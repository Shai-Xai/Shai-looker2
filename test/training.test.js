// The Training runtime (server/training.js) grades practical exams by grepping
// real system state for evidence. These tests lock the deterministic core:
//   • exam creation + trainee assignment (personal codes, email dedupe),
//   • every task check: no evidence → not done; partial evidence → not done
//     with a coaching message; full evidence → done with a human evidence line,
//   • scoring against task points and the pass mark on submit,
//   • the brief personalization ({CODE} → the attempt's code).
// No Looker, no AI — checks are pure SQL, so the suite is hermetic.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { db, makeEntity } = require('./helpers');
const training = require('../server/training');

const fakeApp = { get: () => {}, post: () => {}, put: () => {}, delete: () => {} };
const fakeAuth = { requireAuth: (_q, _s, n) => n && n(), requireAdmin: (_q, _s, n) => n && n() };

const api = training.mount(fakeApp, { db, auth: fakeAuth });
const sql = db.db;

// Feature tables owned by modules not mounted in this test — create just the
// columns the checks read (mirrors the owning modules' DDL).
sql.exec(`
  CREATE TABLE IF NOT EXISTS segments (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'tile', last_count INTEGER NOT NULL DEFAULT -1);
  CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', config TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, name TEXT NOT NULL, target_value REAL NOT NULL DEFAULT 0, unit TEXT NOT NULL DEFAULT '', by_date TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', rule_type TEXT NOT NULL DEFAULT 'threshold', threshold REAL NOT NULL DEFAULT 0, channels TEXT NOT NULL DEFAULT '["push"]');
  CREATE TABLE IF NOT EXISTS scheduled_jobs (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'digest', title TEXT NOT NULL DEFAULT '', cadence TEXT NOT NULL DEFAULT 'daily', recipients TEXT NOT NULL DEFAULT '[]');
  CREATE TABLE IF NOT EXISTS os_threads (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS os_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, body TEXT NOT NULL DEFAULT '');
`);

const uuid = () => crypto.randomUUID();
const entity = makeEntity('Training Sandbox', 'SandboxOrg');

function newExam(taskKeys, extra = {}) {
  return api.createExam({ title: 'Practical', entityId: entity.id, taskKeys, passPct: 70, createdBy: 'trainer@howler.co.za', ...extra });
}
const stateOf = (attemptId, key) => {
  const { attempt } = api.runChecks(attemptId);
  return attempt.taskState[key] || { done: false };
};

test('codes look right and briefs personalize', () => {
  const code = training.makeCode();
  assert.match(code, /^PX-[A-Z2-9]{4}$/);
  const t = training.TASK_CATALOG.find((x) => x.key === 'segment_create');
  assert.ok(training.briefFor(t, 'PX-TEST').includes('PX-TEST'));
});

test('exam creation validates sandbox client and tasks', () => {
  assert.throws(() => api.createExam({ title: 'X', entityId: 'nope', taskKeys: ['segment_create'] }), /sandbox client/);
  assert.throws(() => api.createExam({ title: 'X', entityId: entity.id, taskKeys: ['not_a_task'] }), /at least one task/);
  const exam = newExam(['segment_create', 'bogus']);
  assert.deepEqual(exam.taskKeys, ['segment_create'], 'unknown task keys are dropped');
  assert.equal(exam.status, 'open');
});

test('trainee assignment: personal codes, lowercased + deduped emails', () => {
  const exam = newExam(['segment_create']);
  const added = api.addAttempts(exam.id, [
    { name: 'Thandi', email: 'Thandi@Howler.co.za' },
    { name: 'dup', email: 'thandi@howler.co.za' },
    { name: 'no-email', email: 'not-an-email' },
  ]);
  assert.equal(added.length, 1);
  assert.equal(added[0].traineeEmail, 'thandi@howler.co.za');
  assert.match(added[0].code, /^PX-/);
  assert.equal(api.addAttempts(exam.id, [{ email: 'thandi@howler.co.za' }]).length, 0, 'already assigned');
});

test('checks find evidence by code; partial work gets a coaching message', () => {
  const exam = newExam(['segment_create', 'campaign_draft', 'campaign_submit', 'dashboard_build', 'suite_create', 'goal_create', 'alert_create', 'digest_schedule', 'inbox_thread', 'login_create']);
  const [a] = api.addAttempts(exam.id, [{ name: 'Sipho', email: 'sipho@howler.co.za' }]);
  const code = a.code;

  // Nothing done yet.
  let { attempt } = api.runChecks(a.id);
  assert.ok(Object.values(attempt.taskState).every((s) => !s.done));
  assert.equal(api.scoreOf(exam, attempt.taskState), 0);

  // Segment — done as soon as a named segment exists in the sandbox client.
  sql.prepare('INSERT INTO segments (id, entity_id, name, source, last_count) VALUES (?,?,?,?,?)').run(uuid(), entity.id, `${code} VIP fans`, 'tile', 120);
  let s = stateOf(a.id, 'segment_create');
  assert.ok(s.done); assert.match(s.evidence, /VIP fans.*120 people/);

  // Campaign — a draft without a subject coaches instead of passing.
  const actId = uuid();
  sql.prepare('INSERT INTO actions (id, entity_id, title, status, config) VALUES (?,?,?,?,?)').run(actId, entity.id, `${code} Early bird push`, 'draft', '{}');
  s = stateOf(a.id, 'campaign_draft');
  assert.ok(!s.done); assert.match(s.evidence, /no subject/);
  sql.prepare('UPDATE actions SET config=? WHERE id=?').run(JSON.stringify({ subject: 'Last early birds!', body: 'Grab yours now.' }), actId);
  assert.ok(stateOf(a.id, 'campaign_draft').done);
  // …and submit-for-approval requires leaving draft status.
  assert.match(stateOf(a.id, 'campaign_submit').evidence, /still a draft/);
  sql.prepare('UPDATE actions SET status=?, config=? WHERE id=?').run('pending', JSON.stringify({ subject: 'Last early birds!', body: 'Grab yours now.', approvers: [{ type: 'howler' }] }), actId);
  s = stateOf(a.id, 'campaign_submit');
  assert.ok(s.done); assert.match(s.evidence, /awaiting approval/);

  // Dashboard — needs at least two tiles.
  const dash = db.createDashboard({ title: `${code} Sales overview`, tiles: [{ id: 't1' }] });
  s = stateOf(a.id, 'dashboard_build');
  assert.ok(!s.done); assert.match(s.evidence, /needs at least 2/);
  db.updateDashboard(dash.id, { tiles: [{ id: 't1' }, { id: 't2' }] });
  assert.ok(stateOf(a.id, 'dashboard_build').done);

  // Suite — must have a set attached to count.
  const set = db.createSet({ name: 'Ticketing' });
  const suite = db.createSuite({ entityId: entity.id, name: `${code} Summer Fest` });
  s = stateOf(a.id, 'suite_create');
  assert.ok(!s.done); assert.match(s.evidence, /no dashboard sets/);
  db.setSuiteSets(suite.id, [set.id]);
  assert.ok(stateOf(a.id, 'suite_create').done);

  // Goal / alert / digest / inbox / login.
  sql.prepare('INSERT INTO goals (id, entity_id, name, target_value, unit, by_date) VALUES (?,?,?,?,?,?)').run(uuid(), entity.id, `${code} Sell out GA`, 5000, 'tickets', '2026-09-01');
  assert.match(stateOf(a.id, 'goal_create').evidence, /5000 tickets by 2026-09-01/);
  sql.prepare('INSERT INTO alerts (id, entity_id, name, rule_type, threshold, channels) VALUES (?,?,?,?,?,?)').run(uuid(), entity.id, `${code} VIP low stock`, 'threshold', 100, '["push","email"]');
  assert.ok(stateOf(a.id, 'alert_create').done);
  sql.prepare('INSERT INTO scheduled_jobs (id, entity_id, type, title, cadence, recipients) VALUES (?,?,?,?,?,?)').run(uuid(), entity.id, 'digest', `${code} Weekly exec digest`, 'weekly', '["client@example.com"]');
  assert.ok(stateOf(a.id, 'digest_schedule').done);
  const threadId = uuid();
  sql.prepare('INSERT INTO os_threads (id, entity_id, title) VALUES (?,?,?)').run(threadId, entity.id, `${code} Welcome aboard`);
  sql.prepare('INSERT INTO os_messages (id, thread_id, body) VALUES (?,?,?)').run(uuid(), threadId, 'Hi team — here is your onboarding plan for the season.');
  assert.ok(stateOf(a.id, 'inbox_thread').done);
  const login = db.createUser({ email: `${code.toLowerCase()}@exam.howler.co.za`, password: 'pw-' + uuid(), role: 'client', entityIds: [entity.id] });
  assert.ok(login);
  assert.ok(stateOf(a.id, 'login_create').done);

  // Everything done → full marks.
  ({ attempt } = api.runChecks(a.id));
  assert.ok(Object.values(attempt.taskState).every((x) => x.done));
  assert.equal(api.scoreOf(exam, attempt.taskState), 100);
});

test('submit locks in score vs the pass mark; no double submission', () => {
  const exam = newExam(['segment_create', 'goal_create'], { passPct: 60 });
  const [a] = api.addAttempts(exam.id, [{ name: 'Lerato', email: 'lerato@howler.co.za' }]);
  api.startAttempt(a.id);

  // Only the segment (10 of 20 pts = 50%) → below the 60% pass mark.
  sql.prepare('INSERT INTO segments (id, entity_id, name) VALUES (?,?,?)').run(uuid(), entity.id, `${a.code} halfway`, );
  let done = api.submitAttempt(a.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.scorePct, 50);
  assert.throws(() => api.submitAttempt(a.id), /already submitted/);

  // A fresh attempt with the goal done too passes.
  const [b] = api.addAttempts(exam.id, [{ name: 'Retake', email: 'retake@howler.co.za' }]);
  api.startAttempt(b.id);
  sql.prepare('INSERT INTO segments (id, entity_id, name) VALUES (?,?,?)').run(uuid(), entity.id, `${b.code} seg`);
  sql.prepare('INSERT INTO goals (id, entity_id, name, target_value) VALUES (?,?,?,?)').run(uuid(), entity.id, `${b.code} goal`, 1000);
  done = api.submitAttempt(b.id);
  assert.equal(done.status, 'passed');
  assert.equal(done.scorePct, 100);
});

test('attemptView personalizes briefs and reports progress', () => {
  const exam = newExam(['segment_create'], { notes: 'Sandbox only.', timeLimitMin: 90 });
  const [a] = api.addAttempts(exam.id, [{ name: 'Zola', email: 'zola@howler.co.za' }]);
  const started = api.startAttempt(a.id);
  const view = api.attemptView(started, exam);
  assert.equal(view.exam.entityName, 'Training Sandbox');
  assert.ok(view.tasks[0].brief.includes(a.code), 'the {CODE} placeholder is substituted');
  assert.ok(view.deadline > started.startedAt, 'deadline derived from the time limit');
  assert.equal(view.late, false);
  assert.equal(view.progressPct, 0);
});
