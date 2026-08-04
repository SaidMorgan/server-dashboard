# Games

Each supported game is one file in `src/games/`. A profile says how to talk to
the server, what its commands are called, and how to read its player list.

| `game` | Transport | Players | Broadcast | Notes |
|---|---|---|---|---|
| `ark` | RCON, one persistent socket | yes | yes | Read the ARK section. It has traps |
| `palworld` | REST API | yes (+ ping, level) | yes | RCON is deprecated upstream |
| `minecraft` | RCON | yes | yes | `processName` is `java` — see below |
| `7dtd` | RCON, per command | yes | yes | RCON password is the telnet password |
| `source` | RCON, per command | yes | yes | Generic Source engine |
| `valheim` | none | no | no | Vanilla exposes no remote interface |
| `process` | none | no | no | Monitor and control any process |

---

## ARK: Survival Ascended

**This section is the reason the ARK profile looks the way it does. Don't
"simplify" it back.**

ASA has no Steam A2S query (it uses Epic/EOS) and writes no join/leave lines to
its log, so RCON is the only way to see who is online. RCON is the current,
supported method for ASA — it is not deprecated.

Two traps:

**1. ASA ignores the `-RCONEnabled=True` command-line flag.** Only
`RCONEnabled=True` in `GameUserSettings.ini` under `[ServerSettings]` works,
alongside `RCONPort` and `ServerAdminPassword`.

**2. ASA never closes accepted RCON sockets, and allows only about six.** They
accumulate in `CLOSE_WAIT` forever. Once ~6 are held, the listener returns
`ECONNREFUSED` to everything until the server restarts. Nothing recovers it
short of a restart.

So **every connection attempt is a permanently spent resource — including failed
ones**. Three rules follow, all implemented in `src/rcon.js`, none optional:

- **One socket, held forever.** The `rcon-persistent` transport keeps a single
  authenticated connection per server. Never connect-per-command.
- **Exponential backoff on failure** (15s → 30s → 60s → 120s → 5min cap).
  Without it, a 10-second poll loop against a down server burns all six slots in
  under a minute — so RCON is dead before the server has finished starting.
- **A readiness gate.** ARK has been measured at `Full Startup: 224.86 seconds`
  and refuses RCON that entire time. The profile's `readyAfterSeconds: 240` stops
  the dashboard probing until it's plausibly up.

Diagnose with:

```
netstat -ano | findstr :27020
```

Healthy is one `LISTENING` plus one `ESTABLISHED`, and **zero `CLOSE_WAIT`**. Any
`CLOSE_WAIT` accumulation means something is reconnecting in a loop.

**Restart order matters.** If you restart ARK, make sure the dashboard is already
running current code. Something polling a loading ARK will saturate it during
startup and you'll be restarting again.

### Multiple maps

Copy the target block and change `id`, `name`, `gamePort` and `rconPort`. Each
map needs its **own** RCON port — all maps share one `GameUserSettings.ini`, so
without a per-map override only the first server to start gets 27020. Add this to
the map's `.bat`, inside the map URL string:

```
?RCONEnabled=True?RCONPort=27021
```

---

## Palworld

Palworld's RCON is **deprecated** — the official docs say it "is scheduled to
stop functioning in an upcoming update" — and it mangles multi-byte player names.
It also wedges if you hold a connection open, the exact opposite of what ARK
needs.

So this uses the REST API, which is the supported path and returns more: ping and
level per player. In `PalWorldSettings.ini`:

```
RESTAPIEnabled=True
RESTAPIPort=8212
```

Auth is HTTP Basic as user `admin` with your `AdminPassword` — that's the
`adminPassword` field in `config.json`.

The console box takes REST verbs rather than raw RCON:
`showplayers`, `info`, `metrics`, `save`, `announce <msg>`,
`shutdown <secs> <msg>`.

**Broadcasts land in Palworld's in-game chat panel**, which players open with
Enter and which fades when idle. A player who isn't looking at it will swear
nothing arrived. The API returns HTTP 200 either way. If someone reports a
missing broadcast, have them open chat *before* the next test rather than
assuming it failed.

Shutdowns use Palworld's on-screen countdown, which is the only server message
players genuinely can't miss.

---

## Minecraft

In `server.properties`:

```
enable-rcon=true
rcon.port=25575
rcon.password=your-password
```

`processName` defaults to `java`. If you run more than one Java process, the
dashboard can't tell them apart, so **per-process CPU and RAM may report the
wrong server**. Player counts and RCON control are unaffected, since those go
over RCON to a specific port.

---

## Valheim and `process`

Vanilla Valheim has no RCON, no console and no query interface. There is no
supported way to read its player list or message players. The `valheim` profile
therefore monitors the process: up/down, uptime, CPU, RAM, history, crash
alerts, the watchdog, backups and scheduled restarts all work; player count and
broadcasts do not, and the UI hides those controls rather than offering buttons
that can only fail.

Stop and Restart terminate the process. Valheim saves on shutdown, but there's no
way to force a save first, so prefer restarting when nobody is online.

`process` is the same thing for anything else — set `"game": "process"` and a
`processName`.

If you run a BepInEx RCON mod for Valheim, copy `src/games/source.js` into your
own `games/` folder and point `game` at it.

---

## Adding your own game

Drop a `.js` file into a `games/` folder next to `config.json`. It's loaded at
startup, and a file named after a built-in (`ark.js`) deliberately overrides it.

```js
export default {
  id: 'mygame',
  label: 'My Game',

  // 'rcon-persistent'  one socket held open — for servers that leak sockets
  // 'rcon-oneshot'     fresh connection per command — for servers that wedge
  // 'rest'             your own HTTP client, see palworld.js
  // 'none'             no remote interface; monitor the process only
  transport: 'rcon-oneshot',

  // Filled in when config.json omits them.
  defaults: { gamePort: 27015, rconPort: 27015 },

  commands: {
    list: 'players',
    save: 'save',                        // null if the game has no save command
    broadcast: (msg) => `say ${msg}`,    // null if it can't message players
    shutdown: 'quit',
  },

  // Optional: the menu offered above the RCON console box. Anything in
  // <angle brackets> is a value the user must supply — the UI selects it so
  // typing replaces it, and refuses to send a command with one still in it.
  // `danger: true` groups the command under a "Careful" heading and asks for
  // confirmation before running it. The console still accepts any command you
  // type, listed or not.
  consoleCommands: [
    { command: 'players', description: 'Who is online' },
    { command: 'kick <name>', description: 'Disconnect one player' },
    { command: 'quit', description: 'Shut the server down', danger: true },
  ],

  // Turn the raw reply to commands.list into [{ name, id }].
  parsePlayers(body) {
    return (body || '').split('\n')
      .map((l) => l.trim()).filter(Boolean)
      .map((name) => ({ name, id: '' }));
  },

  // Optional: clean up a reply before it reaches the user.
  normalizeReply: (res) => res,

  setupNotes: 'What the user has to enable server-side.',
};
```

Then in `config.json`:

```json
{ "id": "mine", "name": "My Server", "kind": "game", "game": "mygame",
  "processName": "MyServer", "rconPort": 27015, "rconPassword": "${MY_RCON}" }
```

Setting `commands.save` or `commands.broadcast` to `null` hides those buttons in
the UI. If the profile is invalid the dashboard logs why and skips that file
rather than refusing to start.

**Which transport?** Default to `rcon-oneshot`. Use `rcon-persistent` only if the
server leaks sockets the way ARK does, or if you're polling often enough that
reconnecting is wasteful and the server is known to tolerate a held-open
connection. Getting this wrong is how ARK support was originally broken.
