// The listing judgement is the only logic in the dashboard that can restart a
// server which is running perfectly well, so it is the one piece with tests:
// every guard below corresponds to a way this could reboot a healthy server, or
// fail to stop rebooting a broken one.
//
// judgeListing is pure, which is the entire reason it was split out of
// src/monitor.js -- none of this needs a Steam key, a network, or a server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeListing } from '../src/steamlisting.js';

const cfg = { minChecks: 3, minSpanSeconds: 600 };
const FRESH = { ok: null, listed: null, error: null, ip: null, misses: 0, firstMissAt: null, gaveUp: false };

const MISS = { ok: true, listed: false };   // Steam answered: not in the list
const HIT = { ok: true, listed: true };     // Steam answered: it is there
const FAILED = { ok: false, error: 'Steam did not answer' }; // we could not find out

// Replay a sequence of check results at a given spacing and collect the acts.
function run(results, { online = 0, spacingMs = 300_000 } = {}) {
  let state = { ...FRESH };
  let now = 1_700_000_000_000;
  const acts = [];
  for (const result of results) {
    const out = judgeListing({ state, result, cfg, online, now });
    state = out.state;
    acts.push(out.act);
    now += spacingMs;
  }
  return { acts, state };
}

test('does not act before minChecks misses', () => {
  assert.deepEqual(run([MISS]).acts, ['none']);
  assert.deepEqual(run([MISS, MISS]).acts, ['none', 'none']);
  assert.deepEqual(run([MISS, MISS, MISS]).acts, ['none', 'none', 'restart']);
});

test('does not act on misses bunched into too short a span', () => {
  // Three answers 45s apart say nothing a single answer did not.
  assert.deepEqual(run([MISS, MISS, MISS], { spacingMs: 45_000 }).acts,
    ['none', 'none', 'none']);
  assert.equal(run([MISS, MISS, MISS, MISS], { spacingMs: 200_000 }).acts.at(-1), 'restart');
});

test('a check that failed is never a strike', () => {
  // No API key, a rate limit, a dropped uplink: not knowing is not evidence,
  // and acting on it would reboot a full server because the WiFi blinked.
  assert.deepEqual(run([FAILED, FAILED, FAILED, FAILED]).acts, ['none', 'none', 'none', 'none']);
  assert.equal(run([FAILED, FAILED, FAILED]).state.misses, 0);
  // ...but they do not reset real misses either.
  assert.equal(run([MISS, FAILED, MISS, FAILED, MISS]).acts.at(-1), 'restart');
});

test('any confirmed listing clears the strikes', () => {
  assert.deepEqual(run([MISS, MISS, HIT, MISS, MISS]).acts,
    ['none', 'none', 'clear', 'none', 'none']);
  assert.equal(run([MISS, MISS, HIT]).state.misses, 0);
  assert.equal(run([MISS, MISS, HIT, MISS, MISS, MISS]).acts.at(-1), 'restart');
});

test('players online are proof, whatever Steam says', () => {
  // They are connected, so it is reachable; restarting would evict the very
  // people who disprove the fault.
  assert.deepEqual(run([MISS, MISS, MISS, MISS], { online: 2 }).acts,
    ['clear', 'clear', 'clear', 'clear']);
});

test('an unknown player count is not an empty server', () => {
  assert.deepEqual(run([MISS, MISS, MISS], { online: null }).acts, ['none', 'none', 'none']);
});

test('gaveUp stops further restarts, and a hit lifts it', () => {
  const st = { ...run([MISS, MISS, MISS]).state, gaveUp: true };
  const again = judgeListing({ state: st, result: MISS, cfg, online: 0, now: Date.now() });
  assert.equal(again.act, 'none');
  const back = judgeListing({ state: again.state, result: HIT, cfg, online: 0, now: Date.now() });
  assert.equal(back.state.gaveUp, false);
  assert.equal(back.act, 'clear');
});

test('unverified is announced once, not every five minutes', () => {
  const first = judgeListing({ state: { ...FRESH }, result: FAILED, cfg, online: 0 });
  assert.equal(first.alerts.length, 1);
  const second = judgeListing({ state: first.state, result: FAILED, cfg, online: 0 });
  assert.equal(second.alerts.length, 0);
});
