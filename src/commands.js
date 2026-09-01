// The command list for a Minecraft server, from the two places it actually lives.
//
// Neither source is sufficient alone, which is the whole reason this file exists:
//
//   Jar manifests (src/pluginjar.js) carry the rich detail -- description, usage,
//   aliases, permission node -- and cost nothing but a zip seek, so they can be
//   re-read on every request and stay correct the moment a jar is dropped in.
//   But a Paper plugin that registers through Brigadier declares no commands at
//   all, and a plugin like UJobs takes its command name from its own config.yml.
//   On this box that silently loses /jobs, /prism, /ah and the Geyser commands.
//
//   The server's own /help index knows every command that is really registered,
//   because it is the command dispatcher talking. But it is 40-odd pages of
//   RCON round trips, it only exists while the server is up, and it has no idea
//   which plugin any of it came from.
//
// So: manifests are the spine and are always current, and the live sweep is
// cached and merged over the top to fill the gaps and mark what is genuinely
// registered right now.

// Bukkit paginates /help at nine entries a page and tells you the total in the
// header. The cap is a guard against a parse that never finds the total, not a
// real expectation -- 43 pages is what this server currently produces.
const MAX_PAGES = 120;

// How long a live sweep stays good. Commands only change when a plugin is added
// or updated, which is a restart-shaped event, so this can be generous; the
// point of the TTL is to notice a restart eventually, not promptly.
const DEFAULT_TTL_MS = 10 * 60 * 1000;

const stripColors = (s) => String(s ?? '').replace(/§./g, '');

// "--------- Help: Index (3/43) -----------"
const INDEX_HEADER = /Help:\s*Index\s*\((\d+)\s*\/\s*(\d+)\)/;

/**
 * One /help page into {total, commands}.
 *
 * Entries come in two shapes on the same page -- "/name: description" for a
 * command and "PluginName: All commands for PluginName" for a plugin topic --
 * and only the first is wanted, so the leading slash does the filtering.
 */
export function parseHelpPage(body) {
  const text = stripColors(body);
  const header = text.match(INDEX_HEADER);
  const commands = [];

  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('/')) continue;

    // Split on the first ": " rather than the first ":" -- namespaced entries
    // like "/minecraft:waypoint: A Mojang provided command." would otherwise be
    // cut at the namespace and land in the list as a command called "minecraft".
    const at = t.indexOf(': ');
    const name = (at === -1 ? t.replace(/:$/, '') : t.slice(0, at)).slice(1).trim();
    const description = at === -1 ? '' : t.slice(at + 2).trim();
    if (!name) continue;

    // "/minecraft:xp" and "/ujobs:jobs" are the namespaced spellings of commands
    // already listed unqualified. Keeping both would roughly double the list
    // with entries nobody types.
    if (name.includes(':')) continue;

    commands.push({ name, description });
  }

  return { total: header ? Number(header[2]) : null, commands };
}

/**
 * Cached live sweeps of /help, one per target.
 *
 * Nothing here ever blocks a page load: callers read {@link peek} and, if it is
 * stale, {@link refreshSoon} starts a sweep whose result the *next* refresh
 * picks up. Only an explicit "refresh from server" waits.
 */
export class CommandIndex {
  constructor(actions, { ttlMs = DEFAULT_TTL_MS } = {}) {
    this.actions = actions;
    this.ttlMs = ttlMs;
    this.cache = new Map(); // id -> {commands, at, error, pages}
    this.inFlight = new Map(); // id -> Promise, so a slow sweep is never doubled
  }

  peek(id) {
    return this.cache.get(id) ?? null;
  }

  isStale(id) {
    const hit = this.cache.get(id);
    return !hit || Date.now() - hit.at >= this.ttlMs;
  }

  /** Start a sweep if one is warranted, and return immediately either way. */
  refreshSoon(id) {
    if (!this.isStale(id) || this.inFlight.has(id)) return;
    this.refresh(id).catch(() => { /* recorded on the cache entry */ });
  }

  async refresh(id) {
    const existing = this.inFlight.get(id);
    if (existing) return existing;

    const run = this.sweep(id).then(
      (result) => { this.cache.set(id, result); this.inFlight.delete(id); return result; },
      (err) => {
        this.inFlight.delete(id);
        // Cache the failure too, at the same TTL. Without this a server that is
        // down would be re-swept on every single dashboard refresh.
        const result = { commands: [], at: Date.now(), error: String(err?.message || err), pages: 0 };
        this.cache.set(id, result);
        return result;
      },
    );
    this.inFlight.set(id, run);
    return run;
  }

  async sweep(id) {
    const seen = new Map(); // name -> description, first page wins
    let pages = 0;
    let total = 1;

    for (let page = 1; page <= Math.min(total, MAX_PAGES); page += 1) {
      const res = await this.actions.rcon(id, `help ${page}`);
      if (!res?.ok) throw new Error(res?.error || 'no reply to /help');

      const parsed = parseHelpPage(res.body);
      if (page === 1) {
        if (!parsed.total) throw new Error('could not read the /help page count');
        total = parsed.total;
      }
      for (const c of parsed.commands) {
        if (!seen.has(c.name)) seen.set(c.name, c.description);
      }
      pages = page;
    }

    return {
      commands: [...seen].map(([name, description]) => ({ name, description })),
      at: Date.now(),
      error: null,
      pages,
    };
  }
}

/**
 * Manifest commands grouped by plugin, with the live sweep merged over them.
 *
 * Every command carries where it was found: "both" is the healthy case, "jar"
 * means declared but not currently registered (a plugin that failed to load, or
 * a server that is down), and "live" means registered by something that never
 * declared it -- which is where the Brigadier and config-named commands land.
 */
export function buildCommandList(inventory, live) {
  const liveNames = new Map((live?.commands ?? []).map((c) => [c.name.toLowerCase(), c.description]));
  const claimed = new Set();
  const plugins = [];
  let declared = 0;

  for (const mod of inventory?.mods ?? []) {
    const commands = [];
    for (const c of mod.commands ?? []) {
      const names = [c.name, ...(c.aliases ?? [])];
      for (const n of names) claimed.add(n.toLowerCase());
      const registered = names.some((n) => liveNames.has(n.toLowerCase()));
      commands.push({
        name: c.name,
        aliases: c.aliases ?? [],
        description: c.description,
        usage: c.usage,
        permission: c.permission,
        source: registered ? 'both' : 'jar',
      });
      declared += 1;
    }
    if (!commands.length) continue;
    commands.sort((a, b) => a.name.localeCompare(b.name));
    plugins.push({
      plugin: mod.displayName || mod.name,
      version: mod.version ?? null,
      enabled: mod.status !== 'disabled',
      commands,
    });
  }
  plugins.sort((a, b) => a.plugin.localeCompare(b.plugin));

  // Whatever the server knows about that no jar claimed. Vanilla is the bulk of
  // it and is not interesting here, so it is separated rather than merged into
  // the plugin groups it does not belong to.
  const unclaimed = [...liveNames]
    .filter(([name]) => !claimed.has(name))
    .map(([name, description]) => ({ name, description, source: 'live' }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const vanillaish = (c) => /^A Mojang provided command\.?$/i.test(c.description || '');

  return {
    ok: true,
    plugins,
    // Registered, unclaimed and not obviously vanilla: this is the list that
    // answers "what else can I actually type", and it is where /jobs lives.
    runtime: unclaimed.filter((c) => !vanillaish(c)),
    vanilla: unclaimed.filter(vanillaish),
    counts: {
      declared,
      plugins: plugins.length,
      live: liveNames.size,
    },
    live: live
      ? { at: live.at, error: live.error, pages: live.pages, stale: false }
      : null,
    checkedAt: Date.now(),
  };
}
