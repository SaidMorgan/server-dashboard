// Thin wrappers over the Windows bits we need: process stats, service state,
// launching and killing servers.
import { exec, spawn } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// Several Windows tools — cmd's `start`, robocopy — silently misbehave when
// handed forward slashes. JSON makes forward slashes the tempting way to write
// a Windows path, so normalise before anything reaches a shell.
export const winPath = (p) => String(p).replace(/\//g, '\\');

// PowerShell writes errors to stderr as a CLIXML document when its output is
// redirected. Dumping that at a user is useless, so pull the actual message out
// and drop the parser noise that follows it.
export function cleanPowerShellError(raw) {
  const text = String(raw || '').trim();
  if (!text.startsWith('#< CLIXML')) return text;

  const segments = [...text.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => m[1]);
  if (!segments.length) return text;

  return segments.join('')
    .replace(/_x000D__x000A_/g, '\n')
    .replace(/_x000D_/g, '')
    .replace(/_x000A_/g, '\n')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .split('\n')
    // "At line:N char:M", the caret underline, CategoryInfo and
    // FullyQualifiedErrorId are all restating the same failure.
    .filter((l) => !/^\s*(At line:\d|\+|CategoryInfo|FullyQualifiedErrorId)/.test(l))
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

const ERROR_SENTINEL = '__SD_ERROR__';

export async function ps(command, timeout = 15000) {
  // Catch failures inside PowerShell and report them on stdout as one clean
  // line. Left to its own devices PowerShell writes a CLIXML blob to stderr,
  // word-wrapped at the console width — which corrupts any path long enough to
  // wrap and is unreadable regardless.
  const wrapped = `try {
${command}
} catch { Write-Output ('${ERROR_SENTINEL}' + $_.Exception.Message); exit 1 }`;

  // -EncodedCommand sidesteps every layer of cmd.exe quoting, which matters
  // because these scripts contain quotes, $(), backslashes and newlines.
  const encoded = Buffer.from(wrapped, 'utf16le').toString('base64');

  const unpack = (stdout) => {
    const text = String(stdout || '');
    const at = text.indexOf(ERROR_SENTINEL);
    return at === -1 ? null : text.slice(at + ERROR_SENTINEL.length).trim();
  };

  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    const failed = unpack(stdout);
    if (failed) return { ok: false, error: failed };
    return { ok: true, out: stdout.trim() };
  } catch (err) {
    if (err.killed || err.signal === 'SIGTERM') {
      return { ok: false, error: `timed out after ${Math.round(timeout / 1000)}s` };
    }
    return {
      ok: false,
      error: unpack(err.stdout) || cleanPowerShellError(err.stderr || err.message),
    };
  }
}

// One PowerShell call for every process we care about, rather than one per target.
export async function getProcessStats(names) {
  if (!names.length) return {};
  const filter = names.map((n) => `'${n}'`).join(',');
  // Return raw CPU seconds; the caller turns successive samples into a
  // percentage. Get-Counter would be far slower and is locale-sensitive.
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'
    $names = @(${filter})
    $out = @()
    foreach ($n in $names) {
      $p = Get-Process -Name $n | Select-Object -First 1
      if ($p) {
        $start = $null
        try { $start = $p.StartTime.ToString('o') } catch {}
        if (-not $start) {
          # StartTime throws for elevated processes when we are not elevated;
          # CIM exposes the same value without needing rights.
          $c = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)"
          if ($c -and $c.CreationDate) { $start = $c.CreationDate.ToString('o') }
        }
        $out += [pscustomobject]@{
          name = $n; running = $true; procId = $p.Id
          memMB = [math]::Round($p.WorkingSet64 / 1MB)
          cpuSeconds = [math]::Round($p.TotalProcessorTime.TotalSeconds, 2)
          startTime = $start
        }
      } else {
        $out += [pscustomobject]@{ name = $n; running = $false }
      }
    }
    ConvertTo-Json -InputObject @($out) -Compress`;

  const res = await ps(script);
  if (!res.ok || !res.out) {
    console.error('[procstats]', res.error || 'no output');
    return {};
  }
  try {
    const rows = JSON.parse(res.out);
    return Object.fromEntries(rows.map((r) => [r.name, r]));
  } catch (err) {
    console.error('[procstats] parse:', err.message, res.out.slice(0, 200));
    return {};
  }
}

export async function getServiceState(serviceName) {
  const res = await ps(
    `$s = Get-Service -Name '${serviceName}' -ErrorAction SilentlyContinue; if ($s) { $s.Status.ToString() } else { 'NotInstalled' }`,
  );
  return res.ok ? res.out : 'Unknown';
}

// Get-Service knows whether a service runs, but not which process is doing the
// running — Win32_Service carries the PID, and from a PID the ordinary counters
// follow. That is what lets a service card show uptime, CPU and RAM instead of
// just "Running".
//
// CPU and memory are summed over the whole process tree, which matters for the
// common NSSM setup: the service PID is nssm.exe, a ~8 MB supervisor, and the
// application everyone actually cares about is its child. Reporting the wrapper
// alone would show a busy API using 8 MB and no CPU.
export async function getServiceProcess(serviceName) {
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'
    $svc = Get-CimInstance Win32_Service -Filter "Name='${serviceName}'"
    if (-not $svc -or -not ($svc.ProcessId -gt 0)) { '{}'; return }

    # One CIM query, then walk it in memory — a query per descendant would cost
    # more than the poll interval on a busy machine.
    # Everything comes from this one query. Get-Process would be the obvious way
    # to read memory and CPU, but TotalProcessorTime throws Access Denied on a
    # LocalSystem service unless we are elevated, and silently sums to zero.
    # WorkingSetSize and the *ModeTime counters are readable either way.
    $all = @(Get-CimInstance Win32_Process |
      Select-Object ProcessId, ParentProcessId, CreationDate, WorkingSetSize, UserModeTime, KernelModeTime)
    $byParent = @{}
    foreach ($p in $all) {
      $key = [string]$p.ParentProcessId
      if (-not $byParent.ContainsKey($key)) { $byParent[$key] = @() }
      $byParent[$key] += $p
    }

    $root = $all | Where-Object { $_.ProcessId -eq $svc.ProcessId } | Select-Object -First 1
    if (-not $root) { '{}'; return }

    $tree = @()
    $queue = [System.Collections.Queue]::new()
    $queue.Enqueue($root)
    while ($queue.Count -gt 0) {
      $cur = $queue.Dequeue()
      $tree += $cur
      # Windows reuses PIDs, so a stale parent id can point at a process that
      # started before its "child" — that way lies an infinite loop.
      foreach ($kid in $byParent[[string]$cur.ProcessId]) {
        if ($kid.ProcessId -ne $cur.ProcessId -and $kid.CreationDate -ge $cur.CreationDate) {
          $queue.Enqueue($kid)
        }
      }
    }

    # *ModeTime are in 100-nanosecond ticks.
    $mem = 0; $ticks = 0
    foreach ($t in $tree) {
      $mem += [int64]$t.WorkingSetSize
      $ticks += [int64]$t.UserModeTime + [int64]$t.KernelModeTime
    }
    $cpu = $ticks / 1e7

    ConvertTo-Json -Compress -InputObject ([pscustomobject]@{
      procId = $svc.ProcessId
      procCount = $tree.Count
      memMB = [math]::Round($mem / 1MB)
      cpuSeconds = [math]::Round($cpu, 2)
      startTime = $(if ($root.CreationDate) { $root.CreationDate.ToString('o') } else { $null })
    })`;

  const res = await ps(script);
  if (!res.ok || !res.out) return null;
  try {
    const row = JSON.parse(res.out);
    return row.procId ? row : null;
  } catch {
    return null; // a stat we can't read is a blank tile, not an error
  }
}

export async function controlService(serviceName, action, nssmPath) {
  const verb = { start: 'start', stop: 'stop', restart: 'restart' }[action];
  if (!verb) return { ok: false, error: `unknown service action: ${action}` };

  // Prefer NSSM (it knows how to restart the wrapped node process cleanly).
  const cmd = nssmPath
    ? `& '${nssmPath}' ${verb} ${serviceName}`
    : verb === 'restart'
      ? `Restart-Service -Name '${serviceName}' -Force`
      : `${verb === 'start' ? 'Start-Service' : 'Stop-Service'} -Name '${serviceName}' -Force`;

  const res = await ps(`${cmd}; $?`, 45000);
  if (!res.ok) {
    const denied = /access is denied|requires elevation/i.test(res.error || '');
    return {
      ok: false,
      error: denied
        ? 'Access denied — start the dashboard as administrator to control this service'
        : res.error,
    };
  }
  return { ok: true, out: res.out };
}

export function launchDetached(batPath) {
  if (!batPath) return { ok: false, error: 'no startCommand configured for this target' };

  // cmd.exe's `start` silently does nothing when handed forward slashes, and
  // reports success either way.
  const target = winPath(batPath);

  if (!fs.existsSync(target)) {
    return { ok: false, error: `startCommand not found: ${target}` };
  }

  try {
    // `start` gives the server its own console window and detaches it from us,
    // so the dashboard can be restarted without killing the game server.
    const child = spawn('cmd.exe', ['/c', 'start', '""', '/D', dirOf(target), target], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function dirOf(p) {
  const cut = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return cut === -1 ? '.' : p.slice(0, cut);
}

export async function killProcess(processName) {
  const res = await ps(
    `Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | Stop-Process -Force; $?`,
  );
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

export async function checkHealth(url, timeout = 4000) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
    return { ok: res.ok, status: res.status, ms: Date.now() - started, body };
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - started, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

export async function toast(title, message) {
  // BurntToast isn't guaranteed to be installed, so fall back to a balloon tip.
  const script = `
    try {
      Add-Type -AssemblyName System.Windows.Forms
      $n = New-Object System.Windows.Forms.NotifyIcon
      $n.Icon = [System.Drawing.SystemIcons]::Information
      $n.Visible = $true
      $n.ShowBalloonTip(8000, '${title.replace(/'/g, "''")}', '${message.replace(/'/g, "''")}', 'Warning')
      Start-Sleep -Seconds 9
      $n.Dispose()
    } catch {}`;
  ps(script, 20000).catch(() => {});
}
