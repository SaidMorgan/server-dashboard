// Reconstructing a roster from a log is guesswork dressed as a fact, so the
// cases that matter are the ones where it could be quietly wrong: a duplicate
// join line inventing a player, a line read half-written, a rotated log carrying
// yesterday's names into today's run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LogRoster, reconcile } from '../src/logplayers.js';
import icarus from '../src/games/icarus.js';

const spec = icarus.playersFromLog;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-'));
const file = path.join(dir, 'server.log');
const names = (rows) => (rows || []).map((p) => p.name);

const add = (id, n) => `[2026.09.03-11.00.00:000][100]LogConnectedPlayers: Display: AddConnectedPlayer - UserId: ${id} | PlayerName: ${n}\n`;
const rem = (id) => `[2026.09.03-11.00.00:000][100]LogConnectedPlayers: Display: RemoveConnectedPlayer - UserId: ${id}\n`;
// The lines Icarus also prints for a join, which must not be counted.
const noise = `[2026.09.03-11.00.00:000][100]LogConnectedPlayers: Display: ServerTryCompletePlayerInitialisation - PlayerCharacterID: 1_4 | PlayerName: CHEESE\n`
  + `[2026.09.03-11.00.00:000][100]LogConnectedPlayers: Display: FinaliseConnectedPlayerInitialisation - PlayerName: CHEESE\n`;

test('joins and leaves', () => {
  fs.writeFileSync(file, add('1', 'CHEESE') + noise + add('2', 'KJOMD') + rem('1'));
  const r = new LogRoster(spec);
  assert.deepEqual(names(r.read(file, 'run1')), ['KJOMD']);

  // The next poll reads only what was appended.
  fs.appendFileSync(file, add('3', 'Third'));
  assert.deepEqual(names(r.read(file, 'run1')), ['KJOMD', 'Third']);

  // The initialisation chatter must not invent anyone.
  fs.appendFileSync(file, noise + noise);
  assert.deepEqual(names(r.read(file, 'run1')), ['KJOMD', 'Third']);

  // A rejoin is not a second player, and does not reorder the list.
  fs.appendFileSync(file, add('2', 'KJOMD'));
  assert.deepEqual(names(r.read(file, 'run1')), ['KJOMD', 'Third']);
});

test('a line still being written is not parsed until it is complete', () => {
  fs.writeFileSync(file, add('1', 'CHEESE'));
  const r = new LogRoster(spec);
  r.read(file, 'run2');
  fs.appendFileSync(file, '[2026.09.03-11.00.00:000][100]LogConnectedPlayers: Display: AddConnectedPlayer - UserId: 9 | PlayerNa');
  assert.deepEqual(names(r.read(file, 'run2')), ['CHEESE']);
  fs.appendFileSync(file, 'me: Late\n');
  assert.deepEqual(names(r.read(file, 'run2')), ['CHEESE', 'Late']);
});

test('a rotated log starts a fresh roster', () => {
  fs.writeFileSync(file, add('1', 'CHEESE') + add('2', 'KJOMD'));
  const r = new LogRoster(spec);
  r.read(file, 'runA');
  // Same path, shorter file, new process start: everyone was disconnected.
  fs.writeFileSync(file, add('7', 'AfterRestart'));
  assert.deepEqual(names(r.read(file, 'runB')), ['AfterRestart']);
});

test('a missing log is null, which is not the same as nobody online', () => {
  assert.equal(new LogRoster(spec).read(path.join(dir, 'nope.log'), 'run'), null);
});

test('the measured count wins over the narrated one', () => {
  const two = [{ name: 'A', id: '1' }, { name: 'B', id: '2' }];
  // No count to check against: show what the log said.
  assert.deepEqual(reconcile(two, null), { players: two, approximate: false });
  // The query says the server is empty: it is empty, whatever the log missed.
  assert.deepEqual(reconcile(two, 0), { players: [], approximate: false });
  assert.deepEqual(reconcile(two, 2), { players: two, approximate: false });
  // They disagree: keep the names, but mark them so the card can say so.
  assert.deepEqual(reconcile(two, 1), { players: two, approximate: true });
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
