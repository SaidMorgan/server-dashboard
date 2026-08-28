// Everything that changes server state: start, stop, graceful restart with
// player warnings, saves, broadcasts, raw RCON.
import { rconCommand } from './rcon.js';
import { getProfile } from './games/index.js';
import { launchDetached, killProcess, controlService, runCommands, getProcessStats } from './win.js';

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

// Fallback for a service target's preRestartTimeoutMinutes. A pull is seconds;
// an npm install on a cold cache is not.
const DEFAULT_PRE_RESTART_MINUTES = 5;

// How long a server that refused the shutdown command gets before it is killed.
// Well short of the full grace — nothing is winding down, so there is nothing to
// wait for — but not instant: the usual reason for a refusal is a server still
// loading its world, and a reply can be lost by a server that is in fact exiting.
const REFUSED_SHUTDOWN_GRACE_MS = 45_000;

const SAVE_FLUSH_MS = 3000;          // let a save reach disk before asking to exit
const RESTART_GAP_MS = 5000;         // pause between the process dying and relaunch
const STOP_POLL_MS = 3000;           // how often to check whether it exited yet

export class Actions {
  constructor(config, monitor) {
    this.config = config;
    this.monitor = monitor;
    this.pending = new Map(); // id -> {timers, finishAt, reason}
    this.starting = new Map(); // id -> ms timestamp of an unconfirmed launch
    this.backups = null;      // set by server.js; Backups needs Actions too
    this.shutdownGraceSeconds = config.restart?.graceSeconds ?? DEFAULT_SHUTDOWN_GRACE_SECONDS;
  }

  target(id) {
    const t = this.config.targets.find((x) => x.id === id);
    if (!t) throw new Error(`unknown target: ${id}`);
    return t;
  }

  // A service only counts as up once its health check passes, so its blackout
  // has to cover the warm-up and not just the restart. When it falls short the
  // service comes back *after* the blackout ends, which is indistinguishable
  // from an unplanned outage that recovered on its own — and that pushed a
  // "Back online" to the channel every single night. readyAfterSeconds is how
  // long the thing takes to answer for itself.
  serviceBlackout(t) {
    return t?.readyAfterSeconds ? t.readyAfterSeconds * 1000 : SUPPRESS_SERVICE_MS;
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

    // The snapshot alone is not a safe guard. A cold Icarus map load takes two
    // minutes to answer a query, so for that whole window `up` is false and a
    // second click launches a second copy on top of the first. Both bind 17777,
    // the loser dies silently, and the survivor is a server nobody can find.
    // So: refuse a start while an unconfirmed one is still within its warm-up.
    const inFlight = this.starting.get(id);
    if (inFlight && Date.now() - inFlight < this.startWindow(t)) {
      return { ok: false, error: 'a start is already in progress' };
    }

    // And ask the process table rather than the poller, which is up to one
    // interval stale — the same lag that lets a double-start through.
    if (t.processName) {
      const stats = await getProcessStats([t.processName]).catch(() => ({}));
      if (stats[t.processName]?.running) {
        this.starting.delete(id);
        return { ok: false, error: 'already running' };
      }
    }

    this.starting.set(id, Date.now());
    this.monitor.suppress(id, true);
    setTimeout(() => this.monitor.suppress(id, false), SUPPRESS_START_MS).unref?.();
    const res = launchDetached(t.startCommand);
    if (res.ok) this.monitor.addAlert('info', id, 'Start requested from dashboard', 'restart');
    else this.starting.delete(id);
    return res;
  }

  // How long a launch stays "in flight" before another start is allowed again.
  // readyAfterSeconds is the game's own estimate of time-to-first-answer; the
  // fallback matches the alert blackout.
  startWindow(t) {
    const profile = t.game ? getProfile(t.game) : null;
    const secs = t.readyAfterSeconds ?? profile?.defaults?.readyAfterSeconds;
    return secs ? secs * 1000 : SUPPRESS_START_MS;
  }

  // Save first, ask the server to exit, then make sure it actually died.
  async stop(id, { announce = true } = {}) {
    const t = this.target(id);
    if (t.kind === 'service') {
      this.monitor.suppress(id, true);
      setTimeout(() => this.monitor.suppress(id, false), this.serviceBlackout(t)).unref?.();
      return controlService(t.serviceName, 'stop', t.nssm);
    }

    this.starting.delete(id);
    this.monitor.suppress(id, true);
    const profile = getProfile(t.game);

    // A game with no remote interface can't be asked politely — the process
    // table is the only handle we have. Most such servers save on SIGTERM.
    if (profile.transport === 'none') {
      const killed = await killProcess(t.processName);
      await this.monitor.pollOnce().catch(() => {});
      setTimeout(() => this.monitor.suppress(id, false), SUPPRESS_SETTLE_MS).unref?.();
      if (!killed.ok) {
        this.monitor.addAlert('error', id, `Could not stop the server — ${killed.error}`);
        return { ok: false, error: killed.error };
      }
      this.monitor.addAlert('info', id, 'Stopped (no remote interface — process terminated)', 'restart');
      return { ok: true, saved: false, forced: true };
    }

    // Palworld renders this as an on-screen countdown — the only server message
    // players can't miss, since announce only reaches the chat panel. ARK exits
    // immediately on doexit, so its countdown is 0.
    //
    // With nobody online there is nobody to warn, so skip it: a minute of grace
    // for an empty server is a minute of watching a server that could already be
    // down. An unknown player list — RCON not answering — is not an empty one,
    // so only a confirmed zero skips the wait.
    const online = this.monitor.state.get(id)?.players?.length ?? null;
    const countdown = online === 0 ? 0 : (t.shutdownCountdownSeconds ?? 0);

    if (announce) {
      const msg = countdown
        ? `Server restarting in ${countdown} seconds`
        : 'Server shutting down now';
      await this.broadcast(id, msg).catch(() => {});
    }
    const saved = await this.save(id).catch(() => ({ ok: false }));
    await delay(SAVE_FLUSH_MS);

    // Whether the server actually accepted the order to exit decides how long it
    // is worth waiting. Swallowing this — which is what used to happen — meant a
    // refused shutdown looked exactly like a slow one: the full countdown and
    // grace period would elapse in silence before the process was killed
    // anyway. A server still loading its world is the common case; it answers
    // /save and refuses /shutdown.
    const asked = profile.transport === 'rest'
      ? await profile.rest.shutdown(t, countdown, 'Server restarting').catch((err) => ({ ok: false, error: err.message }))
      : await this.rcon(id, profile.commands.shutdown).catch((err) => ({ ok: false, error: err.message }));

    if (!asked.ok) {
      this.monitor.addAlert('warn', id,
        `The server refused the shutdown command (${asked.error}) — it will be force-killed instead`,
        'restart');
    }

    // Wait out the countdown itself, plus grace for the world to flush to disk,
    // before force-killing. Force-killing mid-countdown would defeat the point.
    const waitingSince = Date.now();
    const waited = () => Math.round((Date.now() - waitingSince) / 1000);
    // Nothing was asked to exit, so there is no countdown to sit through and no
    // world being flushed: just enough time for the save that already went
    // through to land, then the kill.
    const deadline = waitingSince + (asked.ok
      ? (countdown + this.shutdownGraceSeconds) * 1000
      : REFUSED_SHUTDOWN_GRACE_MS);

    while (Date.now() < deadline) {
      await delay(STOP_POLL_MS);
      // Just this one process. The old version ran the entire poll loop — every
      // target, RCON round-trips and all — every few seconds at a server in the
      // middle of writing a large world to disk, which is the worst possible
      // moment to add load to it.
      const stats = await getProcessStats([t.processName]);
      if (!stats[t.processName]?.running) {
        // One real poll now that it is down, so the card and anything that asks
        // "is it up?" next — restartNow's start, for one — see the truth.
        await this.monitor.pollOnce().catch(() => {});
        this.monitor.addAlert('info', id, `Stopped cleanly after ${waited()}s`, 'restart');
        setTimeout(() => this.monitor.suppress(id, false), SUPPRESS_SETTLE_MS).unref?.();
        return { ok: true, saved: saved.ok, forced: false, seconds: waited() };
      }
    }

    const killed = await killProcess(t.processName);
    await this.monitor.pollOnce().catch(() => {});
    setTimeout(() => this.monitor.suppress(id, false), SUPPRESS_SETTLE_MS).unref?.();

    // A kill that didn't work is the one outcome the caller must not treat as a
    // stopped server: on top of it goes a restart that starts a second copy on
    // the same ports, or a Steam update against files that are still open.
    if (!killed.ok) {
      this.monitor.addAlert('error', id,
        `Still running ${waited()}s after being asked to stop, and the forced kill failed — ${killed.error}`);
      return { ok: false, error: killed.error, saved: saved.ok, seconds: waited() };
    }

    // A warn, but still part of a stop somebody asked for: the dashboard wanted
    // it down and it is down. The feed records how it went; the channel doesn't
    // need it.
    this.monitor.addAlert('warn', id,
      `Did not exit on request within ${waited()}s — the process and everything it started were force-killed`,
      'restart');
    return { ok: true, saved: saved.ok, forced: true, seconds: waited() };
  }

  async restartNow(id) {
    const t = this.target(id);
    if (t.kind === 'service') {
      this.monitor.suppress(id, true);
      setTimeout(() => this.monitor.suppress(id, false), this.serviceBlackout(t)).unref?.();
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

    // "Restart complete" used to be logged whether or not the server came back,
    // and as routine restart chatter it was muted everywhere that would have
    // told you. A restart that stopped a server and failed to start it is the
    // one event most worth an interruption, so it goes out uncategorised.
    if (started.ok) {
      this.monitor.addAlert('info', id, 'Restart complete', 'restart');
    } else {
      this.monitor.addAlert('error', id,
        `Restart failed — the server was stopped but did not come back up: ${started.error}`);
    }
    return { ok: started.ok, forced: stopped.forced, error: started.error, backup: backup?.file ?? null };
  }

  // Restart, with the target's preRestartCommand run in between — a `git pull`,
  // an install, a build. Separate from restartNow on purpose: a service that has
  // simply wedged should be bounced on the code that is already there, without
  // dragging in whatever landed upstream since.
  //
  // Stop first, then update, then start. Windows will not let git replace a file
  // the running process holds open, so updating a live service is how you get a
  // half-applied working tree.
  async updateAndRestart(id) {
    const t = this.target(id);
    if (t.kind !== 'service') {
      return { ok: false, error: 'update & restart only applies to service targets' };
    }
    if (!t.preRestartCommand) {
      return { ok: false, error: 'no preRestartCommand configured for this target' };
    }

    const minutes = t.preRestartTimeoutMinutes ?? DEFAULT_PRE_RESTART_MINUTES;
    const dir = t.preRestartDir || null;

    this.monitor.suppress(id, true);
    // The update sits inside the downtime, so the blackout has to cover it.
    const unsuppress = () => {
      setTimeout(() => this.monitor.suppress(id, false), this.serviceBlackout(t)).unref?.();
    };

    // controlService confirms the service reached Stopped rather than taking the
    // service manager's word for the request, which is what this path needs:
    // the files must not be open when the update touches them.
    const stopped = await controlService(t.serviceName, 'stop', t.nssm);
    if (!stopped.ok) {
      unsuppress();
      this.monitor.addAlert('error', id, `Update aborted — the service did not stop: ${stopped.error}`);
      return { ok: false, error: `stop failed: ${stopped.error}` };
    }
    this.monitor.addAlert('info', id, 'Stopped for update', 'restart');

    const update = await runCommands(t.preRestartCommand, dir, minutes * 60_000);

    if (!update.ok) {
      // Bring it back on the code that was already there. A failed pull is a
      // problem; a failed pull plus a service left down is an outage.
      const restored = await controlService(t.serviceName, 'start', t.nssm);
      unsuppress();
      this.monitor.addAlert('error', id, restored.ok
        ? `Update failed — restarted on the previous version: ${update.error}`
        : `Update failed and the service did not come back: ${update.error}`);
      return { ok: false, error: update.error, output: update.out, restored: restored.ok };
    }

    const started = await controlService(t.serviceName, 'start', t.nssm);
    unsuppress();
    if (started.ok) this.monitor.addAlert('info', id, 'Updated and restarted', 'restart');
    else this.monitor.addAlert('error', id, `Update applied, but the service did not start: ${started.error}`);
    return { ok: started.ok, error: started.error, output: update.out };
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
