// DSAR tooling (server/dsar.js): entity purge reaches the no-FK feature
// tables, contact forget erases everywhere EXCEPT suppressions, audience
// snapshots are scrubbed, export mirrors the sweep, and the routes gate on
// super-admin. Tables are created by the REAL modules (mailer/surveys/fanOwl/
// actions mounted with the same stub-dep pattern as campaigns.test.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { startApp } = require('./http');
const dsar = require('../server/dsar');

const noop = new Proxy({}, { get: () => () => {} });
const mailerStub = {
  send: async () => ({ ok: true }),
  baseUrl: () => 'http://test.local',
  resolveBranding: () => ({ senderName: 'T' }),
  campaignEmail: () => ({ html: '', text: '' }),
};

let app, A, B, superAdmin, plainAdmin;
const sql = () => h.db.db;

before(async () => {
  require('../server/mailer').init({ db: h.db }); // mail_log + mail_suppressions
  A = h.makeEntity('DSAR Co A', 'A');
  B = h.makeEntity('DSAR Co B', 'B');
  superAdmin = (() => { const u = h.makeAdmin('root@test.local'); h.db.updateUser(u.id, { roles: ['super_admin'] }); return h.db.getUser(u.id); })();
  plainAdmin = h.makeAdmin('plain@test.local');
  app = await startApp((expressApp) => {
    require('../server/actions').mount(expressApp, {
      db: h.db, auth: h.auth, mailer: mailerStub, push: noop, messaging: noop, os: noop,
      billing: { costFor: () => ({ total: 0 }), masterRates: () => ({ currency: 'ZAR' }) },
      resolveAudience: async () => ({ rows: [], fields: [] }),
      draftCopy: async () => ({ subject: 's', body: 'b' }),
      listEvents: async () => [],
    });
    require('../server/surveys').mount(expressApp, { db: h.db, auth: h.auth, rateLimit: () => (_req, _res, next) => next() });
    dsar.mount(expressApp, { db: h.db, auth: h.auth });
    expressApp.use(require('../server/http').errorMiddleware);
  });

  // Seed contact 'gone@fan.com' + bystander 'stays@fan.com' across tables.
  const now = new Date().toISOString();
  sql().prepare('INSERT INTO mail_log (at, recipient, subject, status, kind, entity_id) VALUES (?,?,?,?,?,?)')
    .run(now, 'gone@fan.com', 'Hi', 'sent', 'campaign', A.id);
  sql().prepare('INSERT INTO mail_log (at, recipient, subject, status, kind, entity_id) VALUES (?,?,?,?,?,?)')
    .run(now, 'stays@fan.com', 'Hi', 'sent', 'campaign', A.id);
  sql().prepare('INSERT INTO mail_suppressions (email, reason, at) VALUES (?,?,?)')
    .run('gone@fan.com', 'complained', now);
  sql().prepare('INSERT INTO action_suppressions (entity_id, email, at) VALUES (?,?,?)')
    .run(A.id, 'gone@fan.com', now);
  sql().prepare('INSERT INTO survey_responses (id, survey_id, howler_user_id, display_name, email, answers, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('r1', 'sv1', 'u1', 'Gone Fan', 'gone@fan.com', '["ans"]', now, now);
  sql().prepare("INSERT INTO surveys (id, entity_id, title, questions, created_at, updated_at) VALUES ('sv1', ?, 'S', '[]', ?, ?)").run(A.id, now, now);
  // Campaign with an audience snapshot containing both contacts (entity A) and
  // an entity-B campaign that must be untouched by A's purge.
  sql().prepare("INSERT INTO actions (id, entity_id, type, status, title, audience, config, created_at, updated_at) VALUES ('actA', ?, 'email', 'sent', 'Blast', ?, '{}', ?, ?)")
    .run(A.id, JSON.stringify([{ email: 'gone@fan.com', name: 'Gone' }, { email: 'stays@fan.com', name: 'Stays' }]), now, now);
  sql().prepare("INSERT INTO actions (id, entity_id, type, status, title, audience, config, created_at, updated_at) VALUES ('actB', ?, 'email', 'sent', 'B blast', '[]', '{}', ?, ?)")
    .run(B.id, now, now);
  sql().prepare("INSERT INTO action_sends (action_id, recipient, channel, at) VALUES ('actA', 'gone@fan.com', 'email', ?)").run(now);
});
after(async () => { if (app) await app.close(); });

test('forgetContact erases the contact everywhere but KEEPS suppressions', () => {
  const result = dsar.forgetContact({ email: 'Gone@Fan.com' });
  // Erased: mail log, survey response, send ledger, audience snapshot rows.
  assert.equal(sql().prepare("SELECT COUNT(*) c FROM mail_log WHERE recipient='gone@fan.com'").get().c, 0);
  assert.equal(sql().prepare("SELECT COUNT(*) c FROM survey_responses WHERE email='gone@fan.com'").get().c, 0);
  const audience = JSON.parse(sql().prepare("SELECT audience FROM actions WHERE id='actA'").get().audience);
  assert.deepEqual(audience.map((r) => r.email), ['stays@fan.com']); // bystander survives
  // KEPT: both suppression tiers (do-not-contact memory) + bystander data.
  assert.equal(sql().prepare("SELECT COUNT(*) c FROM mail_suppressions WHERE email='gone@fan.com'").get().c, 1);
  assert.equal(sql().prepare("SELECT COUNT(*) c FROM action_suppressions WHERE email='gone@fan.com'").get().c, 1);
  assert.equal(sql().prepare("SELECT COUNT(*) c FROM mail_log WHERE recipient='stays@fan.com'").get().c, 1);
  assert.deepEqual(result.kept, ['mail_suppressions', 'action_suppressions']);
  assert.ok(result.removed['actions.audience (snapshot rows)'] >= 1);
});

test('purgeEntityData sweeps entity A without touching entity B', () => {
  const out = dsar.purgeEntityData(A.id);
  assert.equal(sql().prepare("SELECT COUNT(*) c FROM actions WHERE entity_id=?").get(A.id).c, 0);
  assert.equal(sql().prepare("SELECT COUNT(*) c FROM mail_log WHERE entity_id=?").get(A.id).c, 0);
  assert.equal(sql().prepare("SELECT COUNT(*) c FROM surveys WHERE entity_id=?").get(A.id).c, 0);
  assert.equal(sql().prepare("SELECT COUNT(*) c FROM action_suppressions WHERE entity_id=?").get(A.id).c, 0);
  // Entity B untouched; GLOBAL suppression untouched.
  assert.equal(sql().prepare("SELECT COUNT(*) c FROM actions WHERE entity_id=?").get(B.id).c, 1);
  assert.equal(sql().prepare("SELECT COUNT(*) c FROM mail_suppressions WHERE email='gone@fan.com'").get().c, 1);
  // Absent-table steps are reported, not silent (fan/os/chat modules unmounted here).
  assert.ok(out.skipped.includes('fan_profiles'));
});

test('routes: super-admin only; forget demands confirm:true; export mirrors data', async () => {
  const r1 = await app.req('POST', '/api/admin/dsar/forget', { as: plainAdmin, body: { email: 'x@y.z', confirm: true } });
  assert.equal(r1.status, 403); // plain admin blocked
  const r2 = await app.req('POST', '/api/admin/dsar/forget', { as: superAdmin, body: { email: 'x@y.z' } });
  assert.equal(r2.status, 400); // no confirm flag
  // Seed a fresh row, export it, then forget it via the route.
  sql().prepare('INSERT INTO mail_log (at, recipient, subject, status, kind, entity_id) VALUES (?,?,?,?,?,?)')
    .run(new Date().toISOString(), 'route@fan.com', 'Hi', 'sent', 'campaign', B.id);
  const ex = await app.req('GET', '/api/admin/dsar/export?email=route@fan.com', { as: superAdmin });
  assert.equal(ex.status, 200);
  assert.equal(ex.body.data.mail_log.length, 1);
  const r3 = await app.req('POST', '/api/admin/dsar/forget', { as: superAdmin, body: { email: 'route@fan.com', confirm: true } });
  assert.equal(r3.status, 200);
  assert.equal(sql().prepare("SELECT COUNT(*) c FROM mail_log WHERE recipient='route@fan.com'").get().c, 0);
});

test('offboardEntity purges + deletes the entity row in one call', () => {
  const C = h.makeEntity('DSAR Co C', 'C');
  sql().prepare('INSERT INTO mail_log (at, recipient, subject, status, kind, entity_id) VALUES (?,?,?,?,?,?)')
    .run(new Date().toISOString(), 'c@fan.com', 'Hi', 'sent', 'campaign', C.id);
  const out = dsar.offboardEntity(C.id, superAdmin.id);
  assert.equal(out.ok, true);
  assert.equal(h.db.getEntity(C.id), undefined);
  assert.equal(sql().prepare('SELECT COUNT(*) c FROM mail_log WHERE entity_id=?').get(C.id).c, 0);
});
