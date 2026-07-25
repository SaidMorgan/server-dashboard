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
import sevenDaysToDie from './7dtd.js';
import source from './source.js';
import valheim from './valheim.js';
import processOnly from './process.js';

export const TRANSPORTS = ['rcon-persistent', 'rcon-oneshot', 'rest', 'none'];

const registry = new Map();

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
    rest: null,
    restVerbs: null,
    verbAliases: {},
    setupNotes: '',
    parsePlayers: () => [],
    normalizeReply: (res) => res,
    ...profile,
    origin: origin || 'built-in',
  };

  // A profile that can read players must be able to parse them.
  if (normalized.transport.startsWith('rcon') && typeof normalized.parsePlayers !== 'function') {
    throw new Error(`game profile "${profile.id}"${where} needs a parsePlayers(body) function`);
  }

  registry.set(normalized.id, normalized);
  return normalized;
}

for (const p of [ark, palworld, minecraft, sevenDaysToDie, source, valheim, processOnly]) {
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
