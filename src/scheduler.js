// Recurring scheduled jobs: nightly restarts, periodic saves, backups.
//
// Jobs come from two places. Ones declared in config.json are read-only in the
// UI — config.json is the source of truth for those, so an edit in the browser
// would silently disagree with the file on disk. Ones created in the UI live in
// data/schedules.json and can be edited or deleted freely.
//
// No catch-up: if the dashboard was down when a job was due, it does not fire
// late on startup. Waking up to a stampede of missed 3am restarts is worse than
// missing them.
import fs from 'node:fs';
import path from 'node:path';
import { validateCron } from './config.js';

const ACTIONS = ['restart', 'start', 'stop', 'save', 'backup', 'broadcast'];

// --- cron ------------------------------------------------------------------

function parseField(field, lo, hi) {
  const allowed = new Set();
  for (const part of field.split(',')) {
    const [spec, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    let from = lo;
    let to = hi;
    if (spec !== '*') {
      const bounds = spec.split('-').map(Number);
      from = bounds[0];
      to = bounds.length > 1 ? bounds[1] : bounds[0];
    }
    for (let n = from; n <= to; n += step) allowed.add(n);
  }
  return allowed;
}

export function parseCron(expr) {
  const [min, hour, dom, month, dow] = expr.trim().split(/\s+/);
  const weekdays = parseField(dow, 0, 7);
  // Cron allows both 0 and 7 for Sunday.
  if (weekdays.has(7)) weekdays.add(0);
  return {
    minute: parseField(min, 0, 59),
    hour: parseField(hour, 0, 23),
    dom: parseField(dom, 1, 31),
    month: parseField(month, 1, 12),
    dow: weekdays,
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
  };
}

export function cronMatches(parsed, date) {
  if (!parsed.minute.has(date.getMinutes())) return false;
  if (!parsed.hour.has(date.getHours())) return false;
  if (!parsed.month.has(date.getMonth() + 1)) return false;

  const domHit = parsed.dom.has(date.getDate());
  const dowHit = parsed.dow.has(date.getDay());

  // Standard cron quirk: when BOTH day-of-month and day-of-week are restricted,
  // the job runs if EITHER matches, not both.
  if (parsed.domRestricted && parsed.dowRestricted) return domHit || dowHit;
  if (parsed.domRestricted) return domHit;
  if (parsed.dowRestricted) return dowHit;
  return true;
}

export function describeCron(expr) {
  const [min, hour, dom, month, dow] = expr.trim().split(/\s+/);
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const time = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

  if (month === '*' && dom === '*' && dow === '*' && /^\d+$/.test(min) && /^\d+$/.test(hour)) {
    return `daily at ${time(hour, min)}`;
  }
  if (month === '*' && dom === '*' && /^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d$/.test(dow)) {
    return `every ${DAYS[Number(dow) % 7]} at ${time(hour, min)}`;
  }
  if (month === '*' && dom === '*' && dow === '*' && /^\d+$/.test(min) && /^\*\/(\d+)$/.test(hour)) {
    return `every ${hour.slice(2)} hours at :${String(min).padStart(2, '0')}`;
  }
  if (month === '*' && dom === '*' && dow === '*' && /^\*\/(\d+)$/.test(min) && hour === '*') {
    return `every ${min.slice(2)} minutes`;
  }
  return expr;
}

export function nextRun(expr, from = new Date()) {
  const parsed = parseCron(expr);
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  // A year of minutes is a comfortable upper bound for any valid expression.
  for (let i = 0; i < 527_040; i += 1) {
    if (cronMatches(parsed, d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// --- scheduler -------------------------------------------------------------

export class Scheduler {
  constructor(config, monitor, actions, backups, dataDir) {
    this.config = config;
    this.monitor = monitor;
    this.actions = actions;
    this.backups = backups;
    this.file = path.join(dataDir, 'schedules.json');
    this.userJobs = this.#load();
    this.lastTickMinute = null;
    this.timer = null;
  }

  #load() {
    try {
      const rows = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(rows) ? rows : [];
    } catch {
      return []; // first run
    }
  }

  #save() {
    fs.writeFile(this.file, JSON.stringify(this.userJobs, null, 2), (err) => {
      if (err) console.error('[scheduler] could not persist schedules:', err.message);
    });
  }

  // Config-declared jobs get stable ids so their lastRun survives a restart.
  #configJobs() {
    const out = [];
    for (const t of this.config.targets) {
      (t.schedules || []).forEach((s, i) => {
        out.push({
          id: `config:${t.id}:${i}`,
          targetId: t.id,
          cron: s.cron,
          action: s.action,
          message: s.message ?? null,
          warnMinutes: s.warnMinutes ?? 0,
          reason: s.reason || `scheduled ${s.action}`,
          enabled: s.enabled !== false,
          source: 'config',
        });
      });
    }
    return out;
  }

  jobs() {
    const all = [...this.#configJobs(), ...this.userJobs.map((j) => ({ ...j, source: 'user' }))];
    return all.map((j) => ({
      ...j,
      description: describeCron(j.cron),
      nextRun: j.enabled ? nextRun(j.cron) : null,
      lastRun: this.lastRuns?.[j.id] ?? j.lastRun ?? null,
    }));
  }

  // --- CRUD for UI-created jobs ---
  add(job) {
    const error = this.#validate(job);
    if (error) return { ok: false, error };
    const record = {
      id: `user:${Date.now().toString(36)}${Math.floor(performance.now() * 1000) % 1000}`,
      targetId: job.targetId,
      cron: job.cron.trim(),
      action: job.action,
      message: job.message ?? null,
      warnMinutes: Number(job.warnMinutes) || 0,
      reason: job.reason || `scheduled ${job.action}`,
      enabled: job.enabled !== false,
      lastRun: null,
    };
    this.userJobs.push(record);
    this.#save();
    return { ok: true, job: record };
  }

  update(id, patch) {
    const job = this.userJobs.find((j) => j.id === id);
    if (!job) return { ok: false, error: 'schedules declared in config.json are edited in that file, not here' };
    const merged = { ...job, ...patch };
    const error = this.#validate(merged);
    if (error) return { ok: false, error };
    Object.assign(job, merged);
    this.#save();
    return { ok: true, job };
  }

  remove(id) {
    const before = this.userJobs.length;
    this.userJobs = this.userJobs.filter((j) => j.id !== id);
    if (this.userJobs.length === before) {
      return { ok: false, error: 'no such schedule (jobs from config.json are removed by editing that file)' };
    }
    this.#save();
    return { ok: true };
  }

  #validate(job) {
    if (!this.config.targets.some((t) => t.id === job.targetId)) return `unknown target: ${job.targetId}`;
    if (!ACTIONS.includes(job.action)) return `action must be one of ${ACTIONS.join(', ')}`;
    const cronError = validateCron(job.cron);
    if (cronError) return `cron: ${cronError}`;
    if (job.action === 'broadcast' && !String(job.message || '').trim()) return 'a broadcast needs a message';
    return null;
  }

  // --- running ---
  async runJob(job) {
    const { targetId, action } = job;
    this.lastRuns = this.lastRuns || {};
    this.lastRuns[job.id] = Date.now();

    const userJob = this.userJobs.find((j) => j.id === job.id);
    if (userJob) { userJob.lastRun = Date.now(); this.#save(); }

    try {
      switch (action) {
        case 'backup':
          return await this.backups.run(targetId, { reason: 'scheduled' });
        case 'save':
          return await this.actions.save(targetId);
        case 'broadcast':
          return await this.actions.broadcast(targetId, job.message);
        case 'start':
          return await this.actions.start(targetId);
        case 'stop':
        case 'restart': {
          // Warn players first when asked. scheduleRestart already handles the
          // 15/10/5/1 minute countdown and is cancellable from the UI.
          if (job.warnMinutes > 0 && action === 'restart') {
            return this.actions.scheduleRestart(targetId, job.warnMinutes, job.reason);
          }
          this.monitor.addAlert('info', targetId, `Scheduled ${action} starting now — ${job.reason}`, 'restart');
          return action === 'stop'
            ? await this.actions.stop(targetId)
            : await this.actions.restartNow(targetId);
        }
        default:
          return { ok: false, error: `unknown action: ${action}` };
      }
    } catch (err) {
      this.monitor.addAlert('error', targetId, `Scheduled ${action} failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  tick(now = new Date()) {
    const minuteKey = Math.floor(now.getTime() / 60_000);
    if (minuteKey === this.lastTickMinute) return []; // timer drift double-fire
    this.lastTickMinute = minuteKey;

    const due = [];
    for (const job of this.jobs()) {
      if (!job.enabled) continue;
      let parsed;
      try {
        parsed = parseCron(job.cron);
      } catch {
        continue; // validated on the way in; a bad one should not stop the rest
      }
      if (cronMatches(parsed, now)) due.push(job);
    }

    for (const job of due) {
      this.runJob(job).catch((err) => console.error('[scheduler]', err.message));
    }
    return due;
  }

  start() {
    // Align to the top of the minute so jobs fire when the clock says they do.
    const msToNextMinute = 60_000 - (Date.now() % 60_000);
    setTimeout(() => {
      this.tick();
      this.timer = setInterval(() => this.tick(), 60_000);
      this.timer.unref?.();
    }, msToNextMinute).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
