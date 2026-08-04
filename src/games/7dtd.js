// 7 Days to Die.
//
// Exposes Source RCON on its telnet/control port. It does not reliably close
// idle sockets across versions, so use one-shot connections.

export default {
  id: '7dtd',
  label: '7 Days to Die',
  transport: 'rcon-oneshot',

  defaults: {
    gamePort: 26900,
    rconPort: 8081,
  },

  commands: {
    list: 'lp',
    save: 'saveworld',
    broadcast: (msg) => `say "${msg.replace(/"/g, "'")}"`,
    shutdown: 'shutdown',
  },

  consoleCommands: [
    { command: 'lp', description: 'List connected players with their entity IDs' },
    { command: 'saveworld', description: 'Force a world save to disk' },
    { command: 'say "<message>"', description: 'Server message in everyone\'s chat — keep the quotes' },
    { command: 'gettime', description: 'Current in-game day and time' },
    { command: 'admin list', description: 'Show who has admin rights' },
    { command: 'kick <name>', description: 'Disconnect one player; they can rejoin' },
    { command: 'ban add <name> 1 day', description: 'Ban a player for a duration (unit: minute, hour, day…)' },
    { command: 'ban remove <name>', description: 'Lift a ban' },
    { command: 'mem', description: 'Memory use, entity and chunk counts — also forces a cleanup' },
    { command: 'version', description: 'Server version and installed mods' },
    { command: 'shutdown', description: 'Save and shut the server down — it will not come back on its own', danger: true },
  ],

  // "1. id=171, SomeName, pos=(1.2, 3.4, 5.6), rot=..., health=100, ..."
  // followed by a "Total of N in the game" summary line.
  parsePlayers(body) {
    if (!body) return [];
    const out = [];
    for (const line of body.split(/\r?\n/)) {
      const m = line.match(/^\s*\d+\.\s*id=(\d+),\s*(.+?),\s*pos=/i);
      if (m) out.push({ name: m[2].trim(), id: m[1] });
    }
    return out;
  },

  setupNotes: [
    'Set TelnetEnabled=true, TelnetPort=8081 and TelnetPassword in serverconfig.xml.',
    'The RCON password is the telnet password.',
  ].join(' '),
};
