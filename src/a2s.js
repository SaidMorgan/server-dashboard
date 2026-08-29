// Steam A2S server queries over UDP.
//
// The third way to read a running game, alongside RCON and REST: every server
// that registers with Steam answers A2S_INFO on its query port with the name,
// the map and — the part the dashboard cares about — how many players are on
// it. No password, no persistent socket, no login; the port is already open
// because that is how anyone finds the server in the first place.
//
// That makes it the only remote interface some games have. Icarus has no RCON,
// no REST and no console, so without this its card can only say "running" —
// see src/games/icarus.js.
//
// A2S is not a substitute for RCON: it reads, it cannot act. Broadcasts, saves
// and clean shutdowns still need a transport, which is why this is a separate
// `query` capability on a profile rather than a fourth transport.
import dgram from 'node:dgram';

const HEADER = Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]);
const A2S_INFO = Buffer.concat([HEADER, Buffer.from([0x54]), Buffer.from('Source Engine Query\0', 'ascii')]);
const A2S_PLAYER = Buffer.concat([HEADER, Buffer.from([0x55, 0xFF, 0xFF, 0xFF, 0xFF])]);

const R_CHALLENGE = 0x41; // "ask again with this four-byte token"
const R_INFO = 0x49;
const R_PLAYER = 0x44;

const DEFAULT_TIMEOUT_MS = 2000;

// One request, one reply, one socket. Sockets are not kept alive between polls:
// A2S is a single datagram each way, so a pool would only buy the cost of
// holding a port open for the 10 seconds between polls.
function ask(host, port, payload, timeoutMs) {
  return new Promise((resolve) => {
    let socket;
    try {
      socket = dgram.createSocket('udp4');
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closing */ }
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, error: 'no answer on the query port' }), timeoutMs);
    timer.unref?.();

    socket.on('message', (msg) => done({ ok: true, msg }));
    socket.on('error', (err) => done({ ok: false, error: err.message }));
    socket.send(payload, port, host, (err) => {
      if (err) done({ ok: false, error: err.message });
    });
  });
}

// Every A2S request can be answered with a challenge instead of the thing that
// was asked for, at the server's discretion — it is how Valve stopped these
// ports being amplifiers for spoofed-source floods. So each query is "ask, and
// if that comes back a challenge, ask again with the token".
async function askWithChallenge(host, port, payload, timeoutMs) {
  let res = await ask(host, port, payload, timeoutMs);
  if (!res.ok) return res;
  if (res.msg.length < 5) return { ok: false, error: 'truncated reply' };

  if (res.msg[4] === R_CHALLENGE) {
    const challenge = res.msg.subarray(5, 9);
    // A2S_PLAYER carries its token in place of the FF FF FF FF placeholder it
    // was sent with; A2S_INFO appends it after the query string.
    const retry = payload[4] === 0x55
      ? Buffer.concat([payload.subarray(0, 5), challenge])
      : Buffer.concat([payload, challenge]);
    res = await ask(host, port, retry, timeoutMs);
    if (!res.ok) return res;
  }

  // Split replies (0xFFFFFFFE) need reassembly and, on some games, bzip2. Only
  // a player list long enough to overflow a datagram gets one, and the count
  // from A2S_INFO is unaffected, so say so plainly instead of half-parsing it.
  if (res.msg.readUInt32LE(0) !== 0xFFFFFFFF) {
    return { ok: false, error: 'multi-packet reply is not supported' };
  }
  return res;
}

// The wire format is a stream of little-endian primitives and NUL-terminated
// strings, and a short read means a malformed packet rather than a zero.
function reader(buf) {
  let off = 5; // past the 0xFFFFFFFF header and the reply type byte
  const need = (n) => { if (off + n > buf.length) throw new Error('short packet'); };
  return {
    u8() { need(1); return buf[off++]; },
    u16() { need(2); const v = buf.readUInt16LE(off); off += 2; return v; },
    f32() { need(4); const v = buf.readFloatLE(off); off += 4; return v; },
    str() {
      const end = buf.indexOf(0, off);
      if (end < 0) throw new Error('unterminated string');
      const s = buf.toString('utf8', off, end);
      off = end + 1;
      return s;
    },
  };
}

// A2S_INFO — name, map and the player count. This is the call that matters:
// it is answered by every Steam-registered server, and it is where the "3 / 16"
// on a card comes from.
export async function queryInfo({ host, port, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const started = Date.now();
  const res = await askWithChallenge(host, port, A2S_INFO, timeoutMs);
  if (!res.ok) return res;
  if (res.msg[4] !== R_INFO) return { ok: false, error: `unexpected reply 0x${res.msg[4].toString(16)}` };

  try {
    const r = reader(res.msg);
    r.u8(); // protocol version
    const name = r.str();
    const map = r.str();
    r.str(); // game folder
    r.str(); // game name
    r.u16(); // app id, truncated to 16 bits and 0 on some servers — steamAppId in the profile is the real one
    const players = r.u8();
    const maxPlayers = r.u8();
    const bots = r.u8();

    // The version string is four bytes further on and costs nothing to read --
    // it is in the reply either way. Everything between is a single byte, so
    // this cannot drift out of step the way a length-prefixed field could.
    //
    // Wrapped on its own because it is the one field here that is optional in
    // practice: a server that stops early leaves the count intact rather than
    // failing the whole query over a label. (The Ship inserts three extra
    // fields before this; no game on this dashboard is The Ship, and guessing
    // wrong would only mean a blank version.)
    let version = '';
    try {
      r.u8(); // server type — d dedicated, l listen, p SourceTV
      r.u8(); // environment — w Windows, l Linux, m Mac
      r.u8(); // visibility — 0 public, 1 private
      r.u8(); // VAC — 0 off, 1 on
      version = r.str();
    } catch { /* older or truncated reply: the count above still stands */ }

    return { ok: true, name, map, players, maxPlayers, bots, version, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: `could not parse the reply (${err.message})` };
  }
}

// A2S_PLAYER — one entry per player, in theory with a name. In practice the
// names come from whatever the game bothers to register with Steam, and plenty
// of servers (Icarus among them) answer with the right number of entries and
// nothing in the name field. Blank entries are dropped here, so a caller that
// gets fewer names than A2S_INFO counted is looking at a game that does not
// publish them — not at players who left between the two calls.
export async function queryPlayers({ host, port, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const res = await askWithChallenge(host, port, A2S_PLAYER, timeoutMs);
  if (!res.ok) return res;
  if (res.msg[4] !== R_PLAYER) return { ok: false, error: `unexpected reply 0x${res.msg[4].toString(16)}` };

  try {
    const r = reader(res.msg);
    const count = r.u8();
    const players = [];
    for (let i = 0; i < count; i++) {
      r.u8(); // index, always 0 in practice
      const name = r.str();
      r.u16(); r.u16(); // score, as int32 split across two reads
      const seconds = r.f32();
      if (name) players.push({ name, id: `${Math.round(seconds / 60)}m online` });
    }
    return { ok: true, players, count };
  } catch (err) {
    return { ok: false, error: `could not parse the reply (${err.message})` };
  }
}
