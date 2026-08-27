// Icarus.
//
// No RCON, no REST, no console — RocketWerkz exposes nothing to talk to a
// running server with, so this is a monitor-and-control-the-process profile in
// the same family as valheim.js: up/down, uptime, CPU, RAM, history, crash
// alerts, the watchdog, backups and scheduled restarts all work; the player list
// and broadcasts do not, and the UI hides those rather than offering buttons
// that can only fail.
//
// Administration happens in-game instead. A player whose Steam ID is in
// AdminPassword's ini section gets the server console with `\` — that is the
// only channel there is.

export default {
  id: 'icarus',
  label: 'Icarus',
  transport: 'none',

  defaults: {
    // Both UDP. The query port is a real Steam game server query port, not
    // decoration: Icarus registers with Steam's master server through it, and
    // if it cannot bind, OnlineSubsystemSteam logs "Steam Dedicated Server API
    // failed to initialize" and nobody can find or join the server.
    //
    // It defaults to 27016 rather than the usual 27015 on purpose. 27015 is the
    // first port every other Steam server on the box also wants — Palworld took
    // it here — and the failure is silent unless you read the log. Icarus takes
    // -QueryPort= on the command line; the start .bat passes this value.
    gamePort: 17777,
    queryPort: 27016,

    // "Icarus Dedicated Server" on Steam. Lets the dashboard read the installed
    // build out of the manifest and compare it with the published one — see
    // src/steam.js. This is a SteamCMD-only tool and never appears in the Steam
    // client's library, so its manifest lives in whatever folder SteamCMD was
    // pointed at: the target needs a steamLibrary alongside this.
    steamAppId: 2089300,

    // Measured cold-start on an NVMe box is well under a minute, but Icarus
    // loads the prospect's terrain before it accepts anyone and a big, long-run
    // prospect is far slower than a fresh one. Nothing probes the server during
    // this window; it only stops the watchdog counting a loading server as down.
    readyAfterSeconds: 120,
  },

  setupNotes: [
    'The name players see in the server browser comes from -SteamServerName= on',
    'the command line, not from SessionName in ServerSettings.ini. Without the',
    'switch the server lists under its raw numeric Steam session id while looking',
    'perfectly healthy otherwise.',
    ' ',

    'Icarus ships two self-shutdown timers, ShutdownIfNotJoinedFor and',
    'ShutdownIfEmptyFor, both defaulting to 300 seconds. An idle server therefore',
    'exits on purpose five minutes after the last player leaves — which the',
    'watchdog cannot tell apart from a crash, so it restarts it, and five minutes',
    'later the pair do it again. Set both to -1 in ServerSettings.ini to disable',
    'them, or turn the watchdog off for this target. Do not leave the defaults',
    'and the watchdog on together.',
  ].join(' '),
};
