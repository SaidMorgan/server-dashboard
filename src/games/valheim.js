// Valheim.
//
// Vanilla Valheim's dedicated server has no RCON and no console — there is no
// supported way to read the player list or send a message remotely. So this is
// a monitor-and-control-the-process profile: uptime, CPU, RAM, start, stop and
// restart all work; player count and broadcasts do not.
//
// If you run a BepInEx RCON mod, copy src/games/source.js into your own games/
// folder instead and point "game" at that.

export default {
  id: 'valheim',
  label: 'Valheim',
  transport: 'none',

  defaults: {
    gamePort: 2456,
    queryPort: 2457,
    // "Valheim Dedicated Server" on Steam — see src/steam.js.
    steamAppId: 896660,
  },

  setupNotes: [
    'Valheim exposes no query or RCON interface, so the dashboard can only report',
    'whether the process is alive and how much CPU and memory it is using. Stop and',
    'Restart terminate the process directly; Valheim saves on shutdown, but there is',
    'no way to force a save first, so prefer restarting when nobody is online.',
  ].join(' '),
};
