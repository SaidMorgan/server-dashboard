// Reading a Bukkit/Paper plugin's own description of itself, out of the jar.
//
// A Minecraft plugin has no folder, no manifest beside it and no Steam item
// behind it -- a plugin IS one jar file, and everything worth putting on a card
// (its real name, its version, who wrote it, which Minecraft API it was built
// against, what it needs loaded first) lives in a plugin.yml *inside* that jar.
// The filename is not a substitute: two of the jars on this box are called
// "Geyser-Spigot.jar" and "floodgate-spigot.jar" and carry no version at all,
// while others carry a version that stopped being true the moment somebody
// dropped in a newer build without renaming it.
//
// So this opens the zip. Deliberately without a dependency: the project ships
// express and nothing else, a jar is a zip, and node has inflate built in. It is
// also deliberately not a general zip library -- it seeks one small named entry
// and gives up quietly on anything it does not understand, because the worst
// outcome allowed here is a plugin listed with fewer details, never a panel that
// fails to load.
import fs from 'node:fs';
import zlib from 'node:zlib';

// Paper reads whichever of these it finds -- paper-plugin.yml first, for plugins
// written against the newer loader. A jar can legitimately contain both, and the
// Paper one wins there too.
const MANIFESTS = ['paper-plugin.yml', 'plugin.yml'];

// The end-of-central-directory record sits at the very end of a zip, after a
// comment that is almost always empty and can be at most 64 KB. Reading that
// tail is what makes this cheap: Geyser-Spigot.jar is tens of megabytes and
// this touches a few kilobytes of it.
const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_TAIL = 66 * 1024;

// A plugin.yml is a text file, and a malformed or enormous one is a reason to
// stop reading rather than to allocate.
const MAX_MANIFEST = 512 * 1024;

function findEocd(buf) {
  // Scan backwards: the signature can also occur inside the comment, and the
  // last plausible one is the real record.
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

// The bytes of one named entry, or null. Two seeks: the central directory says
// where the entry lives, the local header says where its data starts.
function readEntry(fd, size, names) {
  const tailLen = Math.min(MAX_TAIL, size);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);

  const eocd = findEocd(tail);
  if (eocd === -1) return null;

  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  // 0xffffffff is the zip64 escape. A plugin jar that needs zip64 is not a
  // thing that happens, and guessing at one would be worse than not reading it.
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) return null;
  if (!cdSize || cdOffset + cdSize > size) return null;

  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOffset);

  // One pass over the directory, keeping the best match rather than the first:
  // the caller's `names` are in priority order and the directory is in whatever
  // order the jar was built in.
  let best = null;
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === CD_SIG) {
    const method = cd.readUInt16LE(p + 10);
    const compressed = cd.readUInt32LE(p + 20);
    const uncompressed = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);

    const rank = names.indexOf(name);
    if (rank !== -1 && (!best || rank < best.rank) && uncompressed <= MAX_MANIFEST) {
      best = { rank, method, compressed, localOffset };
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!best) return null;

  // The local header repeats the name and extra-field lengths, and they are not
  // always the same as the central directory's -- the data offset has to come
  // from here.
  const head = Buffer.alloc(30);
  fs.readSync(fd, head, 0, 30, best.localOffset);
  if (head.readUInt32LE(0) !== LOCAL_SIG) return null;
  const dataAt = best.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);

  const raw = Buffer.alloc(best.compressed);
  fs.readSync(fd, raw, 0, best.compressed, dataAt);

  if (best.method === 0) return raw;
  if (best.method === 8) {
    try { return zlib.inflateRawSync(raw); } catch { return null; }
  }
  return null; // some other compression method; listed without details
}

// --- the smallest YAML that reads a plugin.yml ------------------------------

// Not a YAML parser, and not trying to be. A plugin.yml is mostly `key: value`
// at column zero with two shapes of list, and the parts this cannot read
// (commands:, permissions: -- nested maps, and none of our business) are exactly
// the parts that indent, so ignoring every indented line is both the simplest
// rule and the correct one.
function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseYaml(text) {
  const out = {};
  let key = null; // the top-level key an indented "- item" list belongs to

  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;

    // An indented "- x" continues the list started by the last top-level key.
    const item = raw.match(/^\s+-\s+(.*)$/);
    if (item && key) {
      if (!Array.isArray(out[key])) out[key] = [];
      out[key].push(unquote(item[1]));
      continue;
    }
    if (/^\s/.test(raw)) continue; // any other nested line: not ours

    const at = raw.indexOf(':');
    if (at === -1) continue;
    key = raw.slice(0, at).trim();
    const value = raw.slice(at + 1).trim();

    if (!value) { out[key] = null; continue; } // a block list may follow
    if (value.startsWith('[')) {
      out[key] = value.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean);
      continue;
    }
    out[key] = unquote(value);
  }
  return out;
}

// --- entry point ------------------------------------------------------------

const list = (v) => (Array.isArray(v)
  ? v.filter((x) => typeof x === 'string' && x)
  : (typeof v === 'string' && v ? [v] : []));

const str = (v) => {
  if (typeof v === 'string' && v) return v;
  if (typeof v === 'number') return String(v);
  return null;
};

// What the jar says it is, or null if it says nothing this can read. A jar with
// no readable manifest is still a plugin the server will try to load, so the
// caller lists it under its filename rather than dropping it.
export function readPluginJar(file) {
  let fd;
  try {
    const size = fs.statSync(file).size;
    if (size < 22) return null;
    fd = fs.openSync(file, 'r');
    const buf = readEntry(fd, size, MANIFESTS);
    if (!buf) return null;

    const y = parseYaml(buf.toString('utf8'));
    if (!y.name && !y.version && !y.main) return null;

    return {
      name: str(y.name),
      version: str(y.version),
      // "author" and "authors" are both legal, and plugins use both.
      authors: [...new Set([...list(y.authors), ...list(y.author)])],
      // The api-version a plugin declares is the OLDEST Minecraft API it says
      // it works with, not the version it was built against -- a plugin
      // updated for 1.21 that never raised its floor still says 1.13. So it
      // is a floor, and the only thing it proves on its own is that a plugin
      // declaring a floor above the server cannot load at all. Reported
      // as-is; the panel calls it a floor rather than a build version.
      apiVersion: str(y['api-version']),
      description: str(y.description),
      website: str(y.website),
      depend: list(y.depend),
      softdepend: list(y.softdepend),
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* nothing to do */ } }
  }
}
