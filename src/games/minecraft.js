// Minecraft (Java Edition, vanilla / Paper / Spigot / Fabric).
//
// Well-behaved Source RCON: it closes sockets properly and has no connection
// cap worth worrying about, so a persistent connection is safe and cheaper.

import { javaGamerules } from './gamerules.js';

export default {
  id: 'minecraft',
  label: 'Minecraft (Java)',
  transport: 'rcon-persistent',

  defaults: {
    gamePort: 25565,
    rconPort: 25575,
    processName: 'java',
  },

  commands: {
    list: 'list',
    save: 'save-all',
    broadcast: (msg) => `say ${msg}`,
    shutdown: 'stop',
  },

  // Bans are read from banned-players.json but written with these, never by
  // editing that file: a live server holds the list in memory and rewrites it
  // on the next change, so a hand-edited file is undone the moment anyone else
  // is banned. See src/moderation.js.
  //
  // Vanilla /ban takes the reason as the rest of the line, unquoted.
  moderation: {
    kind: 'minecraft-java',
    ban: (name, reason) => (reason ? `ban ${name} ${reason}` : `ban ${name}`),
    pardon: (name) => `pardon ${name}`,
    banIp: (ip, reason) => (reason ? `ban-ip ${ip} ${reason}` : `ban-ip ${ip}`),
    pardonIp: (ip) => `pardon-ip ${ip}`,
  },

  consoleCommands: [
    { command: 'list', description: 'Who is online, and the player cap' },
    { command: 'save-all', description: 'Flush all chunks to disk now' },
    { command: 'save-off', description: 'Stop auto-saving — for taking a clean copy of the world', danger: true },
    { command: 'save-on', description: 'Resume auto-saving after save-off' },
    { command: 'say <message>', description: 'Server message in everyone\'s chat' },
    { command: 'tell <player> <message>', description: 'Private message to one player' },
    { command: 'kick <player>', description: 'Disconnect one player; they can rejoin' },
    { command: 'ban <player>', description: 'Ban a player by name' },
    { command: 'pardon <player>', description: 'Lift a ban' },
    { command: 'op <player>', description: 'Grant operator (admin) rights' },
    { command: 'deop <player>', description: 'Remove operator rights' },
    { command: 'whitelist <whitelistAction>', description: 'Show or change the whitelist' },
    { command: 'gamemode <gamemode> <player>', description: 'Change what mode a player is in' },
    { command: 'gamerule <gamerule> <value>', description: 'Read or set one of the world rules' },
    { command: 'time set <time>', description: 'Set the time of day' },
    { command: 'weather <weather>', description: 'Change the weather' },
    { command: 'difficulty <difficulty>', description: 'Change the difficulty' },
    { command: 'seed', description: 'Show the world seed' },
    { command: 'stop', description: 'Save and shut the server down — it will not come back on its own', danger: true },

    // Prism registers everything through Brigadier, so its jar declares no
    // commands and the live /help sweep finds a bare "prism" with nothing under
    // it. Spelling the subcommands out here is the only way the console can
    // offer them -- the list is read off Prism 4.4's own command classes.
    //
    // The first two are answered by the dashboard, not by the server: see
    // src/playerstats.js. They sit under `prism` because that is where an admin
    // already looks, and neither name exists in Prism itself.
    { command: 'prism players', description: 'Everyone who has ever played — balance, blocks broken, last seen' },
    { command: 'prism stats <knownPlayer>', description: 'One player in full: blocks, shop, earnings, and sold-vs-mined integrity' },
    { command: 'prism lookup <prismQuery>', description: 'Search the block log. Parameters: p:<player> a:<action> b:<block> r:<radius> w:<world> before:<date> since:<date> in:<chunk|world> at:<x,y,z> id:<n> reversed' },
    { command: 'prism page <n>', description: 'Another page of the last lookup' },
    { command: 'prism near', description: 'Recent activity around you — in game only, the console has no location' },
    { command: 'prism status', description: 'Whether Prism is recording, and how big its write queue is' },
    { command: 'prism about', description: 'Prism version and links' },
    { command: 'prism vault', description: 'Browse lookup results in a chest UI — in game only' },
    { command: 'prism wand <prismWand>', description: 'Give yourself an inspection or rollback wand — in game only' },
    { command: 'prism preview <prismPreview>', description: 'Show a rollback or restore before committing it — in game only' },
    { command: 'prism teleport <n>', description: 'Teleport to the activity on that result row — in game only' },
    { command: 'prism rollback <prismQuery>', description: 'Undo everything the query matches. Same parameters as lookup — run it as a lookup first', danger: true },
    { command: 'prism restore <prismQuery>', description: 'Re-apply everything the query matches, undoing a rollback', danger: true },
    { command: 'prism undo', description: 'Reverse your own last rollback or restore', danger: true },
    { command: 'prism purge <prismQuery>', description: 'Delete matching rows from the block log permanently — this is not a rollback', danger: true },

    // DuelArena is the other shape the usage parser cannot help with, for the
    // opposite reason to Prism's. It declares one command with fourteen words
    // under it in a single bracket group, which is more alternatives than the
    // parser will expand, so the whole line is dropped and Tab has nothing
    // after "arena". Its second level -- `tp <room>`, `t start`, `raid arm` --
    // was never in that line to begin with. Both are spelled out here.
    //
    // Only the words the console can actually run, plus the two worth knowing
    // exist. Everything else on /arena needs a body standing in the world.
    // The aliases live in commandAliases below, so /duelarena and /soloarena
    // complete the same list without a second copy of it.
    { command: 'arena status', description: 'Who is queued, what is running, how many hold a prize — the first thing to check when the arena is stuck' },
    { command: 'arena help', description: 'The player-facing command list' },
    { command: 'arena reload', description: 'Re-read config.yml and rebuild the stadium, chambers and boss rooms. Safe mid-session, NOT safe mid-fight — it puts blocks back where somebody is standing, so check status first', danger: true },
    { command: 'arena host', description: 'Open tournament sign-up' },
    { command: 'arena t <arenaTournament>', description: 'Run the tournament: open sign-up, close it early, or call it off' },
    { command: 'arena give <player>', description: 'A fresh beacon and all the books, ignoring what they had; needs three free slots' },
    { command: 'arena refresh <arenaRefresh>', description: 'Rewrite old prizes and books to their current version' },
    { command: 'arena refresh <player>', description: 'Rewrite the prizes and books one player is holding to their current version' },
    { command: 'arena raid arm', description: 'Force the next challenge anybody starts to become the village raid — the only way to make one happen on purpose' },
    { command: 'arena tp <arenaRoom>', description: 'Straight into a room without queueing — in game only' },
    { command: 'arena book', description: 'The Arena Maintenance book, to yourself — in game only' },
  ],

  // The same command under six other spellings, so the console completes
  // /duelarena and /soloarena exactly as it completes /arena. Aliases rather
  // than repeated rows: half the point of the list above is that there is one
  // of it to keep right.
  commandAliases: {
    arena: ['duel', 'soloarena', 'solo', 'caves', 'duelarena', 'da'],
  },

  // Options for the <placeholders> above, so the console can suggest the next
  // word rather than leaving a name to be remembered. An option's own `values`
  // are what the slot *after* it offers, which is how a gamerule decides
  // whether the next box is true/false or a number. <player> is not listed:
  // the console fills that one from whoever is actually online.
  //
  // whitelist is one command with a <whitelistAction> slot, where the Bedrock
  // profile writes its allowlist out one shape per line. The difference is not
  // taste: a Java name cannot contain a space, so it needs no quotes, and the
  // add/remove branches can hand the player list on through `values` without
  // one. Bedrock gamertags do contain spaces, so there the name has to sit in
  // a quoted slot of its own.
  argValues: {
    gamerule: javaGamerules,
    difficulty: ['peaceful', 'easy', 'normal', 'hard'],
    gamemode: [
      { value: 'survival', description: 'Normal play' },
      { value: 'creative', description: 'Flight, no damage, unlimited blocks' },
      { value: 'adventure', description: 'Cannot break blocks without the right tool' },
      { value: 'spectator', description: 'Fly through walls, touch nothing' },
    ],
    time: [
      { value: 'day', description: 'Morning, 1000 ticks' },
      { value: 'noon', description: 'Midday, 6000 ticks' },
      { value: 'night', description: 'Dusk, 13000 ticks' },
      { value: 'midnight', description: 'Middle of the night, 18000 ticks' },
    ],
    weather: [
      { value: 'clear', description: 'Stop rain and storms' },
      { value: 'rain', description: 'Start rain' },
      { value: 'thunder', description: 'Start a thunderstorm' },
    ],
    // Filled from /api/players — everybody the block log and the economy
    // remember, not only whoever happens to be online, because looking up a
    // player who is not here is the entire point of the command.
    knownPlayer: '@knownPlayers',
    arenaTournament: [
      { value: 'host', description: 'Open sign-up so anyone can enter' },
      { value: 'start', description: 'Close sign-up early and run the bracket' },
      { value: 'cancel', description: 'Call the whole thing off' },
    ],
    arenaRefresh: [
      { value: 'all', description: 'Everyone online' },
      { value: 'chests', description: 'Containers in loaded chunks — the bases of whoever is on' },
    ],
    arenaRoom: [
      { value: 'solo', description: 'A wave chamber' },
      { value: 'dragon', description: 'The dragon coliseum' },
      { value: 'warden', description: 'The buried city' },
      { value: 'duel', description: 'The pit' },
      { value: 'raid', description: 'The village, empty — to look at the build' },
    ],
    prismWand: [
      { value: 'inspect', description: 'Right-click a block to see its history' },
      { value: 'rollback', description: 'Right-click to undo changes at that block' },
      { value: 'restore', description: 'Right-click to re-apply changes at that block' },
      { value: 'off', description: 'Put the wand away' },
    ],
    prismPreview: [
      { value: 'apply', description: 'Commit the preview you are looking at' },
      { value: 'cancel', description: 'Throw the preview away' },
      { value: 'rollback', description: 'Preview a rollback rather than doing it' },
      { value: 'restore', description: 'Preview a restore rather than doing it' },
    ],
    whitelistAction: [
      { value: 'list', description: 'Show who is on the whitelist' },
      { value: 'add', description: 'Add a player', values: '@players' },
      { value: 'remove', description: 'Remove a player', values: '@players' },
      { value: 'on', description: 'Enforce the whitelist — anyone not on it is kicked' },
      { value: 'off', description: 'Stop enforcing the whitelist' },
      { value: 'reload', description: 'Re-read whitelist.json from disk' },
    ],
  },

  // "There are 3 of a max of 20 players online: Alice, Bob, Carol"
  // Some forks append extra sections after a second colon; take the first list.
  parsePlayers(body) {
    if (!body) return [];
    const m = body.match(/players online:\s*(.*)/is);
    if (!m) return [];
    return m[1]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean)
      // Paper can render names as "Alice (uuid)" when a plugin overrides /list.
      .map((n) => {
        const withId = n.match(/^(.+?)\s*\(([0-9a-f-]{8,})\)$/i);
        return withId ? { name: withId[1].trim(), id: withId[2] } : { name: n, id: '' };
      });
  },

  // The version tile. Bukkit, Spigot and Paper all answer `version`; vanilla
  // has no such command and simply reports nothing, which shows as a dash.
  //
  // The first call after a restart returns "Checking version, please wait..."
  // because Paper kicks off an is-there-a-newer-build lookup before answering.
  // Returning null for that is what makes it work: the monitor only caches a
  // real answer, so it asks again on the next poll and gets the cached string.
  versionCommand: 'version',

  // "§fThis server is running Paper version 26.2-120-main@1797fbc (2026-…) …"
  // becomes "Paper 26.2-120". The build number stays because on Paper it is the
  // part that actually moves -- the update checker tracks builds of one
  // Minecraft version, so "26.2" alone would never appear to change.
  parseVersion(body) {
    if (!body) return null;
    const clean = body.replace(/§./g, '');
    const m = clean.match(/running\s+(.+?)\s+version\s+(\S+)/i);
    if (!m) return null;
    const flavor = m[1].trim();
    // "26.2-120-main@1797fbc" -> "26.2-120"; a plain "1.21.4" is left alone.
    const parts = m[2].split('-');
    const version = /^\d+$/.test(parts[1] || '') ? `${parts[0]}-${parts[1]}` : parts[0];
    return `${flavor} ${version}`;
  },

  // Where the Plugins panel looks. Unlike the Steam games this resolves against
  // the folder the start command sits in, because Minecraft is not a Steam game
  // and a target for it has no steamInstallDir to resolve against.
  //
  // One candidate, not three: a Bukkit/Paper server loads plugins from exactly
  // one folder and there is nothing to guess. Vanilla has no plugins folder at
  // all, which is not an error -- the panel says the folder is not there, which
  // is the true and useful answer for a vanilla server.
  mods: {
    kind: 'plugins',
    noun: 'plugin',
    candidates: ['plugins'],
    note: 'Plugins are listed, never installed or updated — "Check for update" '
      + 'replaces the server jar only and does not touch this folder. Each entry '
      + 'is one .jar, read from the plugin.yml inside it. "API ≥" is the oldest '
      + 'Minecraft API the plugin declares it works with — a floor, not the '
      + 'version it was built for, so a maintained plugin can still say 1.13. '
      + 'Before moving to a new Minecraft version, check the release notes of '
      + 'each plugin; Geyser and Floodgate in particular have to be updated in '
      + 'the same pass as the server.',
  },

  setupNotes: [
    'Set enable-rcon=true, rcon.port=25575 and rcon.password in server.properties,',
    'then restart. Note processName defaults to "java": if you run more than one',
    'Java process this dashboard cannot tell them apart, so per-process CPU and RAM',
    'may report the wrong server. Player counts and RCON control are unaffected.',
    ' ',

    '"Check for update" reads the version out of the server jar itself, compares it',
    'against what Mojang (or PaperMC) publishes, and if a newer one is out it stops',
    'the server, downloads the jar, swaps it in and starts the server again. The',
    'jar it replaced is kept, so there is always a way back. Nothing else in the',
    'folder is touched — the world, server.properties and plugins/ are not part of',
    'the download. See src/mcupdate.js.',
    ' ',

    'For Paper, set "minecraftUpdate": { "flavor": "paper" } on the target. It then',
    'tracks new builds of the Minecraft version you are already on rather than new',
    'Minecraft versions, because every plugin you run is built against one version',
    'and a version bump is the thing that breaks them. Set "track": "latest" if you',
    'want it to follow releases anyway.',
  ].join(' '),
};
