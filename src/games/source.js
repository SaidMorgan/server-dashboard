// Generic Source-engine RCON (CS2, TF2, Garry's Mod, Left 4 Dead 2, Rust, ...).
//
// A sane default for any game that speaks standard Source RCON. If your game
// needs a different command vocabulary, copy this file into your own games/
// folder, change the id, and set "game" to that id in config.json.

export default {
  id: 'source',
  label: 'Source RCON (generic)',
  transport: 'rcon-oneshot',

  defaults: {
    gamePort: 27015,
    queryPort: 27015,
    rconPort: 27015,
  },

  commands: {
    list: 'status',
    save: null, // most Source games have no save command; the UI hides the button
    broadcast: (msg) => `say ${msg}`,
    shutdown: 'quit',
  },

  // Deliberately limited to commands every Source game understands. A game with
  // a richer vocabulary deserves its own profile — see the note above.
  consoleCommands: [
    { command: 'status', description: 'Server state and the connected players' },
    { command: 'users', description: 'Connected players, names and IDs only' },
    { command: 'stats', description: 'CPU, frame rate and network throughput' },
    { command: 'version', description: 'Server build number' },
    { command: 'say <message>', description: 'Server message in everyone\'s chat' },
    { command: 'kick "<name>"', description: 'Disconnect one player; they can rejoin' },
    { command: 'changelevel <map>', description: 'Switch maps — everyone reloads into the new one', danger: true },
    { command: 'quit', description: 'Shut the server down — it will not come back on its own', danger: true },
  ],

  // status output, one player per line:
  // # 2 "PlayerName" STEAM_1:0:1234 05:12 45 0 active 196608
  parsePlayers(body) {
    if (!body) return [];
    const out = [];
    for (const line of body.split(/\r?\n/)) {
      const m = line.match(/^#\s*\d+\s+"([^"]+)"\s+(\S+)/);
      if (m) out.push({ name: m[1], id: m[2] });
    }
    return out;
  },

  setupNotes: 'Set rcon_password in server.cfg and make sure the RCON port is reachable.',
};
