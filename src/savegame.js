// What the world on disk says about itself, and when it was last written.
//
// Some games publish nothing about the world they are running -- not over a
// query, not in a log banner -- but write it all into the save file anyway.
// Icarus is the case this was built for: its prospect file opens with a plain
// `ProspectInfo` object naming the prospect, the map, the difficulty, how long
// it has been running and who is on the roster, none of which reaches the card
// by any other route.
//
// The file's mtime matters as much as its contents. Stop and Restart on a game
// with no remote interface are a process kill, made safe only by the game's own
// save-on-exit; the age of this file is the single piece of evidence an admin
// has that pressing Restart will not cost an evening's play. A card that shows
// "saved 3 minutes ago" turns that button from a gamble into a decision.
//
// A profile opts in by declaring `saveInfo`. Nothing here knows about any
// particular game: the profile says where to look and how to read the head of
// the file, and gets back the parse plus the timestamps.
import fs from 'node:fs';
import path from 'node:path';

// Save files are large -- an Icarus prospect is ~220 KB, almost all of it one
// base64 blob of serialised actors -- and the interesting part is a header. So
// read a window off the front rather than the whole file, and never JSON.parse
// the blob. The profile can raise this if its header is bigger.
const DEFAULT_HEAD_BYTES = 16 * 1024;

// Pick the save the server is actually writing: the most recently modified file
// in the folder that matches, ignoring the rolling `.backup_3` copies the game
// keeps beside it. A server can hold several worlds on disk and only one of
// them is live, and the live one is by definition the one being saved.
function newestSave(dir, match) {
  let best = null;
  for (const name of fs.readdirSync(dir)) {
    if (!match.test(name)) continue;
    const full = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue; // vanished between readdir and stat -- a backup being rotated
    }
    if (!stat.isFile()) continue;
    if (!best || stat.mtimeMs > best.stat.mtimeMs) best = { name, full, stat };
  }
  return best;
}

// One reader per target, so a file that has not changed is not re-parsed sixty
// times a minute. mtime *and* size, because a save that rewrites the same number
// of bytes within a filesystem timestamp tick is not impossible, and the cost of
// being wrong is a stale prospect on the card.
export class SaveReader {
  constructor(spec) {
    this.spec = spec;
    this.cache = null; // {key, parsed}
  }

  // Returns { file, savedAt, ageSeconds, ...whatever the profile parsed } or
  // null when there is no save yet -- which is a real state, not an error:
  // Icarus does not create PlayerData until a prospect has been launched.
  read(installDir) {
    const { dir, match = /\.json$/i, headBytes = DEFAULT_HEAD_BYTES, parse } = this.spec;
    const folder = path.resolve(installDir, dir);

    let found;
    try {
      found = newestSave(folder, match);
    } catch {
      return null; // no PlayerData folder yet: no prospect has ever been run
    }
    if (!found) return null;

    const key = `${found.full}:${found.stat.mtimeMs}:${found.stat.size}`;
    const savedAt = new Date(found.stat.mtimeMs).toISOString();
    // The age is recomputed every call even when the parse is cached -- it is
    // the whole point of this and it changes every second.
    const withTimes = (parsed) => (parsed && {
      ...parsed,
      file: found.name,
      savedAt,
      ageSeconds: Math.max(0, Math.round((Date.now() - found.stat.mtimeMs) / 1000)),
    });

    if (this.cache?.key === key) return withTimes(this.cache.parsed);

    let head;
    try {
      const span = Math.min(headBytes, found.stat.size);
      const fd = fs.openSync(found.full, 'r');
      const buf = Buffer.alloc(span);
      fs.readSync(fd, buf, 0, span, 0);
      fs.closeSync(fd);
      head = buf.toString('utf8');
    } catch {
      // Being mid-write is the common case here, not a broken save. Keep the
      // last good parse rather than blanking the card for one poll.
      return this.cache ? withTimes(this.cache.parsed) : null;
    }

    let parsed = null;
    try {
      parsed = parse(head) ?? null;
    } catch {
      parsed = null;
    }
    // A failed parse is still cached against this key, so a save file whose
    // format has moved on is read once rather than on every poll forever.
    this.cache = { key, parsed };
    return withTimes(parsed);
  }
}

// Pull one balanced {...} object out of a larger JSON document by name, without
// parsing the rest of it. This is what makes reading a 220 KB save cheap: the
// header sits at the front, the payload behind it is a single enormous string,
// and JSON has no way to ask for the first key only.
//
// Returns null rather than throwing when the object is not fully inside the
// window it was given -- the caller read a fixed number of bytes and cannot know
// in advance whether that was enough.
export function sliceJsonObject(text, key) {
  const at = text.indexOf(`"${key}"`);
  if (at < 0) return null;
  const open = text.indexOf('{', at);
  if (open < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(open, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null; // truncated by the read window
}
