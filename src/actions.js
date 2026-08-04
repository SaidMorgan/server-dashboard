// Everything that changes server state: start, stop, graceful restart with
// player warnings, saves, broadcasts, raw RCON.
import { rconCommand } from './rcon.js';
import { getProfile } from './games/index.js';
import { launchDetached, killProcess, controlService } from './win.js';

// --- tunables ---------------------------------------------------------------
// Sensible defaults for the servers this was built against. Change them here;
// nothing below hard-codes a duration.

// How long before a restart players get told, in minutes.
const WARN_MINUTES = [15, 10, 5, 1];

// While a server is deliberately down, alerts for it are suppressed so a
// restart doesn't fire "server is gone" at everyone. These are how long that
// blackout lasts — long enough to cover the operation, short enough that a
// genuine failure still surfaces. START is the longest: a cold map load is slow.
const SUPPRESS_START_MS = 90_000;
const SUPPRESS_SERVICE_MS = 60_000;
const SUPPRESS_SETTLE_MS = 10_000;   // after the server is confirmed down

// Fallback for restart.graceSeconds in config.json.
const DEFAULT_SHUTDOWN_GRACE_SECONDS = 90;

const SAVE_FLUSH_MS = 3000;          // let a save reach disk before asking to exit
const RESTART_GAP_MS = 5000;         // pause between the process dying and relaunch
const STOP_POLL_MS = 3000;           // how often to check whether it exited yet

export class Actions {
  constructor(config, monitor) {
    this.config = config;
    this.monitor = monitor;
    this.pending = new Map(); // id -> {timers, finishAt, reason}
    this.backups = null;      // set by server.js; Backups needs Actions too
    this.shutdownGraceSeconds = config.restart?.graceSeconds ?? DEFAULT_SHUTDOWN_GRACE_SECONDS;
  }

  target(id) {
    const t = this.config.targets.find((x) => x.id === id);
    if (!t) throw new Error(`unknown target: ${id}`);
    return t;
  }

  // Every game-facing action goes through a profile, so adding a game means
  // adding one file in src/games/ and nothing else.
  profile(id) {
    const t = this.target(id);
    if (t.kind !== 'game') throw new Error('not a game server');
    const p = getProfile(t.game);
    if (!p) throw new Error(`no game profile for "${t.game}"`);
    return p;
  }

  async rcon(id, command) {
    const t = this.target(id);
    if (t.kind !== 'game') return { ok: false, error: 'not a game server' };
    const profile = getProfile(t.game);

    if (profile.transport === 'none') {
      return { ok: false, error: `${profile.label} has no remote command interface` };
    }

    // REST targets expose a few named operations rather than a command string.
    if (profile.transport === 'rest') {
      const [rawVerb, ...rest] = command.trim().split(/\s+/);
      const verb = profile.verbAliases[rawVerb.toLowerCase()] || rawVerb.toLowerCase();
      const handler = profile.restVerbs?.[verb];
      if (!handler) {
        const supported = Object.keys(profile.restVerbs || {}).join(', ');
        return { ok: false, error: `${profile.label} supports: ${supported}` };
      }
      return handler(t, rest.join(' '));
    }

    const res = await rconCommand({
      host: t.host,
      port: t.rconPort,
      password: t.rconPassword,
      command,
      mode: profile.transport,
    });
    return profile.normalizeReply(res);
  }

  async save(id) {
    const t = this.target(id);
    const profile = getProfile(t.game);
    if (profile?.transport === 'rest') return profile.rest.save(t);
    if (!profile?.commands?.save) {
      return { ok: false, error: `${profile?.label || t.game} has no save command` };
    }
    return this.rcon(id, profile.commands.save);
  }

  async broadcast(id, message) {
    const t = this.target(id);
    const profile = getProfile(t.game);
    if (profile?.transport === 'rest') return profile.rest.announce(t, message);
    if (!profile?.commands?.broadcast) {
      return { ok: false, error: `${profile?.label || t.game} cannot send in-game messages` };
    }
    return this.rcon(id, profile.commands.broadcast(message));
  }

  async start(id) {
    const t = this.target(id);
    if (t.kind === 'service') {
      return controlService(t.serviceName, 'start', t.nssm);
    }
    const snap = this.monitor.state.get(id);
    if (snap?.up) return { ok: false, error: 'already running' };
    this.monitor.suppress(id, true);
    setTimeout(() => this.monitor.suppress(id, false), SUPPRESS_START_MS).unref?.();
    const res = launchDetached(t.startCommand);
    if (res.ok) this.monitor.addAlert('info', id, 'Start requested from dashboard', 'restart');
    return res;
  }

  // Save first, ask the server to exit, then make sure it actually died.
  async stop(id, { announce = true } = {}) {
    const t = this.target(id);
    if (t.kind === 'service') {
      this.monitor.suppress(id, true);
      setTimeout(() => this.monitor.suppress(id, false), SUPPRESS_SERVICE_MS).unref?.();
      return controlService(t.serviceName, 'stop', t.nssm);
    }

    this.monitor.suppress(id, true);
    const profile = getProfile(t.game);

    // A game with no remote interface can't be asked politely — the process
    // table is the only handle we have. Most such servers save on SIGTERM.
    if (profile.transport === 'none') {
      await killProcess(t.processName);
      this.monitor.addAlert('info', id, 'Stopped (no remote interface — process terminated)', 'restart');
      setTimeout(() => this.monitor.suppress(id, false), SUPPRESS_SETTLE_MS).unref?.();
      return { ok: true, saved: false, forced: true };
    }

    // Palworld renders this as an on-screen countdown — the only server message
    // players can't miss, since announce only reaches the chat panel. ARK exits
    // immediately on doexit, so its countdown is 0.
    const countdown = t.shutdownCountdownSeconds ?? 0;

    if (announce) {
      const msg = countdown
        ? `Server restarting in ${countdown} seconds`
        : 'Server shutting down now';
      await this.broadcast(id, msg).catch(() => {});
    }
    const saved = await this.save(id).catch(() => ({ ok: false }));
    await delay(SAVE_FLUSH_MS);

    if (profile.transport === 'rest') {
      await profile.rest.shutdown(t, countdown, 'Server restarting').catch(() => {});
    } else {
      await this.rcon(id, profile.commands.shutdown).catch(() => {});
    }

    // Wait out the countdown itself, plus grace for the world to flush to disk,
    // before force-killing. Force-killing mid-countdown would defeat the point.
    const deadline = Date.now() + (countdown + this.shutdownGraceSeconds) * 1000;
    while (Date.now() < deadline) {
      await delay(STOP_POLL_MS);
      const snap = await this.monitor.pollOnce().then((s) => s.find((x) => x.id === id));
      if (!snap?.up) {
        this.monitor.addAlert('info', id, 'Stopped cleanly', 'restart');
        setTimeout(() => this.monitor.suppress(id, false), SUPPRESS_SETTLE_MS).unref?.();
        return { ok: true, saved: saved.ok, forced: false };
      }
    }

    await killProcess(t.processName);
    // A warn, but still part of a stop somebody asked for: the dashboard wanted
    // it down and it is down. The feed records how it went; the channel doesn't
    // need it.
    this.monitor.addAlert('warn', id, 'Did not exit on request — process was force-killed', 'restart');
    setTimeout(() => this.monitor.suppress(id, false), SUPPRESS_SETTLE_MS).unref?.();
    return { ok: true, saved: saved.ok, forced: true };
  }

  async restartNow(id) {
    const t = this.target(id);
    if (t.kind === 'service') {
      this.monitor.suppress(id, true);
      setTimeout(() => this.monitor.suppress(id, false), SUPPRESS_SERVICE_MS).unref?.();
      const res = await controlService(t.serviceName, 'restart', t.nssm);
      // A restart that worked is bookkeeping; one that failed is an issue, so
      // only the success carries the mutable category.
      if (res.ok) this.monitor.addAlert('info', id, 'Service restarted', 'restart');
      else this.monitor.addAlert('error', id, `Restart failed: ${res.error}`);
      return res;
    }

    const stopped = await this.stop(id);
    if (!stopped.ok) return stopped;

    // With the server down the save files are at rest, so this is both the
    // safest moment to archive them and the last point at which a bad update or
    // a corrupt world can still be rolled back.
    let backup = null;
    if (t.backup?.enabled && t.backup?.beforeRestart && this.backups) {
      backup = await this.backups.run(id, { reason: 'before restart', save: false });
      if (!backup.ok) {
        this.monitor.addAlert('warn', id, `Pre-restart backup failed, continuing with the restart: ${backup.error}`, 'backup');
      }
    }

    await delay(RESTART_GAP_MS);
    const started = await this.start(id);
    this.monitor.addAlert('info', id, 'Restart complete', 'restart');
    return { ok: started.ok, forced: stopped.forced, error: started.error, backup: backup?.file ?? null };
  }

  // Warn players at 15/10/5/1 minutes, then restart. Cancellable.
  scheduleRestart(id, minutes, reason = 'scheduled restart') {
    const t = this.target(id);
    if (t.kind !== 'game') return { ok: false, error: 'countdown only applies to game servers' };
    if (this.pending.has(id)) return { ok: false, error: 'a restart is already scheduled' };

    const finishAt = Date.now() + minutes * 60_000;
    const timers = [];

    for (const m of WARN_MINUTES) {
      if (m >= minutes) continue;
      const fireIn = (minutes - m) * 60_000;
      timers.push(setTimeout(() => {
        this.broadcast(id, `Server restarting in ${m} minute${m === 1 ? '' : 's'} - ${reason}`).catch(() => {});
        this.monitor.addAlert('info', id, `Warned players: ${m} minute(s) to restart`, 'restart');
      }, fireIn));
    }

    timers.push(setTimeout(async () => {
      this.pending.delete(id);
      this.monitor.addAlert('warn', id, 'Countdown finished — restarting now', 'restart');
      await this.restartNow(id);
    }, minutes * 60_000));

    this.pending.set(id, { timers, finishAt, reason });
    this.broadcast(id, `Server restarting in ${minutes} minutes - ${reason}`).catch(() => {});
    this.monitor.addAlert('info', id, `Restart scheduled in ${minutes} minute(s)`, 'restart');
    return { ok: true, finishAt };
  }

  cancelRestart(id) {
    const p = this.pending.get(id);
    if (!p) return { ok: false, error: 'nothing scheduled' };
    p.timers.forEach(clearTimeout);
    this.pending.delete(id);
    this.broadcast(id, 'Restart cancelled').catch(() => {});
    this.monitor.addAlert('info', id, 'Scheduled restart cancelled', 'restart');
    return { ok: true };
  }

  pendingInfo() {
    return Object.fromEntries(
      [...this.pending].map(([id, p]) => [id, { finishAt: p.finishAt, reason: p.reason }]),
    );
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
