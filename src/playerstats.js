// What one player has actually done, assembled from the four places that know.
//
// This exists because answering "how is that child making so much money?" meant
// a session of ad-hoc scripts across four unrelated stores, and the answer --
// he chopped twenty-three thousand trees -- was not the one anybody expected.
// The question will be asked again, so it is a command now.
//
//   Prism (prism.db, SQLite)  every block broken and placed, with coordinates
//                             and timestamps. This is the ground truth, and it
//                             is the half that cannot be faked from in-game.
//   TheNewEconomy             the balance, and a transaction per money movement
//                             naming the plugin that caused it.
//   UltimateShop              per-player buy/sell counts, keyed by a shop letter
//                             that only the shop's own yml can decode.
//   Floodgate                 nothing directly, but its uuid prefix is how a
//                             Bedrock account is told from a Java one.
//
// THE POINT OF JOINING THEM is the integrity section at the bottom. Money and
// shop volume on their own cannot tell grinding from duplicating -- both look
// like "sold twenty thousand logs". Prism can: a duplicated item has no
// block-break behind it, and a mined one has exactly one. Comparing the two
// columns is the whole reason this file reads from more than one store.
//
// Everything here is READ-ONLY and opens the live databases read-only. The
// server is running while this executes.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { winPath } from './win.js';

// A Bedrock player arrives through Floodgate wearing a synthetic uuid in a
// reserved range, and by convention a prefixed name. Neither is a secret; the
// prefix is just what the console shows, so the report says which it is rather
// than leaving "why does this one have a dot" to be worked out.
const FLOODGATE_PREFIX = '00000000-0000-0000-0009-';

// How long the transaction sweep stays good. It is the one genuinely expensive
// read here -- fifty thousand small yml files -- and it is a whole-server scan,
// so one sweep answers for every player and re-running it per lookup would be
// pure waste. Money does not move fast enough for five minutes to mislead.
const TX_TTL_MS = 5 * 60 * 1000;

// A guard rather than an expectation. The transactions folder only grows, and a
// command that quietly takes ninety seconds is worse than one that says it gave
// up: past this the sweep stops and the report says the figure is partial.
const TX_FILE_BUDGET = 120_000;

let txCache = { at: 0, dir: null, byPlayer: null, scanned: 0, truncated: false };

// ---------------------------------------------------------------------------
// where things live

/**
 * The plugin data folders for a target, or null if it is not a Java server.
 *
 * Derived from startCommand the same way src/mcupdate.js does it: a Java
 * server's .bat sits beside its jar, because that is where the working
 * directory has to be. Nothing here is configurable on purpose -- these are
 * fixed paths inside a plugin's own data folder, and a config key for each
 * would be four more things to get wrong.
 */
export function resolveDirs(target) {
  if (!target || target.game !== 'minecraft' || !target.startCommand) return null;
  const installDir = path.dirname(path.resolve(winPath(target.startCommand)));
  const plugins = path.join(installDir, 'plugins');
  if (!fs.existsSync(plugins)) return null;
  return {
    installDir,
    plugins,
    prismDb: path.join(plugins, 'prism', 'prism.db'),
    tneAccounts: path.join(plugins, 'TheNewEconomy', 'accounts'),
    tneTransactions: path.join(plugins, 'TheNewEconomy', 'transactions'),
    // Where C:\Apps\tne-archive.py folds those yml files once they are safely
    // in SQLite. The loose files are an intermediary now, not the record.
    tneArchive: path.join(plugins, 'TheNewEconomy', 'archive', 'transactions.db'),
    shopDatas: path.join(plugins, 'UltimateShop', 'datas'),
    shopDefs: path.join(plugins, 'UltimateShop', 'shops'),
  };
}

// ---------------------------------------------------------------------------
// Prism -- the ground truth

/**
 * Everything Prism knows about one player.
 *
 * Opened read-only against a database Paper is actively writing to, which
 * SQLite handles fine in WAL mode -- but only read-only, and nothing in this
 * file ever opens it any other way.
 */
function readPrism(dirs, name) {
  if (!fs.existsSync(dirs.prismDb)) return null;
  let db;
  try {
    db = new DatabaseSync(dirs.prismDb, { readOnly: true });
  } catch (err) {
    return { error: `prism.db could not be opened: ${err.message}` };
  }
  try {
    const player = db.prepare(
      'select player_id, player, player_uuid from prism_players where lower(player) = lower(?)',
    ).get(name);
    if (!player) return { missing: true };

    const counts = db.prepare(`
      select ac.action, count(*) n
      from prism_activities a
      join prism_actions ac on ac.action_id = a.action_id
      where a.cause_player_id = ?
      group by ac.action order by n desc`).all(player.player_id);

    const broken = db.prepare(`
      select b.name, count(*) n
      from prism_activities a
      join prism_actions ac on ac.action_id = a.action_id
      join prism_blocks b on b.block_id = a.affected_block_id
      where a.cause_player_id = ? and ac.action = 'block-break'
      group by b.name order by n desc`).all(player.player_id);

    // Active hours rather than a session log, because Prism records events and
    // not presence. An hour with a single block broken in it counts the same as
    // a full one, so the rate below is a floor on how fast they were going --
    // which is the safe direction for a number used to judge somebody.
    const hours = db.prepare(`
      select strftime('%Y-%m-%d %H', a.timestamp, 'unixepoch', 'localtime') h, count(*) n
      from prism_activities a
      join prism_actions ac on ac.action_id = a.action_id
      where a.cause_player_id = ? and ac.action = 'block-break'
      group by h order by n desc`).all(player.player_id);

    const span = db.prepare(`
      select min(a.timestamp) first, max(a.timestamp) last
      from prism_activities a where a.cause_player_id = ?`).get(player.player_id);

    const byAction = Object.fromEntries(counts.map((r) => [r.action, r.n]));
    const totalBreaks = byAction['block-break'] || 0;
    return {
      id: player.player_id,
      name: player.player,
      uuid: player.player_uuid,
      byAction,
      broken,
      brokenIndex: new Map(broken.map((r) => [r.name, r.n])),
      activeHours: hours.length,
      peakHour: hours[0] || null,
      perHour: hours.length ? totalBreaks / hours.length : 0,
      first: span?.first || null,
      last: span?.last || null,
    };
  } catch (err) {
    return { error: err.message };
  } finally {
    try { db.close(); } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------
// TheNewEconomy -- balances and where the money came from

const yamlValue = (text, key) => {
  const m = text.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null;
};

// TheNewEconomy types a Floodgate account as `bedrock`, not `player`, so a
// filter on `player` alone silently drops four of this server's six children --
// and the rankings then read "2 of 2" without ever looking wrong.
const IS_PLAYER = new Set(['player', 'bedrock']);

/** Every account with a name and a balance, richest first. */
function readBalances(dirs) {
  if (!fs.existsSync(dirs.tneAccounts)) return [];
  const out = [];
  for (const file of fs.readdirSync(dirs.tneAccounts)) {
    if (!file.endsWith('.yml')) continue;
    let text;
    try { text = fs.readFileSync(path.join(dirs.tneAccounts, file), 'utf8'); } catch { continue; }
    const name = yamlValue(text, 'Name');
    const m = text.match(/tne:VIRTUAL_HOLDINGS:\s*'?([\d.-]+)'?/);
    if (!name) continue;
    out.push({
      name,
      uuid: file.replace(/\.yml$/i, ''),
      balance: m ? Number(m[1]) : 0,
      type: yamlValue(text, 'Type'),
    });
  }
  return out.sort((a, b) => b.balance - a.balance);
}

/**
 * Money in and out per account, and which plugin caused it.
 *
 * A DEBIT IS RECORDED AS AN ADD WITH A NEGATIVE MODIFIER, which is the one
 * genuinely surprising thing about this format and the reason the sign is read
 * off the number rather than off the `operation` field. Trusting `operation`
 * here reports every player as having spent nothing at all.
 */
/**
 * The folded archive, summed in SQL. Returns how many transactions it covered.
 *
 * Opened read-only, and a missing or unreadable database is not an error: the
 * archive is an optimisation over the yml files, so a server that has never run
 * the archiver must still answer the question from the loose files alone.
 */
function sweepArchive(dirs, take) {
  if (!dirs.tneArchive || !fs.existsSync(dirs.tneArchive)) return 0;
  let db;
  try {
    db = new DatabaseSync(dirs.tneArchive, { readOnly: true });
    // One row per account per source, which is precisely the shape the report
    // wants -- the per-source breakdown and the in/out split both fall out of
    // it without touching a single transaction row in JavaScript.
    const rows = db.prepare(`
      SELECT account_id AS uuid,
             source_name AS source,
             SUM(CAST(amount AS REAL)) AS net,
             SUM(CASE WHEN CAST(amount AS REAL) > 0 THEN CAST(amount AS REAL) ELSE 0 END) AS gained,
             SUM(CASE WHEN CAST(amount AS REAL) < 0 THEN -CAST(amount AS REAL) ELSE 0 END) AS spent,
             COUNT(*) AS n
        FROM transactions
       WHERE account_id IS NOT NULL
       GROUP BY account_id, source_name`).all();

    let counted = 0;
    for (const r of rows) {
      const acc = take(String(r.uuid));
      acc.in += Number(r.gained) || 0;
      acc.out += Number(r.spent) || 0;
      const source = r.source == null ? '?' : String(r.source);
      acc.bySource.set(source, (acc.bySource.get(source) || 0) + (Number(r.net) || 0));
      counted += Number(r.n) || 0;
    }
    return counted;
  } catch {
    // A half-written database during a fold is a reason to fall back to the yml
    // files, not a reason for the whole command to fail.
    return 0;
  } finally {
    try { db?.close(); } catch { /* already gone */ }
  }
}

function sweepTransactions(dirs) {
  const fresh = txCache.byPlayer
    && txCache.dir === dirs.tneTransactions
    && Date.now() - txCache.at < TX_TTL_MS;
  if (fresh) return txCache;

  const byPlayer = new Map();
  const take = (uuid) => {
    if (!byPlayer.has(uuid)) {
      byPlayer.set(uuid, { in: 0, out: 0, bySource: new Map(), traded: 0 });
    }
    return byPlayer.get(uuid);
  };

  let scanned = 0;
  let truncated = false;

  // The archive first. Almost every transaction that has ever happened lives
  // here, and the sum is done in SQL rather than by reading rows out one at a
  // time -- that is the whole reason the folding exists, and it turns the
  // expensive part of this command into a single indexed aggregate.
  //
  // Archived rows are read as one-sided, which is what they are: every one of
  // the sixty-one thousand records folded on 2026-09-02 had a `to` and no
  // `from`. A two-sided transfer would still be recorded in full in raw_json,
  // so nothing is lost on disk if TNE ever starts writing them -- but `traded`
  // would need reading that column back, and inventing the machinery for a case
  // that has never occurred would be the wrong trade.
  const archived = sweepArchive(dirs, take);
  scanned += archived;

  // Then whatever has landed since the last fold. With the archiver running
  // nightly at zero lag this is minutes of files, not months of them.
  let files = [];
  if (fs.existsSync(dirs.tneTransactions)) {
    try { files = fs.readdirSync(dirs.tneTransactions); } catch { files = []; }
  } else if (!archived) {
    return null;
  }
  // The budget counts files opened, not transactions covered. Rows already in
  // SQLite cost an indexed aggregate between them, so charging them against a
  // limit that exists to bound *file reads* would start reporting the figure as
  // partial precisely as the archive got good at its job.
  let filesRead = 0;
  for (const file of files) {
    if (filesRead >= TX_FILE_BUDGET) { truncated = true; break; }
    if (!file.endsWith('.yml')) continue;
    let text;
    try { text = fs.readFileSync(path.join(dirs.tneTransactions, file), 'utf8'); } catch { continue; }
    filesRead++;
    scanned++;

    const source = (text.match(/^source:\n\s+type:\s*\S+\n\s+name:\s*(.+)$/m) || [, '?'])[1].trim();
    // Both halves carry their own id and modifier; a transfer between two
    // players has both, and a plugin paying somebody has only one. That
    // difference is what separates money created from money merely moved.
    // Sliced at the top-level keys rather than matched with a lookahead. `$`
    // under /m ends at the first line break, so the old expression captured one
    // line of a nine-line block, found no modifier in it, and silently reported
    // every player as having earned nothing -- a whole section quietly absent
    // rather than visibly broken.
    const halves = [];
    const tops = [...text.matchAll(/^(\w+):[ \t]*$/gm)];
    for (let i = 0; i < tops.length; i++) {
      const section = tops[i][1];
      if (section !== 'to' && section !== 'from') continue;
      const start = tops[i].index + tops[i][0].length;
      const end = i + 1 < tops.length ? tops[i + 1].index : text.length;
      const chunk = text.slice(start, end);
      const uuid = (chunk.match(/^\s{2}id:\s*(\S+)/m) || [])[1];
      const mod = (chunk.match(/modifier:\s*'([-\d.]+)'/) || [])[1];
      if (uuid && mod !== undefined) halves.push({ uuid, amount: Number(mod) });
    }
    const twoSided = halves.length === 2;
    for (const { uuid, amount } of halves) {
      const acc = take(uuid);
      if (amount > 0) acc.in += amount; else acc.out += -amount;
      acc.bySource.set(source, (acc.bySource.get(source) || 0) + amount);
      if (twoSided) acc.traded += amount;
    }
  }

  txCache = { at: Date.now(), dir: dirs.tneTransactions, byPlayer, scanned, truncated };
  return txCache;
}

// ---------------------------------------------------------------------------
// UltimateShop -- what was bought and sold

/**
 * shop file -> letter -> {material, amount}.
 *
 * The per-player data records a use-count against a bare letter, and only the
 * shop definition knows that "logs H" means a dark oak log. Without this join
 * the whole shop section reads as "sold 22,498 of logs:H".
 */
function readCatalog(dirs) {
  const catalog = new Map();
  if (!fs.existsSync(dirs.shopDefs)) return catalog;
  for (const file of fs.readdirSync(dirs.shopDefs)) {
    if (!file.endsWith('.yml')) continue;
    let text;
    try { text = fs.readFileSync(path.join(dirs.shopDefs, file), 'utf8'); } catch { continue; }
    const body = text.split(/^items:/m)[1];
    if (!body) continue;
    // Sliced between the headers rather than matched as one expression. A
    // lookahead ending in `$` under /m terminates at the end of the FIRST line
    // rather than at the next item, so every block came back empty and every
    // material read as "logs:H" -- output that looks right and is built on
    // nothing. Slicing between header positions cannot go wrong that way.
    const letters = new Map();
    const heads = [...body.matchAll(/^ {2}(\w+):[ \t]*$/gm)];
    for (let i = 0; i < heads.length; i++) {
      const start = heads[i].index + heads[i][0].length;
      const end = i + 1 < heads.length ? heads[i + 1].index : body.length;
      const chunk = body.slice(start, end);
      const material = (chunk.match(/material:\s*(\S+)/) || [])[1];
      if (!material) continue;
      const amount = Number((chunk.match(/amount:\s*(\d+)/) || [, 1])[1]) || 1;
      letters.set(heads[i][1], { material: material.trim().toUpperCase(), amount });
    }
    catalog.set(file.replace(/\.yml$/i, ''), letters);
  }
  return catalog;
}

/** One player's shop volumes, already decoded to material names. */
function readShop(dirs, uuid, catalog) {
  const file = path.join(dirs.shopDatas, `${uuid}.yml`);
  if (!fs.existsSync(file)) return null;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }

  const buys = new Map();
  const sells = new Map();
  let shop = null;
  let letter = null;
  for (const line of text.split(/\r?\n/)) {
    let m = line.match(/^ {2}(\S+):\s*$/);
    if (m) { shop = m[1]; letter = null; continue; }
    m = line.match(/^ {4}(\w+):\s*$/);
    if (m) { letter = m[1]; continue; }
    m = line.match(/^ {6}(buy|sell)UseTimes:\s*(\d+)/);
    if (m && shop && letter) {
      const entry = catalog.get(shop)?.get(letter);
      const material = entry?.material || `${shop}:${letter}`;
      const n = Number(m[2]) * (entry?.amount || 1);
      const into = m[1] === 'buy' ? buys : sells;
      into.set(material, (into.get(material) || 0) + n);
    }
  }
  return { buys, sells };
}

// ---------------------------------------------------------------------------
// the integrity check

/**
 * Which block breaks could legitimately produce a sold item.
 *
 * DELIBERATELY INCOMPLETE, and that is the design. Only items whose only real
 * source is breaking a block are checkable -- mob drops, crop harvests, trades
 * and crafted goods all have honest routes that leave no block-break behind, so
 * flagging them would produce confident nonsense. Anything absent from this map
 * is reported as unchecked rather than as clean, because "we did not look" and
 * "we looked and it was fine" are different answers.
 */
const BLOCK_SOURCES = {
  DARK_OAK_LOG: ['dark_oak_log', 'dark_oak_wood'],
  OAK_LOG: ['oak_log', 'oak_wood'],
  BIRCH_LOG: ['birch_log', 'birch_wood'],
  SPRUCE_LOG: ['spruce_log', 'spruce_wood'],
  JUNGLE_LOG: ['jungle_log', 'jungle_wood'],
  ACACIA_LOG: ['acacia_log', 'acacia_wood'],
  CHERRY_LOG: ['cherry_log', 'cherry_wood'],
  MANGROVE_LOG: ['mangrove_log', 'mangrove_wood'],
  PALE_OAK_LOG: ['pale_oak_log', 'pale_oak_wood'],
  DIAMOND: ['diamond_ore', 'deepslate_diamond_ore'],
  EMERALD: ['emerald_ore', 'deepslate_emerald_ore'],
  COAL: ['coal_ore', 'deepslate_coal_ore'],
  LAPIS_LAZULI: ['lapis_ore', 'deepslate_lapis_ore'],
  REDSTONE: ['redstone_ore', 'deepslate_redstone_ore'],
  RAW_IRON: ['iron_ore', 'deepslate_iron_ore'],
  RAW_GOLD: ['gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'],
  RAW_COPPER: ['copper_ore', 'deepslate_copper_ore'],
  COBBLESTONE: ['stone', 'cobblestone'],
  DIRT: ['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt'],
  GRAVEL: ['gravel'],
  SAND: ['sand'],
  OBSIDIAN: ['obsidian'],
  NETHERRACK: ['netherrack'],
  AMETHYST_SHARD: ['amethyst_cluster'],
  BAMBOO: ['bamboo'],
  SUGAR_CANE: ['sugar_cane'],
};

/**
 * Sold volume against blocks actually broken, for the items where that
 * comparison means something.
 *
 * The ratio is sold/broken, so under 1.0 is somebody selling less than they
 * mined -- the ordinary case, because nobody sells everything. Meaningfully
 * over 1.0 is the interesting one: more sold than the world ever gave them.
 *
 * The threshold is generous on purpose. Fortune multiplies ore drops several
 * times over, a single break can drop more than one item, and gear won from
 * the arena or given by a friend is real. A flag here is a prompt to go and
 * look with /prism lookup, never a verdict on its own.
 */
function integrity(prism, shop) {
  if (!prism || !shop) return [];
  const rows = [];
  for (const [material, sold] of shop.sells) {
    if (sold < 50) continue;
    const sources = BLOCK_SOURCES[material];
    if (!sources) { rows.push({ material, sold, checkable: false }); continue; }
    let broke = 0;
    for (const block of sources) broke += prism.brokenIndex.get(block) || 0;

    // BOUGHT STOCK COUNTS AS SUPPLY, and leaving it out is how this section
    // produces its most damaging kind of wrong answer. The first run of this
    // report flagged a player for selling 77 diamonds having mined none --
    // he had bought 287 from the same shop minutes earlier. Anyone acting on
    // that flag would have punished a child for shopping.
    const bought = shop.buys.get(material) || 0;
    const supply = broke + bought;
    rows.push({
      material, sold, broke, bought, supply, checkable: true,
      ratio: supply ? sold / supply : Infinity,
    });
  }
  return rows.sort((a, b) => b.sold - a.sold);
}

// ---------------------------------------------------------------------------
// formatting

const pad = (s, n) => String(s).padEnd(n);
const num = (n) => Number(n || 0).toLocaleString('en-US');
const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (secs) => (secs ? new Date(secs * 1000).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '--');

/** The whole report for one player, as plain text for a console. */
export function playerStats(target, rawName) {
  const dirs = resolveDirs(target);
  if (!dirs) return { ok: false, error: 'not a Minecraft Java target, or its folder was not found' };

  const name = String(rawName || '').trim().replace(/^\./, '');
  if (!name) return { ok: false, error: 'usage: prism stats <player>' };

  const balances = readBalances(dirs);
  // Bedrock accounts carry a leading dot in-game; match with and without it so
  // "prism stats waahid121" finds ".waahid121" without anybody having to know.
  const account = balances.find((b) => b.name.toLowerCase() === name.toLowerCase())
    || balances.find((b) => b.name.replace(/^\./, '').toLowerCase() === name.toLowerCase());
  const prism = readPrism(dirs, account?.name || name)
    || readPrism(dirs, `.${name}`);

  if ((!prism || prism.missing) && !account) {
    const known = balances.filter((b) => IS_PLAYER.has(b.type)).map((b) => b.name);
    return { ok: false, error: `no player called "${rawName}". Known: ${known.join(', ') || 'none'}` };
  }
  if (prism?.error) return { ok: false, error: prism.error };

  const display = prism?.name || account?.name || rawName;
  const uuid = prism?.uuid || account?.uuid || '';
  const bedrock = uuid.startsWith(FLOODGATE_PREFIX);
  const L = [];

  L.push(`=== ${display} ${'='.repeat(Math.max(3, 60 - display.length))}`);
  L.push(`  ${bedrock ? 'Bedrock (Floodgate)' : 'Java'} · ${uuid}`);
  if (prism && !prism.missing) {
    L.push(`  first seen ${when(prism.first)} · last seen ${when(prism.last)}`);
  }

  if (account) {
    const rank = balances.filter((b) => IS_PLAYER.has(b.type)).findIndex((b) => b.uuid === account.uuid) + 1;
    const of = balances.filter((b) => IS_PLAYER.has(b.type)).length;
    L.push(`  balance ${money(account.balance)}   (${rank} of ${of})`);
  }

  if (prism && !prism.missing) {
    L.push('');
    L.push('  BLOCKS');
    L.push(`    broken ${num(prism.byAction['block-break'])}   placed ${num(prism.byAction['block-place'])}`
      + `   picked up ${num(prism.byAction['item-pickup'])}   dropped ${num(prism.byAction['item-drop'])}`);
    if (prism.activeHours) {
      L.push(`    ${num(prism.activeHours)} active hours · avg ${num(Math.round(prism.perHour))}/hr`
        + (prism.peakHour ? ` · peak ${num(prism.peakHour.n)}/hr (${prism.peakHour.h})` : ''));
    }
    L.push('    most broken:');
    for (const row of prism.broken.slice(0, 8)) {
      L.push(`      ${pad(row.name, 26)}${num(row.n).padStart(9)}`);
    }
  }

  const catalog = readCatalog(dirs);
  const shop = account ? readShop(dirs, account.uuid, catalog) : null;
  if (shop) {
    const totalSold = [...shop.sells.values()].reduce((a, b) => a + b, 0);
    const totalBought = [...shop.buys.values()].reduce((a, b) => a + b, 0);
    L.push('');
    L.push('  SHOP');
    L.push(`    sold ${num(totalSold)} items · bought ${num(totalBought)}`);
    const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (totalSold) {
      L.push('    top sells:');
      for (const [mat, n] of top(shop.sells)) L.push(`      ${pad(mat, 26)}${num(n).padStart(9)}`);
    }
    if (totalBought) {
      L.push('    top buys:');
      for (const [mat, n] of top(shop.buys)) L.push(`      ${pad(mat, 26)}${num(n).padStart(9)}`);
    }
  }

  const tx = sweepTransactions(dirs);
  const acc = tx && account ? tx.byPlayer.get(account.uuid) : null;
  if (acc) {
    L.push('');
    L.push('  EARNINGS');
    L.push(`    in ${money(acc.in)}   out ${money(acc.out)}   net ${money(acc.in - acc.out)}`);
    const sources = [...acc.bySource.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    for (const [src, v] of sources.slice(0, 6)) {
      L.push(`      ${pad(src, 22)}${(v >= 0 ? '+' : '') + money(v)}`);
    }
    // Zero here means every dollar was created or destroyed by a plugin, which
    // is the normal state. A large number means players are moving money
    // between themselves -- worth knowing before reading anybody's balance as
    // something they earned.
    L.push(`      ${pad('(player-to-player)', 22)}${money(acc.traded)}`);
    if (tx.truncated) L.push(`      partial -- stopped after ${num(tx.scanned)} transaction files`);
  }

  const checks = integrity(prism && !prism.missing ? prism : null, shop);
  if (checks.length) {
    L.push('');
    L.push('  INTEGRITY -- sold vs blocks actually broken');
    for (const row of checks.slice(0, 8)) {
      if (!row.checkable) {
        L.push(`    --   ${pad(row.material, 22)}sold ${num(row.sold).padStart(8)}   not block-sourced, unchecked`);
        continue;
      }
      const flag = row.ratio > 3 ? '!!' : row.ratio > 1.25 ? '? ' : 'ok';
      const pct = row.supply ? `${Math.round(row.ratio * 100)}%` : 'no source at all';
      L.push(`    ${flag}   ${pad(row.material, 22)}sold ${num(row.sold).padStart(8)}`
        + `   mined ${num(row.broke).padStart(8)}`
        + `   bought ${num(row.bought).padStart(7)}   ${pct}`);
    }
    L.push('    ok = mined or bought at least as much as sold. "!!" is a prompt to run');
    L.push('    /prism lookup, not a verdict -- Fortune, gifts and arena prizes are real.');
  }

  return { ok: true, body: L.join('\n') };
}

/**
 * Everyone who has ever played, from both stores that remember them.
 *
 * Prism knows anybody who has touched a block, TheNewEconomy knows anybody who
 * has held money, and neither is a superset of the other -- a child who only
 * ever built has no account, and an account created by a plugin payout can
 * outlive the world its blocks were broken in. The union is the honest answer
 * to "who has played here", which is the list the console completes <player>
 * from and the list `prism players` prints.
 *
 * Cached, because it is a whole-table group-by and the console asks for it on
 * every card render. Nobody joins the server often enough for two minutes of
 * staleness to matter.
 */
const ROSTER_TTL_MS = 2 * 60 * 1000;
let rosterCache = { at: 0, db: null, rows: null };

export function knownPlayers(target) {
  const dirs = resolveDirs(target);
  if (!dirs) return { ok: false, error: 'not a Minecraft Java target, or its folder was not found' };

  if (rosterCache.rows && rosterCache.db === dirs.prismDb
      && Date.now() - rosterCache.at < ROSTER_TTL_MS) {
    return { ok: true, players: rosterCache.rows, cached: true };
  }

  const byKey = new Map(); // lowercased name -> row, so the two stores merge
  const take = (name) => {
    const key = String(name).replace(/^\./, '').toLowerCase();
    if (!byKey.has(key)) {
      byKey.set(key, { name, uuid: '', bedrock: false, balance: null, breaks: 0, first: null, last: null });
    }
    return byKey.get(key);
  };

  for (const b of readBalances(dirs).filter((b) => IS_PLAYER.has(b.type))) {
    const row = take(b.name);
    row.name = b.name; // the account spelling carries the Bedrock dot
    row.uuid = b.uuid;
    row.bedrock = String(b.uuid).startsWith(FLOODGATE_PREFIX);
    row.balance = b.balance;
  }

  let db;
  try {
    db = new DatabaseSync(dirs.prismDb, { readOnly: true });
    // One pass over the activity table rather than one query per player: this
    // is the expensive read here, and asking it per name would turn a roster of
    // a dozen children into a dozen full scans.
    const rows = db.prepare(`
      select p.player name, p.player_uuid uuid,
             min(a.timestamp) first, max(a.timestamp) last,
             sum(case when ac.action = 'block-break' then 1 else 0 end) breaks,
             count(a.activity_id) events
      from prism_players p
      left join prism_activities a on a.cause_player_id = p.player_id
      left join prism_actions ac on ac.action_id = a.action_id
      group by p.player_id`).all();
    for (const r of rows) {
      // Prism records every cause it has ever seen, including the ones that are
      // not people at all -- an "environment" row would otherwise be offered as
      // a player to look up.
      if (!r.uuid) continue;
      const row = take(r.name);
      if (!row.uuid) row.uuid = r.uuid;
      row.bedrock = row.bedrock || String(r.uuid).startsWith(FLOODGATE_PREFIX);
      row.breaks = Number(r.breaks) || 0;
      row.events = Number(r.events) || 0;
      row.first = r.first || null;
      row.last = r.last || null;
    }
  } catch (err) {
    // Prism is optional for this view: without it the roster is still every
    // account TheNewEconomy knows, which is most of the answer.
    if (!byKey.size) return { ok: false, error: `prism.db could not be read: ${err.message}` };
  } finally {
    try { db?.close(); } catch { /* already gone */ }
  }

  const players = [...byKey.values()].sort((a, b) => (b.last || 0) - (a.last || 0)
    || a.name.localeCompare(b.name));
  rosterCache = { at: Date.now(), db: dirs.prismDb, rows: players };
  return { ok: true, players };
}

/** Every player at a glance, for `prism players` and a bare `prism stats`. */
export function playerLeaderboard(target) {
  const roster = knownPlayers(target);
  if (!roster.ok) return { ok: false, error: roster.error };

  const L = ['=== players ' + '='.repeat(58),
    `  ${pad('name', 18)}${'balance'.padStart(13)}${'broken'.padStart(11)}${'  last seen'}`];
  for (const p of roster.players) {
    L.push(`  ${pad(p.name + (p.bedrock ? ' *' : ''), 18)}`
      + `${(p.balance == null ? '--' : money(p.balance)).padStart(13)}`
      + `${num(p.breaks).padStart(11)}  ${when(p.last)}`);
  }
  if (!roster.players.length) L.push('  (nobody on record yet)');
  L.push('');
  L.push('  * = Bedrock account. Sorted by who played most recently.');
  L.push('  prism stats <player>   for one player in full');
  return { ok: true, body: L.join('\n') };
}
