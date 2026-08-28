// Config loading, ${ENV} interpolation, defaults and validation.
//
// Design goal: a config.json that is safe to commit and share. Secrets are
// written as ${VAR} references and resolved from the environment or a
// gitignored .env file, so the only thing that ever holds a real password is a
// file git never sees.
//
// Second goal: when the config is wrong, say so in plain English — every error
// at once, each naming its exact path — instead of throwing a stack trace at
// someone who just wants their server list to load.
import fs from 'node:fs';
import path from 'node:path';
import { getProfile, knownGames } from './games/index.js';

export class ConfigError extends Error {
  constructor(errors) {
    super(`config has ${errors.length} problem(s)`);
    this.name = 'ConfigError';
    this.errors = errors;
  }

  // Printed straight to the console at startup, so make it readable.
  format(file) {
    const lines = [
      '',
      '  Configuration problem'.toUpperCase(),
      `  ${file}`,
      '',
      ...this.errors.map((e) => `    - ${e}`),
      '',
      '  See config.example.json for a working reference.',
      '',
    ];
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// .env
// ---------------------------------------------------------------------------

// Deliberately minimal: KEY=value, # comments, optional surrounding quotes.
// Real environment variables always win, so the service can override the file.
export function loadEnvFile(file) {
  if (!fs.existsSync(file)) return 0;
  let count = 0;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);
    process.env[key] = value;
    count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// ${VAR} interpolation
// ---------------------------------------------------------------------------

const VAR_PATTERN = /\$(\$)|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

function interpolateString(value, where, errors) {
  return value.replace(VAR_PATTERN, (match, escaped, name, fallback) => {
    if (escaped) return '$'; // "$${VAR}" is an escape for a literal "${VAR}"
    const found = process.env[name];
    if (found !== undefined && found !== '') return found;
    if (fallback !== undefined) return fallback;
    errors.push(
      `${where}: environment variable ${name} is referenced but not set. ` +
      `Add ${name}=... to your .env file, or write \${${name}:-default} to allow a fallback.`,
    );
    return '';
  });
}

function interpolate(node, where, errors) {
  if (typeof node === 'string') return interpolateString(node, where, errors);
  if (Array.isArray(node)) return node.map((v, i) => interpolate(v, `${where}[${i}]`, errors));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = interpolate(v, where ? `${where}.${k}` : k, errors);
    }
    return out;
  }
  return node;
}

// ---------------------------------------------------------------------------
// Comments in config.json
// ---------------------------------------------------------------------------

// A config nobody can annotate is a config nobody dares change, so // and /* */
// are allowed and stripped before parsing. The one thing this must not break is
// a URL: "https://discord.com/..." has a // inside a string, so track whether
// we're inside one. Replacing comments with spaces rather than deleting them
// keeps every offset intact, so JSON.parse still reports the real position.
export function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];

    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }

    if (c === '"') { inString = true; out += c; continue; }

    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') { out += ' '; i += 1; }
      out += '\n';
      continue;
    }

    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      // Keep newlines so reported line numbers still line up with the file.
      for (; i < stop; i += 1) out += text[i] === '\n' ? '\n' : ' ';
      i -= 1;
      continue;
    }

    out += c;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS = {
  port: 8770,
  // Where history, alerts, schedules and the session key live. Relative paths
  // resolve against the project folder. Two dashboards pointed at the same
  // dataDir will fight over these files, so a second instance needs its own.
  dataDir: 'data',
  // Loopback by default. Binding anywhere else requires auth.password to be
  // set — see src/auth.js. This is the safety property of the whole project.
  bind: '127.0.0.1',
  pollSeconds: 10,
  historyHours: 48,
  auth: {
    password: '',
    passwordHash: '',
    sessionDays: 30,
  },
  notifications: {
    windowsToast: true,
    // An identical message is sent at most once per this many seconds, and no
    // more than maxPerMinute leave the machine in any one minute. Both guard
    // against a flapping server flooding a channel and burning the webhook.
    dedupeSeconds: 60,
    maxPerMinute: 10,
    discord: { enabled: false, url: '', events: ['error', 'warn'], mute: [] },
    webhook: { enabled: false, url: '', events: ['error'], mute: [] },
  },
  // Defaults for every target's backups; a target's own backup block wins.
  backups: {
    // Seconds given to a save command to reach disk before the copy starts.
    flushSeconds: 4,
    // Ceilings, not expected durations — a big world is slow, and a backup that
    // takes 15 minutes beats one killed at 5.
    stageTimeoutMinutes: 10,
    zipTimeoutMinutes: 20,
  },
  alerts: {
    // Alerts kept in memory and in data/alerts.json. The activity feed is a
    // recent-activity view, not an audit log.
    keep: 200,
  },
  // Steam build checks for game targets that carry a steamAppId. See src/steam.js.
  steam: {
    // How often to compare the installed build against the one Steam publishes.
    // Six hours: a dedicated server build lands a few times a week at most, and
    // the answer only matters when you are about to act on it.
    checkMinutes: 360,
    // How long the dashboard keeps a server stopped waiting for you to press
    // Update in Steam. When this runs out it starts the server again on the
    // build that is still on disk, rather than leaving it down overnight.
    waitMinutes: 60,
    // An extra steamapps folder to look in, if the install is somewhere the
    // default library and libraryfolders.vdf don't mention. Per-target
    // steamLibrary wins over this.
    library: null,
  },
  // Steam Workshop mod checks, for game targets that carry a workshopMods
  // block. Detection only -- see src/workshop.js for why nothing is installed
  // automatically.
  workshop: {
    // Mods publish far less often than game builds, and the dashboard never
    // acts on the answer by itself, so there is nothing to gain from asking
    // more often than this.
    checkMinutes: 360,
  },
  restart: {
    // Extra seconds allowed after a shutdown countdown ends before the process
    // is force-killed. The countdown ends when the server *starts* exiting;
    // flushing a large world to disk happens after that.
    graceSeconds: 90,
  },
  targets: [],
};

const TARGET_DEFAULTS = {
  host: '127.0.0.1',
  watchdog: { enabled: false, restartAfterSeconds: 60, maxRestartsPerHour: 3 },
  backup: { enabled: false, paths: [], keep: 10, beforeRestart: false, dir: null },
  schedules: [],
};

function deepDefaults(value, defaults) {
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    return value === undefined ? defaults : value;
  }
  const base = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = { ...base };
  for (const [k, d] of Object.entries(defaults)) {
    out[k] = deepDefaults(base[k], d);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SCHEDULE_ACTIONS = ['restart', 'start', 'stop', 'save', 'backup', 'broadcast'];
const ALERT_LEVELS = ['info', 'warn', 'error'];

// Categories a notification channel can mute or force through. The dashboard's
// own activity feed always shows everything; this only decides what leaves the
// machine.
//
//   backup    archive successes and failures
//   restart   planned stop/start chatter, whether scheduled or clicked
//   recovery  a target coming back up after an unplanned outage
//   update    Steam build checks and everything the Update button does
const ALERT_CATEGORIES = ['backup', 'restart', 'recovery', 'update'];

function check(errors, cond, message) {
  if (!cond) errors.push(message);
  return cond;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;
const isBool = (v) => typeof v === 'boolean';

// A 5-field cron expression: minute hour day-of-month month day-of-week.
export function validateCron(expr) {
  if (typeof expr !== 'string') return 'must be a string';
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return `expected 5 space-separated fields (minute hour day month weekday), got ${fields.length}`;
  }
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  for (let i = 0; i < 5; i += 1) {
    const [lo, hi] = ranges[i];
    for (const part of fields[i].split(',')) {
      const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
      if (!m) return `field ${i + 1} ("${part}") is not a valid cron term`;
      if (m[2] !== undefined && Number(m[2]) < 1) return `field ${i + 1}: step must be 1 or more`;
      if (m[1] === '*') continue;
      const bounds = m[1].split('-').map(Number);
      for (const n of bounds) {
        if (n < lo || n > hi) return `field ${i + 1}: ${n} is outside ${lo}-${hi}`;
      }
      if (bounds.length === 2 && bounds[0] > bounds[1]) {
        return `field ${i + 1}: range ${m[1]} runs backwards`;
      }
    }
  }
  return null;
}

function validateNotificationChannel(channel, where, errors) {
  if (!channel?.enabled) return;
  check(errors, isStr(channel.url), `${where}.url: required when ${where}.enabled is true`);
  if (channel.url && !/^https?:\/\//i.test(channel.url)) {
    errors.push(`${where}.url: must start with http:// or https://`);
  }
  if (!Array.isArray(channel.events)) {
    errors.push(`${where}.events: expected an array of ${ALERT_LEVELS.join('/')}`);
    return;
  }
  for (const e of channel.events) {
    if (!ALERT_LEVELS.includes(e)) {
      errors.push(`${where}.events: "${e}" is not a level (expected ${ALERT_LEVELS.join(', ')})`);
    }
  }

  for (const key of ['mute', 'always']) {
    const list = channel[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      errors.push(`${where}.${key}: expected an array of ${ALERT_CATEGORIES.join('/')}`);
      continue;
    }
    for (const c of list) {
      if (!ALERT_CATEGORIES.includes(c)) {
        errors.push(`${where}.${key}: "${c}" is not a category (expected ${ALERT_CATEGORIES.join(', ')})`);
      }
    }
  }

  // Listing a category in both is a contradiction, and silently picking a
  // winner would leave someone wondering why their alerts vanished.
  for (const c of channel.always || []) {
    if ((channel.mute || []).includes(c)) {
      errors.push(`${where}: "${c}" is in both mute and always — pick one`);
    }
  }
}

// The optional update step behind a service card's "Update & restart" button:
// one command or a list of them, run between the stop and the start.
function validatePreRestart(t, at, errors) {
  if (t.preRestartCommand === undefined) {
    for (const key of ['preRestartDir', 'preRestartTimeoutMinutes']) {
      if (t[key] !== undefined) {
        errors.push(`${at}.${key}: set without preRestartCommand, so nothing would ever use it`);
      }
    }
    return;
  }

  const list = Array.isArray(t.preRestartCommand) ? t.preRestartCommand : [t.preRestartCommand];
  if (!list.length || !list.every(isStr)) {
    errors.push(
      `${at}.preRestartCommand: expected a command such as "git pull --ff-only", ` +
      `or an array of them to run in order`,
    );
  }
  if (t.preRestartDir !== undefined && !isStr(t.preRestartDir)) {
    errors.push(`${at}.preRestartDir: expected the folder to run the command in, e.g. "C:\\\\Apps\\\\MyApi"`);
  }
  if (t.preRestartTimeoutMinutes !== undefined
    && !(isNum(t.preRestartTimeoutMinutes) && t.preRestartTimeoutMinutes > 0)) {
    errors.push(`${at}.preRestartTimeoutMinutes: expected a positive number of minutes`);
  }
}

function validateTarget(t, i, seen, errors) {
  const where = `targets[${i}]`;

  if (!check(errors, isStr(t.id), `${where}.id: required, a short identifier like "ark-island"`)) return;
  const at = `targets[${i}] ("${t.id}")`;

  if (seen.has(t.id)) errors.push(`${at}.id: duplicate — every target needs a unique id`);
  seen.add(t.id);

  check(errors, isStr(t.name), `${at}.name: required, the label shown on the card`);
  if (!check(errors, t.kind === 'game' || t.kind === 'service',
    `${at}.kind: expected "game" or "service", got ${JSON.stringify(t.kind)}`)) return;

  if (t.kind === 'service') {
    check(errors, isStr(t.serviceName), `${at}.serviceName: required for kind "service"`);
    if (t.healthUrl && !/^https?:\/\//i.test(t.healthUrl)) {
      errors.push(`${at}.healthUrl: must start with http:// or https://`);
    }
    validatePreRestart(t, at, errors);
    return;
  }

  // --- game targets ---
  if (!check(errors, isStr(t.game),
    `${at}.game: required. Known games: ${knownGames().join(', ')}`)) return;

  const profile = getProfile(t.game);
  if (!profile) {
    errors.push(
      `${at}.game: "${t.game}" is not a known game. Built-ins: ${knownGames().join(', ')}. ` +
      `To add your own, drop a profile into the games/ folder — see docs/games.md.`,
    );
    return;
  }

  check(errors, isStr(t.processName),
    `${at}.processName: required — the Windows process name without .exe, e.g. "${profile.defaults?.processName || 'ArkAscendedServer'}"`);

  if (t.startCommand !== undefined && t.startCommand !== null && !isStr(t.startCommand)) {
    errors.push(`${at}.startCommand: expected a path to a .bat or .exe, or omit it to hide the Start button`);
  }
  if (t.maxPlayers !== undefined && !isNum(t.maxPlayers)) {
    errors.push(`${at}.maxPlayers: expected a number`);
  }

  // Steam update checks. Most games fill steamAppId in from their profile, so
  // this usually only fires for a hand-written one.
  if (t.steamAppId !== undefined && t.steamAppId !== null
    && !(isNum(t.steamAppId) && t.steamAppId > 0 && Number.isInteger(t.steamAppId))) {
    errors.push(
      `${at}.steamAppId: expected the Steam app id of the DEDICATED SERVER as a number, `
      + `e.g. 2394010 for Palworld — it is the number in the store URL, and it is not the game's own id`,
    );
  }
  if (t.steamLibrary !== undefined && t.steamLibrary !== null && !isStr(t.steamLibrary)) {
    errors.push(`${at}.steamLibrary: expected a path to a steamapps folder, e.g. "D:\\\\SteamLibrary\\\\steamapps"`);
  }
  if (t.steamLibrary && t.steamAppId === undefined) {
    errors.push(`${at}.steamLibrary: set without steamAppId, so nothing would ever look in it`);
  }

  // Workshop mod checks. Both halves are required or there is nothing to
  // compare: the app id says which acf to read, the folder says what is
  // actually installed.
  if (t.workshopMods !== undefined && t.workshopMods !== null) {
    const w = t.workshopMods;
    if (typeof w !== 'object' || Array.isArray(w)) {
      errors.push(`${at}.workshopMods: expected an object with appId and modsDir`);
    } else {
      if (!(isNum(w.appId) && w.appId > 0 && Number.isInteger(w.appId))) {
        errors.push(
          `${at}.workshopMods.appId: expected the Steam app id of the GAME as a number, `
          + `e.g. 1623730 for Palworld — workshop items belong to the game, not to the `
          + `dedicated server app, so this is not the same number as steamAppId`,
        );
      }
      check(errors, isStr(w.modsDir),
        `${at}.workshopMods.modsDir: required — the folder holding one subfolder per `
        + `installed mod, each with an InstallManifest.json`);
      if (w.workshopDir !== undefined && w.workshopDir !== null && !isStr(w.workshopDir)) {
        errors.push(`${at}.workshopMods.workshopDir: expected a path to a steamapps\\workshop folder`);
      }
    }
  }

  // Filled in from the profile's defaults for a stock setup; only a target that
  // explicitly cleared it can get here.
  if (profile.query) {
    check(errors, isNum(t.queryPort),
      `${at}.queryPort: required for ${profile.label} — it is how the player count is read`);
  }

  if (profile.transport === 'rest') {
    check(errors, isNum(t.restPort), `${at}.restPort: required for ${profile.label}`);
    check(errors, isStr(t.adminPassword),
      `${at}.adminPassword: required for ${profile.label}. Use \${SOME_VAR} and put the value in .env.`);
  } else if (profile.transport.startsWith('rcon')) {
    check(errors, isNum(t.rconPort), `${at}.rconPort: required for ${profile.label}`);
    check(errors, isStr(t.rconPassword),
      `${at}.rconPassword: required for ${profile.label}. Use \${SOME_VAR} and put the value in .env.`);
  }

  // --- optional blocks ---
  if (t.watchdog?.enabled) {
    check(errors, isNum(t.watchdog.restartAfterSeconds) && t.watchdog.restartAfterSeconds >= 10,
      `${at}.watchdog.restartAfterSeconds: expected a number of 10 or more`);
    check(errors, isNum(t.watchdog.maxRestartsPerHour) && t.watchdog.maxRestartsPerHour >= 1,
      `${at}.watchdog.maxRestartsPerHour: expected a number of 1 or more`);
    if (!isStr(t.startCommand)) {
      errors.push(`${at}.watchdog: enabled, but there is no startCommand — the watchdog would have no way to restart it`);
    }
  }

  if (t.backup?.enabled) {
    if (!Array.isArray(t.backup.paths) || !t.backup.paths.length) {
      errors.push(`${at}.backup.paths: required when backups are enabled — the save folder(s) to archive`);
    } else {
      t.backup.paths.forEach((p, j) => {
        if (!isStr(p)) errors.push(`${at}.backup.paths[${j}]: expected a path string`);
      });
    }
    check(errors, isNum(t.backup.keep) && t.backup.keep >= 1,
      `${at}.backup.keep: expected how many archives to retain (1 or more)`);
    if (t.backup.beforeRestart !== undefined && !isBool(t.backup.beforeRestart)) {
      errors.push(`${at}.backup.beforeRestart: expected true or false`);
    }
  }

  if (t.schedules !== undefined) {
    if (!Array.isArray(t.schedules)) {
      errors.push(`${at}.schedules: expected an array`);
    } else {
      t.schedules.forEach((s, j) => {
        const sw = `${at}.schedules[${j}]`;
        const cronError = validateCron(s?.cron);
        if (cronError) errors.push(`${sw}.cron: ${cronError}`);
        if (!SCHEDULE_ACTIONS.includes(s?.action)) {
          errors.push(`${sw}.action: expected one of ${SCHEDULE_ACTIONS.join(', ')}, got ${JSON.stringify(s?.action)}`);
        }
        if (s?.action === 'broadcast' && !isStr(s.message)) {
          errors.push(`${sw}.message: required for a broadcast schedule`);
        }
        if (s?.warnMinutes !== undefined && !isNum(s.warnMinutes)) {
          errors.push(`${sw}.warnMinutes: expected a number of minutes to warn players beforehand`);
        }
      });
    }
  }
}

function validate(config, errors) {
  check(errors, isNum(config.port) && config.port > 0 && config.port < 65536,
    `port: expected a number between 1 and 65535, got ${JSON.stringify(config.port)}`);
  check(errors, isStr(config.bind), `bind: expected an address such as "127.0.0.1" or "0.0.0.0"`);
  check(errors, isNum(config.pollSeconds) && config.pollSeconds >= 2,
    `pollSeconds: expected a number of 2 or more (below that you are just hammering the servers)`);
  check(errors, isNum(config.historyHours) && config.historyHours > 0,
    `historyHours: expected a positive number of hours to keep history for`);
  check(errors, isNum(config.auth?.sessionDays) && config.auth.sessionDays > 0,
    `auth.sessionDays: expected a positive number of days before a login expires`);

  validateNotificationChannel(config.notifications?.discord, 'notifications.discord', errors);
  validateNotificationChannel(config.notifications?.webhook, 'notifications.webhook', errors);

  // Tunables. Each must be a positive number — a zero or a negative here turns
  // into a timeout that fires instantly or a retention that keeps nothing.
  for (const [where, value] of [
    ['notifications.dedupeSeconds', config.notifications?.dedupeSeconds],
    ['notifications.maxPerMinute', config.notifications?.maxPerMinute],
    ['backups.flushSeconds', config.backups?.flushSeconds],
    ['backups.stageTimeoutMinutes', config.backups?.stageTimeoutMinutes],
    ['backups.zipTimeoutMinutes', config.backups?.zipTimeoutMinutes],
    ['alerts.keep', config.alerts?.keep],
    ['restart.graceSeconds', config.restart?.graceSeconds],
    ['steam.checkMinutes', config.steam?.checkMinutes],
    ['steam.waitMinutes', config.steam?.waitMinutes],
  ]) {
    check(errors, isNum(value) && value > 0, `${where}: expected a positive number, got ${JSON.stringify(value)}`);
  }

  if (!Array.isArray(config.targets)) {
    errors.push('targets: expected an array of servers to monitor');
    return;
  }
  if (!config.targets.length) {
    errors.push('targets: no servers configured. Copy a block from config.example.json to get started.');
    return;
  }

  const seen = new Set();
  config.targets.forEach((t, i) => validateTarget(t, i, seen, errors));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isLoopback(address) {
  if (!address) return false;
  const a = String(address).trim().toLowerCase().replace(/^\[|\]$/g, '');
  return a === 'localhost' || a === '::1' || a === '127.0.0.1' || a.startsWith('127.');
}

// Applies each game profile's defaults to its targets. Explicit config always
// wins; this only fills gaps, so "rconPort" can be omitted for a stock setup.
function applyProfileDefaults(config) {
  for (const t of config.targets) {
    if (t.kind !== 'game') continue;
    const profile = getProfile(t.game);
    if (!profile?.defaults) continue;
    for (const [k, v] of Object.entries(profile.defaults)) {
      if (t[k] === undefined || t[k] === null) t[k] = v;
    }
  }
}

export function loadConfig({ dir, file } = {}) {
  const root = dir || process.cwd();
  const configFile = file || process.env.SD_CONFIG || path.join(root, 'config.json');

  loadEnvFile(path.join(root, '.env'));

  if (!fs.existsSync(configFile)) {
    throw new ConfigError([
      `no config file at ${configFile}.`,
      `Copy config.example.json to config.json and edit it, then copy .env.example to .env for your passwords.`,
    ]);
  }

  let raw;
  try {
    raw = JSON.parse(stripJsonComments(fs.readFileSync(configFile, 'utf8')));
  } catch (err) {
    throw new ConfigError([`not valid JSON — ${err.message}`, 'A trailing comma or a missing quote is the usual cause.']);
  }

  const errors = [];
  const interpolated = interpolate(raw, '', errors);
  const config = deepDefaults(interpolated, DEFAULTS);
  config.targets = (config.targets || []).map((t) => deepDefaults(t, TARGET_DEFAULTS));

  // Interpolation errors make everything downstream meaningless, so stop here.
  if (errors.length) throw new ConfigError(errors);

  applyProfileDefaults(config);
  validate(config, errors);
  if (errors.length) throw new ConfigError(errors);

  config.file = configFile;
  config.root = root;
  config.dataDir = path.resolve(root, config.dataDir || 'data');
  config.backupRoot = config.backupRoot
    ? path.resolve(root, config.backupRoot)
    : path.join(root, 'backups');
  return config;
}

const SECRET_KEYS = /password|secret|token|adminpassword|webhook|url$/i;

// For logging and for anything that might reach the browser.
export function redact(node) {
  if (Array.isArray(node)) return node.map(redact);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = SECRET_KEYS.test(k) && typeof v === 'string' && v ? '***' : redact(v);
    }
    return out;
  }
  return node;
}
