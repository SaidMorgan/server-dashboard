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

  // Binding the query port and registering a session are two different things,
  // and only the first one fails loudly. The server can initialise the Steam
  // Game Server API, bind 27016, load the prospect and sit there looking
  // perfectly healthy while FOnlineAsyncTaskSteamCreateServer has quietly timed
  // out -- and a server with no session is in no browser, LAN or internet, with
  // nothing in the process table to suggest why. The watchdog actively hides
  // this: the process is alive, so every check passes.
  //
  // Checked once per start, once the run has had time to get there.
  logHealth: {
    afterSeconds: 90,
    // Two distinct silent failures, same symptom. "initialized 0" is the query
    // port being unavailable -- something else on the box already has it.
    // "CreateServer ... bWasSuccessful: 0" is the port being fine and the
    // registration losing a race: Steam gives that task a fixed 15 seconds and
    // ticks it on the game thread, which ResumeProspect=True has busy loading
    // the prospect's terrain. See docs/games.md -- a restart does not fix it.
    pattern: /Game Server API initialized 0|FOnlineAsyncTaskSteamCreateServer bWasSuccessful: 0/,
    message: 'Started, but it never registered a session with Steam — it will '
      + 'not appear in the LAN or internet server browser until it is restarted. '
      + 'Check Icarus.log for "Game Server API initialized 0" (query port taken) '
      + 'or "FOnlineAsyncTaskSteamCreateServer bWasSuccessful: 0" (Steam did not answer)',
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
