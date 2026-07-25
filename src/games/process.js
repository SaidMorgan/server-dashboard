// Generic process-only profile.
//
// For any server the dashboard can't talk to: no RCON, no query, no REST. You
// still get up/down, uptime, CPU, RAM, history, crash alerts, the watchdog,
// backups, scheduled restarts and the log tail — everything except the player
// list and in-game messages.
//
// Set "game": "process" and give it a "processName".

export default {
  id: 'process',
  label: 'Process only (no game API)',
  transport: 'none',
  setupNotes: 'Requires only processName, plus startCommand if you want the Start button.',
};
