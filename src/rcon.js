// Source RCON protocol client.
//
// This file knows the wire protocol and nothing about any particular game —
// command names and player-list parsing live in src/games/*.js.
//
// IMPORTANT: some servers (ARK Ascended is the notorious one) leak accepted
// sockets — they never close them, so they pile up in CLOSE_WAIT and after a
// handful of connections the listener refuses everything until the server
// restarts. For those, we hold ONE long-lived, authenticated connection per
// server and reuse it for every command, reconnecting only if it actually
// breaks. Never go back to connect-per-command for a 'rcon-persistent' game.
import net from 'node:net';

const AUTH = 3;
const AUTH_RESPONSE = 2;
const EXEC = 2;
const RESPONSE_VALUE = 0;

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

// ARK accepts roughly six RCON sockets and never reaps them, so every FAILED
// connection attempt permanently burns one of six slots. Retrying on a 10s poll
// loop kills RCON within a minute. Back off hard instead. This applies to every
// game, since a server that is down is a server that is down.
const BACKOFF_STEPS = [15_000, 30_000, 60_000, 120_000, 300_000];

class RconClient {
  constructor({ host, port, password, timeout = 8000 }) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.timeout = timeout;
    this.socket = null;
    this.connecting = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 10;
    this.pending = new Map(); // id -> {chunks, resolve, settleTimer, killTimer}
    this.queue = Promise.resolve();
    this.failures = 0;
    this.nextAttemptAt = 0;
  }

  // How long until we're allowed to spend another connection slot.
  retryInSeconds() {
    return Math.max(0, Math.ceil((this.nextAttemptAt - Date.now()) / 1000));
  }

  #noteFailure() {
    this.failures += 1;
    const step = BACKOFF_STEPS[Math.min(this.failures - 1, BACKOFF_STEPS.length - 1)];
    this.nextAttemptAt = Date.now() + step;
  }

  #noteSuccess() {
    this.failures = 0;
    this.nextAttemptAt = 0;
  }

  #teardown(reason) {
    const sock = this.socket;
    this.socket = null;
    this.connecting = null;
    this.buffer = Buffer.alloc(0);
    if (sock) {
      sock.removeAllListeners();
      sock.destroy();
    }
    for (const [id, p] of this.pending) {
      clearTimeout(p.settleTimer);
      clearTimeout(p.killTimer);
      p.resolve({ ok: false, error: reason });
      this.pending.delete(id);
    }
  }

  #onData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readInt32LE(0);
      if (size < 10 || size > 8 * 1024 * 1024) { this.#teardown('protocol desync'); return; }
      if (this.buffer.length < size + 4) break;

      const frame = this.buffer.subarray(4, size + 4);
      this.buffer = this.buffer.subarray(size + 4);

      const id = frame.readInt32LE(0);
      const type = frame.readInt32LE(4);
      const body = frame.subarray(8, frame.length - 2).toString('utf8');

      if (type !== RESPONSE_VALUE) continue; // auth replies are handled at connect time
      const p = this.pending.get(id);
      if (!p) continue;

      p.chunks.push(body);
      // Multi-packet replies arrive back to back; settle once they stop coming.
      clearTimeout(p.settleTimer);
      p.settleTimer = setTimeout(() => {
        clearTimeout(p.killTimer);
        this.pending.delete(id);
        p.resolve({ ok: true, body: p.chunks.join('') });
      }, 150);
      p.settleTimer.unref?.();
    }
  }

  #connect() {
    if (this.socket && !this.socket.destroyed) return Promise.resolve({ ok: true });
    if (this.connecting) return this.connecting;

    // Refuse to spend a connection slot while backing off.
    const wait = this.retryInSeconds();
    if (wait > 0) {
      return Promise.resolve({ ok: false, error: `unreachable — retrying in ${wait}s`, backingOff: true });
    }

    this.connecting = new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!result.ok) {
          socket.removeAllListeners();
          socket.destroy();
          this.socket = null;
          this.#noteFailure();
        } else {
          this.#noteSuccess();
        }
        this.connecting = null;
        resolve(result);
      };

      const timer = setTimeout(() => done({ ok: false, error: 'connect/auth timed out' }), this.timeout);
      timer.unref?.();

      socket.on('error', (err) => {
        const msg = err.code === 'ECONNREFUSED'
          ? 'RCON not listening'
          : err.code === 'ECONNRESET' ? 'connection reset' : err.message;
        if (settled) this.#teardown(msg);
        else done({ ok: false, error: msg });
      });

      socket.on('close', () => {
        if (settled) this.#teardown('connection closed by server');
      });

      // Auth handshake: watch for the auth reply, then hand data off to #onData.
      let authBuf = Buffer.alloc(0);
      const authHandler = (data) => {
        authBuf = Buffer.concat([authBuf, data]);
        while (authBuf.length >= 4) {
          const size = authBuf.readInt32LE(0);
          if (authBuf.length < size + 4) return;
          const frame = authBuf.subarray(4, size + 4);
          authBuf = authBuf.subarray(size + 4);
          const id = frame.readInt32LE(0);
          const type = frame.readInt32LE(4);
          if (type !== AUTH_RESPONSE) continue; // ignore the empty RESPONSE_VALUE

          socket.off('data', authHandler);
          socket.on('data', (d) => this.#onData(d));
          if (authBuf.length) this.#onData(authBuf);

          if (id === -1) { done({ ok: false, error: 'RCON password rejected' }); return; }
          this.socket = socket;
          done({ ok: true });
          return;
        }
      };
      socket.on('data', authHandler);

      socket.connect(this.port, this.host, () => socket.write(encode(2, AUTH, this.password)));
    });

    return this.connecting;
  }

  // Commands are serialized so one slow reply can't be attributed to the next.
  exec(command) {
    const run = async () => {
      const conn = await this.#connect();
      if (!conn.ok) return conn;

      return new Promise((resolve) => {
        const id = this.nextId++;
        if (this.nextId > 2_000_000) this.nextId = 10;

        const entry = { chunks: [], resolve, settleTimer: null, killTimer: null };
        entry.killTimer = setTimeout(() => {
          this.pending.delete(id);
          clearTimeout(entry.settleTimer);
          // Silence usually means the world is still loading, not a dead socket.
          resolve({ ok: false, error: 'no reply (server busy or still starting)' });
        }, this.timeout);
        entry.killTimer.unref?.();
        this.pending.set(id, entry);

        try {
          this.socket.write(encode(id, EXEC, command));
        } catch (err) {
          clearTimeout(entry.killTimer);
          this.pending.delete(id);
          this.#teardown(err.message);
          resolve({ ok: false, error: err.message });
        }
      });
    };

    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  close() {
    this.#teardown('closed');
  }
}

const clients = new Map();

export function getClient({ host, port, password }) {
  const key = `${host}:${port}`;
  let c = clients.get(key);
  if (!c) {
    c = new RconClient({ host, port, password });
    clients.set(key, c);
  }
  c.password = password;
  return c;
}

// Games need opposite connection strategies, so each profile declares its own:
//
//   'rcon-persistent'  One socket, held forever. For servers that never close
//                      accepted sockets — they pile up in CLOSE_WAIT until the
//                      listener starts refusing. ARK, Minecraft.
//   'rcon-oneshot'     A fresh connection per command. For servers that answer
//                      the first command and then go silent, wedging a held-open
//                      socket. These close their sockets properly, so it's safe.
export async function rconCommand({ host, port, password, command, mode = 'rcon-oneshot' }) {
  if (mode === 'rcon-persistent' || mode === 'persistent') {
    return getClient({ host, port, password }).exec(command);
  }
  const client = new RconClient({ host, port, password });
  try {
    return await client.exec(command);
  } finally {
    client.close();
  }
}

export function closeAll() {
  for (const c of clients.values()) c.close();
  clients.clear();
}
