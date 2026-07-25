// Access control.
//
// The rule, in one sentence: if the dashboard is only reachable from this
// machine, there is nothing to log in to; the moment you make it reachable from
// anywhere else, a password becomes mandatory.
//
// That is enforced at startup (assertBindIsSafe) rather than as a warning,
// because this thing can start, stop and send arbitrary RCON to servers running
// as LocalSystem. An open panel on a LAN is a remote-control handle for anyone
// on the network, and "the README said not to" has never stopped anyone from
// port-forwarding it.
//
// No dependencies: scrypt and HMAC come from node:crypto, cookies are three
// lines of parsing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isLoopback } from './config.js';

const COOKIE = 'sd_session';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

// --- password hashing ------------------------------------------------------

export function hashPassword(password, salt = crypto.randomBytes(16)) {
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  let expected;
  let actual;
  try {
    expected = Buffer.from(keyHex, 'hex');
    actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT);
  } catch {
    return false;
  }
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// --- startup gate ----------------------------------------------------------

export class UnsafeBindError extends Error {
  constructor(bind) {
    super(`refusing to bind ${bind} without a password`);
    this.name = 'UnsafeBindError';
    this.bind = bind;
  }

  format() {
    return [
      '',
      '  REFUSING TO START',
      '',
      `  config.json binds to "${this.bind}", which makes this dashboard reachable`,
      '  from other machines — but no password is configured.',
      '',
      '  This dashboard can start, stop and send RCON commands to your servers, and',
      '  when installed as a service it does so as LocalSystem. Exposing that without',
      '  a password hands control of those servers to anyone who can reach this port.',
      '',
      '  Pick one:',
      '',
      '    1. Set a password. In .env:',
      '',
      '         DASHBOARD_PASSWORD=something-long-and-unguessable',
      '',
      '       and in config.json:',
      '',
      '         "auth": { "password": "${DASHBOARD_PASSWORD}" }',
      '',
      '    2. Or keep it local-only — remove "bind" from config.json, or set it to',
      '       "127.0.0.1". No password needed, no login prompt.',
      '',
    ].join('\n');
  }
}

export function assertBindIsSafe(config) {
  const hasPassword = Boolean(config.auth?.password || config.auth?.passwordHash);
  if (!isLoopback(config.bind) && !hasPassword) throw new UnsafeBindError(config.bind);
}

// --- cookies ---------------------------------------------------------------

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// --- the auth layer --------------------------------------------------------

export function createAuth(config, dataDir) {
  const hash = config.auth?.passwordHash
    || (config.auth?.password ? hashPassword(config.auth.password) : '');
  const enabled = Boolean(hash);
  const sessionMs = (config.auth?.sessionDays || 30) * 24 * 3600 * 1000;

  // Persisted so a dashboard restart doesn't log you out. Rotating the password
  // changes the fingerprint below, which invalidates every existing session.
  const secretFile = path.join(dataDir, 'session.secret');
  let secret;
  if (fs.existsSync(secretFile)) {
    secret = fs.readFileSync(secretFile, 'utf8').trim();
  } else {
    secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  }
  const fingerprint = crypto.createHash('sha256').update(hash).digest('hex').slice(0, 16);

  const sign = (data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

  function issue(res, secureRequest) {
    const expires = Date.now() + sessionMs;
    const payload = `${expires}.${fingerprint}`;
    const value = `${payload}.${sign(payload)}`;
    const attrs = [
      `${COOKIE}=${encodeURIComponent(value)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(sessionMs / 1000)}`,
    ];
    if (secureRequest) attrs.push('Secure');
    res.setHeader('Set-Cookie', attrs.join('; '));
  }

  function valid(req) {
    const raw = readCookie(req, COOKIE);
    if (!raw) return false;
    const idx = raw.lastIndexOf('.');
    if (idx === -1) return false;
    const payload = raw.slice(0, idx);
    const mac = raw.slice(idx + 1);

    const expectedMac = Buffer.from(sign(payload));
    const givenMac = Buffer.from(mac);
    if (expectedMac.length !== givenMac.length) return false;
    if (!crypto.timingSafeEqual(expectedMac, givenMac)) return false;

    const [expires, fp] = payload.split('.');
    if (fp !== fingerprint) return false; // password changed since this was issued
    return Number(expires) > Date.now();
  }

  // --- brute force ---------------------------------------------------------
  const attempts = new Map(); // ip -> { count, until }

  function throttled(ip) {
    const entry = attempts.get(ip);
    if (!entry) return 0;
    if (Date.now() > entry.until) { attempts.delete(ip); return 0; }
    return entry.count >= MAX_ATTEMPTS ? Math.ceil((entry.until - Date.now()) / 1000) : 0;
  }

  function noteFailure(ip) {
    const entry = attempts.get(ip) || { count: 0, until: 0 };
    entry.count += 1;
    entry.until = Date.now() + LOCKOUT_MS;
    attempts.set(ip, entry);
  }

  // --- middleware ----------------------------------------------------------

  // The login page's own assets must be reachable before you're logged in —
  // otherwise the stylesheet request gets redirected to /login, the browser
  // receives HTML where it expected CSS, and you get an unstyled page.
  const OPEN_PATHS = new Set([
    '/login', '/login.html', '/style.css', '/favicon.ico',
    '/api/login', '/api/auth-state',
  ]);

  function middleware(req, res, next) {
    if (!enabled) return next();
    if (OPEN_PATHS.has(req.path)) return next();

    if (valid(req)) return next();

    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ ok: false, error: 'not authenticated', login: '/login' });
    }
    return res.redirect(302, '/login');
  }

  // Same-origin CSRF guard. The front-end always sends JSON; a cross-site form
  // post cannot set this content type without triggering a CORS preflight.
  function requireJson(req, res, next) {
    if (req.method !== 'POST' && req.method !== 'DELETE') return next();
    if (!enabled) return next();
    const ct = String(req.headers['content-type'] || '');
    if (!ct.includes('application/json')) {
      return res.status(415).json({ ok: false, error: 'expected Content-Type: application/json' });
    }
    return next();
  }

  function routes(app, publicDir) {
    app.get('/login', (req, res) => {
      if (!enabled) return res.redirect(302, '/');
      if (valid(req)) return res.redirect(302, '/');
      return res.sendFile(path.join(publicDir, 'login.html'));
    });

    app.get('/api/auth-state', (req, res) => {
      res.json({ enabled, authenticated: !enabled || valid(req) });
    });

    app.post('/api/login', (req, res) => {
      if (!enabled) return res.json({ ok: true });

      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const wait = throttled(ip);
      if (wait) {
        return res.status(429).json({ ok: false, error: `too many attempts — try again in ${Math.ceil(wait / 60)} minute(s)` });
      }

      const password = String(req.body?.password || '');
      if (!password || !verifyPassword(password, hash)) {
        noteFailure(ip);
        const left = MAX_ATTEMPTS - (attempts.get(ip)?.count || 0);
        return res.status(401).json({
          ok: false,
          error: left > 0 ? `incorrect password — ${left} attempt(s) left` : 'too many attempts — locked out for 15 minutes',
        });
      }

      attempts.delete(ip);
      issue(res, req.secure || req.headers['x-forwarded-proto'] === 'https');
      return res.json({ ok: true });
    });

    app.post('/api/logout', (req, res) => {
      res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      res.json({ ok: true });
    });
  }

  return { enabled, middleware, requireJson, routes };
}
