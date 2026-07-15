// The downloadable JSON backup (exportAll/importAll) must now round-trip a
// client's alerts + live updates — previously omitted, so a restore silently
// dropped every watcher. These tables are owned by disposable modules that
// create them at mount; here we create minimal versions directly so the export
// path can be exercised without standing up the whole app.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Stand up the alerts + live_pulses tables the way the modules would, minimally.
function ensureWatcherTables() {
  h.db.db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, entity_id TEXT, suite_id TEXT, name TEXT, status TEXT);
    CREATE TABLE IF NOT EXISTS alert_events (id TEXT PRIMARY KEY, alert_id TEXT, at TEXT, status TEXT);
    CREATE TABLE IF NOT EXISTS live_pulses (id TEXT PRIMARY KEY, entity_id TEXT, suite_id TEXT, name TEXT, status TEXT);
    CREATE TABLE IF NOT EXISTS live_pulse_runs (id TEXT PRIMARY KEY, pulse_id TEXT, at TEXT, status TEXT);
  `);
}

test('exportAll captures alerts + live updates', () => {
  ensureWatcherTables();
  h.db.db.prepare('INSERT OR REPLACE INTO alerts (id,entity_id,suite_id,name,status) VALUES (?,?,?,?,?)').run('a1', 'e1', 's1', 'Sell-out watch', 'active');
  h.db.db.prepare('INSERT OR REPLACE INTO live_pulses (id,entity_id,suite_id,name,status) VALUES (?,?,?,?,?)').run('p1', 'e1', 's1', 'Event live update', 'paused');

  const dump = h.db.exportAll();
  assert.ok(dump.alerts.some((a) => a.id === 'a1'), 'alert is in the export');
  assert.ok(dump.live_pulses.some((p) => p.id === 'p1'), 'live update is in the export');
});

test('importAll restores alerts + live updates (round-trip)', () => {
  ensureWatcherTables();
  h.db.db.prepare('INSERT OR REPLACE INTO alerts (id,entity_id,suite_id,name,status) VALUES (?,?,?,?,?)').run('a2', 'e1', 's1', 'Revenue milestone', 'active');
  h.db.db.prepare('INSERT OR REPLACE INTO live_pulses (id,entity_id,suite_id,name,status) VALUES (?,?,?,?,?)').run('p2', 'e1', 's1', 'Gate pace', 'active');
  const dump = h.db.exportAll();

  // Wipe them, then restore from the dump — they must come back.
  h.db.db.prepare('DELETE FROM alerts').run();
  h.db.db.prepare('DELETE FROM live_pulses').run();
  assert.equal(h.db.db.prepare('SELECT COUNT(*) c FROM alerts').get().c, 0);

  h.db.importAll(dump);
  assert.equal(h.db.db.prepare('SELECT name FROM alerts WHERE id=?').get('a2')?.name, 'Revenue milestone', 'alert restored');
  assert.equal(h.db.db.prepare('SELECT name FROM live_pulses WHERE id=?').get('p2')?.name, 'Gate pace', 'live update restored');
});
