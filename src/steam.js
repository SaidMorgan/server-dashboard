// Knows which build of a Steam-installed server is on disk, and which one Steam
// is currently offering.
//
// The dashboard deliberately does not download anything. These servers are
// installed by the Steam *client*, and pointing SteamCMD at the client's library
// gives you two programs each keeping their own record of what is installed —
// which is how a working install turns into a re-download at the worst moment.
//
// So the update is half automatic and half you. The dashboard notices the new
// build and clears the way by stopping the server; you press Update in Steam;
// the dashboard sees the files change underneath it and brings the server back
// up. Steam cannot patch files a running server holds open, so the stop is not
// politeness — it is the part that makes the update possible at all.
import fs from 'node:fs';
import path from 'node:path';

// --- tunables ---------------------------------------------------------------

// Where Steam installs by default. Any other library folder is discovered from
// libraryfolders.vdf, so a game moved to another drive still resolves.
const DEFAULT_LIBRARY = 'C:\\Program Files (x86)\\Steam\\steamapps';

// Public app info, anonymously readable. This is the same data SteamCMD's
// app_info_print returns, without needing SteamCMD installed.
const INFO_API = 'https://api.steamcmd.net/v1/info';
const INFO_TIMEOUT_MS = 8000;

// Every alert this file raises carries this category, so one entry in a
// channel's mute list keeps the whole feature out of chat while the dashboard's
// own activity feed still shows all of it. See notifications.* in config.json.
const CATEGORY = 'update';

// A published build id changes a few times a week at most, so a cached answer is
// nearly always the right one and several cards refreshing at once cost one call.
const INFO_CACHE_MS = 5 * 60_000;

// How often the manifest is re-read while waiting for you to run the update.
const WAIT_POLL_MS = 15_000;

// A finished-looking manifest has to look finished twice in a row before the
// server is started. Steam rewrites the file more than once as it finishes, and
// starting the server into a half-written install is the one outcome worth
// spending 15 seconds to avoid.
const SETTLE_POLLS = 2;

// Delay before the first background check, so a dashboard restart doesn't fire a
// burst of HTTP while the servers are still being polled for the first time.
const FIRST_CHECK_MS = 15_000;

// --- reading what Steam wrote ----------------------------------------------

// appmanifest_*.acf and libraryfolders.vdf are Valve's KeyValues format. Only a
// handful of scalar keys are needed here and each is unique within its file, so
// this reads them directly rather than dragging in a full VDF parser.
function readKey(text, key) {
  const m = text.match(new RegExp(`"${key}"\\s+"([^"]*)"`, 'i'));
  return m ? m[1] : null;
}

// Every steamapps folder on this machine: the default one, plus whatever
// libraryfolders.vdf lists. Missing folders are dropped rather than reported —
// a library on a drive that isn't plugged in is not an error, it just holds
// nothing we can see.
export function steamLibraries(extra = null) {
  const found = [];
  const add = (dir) => {
    if (!dir) return;
    const full = path.resolve(dir);
    if (!found.some((d) => d.toLowerCase() === full.toLowerCase()) && fs.existsSync(full)) found.push(full);
  };

  add(extra);
  add(DEFAULT_LIBRARY);

  try {
    const vdf = fs.readFileSync(path.join(DEFAULT_LIBRARY, 'libraryfolders.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/gi)) {
      add(path.join(m[1].replace(/\\\\/g, '\\'), 'steamapps'));
    }
  } catch { /* no library file: the default folder is the whole story */ }

  return found;
}

// The manifest is the file Steam updates when an install changes, which makes it
// both the record of what is installed and the signal that an update landed.
export function findManifest(appId, extra = null) {
  if (!appId) return null;
  for (const dir of steamLibraries(extra)) {
    const file = path.join(dir, `appmanifest_${appId}.acf`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

export function readManifest(file) {
  const text = fs.readFileSync(file, 'utf8');
  const num = (key) => {
    const raw = readKey(text, key);
    return raw == null || raw === '' ? null : Number(raw);
  };
  return {
    file,
    buildId: readKey(text, 'buildid'),
    name: readKey(text, 'name'),
    installDir: readKey(text, 'installdir'),
    bytesToDownload: num('BytesToDownload'),
    bytesDownloaded: num('BytesDownloaded'),
    // Recorded for the activity feed only. StateFlags is not used to decide
    // whether an update finished: on a healthy idle install here it reads 1542,
    // which claims an update is both required and running. Bytes and the build
    // id tell the truth.
    stateFlags: num('StateFlags'),
  };
}

// --- what Steam is offering -------------------------------------------------

const infoCache = new Map(); // appId -> {at, result}

export async function latestBuild(appId, { force = false } = {}) {
  const cached = infoCache.get(appId);
  if (!force && cached && Date.now() - cached.at < INFO_CACHE_MS) return cached.result;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INFO_TIMEOUT_MS);
  let result;
  try {
    const res = await fetch(`${INFO_API}/${appId}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const buildId = body?.data?.[appId]?.depots?.branches?.public?.buildid;
    result = buildId
      ? { ok: true, buildId: String(buildId) }
      : { ok: false, error: `Steam returned no public build for app ${appId}` };
  } catch (err) {
    result = {
      ok: false,
      error: err.name === 'AbortError' ? 'timed out asking Steam for the current build' : err.message,
    };
  } finally {
    clearTimeout(timer);
  }

  // Only good answers are cached: a failed lookup should be retried, not
  // remembered for five minutes.
  if (result.ok) infoCache.set(appId, { at: Date.now(), result });
  return result;
}

// ---------------------------------------------------------------------------
// The update flow
// ---------------------------------------------------------------------------

export class SteamUpdates {
  constructor(config, monitor, dataDir) {
    this.config = config;
    this.monitor = monitor;
    this.actions = null; // set by server.js — Actions is built after this
    this.state = new Map(); // id -> what the card should say
    this.waits = new Map(); // id -> {timer, installedBefore, deadline, settled}
    this.checkMinutes = config.steam?.checkMinutes ?? 360;
    this.waitMinutes = config.steam?.waitMinutes ?? 60;
    this.library = config.steam?.library ?? null;
    // A wait outlives a dashboard restart: the server is stopped and nothing
    // else is going to start it again.
    this.waitFile = path.join(dataDir, 'steam-waits.json');
  }

  attach({ actions }) {
    this.actions = actions ?? this.actions;
  }

  target(id) {
    const t = this.config.targets.find((x) => x.id === id);
    if (!t) throw new Error(`unknown target: ${id}`);
    return t;
  }

  // A target the dashboard can do this for: a Steam game whose manifest it can
  // actually find. Anything else (a non-Steam install, a game copied by hand)
  // gets no button rather than a button that only ever explains itself.
  manifestFor(id) {
    const t = this.config.targets.find((x) => x.id === id);
    if (!t || t.kind !== 'game' || !t.steamAppId) return null;
    return findManifest(t.steamAppId, t.steamLibrary || this.library);
  }

  managed(id) {
    return Boolean(this.manifestFor(id));
  }

  #set(id, patch) {
    this.state.set(id, { ...(this.state.get(id) || {}), ...patch });
  }

  // What the browser sees. Only targets with something to say appear.
  snapshot() {
    const out = {};
    for (const [id, s] of this.state) {
      if (s.phase === 'idle' && !s.updateAvailable && !s.error) continue;
      out[id] = s;
    }
    return out;
  }

  // Compare what is installed against what Steam is offering. No side effects —
  // both the button and the background sweep start here.
  async check(id, { force = false } = {}) {
    const t = this.target(id);
    if (t.kind !== 'game' || !t.steamAppId) {
      return { ok: false, error: 'this target is not a Steam install (no steamAppId)' };
    }

    const file = this.manifestFor(id);
    if (!file) {
      const error = `no appmanifest_${t.steamAppId}.acf in any Steam library — `
        + `set steamLibrary on this target if Steam lives somewhere unusual`;
      this.#set(id, { error });
      return { ok: false, error };
    }

    let installed;
    try {
      installed = readManifest(file).buildId;
    } catch (err) {
      const error = `could not read ${path.basename(file)}: ${err.message}`;
      this.#set(id, { error });
      return { ok: false, error };
    }

    const latest = await latestBuild(t.steamAppId, { force });
    if (!latest.ok) {
      this.#set(id, { installed, error: latest.error });
      return { ok: false, installed, error: latest.error };
    }

    const updateAvailable = Boolean(installed && latest.buildId && installed !== latest.buildId);
    this.#set(id, {
      phase: this.state.get(id)?.phase || 'idle',
      installed,
      latest: latest.buildId,
      updateAvailable,
      checkedAt: Date.now(),
      error: null,
    });
    return { ok: true, installed, latest: latest.buildId, updateAvailable };
  }

  // The button. Check first; if there is nothing to install, say so and leave the
  // server alone. If there is, stop the server and wait for you to press Update
  // in Steam.
  async begin(id) {
    const t = this.target(id);
    if (this.waits.has(id)) return { ok: false, error: 'already waiting for this update' };
    if (!this.actions) return { ok: false, error: 'dashboard is still starting up' };

    this.#set(id, { phase: 'checking' });
    const result = await this.check(id, { force: true });
    if (!result.ok) {
      this.#set(id, { phase: 'idle' });
      return result;
    }
    if (!result.updateAvailable) {
      this.#set(id, { phase: 'idle' });
      this.monitor.addAlert('info', id, `Checked Steam — already on the current build (${result.installed})`, CATEGORY);
      return { ok: true, updateAvailable: false, installed: result.installed, latest: result.latest };
    }

    this.monitor.addAlert('warn', id,
      `Steam build ${result.latest} is available (installed ${result.installed}) — stopping the server so you can update it`,
      CATEGORY);

    this.#set(id, { phase: 'stopping' });
    // Held for the whole wait, not just the stop. Monitor#suppress counts holds,
    // so the stop inside this one can take and release its own without ending
    // the blackout — a server that is meant to be down for twenty minutes must
    // not be reported as crashed, or restarted by the watchdog, at minute one.
    this.monitor.suppress(id, true);

    const stopped = await this.actions.stop(id).catch((err) => ({ ok: false, error: err.message }));
    if (!stopped.ok) {
      this.monitor.suppress(id, false);
      this.#set(id, { phase: 'idle', error: stopped.error });
      this.monitor.addAlert('error', id, `Update aborted — the server would not stop: ${stopped.error}`, CATEGORY);
      return { ok: false, error: `stop failed: ${stopped.error}` };
    }

    // The server is down and the world is at rest, and the next thing to touch
    // these files is a version change. This is the archive you want if the new
    // build turns out to be the problem.
    let backup = null;
    if (t.backup?.enabled && t.backup?.beforeRestart && this.actions.backups) {
      backup = await this.actions.backups.run(id, { reason: 'before Steam update', save: false });
      if (!backup.ok) {
        this.monitor.addAlert('warn', id, `Pre-update backup failed, still waiting for the update: ${backup.error}`, 'backup');
      }
    }

    this.#beginWait(id, { installedBefore: result.installed, deadline: Date.now() + this.waitMinutes * 60_000 });
    this.monitor.addAlert('info', id,
      `Stopped and waiting — update it in Steam now, and the server will start itself when the files change`,
      CATEGORY);

    return {
      ok: true,
      updateAvailable: true,
      waiting: true,
      installed: result.installed,
      latest: result.latest,
      backup: backup?.file ?? null,
    };
  }

  // Stop waiting. The server comes back on the build that is currently on disk,
  // whether or not that turned out to be the new one.
  async cancel(id, { reason = 'cancelled', level = 'info' } = {}) {
    const wait = this.waits.get(id);
    if (!wait) return { ok: false, error: 'not waiting for an update' };

    clearInterval(wait.timer);
    this.waits.delete(id);
    this.#persistWaits();
    this.#set(id, { phase: 'starting' });
    this.monitor.addAlert(level, id, `No longer waiting for the Steam update (${reason}) — starting the server`, CATEGORY);

    const started = await this.actions.start(id).catch((err) => ({ ok: false, error: err.message }));
    this.monitor.suppress(id, false);
    this.#set(id, {
      phase: 'idle', waitingSince: null, deadline: null,
      bytesDownloaded: null, bytesToDownload: null,
    });
    await this.check(id, { force: true }).catch(() => {});
    return { ok: started.ok, error: started.error };
  }

  // --- waiting ---------------------------------------------------------------

  #beginWait(id, { installedBefore, deadline }) {
    const timer = setInterval(() => this.#tick(id).catch((err) => {
      this.monitor.addAlert('warn', id, `Update watch hiccup: ${err.message}`, CATEGORY);
    }), WAIT_POLL_MS);
    timer.unref?.();

    this.waits.set(id, { timer, installedBefore, deadline, settled: 0 });
    this.#set(id, {
      phase: 'waiting',
      installed: installedBefore,
      waitingSince: Date.now(),
      deadline,
      error: null,
    });
    this.#persistWaits();
  }

  async #tick(id) {
    const wait = this.waits.get(id);
    if (!wait) return;

    if (Date.now() > wait.deadline) {
      await this.cancel(id, { reason: 'no update was installed in time', level: 'error' });
      return;
    }

    const file = this.manifestFor(id);
    if (!file) return; // Steam rewrites the manifest in place; a missed read is normal

    let manifest;
    try {
      manifest = readManifest(file);
    } catch {
      return;
    }

    const downloading = manifest.bytesToDownload != null
      && manifest.bytesDownloaded != null
      && manifest.bytesDownloaded < manifest.bytesToDownload;

    if (downloading) {
      wait.settled = 0;
      this.#set(id, {
        bytesDownloaded: manifest.bytesDownloaded,
        bytesToDownload: manifest.bytesToDownload,
      });
      return;
    }

    if (!manifest.buildId || manifest.buildId === wait.installedBefore) {
      wait.settled = 0;
      return;
    }

    // The build changed and nothing is left to download. Give Steam one more
    // poll to prove it, then bring the server back.
    wait.settled += 1;
    if (wait.settled < SETTLE_POLLS) return;

    clearInterval(wait.timer);
    this.waits.delete(id);
    this.#persistWaits();

    this.#set(id, {
      phase: 'starting',
      installed: manifest.buildId,
      updateAvailable: false,
      waitingSince: null,
      deadline: null,
      bytesDownloaded: null,
      bytesToDownload: null,
    });
    this.monitor.addAlert('info', id,
      `Steam finished updating (build ${wait.installedBefore} → ${manifest.buildId}) — starting the server`,
      CATEGORY);

    const started = await this.actions.start(id).catch((err) => ({ ok: false, error: err.message }));
    this.monitor.suppress(id, false);
    this.#set(id, { phase: 'idle' });
    if (!started.ok) {
      this.monitor.addAlert('error', id, `Update installed, but the server did not start: ${started.error}`, CATEGORY);
    }
    await this.check(id, { force: true }).catch(() => {});
  }

  // --- surviving a dashboard restart -----------------------------------------

  #persistWaits() {
    const rows = [...this.waits].map(([id, w]) => ({
      id, installedBefore: w.installedBefore, deadline: w.deadline,
    }));
    fs.writeFile(this.waitFile, JSON.stringify(rows), () => {});
  }

  #resumeWaits() {
    let rows = [];
    try {
      rows = JSON.parse(fs.readFileSync(this.waitFile, 'utf8'));
    } catch { return; }

    for (const row of rows) {
      if (!this.config.targets.some((t) => t.id === row.id)) continue;
      this.monitor.suppress(row.id, true);
      // An expired deadline still gets one tick rather than an immediate give-up:
      // the update may well have finished while the dashboard was down, and
      // starting on the new build beats announcing a timeout for it.
      this.#beginWait(row.id, {
        installedBefore: row.installedBefore,
        deadline: Math.max(row.deadline, Date.now() + WAIT_POLL_MS * (SETTLE_POLLS + 1)),
      });
      this.monitor.addAlert('warn', row.id,
        'Dashboard restarted while waiting for a Steam update — the server is still stopped and still waiting',
        CATEGORY);
    }
  }

  // --- background checks -------------------------------------------------------

  // One alert per new build, not one per sweep: this runs every six hours and a
  // build can sit unapplied for days.
  async #sweep() {
    for (const t of this.config.targets) {
      if (!this.managed(t.id) || this.waits.has(t.id)) continue;
      const res = await this.check(t.id).catch(() => null);
      if (!res?.ok || !res.updateAvailable) continue;
      if (this.state.get(t.id)?.notified === res.latest) continue;
      this.#set(t.id, { notified: res.latest });
      this.monitor.addAlert('warn', t.id,
        `Steam update available — build ${res.latest} (running ${res.installed}). `
        + `Press "Check for update" on the card when you want it installed.`,
        CATEGORY);
    }
  }

  start() {
    this.#resumeWaits();
    const tick = () => this.#sweep().catch((err) => console.error('[steam]', err.message));
    this.first = setTimeout(tick, FIRST_CHECK_MS);
    this.first.unref?.();
    this.timer = setInterval(tick, this.checkMinutes * 60_000);
    this.timer.unref?.();
  }

  stop() {
    clearTimeout(this.first);
    clearInterval(this.timer);
    // The wait timers are dropped, not cancelled: the file on disk still says a
    // wait is in progress, so the next start picks it up rather than leaving a
    // stopped server with nobody watching it.
    for (const w of this.waits.values()) clearInterval(w.timer);
  }
}
