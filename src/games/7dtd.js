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
    // "7 Days to Die Dedicated Server" on Steam — see src/steam.js.
    steamAppId: 294420,
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
    { command: 'settime <settime>', description: 'Set the in-game clock' },
    { command: 'getgamepref', description: 'Print every game preference and its current value' },
    { command: 'setgamepref <gamepref> <value>', description: 'Change one game preference' },
    // admin and ban are written out one shape per line rather than as one
    // command with a <subcommand> slot. Both branch further than a single
    // extra word -- "ban add" goes on to a name, a number and a unit -- and
    // spelling each shape out is what lets the console walk the whole way
    // down it.
    { command: 'admin list', description: 'Show who has admin rights' },
    { command: 'admin add "<name>" <permissionLevel>', description: 'Grant admin rights at a permission level' },
    { command: 'admin remove "<name>"', description: 'Take admin rights away' },
    { command: 'kick "<name>"', description: 'Disconnect one player; they can rejoin' },
    { command: 'ban list', description: 'Show who is banned' },
    { command: 'ban add "<name>" <banLength> <banUnit>', description: 'Ban a player for a length of time' },
    { command: 'ban remove "<name>"', description: 'Lift a ban' },
    { command: 'mem', description: 'Memory use, entity and chunk counts — also forces a cleanup' },
    { command: 'version', description: 'Server version and installed mods' },
    { command: 'shutdown', description: 'Save and shut the server down — it will not come back on its own', danger: true },
  ],

  // Game preferences are this game's version of Minecraft's gamerules: one
  // command, a long list of settings behind it, and a different set of sensible
  // values for each. The list below is the commonly-changed subset rather than
  // everything the server holds -- `getgamepref` prints the authoritative list,
  // and the box still takes a name that is not here.
  //
  // Not every preference takes effect while the server is running; several are
  // read once at world load, and setgamepref will accept them without any
  // visible result until a restart.
  argValues: {
    settime: [
      { value: 'day', description: 'Morning' },
      { value: 'night', description: 'Nightfall' },
    ],
    permissionLevel: [
      { value: '0', description: 'Full admin' },
      { value: '500', description: 'Moderator' },
      { value: '1000', description: 'Ordinary player' },
    ],
    banLength: ['1', '3', '7', '30'],
    banUnit: ['minute', 'hour', 'day', 'week', 'month', 'year'],
    gamepref: [
      { value: 'XPMultiplier', description: 'Experience rate, percent', values: ['100', '50', '200', '300'] },
      { value: 'LootAbundance', description: 'How much loot containers hold, percent', values: ['100', '50', '200', '300'] },
      { value: 'LootRespawnDays', description: 'Days before containers refill', values: ['7', '3', '15', '30'] },
      { value: 'AirDropFrequency', description: 'Hours between air drops, 0 for none', values: ['72', '0', '24', '48'] },
      { value: 'AirDropMarker', description: 'Air drops show on the map', values: ['true', 'false'] },
      { value: 'DropOnDeath', description: 'What you drop when you die', values: [
        { value: '0', description: 'Nothing' },
        { value: '1', description: 'Everything' },
        { value: '2', description: 'Toolbelt only' },
        { value: '3', description: 'Backpack only' },
        { value: '4', description: 'Delete all' },
      ] },
      { value: 'DropOnQuit', description: 'What you drop on quitting', values: ['0', '1', '2', '3'] },
      { value: 'DayLightLength', description: 'Daylight hours in a game day', values: ['18', '12', '14', '20'] },
      { value: 'DayNightLength', description: 'Real minutes in a game day', values: ['60', '30', '90', '120'] },
      { value: 'BloodMoonFrequency', description: 'Days between blood moons, 0 for none', values: ['7', '0', '3', '10'] },
      { value: 'BloodMoonRange', description: 'Days either side the blood moon may wander', values: ['0', '1', '3'] },
      { value: 'BloodMoonWarning', description: 'Hour the sky starts to redden, -1 for none', values: ['8', '-1'] },
      { value: 'BloodMoonEnemyCount', description: 'Blood moon enemies alive per player', values: ['8', '4', '12', '16'] },
      { value: 'EnemyDifficulty', description: 'Normal or feral enemies', values: [
        { value: '0', description: 'Normal' },
        { value: '1', description: 'Feral' },
      ] },
      { value: 'GameDifficulty', description: 'Scavenger through Insane', values: ['2', '0', '1', '3', '4', '5'] },
      { value: 'PlayerKillingMode', description: 'Who may kill whom', values: [
        { value: '0', description: 'No killing' },
        { value: '1', description: 'Allies only' },
        { value: '2', description: 'Strangers only' },
        { value: '3', description: 'Everyone' },
      ] },
      { value: 'BuildCreate', description: 'Creative building for everyone', values: ['false', 'true'] },
      { value: 'LandClaimSize', description: 'Blocks square a land claim protects', values: ['41', '21', '61'] },
      { value: 'LandClaimExpiryTime', description: 'Days a claim survives with nobody online', values: ['7', '3', '30'] },
      { value: 'ServerMaxAllowedViewDistance', description: 'Cap on how far clients may render', values: ['12', '6', '8', '10'] },
    ],
  },

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
