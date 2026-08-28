// RakNet unconnected ping — how a Minecraft Bedrock server is read.
//
// The fourth way to ask a running server how many players are on it, alongside
// RCON, REST and A2S. Bedrock has none of the other three: RCON is a Java
// Edition feature, there is no REST interface, and BDS does not register with
// Steam, so src/a2s.js gets nothing back from it.
//
// What it does answer is the packet the Bedrock client itself sends when it
// draws the server list — an unconnected ping on the game port. The reply is a
// single semicolon-delimited string carrying the MOTD, the version, the player
// count and the player cap. No password, no session, no handshake: the port is
// already open because that is how anyone joins in the first place.
//
// Like A2S this reads and cannot act. Broadcasts, saves and a clean shutdown
// still need a transport, which Bedrock does not have — see
// src/games/bedrock.js.
import dgram from 'node:dgram';

// Fixed 16-byte "OFFLINE_MESSAGE_DATA_ID". RakNet uses it to tell its own
// unconnected packets apart from noise arriving on the same UDP port; a reply
// without it verbatim is not a pong.
const MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');

const ID_UNCONNECTED_PING = 0x01;
const ID_UNCONNECTED_PONG = 0x1C;

const DEFAULT_TIMEOUT_MS = 2000;

// The ping carries a client timestamp and a client GUID, both echoed back. The
// server does not care what either one is — the timestamp is not used for the
// round trip here (that is measured locally) and the GUID only matters to a
// client tracking several pings at once, which this is not.
function pingPacket() {
  const buf = Buffer.alloc(33);
  buf.writeUInt8(ID_UNCONNECTED_PING, 0);
  buf.writeBigInt64BE(BigInt(Date.now()), 1);
  MAGIC.copy(buf, 9);
  buf.writeBigInt64BE(0n, 25); // client GUID
  return buf;
}

// One request, one reply, one socket — same as A2S, and for the same reason:
// a single datagram each way means a pool would only buy holding a port open
// for the ten seconds between polls.
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

// "MCPE;Dedicated Server;800;1.26.44;3;10;13253860892328930865;Bedrock level;Survival;1;19132;19133;0"
//
// Semicolons are the separator and Mojang has appended fields to the end of
// this string across versions, so read by index from the front and ignore
// whatever follows — a server newer than this code still parses. The MOTD
// itself is the one field that can contain a semicolon; splitting on every one
// would shift the count out of position, so the fields that matter are read
// from a fixed offset only after checking the edition tag is where it should be.
function parseServerId(text) {
  const f = text.split(';');
  if (f.length < 6) throw new Error('too few fields');
  // MCPE is Bedrock; MCEE was Education Edition. Anything else is not a
  // Bedrock server answering, and reading players out of it would be a guess.
  if (f[0] !== 'MCPE' && f[0] !== 'MCEE') throw new Error(`unexpected edition "${f[0]}"`);

  const players = Number(f[4]);
  const maxPlayers = Number(f[5]);
  if (!Number.isInteger(players) || !Number.isInteger(maxPlayers)) {
    throw new Error('player counts were not numbers');
  }
  return {
    name: f[1] || '',
    version: f[3] || '',
    players,
    maxPlayers,
    levelName: f[7] || '',
    gamemode: f[8] || '',
  };
}

// The equivalent of A2S_INFO: name, version and the player count. This is the
// only call — there is no Bedrock packet that lists who is online. The names
// exist nowhere on the wire, only in the server's own console output, so a card
// for a Bedrock server shows "3 online" and no list. See the profile's
// query.names: false.
export async function queryInfo({ host, port, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const started = Date.now();
  const res = await ask(host, port, pingPacket(), timeoutMs);
  if (!res.ok) return res;

  const msg = res.msg;
  // 1 id + 8 time + 8 server GUID + 16 magic + 2 length = 35 before the string.
  if (msg.length < 35) return { ok: false, error: 'truncated reply' };
  if (msg[0] !== ID_UNCONNECTED_PONG) {
    return { ok: false, error: `unexpected reply 0x${msg[0].toString(16)}` };
  }
  if (!msg.subarray(17, 33).equals(MAGIC)) {
    return { ok: false, error: 'reply was not a RakNet pong' };
  }

  try {
    const len = msg.readUInt16BE(33);
    // A length that overruns the datagram means the packet was cut short, which
    // would otherwise parse as a silently truncated MOTD.
    if (35 + len > msg.length) throw new Error('server id string is longer than the packet');
    const info = parseServerId(msg.toString('utf8', 35, 35 + len));
    return { ok: true, ...info, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: `could not parse the reply (${err.message})` };
  }
}
