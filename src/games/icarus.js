// Icarus.
//
// No RCON, no REST, no console — RocketWerkz exposes nothing to *talk to* a
// running server with, so this is a monitor-and-control-the-process profile:
// up/down, uptime, CPU, RAM, history, crash alerts, the watchdog, backups and
// scheduled restarts all work; broadcasts and a clean remote shutdown do not,
// and the UI hides those rather than offering buttons that can only fail.
//
// It can still be *read*, though. Icarus registers with Steam and answers
// A2S_INFO on its query port, which is where the player count on the card comes
// from — see src/a2s.js. That count is what makes "update while nobody is
// online" and "skip the shutdown warning, the server is empty" real decisions
// here instead of guesses.
//
// Administration happens in-game instead. A player whose Steam ID is in
// AdminPassword's ini section gets the server console with `\` — that is the
// only channel there is.

export default {
  id: 'icarus',
  label: 'Icarus',
  transport: 'none',

  // A2S_INFO gives the count; A2S_PLAYER does not give names. Icarus answers it
  // with the right number of entries and an empty string in every name field,
  // so asking costs a second UDP round trip every poll and returns nothing the
  // count did not already say. The card shows "N online" without a list.
  query: {
    protocol: 'a2s',
    names: false,
  },

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

  // Shown on the card in place of the console and broadcast boxes. Those are
  // hidden because they cannot work here, and a blank space where Palworld has
  // three controls reads as a broken card rather than a different game — so say
  // which it is, once, where the missing controls would have been.
  noRemoteNote: 'Icarus exposes no RCON, REST or console port, so in-game '
    + 'broadcasts and a clean remote shutdown are not possible. Stop and Restart '
    + 'work by terminating the process; SaveGameOnExit=True in ServerSettings.ini '
    + 'is what makes that safe. Admin commands are typed in-game with \\ by a '
    + 'player whose Steam ID is in the AdminPassword section.',

  // Where the Mods panel looks, relative to the target's steamInstallDir. Icarus
  // distributes mods through mod.io rather than the Steam Workshop, and they
  // arrive as loose Unreal packages rather than as manifested folders, so there
  // is no "an update is waiting" to compute — the panel lists what is present
  // and when it was last written.
  //
  // Three candidates because the engine will load from any of them and which
  // one is in use depends on how the mod was installed; the first that exists
  // wins, and if none do, the first is where they would go.
  mods: {
    kind: 'paks',
    candidates: [
      'Icarus/Mods',
      'Icarus/Content/Paks/~mods',
      'Icarus/Content/Paks/mods',
    ],
    note: 'Icarus mods come from mod.io as loose .pak files, not from the Steam '
      + 'Workshop, so there is no subscription to compare against — this lists '
      + 'what is on disk. A mod built for an older build can stop the server '
      + 'loading a prospect, so remove it here and restart if a game update '
      + 'breaks the server.',
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
