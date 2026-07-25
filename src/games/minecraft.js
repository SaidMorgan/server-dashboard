// Minecraft (Java Edition, vanilla / Paper / Spigot / Fabric).
//
// Well-behaved Source RCON: it closes sockets properly and has no connection
// cap worth worrying about, so a persistent connection is safe and cheaper.

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

  setupNotes: [
    'Set enable-rcon=true, rcon.port=25575 and rcon.password in server.properties,',
    'then restart. Note processName defaults to "java": if you run more than one',
    'Java process this dashboard cannot tell them apart, so per-process CPU and RAM',
    'may report the wrong server. Player counts and RCON control are unaffected.',
  ].join(' '),
};
