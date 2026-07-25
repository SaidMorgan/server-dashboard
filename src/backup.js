// World backups.
//
// Two things make this harder than "zip the save folder":
//
//  1. Running servers hold their save files open. Compress-Archive fails
//     outright on a locked file, so we stage a copy with robocopy /B (backup
//     mode, which uses the SeBackupPrivilege the service already has) and zip
//     the staging copy instead.
//  2. A zip taken mid-write is a zip of a half-written world. So we ask the
//     server to save and let it flush before copying.
//
// Everything shells out through the same ps() helper the rest of the project
// uses, which keeps the dependency count at zero.
import fs from 'node:fs';
import path from 'node:path';
import { ps, winPath } from './win.js';

const STAGE_TIMEOUT = 10 * 60 * 1000;
const ZIP_TIMEOUT = 20 * 60 * 1000;
const FLUSH_MS = 4000;

const stamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// Single-quoted for PowerShell, and always with Windows separators.
const quote = (s) => `'${winPath(s).replace(/'/g, "''")}'`;

// robocopy exit codes below 8 all mean success; 8 and above are real failures.
//
// /B is backup mode, which is what lets us read files a running server holds
// open — but it needs the Backup and Restore Files privilege. The dashboard has
// that when installed as a service (LocalSystem) or run elevated, and does not
// when run as a plain user, where robocopy fails with exit 16. So try backup
// mode, and fall back to an ordinary copy rather than failing outright.
async function robocopy(src, dest, mode = '/E') {
  const args = (extra) => [quote(src), quote(dest), `'${mode}'`, ...extra,
    "'/R:1'", "'/W:1'", "'/NFL'", "'/NDL'", "'/NJH'", "'/NJS'", "'/NP'"].join(', ');

  const run = (extra) => ps(
    `$p = Start-Process robocopy -ArgumentList @(${args(extra)}) -Wait -PassThru -WindowStyle Hidden
     if ($p.ExitCode -ge 8) { throw "robocopy exit code $($p.ExitCode)" }`,
    STAGE_TIMEOUT,
  );

  const withBackupMode = await run(["'/B'"]);
  if (withBackupMode.ok) return { ok: true, backupMode: true };

  const plain = await run([]);
  if (plain.ok) return { ok: true, backupMode: false };

  // Report the plain-copy error: it's the one without the privilege caveat.
  return { ok: false, error: plain.error };
}

export class Backups {
  constructor(config, monitor, actions) {
    this.config = config;
    this.monitor = monitor;
    this.actions = actions;
    this.running = new Set(); // target ids with a backup in flight
  }

  target(id) {
    const t = this.config.targets.find((x) => x.id === id);
    if (!t) throw new Error(`unknown target: ${id}`);
    return t;
  }

  dirFor(id) {
    const t = this.target(id);
    return t.backup?.dir || path.join(this.config.backupRoot, id);
  }

  list(id) {
    const dir = this.dirFor(id);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.zip'))
      .map((f) => {
        const s = fs.statSync(path.join(dir, f));
        return { name: f, bytes: s.size, at: s.mtimeMs };
      })
      .sort((a, b) => b.at - a.at);
  }

  // Deleting the oldest archives once we're over the retention count.
  prune(id) {
    const t = this.target(id);
    const keep = Math.max(1, t.backup?.keep ?? 10);
    const dir = this.dirFor(id);
    const removed = [];
    for (const entry of this.list(id).slice(keep)) {
      try {
        fs.unlinkSync(path.join(dir, entry.name));
        removed.push(entry.name);
      } catch (err) {
        console.error(`[backup] could not remove ${entry.name}: ${err.message}`);
      }
    }
    return removed;
  }

  async run(id, { reason = 'manual', save = true } = {}) {
    const t = this.target(id);
    const paths = t.backup?.paths || [];
    if (!paths.length) return { ok: false, error: 'no backup.paths configured for this target' };

    const missing = paths.filter((p) => !fs.existsSync(p));
    if (missing.length) return { ok: false, error: `path does not exist: ${missing[0]}` };

    if (this.running.has(id)) return { ok: false, error: 'a backup is already running for this target' };
    this.running.add(id);

    const started = Date.now();
    const dir = this.dirFor(id);
    const staging = path.join(dir, `.staging-${stamp(new Date())}`);
    const archive = path.join(dir, `${id}-${stamp(new Date())}.zip`);

    try {
      fs.mkdirSync(dir, { recursive: true });

      // Ask the server to flush first. Best effort: a stopped server, or one
      // whose game has no save command, is fine — its files are already at rest.
      const up = this.monitor.state.get(id)?.up;
      if (save && up && this.actions) {
        await this.actions.save(id).catch(() => {});
        await new Promise((r) => setTimeout(r, FLUSH_MS));
      }

      // Stage a copy first: robocopy can read files a running server holds
      // open, and handles paths longer than MAX_PATH, neither of which
      // Compress-Archive manages on its own.
      let lockedFileSafe = true;
      for (const src of paths) {
        const dest = path.join(staging, path.basename(src));
        const res = await robocopy(src, dest);
        // Keep the path in the JS-side message; embedding it in the PowerShell
        // string is a quoting hazard for no benefit.
        if (!res.ok) throw new Error(`could not copy ${src}: ${res.error || 'staging copy failed'}`);
        if (!res.backupMode) lockedFileSafe = false;
      }

      // Worth saying out loud: without backup mode a running server can hold a
      // save file open and it will be missing from the archive.
      if (!lockedFileSafe && this.monitor.state.get(id)?.up && !this.warnedNoBackupMode) {
        this.warnedNoBackupMode = true;
        this.monitor.addAlert('warn', id,
          'Backing up a running server without the Backup Files privilege — files the server holds open may be skipped. ' +
          'Run the dashboard elevated, or install it as a service, for reliable hot backups.');
      }

      const res = await ps(
        `Compress-Archive -Path (Join-Path ${quote(staging)} '*') -DestinationPath ${quote(archive)} -CompressionLevel Optimal -Force`,
        ZIP_TIMEOUT,
      );
      if (!res.ok) throw new Error(res.error || 'Compress-Archive failed');
      if (!fs.existsSync(archive)) throw new Error('archive was not created');

      const bytes = fs.statSync(archive).size;
      const removed = this.prune(id);
      const ms = Date.now() - started;

      this.monitor.addAlert('info', id,
        `Backup complete (${reason}) — ${formatBytes(bytes)} in ${Math.round(ms / 1000)}s` +
        (removed.length ? `, pruned ${removed.length} old` : ''));

      return { ok: true, file: path.basename(archive), bytes, ms, pruned: removed.length };
    } catch (err) {
      this.monitor.addAlert('error', id, `Backup failed (${reason}): ${err.message}`);
      try { if (fs.existsSync(archive)) fs.unlinkSync(archive); } catch { /* nothing useful to do */ }
      return { ok: false, error: err.message };
    } finally {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
      this.running.delete(id);
    }
  }

  // Restoring overwrites a live world, so this refuses unless the server is
  // stopped, and takes a safety copy of the current state first — an accidental
  // restore of the wrong archive is otherwise unrecoverable.
  async restore(id, name) {
    const t = this.target(id);
    if (!/^[\w.-]+\.zip$/.test(name)) return { ok: false, error: 'invalid archive name' };

    const dir = this.dirFor(id);
    const archive = path.join(dir, name);
    if (!fs.existsSync(archive)) return { ok: false, error: 'archive not found' };

    if (this.monitor.state.get(id)?.up) {
      return { ok: false, error: 'stop the server before restoring a backup' };
    }

    const paths = t.backup?.paths || [];
    if (!paths.length) return { ok: false, error: 'no backup.paths configured for this target' };

    const staging = path.join(dir, `.restore-${stamp(new Date())}`);
    let safety = null;
    try {
      // Extract BEFORE taking the safety backup. The safety backup counts
      // against the retention limit, so if this archive happens to be the
      // oldest, pruning would delete the very file we are restoring from.
      const unzip = await ps(
        `Expand-Archive -Path ${quote(archive)} -DestinationPath ${quote(staging)} -Force`,
        ZIP_TIMEOUT,
      );
      if (!unzip.ok) throw new Error(unzip.error || 'Expand-Archive failed');

      safety = await this.run(id, { reason: 'pre-restore safety copy', save: false });
      if (!safety.ok) throw new Error(`refusing to overwrite — safety backup failed: ${safety.error}`);

      for (const dest of paths) {
        const src = path.join(staging, path.basename(dest));
        if (!fs.existsSync(src)) throw new Error(`archive has no folder named ${path.basename(dest)}`);
        // /MIR makes the destination match the archive exactly, which is what
        // "restore" has to mean — a merge would leave newer stray files behind.
        const res = await robocopy(src, dest, '/MIR');
        if (!res.ok) throw new Error(`could not restore into ${dest}: ${res.error || 'restore copy failed'}`);
      }

      this.monitor.addAlert('warn', id, `Restored backup ${name} (previous state saved as ${safety.file})`);
      return { ok: true, safetyBackup: safety.file };
    } catch (err) {
      this.monitor.addAlert('error', id, `Restore failed: ${err.message}`);
      return { ok: false, error: err.message, safetyBackup: safety?.file ?? null };
    } finally {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
