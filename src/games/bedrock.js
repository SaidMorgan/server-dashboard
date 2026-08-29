// Minecraft: Bedrock Edition (the official Bedrock Dedicated Server).
//
// A different product from the `minecraft` profile next door, not a variant of
// it. That one speaks Source RCON, which is a *Java Edition* feature; BDS has
// no RCON, no REST and no telnet of its own. Its console is stdin on
// bedrock_server.exe, and the dashboard starts servers detached (see
// src/win.js), so nothing is holding that pipe.
//
// So this profile assumes BDS is launched under tools/bds-supervisor.js, which
// holds that stdin and speaks Source RCON on its behalf. That is what makes
// transport 'rcon-persistent' rather than 'none': the supervisor never closes
// an accepted socket on its own, so one held connection is right, and it is
// cheaper than reconnecting per command.
//
// Run BDS directly, without the supervisor, and everything here still degrades
// safely -- up/down, CPU/RAM, the RakNet player count, watchdog and backups all
// come from elsewhere. Only the RCON half goes to 'error' on the card.
//
// The count also still comes from RakNet rather than from `list`: BDS answers
// the unconnected ping that the Bedrock client sends to draw its server list
// (src/raknet.js), which is free and needs no auth. RCON adds the *names* the
// ping cannot carry, plus broadcast, save and a genuine clean shutdown.

import { bedrockGamerules } from './gamerules.js';

export default {
  id: 'bedrock',
  label: 'Minecraft (Bedrock)',
  transport: 'rcon-persistent',

  // Names come from `list` over the supervisor, not from the ping: the RakNet
  // reply is one string with a number in it and no player list whatsoever.
  query: {
    protocol: 'raknet',
    names: false,
  },

  defaults: {
    // UDP, and the same port twice on purpose. Bedrock answers the ping on the
    // port people connect to -- there is no separate query port the way a Steam
    // game has one, so a target sets queryPort to the same 19132. Nothing binds
    // twice; the dashboard just sends its ping where the clients send theirs.
    gamePort: 19132,
    queryPort: 19132,

    // The supervisor's listener, not the server's -- BDS has no RCON port to
    // default to. Deliberately not 25575: that is the Java Edition default, and
    // a box running both should not have them collide.
    rconPort: 25585,

    // The unambiguous half of running Bedrock rather than Java: this is a
    // native executable with its own name, so per-process CPU and RAM are
    // attributed correctly. The `minecraft` profile has to default processName
    // to "java" and cannot tell two Java servers apart.
    //
    // Still bedrock_server and not the supervisor: the dashboard should measure
    // the game, and a stop should be judged by the game's process going away.
    processName: 'bedrock_server',

    // BDS starts fast -- a small world is up in a few seconds -- but neither
    // the ping nor the console answers until the level is loaded, and a large
    // world takes longer. This only stops the card reporting an error during a
    // start it is already reporting as starting.
    readyAfterSeconds: 60,
  },

  commands: {
    list: 'list',

    // Not a plain `save`. A correct Bedrock save is `save hold`, then `save
    // query` until it confirms, then `save resume` -- and skipping the resume
    // leaves the world held and never auto-saving again. The supervisor runs
    // all three as one atomic command; see the saveMacro note in
    // tools/bds-supervisor.js.
    save: 'dashboard:save',

    broadcast: (msg) => `say ${msg}`,
    shutdown: 'stop',
  },

  consoleCommands: [
    { command: 'list', description: 'Who is online, and the player cap' },
    { command: 'dashboard:save', description: 'Hold, confirm and resume the world save in one step' },
    { command: 'save hold', description: 'Begin a save so the world can be copied — must be resumed', danger: true },
    { command: 'save query', description: 'Ask whether the held save has finished' },
    { command: 'save resume', description: 'Resume normal saving after save hold' },
    { command: 'say <message>', description: 'Server message in everyone\'s chat' },
    { command: 'tell "<player>" <message>', description: 'Private message to one player' },
    { command: 'kick "<player>"', description: 'Disconnect one player; they can rejoin' },
    // Spelled out one shape per line rather than behind a single
    // <allowlistAction> slot, the way the Java profile writes its whitelist.
    // Bedrock gamertags may contain spaces, so the name has to arrive quoted,
    // and quotes belong to a slot in the command -- a list of values carried
    // over from the word before cannot add them.
    { command: 'allowlist list', description: 'Show who is on the allow list' },
    { command: 'allowlist add "<player>"', description: 'Let a player onto an allow-listed server' },
    { command: 'allowlist remove "<player>"', description: 'Take a player off the allow list' },
    { command: 'allowlist on', description: 'Enforce the allow list — with an empty list this locks everyone out, including you', danger: true },
    { command: 'allowlist off', description: 'Stop enforcing the allow list' },
    { command: 'allowlist reload', description: 'Re-read allowlist.json from disk' },
    { command: 'permission list', description: 'Show operator permissions' },
    { command: 'op "<player>"', description: 'Grant operator rights' },
    { command: 'deop "<player>"', description: 'Remove operator rights' },
    { command: 'gamemode <gamemode> "<player>"', description: 'Change what mode a player is in' },
    { command: 'gamerule <gamerule> <value>', description: 'Read or set one of the world rules' },
    { command: 'time set <time>', description: 'Set the time of day' },
    { command: 'weather <weather>', description: 'Change the weather' },
    { command: 'difficulty <difficulty>', description: 'Change the difficulty' },
    { command: 'stop', description: 'Save and shut the server down — it will not come back on its own', danger: true },
  ],

  // Options for the <placeholders> above, so the console can suggest the next
  // word rather than leaving a name to be remembered. An option's own `values`
  // are what the slot *after* it offers, which is how a gamerule decides
  // whether the next box is true/false or a number. <player> is not listed:
  // the console fills that one from whoever is actually online.
  argValues: {
    gamerule: bedrockGamerules,
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
      { value: 'sunrise', description: 'First light, 23000 ticks' },
      { value: 'sunset', description: 'Last light, 12000 ticks' },
    ],
    weather: [
      { value: 'clear', description: 'Stop rain and storms' },
      { value: 'rain', description: 'Start rain' },
      { value: 'thunder', description: 'Start a thunderstorm' },
    ],
  },

  // "There are 2/10 players online:" and then the names on the FOLLOWING line,
  // which is where this differs from Java's single-line reply. The /s flag is
  // what lets (.*) cross that newline.
  parsePlayers(body) {
    if (!body) return [];
    const m = body.match(/players online:\s*(.*)/is);
    if (!m) return [];
    return m[1]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean)
      .map((name) => ({ name, id: '' }));
  },

  setupNotes: [
    'Launch BDS through tools/bds-supervisor.js rather than bedrock_server.exe',
    'directly — it holds the console stdin that BDS has instead of RCON, and',
    'serves Source RCON on rconPort for the dashboard. Without it the card still',
    'shows up/down, CPU, RAM and the player count, but RCON reads as an error and',
    'Stop goes back to being a hard kill. Put the password in .env as',
    'BEDROCK_RCON_PASSWORD; the supervisor reads the same file the dashboard does.',
    ' ',

    'That listener binds to 127.0.0.1 by default and should stay there. Source',
    'RCON sends its password in plaintext, so it must never be the thing exposed',
    'to the internet — only the UDP game port should be forwarded.',
    ' ',

    'Bedrock is not on Steam and has no SteamCMD app id, so the Steam build check',
    'has nothing to read here. "Check for update" on the card is a different',
    'thing that does the whole job instead: it asks minecraft.net for the current',
    'version, and if this one is older it stops the server, downloads the zip,',
    'unpacks it over the install, deletes the zip and starts the server again.',
    'server.properties, allowlist.json, whitelist.json and permissions.json are',
    'never overwritten — the zip ships stock copies of all four — and neither are',
    'worlds/ or the development_* folders. Nothing is deleted either, so add-on',
    'packs and scripts of your own survive. See src/mcupdate.js.',
    ' ',

    'Set "minecraftUpdate": { "auto": true } on the target to have that happen by',
    'itself when a version lands and nobody is online. It is a safer proposition',
    'here than on a modded Java server: Bedrock has no plugins to break.',
    ' ',

    'The shipped server.properties has allow-list=true, so a brand new server',
    'lets nobody in and looks like a networking fault. Add players to',
    'allowlist.json, or set it to false.',
    ' ',

    'The port is UDP, not TCP. A firewall rule made for a Java server will not',
    'pass Bedrock traffic, and consoles need UDP 19132 specifically.',
  ].join(' '),
};
