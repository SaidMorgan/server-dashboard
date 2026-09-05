// Is the server actually in the Steam server browser?
//
// This is a different question from every other check the dashboard makes, and
// the only one that answers it. The process can be up, the query port can be
// answering, the log can say `Game Server API initialized 1`, and the server can
// still be in no browser at all -- because binding the query port and
// registering a session with Steam are two separate steps and only the first
// one fails loudly. See docs/games.md, "`initialized 1` is not the same as
// registered".
//
// The local A2S query cannot stand in for this, and there is recorded proof: on
// a run that logged `FOnlineAsyncTaskSteamCreateServer bWasSuccessful: 0`, this
// install's own history shows the Steam query answering on 27016 every ten
// seconds for the following seven hours. The query is served next to the server;
// the listing lives on Valve's side. Only Valve can be asked.
//
// The UDP master servers that used to answer this (hl2master.steampowered.com
// and friends) are gone -- the hostnames no longer resolve -- so the remaining
// route is the Steam Web API, which needs a free key from
// https://steamcommunity.com/dev/apikey. Without one this reports "unverified",
// which is deliberately its own state: not knowing must never be reported as,
// or acted on like, not listed.
import dns from 'node:dns/promises';

const DEFAULT_TIMEOUT_MS = 8000;

// The public address is stable for long stretches and a lookup is a round trip
// to somebody else's service, so it is cached hard. A wrong IP here reads as
// "not listed", so the cache is dropped on any failure rather than kept.
const IP_TTL_MS = 6 * 3600_000;
let ipCache = null; // {ip, at}

async function fetchText(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// The server registers itself under the address Valve sees, which is the box's
// public IP -- not the 127.0.0.1 the rest of the dashboard talks to, and not the
// LAN address either.
export async function publicIp({ url = 'https://api.ipify.org', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (ipCache && Date.now() - ipCache.at < IP_TTL_MS) return { ok: true, ip: ipCache.ip };
  try {
    const res = await fetchText(url, timeoutMs);
    const ip = res.body.trim();
    if (!res.ok || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      return { ok: false, error: `could not read the public IP (HTTP ${res.status})` };
    }
    ipCache = { ip, at: Date.now() };
    return { ok: true, ip };
  } catch (err) {
    return { ok: false, error: `could not read the public IP: ${err.message}` };
  }
}

// Exported for the "why is this unverified" path: a box with no DNS is a
// different problem from a rejected key, and saying which saves a session.
export async function canReachSteam() {
  try {
    await dns.lookup('api.steampowered.com');
    return true;
  } catch {
    return false;
  }
}

// Ask Steam for every server it is currently advertising at our address, and
// look for ours among them.
//
// Three outcomes, and keeping them apart is the entire safety property of the
// auto-restart built on top of this:
//
//   {ok: true,  listed: true }  -- Steam is advertising it. Proof.
//   {ok: true,  listed: false}  -- Steam answered and it is not in the list.
//   {ok: false, error}          -- we could not find out. Never a strike.
//
// A key that is missing, a network that is down, a rate limit, a malformed
// reply: all of those are the third case. Restarting a healthy server because
// somebody's WiFi dropped would be a far worse failure than missing an unlisted
// one for another five minutes.
export async function checkListed({
  apiKey,
  gamePort,
  queryPort,
  appId = null,
  ip = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!apiKey) {
    return { ok: false, error: 'no Steam Web API key configured (steamWebApiKey)' };
  }

  let addr = ip;
  if (!addr) {
    const res = await publicIp({ timeoutMs });
    if (!res.ok) return { ok: false, error: res.error };
    addr = res.ip;
  }

  // gameaddr filters by IP alone; the port match happens here, because one
  // address can carry several servers and this box runs Palworld on the same
  // one. appid narrows the reply when the profile knows it -- note that is the
  // *game's* id as the server advertises itself (Icarus: 1149460), not the
  // dedicated server tool's (2089300).
  const filter = (appId ? `\\appid\\${appId}` : '') + `\\gameaddr\\${addr}`;
  const url = 'https://api.steampowered.com/IGameServersService/GetServerList/v1/'
    + `?key=${encodeURIComponent(apiKey)}&limit=64&filter=${encodeURIComponent(filter)}`;

  let res;
  try {
    res = await fetchText(url, timeoutMs);
  } catch (err) {
    return { ok: false, error: `Steam did not answer: ${err.message}`, ip: addr };
  }

  if (res.status === 403) {
    return { ok: false, error: 'Steam rejected the Web API key', ip: addr };
  }
  if (!res.ok) {
    return { ok: false, error: `Steam answered HTTP ${res.status}`, ip: addr };
  }

  let servers;
  try {
    servers = JSON.parse(res.body)?.response?.servers ?? [];
  } catch {
    return { ok: false, error: 'Steam sent a reply that could not be parsed', ip: addr };
  }

  // Match on the game port first: it is what a player connects to and what the
  // target configures. Fall back to the query port, which is the port half of
  // `addr`, for a game that advertises the two the other way round.
  const mine = servers.find((s) => {
    if (gamePort != null && Number(s.gameport) === Number(gamePort)) return true;
    const port = Number(String(s.addr || '').split(':')[1]);
    return queryPort != null && port === Number(queryPort);
  });

  if (!mine) {
    return {
      ok: true,
      listed: false,
      ip: addr,
      // How many other servers Steam is advertising at this address. Zero
      // versus several is the difference between "Steam has never heard of
      // this box" and "it is listing the neighbour but not us", which point at
      // different causes.
      othersAtAddress: servers.length,
    };
  }

  return {
    ok: true,
    listed: true,
    ip: addr,
    name: mine.name || null,
    map: mine.map || null,
    players: typeof mine.players === 'number' ? mine.players : null,
    maxPlayers: typeof mine.max_players === 'number' ? mine.max_players : null,
    version: mine.version || null,
    steamId: mine.steamid || null,
  };
}

// --- the decision ----------------------------------------------------------
//
// What one check result means for a server: nothing, something to say, or a
// restart. Kept pure and separate from both the asking above and the acting in
// src/monitor.js, because this is the only logic in the dashboard that can
// reboot a server that is running perfectly well, and it has to be testable
// without a Steam key, a network, or a server to sacrifice.
//
// Takes the running state and a result, returns the new state plus what to do.
// It never restarts on:
//   - a check that failed        -- not knowing is not evidence
//   - a single miss              -- registration is racy, and a run that logged
//                                   a failure has been found joinable since
//   - misses spanning too little -- three checks in one minute prove nothing
//   - a server with players      -- they are proof it is reachable
//   - an unconfirmed player count -- unknown is not empty
export function judgeListing({ state, result, cfg, online, now = Date.now() }) {
  const st = { ...state };
  const alerts = [];
  const minChecks = cfg.minChecks ?? 3;
  const minSpan = cfg.minSpanSeconds ?? 600;

  st.ip = result.ip ?? st.ip;

  if (!result.ok) {
    // Say it once per spell of not knowing, not once every five minutes.
    if (st.ok !== false) alerts.push({ level: 'info', message: `Browser listing unverified: ${result.error}` });
    st.ok = false;
    st.error = result.error;
    return { state: st, act: 'none', alerts };
  }

  st.ok = true;
  st.error = null;

  // Players are proof: somebody is connected, so it is reachable and joinable
  // whatever the list says. Restarting here would throw out the very people who
  // disprove the fault.
  if (result.listed || online > 0) {
    if (st.misses >= minChecks) {
      alerts.push({
        level: 'info',
        category: 'recovery',
        message: result.listed
          ? 'Back in the Steam server browser'
          : 'Not in the Steam list, but players are connected — treating it as reachable',
      });
    }
    st.listed = true;
    st.misses = 0;
    st.firstMissAt = null;
    st.gaveUp = false;
    return { state: st, act: 'clear', alerts };
  }

  st.listed = false;
  st.misses += 1;
  if (st.misses === 1) st.firstMissAt = now;

  const span = st.firstMissAt ? (now - st.firstMissAt) / 1000 : 0;

  // Two conditions, not one. The count alone fires early if checks bunch up
  // after a delay; the span alone fires on a single stale miss. Together they
  // mean consistently absent for the whole window.
  if (st.misses < minChecks || span < minSpan) {
    alerts.push({
      level: 'warn',
      message: st.misses === 1
        ? 'Steam is not advertising this server — checking again before doing anything '
          + `(${minChecks} checks over ${Math.round(minSpan / 60)} minutes)`
        : `Still not in the Steam browser (check ${st.misses} of ${minChecks})`,
    });
    return { state: st, act: 'none', alerts };
  }

  if (st.gaveUp) return { state: st, act: 'none', alerts };

  // Confirmed zero, not merely "not known to be occupied". The listing failure
  // stops anyone *new* joining, but whoever joined before it broke is still
  // playing — and this game has no way to warn them.
  if (online !== 0) {
    alerts.push({
      level: 'warn',
      message: 'Not in the Steam browser, but the player count is not a confirmed zero — '
        + 'not restarting. Use Restart when empty if this needs clearing.',
    });
    return { state: st, act: 'none', alerts };
  }

  return { state: st, act: 'restart', alerts };
}
