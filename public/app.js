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
  wireCommandPicker(node, rconInput, caps.consoleCommands || [], caps.consoleArgs || {}, target.id);

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
  wireMods(target, node);
  wireModeration(target, node);

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

function wireCommandPicker(node, input, commands, argValues, targetId) {
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
    // The caret has just landed on a <placeholder>; tell the typeahead so it
    // can offer that slot's values straight away.
    input.dispatchEvent(new Event('input'));
    select.value = ''; // so picking the same command twice still fires
  });

  input.addEventListener('input', () => showHelp(findCommand(commands, input.value)));

  wireTypeahead(node, input, commands, argValues || {}, targetId, showHelp);
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

function wireTypeahead(node, input, commands, argValues, targetId, showHelp) {
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
    const words = splitWords(input.value.slice(0, at.start));

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
    const words = [...splitWords(value.slice(0, at.start)), row.value];
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
    showHelp(findCommand(commands, input.value));
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
  if (out) out.textContent = `${action}…`;

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
    } else if (!res.ok && !updateOut) {
      alert(`${action} failed: ${res.error}`);
    }
    if (updateOut) {
      const head = res.ok
        ? 'Updated and restarted.'
        : `FAILED: ${res.error}${res.restored === true ? '\nService was restarted on the previous version.'
          : res.restored === false ? '\nThe service is still DOWN.' : ''}`;
      updateOut.textContent = [head, res.output].filter(Boolean).join('\n\n');
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
      .join('');
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
    render(snap, status.pending, status.updates, status.mods);
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
