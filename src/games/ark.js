// ARK: Survival Ascended.
//
// Uses RCON on a SINGLE persistent socket. This is not a style choice — see
// docs/games.md. ASA never closes accepted RCON sockets and accepts only about
// six, so every connection (including failed ones) is permanently spent.

const EMPTY = /no players connected/i;

export default {
  id: 'ark',
  label: 'ARK: Survival Ascended',
  transport: 'rcon-persistent',

  defaults: {
    gamePort: 7777,
    queryPort: 27015,
    rconPort: 27020,
    // ARK refuses RCON for its entire ~4 minute load and burns a socket slot on
    // every rejected attempt. Don't probe until it has plausibly finished.
    readyAfterSeconds: 240,
  },

  commands: {
    list: 'listplayers',
    save: 'saveworld',
    broadcast: (msg) => `broadcast ${msg}`,
    shutdown: 'doexit',
  },

  // ARK acknowledges output-less commands (broadcast, saveworld) with this
  // alarming-looking string. It means success; say so plainly.
  normalizeReply(res) {
    if (res.ok && /Server received, But no response/i.test(res.body || '')) {
      return { ok: true, body: 'command executed — ARK returns no output for this one' };
    }
    return res;
  },

  // Lines look like: "0. SomeName, 0002abc123..."
  parsePlayers(body) {
    if (!body || EMPTY.test(body)) return [];
    return body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^\s*\d+\.\s*(.+?),\s*([0-9a-fx]+)\s*$/i);
        if (m) return { name: m[1].trim(), id: m[2] };
        return { name: line.replace(/^\s*\d+\.\s*/, ''), id: '' };
      })
      .filter((p) => p.name);
  },

  setupNotes: [
    'ARK ignores the -RCONEnabled=True command line flag. RCONEnabled=True must be',
    'set in GameUserSettings.ini under [ServerSettings], along with RCONPort and',
    'ServerAdminPassword. Each map needs its OWN RCONPort — they share one ini file.',
  ].join(' '),
};
