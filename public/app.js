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

// ---------------------------------------------------------------------------
// Server tabs
//
// One card is on screen at a time and the tab bar picks which. The bar carries
// each server's dot and player count so the thing the old side-by-side grid was
// actually good for -- seeing at a glance that something is down, or that
// somebody is on -- survives showing one card.
// ---------------------------------------------------------------------------
const tabsEl = document.getElementById('serverTabs');
const tabs = new Map(); // id -> button
const TAB_KEY = 'serverControl.tab';
const SCOPE_KEY = 'serverControl.feedScope';
let selected = null;
// The feed follows the open tab by default: when one server is misbehaving, its
// own retries are exactly what buries its history in a shared list.
let feedScope = 'tab';
try { if (localStorage.getItem(SCOPE_KEY) === 'all') feedScope = 'all'; } catch { /* private mode */ }

function buildTabs(targets) {
  if (ONLY || targets.length < 2) return; // one server needs no way to choose it
  tabsEl.innerHTML = '';
  targets.forEach((t, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab';
    btn.setAttribute('role', 'tab');
    btn.dataset.id = t.id;
    btn.id = `tab-${t.id}`;
    btn.setAttribute('aria-controls', `card-${t.id}`);
    btn.innerHTML = '<span class="dot"></span><span class="tab-name"></span><span class="count"></span>';
    btn.querySelector('.tab-name').textContent = t.name;
    btn.title = i < 9 ? `${t.name} (Alt+${i + 1})` : t.name;
    btn.addEventListener('click', () => selectTarget(t.id));
    tabsEl.append(btn);
    tabs.set(t.id, btn);
  });

  // Alt+1..9 from anywhere. Alt rather than a bare digit because half this page
  // is text boxes, and Alt is the one modifier the browser is not already using
  // for its own tabs on this machine.
  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const n = Number(e.key);
    if (!n || n > tabs.size) return;
    e.preventDefault();
    selectTarget([...tabs.keys()][n - 1]);
  });
  // Arrow keys walk the bar, which is what a role=tablist promises a screen
  // reader and a keyboard user it will do.
  tabsEl.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const ids = [...tabs.keys()];
    const next = ids[(ids.indexOf(selected) + step + ids.length) % ids.length];
    selectTarget(next);
    tabs.get(next)?.focus();
  });
  tabsEl.classList.remove('hidden');
}

function selectTarget(id) {
  if (!id) return;
  selected = id;
  // Remembered, because the server you were looking at a minute ago is
  // overwhelmingly the one you want back after a reload or a restart.
  try { localStorage.setItem(TAB_KEY, id); } catch { /* private mode */ }
  tabs.forEach((btn, tid) => {
    const on = tid === id;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
  });
  cards.forEach((node, cid) => node.classList.toggle('is-on', cid === id));

  // The card being opened is the one whose charts are about to be looked at,
  // and it may have been sitting off screen through several of the slow
  // refreshes below. Bring it up to date on the way in.
  const node = cards.get(id);
  if (node) { loadHistory(id, node); loadUsage(id, node); }

  if (!ONLY) renderAlerts(); // the feed follows the tab
}

// The first card to exist wins if nothing was remembered — never no selection
// at all, which would render an empty page.
function ensureSelection(targets) {
  if (selected && targets.some((t) => t.id === selected)) return;
  let stored = null;
  try { stored = localStorage.getItem(TAB_KEY); } catch { /* private mode */ }
  // ?tab=<id> so a link can point at one server without opening the stripped-down
  // pop-out window, which is a different thing and loses the tab bar.
  const asked = params.get('tab');
  const valid = (id) => id && targets.some((t) => t.id === id);
  const pick = ONLY || (valid(asked) ? asked : null) || (valid(stored) ? stored : null) || targets[0]?.id;
  selectTarget(pick);
}

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

// A span of seconds, for things that are not uptime: how long a save has been
// sitting on disk, how many hours a world has been played. Same shape as
// fmtUptime deliberately — two units, largest first — so a card carrying both
// does not read as two different clocks.
function fmtSpan(secs) {
  if (secs == null || !Number.isFinite(secs) || secs < 0) return '—';
  if (secs < 60) return `${Math.floor(secs)}s`;
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
  if (!ONLY && tabs.has(target.id)) {
    node.id = `card-${target.id}`;
    node.setAttribute('role', 'tabpanel');
    node.setAttribute('aria-labelledby', `tab-${target.id}`);
  }
  if (target.kind === 'service') node.classList.add('service-kind');
  if (target.kind === 'service') dropUsageCharts(node.querySelector('.chart-wrap'));
  node.querySelector('.name').textContent = target.name;

  // Hide controls this target can't perform, rather than offering buttons whose
  // only possible outcome is an error.
  const hide = (sel) => node.querySelector(sel)?.classList.add('hidden');
  if (caps.canSave === false) hide('[data-act=save]');
  if (caps.canBroadcast === false) {
    hide('.broadcast-msg');
    hide('[data-act=broadcast]');
  }
  // The delayed restart is the dashboard's own timer and does not need a way to
  // talk to the server, so it is kept separate from broadcast: without a chat
  // channel it still restarts on time, it just cannot tell anyone first. Losing
  // the ability to schedule a restart at all was too high a price for that.
  if (!caps.canDelayRestart) hide('.delay-row');
  if (!caps.canRestartWhenEmpty) hide('[data-act=restartWhenEmpty]');
  if (caps.canConsole === false) hide('.console');
  if (!caps.hasMods) hide('.mods');
  // The panel lists mods for any game with a mods folder; only a workshop
  // install with somewhere to copy into can refresh one. Two different
  // questions, so two different flags. The panel's copy of the button is always
  // there for a target that can refresh; the banner's appears only alongside a
  // notice about a mod it could act on, and renderMods owns that one.
  if (caps.canRefreshMods) node.querySelector('.mods .mods-install')?.classList.remove('hidden');
  // A Paper server whose plugins have publishers the dashboard knows. Separate
  // from the Steam button above: different half of the install, different
  // promise -- this one downloads and installs by itself.
  if (caps.canUpdatePlugins) node.querySelector('.mods .plugins-update')?.classList.remove('hidden');

  // Where the console and the broadcast box would have been, say which game
  // this is and why it has neither — a card that is simply missing half of
  // another card's controls looks broken.
  if (caps.remoteNote) {
    const note = node.querySelector('.no-remote');
    note.textContent = caps.remoteNote;
    note.classList.remove('hidden');
  }
  if (caps.canStart === false) hide('[data-act=start]');
  if (!caps.canUpdate) hide('[data-act=updateRestart]');
  if (!caps.canCheckUpdate) hide('[data-act=updateBegin]');
  if (caps.hasBackup === false) hide('.backups');
  if (caps.hasLog === false) hide('.logs');
  if (!caps.canModerate) hide('.moderation');
  // Hidden only when there is genuinely nothing to show. A game with no control
  // transport still gets the panel if it answers Steam queries — the count is
  // the point of the card for those.
  if (caps.transport === 'none' && !caps.hasQuery) hide('.players-list');

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
  // The array is mutated in place by the feed below, so the danger check in
  // sendRcon sees discovered commands too rather than only the curated ones.
  caps.consoleCommands = caps.consoleCommands || [];
  commandFeeds.set(target.id,
    wireCommandPicker(node, rconInput, caps.consoleCommands, caps.consoleArgs || {}, target.id,
      caps.consoleAliases || {}));
  // Not deferred until the Commands panel is opened: the point of this is Tab
  // completion in the console, and nobody opens a reference panel first.
  primeCommandPicker(target.id);
  // Same reasoning for the roster: it is what `prism stats <player>` completes
  // from, and a suggestion list that only fills in after the first lookup is a
  // suggestion list nobody notices.
  if (JSON.stringify(caps.consoleArgs || {}).includes('@knownPlayers')) primeKnownPlayers(target.id);

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

    const known = findCommand(caps.consoleCommands, command, caps.consoleAliases || {});
    if (known?.danger && !confirm(`${command}\n\n${known.description}\n\nRun it?`)) return;

    const out = node.querySelector('.output');
    writeConsole(out, `> ${command}\n…`);
    const res = await api(`/api/rcon/${target.id}`, {
      method: 'POST',
      body: JSON.stringify({ command }),
    });
    writeConsole(out, `> ${command}\n${res.ok ? (res.body || '(no output)') : `ERROR: ${res.error}`}`);
    out.scrollTop = 0; // a long report is read from its first line, not its last
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
  wireMods(target, node);
  wireCommands(target, node);
  wireModeration(target, node);

  node.querySelectorAll('.chart-tab').forEach((btn) => {
    btn.addEventListener('click', () => selectChartView(node.querySelector('.chart-wrap'), btn.dataset.view));
  });

  node.classList.toggle('is-on', target.id === selected);
  cardsEl.append(node);
  cards.set(target.id, node);
  loadHistory(target.id, node);
  loadUsage(target.id, node);
  return node;
}

// --- feeding discovered commands into the console ---------------------------
//
// The picker above is a curated per-game list: a handful of commands with
// argument hints and danger flags, which is what makes "gamerule <rule>
// <value>" complete a rule and then true/false. It knows nothing about the
// plugins installed on any particular server.
//
// /api/commands supplies those, so they are appended to the same array the
// typeahead already reads. They come in weaker -- a bare command word, no
// argument shapes -- but that is enough for Tab to finish "/herobrinest" and
// enough for the dropdown to list them.

const commandFeeds = new Map(); // target id -> the adder returned by wireCommandPicker

// Commands worth a confirm even though nothing declared them dangerous. The
// curated lists carry their own flags; this is only for discovered rows, where
// the alternative is no warning at all on a command that stops the server.
const RISKY_DISCOVERED = /^(stop|restart|reload|rl|end|kill|killall|op|deop|ban|ban-ip|banip|pardon|kick|whitelist|save-off|purge|wipe|reset|deleteallclaims|deleteclaimsinworld|ecoadmin)$/i;

// --- turning a declared usage string into completable shapes -----------------
//
// Without this a discovered command is a single bare word and Tab has nothing to
// say after it -- you are expected to already know that /herobrine takes
// "status". The usage line in plugin.yml does know, so it is parsed into the
// same slot shapes the curated lists use, which buys two things for free from
// the existing typeahead: <a|b> alternatives become suggestable words, and
// <player> completes with whoever is actually online.
//
// It is defensive on purpose. Real usage strings on this server include prose
// running off the end ("<player>  Grants a player permission to build."), a bare
// "|", the literal "or", nested brackets, and one plugin whose usage misspells
// its own command as /spawan. Anything not understood is dropped rather than
// guessed at, leaving that command exactly as good as it was before.

// Split on whitespace, but keep a bracket group together however deeply it
// nests: "[status|wake [minutes]|sleep]" is one token, not two.
function tokenizeUsage(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '<' || ch === '[') depth += 1;
    if (ch === '>' || ch === ']') depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      if (cur) { out.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// "status|wake [minutes]|sleep" -> ["status", "wake [minutes]", "sleep"],
// splitting only on the bars that are not inside a nested group.
function splitAlternatives(inner) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '<' || ch === '[') depth += 1;
    if (ch === '>' || ch === ']') depth = Math.max(0, depth - 1);
    if (ch === '|' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  const bars = out.filter(Boolean);
  // TPA spells its choices with slashes rather than bars -- [player/warp/spawn].
  // Only applied when bars found nothing and the group is a single bare word
  // run, so a placeholder that happens to contain a slash is left alone.
  if (bars.length === 1 && /^[^\s<>[\]]+\/[^\s<>[\]]+$/.test(bars[0])) {
    return bars[0].split('/').map((s) => s.trim()).filter(Boolean);
  }
  return bars;
}

// Placeholder names that mean "a player" in a language the typeahead's own
// player detection does not read. TPA is a Chinese-language plugin and its
// /tpa <玩家名称> is one of the most-used commands on this server, so it is
// worth the entry to have it complete real names.
const PLAYER_WORDS = { '玩家名称': 'player', 'jugador': 'player', 'spieler': 'player' };

// What to call a placeholder so the typeahead recognises it. Anything that
// looks like a player becomes exactly "player", which is the name its own
// option lookup keys on -- that covers <playerName>, <player1>, <player name>
// and the translated spellings in one rule. Everything else keeps its name and
// simply has no options to offer, which is still better than being mistaken for
// a literal word the user is expected to type.
function placeholderName(raw) {
  const name = PLAYER_WORDS[raw.trim()] || raw.trim();
  if (/player|gamertag/i.test(name)) return 'player';
  return name.replace(/\s+/g, ''); // slots are split on whitespace; a two-word one would break
}

const BRACKETED = /^[<[](.*)[>\]]$/;
const MAX_VARIANTS = 12;

// Square brackets are ambiguous in Bukkit usage strings and the two meanings
// need opposite treatment: "[reload]" is a word you type, "[player]" is a value
// you supply. Angle brackets are never ambiguous -- always a value. So a lone
// square-bracket group is only treated as a value when it names one.
const VALUE_WORDS = /^(player|players|target|name|username|gamertag|amount|number|num|count|radius|size|distance|world|minutes|seconds|time|state|category|item|block|tool|page|value|id|level|reason|message|text|x|y|z)$/i;

// Anything outside ASCII is an argument described in another language, not an
// English subcommand anyone types: TPA writes "[player/warp/spawn]" (words to
// type) alongside "[玩家名称/传送点名称]" (descriptions of values). Without this
// the second one lands in the console as literal text to send.
const NON_ASCII = /[^ -]/;

/**
 * One alternative inside a bracket group, as slot text.
 *
 * @param choice   true when the group offered several alternatives, which makes
 *                 plain words literal subcommands rather than value names
 * @param optional true for a [square] group, false for an <angle> one
 */
function renderAlt(alt, { choice, optional }) {
  const pieces = tokenizeUsage(alt);
  // Something like "wake [minutes]": a literal followed by its own slot.
  if (pieces.some((x) => BRACKETED.test(x))) {
    return pieces.map((piece) => {
      const inner = piece.match(BRACKETED);
      return inner ? `<${placeholderName(inner[1])}>` : piece;
    });
  }
  const translated = Boolean(PLAYER_WORDS[alt.trim()]) || NON_ASCII.test(alt);
  const isValue = translated
    || (choice ? false : (!optional || VALUE_WORDS.test(alt.trim())));
  return isValue ? [`<${placeholderName(alt)}>`] : [alt];
}

// One usage line -> the command patterns it describes. Returns [] when there is
// nothing beyond the command word itself.
function expandUsage(name, usage) {
  if (!usage || !/[<[]/.test(usage)) return [];
  const tokens = tokenizeUsage(usage.replace(/^\//, '').trim());
  if (!tokens.length) return [];

  // The first token is the command's own name however it was spelled -- Bukkit's
  // literal "<command>", the real name, or a typo. It is never an argument, so
  // it is always replaced with the name we actually know.
  let forms = [[name]];

  for (const token of tokens.slice(1)) {
    const m = token.match(BRACKETED);
    // Prose, "or", a stray "|": everything from here on is not a slot, and the
    // slots already collected are still good.
    if (!m) break;

    const optional = token.startsWith('[');
    const alts = splitAlternatives(m[1]);
    const next = [];

    for (const form of forms) {
      // An optional group means the command is also valid without it.
      if (optional) next.push(form);
      for (const alt of alts) {
        if (!alt) continue;
        next.push([...form, ...renderAlt(alt, { choice: alts.length > 1, optional })]);
      }
    }
    forms = next;
    if (forms.length > MAX_VARIANTS) return [];
  }

  // A single form that is just the bare name adds nothing over the plain row.
  return forms.map((f) => f.join(' ')).filter((f) => f !== name);
}

// The API payload flattened into picker rows. Aliases become rows of their own:
// /hbstrike is the spelling anyone will actually type, and Tab cannot offer it
// if it only exists inside another row's description.
function toPickerRows(payload) {
  const rows = [];
  const push = (name, description, from, usage) => {
    if (!name || /[^\w+.-]/.test(name)) return; // a name with a space is not a command word
    const meta = {
      description: [description, from].filter(Boolean).join(' · '),
      danger: RISKY_DISCOVERED.test(name),
      discovered: true,
    };
    rows.push({ command: name, ...meta });
    // The expanded shapes are what Tab walks; they are flagged so the dropdown
    // can still show one tidy row per command instead of every branch of it.
    for (const form of expandUsage(name, usage)) {
      rows.push({ command: form, ...meta, variant: true });
    }
  };

  for (const g of payload.plugins ?? []) {
    for (const c of g.commands ?? []) {
      push(c.name, c.description, g.plugin, c.usage);
      for (const a of c.aliases ?? []) push(a, `alias for /${c.name}`, g.plugin, c.usage);
    }
  }
  // Runtime-registered commands have no plugin to name them after; vanilla is
  // deliberately left out, since the curated list already covers what is worth
  // reaching for and 88 more rows would bury it.
  for (const c of payload.runtime ?? []) push(c.name, c.description, null);
  return rows;
}

async function primeCommandPicker(id, { retry = true } = {}) {
  const feed = commandFeeds.get(id);
  if (!feed) return 0;
  let res;
  try {
    res = await api(`/api/commands/${id}`);
  } catch {
    return 0; // no console commands beyond the curated ones; nothing else breaks
  }
  if (!res?.ok) return 0;
  const added = feed(toPickerRows(res));

  // The first call lands before the live /help sweep it just kicked off has
  // finished, so the runtime-registered commands -- /jobs, /prism, /ah -- are
  // not in that payload yet. Come back for them once. Re-feeding is safe: the
  // adder drops anything already present.
  if (res.pending && retry) {
    setTimeout(() => primeCommandPicker(id, { retry: false }), 12000);
  }
  return added;
}

// --- commands panel ---------------------------------------------------------
//
// Every command the plugins on this server provide, read out of the jars on each
// open so adding a plugin is enough to make it appear -- there is no list here to
// maintain. The server's own /help fills in what the jars cannot declare; see
// src/commands.js for why both halves are needed.

function cmdRow(c, targetId) {
  const aliases = c.aliases?.length
    ? `<span class="cmd-alias">${escapeHtml(c.aliases.map((a) => `/${a}`).join(' '))}</span>` : '';
  // "declared but not registered" is the one state worth flagging: it usually
  // means the plugin failed to load, or the server is down.
  const flag = c.source === 'jar'
    ? '<span class="cmd-flag" title="Declared in the jar but not registered on the running server">not live</span>'
    : '';
  const perm = c.permission
    ? `<span class="cmd-perm" title="Permission node">${escapeHtml(c.permission)}</span>` : '';
  const desc = c.description ? `<div class="cmd-desc">${escapeHtml(c.description)}</div>` : '';
  const usage = c.usage && c.usage !== `/${c.name}`
    ? `<div class="cmd-usage">${escapeHtml(c.usage)}</div>` : '';
  return `<li class="cmd" data-cmd="${escapeHtml(c.name)}" data-target="${escapeHtml(targetId)}">
    <div class="cmd-head"><code>/${escapeHtml(c.name)}</code>${aliases}${flag}${perm}</div>
    ${desc}${usage}</li>`;
}

function renderCommands(node, res, targetId) {
  const list = node.querySelector('.cmdlist');
  const groups = [];

  for (const g of res.plugins ?? []) {
    groups.push(`<div class="cmd-group"><h4>${escapeHtml(g.plugin)}`
      + `${g.version ? ` <span class="cmd-ver">${escapeHtml(g.version)}</span>` : ''}</h4>`
      + `<ul>${g.commands.map((c) => cmdRow(c, targetId)).join('')}</ul></div>`);
  }

  // Registered but claimed by no jar. This is where a Brigadier command and a
  // plugin that names its command in its own config end up, so it is a real
  // section rather than a leftovers bin.
  if (res.runtime?.length) {
    groups.push('<div class="cmd-group"><h4>Registered at runtime '
      + '<span class="cmd-ver">no jar declares these</span></h4>'
      + `<ul>${res.runtime.map((c) => cmdRow(c, targetId)).join('')}</ul></div>`);
  }
  if (res.vanilla?.length) {
    groups.push(`<details class="cmd-group cmd-vanilla"><summary>Vanilla Minecraft (${res.vanilla.length})</summary>`
      + `<ul>${res.vanilla.map((c) => cmdRow(c, targetId)).join('')}</ul></details>`);
  }

  list.innerHTML = groups.length ? groups.join('') : '<div class="empty">no commands found</div>';
}

function filterCommands(node, term) {
  const q = term.trim().toLowerCase();
  let shown = 0;
  node.querySelectorAll('.cmdlist .cmd').forEach((li) => {
    const hit = !q || li.textContent.toLowerCase().includes(q);
    li.classList.toggle('hidden', !hit);
    if (hit) shown += 1;
  });
  // A group whose every row is filtered out is just a heading with nothing
  // under it, so it goes too.
  node.querySelectorAll('.cmdlist .cmd-group').forEach((g) => {
    g.classList.toggle('hidden', !g.querySelector('.cmd:not(.hidden)'));
  });
  return shown;
}

async function loadCommands(id, node, { refresh = false } = {}) {
  const details = node.querySelector('details.commands');
  if (!details) return;
  const status = node.querySelector('.cmd-status');
  const count = node.querySelector('.cmd-count');
  const where = node.querySelector('.cmd-where');

  let res;
  try {
    res = await api(`/api/commands/${id}${refresh ? '?refresh=1' : ''}`);
  } catch {
    return;
  }

  // A server with no plugins folder has nothing to show; hide rather than
  // display an empty panel that looks broken.
  if (!res.ok) { details.classList.add('hidden'); return; }
  details.classList.remove('hidden');

  const c = res.counts || {};
  count.textContent = `· ${c.declared || 0} from ${c.plugins || 0} plugin${c.plugins === 1 ? '' : 's'}`
    + (res.runtime?.length ? ` · ${res.runtime.length} runtime` : '');

  renderCommands(node, res, id);
  const filter = node.querySelector('.cmd-filter');
  if (filter?.value) filterCommands(node, filter.value);

  // Be explicit about which half of the list is live and which is from disk --
  // "not live" flags mean nothing if you cannot tell the sweep never ran.
  if (res.pending) {
    status.textContent = 'reading commands from the server…';
    status.className = 'cmd-status';
  } else if (res.live?.error) {
    status.textContent = `server list unavailable — ${res.live.error}`;
    status.className = 'cmd-status warn';
  } else if (res.live) {
    status.textContent = `server list read ${fmtTime(res.live.at)}${res.live.stale ? ' (refreshing)' : ''}`;
    status.className = 'cmd-status';
  }

  where.innerHTML = '<div>Read from the plugin jars on every open, so a new plugin '
    + 'shows up here as soon as it is installed. Click a command to put it in the console box.</div>';
}

function wireCommands(target, node) {
  const details = node.querySelector('details.commands');
  if (!details) return;

  details.addEventListener('toggle', function () {
    if (this.open) loadCommands(target.id, node);
  });

  node.querySelector('.cmd-refresh').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.classList.add('busy');
    await loadCommands(target.id, node, { refresh: true });
    await primeCommandPicker(target.id, { retry: false });
    btn.classList.remove('busy');
  });

  const filter = node.querySelector('.cmd-filter');
  filter.addEventListener('input', () => filterCommands(node, filter.value));

  // Clicking a row loads it into the console rather than running it. Most of
  // these carry no argument hints, so a click would often send an incomplete
  // command -- and a click that runs something is a bad default next to a list
  // this long anyway.
  node.querySelector('.cmdlist').addEventListener('click', (event) => {
    const li = event.target.closest('.cmd');
    if (!li) return;
    const input = node.querySelector('.rcon-input');
    if (!input) return;
    input.value = li.dataset.cmd;
    input.focus();
    input.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
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

// The same command under another name. /arena is also /duelarena, /soloarena
// and four more spellings, and a child who types the long one should get the
// same subcommands as one who types the short one -- so the first word is
// swapped for the real command before anything is matched against it, rather
// than the profile carrying six copies of the list. Only the first word: an
// alias renames a command, never an argument to one.
function canonicalize(words, aliases) {
  if (!words.length || !aliases) return words;
  const real = aliases[words[0].toLowerCase()];
  return real ? [real, ...words.slice(1)] : words;
}

// Which known command is the user typing? Longest match wins, so "ban add"
// beats a bare "ban".
function findCommand(commands, typed, aliases) {
  if (!commands?.length || !typed?.trim()) return null;
  const words = canonicalize(typed.trim().toLowerCase().split(/\s+/), aliases);
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

// A console pane sized to what came back.
//
// Most replies are one line, and a 460px box of empty black under every "ok" is
// wasted screen. But `prism stats` answers with sixty lines, and reading those
// eight at a time through a 190px slot is the thing this exists to stop. So the
// pane keeps its small default and doubles only when the reply has earned it --
// measured on the rendered text, because "large response" is not something a
// character count can tell you once wrapping is involved.
//
// scrollHeight is the full content height whatever the max-height is, so the
// class has to come off before measuring, or a pane that once grew could never
// shrink back down.
const OUTPUT_BASE_PX = 190;
function fitOutput(el) {
  if (!el) return;
  el.classList.remove('tall');
  if (el.scrollHeight > OUTPUT_BASE_PX + 24) el.classList.add('tall');
}

// --- console colour ---------------------------------------------------------
//
// Plugins answer in colour and the console was showing the codes. A `prism
// status` reply arrives as "§7》 Version: §x§4§f§f§f§d§34.4", which is not a
// formatting nicety to lose -- it is six lines of punctuation soup wrapped
// around the four characters anybody wanted. The same is true of the log tail,
// which Paper writes with ANSI escapes.
//
// Both are rendered rather than stripped, because the colour is carrying real
// meaning: Prism paints its errors red, and the log paints WARN and ERROR.
//
// THE PALETTE IS NOT MINECRAFT'S. Minecraft's is designed for a light-on-dark
// game world where §0 is black and §8 is dark grey; on this pane those are
// invisible, and §8 in particular is what half the plugins here prefix their
// output with. Each entry is the same hue lifted to something readable on
// --input, which is the whole point of doing this at all.
const MC_COLORS = {
  0: '#8892a0', 1: '#6b8cff', 2: '#4fbf6a', 3: '#3fbfbf',
  4: '#e06c66', 5: '#b57ee0', 6: '#e0a33f', 7: '#b9c4d0',
  8: '#8b98a8', 9: '#79b8ff', a: '#56d364', b: '#56d8d8',
  c: '#ff7b72', d: '#e58af0', e: '#e3b341', f: '#eaf1f8',
};

// Paper's log, and anything else that writes ANSI. Bright and normal are given
// the same value: the distinction is not worth two palettes, and half the
// writers pick between them arbitrarily.
const ANSI_COLORS = {
  30: MC_COLORS[0], 31: MC_COLORS.c, 32: MC_COLORS.a, 33: MC_COLORS.e,
  34: MC_COLORS[9], 35: MC_COLORS.d, 36: MC_COLORS.b, 37: MC_COLORS[7],
  90: MC_COLORS[8], 91: MC_COLORS.c, 92: MC_COLORS.a, 93: MC_COLORS.e,
  94: MC_COLORS[9], 95: MC_COLORS.d, 96: MC_COLORS.b, 97: MC_COLORS.f,
};

// A §x hex colour is chosen by the plugin author against a black chat box, so
// it can land anywhere -- Prism's own banner runs through #00f2fa to #f3ffa8,
// and the dark end of a gradient like that disappears here. Anything below the
// floor is mixed toward white until it clears it, which keeps the hue and the
// gradient while making every step of it readable.
const MIN_LUMA = 0.42;
function readable(hex) {
  let [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const luma = () => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  for (let i = 0; i < 8 && luma() < MIN_LUMA; i += 1) {
    [r, g, b] = [r, g, b].map((c) => Math.round(c + (255 - c) * 0.28));
  }
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

// One run of text and how it is painted, as a <span> or as nothing when it is
// plain. `state` is mutated by the parsers above it, so a colour set on one
// line carries on to the next exactly as it does in game.
function styledSpan(text, state) {
  if (!text) return '';
  const css = [];
  if (state.color) css.push(`color:${state.color}`);
  if (state.bold) css.push('font-weight:700');
  if (state.italic) css.push('font-style:italic');
  if (state.underline || state.strike) {
    css.push(`text-decoration:${[state.underline && 'underline', state.strike && 'line-through'].filter(Boolean).join(' ')}`);
  }
  const body = escapeHtml(text);
  return css.length ? `<span style="${css.join(';')}">${body}</span>` : body;
}

const SECTION = /§(x(?:§[0-9a-fA-F]){6}|[0-9a-fA-Fk-orK-OR])/g;
const ANSI = /\u001b\[([0-9;]*)m/g;

/** Server output, colour codes and all, as HTML for a <pre>. */
function colorize(raw) {
  const text = String(raw ?? '');
  const state = { color: '', bold: false, italic: false, underline: false, strike: false };
  const reset = () => Object.assign(state, { color: '', bold: false, italic: false, underline: false, strike: false });
  let html = '';
  let at = 0;

  // One pass over whichever code comes next, so a line carrying both -- a log
  // line quoting a plugin message -- is handled without two passes fighting.
  const both = new RegExp(`${SECTION.source}|${ANSI.source}`, 'g');
  for (let m = both.exec(text); m; m = both.exec(text)) {
    html += styledSpan(text.slice(at, m.index), state);
    at = m.index + m[0].length;

    if (m[1] !== undefined) {
      const code = m[1].toLowerCase();
      if (code[0] === 'x') state.color = readable(`#${code.replace(/§/g, '').slice(1)}`);
      else if (code === 'r') reset();
      else if (code === 'l') state.bold = true;
      else if (code === 'o') state.italic = true;
      else if (code === 'n') state.underline = true;
      else if (code === 'm') state.strike = true;
      else if (code === 'k') { /* obfuscated: shown as the plain text under it */ }
      else if (MC_COLORS[code]) { reset(); state.color = MC_COLORS[code]; }
      continue;
    }

    // ANSI. Only the parts that carry meaning here; backgrounds and cursor
    // moves are dropped rather than guessed at.
    for (const part of (m[2] || '0').split(';')) {
      const n = Number(part || 0);
      if (n === 0) reset();
      else if (n === 1) state.bold = true;
      else if (n === 3) state.italic = true;
      else if (n === 4) state.underline = true;
      else if (n === 22) state.bold = false;
      else if (ANSI_COLORS[n]) state.color = ANSI_COLORS[n];
      else if (n === 39) state.color = '';
    }
  }
  return html + styledSpan(text.slice(at), state);
}

/** Write server output into a <pre>, painted, and size the pane to it. */
function writeConsole(el, text) {
  if (!el) return;
  el.innerHTML = colorize(text);
  fitOutput(el);
}

function wireCommandPicker(node, input, commands, argValues, targetId, aliases) {
  const select = node.querySelector('.rcon-pick');
  const help = node.querySelector('.cmd-help');

  const option = (c) => {
    const el = document.createElement('option');
    el.value = c.command;
    el.textContent = `${c.danger ? '⚠ ' : ''}${c.command}${c.description ? ` — ${c.description}` : ''}`;
    el.title = c.description || c.command;
    return el;
  };

  // Rebuilt rather than appended to, because discovered commands arrive after
  // the card is already on screen and the curated ones must stay on top.
  const fill = () => {
    select.innerHTML = '<option value="">Commands…</option>';
    const group = (label, rows) => {
      if (!rows.length) return;
      const g = document.createElement('optgroup');
      g.label = label;
      rows.forEach((c) => g.append(option(c)));
      select.append(g);
    };
    const curated = commands.filter((c) => !c.discovered);
    const found = commands.filter((c) => c.discovered && !c.variant);
    const risky = curated.filter((c) => c.danger);
    const safe = curated.filter((c) => !c.danger);
    // Only split the curated list when there is something to warn about.
    if (risky.length) {
      group('Commands', safe);
      group('Careful — affects everyone', risky);
    } else {
      safe.forEach((c) => select.append(option(c)));
    }
    // Kept as its own group and kept last: these come with no argument hints
    // and no danger flags, so they are a weaker thing than the curated rows
    // above and should not be mixed in among them.
    group('From plugins on this server', found);
    node.querySelector('.rcon-pickrow').classList.toggle('hidden', !commands.length);
  };
  fill();

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
    // The caret has just landed on a <placeholder>; tell the typeahead so it
    // can offer that slot's values straight away.
    input.dispatchEvent(new Event('input'));
    select.value = ''; // so picking the same command twice still fires
  });

  input.addEventListener('input', () => showHelp(findCommand(commands, input.value, aliases)));

  wireTypeahead(node, input, commands, argValues || {}, targetId, showHelp, aliases);

  // How discovered commands get in later. The array is captured by reference by
  // wireTypeahead, so pushing into it is enough for Tab completion; the select
  // is the only part that has to be told.
  return (rows) => {
    // Two different tests. `leads` is which command *words* are already spoken
    // for, so a curated entry keeps its argument hints and the discovered bare
    // word is dropped. `seen` is exact strings, so the expanded variants of a
    // command can all go in without colliding with each other.
    const leads = new Set(commands.map((c) => commandLead(c.command)[0]).filter(Boolean));
    const seen = new Set(commands.map((c) => c.command.toLowerCase()));
    const curated = new Set(leads);
    let added = 0;
    for (const r of rows) {
      const lead = commandLead(r.command)[0];
      // Dropping the base word to a curated entry has to drop its variants too,
      // or the curated shape and a half-parsed usage line would both be offered.
      if (curated.has(lead)) continue;
      if (seen.has(r.command.toLowerCase())) continue;
      seen.add(r.command.toLowerCase());
      leads.add(lead);
      commands.push(r);
      added += 1;
    }
    if (added) fill();
    return added;
  };
}

// --- next-word suggestions ---------------------------------------------------
//
// The dropdown above is one flat menu of whole commands, which stops working
// the moment a command has more than a couple of shapes: "gamerule" alone has
// fifty rules behind it and each rule has its own set of legal values. So the
// console also completes a word at a time -- pick "gamerule", get the rules;
// pick a rule, get true/false or the numbers that rule takes.
//
// It stays a plain text box throughout. Nothing here filters what can be sent;
// a command the profile has never heard of is typed and run exactly as before,
// and the suggestions simply have nothing to say about it.

// The players currently online, per target, so <player> can be completed with
// people who are actually there. Filled by render().
const onlinePlayers = new Map();

// Everyone who has ever played, per target, for the slots where "online now" is
// the wrong list -- `prism stats` is asked about the child who logged off an
// hour ago far more often than about the one standing in front of you. Fetched
// once per card from /api/players, which reads it off disk; see
// src/playerstats.js. Empty until it arrives, and the slot falls back to the
// online list in the meantime rather than offering nothing.
const knownPlayerLists = new Map();

async function primeKnownPlayers(id) {
  try {
    const res = await api(`/api/players/${id}`);
    if (res?.ok && res.players?.length) knownPlayerLists.set(id, res.players);
  } catch { /* the online list still completes the slot */ }
}

// A slot is either a literal word or a <placeholder>, and a placeholder may
// arrive wrapped in quotes because the game needs them -- Source's kick takes
// "<name>" so that a name with a space in it survives the trip. The quotes
// belong to the slot, so they travel with whatever is suggested for it.
function slotShape(slot) {
  const m = slot.match(/^(")?<(.+)>"?$/);
  return m ? { name: m[2], quote: m[1] || '' } : null;
}

const isPlaceholder = (slot) => slotShape(slot) !== null;

// One option list, from whichever form the profile wrote it in. The '@' lists
// are resolved here rather than in the profile because they are a different
// answer every minute.
function resolveOptions(spec, targetId) {
  if (spec === '@knownPlayers') {
    const roster = knownPlayerLists.get(targetId);
    if (!roster?.length) return resolveOptions('@players', targetId);
    const now = Date.now() / 1000;
    const ago = (secs) => {
      if (!secs) return 'never seen in the block log';
      const days = Math.floor((now - secs) / 86400);
      return days <= 0 ? 'played today' : days === 1 ? 'played yesterday' : `${days} days ago`;
    };
    return roster.map((p) => ({
      value: p.name,
      description: `${ago(p.last)}${p.bedrock ? ' · Bedrock' : ''}`,
    }));
  }
  if (spec === '@players' || spec === '@playerIds') {
    const players = onlinePlayers.get(targetId) || [];
    // Two lists because games disagree about what identifies a player: ARK and
    // 7DTD want the id and would reject the name, Minecraft wants the name and
    // has no id to offer. The id list is labelled with the name, since an id is
    // not something anyone recognises on sight.
    const rows = spec === '@players'
      ? players.filter((p) => p.name).map((p) => ({ value: p.name, description: 'online now' }))
      : players.filter((p) => p.id).map((p) => ({ value: p.id, description: p.name || 'online now' }));
    return rows.length ? rows : null;
  }
  return Array.isArray(spec) && spec.length ? spec : null;
}

// What may go in this slot. `carried` is the previous option's own `values`,
// which beats the placeholder's name: it is how <value> after a gamerule knows
// to offer true/false rather than the same list for every rule.
function slotOptions(slot, carried, argValues, targetId) {
  const shape = slotShape(slot);
  if (!shape) return null;

  let opts = null;
  if (carried) opts = resolveOptions(carried, targetId);
  // <peaceful|easy|normal|hard> spells its own options out inline.
  else if (shape.name.includes('|')) opts = shape.name.split('|').map((v) => ({ value: v.trim() })).filter((o) => o.value);
  else if (argValues[shape.name]) opts = resolveOptions(argValues[shape.name], targetId);
  // No table for it, but a slot called <player> can only want a player, and one
  // called <steamID> can only want the same player's id.
  else if (/^(player|target|name|gamertag)$/i.test(shape.name)) opts = resolveOptions('@players', targetId);
  else if (/^(steamid|eosid|playerid|userid|entityid)$/i.test(shape.name)) opts = resolveOptions('@playerIds', targetId);

  if (!opts?.length) return null;
  return shape.quote ? opts.map((o) => ({ ...o, value: `${shape.quote}${o.value}${shape.quote}` })) : opts;
}

// Candidates for the word at position `words.length`, given the words already
// typed. Each command is walked slot by slot: literals must match what was
// typed, placeholders swallow whatever is there and hand their chosen option's
// `values` on to the next slot.
function nextWords(commands, argValues, words, targetId) {
  const found = [];
  for (const c of commands) {
    const slots = c.command.trim().split(/\s+/);
    // One word past the last slot is still worth walking: an option's `values`
    // can open a slot the command string never spelled out, which is how
    // "whitelist add" goes on to offer players while "whitelist list" stops.
    if (slots.length < words.length) continue;

    let carried = null;
    let matches = true;
    for (let i = 0; i < words.length; i += 1) {
      const opts = slotOptions(slots[i], carried, argValues, targetId);
      if (isPlaceholder(slots[i])) {
        const picked = opts?.find((o) => o.value.toLowerCase() === words[i].toLowerCase());
        carried = picked?.values ?? null;
      } else if (slots[i].toLowerCase() !== words[i].toLowerCase()) {
        matches = false;
        break;
      } else {
        carried = null;
      }
    }
    if (!matches) continue;

    const slot = slots[words.length];
    if (slot === undefined) {
      // Off the end of the command: only a carried list has anything to add.
      const extra = resolveOptions(carried, targetId);
      if (extra) for (const o of extra) found.push({ value: o.value, description: o.description || '', danger: false, from: c });
      continue;
    }

    const last = words.length === slots.length - 1;
    const opts = slotOptions(slot, carried, argValues, targetId);
    if (opts) {
      for (const o of opts) found.push({ value: o.value, description: o.description || '', danger: false, from: c });
    } else if (!isPlaceholder(slot)) {
      // A literal word carries the command's own description only when it is
      // the whole command -- "say" should not be labelled with what <message>
      // does, and the danger warning belongs on "stop", not on a prefix of it.
      found.push({ value: slot, description: last ? c.description : '', danger: last && Boolean(c.danger), from: c });
    }
    // A placeholder with no options is free text: nothing useful to suggest.
  }

  // Same word reached through several commands -- "save" leads to hold, query
  // and resume. Keep one row, and only claim a description or a danger warning
  // when every command behind that word agrees on it.
  const merged = new Map();
  for (const row of found) {
    const key = row.value.toLowerCase();
    const seen = merged.get(key);
    if (!seen) { merged.set(key, { ...row, sources: 1 }); continue; }
    seen.sources += 1;
    if (seen.description !== row.description) seen.description = '';
    if (!row.danger) seen.danger = false;
  }
  return [...merged.values()];
}

// Is another word expected after these? Separate from having something to
// suggest: `say <message>` offers no options for the message but still wants
// one, so accepting "say" should leave the caret a space along rather than
// hard against the end of the word.
function expectsMore(commands, words) {
  return commands.some((c) => {
    const slots = c.command.trim().split(/\s+/);
    if (slots.length <= words.length) return false;
    return slots.every((s, i) => i >= words.length || isPlaceholder(s) || s.toLowerCase() === words[i].toLowerCase());
  });
}

// Split typed text into words, keeping a quoted run together. Whitespace alone
// would be wrong for exactly the games the quotes are there for: "Kid
// Gamertag" is one word, and splitting it into two walks the command a slot
// further along than the typist has actually got.
function splitWords(text) {
  return text.match(/"[^"]*"?|\S+/g) || [];
}

// Where the caret is, as a word. A caret sitting inside an unfilled <message>
// is treated as being on an empty word, so the options replace the whole
// placeholder rather than being typed into the middle of it.
function wordAtCaret(value, caret) {
  let start = caret;
  while (start > 0 && !/\s/.test(value[start - 1])) start -= 1;
  let end = caret;
  while (end < value.length && !/\s/.test(value[end])) end += 1;

  // ...unless the caret is inside a quote that has not been closed yet, in
  // which case the word began at that quote and runs to its partner: half of
  // `kick "Kid Ga` is not a word of its own.
  // An odd number of quotes behind the caret is what "inside a quote" means --
  // looking only at the nearest one puts the caret back inside a name it has
  // already finished typing.
  const head = value.slice(0, caret);
  if ((head.match(/"/g) || []).length % 2 === 1) {
    start = head.lastIndexOf('"');
    const close = value.indexOf('"', caret);
    end = close === -1 ? value.length : close + 1;
  }

  const text = value.slice(start, end);
  return { start, end, prefix: isPlaceholder(text) ? '' : value.slice(start, caret) };
}

function wireTypeahead(node, input, commands, argValues, targetId, showHelp, aliases) {
  const list = node.querySelector('.cmd-suggest');
  if (!list) return;
  const MAX = 12;

  let rows = [];
  let active = -1;
  let at = null; // the slice of the input the next pick replaces

  const close = () => {
    list.classList.add('hidden');
    list.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    rows = [];
    active = -1;
  };

  const paint = () => {
    list.innerHTML = '';
    rows.forEach((row, i) => {
      const li = document.createElement('li');
      li.className = `${i === active ? 'active ' : ''}${row.danger ? 'risky' : ''}`.trim();
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      const word = document.createElement('span');
      word.className = 'word';
      // Bold the part already typed so it is obvious why these rows are here.
      // Counted character by character rather than taken from the prefix
      // length: a substring hit, or a name found without its opening quote,
      // has nothing at the front to bold.
      let hit = 0;
      while (hit < at.prefix.length && hit < row.value.length
        && row.value[hit].toLowerCase() === at.prefix[hit].toLowerCase()) hit += 1;
      const typed = document.createElement('b');
      typed.textContent = row.value.slice(0, hit);
      word.append(typed, row.value.slice(hit));
      if (row.danger) word.prepend('⚠ ');
      li.append(word);
      if (row.description) {
        const note = document.createElement('span');
        note.className = 'note';
        note.textContent = row.description;
        li.append(note);
      }
      // mousedown, not click: the input must not lose focus before the pick.
      li.addEventListener('mousedown', (e) => { e.preventDefault(); accept(i); });
      list.append(li);
    });
    if (rows.length === MAX) {
      const more = document.createElement('li');
      more.className = 'more';
      more.textContent = 'keep typing to narrow this down';
      list.append(more);
    }
    list.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
    list.scrollTop = 0;
  };

  const refresh = () => {
    // Sending a command clears the box and fires 'input'. Without this the
    // whole command list would pop open under a console nobody is typing in.
    if (document.activeElement !== input) { close(); return; }
    const caret = input.selectionStart ?? input.value.length;
    at = wordAtCaret(input.value, caret);
    const words = canonicalize(splitWords(input.value.slice(0, at.start)), aliases);

    const all = nextWords(commands, argValues, words, targetId);
    // A leading quote is the slot's, not the typist's: "Ali should still find
    // "Alice", and so should Ali.
    const bare = (s) => s.toLowerCase().replace(/^"/, '');
    const prefix = at.prefix.toLowerCase();
    const key = bare(at.prefix);
    // Prefix matches first, then anything containing the fragment: typing
    // "inventory" should still find keepInventory.
    const starts = all.filter((r) => bare(r.value).startsWith(key));
    const contains = key
      ? all.filter((r) => !bare(r.value).startsWith(key) && bare(r.value).includes(key))
      : [];
    rows = [...starts, ...contains].slice(0, MAX);

    // One suggestion that is already typed in full is not a suggestion.
    if (rows.length === 1 && rows[0].value.toLowerCase() === prefix && prefix) rows = [];

    active = -1;
    if (!rows.length) close(); else paint();
  };

  const accept = (i) => {
    const row = rows[i];
    if (!row) return;
    const value = input.value;
    // A trailing space only when there is another word to come, so a finished
    // command does not have to be backspaced before Enter.
    const words = canonicalize([...splitWords(value.slice(0, at.start)), row.value], aliases);
    const more = expectsMore(commands, words) || nextWords(commands, argValues, words, targetId).length > 0;
    const tail = value.slice(at.end);
    // A trailing space is only added when there isn't one already: a command
    // taken whole from the dropdown has its later <placeholders> still sitting
    // in the tail, and doubling the gap would split it into an empty word.
    const gap = more && !/^\s/.test(tail) ? ' ' : '';
    input.value = `${value.slice(0, at.start)}${row.value}${gap}${tail}`;
    // Land on the next word rather than at the end of this one, so its own
    // options come up without having to press anything.
    const caret = at.start + row.value.length + gap.length
      + (more && !gap ? tail.match(/^\s*/)[0].length : 0);
    input.setSelectionRange(caret, caret);
    showHelp(findCommand(commands, input.value, aliases));
    if (more) refresh(); else close();
  };

  input.addEventListener('input', refresh);
  input.addEventListener('focus', refresh);
  // A click that moves the caret changes which word is being completed.
  input.addEventListener('click', refresh);
  input.addEventListener('blur', () => setTimeout(close, 100));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); return; }
    if (!rows.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = e.key === 'ArrowDown'
        ? (active + 1) % rows.length
        : (active <= 0 ? rows.length - 1 : active - 1);
      paint();
      list.children[active]?.scrollIntoView({ block: 'nearest' });
      return;
    }
    // Tab takes the highlighted row, or the top one if nothing is highlighted:
    // the usual shell bargain. Enter only accepts something deliberately
    // chosen, so it still sends the command in the ordinary case.
    if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); accept(active < 0 ? 0 : active); return; }
    // stopImmediatePropagation because the Run-on-Enter handler is bound to
    // this same input: without it, picking a row would also send the command.
    if (e.key === 'Enter' && active >= 0) { e.preventDefault(); e.stopImmediatePropagation(); accept(active); }
  });
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
  // Same box, different meaning: for a countdown it is how long until the
  // restart, here it is how long to keep waiting before giving up. Say which,
  // because pressing the wrong one of two adjacent buttons is easy.
  if (action === 'restartWhenEmpty') {
    body.minutes = Number(node.querySelector('.countdown-min').value) || 60;
    const count = node.dataset.playerCount || '0';
    if (!confirm(
      `Restart ${target.name} as soon as nobody is online?\n\n`
      + (count === '0'
        ? 'Nobody is online now, so this will restart almost immediately.'
        : `${count} player(s) are online, so it will wait for them to leave.`)
      + `\n\nIf the server has not emptied within ${body.minutes} minute(s), the restart `
      + 'is abandoned — it will not restart on top of players.',
    )) return;
  }
  // The check only stops the server if there is actually something to install,
  // so the confirmation has to describe a maybe rather than a certainty. What
  // happens after that differs by publisher and the wording says which: the
  // dashboard installs a Minecraft update itself, start to finish, while a
  // Steam one stops the server and hands over to Steam.
  if (action === 'updateBegin') {
    const count = node.dataset.playerCount || '0';
    const warning = count !== '0' ? `\n\n${count} player(s) are ONLINE right now.` : '';
    const minecraft = capabilities.get(target.id)?.updateProvider === 'minecraft';
    if (!confirm(
      `Check for a newer version of ${target.name}?\n\n`
      + (minecraft
        ? 'If there is one, the server will be STOPPED, the release downloaded and '
          + 'installed over it, and the server started again — nothing else to press. '
          + 'Your world, server.properties, allowlist.json and permissions.json are kept, '
          + 'and the download is deleted afterwards.'
        : 'If there is one, the server will be STOPPED so you can install it in Steam. '
          + 'The dashboard starts it again by itself once Steam has finished.')
      + `\n\nIf it is already up to date, nothing happens.${warning}`,
    )) return;
  }

  if (action === 'updateCancel' && !confirm(
    `Stop waiting for the update and start ${target.name} on the version it already has?`,
  )) return;

  if (action === 'stop' || action === 'restart' || action === 'updateRestart') {
    const verb = { stop: 'Stop', restart: 'Restart', updateRestart: 'Update and restart' }[action];
    const count = node.dataset.playerCount || '0';
    const warning = count !== '0' ? `\n\n${count} player(s) are ONLINE right now.` : '';
    // Worth spelling out: this one changes what is on disk, not just the uptime.
    const extra = action === 'updateRestart'
      ? '\n\nThis stops the service, runs its update command, then starts it again.'
      : '';
    if (!confirm(`${verb} ${target.name}?${extra}${warning}`)) return;
  }

  btn.classList.add('busy');
  // A card with no console has no console output pane either, and until this
  // line every result on those cards — Icarus, and every service — was written
  // into a hidden element. Same feedback, somewhere it can be read.
  const out = (capabilities.get(target.id)?.canConsole)
    ? node.querySelector('.output')
    : node.querySelector('.action-status');
  if (out) { out.textContent = `${action}…`; fitOutput(out); }

  // A game server is asked to save and exit, and a large world can take a minute
  // or more to do it. A line that says "stop…" and then sits there for ninety
  // seconds is indistinguishable from a button that did nothing, so count.
  const slow = { stop: 'stopping', restart: 'restarting', updateRestart: 'updating', updateBegin: 'checking for updates' }[action];
  let ticker = null;
  if (out && slow) {
    const startedAt = Date.now();
    const tick = () => {
      const secs = Math.round((Date.now() - startedAt) / 1000);
      out.textContent = `${slow}… ${secs}s`
        + (action === 'stop' || action === 'restart' ? ' — waiting for it to save and exit' : '');
    };
    tick();
    ticker = setInterval(tick, 1000);
  }

  // The update transcript is the whole point of the button, so it gets its own
  // panel that stays put once the action finishes.
  const updateOut = action === 'updateRestart' ? node.querySelector('.update-out') : null;
  if (updateOut) {
    updateOut.classList.remove('hidden');
    updateOut.textContent = 'Stopping, updating, restarting…';
  }
  try {
    const res = await api(`/api/action/${target.id}`, { method: 'POST', body: JSON.stringify(body) });
    if (action === 'updateBegin' || action === 'updateCancel') {
      // From here the banner is the whole story and the status stream keeps it
      // current — except for "already up to date", which leaves no state behind
      // it and would otherwise look like a button that did nothing.
      showUpdateAnswer(node, res, action);
    } else if (out) {
      // Say who actually received a broadcast — "ok" against an empty server
      // looks identical to a broadcast that silently went nowhere.
      let detail = '';
      if (action === 'broadcast' && res.ok) {
        const seen = Number(node.dataset.playerCount || 0);
        detail = seen ? ` — delivered to ${seen} player(s)` : ' — but nobody is online to see it';
      }
      if (res.backup) detail += ` — backed up as ${res.backup}`;
      const took = res.seconds != null ? ` in ${res.seconds}s` : '';
      out.textContent = res.ok
        ? `${action}: ok${took}${res.forced ? ' (it had to be force-killed)' : ''}${detail}`
        : `${action} failed: ${res.error}`;
      fitOutput(out);
    } else if (!res.ok && !updateOut) {
      alert(`${action} failed: ${res.error}`);
    }
    if (updateOut) {
      const head = res.ok
        ? 'Updated and restarted.'
        : `FAILED: ${res.error}${res.restored === true ? '\nService was restarted on the previous version.'
          : res.restored === false ? '\nThe service is still DOWN.' : ''}`;
      updateOut.textContent = [head, res.output].filter(Boolean).join('\n\n');
      fitOutput(updateOut);
      updateOut.scrollTop = updateOut.scrollHeight;
    }
    if (action === 'broadcast') node.querySelector('.broadcast-msg').value = '';
  } finally {
    clearInterval(ticker);
    btn.classList.remove('busy');
    refresh();
  }
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------
//
// One banner, two publishers behind it. A Steam target is stopped and handed
// over to Steam; a Minecraft target is downloaded and installed here. The state
// arriving on the stream carries which, and the wording follows it — "build" is
// a Steam word and "version" is a Minecraft one, and a card that used the wrong
// one would send you looking in the wrong place.
const isMinecraft = (u) => u?.provider === 'minecraft';

// The reply to pressing the button. Everything that follows — the download, the
// install, the restart — arrives through renderUpdate on the status stream.
function showUpdateAnswer(node, res, action) {
  const box = node.querySelector('.update-banner');
  const text = node.querySelector('.update-text');
  box.classList.remove('hidden');
  box.classList.toggle('bad', !res.ok);

  if (!res.ok) {
    text.textContent = `${action === 'updateCancel' ? 'Could not start it' : 'Update check failed'} — ${res.error}`;
  } else if (action === 'updateCancel') {
    text.textContent = 'No longer waiting — starting the server…';
  } else if (res.updateAvailable === false) {
    text.textContent = `Already on the current version (${res.installed}). Nothing to do.`;
  } else {
    // Deliberately vague about which step comes first: Steam stops the server
    // straight away, Minecraft downloads first and stops later. The status
    // stream replaces this line within a second either way.
    text.textContent = 'Update found — starting the update…';
  }
}

// One line under the card header saying where this target stands: a new version
// is out, an update is running, or the server is stopped waiting for you to
// install one in Steam.
function renderUpdate(node, u) {
  const box = node.querySelector('.update-banner');
  const text = node.querySelector('.update-text');
  const cancel = node.querySelector('.update-cancel');
  if (!box) return;

  // No entry means idle and current. Don't clear a just-clicked answer that the
  // server has no state for ("already up to date").
  if (!u) {
    cancel.classList.add('hidden');
    box.classList.remove('waiting');
    return;
  }

  box.classList.remove('hidden');
  // Amber is for "your server is down / it needs you". A Minecraft download
  // runs with the server up and the players on it, so it is not either.
  box.classList.toggle('waiting', u.phase === 'waiting');
  box.classList.toggle('bad', Boolean(u.error) && u.phase === 'idle');
  // Only the Steam wait can be cancelled, because it is the only phase that is
  // waiting for a person rather than doing something. A download that has
  // started finishes and brings the server back on its own.
  cancel.classList.toggle('hidden', u.phase !== 'waiting');

  const mc = isMinecraft(u);
  const inProgress = {
    checking: mc ? 'Asking Minecraft which version is current…' : 'Asking Steam which build is current…',
    stopping: 'Update found — stopping the server…',
    installing: mc
      ? `Installing ${u.latest}${u.edition === 'bedrock' ? ' over the server folder' : ''}…`
      : 'Installing the update with SteamCMD — this can take a while…',
    starting: 'Starting the server…',
  }[u.phase];

  if (u.phase === 'downloading') {
    // The dashboard is doing this download itself, so unlike the Steam wait
    // below the byte counts are its own and always present.
    const progress = u.bytesToDownload
      ? ` — ${fmtBytes(u.bytesDownloaded)} of ${fmtBytes(u.bytesToDownload)}`
      : ` — ${fmtBytes(u.bytesDownloaded)}`;
    text.textContent = `⬇ Downloading ${u.latest}${progress}. `
      + 'The server is still up — it stops once the download is here, and comes '
      + 'back as soon as the new version is in place.';
  } else if (u.phase === 'waiting') {
    // Steam counts the bytes down in the manifest, so the card can show progress
    // for a download nobody in this process started.
    const progress = u.bytesToDownload
      ? ` Downloading ${fmtBytes(u.bytesDownloaded)} of ${fmtBytes(u.bytesToDownload)}.`
      : '';
    text.textContent = `⬇ Stopped for a Steam update — install build ${u.latest} in Steam now `
      + `(this one is ${u.installed}).${progress} The server starts itself when Steam finishes; `
      + `giving up ${fmtUntil(u.deadline)}.`;
  } else if (inProgress) {
    text.textContent = inProgress;
  } else if (u.error) {
    text.textContent = `Update check failed — ${u.error}`;
  } else if (u.updateAvailable) {
    text.textContent = mc
      ? `⬆ Minecraft ${u.latest} is out; this server is running ${u.installed}. `
        + 'Press "Check for update" and the dashboard installs it for you.'
      : `⬆ Steam has build ${u.latest}; this server is running ${u.installed}. `
        + 'Press "Check for update" when you want it installed.';
  } else if (u.unknownInstalled && u.note) {
    // Not an error and not an update: the publisher answered, but which version
    // is on disk could not be read, so nothing can be compared. Saying so beats
    // an empty banner or a confident "up to date" that was never checked.
    text.textContent = `Minecraft ${u.latest} is the current version, but the installed one `
      + `could not be read — ${u.note}.`;
  } else {
    box.classList.add('hidden');
  }
}

// Mods are never installed automatically, so this line is a notice rather than
// a control: it says what is waiting and leaves the doing to you. Absent from
// the payload means every mod is current, which is the usual case and deserves
// no space on the card.
function renderMods(node, m) {
  const box = node.querySelector('.mods-banner');
  const text = node.querySelector('.mods-text');
  if (!box) return;

  if (!m) {
    box.classList.add('hidden');
    return;
  }

  box.classList.remove('hidden');
  box.classList.toggle('bad', Boolean(m.error));

  if (m.error) {
    text.textContent = `Mod check failed — ${m.error}`;
    return;
  }

  const parts = [];
  const canRefresh = Boolean(capabilities.get(node.dataset.id)?.canRefreshMods);
  if (m.stale?.length) {
    parts.push(`\u{1F9E9} ${m.stale.length} mod update${m.stale.length > 1 ? 's' : ''} waiting `
      + `(${m.stale.join(', ')}) — `
      + (canRefresh
        ? 'Refresh mods copies them in and restarts the server. Nothing is updated automatically.'
        : 'refresh in your mod manager. Mods are not updated automatically.'));
  }
  // Worth saying out loud rather than leaving as a silent "current": these are
  // pinned forever, which is fine until you are waiting on a fix that is never
  // going to arrive.
  if (m.unsubscribed?.length) {
    parts.push(`Not subscribed in Steam: ${m.unsubscribed.join(', ')} — these will never update.`);
  }
  if (!parts.length) {
    box.classList.add('hidden');
    return;
  }
  text.textContent = parts.join(' ');

  // Only next to a notice that names something it could act on. An always-on
  // button here would be a second copy of the one in the Mods panel.
  const btn = node.querySelector('.mods-banner .mods-install');
  if (btn) btn.classList.toggle('hidden', !canRefresh || !m.stale?.length);
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
  // For a query-only game this tile is the honest equivalent: it says whether
  // the number above it is current, and it is the first thing to go when a
  // server is running but has fallen out of the Steam browser.
  if (snap.query && snap.query !== 'n/a') {
    const queryLabel = snap.queryProtocol === 'raknet' ? 'Server ping' : 'Steam query';
    tiles.push([queryLabel, snap.query === 'ok' ? 'answering' : (snap.queryError || snap.query),
      snap.query === 'ok' ? 'good' : (snap.up && snap.query !== 'starting' ? 'warn' : '')]);
  }
  tiles.push(['Port', String(snap.gamePort ?? '—'), '']);
  // Only when the server actually told us. A game that publishes its version
  // nowhere (Valheim, "process") would otherwise carry a tile reading "—"
  // forever, which looks like something is broken rather than like something
  // that was never offered. This is also why it sits last: it is the one tile
  // that can be absent, so the ones above it never move when it appears.
  // Two columns wide. A version string is the longest value on the card by some
  // way -- "Paper 26.2-120" and "3.0.25.156508" both overrun a 90px cell, and
  // the grid's minmax floor means they wrap or spill rather than widening it.
  // Spanning also happens to consume the empty cell that used to sit at the end
  // of this row, so the row comes out full instead of half-blank.
  // Whether Steam is actually advertising this server, which is a different
  // question from whether it answers its own query port -- a server can do the
  // second for hours while failing the first, and then it is running perfectly
  // and nobody can find it. Only shown for a target that checks; see
  // src/steamlisting.js.
  if (snap.listing && snap.listing.state !== 'offline') {
    const s = snap.listing.state;
    // "unverified" is not a warning. It means the dashboard could not ask --
    // no API key, or no route to Steam -- and colouring it amber would train
    // everyone to ignore the one tile that means something is wrong.
    tiles.push(['Browser',
      s === 'listed' ? 'listed'
        : s === 'not listed' ? `not listed (${snap.listing.misses})`
        : s,
      s === 'listed' ? 'good' : s === 'not listed' ? 'bad' : '']);
  }

  // The world on disk. "Saved" is the one that changes a decision: Stop and
  // Restart on a game with no remote interface are a kill, and this is the only
  // evidence of what that would cost.
  if (snap.save) {
    const world = [snap.save.prospect, snap.save.difficulty].filter(Boolean).join(' · ');
    if (world) tiles.push(['World', world, '', 'wide']);
    if (snap.save.elapsedSeconds != null) tiles.push(['Played', fmtSpan(snap.save.elapsedSeconds), '']);
    // An hour-old save is not itself a fault -- an idle server writes nothing --
    // so this only turns amber once the number is large enough to be worth
    // reading before pressing Restart.
    tiles.push(['Saved', fmtSpan(snap.save.ageSeconds), snap.save.ageSeconds > 3600 ? 'warn' : '']);
  }

  if (snap.version) tiles.push(['Version', snap.version, '', 'wide']);
  return tiles;
}

function render(snap, pending, updates, mods) {
  const node = cards.get(snap.id);
  if (!node) return;

  const players = snap.players;
  const count = snap.playerCount ?? (players ? players.length : null);
  // So the console can complete <player> with people who are actually on.
  onlinePlayers.set(snap.id, players || []);
  node.dataset.playerCount = count ?? 0;

  // Status dot: green = up, amber = up but RCON/health unhappy, red = down.
  const dot = node.querySelector('.card-head .dot');
  const degraded = snap.up && (
    (snap.kind === 'game' && snap.rcon !== 'ok' && snap.rcon !== 'n/a')
    // A query that is merely 'starting' is a server still loading, not a sick
    // one — the same grace the RCON games already get from readyAfterSeconds.
    || (snap.kind === 'game' && snap.query === 'error')
    // Running and unfindable is exactly the state that looks fine everywhere
    // else on the card, so it has to reach the dot or it reaches nothing.
    || (snap.kind === 'game' && snap.listing?.state === 'not listed')
    || (snap.kind === 'service' && !snap.healthy));
  dot.className = `dot ${!snap.up ? 'down' : degraded ? 'degraded' : 'up'}`;

  const badge = node.querySelector('.badge.players');
  if (snap.kind === 'game') {
    badge.textContent = (snap.rcon === 'n/a' && count == null)
      ? (snap.up ? 'running' : 'stopped')
      : (count == null ? '— / —' : `${count} / ${snap.maxPlayers}`);
    badge.classList.toggle('active', Boolean(count));
  } else {
    badge.textContent = snap.up ? 'healthy' : 'down';
  }

  // The tab carries the same two facts as the card head, so the servers you are
  // not looking at still report themselves.
  const tab = tabs.get(snap.id);
  if (tab) {
    tab.querySelector('.dot').className = dot.className;
    const c = tab.querySelector('.count');
    c.textContent = badge.textContent;
    c.classList.toggle('active', badge.classList.contains('active'));
  }

  node.querySelector('.stats').innerHTML = statTiles(snap)
    .map(([k, v, cls, tile]) => `<div class="stat ${tile || ''}"><div class="k">${k}</div><div class="v ${cls}">${escapeHtml(String(v))}</div></div>`)
    .join('');

  const list = node.querySelector('.playerlist');
  if (snap.kind === 'service') {
    node.querySelector('.players-list').classList.add('hidden');
    renderServiceInfo(node, snap);
  } else if (snap.rcon === 'n/a' && snap.query === 'n/a') {
    // handled by hiding the section at build time
  } else if (!players && count != null) {
    // A count with no names: the game answers Steam's query but does not publish
    // who is on it. Say the number rather than pretending the list is empty.
    list.innerHTML = count === 0
      ? '<li class="empty">nobody online — safe to restart</li>'
      : `<li class="empty">${count} player(s) online — this game does not publish names</li>`;
  } else if (!players) {
    const why = snap.query === 'starting' ? 'still starting — no player count yet'
      : snap.rcon === 'n/a' ? `${snap.queryProtocol === 'raknet' ? 'Server ping' : 'Steam query'} unavailable — cannot read the player count`
      : 'RCON unavailable — cannot read player list';
    list.innerHTML = `<li class="empty">${snap.up ? why : 'server offline'}</li>`;
  } else if (!players.length) {
    list.innerHTML = '<li class="empty">nobody online — safe to restart</li>';
  } else {
    list.innerHTML = players
      .map((p) => `<li><span>${escapeHtml(p.name)}</span><span class="pid">${escapeHtml(p.id || '')}</span></li>`)
      .join('')
      // Names read out of a log, against a count measured over the wire, and the
      // two disagree. The count is the one to trust for "is it safe to restart",
      // so say which is which rather than quietly showing the shorter list.
      + (snap.playersApproximate
        ? `<li class="empty">the Steam query counts ${count} — this list is from the server log and may be behind</li>`
        : '');
  }

  const cd = node.querySelector('.countdown');
  const p = pending?.[snap.id];
  if (p) {
    const left = Math.max(0, Math.round((p.finishAt - Date.now()) / 1000));
    const clock = `${Math.floor(left / 60)}m ${String(left % 60).padStart(2, '0')}s`;
    // Two different things end at finishAt: a countdown ends with a restart, a
    // wait-for-empty ends with the restart being abandoned. Wording them the
    // same would make "giving up in 2m" look like "restarting in 2m".
    cd.textContent = p.mode === 'empty'
      ? `⏱ Waiting for the server to empty, then restarting — giving up in ${clock}`
      : `⏱ Restarting in ${clock} — ${p.reason}`;
    cd.classList.remove('hidden');
  } else {
    cd.classList.add('hidden');
  }

  const update = updates?.[snap.id];
  renderUpdate(node, update);
  renderMods(node, mods?.[snap.id]);

  const startBtn = node.querySelector('[data-act=start]');
  const stopBtn = node.querySelector('[data-act=stop]');
  // Starting it by hand mid-wait would put the files back under a running server
  // and leave Steam unable to patch them. The banner's own button is the way out.
  if (startBtn) startBtn.disabled = snap.up || update?.phase === 'waiting';
  if (stopBtn) stopBtn.disabled = !snap.up;
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

function wireSchedules(target, node) {
  const details = node.querySelector('details.schedules');
  const actionSel = node.querySelector('.sched-action');
  const presetSel = node.querySelector('.sched-preset');
  const cronField = node.querySelector('.sched-field-cron');
  const cronInput = node.querySelector('.sched-cron');
  const messageField = node.querySelector('.sched-field-message');
  const messageInput = node.querySelector('.sched-message');
  const warnField = node.querySelector('.sched-field-warn');
  const preview = node.querySelector('.sched-preview');

  // The cron box only appears for "Custom"; the presets cover what people
  // actually schedule, and a five-field expression is nobody's idea of a hint.
  const chosenCron = () => (presetSel.value === 'custom' ? cronInput.value.trim() : presetSel.value);

  let previewSeq = 0;
  async function refreshPreview() {
    const cron = chosenCron();
    if (!cron) {
      preview.className = 'sched-preview';
      preview.textContent = 'Write a cron expression above, e.g. 0 5 * * * for 05:00 daily.';
      return;
    }
    // The server owns the cron rules, so ask it rather than keeping a second
    // copy here that can drift. Out-of-order replies are dropped.
    const seq = ++previewSeq;
    const res = await api(`/api/schedules/preview?cron=${encodeURIComponent(cron)}`);
    if (seq !== previewSeq) return;
    if (!res.ok) {
      preview.className = 'sched-preview bad';
      preview.textContent = `That won't work — ${res.error}`;
      return;
    }
    const what = actionSel.selectedOptions[0].textContent.toLowerCase();
    preview.className = 'sched-preview good';
    preview.textContent = `Will ${what} ${res.description} — first run ${fmtUntil(res.nextRun)}.`;
  }

  function syncForm() {
    // Only a broadcast needs a message, and only a restart can warn players
    // beforehand — the scheduler ignores warnMinutes on anything else.
    messageField.classList.toggle('hidden', actionSel.value !== 'broadcast');
    warnField.classList.toggle('hidden', actionSel.value !== 'restart');
    cronField.classList.toggle('hidden', presetSel.value !== 'custom');
    refreshPreview();
  }

  details.addEventListener('toggle', function () {
    if (this.open) { loadSchedules(target.id, node); syncForm(); }
  });

  actionSel.addEventListener('change', syncForm);
  presetSel.addEventListener('change', syncForm);
  cronInput.addEventListener('input', refreshPreview);

  node.querySelector('.sched-add').addEventListener('click', async () => {
    const body = {
      targetId: target.id,
      cron: chosenCron(),
      action: actionSel.value,
      warnMinutes: Number(node.querySelector('.sched-warn').value) || 0,
      message: messageInput.value.trim() || null,
    };
    const res = await api('/api/schedules', { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) {
      preview.className = 'sched-preview bad';
      preview.textContent = `Not added — ${res.error}`;
      return;
    }
    cronInput.value = '';
    messageInput.value = '';
    loadSchedules(target.id, node);
    syncForm();
  });
}

async function loadSchedules(id, node) {
  const rows = (await api('/api/schedules')).filter((j) => j.targetId === id);
  const list = node.querySelector('.schedulelist');

  if (!rows.length) {
    list.innerHTML = '<li class="empty">nothing scheduled yet — add one below</li>';
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
// Moderation
//
// Two questions the log tail could technically answer and nobody could
// realistically read it for: who is banned right now, and what has been handed
// out recently. The second half matters more than it looks -- a kick leaves no
// record anywhere except one line in a log that rotates, so without this panel
// "why did that player drop" is unanswerable an hour later.
//
// Pardon is one click because it is the safe direction: it lets somebody back
// in, and a mistake is undone by banning them again. Ban asks first.
// ---------------------------------------------------------------------------

const MOD_KIND = {
  ban:     { label: 'banned',  cls: 'bad' },
  kick:    { label: 'kicked',  cls: 'warn' },
  pardon:  { label: 'pardoned', cls: 'good' },
  blocked: { label: 'blocked at the door', cls: 'dim' },
};

function wireModeration(target, node) {
  const details = node.querySelector('details.moderation');
  if (!details || details.classList.contains('hidden')) return;

  details.addEventListener('toggle', function () {
    if (this.open) loadModeration(target.id, node);
  });

  const nameInput = node.querySelector('.ban-name');
  const reasonInput = node.querySelector('.ban-reason');

  const doBan = async () => {
    const who = nameInput.value.trim();
    if (!who) return;
    const reason = reasonInput.value.trim();
    if (!confirm(`Ban ${who}?${reason ? `\n\nReason: ${reason}` : ''}\n\nThey are disconnected and cannot rejoin until you pardon them.`)) return;
    await modAction(target.id, node, { who, reason, action: 'ban' }, `banning ${who}…`);
    nameInput.value = '';
    reasonInput.value = '';
  };

  node.querySelector('.ban-do').addEventListener('click', doBan);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doBan(); });
  reasonInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doBan(); });
}

// Every write goes through here so there is one place that knows a ban is sent
// over RCON and therefore needs the server to be up -- and one place that says
// so plainly when it isn't.
async function modAction(id, node, body, busyText) {
  const status = node.querySelector('.mod-status');
  status.textContent = busyText;
  const res = await api(`/api/bans/${id}`, { method: 'POST', body: JSON.stringify(body) });
  if (res.ok) {
    status.textContent = 'done';
    // The reply carries the ban list the server wrote as part of the command,
    // so the list below is right without a second round trip.
    if (res.bans) renderBans(id, node, res.bans);
    loadModEvents(id, node);
  } else {
    status.textContent = `failed: ${res.error}`;
  }
}

async function loadModeration(id, node) {
  renderBans(id, node, await api(`/api/bans/${id}`));
  loadModEvents(id, node);
}

function renderBans(id, node, data) {
  const list = node.querySelector('.banlist');
  const count = node.querySelector('.ban-count');
  const rows = [
    ...(data.players || []).map((b) => ({ ...b, kind: 'player', who: b.name })),
    ...(data.ips || []).map((b) => ({ ...b, kind: 'ip', who: b.ip })),
  ];

  count.textContent = rows.length ? `· ${rows.length}` : '';

  if (!data.ok) {
    list.innerHTML = `<li class="empty">${escapeHtml(data.error || 'cannot read the ban list')}</li>`;
    return;
  }
  if (!rows.length) {
    list.innerHTML = '<li class="empty">nobody is banned</li>';
    return;
  }

  list.innerHTML = rows.map((b) => `<li>
    <span class="ban-who">${escapeHtml(b.who || '?')}${b.kind === 'ip' ? ' <span class="dim">(IP)</span>' : ''}</span>
    <span class="ban-why">${escapeHtml(b.reason || 'no reason given')}</span>
    <span class="ban-meta">${escapeHtml(b.source || 'unknown')}${b.created ? ` · ${fmtWhen(b.created)}` : ''}</span>
    <button class="mini good" data-pardon="${escapeHtml(b.who || '')}" data-kind="${b.kind}">pardon</button>
  </li>`).join('');

  list.querySelectorAll('[data-pardon]').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.classList.add('busy');
      modAction(id, node, { who: btn.dataset.pardon, kind: btn.dataset.kind, action: 'pardon' },
        `pardoning ${btn.dataset.pardon}…`);
    });
  });
}

async function loadModEvents(id, node) {
  const list = node.querySelector('.modevents');
  const res = await api(`/api/modevents/${id}`);
  const events = res.events || [];

  if (!events.length) {
    list.innerHTML = '<li class="empty">nothing in the last 7 days</li>';
    return;
  }

  list.innerHTML = events.map((e) => {
    const k = MOD_KIND[e.kind] || { label: e.kind, cls: 'dim' };
    return `<li>
      <span class="ev-kind ${k.cls}">${escapeHtml(k.label)}</span>
      <span class="ev-who">${escapeHtml(e.who || '?')}</span>
      <span class="ev-why">${escapeHtml(e.reason || '')}${e.repeats ? ` <span class="dim">×${e.repeats}</span>` : ''}</span>
      <span class="ev-meta">${escapeHtml(e.source || '')} · ${escapeHtml(fmtWhen(e.at))}</span>
    </li>`;
  }).join('');
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
// Mods
//
// What is installed, which is a different question from the banner above the
// card: that one only speaks up when an update is waiting, so on a healthy
// modded server it says nothing at all and you still had to go and look in the
// folder to find out what the server is running. This is the list.
//
// One thing here writes: "Refresh from Steam" replaces the files a mod already
// installed with the newer copies the Steam client has downloaded, then restarts
// the server. Enabling, removing and installing mods stay in the mod manager for
// the reason src/workshop.js gives -- a mod has no `validate` to undo a bad one,
// and the server can be fine until the first player joins. What the button adds
// is the one step that is pure mechanics: the same files, from the same item,
// into the same places.
// ---------------------------------------------------------------------------

function wireMods(target, node) {
  const details = node.querySelector('details.mods');
  // Hidden at build time when this target has no mods folder at all — no panel,
  // so nothing to wire and nothing to fetch.
  if (!details || details.classList.contains('hidden')) return;

  details.addEventListener('toggle', function () {
    if (this.open) loadMods(target.id, node);
  });

  node.querySelector('.mods-refresh').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.classList.add('busy');
    // Ask the background checker to re-run first where there is one, so the
    // "update waiting" column is as fresh as the rest of the row rather than up
    // to six hours old.
    if (capabilities.get(target.id)?.hasModChecks) {
      await api(`/api/action/${target.id}`, { method: 'POST', body: JSON.stringify({ action: 'modsCheck' }) })
        .catch(() => {});
    }
    // Same idea on a Paper server, and it is the slow half: four publisher APIs
    // rather than a folder read. Failures are swallowed because the panel below
    // is still worth drawing without them -- each row says so itself.
    if (capabilities.get(target.id)?.canUpdatePlugins) {
      await api(`/api/action/${target.id}`, { method: 'POST', body: JSON.stringify({ action: 'pluginsCheck' }) })
        .catch(() => {});
    }
    await loadMods(target.id, node);
    btn.classList.remove('busy');
  });

  // Both copies of the button -- the one in this panel and the one on the
  // banner, which is where you are actually looking when there is something to
  // do -- run the same thing.
  node.querySelectorAll('.mods-install').forEach((btn) => {
    btn.addEventListener('click', () => refreshModsFromSteam(target, node, btn));
  });

  node.querySelector('.plugins-update')?.addEventListener('click', (event) => {
    updatePlugins(target, node, event.currentTarget);
  });

  // The count is the useful part at a glance, so it is fetched once on load
  // rather than waiting for somebody to open the panel.
  loadMods(target.id, node, { quiet: true });
}

// What the confirmation says, from the plan the server just made. It is worth
// spelling out rather than asking "are you sure": the interesting part of a mod
// refresh is what it is NOT going to touch -- a file you have edited since it
// was installed, or one the Steam copy has no equivalent for.
function describePlan(plan) {
  const lines = [];
  for (const m of plan.mods) {
    if (!m.ok) { lines.push(`  ${m.name}: cannot refresh — ${m.error}`); continue; }
    const bits = [`${m.copy.length} file(s) to copy`];
    if (m.same.length) bits.push(`${m.same.length} already identical`);
    if (m.guarded.length) bits.push(`${m.guarded.length} left alone (edited here)`);
    if (m.unmapped.length) bits.push(`${m.unmapped.length} not in the Steam copy`);
    lines.push(`  ${m.name}: ${bits.join(', ')}`);
    for (const g of m.guarded) lines.push(`     keeping your ${g.dest}`);
  }
  return lines.join('\n');
}

// Plugin updates, which unlike the Steam refresh next door the dashboard does
// end to end: it fetches from each plugin's publisher, verifies every jar
// against a published checksum, and restarts the server once for all of them.
// The confirmation says what will be installed and what it costs, because the
// cost is an outage for anyone online.
async function updatePlugins(target, node, btn) {
  const status = node.querySelector('.mods-status');
  const say = (text, bad = false) => {
    if (!status) return;
    status.textContent = text;
    status.className = `mods-status${bad ? ' bad' : ''}`;
  };

  btn.classList.add('busy');
  try {
    say('checking each plugin with its publisher…');
    const check = await api(`/api/action/${target.id}`, {
      method: 'POST', body: JSON.stringify({ action: 'pluginsCheck' }),
    });
    if (!check.ok) { say(`could not check for plugin updates — ${check.error}`, true); return; }

    const waiting = (check.plugins || []).filter((p) => p.status === 'outdated');
    await loadMods(target.id, node, { quiet: true });

    if (!waiting.length) {
      const broken = (check.plugins || []).filter((p) => p.status === 'error').length;
      say(`every plugin is current${broken ? ` — ${broken} could not be checked, see the list` : ''}`);
      return;
    }

    const count = node.dataset.playerCount || '0';
    const ok = confirm(
      `Update ${waiting.length} plugin(s) on ${target.name}?\n\n`
      + `${waiting.map((p) => `  ${p.name}: ${p.version ?? '?'} → ${p.latestVersion}  (from ${p.source})`).join('\n')}\n\n`
      + 'Each jar is downloaded and checked against its publisher’s checksum first, with the server '
      + 'still running. Then the server STOPS once, all of them are installed, and it starts again. '
      + 'The jars they replace are kept, so there is a way back.\n\n'
      + (count !== '0'
        ? `${count} player(s) appear to be online — they will be disconnected.`
        : 'Nobody is online.'),
    );
    if (!ok) { say('not updated'); return; }

    say('updating — the server restarts once at the end…');
    const res = await api(`/api/action/${target.id}`, {
      method: 'POST', body: JSON.stringify({ action: 'pluginsUpdate' }),
    });

    const done = res.updated?.length || 0;
    const failed = res.failed?.length || 0;
    if (!res.ok && !done) {
      say(`no plugin was updated — ${res.error || res.failed?.map((f) => f.error).join('; ')}`, true);
    } else {
      say(`updated ${done} plugin(s)${failed ? `, ${failed} failed` : ''}`
        + `${res.started === false ? ' — SERVER DID NOT START' : ' — server restarted'}`,
        failed > 0 || res.started === false);
    }
    await loadMods(target.id, node);
  } catch (err) {
    say(`plugin update failed — ${err.message}`, true);
  } finally {
    btn.classList.remove('busy');
  }
}

async function refreshModsFromSteam(target, node, btn) {
  const status = node.querySelector('.mods-status');
  const say = (text, bad = false) => {
    if (!status) return;
    status.textContent = text;
    status.className = `mods-status${bad ? ' bad' : ''}`;
  };

  btn.classList.add('busy');
  try {
    const plan = await api(`/api/action/${target.id}`, {
      method: 'POST', body: JSON.stringify({ action: 'modsPlan' }),
    });
    if (!plan.ok) { say(`could not plan the refresh — ${plan.error}`, true); return; }
    if (plan.nothingToDo) {
      say('nothing waiting — every installed mod already matches its Steam copy');
      await loadMods(target.id, node);
      return;
    }

    // A refresh with nothing to copy is a timestamp fix, and it does not stop
    // the server. Promising an outage that will not happen is as misleading as
    // hiding one that will.
    const willStop = plan.files > 0;
    const count = node.dataset.playerCount || '0';
    const ok = confirm(
      `Refresh mods on ${target.name} from the Steam copy?\n\n`
      + `${describePlan(plan)}\n\n`
      + (willStop
        ? `The server will STOP, ${plan.files} file(s) (${fmtBytes(plan.bytes)}) will be copied in, and it will `
          + `start again. Replaced files are kept in the dashboard's data folder.\n\n`
          + (count !== '0' ? `${count} player(s) appear to be online — the refresh will refuse to run unless you confirm again.` : 'Nobody is online.')
        : 'Nothing needs copying — the installed files already match Steam byte for byte, so the server keeps '
          + 'running and only the "update waiting" flag is cleared.'),
    );
    if (!ok) return;

    let res = await api(`/api/action/${target.id}`, {
      method: 'POST', body: JSON.stringify({ action: 'modsRefresh' }),
    });

    // The server refused because it could not confirm an empty server. That is
    // the right default and the wrong answer often enough to be worth one more
    // question -- but the question has to say what it costs.
    if (res.waiting) {
      const again = confirm(
        `${res.error}.\n\n`
        + `Stop ${target.name} anyway and refresh now? Anyone still connected will be disconnected `
        + `when it saves and exits.`,
      );
      if (!again) { say(`not refreshed — ${res.error}`); return; }
      say('refreshing…');
      res = await api(`/api/action/${target.id}`, {
        method: 'POST', body: JSON.stringify({ action: 'modsRefresh', force: true }),
      });
    }

    if (!res.ok) {
      say(`refresh failed — ${res.error || res.failed?.join('; ')}`, true);
    } else if (res.verifiedOnly) {
      say(`already current — ${res.mods.length} mod(s) verified against Steam, server left running`);
    } else {
      say(`refreshed ${res.files} file(s)${res.restarted ? ' — server restarted' : ' — SERVER DID NOT START'}`,
        !res.restarted);
    }
    await loadMods(target.id, node);
  } catch (err) {
    say(`refresh failed — ${err.message}`, true);
  } finally {
    btn.classList.remove('busy');
  }
}

// One line per mod. The two things worth seeing without opening anything are
// how many there are and whether any of them are in a state that needs a
// decision — an update waiting, a mod the server is not loading, a mod with no
// subscription left to update from.
function modLine(m) {
  const bits = [];
  if (m.version) bits.push(`v${m.version}`);
  if (m.author) bits.push(`by ${m.author}`);
  // Minecraft only. The plugin's declared API floor, not the version it was
  // built against -- see src/pluginjar.js -- so it is labelled as a floor.
  if (m.apiVersion) bits.push(`API ≥ ${m.apiVersion}`);
  if (m.bytes != null) bits.push(fmtBytes(m.bytes));
  if (m.installedAt) bits.push(`installed ${fmtWhen(m.installedAt)}`);
  // The filename, when it is not simply the name again. A plugin is identified
  // by what is inside the jar but deleted by what the jar is called, and those
  // two disagree often enough (floodgate-spigot.jar is "floodgate") that the
  // panel has to answer both.
  if (m.file && m.file.replace(/\.jar$/i, '').toLowerCase() !== (m.name || '').toLowerCase()) {
    bits.push(m.file);
  }
  // Who the dashboard would fetch an update from. Worth showing on every row,
  // not just the outdated ones: it is the answer to "will this look after
  // itself?", which is otherwise invisible until something is waiting.
  if (m.source) bits.push(`updates from ${m.source}`);

  const flags = [];
  if (m.status === 'stale') {
    flags.push(['stale', 'update waiting', m.staleWhy || `Steam has a newer copy than the one installed${m.sourceAt ? ` (published ${fmtWhen(m.sourceAt)})` : ''}. Refresh it in your mod manager.`]);
  }
  if (m.status === 'staged') {
    flags.push(['stale', 'update staged', m.staleWhy || 'A newer copy is waiting to be installed on the next restart.']);
  }
  if (m.status === 'unsubscribed') {
    flags.push(['orphan', 'not subscribed', 'Installed here but not subscribed in the Steam client, so it will never receive an update.']);
  }
  // Two jars claiming the same name: the server loads one of them and refuses
  // the other, so this is a decision waiting to be made, not a warning.
  if (m.conflict) {
    flags.push(['dupe', 'duplicate', 'Another file in this folder declares the same plugin name — usually a new version dropped in without deleting the old one. The server loads only one of them.']);
  }
  // Only an explicit false. A game with no mod list to read reports null, and
  // "we cannot tell" must not be shown as "the server is ignoring this".
  if (m.enabled === false) {
    flags.push(['off', 'not loaded', m.disabledWhy || 'Installed, but missing from the game’s active mod list — the server is not loading it.']);
  }

  // Neither a problem nor a promise: the dashboard is not in a position to
  // update this one, and saying nothing would read as "up to date".
  // null means "checked, and there is no publisher for this one". undefined
  // means the panel has not been checked yet, which is not the same thing and
  // must not be flagged as if it were.
  if (m.sourceError) {
    flags.push(['note', 'source unreachable', m.sourceError]);
  } else if (m.source === null) {
    flags.push(['note', 'no source', 'No publisher is configured for this plugin, so the dashboard will never update it. Add one under pluginUpdates.sources in config.json.']);
  }

  const deps = m.dependencies?.length
    ? `<div class="mod-deps">needs ${m.dependencies.map(escapeHtml).join(', ')}</div>`
    : '';

  return `<li>
    <div class="mod-top">
      <span class="mod-name">${escapeHtml(m.displayName || m.name)}</span>
      ${flags.map(([cls, label, why]) => `<span class="mod-flag ${cls}" title="${escapeHtml(why)}">${label}</span>`).join('')}
    </div>
    <div class="mod-meta">${escapeHtml(bits.join(' · ')) || '—'}</div>
    ${deps}
  </li>`;
}

async function loadMods(id, node, { quiet = false } = {}) {
  const list = node.querySelector('.modlist');
  const count = node.querySelector('.mods-count');
  const where = node.querySelector('.mods-where');
  const status = node.querySelector('.mods-status');
  const label = node.querySelector('.mods-label');
  if (!list) return;

  let res;
  try {
    res = await api(`/api/mods/${id}`);
  } catch {
    return;
  }

  // What this server calls them. A Paper server has plugins and no mods folder,
  // and a panel headed "Mods" would send you looking for a folder that is not
  // there. The server decides the word; this only spells it.
  const noun = res.noun || 'mod';
  const plural = `${noun}s`;
  if (label) label.textContent = plural.charAt(0).toUpperCase() + plural.slice(1);

  if (!res.ok) {
    count.textContent = '(unreadable)';
    count.className = 'mods-count bad';
    list.innerHTML = `<li class="empty">could not read the ${escapeHtml(noun)} folder — ${escapeHtml(res.error || 'unknown error')}</li>`;
    where.textContent = res.dir || '';
    return;
  }

  const c = res.counts || { total: 0 };
  const notes = [];
  if (c.stale) notes.push(`${c.stale} update${c.stale > 1 ? 's' : ''} waiting`);
  if (c.disabled) notes.push(`${c.disabled} not loaded`);
  if (c.conflicts) notes.push(`${c.conflicts} duplicate${c.conflicts > 1 ? 's' : ''}`);
  if (c.unsubscribed) notes.push(`${c.unsubscribed} unsubscribed`);
  count.textContent = c.total
    ? `· ${c.total}${notes.length ? ` · ${notes.join(', ')}` : ''}`
    : '· none';
  count.className = `mods-count${notes.length ? ' warn' : ''}`;

  // A master switch that turns every mod off outranks every per-mod state below
  // it, and it is invisible in the list — every mod still reads as enabled.
  if (res.globalOff) {
    status.textContent = 'Mods are switched OFF globally in the game’s mod settings — none of these are loading.';
    status.className = 'mods-status bad';
  } else if (!quiet) {
    status.textContent = `read ${fmtTime(res.checkedAt || Date.now())}`;
    status.className = 'mods-status';
  }

  if (!res.mods.length) {
    list.innerHTML = res.missing
      ? `<li class="empty">no ${escapeHtml(plural)} installed — the folder is not there yet</li>`
      : `<li class="empty">no ${escapeHtml(plural)} installed</li>`;
  } else {
    list.innerHTML = res.mods.map(modLine).join('');
  }

  // The folder is the answer to "where do I go to change this", which is the
  // next question every time, since nothing on this panel changes anything.
  const lines = [];
  if (res.dir) lines.push(`${res.missing ? 'Would be read from' : 'Read from'} ${res.dir}`);
  if (res.enabledFile) lines.push(`Active list: ${res.enabledFile}`);
  if (res.note) lines.push(res.note);
  where.innerHTML = lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('');
}

// ---------------------------------------------------------------------------
// Utilisation: busy times and the week
// ---------------------------------------------------------------------------
//
// The live line answers "what is it doing"; these two answer "how much is it
// being used", which is a different question and was the one nobody could get
// off this page. A three-hour trace cannot tell a dead server from a Tuesday
// morning, because a normal Tuesday morning is also flat.
//
// So both charts are drawn the same way: a pale bar for what a normal week
// looks like at this moment, and a solid bar in front of it for what is
// actually happening. Neither number means much alone -- four players is a lot
// on a Wednesday lunchtime and nothing on a Saturday night -- and the whole
// design is about making that comparison the thing you see first.

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// 12-hour labels, because the question being asked is a human one ("is Saturday
// evening busy") and 20:00 is not how anybody says it here.
function hourLabel(h) {
  if (h === 0) return '12a';
  if (h === 12) return '12p';
  return h < 12 ? `${h}a` : `${h - 12}p`;
}

function fmtPlayers(n) {
  if (n == null) return '—';
  return n >= 10 ? String(Math.round(n)) : (Math.round(n * 10) / 10).toString();
}

function fmtHours(n) {
  if (n == null) return '—';
  if (n === 0) return '0h';
  if (n < 1) return `${Math.round(n * 60)}m`;
  return `${Math.round(n * 10) / 10}h`;
}

function selectChartView(node, view) {
  node.querySelectorAll('.chart-tab').forEach((b) => b.classList.toggle('is-on', b.dataset.view === view));
  node.querySelectorAll('.chart-view').forEach((v) => v.classList.toggle('hidden', v.dataset.view !== view));
}

/**
 * One column: a pale "typical" bar with the real one drawn in front of it.
 *
 * Anything above zero gets at least a sliver of height. A bar rounded down to
 * nothing is indistinguishable from an hour nobody played, and those two say
 * opposite things about whether the server is worth keeping up.
 */
function barColumn({ typical, actual, scale, classes, title }) {
  const pct = (v) => (v == null || v <= 0 ? 0 : Math.max(3, Math.min(100, (v / scale) * 100)));
  const t = pct(typical);
  const a = pct(actual);
  return `<div class="col ${classes.join(' ')}" title="${escapeHtml(title)}">
    ${t ? `<div class="typical" style="height:${t.toFixed(1)}%"></div>` : ''}
    ${a ? `<div class="actual" style="height:${a.toFixed(1)}%"></div>` : ''}
  </div>`;
}

/**
 * Is right now busier than a normal one of these, and by enough to say so?
 *
 * The band is deliberately wide. Player counts on a family server are small
 * integers, so one extra kid is a 50% swing, and a verdict that flips between
 * "busier" and "quieter" every time somebody logs in is noise wearing a
 * conclusion's clothes. The additive term is what stops near-empty hours --
 * where every ratio is enormous -- from setting it off.
 */
function busyVerdict(cur, dow) {
  if (!cur || cur.typical == null || !cur.weeks) {
    return { cls: '', html: `Still learning what a normal <b>${DOW_LONG[dow]}</b> looks like.` };
  }
  const t = cur.typical;
  const a = cur.actual ?? 0;
  const usually = `usually ${fmtPlayers(t)} at ${hourLabel(cur.hour)} on a ${DOW_LONG[dow]}`;
  const nowText = cur.actual == null ? 'nobody on' : `${fmtPlayers(a)} on`;
  if (t < 0.25 && a < 0.25) return { cls: '', html: `<b>Quiet</b>, as it usually is at this hour.` };
  if (a >= t * 1.35 + 0.4) return { cls: 'busier', html: `<b>Busier than usual</b> — ${nowText}, ${usually}.` };
  if (a <= t * 0.65 - 0.4 || (a === 0 && t >= 0.5)) return { cls: 'quieter', html: `<b>Quieter than usual</b> — ${nowText}, ${usually}.` };
  return { cls: '', html: `<b>About as busy as usual</b> — ${nowText}, ${usually}.` };
}

function renderBusy(wrap, res) {
  const bars = wrap.querySelector('.busy-bars');
  const axis = wrap.querySelector('.busy-axis');
  const rows = res.day;
  const known = rows.filter((r) => r.typical != null || r.actual != null);
  if (!known.length) {
    bars.innerHTML = '<div class="empty">no usage recorded yet</div>';
    axis.innerHTML = '';
    wrap.querySelector('.busy-verdict').innerHTML = 'Collecting — a first day of history takes a day.';
    return;
  }

  // One scale for both series, or the overlay compares two different rulers.
  const scale = Math.max(0.5, ...rows.map((r) => Math.max(r.typical ?? 0, r.actual ?? 0)));

  bars.innerHTML = rows.map((r) => {
    const classes = [];
    if (r.hour === res.hour) classes.push('now');
    if (r.partial) classes.push('partial');
    if (r.future) classes.push('future');
    const parts = [`${hourLabel(r.hour)} on ${DOW_LONG[res.dow]}`];
    parts.push(r.typical == null ? 'no history yet' : `usually ${fmtPlayers(r.typical)} (peak ${r.typicalPeak ?? 0})`);
    if (!r.future) parts.push(r.actual == null ? 'today: no reading' : `today ${fmtPlayers(r.actual)} (peak ${r.peak ?? 0})`);
    if (r.partial) parts.push('hour still in progress');
    return barColumn({ typical: r.typical, actual: r.actual, scale, classes, title: parts.join(' · ') });
  }).join('');

  // Four labels, not twenty-four: at card width the rest collide into a smear.
  // The current hour always gets one, though -- it is the only column anyone
  // looks up by name, and the baseline tick under it means nothing if the hour
  // it is pointing at is unlabelled. A six-hour label immediately beside it
  // stands down rather than colliding with it.
  axis.innerHTML = rows.map((r) => {
    const isNow = r.hour === res.hour;
    const show = isNow || (r.hour % 6 === 0 && Math.abs(r.hour - res.hour) > 1);
    return `<span class="${isNow ? 'now' : ''}">${show ? hourLabel(r.hour) : ''}</span>`;
  }).join('');

  const v = busyVerdict(rows[res.hour], res.dow);
  const verdict = wrap.querySelector('.busy-verdict');
  verdict.className = `busy-verdict ${v.cls}`;
  verdict.innerHTML = v.html;
}

function renderWeek(wrap, res) {
  const bars = wrap.querySelector('.week-bars');
  const axis = wrap.querySelector('.week-axis');
  const rows = res.week;
  const known = rows.filter((r) => r.typical != null || r.actual != null);
  if (!known.length) {
    bars.innerHTML = '<div class="empty">no usage recorded yet</div>';
    axis.innerHTML = '';
    wrap.querySelector('.week-verdict').innerHTML = '';
    return;
  }

  const scale = Math.max(0.25, ...rows.map((r) => Math.max(r.typical ?? 0, r.actual ?? 0)));
  bars.innerHTML = rows.map((r) => {
    const classes = [];
    if (r.today) classes.push('now', 'today', 'partial');
    if (r.future) classes.push('future');
    const parts = [DOW_LONG[r.dow]];
    parts.push(r.typical == null ? 'no history yet' : `usually ${fmtHours(r.typical)} of play`);
    if (!r.future) parts.push(r.actual == null ? 'nothing this week' : `this week ${fmtHours(r.actual)} (peak ${r.peak ?? 0})`);
    if (r.today) parts.push('today, still going');
    return barColumn({ typical: r.typical, actual: r.actual, scale, classes, title: parts.join(' · ') });
  }).join('');

  axis.innerHTML = rows.map((r) => `<span class="${r.today ? 'now' : ''}">${DOW_SHORT[r.dow]}</span>`).join('');

  // Weekly total against a typical week, counting only the days that have
  // happened -- comparing three days of this week against seven of a normal one
  // would report a collapse every Wednesday.
  const done = rows.filter((r) => !r.future);
  const actual = done.reduce((a, r) => a + (r.actual ?? 0), 0);
  const typical = done.reduce((a, r) => a + (r.typical ?? 0), 0);
  const el = wrap.querySelector('.week-verdict');
  if (!typical) {
    el.className = 'busy-verdict week-verdict';
    el.innerHTML = `<b>${fmtHours(actual)}</b> of play so far this week.`;
    return;
  }
  const delta = Math.round(((actual - typical) / typical) * 100);
  const cls = delta >= 20 ? 'busier' : delta <= -20 ? 'quieter' : '';
  const word = delta >= 20 ? 'above' : delta <= -20 ? 'below' : 'in line with';
  el.className = `busy-verdict week-verdict ${cls}`;
  el.innerHTML = `<b>${fmtHours(actual)}</b> of play so far this week — ${word} the usual ${fmtHours(typical)} by this point${delta ? ` (${delta > 0 ? '+' : ''}${delta}%)` : ''}.`;
}

function renderUsageStats(wrap, res) {
  const el = wrap.querySelector('.usage-stats');
  const s = res.summary;
  if (!s) { el.innerHTML = ''; return; }
  const bits = [];
  bits.push(`<span>7d <b>${fmtHours(s.playerHours7d)}</b> played</span>`);
  if (s.playerHoursPrev7d) {
    const d = Math.round(((s.playerHours7d - s.playerHoursPrev7d) / s.playerHoursPrev7d) * 100);
    bits.push(`<span class="trend ${d >= 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${d}% vs prev</span>`);
  }
  if (s.peak7d != null) bits.push(`<span>peak <b>${s.peak7d}</b></span>`);
  if (s.peakEver && s.peakEver > (s.peak7d ?? 0)) bits.push(`<span>record <b>${s.peakEver}</b> ${escapeHtml(fmtWhen(s.peakEverAt))}</span>`);
  if (s.activeShare != null) bits.push(`<span>anyone on <b>${Math.round(s.activeShare * 100)}%</b> of the time</span>`);
  if (s.busiest) bits.push(`<span>busiest <b>${DOW_SHORT[s.busiest.dow]} ${hourLabel(s.busiest.hour)}</b></span>`);
  // The quietest slot is the one worth acting on: it is when to schedule the
  // restart that a busy hour would have interrupted.
  if (s.quietest) bits.push(`<span>quietest <b>${DOW_SHORT[s.quietest.dow]} ${hourLabel(s.quietest.hour)}</b></span>`);
  if (s.uptime7d != null) bits.push(`<span><b>${(s.uptime7d * 100).toFixed(1)}%</b> up</span>`);
  if (res.weeks) bits.push(`<span class="trend down">typical = ${res.weeks} week${res.weeks === 1 ? '' : 's'}</span>`);
  el.innerHTML = bits.join('');
}

function fmtDuration(sec) {
  if (sec == null) return null;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/**
 * The punch card: seven rows of twenty-four cells, opacity carrying the average.
 *
 * The floor on a non-zero cell is the whole trick. Scaling opacity straight
 * from the average would render a real but small number as nothing, which is
 * the one thing this chart must never do -- "quiet" and "never used" are
 * different answers to when-can-I-restart, and they would look identical.
 */
function renderHeatmap(wrap, res) {
  const el = wrap.querySelector('.heat');
  const foot = wrap.querySelector('.heat-foot');
  if (!res.heatmap?.length || !res.hottest) {
    el.innerHTML = '<div class="empty">no usage recorded yet</div>';
    foot.innerHTML = '';
    return;
  }

  const cells = [];
  for (const row of res.heatmap) {
    cells.push(`<div class="rowlab">${DOW_SHORT[row[0].dow]}</div>`);
    for (const c of row) {
      const known = c.avg != null;
      const a = known && c.avg > 0 ? 0.12 + (c.avg / res.hottest) * 0.88 : 0;
      const now = c.dow === res.dow && c.hour === res.hour;
      const title = `${DOW_LONG[c.dow]} ${hourLabel(c.hour)} — ${known ? `${fmtPlayers(c.avg)} on average` : 'never observed'}`;
      cells.push(`<div class="cell ${known ? '' : 'blank'} ${now ? 'now' : ''}" style="--a:${a.toFixed(3)}" title="${escapeHtml(title)}"></div>`);
    }
  }
  // The hour scale, on the row below, at the same six-hour marks as the busy chart.
  cells.push('<div class="rowlab"></div>');
  for (let h = 0; h < 24; h++) cells.push(`<div class="hourlab">${h % 6 === 0 ? hourLabel(h) : ''}</div>`);
  el.innerHTML = cells.join('');

  const swatches = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => `<i style="--a:${f ? (0.12 + f * 0.88).toFixed(2) : 0}"></i>`)
    .join('');
  foot.innerHTML = `<span>darker = quieter</span><span class="heat-scale">0 ${swatches} ${fmtPlayers(res.hottest)}</span>`;
}

function figure(label, value, note) {
  if (value == null) return `<div><dt>${escapeHtml(label)}</dt><dd class="none">—</dd></div>`;
  return `<div><dt>${escapeHtml(label)}</dt><dd>${value}${note ? ` <small>${note}</small>` : ''}</dd></div>`;
}

/**
 * Who is actually playing, rather than how many.
 *
 * This is the half of "utilisation" a player count cannot reach. Two servers
 * averaging one player look identical on every chart above and are not the same
 * server at all: one has a single person on for hours, the other has fifteen
 * people dropping in. Unique players, session length and the newcomer/regular
 * split are what tell those apart, and they are what every analytics tool for
 * game servers converges on.
 */
function renderPeople(wrap, res) {
  const figs = wrap.querySelector('.figures');
  const top = wrap.querySelector('.toplist');
  const p = res.people;
  if (!p) {
    figs.innerHTML = '';
    top.innerHTML = '<li class="empty">this game reports how many are online, but not who</li>';
    return;
  }

  const s = res.summary || {};
  figs.innerHTML = [
    figure('Players, 7d', p.unique7d, p.unique30d ? `of ${p.unique30d} in 30d` : ''),
    figure('New this week', p.newcomers7d, p.regulars7d ? `${p.regulars7d} regular${p.regulars7d === 1 ? '' : 's'}` : ''),
    figure('Sessions, 7d', p.sessions7d, p.online ? `${p.online} on now` : ''),
    figure('Typical session', fmtDuration(p.avgSession)),
    figure('Longest, 7d', fmtDuration(p.longestSession)),
    // How long a newcomer's very first visit lasts: the difference between
    // people arriving and people staying.
    figure('First visit', fmtDuration(p.firstSessionAvg)),
    figure('Came back', p.retention == null ? null : `${Math.round(p.retention * 100)}%`,
      p.retention == null ? '' : `of ${p.retentionCohort}`),
    figure('Peak ever', s.peakEver ?? null, s.peakEverAt ? fmtWhen(s.peakEverAt) : ''),
  ].join('');

  if (!p.top?.length) {
    top.innerHTML = '<li class="empty">nobody has played in the last week</li>';
    return;
  }
  const most = Math.max(...p.top.map((t) => t.seconds));
  top.innerHTML = p.top.map((t) => `<li>
    <span class="who">${escapeHtml(t.name)}${t.online ? ' <span class="live" title="online now">●</span>' : ''}</span>
    <span class="track"><i style="width:${Math.max(2, (t.seconds / most) * 100).toFixed(1)}%"></i></span>
    <span class="amt">${fmtDuration(t.seconds)}</span>
  </li>`).join('');
}

/**
 * Fall back to the plain response-time trace, and stop offering the rest.
 *
 * A service has no players, so both comparison charts would be flat lines
 * pretending to be information, and the tabs would be two ways of reaching
 * them. The heading goes back to naming what is actually on screen.
 */
function dropUsageCharts(wrap) {
  if (!wrap || wrap.dataset.usage === 'off') return;
  wrap.dataset.usage = 'off';
  wrap.querySelector('.chart-tabs').classList.add('hidden');
  wrap.querySelector('.usage-stats').innerHTML = '';
  wrap.querySelector('h3').textContent = 'Last 3 hours';
  selectChartView(wrap, 'live');
}

async function loadUsage(id, node) {
  const wrap = node.querySelector('.chart-wrap');
  if (!wrap) return;
  let res = null;
  try { res = await api(`/api/usage/${id}`); } catch { /* handled below */ }

  // A service has no players, so the two comparison charts would be flat lines
  // pretending to be information. It keeps the response-time trace instead, and
  // loses the tab bar rather than showing two tabs that say nothing.
  if (!res?.ok) {
    dropUsageCharts(wrap);
    return;
  }
  renderBusy(wrap, res);
  renderWeek(wrap, res);
  renderHeatmap(wrap, res);
  renderPeople(wrap, res);
  renderUsageStats(wrap, res);

  // A game that answers "how many" but never "who" gets no Players tab at all.
  // Icarus is one: its player query returns the right number of entries with an
  // empty name in every one, so the panel would be permanently empty and read
  // as broken rather than as inapplicable.
  const peopleTab = wrap.querySelector('.tab-people');
  peopleTab.classList.toggle('hidden', !res.hasNames);
  if (!res.hasNames && peopleTab.classList.contains('is-on')) selectChartView(wrap, 'busy');
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
  writeConsole(pre, res.lines?.length ? res.lines.join('\n') : '(no log found)');
  pre.scrollTop = pre.scrollHeight;
}

/**
 * The feed, with a repeat said once.
 *
 * One target retrying something that keeps failing -- Steam declining to answer
 * a listing query, most of a day of it -- filled forty rows with the same
 * sentence and pushed every player join, backup and restart off the bottom. The
 * repetition is information, but it is one line of information: what it is, how
 * many times, and how far back. Only consecutive runs are folded, so nothing
 * jumps its place in the order to join a group further up.
 */
function groupAlerts(list) {
  const out = [];
  for (const a of list) {
    const last = out[out.length - 1];
    if (last && last.targetId === a.targetId && last.message === a.message && last.level === a.level) {
      last.count += 1;
      last.since = a.t; // the list runs newest first, so this walks backwards
    } else {
      out.push({ ...a, count: 1, since: a.t });
    }
  }
  return out;
}

function targetName(id) {
  return capabilities.get(id)?.name || id;
}

function renderAlerts() {
  const scoped = feedScope === 'tab' && selected
    ? alerts.filter((a) => a.targetId === selected)
    : alerts;

  // The heading says what is being looked at, and the button says what the
  // other view would be -- a toggle labelled with its own current state is the
  // one control everyone reads backwards.
  const head = document.getElementById('feedHead');
  const scopeBtn = document.getElementById('feedScope');
  if (head) {
    head.innerHTML = feedScope === 'tab' && selected
      ? `Activity · <b>${escapeHtml(targetName(selected))}</b>`
      : 'Activity · all servers';
  }
  if (scopeBtn) {
    scopeBtn.textContent = feedScope === 'tab' ? 'Show all servers' : 'Only this server';
    scopeBtn.classList.toggle('hidden', Boolean(ONLY) || tabs.size < 2);
  }

  // Every row says "icarus" when only Icarus is being shown; the heading has
  // already said it once.
  alertsEl.classList.toggle('scoped', feedScope === 'tab' && Boolean(selected));

  if (!scoped.length) {
    alertsEl.innerHTML = `<li class="empty">nothing yet${feedScope === 'tab' && selected ? ` for ${escapeHtml(targetName(selected))}` : ''}</li>`;
    return;
  }
  // The buffer is deep so that filtering cannot empty a quiet server's feed;
  // the page still only shows a screenful of it.
  alertsEl.innerHTML = groupAlerts(scoped).slice(0, 40)
    .map((a) => {
      const repeat = a.count > 1
        ? `<span class="rep" title="First of these at ${fmtTime(a.since)}">×${a.count} since ${fmtTime(a.since)}</span>`
        : '';
      return `<li class="${a.level}"><span class="when">${fmtTime(a.t)}</span><span class="who">${escapeHtml(a.targetId)}</span><span class="msg">${escapeHtml(a.message)}</span>${repeat}</li>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Status plumbing: SSE with a polling fallback
// ---------------------------------------------------------------------------

function applyStatus(status) {
  document.getElementById('hostLabel').textContent = status.host;
  document.getElementById('clock').textContent = fmtTime(status.now);

  ensureSelection(ONLY ? status.targets.filter((t) => t.id === ONLY) : status.targets);

  for (const snap of status.targets) {
    if (ONLY && snap.id !== ONLY) continue;
    if (!cards.has(snap.id)) buildCard(snap);
    render(snap, status.pending, status.updates, status.mods);
  }

  const allUp = status.targets.filter((t) => !ONLY || t.id === ONLY).every((t) => t.up);
  document.getElementById('globalDot').className = `dot ${allUp ? 'up' : 'down'}`;
  // Which server is open, in the tab title: with one card on screen the browser
  // tab is otherwise four identical entries called Server Control.
  const openName = status.targets.find((t) => t.id === (ONLY || selected))?.name;
  document.title = ONLY
    ? `${openName || 'Panel'}`
    : `${allUp ? '●' : '▲'} ${openName ? `${openName} — ` : ''}Server Control`;
}

function setLive(state) {
  liveEl.className = `live ${state}`;
  liveEl.textContent = state === 'on' ? 'live' : state === 'off' ? 'offline' : 'polling';
}

async function refresh() {
  try {
    applyStatus(await api('/api/status'));
    if (!ONLY) { alerts = await api('/api/alerts?limit=200'); renderAlerts(); }
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
    alerts = alerts.slice(0, 200);
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

  document.getElementById('feedScope').addEventListener('click', () => {
    feedScope = feedScope === 'tab' ? 'all' : 'tab';
    try { localStorage.setItem(SCOPE_KEY, feedScope); } catch { /* private mode */ }
    renderAlerts();
  });

  const targets = await api('/api/targets');
  for (const t of targets) capabilities.set(t.id, t);
  buildTabs(targets);

  await refresh();
  if (NO_STREAM) startPolling();
  else connectStream();
}

init();

// History changes slowly; no need to redraw it on every status update. Only the
// card on screen is redrawn -- the other three are behind a tab, and whichever
// one is opened next is refreshed by selectTarget on the way in.
setInterval(() => {
  const node = cards.get(selected);
  if (!node) return;
  loadHistory(selected, node);
  // Cheap, and the current hour's bar is the one being watched -- a busy
  // evening that only redraws on reload is the version of this that fails.
  loadUsage(selected, node);
}, 60000);
