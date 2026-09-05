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
//
// What it cannot be *asked*, it can still be read from what it writes down: the
// player names come out of its log (src/logplayers.js), the prospect and the
// save's age out of the save file (src/savegame.js), and whether it is really in
// the server browser out of Steam itself (src/steamlisting.js).
import { sliceJsonObject } from '../savegame.js';

export default {
  id: 'icarus',
  label: 'Icarus',
  transport: 'none',

  // A2S_INFO gives the count; A2S_PLAYER does not give names. Icarus answers it
  // with the right number of entries and an empty string in every name field,
  // so asking costs a second UDP round trip every poll and returns nothing the
  // count did not already say. The names come out of the log instead -- see
  // playersFromLog below -- and this stays the authority on the count.
  query: {
    protocol: 'a2s',
    names: false,
    // Icarus fills the A2S version field with a flat "0.0.0.1" and has done
    // through every build it has shipped. Taking it would put a confident,
    // permanently wrong number on the card, so it is refused here and the real
    // one is read out of the log below instead.
    version: false,
  },

  // "====> Version: 3.0.25.156508-Shipping-DangerousHorizons <===="
  //
  // Only the numeric part is kept: the suffix is the build flavour and the
  // release's codename, which change with every content drop and would make the
  // tile wrap. LogIcarusGameInstance prints this once, early, which is why the
  // monitor reads the head of this log rather than the tail.
  //
  // Not to be confused with the two "Version: 4.27.x" lines just above it in
  // the same file — those are the Unreal Engine build, not the game.
  versionLog: { pattern: /====>\s*Version:\s*([\d.]+)/ },

  // Who is on, from the same log. A2S_PLAYER blanks every name, so this is the
  // only place the server ever says one out loud:
  //
  //   LogConnectedPlayers: Display: AddConnectedPlayer - UserId: 7656... | PlayerName: Someone
  //   LogConnectedPlayers: Display: RemoveConnectedPlayer - UserId: 7656...
  //
  // Only the Add/Remove pair is matched, deliberately. The same category prints
  // ServerTryCompletePlayerInitialisation and FinaliseConnectedPlayerInitialisation
  // for the same join, sometimes several times, and counting those would put a
  // player on the card twice. These two are the ones that bracket a session.
  //
  // Icarus rotates its log on every start, so the reconstructed roster covers
  // exactly the current run and a restart forgets everyone -- which is correct,
  // since a restart disconnects them. See src/logplayers.js.
  playersFromLog: {
    join: /AddConnectedPlayer - UserId:\s*(\d+)\s*\|\s*PlayerName:\s*(.*)$/,
    leave: /RemoveConnectedPlayer - UserId:\s*(\d+)/,
  },

  // The prospect, read out of the save file. Nothing else on the box says which
  // world is loaded, how far into it the server is, or on what difficulty --
  // there is no query field for it and no console to ask -- but the save's
  // header says all of it in plain JSON before the actor blob starts.
  //
  // The mtime is the more important half. Stop and Restart here are a kill made
  // safe only by SaveGameOnExit, and this file's age is the only evidence that
  // pressing Restart will not cost the evening. See src/savegame.js.
  saveInfo: {
    dir: 'Icarus/Saved/PlayerData/DedicatedServer/Prospects',
    // The game keeps ten rolling copies (`Olympus.json.backup_7`) beside the
    // live file. Matching only the bare .json keeps the newest-file rule
    // pointing at the one the server is actually writing.
    match: /^[^.]+\.json$/i,
    parse(head) {
      const info = sliceJsonObject(head, 'ProspectInfo');
      if (!info) return null;
      const members = Array.isArray(info.AssociatedMembers) ? info.AssociatedMembers : [];
      return {
        prospect: info.ProspectID || null,
        // "Outpost006_Olympus" -- the table row key, which carries the map and
        // the mission slot. The trailing word is the part a player would name.
        mapKey: info.ProspectDTKey || null,
        map: (info.ProspectDTKey || '').split('_').pop() || null,
        difficulty: info.Difficulty || null,
        state: info.ProspectState || null,
        // Seconds of in-prospect time, which is not the same as server uptime:
        // it does not advance while the prospect is unloaded, so it is the real
        // "how far into this world are we".
        elapsedSeconds: typeof info.ElapsedTime === 'number' ? info.ElapsedTime : null,
        hardcore: Boolean(info.NoRespawns),
        insurance: Boolean(info.Insurance),
        members: members.map((m) => ({
          name: m.CharacterName || m.AccountName || null,
          id: m.UserID || null,
          playing: Boolean(m.IsCurrentlyPlaying),
        })),
      };
    },
  },

  // Proof that the server is in the Steam browser, which is the one thing the
  // logHealth check below cannot give. That check reads an error line and
  // infers the consequence; this asks Steam what it is currently advertising.
  //
  // The inference has been wrong in practice -- a run that logged
  // `bWasSuccessful: 0` has since been found perfectly joinable -- which is why
  // the restart in src/monitor.js hangs off this and not off the log.
  //
  // appId is the id the server advertises itself under, which is the GAME
  // (1149460, and it is what `[AppId: ...]` in the log shows), not the
  // dedicated server tool in `defaults.steamAppId` (2089300). Filtering by the
  // wrong one returns an empty list for a perfectly healthy server.
  listing: { appId: 1149460 },

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
