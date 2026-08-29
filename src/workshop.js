// Knows which Steam Workshop mods are installed into a server, and which of
// them the Steam client has since fetched a newer copy of.
//
// This is deliberately detection only. The base game is safe to update
// unattended because app_update is atomic, verifiable and reversible: validate
// repairs a bad download, and the build id says unambiguously what you ended up
// with. A mod has none of that. It is built against a particular game build, it
// can take the server down on the first player join, and there is no validate
// to undo it. So the dashboard says "PalSchema has an update waiting" and a
// human decides -- which, for a modded server, is the whole safety margin.
//
// The two hops are worth keeping straight. The Steam *client* downloads
// workshop items and keeps them current on its own; a mod manager then installs
// them into the server folder. Only the second hop is manual, and it is the only
// one this file can see or report on.
//
// refresh() below performs that second hop, within limits set out in
// src/modinstall.js: it re-copies the files a mod already installed, from the
// item it already came from, and never decides for itself what a mod should
// install. Detection stays what it always was -- nothing here runs unattended,
// and the sweep still only ever raises a flag.
import fs from 'node:fs';
import path from 'node:path';

import { planRefresh, applyRefresh } from './modinstall.js';

// Where the Steam client keeps subscribed workshop items. Only the default
// library is checked: workshop content lives with the client, not with whatever
// library a given app was installed into.
const DEFAULT_WORKSHOP = 'C:\\Program Files (x86)\\Steam\\steamapps\\workshop';

// One entry in a channel's mute list keeps mod chatter out of chat while the
// activity feed still shows all of it. See notifications.* in config.json.
const CATEGORY = 'mods';

// Mods publish far less often than game builds, and nothing here acts on the
// answer anyway -- it is a notice, not a trigger.
const DEFAULT_CHECK_MINUTES = 360;

// Let the first status poll finish before adding disk reads to the same tick.
const FIRST_CHECK_MS = 20_000;

// Names the folder a refresh keeps the files it replaced in. Same shape the
// backup archives use, so two things you might go looking for after a bad mod
// update sort next to each other by eye.
const fileStamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// --- reading what Steam and the mod manager wrote ---------------------------

// Returns the body of "<key>" { ... } from a KeyValues file, brace-matched. The
// workshop acf carries the same item ids under two different sections with two
// different meanings, so taking one section by name is the whole point.
function section(text, key) {
  const at = text.indexOf(`"${key}"`);
  if (at === -1) return null;
  const open = text.indexOf('{', at);
  if (open === -1) return null;

  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

// workshopId -> when the copy ON DISK was last updated.
//
// This reads WorkshopItemsInstalled, not WorkshopItemDetails. Details carries
// the newest version Steam knows to *exist*, which is a different question: a
// mod published an hour ago that the client has not downloaded yet is not an
// update the mod manager could install, and alerting on it would send you to
// the mod manager to find nothing new there.
export function workshopSources(appId, workshopDir = null) {
  const dir = workshopDir || DEFAULT_WORKSHOP;
  const file = path.join(dir, `appworkshop_${appId}.acf`);
  if (!fs.existsSync(file)) {
    return { ok: false, error: `no appworkshop_${appId}.acf in ${dir} — is the Steam client subscribed to any mods?` };
  }

  let body;
  try {
    body = section(fs.readFileSync(file, 'utf8'), 'WorkshopItemsInstalled');
  } catch (err) {
    return { ok: false, error: `could not read ${path.basename(file)}: ${err.message}` };
  }
  if (body == null) return { ok: false, error: `${path.basename(file)} has no WorkshopItemsInstalled section` };

  const items = new Map();
  for (const m of body.matchAll(/"(\d{6,})"\s*\{([^{}]*)\}/g)) {
    const t = m[2].match(/"timeupdated"\s+"(\d+)"/i);
    if (t) items.set(m[1], Number(t[1]) * 1000);
  }
  return { ok: true, items };
}

// What the mod manager recorded when it installed each mod. Every managed mod
// carries an InstallManifest.json naming the workshop item it came from and when
// it was last written into the server.
//
// The install time comes from that file rather than from the mods' own file
// mtimes on purpose: copying a server folder preserves timestamps, so mtimes
// survive a migration and would report every mod as freshly installed on a box
// where nothing had been installed at all.
export function installedMods(modsDir) {
  if (!modsDir || !fs.existsSync(modsDir)) {
    return { ok: false, error: `no such mods folder: ${modsDir}` };
  }

  const mods = [];
  let entries;
  try {
    entries = fs.readdirSync(modsDir, { withFileTypes: true });
  } catch (err) {
    return { ok: false, error: `could not list ${modsDir}: ${err.message}` };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(modsDir, entry.name, 'InstallManifest.json');
    if (!fs.existsSync(file)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const at = Date.parse(j.LastInstallTimeUtc);
      mods.push({
        name: entry.name,
        workshopId: j.WorkshopId == null ? null : String(j.WorkshopId),
        installedAt: Number.isNaN(at) ? null : at,
      });
    } catch { /* a half-written manifest is not worth failing the sweep over */ }
  }
  return { ok: true, mods };
}

// --- the comparison ---------------------------------------------------------

// Joins the two sides on workshop id. Three outcomes per mod, kept distinct
// because they need different actions: current (nothing to do), stale (refresh
// it in the mod manager), and unsubscribed -- installed here but not subscribed
// in the Steam client, so it has no source and will never update again no
// matter how long you wait.
export function compare({ appId, modsDir, workshopDir = null }) {
  const src = workshopSources(appId, workshopDir);
  if (!src.ok) return src;
  const inst = installedMods(modsDir);
  if (!inst.ok) return inst;

  const mods = inst.mods.map((m) => {
    const sourceAt = m.workshopId ? src.items.get(m.workshopId) ?? null : null;
    let status;
    if (!m.workshopId || sourceAt == null) status = 'unsubscribed';
    else if (m.installedAt == null) status = 'unknown';
    else status = sourceAt > m.installedAt ? 'stale' : 'current';
    return { ...m, sourceAt, status };
  }).sort((a, b) => a.name.localeCompare(b.name));

  return {
    ok: true,
    mods,
    stale: mods.filter((m) => m.status === 'stale'),
    unsubscribed: mods.filter((m) => m.status === 'unsubscribed'),
    checkedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------

export class WorkshopMods {
  constructor(config, monitor, dataDir) {
    this.config = config;
    this.monitor = monitor;
    this.actions = null; // set by server.js — Actions is built after this
    this.state = new Map(); // id -> what the card should say
    this.busy = new Set();  // ids with a refresh in flight
    this.checkMinutes = config.workshop?.checkMinutes ?? DEFAULT_CHECK_MINUTES;
    // Replaced files are kept here rather than beside the originals. See the
    // note on applyRefresh in src/modinstall.js.
    this.backupRoot = path.join(dataDir || 'data', 'mod-backups');
  }

  attach({ actions }) {
    this.actions = actions ?? this.actions;
  }

  // A target opts in by carrying a workshopMods block. Anything else gets no
  // banner rather than a banner that only ever explains why it is empty.
  #settings(id) {
    const t = this.config.targets.find((x) => x.id === id);
    const w = t?.workshopMods;
    if (!w?.appId || !w?.modsDir) return null;
    return {
      appId: w.appId,
      modsDir: w.modsDir,
      workshopDir: w.workshopDir ?? null,
      // Where the copy would land. Absent means detection still works and
      // refreshing does not, which is a button hidden rather than a button that
      // fails when pressed.
      installDir: t.steamInstallDir ?? null,
    };
  }

  managed(id) {
    return Boolean(this.#settings(id));
  }

  // Refreshing needs somewhere to copy into and a way to bring the server back
  // up afterwards. Without both, the card keeps the notice and loses the button.
  canRefresh(id) {
    const s = this.#settings(id);
    if (!s?.installDir) return false;
    const t = this.config.targets.find((x) => x.id === id);
    return Boolean(t?.startCommand);
  }

  check(id) {
    const s = this.#settings(id);
    if (!s) return { ok: false, error: 'this target has no workshopMods block' };

    const res = compare(s);
    if (!res.ok) {
      this.state.set(id, { ...(this.state.get(id) || {}), error: res.error });
      return res;
    }
    this.state.set(id, {
      ...(this.state.get(id) || {}),
      total: res.mods.length,
      stale: res.stale.map((m) => m.name),
      unsubscribed: res.unsubscribed.map((m) => m.name),
      checkedAt: res.checkedAt,
      error: null,
    });
    return res;
  }

  // --- refreshing -------------------------------------------------------------

  // What pressing the button would do, with nothing written and the server left
  // alone. The confirmation reads from this, so what it promises and what
  // happens are the same code path -- a dialog that says "3 files" while the
  // operation copies eleven is worse than no dialog.
  plan(id, { names = null } = {}) {
    const s = this.#settings(id);
    if (!s) return { ok: false, error: 'this target has no workshopMods block' };
    if (!s.installDir) return { ok: false, error: 'this target has no steamInstallDir, so there is nowhere to copy into' };

    const res = compare(s);
    if (!res.ok) return res;

    // Only stale mods by default. A mod whose Steam copy has not moved has
    // nothing waiting for it, and re-copying it would be work with no reason.
    const stale = res.stale.map((m) => m.name);
    const wanted = names?.length ? names.filter((n) => res.mods.some((m) => m.name === n)) : stale;
    const sourceAt = Object.fromEntries(res.mods.map((m) => [m.name, m.sourceAt]));

    if (!wanted.length) {
      return { ok: true, stale, mods: [], files: 0, bytes: 0, nothingToDo: true, checkedAt: res.checkedAt };
    }

    const plan = planRefresh({
      appId: s.appId,
      modsDir: s.modsDir,
      workshopDir: s.workshopDir || DEFAULT_WORKSHOP,
      installDir: s.installDir,
      names: wanted,
      sourceAt,
    });
    return { ...plan, stale, requested: wanted, checkedAt: res.checkedAt };
  }

  // Stop the server, put the newer files in place, start it again.
  //
  // The stop is the part that makes this possible at all rather than a courtesy:
  // UE4SS.dll is loaded into the running server process and Windows will not let
  // anything replace a file that is mapped into a live process. So a refresh on
  // a running server is not a slower refresh, it is a half-written one.
  //
  // Nobody online is a precondition, not a preference -- the alternative is
  // dropping players to install something that was not urgent five minutes ago.
  // `force` exists because the operator can decide otherwise, and the button
  // says so before it sends it.
  async refresh(id, { names = null, force = false } = {}) {
    const s = this.#settings(id);
    if (!s) return { ok: false, error: 'this target has no workshopMods block' };
    if (!this.actions) return { ok: false, error: 'dashboard is still starting up' };
    if (this.busy.has(id)) return { ok: false, error: 'a mod refresh is already running for this server' };

    const plan = this.plan(id, { names });
    if (!plan.ok) return plan;

    if (plan.nothingToDo) {
      this.monitor.addAlert('info', id, 'Checked the Steam copies — every installed mod is already current', CATEGORY);
      return { ok: true, nothingToDo: true, files: 0, stale: [] };
    }

    this.busy.add(id);
    try {
      const stamp = fileStamp(new Date());
      const backupRoot = path.join(this.backupRoot, id);

      // Nothing to copy, but the mods still read as stale: the item was
      // republished with the same bytes, which the detector cannot see and this
      // can. Re-dating the install is the entire fix, and it needs no outage --
      // taking the server down to write a timestamp would be the wrong trade by
      // a wide margin.
      if (plan.files === 0) {
        const applied = applyRefresh(plan, { backupRoot, stamp });
        this.check(id);
        const names2 = applied.mods.filter((m) => m.ok).map((m) => m.name);
        this.monitor.addAlert('info', id,
          `Mods verified against the Steam copy — ${names2.join(', ') || 'nothing'} `
          + 'already matched it byte for byte, so the server was left running and the update flag cleared.',
          CATEGORY);
        return { ...applied, stopped: false, restarted: false, verifiedOnly: true, plan };
      }

      // Only a confirmed zero counts. A player count that cannot be read is not
      // an empty server, and this is the same rule the Steam auto-update sweep
      // uses for the same reason.
      const online = this.monitor.state.get(id)?.playerCount ?? null;
      if (!force && online !== 0) {
        return {
          ok: false,
          waiting: true,
          online,
          error: online === null
            ? 'the player count for this server cannot be read right now, so "nobody is online" cannot be confirmed'
            : `${online} player(s) are online — the server has to stop to replace mod files`,
        };
      }

      const label = plan.mods.filter((m) => m.ok && m.copy.length).map((m) => m.name).join(', ');
      this.monitor.addAlert('info', id,
        `Refreshing mods from Steam (${label}) — ${plan.files} file(s), stopping the server`, CATEGORY);

      // Held across the whole operation, so the minutes the server is down do
      // not read as a crash or wake the watchdog. Monitor#suppress counts holds,
      // so the stop and start inside take and release their own.
      this.monitor.suppress(id, true);
      try {
        const stopped = await this.actions.stop(id).catch((err) => ({ ok: false, error: err.message }));
        if (!stopped.ok) {
          this.monitor.addAlert('error', id, `Mod refresh aborted — the server would not stop: ${stopped.error}`, CATEGORY);
          return { ok: false, error: `stop failed: ${stopped.error}`, stopped: false };
        }

        const applied = applyRefresh(plan, { backupRoot, stamp });

        // Started either way. A refresh that copied four files out of five
        // leaves a server that is down and a person who has to work out what
        // happened; a server that is up on a known-imperfect install is at
        // worst the same mod problem, with the log to read it from.
        const started = await this.actions.start(id).catch((err) => ({ ok: false, error: err.message }));
        this.check(id);

        if (applied.ok) {
          this.monitor.addAlert('info', id,
            `Mods refreshed — ${applied.files} file(s) copied from Steam`
            + `${applied.backupDir ? `, previous copies kept in ${applied.backupDir}` : ''}`
            + `${started.ok ? ' — server restarted' : ''}. `
            + 'Check the mod loader log if anything misbehaves; a mod built for a newer game build can still crash the server.',
            CATEGORY);
        } else {
          this.monitor.addAlert('error', id,
            `Mod refresh finished with errors — ${applied.failed.join('; ')}`
            + `${applied.backupDir ? `. Previous copies are in ${applied.backupDir}` : ''}`,
            CATEGORY);
        }
        if (!started.ok) {
          this.monitor.addAlert('error', id, `Mods refreshed, but the server would not start: ${started.error}`, CATEGORY);
        }

        return { ...applied, stopped: true, restarted: started.ok, startError: started.ok ? null : started.error, plan };
      } finally {
        this.monitor.suppress(id, false);
      }
    } finally {
      this.busy.delete(id);
    }
  }

  // Only targets with something to say appear.
  snapshot() {
    const out = {};
    for (const [id, s] of this.state) {
      if (!s.error && !s.stale?.length && !s.unsubscribed?.length) continue;
      out[id] = s;
    }
    return out;
  }

  // One alert per mod per published version. This runs every few hours and a mod
  // can sit un-refreshed for weeks; re-announcing it every sweep would train you
  // to ignore the channel it lands in.
  #sweep() {
    for (const t of this.config.targets) {
      if (!this.managed(t.id)) continue;

      const res = this.check(t.id);
      if (!res.ok) continue;

      const announced = { ...(this.state.get(t.id)?.announced || {}) };
      const fresh = res.stale.filter((m) => announced[m.name] !== m.sourceAt);
      for (const m of res.stale) announced[m.name] = m.sourceAt;

      // Losing a subscription is a state change worth exactly one mention: the
      // mod keeps working, it just stops ever being updated again.
      const orphaned = res.unsubscribed.filter((m) => !(m.name in announced));
      for (const m of res.unsubscribed) announced[m.name] = 'unsubscribed';

      this.state.set(t.id, { ...(this.state.get(t.id) || {}), announced });

      if (fresh.length) {
        this.monitor.addAlert('warn', t.id,
          `Mod update${fresh.length > 1 ? 's' : ''} waiting — ${fresh.map((m) => m.name).join(', ')}. `
          + 'Steam has a newer copy than the one installed on the server; refresh it in your mod manager. '
          + 'Mods are never updated automatically, and one built for a newer game build can crash the server.',
          CATEGORY);
      }
      if (orphaned.length) {
        this.monitor.addAlert('warn', t.id,
          `Installed but not subscribed in Steam: ${orphaned.map((m) => m.name).join(', ')}. `
          + 'These keep working, but they will never receive an update.',
          CATEGORY);
      }
    }
  }

  start() {
    const tick = () => {
      try { this.#sweep(); } catch (err) { console.error('[workshop]', err.message); }
    };
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
