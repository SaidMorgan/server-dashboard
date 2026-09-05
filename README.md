# Server Dashboard

A single-page control panel for the game servers and Windows services running on
one machine. Start, stop and restart them, see who's playing before you reboot on
top of someone, schedule nightly restarts, take world backups, keep them patched,
and get told when something crashes.

It runs on **Windows**, needs **Node 20+**, and has **one dependency** (Express).

![The dashboard](docs/images/dashboard.png)

**Supported out of the box:** ARK: Survival Ascended, Palworld, Minecraft (Java
and Bedrock), 7 Days to Die, any Source-engine game, Valheim, plus any Windows
service and any process at all. [Adding your own game](docs/games.md) is one small file.

---

## Install

```bash
git clone https://github.com/YOUR-USERNAME/server-dashboard.git
cd server-dashboard
npm install
```

Then create your config:

```bash
copy config.example.json config.json
copy .env.example .env
```

Edit `config.json` for your servers and put the passwords in `.env`. Start it:

```bash
node server.js
```

Open <http://localhost:8770>.

`config.json` and `.env` are gitignored, so your passwords never end up in a
commit even if you fork this and push it back.

### Where the game servers live

**`C:\GameServers\` — not `C:\Apps\`.** Each server gets its own folder there
(`Bedrock\`, `PalServer\`, `IcarusServer\`, `JavaMC\`), and that is what the
`startCommand`, `logFile` and `backup.paths` on every target point at.

`C:\Apps\` is for repos — this dashboard, ClearLedger — plus the third-party
tooling they drive (`steamcmd\`, `nssm\`, `jdk25\`). Nothing in `C:\Apps\`
holds a world or a save.

The split matters because the two trees have opposite backup and update rules:
`C:\Apps\` is disposable and re-clonable, while `C:\GameServers\` holds the
only copy of everything players have built. Putting a server under `C:\Apps\`
makes it look re-clonable when it is not.

---

## Configuration

`config.json` is the whole configuration. Every string in it can reference an
environment variable with `${NAME}`, resolved from `.env` or the real
environment — which is how secrets stay out of the file:

```json
"rconPassword": "${ARK_RCON_PASSWORD}"
```

Use `${NAME:-fallback}` if you want a default. A `${NAME}` with no value and no
fallback is a startup error that names the exact setting, rather than a server
that quietly can't authenticate.

### Top level

| Key | Default | What it does |
|---|---|---|
| `port` | `8770` | Port to listen on |
| `bind` | `127.0.0.1` | Which interface to listen on. See [Access](#access) |
| `pollSeconds` | `10` | How often to check every target |
| `historyHours` | `48` | How much history to keep for the live 3h chart. The busy-times charts keep their own long-term rollup and ignore this |
| `dataDir` | `data` | Where history, utilisation, alerts and schedules are stored |
| `backupRoot` | `backups` | Where world archives go |
| `auth.password` | *(none)* | Required to bind anywhere but localhost |
| `auth.sessionDays` | `30` | How long a login lasts |
| `notifications` | off | Discord and webhook alerts — see below |
| `notifications.dedupeSeconds` | `60` | An identical message is sent at most once per this window |
| `notifications.maxPerMinute` | `10` | Hard ceiling on outbound messages, so a flapping server can't flood a channel |
| `backups.flushSeconds` | `4` | Time a save is given to reach disk before the copy starts |
| `backups.stageTimeoutMinutes` | `10` | Ceiling on the staging copy |
| `backups.zipTimeoutMinutes` | `20` | Ceiling on compressing, and on extracting during a restore |
| `alerts.keep` | `200` | Alerts kept in the activity feed and `data/alerts.json` |
| `restart.graceSeconds` | `90` | Extra time after a shutdown countdown before the process is force-killed |
| `minecraft.checkMinutes` | `360` | How often to check for a new Minecraft version |
| `minecraft.downloadTimeoutMinutes` | `30` | Ceiling on fetching a release |
| `minecraft.extractTimeoutMinutes` | `15` | Ceiling on unpacking a Bedrock zip |
| `minecraft.keepDownloads` | `false` | Keep the download instead of deleting it once installed |
| `targets` | — | The servers to manage |

**config.json takes comments.** `//` and `/* */` are stripped before parsing, so
every option can be annotated in place — see `config.example.json`, which is
commented throughout. Anything tunable lives in the config; the constants left
in `src/` are protocol details (RCON frame bounds, alert-dedupe map size) that
have no reason to differ between installs.

### A game target

```jsonc
{
  "id": "ark-island",            // unique, used in URLs
  "name": "ARK: The Island",     // shown on the card
  "kind": "game",
  "game": "ark",                 // which profile — see docs/games.md
  "host": "127.0.0.1",
  "gamePort": 7777,
  "rconPort": 27020,
  "rconPassword": "${ARK_RCON_PASSWORD}",
  "maxPlayers": 10,
  "processName": "ArkAscendedServer",   // no .exe
  "startCommand": "C:\\path\\to\\Start Island.bat",
  "logFile": "C:\\path\\to\\ShooterGame.log"
}
```

Most ports have sensible per-game defaults, so you can usually omit them. Omit
`startCommand` and the Start button disappears rather than failing.

`serverDir` is optional and only read by the bans panel, which needs the folder
holding `banned-players.json`. It is derived from `logFile` — a log inside a
`logs\` subfolder means the server root is its parent — so set it only when your
layout puts the two somewhere that guess doesn't reach.

> Windows paths in JSON need doubled backslashes (`C:\\Servers\\...`). Forward
> slashes (`C:/Servers/...`) also work.

### Steam updates

Game targets installed through Steam get a **Check for update** button and a
six-hourly background check. The dashboard reads the installed build id out of
Steam's own `appmanifest_<appid>.acf` and compares it with the build Steam is
publishing for that app.

Without a SteamCMD to drive, the dashboard never downloads anything and the
update is half automatic:

1. You press **Check for update** (or the background check tells you there's a
   new build). If you're already current, it says so and nothing else happens.
2. If there is one, the server is warned, saved, backed up if `beforeRestart` is
   set, and **stopped** — Steam cannot patch files a running server holds open.
3. You install the update in the Steam client.
4. The dashboard is watching the manifest. When the build id changes and there
   are no bytes left to download, it starts the server again on its own.

While it waits, the card shows a banner with the download progress Steam is
writing to disk, crash alerts and the watchdog are held off, and Start is
disabled — the banner's own button is how you bail out and start the server on
the build it already has. If nothing is installed within `steam.waitMinutes`
(default 60) it does that for you rather than leaving the server down overnight.
A wait survives a dashboard restart.

#### Fully automatic updates

Give the dashboard a `steamcmd.exe` and set `autoUpdate` on a target, and steps
3 and 4 stop being your problem — it stops the server, runs the install itself,
and starts the server back up on the new build:

```jsonc
"steam": {
  "steamcmd": "C:\\Apps\\steamcmd\\steamcmd.exe",
  "updateTimeoutMinutes": 60      // a cold 9 GB install is not a 5-minute job
}
```

```jsonc
"autoUpdate": true,
// Only needed for a +force_install_dir install, where the files sit in the
// folder itself instead of under steamapps\common. Otherwise it is worked out
// from the manifest.
"steamInstallDir": "C:\\GameServers\\IcarusServer"
```

**A Steam-client install does not need moving to SteamCMD for this.** SteamCMD
updates an existing library folder in place — point `+force_install_dir` at the
folder the client already installed to, which is what the dashboard does. And
`app_update` only replaces game files, so saves and configs living under the
install (Palworld's `Pal\Saved`, ARK's `ShooterGame\Saved`) are untouched. The
one cost is that both programs then keep their own record of what is installed,
so the Steam client may offer to verify the app afterwards; letting it is
harmless.

The background sweep **only updates a server nobody is standing in.** A
populated one is left alone and picked up by a later sweep, because stopping a
game with no remote interface is a kill and nobody in it gets a warning. Only a
confirmed zero counts — an unknown player list is not an empty one.

Success is judged by the build id in the manifest afterwards, never by
SteamCMD's exit code: it exits 7 on the self-relaunch it does after updating
itself, with the app update having succeeded. If the install genuinely fails,
the target falls back to the manual wait above rather than staying down.


Most games fill in their app id from their profile (ARK, Palworld, 7 Days to
Die, Valheim). For anything else, give the target the app id of the **dedicated
server**, not the game:

```jsonc
"steamAppId": 2394010,
"steamLibrary": "D:\\SteamLibrary\\steamapps"   // only if it isn't auto-found
```

Other libraries are discovered from `libraryfolders.vdf`, so a server moved to
another drive still resolves. If no manifest is found the button is hidden
rather than shown broken. Everything this feature raises is tagged with the
`update` alert category, so one entry in a channel's `mute` list keeps it out of
chat while the activity feed still shows all of it.

### Minecraft updates

Minecraft is not on Steam, so `bedrock` and `minecraft` targets get the same
**Check for update** button wired to a different mechanism — one that does the
whole job rather than handing you over to another program. Nothing else owns a
Minecraft install, so there is no second downloader to coordinate with, and the
dashboard can simply do it:

1. It asks the publisher what the current version is and compares it with what
   is on disk. If you're already current, it says so and nothing else happens.
2. If there is a newer one, the release is downloaded **while the server is
   still running**, with a progress bar on the card, and checked against the
   publisher's own checksum where there is one (Mojang signs its jars with
   SHA-1, PaperMC with SHA-256). A file that doesn't match is not installed —
   and because nothing has been touched yet, a failed download costs no
   downtime at all.
3. Only then is the server warned, saved, backed up if `beforeRestart` is set,
   and **stopped** — Windows will not let anything replace a binary that a
   running process holds open.
4. The release is unpacked over the install and the server starts again. The
   download is deleted last, once the server is back up.

There is nothing to press in between, and no configuration needed to get there:
the install folder is taken from `startCommand`, and the installed version is
read from the server itself.

**Bedrock** is a ~95 MB zip from minecraft.net that unpacks to about ten
thousand files. It is extracted entry by entry rather than wholesale, so that
four names the zip ships stock copies of can be stepped over:

| Never overwritten | Why |
|---|---|
| `server.properties` | your settings — ports, difficulty, `allow-list` |
| `allowlist.json`, `whitelist.json` | who may join. The shipped copy is empty |
| `permissions.json` | who is an operator |
| `worlds\` | the world |
| `development_*_packs\` | packs you are working on |

Nothing is ever **deleted**, either — an update only writes the names the zip
contains — so add-on packs, scripts and anything else of your own survive it.
`minecraftUpdate.keep` adds to the list above; end an entry with `/` to protect
a whole folder. The vanilla `behavior_packs\` and `resource_packs\` are
deliberately *not* protected: they hold the content for that exact server
version, and holding them back while the binary moves forward is its own bug.

**Java** is one file, which makes it simpler still: the server jar is replaced
and nothing else is touched — your world, `server.properties` and `plugins\`
were never part of the download. The jar that was replaced is kept under
`data\mc-updates\<id>\`, so there is always a way back.

```jsonc
"minecraftUpdate": {
  "flavor": "paper",   // "vanilla" (Mojang's jar) or "paper" (PaperMC builds)
  "track": "same",     // "same", "latest", or a version to pin to
  "auto": false
}
```

`track` is the setting worth thinking about. **`same`** holds the Minecraft
version you are on and takes newer builds of it; **`latest`** follows Minecraft
releases. It defaults to `same` for Paper and `latest` for vanilla, because
every plugin on a Paper server is built against one Minecraft version, and
carrying them across a version bump unattended is how a server comes back up
with half of them refusing to load. Vanilla has no plugins to break.

Everything else is optional: `installDir` if the server isn't in the folder its
start script lives in, `jar` if it isn't `server.jar`, and `preview` on Bedrock
to follow the preview channel instead.

#### Automatic updates

`"auto": true` on a target installs a new version as soon as one appears **and
the server is empty**. A populated one is left alone and picked up by a later
sweep; only a confirmed zero counts, an unreadable player count is not an empty
server. Off by default, and the six-hourly background check still raises an
alert either way, so the update stays a decision rather than a surprise. It is a
much safer proposition on Bedrock — which has no plugins to break — than on a
modded Java server.

The installed version is worked out from, in order: a marker the dashboard
writes after each update, the version inside the jar (Java), and the version the
server logs at startup. The marker is checked against the file it describes and
thrown away if that file has changed underneath it, so a hand-installed update
is noticed rather than papered over. If the version genuinely can't be read the
card says so instead of guessing — and `auto` never fires on a comparison it
couldn't make. Running one update from the dashboard settles it from then on.

Like the Steam checks, everything here is tagged with the `update` alert
category.

### Mods

Every game card with a mods folder gets a **Mods** panel listing what is
installed — name, version, author, size on disk, when it was installed, and its
dependencies. Two layouts are read:

- **Steam Workshop**, as a mod manager installs it: one folder per mod, each
  with an `InstallManifest.json`. Add a `workshopMods` block to the target (see
  below) and each mod is also compared against what the Steam client has
  downloaded, so an update waiting to be applied is flagged.
- **Loose Unreal packages** (`.pak`, and its `.utoc`/`.ucas`/`.sig` siblings) for
  games that simply load mods from a folder — Icarus, whose mods come from
  mod.io. There is no subscription to compare against, so the panel reports what
  is on disk rather than inventing an update state.

Most games find their own mods folder from their profile. Point a target at a
different one with:

```jsonc
"mods": {
  "dir": "C:\\GameServers\\IcarusServer\\Icarus\\Mods",
  "kind": "paks"        // or "workshop" for manifested one-folder-per-mod
}
```

Three flags mark a mod that needs a decision: **update waiting** (Steam has a
newer copy), **not subscribed** (installed here but with no source left, so it
will never update again), and **not loaded** (installed, but missing from the
game's own active mod list — the server is ignoring it). That last one is the
most common "why isn't my mod working", and it is invisible from the folder
alone.

**Refresh from Steam** acts on the first of those, for a `workshopMods` target
with a `steamInstallDir`: it stops the server, copies the newer files the Steam
client has already downloaded over the ones the mod manager installed, and
starts it again. It runs only on a confirmed-empty server (an unknown player
count is not an empty one), and the confirmation lists per mod what it will
copy, what already matches, and what it is leaving alone.

Its limits are the point, and they are what make it safe to press: only files
the mod already installed are replaced, a destination edited since the install
is never overwritten — UE4SS's hand-edited `mods.txt` is the reason — and every
replaced file is kept under `data\mod-backups`. Deciding what a mod installs
stays with the mod manager: installing, enabling and removing mods are still
its job, because a mod is built against one game build, can take the server down
on the first player join, and has no `validate` to undo it. See
[docs/games.md](docs/games.md) for the Palworld and Icarus specifics.

### Watchdog — restart it when it crashes

```jsonc
"watchdog": {
  "enabled": true,
  "restartAfterSeconds": 60,   // grace period before acting
  "maxRestartsPerHour": 3      // then give up and say so
}
```

It waits out `restartAfterSeconds` so it doesn't fight you when you're
restarting something by hand, and it never triggers during a restart the
dashboard itself started. The hourly cap matters: a server that crashes *on
startup* would otherwise be restarted forever. When the cap is hit you get an
error alert telling you to fix the server instead.

### Backups

```jsonc
"backup": {
  "enabled": true,
  "paths": ["C:\\path\\to\\SavedArks"],
  "keep": 10,               // retention; oldest are pruned
  "beforeRestart": true     // archive on every restart, while it's stopped
}
```

The server is asked to save, given a moment to flush, and the files are then
staged with `robocopy` before being zipped — so a running server holding its
world open doesn't break the archive.

Hot backups of a *running* server use robocopy's backup mode, which needs the
Backup and Restore Files privilege. Run the dashboard elevated or as a service
and you have it; run it as a plain user and it falls back to a normal copy,
warns you once, and may skip files the server has open. `beforeRestart` backups
happen while the server is stopped, so they're always complete.

Restore is in the UI. It refuses unless the server is stopped and archives the
current world first, so a restore of the wrong file is recoverable.

### Bans and moderation

Minecraft (Java) cards get a **Bans & moderation** panel: who is banned right
now, and every kick, ban and pardon from the last seven days. No configuration —
the panel appears when the game profile keeps bans in a format the dashboard
understands and the server folder can be found next to the configured `logFile`.
Set `serverDir` on the target if your layout puts them apart.

The two halves work differently on purpose:

- **Reading** comes off `banned-players.json`, which records who, when, by what
  and why — where RCON `banlist` is one line of prose that drops the source and
  the expiry. It also still answers when the server is down, which is exactly
  when you want to know why somebody can't get in.
- **Writing** always goes over RCON, never by editing that file. A running
  server holds the ban list in memory and rewrites it on the next change, so a
  hand-edited file is silently undone.

The event feed is stitched from three sources, because no one of them is
complete. Plugin and in-game actions are parsed out of the server log — the only
record a *kick* leaves anywhere. Bans issued from this dashboard are recorded by
the dashboard itself, because a command sent over RCON leaves no trace in the
log at all. Repeated events, like a banned player retrying the connect button
four times, collapse into one row with a count.

Chat is discarded before any of that is parsed. A player can type "Was Banned
For Spamming" in chat — one on this author's server did, moments after being
unbanned — and it must not become an entry.

Pardon is one click; it's the safe direction, and a mistake is undone by banning
again. Ban asks first.

### Player reports (Minecraft Java)

Two commands the dashboard answers itself rather than forwarding to the server,
because no plugin in the game can see all the places the answer lives:

```
prism players            everyone who has ever played
prism stats <player>     one of them in full
```

`prism players` is the roster: name, balance, blocks broken and last seen, most
recent first. It is the union of everyone Prism has
recorded touching a block and everyone TheNewEconomy holds an account for —
neither list is a superset of the other. The console completes `prism stats`
from it, so looking up the child who logged off an hour ago takes no typing.

`prism stats <player>` joins four stores into one report: blocks broken and
placed with an hourly rate (Prism), balance and where the money came from
(TheNewEconomy), what they have bought and sold (UltimateShop), and whether the
account came in through Floodgate.

The last section is the reason it exists. Money and shop volume alone cannot
tell grinding from duplicating — both look like "sold twenty thousand logs".
Prism can: a duplicated item has no block-break behind it and a mined one has
exactly one, so the report puts *sold* and *mined* in adjacent columns and flags
the rows where selling has outrun any source for it. A flag is a prompt to run
`prism lookup`, not a verdict — Fortune, gifts and event prizes are all real.

Everything is read-only, opens the live databases read-only, and needs nothing
installed: it is skipped silently on a server that has none of those plugins.
Both names are the dashboard's own — Prism 4 has no `stats` or `players`
subcommand of its own, and everything else you type after `prism` goes straight
through to the plugin.

### Schedules

```jsonc
"schedules": [
  { "cron": "0 5 * * *", "action": "restart", "warnMinutes": 15, "reason": "nightly restart" },
  { "cron": "0 */6 * * *", "action": "backup" }
]
```

Standard 5-field cron (`minute hour day month weekday`) on this machine's local
clock. Actions: `restart`, `start`, `stop`, `save`, `backup`, `broadcast`.
`warnMinutes` broadcasts a countdown to players at 15/10/5/1 minutes first, and
it's cancellable from the UI.

You can also add schedules in the browser — those are stored separately and can
be edited or deleted there. Ones declared in `config.json` show as read-only,
since the file is their source of truth.

If the dashboard is down when a job was due, it does **not** fire late on
startup. Waking up to a queue of missed 3am restarts is worse than missing them.

### Notifications

```jsonc
"notifications": {
  "windowsToast": true,
  "discord": {
    "enabled": true,
    "url": "${DISCORD_WEBHOOK_URL}",
    "events": ["error", "warn"],
    "mute": ["backup", "restart", "update"],  // categories this channel skips
    "always": ["recovery"]          // categories it takes at any level
  }
}
```

`webhook` takes the same shape and POSTs plain JSON to any URL. Identical
messages are suppressed for a minute and there's a hard ceiling of 10 per
minute, so a flapping server can't flood your channel.

`events` picks the levels a channel wants. `mute` and `always` then adjust that
by category — how loud an alert is and what kind of thing it is are different
questions, and a channel usually wants to filter on both. The four categories:

| Category | Covers | Default |
| --- | --- | --- |
| `backup` | Archive successes and failures | muted |
| `restart` | Planned stop/start chatter, scheduled or clicked | muted |
| `update` | Steam build checks and everything the Update button does | muted |
| `recovery` | A target back up after an unplanned outage | always |

`mute` drops a category however loud it is, which is what keeps a nightly reset
that went to plan off your channel — the countdown's closing warn is still a
`warn`, it just isn't news. `always` does the reverse, sending a category that
sits below the level threshold: "Back online" is only an `info`, but it's the
all-clear to a crash you were paged about, so it goes out. It's only ever
reached after an unplanned outage — a managed restart is suppressed and never
raises it.

A restart that fails is deliberately none of those categories, so it reaches
every channel whatever they mute: a scheduled job that reports failure, and a
restart that stopped a server and could not start it again, both raise a plain
`error`. The quiet nightly restart you want to ignore and the one that left a
server down at 3am should not look the same.

The defaults above leave a channel that carries real problems and nothing else:
crashes, failed schedules, RCON dropping out, a failing health check, and the
recovery that closes them out. The activity feed and the alerts API always keep
every alert regardless — these lists only decide what leaves the machine.
Restores stay un-muted; they overwrite a live world and are worth an
interruption.

### A Windows service target

```jsonc
{
  "id": "my-api",
  "name": "My API",
  "kind": "service",
  "serviceName": "MyApiService",
  "healthUrl": "http://127.0.0.1:3001/health",
  "nssm": "C:\\Apps\\nssm\\nssm.exe",   // optional, preferred for restarts
  "logDir": "C:\\Apps\\MyApi\\logs",    // newest file is tailed
  "readyAfterSeconds": 150              // how long it takes to answer healthUrl
}
```

`readyAfterSeconds` matters more than it looks. A service counts as up only once
its health check passes, so a restart of something that takes a minute to warm
up finishes *after* the default blackout ends — and the dashboard then reports
the tail of its own restart as an unplanned outage that recovered, every night
at the same minute. Set this to comfortably more than the warm-up and that stops.

#### Update & restart

**Restart now** stops the service and starts it again on the code that is
already on disk. Nothing is fetched, nothing is built — it is the button for a
process that has wedged.

Give a service a `preRestartCommand` and it gets a second button, **Update &
restart**, which stops the service, runs that command, then starts it:

```jsonc
{
  "id": "my-api",
  "name": "My API",
  "kind": "service",
  "serviceName": "MyApiService",

  "preRestartCommand": [           // one string, or a list run in order
    "git pull --ff-only",
    "npm ci --omit=dev"
  ],
  "preRestartDir": "C:\\Apps\\MyApi",  // where to run it; defaults to the dashboard folder
  "preRestartTimeoutMinutes": 5        // per command, default 5
}
```

The order matters: the service is stopped *before* the update runs, because
Windows will not let `git` replace a file the running process still holds open.

Each command is a separate PowerShell run and the first non-zero exit code stops
the list — Windows PowerShell has no `&&`, so a `;`-chained pull that failed
would otherwise be followed by a build of the old tree. If the update fails, the
service is started again on the previous version rather than left down, and the
alert says so. The full transcript — everything the commands printed, stdout and
stderr both — appears under the buttons.

This runs whatever you put in it, as whatever account the dashboard runs under.
It is the same trust level as `startCommand`, and one more reason the dashboard
refuses to listen off-localhost without a password.

---

## Access

**By default the dashboard listens on `127.0.0.1` and asks for no password.**
It's your machine; there's nobody to authenticate against.

**The moment you change `bind`, a password becomes mandatory.** Set
`bind: "0.0.0.0"` without `auth.password` and the dashboard refuses to start and
tells you why.

That's deliberate and not negotiable in config, because of what this thing is: a
web page that can stop, start and send arbitrary RCON commands to your servers.
Installed as a service it does that as `LocalSystem`. Unauthenticated on a LAN,
it's a remote-control handle for anyone on the network — including a guest phone
or a compromised smart TV.

To reach it from your phone:

```jsonc
"bind": "0.0.0.0",
"auth": { "password": "${DASHBOARD_PASSWORD}" }
```

and put `DASHBOARD_PASSWORD=something-long` in `.env`.

![The login page](docs/images/login.png)

Even then, prefer a private network (Tailscale, WireGuard, a VPN) over
port-forwarding. The password is a solid second line of defence, not a licence to
put this on the public internet. If you do expose it, put it behind a reverse
proxy with TLS — the session cookie is marked `Secure` automatically when it sees
HTTPS.

Passwords are stored hashed with scrypt, sessions are HMAC-signed cookies, and
logins are rate-limited to 5 attempts per 15 minutes per IP.

---

## Running it in the background

Double-clicking `Start Dashboard.bat` works, but the window has to stay open.

To install as a Windows service, get [NSSM](https://nssm.cc/) and run
`Install Service.bat`. It starts at boot with no window and no UAC prompt.

Running as `LocalSystem` is what makes Start/Stop/Restart work on servers that
run elevated, and gives backups the privilege they want. One consequence: game
servers started *from the dashboard* run in session 0 and won't appear on your
desktop. They're headless anyway.

Without admin rights everything still **monitors** correctly — players, health,
charts, alerts — but the control buttons fail with "Access denied".

```bash
sc query ServerDashboard
```

`Uninstall Service.bat` removes it.

---

## What each card shows

| | |
|---|---|
| Status dot | green = healthy, amber = running but RCON/query/health failing, red = down |
| Stats | uptime, CPU, RAM, RCON or Steam-query state, port |
| Players | live names, a count for games that only answer Steam queries (Icarus), or "nobody online — safe to restart" |
| Controls | Start / Restart / Stop / Save world |
| Warn & restart | broadcasts at 15/10/5/1 min, then restarts. Cancellable |
| Restart when empty | waits for the last player to leave, then restarts; gives up rather than restarting on top of players |
| Broadcast | send a message to everyone in-game |
| Console | raw RCON command box, with a menu of the commands this game knows and word-by-word suggestions as you type (pick `gamerule`, get the rules; pick a rule, get its values). Replies are shown in colour, and the pane grows to about double height for a long one |
| Utilisation | **Busy times** — how many players are usually on at each hour of today's weekday, with today drawn over it, so four players reads as busy on a Wednesday and quiet on a Saturday. **Week** — the same comparison in player-hours per day. **Heatmap** — the whole week as a 7×24 punch card. **Players** — unique players, newcomers vs regulars, typical session length, how many came back, all-time peak, and who played most this week. **Last 3h** — the live trace of player count, red bands for downtime |
| Mods | what is installed: version, author, size, and a flag when one needs a decision |
| Schedules | recurring jobs for this server |
| Backups | run, download, restore |
| Bans & moderation | who is banned, with one-click pardon; recent kicks, bans and pardons (Minecraft Java) |
| Log tail | last 200 lines, with the server's own colours rendered rather than shown as escape codes |

**Why the utilisation charts compare rather than just plot.** A player count on
its own is not a fact anybody can act on: three players is a busy Tuesday
morning and a dead Saturday night, and a three-hour line cannot tell a failing
server from a normal weekday lunchtime, because both are flat. So every bar is
drawn against a pale one behind it showing what a normal week looks like at that
moment. The baseline is built from completed weeks only — never the week in
progress, or this morning would be part of the average this morning is being
compared against, and the chart could never say anything but "normal".

**Why there is a Players panel at all.** Two servers averaging one player look
identical on every chart above and are not remotely the same server: one has a
single person on for six hours, the other has fifteen people dropping in for
twenty minutes. Player counts cannot tell those apart, and the difference is
most of what "how much is this being used" means. So the same store also tracks
sessions — unique players over 7 and 30 days, newcomers against regulars, how
long a typical session runs, how long a *first* session runs, and how many of
the people who first appeared a few weeks ago came back. These are the metrics
[Plan](https://www.playeranalytics.net/) and
[BattleMetrics](https://www.battlemetrics.com/) both converge on, for the same
reason.

Sessions are accumulated tick by tick rather than measured as `left - joined`,
which are the same number right up until the dashboard restarts mid-session and
the subtraction credits somebody with eight hours they were not there for. A
connection under a minute is a bounce, not a visit, and is not counted. A
retention figure is withheld below four people, where it can only ever say 0%,
50% or 100%. A game that reports how many are online but never who — Icarus
answers the player query with a blank name in every slot — gets no Players tab
rather than an empty one that looks broken. The roll is capped at the 100
players with the most time on the server, so the file cannot grow with the
playerbase; a household will never come near it.

That history lives in `data/usage.json`, not in the `historyHours` window: it is
a few running totals per (weekday, hour), a few tens of kilobytes that never
grow, which is what makes keeping it indefinitely reasonable where keeping the
ten-second samples is not. It takes a day to draw a first chart and a few weeks
to mean much; until then the card says so instead of presenting one Tuesday as
the truth about Tuesdays.

Controls that a game can't support are hidden rather than shown and failing — a
Valheim card has no broadcast box, because Valheim has no way to send one. A game
with no remote interface at all says which one it is and why, in the space those
controls would have taken, rather than leaving a gap.

**Warn & restart vs Restart when empty.** The first is a promise to restart at a
fixed time and warn people on the way; the second is a promise not to interrupt
anyone. Prefer the second for housekeeping, and for any game that cannot
broadcast — there, a countdown is only a warning nobody receives.

Stop and Restart confirm first and warn if players are online. Both save the
world first and only force-kill if the server ignores the request.

The **⧉** button pops a card into its own window.

Updates arrive over a live event stream — the badge in the top bar reads `LIVE`.
If something between you and the dashboard breaks long-lived connections, it
falls back to polling on its own and the badge reads `POLLING`. Add `?live=0` to
the URL to force polling permanently.

---

## Docs

- [docs/games.md](docs/games.md) — supported games, per-game setup, and how to
  add your own
- [CONTRIBUTING.md](CONTRIBUTING.md)

## License

MIT — see [LICENSE](LICENSE).
