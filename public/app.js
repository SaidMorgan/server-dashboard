// Dashboard front-end. Renders one card per target, subscribes to /api/stream
// for live updates, and posts control actions. ?only=<id> renders a single card
// (used by pop-out).
//
// Updates arrive over server-sent events, so a crash shows up the moment the
// poll loop sees it. If the stream can't be established — an old proxy, a
// captive network — it silently falls back to the 5-second poll it used before.
const params = new URLSearchParams(location.search);
const ONLY = params.get('only');
// ?live=0 forces the old 5-second polling instead of the event stream. Useful
// behind a proxy that mangles long-lived connections, and needed by anything
// that waits for the network to go idle — headless screenshot tools and
// archivers never finish on a page holding an SSE connection open.
const NO_STREAM = params.get('live') === '0';

const cardsEl = document.getElementById('cards');
const alertsEl = document.getElementById('alerts');
const liveEl = document.getElementById('live');
const template = document.getElementById('cardTemplate');
const cards = new Map();
const capabilities = new Map(); // id -> what this target can actually do
let alerts = [];

if (ONLY) {
  document.body.classList.add('solo');
  document.getElementById('feedSection').classList.add('hidden');
}

const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function fmtUptime(iso) {
  if (!iso) return '—';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 0 || !Number.isFinite(secs)) return '—';
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function fmtWhen(t) {
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function fmtUntil(t) {
  if (!t) return '—';
  const mins = Math.round((t - Date.now()) / 60000);
  if (mins < 1) return 'in <1m';
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h ${mins % 60}m`;
  return `in ${Math.round(hours / 24)}d`;
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  // The session can expire while the page is open; go get a new one.
  if (res.status === 401) { location.href = '/login'; throw new Error('not authenticated'); }
  return res.json();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function buildCard(target) {
  const node = template.content.firstElementChild.cloneNode(true);
  const caps = capabilities.get(target.id) || {};
  node.dataset.id = target.id;
  if (target.kind === 'service') node.classList.add('service-kind');
  node.querySelector('.name').textContent = target.name;

  // Hide controls this target can't perform, rather than offering buttons whose
  // only possible outcome is an error.
  const hide = (sel) => node.querySelector(sel)?.classList.add('hidden');
  if (caps.canSave === false) hide('[data-act=save]');
  if (caps.canBroadcast === false) {
    hide('.broadcast-msg');
    hide('[data-act=broadcast]');
    hide('[data-act=scheduleRestart]');
    hide('[data-act=cancelRestart]');
    hide('.countdown-min');
  }
  if (caps.canConsole === false) hide('.console');
  if (caps.canStart === false) hide('[data-act=start]');
  if (caps.hasBackup === false) hide('.backups');
  if (caps.hasLog === false) hide('.logs');
  if (caps.transport === 'none') hide('.players-list');

  node.querySelector('.popout').addEventListener('click', () => {
    window.open(`${location.pathname}?only=${target.id}`, `panel_${target.id}`,
      'width=520,height=900,menubar=no,toolbar=no,location=no');
  });

  node.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => runAction(target, node, btn));
  });

  // Enter in the broadcast box sends it, same as clicking the button.
  const bcastInput = node.querySelector('.broadcast-msg');
  const bcastBtn = node.querySelector('[data-act=broadcast]');
  if (bcastInput && bcastBtn) {
    bcastInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (!bcastInput.value.trim()) return;
      bcastBtn.click();
    });
  }

  const rconInput = node.querySelector('.rcon-input');
  wireCommandPicker(node, rconInput, caps.consoleCommands || []);

  const sendRcon = async () => {
    const command = rconInput.value.trim();
    if (!command) return;

    // An unfilled <placeholder> would be sent verbatim — broadcasting the literal
    // text "<message>" to everyone is a confusing way to find that out.
    const blank = command.match(/<[^>]+>/);
    if (blank) {
      alert(`Replace ${blank[0]} with a real value first.`);
      rconInput.focus();
      selectPlaceholder(rconInput);
      return;
    }

    const known = findCommand(caps.consoleCommands, command);
    if (known?.danger && !confirm(`${command}\n\n${known.description}\n\nRun it?`)) return;

    const out = node.querySelector('.output');
    out.textContent = `> ${command}\n…`;
    const res = await api(`/api/rcon/${target.id}`, {
      method: 'POST',
      body: JSON.stringify({ command }),
    });
    out.textContent = `> ${command}\n${res.ok ? (res.body || '(no output)') : `ERROR: ${res.error}`}`;
    out.scrollTop = out.scrollHeight;
    rconInput.value = '';
    rconInput.dispatchEvent(new Event('input')); // clears the description hint
  };
  node.querySelector('.rcon-send').addEventListener('click', sendRcon);
  rconInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendRcon(); });

  node.querySelector('details.logs').addEventListener('toggle', function () {
    if (this.open) loadLog(target.id, node);
  });

  wireSchedules(target, node);
  wireBackups(target, node);

  cardsEl.append(node);
  cards.set(target.id, node);
  loadHistory(target.id, node);
  return node;
}

// --- console command picker -------------------------------------------------
//
// The console still takes any command the server understands — the dropdown is
// a menu of the ones this game is known to have, so nobody has to keep a wiki
// tab open to remember whether it's "listplayers" or "lp".

// The literal words a command starts with, ignoring everything from the first
// <placeholder> on: "ban add <name> 1 day" identifies as "ban add".
function commandLead(command) {
  const lead = [];
  for (const word of command.toLowerCase().split(/\s+/)) {
    if (word.includes('<')) break;
    lead.push(word);
  }
  return lead;
}

// Which known command is the user typing? Longest match wins, so "ban add"
// beats a bare "ban".
function findCommand(commands, typed) {
  if (!commands?.length || !typed?.trim()) return null;
  const words = typed.trim().toLowerCase().split(/\s+/);
  const hits = commands
    .map((c) => ({ c, lead: commandLead(c.command) }))
    .filter(({ lead }) => lead.length && lead.every((w, i) => words[i] === w))
    .sort((a, b) => b.lead.length - a.lead.length);
  return hits[0]?.c ?? null;
}

// Put the caret somewhere useful: on the first <placeholder> if there is one,
// so typing overwrites it, otherwise at the end.
function selectPlaceholder(input) {
  const m = input.value.match(/<[^>]*>/);
  if (m) input.setSelectionRange(m.index, m.index + m[0].length);
  else input.setSelectionRange(input.value.length, input.value.length);
}

function wireCommandPicker(node, input, commands) {
  if (!commands.length) return; // profile ships no list; plain text box as before

  const select = node.querySelector('.rcon-pick');
  const help = node.querySelector('.cmd-help');
  node.querySelector('.rcon-pickrow').classList.remove('hidden');

  const option = (c) => {
    const el = document.createElement('option');
    el.value = c.command;
    el.textContent = `${c.danger ? '⚠ ' : ''}${c.command}${c.description ? ` — ${c.description}` : ''}`;
    el.title = c.description || c.command;
    return el;
  };

  const safe = commands.filter((c) => !c.danger);
  const risky = commands.filter((c) => c.danger);
  const group = (label, rows) => {
    if (!rows.length) return;
    const g = document.createElement('optgroup');
    g.label = label;
    rows.forEach((c) => g.append(option(c)));
    select.append(g);
  };
  // Only split into groups when there is something to warn about.
  if (risky.length) {
    group('Commands', safe);
    group('Careful — affects everyone', risky);
  } else {
    safe.forEach((c) => select.append(option(c)));
  }

  const showHelp = (entry) => {
    help.classList.toggle('hidden', !entry?.description);
    help.classList.toggle('danger', Boolean(entry?.danger));
    help.textContent = entry?.description ? `${entry.danger ? '⚠ ' : ''}${entry.description}` : '';
  };

  select.addEventListener('change', () => {
    const picked = commands.find((c) => c.command === select.value);
    if (!picked) return;
    input.value = picked.command;
    showHelp(picked);
    input.focus();
    selectPlaceholder(input);
    select.value = ''; // so picking the same command twice still fires
  });

  input.addEventListener('input', () => showHelp(findCommand(commands, input.value)));
}

async function runAction(target, node, btn) {
  const action = btn.dataset.act;
  const body = { action };

  if (action === 'broadcast') {
    body.message = node.querySelector('.broadcast-msg').value.trim();
    if (!body.message) return;
  }
  if (action === 'scheduleRestart') {
    body.minutes = Number(node.querySelector('.countdown-min').value) || 15;
  }
  if (action === 'stop' || action === 'restart') {
    const verb = action === 'stop' ? 'Stop' : 'Restart';
    const count = node.dataset.playerCount || '0';
    const warning = count !== '0' ? `\n\n${count} player(s) are ONLINE right now.` : '';
    if (!confirm(`${verb} ${target.name}?${warning}`)) return;
  }

  btn.classList.add('busy');
  const out = node.querySelector('.output');
  if (out) out.textContent = `${action}…`;
  try {
    const res = await api(`/api/action/${target.id}`, { method: 'POST', body: JSON.stringify(body) });
    if (out) {
      // Say who actually received a broadcast — "ok" against an empty server
      // looks identical to a broadcast that silently went nowhere.
      let detail = '';
      if (action === 'broadcast' && res.ok) {
        const seen = Number(node.dataset.playerCount || 0);
        detail = seen ? ` — delivered to ${seen} player(s)` : ' — but nobody is online to see it';
      }
      if (res.backup) detail += ` — backed up as ${res.backup}`;
      out.textContent = res.ok
        ? `${action}: ok${res.forced ? ' (force-killed)' : ''}${detail}`
        : `${action} failed: ${res.error}`;
    } else if (!res.ok) {
      alert(`${action} failed: ${res.error}`);
    }
    if (action === 'broadcast') node.querySelector('.broadcast-msg').value = '';
  } finally {
    btn.classList.remove('busy');
    refresh();
  }
}

// A service card has no player list, which left it noticeably barer than a game
// card. This fills that space with what a service actually has: which Windows
// service it is, what gets polled, and what that poll last said.
function renderServiceInfo(node, snap) {
  const box = node.querySelector('.service-info');
  const rows = [];

  if (snap.serviceName) {
    rows.push(['Service', snap.pid ? `${snap.serviceName} · pid ${snap.pid}` : snap.serviceName, '']);
  }
  if (snap.healthUrl) rows.push(['Polling', snap.healthUrl, '']);

  if (snap.healthChecked !== false) {
    if (snap.healthError) {
      rows.push(['Error', snap.healthError, 'bad']);
    } else if (snap.healthBody != null) {
      // The endpoint answers with whatever it likes; JSON gets flattened to one
      // line so a long reply doesn't push the rest of the card off screen.
      const text = typeof snap.healthBody === 'string'
        ? snap.healthBody
        : JSON.stringify(snap.healthBody);
      const trimmed = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      if (trimmed.trim()) rows.push([`Replied ${snap.httpStatus ?? ''}`.trim(), trimmed, '']);
    }
  }

  box.classList.toggle('hidden', !rows.length);
  box.querySelector('.infolist').innerHTML = rows
    .map(([k, v, cls]) => `<li><span class="k">${escapeHtml(k)}</span><span class="v ${cls}">${escapeHtml(v)}</span></li>`)
    .join('');
}

// GB reads well for a game server and badly for a 90 MB API process.
function fmtMem(memMB) {
  if (memMB == null) return '—';
  return memMB >= 1024 ? `${(memMB / 1024).toFixed(1)} GB` : `${Math.round(memMB)} MB`;
}

function statTiles(snap) {
  if (snap.kind === 'service') {
    const tiles = [
      ['Service', snap.serviceStatus || '—', snap.serviceStatus === 'Running' ? 'good' : 'bad'],
    ];
    // A service with no healthUrl configured is judged on the service state
    // alone; a Health tile reading "—" forever would just look broken.
    if (snap.healthChecked !== false) {
      tiles.push(
        ['Health', snap.healthy ? 'ok' : (snap.healthError || `HTTP ${snap.httpStatus}`), snap.healthy ? 'good' : 'bad'],
        ['Latency', snap.responseMs != null ? `${snap.responseMs} ms` : '—', snap.responseMs > 1000 ? 'warn' : ''],
      );
    }
    tiles.push(
      ['Uptime', fmtUptime(snap.startedAt), ''],
      ['CPU', snap.cpu != null ? `${snap.cpu}%` : '—', snap.cpu > 80 ? 'warn' : ''],
      ['RAM', fmtMem(snap.memMB), ''],
    );
    return tiles;
  }
  const tiles = [
    ['State', snap.up ? 'running' : 'stopped', snap.up ? 'good' : 'bad'],
    ['Uptime', fmtUptime(snap.startedAt), ''],
    ['CPU', snap.cpu != null ? `${snap.cpu}%` : '—', snap.cpu > 80 ? 'warn' : ''],
    ['RAM', fmtMem(snap.memMB), ''],
  ];
  // A game with no remote API has no RCON state worth a tile.
  if (snap.rcon !== 'n/a') {
    tiles.push(['RCON', snap.rcon === 'ok' ? 'connected' : (snap.rconError || snap.rcon),
      snap.rcon === 'ok' ? 'good' : (snap.up ? 'warn' : '')]);
  }
  tiles.push(['Port', String(snap.gamePort ?? '—'), '']);
  return tiles;
}

function render(snap, pending) {
  const node = cards.get(snap.id);
  if (!node) return;

  const players = snap.players;
  const count = players ? players.length : null;
  node.dataset.playerCount = count ?? 0;

  // Status dot: green = up, amber = up but RCON/health unhappy, red = down.
  const dot = node.querySelector('.card-head .dot');
  const degraded = snap.up && (
    (snap.kind === 'game' && snap.rcon !== 'ok' && snap.rcon !== 'n/a')
    || (snap.kind === 'service' && !snap.healthy));
  dot.className = `dot ${!snap.up ? 'down' : degraded ? 'degraded' : 'up'}`;

  const badge = node.querySelector('.badge.players');
  if (snap.kind === 'game') {
    badge.textContent = snap.rcon === 'n/a'
      ? (snap.up ? 'running' : 'stopped')
      : (count == null ? '— / —' : `${count} / ${snap.maxPlayers}`);
    badge.classList.toggle('active', Boolean(count));
  } else {
    badge.textContent = snap.up ? 'healthy' : 'down';
  }

  node.querySelector('.stats').innerHTML = statTiles(snap)
    .map(([k, v, cls]) => `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${escapeHtml(String(v))}</div></div>`)
    .join('');

  const list = node.querySelector('.playerlist');
  if (snap.kind === 'service') {
    node.querySelector('.players-list').classList.add('hidden');
    renderServiceInfo(node, snap);
  } else if (snap.rcon === 'n/a') {
    // handled by hiding the section at build time
  } else if (!players) {
    list.innerHTML = `<li class="empty">${snap.up ? 'RCON unavailable — cannot read player list' : 'server offline'}</li>`;
  } else if (!players.length) {
    list.innerHTML = '<li class="empty">nobody online — safe to restart</li>';
  } else {
    list.innerHTML = players
      .map((p) => `<li><span>${escapeHtml(p.name)}</span><span class="pid">${escapeHtml(p.id || '')}</span></li>`)
      .join('');
  }

  const cd = node.querySelector('.countdown');
  const p = pending?.[snap.id];
  if (p) {
    const left = Math.max(0, Math.round((p.finishAt - Date.now()) / 1000));
    cd.textContent = `⏱ Restarting in ${Math.floor(left / 60)}m ${String(left % 60).padStart(2, '0')}s — ${p.reason}`;
    cd.classList.remove('hidden');
  } else {
    cd.classList.add('hidden');
  }

  const startBtn = node.querySelector('[data-act=start]');
  const stopBtn = node.querySelector('[data-act=stop]');
  if (startBtn) startBtn.disabled = snap.up;
  if (stopBtn) stopBtn.disabled = !snap.up;
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

function wireSchedules(target, node) {
  const details = node.querySelector('details.schedules');
  const actionSel = node.querySelector('.sched-action');
  const messageInput = node.querySelector('.sched-message');

  details.addEventListener('toggle', function () {
    if (this.open) loadSchedules(target.id, node);
  });

  // Only a broadcast needs a message, so only show the box for one.
  actionSel.addEventListener('change', () => {
    messageInput.classList.toggle('hidden', actionSel.value !== 'broadcast');
  });

  node.querySelector('.sched-add').addEventListener('click', async () => {
    const body = {
      targetId: target.id,
      cron: node.querySelector('.sched-cron').value.trim(),
      action: actionSel.value,
      warnMinutes: Number(node.querySelector('.sched-warn').value) || 0,
      message: messageInput.value.trim() || null,
    };
    const res = await api('/api/schedules', { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) { alert(res.error); return; }
    node.querySelector('.sched-cron').value = '';
    messageInput.value = '';
    loadSchedules(target.id, node);
  });
}

async function loadSchedules(id, node) {
  const rows = (await api('/api/schedules')).filter((j) => j.targetId === id);
  const list = node.querySelector('.schedulelist');

  if (!rows.length) {
    list.innerHTML = '<li class="empty">nothing scheduled</li>';
    return;
  }

  list.innerHTML = rows.map((j) => {
    const label = j.action + (j.warnMinutes ? ` (warn ${j.warnMinutes}m)` : '');
    const controls = j.source === 'config'
      ? '<span class="locked" title="Declared in config.json">from config</span>'
      : `<button class="mini" data-run="${escapeHtml(j.id)}">run</button>
         <button class="mini bad" data-del="${escapeHtml(j.id)}">delete</button>`;
    return `<li>
      <span class="when">${escapeHtml(j.description)}</span>
      <span class="what">${escapeHtml(label)}</span>
      <span class="next">${j.enabled ? escapeHtml(fmtUntil(j.nextRun)) : 'disabled'}</span>
      ${controls}
    </li>`;
  }).join('');

  list.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this schedule?')) return;
      const res = await api(`/api/schedules/${encodeURIComponent(btn.dataset.del)}`, { method: 'DELETE' });
      if (!res.ok) alert(res.error);
      loadSchedules(id, node);
    });
  });

  list.querySelectorAll('[data-run]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.classList.add('busy');
      const res = await api(`/api/schedules/${encodeURIComponent(btn.dataset.run)}/run`, { method: 'POST' });
      btn.classList.remove('busy');
      if (!res.ok) alert(res.error || 'failed');
      loadSchedules(id, node);
    });
  });
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

function wireBackups(target, node) {
  const details = node.querySelector('details.backups');
  const status = node.querySelector('.backup-status');

  details.addEventListener('toggle', function () {
    if (this.open) loadBackups(target.id, node);
  });

  node.querySelector('.backup-now').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.classList.add('busy');
    // A big world can take minutes to archive, so say so rather than looking hung.
    status.textContent = 'archiving… this can take a while for a large world';
    const res = await api(`/api/backups/${target.id}`, { method: 'POST' });
    btn.classList.remove('busy');
    status.textContent = res.ok
      ? `done — ${fmtBytes(res.bytes)} in ${Math.round(res.ms / 1000)}s`
      : `failed: ${res.error}`;
    loadBackups(target.id, node);
  });
}

async function loadBackups(id, node) {
  const rows = await api(`/api/backups/${id}`);
  const list = node.querySelector('.backuplist');

  if (!rows.length) {
    list.innerHTML = '<li class="empty">no backups yet</li>';
    return;
  }

  list.innerHTML = rows.map((b) => `<li>
    <span class="when">${escapeHtml(fmtWhen(b.at))}</span>
    <span class="size">${escapeHtml(fmtBytes(b.bytes))}</span>
    <a class="mini" href="/api/backups/${encodeURIComponent(id)}/download/${encodeURIComponent(b.name)}">download</a>
    <button class="mini bad" data-restore="${escapeHtml(b.name)}">restore</button>
  </li>`).join('');

  list.querySelectorAll('[data-restore]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.restore;
      // Restoring overwrites a live world. Two confirmations is not too many.
      if (!confirm(`Restore ${name}?\n\nThis REPLACES the current world. The server must be stopped.`)) return;
      if (!confirm('Really restore? The current world will be archived first, but this cannot be undone casually.')) return;
      btn.classList.add('busy');
      const res = await api(`/api/backups/${id}/restore`, { method: 'POST', body: JSON.stringify({ name }) });
      btn.classList.remove('busy');
      alert(res.ok
        ? `Restored. Your previous world was saved as ${res.safetyBackup}.`
        : `Restore failed: ${res.error}`);
      loadBackups(id, node);
    });
  });
}

// ---------------------------------------------------------------------------
// History chart and logs
// ---------------------------------------------------------------------------

async function loadHistory(id, node) {
  const rows = await api(`/api/history/${id}?minutes=180`);
  const svg = node.querySelector('.chart');
  const legend = node.querySelector('.chart-legend');
  if (!rows.length) { legend.textContent = 'no history yet'; return; }

  const W = 300, H = 60;
  // Player count is the interesting series for a game. A service has none, so
  // plot its response time instead — a flat line pinned at zero told you nothing.
  const hasPlayers = rows.some((r) => r.players != null);
  const value = hasPlayers ? (r) => r.players ?? 0 : (r) => r.ms ?? 0;
  const peakValue = Math.max(1, ...rows.map(value));
  const x = (i) => (i / Math.max(1, rows.length - 1)) * W;

  // Red bands mark downtime, blue line is player count.
  const downBands = [];
  let bandStart = null;
  rows.forEach((r, i) => {
    if (!r.up && bandStart === null) bandStart = i;
    if (r.up && bandStart !== null) { downBands.push([bandStart, i]); bandStart = null; }
  });
  if (bandStart !== null) downBands.push([bandStart, rows.length - 1]);

  const line = rows
    .map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${(H - (value(r) / peakValue) * (H - 8) - 4).toFixed(1)}`)
    .join(' ');

  svg.innerHTML = `
    ${downBands.map(([a, b]) => `<rect x="${x(a)}" y="0" width="${Math.max(1, x(b) - x(a))}" height="${H}" fill="#f8514922"/>`).join('')}
    <path d="${line}" fill="none" stroke="#58a6ff" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`;

  const downtime = rows.filter((r) => !r.up).length;
  const uptimePct = Math.round(((rows.length - downtime) / rows.length) * 100);
  const tail = `${uptimePct}% up · ${rows.length} samples`;

  if (hasPlayers) {
    legend.textContent = `peak ${Math.max(0, ...rows.map((r) => r.players ?? 0))} player(s) · ${tail}`;
    return;
  }

  const latencies = rows.map((r) => r.ms).filter((ms) => ms != null);
  legend.textContent = latencies.length
    ? `${Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)} ms avg · ${Math.max(...latencies)} ms peak · ${tail}`
    : tail;
}

async function loadLog(id, node) {
  const res = await api(`/api/logs/${id}?lines=200`);
  const pre = node.querySelector('.logout');
  pre.textContent = res.lines?.length ? res.lines.join('\n') : '(no log found)';
  pre.scrollTop = pre.scrollHeight;
}

function renderAlerts() {
  if (!alerts.length) { alertsEl.innerHTML = '<li class="empty">nothing yet</li>'; return; }
  alertsEl.innerHTML = alerts
    .map((a) => `<li class="${a.level}"><span class="when">${fmtTime(a.t)}</span><span class="who">${escapeHtml(a.targetId)}</span><span class="msg">${escapeHtml(a.message)}</span></li>`)
    .join('');
}

// ---------------------------------------------------------------------------
// Status plumbing: SSE with a polling fallback
// ---------------------------------------------------------------------------

function applyStatus(status) {
  document.getElementById('hostLabel').textContent = status.host;
  document.getElementById('clock').textContent = fmtTime(status.now);

  for (const snap of status.targets) {
    if (ONLY && snap.id !== ONLY) continue;
    if (!cards.has(snap.id)) buildCard(snap);
    render(snap, status.pending);
  }

  const allUp = status.targets.filter((t) => !ONLY || t.id === ONLY).every((t) => t.up);
  document.getElementById('globalDot').className = `dot ${allUp ? 'up' : 'down'}`;
  document.title = ONLY
    ? `${status.targets.find((t) => t.id === ONLY)?.name || 'Panel'}`
    : `${allUp ? '●' : '▲'} Server Control`;
}

function setLive(state) {
  liveEl.className = `live ${state}`;
  liveEl.textContent = state === 'on' ? 'live' : state === 'off' ? 'offline' : 'polling';
}

async function refresh() {
  try {
    applyStatus(await api('/api/status'));
    if (!ONLY) { alerts = await api('/api/alerts?limit=40'); renderAlerts(); }
  } catch {
    document.getElementById('globalDot').className = 'dot down';
    document.getElementById('clock').textContent = 'dashboard offline';
    setLive('off');
  }
}

let pollTimer = null;

function startPolling() {
  if (pollTimer) return;
  setLive('poll');
  pollTimer = setInterval(refresh, 5000);
}

function connectStream() {
  const source = new EventSource('/api/stream');

  source.addEventListener('status', (event) => {
    setLive('on');
    // The stream is working, so the polling fallback is just wasted requests.
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    applyStatus(JSON.parse(event.data));
  });

  source.addEventListener('alert', (event) => {
    if (ONLY) return;
    alerts.unshift(JSON.parse(event.data));
    alerts = alerts.slice(0, 40);
    renderAlerts();
  });

  // EventSource reconnects on its own; fall back to polling meanwhile so the
  // dashboard keeps working on networks that break long-lived connections.
  source.onerror = () => {
    setLive('off');
    startPolling();
  };
}

async function init() {
  try {
    const state = await api('/api/auth-state');
    if (state.enabled) {
      const button = document.getElementById('signout');
      button.classList.remove('hidden');
      button.addEventListener('click', async () => {
        await api('/api/logout', { method: 'POST' });
        location.href = '/login';
      });
    }
  } catch { /* auth state is a nicety, not a requirement */ }

  for (const t of await api('/api/targets')) capabilities.set(t.id, t);

  await refresh();
  if (NO_STREAM) startPolling();
  else connectStream();
}

init();

// History changes slowly; no need to redraw it on every status update.
setInterval(() => cards.forEach((node, id) => loadHistory(id, node)), 60000);
