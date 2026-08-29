// Keeping a Paper server's plugins current.
//
// src/mcupdate.js updates the server jar and nothing else -- by design, and the
// panel says so. That left the other half of a Paper install unmanaged: eight
// jars in plugins\, each from a different publisher, each with its own idea of
// where a release lives. Geyser and Floodgate in particular are the ones you
// cannot afford to leave behind, because a Bedrock player's connection is what
// breaks when they fall behind the server.
//
// The shape is deliberately the same as mcupdate.js, because the risks are the
// same: download and verify with the server still up, then one stop, swap
// everything, start. N plugins cost one restart, not N.
//
// Two rules this does not bend:
//
//   Never guess a source. A plugin is matched to a publisher by an explicit
//   entry -- in config.json, or in the verified catalogue below -- and never by
//   searching for its name. Modrinth has a plugin called "veinminer" that is
//   NOT the VeinMiner installed here; a name-matching updater would quietly
//   replace one plugin with an unrelated one, which is worse than never
//   updating at all.
//
//   Never install an unverified file. Every provider here publishes a checksum
//   with its download, and a jar whose hash does not match is deleted rather
//   than installed. This is also how "is there an update?" is answered: the
//   published hash against the hash of the jar on disk. Version strings cannot
//   do that job -- Geyser has called itself "2.11.2-SNAPSHOT" across hundreds
//   of builds.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { download, compareVersions, mcPart } from './mcupdate.js';
import { readPluginJar } from './pluginjar.js';

const UA = 'ServerDashboard/1.0';
const API_TIMEOUT_MS = 20_000;

// Plugin releases are not frequent enough to justify hammering four APIs; this
// is the same six-hour default the workshop sweep uses.
const DEFAULT_CHECK_MINUTES = 360;

// Alerts land in the "mods" category, like the workshop ones, so that
// notifications.discord.mute can silence plugin noise without also silencing
// the server build updates in "update".
const CATEGORY = 'mods';

const FIRST_CHECK_MS = 40_000;

// How many superseded jars to keep per plugin. This is the whole rollback
// story: the jar that was running is copied here before it is replaced.
const KEEP_PREVIOUS = 3;

// --- the catalogue ----------------------------------------------------------

// Sources for plugins commonly found on a crossplay Paper server. Every entry
// here was checked against the publisher's own API and against the jar actually
// installed on this machine -- the filename and checksum matched -- because an
// entry that points at the wrong project is the one failure mode that matters.
//
// Keyed by the name in the plugin's own plugin.yml, lowercased. A target's
// pluginUpdates.sources overrides an entry; anything not listed either way has
// no source, is reported as such, and is never touched.
export const CATALOG = {
  'geyser-spigot': { provider: 'geyser', project: 'geyser', download: 'spigot' },
  floodgate: { provider: 'geyser', project: 'floodgate', download: 'spigot' },
  prism: { provider: 'hangar', project: 'Prism', platform: 'PAPER' },
  griefprevention: { provider: 'modrinth', project: 'griefprevention' },
  coordinates: { provider: 'modrinth', project: 'coordinates' },
  // Choco's VeinMiner, which publishes on GitHub. Note the anchored asset
  // pattern: the fabric jar sits in the same release.
  veinminer: { provider: 'github', repo: '2008Choco/VeinMiner', asset: '^VeinMiner-Bukkit-.*\\.jar$' },
  nbtapi: { provider: 'github', repo: 'tr7zw/Item-NBT-API', asset: '^item-nbt-api-plugin-.*\\.jar$' },
  // ^ anchored so it cannot match the release's "original-TPA-x.y.z.jar".
  tpa: { provider: 'github', repo: 'WarSkyGod/TPA', asset: '^TPA-.*\\.jar$' },
};

// --- http -------------------------------------------------------------------

async function getJson(url, { accept = 'application/json' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: accept },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, error: `${new URL(url).host} returned HTTP ${res.status}` };
    return { ok: true, body: await res.json() };
  } catch (err) {
    const why = err.name === 'AbortError' ? `timed out after ${API_TIMEOUT_MS / 1000}s` : err.message;
    return { ok: false, error: `could not reach ${new URL(url).host} — ${why}` };
  } finally {
    clearTimeout(timer);
  }
}

function sha256(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toLowerCase();
  } catch {
    return null;
  }
}

// --- providers --------------------------------------------------------------
//
// Each returns the same shape, so everything downstream is provider-agnostic:
//
//   { ok, version, fileName, url, sha256|sha1, gameVersions[], publishedAt }
//
// gameVersions is what the publisher says the release supports. It is advisory:
// a plugin can be perfectly happy on a version it has not got round to listing
// (every plugin here still lists 1.21.11 while the server runs 26.2), so it is
// reported rather than enforced -- see requireGameVersion.

// GeyserMC's own build server. Rolling builds with no meaningful version string,
// so the build number is the version and the published sha256 is the truth.
async function fromGeyser(src) {
  const project = src.project || 'geyser';
  const want = src.download || 'spigot';
  const base = `https://download.geysermc.org/v2/projects/${encodeURIComponent(project)}`;
  const res = await getJson(`${base}/versions/latest/builds/latest`);
  if (!res.ok) return res;

  const b = res.body;
  const file = b.downloads?.[want];
  if (!file?.name) return { ok: false, error: `GeyserMC published no "${want}" download for ${project}` };

  return {
    ok: true,
    version: `${b.version}-b${b.build}`,
    fileName: file.name,
    url: `${base}/versions/latest/builds/latest/downloads/${encodeURIComponent(want)}`,
    sha256: file.sha256 ?? null,
    gameVersions: [],
    publishedAt: b.time ? Date.parse(b.time) : null,
  };
}

// Modrinth. Versions come newest-first already filtered to the loader, so the
// game-version preference is applied here rather than by refetching.
async function fromModrinth(src, { loader = 'paper', gameVersion = null } = {}) {
  if (!src.project) return { ok: false, error: 'modrinth source has no project slug' };
  const url = `https://api.modrinth.com/v2/project/${encodeURIComponent(src.project)}/version`
    + `?loaders=${encodeURIComponent(JSON.stringify([src.loader || loader]))}`;
  const res = await getJson(url);
  if (!res.ok) return res;
  if (!Array.isArray(res.body) || !res.body.length) {
    return { ok: false, error: `Modrinth lists no ${src.loader || loader} builds for ${src.project}` };
  }

  const pick = (gameVersion && res.body.find((v) => v.game_versions?.includes(gameVersion))) || res.body[0];
  const file = pick.files?.find((f) => f.primary) || pick.files?.[0];
  if (!file?.url) return { ok: false, error: `Modrinth version ${pick.version_number} has no downloadable file` };

  return {
    ok: true,
    version: pick.version_number,
    fileName: file.filename,
    url: file.url,
    sha512: file.hashes?.sha512 ?? null,
    sha1: file.hashes?.sha1 ?? null,
    gameVersions: pick.game_versions ?? [],
    publishedAt: pick.date_published ? Date.parse(pick.date_published) : null,
  };
}

// Hangar, PaperMC's own plugin host. A version can carry an externalUrl instead
// of a download -- the file lives somewhere Hangar does not host and publishes
// no checksum -- and that is refused rather than fetched blind.
async function fromHangar(src, { gameVersion = null } = {}) {
  if (!src.project) return { ok: false, error: 'hangar source has no project name' };
  const platform = src.platform || 'PAPER';
  const url = `https://hangar.papermc.io/api/v1/projects/${encodeURIComponent(src.project)}/versions?limit=10`;
  const res = await getJson(url);
  if (!res.ok) return res;

  const versions = res.body?.result;
  if (!Array.isArray(versions) || !versions.length) {
    return { ok: false, error: `Hangar lists no versions for ${src.project}` };
  }

  const supports = (v) => v.platformDependencies?.[platform]?.includes(gameVersion);
  const pick = (gameVersion && versions.find((v) => v.downloads?.[platform] && supports(v)))
    || versions.find((v) => v.downloads?.[platform]);
  if (!pick) return { ok: false, error: `Hangar has no ${platform} build of ${src.project}` };

  const dl = pick.downloads[platform];
  if (!dl.downloadUrl) {
    return { ok: false, error: `${src.project} ${pick.name} is hosted off Hangar (${dl.externalUrl || 'external link'}), which publishes no checksum — install it by hand` };
  }

  return {
    ok: true,
    version: pick.name,
    fileName: dl.fileInfo?.name || `${src.project}-${pick.name}.jar`,
    url: dl.downloadUrl,
    sha256: dl.fileInfo?.sha256Hash ?? null,
    gameVersions: pick.platformDependencies?.[platform] ?? [],
    publishedAt: pick.createdAt ? Date.parse(pick.createdAt) : null,
  };
}

// GitHub releases. `asset` is a regex because a release usually carries more
// than one jar -- a fabric build, a sources jar, a shaded "original-" copy --
// and picking the wrong one installs a plugin the server cannot load.
async function fromGithub(src) {
  if (!src.repo) return { ok: false, error: 'github source has no repo' };
  const url = `https://api.github.com/repos/${src.repo}/releases/latest`;
  const res = await getJson(url, { accept: 'application/vnd.github+json' });
  if (!res.ok) return res;

  const rel = res.body;
  if (!rel?.tag_name) return { ok: false, error: `no published release for ${src.repo}` };

  let re;
  try {
    re = new RegExp(src.asset || '\\.jar$', 'i');
  } catch (err) {
    return { ok: false, error: `asset pattern is not a valid regular expression: ${err.message}` };
  }

  const assets = (rel.assets || []).filter((a) => re.test(a.name));
  if (!assets.length) {
    return { ok: false, error: `release ${rel.tag_name} has no asset matching ${re} (found ${(rel.assets || []).map((a) => a.name).join(', ') || 'nothing'})` };
  }
  if (assets.length > 1) {
    return { ok: false, error: `asset pattern ${re} matches ${assets.length} files in ${rel.tag_name} (${assets.map((a) => a.name).join(', ')}) — make it more specific` };
  }

  const asset = assets[0];
  // GitHub publishes "sha256:<hex>" per asset. Older releases predate it, and
  // those are still installable -- just by length rather than by digest.
  const digest = typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')
    ? asset.digest.slice(7).toLowerCase()
    : null;

  return {
    ok: true,
    version: String(rel.tag_name).replace(/^v/i, ''),
    fileName: asset.name,
    url: asset.browser_download_url,
    sha256: digest,
    size: asset.size ?? null,
    gameVersions: [],
    publishedAt: rel.published_at ? Date.parse(rel.published_at) : null,
  };
}

// A fixed link, for a publisher with no API. There is no version to read and
// usually no checksum, so "is there an update?" can only be answered by
// downloading and comparing -- which is why this one is last and opt-in.
async function fromUrl(src) {
  if (!src.url) return { ok: false, error: 'url source has no url' };
  return {
    ok: true,
    version: null,
    fileName: src.fileName || path.basename(new URL(src.url).pathname) || 'plugin.jar',
    url: src.url,
    sha256: src.sha256 ?? null,
    gameVersions: [],
    publishedAt: null,
    // With a checksum in the config this behaves like any other source: the
    // hash on disk answers "is it current?" and the download is verified
    // against it. Without one there is nothing to compare and nothing to
    // verify, which is a state this reports rather than papers over.
    opaque: !src.sha256,
  };
}

const PROVIDERS = {
  geyser: fromGeyser,
  modrinth: fromModrinth,
  hangar: fromHangar,
  github: fromGithub,
  url: fromUrl,
};

export function resolveLatest(src, ctx) {
  const fn = PROVIDERS[src?.provider];
  if (!fn) {
    return Promise.resolve({
      ok: false,
      error: `unknown plugin update provider "${src?.provider}" — expected one of ${Object.keys(PROVIDERS).join(', ')}`,
    });
  }
  return fn(src, ctx);
}

// --- the updater ------------------------------------------------------------

export class PluginUpdates {
  constructor(config, monitor, dataDir) {
    this.config = config;
    this.monitor = monitor;
    this.actions = null;
    this.otherBusy = null;
    this.store = path.join(dataDir || 'data', 'plugin-updates');
    this.state = new Map();   // id -> { phase, checkedAt, error, plugins: [] }
    this.busy = new Set();
    this.checkMinutes = Math.max(15, Number(config.plugins?.checkMinutes) || DEFAULT_CHECK_MINUTES);
  }

  // otherBusy is the server-jar updater's lock. The two must never run at once:
  // both stop the server and write into the same install, and the loser of that
  // race would be starting a server the winner is halfway through updating.
  attach({ actions, otherBusy } = {}) {
    this.actions = actions ?? this.actions;
    this.otherBusy = otherBusy ?? this.otherBusy;
  }

  // What this target's plugin updates look like, or null if it has none. Opt-in
  // per target, and only for a Paper-shaped server: a vanilla jar has no
  // plugins folder, and there would be nothing to update.
  settings(id) {
    const t = this.config.targets.find((x) => x.id === id);
    if (!t || t.kind !== 'game' || t.game !== 'minecraft') return null;

    const pu = t.pluginUpdates ?? {};
    if (pu.enabled === false) return null;
    if (!t.startCommand && !pu.dir) return null;

    const installDir = t.startCommand ? path.dirname(path.resolve(String(t.startCommand).replace(/\//g, '\\'))) : null;
    const dir = pu.dir ?? (installDir ? path.join(installDir, 'plugins') : null);
    if (!dir) return null;

    return {
      dir,
      installDir,
      auto: Boolean(pu.auto),
      // The catalogue supplies the sources nobody should have to write out;
      // config.json overrides any of them, and `false` switches one off.
      sources: { ...CATALOG, ...lowerKeys(pu.sources ?? {}) },
      // Off by default. Every plugin on this box still lists 1.21.11 as its
      // newest supported version while the server runs 26.2, so refusing
      // anything that does not name the running version would refuse
      // everything. It is reported instead, on the entry it applies to.
      requireGameVersion: Boolean(pu.requireGameVersion),
      loader: pu.loader || 'paper',
    };
  }

  managed(id) {
    const s = this.settings(id);
    return Boolean(s && fs.existsSync(s.dir));
  }

  target(id) {
    const t = this.config.targets.find((x) => x.id === id);
    if (!t) throw new Error(`unknown target: ${id}`);
    return t;
  }

  #set(id, patch) {
    this.state.set(id, { ...(this.state.get(id) || {}), ...patch });
  }

  snapshot() {
    const out = {};
    for (const [id, v] of this.state) out[id] = v;
    return out;
  }

  // Which Minecraft version the server is on, for the game-version preference.
  // The monitor already knows it from the RCON version line ("paper 26.2-120"),
  // and an unknown version is not an error -- it only means the preference
  // cannot be applied and the newest build wins.
  #gameVersion(id) {
    const v = this.monitor.state?.get(id)?.version;
    if (!v) return null;
    const last = String(v).trim().split(/\s+/).pop();
    return mcPart(last);
  }

  // --- checking -------------------------------------------------------------

  // What is installed, from the jars themselves. Same reading as the Plugins
  // panel, kept here rather than imported from src/mods.js because this one
  // needs the file path and the hash, which the panel has no use for.
  #installed(dir) {
    let names;
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.jar'))
        .map((e) => e.name);
    } catch (err) {
      return { ok: false, error: `could not read ${dir}: ${err.message}` };
    }

    const rows = names.map((file) => {
      const full = path.join(dir, file);
      const meta = readPluginJar(full) || {};
      return {
        name: meta.name || file.replace(/\.jar$/i, ''),
        file,
        path: full,
        version: meta.version ?? null,
      };
    });
    return { ok: true, rows };
  }

  async check(id, { force = false } = {}) {
    const s = this.settings(id);
    if (!s) return { ok: false, error: 'this target has no plugin updates to check' };

    const found = this.#installed(s.dir);
    if (!found.ok) {
      this.#set(id, { error: found.error, checkedAt: Date.now() });
      return { ok: false, error: found.error };
    }

    const gameVersion = this.#gameVersion(id);
    const plugins = [];

    for (const row of found.rows) {
      const src = s.sources[row.name.toLowerCase()];
      if (!src || src === false) {
        plugins.push({
          ...row,
          source: null,
          status: 'unmanaged',
          why: 'no update source is configured for this plugin, so the dashboard will never touch it',
        });
        continue;
      }

      const latest = await resolveLatest(src, { loader: s.loader, gameVersion });
      if (!latest.ok) {
        plugins.push({ ...row, source: src.provider, status: 'error', why: latest.error });
        continue;
      }

      // The published checksum against the jar on disk. This is exact where a
      // version string is not: it catches a rebuilt jar under an unchanged
      // version, and it does not cry wolf when a publisher renames a release.
      const digest = latest.sha256 ? sha256(row.path) : null;
      const sameFile = Boolean(latest.sha256 && digest && digest === String(latest.sha256).toLowerCase());

      // Falls back to versions where there is no checksum to compare. An equal
      // or newer installed version is current; only a genuinely older one is an
      // update, so a hand-built jar ahead of the release is left alone.
      // A source with neither a version nor a checksum cannot answer the
      // question at all. Saying "current" there would be a claim about a file
      // nobody compared, so it gets its own state and is never auto-installed.
      if (latest.opaque) {
        plugins.push({
          ...row,
          source: src.provider,
          status: 'unknown',
          why: 'this source publishes no version and no checksum, so the dashboard cannot tell '
            + 'whether it is current — add a sha256 to the source, or update it by hand',
        });
        continue;
      }

      let outdated;
      if (latest.sha256) {
        outdated = !sameFile;
      } else if (row.version && latest.version) {
        const cmp = compareVersions(latest.version, row.version);
        outdated = cmp === null ? row.version !== latest.version : cmp > 0;
      } else {
        outdated = row.version !== latest.version;
      }

      const declares = !latest.gameVersions?.length || !gameVersion
        || latest.gameVersions.includes(gameVersion);

      plugins.push({
        ...row,
        source: src.provider,
        latestVersion: latest.version,
        latestFile: latest.fileName,
        publishedAt: latest.publishedAt,
        gameVersions: latest.gameVersions ?? [],
        declaresGameVersion: declares,
        status: outdated ? (declares || !s.requireGameVersion ? 'outdated' : 'blocked') : 'current',
        why: outdated && !declares
          ? `the newest release (${latest.version}) does not list ${gameVersion} among the Minecraft versions it supports`
          : null,
      });
    }

    const outdated = plugins.filter((p) => p.status === 'outdated');
    this.#set(id, {
      checkedAt: Date.now(),
      error: null,
      plugins,
      outdated: outdated.map((p) => `${p.name} ${p.version ?? '?'} → ${p.latestVersion}`),
      gameVersion,
    });

    return {
      ok: true,
      checkedAt: Date.now(),
      gameVersion,
      plugins,
      updateAvailable: outdated.length > 0,
      outdated: outdated.length,
      errors: plugins.filter((p) => p.status === 'error').length,
      forced: force,
    };
  }

  // --- installing -----------------------------------------------------------

  // Everything outdated, in one restart. Downloads happen with the server up;
  // the stop is taken once, after every jar is on disk and verified.
  async begin(id, { force = false, only = null } = {}) {
    const s = this.settings(id);
    if (!s) return { ok: false, error: 'this target has no plugins the dashboard can update' };
    if (!this.actions) return { ok: false, error: 'dashboard is still starting up' };
    if (this.busy.has(id)) return { ok: false, error: 'a plugin update is already running for this server' };
    if (this.otherBusy?.(id)) return { ok: false, error: 'the server is being updated right now — try again when that has finished' };

    const t = this.target(id);
    this.busy.add(id);
    try {
      this.#set(id, { phase: 'checking' });
      const found = await this.check(id, { force: true });
      if (!found.ok) { this.#set(id, { phase: 'idle' }); return found; }

      const wanted = found.plugins.filter((p) => p.status === 'outdated'
        && (!only?.length || only.includes(p.name)));
      if (!wanted.length) {
        this.#set(id, { phase: 'idle' });
        this.monitor.addAlert('info', id,
          `Checked plugins — all ${found.plugins.length} are current`, CATEGORY);
        return { ok: true, updated: [], updateAvailable: false, checked: found.plugins.length };
      }

      this.monitor.addAlert('warn', id,
        `${wanted.length} plugin update(s) available (${wanted.map((p) => p.name).join(', ')}) — `
        + 'downloading now; the server stays up until they have arrived', CATEGORY);

      // --- download and verify, server still running --------------------------
      this.#set(id, { phase: 'downloading' });
      const staged = [];
      const failed = [];
      const gameVersion = found.gameVersion;

      for (const p of wanted) {
        const src = s.sources[p.name.toLowerCase()];
        const latest = await resolveLatest(src, { loader: s.loader, gameVersion });
        if (!latest.ok) { failed.push({ name: p.name, error: latest.error }); continue; }

        const dest = path.join(this.store, id, 'incoming', latest.fileName);
        // Which digest to compute is decided by which one the publisher
        // advertises: Modrinth signs with sha512, everyone else with sha256.
        const algorithm = latest.sha256 ? 'sha256' : latest.sha512 ? 'sha512' : 'sha1';
        const expected = latest.sha256 ?? latest.sha512 ?? latest.sha1 ?? null;

        const got = await download(latest.url, dest, { algorithm });
        if (!got.ok) { failed.push({ name: p.name, error: got.error }); continue; }

        if (expected && got.digest.toLowerCase() !== String(expected).toLowerCase()) {
          try { fs.unlinkSync(dest); } catch { /* already gone */ }
          failed.push({
            name: p.name,
            error: `the download did not match its published ${algorithm} checksum — it was not installed`,
          });
          continue;
        }
        if (!expected) {
          // Worth saying once per install rather than never: it is the one case
          // where "verified" would be a claim this cannot make.
          this.monitor.addAlert('warn', id,
            `${p.name} ${latest.version} was downloaded from ${p.source} without a published checksum — `
            + 'installed unverified', CATEGORY);
        }

        staged.push({ plugin: p, latest, file: dest });
      }

      for (const f of failed) {
        this.monitor.addAlert('error', id, `Plugin update failed for ${f.name}: ${f.error}`, CATEGORY);
      }

      if (!staged.length) {
        this.#set(id, { phase: 'idle' });
        return { ok: false, error: 'nothing could be downloaded', failed, updated: [] };
      }

      // --- one stop, all swaps, one start ------------------------------------
      this.monitor.suppress(id, true);
      try {
        this.#set(id, { phase: 'stopping' });
        const stopped = await this.actions.stop(id).catch((err) => ({ ok: false, error: err.message }));
        if (!stopped.ok) {
          for (const st of staged) this.#discard(st.file);
          this.#set(id, { phase: 'idle', error: stopped.error });
          this.monitor.addAlert('error', id,
            `Plugin update aborted — the server would not stop: ${stopped.error}`, CATEGORY);
          return { ok: false, error: `stop failed: ${stopped.error}`, updated: [] };
        }

        // The server is down and the world is at rest. A plugin update can
        // change how a plugin stores its data, and that is not always
        // reversible by putting the old jar back.
        let backup = null;
        if (t.backup?.enabled && t.backup?.beforeRestart && this.actions.backups) {
          backup = await this.actions.backups.run(id, { reason: 'before plugin update', save: false });
          if (!backup.ok) {
            this.monitor.addAlert('warn', id,
              `Pre-update backup failed, continuing with the update: ${backup.error}`, 'backup');
          }
        }

        this.#set(id, { phase: 'installing' });
        const updated = [];
        for (const st of staged) {
          const res = this.#swap(id, s, st);
          if (res.ok) updated.push(res);
          else {
            failed.push({ name: st.plugin.name, error: res.error });
            this.monitor.addAlert('error', id,
              `Could not install ${st.plugin.name}: ${res.error}`, CATEGORY);
          }
        }

        this.#set(id, { phase: 'starting' });
        // Started either way, for the reason mcupdate.js gives: a server that is
        // down needs a person, and a server that is up on an imperfect install
        // at least has a log to read.
        const started = await this.actions.start(id).catch((err) => ({ ok: false, error: err.message }));
        if (!started.ok) {
          this.monitor.addAlert('error', id,
            `Plugins updated, but the server would not start: ${started.error}`, CATEGORY);
        } else if (updated.length) {
          this.monitor.addAlert('info', id,
            `Updated ${updated.length} plugin(s): `
            + `${updated.map((u) => `${u.name} ${u.from ?? '?'} → ${u.to}`).join(', ')}. `
            + 'The jars they replaced are kept in the dashboard data folder. Starting the server.',
            CATEGORY);
        }

        this.#set(id, { phase: 'idle' });
        await this.check(id, { force: true }).catch(() => {});

        return {
          ok: updated.length > 0,
          updated,
          failed,
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

  // One plugin, with the server stopped: keep the old jar, write the new one,
  // remove the old one only once the new one is in place.
  //
  // The old jar is deleted rather than left behind, and that is the whole
  // reason this cannot be a plain copy: a release usually renames the file
  // (VeinMiner-Bukkit-2.4.0.jar -> 2.5.0.jar), and two jars declaring the same
  // plugin name is a server that loads one of them and refuses the other.
  #swap(id, s, { plugin, latest, file }) {
    const keepDir = path.join(this.store, id, 'previous');
    const kept = path.join(keepDir, `${plugin.file}.${Date.now()}.bak`);
    const dest = path.join(s.dir, latest.fileName);

    try {
      fs.mkdirSync(keepDir, { recursive: true });
      fs.copyFileSync(plugin.path, kept);
    } catch (err) {
      return { ok: false, error: `could not set the current jar aside first: ${err.message}` };
    }

    try {
      fs.copyFileSync(file, dest);
    } catch (err) {
      return { ok: false, error: `could not write ${latest.fileName}: ${err.message}` };
    }

    // Only now is it safe to remove the old one: if the write above failed, the
    // server still has a working plugin to start with.
    if (path.resolve(dest).toLowerCase() !== path.resolve(plugin.path).toLowerCase()) {
      try {
        fs.unlinkSync(plugin.path);
      } catch (err) {
        // Both jars are now in the folder, which is the duplicate the Plugins
        // panel flags. Say so plainly -- it needs a person and one deletion.
        this.monitor.addAlert('warn', id,
          `${plugin.name} was updated, but the old ${plugin.file} could not be deleted (${err.message}). `
          + 'Two jars now declare this plugin — delete the old one before the next restart.', CATEGORY);
      }
    }

    this.#discard(file);
    this.#prune(keepDir, plugin.file);

    return {
      ok: true,
      name: plugin.name,
      from: plugin.version,
      to: latest.version,
      file: latest.fileName,
      replaced: plugin.file,
      previous: kept,
    };
  }

  #discard(file) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }

  #prune(dir, base) {
    try {
      const old = fs.readdirSync(dir)
        .filter((f) => f.startsWith(`${base}.`) && f.endsWith('.bak'))
        .map((f) => ({ f, at: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.at - a.at)
        .slice(KEEP_PREVIOUS);
      for (const { f } of old) fs.unlinkSync(path.join(dir, f));
    } catch { /* a jar we could not prune costs disk, not correctness */ }
  }

  // --- background sweep -----------------------------------------------------

  async #sweep() {
    for (const t of this.config.targets) {
      if (!this.managed(t.id) || this.busy.has(t.id)) continue;
      if (this.otherBusy?.(t.id)) continue;

      const res = await this.check(t.id).catch(() => null);
      if (!res?.ok || !res.updateAvailable) continue;

      const s = this.settings(t.id);
      const names = res.plugins.filter((p) => p.status === 'outdated')
        .map((p) => `${p.name} ${p.version ?? '?'} → ${p.latestVersion}`);
      const key = names.join('|');

      if (s?.auto) {
        // Installing means restarting, and a restart nobody asked for is an
        // outage. Only a confirmed empty server gets updated; anything else
        // waits for a later sweep. An unknown player count is not empty.
        const online = this.monitor.state.get(t.id)?.playerCount ?? null;
        if (online === 0) {
          this.#set(t.id, { notified: key });
          this.monitor.addAlert('info', t.id,
            `${names.length} plugin update(s) available and nobody is online — updating now`, CATEGORY);
          await this.begin(t.id).catch((err) => {
            this.monitor.addAlert('error', t.id, `Automatic plugin update failed: ${err.message}`, CATEGORY);
          });
          continue;
        }
        if (this.state.get(t.id)?.notified === key) continue;
        this.#set(t.id, { notified: key });
        this.monitor.addAlert('warn', t.id,
          `Plugin updates available — ${names.join(', ')}. `
          + `${online === null ? 'The player count cannot be read' : `${online} player(s) online`}, `
          + 'so they will be installed automatically once the server is empty.', CATEGORY);
        continue;
      }

      if (this.state.get(t.id)?.notified === key) continue;
      this.#set(t.id, { notified: key });
      this.monitor.addAlert('warn', t.id,
        `Plugin updates available — ${names.join(', ')}. `
        + 'Press "Update plugins" on the card when you want them installed.', CATEGORY);
    }
  }

  start() {
    const tick = () => this.#sweep().catch((err) => console.error('[plugins]', err.message));
    this.first = setTimeout(tick, FIRST_CHECK_MS);
    this.first.unref?.();
    this.timer = setInterval(tick, this.checkMinutes * 60_000);
    this.timer.unref?.();
  }

  stop() {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }

  // What the Plugins panel shows on each row, merged in by server.js. Kept here
  // so src/mods.js stays a pure read of the folder and knows nothing about
  // publishers or the network.
  annotate(id, mods) {
    const st = this.state.get(id);
    if (!st?.plugins?.length || !Array.isArray(mods)) return mods;

    const by = new Map(st.plugins.map((p) => [p.file.toLowerCase(), p]));
    for (const m of mods) {
      const p = by.get(String(m.file || '').toLowerCase());
      if (!p) continue;
      m.source = p.source;
      m.latestVersion = p.latestVersion ?? null;
      if (p.status === 'outdated') {
        m.status = 'stale';
        m.staleWhy = `${p.source} publishes ${p.latestVersion}, and this is ${p.version ?? 'an unknown version'}. `
          + 'Press "Update plugins" to install it — the server restarts once for all of them.';
      } else if (p.status === 'blocked' || (p.status === 'outdated' && p.why)) {
        m.staleWhy = p.why;
      } else if (p.status === 'error') {
        m.sourceError = p.why;
      }
    }
    return mods;
  }
}

function lowerKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k.toLowerCase()] = v;
  return out;
}
