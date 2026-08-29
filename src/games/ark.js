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
    // "ARK: Survival Ascended Dedicated Server" on Steam. Lets the dashboard read
    // the installed build out of Steam's manifest and compare it with the
    // published one — see src/steam.js.
    steamAppId: 2430930,
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

  // Offered in the console dropdown. `<angle brackets>` mark the part the user
  // has to fill in — the UI selects the first one so typing replaces it.
  consoleCommands: [
    { command: 'listplayers', description: 'List connected players with their IDs' },
    { command: 'saveworld', description: 'Force a world save to disk' },
    { command: 'broadcast <message>', description: 'Large message across every player\'s screen' },
    { command: 'serverchat <message>', description: 'Message in the chat panel only — easy to miss' },
    { command: 'getchat', description: 'Recent in-game chat since the last time you asked' },
    { command: 'getgamelog', description: 'Recent server log lines' },
    { command: 'settimeofday <timeOfDay>', description: 'Set the in-game clock, e.g. 09:00:00' },
    { command: 'kickplayer <steamID>', description: 'Disconnect one player; they can rejoin' },
    { command: 'banplayer <steamID>', description: 'Ban a player until you unban them' },
    { command: 'unbanplayer <steamID>', description: 'Lift a ban' },
    { command: 'destroywilddinos', description: 'Wipe all WILD creatures so they respawn — tamed ones are untouched', danger: true },
    { command: 'doexit', description: 'Save and shut the server down — it will not come back on its own', danger: true },
  ],

  // The <steamID> slots above need no entry here: the console fills any slot
  // named for an id from the player list, which is the whole reason
  // listplayers prints ids next to names. ARK is one of the games where that
  // matters — kickplayer takes the id and will not take the name.
  argValues: {
    timeOfDay: [
      { value: '05:30:00', description: 'Dawn' },
      { value: '09:00:00', description: 'Morning' },
      { value: '12:00:00', description: 'Midday' },
      { value: '17:30:00', description: 'Dusk' },
      { value: '22:00:00', description: 'Night' },
    ],
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
