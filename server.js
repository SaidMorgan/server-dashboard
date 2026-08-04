import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig, ConfigError, isLoopback, validateCron } from './src/config.js';
import { loadUserProfiles, getProfile } from './src/games/index.js';
import { createAuth, assertBindIsSafe, UnsafeBindError } from './src/auth.js';
import { Monitor } from './src/monitor.js';
import { Actions } from './src/actions.js';
import { Backups } from './src/backup.js';
import { Notifier } from './src/notify.js';
import { Scheduler, describeCron, nextRun } from './src/scheduler.js';
import { closeAll } from './src/rcon.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');

// User-supplied game profiles are registered before the config is validated,
// so config.json can reference them by id.
const userProfiles = await loadUserProfiles(path.join(here, 'games'));
if (userProfiles.length) console.log(`Loaded custom game profiles: ${userProfiles.join(', ')}`);

let config;
try {
  config = loadConfig({ dir: here });
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.format(process.env.SD_CONFIG || path.join(here, 'config.json')));
    process.exit(1);
  }
  throw err;
}

// Exposed to the network without a password? Stop, and explain. See src/auth.js.
try {
  assertBindIsSafe(config);
} catch (err) {
  if (err instanceof UnsafeBindError) {
    console.error(err.format());
    process.exit(1);
  }
  throw err;
}

const auth = createAuth(config, config.dataDir);
const monitor = new Monitor(config, config.dataDir);
const actions = new Actions(config, monitor);
const backups = new Backups(config, monitor, actions);
const notifier = new Notifier(config);
const scheduler = new Scheduler(config, monitor, actions, backups, config.dataDir);

// These four know about each other, so the wiring happens here rather than
// through constructor arguments that would be circular.
actions.backups = backups;
monitor.attach({ actions, notifier });

monitor.start();
scheduler.start();

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '64kb' }));
auth.routes(app, publicDir);
app.use(auth.middleware);
app.use(auth.requireJson);
app.use(express.static(publicDir));

// Never let RCON passwords out over the wire. The UI also needs to know what
// each game can actually do, so it can hide buttons that would only ever fail.
const publicTarget = (t) => {
  const profile = t.kind === 'game' ? getProfile(t.game) : null;
  return {
    id: t.id, name: t.name, kind: t.kind, game: t.game ?? null,
    gameLabel: profile?.label ?? null,
    transport: profile?.transport ?? null,
    canBroadcast: Boolean(profile && (profile.transport === 'rest' || profile.commands?.broadcast)),
    canSave: Boolean(profile && (profile.transport === 'rest' || profile.commands?.save)),
    canConsole: Boolean(profile && profile.transport !== 'none'),
    consoleCommands: profile?.consoleCommands ?? [],
    canStart: Boolean(t.startCommand) || t.kind === 'service',
    gamePort: t.gamePort ?? null, rconPort: t.rconPort ?? null,
    maxPlayers: t.maxPlayers ?? null, serviceName: t.serviceName ?? null,
    healthUrl: t.healthUrl ?? null, hasLog: Boolean(t.logFile || t.logDir),
    hasBackup: Boolean(t.backup?.enabled && t.backup?.paths?.length),
  };
};

app.get('/api/targets', (_req, res) => res.json(config.targets.map(publicTarget)));

// Shared by the polling endpoint and the SSE stream, so both always agree.
function statusPayload() {
  return {
    now: Date.now(),
    pollSeconds: config.pollSeconds,
    host: os.hostname(),
    targets: monitor.snapshot(),
    pending: actions.pendingInfo(),
  };
}

app.get('/api/status', (_req, res) => res.json(statusPayload()));

app.get('/api/history/:id', (req, res) => {
  const minutes = Math.min(Number(req.query.minutes) || 180, config.historyHours * 60);
  res.json(monitor.historyFor(req.params.id, minutes));
});

app.get('/api/alerts', (req, res) => {
  const id = req.query.id;
  const rows = id ? monitor.alerts.filter((a) => a.targetId === id) : monitor.alerts;
  res.json(rows.slice(0, Number(req.query.limit) || 100));
});

app.get('/api/logs/:id', async (req, res) => {
  const t = config.targets.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'unknown target' });

  let file = t.logFile;
  if (!file && t.logDir) {
    try {
      const newest = fs.readdirSync(t.logDir)
        .map((f) => ({ f, s: fs.statSync(path.join(t.logDir, f)) }))
        .filter((x) => x.s.isFile())
        .sort((a, b) => b.s.mtimeMs - a.s.mtimeMs)[0];
      if (newest) file = path.join(t.logDir, newest.f);
    } catch { /* fall through */ }
  }
  if (!file || !fs.existsSync(file)) return res.json({ file: null, lines: [] });

  const want = Math.min(Number(req.query.lines) || 200, 2000);
  try {
    // Read only the tail — these logs get large.
    const size = fs.statSync(file).size;
    const span = Math.min(size, 256 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(span);
    fs.readSync(fd, buf, 0, span, size - span);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split(/\r?\n/).slice(-want);
    res.json({ file, lines });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- live updates ----------------------------------------------------------
//
// Server-sent events replace the front-end's 5-second poll: the browser learns
// about a crash the moment the poll loop sees it, and an idle dashboard costs
// one open connection instead of a request every five seconds.
const streamClients = new Set();

function broadcastEvent(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of streamClients) {
    try { res.write(frame); } catch { streamClients.delete(res); }
  }
}

monitor.onPoll = () => broadcastEvent('status', statusPayload());
monitor.onAlert = (alert) => broadcastEvent('alert', alert);

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // don't let a reverse proxy buffer the stream
  });
  res.write(`retry: 3000\n\n`);
  res.write(`event: status\ndata: ${JSON.stringify(statusPayload())}\n\n`);
  streamClients.add(res);

  // Proxies and phones drop idle connections; a comment every 20s keeps it open.
  const keepAlive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { /* closed */ }
  }, 20_000);
  keepAlive.unref?.();

  req.on('close', () => {
    clearInterval(keepAlive);
    streamClients.delete(res);
  });
});

// --- schedules -------------------------------------------------------------

app.get('/api/schedules', (_req, res) => res.json(scheduler.jobs()));

// Explains a cron expression before it is saved, so the form can say "daily at
// 05:00, next in 7h" while it is being typed. Same code the scheduler runs on,
// so the preview can't disagree with what actually happens.
app.get('/api/schedules/preview', (req, res) => {
  const cron = String(req.query.cron || '');
  const error = validateCron(cron);
  if (error) return res.json({ ok: false, error });
  return res.json({ ok: true, description: describeCron(cron), nextRun: nextRun(cron) });
});

app.post('/api/schedules', (req, res) => {
  const result = scheduler.add(req.body || {});
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/api/schedules/:id', (req, res) => {
  const result = scheduler.update(req.params.id, req.body || {});
  res.status(result.ok ? 200 : 400).json(result);
});

app.delete('/api/schedules/:id', (req, res) => {
  const result = scheduler.remove(req.params.id);
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/api/schedules/:id/run', async (req, res) => {
  const job = scheduler.jobs().find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'no such schedule' });
  return res.json(await scheduler.runJob(job));
});

// --- backups ---------------------------------------------------------------

app.get('/api/backups/:id', (req, res) => {
  try {
    res.json(backups.list(req.params.id));
  } catch (err) {
    res.status(404).json({ ok: false, error: err.message });
  }
});

app.post('/api/backups/:id', async (req, res) => {
  try {
    res.json(await backups.run(req.params.id, { reason: 'manual' }));
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/backups/:id/restore', async (req, res) => {
  const name = String(req.body?.name || '');
  try {
    res.json(await backups.restore(req.params.id, name));
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/backups/:id/download/:name', (req, res) => {
  const { id, name } = req.params;
  // The name comes from the URL, so anchor it to the target's backup folder and
  // reject anything that tries to climb out of it.
  if (!/^[\w.-]+\.zip$/.test(name)) return res.status(400).json({ ok: false, error: 'invalid archive name' });
  try {
    const dir = path.resolve(backups.dirFor(id));
    const file = path.resolve(dir, name);
    if (!file.startsWith(dir + path.sep)) return res.status(400).json({ ok: false, error: 'invalid path' });
    if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: 'not found' });
    return res.download(file);
  } catch (err) {
    return res.status(404).json({ ok: false, error: err.message });
  }
});

app.post('/api/rcon/:id', async (req, res) => {
  const command = String(req.body?.command || '').trim();
  if (!command) return res.status(400).json({ ok: false, error: 'command required' });
  try {
    res.json(await actions.rcon(req.params.id, command));
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/action/:id', async (req, res) => {
  const { action, minutes, message, reason } = req.body || {};
  const id = req.params.id;
  try {
    switch (action) {
      case 'start':          return res.json(await actions.start(id));
      case 'stop':           return res.json(await actions.stop(id));
      case 'restart':        return res.json(await actions.restartNow(id));
      case 'save':           return res.json(await actions.save(id));
      case 'broadcast':      return res.json(await actions.broadcast(id, String(message || '').trim()));
      case 'scheduleRestart':return res.json(actions.scheduleRestart(id, Number(minutes) || 15, reason || 'scheduled restart'));
      case 'cancelRestart':  return res.json(actions.cancelRestart(id));
      default:               return res.status(400).json({ ok: false, error: `unknown action: ${action}` });
    }
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

const server = app.listen(config.port, config.bind, () => {
  const reach = isLoopback(config.bind)
    ? `http://localhost:${config.port} (this machine only)`
    : `http://<this machine>:${config.port} (reachable on your network)`;
  console.log(`Server dashboard listening on ${reach}`);
  console.log(`Monitoring ${config.targets.length} target(s) every ${config.pollSeconds}s`);
  console.log(auth.enabled ? 'Password protection: on' : 'Password protection: off (localhost only)');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    monitor.stop();
    scheduler.stop();
    closeAll();
    for (const res of streamClients) { try { res.end(); } catch { /* already gone */ } }
    server.close(() => process.exit(0));
  });
}
