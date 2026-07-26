// Polls every target on an interval, keeps rolling history, and raises alerts
// on state transitions (up->down, health failures, crashes).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rconCommand, getClient } from './rcon.js';
import { getProfile } from './games/index.js';
import { getProcessStats, getServiceState, checkHealth, toast } from './win.js';

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
    this.suppressed = new Set(); // ids under a managed restart — don't cry wolf
    this.cpuSamples = new Map(); // processName -> {cpuSeconds, at} for % between polls
    this.cores = os.cpus().length || 1;
    this.alertLimit = config.alerts?.keep ?? DEFAULT_ALERT_LIMIT;

    // Set after construction by server.js — Actions needs a Monitor, so they
    // cannot both be constructor arguments of each other.
    this.notifier = null;
    this.actions = null;
    this.watchdogTimers = new Map(); // id -> pending restart timer
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
  // `category` is optional and coarse ('backup', and nothing else so far). It
  // exists so a notification channel can mute a class of event that is worth
  // recording but not worth a phone buzz — see notifications.*.mute.
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

  suppress(id, on) {
    if (on) this.suppressed.add(id);
    else this.suppressed.delete(id);
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
        players: snap.players?.length ?? null,
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

  async #pollGame(target, proc) {
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
      players: null,
      rcon: 'unknown',
      checkedAt: Date.now(),
    };

    // Games with no query interface at all (Valheim, "process"): the process
    // table is the whole story, so stop here rather than reporting a broken RCON.
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
    } else {
      snap.rcon = 'error';
      snap.rconError = res.error;
    }
    return snap;
  }

  async #pollService(target) {
    const [status, health] = await Promise.all([
      getServiceState(target.serviceName),
      checkHealth(target.healthUrl),
    ]);
    return {
      id: target.id,
      name: target.name,
      kind: 'service',
      up: status === 'Running' && health.ok,
      serviceStatus: status,
      healthy: health.ok,
      httpStatus: health.status,
      responseMs: health.ms,
      healthBody: health.body ?? null,
      healthError: health.error ?? null,
      checkedAt: Date.now(),
    };
  }

  #diffAndAlert(prev, snap) {
    if (!prev) return;
    if (this.suppressed.has(snap.id)) return;

    if (prev.up && !snap.up) {
      this.addAlert('error', snap.id, snap.kind === 'game'
        ? 'Server process is gone — it crashed or was stopped outside the dashboard'
        : `Service ${snap.serviceStatus}, health ${snap.healthy ? 'ok' : 'failing'}`);
      this.#armWatchdog(snap.id);
    } else if (!prev.up && snap.up) {
      this.#disarmWatchdog(snap.id);
      this.addAlert('info', snap.id, 'Back online');
    }

    if (snap.kind === 'game' && prev.rcon === 'ok' && snap.rcon === 'error') {
      this.addAlert('warn', snap.id, `RCON stopped responding: ${snap.rconError}`);
    }
    if (snap.kind === 'service' && prev.healthy && !snap.healthy && snap.serviceStatus === 'Running') {
      this.addAlert('warn', snap.id, `Health check failing (${snap.healthError || snap.httpStatus}) while the service still runs`);
    }

    // Player joins/leaves, so the activity feed shows who is actually around.
    if (snap.kind === 'game' && prev.players && snap.players) {
      const before = new Set(prev.players.map((p) => p.name));
      const after = new Set(snap.players.map((p) => p.name));
      for (const n of after) if (!before.has(n)) this.addAlert('info', snap.id, `${n} joined`);
      for (const n of before) if (!after.has(n)) this.addAlert('info', snap.id, `${n} left`);
    }
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
      if (this.state.get(id)?.up || this.suppressed.has(id)) return;

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
