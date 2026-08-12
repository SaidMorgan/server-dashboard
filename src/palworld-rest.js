// Palworld REST API client.
//
// Palworld's RCON is deprecated ("scheduled to stop functioning in an upcoming
// update" per the official docs) and in practice it wedges when a connection is
// held open. The REST API is the supported path and returns richer data — ping,
// level and coordinates per player.
//
// Auth is HTTP Basic with username "admin" and the server's AdminPassword.
// Docs: https://docs.palworldgame.com/api/rest-api/

// --- tunables ---------------------------------------------------------------
// How long any single REST call gets before it's abandoned. The dashboard polls
// on a 10s loop by default, so this has to stay comfortably under that.
const REQUEST_TIMEOUT_MS = 6000;

function authHeader(password) {
  return 'Basic ' + Buffer.from(`admin:${password}`).toString('base64');
}

async function call(target, method, path, body) {
  const base = `http://${target.host}:${target.restPort}/v1/api`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(base + path, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: authHeader(target.adminPassword),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (res.status === 401) return { ok: false, error: 'REST auth rejected — check AdminPassword' };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const text = await res.text();
    if (!text) return { ok: true, data: null };
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      return { ok: true, data: text };
    }
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, error: 'REST timed out' };
    const refused = err.cause?.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(err.message);
    return { ok: false, error: refused ? 'REST API not listening' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

export async function listPlayers(target) {
  const res = await call(target, 'GET', '/players');
  if (!res.ok) return res;
  const players = (res.data?.players || []).map((p) => ({
    name: p.name,
    id: p.userId || p.playerId || '',
    ping: p.ping != null ? Math.round(p.ping) : null,
    level: p.level ?? null,
  }));
  return { ok: true, players };
}

export async function info(target) {
  return call(target, 'GET', '/info');
}

export async function metrics(target) {
  return call(target, 'GET', '/metrics');
}

export async function announce(target, message) {
  const res = await call(target, 'POST', '/announce', { message });
  return res.ok ? { ok: true, body: 'announced' } : res;
}

export async function save(target) {
  const res = await call(target, 'POST', '/save');
  return res.ok ? { ok: true, body: 'world saved' } : res;
}

// waittime is in seconds; players see the message before the server goes down.
//
// Never zero. A zero wait does not shut the server down — it keeps running until
// something kills it, which looks from the outside exactly like a server that is
// slow to exit. A non-zero wait is honoured, and one second is the same thing to
// a player as none.
export async function shutdown(target, waittime = 10, message = 'Server restarting') {
  const secs = Math.max(1, Math.round(Number(waittime) || 0));
  const res = await call(target, 'POST', '/shutdown', { waittime: secs, message });
  return res.ok ? { ok: true, body: `shutting down in ${secs}s` } : res;
}
