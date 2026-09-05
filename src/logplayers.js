// Who is online, reconstructed from a server's own log file.
//
// The fourth way to read a running game, after RCON, REST and the Steam query
// (src/a2s.js) -- and the only one left for a game that has none of the three.
// Icarus is exactly that server: no console to ask, and its A2S_PLAYER reply
// carries the right *number* of entries with an empty string in every name
// field, so the card can say "2 online" and never who. Its log, meanwhile, says
// it plainly:
//
//   LogConnectedPlayers: Display: AddConnectedPlayer - UserId: 7656... | PlayerName: Someone
//   LogConnectedPlayers: Display: RemoveConnectedPlayer - UserId: 7656...
//
// So the roster is those two lines replayed in order. This is a derived answer
// rather than a measured one, which is worth being honest about: it is only as
// good as the log, and the caller is expected to keep the query's count as the
// authority on *how many* -- see reconcile() at the bottom.
//
// A profile opts in by declaring `playersFromLog`; nothing here is Icarus-
// specific, so any game whose log announces joins and leaves can use it.
import fs from 'node:fs';

// Read at most this much on the first pass over a log. Every pass after the
// first reads only what was appended, so this ceiling is paid once per run --
// which is why it is generous rather than tight. Cutting it fine would be a
// false economy: the cost of starting too late in the file is missing somebody's
// join line and then showing them as offline for the rest of the session.
const FIRST_PASS_MAX = 32 * 1024 * 1024;

// A line still being written when we read is normal -- the engine flushes
// mid-line -- so an unterminated tail is carried into the next pass rather than
// parsed. This bounds how much of it we are willing to hold.
const MAX_CARRY = 64 * 1024;

// One reader per target. Keyed on the process start time as well as the file
// size, because Icarus rotates its log on every start: a new run means a new
// file, an empty roster, and no memory of who was on before the restart.
export class LogRoster {
  constructor(spec) {
    this.spec = spec;
    this.startedAt = undefined;
    this.offset = 0;
    this.carry = '';
    this.players = new Map(); // id -> name, in join order
  }

  #reset(startedAt) {
    this.startedAt = startedAt;
    this.offset = 0;
    this.carry = '';
    this.players = new Map();
  }

  // Returns [{name, id}] in join order, or null if the log could not be read at
  // all -- which is different from "nobody is on" and must not be shown as an
  // empty server.
  read(logFile, startedAt) {
    if (startedAt !== this.startedAt) this.#reset(startedAt);

    let size;
    try {
      size = fs.statSync(logFile).size;
    } catch {
      return null;
    }

    // The file got shorter: it was rotated or truncated under us, so whatever
    // offset we were holding points into a different file. Start again.
    if (size < this.offset) this.#reset(startedAt);

    if (size > this.offset) {
      const from = this.offset === 0 ? Math.max(0, size - FIRST_PASS_MAX) : this.offset;
      const span = size - from;
      let text;
      try {
        const fd = fs.openSync(logFile, 'r');
        const buf = Buffer.alloc(span);
        fs.readSync(fd, buf, 0, span, from);
        fs.closeSync(fd);
        text = buf.toString('utf8');
      } catch {
        return this.#snapshot();
      }
      this.offset = size;
      this.#consume(this.carry + text);
    }

    return this.#snapshot();
  }

  #consume(text) {
    const lines = text.split(/\r?\n/);
    // The last element is whatever followed the final newline: either an empty
    // string, or half a line the engine has not finished writing.
    this.carry = lines.pop() ?? '';
    if (this.carry.length > MAX_CARRY) this.carry = '';

    const { join, leave, idGroup = 1, nameGroup = 2 } = this.spec;
    for (const line of lines) {
      const j = join.exec(line);
      if (j) {
        const id = j[idGroup];
        const name = (j[nameGroup] ?? '').trim();
        if (id) {
          // A rejoin must not move an existing player to the end of the list,
          // and must not lose a name we already had to a line that omits it.
          this.players.set(id, name || this.players.get(id) || id);
        }
        continue;
      }
      const l = leave.exec(line);
      if (l && l[idGroup]) this.players.delete(l[idGroup]);
    }
  }

  #snapshot() {
    return [...this.players].map(([id, name]) => ({ name, id }));
  }
}

// The log is a narrative and the query is a measurement, so when they disagree
// the query wins on the count. A dropped connection that never logged its
// Remove line would otherwise leave a ghost on the card until the next restart
// -- permanently, silently, and in the one place an admin looks to decide
// whether it is safe to reboot.
//
// count === null means the query itself failed, and then the log is all there
// is. Otherwise:
//   - counts agree            -> show the names
//   - query says 0            -> show nobody, whatever the log thinks
//   - counts differ           -> keep the names but mark them approximate, so
//                                the card can say so instead of quietly lying
export function reconcile(names, count) {
  if (!names) return { players: null, approximate: false };
  if (count == null) return { players: names, approximate: false };
  if (count === 0) return { players: [], approximate: false };
  return { players: names, approximate: names.length !== count };
}
