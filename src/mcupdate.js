// Knows which Minecraft server version is on disk, which one Mojang (or Paper)
// is currently publishing, and how to get from the first to the second without
// anyone standing over it.
//
// This is the counterpart to src/steam.js, and it is a genuinely different
// problem. Steam owns the install: the dashboard can only stop the server and
// let SteamCMD do the work, because two programs writing the same library is
// how a working install turns into a re-download. Minecraft has no such owner.
// A Bedrock update is a zip on a web server and a Java update is a single jar,
// so there is nothing to coordinate with and nothing to corrupt -- which makes
// this the one update path the dashboard can drive end to end.
//
// The whole flow, from the button or from the sweep:
//
//   check   ask the publisher what the current version is, compare with disk
//   fetch   stream the download to dataDir, verifying the checksum where the
//           publisher gives us one -- with the server still up and players
//           still on it, because nothing in this step touches the install
//   stop    the server holds bedrock_server.exe / server.jar open, and Windows
//           will not let anything replace a file mapped into a live process
//   backup  the target's own pre-restart backup, if it has one configured
//   apply   Bedrock: extract over the install, skipping the files that carry
//           the operator's configuration and the world
//           Java: swap the jar, keeping the previous one for a rollback
//   start   bring the server back
//   clean   delete the download, once the server is up again
//
// That order is chosen for downtime. Only the steps between stop and start need
// the server off, and the download -- the longest step by a wide margin, and the
// one most likely to fail -- is not one of them. A download that stalls or fails
// its checksum now costs an outage that never started, rather than one already
// under way.
//
// The skip list is the part worth reading twice. The Bedrock zip ships stock
// copies of server.properties, allowlist.json and permissions.json, and
// unzipping it over a live install is the classic way to hand your server back
// to the public with an empty allow list. Extraction here is per-entry rather
// than wholesale precisely so those names can be stepped over, and nothing is
// ever deleted -- an operator's extra behaviour packs survive because the zip
// simply has nothing to say about them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ps, winPath } from './win.js';

// --- publishers -------------------------------------------------------------

// The links Mojang's launcher and website read. It carries every Bedrock build
// -- stable and preview, Windows and Linux -- plus the current vanilla Java
// server jar, and needs no key.
const BEDROCK_LINKS = 'https://net-secondary.web.minecraft-services.net/api/v1.0/download/links';

// The Java version index. v2 over v1 for the sha1 of each version manifest,
// which is what makes a downloaded jar verifiable.
const MOJANG_MANIFEST = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';

// PaperMC's current API. v1 and v2 are both sunset and answer every request
// with a refusal, so a Paper check against either fails in a way that looks
// like a network problem rather than the deliberate shutdown it is.
const PAPER_API = 'https://fill.papermc.io/v3/projects/paper';

// minecraft.net sits behind a CDN that answers a request with no User-Agent
// differently from a browser's. Node's fetch sends none by default.
const UA = 'ServerDashboard/1.0';

const API_TIMEOUT_MS = 15_000;

// A Minecraft release lands every few weeks and a Paper build every few days,
// so a cached answer is nearly always the right one, and several cards
// refreshing at once cost one call.
const INFO_CACHE_MS = 5 * 60_000;

// Every alert this file raises carries the same category the Steam updater
// uses, so one entry in a channel's mute list covers updates as a subject
// rather than as an implementation. See notifications.* in config.json.
const CATEGORY = 'update';

// Delay before the first background check, so a dashboard restart does not fire
// a burst of HTTP while the servers are still being polled for the first time.
const FIRST_CHECK_MS = 25_000;

// A download that has produced no bytes for this long is hung, not slow. The
// overall timeout has to be generous enough for a 95 MB zip on a bad line, and
// a generous overall timeout is exactly what lets a dead socket sit for half an
// hour -- so the two limits do different jobs and both are needed.
const STALL_MS = 90_000;

// How often the front end is told how far the download has got. Every chunk
// would be thousands of status frames for one file.
const PROGRESS_MS = 1000;

// The files the Bedrock zip ships stock copies of and an operator has almost
// certainly edited. Overwriting any of these is silent and immediate loss of
// the "why is my server suddenly allow-listed to nobody" kind.
//
// whitelist.json is here as well as allowlist.json because BDS renamed it and
// still honours the old name on servers that were never migrated.
const BEDROCK_KEEP_FILES = [
  'server.properties',
  'allowlist.json',
  'whitelist.json',
  'permissions.json',
];

// Folders that belong to the operator rather than to the release. worlds/ is
// the obvious one; the development_* folders are where a pack being worked on
// lives, and the release has no opinion about them.
//
// The shipped behavior_packs/ and resource_packs/ are deliberately NOT here:
// those hold the vanilla content for this exact server version, and pinning
// them to an older release while the binary moves forward is its own bug. An
// operator's own packs in those folders survive anyway, because extraction only
// ever writes the names the zip contains and never deletes anything.
const BEDROCK_KEEP_DIRS = [
  'worlds',
  'development_behavior_packs',
  'development_resource_packs',
  'development_skin_packs',
];

// Written into the install folder after a successful update, and validated
// against the binary it describes before it is believed. A marker whose binary
// has changed underneath it was overtaken by a hand-installed update, and
// trusting it would report a server as current forever.
const MARKER = '.dashboard-update.json';

// --- small helpers ----------------------------------------------------------

// "1.26.45.1" against "1.26.44.3". Compared segment by segment as numbers so
// that 45 beats 9, which a string compare gets backwards. A non-numeric segment
// (the "rc1" of a pre-release) sorts below a numeric one at the same position,
// which is the right answer for the only case that matters: a release candidate
// is not an upgrade over the release.
export function compareVersions(a, b) {
  if (a === b) return 0;
  const parts = (v) => String(v ?? '').split(/[.\-+]/).filter(Boolean);
  const A = parts(a);
  const B = parts(b);
  for (let i = 0; i < Math.max(A.length, B.length); i += 1) {
    const x = A[i];
    const y = B[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number(x);
    const ny = Number(y);
    const xNum = !Number.isNaN(nx) && x !== '';
    const yNum = !Number.isNaN(ny) && y !== '';
    if (xNum && yNum) {
      if (nx !== ny) return nx < ny ? -1 : 1;
      continue;
    }
    if (xNum !== yNum) return xNum ? 1 : -1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// The Minecraft version a Paper build targets: "1.21.11-132" is build 132 of
// 1.21.11, and the two halves answer different questions.
export const mcPart = (v) => String(v ?? '').split('-')[0] || null;

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const cache = new Map(); // key -> {at, result}

async function cached(key, force, fn) {
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < INFO_CACHE_MS) return hit.result;
  let result;
  try {
    result = await fn();
  } catch (err) {
    result = {
      ok: false,
      error: err.name === 'AbortError'
        ? 'timed out asking for the current Minecraft version'
        : err.message,
    };
  }
  // Only good answers are cached. A failed lookup should be retried on the next
  // press of the button, not remembered for five minutes.
  if (result.ok) cache.set(key, { at: Date.now(), result });
  return result;
}

// --- what the publishers are offering ---------------------------------------

// The current Bedrock Dedicated Server for Windows. `preview` follows the
// preview channel instead, which is a separate product line rather than a
// newer one -- a server on preview stays on preview.
export async function latestBedrock({ preview = false, force = false } = {}) {
  return cached(`bedrock:${preview}`, force, async () => {
    const body = await getJson(BEDROCK_LINKS);
    const want = preview ? 'serverBedrockPreviewWindows' : 'serverBedrockWindows';
    const link = body?.result?.links?.find((l) => l.downloadType === want);
    if (!link?.downloadUrl) {
      return { ok: false, error: `Minecraft's download index listed no ${want} build` };
    }
    // The version is not a field anywhere in that document -- it is only ever
    // the number in the file name.
    const m = String(link.downloadUrl).match(/bedrock-server-([\d.]+)\.zip/i);
    if (!m) return { ok: false, error: `could not read a version out of ${link.downloadUrl}` };
    return { ok: true, version: m[1], url: link.downloadUrl, fileName: `bedrock-server-${m[1]}.zip` };
  });
}

// The vanilla Java server jar for one Minecraft version, or for the newest
// release when `version` is null. The sha1 comes back with it: Mojang publishes
// one for every artifact, so an unattended download is verifiable rather than
// merely probable.
export async function latestVanilla({ version = null, force = false } = {}) {
  return cached(`vanilla:${version ?? 'latest'}`, force, async () => {
    const manifest = await getJson(MOJANG_MANIFEST);
    const id = version || manifest?.latest?.release;
    if (!id) return { ok: false, error: 'Mojang published no current release in its version manifest' };

    const entry = manifest?.versions?.find((v) => v.id === id);
    if (!entry?.url) return { ok: false, error: `Mojang's version manifest has no entry for "${id}"` };

    const detail = await getJson(entry.url);
    const server = detail?.downloads?.server;
    if (!server?.url) {
      return { ok: false, error: `Minecraft ${id} publishes no dedicated server jar` };
    }
    return {
      ok: true,
      version: id,
      url: server.url,
      sha1: server.sha1 ?? null,
      size: server.size ?? null,
      fileName: 'server.jar',
    };
  });
}

// The newest Paper build, either for one Minecraft version or for the newest
// version Paper builds for at all.
export async function latestPaper({ version = null, force = false } = {}) {
  return cached(`paper:${version ?? 'latest'}`, force, async () => {
    let mc = version;
    if (!mc) {
      const project = await getJson(PAPER_API);
      // `versions` is grouped by minor line, newest line first and newest
      // version first within it. Release candidates and pre-releases are
      // published alongside the stable build and are not what an unattended
      // update should take, so the first stable entry wins.
      const groups = Object.values(project?.versions ?? {});
      for (const group of groups) {
        const stable = group.find((v) => !/-(rc|pre)/i.test(v));
        if (stable) { mc = stable; break; }
      }
      if (!mc) return { ok: false, error: 'PaperMC listed no stable versions' };
    }

    const build = await getJson(`${PAPER_API}/versions/${encodeURIComponent(mc)}/builds/latest`);
    const dl = build?.downloads?.['server:default'];
    if (!dl?.url) {
      return { ok: false, error: `PaperMC has no server download for ${mc} build ${build?.id ?? '?'}` };
    }
    return {
      ok: true,
      version: `${mc}-${build.id}`,
      mcVersion: mc,
      build: build.id,
      url: dl.url,
      sha256: dl.checksums?.sha256 ?? null,
      size: dl.size ?? null,
      fileName: dl.name || `paper-${mc}-${build.id}.jar`,
    };
  });
}

// --- what is on disk --------------------------------------------------------

function readMarker(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
  } catch {
    return null;
  }
}

// The marker is only believed while the file it describes is still the file it
// described. Size and mtime together are enough: a hand-installed update
// changes both, and nothing else rewrites a server binary in place.
function markerValid(marker, file) {
  if (!marker?.version || !marker.binary) return false;
  try {
    const st = fs.statSync(file);
    return st.size === marker.binary.size && Math.abs(st.mtimeMs - marker.binary.mtimeMs) < 2000;
  } catch {
    return false;
  }
}

export function writeMarker(dir, file, patch) {
  try {
    const st = fs.statSync(file);
    fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({
      ...patch,
      at: Date.now(),
      binary: { path: file, size: st.size, mtimeMs: st.mtimeMs },
    }, null, 2));
  } catch { /* a marker we cannot write only costs the next check its shortcut */ }
}

// The newest line matching `re` in a log file, without reading the whole thing
// -- these grow to hundreds of megabytes and only two slices of that can
// possibly hold the answer.
//
// Both ends are read, and which one wins is not arbitrary. A server logs its
// version once, in the banner it prints at startup, so in a log that is rotated
// per run (which is what tools/bds-supervisor.js does) the line is in the first
// few hundred bytes and a tail-only read never sees it. In a log that is
// appended across restarts the newest banner is near the end instead. So: take
// the last match in the tail if there is one, because that is the most recent
// start, and otherwise fall back to the head.
const LOG_SLICE = 256 * 1024;

function readSlice(fd, size, at, want) {
  const span = Math.min(want, Math.max(0, size - at));
  if (!span) return '';
  const buf = Buffer.alloc(span);
  fs.readSync(fd, buf, 0, span, at);
  return buf.toString('utf8');
}

function lastMatch(text, re) {
  // matchAll needs a fresh lastIndex each time or the second call resumes where
  // the first stopped and silently finds nothing.
  const hits = [...text.matchAll(new RegExp(re.source, re.flags))];
  return hits.length ? hits[hits.length - 1][1] : null;
}

function fromLog(file, re) {
  if (!file || !fs.existsSync(file)) return null;
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    fd = fs.openSync(file, 'r');
    const head = readSlice(fd, size, 0, LOG_SLICE);
    const tail = size > LOG_SLICE ? readSlice(fd, size, size - LOG_SLICE, LOG_SLICE) : '';
    return lastMatch(tail, re) ?? lastMatch(head, re);
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

// Which Bedrock build is installed.
//
// bedrock_server.exe carries no version resource at all -- Get-Item's
// VersionInfo comes back blank -- so there is nothing to read out of the binary
// and the answer has to come from somewhere else. The marker written by the
// last update is first, because it is the only source that is exact; the log
// line BDS prints at startup is the fallback, and it is what makes this work on
// a server the dashboard has never updated.
export function installedBedrock(dir, { logFile = null } = {}) {
  const exe = path.join(dir, 'bedrock_server.exe');
  if (!fs.existsSync(exe)) {
    return { ok: false, error: `no bedrock_server.exe in ${dir} — set minecraftUpdate.installDir` };
  }

  const marker = readMarker(dir);
  if (markerValid(marker, exe)) {
    return { ok: true, version: marker.version, source: 'marker', binary: exe };
  }

  // "[2026-08-28 04:45:26:416 INFO] Version: 1.26.44.3"
  const log = logFile || path.join(dir, 'logs', 'latest.log');
  const logged = fromLog(log, /\bVersion:\s*([\d][\d.]*)/gi);

  // A log older than the binary describes the build before this one. Saying so
  // beats reporting a stale number as the truth and calling the server current.
  if (logged) {
    try {
      if (fs.statSync(log).mtimeMs >= fs.statSync(exe).mtimeMs) {
        return { ok: true, version: logged, source: 'log', binary: exe };
      }
    } catch { /* fall through to the unknown case */ }
    return {
      ok: true,
      version: null,
      source: 'log',
      binary: exe,
      note: `bedrock_server.exe is newer than ${path.basename(log)}, which still says ${logged} — `
        + 'start the server once so it logs the version it is actually running',
    };
  }

  return {
    ok: true,
    version: null,
    source: null,
    binary: exe,
    note: 'no version recorded yet — start the server once so it writes its version to the log, '
      + 'or run one update from here and it will be recorded from then on',
  };
}

// Which Java server is installed.
//
// Unlike Bedrock, the jar can be asked directly: every server jar since 1.14
// carries a version.json at its root naming the Minecraft version it is, and
// Paper's launcher jar carries the same. That is ground truth and it survives a
// hand-installed update, so it goes first.
//
// It is also only half the answer for Paper, whose builds all report the same
// Minecraft version -- 1.21.11 build 131 and build 132 are both "1.21.11". The
// build number comes from the marker or from Paper's own startup line.
export async function installedJava(jar, { logFile = null, flavor = 'vanilla' } = {}) {
  if (!fs.existsSync(jar)) {
    return { ok: false, error: `no server jar at ${jar} — set minecraftUpdate.jar` };
  }
  const dir = path.dirname(jar);
  const marker = readMarker(dir);
  const valid = markerValid(marker, jar);
  const log = logFile || path.join(dir, 'logs', 'latest.log');

  if (flavor === 'paper') {
    if (valid && marker.version) return { ok: true, version: marker.version, source: 'marker', binary: jar };
    // "This server is running Paper version 1.21.11-132-abcdef (MC: 1.21.11)"
    const logged = fromLog(log, /running Paper version ([\w.\-]+)/gi);
    const m = logged?.match(/^([\d.]+)-(\d+)/);
    if (m) return { ok: true, version: `${m[1]}-${m[2]}`, mcVersion: m[1], source: 'log', binary: jar };

    // The Minecraft version alone still points the check at the right Paper
    // line; it just cannot say whether the build on disk is current.
    const mc = await jarVersion(jar);
    return {
      ok: true,
      version: null,
      mcVersion: mc,
      source: mc ? 'jar' : null,
      binary: jar,
      note: mc
        ? `the jar reports Minecraft ${mc} but not which Paper build it is — `
          + 'run one update from here and the build will be recorded from then on'
        : 'could not read a version out of the jar',
    };
  }

  const mc = await jarVersion(jar);
  if (mc) return { ok: true, version: mc, mcVersion: mc, source: 'jar', binary: jar };
  if (valid && marker.version) return { ok: true, version: marker.version, source: 'marker', binary: jar };
  const logged = fromLog(log, /Starting minecraft server version ([\w.\-]+)/gi);
  if (logged) return { ok: true, version: logged, mcVersion: logged, source: 'log', binary: jar };
  return {
    ok: true,
    version: null,
    source: null,
    binary: jar,
    note: 'could not read a version out of the jar',
  };
}

// version.json out of the jar without unpacking it. A server jar is a zip, and
// .NET can read one entry out of it -- which beats shelling out to an unzip
// that may not be installed, and beats extracting sixty megabytes to read one
// line.
async function jarVersion(jar) {
  const res = await ps(`
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead('${winPath(jar).replace(/'/g, "''")}')
    try {
      $entry = $zip.Entries | Where-Object { $_.FullName -eq 'version.json' } | Select-Object -First 1
      if ($entry) {
        $reader = New-Object System.IO.StreamReader($entry.Open())
        try { Write-Output $reader.ReadToEnd() } finally { $reader.Dispose() }
      }
    } finally { $zip.Dispose() }
  `, 30_000);
  if (!res.ok || !String(res.out || '').trim()) return null;
  try {
    // Paper's version.json calls it "id" like Mojang's does; some forks only
    // set "name". Either is the Minecraft version.
    const j = JSON.parse(res.out);
    return j.id || j.name || null;
  } catch {
    return null;
  }
}

// --- fetching ---------------------------------------------------------------

// Streams a download to disk, hashing as it goes, so nothing is read twice and
// a 95 MB zip never has to be held in memory. Returns the digest for the caller
// to compare against whatever the publisher advertised.
export async function download(url, dest, { onProgress = null, algorithm = 'sha1' } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const controller = new AbortController();
  let stalled = false;

  // Reset by every chunk. A socket that has gone quiet has failed, and without
  // this it would sit inside the (necessarily generous) overall timeout doing
  // nothing until the server had been down for half an hour.
  let stall = null;
  const touch = () => {
    clearTimeout(stall);
    stall = setTimeout(() => { stalled = true; controller.abort(); }, STALL_MS);
  };
  touch();

  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': UA } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} fetching ${url}` };
    if (!res.body) return { ok: false, error: 'the download returned no body' };

    const total = Number(res.headers.get('content-length')) || null;
    const hash = crypto.createHash(algorithm);
    let received = 0;
    let announced = 0;

    async function* meter(source) {
      for await (const chunk of source) {
        received += chunk.length;
        hash.update(chunk);
        touch();
        if (onProgress && Date.now() - announced > PROGRESS_MS) {
          announced = Date.now();
          onProgress(received, total);
        }
        yield chunk;
      }
    }

    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(dest));
    onProgress?.(received, total);

    // A truncated download is the failure that produces a zip which opens and
    // then fails halfway through extraction, leaving the server stopped with
    // half its files replaced. Catch it here, before any of that.
    if (total != null && received !== total) {
      try { fs.unlinkSync(dest); } catch { /* nothing to remove */ }
      return { ok: false, error: `download ended early — got ${received} of ${total} bytes` };
    }
    return { ok: true, bytes: received, digest: hash.digest('hex'), file: dest };
  } catch (err) {
    // Whatever landed is not usable, and left in place it would be mistaken for
    // a finished download next time.
    try { fs.unlinkSync(dest); } catch { /* nothing to remove */ }
    return {
      ok: false,
      error: stalled ? `download stalled with no data for ${STALL_MS / 1000}s` : err.message,
    };
  } finally {
    clearTimeout(stall);
  }
}

// --- applying ---------------------------------------------------------------

// Extracts a Bedrock zip over an install, entry by entry, skipping the names
// that belong to the operator rather than to the release.
//
// Entry by entry rather than Expand-Archive because a wholesale extraction has
// no way to leave server.properties alone, and because nothing here deletes: a
// pack, a script or a config the operator added is simply a name the zip never
// mentions, so it is still there afterwards.
//
// The path check is not paranoia about Mojang. It is that this writes a remote
// archive into a folder full of live data, and an entry named
// "..\..\Windows\System32\..." is the oldest trick there is against exactly
// this shape of code.
export async function extractBedrock(zipFile, installDir, { keep = [], timeoutMs = 900_000 } = {}) {
  const quote = (v) => `'${String(v).replace(/'/g, "''")}'`;
  const norm = (v) => String(v).toLowerCase().replace(/\\/g, '/').replace(/^\/+/, '');
  const files = [...BEDROCK_KEEP_FILES, ...keep.filter((k) => !String(k).endsWith('/'))].map(norm);
  const dirs = [...BEDROCK_KEEP_DIRS, ...keep.filter((k) => String(k).endsWith('/'))]
    .map((d) => `${norm(d).replace(/\/$/, '')}/`);

  const script = [
    `Add-Type -AssemblyName System.IO.Compression.FileSystem`,
    `$root = [System.IO.Path]::GetFullPath(${quote(winPath(installDir))})`,
    `if (-not $root.EndsWith('\\')) { $root = $root + '\\' }`,
    `$skipFiles = @(${files.map(quote).join(',')})`,
    `$skipDirs  = @(${dirs.map(quote).join(',')})`,
    `$copied = 0; $kept = 0; $bytes = 0; $failed = @()`,
    `$zip = [System.IO.Compression.ZipFile]::OpenRead(${quote(winPath(zipFile))})`,
    `try {`,
    `  foreach ($entry in $zip.Entries) {`,
    `    $rel = $entry.FullName.Replace('\\', '/')`,
    `    if ($rel.EndsWith('/')) { continue }`,
    `    $low = $rel.ToLowerInvariant()`,
    `    if ($skipFiles -contains $low) { $kept++; continue }`,
    `    $inKept = $false`,
    `    foreach ($d in $skipDirs) { if ($low.StartsWith($d)) { $inKept = $true; break } }`,
    `    if ($inKept) { $kept++; continue }`,
    `    $dest = [System.IO.Path]::GetFullPath((Join-Path $root ($rel.Replace('/', '\\'))))`,
    `    if (-not $dest.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {`,
    `      $failed += ('refused, outside the install folder: ' + $rel); continue`,
    `    }`,
    `    try {`,
    `      $dir = [System.IO.Path]::GetDirectoryName($dest)`,
    `      if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }`,
    `      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $true)`,
    `      $copied++; $bytes += $entry.Length`,
    // Collected rather than thrown: one locked file should report itself, not
    // abandon the other ten thousand halfway through.
    `    } catch {`,
    `      if ($failed.Count -lt 20) { $failed += ($rel + ': ' + $_.Exception.Message) }`,
    `    }`,
    `  }`,
    `} finally { $zip.Dispose() }`,
    `Write-Output ('SD_JSON ' + (ConvertTo-Json -Compress @{ copied = $copied; kept = $kept; bytes = $bytes; failed = @($failed) }))`,
  ].join('\n');

  const res = await ps(script, timeoutMs);
  const empty = { copied: 0, kept: 0, bytes: 0, failed: [] };
  if (!res.ok) return { ok: false, error: res.error, ...empty };

  const at = String(res.out || '').lastIndexOf('SD_JSON ');
  if (at === -1) return { ok: false, error: 'the extraction reported nothing back', ...empty };

  let summary;
  try {
    summary = JSON.parse(res.out.slice(at + 'SD_JSON '.length).trim());
  } catch (err) {
    return { ok: false, error: `could not read the extraction summary: ${err.message}`, ...empty };
  }

  const failed = [].concat(summary.failed ?? []).filter(Boolean);
  return {
    ok: failed.length === 0 && summary.copied > 0,
    copied: summary.copied ?? 0,
    kept: summary.kept ?? 0,
    bytes: summary.bytes ?? 0,
    failed,
    error: failed.length
      ? `${failed.length} file(s) could not be written: ${failed.slice(0, 3).join('; ')}`
      : summary.copied ? null : 'the archive contained nothing to install',
  };
}

export const KEEP_LIST = { files: BEDROCK_KEEP_FILES, dirs: BEDROCK_KEEP_DIRS };

// Names the copy of the jar a Java update replaced, in the same shape the
// backup archives use, so two things you might go looking for after a bad
// update sort next to each other by eye.
const fileStamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// How many replaced jars to keep per target. One is the rollback; the second is
// the rollback for the update before that, which is what you want when a
// version turns out to be broken only after a day of play.
const KEEP_PREVIOUS_JARS = 2;

// ---------------------------------------------------------------------------
// The update flow
// ---------------------------------------------------------------------------

export class MinecraftUpdates {
  constructor(config, monitor, dataDir) {
    this.config = config;
    this.monitor = monitor;
    this.actions = null; // set by server.js — Actions is built after this
    this.state = new Map(); // id -> what the card should say
    // id -> the release check() last resolved. begin() installs this rather
    // than asking the publisher a second time, so what was compared and what
    // gets installed cannot disagree. Kept here instead of returned, because it
    // is a download URL and a checksum -- begin()'s business, not the browser's.
    this.releases = new Map();
    this.busy = new Set();  // ids with an update in flight
    this.checkMinutes = config.minecraft?.checkMinutes ?? 360;
    // A 95 MB zip on a slow line is not a 5-minute job, and extracting eleven
    // thousand files onto a spinning disk is not either.
    this.downloadTimeoutMinutes = config.minecraft?.downloadTimeoutMinutes ?? 30;
    this.extractTimeoutMinutes = config.minecraft?.extractTimeoutMinutes ?? 15;
    // The download is deleted once it has been installed, which is what makes
    // this unattended rather than a folder that fills with 95 MB zips. Turn it
    // on to keep them -- the only offline way back to a previous Bedrock build,
    // since Mojang publishes no archive of old releases.
    this.keepDownloads = Boolean(config.minecraft?.keepDownloads);
    this.store = path.join(dataDir || 'data', 'mc-updates');
  }

  // otherBusy is the plugin updater's lock (src/pluginupdate.js). Both stop the
  // server and write into the same install, so they must never overlap: the
  // loser of that race would be starting a server the winner is still swapping
  // files under.
  attach({ actions, otherBusy } = {}) {
    this.actions = actions ?? this.actions;
    this.otherBusy = otherBusy ?? this.otherBusy;
  }

  // What this target's updates look like, or null if it has none.
  //
  // Almost all of this is derived rather than configured. A Bedrock or Java
  // target already says where it starts from and what it logs to, and those
  // answer "which folder" and "which edition" on their own -- so the common
  // case needs no minecraftUpdate block at all, and the block exists for the
  // installs that are laid out unusually.
  settings(id) {
    const t = this.config.targets.find((x) => x.id === id);
    if (!t || t.kind !== 'game') return null;

    const mu = t.minecraftUpdate ?? {};
    if (mu.enabled === false) return null;

    const edition = mu.edition
      ?? (t.game === 'bedrock' ? 'bedrock' : t.game === 'minecraft' ? 'java' : null);
    if (!edition) return null;

    // The start command lives in the install folder for every normal layout --
    // BDS cannot be launched from anywhere else, and a Java server's .bat sits
    // beside its jar because that is where the working directory has to be.
    const installDir = mu.installDir
      ?? (t.startCommand ? path.dirname(path.resolve(winPath(t.startCommand))) : null);
    if (!installDir) return null;

    if (edition === 'bedrock') {
      return {
        edition,
        installDir,
        binary: path.join(installDir, 'bedrock_server.exe'),
        preview: Boolean(mu.preview),
        auto: Boolean(mu.auto),
        keep: mu.keep ?? [],
        logFile: t.logFile ?? null,
      };
    }

    const flavor = mu.flavor ?? 'vanilla';
    return {
      edition: 'java',
      installDir,
      flavor,
      binary: path.isAbsolute(mu.jar ?? '')
        ? mu.jar
        : path.join(installDir, mu.jar ?? 'server.jar'),
      // Which new versions count. "same" holds the Minecraft version still and
      // takes newer builds of it, which is the only safe default for Paper --
      // every plugin on the server is built against one Minecraft version, and
      // carrying them across a version bump unattended is how a server comes
      // back up with half its plugins refusing to load. Vanilla has no plugins
      // to break, so it follows releases.
      track: mu.track ?? (flavor === 'paper' ? 'same' : 'latest'),
      auto: Boolean(mu.auto),
      logFile: t.logFile ?? null,
    };
  }

  // A target the dashboard can actually do this for. As with the Steam updater,
  // a layout it cannot make sense of gets no button rather than a button whose
  // only possible outcome is an explanation.
  managed(id) {
    const s = this.settings(id);
    return Boolean(s && fs.existsSync(s.binary));
  }

  target(id) {
    const t = this.config.targets.find((x) => x.id === id);
    if (!t) throw new Error(`unknown target: ${id}`);
    return t;
  }

  #set(id, patch) {
    this.state.set(id, { ...(this.state.get(id) || {}), ...patch });
  }

  // What the browser sees. Only targets with something to say appear, and the
  // shape matches the Steam updater's so one banner renders both.
  snapshot() {
    const out = {};
    for (const [id, s] of this.state) {
      if (s.phase === 'idle' && !s.updateAvailable && !s.error && !s.note) continue;
      out[id] = s;
    }
    return out;
  }

  // --- reading both sides ---------------------------------------------------

  async #installed(s) {
    return s.edition === 'bedrock'
      ? installedBedrock(s.installDir, { logFile: s.logFile })
      : installedJava(s.binary, { logFile: s.logFile, flavor: s.flavor });
  }

  async #latest(s, installed, force) {
    if (s.edition === 'bedrock') return latestBedrock({ preview: s.preview, force });

    // "same" needs to know which Minecraft version is installed before it can
    // ask for a newer build of it. Without that it has no line to follow, so it
    // degrades to the newest release rather than to nothing.
    let version = null;
    if (s.track === 'same') version = installed.mcVersion ?? mcPart(installed.version) ?? null;
    else if (s.track !== 'latest') version = s.track;

    return s.flavor === 'paper'
      ? latestPaper({ version, force })
      : latestVanilla({ version, force });
  }

  // Compare what is installed against what is published. No side effects --
  // both the button and the background sweep start here.
  async check(id, { force = false } = {}) {
    const s = this.settings(id);
    if (!s) return { ok: false, error: 'this target is not a Minecraft server the dashboard can update' };

    const installed = await this.#installed(s);
    if (!installed.ok) {
      this.#set(id, { provider: 'minecraft', error: installed.error });
      return installed;
    }

    const latest = await this.#latest(s, installed, force);
    if (!latest.ok) {
      this.#set(id, { provider: 'minecraft', installed: installed.version, error: latest.error });
      return { ok: false, installed: installed.version, error: latest.error };
    }

    // An unknown installed version is never an update. It is the one case where
    // guessing costs a live server an outage it did not need, so the sweep is
    // told nothing is waiting and the note explains what to do about it -- while
    // begin() will still install on request, which is what records the version
    // and ends the ambiguity.
    const known = Boolean(installed.version);
    const updateAvailable = known && compareVersions(latest.version, installed.version) > 0;
    this.releases.set(id, latest);

    this.#set(id, {
      provider: 'minecraft',
      edition: s.edition,
      flavor: s.flavor ?? null,
      phase: this.state.get(id)?.phase || 'idle',
      installed: installed.version,
      latest: latest.version,
      updateAvailable,
      unknownInstalled: !known,
      note: known ? null : installed.note ?? null,
      checkedAt: Date.now(),
      error: null,
    });

    return {
      ok: true,
      installed: installed.version,
      latest: latest.version,
      updateAvailable,
      unknownInstalled: !known,
      note: known ? null : installed.note ?? null,
    };
  }

  // --- the update -----------------------------------------------------------

  // The button, and the whole job. Check; if there is nothing to install, say so
  // and leave the server alone. If there is, fetch the release while the server
  // is still running, then stop it, back it up, put the release in place, start
  // it again and delete the download -- with no step in the middle that waits
  // for a person, and the server down only for the part that needs it.
  async begin(id, { force = false } = {}) {
    const s = this.settings(id);
    if (!s) return { ok: false, error: 'this target is not a Minecraft server the dashboard can update' };
    if (!this.actions) return { ok: false, error: 'dashboard is still starting up' };
    if (this.busy.has(id)) return { ok: false, error: 'an update is already running for this server' };
    if (this.otherBusy?.(id)) return { ok: false, error: 'the plugins are being updated right now — try again when that has finished' };

    const t = this.target(id);
    this.busy.add(id);
    try {
      this.#set(id, { phase: 'checking', provider: 'minecraft' });
      const found = await this.check(id, { force: true });
      if (!found.ok) {
        this.#set(id, { phase: 'idle' });
        return found;
      }

      // Nothing waiting, and the version on disk is known: this is the ordinary
      // "already current" answer and the server is not touched.
      if (!found.updateAvailable && !found.unknownInstalled && !force) {
        this.#set(id, { phase: 'idle' });
        this.monitor.addAlert('info', id,
          `Checked Minecraft — already on the current version (${found.installed})`, CATEGORY);
        return { ok: true, updateAvailable: false, installed: found.installed, latest: found.latest };
      }

      const latest = this.releases.get(id);
      if (!latest?.ok) {
        const error = latest?.error ?? 'could not work out which version to install';
        this.#set(id, { phase: 'idle', error });
        return { ok: false, error };
      }

      this.monitor.addAlert('warn', id,
        `Minecraft ${latest.version} is available (installed ${found.installed ?? 'unknown'}) — `
        + 'downloading it now — the server stays up until it has arrived', CATEGORY);

      // Downloaded and verified first, with the server still running and the
      // players still on it. Nothing here writes into the install, so these
      // minutes are minutes the server does not have to spend down.
      const fetched = await this.#fetch(id, latest);
      if (!fetched.ok) {
        this.#set(id, { phase: 'idle', bytesDownloaded: null, bytesToDownload: null });
        return {
          ...fetched,
          updateAvailable: true,
          installed: found.installed,
          latest: latest.version,
        };
      }

      // Held from here until the server is back. Monitor#suppress counts holds,
      // so the stop and start inside take and release their own without ending
      // the blackout -- a server that is meant to be down for the length of an
      // install must not be reported as crashed, or restarted by the watchdog,
      // while it is.
      this.monitor.suppress(id, true);
      try {
        this.#set(id, { phase: 'stopping' });
        const stopped = await this.actions.stop(id).catch((err) => ({ ok: false, error: err.message }));
        if (!stopped.ok) {
          // Nothing was installed and the server never went down, so the
          // download has no one left to serve.
          this.#cleanup(fetched.file, !this.keepDownloads);
          this.#set(id, { phase: 'idle', error: stopped.error });
          this.monitor.addAlert('error', id,
            `Update aborted — the server would not stop: ${stopped.error}`, CATEGORY);
          return { ok: false, error: `stop failed: ${stopped.error}` };
        }

        // The server is down and the world is at rest, and the next thing to
        // touch these files is a version change. This is the archive you want if
        // the new version turns out to be the problem.
        let backup = null;
        if (t.backup?.enabled && t.backup?.beforeRestart && this.actions.backups) {
          backup = await this.actions.backups.run(id, { reason: 'before Minecraft update', save: false });
          if (!backup.ok) {
            this.monitor.addAlert('warn', id,
              `Pre-update backup failed, continuing with the update: ${backup.error}`, 'backup');
          }
        }

        const applied = await this.#apply(id, s, fetched.file, latest, found.installed);

        this.#set(id, { phase: 'starting', bytesDownloaded: null, bytesToDownload: null });
        // Started either way. An update that failed halfway leaves a server that
        // is down and a person who has to work out why; a server that is up on a
        // known-imperfect install is at worst the same problem, with its own log
        // to read it from. The alert above says which happened.
        const started = await this.actions.start(id).catch((err) => ({ ok: false, error: err.message }));
        if (!started.ok) {
          this.monitor.addAlert('error', id,
            `Update finished, but the server would not start: ${started.error}`, CATEGORY);
        }

        // Last, so the file stays on disk for the whole window in which the
        // install could still turn out to have gone wrong.
        this.#cleanup(fetched.file, !this.keepDownloads);

        this.#set(id, { phase: 'idle' });
        await this.check(id, { force: true }).catch(() => {});

        return {
          ...applied,
          updateAvailable: true,
          installed: applied.ok ? latest.version : found.installed,
          latest: latest.version,
          backup: backup?.file ?? null,
          started: started.ok,
          startError: started.ok ? null : started.error,
        };
      } finally {
        this.monitor.suppress(id, false);
      }
    } finally {
      this.busy.delete(id);
    }
  }

  // Download and verify, and nothing else: the server is still running when
  // this is called, and nothing below writes into the install.
  async #fetch(id, latest) {
    const dir = path.join(this.store, id);
    const file = path.join(dir, latest.fileName);

    this.#set(id, { phase: 'downloading', bytesDownloaded: 0, bytesToDownload: latest.size ?? null });
    this.monitor.addAlert('info', id,
      `Downloading Minecraft ${latest.version}${latest.size ? ` (${Math.round(latest.size / 1048576)} MB)` : ''}`,
      CATEGORY);

    // Which digest to compute is decided by which one the publisher advertised.
    // Mojang signs its jars with sha1 and Paper with sha256; Bedrock publishes
    // neither, so that download is checked by length and then by whether the
    // archive opens.
    const algorithm = latest.sha256 ? 'sha256' : 'sha1';
    const expected = latest.sha256 ?? latest.sha1 ?? null;

    const got = await download(latest.url, file, {
      algorithm,
      onProgress: (received, total) => {
        this.#set(id, { bytesDownloaded: received, bytesToDownload: total ?? latest.size ?? null });
      },
    });
    if (!got.ok) {
      this.#set(id, { error: got.error });
      this.monitor.addAlert('error', id, `Update download failed: ${got.error}`, CATEGORY);
      return { ok: false, error: got.error, phase: 'download' };
    }

    // A file that does not match its published digest is not a slow download or
    // a flaky mirror, it is a file that must not be installed. There is nothing
    // to salvage, so it goes.
    if (expected && got.digest.toLowerCase() !== String(expected).toLowerCase()) {
      this.#cleanup(file, true);
      const error = `the download did not match its published ${algorithm} checksum — it was not installed`;
      this.#set(id, { error });
      this.monitor.addAlert('error', id, `Update aborted — ${error}`, CATEGORY);
      return { ok: false, error, phase: 'verify' };
    }

    return { ok: true, file };
  }

  // Put the verified download in place. The server is stopped and the blackout
  // is held by the time this runs; deleting the download is the caller's job,
  // after the server is back up.
  async #apply(id, s, file, latest, previousVersion) {
    this.#set(id, { phase: 'installing' });
    return s.edition === 'bedrock'
      ? this.#applyBedrock(id, s, file, latest, previousVersion)
      : this.#applyJava(id, s, file, latest, previousVersion);
  }

  async #applyBedrock(id, s, zip, latest, previousVersion) {
    const res = await extractBedrock(zip, s.installDir, {
      keep: s.keep,
      timeoutMs: this.extractTimeoutMinutes * 60_000,
    });

    if (!res.ok) {
      this.#set(id, { error: res.error });
      this.monitor.addAlert('error', id,
        `Update finished with errors — ${res.error}. `
        + `${res.copied} file(s) were written, so the install may be part-updated; `
        + 'compare it against a fresh download if the server misbehaves.', CATEGORY);
      return { ok: false, error: res.error, ...res };
    }

    writeMarker(s.installDir, s.binary, { edition: 'bedrock', version: latest.version, previousVersion });
    // Names the four things an operator actually worries about losing here,
    // rather than reciting the whole skip list. The raw count of skipped
    // entries is not the reassuring number -- "3 left alone" against ten
    // thousand installed reads like something went wrong.
    this.monitor.addAlert('info', id,
      `Updated Bedrock ${previousVersion ?? 'unknown'} → ${latest.version} — `
      + `${res.copied} file(s) installed. Your world, server.properties, allowlist.json `
      + `and permissions.json were left as they were`
      + `${s.keep?.length ? `, along with ${s.keep.join(', ')}` : ''}. `
      + 'Starting the server.', CATEGORY);

    return { ok: true, copied: res.copied, kept: res.kept, bytes: res.bytes, version: latest.version };
  }

  // A Java update is one file, which makes the rollback one file too: the jar
  // being replaced is copied aside first, so a failed write has somewhere to
  // come back from instead of leaving a truncated jar where the server is.
  #applyJava(id, s, downloaded, latest, previousVersion) {
    const dir = path.join(this.store, id);
    const kept = path.join(dir, `previous-${previousVersion ?? 'unknown'}-${fileStamp(new Date())}.jar`);

    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(s.binary, kept);
    } catch (err) {
      const error = `could not set the current jar aside first: ${err.message}`;
      this.#set(id, { error });
      this.monitor.addAlert('error', id, `Update aborted — ${error}`, CATEGORY);
      return { ok: false, error, phase: 'backup' };
    }

    try {
      fs.copyFileSync(downloaded, s.binary);
    } catch (err) {
      let restored = false;
      try { fs.copyFileSync(kept, s.binary); restored = true; } catch { /* reported below */ }
      const error = `could not replace ${path.basename(s.binary)}: ${err.message}`;
      this.#set(id, { error });
      this.monitor.addAlert('error', id,
        `Update failed — ${error}. ${restored
          ? 'The previous jar was put back, so the server starts on the version it had.'
          : `The jar may be incomplete; the previous one is at ${kept}.`}`, CATEGORY);
      return { ok: false, error, restored, phase: 'install' };
    }

    writeMarker(s.installDir, s.binary, {
      edition: 'java', flavor: s.flavor, version: latest.version, previousVersion, previousJar: kept,
    });
    this.#pruneJars(dir);

    this.monitor.addAlert('info', id,
      `Updated ${s.flavor === 'paper' ? 'Paper' : 'Minecraft'} `
      + `${previousVersion ?? 'unknown'} → ${latest.version}. `
      + `The previous jar is kept at ${kept} if you need to go back. Starting the server.`, CATEGORY);

    return { ok: true, copied: 1, kept: 0, version: latest.version, previousJar: kept };
  }

  #pruneJars(dir) {
    try {
      const old = fs.readdirSync(dir)
        .filter((f) => /^previous-.*\.jar$/i.test(f))
        .map((f) => ({ f, at: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.at - a.at)
        .slice(KEEP_PREVIOUS_JARS);
      for (const { f } of old) fs.unlinkSync(path.join(dir, f));
    } catch { /* a jar we could not prune costs disk, not correctness */ }
  }

  #cleanup(file, remove) {
    if (!remove) return;
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }

  // Present so that one dispatch can drive either updater, and honest about why
  // it does nothing. The Steam flow has a phase where the server is stopped
  // waiting for a person, and cancelling means giving up on that wait; this
  // flow never waits for anyone, so there is no wait to abandon. The card's
  // cancel button only appears for phase "waiting", which nothing here sets, so
  // in practice this is unreachable from the UI.
  async cancel(id) {
    return {
      ok: false,
      error: this.busy.has(id)
        ? 'this update is already downloading or installing — it finishes on its own and starts the server'
        : 'no Minecraft update is in progress for this server',
    };
  }

  // --- background checks ----------------------------------------------------

  // One alert per new version, not one per sweep: this runs every six hours and
  // a release can sit unapplied for days.
  async #sweep() {
    for (const t of this.config.targets) {
      if (!this.managed(t.id) || this.busy.has(t.id)) continue;
      if (this.otherBusy?.(t.id)) continue;

      const res = await this.check(t.id).catch(() => null);
      if (!res?.ok || !res.updateAvailable) continue;

      const s = this.settings(t.id);
      if (s?.auto) {
        // Installing means stopping the server, and for a server with players on
        // it that stop is an outage they did not ask for. So an automatic update
        // waits for an empty server; a populated one is left alone and picked up
        // by a later sweep. Only a confirmed zero counts -- an unknown player
        // count is not an empty server.
        const online = this.monitor.state.get(t.id)?.playerCount ?? null;
        if (online === 0) {
          this.#set(t.id, { notified: res.latest });
          this.monitor.addAlert('info', t.id,
            `Minecraft ${res.latest} is available and nobody is online — updating now`, CATEGORY);
          await this.begin(t.id).catch((err) => {
            this.monitor.addAlert('error', t.id, `Automatic update failed: ${err.message}`, CATEGORY);
          });
          continue;
        }
        if (this.state.get(t.id)?.notified === res.latest) continue;
        this.#set(t.id, { notified: res.latest });
        this.monitor.addAlert('warn', t.id,
          `Minecraft update available — ${res.latest} (running ${res.installed}). `
          + `${online === null ? 'The player count cannot be read' : `${online} player(s) online`}, `
          + 'so it will be installed automatically once the server is empty.', CATEGORY);
        continue;
      }

      if (this.state.get(t.id)?.notified === res.latest) continue;
      this.#set(t.id, { notified: res.latest });
      this.monitor.addAlert('warn', t.id,
        `Minecraft update available — ${res.latest} (running ${res.installed}). `
        + 'Press "Check for update" on the card when you want it installed.', CATEGORY);
    }
  }

  start() {
    const tick = () => this.#sweep().catch((err) => console.error('[minecraft]', err.message));
    this.first = setTimeout(tick, FIRST_CHECK_MS);
    this.first.unref?.();
    this.timer = setInterval(tick, this.checkMinutes * 60_000);
    this.timer.unref?.();
  }

  stop() {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }
}
