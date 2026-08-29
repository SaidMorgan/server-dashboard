// Who is banned, and who was kicked or banned recently.
//
// Two halves that deliberately read and write through different channels:
//
//   Reading  - straight off disk. banned-players.json is structured (who, when,
//              by what, why, until) where RCON `banlist` is one line of prose
//              that drops the source and the expiry. It also still answers when
//              the server is down, which is exactly when you want to know why
//              somebody cannot get in.
//
//   Writing  - always over RCON, never by editing those files. A running server
//              holds the ban list in memory and writes it out on change, so a
//              file edited underneath it is silently overwritten on the next
//              ban. `ban` and `pardon` go to the process that owns the list.
//
// The event feed is parsed out of the server log, because nothing else records
// a kick at all: a kick leaves no file behind, only a line.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// A Java username is 3-16 of [A-Za-z0-9_]. The leading dot is Floodgate's
// prefix for a Bedrock player arriving through Geyser (".SomeGamertag"), so a
// pattern that rejects it would refuse to moderate half of a Geyser server.
const NAME_RE = /^\.?[A-Za-z0-9_]{1,16}$/;
const IP_RE = /^[0-9a-fA-F.:]{3,45}$/;

export function validName(name) {
  return NAME_RE.test(String(name || '').trim());
}

export function validIp(ip) {
  return IP_RE.test(String(ip || '').trim());
}

// RCON is a text protocol with no shell behind it, so there is no injection to
// escape -- but a newline would end the command early and a control character
// can corrupt the frame. Reasons are free text, so they get cleaned.
export function cleanReason(reason) {
  return String(reason || '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 200);
}

// Where the server keeps banned-players.json. Explicit config wins; otherwise
// this is derived, because every Minecraft target already has to say where its
// log is and the log lives one level down from the server root.
export function serverDir(target) {
  if (target.serverDir) return target.serverDir;
  const fromLog = target.logFile ? path.dirname(target.logFile) : target.logDir;
  if (fromLog) {
    // ...\JavaMC\logs\latest.log -> ...\JavaMC. Only when the folder is
    // actually called "logs": a server that writes its log into its own root
    // would otherwise be walked one level too far, up into C:\GameServers.
    if (path.basename(fromLog).toLowerCase() === 'logs') return path.dirname(fromLog);
    return fromLog;
  }
  if (target.startCommand) return path.dirname(target.startCommand);
  return null;
}

// Whether this target can be moderated at all: the game profile has to opt in
// (only the Java profile keeps bans in this format) and the files it needs have
// to be somewhere findable. server.properties stands in for the ban files
// themselves, which do not exist until the first ban is issued.
export function managed(target, profile) {
  if (!profile?.moderation) return false;
  const dir = serverDir(target);
  if (!dir) return false;
  return fs.existsSync(path.join(dir, 'server.properties'))
    || fs.existsSync(path.join(dir, 'banned-players.json'));
}

function readJsonArray(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A half-written file during a save, or no file at all because nobody has
    // ever been banned. Neither is an error worth showing.
    return [];
  }
}

// Minecraft writes "2026-08-29 13:31:15 -0700", which Date cannot parse on its
// own. Turned into something sortable here so the UI never has to.
function parseMcDate(text) {
  const m = String(text || '').match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) ([+-]\d{2})(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, oh, om] = m;
  const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}${oh}:${om}`);
  return Number.isNaN(t) ? null : t;
}

export function readBans(target) {
  const dir = serverDir(target);
  if (!dir) return { ok: false, error: 'cannot locate the server folder', players: [], ips: [] };

  const players = readJsonArray(path.join(dir, 'banned-players.json')).map((b) => ({
    name: b.name ?? null,
    uuid: b.uuid ?? null,
    created: parseMcDate(b.created),
    createdText: b.created ?? null,
    source: b.source ?? null,
    // Minecraft writes the string "forever" rather than omitting the field.
    expires: b.expires && b.expires !== 'forever' ? b.expires : null,
    reason: b.reason ?? null,
  }));

  const ips = readJsonArray(path.join(dir, 'banned-ips.json')).map((b) => ({
    ip: b.ip ?? null,
    created: parseMcDate(b.created),
    createdText: b.created ?? null,
    source: b.source ?? null,
    expires: b.expires && b.expires !== 'forever' ? b.expires : null,
    reason: b.reason ?? null,
  }));

  // Newest ban first: the one you are most likely to be here to lift.
  const byNewest = (a, b) => (b.created ?? 0) - (a.created ?? 0);
  players.sort(byNewest);
  ips.sort(byNewest);

  return { ok: true, dir, players, ips };
}

// --- the event feed --------------------------------------------------------
//
// A ban leaves a row in banned-players.json; a kick leaves nothing but a line
// in the log, and a pardon leaves an absence. So "what happened recently" can
// only be reconstructed by reading the log.
//
// The one real trap is that a player can *say* any of this in chat. This is not
// hypothetical: a real log line read `<player> Was Banned For Spamming`, typed
// moments after that player was unbanned, and a naive parser files it as an
// event. Chat is therefore discarded before any pattern is tried, rather than
// being pattern-matched around. Paper writes chat as `<name> text`, optionally
// behind a `[Not Secure] ` marker.

const LINE_RE = /^\[(\d{2}):(\d{2}):(\d{2})\] \[([^\]]*)\]: (.*)$/;
const CHAT_RE = /^(?:\[Not Secure\] )?</;

// Order matters: "Banned IP 1.2.3.4: x" has to be tried before "Banned x: y",
// or the IP ban is filed as a player named "IP".
const PATTERNS = [
  { re: /^\[GriefPrevention\] Banning (\S+) for spam\.$/,
    kind: 'ban', source: 'GriefPrevention anti-spam', reason: 'spam' },
  { re: /^\[GriefPrevention\] Kicking (\S+) for spam\.$/,
    kind: 'kick', source: 'GriefPrevention anti-spam', reason: 'spam' },
  { re: /^Banned IP (\S+?): (.*)$/, kind: 'ban', target: 'ip', source: 'admin' },
  { re: /^Unbanned IP (\S+)$/, kind: 'pardon', target: 'ip', source: 'admin' },
  { re: /^Banned (\S+?): (.*)$/, kind: 'ban', source: 'admin' },
  { re: /^Unbanned (\S+)$/, kind: 'pardon', source: 'admin' },
  { re: /^Kicked (\S+?) from the game: (.*)$/, kind: 'kick', source: 'admin' },
  // Somebody already banned trying the door again. Worth showing: it is the
  // difference between "they were banned" and "they are still trying to play".
  { re: /^Disconnecting (\S+) \(\/[^)]*\): You are banned from this server\.$/,
    kind: 'blocked', source: 'server', reason: 'ban still in force' },
];

// `lost connection: Banned for spam.` is the same event as the `Banning` line
// one millisecond earlier, seen from the networking side. Listing both would
// double every ban in the feed, so the disconnect side is dropped.

function classify(body) {
  for (const p of PATTERNS) {
    const m = body.match(p.re);
    if (!m) continue;
    return {
      kind: p.kind,
      who: m[1],
      target: p.target ?? 'player',
      source: p.source,
      reason: p.reason ?? (m[2] ? m[2].replace(/\.$/, '') : null),
    };
  }
  return null;
}

// Paper stamps lines with a time but no date -- the date is in the file name
// for a rotated log, and is only implied for latest.log. Scanning backwards
// makes crossing midnight detectable: within one file time only ever decreases
// as you walk up it, so an increase means the previous day.
function parseLogLines(lines, endDate) {
  const out = [];
  let dayOffset = 0;
  let prev = Infinity;

  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(LINE_RE);
    if (!m) continue;
    const [, hh, mm, ss, , body] = m;

    const secs = Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
    if (secs > prev) dayOffset++;
    prev = secs;

    if (CHAT_RE.test(body)) continue;
    const hit = classify(body);
    if (!hit) continue;

    const at = new Date(endDate);
    at.setDate(at.getDate() - dayOffset);
    at.setHours(Number(hh), Number(mm), Number(ss), 0);

    out.push({ at: at.getTime(), ...hit });
  }

  return out; // newest first, because the walk was backwards
}

// Parsing the same unchanged file on every open of the panel is wasteful: these
// logs only grow at the end and a rotated one never changes at all.
const cache = new Map();

function eventsFromFile(file, gzipped, endDate) {
  let stat;
  try { stat = fs.statSync(file); } catch { return []; }

  const key = `${file}:${stat.size}:${stat.mtimeMs}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let text;
  try {
    const raw = fs.readFileSync(file);
    text = (gzipped ? zlib.gunzipSync(raw) : raw).toString('utf8');
  } catch {
    return [];
  }

  const events = parseLogLines(text.split(/\r?\n/), endDate);

  // One entry per file, and the old size/mtime keys for a growing latest.log
  // are dead the moment it grows, so the map is swept rather than grown.
  for (const k of cache.keys()) if (k.startsWith(`${file}:`)) cache.delete(k);
  cache.set(key, events);
  return events;
}

const ROTATED_RE = /^(\d{4})-(\d{2})-(\d{2})-\d+\.log\.gz$/;

// Repeated identical events -- four "still banned" bounces while somebody
// retries the connect button -- are one thing that happened, not four.
function collapse(events, windowMs = 10 * 60 * 1000) {
  const out = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (last && last.kind === e.kind && last.who === e.who
        && Math.abs(last.at - e.at) <= windowMs) {
      last.repeats = (last.repeats ?? 1) + 1;
      // Keep the earliest time of the run, so the row reads as when it started.
      last.at = Math.min(last.at, e.at);
      continue;
    }
    out.push({ ...e });
  }
  return out;
}

// --- what the dashboard did itself ------------------------------------------
//
// A ban sent over RCON does not appear in the server log at all. The server
// logs that an RCON client connected and nothing about what it asked for, so a
// ban issued from this panel would be the one kind of ban the feed could not
// show -- which is precisely the kind you would come here to look up.
//
// So the dashboard keeps its own line for the actions it takes. This is only
// ever additive: in-game and plugin actions still come from the log, and
// nothing here is recorded twice because the log never had these to begin with.

function auditFile(dataDir, targetId) {
  return path.join(dataDir, `moderation-${targetId}.jsonl`);
}

export function record(dataDir, targetId, event) {
  if (!dataDir) return;
  try {
    fs.appendFileSync(auditFile(dataDir, targetId), `${JSON.stringify({ at: Date.now(), ...event })}\n`);
  } catch {
    // An audit line that cannot be written must not fail the ban that was
    // already carried out -- the ban is the thing that mattered.
  }
}

function readAudit(dataDir, targetId, cutoff) {
  if (!dataDir) return [];
  try {
    return fs.readFileSync(auditFile(dataDir, targetId), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((e) => e && e.at >= cutoff);
  } catch {
    return []; // nothing issued from here yet
  }
}

export function readEvents(target, { limit = 100, days = 7, dataDir = null, targetId = null } = {}) {
  const live = target.logFile
    || (target.logDir ? path.join(target.logDir, 'latest.log') : null);
  const dir = target.logDir || (target.logFile ? path.dirname(target.logFile) : null);
  if (!dir) return { ok: false, error: 'no log configured', events: [] };

  const events = [];
  const cutoff = Date.now() - days * 86_400_000;

  if (live && fs.existsSync(live)) {
    events.push(...eventsFromFile(live, false, new Date(fs.statSync(live).mtimeMs)));
  }

  // Rotated logs carry their own date in the file name, which is both more
  // reliable than mtime and free to sort on.
  //
  // Chosen by that date rather than by taking the newest N files: a server that
  // restarts often rotates many times a day -- this one has written seven files
  // in a single day -- so any count-based window silently covers a fraction of
  // the days it claims to. The hard cap only exists so an enormous log folder
  // cannot turn one panel open into thousands of file reads.
  let rotated = [];
  try {
    rotated = fs.readdirSync(dir)
      .map((f) => ({ f, m: f.match(ROTATED_RE) }))
      .filter((x) => x.m)
      // Noon, not midnight: the date only labels the day, and a midnight anchor
      // would land the walk-back on the wrong side of it.
      .map((x) => ({ ...x, day: new Date(Number(x.m[1]), Number(x.m[2]) - 1, Number(x.m[3]), 12, 0, 0, 0) }))
      // A whole day of slack, so the day the cutoff falls inside is still read.
      .filter((x) => x.day.getTime() >= cutoff - 86_400_000)
      .sort((a, b) => b.f.localeCompare(a.f))
      .slice(0, 200);
  } catch { /* no log dir to read */ }

  for (const { f, day } of rotated) {
    events.push(...eventsFromFile(path.join(dir, f), true, day));
  }

  // Actions taken from this dashboard, which the server log never saw.
  events.push(...readAudit(dataDir, targetId ?? target.id, cutoff));

  events.sort((a, b) => b.at - a.at);
  return { ok: true, events: collapse(events.filter((e) => e.at >= cutoff)).slice(0, limit) };
}
