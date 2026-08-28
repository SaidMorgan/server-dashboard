// The mod inventory behind each card's "Mods" panel: what is actually installed
// into a server right now, what version, and whether the server will load it.
//
// This is the read side of modding. src/workshop.js answers one narrow question
// -- "has Steam fetched a newer copy of something installed here?" -- and raises
// a banner when the answer is yes. That is an alert, and by design it says
// nothing at all when everything is current, which is most of the time. It left
// the dashboard unable to answer the far more ordinary question: what is on this
// server? You had to go and look in the folder.
//
// Nothing here installs, enables, disables or removes anything. Same reasoning
// as workshop.js: a mod is built against one game build, can take the server
// down on the first player join, and has no `validate` to undo it. Reading is
// safe; writing is a decision a person makes in their mod manager.
//
// Two layouts are understood, because the two games on this box do it two
// different ways:
//
//   workshop -- a mod manager installs Steam Workshop items into one folder per
//               mod, each carrying an InstallManifest.json (what it wrote and
//               when) and usually an Info.json (name, version, author). This is
//               Palworld via its mod manager.
//   paks     -- an Unreal game that simply loads .pak files it finds in a mods
//               folder. There is no manifest, so the file itself is the record:
//               name, size, and when it was written. This is Icarus, and most
//               other UE dedicated servers with loose-file mod support.
import fs from 'node:fs';
import path from 'node:path';

import { compare } from './workshop.js';

// Unreal packages a mod as one or more of these. .pak is the content; .utoc and
// .ucas are the IoStore pair that newer engine versions split it into, and a mod
// shipped that way is three files that are one mod.
const PAK_EXTENSIONS = new Set(['.pak', '.utoc', '.ucas', '.sig']);

// A mods folder can sit next to a hundred thousand game files. Walking is
// bounded so a misconfigured dir (pointed at the install root, say) costs a
// truncated list rather than a stalled request.
const MAX_WALK_ENTRIES = 5000;

// --- where the mods are -----------------------------------------------------

// Resolves a profile-supplied relative path against the install folder. A
// profile ships candidates rather than one path because a game usually has more
// than one place it will load mods from, and only the user knows which one their
// mod manager writes to.
function resolveCandidates(target, candidates) {
  const root = target.steamInstallDir;
  if (!root || !Array.isArray(candidates)) return [];
  return candidates.map((rel) => path.resolve(root, rel));
}

// What this target's mods look like on disk, or null if it has no mod folder at
// all. Order matters: an explicit `mods` block in config.json is the operator
// saying where to look and beats everything, then the workshopMods block that
// already exists for the update check, then the game profile's own guess.
export function modSource(target, profile) {
  if (!target || target.kind !== 'game') return null;

  if (target.mods && target.mods.dir) {
    return {
      kind: target.mods.kind || 'paks',
      dir: target.mods.dir,
      candidates: [target.mods.dir],
      enabledFrom: target.mods.enabledFrom ?? null,
      note: target.mods.note ?? profile?.mods?.note ?? null,
      appId: target.workshopMods?.appId ?? null,
      workshopDir: target.workshopMods?.workshopDir ?? null,
      modsDir: target.mods.dir,
    };
  }

  if (target.workshopMods?.modsDir) {
    const enabled = profile?.mods?.enabledFrom;
    return {
      kind: 'workshop',
      dir: target.workshopMods.modsDir,
      candidates: [target.workshopMods.modsDir],
      appId: target.workshopMods.appId,
      workshopDir: target.workshopMods.workshopDir ?? null,
      modsDir: target.workshopMods.modsDir,
      // Which mods the server will actually load is a separate file from which
      // mods are installed, and the profile is what knows where it lives.
      enabledFrom: enabled && target.steamInstallDir
        ? { ...enabled, file: path.resolve(target.steamInstallDir, enabled.file) }
        : null,
      note: profile?.mods?.note ?? null,
    };
  }

  const guess = profile?.mods;
  if (guess?.candidates?.length) {
    const candidates = resolveCandidates(target, guess.candidates);
    if (!candidates.length) return null;
    // First one that exists wins; if none do, the first is still the answer to
    // "where would they go", which is what the empty panel should say.
    const found = candidates.find((d) => fs.existsSync(d));
    return {
      kind: guess.kind || 'paks',
      dir: found || candidates[0],
      candidates,
      exists: Boolean(found),
      enabledFrom: null,
      note: guess.note ?? null,
    };
  }

  return null;
}

// --- reading mod metadata ---------------------------------------------------

// Info.json is the mod's own description of itself, written by whoever built it.
// Everything in it is optional and none of it is trustworthy enough to fail over
// -- a mod with a malformed Info.json still loads, so it still gets listed.
function readInfo(dir) {
  const file = path.join(dir, 'Info.json');
  if (!fs.existsSync(file)) return {};
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      displayName: typeof j.ModName === 'string' ? j.ModName : null,
      version: typeof j.Version === 'string' ? j.Version : null,
      author: typeof j.Author === 'string' ? j.Author : null,
      dependencies: Array.isArray(j.Dependencies) ? j.Dependencies.filter((d) => typeof d === 'string') : [],
      tags: Array.isArray(j.Tags) ? j.Tags.filter((d) => typeof d === 'string') : [],
    };
  } catch {
    return {};
  }
}

// The mod's real footprint, from the file list its installer recorded rather
// than from the folder it is named after. A Palworld UE4SS mod keeps one
// Info.json in ManagedMods and its actual payload -- dlls, Lua, config -- under
// NativeMods, so measuring the named folder would report a 400-byte mod.
function measure(installDir, files) {
  if (!installDir || !Array.isArray(files) || !files.length) return null;
  let bytes = 0;
  let counted = 0;
  for (const rel of files) {
    if (typeof rel !== 'string') continue;
    try {
      bytes += fs.statSync(path.resolve(installDir, rel)).size;
      counted += 1;
    } catch { /* the manifest lists what was written, not what still exists */ }
  }
  return counted ? { bytes, files: counted } : null;
}

// Which mods the server will load, from a game's own mod settings file.
//
// Installed and enabled are genuinely different states, and the difference is
// the most common "why isn't my mod working": Palworld's PalModSettings.ini
// lists ActiveModList= once per enabled mod, and one commented-out line is a mod
// that is fully installed, up to date, and doing nothing. A card that only ever
// said "installed" would be no help at all with that.
export function readEnabled(spec) {
  if (!spec?.file || !fs.existsSync(spec.file)) return null;

  let text;
  try {
    text = fs.readFileSync(spec.file, 'utf8');
  } catch {
    return null;
  }

  const key = spec.key || 'ActiveModList';
  const names = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    // ; and # are both comment markers in the ini dialects UE games use, and a
    // disabled mod is normally left in the file as a commented line.
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at === -1) continue;
    if (line.slice(0, at).trim().toLowerCase() !== key.toLowerCase()) continue;
    const value = line.slice(at + 1).trim();
    if (value) names.add(value);
  }

  // One master switch turning every mod off is a state worth reporting on its
  // own: every mod still reads as enabled in the list below it.
  let globalOff = false;
  if (spec.globalKey) {
    const m = text.match(new RegExp(`^\\s*${spec.globalKey}\\s*=\\s*(\\w+)`, 'im'));
    if (m) globalOff = /^(false|0|no)$/i.test(m[1]);
  }

  return { names, globalOff, file: spec.file };
}

// --- the two readers --------------------------------------------------------

// A mod-manager install: one folder per mod, each with an InstallManifest.json.
// compare() does the Steam half (is a newer copy waiting?); this adds the half
// that matters when nothing is waiting -- name, version, author, size, and
// whether the server is set to load it.
function readWorkshop(source, target) {
  const res = compare({
    appId: source.appId,
    modsDir: source.modsDir,
    workshopDir: source.workshopDir,
  });
  if (!res.ok) return res;

  const enabled = readEnabled(source.enabledFrom);
  const installDir = target.steamInstallDir || null;

  const mods = res.mods.map((m) => {
    const dir = path.join(source.modsDir, m.name);
    const info = readInfo(dir);

    let manifestFiles = [];
    try {
      manifestFiles = JSON.parse(fs.readFileSync(path.join(dir, 'InstallManifest.json'), 'utf8')).Files || [];
    } catch { /* listed without a size rather than not listed */ }

    const size = measure(installDir, manifestFiles);

    return {
      name: m.name,
      displayName: info.displayName || m.name,
      version: info.version ?? null,
      author: info.author ?? null,
      dependencies: info.dependencies ?? [],
      tags: info.tags ?? [],
      workshopId: m.workshopId,
      installedAt: m.installedAt,
      sourceAt: m.sourceAt,
      status: m.status,
      // null, not false, when the game has no such file: "we cannot tell" and
      // "the server is ignoring this mod" must not look the same on the card.
      enabled: enabled ? enabled.names.has(m.name) : null,
      bytes: size?.bytes ?? null,
      fileCount: size?.files ?? null,
    };
  });

  return {
    ok: true,
    kind: 'workshop',
    dir: source.modsDir,
    mods,
    enabledFile: enabled?.file ?? null,
    globalOff: enabled?.globalOff ?? false,
    checkedAt: Date.now(),
  };
}

// Loose Unreal packages. No manifest, so the files are the whole record.
//
// Two shapes are treated as one mod: a folder holding pak files (what most mod
// distributions unzip to) and a bare pak sitting directly in the mods dir. The
// .utoc/.ucas/.sig siblings of a .pak are parts of it, not separate mods, so
// they are folded into the one entry.
function readPaks(source) {
  const dir = source.dir;
  if (!dir || !fs.existsSync(dir)) {
    return {
      ok: true,
      kind: 'paks',
      dir,
      mods: [],
      missing: true,
      candidates: source.candidates || [dir],
      checkedAt: Date.now(),
    };
  }

  const found = new Map(); // mod name -> { bytes, files, at }
  let seen = 0;

  const add = (name, file) => {
    let stat;
    try { stat = fs.statSync(file); } catch { return; }
    const cur = found.get(name) || { bytes: 0, files: 0, at: 0 };
    cur.bytes += stat.size;
    cur.files += 1;
    cur.at = Math.max(cur.at, stat.mtimeMs);
    found.set(name, cur);
  };

  const walk = (folder, modName, depth) => {
    if (depth > 3 || seen > MAX_WALK_ENTRIES) return;
    let entries;
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      seen += 1;
      if (seen > MAX_WALK_ENTRIES) return;
      const full = path.join(folder, e.name);
      if (e.isDirectory()) {
        walk(full, modName || e.name, depth + 1);
      } else if (PAK_EXTENSIONS.has(path.extname(e.name).toLowerCase())) {
        add(modName || path.basename(e.name, path.extname(e.name)), full);
      }
    }
  };

  let top;
  try {
    top = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return { ok: false, error: `could not list ${dir}: ${err.message}` };
  }

  for (const e of top) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, e.name, 1);
    else if (PAK_EXTENSIONS.has(path.extname(e.name).toLowerCase())) {
      add(path.basename(e.name, path.extname(e.name)), full);
    }
  }

  const mods = [...found]
    .map(([name, v]) => ({
      name,
      displayName: name,
      version: null,
      author: null,
      dependencies: [],
      tags: [],
      workshopId: null,
      installedAt: Math.round(v.at),
      sourceAt: null,
      // A loose pak has no upstream to compare against, so "current" would be a
      // claim this cannot make. It is present; that is all that is known.
      status: 'present',
      enabled: null,
      bytes: v.bytes,
      fileCount: v.files,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { ok: true, kind: 'paks', dir, mods, checkedAt: Date.now() };
}

// --- entry point ------------------------------------------------------------

// Everything the Mods panel needs for one target. Never throws: a mod folder
// that has been renamed or a drive that is offline is a message on the card, not
// a 500 on an endpoint that four other cards are also waiting on.
export function inventory(target, profile) {
  const source = modSource(target, profile);
  if (!source) {
    return { ok: true, configured: false, mods: [], note: profile?.mods?.note ?? null };
  }

  let res;
  try {
    res = source.kind === 'workshop' ? readWorkshop(source, target) : readPaks(source);
  } catch (err) {
    res = { ok: false, error: err.message };
  }

  if (!res.ok) {
    return { ok: false, configured: true, kind: source.kind, dir: source.dir, error: res.error, mods: [] };
  }

  const counts = {
    total: res.mods.length,
    stale: res.mods.filter((m) => m.status === 'stale').length,
    unsubscribed: res.mods.filter((m) => m.status === 'unsubscribed').length,
    disabled: res.mods.filter((m) => m.enabled === false).length,
  };

  return { ...res, configured: true, counts, note: source.note ?? null };
}
