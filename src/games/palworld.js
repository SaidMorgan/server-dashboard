// Palworld.
//
// Uses the REST API, not RCON. Palworld's RCON is deprecated (the official docs
// say it "is scheduled to stop functioning in an upcoming update"), it mangles
// multi-byte player names, and it wedges if you hold a connection open — the
// exact opposite of what ARK needs. REST also returns more: ping and level.
import * as rest from '../palworld-rest.js';

export default {
  id: 'palworld',
  label: 'Palworld',
  transport: 'rest',
  rest,

  defaults: {
    gamePort: 8211,
    restPort: 8212,
    // Palworld renders this as an on-screen countdown — the only server message
    // players can't miss, since announce only reaches the chat panel.
    shutdownCountdownSeconds: 60,
  },

  // Verbs the RCON console box accepts for this target, since there is no raw
  // command string to pass through.
  restVerbs: {
    showplayers: async (t) => {
      const r = await rest.listPlayers(t);
      if (!r.ok) return r;
      return {
        ok: true,
        body: r.players.length
          ? r.players.map((p) => `${p.name}  lvl ${p.level ?? '?'}  ${p.ping ?? '?'}ms`).join('\n')
          : 'No players connected',
      };
    },
    info: async (t) => {
      const r = await rest.info(t);
      return r.ok ? { ok: true, body: JSON.stringify(r.data, null, 2) } : r;
    },
    metrics: async (t) => {
      const r = await rest.metrics(t);
      return r.ok ? { ok: true, body: JSON.stringify(r.data, null, 2) } : r;
    },
    save: (t) => rest.save(t),
    announce: (t, arg) => rest.announce(t, arg),
    shutdown: (t, arg) => {
      const [secs, ...msg] = arg.split(/\s+/);
      return rest.shutdown(t, Number(secs) || 10, msg.join(' ') || 'Server restarting');
    },
  },

  verbAliases: { listplayers: 'showplayers', broadcast: 'announce' },

  setupNotes: [
    'Set RESTAPIEnabled=True and RESTAPIPort=8212 in PalWorldSettings.ini. Auth is',
    'HTTP Basic as user "admin" with your AdminPassword. Broadcasts land in the',
    'in-game chat panel, which fades when idle — players not looking at it will',
    'swear nothing arrived, even though the API returned 200.',
  ].join(' '),
};
