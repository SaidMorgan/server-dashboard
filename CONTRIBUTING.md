# Contributing

## Running it

```bash
npm install
copy config.example.json config.json
copy .env.example .env
node server.js
```

You don't need a real game server to work on most of this. Set
`"game": "process"` with any `processName` (`notepad` works) and you get a fully
functional card.

To avoid clobbering a real install's data while testing, point `SD_CONFIG` at a
throwaway config with its own `dataDir`:

```bash
SD_CONFIG=/tmp/test.json node server.js
```

## Adding a game

Almost always this is one file in `src/games/` and no other changes. See
[docs/games.md](docs/games.md#adding-your-own-game).

Please include a `setupNotes` string saying what the user has to enable
server-side — it's the part people get stuck on.

## Layout

```
server.js          Express API, SSE stream, static host
src/config.js      loading, ${ENV} interpolation, validation
src/auth.js        password hashing, sessions, the bind-safety gate
src/games/         one file per game
src/rcon.js        Source RCON protocol client (knows no game names)
src/palworld-rest.js
src/win.js         process stats, services, launching, PowerShell helper
src/monitor.js     poll loop, history, alert transitions, watchdog
src/actions.js     start/stop/restart, countdown restarts, broadcasts
src/backup.js      staging, archiving, retention, restore
src/scheduler.js   cron parsing and job running
src/notify.js      Discord and webhook delivery
public/            the UI (no build step, no framework)
```

## House rules

- **No dependencies** unless there's no reasonable alternative. Express is the
  only one. Cron parsing, password hashing, sessions, `.env` parsing and zipping
  are all done with the standard library or built-in Windows tools, and that's
  worth keeping.
- **No build step.** `public/` is plain HTML, CSS and JS served as-is.
- **Comments explain *why*.** The codebase is full of hard-won notes about why
  ARK needs one socket and Palworld needs the opposite. If you find a new trap,
  write it down where the next person will hit it.
- **Never widen network exposure by default.** The rule that binding off
  localhost requires a password is the project's main safety property.
- Windows paths reaching a shell go through `winPath()` in `src/win.js`. Both
  `cmd /c start` and `robocopy` fail on forward slashes, and one of them fails
  *silently*.

## Testing

There's no test framework. Before opening a PR, please check:

- It starts against `config.example.json` with the env vars set.
- A deliberately broken config produces readable errors, not a stack trace.
- `bind: "0.0.0.0"` with no password refuses to start.
- If you touched `src/rcon.js` or a profile, that
  `netstat -ano | findstr :<rconPort>` shows no `CLOSE_WAIT` build-up after a
  server restart.

## Reporting bugs

Include your `config.json` **with passwords removed**, the console output, and
which game. If it's a game-specific problem, say which server build.
