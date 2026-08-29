// Polls every target on an interval, keeps rolling history, and raises alerts
// on state transitions (up->down, health failures, crashes).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rconCommand, getClient } from './rcon.js';
import { queryInfo, queryPlayers } from './a2s.js';
import { queryInfo as raknetInfo } from './raknet.js';
import { getProfile } from './games/index.js';
import { getProcessStats, getServiceState, getServiceProcess, checkHealth, toast } from './win.js';

// --- tunables ---------------------------------------------------------------
// Poll interval and history retention are per-install, so they live in
// config.json (pollSeconds, historyHours) rather than here. These are the ones
// with no reason to differ between installs.

// Fallback for alerts.keep, which lives in config.json.
const DEFAULT_ALERT_LIMIT = 200;

// Default span the dashboard's history graph asks for, in minutes.
const HISTORY_DEFAULT_MINUTES = 180;

// Fallback for a target's watchdog.restartAfterSeconds, and the window that
// watchdog.maxRestartsPerHour is counted over. Both are per-target config.
const WATCHDOG_WAIT_SECONDS = 60;
const RESTART_WINDOW_MS = 3600_000;

export class Monitor {
  constructor(config, dataDir) {
    this.config = config;
    this.dataDir = dataDir;
    this.state = new Map();   // id -> latest snapshot
    this.history = new Map(); // id -> [{t, up, players, cpu, memMB, ms}]
    this.alerts = [];
    this.suppressed = new Map(); // id -> how many operations are holding the blackout
    this.cpuSamples = new Map(); // processName -> {cpuSeconds, at} for % between polls
    this.cores = os.cpus().length || 1;
    this.alertLimit = config.alerts?.keep ?? DEFAULT_ALERT_LIMIT;

    // Set after construction by server.js — Actions needs a Monitor, so they
    // cannot both be constructor arguments of each other.
    this.notifier = null;
    this.actions = null;
    this.watchdogTimers = new Map(); // id -> pending restart timer
    this.logHealth = new Map();      // id -> {startedAt, verdict} per server run
    // id -> {startedAt, version}. Keyed on the process start time so it is
    // asked once per server run and re-asked after a restart, which is the only
    // moment a running server's version can change. Without this, showing the
    // version would mean an extra RCON round trip every ten seconds forever to
    // re-learn a string that cannot have moved.
    this.versions = new Map();
    this.restartLog = new Map();     // id -> [timestamps] for flap protection

    fs.mkdirSync(dataDir, { recursive: true });
    this.historyFile = path.join(dataDir, 'history.json');
    this.alertsFile = path.join(dataDir, 'alerts.json');
    this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
      for (const [id, rows] of Object.entries(raw)) this.history.set(id, rows);
    } catch { /* first run */ }
    try {
      this.alerts = JSON.parse(fs.readFileSync(this.alertsFile, 'utf8'));
    } catch { /* first run */ }
  }

  #persist() {
    const cutoff = Date.now() - this.config.historyHours * 3600 * 1000;
    const trimmed = {};
    for (const [id, rows] of this.history) {
      const keep = rows.filter((r) => r.t >= cutoff);
      this.history.set(id, keep);
      trimmed[id] = keep;
    }
    fs.writeFile(this.historyFile, JSON.stringify(trimmed), () => {});
    fs.writeFile(this.alertsFile, JSON.stringify(this.alerts.slice(0, this.alertLimit)), () => {});
  }

  attach({ actions, notifier }) {
    this.actions = actions ?? this.actions;
    this.notifier = notifier ?? this.notifier;
  }

  // The single funnel every event in the dashboard passes through, which is why
  // notifications and the live stream hook in here and nowhere else.
  //
  // `category` is optional and coarse ('backup', 'restart', 'recovery'). It
  // exists so a notification channel can mute a class of event that is worth
  // recording but not worth a phone buzz, or force one through below its level
  // threshold — see notifications.*.mute and .always.
  addAlert(level, targetId, message, category = null) {
    const alert = { t: Date.now(), level, targetId, message };
    if (category) alert.category = category;
    this.alerts.unshift(alert);
    this.alerts = this.alerts.slice(0, this.alertLimit);

    const name = this.config.targets.find((x) => x.id === targetId)?.name || targetId;
    if (level === 'error' && this.config.notifications?.windowsToast !== false) {
      toast(name, message);
    }
    this.notifier?.notify(alert, name);
    this.onAlert?.(alert);
    return alert;
  }

  // Reference-counted, not a flag. Managed operations overlap all the time: a
  // start's 90-second blackout is still ticking when the next stop begins, and a
  // stop runs inside a Steam update that is holding its own. With a flag,
  // whichever operation finished first lifted the blackout for every other one
  // still running — and the very next poll would report the outage the dashboard
  // had itself just caused, then arm the watchdog and restart a server somebody
  // had deliberately stopped a minute earlier.
  //
  // So each operation takes a hold and releases exactly one, and the blackout
  // lasts until the last of them is done.
  suppress(id, on) {
    const held = this.suppressed.get(id) || 0;
    if (on) {
      this.suppressed.set(id, held + 1);
    } else if (held <= 1) {
      this.suppressed.delete(id);
    } else {
      this.suppressed.set(id, held - 1);
    }
  }

  isSuppressed(id) {
    return (this.suppressed.get(id) || 0) > 0;
  }

  async pollOnce() {
    const games = this.config.targets.filter((t) => t.kind === 'game');
    const procStats = await getProcessStats(games.map((t) => t.processName));

    const snapshots = await Promise.all(
      this.config.targets.map((t) =>
        t.kind === 'game' ? this.#pollGame(t, procStats[t.processName]) : this.#pollService(t),
      ),
    );

    const now = Date.now();
    for (const snap of snapshots) {
      const prev = this.state.get(snap.id);
      this.#diffAndAlert(prev, snap);
      this.state.set(snap.id, snap);

      const rows = this.history.get(snap.id) || [];
      rows.push({
        t: now,
        up: snap.up ? 1 : 0,
        players: snap.playerCount ?? null,
        cpu: snap.cpu ?? null,
        memMB: snap.memMB ?? null,
        ms: snap.responseMs ?? null,
      });
      this.history.set(snap.id, rows);
    }
    this.#persist();
    return snapshots;
  }

  // CPU% = extra processor-seconds burned since the last poll, over wall time.
  #cpuPercent(processName, cpuSeconds) {
    if (cpuSeconds == null) return null;
    const now = Date.now();
    const prev = this.cpuSamples.get(processName);
    this.cpuSamples.set(processName, { cpuSeconds, at: now });
    if (!prev || now <= prev.at) return null;
    const elapsed = (now - prev.at) / 1000;
    const used = cpuSeconds - prev.cpuSeconds;
    if (used < 0) return null; // process restarted; counter reset
    return Math.round((used / elapsed / this.cores) * 1000) / 10;
  }

  // Everything downstream — the badge, the history graph, "is it safe to update"
  // — wants one number, so the two ways of arriving at it (a parsed player list,
  // or a Steam query that only ever returns a count) are reconciled in one place
  // rather than at each call site.
  async #pollGame(target, proc) {
    const snap = await this.#pollGameState(target, proc);
    if (snap.playerCount == null) snap.playerCount = snap.players?.length ?? null;
    return snap;
  }

  async #pollGameState(target, proc) {
    const profile = getProfile(target.game);
    const running = Boolean(proc?.running);
    const snap = {
      id: target.id,
      name: target.name,
      kind: 'game',
      game: target.game,
      up: running,
      pid: proc?.procId ?? null,
      cpu: running ? this.#cpuPercent(target.processName, proc?.cpuSeconds) : null,
      memMB: proc?.memMB ?? null,
      startedAt: proc?.startTime ?? null,
      maxPlayers: target.maxPlayers,
      gamePort: target.gamePort,
      rconPort: target.rconPort,
      queryPort: profile.query ? (target.queryPort ?? null) : null,
      players: null,
      playerCount: null,
      query: profile.query ? 'unknown' : 'n/a',
      // The UI labels the query tile with the dialect rather than calling
      // everything a Steam query — Bedrock's ping has nothing to do with Steam,
      // and a tile that names the wrong system sends people to the wrong docs.
      queryProtocol: profile.query?.protocol ?? null,
      rcon: 'unknown',
      // The build the running process reports about itself. Filled in from
      // whichever source the game already answers -- the query reply, the REST
      // info endpoint, or one cached RCON call -- and left null for a game that
      // publishes it nowhere, which shows as a dash rather than a wrong number.
      version: running ? (this.versions.get(target.id)?.version ?? null) : null,
      checkedAt: Date.now(),
    };

    // A profile can name a line that means "this run is broken" even though the
    // process is up. Nothing else would catch it: for a transport:'none' game
    // the process table is the only signal, and it says everything is fine.
    if (running && profile.logHealth && target.logFile) {
      snap.logHealthError = this.#checkLogHealth(target, profile.logHealth, proc);
    }

    // A Steam query is independent of the control transport: it needs no
    // password and no session, so it is worth asking whether or not the game
    // also speaks RCON. For a transport:'none' game it is the only thing on the
    // card that is not read out of the process table.
    if (profile.query && target.queryPort) {
      await this.#pollQuery(target, profile, snap, running);
    }

    // Some games announce their version once at startup and offer it nowhere
    // else: no usable query field, and for a transport:'none' game no console
    // to ask either. The log is then the only source, and reading it is
    // independent of transport, so it belongs here rather than in one of the
    // branches below -- which is also the only way Icarus reaches it at all,
    // since transport:'none' returns a few lines further down.
    if (running && !snap.version && profile.versionLog && target.logFile) {
      this.#versionFromLog(target, profile.versionLog, snap);
    }

    // Games with no control interface at all (Valheim, "process"): there is
    // nothing to connect to, so stop here rather than reporting a broken RCON.
    if (profile.transport === 'none') {
      snap.rcon = 'n/a';
      snap.control = null;
      return snap;
    }

    if (!running) {
      // Drop the kept-alive socket so we reconnect cleanly when it comes back.
      if (target.rconPort) {
        getClient({ host: target.host, port: target.rconPort, password: target.rconPassword }).close();
      }
      snap.rcon = 'offline';
      return snap;
    }

    // ARK takes ~4 minutes to load and refuses RCON the whole time. Since every
    // rejected attempt permanently burns one of its ~6 connection slots, don't
    // even try until it has had time to finish starting.
    if (target.readyAfterSeconds && proc?.startTime) {
      const ageSeconds = (Date.now() - new Date(proc.startTime).getTime()) / 1000;
      if (ageSeconds < target.readyAfterSeconds) {
        snap.rcon = 'starting';
        snap.rconError = `still loading (${Math.ceil(target.readyAfterSeconds - ageSeconds)}s left)`;
        return snap;
      }
    }

    const started = Date.now();

    if (profile.transport === 'rest') {
      const res = await profile.rest.listPlayers(target);
      snap.responseMs = Date.now() - started;
      snap.control = 'REST';
      if (res.ok) {
        snap.rcon = 'ok';
        snap.players = res.players;
        await this.#pollVersion(target, profile, snap);
      } else {
        snap.rcon = 'error';
        snap.rconError = res.error;
      }
      return snap;
    }

    snap.control = 'RCON';
    const res = await rconCommand({
      host: target.host,
      port: target.rconPort,
      password: target.rconPassword,
      command: profile.commands.list,
      mode: profile.transport,
    });
    snap.responseMs = Date.now() - started;

    if (res.ok) {
      snap.rcon = 'ok';
      snap.players = profile.parsePlayers(res.body);
      await this.#pollVersion(target, profile, snap);
    } else {
      snap.rcon = 'error';
      snap.rconError = res.error;
    }
    return snap;
  }

  // The version a game printed when it started. Reads the HEAD of the log, not
  // the tail that #checkLogHealth wants: a startup banner is the first thing in
  // the file and scrolls out of a tail window within minutes of a busy server
  // running. Cached on the process start time like everything else here, so a
  // 1 MB log is read once per run rather than every ten seconds.
  #versionFromLog(target, spec, snap) {
    const cached = this.versions.get(target.id);
    if (cached && cached.startedAt === snap.startedAt) {
      snap.version = cached.version;
      return;
    }
    try {
      const size = fs.statSync(target.logFile).size;
      const span = Math.min(size, 512 * 1024);
      const fd = fs.openSync(target.logFile, 'r');
      const buf = Buffer.alloc(span);
      fs.readSync(fd, buf, 0, span, 0);
      fs.closeSync(fd);
      const m = buf.toString('utf8').match(spec.pattern);
      if (!m) return; // still starting, or the banner moved — try again next poll
      snap.version = m[spec.group ?? 1];
      this.versions.set(target.id, { startedAt: snap.startedAt, version: snap.version });
    } catch { /* an unreadable log costs a label, nothing else */ }
  }

  // The running build, for the games that will only say so if asked. Games with
  // a query answer this for free in #pollQuery and never reach here.
  //
  // Deliberately after the player list and never before it: this is the least
  // important thing on the card, so it must not be what fails a snapshot. A
  // server that refuses the question keeps every other tile, and the cache is
  // left empty so the next poll tries again -- a version that arrives one cycle
  // late is invisible, whereas a card stuck on "error" is not.
  async #pollVersion(target, profile, snap) {
    const cached = this.versions.get(target.id);
    if (cached && cached.startedAt === snap.startedAt) {
      snap.version = cached.version;
      return;
    }

    let version = null;
    try {
      if (profile.transport === 'rest') {
        if (!profile.rest?.info) return;
        const res = await profile.rest.info(target);
        if (res.ok) version = profile.parseVersion?.(res) ?? null;
      } else {
        if (!profile.versionCommand) return;
        const res = await rconCommand({
          host: target.host,
          port: target.rconPort,
          password: target.rconPassword,
          command: profile.versionCommand,
          mode: profile.transport,
        });
        if (res.ok) version = profile.parseVersion?.(res.body) ?? null;
      }
    } catch { /* see above: never fatal to the snapshot */ }

    if (!version) return;
    snap.version = version;
    this.versions.set(target.id, { startedAt: snap.startedAt, version });
  }

  // A read-only player-count query over UDP, in whichever dialect the profile
  // speaks: A2S for Steam-registered games, RakNet for Bedrock. Failure here is
  // never fatal to the snapshot: a query that does not answer costs the player
  // count, and everything read from the process table stands on its own.
  async #pollQuery(target, profile, snap, running) {
    if (!running) {
      snap.query = 'offline';
      return;
    }

    // A loading server has not registered with Steam yet, so the query times out
    // for exactly as long as the start takes. Reporting that as an error would
    // put every card into a warning state for the first two minutes of every
    // restart, which is the one time somebody is definitely watching it.
    if (target.readyAfterSeconds && snap.startedAt) {
      const ageSeconds = (Date.now() - new Date(snap.startedAt).getTime()) / 1000;
      if (ageSeconds < target.readyAfterSeconds) {
        snap.query = 'starting';
        return;
      }
    }

    // Both dialects answer with the same shape — { ok, name, players,
    // maxPlayers, ms } — so everything below this line is protocol-agnostic.
    const askInfo = profile.query.protocol === 'raknet' ? raknetInfo : queryInfo;
    const info = await askInfo({ host: target.host, port: target.queryPort });
    if (!info.ok) {
      snap.query = 'error';
      snap.queryError = info.error;
      return;
    }

    snap.query = 'ok';
    snap.playerCount = info.players;
    snap.responseMs = info.ms;
    snap.serverName = info.name || null;
    // Free: both dialects carry the running build in the reply they already
    // sent. This is the version the server is *actually* running, which is the
    // one worth showing -- what is on disk can differ from what is in memory
    // for the whole window between an update landing and the next restart.
    //
    // `version: false` on a profile's query block means the field is there but
    // is a placeholder (Icarus answers a flat "0.0.0.1" for every build ever
    // shipped). A wrong version is worse than none: it reads as authoritative
    // and there is nothing on the card to suggest otherwise.
    if (info.version && profile.query.version !== false) snap.version = info.version;
    // A server that reports its own limit is a better source than a hand-typed
    // maxPlayers, but only when the config left it out — an admin who wrote a
    // number there gets to keep it.
    if (snap.maxPlayers == null) snap.maxPlayers = info.maxPlayers;

    // Only when the game actually fills in the name field. The rest answer with
    // one blank entry per player, which is a list of nobody.
    if (!profile.query.names || info.players === 0) return;
    const list = await queryPlayers({ host: target.host, port: target.queryPort });
    if (list.ok) snap.players = list.players;
  }

  async #pollService(target) {
    // A health URL is optional: plenty of services are just "is it running?".
    // Without one, the service state is the whole verdict — checking a URL that
    // doesn't exist would report every such target as permanently down.
    const checked = Boolean(target.healthUrl);
    const [status, health, proc] = await Promise.all([
      getServiceState(target.serviceName),
      checked ? checkHealth(target.healthUrl) : Promise.resolve(null),
      getServiceProcess(target.serviceName),
    ]);
    const running = status === 'Running';
    return {
      id: target.id,
      name: target.name,
      kind: 'service',
      up: running && (!checked || health.ok),
      serviceStatus: status,
      healthChecked: checked,
      healthy: checked ? health.ok : null,
      httpStatus: checked ? health.status : null,
      responseMs: checked ? health.ms : null,
      healthBody: checked ? (health.body ?? null) : null,
      healthError: checked ? (health.error ?? null) : null,
      healthUrl: target.healthUrl ?? null,
      serviceName: target.serviceName ?? null,
      // Same counters the game cards show, so a service card isn't a poor
      // relation: the PID behind the service gives uptime, CPU and memory.
      pid: proc?.procId ?? null,
      cpu: running ? this.#cpuPercent(`service:${target.serviceName}`, proc?.cpuSeconds) : null,
      memMB: proc?.memMB ?? null,
      startedAt: proc?.startTime ?? null,
      checkedAt: Date.now(),
    };
  }

  #diffAndAlert(prev, snap) {
    if (this.isSuppressed(snap.id)) return;

    // First sight of a target. There is no transition to report, but "already
    // down when the dashboard started" still needs the watchdog: without this
    // the only thing that ever arms it is an up->down edge, so a server that
    // was down before the dashboard came up -- after a reboot, or because the
    // dashboard was restarted while the server happened to be stopped -- stays
    // down for good, with the card showing it down and nothing acting on it.
    if (!prev) {
      if (!snap.up) this.#armWatchdog(snap.id);
      return;
    }

    if (prev.up && !snap.up) {
      this.addAlert('error', snap.id, snap.kind === 'game'
        ? 'Server process is gone — it crashed or was stopped outside the dashboard'
        : `Service ${snap.serviceStatus}, health ${snap.healthy ? 'ok' : 'failing'}`);
      this.#armWatchdog(snap.id);
    } else if (!prev.up && snap.up) {
      this.#disarmWatchdog(snap.id);
      // Only reachable after an outage nobody asked for — a managed restart
      // sets the suppressed flag above and never gets this far. That makes it
      // the all-clear to the error above rather than routine chatter, so it is
      // worth pushing to a channel that otherwise only wants problems.
      this.addAlert('info', snap.id, 'Back online', 'recovery');
    }

    if (snap.kind === 'game' && prev.rcon === 'ok' && snap.rcon === 'error') {
      this.addAlert('warn', snap.id, `RCON stopped responding: ${snap.rconError}`);
    }
    // Worth saying out loud even though the process is alive: a server that has
    // stopped answering Steam is a server nobody can find in the browser.
    if (snap.kind === 'game' && prev.query === 'ok' && snap.query === 'error') {
      const dialect = snap.queryProtocol === 'raknet' ? 'Server ping' : 'Steam query';
      this.addAlert('warn', snap.id, `${dialect} stopped responding: ${snap.queryError}`);
    }
    if (snap.kind === 'service' && prev.healthy && !snap.healthy && snap.serviceStatus === 'Running') {
      this.addAlert('warn', snap.id, `Health check failing (${snap.healthError || snap.httpStatus}) while the service still runs`);
    }

    // Games that only report a count get the same feed without the names — it
    // is still the difference between "someone is on it" and "it is idle".
    if (snap.kind === 'game' && !snap.players && snap.playerCount != null
        && prev.playerCount != null && prev.playerCount !== snap.playerCount) {
      const n = snap.playerCount;
      this.addAlert('info', snap.id, n > prev.playerCount
        ? `Player joined — ${n} online`
        : (n === 0 ? 'Last player left — server is empty' : `Player left — ${n} online`));
    }

    // Player joins/leaves, so the activity feed shows who is actually around.
    if (snap.kind === 'game' && prev.players && snap.players) {
      const before = new Set(prev.players.map((p) => p.name));
      const after = new Set(snap.players.map((p) => p.name));
      for (const n of after) if (!before.has(n)) this.addAlert('info', snap.id, `${n} joined`);
      for (const n of before) if (!after.has(n)) this.addAlert('info', snap.id, `${n} left`);
    }
  }

  // Scan the tail of a target's log once per run. Keyed on the process start
  // time, so a restart re-arms it and a healthy run is never read twice: this
  // sits in a 10-second poll loop and these logs reach hundreds of KB.
  #checkLogHealth(target, spec, proc) {
    const startedAt = proc?.startTime ?? null;
    let entry = this.logHealth.get(target.id);
    if (!entry || entry.startedAt !== startedAt) {
      entry = { startedAt, verdict: undefined };
      this.logHealth.set(target.id, entry);
    }
    if (entry.verdict !== undefined) return entry.verdict;

    // Give the run time to actually reach the thing being looked for; a verdict
    // read too early is a false all-clear.
    const age = startedAt ? (Date.now() - Date.parse(startedAt)) / 1000 : null;
    if (age === null || age < (spec.afterSeconds ?? 90)) return null;

    try {
      const size = fs.statSync(target.logFile).size;
      const span = Math.min(size, 512 * 1024);
      const fd = fs.openSync(target.logFile, 'r');
      const buf = Buffer.alloc(span);
      fs.readSync(fd, buf, 0, span, size - span);
      fs.closeSync(fd);
      entry.verdict = spec.pattern.test(buf.toString('utf8')) ? spec.message : null;
    } catch {
      // An unreadable log is not evidence of a broken server — say nothing and
      // try again on the next run rather than crying wolf.
      entry.verdict = null;
    }
    if (entry.verdict) this.addAlert('error', target.id, entry.verdict);
    return entry.verdict;
  }

  // --- crash watchdog ------------------------------------------------------
  //
  // Waits out restartAfterSeconds before acting, so a server the user is
  // deliberately restarting by hand isn't fought over. A managed restart sets
  // the suppressed flag and never gets here at all.

  #armWatchdog(id) {
    const target = this.config.targets.find((t) => t.id === id);
    const cfg = target?.watchdog;
    if (!cfg?.enabled || !target.startCommand || !this.actions) return;
    if (this.watchdogTimers.has(id)) return;

    const wait = (cfg.restartAfterSeconds ?? WATCHDOG_WAIT_SECONDS) * 1000;
    this.addAlert('warn', id, `Watchdog armed — will restart in ${Math.round(wait / 1000)}s if it stays down`);

    const timer = setTimeout(() => {
      this.watchdogTimers.delete(id);
      if (this.state.get(id)?.up || this.isSuppressed(id)) return;

      // Flap protection: a server that crashes on startup would otherwise be
      // restarted forever, which is worse than leaving it down and saying so.
      const hourAgo = Date.now() - RESTART_WINDOW_MS;
      const recent = (this.restartLog.get(id) || []).filter((t) => t > hourAgo);
      const limit = cfg.maxRestartsPerHour ?? 3;
      if (recent.length >= limit) {
        this.addAlert('error', id,
          `Watchdog giving up — already restarted ${recent.length} time(s) this hour. ` +
          `Something is wrong with the server itself; fix it and start it manually.`);
        this.restartLog.set(id, recent);
        return;
      }

      recent.push(Date.now());
      this.restartLog.set(id, recent);
      this.addAlert('warn', id, `Watchdog restarting the server (attempt ${recent.length} of ${limit} this hour)`);
      this.actions.start(id).catch((err) => this.addAlert('error', id, `Watchdog restart failed: ${err.message}`));
    }, wait);

    timer.unref?.();
    this.watchdogTimers.set(id, timer);
  }

  #disarmWatchdog(id) {
    const timer = this.watchdogTimers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.watchdogTimers.delete(id);
  }

  start() {
    const tick = () => this.pollOnce()
      .then((snaps) => this.onPoll?.(snaps))
      .catch((err) => console.error('[poll]', err.message));
    tick();
    this.timer = setInterval(tick, this.config.pollSeconds * 1000);
  }

  stop() {
    clearInterval(this.timer);
    for (const timer of this.watchdogTimers.values()) clearTimeout(timer);
    this.watchdogTimers.clear();
  }

  snapshot() {
    return this.config.targets.map(
      (t) => this.state.get(t.id) || { id: t.id, name: t.name, kind: t.kind, up: false, pending: true },
    );
  }

  historyFor(id, minutes = HISTORY_DEFAULT_MINUTES) {
    const cutoff = Date.now() - minutes * 60 * 1000;
    return (this.history.get(id) || []).filter((r) => r.t >= cutoff);
  }
}
