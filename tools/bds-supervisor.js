// Supervisor for the Minecraft Bedrock Dedicated Server.
//
// The problem this exists to solve: BDS has no remote control channel at all.
// No RCON (that is a Java Edition feature), no REST, no telnet. Its console is
// stdin on bedrock_server.exe, and the dashboard starts servers detached (see
// src/win.js) precisely so restarting the dashboard does not kill the game --
// which leaves nothing holding that stdin. So `transport: 'none'`, and Stop and
// Restart terminate the process. BDS has no "save on exit", so every restart is
// a hard kill of a server that may be mid-chunk-write.
//
// This process is the missing stdin holder. It launches BDS as a child, keeps
// the pipe, and speaks Source RCON on a TCP port -- the one control protocol
// the dashboard already knows (src/rcon.js). Nothing in the dashboard needed a
// new transport: the bedrock profile just stops saying 'none' and says
// 'rcon-persistent' instead, and console, broadcast, save and a genuine clean
// `stop` all start working through the existing code path.
//
// Deliberately NOT a service wrapper. The dashboard still watches
// bedrock_server.exe by name, so up/down, uptime and per-process CPU/RAM stay
// attributed to the real server rather than to a node process -- the property
// that made the process-only profile worth having in the first place.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// --- Source RCON wire format ------------------------------------------------
// Mirrors src/rcon.js exactly, from the other side of the socket.
const AUTH = 3;
const AUTH_RESPONSE = 2;
const EXEC = 2;
const RESPONSE_VALUE = 0;

const MIN_FRAME_BYTES = 10;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

// Real Source servers split long replies at 4096 bytes including the header.
// src/rcon.js reassembles by settling on silence, so it copes either way, but
// staying under the limit keeps third-party clients (mcrcon and friends) happy.
const MAX_BODY_BYTES = 4000;

function encode(id, type, body) {
  const payload = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(payload.length + 14);
  buf.writeInt32LE(payload.length + 10, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  buf.writeInt16LE(0, payload.length + 12);
  return buf;
}

// --- console capture timings ------------------------------------------------
// BDS neither echoes the command it was given nor marks where a reply ends, so
// a command's output can only be identified as "whatever the console printed
// just after we typed it". That is why commands are serialised below: with two
// in flight there is no way to tell whose output is whose.
//
// src/rcon.js gives up on a command after 8s, so everything here has to settle
// well inside that.
const FIRST_LINE_MS = 800;   // nothing at all by now => the command prints nothing
const QUIET_MS = 250;        // ...then stop once the console goes quiet again
const HARD_CAP_MS = 3000;    // a chatty server must not hold the reply open
const SAVE_QUERY_BUDGET_MS = 5000;

// --- arguments --------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));

// Options are all --name=value. Anything after a bare `--` is handed to the
// child instead: BDS itself takes no arguments, but this is what lets the
// supervisor be pointed at a stand-in process to test the RCON side without a
// world directory to lose.
const dashAt = process.argv.indexOf('--');
const ownArgv = dashAt === -1 ? process.argv : process.argv.slice(0, dashAt);
const childArgs = dashAt === -1 ? [] : process.argv.slice(dashAt + 1);

function arg(name, fallback = null) {
  const hit = ownArgv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

// The password lives in the dashboard's gitignored .env alongside every other
// secret, rather than being baked into the .bat that launches this -- a .bat is
// exactly the kind of file that gets pasted into a forum post.
function readEnvFile(file) {
  const out = {};
  if (!file || !fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["'](.*)["']$/, '$1');
  }
  return out;
}

const envFile = arg('env-file', path.join(here, '..', '.env'));
const env = { ...readEnvFile(envFile), ...process.env };

const exe = arg('exe');
const dir = arg('dir', exe ? path.dirname(exe) : process.cwd());
const rconPort = Number(arg('rcon-port', '25585'));
// Loopback by default and on purpose. Source RCON authenticates with a
// plaintext password and everything after it is plaintext too; this listener
// must never be the thing that is reachable from the internet. The dashboard
// connects from the same box.
const rconHost = arg('rcon-host', '127.0.0.1');
const passwordVar = arg('password-var', 'BEDROCK_RCON_PASSWORD');
const password = env[passwordVar] || '';
const logFile = arg('log', path.join(dir, 'logs', 'latest.log'));

function die(msg) {
  process.stderr.write(`[supervisor] ${msg}\n`);
  process.exit(1);
}

if (!exe) die('missing --exe=<path to bedrock_server.exe>');
if (!fs.existsSync(exe)) die(`no such executable: ${exe}`);
if (!password) {
  die(`${passwordVar} is not set. Add it to ${envFile} (the same file the dashboard reads).`);
}
if (!Number.isInteger(rconPort) || rconPort < 1 || rconPort > 65535) {
  die(`--rcon-port must be a port number, got "${arg('rcon-port')}"`);
}

// --- logging ----------------------------------------------------------------
// Same rotation the old .bat did: the log worth reading after a crash is the
// one from the run that crashed, and the watchdog may already have restarted
// the server on top of it. Doing it here rather than in the .bat means it
// happens however this gets launched.
fs.mkdirSync(path.dirname(logFile), { recursive: true });
if (fs.existsSync(logFile)) {
  try {
    fs.renameSync(logFile, path.join(path.dirname(logFile), 'latest.prev.log'));
  } catch { /* a locked previous log is not worth refusing to start over */ }
}
const log = fs.createWriteStream(logFile, { flags: 'a' });

function note(msg) {
  const line = `[supervisor] ${msg}\n`;
  process.stdout.write(line);
  log.write(line);
}

// --- the server process -----------------------------------------------------
note(`starting ${exe}`);
const child = spawn(exe, childArgs, {
  cwd: dir,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: false,
});

child.on('error', (err) => die(`could not start the server: ${err.message}`));

// One capture slot, because only one command runs at a time.
let capture = null;
let pendingOut = '';

function onLine(line) {
  if (!capture) return;
  capture.lines.push(line);
  clearTimeout(capture.timer);
  capture.timer = setTimeout(capture.finish, QUIET_MS);
}

function onChunk(chunk) {
  log.write(chunk);
  process.stdout.write(chunk);
  pendingOut += chunk.toString('utf8');
  const lines = pendingOut.split(/\r?\n/);
  pendingOut = lines.pop();          // trailing partial line stays buffered
  for (const line of lines) onLine(line);
}

child.stdout.on('data', onChunk);
child.stderr.on('data', onChunk);

// --- command execution ------------------------------------------------------
let chain = Promise.resolve();
let stopping = false;
let exiting = false;

// Serialise. See the capture-timing note above: concurrent commands would have
// their console output interleaved with no way to attribute it.
function enqueue(fn) {
  const run = () => fn();
  chain = chain.then(run, run);
  return chain;
}

// Type a command and collect whatever the console prints in response.
function execRaw(command) {
  return new Promise((resolve) => {
    if (!child.stdin.writable) { resolve('server is not accepting console input'); return; }

    const slot = { lines: [], timer: null, hard: null, done: false };
    slot.finish = () => {
      if (slot.done) return;
      slot.done = true;
      clearTimeout(slot.timer);
      clearTimeout(slot.hard);
      capture = null;
      resolve(slot.lines.join('\n').trim());
    };
    capture = slot;
    slot.timer = setTimeout(slot.finish, FIRST_LINE_MS);
    slot.hard = setTimeout(slot.finish, HARD_CAP_MS);

    try {
      child.stdin.write(`${command}\n`);
    } catch (err) {
      slot.finish();
      resolve(`could not write to the server console: ${err.message}`);
    }
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// A correct Bedrock save is three commands, not one.
//
// `save hold` only *asks* for a snapshot; the files are not consistent until
// `save query` says so, and `save resume` must run afterwards or the world
// stays held and never auto-saves again. A backup taken between hold and a
// confirmed query is a torn copy -- which is the whole reason
// backup.beforeRestart exists. Exposed to the dashboard as one atomic command
// so the profile can keep a single `save` string.
async function saveMacro() {
  const held = await execRaw('save hold');
  const deadline = Date.now() + SAVE_QUERY_BUDGET_MS;
  let ready = '';
  while (Date.now() < deadline) {
    await delay(400);
    const q = await execRaw('save query');
    if (/ready to be copied|files are now ready/i.test(q)) { ready = q; break; }
  }
  // Always resume, even if the query never confirmed: leaving the world held
  // is worse than an unconfirmed save, because nothing auto-saves after it.
  const resumed = await execRaw('save resume');
  return ready
    ? `${ready}\n${resumed}`
    : `save did not confirm within ${SAVE_QUERY_BUDGET_MS}ms - resumed anyway\n${held}\n${resumed}`;
}

// `stop` is acknowledged the instant it reaches the console, not when the
// server has finished exiting. A clean Bedrock shutdown can take far longer
// than the 8s src/rcon.js allows a command, and a timeout there is read by
// actions.js as "the server refused the shutdown" -- which force-kills it after
// 45s, destroying the very clean exit this whole file exists to provide. The
// dashboard already watches the process table to learn when it is actually
// down; that is the right mechanism and it needs no reply from us.
async function dispatch(command) {
  const cmd = command.trim();
  if (!cmd) return '';

  if (/^dashboard:save$/i.test(cmd)) return enqueue(saveMacro);

  if (/^stop$/i.test(cmd)) {
    return enqueue(async () => {
      stopping = true;
      try { child.stdin.write('stop\n'); } catch { /* exiting anyway */ }
      return 'Stopping the server (saving and shutting down)';
    });
  }

  return enqueue(() => execRaw(cmd));
}

// --- RCON listener ----------------------------------------------------------
function reply(sock, id, type, body) {
  if (sock.destroyed) return;
  const payload = Buffer.from(body, 'utf8');
  if (payload.length <= MAX_BODY_BYTES) { sock.write(encode(id, type, body)); return; }
  for (let at = 0; at < payload.length; at += MAX_BODY_BYTES) {
    sock.write(encode(id, type, payload.subarray(at, at + MAX_BODY_BYTES).toString('utf8')));
  }
}

const rcon = net.createServer((sock) => {
  sock.setNoDelay(true);
  let authed = false;
  let buf = Buffer.alloc(0);

  sock.on('error', () => sock.destroy());

  sock.on('data', (data) => {
    buf = Buffer.concat([buf, data]);
    while (buf.length >= 4) {
      const size = buf.readInt32LE(0);
      if (size < MIN_FRAME_BYTES || size > MAX_FRAME_BYTES) { sock.destroy(); return; }
      if (buf.length < size + 4) break;

      const frame = buf.subarray(4, size + 4);
      buf = buf.subarray(size + 4);

      const id = frame.readInt32LE(0);
      const type = frame.readInt32LE(4);
      const body = frame.subarray(8, frame.length - 2).toString('utf8');

      if (type === AUTH) {
        authed = body === password;
        // What a real Source server sends: an empty RESPONSE_VALUE, then the
        // auth verdict. src/rcon.js skips the first and reads the second; id
        // -1 is the protocol's "rejected".
        reply(sock, id, RESPONSE_VALUE, '');
        reply(sock, authed ? id : -1, AUTH_RESPONSE, '');
        if (!authed) note(`RCON auth rejected from ${sock.remoteAddress}`);
        continue;
      }

      if (type === EXEC) {
        // An unauthenticated caller gets the protocol's rejection and the
        // socket closed, rather than a hint about which half was wrong.
        if (!authed) { reply(sock, -1, AUTH_RESPONSE, ''); sock.destroy(); return; }
        dispatch(body).then(
          (out) => reply(sock, id, RESPONSE_VALUE, out),
          (err) => reply(sock, id, RESPONSE_VALUE, `supervisor error: ${err.message}`),
        );
      }
    }
  });
});

rcon.on('error', (err) => {
  // A port already in use almost always means a second supervisor is up, which
  // would mean two servers fighting over one world directory.
  note(`RCON listener failed: ${err.message}`);
  shutdown(1);
});

rcon.listen(rconPort, rconHost, () => {
  note(`RCON listening on ${rconHost}:${rconPort}`);
});

// --- lifecycle --------------------------------------------------------------
// The supervisor's life is the server's life, in both directions.
//
// Downward: killProcess() in src/win.js kills by process name, so a forced stop
// takes bedrock_server.exe and leaves this process behind holding the RCON
// port -- the next start would then fail to bind. Exiting with the child
// prevents that.
child.on('exit', (code, signal) => {
  note(`server exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`);
  shutdown(0);
});

function shutdown(code) {
  if (exiting) return;
  exiting = true;
  try { rcon.close(); } catch { /* already down */ }
  // Upward: if this process is going away, the server must not be left running
  // with nobody holding its console -- it would be unreachable and unstoppable
  // except by name.
  if (child.exitCode === null && !child.killed) {
    try { child.kill(); } catch { /* gone already */ }
  }
  log.end(() => process.exit(code));
  setTimeout(() => process.exit(code), 2000).unref();
}

// Ctrl+C in the console window, or a polite terminate: spend the shutdown
// budget on a real `stop` before giving up on it.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => {
    if (stopping || exiting) { shutdown(0); return; }
    stopping = true;
    note(`${sig} - asking the server to stop cleanly`);
    try { child.stdin.write('stop\n'); } catch { shutdown(0); return; }
    setTimeout(() => shutdown(0), 60_000).unref();
  });
}
