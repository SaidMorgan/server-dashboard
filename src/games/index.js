// Game profile registry.
//
// A profile is everything the dashboard needs to know about one game: how to
// talk to it, what its commands are called, and how to read its player list.
// Built-ins live in this folder. Users can add their own by dropping a .js file
// into a `games/` folder next to config.json — no fork required.
//
// See docs/games.md for the profile shape.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import ark from './ark.js';
import palworld from './palworld.js';
import minecraft from './minecraft.js';
import bedrock from './bedrock.js';
import sevenDaysToDie from './7dtd.js';
import source from './source.js';
import valheim from './valheim.js';
import icarus from './icarus.js';
import processOnly from './process.js';

export const TRANSPORTS = ['rcon-persistent', 'rcon-oneshot', 'rest', 'none'];

// Read-only ways to ask a running server how many players are on it, which is
// a different axis from transport: a game can have no control channel at all
// and still answer the question its own client asks to draw a server list.
// 'a2s' is the Steam query (src/a2s.js); 'raknet' is the Bedrock unconnected
// ping (src/raknet.js). Adding one means teaching src/monitor.js to dispatch
// on it, so this list is deliberately not open to user profiles.
export const QUERY_PROTOCOLS = ['a2s', 'raknet'];

const registry = new Map();

// One list of suggestions, from a profile that may have written it the short
// way. Accepts '@players', a bare array of strings, or full option objects, and
// throws away anything it cannot make sense of rather than shipping it to the
// browser. Depth is capped because `values` nests: a rule offers values, and
// each of those could in principle offer more.
function normalizeOptions(list, depth = 0) {
  if (list === '@players') return '@players';
  if (!Array.isArray(list) || depth > 4) return null;
  const rows = list
    .map((o) => (typeof o === 'string' ? { value: o } : o))
    .filter((o) => o && typeof o.value === 'string' && o.value.trim())
    .map((o) => {
      const row = { value: o.value.trim() };
      if (typeof o.description === 'string' && o.description) row.description = o.description;
      const next = normalizeOptions(o.values, depth + 1);
      if (next) row.values = next;
      return row;
    });
  return rows.length ? rows : null;
}

function normalizeArgValues(argValues, id, where) {
  if (!argValues) return {};
  if (typeof argValues !== 'object' || Array.isArray(argValues)) {
    console.error(`[games] "${id}"${where}: argValues must be an object — ignoring it`);
    return {};
  }
  const out = {};
  for (const [name, list] of Object.entries(argValues)) {
    const rows = normalizeOptions(list);
    if (rows) out[name] = rows;
    else console.error(`[games] "${id}"${where}: argValues.${name} is not a usable option list — ignoring it`);
  }
  return out;
}

function register(profile, origin) {
  const where = origin ? ` (${origin})` : '';
  if (!profile || typeof profile !== 'object') {
    throw new Error(`game profile${where} did not export an object`);
  }
  if (typeof profile.id !== 'string' || !profile.id) {
    throw new Error(`game profile${where} is missing a string "id"`);
  }
  if (!TRANSPORTS.includes(profile.transport)) {
    throw new Error(
      `game profile "${profile.id}"${where} has transport "${profile.transport}"; ` +
      `expected one of ${TRANSPORTS.join(', ')}`,
    );
  }

  const normalized = {
    label: profile.id,
    defaults: {},
    commands: null,
    consoleCommands: [],
    argValues: {},
    rest: null,
    restVerbs: null,
    query: null,
    verbAliases: {},
    setupNotes: '',
    parsePlayers: () => [],
    normalizeReply: (res) => res,
    ...profile,
    origin: origin || 'built-in',
  };

  // A query protocol is opt-in per profile and needs a queryPort on the target
  // to aim at; config.js checks for that.
  if (normalized.query) {
    const protocol = normalized.query.protocol;
    if (!QUERY_PROTOCOLS.includes(protocol)) {
      throw new Error(
        `game profile "${profile.id}"${where} has query protocol "${protocol}"; ` +
        `expected one of ${QUERY_PROTOCOLS.join(', ')}`,
      );
    }
  }

  // A profile that can read players must be able to parse them.
  if (normalized.transport.startsWith('rcon') && typeof normalized.parsePlayers !== 'function') {
    throw new Error(`game profile "${profile.id}"${where} needs a parsePlayers(body) function`);
  }

  // The console dropdown is cosmetic, so a malformed list from a user profile
  // costs them the menu, not the profile.
  if (!Array.isArray(normalized.consoleCommands)) {
    if (normalized.consoleCommands) {
      console.error(`[games] "${normalized.id}"${where}: consoleCommands must be an array — ignoring it`);
    }
    normalized.consoleCommands = [];
  }
  normalized.consoleCommands = normalized.consoleCommands
    .filter((c) => c && typeof c.command === 'string' && c.command.trim())
    .map((c) => ({
      command: c.command.trim(),
      description: typeof c.description === 'string' ? c.description : '',
      danger: Boolean(c.danger),
    }));

  // Suggestion options for the <placeholders> in those commands. Cosmetic in
  // the same way, and normalized here so the browser can trust the shape: a
  // list is either the string '@players' (filled in live from whoever is
  // online) or an array of { value, description, values } rows, where `values`
  // is what the *next* word after this one may be.
  normalized.argValues = normalizeArgValues(normalized.argValues, normalized.id, where);

  registry.set(normalized.id, normalized);
  return normalized;
}

for (const p of [ark, palworld, minecraft, bedrock, sevenDaysToDie, source, valheim, icarus, processOnly]) {
  register(p);
}

// User profiles are loaded after the built-ins, so dropping in a file named
// ark.js deliberately overrides the shipped ARK profile.
export async function loadUserProfiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const loaded = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    const full = path.join(dir, file);
    try {
      const mod = await import(pathToFileURL(full).href);
      const profile = register(mod.default, file);
      loaded.push(profile.id);
    } catch (err) {
      // One bad user file must not take the whole dashboard down.
      console.error(`[games] skipping ${file}: ${err.message}`);
    }
  }
  return loaded;
}

export function getProfile(id) {
  return registry.get(id) || null;
}

export function knownGames() {
  return [...registry.keys()].sort();
}

export function allProfiles() {
  return [...registry.values()];
}
