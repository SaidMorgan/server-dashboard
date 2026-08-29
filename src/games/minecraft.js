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
  ],

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
