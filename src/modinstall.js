// Copies the Steam client's newer copy of a workshop mod over the copy the mod
// manager installed into a server, and records that it happened.
//
// src/workshop.js is the detector: it compares the two timestamps and says "a
// newer copy is waiting". Everything there is read-only on purpose, and the
// reasoning behind that -- a mod is built against one game build, can take the
// server down on the first player join, and has no `validate` to undo it -- is
// still true. This file does not disagree with it. It narrows it:
//
//   the mod manager decides WHAT a mod installs. This only refreshes the files
//   it already installed, from the same workshop item it installed them from.
//
// That distinction is the whole safety argument, and it is worth being precise
// about, because it is what makes the operation predictable:
//
//   * Only files listed in the mod's own InstallManifest.json are touched. A
//     workshop item usually contains more than the server got -- a client-only
//     mod installs one Info.json here and keeps its Paks and Lua for the game --
//     and copying those in would install things the manager deliberately did
//     not. New files an update adds are reported, never guessed at.
//   * A destination that has been edited since the install is never overwritten.
//     UE4SS's Mods\mods.txt is the case that matters: it is the list of what
//     UE4SS loads, it is routinely hand-edited, and the workshop copy is the
//     stock one. Replacing it would silently switch mods off.
//   * Every file that is replaced is copied somewhere first. Nothing here is
//     one-way.
//
// The mapping from a workshop file to its installed destination is recovered by
// suffix, not reinvented: the manifest records `Mods/NativeMods/UE4SS/Mods/
// PalSchema/dlls/main.dll` and the item contains `dlls/main.dll`, so the longest
// item path that is a tail of the recorded path is the file it came from. That
// is deliberately not an attempt to reimplement the manager's InstallRule
// language -- inferring where a mod's files *should* go is exactly the kind of
// guess that writes a dll into the wrong folder. The recorded path is where this
// mod's files actually went last time, on this machine.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// A destination written within this long of the recorded install time is one the
// installer itself wrote, not a later edit. The manager writes the files and
// then the manifest, so a file's mtime can sit slightly either side of the
// stamp; anything outside the window is somebody's own change.
const INSTALL_WINDOW_MS = 60_000;

// Where the Steam client unpacks subscribed items, under the workshop folder.
export function contentDir(workshopDir, appId, workshopId) {
  return path.join(workshopDir, 'content', String(appId), String(workshopId));
}

// --- reading both sides -----------------------------------------------------

// Every file under a folder, as forward-slash relative paths. Workshop items are
// small (a dll and some Lua, at most a pak), so this walks the lot rather than
// bounding it the way src/mods.js has to bound a game folder.
function walk(root, rel = '', out = []) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(root, child, out);
    else out.push(child);
  }
  return out;
}

function sha1(file) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

// Same bytes, cheaply: a size mismatch is the common case and settles it without
// reading either file.
function identical(a, b) {
  let sa;
  let sb;
  try {
    sa = fs.statSync(a);
    sb = fs.statSync(b);
  } catch {
    return false;
  }
  if (sa.size !== sb.size) return false;
  const ha = sha1(a);
  return ha != null && ha === sha1(b);
}

// The longest path in `sources` that is a tail of `dest`, aligned on separators.
// Windows paths are compared case-insensitively because the filesystem is.
function matchSource(dest, byLower) {
  const parts = dest.split('/');
  for (let i = 0; i < parts.length; i += 1) {
    const tail = parts.slice(i).join('/');
    const hit = byLower.get(tail.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

// --- planning ---------------------------------------------------------------

// What refreshing one mod would do, with nothing written. Every file the mod
// recorded ends up in exactly one bucket, and the buckets are the explanation
// the card shows before anybody presses anything.
export function planMod({ modsDir, installDir, workshopDir, appId, name, sourceAt = null }) {
  const dir = path.join(modsDir, name);
  const manifestFile = path.join(dir, 'InstallManifest.json');

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (err) {
    return { name, ok: false, error: `could not read InstallManifest.json: ${err.message}` };
  }

  const workshopId = manifest.WorkshopId == null ? null : String(manifest.WorkshopId);
  if (!workshopId) return { name, ok: false, error: 'the install manifest names no workshop item' };

  const src = contentDir(workshopDir, appId, workshopId);
  if (!fs.existsSync(src)) {
    return {
      name,
      ok: false,
      workshopId,
      error: `Steam has no downloaded copy of item ${workshopId} — subscribe to it in the Steam client`,
    };
  }

  const files = Array.isArray(manifest.Files) ? manifest.Files.filter((f) => typeof f === 'string') : [];
  if (!files.length) {
    return { name, ok: false, workshopId, error: 'the install manifest lists no files' };
  }

  const installedAt = Date.parse(manifest.LastInstallTimeUtc);
  const sources = walk(src);
  const byLower = new Map(sources.map((s) => [s.toLowerCase(), s]));
  const used = new Set();

  const copy = [];
  const same = [];
  const guarded = [];
  const unmapped = [];

  for (const rel of files) {
    const dest = path.resolve(installDir, rel);
    // The manifest is a file on disk like any other; a path in it that climbs
    // out of the install folder is not something to act on.
    if (dest !== installDir && !dest.startsWith(installDir + path.sep)) {
      unmapped.push({ dest: rel, why: 'the recorded path points outside the install folder' });
      continue;
    }

    const hit = matchSource(rel, byLower);
    if (!hit) {
      // A file the manager wrote that the item does not contain: its own backup
      // copies (config.ini.bak-*), or a file dropped upstream between versions.
      unmapped.push({ dest: rel, why: 'no file in the Steam copy corresponds to it' });
      continue;
    }
    used.add(hit);

    const from = path.join(src, hit);
    if (fs.existsSync(dest) && identical(from, dest)) {
      same.push({ dest: rel, src: hit });
      continue;
    }

    // Changed here since the install, and the Steam copy disagrees with it. That
    // is somebody's edit, and the update is not a reason to discard it.
    if (fs.existsSync(dest) && Number.isFinite(installedAt)) {
      let mtime = 0;
      try { mtime = fs.statSync(dest).mtimeMs; } catch { /* treat as unknown */ }
      if (mtime > installedAt + INSTALL_WINDOW_MS) {
        guarded.push({ dest: rel, src: hit, changedAt: Math.round(mtime) });
        continue;
      }
    }

    let bytes = 0;
    try { bytes = fs.statSync(from).size; } catch { /* reported as zero */ }
    copy.push({ dest: rel, src: hit, bytes, missing: !fs.existsSync(dest) });
  }

  // Files the item carries that this server never received. Normal and expected
  // for a mod whose server install is one Info.json, so it is reported rather
  // than treated as a problem -- but if an update genuinely adds a new server
  // file, this is where it shows up, and the mod manager is what installs it.
  const extra = sources.filter((s) => !used.has(s));

  return {
    name,
    ok: true,
    workshopId,
    manifestFile,
    contentDir: src,
    installedAt: Number.isFinite(installedAt) ? installedAt : null,
    sourceAt,
    copy,
    same,
    guarded,
    unmapped,
    extra,
    bytes: copy.reduce((n, f) => n + f.bytes, 0),
  };
}

// The same for a set of mods. `names` is what the caller decided to act on --
// normally the stale ones, since a mod whose Steam copy has not moved has
// nothing to copy.
export function planRefresh({ appId, modsDir, workshopDir, installDir, names, sourceAt = {} }) {
  if (!installDir) return { ok: false, error: 'this target has no steamInstallDir, so there is nowhere to copy into' };
  if (!fs.existsSync(modsDir)) return { ok: false, error: `no such mods folder: ${modsDir}` };

  const root = path.resolve(installDir);
  const mods = names.map((name) => planMod({
    modsDir, installDir: root, workshopDir, appId, name, sourceAt: sourceAt[name] ?? null,
  }));

  return {
    ok: true,
    installDir: root,
    mods,
    files: mods.reduce((n, m) => n + (m.copy?.length || 0), 0),
    bytes: mods.reduce((n, m) => n + (m.bytes || 0), 0),
    failed: mods.filter((m) => !m.ok).map((m) => `${m.name}: ${m.error}`),
  };
}

// --- applying ---------------------------------------------------------------

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

// Re-dates the install so the mod stops reading as stale. This is the whole
// operation for a mod whose files turn out to be byte-identical to the Steam
// copy -- which happens more than you would think, because a workshop item can
// be republished with a new timestamp and unchanged content, and the detector
// compares timestamps because that is all it can see from outside.
function restamp(file, sourceAt) {
  const now = new Date();
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { ok: false, error: err.message };
  }
  manifest.LastInstallTimeUtc = now.toISOString();
  if (sourceAt) manifest.LastWorkshopUpdateTimeUtc = new Date(sourceAt).toISOString();
  try {
    // Tabs, because that is how the mod manager writes it and this file has to
    // keep reading as the manager's own record rather than something rewritten.
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, '\t')}\n`);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true, at: now.getTime() };
}

// Do it. The plan is re-read rather than trusted: it was made before the server
// stopped, and a file that changed in between should not be overwritten on the
// strength of a stale answer.
//
// `backupRoot` is a folder in the dashboard's own data dir, not in the game --
// the mod manager's habit of leaving config.ini.bak-20260827 next to the file it
// replaced is how a mods folder fills up with things nothing will ever clean.
export function applyRefresh(plan, { backupRoot, stamp }) {
  const results = [];
  const backupDir = path.join(backupRoot, stamp);

  for (const mod of plan.mods) {
    if (!mod.ok) {
      results.push({ name: mod.name, ok: false, error: mod.error });
      continue;
    }

    const copied = [];
    const skipped = [];
    let failed = null;

    for (const f of mod.copy) {
      const from = path.join(mod.contentDir, f.src);
      const to = path.resolve(plan.installDir, f.dest);
      if (!fs.existsSync(from)) {
        skipped.push({ dest: f.dest, why: 'the Steam copy no longer has this file' });
        continue;
      }
      if (fs.existsSync(to) && identical(from, to)) {
        skipped.push({ dest: f.dest, why: 'already identical' });
        continue;
      }

      try {
        // Kept alongside the plan's own structure so a restore is a plain copy
        // back over the top: <backupRoot>\<stamp>\<mod>\<the same relative path>.
        if (fs.existsSync(to)) copyFile(to, path.join(backupDir, mod.name, f.dest));
        copyFile(from, to);
        copied.push({ dest: f.dest, bytes: f.bytes });
      } catch (err) {
        failed = `${f.dest}: ${err.message}`;
        break;
      }
    }

    if (failed) {
      results.push({ name: mod.name, ok: false, error: failed, copied, backupDir });
      continue;
    }

    const stamped = restamp(mod.manifestFile, mod.sourceAt);
    results.push({
      name: mod.name,
      ok: true,
      copied,
      skipped,
      guarded: mod.guarded,
      unmapped: mod.unmapped,
      restamped: stamped.ok,
      restampError: stamped.ok ? null : stamped.error,
      bytes: copied.reduce((n, f) => n + f.bytes, 0),
    });
  }

  const files = results.reduce((n, r) => n + (r.copied?.length || 0), 0);
  return {
    ok: results.every((r) => r.ok),
    mods: results,
    files,
    bytes: results.reduce((n, r) => n + (r.bytes || 0), 0),
    // Only when something was actually put there. An empty timestamped folder
    // per press is clutter that looks like a record of something.
    backupDir: files ? backupDir : null,
    failed: results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.error}`),
  };
}
