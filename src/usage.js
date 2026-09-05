// Long-term utilisation: how busy a server usually is, by hour and by weekday.
//
// The history in monitor.js answers "what is happening right now" and is
// deliberately short -- historyHours of ten-second samples, trimmed on every
// poll. It cannot answer "is Saturday evening busy", because by Saturday
// evening last Saturday has already been thrown away.
//
// So this keeps a second, much smaller store: one bucket per (weekday, hour)
// per target, holding a few running totals rather than the samples themselves.
// 168 buckets times a handful of weeks is a few tens of kilobytes and never
// grows, which is what makes keeping it forever reasonable where keeping the
// samples is not.
//
// WHY SECONDS AND NOT SAMPLE COUNTS. Every total here is in observed seconds,
// accumulated as (players * elapsed since the last poll), not as a count of
// polls. A poll interval that changes, a dashboard restart, a poll that ran
// late -- all of them would silently reweight an average built on sample
// counts, and none of them touch one built on elapsed time. It also means the
// daily figure comes out as player-hours directly, which is the unit that
// actually says how much a server got used.
import fs from 'node:fs';
import path from 'node:path';

const FILE_VERSION = 1;

// How many weeks of each (weekday, hour) bucket to keep. The current week plus
// four completed ones: enough that a typical Saturday is an average of four
// Saturdays and not of one, and few enough that a server whose players moved on
// months ago stops being described by how busy it used to be.
const WEEKS_KEPT = 5;

// Days of per-day totals, for the weekly bars. Ten weeks, so a "typical
// weekday" figure there rests on about the same number of observations.
const DAYS_KEPT = 70;

// Closed sessions are kept as individual rows, unlike everything else here,
// because the questions asked of them ("how long is a session", "how many
// people were on last week") cannot be answered from a running total -- an
// average of averages is not an average, and a sum cannot be de-duplicated
// into a headcount. Two caps, because either one alone has a bad case: the
// day bound alone lets one very busy server write an unbounded file, and the
// row bound alone lets a quiet one keep sessions from last spring.
const SESSION_DAYS = 30;
const SESSION_ROWS = 2000;

// A session shorter than this is a bounce, not a visit -- a connection that
// failed, a client that reconnected, a look at the server list. Counting them
// drags the average session length toward zero and inflates the session count
// with events nobody would call a session.
const MIN_SESSION_SECONDS = 60;

// The one part of this store that grows with the playerbase rather than with
// time, so it is the one part that needs a ceiling. Half a year is well past
// the point where somebody counts as a returning player, and a hundred names is
// far more than a family server will ever hold -- the bound is there so a
// public one cannot accumulate every stranger who ever looked in, forever, in a
// file rewritten every minute.
//
// Eviction is by playtime, not by recency: the hundred people who have actually
// played are the hundred worth remembering, and dropping the biggest player on
// the server because they took a fortnight off would be the wrong trade. Anyone
// online is exempt, since their session is still accumulating into the record
// being considered for deletion.
const PEOPLE_DAYS = 180;
const PEOPLE_MAX = 100;

// Below this many people a retention percentage is arithmetic, not evidence:
// with two candidates it can only ever say 0%, 50% or 100%. Reported as
// unknown instead of as a number that will be read as a trend.
const MIN_RETENTION_COHORT = 4;

// A poll that arrives later than this after the previous one is a gap, not a
// measurement -- the dashboard was restarted, the machine slept, the service
// was reinstalled. Crediting the whole gap would invent hours of players who
// were never there, so a gap counts as one ordinary interval instead.
const MAX_GAP_FACTOR = 3;

// Written on a timer rather than on every poll. Losing the last minute of
// utilisation data in a crash costs nothing, and the file is rewritten whole.
const FLUSH_MS = 60_000;

/** Local calendar day as a whole number of days, so date maths cannot drift. */
function dayNumber(d) {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
}

/** The Sunday that starts this date's week, as a day number. Used as a week id. */
function weekId(d) {
  return dayNumber(d) - d.getDay();
}

/** yyyy-mm-dd in local time -- the key the per-day totals are stored under. */
function dateKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Parse a dateKey back to a local Date, without going through the string parser. */
function fromDateKey(key) {
  const [y, m, day] = key.split('-').map(Number);
  return new Date(y, m - 1, day);
}

function emptyBucket(w) {
  // obs: seconds we had a believable player reading for (a server that is down
  //      counts, as zero players -- "nobody could play" is a real answer).
  // ps:  player-seconds, the numerator of every average here.
  // on:  seconds the server was up.        n: seconds observed at all.
  // max: the highest concurrent player count seen in the bucket.
  return { w, obs: 0, ps: 0, on: 0, n: 0, max: 0 };
}

function addSample(bucket, { up, players, dt }) {
  bucket.n += dt;
  if (up) bucket.on += dt;
  // A server that is up but whose player count could not be read (RCON down
  // mid-restart, a query timeout) is genuinely unknown. Averaging that in as
  // zero would make every restart look like an empty evening.
  const known = up ? (players ?? null) : 0;
  if (known === null) return;
  bucket.obs += dt;
  bucket.ps += known * dt;
  if (known > bucket.max) bucket.max = known;
}

/** Player-seconds over observed seconds: the average concurrent player count. */
function meanPlayers(rows) {
  let ps = 0;
  let obs = 0;
  for (const r of rows) { ps += r.ps; obs += r.obs; }
  return obs > 0 ? ps / obs : null;
}

/**
 * Every session that overlaps a window, clipped to it, plus the ones still open.
 *
 * Clipping matters more than it looks. A session that started last Tuesday and
 * ran past midnight belongs partly to each day, and counting it whole in both
 * is how a week's playtime comes out larger than the week. The clip is applied
 * to the wall-clock span but scaled onto the observed duration, so a session
 * that spanned a dashboard restart stays honest about how much of it was
 * actually watched.
 */
function sessionsIn(store, fromMs, toMs, now) {
  const out = [];
  for (const row of store.sessions || []) {
    if (row.e <= fromMs || row.s >= toMs) continue;
    const span = Math.max(1, row.e - row.s);
    const overlap = Math.min(row.e, toMs) - Math.max(row.s, fromMs);
    out.push({ ...row, share: row.d * (overlap / span), open: false });
  }
  for (const [key, open] of Object.entries(store.open || {})) {
    if (now <= fromMs) continue;
    const span = Math.max(1, now - open.at);
    const overlap = Math.min(now, toMs) - Math.max(open.at, fromMs);
    if (overlap <= 0) continue;
    out.push({ k: key, n: open.name, s: open.at, e: now, d: open.sec, share: open.sec * (overlap / span), open: true });
  }
  return out;
}

export class UsageStats {
  constructor(config, dataDir) {
    this.config = config;
    this.file = path.join(dataDir, 'usage.json');
    this.data = { version: FILE_VERSION, targets: {} };
    this.lastAt = new Map(); // target id -> when we last credited it time
    this.dirty = false;
    this.lastFlush = 0;
    fs.mkdirSync(dataDir, { recursive: true });
    this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw?.version === FILE_VERSION && raw.targets) this.data = raw;
    } catch { /* first run, or a file we cannot read -- start over */ }
  }

  #forTarget(id) {
    let t = this.data.targets[id];
    if (!t) t = this.data.targets[id] = {};
    // Filled in lazily and defensively rather than in one literal, so a
    // usage.json written by an older build gains the new sections instead of
    // throwing on the first poll after an upgrade.
    t.hours ||= {};
    t.days ||= {};
    t.people ||= {};    // key -> lifetime totals for one person
    t.open ||= {};      // key -> the session they are in right now
    t.sessions ||= [];  // recently closed sessions, oldest first
    t.peak ||= { n: 0, at: null };
    return t;
  }

  /**
   * Turn the live player list into sessions.
   *
   * Time is accumulated tick by tick rather than measured as (left - joined).
   * Those are the same number right up until the dashboard is restarted or the
   * machine sleeps mid-session, and then the subtraction quietly credits
   * somebody with eight hours of play they were not there for. The same reason
   * the hour buckets clamp their gap.
   *
   * A missing player list is not an empty one. Only a server that is actually
   * down ends everyone's session; a query that failed or a roster that could
   * not be read leaves them open, because the alternative is a restart-shaped
   * hole chopping one evening into four "sessions".
   */
  #recordSessions(store, snap, now, dt) {
    const list = snap.up ? snap.players : [];
    if (!list) return;

    const seen = new Map();
    for (const p of list) {
      if (!p) continue;
      // Prefer a stable id where the game has one: names change, and a rename
      // should not read as one player leaving and a new one arriving.
      const key = String(p.id ?? p.name ?? '').trim();
      if (key) seen.set(key, p.name ?? key);
    }

    for (const [key, name] of seen) {
      const person = store.people[key] || (store.people[key] = {
        name, first: dayNumber(new Date(now)), last: now, sec: 0, sess: 0, longest: 0, firstSec: null,
      });
      person.name = name;
      person.last = now;
      person.sec += dt;
      const open = store.open[key] || (store.open[key] = { at: now, sec: 0, name });
      open.sec += dt;
      open.name = name;
    }

    for (const key of Object.keys(store.open)) {
      if (seen.has(key)) continue;
      const open = store.open[key];
      delete store.open[key];
      if (open.sec < MIN_SESSION_SECONDS) continue;
      const person = store.people[key];
      if (person) {
        person.sess += 1;
        if (open.sec > person.longest) person.longest = open.sec;
        // The length of somebody's very first visit is the one session that
        // says whether newcomers stay, so it is kept apart from the average.
        if (person.firstSec == null) person.firstSec = open.sec;
      }
      store.sessions.push({ k: key, n: open.name, s: open.at, e: now, d: Math.round(open.sec) });
    }
  }

  /**
   * Credit one poll's worth of elapsed time to every game target.
   *
   * Services are skipped: they have no player count, so a busyness chart for
   * one would be a flat line at zero pretending to be information.
   */
  record(snapshots, now = Date.now()) {
    const d = new Date(now);
    const key = `${d.getDay()}-${d.getHours()}`;
    const w = weekId(d);
    const day = dateKey(d);
    const interval = (this.config.pollSeconds || 10) * 1000;
    const maxGap = interval * MAX_GAP_FACTOR;

    for (const snap of snapshots) {
      const target = this.config.targets.find((t) => t.id === snap.id);
      if (!target || target.kind !== 'game') continue;

      const prev = this.lastAt.get(snap.id);
      this.lastAt.set(snap.id, now);
      const gap = prev == null ? interval : now - prev;
      const dt = (gap <= 0 || gap > maxGap ? interval : gap) / 1000;

      const store = this.#forTarget(snap.id);
      const sample = { up: !!snap.up, players: snap.playerCount ?? null, dt };

      const weeks = store.hours[key] || (store.hours[key] = []);
      if (weeks[0]?.w !== w) {
        weeks.unshift(emptyBucket(w));
        weeks.length = Math.min(weeks.length, WEEKS_KEPT);
      }
      addSample(weeks[0], sample);

      const today = store.days[day] || (store.days[day] = emptyBucket(w));
      addSample(today, sample);

      // All-time peak, kept with the moment it happened -- "six players" is a
      // different fact from "six players, once, in August".
      if (snap.up && snap.playerCount != null && snap.playerCount > store.peak.n) {
        store.peak = { n: snap.playerCount, at: now };
      }

      this.#recordSessions(store, snap, now, dt);
    }

    this.dirty = true;
    this.#trim(dayNumber(d), now);
    if (now - this.lastFlush >= FLUSH_MS) this.flush(now);
  }

  #trim(today, now) {
    for (const store of Object.values(this.data.targets)) {
      for (const key of Object.keys(store.days)) {
        if (today - dayNumber(fromDateKey(key)) > DAYS_KEPT) delete store.days[key];
      }
      if (!store.sessions) continue;
      const cutoff = now - SESSION_DAYS * 86_400_000;
      let from = 0;
      while (from < store.sessions.length && store.sessions[from].e < cutoff) from++;
      const over = store.sessions.length - from - SESSION_ROWS;
      if (over > 0) from += over;
      if (from > 0) store.sessions.splice(0, from);

      // Never evict somebody who is on right now, however long ago they first
      // appeared -- their session is still accumulating into that record.
      const stale = now - PEOPLE_DAYS * 86_400_000;
      const people = Object.entries(store.people || {});
      for (const [key, v] of people) {
        if (v.last < stale && !store.open?.[key]) delete store.people[key];
      }
      // Rank everyone, then delete from the bottom of that ranking -- skipping
      // whoever is online rather than passing their share of the quota up to
      // the next name. Taking the quota from the survivors instead is how a
      // roomful of drive-by visitors could evict every regular on the server;
      // under-deleting for one poll is the harmless half of that trade, and the
      // bound is restored the moment they log off.
      const ranked = Object.entries(store.people || {});
      if (ranked.length > PEOPLE_MAX) {
        ranked.sort((a, b) => a[1].sec - b[1].sec); // least time played first
        for (const [key] of ranked.slice(0, ranked.length - PEOPLE_MAX)) {
          if (!store.open?.[key]) delete store.people[key];
        }
      }
    }
  }

  // Written through a temp file and renamed, which history.json does not bother
  // with and should not: history is minutes old and rebuilt by the next poll.
  // This store is months of weekday averages that nothing can reconstruct, and
  // a plain write truncates first -- so the one crash that lands mid-write
  // would leave an empty file where the only copy of them used to be.
  //
  // sync is for shutdown: an async write queued as the process exits does not
  // land, and dropping the last minute on every restart would quietly bias the
  // averages against whatever time of day this box gets rebooted.
  flush(now = Date.now(), { sync = false } = {}) {
    if (!this.dirty) return;
    this.dirty = false;
    this.lastFlush = now;
    const json = JSON.stringify(this.data);
    const tmp = `${this.file}.tmp`;
    if (sync) {
      try {
        fs.writeFileSync(tmp, json);
        fs.renameSync(tmp, this.file);
      } catch { /* nothing left to do at exit */ }
      return;
    }
    fs.writeFile(tmp, json, (err) => {
      if (err) return;
      fs.rename(tmp, this.file, () => {});
    });
  }

  /**
   * Everything a card needs to draw its two charts, in one reply.
   *
   * The split that matters here is typical-versus-now. Every "typical" figure
   * is computed from COMPLETED weeks only, never from the week in progress --
   * otherwise this morning would be part of the baseline this morning is being
   * compared against, and the overlay could never show anything but "normal".
   * A new install has no completed weeks, so it falls back to what it has and
   * says how many weeks that is, rather than presenting one Tuesday as the
   * truth about Tuesdays.
   */
  report(id, now = Date.now()) {
    const d = new Date(now);
    const thisWeek = weekId(d);
    const dow = d.getDay();
    const hour = d.getHours();
    const store = this.data.targets[id];
    if (!store) {
      return {
        ok: true, learning: true, weeks: 0, dow, hour,
        day: [], week: [], recent: [], heatmap: [], hottest: 0,
        hasNames: false, people: null, summary: null,
      };
    }

    // --- today, hour by hour, against a typical version of the same weekday --
    const day = [];
    for (let h = 0; h < 24; h++) {
      const rows = store.hours[`${dow}-${h}`] || [];
      const past = rows.filter((r) => r.w !== thisWeek && r.obs > 0);
      const base = past.length ? past : rows.filter((r) => r.obs > 0);
      const live = rows.find((r) => r.w === thisWeek) || null;
      day.push({
        hour: h,
        typical: meanPlayers(base),
        typicalPeak: base.length ? Math.max(...base.map((r) => r.max)) : null,
        weeks: past.length,
        actual: live && live.obs > 0 ? live.ps / live.obs : null,
        peak: live ? live.max : null,
        // An hour still in progress is not a quiet hour, it is a partial one,
        // and the chart has to say which.
        partial: h === hour,
        future: h > hour,
      });
    }

    // --- the week, day by day, in player-hours -------------------------------
    const dayNum = dayNumber(d);
    const dated = Object.entries(store.days).map(([key, row]) => ({ key, row, at: fromDateKey(key) }));
    const week = [];
    for (let wd = 0; wd < 7; wd++) {
      const past = [];
      let current = null;
      for (const { row, at } of dated) {
        if (at.getDay() !== wd) continue;
        const entry = { playerHours: row.ps / 3600, peak: row.max };
        if (weekId(at) === thisWeek) current = entry;
        else past.push(entry);
      }
      week.push({
        dow: wd,
        typical: past.length ? past.reduce((a, b) => a + b.playerHours, 0) / past.length : null,
        typicalPeak: past.length ? Math.max(...past.map((h) => h.peak)) : null,
        weeks: past.length,
        actual: current?.playerHours ?? null,
        peak: current?.peak ?? null,
        today: wd === dow,
        future: wd > dow,
      });
    }

    // --- headline numbers ----------------------------------------------------
    const recent = dated
      .map(({ key, row, at }) => ({
        date: key,
        age: dayNum - dayNumber(at),
        playerHours: row.ps / 3600,
        peak: row.max,
        n: row.n,
        on: row.on,
      }))
      .filter((r) => r.age >= 0 && r.age <= 27)
      .sort((a, b) => a.age - b.age);

    const span = (from, to) => recent.filter((r) => r.age >= from && r.age <= to);
    const sum = (rows, pick) => rows.reduce((a, r) => a + pick(r), 0);
    const last7 = span(0, 6);
    const prev7 = span(7, 13);

    // The busiest slot answers "when must I not restart", and its inverse
    // answers "when should I schedule one" -- which is the actionable half.
    let busiest = null;
    let quietest = null;
    let active = 0;
    let observed = 0;
    for (const [key, rows] of Object.entries(store.hours)) {
      const usable = rows.filter((r) => r.obs > 0);
      for (const r of usable) {
        observed += r.obs;
        if (r.ps > 0) active += r.obs;
      }
      const avg = meanPlayers(usable);
      if (avg == null) continue;
      const [wd, h] = key.split('-').map(Number);
      const slot = { dow: wd, hour: h, avg };
      if (!busiest || avg > busiest.avg) busiest = slot;
      if (!quietest || avg < quietest.avg) quietest = slot;
    }

    const uptimeSpan = sum(last7, (r) => r.n);
    const weeksSeen = new Set();
    for (const rows of Object.values(store.hours)) for (const r of rows) weeksSeen.add(r.w);

    // --- the punch card ------------------------------------------------------
    //
    // The same buckets the busy chart reads, laid out as a 7x24 grid instead of
    // one weekday at a time. It is the one view that answers "when is this
    // server used" in a single glance rather than seven, which is why every
    // analytics tool for game servers ends up drawing one.
    const heatmap = [];
    let hottest = 0;
    for (let wd = 0; wd < 7; wd++) {
      const row = [];
      for (let h = 0; h < 24; h++) {
        const rows = (store.hours[`${wd}-${h}`] || []).filter((r) => r.obs > 0);
        const avg = meanPlayers(rows);
        if (avg != null && avg > hottest) hottest = avg;
        row.push({ dow: wd, hour: h, avg, weeks: rows.length });
      }
      heatmap.push(row);
    }

    // --- who, not how many ---------------------------------------------------
    const dayMs = 86_400_000;
    const win7 = sessionsIn(store, now - 7 * dayMs, now, now);
    const win30 = sessionsIn(store, now - 30 * dayMs, now, now);
    const people = Object.entries(store.people || {});
    const hasNames = people.length > 0;

    const playtime = new Map();
    for (const row of win7) playtime.set(row.k, (playtime.get(row.k) || 0) + row.share);

    // Closed sessions only. An open one is a lower bound on its own length, and
    // averaging in a session that is still growing biases the figure down all
    // evening and then jumps when everyone logs off.
    const closed7 = win7.filter((r) => !r.open);
    const firstSessions = people.map(([, v]) => v.firstSec).filter((v) => v != null);

    // Retention, the way a server owner actually means it: of the people who
    // turned up for the first time between one and four weeks ago -- long
    // enough ago to have had the chance to come back -- how many did?
    const cohort = people.filter(([, v]) => {
      const age = dayNum - v.first;
      return age >= 7 && age <= 30;
    });
    const returned = cohort.filter(([, v]) => now - v.last <= 7 * dayMs);

    const top = [...playtime.entries()]
      .map(([k, sec]) => ({ key: k, name: store.people[k]?.name || k, seconds: sec, online: !!store.open?.[k] }))
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, 6);

    return {
      ok: true,
      dow,
      hour,
      // Completed weeks only -- the number the "typical" line is actually made of.
      weeks: Math.max(0, weeksSeen.size - 1),
      learning: weeksSeen.size <= 1,
      day,
      week,
      recent,
      heatmap,
      hottest,
      // A game that reports only a count (Icarus answers the player query with
      // blank names) has no session data and never will. Saying so lets the
      // card drop the panel rather than draw an empty one that looks broken.
      hasNames,
      people: !hasNames ? null : {
        unique7d: new Set(win7.map((r) => r.k)).size,
        unique30d: new Set(win30.map((r) => r.k)).size,
        newcomers7d: people.filter(([, v]) => dayNum - v.first <= 7).length,
        regulars7d: new Set(win7.filter((r) => dayNum - (store.people[r.k]?.first ?? dayNum) > 7).map((r) => r.k)).size,
        sessions7d: closed7.length,
        avgSession: closed7.length ? closed7.reduce((a, r) => a + r.d, 0) / closed7.length : null,
        longestSession: win7.length ? Math.max(...win7.map((r) => r.d)) : null,
        firstSessionAvg: firstSessions.length ? firstSessions.reduce((a, b) => a + b, 0) / firstSessions.length : null,
        retention: cohort.length >= MIN_RETENTION_COHORT ? returned.length / cohort.length : null,
        retentionCohort: cohort.length,
        known: people.length,
        top,
        online: Object.keys(store.open || {}).length,
      },
      summary: {
        playerHours7d: sum(last7, (r) => r.playerHours),
        playerHoursPrev7d: prev7.length ? sum(prev7, (r) => r.playerHours) : null,
        peak7d: last7.length ? Math.max(...last7.map((r) => r.peak)) : null,
        peakEver: store.peak?.n || null,
        peakEverAt: store.peak?.at || null,
        uptime7d: uptimeSpan > 0 ? sum(last7, (r) => r.on) / uptimeSpan : null,
        busiest,
        quietest,
        // Share of observed time with anybody on at all -- the difference
        // between a server used hard for four hours a day and one that idles.
        activeShare: observed > 0 ? active / observed : null,
      },
    };
  }
}

export const _internals = { dayNumber, weekId, dateKey, fromDateKey, emptyBucket, addSample, meanPlayers };
