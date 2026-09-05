import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig, ConfigError, isLoopback, validateCron } from './src/config.js';
import { loadUserProfiles, getProfile } from './src/games/index.js';
import { createAuth, assertBindIsSafe, UnsafeBindError } from './src/auth.js';
import { Monitor } from './src/monitor.js';
import { UsageStats } from './src/usage.js';
import { Actions } from './src/actions.js';
import { Backups } from './src/backup.js';
import { Notifier } from './src/notify.js';
import { Scheduler, describeCron, nextRun } from './src/scheduler.js';
import { SteamUpdates } from './src/steam.js';
import { MinecraftUpdates } from './src/mcupdate.js';
import { PluginUpdates } from './src/pluginupdate.js';
import { WorkshopMods } from './src/workshop.js';
import { inventory as modInventory, modSource } from './src/mods.js';
import { CommandIndex, buildCommandList } from './src/commands.js';
import { closeAll } from './src/rcon.js';
import * as moderation from './src/moderation.js';
import { knownPlayers } from './src/playerstats.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');

// User-supplied game profiles are registered before the config is validated,
// so config.json can reference them by id.
const userProfiles = await loadUserProfiles(path.join(here, 'games'));
if (userProfiles.length) console.log(`Loaded custom game profiles: ${userProfiles.join(', ')}`);

let config;
try {
  config = loadConfig({ dir: here });
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.format(process.env.SD_CONFIG || path.join(here, 'config.json')));
    process.exit(1);
  }
  throw err;
}

// Exposed to the network without a password? Stop, and explain. See src/auth.js.
try {
  assertBindIsSafe(config);
} catch (err) {
  if (err instanceof UnsafeBindError) {
    console.error(err.format());
    process.exit(1);
  }
  throw err;
}

const auth = createAuth(config, config.dataDir);
const monitor = new Monitor(config, config.dataDir);
const usage = new UsageStats(config, config.dataDir);
const actions = new Actions(config, monitor);
const backups = new Backups(config, monitor, actions);
const notifier = new Notifier(config);
const scheduler = new Scheduler(config, monitor, actions, backups, config.dataDir);
const steam = new SteamUpdates(config, monitor, config.dataDir);
// Minecraft is not on Steam, so its updates are a different publisher, a
// different comparison and -- because nothing else owns the install -- a
// download the dashboard can perform itself. See src/mcupdate.js.
const mcupdates = new MinecraftUpdates(config, monitor, config.dataDir);
const workshop = new WorkshopMods(config, monitor, config.dataDir);
// The other half of a Paper install: the jars in plugins\, each from its own
// publisher. Separate from mcupdates because the server jar and the plugins
// move on different schedules -- and must never move at the same moment, which
// is what the otherBusy wiring below prevents. See src/pluginupdate.js.
const pluginupdates = new PluginUpdates(config, monitor, config.dataDir);
// Live command sweeps, cached. Needs actions for RCON; nothing sweeps until
// something asks for a command list.
const commandIndex = new CommandIndex(actions);

// These know about each other, so the wiring happens here rather than through
// constructor arguments that would be circular.
actions.backups = backups;
monitor.attach({ actions, notifier, usage });
steam.attach({ actions });
mcupdates.attach({ actions, otherBusy: (id) => pluginupdates.busy.has(id) });
workshop.attach({ actions });
pluginupdates.attach({ actions, otherBusy: (id) => mcupdates.busy.has(id) });

monitor.start();
scheduler.start();
steam.start();
mcupdates.start();
workshop.start();
pluginupdates.start();

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '64kb' }));
auth.routes(app, publicDir);
app.use(auth.middleware);
app.use(auth.requireJson);
app.use(express.static(publicDir));

// Never let RCON passwords out over the wire. The UI also needs to know what
// each game can actually do, so it can hide buttons that would only ever fail.
const publicTarget = (t) => {
  const profile = t.kind === 'game' ? getProfile(t.game) : null;
  return {
    id: t.id, name: t.name, kind: t.kind, game: t.game ?? null,
    gameLabel: profile?.label ?? null,
    transport: profile?.transport ?? null,
    canBroadcast: Boolean(profile && (profile.transport === 'rest' || profile.commands?.broadcast)),
    canSave: Boolean(profile && (profile.transport === 'rest' || profile.commands?.save)),
    canConsole: Boolean(profile && profile.transport !== 'none'),
    // A delayed restart is the dashboard's own timer, so it works for any game
    // it can start again -- it does not need a way to talk to the server. It
    // used to be hidden alongside the broadcast box, which meant a game with no
    // chat channel also lost the ability to schedule a restart at all. What it
    // loses without broadcast is only the warning, and the card says so.
    canDelayRestart: Boolean(profile && t.kind === 'game' && t.startCommand),
    // Restarting at the first empty moment needs a readable player count and
    // nothing else -- no console, no chat. It is the only "restart soon" that
    // is honest on a server that cannot warn anyone.
    canRestartWhenEmpty: Boolean(profile && t.kind === 'game' && t.startCommand
      && (profile.transport !== 'none' || (profile.query && t.queryPort))),
    // Shown where the console and broadcast controls would have been. An empty
    // gap reads as a broken card; one line naming the reason reads as a
    // different game.
    remoteNote: (profile && profile.transport === 'none' && profile.noRemoteNote) || null,
    // A game with no control transport can still have a readable player count
    // (Icarus answers Steam queries), so the players panel is not tied to RCON.
    hasQuery: Boolean(profile?.query && t.queryPort),
    // ...but a count with no names is a number, not a list, and the panel says
    // so instead of rendering an empty one. A game whose log announces joins and
    // leaves does have names, even with no transport and a nameless query --
    // Icarus is read that way, see src/logplayers.js.
    hasPlayerNames: Boolean(profile && (profile.transport !== 'none' || profile.query?.names
      || (profile.playersFromLog && t.logFile))),
    consoleCommands: profile?.consoleCommands ?? [],
    // Options for the <placeholders> inside those commands, so the console can
    // suggest the next word as it is typed. Sent whole rather than queried per
    // keystroke: it is a few KB of static data per game and the alternative is
    // a round trip between letters.
    consoleArgs: profile?.argValues ?? {},
    // alias -> real command word, so typing /duelarena completes the same
    // subcommands as /arena without the profile carrying the list twice.
    consoleAliases: profile?.commandAliases ?? {},
    canStart: Boolean(t.startCommand) || t.kind === 'service',
    canUpdate: t.kind === 'service' && Boolean(t.preRestartCommand),
    // Only offered when there is genuinely something to compare against: a
    // Steam manifest for this app on disk, or a Minecraft install the updater
    // could find the server binary in. A hand-copied install has nothing to
    // read, so it gets no button instead of one that can only ever explain why
    // it doesn't work. Which of the two answers yes also decides what pressing
    // the button does -- see the update actions below.
    canCheckUpdate: steam.managed(t.id) || mcupdates.managed(t.id),
    // Which one, so the confirmation can describe what pressing the button
    // actually does. The two are not the same promise: a Minecraft update is
    // downloaded and installed start to finish, while a Steam one stops the
    // server and hands you over to Steam.
    updateProvider: mcupdates.managed(t.id) ? 'minecraft' : steam.managed(t.id) ? 'steam' : null,
    // Workshop mods are reported, never installed by the background sweep, so
    // this only decides whether the card can show a mod line at all.
    hasModChecks: workshop.managed(t.id),
    // Whether the card also gets the button that acts on that line. It needs an
    // install folder to copy into and a way to start the server again; without
    // both the notice stands on its own, as it always did.
    canRefreshMods: workshop.canRefresh(t.id),
    // Separate from hasModChecks: the update comparison needs a Steam Workshop
    // subscription to compare against, while simply listing what is installed
    // works for any game with a mods folder -- including one whose mods come
    // from mod.io, where there is nothing to compare.
    hasMods: Boolean(modSource(t, profile)),
    // A Paper server whose plugins folder exists and which has at least one
    // plugin the dashboard knows a publisher for. Without this the panel is
    // still a list -- it just has nothing to press.
    canUpdatePlugins: pluginupdates.managed(t.id),
    gamePort: t.gamePort ?? null, rconPort: t.rconPort ?? null,
    queryPort: t.queryPort ?? null,
    maxPlayers: t.maxPlayers ?? null, serviceName: t.serviceName ?? null,
    healthUrl: t.healthUrl ?? null, hasLog: Boolean(t.logFile || t.logDir),
    hasBackup: Boolean(t.backup?.enabled && t.backup?.paths?.length),
    // A ban list the dashboard can both read and change. Needs the game profile
    // to keep bans in a format it understands *and* the server folder to be
    // findable -- see src/moderation.js, which owns both halves of that answer.
    canModerate: t.kind === 'game' && moderation.managed(t, getProfile(t.game)),
  };
};

app.get('/api/targets', (_req, res) => res.json(config.targets.map(publicTarget)));

// Shared by the polling endpoint and the SSE stream, so both always agree.
function statusPayload() {
  return {
    now: Date.now(),
    pollSeconds: config.pollSeconds,
    host: os.hostname(),
    targets: monitor.snapshot(),
    pending: actions.pendingInfo(),
    // One map, two publishers. A target is managed by at most one of them --
    // Minecraft has no Steam app id and no Steam game is updated from
    // minecraft.net -- so the merge cannot collide, and the card renders both
    // through the same banner.
    updates: { ...steam.snapshot(), ...mcupdates.snapshot() },
    mods: workshop.snapshot(),
    plugins: pluginupdates.snapshot(),
  };
}

app.get('/api/status', (_req, res) => res.json(statusPayload()));

// What is installed, as opposed to what needs updating -- see src/mods.js. Read
// on demand rather than polled: it only changes when somebody installs a mod,
// and it costs a walk of the mods folder.
app.get('/api/mods/:id', (req, res) => {
  const t = config.targets.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'unknown target' });
  const profile = t.kind === 'game' ? getProfile(t.game) : null;
  const inv = modInventory(t, profile);
  // Which of them has a newer release waiting, from the last plugin check. The
  // inventory itself is a pure read of the folder and knows nothing about
  // publishers, so the two are joined here rather than inside src/mods.js.
  if (inv.ok && inv.kind === 'plugins') {
    pluginupdates.annotate(t.id, inv.mods);
    inv.counts.stale = inv.mods.filter((m) => m.status === 'stale' || m.status === 'staged').length;
    inv.pluginState = pluginupdates.state.get(t.id) ?? null;
    inv.canUpdate = pluginupdates.managed(t.id);
  }
  return res.json(inv);
});

app.get('/api/commands/:id', async (req, res) => {
  const t = config.targets.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'unknown target' });
  const profile = t.kind === 'game' ? getProfile(t.game) : null;

  const inv = modInventory(t, profile);
  if (!inv.ok || inv.kind !== 'plugins') {
    return res.json({ ok: false, error: 'this server has no plugins folder to read' });
  }

  // The jar half is a folder read and is therefore always current -- that is
  // what makes the list update on a plain refresh with no button to press. The
  // live half is a 40-page RCON walk, so a stale one is served as-is and a fresh
  // sweep is kicked off for the next refresh to collect. ?refresh=1 waits.
  let live;
  if (req.query.refresh === '1') {
    live = await commandIndex.refresh(t.id);
  } else {
    live = commandIndex.peek(t.id);
    commandIndex.refreshSoon(t.id);
  }

  const payload = buildCommandList(inv, live);
  if (payload.live) payload.live.stale = commandIndex.isStale(t.id);
  payload.pending = !live;
  return res.json(payload);
});

// Everyone who has ever played, not only who is online -- the console completes
// `prism stats <player>` from this, and the whole point of that command is to
// look up somebody who is not here. Read from Prism and TheNewEconomy on the
// server side because both are files on disk this browser cannot see.
app.get('/api/players/:id', (req, res) => {
  const t = config.targets.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'unknown target' });
  try {
    return res.json(knownPlayers(t));
  } catch (err) {
    return res.json({ ok: false, error: String(err?.message || err) });
  }
});

app.get('/api/history/:id', (req, res) => {
  const minutes = Math.min(Number(req.query.minutes) || 180, config.historyHours * 60);
  res.json(monitor.historyFor(req.params.id, minutes));
});

// How busy this server usually is, by hour of the weekday and by day of the
// week. Separate from /api/history on purpose: that one is a live trace of the
// last few hours, this one is the shape of a normal week, and neither answers
// the other's question. See src/usage.js.
app.get('/api/usage/:id', (req, res) => {
  const t = config.targets.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'unknown target' });
  if (t.kind !== 'game') return res.json({ ok: false, reason: 'not a game server' });
  return res.json(usage.report(t.id));
});

app.get('/api/alerts', (req, res) => {
  const id = req.query.id;
  const rows = id ? monitor.alerts.filter((a) => a.targetId === id) : monitor.alerts;
  res.json(rows.slice(0, Number(req.query.limit) || 100));
});

app.get('/api/logs/:id', async (req, res) => {
  const t = config.targets.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'unknown target' });

  let file = t.logFile;
  if (!file && t.logDir) {
    try {
      const newest = fs.readdirSync(t.logDir)
        .map((f) => ({ f, s: fs.statSync(path.join(t.logDir, f)) }))
        .filter((x) => x.s.isFile())
        .sort((a, b) => b.s.mtimeMs - a.s.mtimeMs)[0];
      if (newest) file = path.join(t.logDir, newest.f);
    } catch { /* fall through */ }
  }
  if (!file || !fs.existsSync(file)) return res.json({ file: null, lines: [] });

  const want = Math.min(Number(req.query.lines) || 200, 2000);
  try {
    // Read only the tail — these logs get large.
    const size = fs.statSync(file).size;
    const span = Math.min(size, 256 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(span);
    fs.readSync(fd, buf, 0, span, size - span);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split(/\r?\n/).slice(-want);
    res.json({ file, lines });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- live updates ----------------------------------------------------------
//
// Server-sent events replace the front-end's 5-second poll: the browser learns
// about a crash the moment the poll loop sees it, and an idle dashboard costs
// one open connection instead of a request every five seconds.
const streamClients = new Set();

function broadcastEvent(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of streamClients) {
    try { res.write(frame); } catch { streamClients.delete(res); }
  }
}

monitor.onPoll = () => broadcastEvent('status', statusPayload());
monitor.onAlert = (alert) => broadcastEvent('alert', alert);

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // don't let a reverse proxy buffer the stream
  });
  res.write(`retry: 3000\n\n`);
  res.write(`event: status\ndata: ${JSON.stringify(statusPayload())}\n\n`);
  streamClients.add(res);

  // Proxies and phones drop idle connections; a comment every 20s keeps it open.
  const keepAlive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { /* closed */ }
  }, 20_000);
  keepAlive.unref?.();

  req.on('close', () => {
    clearInterval(keepAlive);
    streamClients.delete(res);
  });
});

// --- schedules -------------------------------------------------------------

app.get('/api/schedules', (_req, res) => res.json(scheduler.jobs()));

// Explains a cron expression before it is saved, so the form can say "daily at
// 05:00, next in 7h" while it is being typed. Same code the scheduler runs on,
// so the preview can't disagree with what actually happens.
app.get('/api/schedules/preview', (req, res) => {
  const cron = String(req.query.cron || '');
  const error = validateCron(cron);
  if (error) return res.json({ ok: false, error });
  return res.json({ ok: true, description: describeCron(cron), nextRun: nextRun(cron) });
});

app.post('/api/schedules', (req, res) => {
  const result = scheduler.add(req.body || {});
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/api/schedules/:id', (req, res) => {
  const result = scheduler.update(req.params.id, req.body || {});
  res.status(result.ok ? 200 : 400).json(result);
});

app.delete('/api/schedules/:id', (req, res) => {
  const result = scheduler.remove(req.params.id);
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/api/schedules/:id/run', async (req, res) => {
  const job = scheduler.jobs().find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'no such schedule' });
  return res.json(await scheduler.runJob(job));
});

// --- backups ---------------------------------------------------------------

app.get('/api/backups/:id', (req, res) => {
  try {
    res.json(backups.list(req.params.id));
  } catch (err) {
    res.status(404).json({ ok: false, error: err.message });
  }
});

app.post('/api/backups/:id', async (req, res) => {
  try {
    res.json(await backups.run(req.params.id, { reason: 'manual' }));
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/backups/:id/restore', async (req, res) => {
  const name = String(req.body?.name || '');
  try {
    res.json(await backups.restore(req.params.id, name));
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/backups/:id/download/:name', (req, res) => {
  const { id, name } = req.params;
  // The name comes from the URL, so anchor it to the target's backup folder and
  // reject anything that tries to climb out of it.
  if (!/^[\w.-]+\.zip$/.test(name)) return res.status(400).json({ ok: false, error: 'invalid archive name' });
  try {
    const dir = path.resolve(backups.dirFor(id));
    const file = path.resolve(dir, name);
    if (!file.startsWith(dir + path.sep)) return res.status(400).json({ ok: false, error: 'invalid path' });
    if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: 'not found' });
    return res.download(file);
  } catch (err) {
    return res.status(404).json({ ok: false, error: err.message });
  }
});

app.post('/api/rcon/:id', async (req, res) => {
  const command = String(req.body?.command || '').trim();
  if (!command) return res.status(400).json({ ok: false, error: 'command required' });
  try {
    res.json(await actions.rcon(req.params.id, command));
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// --- moderation ------------------------------------------------------------
//
// Reads come off disk and writes go over RCON, for the reason src/moderation.js
// explains: the running server owns the ban list, so the file is a report and
// the console is the only safe way to change it.

function moderationTarget(req, res) {
  const t = config.targets.find((x) => x.id === req.params.id);
  if (!t) { res.status(404).json({ ok: false, error: 'unknown target' }); return null; }
  const profile = t.kind === 'game' ? getProfile(t.game) : null;
  if (!moderation.managed(t, profile)) {
    res.status(400).json({ ok: false, error: 'this target has no ban list the dashboard can read' });
    return null;
  }
  return { t, profile };
}

app.get('/api/bans/:id', (req, res) => {
  const found = moderationTarget(req, res);
  if (!found) return;
  res.json(moderation.readBans(found.t));
});

// Kicks and pardons leave no trace in any file -- only a line in the log. This
// is the only place either shows up after the fact.
app.get('/api/modevents/:id', (req, res) => {
  const found = moderationTarget(req, res);
  if (!found) return;
  res.json(moderation.readEvents(found.t, {
    limit: Math.min(Number(req.query.limit) || 100, 500),
    days: Math.min(Number(req.query.days) || 7, 30),
    dataDir: config.dataDir,
  }));
});

app.post('/api/bans/:id', async (req, res) => {
  const found = moderationTarget(req, res);
  if (!found) return;
  const { profile } = found;

  const kind = req.body?.kind === 'ip' ? 'ip' : 'player';
  const who = String(req.body?.who || '').trim();
  const reason = moderation.cleanReason(req.body?.reason);

  // Refusing a malformed name here rather than sending it is the difference
  // between "that is not a username" and RCON's silent, cheerful nothing.
  const ok = kind === 'ip' ? moderation.validIp(who) : moderation.validName(who);
  if (!ok) return res.status(400).json({ ok: false, error: `not a valid ${kind === 'ip' ? 'IP address' : 'player name'}` });

  const action = req.body?.action === 'pardon' ? 'pardon' : 'ban';
  const build = kind === 'ip'
    ? (action === 'ban' ? profile.moderation.banIp : profile.moderation.pardonIp)
    : (action === 'ban' ? profile.moderation.ban : profile.moderation.pardon);

  try {
    const out = await actions.rcon(req.params.id, build(who, reason));
    // Only once it actually went through: an attempt that RCON refused is not
    // something that happened, and the feed would be lying if it said so.
    if (out.ok) {
      moderation.record(config.dataDir, req.params.id, {
        kind: action, who, target: kind,
        reason: reason || null, source: 'dashboard',
      });
    }
    // The ban file is rewritten by the server as part of the command, so the
    // fresh list can be handed back with the result and the panel never has to
    // guess whether it worked.
    res.json({ ...out, bans: moderation.readBans(found.t) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Which of the two update paths a target is on. Minecraft is checked first
// because a Minecraft server has no Steam app id to match on anyway, so the
// order only matters if a target is somehow configured for both -- in which
// case the one that can install unattended is the better answer.
const updaterFor = (id) => {
  if (mcupdates.managed(id)) return mcupdates;
  if (steam.managed(id)) return steam;
  // Never null: an unmanaged target still needs a reply, and the Steam
  // updater's own errors already say exactly why it cannot act.
  return steam;
};

app.post('/api/action/:id', async (req, res) => {
  const { action, minutes, message, reason } = req.body || {};
  const id = req.params.id;
  try {
    switch (action) {
      case 'start':          return res.json(await actions.start(id));
      case 'stop':           return res.json(await actions.stop(id));
      case 'restart':        return res.json(await actions.restartNow(id));
      case 'updateRestart':  return res.json(await actions.updateAndRestart(id));
      case 'save':           return res.json(await actions.save(id));
      case 'broadcast':      return res.json(await actions.broadcast(id, String(message || '').trim()));
      case 'scheduleRestart':return res.json(actions.scheduleRestart(id, Number(minutes) || 15, reason || 'scheduled restart'));
      case 'restartWhenEmpty':return res.json(actions.restartWhenEmpty(id, Number(minutes) || 60, reason || 'restart when empty'));
      case 'cancelRestart':  return res.json(actions.cancelRestart(id));
      // Routed by whichever updater manages this target rather than by name,
      // so the card has one "Check for update" button whatever is behind it.
      case 'updateCheck':    return res.json(await updaterFor(id).check(id, { force: true }));
      case 'updateBegin':    return res.json(await updaterFor(id).begin(id));
      case 'updateCancel':   return res.json(await updaterFor(id).cancel(id));
      case 'modsCheck':      return res.json(workshop.check(id));
      // Plugin updates are their own pair rather than more cases on the update
      // button: the server jar and the plugins are different publishers on
      // different schedules, and the card says which one it is about to touch.
      case 'pluginsCheck':   return res.json(await pluginupdates.check(id, { force: true }));
      case 'pluginsUpdate':  return res.json(await pluginupdates.begin(id, { only: req.body?.only ?? null }));
      // What a refresh would copy, with nothing written and the server left
      // running. The confirmation dialog is built from this.
      case 'modsPlan':       return res.json(workshop.plan(id));
      case 'modsRefresh':    return res.json(await workshop.refresh(id, { force: Boolean(req.body?.force) }));
      default:               return res.status(400).json({ ok: false, error: `unknown action: ${action}` });
    }
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

const server = app.listen(config.port, config.bind, () => {
  const reach = isLoopback(config.bind)
    ? `http://localhost:${config.port} (this machine only)`
    : `http://<this machine>:${config.port} (reachable on your network)`;
  console.log(`Server dashboard listening on ${reach}`);
  console.log(`Monitoring ${config.targets.length} target(s) every ${config.pollSeconds}s`);
  console.log(auth.enabled ? 'Password protection: on' : 'Password protection: off (localhost only)');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    monitor.stop();
    usage.flush(Date.now(), { sync: true });
    scheduler.stop();
    steam.stop();
    mcupdates.stop();
    workshop.stop();
    pluginupdates.stop();
    closeAll();
    for (const res of streamClients) { try { res.end(); } catch { /* already gone */ } }
    server.close(() => process.exit(0));
  });
}
