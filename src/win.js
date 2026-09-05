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

const SERVICE_SETTLE_MS = 30_000;    // how long a service gets to reach a state
const SERVICE_POLL_MS = 1000;

// Windows reports a stop the moment it is accepted, not when the process is
// gone, so poll until the state settles. "NotInstalled" is final — waiting for
// a service that doesn't exist to stop would just burn the whole timeout.
export async function waitForServiceState(serviceName, want, timeoutMs = SERVICE_SETTLE_MS) {
  const deadline = Date.now() + timeoutMs;
  let state = await getServiceState(serviceName);
  while (state !== want && state !== 'NotInstalled' && Date.now() < deadline) {
    await delay(SERVICE_POLL_MS);
    state = await getServiceState(serviceName);
  }
  return { ok: state === want, state };
}

// Just the PID, without getServiceProcess's walk of the whole process table.
async function getServicePid(serviceName) {
  const res = await ps(
    `(Get-CimInstance Win32_Service -Filter "Name='${serviceName}'" -ErrorAction SilentlyContinue).ProcessId`,
  );
  const pid = Number(res.out);
  return res.ok && Number.isInteger(pid) && pid > 0 ? pid : null;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Neither backend volunteers a failure. A PowerShell cmdlet error is
// non-terminating, so `Stop-Service` on a service that isn't there writes to the
// error stream and carries on; nssm reports itself only in its exit code. Both
// therefore need asking twice: make the failure terminating, then confirm the
// service actually reached the state somebody pressed the button for.
const SERVICE_GOAL = { start: 'Running', stop: 'Stopped', restart: 'Running' };

// A command that reported failure gets only a moment to prove otherwise. The
// benign case — nssm objecting that an already-stopped service is stopped — is
// true the instant we look, and a real error shouldn't sit on the button for
// half a minute first.
const SERVICE_ERROR_GRACE_MS = 5000;

export async function controlService(serviceName, action, nssmPath) {
  const verb = { start: 'start', stop: 'stop', restart: 'restart' }[action];
  if (!verb) return { ok: false, error: `unknown service action: ${action}` };

  // Prefer NSSM (it knows how to restart the wrapped node process cleanly).
  // -Force means "stop the dependent services too" and only Stop/Restart-Service
  // take it; handing it to Start-Service fails the call outright.
  const cmd = nssmPath
    // nssm says what went wrong on stderr, which arrives as ErrorRecords whose
    // own ToString() is the useless type name — take the message off each one.
    ? `$out = & '${nssmPath}' ${verb} ${serviceName} 2>&1 |
         ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { [string]$_ } } |
         Where-Object { $_ -match '\\S' }
       if ($LASTEXITCODE -ne 0) { throw "nssm ${verb} exited $LASTEXITCODE : $($out -join ' ')" }`
    : verb === 'restart'
      ? `Restart-Service -Name '${serviceName}' -Force -ErrorAction Stop`
      : verb === 'start'
        ? `Start-Service -Name '${serviceName}' -ErrorAction Stop`
        : `Stop-Service -Name '${serviceName}' -Force -ErrorAction Stop`;

  // A restart that failed on a service which was already running ends in the
  // same state as one that worked, so the state alone can't tell them apart —
  // remember which process we started with.
  const pidBefore = verb === 'restart' ? await getServicePid(serviceName) : null;

  const res = await ps(cmd, 45000);
  const goal = SERVICE_GOAL[action];
  const settled = await waitForServiceState(
    serviceName,
    goal,
    res.ok ? undefined : SERVICE_ERROR_GRACE_MS,
  );

  if (settled.ok) {
    // The service is where it was asked to be. If the command complained on the
    // way there it was complaining about a no-op, which is not a failure — with
    // the exception of a restart, where "already Running" is exactly what a
    // restart that never happened looks like.
    if (res.ok || verb !== 'restart') return { ok: true, out: res.out };
    const pidAfter = await getServicePid(serviceName);
    if (pidAfter && pidAfter !== pidBefore) return { ok: true, out: res.out };
  }

  if (/access is denied|requires elevation/i.test(res.error || '')) {
    return {
      ok: false,
      error: 'Access denied — start the dashboard as administrator to control this service',
    };
  }
  // nssm writes UTF-16, which arrives here padded with NULs.
  if (!res.ok) return { ok: false, error: String(res.error).replace(/\0/g, '').trim() };

  return {
    ok: false,
    error: settled.state === 'NotInstalled'
      ? `there is no service called ${serviceName}`
      : `the service is ${settled.state}, not ${goal}`,
  };
}

// Runs a target's preRestartCommand list — a `git pull`, an `npm ci`, a build —
// and reports what it printed. Unlike launchDetached this waits, because the
// whole point is to know whether the update worked before the service comes
// back up.
//
// Each command is a separate PowerShell run and the first failure stops the
// list: Windows PowerShell 5.1 has no `&&`, so chaining with `;` would happily
// build on top of a pull that never happened.
const EXIT_MARKER = '__SD_EXIT__';

export async function runCommands(commands, cwd, timeout = 300000) {
  const list = (Array.isArray(commands) ? commands : [commands]).filter(Boolean);
  if (!list.length) return { ok: false, error: 'no command to run', out: '' };
  if (cwd && !fs.existsSync(winPath(cwd))) {
    return { ok: false, error: `working folder not found: ${winPath(cwd)}`, out: '' };
  }

  const transcript = [];
  for (const command of list) {
    // Native tools report failure through an exit code rather than by throwing,
    // and plenty of them (git especially) write ordinary progress to stderr — so
    // merge the streams for the log and judge success on the exit code.
    //
    // The code comes back as a trailing marker line rather than as a thrown
    // error, because a failed update is exactly when its output matters most and
    // ps() keeps only the exception text.
    const script = [
      cwd ? `Set-Location -LiteralPath '${winPath(cwd).replace(/'/g, "''")}' -ErrorAction Stop` : '',
      '$ErrorActionPreference = "Continue"',
      '$global:LASTEXITCODE = 0',
      // Rendering an ErrorRecord whole wraps every stderr line in "At line:N
      // char:M", a caret underline and a FullyQualifiedErrorId — four lines of
      // PowerShell trivia around one line of git. Take the message only.
      `$out = & { ${command} } 2>&1 | ForEach-Object {`,
      '  if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { $_ }',
      '} | Out-String -Width 200',
      '$ok = $?',
      '$code = $LASTEXITCODE',
      // A cmdlet that failed without setting an exit code still failed.
      'if ($code -eq 0 -and -not $ok) { $code = 1 }',
      'Write-Output $out',
      `Write-Output "${EXIT_MARKER}$code"`,
    ].filter(Boolean).join('\n');

    transcript.push(`> ${command}`);
    const res = await ps(script, timeout);

    const marker = String(res.out || '').lastIndexOf(EXIT_MARKER);
    const body = marker === -1 ? String(res.out || '') : res.out.slice(0, marker);
    const code = marker === -1 ? null : Number(res.out.slice(marker + EXIT_MARKER.length).trim());
    if (body.trim()) transcript.push(body.trim());

    if (!res.ok || code === null || code !== 0) {
      const why = res.ok ? `exit code ${code ?? 'unknown'}` : res.error;
      return {
        ok: false,
        error: `${command} — ${why}`,
        out: transcript.join('\n').trim(),
      };
    }
  }
  return { ok: true, out: transcript.join('\n').trim() };
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
    //
    // That second clause is the whole point of `start` and it is load-bearing.
    // Spawning the .bat directly instead -- which reads like the simpler thing,
    // and was tried here -- leaves the game server a descendant of this service.
    // NSSM stops a service by killing its process tree, so the next dashboard
    // restart takes every game server down with it. `start` is what puts the
    // server outside that tree. Do not remove it.
    const child = spawn('cmd.exe', ['/c', 'start', '""', '/D', dirOf(target), target], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });

    // A failed spawn is NOT a thrown exception -- Node reports it on an 'error'
    // event a tick later, so the try/catch around this call never caught one and
    // every caller was told `ok: true` for a launch that did not happen. That is
    // not hypothetical: for one evening this returned success for hours while
    // starting nothing, including mid-Restart, on servers it had just stopped.
    // pid is the one honest answer available synchronously.
    if (!child.pid) {
      return { ok: false, error: `could not create a process for ${target}` };
    }

    // Neither handler can change what was already returned. They exist so that a
    // launch failing after the fact leaves a line behind somewhere, which is the
    // part that was missing. Note this watches `start`, not the server: cmd here
    // exits as soon as it has handed the .bat off, and code 0 means only that
    // the handoff worked.
    child.on('error', (err) => {
      console.error(`[launch] ${target} - ${err.message}`);
    });
    child.on('exit', (code) => {
      if (code !== 0) {
        console.error(`[launch] ${target} - cmd exited with code ${code}`);
      }
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

// The last resort when a server won't exit on request.
//
// Two things this has to get right. First, kill the *tree*: a game server
// started from a .bat has a console host above it and often a launcher process
// too, and those keep running — and keep the install locked — after the server
// itself is gone. taskkill /T is the only reliable way to take the lot on
// Windows PowerShell 5.1.
//
// Second, tell the truth. Stop-Process is a non-terminating error when it is
// denied, so the old version reported a clean kill whether or not anything
// died. A caller that believes a dead server is dead will happily start a
// second copy on the same ports.
export async function killProcess(processName) {
  const name = String(processName).replace(/'/g, "''");
  const res = await ps(`
    $ErrorActionPreference = 'SilentlyContinue'
    $procs = @(Get-Process -Name '${name}')
    if (-not $procs) { 'gone'; return }
    foreach ($p in $procs) { taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null }

    # Windows tears a process down asynchronously; a check on the next line can
    # still see it. Give it a moment before deciding it survived.
    $deadline = (Get-Date).AddSeconds(5)
    do {
      Start-Sleep -Milliseconds 400
      $left = @(Get-Process -Name '${name}')
    } while ($left -and (Get-Date) -lt $deadline)

    if ($left) { 'alive:' + (($left | ForEach-Object { $_.Id }) -join ',') } else { 'gone' }`);

  if (!res.ok) return { ok: false, error: res.error };
  if (res.out.startsWith('alive:')) {
    return {
      ok: false,
      error: `${processName} is still running as pid ${res.out.slice(6)} after a forced kill `
        + `— it is probably running as another user or elevated, and the dashboard cannot touch it`,
    };
  }
  return { ok: true };
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
