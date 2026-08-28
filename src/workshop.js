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
import fs from 'node:fs';
import path from 'node:path';

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
  constructor(config, monitor) {
    this.config = config;
    this.monitor = monitor;
    this.state = new Map(); // id -> what the card should say
    this.checkMinutes = config.workshop?.checkMinutes ?? DEFAULT_CHECK_MINUTES;
  }

  // A target opts in by carrying a workshopMods block. Anything else gets no
  // banner rather than a banner that only ever explains why it is empty.
  #settings(id) {
    const t = this.config.targets.find((x) => x.id === id);
    const w = t?.workshopMods;
    if (!w?.appId || !w?.modsDir) return null;
    return { appId: w.appId, modsDir: w.modsDir, workshopDir: w.workshopDir ?? null };
  }

  managed(id) {
    return Boolean(this.#settings(id));
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
