# Games

Each supported game is one file in `src/games/`. A profile says how to talk to
the server, what its commands are called, and how to read its player list.

| `game` | Transport | Players | Broadcast | Notes |
|---|---|---|---|---|
| `ark` | RCON, one persistent socket | yes | yes | Read the ARK section. It has traps |
| `palworld` | REST API | yes (+ ping, level) | yes | RCON is deprecated upstream |
| `minecraft` | RCON | yes | yes | `processName` is `java` — see below |
| `bedrock` | none | count only | no | Minecraft Bedrock. No RCON exists; the count comes from the RakNet ping |
| `7dtd` | RCON, per command | yes | yes | RCON password is the telnet password |
| `source` | RCON, per command | yes | yes | Generic Source engine |
| `valheim` | none | no | no | Vanilla exposes no remote interface |
| `icarus` | none | no | no | SteamCMD-only install. Its self-shutdown timers fight the watchdog |
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

### It is a SteamCMD install, and the dashboard updates it itself

Palworld's dedicated server *is* in the Steam client's library, and this one used
to be installed from it. It no longer is. Pointing SteamCMD at the client's
library gives you two programs each keeping their own record of one folder, which
is how a working install turns into a re-download at the worst moment -- so the
server was moved to a SteamCMD-only install that nothing else writes to:

```
C:\Apps\steamcmd\steamcmd.exe +force_install_dir C:\GameServers\PalServer ^
  +login anonymous +app_update 2394010 validate +quit
```

That is the same command the dashboard runs on the Update button and on an
automatic update, so there is nothing to press in Steam any more. The target
carries `steamLibrary` (SteamCMD's own `steamapps`, or the build check has no
manifest to read) and `steamInstallDir` (the `+force_install_dir` layout puts the
files in the folder itself, not under `steamapps\common`).

**Do not reinstall it in the Steam client.** Two managers, one folder, and the
first symptom is a 6 GB re-download in the middle of a session.

### Automatic updates wait for an empty server

With `autoUpdate: true` the dashboard installs new builds on its own. The sweep
runs hourly (`steam.checkMinutes`) and only acts on a **confirmed zero** players
-- an unknown player list is not an empty one. A populated server is left alone,
announced once, and picked up by a later sweep.

When it fires: 60-second on-screen countdown, stop, pre-update backup, SteamCMD,
start. Monitoring is suppressed for the whole run, so the download minutes do not
read as an outage or wake the watchdog.

`app_update` rewrites depot files only. `Pal\Saved` and `Mods\` are not in the
depot, so the world, the settings and the whole UE4SS stack come through every
update untouched -- `validate` included.

### Mods do not update with the game

The mods here come from the Steam Workshop by way of PalSphere.gg, which the
Steam *client* downloads and PalSphere installs into the server folder. SteamCMD
logs in anonymously and cannot fetch workshop items, so an automatic game update
leaves the mods exactly where they were.

That is usually what you want -- but a game version bump can still break a mod
built against the old one. If the server comes back up after an update and
something is wrong, check `Mods\NativeMods\UE4SS\UE4SS.log` first; it names each
mod as it loads. Refreshing mods is a manual pass in PalSphere, pointed at
`C:\GameServers\PalServer`.

### ...but the dashboard tells you when one is waiting

The `workshopMods` block turns on a sweep that compares what is installed
against what Steam has already downloaded, and alerts when they differ:

```json
"workshopMods": {
  "appId": 1623730,
  "modsDir": "C:\GameServers\PalServer\Mods\ManagedMods"
}
```

`appId` is the **game** (1623730), not the dedicated server (2394010) --
workshop items belong to the game. Each mod folder carries an
`InstallManifest.json` naming its workshop item and when it was last written
into the server; Steam's `appworkshop_1623730.acf` says when each item was last
downloaded. Newer on Steam than on the server means an update is waiting.

Three states, kept apart because they need different things from you:

| State | Meaning |
| --- | --- |
| current | nothing to do |
| stale | Steam has a newer copy; refresh it in the mod manager |
| unsubscribed | installed here, not subscribed in the client -- it will never update again |

Two details that decide whether the answer is trustworthy:

**It reads `WorkshopItemsInstalled`, not `WorkshopItemDetails`.** Details carries
the newest version Steam knows to *exist*; Installed carries what is actually on
this disk. Comparing against Details would announce updates that the client has
not downloaded, sending you to the mod manager to find nothing there.

**It reads install times from `InstallManifest.json`, not from file mtimes.**
Copying a server folder preserves timestamps -- this install was migrated with
`robocopy /COPY:DAT` -- so mtimes would report every mod as freshly installed on
a machine where nothing had been installed at all.

Alerts land in the `mods` category, so `notifications.discord.mute` can silence
them independently of build updates, and each mod is announced once per
published version rather than once per sweep. `steam.checkMinutes` governs the
game build sweep; `workshop.checkMinutes` (default 360) governs this one.

### The Mods panel lists what is installed

The banner above is an alert: by design it says nothing at all while every mod
is current, which is most of the time. The **Mods** panel on the card is the
other half — the standing answer to "what is this server actually running?" —
and it is read on demand from disk rather than polled.

Per mod it shows the name, `Version` and `Author` from the mod's own `Info.json`,
its size on disk, when it was installed, its dependencies, and a flag when it is
in a state that needs a decision:

| Flag | Meaning |
| --- | --- |
| update waiting | Steam has a newer copy — the `stale` state above |
| not subscribed | no subscription left to update from |
| not loaded | installed, but missing from the game's active mod list |

**"not loaded" is the one worth knowing about.** Installed and enabled are
different states in Palworld: `Mods\PalModSettings.ini` carries one
`ActiveModList=` line per *enabled* mod, and the mod manager leaves disabled
mods in the file as commented-out lines. A mod that is installed, current and
commented out is fully present on disk and doing nothing, which is the most
common "why isn't my mod working". The panel reads that file (its location comes
from the game profile's `mods.enabledFrom`, resolved against `steamInstallDir`)
and shows the two states apart. `bGlobalEnableMod=False` turns every mod off at
once while leaving them all listed as active, so that is called out separately
above the list.

Size is measured from the `Files` array in each `InstallManifest.json`, not from
the mod's own folder. A UE4SS mod keeps one `Info.json` under `ManagedMods` and
its actual payload — dlls, Lua, config — under `NativeMods`, so measuring the
folder it is named after would report a 400-byte mod.

Nothing on this panel writes. Enabling, updating and removing mods stay in the
mod manager, for the same reason the sweep above only ever raises a flag.


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

## Minecraft: Bedrock Edition

**A different product from `minecraft`, not a variant of it.** The `minecraft`
profile speaks Source RCON, and RCON is a *Java Edition* feature. Bedrock
Dedicated Server has no RCON, no REST and no telnet: its console is stdin on
`bedrock_server.exe`, and the dashboard starts servers detached (`src/win.js`),
so there is no pipe to write to. Hence `transport: 'none'` — up/down, uptime,
CPU, RAM, history, crash alerts, the watchdog, backups and scheduled restarts
work; broadcasts and a clean remote shutdown do not.

It can still be read. BDS answers the RakNet unconnected ping that the Bedrock
client sends to draw its server list, and the reply carries the player count and
the cap — see `src/raknet.js`. That is where the `3 / 10` badge, the history
graph and "is it safe to restart" come from, exactly as A2S does for Icarus.

**Names are not on the wire at all.** This is stronger than the Icarus case: A2S
at least has an `A2S_PLAYER` packet that Icarus fills with blanks, whereas
Bedrock has no list packet whatsoever — the ping reply is one string with a
number in it. The card says "N player(s) online" and the only place names ever
appear is the server's own console output, which is why the start `.bat`
redirects stdout to a log worth tailing.

### The port is the same number twice, and it is UDP

Bedrock answers the ping on the port players connect to, so `gamePort` and
`queryPort` are both `19132`. Nothing binds twice — the dashboard just sends its
ping where the clients send theirs. This is the one game here that cannot lose
the query-port race described below, because there is no separate port to lose.

It is **UDP**. A firewall rule copied from a Java server (TCP 25565) will not
pass Bedrock traffic, and consoles specifically need UDP 19132 open.

### Stop is a kill, and there is no save-on-exit

The honest limitation. Stop and Restart terminate the process, and unlike Icarus
— where `SaveGameOnExit=True` is what makes that safe — BDS has no equivalent
setting. A hard kill can lose recent chunk writes.

So `backup.beforeRestart` is not decoration on this target; it is what stands
between the 04:30 restart and a world damaged mid-write. Leave it on. If that
stops being good enough, the fix is a supervisor that holds the server's stdin
and types `stop` into it, at which point this profile can move to
`rcon-persistent` and gain a console, broadcasts and a clean shutdown.

`warnMinutes` on a schedule is still honoured by the scheduler, but nobody in
game sees anything — there is no broadcast channel to send a warning down.

### Updates are a manual unzip

Bedrock is not on Steam and has no app id, so there is no manifest for the build
check to read and nothing for `steamcmd` to install: no `steamLibrary`, no
`steamInstallDir`, no `autoUpdate` on this target. An update is a new zip from
minecraft.net unzipped over the folder. The current build is published at:

```
https://net-secondary.web.minecraft-services.net/api/v1.0/download/links
```

Keep `worlds/`, `server.properties`, `allowlist.json` and `permissions.json`
when you unzip — the archive ships stock copies of all four and will overwrite
them.

### allow-list is on by default

The shipped `server.properties` has `allow-list=true` with an empty
`allowlist.json`, so a brand new server refuses everyone and looks exactly like
a networking fault. BDS warns about it in the log at startup. Either add players
to `allowlist.json` or set `allow-list=false`.

---

## Icarus

Icarus has no RCON, no REST and no console, so the profile is `transport: none`:
up/down, uptime, CPU, RAM, history, crash alerts, the watchdog, backups and
scheduled restarts work; broadcasts and a clean remote shutdown do not.
Administration happens in-game, from a client whose Steam ID you have made an
admin.

It can still be read, though. The profile sets `query: { protocol: 'a2s' }`, so
every poll asks the query port the same question the Steam server browser does
and gets back the server name and **how many players are on it** — the `3 / 16`
badge, the history graph, and the join/leave lines in the activity feed. It also
gives the two decisions that need a player count something real to work from:
an automatic Steam update waits for a confirmed empty server, and so does
skipping the shutdown warning.

Names are the one thing missing. Icarus answers `A2S_PLAYER` with the right
number of entries and an empty string in every name field, so the profile sets
`names: false` and the card says "2 player(s) online" rather than listing two
blanks. Who they are is visible in `Icarus.log`, not over the wire.

A "Steam query" tile sits where RCON's would be on other games. It reading
anything but `answering` while the server is up is the symptom described in
[the query port section](#the-query-port-will-collide-and-the-failure-is-silent) — a server
that nobody can find in the browser.

### It is a SteamCMD-only install

"Icarus Dedicated Server" (app **2089300**) is a Tool that never appears in the
Steam client's library, so like Palworld here it cannot be installed or updated
by clicking Update in Steam. It lives outside the client's library entirely:

```
C:\steamcmd\steamcmd.exe +force_install_dir C:\GameServers\IcarusServer ^
  +login anonymous +app_update 2089300 validate +quit
```

Anonymous login is enough — owning Icarus is not required to run the server.

Two consequences for the dashboard. The target needs **`steamLibrary`** pointing
at SteamCMD's own folder (`...\IcarusServer\steamapps`), or the build check has no
manifest to read and the card silently gets no update badge. And the update
itself is the command above rather than a click, so when the dashboard reports a
new build, stop the server, run it, and start the server again.

SteamCMD exits with **code 7** after it updates itself, even on a completely
successful install. Check `StateFlags` in the appmanifest — `4` means installed —
rather than trusting the exit code.

### The query port will collide, and the failure is silent

Icarus registers with Steam through its query port, default **27015** — the same
port every other Steam server on the box wants. Palworld holds it here.

When Icarus loses that race it does not fail loudly. It starts normally, listens
on 17777, and is simply invisible: nobody can find or join it. The only evidence
is in `Icarus\Saved\Logs\Icarus.log`:

```
LogSteamShared: Warning: Steam Dedicated Server API failed to initialize.
LogOnline: STEAM: [AppId: 1149460] Game Server API initialized 0
LogOnline: Warning: Failed to initialize Steam, this could be due to a Steam
           server and client running on the same machine.
```

That last line sends you hunting for a Steam client conflict. Usually it is just
the port. Give Icarus its own with `-QueryPort=` on the command line — this
install uses 27016 — and confirm you get `Game Server API initialized 1`.

### `initialized 1` is not the same as registered

Binding the query port and registering a session are two separate steps, and the
second one can fail on its own:

```
LogOnline: STEAM: [AppId: 1149460] Game Server API initialized 1
LogOnline: Warning: OSS: Async task
  'FOnlineAsyncTaskSteamCreateServer bWasSuccessful: 0' failed in 15.02 seconds
```

The API came up, the port bound, the prospect loaded, the server sits there
using 3.5 GB and 0% CPU looking perfect — and it is in **no** browser, LAN or
internet, because it never created a session to advertise. Unlike the port
collision this leaves nothing in `netstat` to notice, and the watchdog actively
hides it: the process is alive, so every check passes.

**The cause is `ResumeProspect=True`.** Steam's CreateServer task has a fixed
15-second budget and is ticked on the game thread. With ResumeProspect the
server loads the prospect's terrain immediately at startup, which blocks that
thread — `LoadMap(/Game/Maps/Terrain_016_OLY/...)` plus a synchronous
`ULevelStreaming::RequestLevel ... is flushing async loading` — for longer than
the budget, and registration dies while the world is still loading. Measured on
this install:

| World loaded | LoadMap | CreateServer |
| --- | --- | --- |
| 12 min after start (prospect resumed by hand) | 5.9s | ok |
| 23s after start | 3.2s | ok |
| 37s after start | 6.3s | **failed** |
| 35s after start | 7.1s | **failed** |

It is a race, not a clean threshold, which is why it can look intermittent and
why a bigger build or a longer-running prospect tips a working server into a
broken one. `ResumeProspect=False` fixes it outright: the server loads only
`DedicatedServerEntry` (0.6s), registers, and *then* the prospect is resumed
from in-game — which keeps the registration, as the 12-minute row above shows.
The cost is that the world is not up until somebody resumes it, so every
restart needs a person. Weigh that against a nightly scheduled restart.

Restarting does **not** clear it on its own. What this also needs is *noticing*,
so the Icarus profile declares a `logHealth` check that the monitor runs once
per server start:

```js
logHealth: {
  afterSeconds: 90,
  pattern: /Game Server API initialized 0|FOnlineAsyncTaskSteamCreateServer bWasSuccessful: 0/,
  message: '...',
}
```

One scan of the log tail per run, keyed on the process start time so a healthy
run is never read twice and a restart re-arms it — these logs reach hundreds of
KB and the poll loop runs every ten seconds. The 90-second delay matters: the
failure is logged about 45 seconds in, and a verdict read too early is a false
all-clear. Both patterns are covered because they present identically to a
player — `initialized 0` is the query port already being taken, `bWasSuccessful:
0` is the port being fine and Steam not answering.

Note that a server started by the dashboard service runs as **LocalSystem**. You
cannot `taskkill` it from an ordinary shell — the dashboard can, because it is
that service, so restart it from the card rather than the command line.

### The self-shutdown timers fight the watchdog

`ServerSettings.ini` is **not generated on first run**; you write it yourself at
`Icarus\Saved\Config\WindowsServer\ServerSettings.ini`:

```ini
[/Script/Icarus.DedicatedServerSettings]
SessionName=Your server
JoinPassword=
MaxPlayers=8
AdminPassword=something-long
ShutdownIfNotJoinedFor=-1
ShutdownIfEmptyFor=-1
AllowNonAdminsToLaunchProspects=True
AllowNonAdminsToDeleteProspects=False
ResumeProspect=True
```

`ShutdownIfNotJoinedFor` and `ShutdownIfEmptyFor` default to **300 seconds**, so
a stock server deliberately exits five minutes after the last player leaves. The
watchdog cannot tell that from a crash, restarts it, and five minutes later the
pair do it again — a restart loop that looks like a crash loop. Set both to `-1`,
or turn the watchdog off for this target. Do not leave the defaults and the
watchdog both on.

### The browser name comes from the command line, not the ini

`SessionName` in `ServerSettings.ini` does **not** set the name players see. The
server browser reads `-SteamServerName=` from the command line, and with that
switch missing UE falls back to the session's raw numeric Steam id -- so the
server appears in the list as something like `90291711724711955` while looking
completely healthy in every other respect, right down to a correct player count
and ping.

```
IcarusServer.exe -log -QueryPort=27016 -SteamServerName=YourServerName
```

`SessionName` is worth setting anyway for the other places Icarus uses it, but
it is the switch that changes the listing. Verify with:

```
(Get-CimInstance Win32_Process -Filter "Name='IcarusServer-Win64-Shipping.exe'").CommandLine
```

The launcher passes its arguments through, so the switch should appear on the
*shipping* exe's command line, not just the launcher's. UE truncates names past
its internal maximum rather than rejecting them.

### Prospects, admins and saves

A world is a *prospect*, and the server runs one at a time. With
`ResumeProspect=True` it reloads the last one after a restart. You do not have to
name a prospect in the ini: an admin launches one from the in-game Dedicated
Servers menu, which is the normal workflow.

Saves live under `Icarus\Saved\PlayerData`, which is what `backup.paths` points at.
Note the folder does not exist until the server has run a prospect — the backup
job reports a missing source folder rather than writing an empty archive, so
create it or run a prospect before trusting the schedule.

Stop is safe: the launcher `IcarusServer.exe` exits by itself when the real
`IcarusServer-Win64-Shipping.exe` is killed, so `processName` should be the
shipping exe and nothing is orphaned.

### What the card can and cannot do, and why it says so

`transport: none` costs Icarus the broadcast box and the console, and nothing
can give them back. What it does *not* cost is a delayed restart: "Warn &
restart" is the dashboard's own timer, not a message sent to the server, so it
works here — it simply cannot tell anyone it is coming. It used to be hidden
alongside the broadcast box, which meant the game that most needed a scheduled
restart was the one game that could not schedule one.

The better button here is **Restart when empty**: it watches the Steam query
player count and restarts at the first moment nobody is on, giving up after the
deadline in the minutes box rather than restarting on top of players. On a
server with no way to warn anyone, a fixed countdown is only a promise to kill
whoever is still playing in fifteen minutes. It needs a readable player count,
which is exactly what the query port buys — one more reason it must not lose the
race for its port.

Where the console and broadcast controls would have been, the card prints the
profile's `noRemoteNote` instead of leaving a gap, because a card missing half of
another card's controls reads as broken rather than as a different game.

### Mods

Icarus mods come from mod.io as loose Unreal `.pak` files, not from the Steam
Workshop, so there is no subscription to compare against and no "an update is
waiting" to compute — the Mods panel lists what is on disk with its size and
when it was written. The profile looks in `Icarus\Mods`,
`Icarus\Content\Paks\~mods` and `Icarus\Content\Paks\mods`, first one that
exists winning; if none exists the panel says so and names the first, which is
where they would go. `.utoc`/`.ucas`/`.sig` siblings of a `.pak` are folded into
one entry, since a mod shipped that way is three files that are one mod.

Override the folder per target if your install differs:

```json
"mods": { "dir": "C:\GameServers\IcarusServer\Icarus\Mods", "kind": "paks" }
```

A mod built against an older build can stop the server loading a prospect at
all, and there is no `validate` to undo it — so if a game update breaks the
server, this panel is where you find out what is in there.

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

  // Optional, and independent of transport: read the player count from the
  // server's Steam query port (A2S), which needs no password and works even for
  // transport 'none'. The target needs a queryPort — put one in defaults.
  // `names: false` skips the A2S_PLAYER round trip for games that answer it with
  // blank names; the count still comes from A2S_INFO. See icarus.js.
  query: { protocol: 'a2s', names: true },

  // Filled in when config.json omits them.
  defaults: { gamePort: 27015, rconPort: 27015, queryPort: 27015 },

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

  // Optional: where this game keeps its mods, for the card's Mods panel. Read
  // only — nothing here installs, enables or removes anything.
  //
  // 'paks'      loose Unreal packages. `candidates` are paths relative to the
  //             target's steamInstallDir; the first that exists wins, and if
  //             none exists the first is reported as where they would go.
  // 'workshop'  one folder per mod, each with an InstallManifest.json, as a
  //             Steam Workshop mod manager writes them. The folder itself comes
  //             from the target's workshopMods.modsDir; `enabledFrom` (also
  //             relative to steamInstallDir) is the game's own list of which
  //             mods it will actually load, so the panel can tell an installed
  //             mod from a loaded one. See palworld.js.
  //
  // A target can override all of this with its own `mods: { dir, kind }`.
  mods: {
    kind: 'paks',
    candidates: ['MyGame/Mods'],
    note: 'Anything the panel should say about where these come from.',
  },

  // Optional, and only meaningful for transport 'none': shown on the card where
  // the console and broadcast controls would have been. A card that is simply
  // missing half of another card's controls reads as broken; one line naming the
  // reason reads as a different game. See icarus.js.
  noRemoteNote: 'This game has no remote interface, so ...',

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
