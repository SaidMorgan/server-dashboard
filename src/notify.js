// Outbound alerts: Discord webhooks and a generic HTTP POST.
//
// Every alert in the dashboard already funnels through Monitor#addAlert, so this
// hooks in at exactly one place.
//
// The hard requirement here is *not* spamming. A server that flaps up and down,
// or a full server churning joins and leaves, can generate hundreds of events a
// minute. Discord will rate-limit you and your channel becomes unreadable, so
// there are two independent guards: identical messages are suppressed for a
// cooling-off period, and there is a hard ceiling on messages per minute.

const COLORS = { error: 0xf85149, warn: 0xd29922, info: 0x58a6ff };
const DEDUPE_MS = 60_000;
const MAX_PER_MINUTE = 10;
const TIMEOUT_MS = 6000;

export class Notifier {
  constructor(config) {
    this.config = config.notifications || {};
    this.recent = new Map(); // dedupe key -> last sent timestamp
    this.window = [];        // timestamps of sends inside the last minute
    this.suppressedSinceReport = 0;
  }

  #channels(level) {
    const out = [];
    for (const name of ['discord', 'webhook']) {
      const c = this.config[name];
      if (c?.enabled && c.url && (c.events || []).includes(level)) out.push([name, c]);
    }
    return out;
  }

  #allowed(key) {
    const now = Date.now();

    const last = this.recent.get(key);
    if (last && now - last < DEDUPE_MS) return false;

    this.window = this.window.filter((t) => now - t < 60_000);
    if (this.window.length >= MAX_PER_MINUTE) {
      this.suppressedSinceReport += 1;
      return false;
    }

    this.recent.set(key, now);
    this.window.push(now);

    // Keep the dedupe map from growing without bound on a long-running service.
    if (this.recent.size > 500) {
      for (const [k, t] of this.recent) if (now - t > DEDUPE_MS) this.recent.delete(k);
    }
    return true;
  }

  // Fire and forget: a webhook being down must never stall the poll loop or
  // throw into it.
  notify(alert, targetName) {
    const channels = this.#channels(alert.level);
    if (!channels.length) return;
    if (!this.#allowed(`${alert.level}:${alert.targetId}:${alert.message}`)) return;

    const name = targetName || alert.targetId;
    for (const [kind, channel] of channels) {
      const body = kind === 'discord'
        ? discordPayload(alert, name, this.suppressedSinceReport)
        : { level: alert.level, targetId: alert.targetId, target: name, message: alert.message, at: new Date(alert.t).toISOString() };

      post(channel.url, body).catch((err) => {
        console.error(`[notify:${kind}] ${err.message}`);
      });
    }
    this.suppressedSinceReport = 0;
  }
}

function discordPayload(alert, name, suppressed) {
  const embed = {
    title: name,
    description: alert.message,
    color: COLORS[alert.level] ?? COLORS.info,
    timestamp: new Date(alert.t).toISOString(),
    footer: { text: alert.level.toUpperCase() },
  };
  if (suppressed > 0) {
    embed.footer.text += ` · ${suppressed} similar alert(s) suppressed`;
  }
  return { embeds: [embed] };
}

async function post(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'timed out' : err.message);
  } finally {
    clearTimeout(timer);
  }
}
