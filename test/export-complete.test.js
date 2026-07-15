// Full export/import is complete-by-construction: every table (minus a small
// deliberate exclude set) round-trips, and importing a snapshot faithfully
// replaces the data — including feature tables the old hand-list had missed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('./helpers');
const sql = db.db;

// Create a couple of feature tables the OLD EXPORT_TABLES list did NOT include,
// plus an excluded one, then seed rows.
sql.exec(`
  CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, suite_id TEXT, label TEXT);
  CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, entity_id TEXT, name TEXT);
  CREATE TABLE IF NOT EXISTS segments (id TEXT PRIMARY KEY, entity_id TEXT, name TEXT);
  CREATE TABLE IF NOT EXISTS user_2fa (user_id TEXT PRIMARY KEY, secret_enc TEXT);
`);

test('export includes feature tables (goals/alerts/segments) and excludes 2FA secrets', () => {
  sql.prepare('INSERT INTO goals VALUES (?,?,?)').run('g1', 's1', 'North star');
  sql.prepare('INSERT INTO alerts VALUES (?,?,?)').run('a1', 'e1', 'Sold out');
  sql.prepare('INSERT INTO segments VALUES (?,?,?)').run('seg1', 'e1', 'VIPs');
  sql.prepare('INSERT INTO user_2fa VALUES (?,?)').run('u1', 'gcm1:secret');

  const dump = db.exportAll();
  assert.equal(dump._version, 2);
  assert.ok(Array.isArray(dump.goals) && dump.goals.length === 1, 'goals exported');
  assert.ok(Array.isArray(dump.alerts) && dump.alerts.length === 1, 'alerts exported');
  assert.ok(Array.isArray(dump.segments) && dump.segments.length === 1, 'segments exported');
  assert.equal(dump.user_2fa, undefined, '2FA secrets must NOT be exported');
});

test('import replaces data faithfully across many tables (round-trip)', () => {
  const before = db.exportAll();
  // Mutate everything: change a goal, add an alert, drop a segment.
  sql.prepare('UPDATE goals SET label=? WHERE id=?').run('CHANGED', 'g1');
  sql.prepare('INSERT INTO alerts VALUES (?,?,?)').run('a2', 'e1', 'Extra');
  sql.prepare('DELETE FROM segments').run();

  const counts = db.importAll(before); // restore the snapshot
  assert.ok(counts.goals >= 1 && counts.alerts >= 1 && counts.segments >= 1, 'counts reported for feature tables');

  // State matches the snapshot again.
  assert.equal(sql.prepare("SELECT label FROM goals WHERE id='g1'").get().label, 'North star', 'goal restored');
  assert.equal(sql.prepare('SELECT COUNT(*) c FROM alerts').get().c, 1, 'extra alert removed');
  assert.equal(sql.prepare('SELECT COUNT(*) c FROM segments').get().c, 1, 'deleted segment restored');
  // FK enforcement is back on after the restore.
  assert.equal(sql.pragma('foreign_keys', { simple: true }), 1, 'foreign_keys re-enabled');
});

test('importing a partial/old snapshot only touches tables it contains', () => {
  sql.prepare('INSERT INTO alerts VALUES (?,?,?)').run('keep-me', 'e1', 'Preexisting');
  // A snapshot that mentions only goals — alerts must be left untouched.
  db.importAll({ _version: 2, goals: [{ id: 'g9', suite_id: 's', label: 'only goal' }] });
  assert.ok(sql.prepare("SELECT 1 FROM alerts WHERE id='keep-me'").get(), 'alerts untouched by a goals-only import');
  assert.equal(sql.prepare('SELECT COUNT(*) c FROM goals').get().c, 1, 'goals replaced to the snapshot');
});
