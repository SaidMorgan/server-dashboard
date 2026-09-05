// The arithmetic in src/usage.js is the kind that is wrong for weeks without
// looking wrong: an average that quietly includes today in the baseline today
// is being compared against, a restart gap credited as eight hours of players,
// a partial hour averaged as though it were a whole one. None of those show up
// as an error, they show up as a chart that is subtly a lie, so they are pinned
// here rather than eyeballed on the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageStats } from '../src/usage.js';

const config = {
  pollSeconds: 10,
  targets: [
    { id: 'game', kind: 'game' },
    { id: 'svc', kind: 'service' },
  ],
};

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));
  return new UsageStats(config, dir);
}

/** Local-time Date, so the test agrees with the store about which hour it is. */
function at(daysAgo, hour, minute = 0, ref = new Date()) {
  const d = new Date(ref);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

/** Feed a whole hour of ten-second polls at a steady player count. */
function fillHour(usage, whenMs, players, { up = true } = {}) {
  for (let s = 0; s < 3600; s += 10) {
    usage.record([{ id: 'game', up, playerCount: players }], whenMs + s * 1000);
  }
}

test('an hour at a steady player count averages to that count', () => {
  const usage = fresh();
  const now = at(7, 20);
  fillHour(usage, now, 4);
  const r = usage.report('game', at(0, 20, 30));
  const slot = r.day[20];
  assert.equal(Math.round(slot.typical), 4);
  assert.equal(slot.typicalPeak, 4);
  assert.equal(slot.weeks, 1);
});

test('the week in progress is never part of its own baseline', () => {
  const usage = fresh();
  for (const back of [28, 21, 14, 7]) fillHour(usage, at(back, 20), 2);
  fillHour(usage, at(0, 20), 8);

  const r = usage.report('game', at(0, 20, 59));
  const slot = r.day[20];
  assert.equal(Math.round(slot.typical), 2, 'typical must come from completed weeks only');
  assert.equal(Math.round(slot.actual), 8, 'today is the overlay, not the baseline');
  assert.equal(slot.weeks, 4);
});

test('a server that is down counts as nobody playing, not as no reading', () => {
  const usage = fresh();
  fillHour(usage, at(7, 3), 0, { up: false });
  const r = usage.report('game', at(0, 3, 30));
  assert.equal(r.day[3].typical, 0);
  // ...and it is visible as downtime, not hidden inside the average.
  const day = r.recent.find((x) => x.age === 7);
  assert.ok(day.n > 0 && day.on === 0, 'observed the hour, and it was down for all of it');
});

test('a server that is up but unreadable is not averaged in as empty', () => {
  const usage = fresh();
  const now = at(7, 5);
  // Half an hour of four players, then half an hour where RCON stops answering.
  for (let s = 0; s < 1800; s += 10) usage.record([{ id: 'game', up: true, playerCount: 4 }], now + s * 1000);
  for (let s = 1800; s < 3600; s += 10) usage.record([{ id: 'game', up: true, playerCount: null }], now + s * 1000);

  const r = usage.report('game', at(0, 5, 30));
  assert.equal(Math.round(r.day[5].typical), 4, 'unknown minutes must not drag the average toward zero');
});

test('a dashboard restart is a gap, not eight hours of players', () => {
  const usage = fresh();
  const start = at(7, 1);
  usage.record([{ id: 'game', up: true, playerCount: 5 }], start);
  // Eight hours later the process comes back with five people still on.
  usage.record([{ id: 'game', up: true, playerCount: 5 }], start + 8 * 3600_000);

  const r = usage.report('game', at(0, 1, 30));
  const played = r.recent.reduce((a, x) => a + x.playerHours, 0);
  assert.ok(played < 0.05, `gap credited as ${played}h of play`);
});

test('daily totals come out as player-hours', () => {
  const usage = fresh();
  fillHour(usage, at(3, 19), 3); // three players for one hour
  const r = usage.report('game', at(0, 12));
  const day = r.recent.find((x) => x.age === 3);
  assert.ok(Math.abs(day.playerHours - 3) < 0.02, `${day.playerHours} should be ~3 player-hours`);
  assert.ok(Math.abs(r.summary.playerHours7d - 3) < 0.02);
});

test('services are skipped, and asking about one is not an error', () => {
  const usage = fresh();
  usage.record([{ id: 'svc', up: true, playerCount: null }], Date.now());
  const r = usage.report('svc');
  assert.equal(r.ok, true);
  assert.equal(r.learning, true);
  assert.deepEqual(r.day, []);
});

test('the busiest and quietest slots are the ones actually seen', () => {
  const usage = fresh();
  fillHour(usage, at(7, 20), 6);
  fillHour(usage, at(7, 4), 0);
  const r = usage.report('game', at(0, 12));
  assert.equal(r.summary.busiest.hour, 20);
  assert.equal(r.summary.quietest.hour, 4);
});

test('state survives a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));
  const first = new UsageStats(config, dir);
  fillHour(first, at(7, 21), 5);
  first.flush(Date.now(), { sync: true });

  const second = new UsageStats(config, dir);
  const r = second.report('game', at(0, 21, 10));
  assert.equal(Math.round(r.day[21].typical), 5);
});

// --- sessions, people and the punch card ------------------------------------

/** Feed a stretch of polls with a fixed set of names online.
 *
 * The step must match config.pollSeconds. Polling slower than the configured
 * interval is, correctly, treated as a gap and credited one interval -- so a
 * test that steps at 60s against a 10s config measures the clamp, not the
 * session. */
function play(usage, whenMs, seconds, names, { step = 10 } = {}) {
  for (let s = 0; s < seconds; s += step) {
    usage.record([{
      id: 'game',
      up: true,
      playerCount: names.length,
      players: names.map((n) => ({ name: n, id: n })),
    }], whenMs + s * 1000);
  }
  // One more poll with them gone, so the session closes rather than staying open.
  usage.record([{ id: 'game', up: true, playerCount: 0, players: [] }], whenMs + seconds * 1000);
}

test('a session is measured, and its length survives a poll gap', () => {
  const usage = fresh();
  const start = at(2, 18);
  play(usage, start, 3600, ['ada']);
  const r = usage.report('game', at(0, 12));
  assert.equal(r.people.sessions7d, 1);
  assert.ok(Math.abs(r.people.avgSession - 3600) < 120, `${r.people.avgSession}s should be ~1h`);
  assert.equal(r.people.unique7d, 1);
});

test('a blink offline does not chop one evening into several sessions', () => {
  const usage = fresh();
  const start = at(2, 18);
  const online = [{ name: 'ada', id: 'ada' }];
  for (let s = 0; s < 1800; s += 10) usage.record([{ id: 'game', up: true, playerCount: 1, players: online }], start + s * 1000);
  // The query fails for a few polls: a count, but no readable list.
  for (let s = 1800; s < 1830; s += 10) usage.record([{ id: 'game', up: true, playerCount: 1, players: null }], start + s * 1000);
  for (let s = 1830; s < 3600; s += 10) usage.record([{ id: 'game', up: true, playerCount: 1, players: online }], start + s * 1000);
  usage.record([{ id: 'game', up: true, playerCount: 0, players: [] }], start + 3600 * 1000);

  const r = usage.report('game', at(0, 12));
  assert.equal(r.people.sessions7d, 1, 'an unreadable roster must not end anyone session');
});

test('a bounce is not a session', () => {
  const usage = fresh();
  const start = at(2, 18);
  play(usage, start, 30, ['driveby']);
  const r = usage.report('game', at(0, 12));
  assert.equal(r.people.sessions7d, 0, 'a 30-second connect is not a visit');
});

test('playtime is per person, and the leaderboard is ordered by it', () => {
  const usage = fresh();
  play(usage, at(2, 14), 7200, ['ada']);
  play(usage, at(2, 17), 1800, ['bob']);
  const r = usage.report('game', at(0, 12));
  assert.deepEqual(r.people.top.map((t) => t.name), ['ada', 'bob']);
  assert.ok(Math.abs(r.people.top[0].seconds - 7200) < 200);
  assert.equal(r.people.unique7d, 2);
});

test('a session still running counts as playtime but not as an average', () => {
  const usage = fresh();
  const now = at(0, 12);
  const online = [{ name: 'ada', id: 'ada' }];
  for (let s = 0; s < 1800; s += 10) usage.record([{ id: 'game', up: true, playerCount: 1, players: online }], now - 1800_000 + s * 1000);

  const r = usage.report('game', now);
  assert.equal(r.people.online, 1);
  assert.equal(r.people.sessions7d, 0, 'nothing has finished yet');
  assert.equal(r.people.avgSession, null, 'an unfinished session cannot set the average');
  assert.ok(r.people.top[0].seconds > 1500, 'but it does count as time played');
  assert.equal(r.people.top[0].online, true);
});

test('newcomers and regulars are told apart', () => {
  const usage = fresh();
  play(usage, at(20, 19), 3600, ['oldtimer']);  // first seen three weeks ago
  play(usage, at(2, 19), 3600, ['oldtimer']);   // ...and back this week
  play(usage, at(1, 19), 3600, ['brandnew']);   // first seen yesterday

  const r = usage.report('game', at(0, 12));
  assert.equal(r.people.unique7d, 2);
  assert.equal(r.people.newcomers7d, 1);
  assert.equal(r.people.regulars7d, 1);
});

test('retention stays quiet until the cohort is big enough to mean something', () => {
  const usage = fresh();
  play(usage, at(14, 19), 3600, ['a', 'b']);
  let r = usage.report('game', at(0, 12));
  assert.equal(r.people.retention, null, 'two people cannot produce a percentage');

  const usage2 = fresh();
  play(usage2, at(14, 19), 3600, ['a', 'b', 'c', 'd']);
  play(usage2, at(1, 19), 3600, ['a', 'b', 'c']); // three of the four came back
  r = usage2.report('game', at(0, 12));
  assert.equal(r.people.retentionCohort, 4);
  assert.ok(Math.abs(r.people.retention - 0.75) < 0.01);
});

test('the all-time peak is kept with the moment it happened', () => {
  const usage = fresh();
  const when = at(9, 20);
  usage.record([{ id: 'game', up: true, playerCount: 7 }], when);
  usage.record([{ id: 'game', up: true, playerCount: 2 }], at(1, 20));
  const r = usage.report('game', at(0, 12));
  assert.equal(r.summary.peakEver, 7);
  assert.equal(r.summary.peakEverAt, when);
});

test('the punch card is 7 by 24 and lines up with the busy chart', () => {
  const usage = fresh();
  fillHour(usage, at(7, 20), 6);
  const r = usage.report('game', at(0, 20, 30));
  assert.equal(r.heatmap.length, 7);
  assert.ok(r.heatmap.every((row) => row.length === 24));
  const d = new Date(at(7, 20)).getDay();
  assert.equal(Math.round(r.heatmap[d][20].avg), 6);
  assert.equal(r.hottest, 6);
});

test('a game that reports counts but no names says so', () => {
  const usage = fresh();
  fillHour(usage, at(2, 20), 3);
  const r = usage.report('game', at(0, 12));
  assert.equal(r.hasNames, false);
  assert.equal(r.people, null, 'better an absent panel than an empty one that looks broken');
});

test('sessions older than the retention window are dropped', () => {
  const usage = fresh();
  play(usage, at(40, 19), 3600, ['ancient']);
  play(usage, at(1, 19), 3600, ['recent']);
  const r = usage.report('game', at(0, 12));
  assert.equal(r.people.unique30d, 1, 'the 40-day-old session should be gone');
});

test('somebody who stopped playing months ago is eventually forgotten', () => {
  const usage = fresh();
  play(usage, at(200, 19), 3600, ['longgone']);
  play(usage, at(1, 19), 3600, ['stillhere']);
  const store = usage.data.targets.game;
  assert.ok(!store.people.longgone, 'a player unseen for 200 days should be dropped');
  assert.ok(store.people.stillhere);
});

test('a player who is online right now is never evicted', () => {
  const usage = fresh();
  // On since long before the retention window, and still on.
  const online = [{ name: 'marathon', id: 'marathon' }];
  const start = at(200, 12);
  for (let s = 0; s < 600; s += 10) usage.record([{ id: 'game', up: true, playerCount: 1, players: online }], start + s * 1000);
  // ...and the clock rolls forward past the cutoff while they stay connected.
  usage.record([{ id: 'game', up: true, playerCount: 1, players: online }], at(0, 12));
  assert.ok(usage.data.targets.game.people.marathon, 'their session is still accumulating');
});

test('the roll is capped at a hundred, and it is the drive-by visitors that go', () => {
  const usage = fresh();
  const when = at(2, 12);
  // 120 people: 20 regulars with an hour each, 100 who looked in for ten minutes.
  const regulars = Array.from({ length: 20 }, (_, i) => `regular${i}`);
  const tourists = Array.from({ length: 100 }, (_, i) => `tourist${i}`);
  play(usage, when, 3600, regulars);
  play(usage, when + 4 * 3600_000, 600, tourists);

  const people = usage.data.targets.game.people;
  assert.equal(Object.keys(people).length, 100, 'the store is bounded');
  for (const r of regulars) assert.ok(people[r], `${r} played the most and must survive`);
  const keptTourists = tourists.filter((t) => people[t]).length;
  assert.equal(keptTourists, 80, 'the rest of the room is the short visits');
});
