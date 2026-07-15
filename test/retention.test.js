// Retention pruning (server/retention.js): old event rows go, recent stay, and
// the stuck-job sweep flags claimed-but-never-finished scheduled jobs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const retention = require('../server/retention');

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 24 * 3600e3).toISOString();

test('prune() removes rows past each table retention window and keeps the rest', () => {
  const sql = h.db.db;
  // Minimal shapes of the real tables (created by their owning modules in prod).
  sql.exec(`
    CREATE TABLE IF NOT EXISTS ai_usage (id TEXT, entity_id TEXT, kind TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, ts TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS action_opens (action_id TEXT, email TEXT, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS action_clicks (action_id TEXT, email TEXT, at TEXT NOT NULL);
  `);
  sql.prepare('INSERT INTO ai_usage (id, entity_id, kind, created_at) VALUES (?,?,?,?)').run('old', 'e', 'k', iso(430)); // ~14 months
  sql.prepare('INSERT INTO ai_usage (id, entity_id, kind, created_at) VALUES (?,?,?,?)').run('new', 'e', 'k', iso(300)); // ~10 months
  sql.prepare('INSERT INTO usage_events (kind, ts) VALUES (?,?)').run('guide', iso(430));
  sql.prepare('INSERT INTO usage_events (kind, ts) VALUES (?,?)').run('guide', iso(10));
  sql.prepare('INSERT INTO action_opens (action_id, email, at) VALUES (?,?,?)').run('a1', 'x@x.com', iso(400)); // ~13 months
  sql.prepare('INSERT INTO action_opens (action_id, email, at) VALUES (?,?,?)').run('a1', 'x@x.com', iso(30));
  sql.prepare('INSERT INTO action_clicks (action_id, email, at) VALUES (?,?,?)').run('a1', 'x@x.com', iso(400));

  const { prune } = retention.mount({ db: h.db });
  prune();

  assert.deepEqual(h.db.db.prepare('SELECT id FROM ai_usage ORDER BY id').all().map((r) => r.id), ['new']);
  assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM usage_events').get().n, 1);
  assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM action_opens').get().n, 1);
  assert.equal(h.db.db.prepare('SELECT COUNT(*) n FROM action_clicks').get().n, 0);
});

test('sweepStuckJobs() pages ops for a claimed-but-unfinished scheduled job', () => {
  const sql = h.db.db;
  sql.exec(`CREATE TABLE IF NOT EXISTS scheduled_jobs (id TEXT PRIMARY KEY, name TEXT DEFAULT '', status TEXT DEFAULT 'active', last_status TEXT DEFAULT '', last_run_at TEXT DEFAULT '')`);
  sql.prepare('INSERT OR REPLACE INTO scheduled_jobs (id, name, last_status) VALUES (?,?,?)').run('j1', 'Morning digest', `started: ${iso(1)}`); // stuck since yesterday
  sql.prepare('INSERT OR REPLACE INTO scheduled_jobs (id, name, last_status) VALUES (?,?,?)').run('j2', 'Fresh run', `started: ${new Date().toISOString()}`); // just claimed — in flight, not stuck
  sql.prepare('INSERT OR REPLACE INTO scheduled_jobs (id, name, last_status) VALUES (?,?,?)').run('j3', 'Fine', 'ok: sent');

  const alerts = [];
  const { sweepStuckJobs } = retention.mount({ db: h.db, notifyOps: (m) => alerts.push(m) });
  sweepStuckJobs();

  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /Morning digest/);
  assert.doesNotMatch(alerts[0], /Fresh run/);
});
