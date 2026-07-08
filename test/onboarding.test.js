// The client onboarding journey: phased progress, the tenant guard, and the
// email layer's core promises — a welcome pack once the first login exists
// (never twice), a phase-completion email with the next phase introduced, and
// silent baselining for clients that predate the email layer.

const { test } = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./http');
const h = require('./helpers');

// Capture every outbound surface instead of really sending.
function makeStubs() {
  const sent = [];
  const announced = [];
  const mailer = {
    isConfigured: () => true,
    send: (m) => { sent.push(m); return { ok: true }; },
    notificationEmail: ({ title, body }) => ({ html: `<h1>${title}</h1>${body}`, text: `${title}\n${body}` }),
    resolveBranding: () => ({ senderName: 'Acme Events' }),
  };
  const os = { announce: (p) => { announced.push(p); return { id: 't1' }; } };
  return { mailer, os, sent, announced };
}
const mountWith = (stubs) => (app) => require('../server/onboarding').mount(app, { db: h.db, auth: h.auth, mailer: stubs.mailer, os: stubs.os });
const reset = () => { try { h.db.db.exec('DELETE FROM onboarding_state; DELETE FROM onboarding_mail_log;'); } catch { /* new */ } };

test('journey exposes four phases, ticks manual steps, and guards the tenant boundary', async () => {
  const stubs = makeStubs();
  const app = await startApp(mountWith(stubs));
  reset();
  const e = h.makeEntity('Acme', 'Acme Org');
  const user = h.makeClient('u@acme.test', [e.id]);
  const outsider = h.makeClient('x@other.test', [h.makeEntity('Other', 'Other Org').id]);

  let r = await app.req('GET', `/api/my/onboarding/${e.id}`, { as: user });
  assert.equal(r.status, 200);
  assert.equal(r.body.phases.length, 4);
  assert.deepEqual(r.body.phases.map((p) => p.key), ['fundamentals', 'engage', 'owl', 'automate']);
  assert.equal(r.body.currentPhase, 'fundamentals');
  // Every step belongs to a declared phase, and totals add up.
  assert.equal(r.body.phases.reduce((n, p) => n + p.total, 0), r.body.total);

  // Tick a manual step → reflected; unknown step → 400; outsider → 403.
  r = await app.req('POST', `/api/my/onboarding/${e.id}/explore`, { as: user, body: { done: true } });
  assert.equal(r.status, 200);
  assert.equal(r.body.steps.find((s) => s.key === 'explore').done, true);
  r = await app.req('POST', `/api/my/onboarding/${e.id}/nope`, { as: user, body: { done: true } });
  assert.equal(r.status, 400);
  r = await app.req('GET', `/api/my/onboarding/${e.id}`, { as: outsider });
  assert.equal(r.status, 403);

  await app.close();
});

test('welcome pack sends once when the first login exists; phase completion follows with the next phase', async () => {
  const stubs = makeStubs();
  const app = await startApp(mountWith(stubs));
  reset();
  const onboarding = require('../server/onboarding');
  // Re-mount to grab the API (mount is idempotent for tables); use a fresh app-less mount.
  const api = onboarding.mount({ get: () => {}, post: () => {}, put: () => {} }, { db: h.db, auth: h.auth, mailer: stubs.mailer, os: stubs.os });

  // Entities from earlier tests share this DB — age them past the welcome
  // window so the evaluator baselines them silently instead of welcoming them.
  h.db.db.prepare('UPDATE entities SET created_at=?').run(new Date(Date.now() - 60 * 86400000).toISOString());
  const e = h.makeEntity('Beta', 'Beta Org');

  // No logins yet → nothing sends.
  let out = await api.evaluate();
  assert.equal(out.welcomes, 0);
  assert.equal(stubs.sent.length, 0);

  // First login appears → the welcome pack goes out (email + inbox), exactly once.
  const user = h.makeClient('u@beta.test', [e.id]);
  out = await api.evaluate();
  assert.equal(out.welcomes, 1);
  const welcome = stubs.sent.find((m) => m.kind === 'onboarding');
  assert.ok(welcome, 'welcome email sent');
  assert.deepEqual(welcome.to, ['u@beta.test']);
  assert.equal(stubs.announced.length, 1);
  out = await api.evaluate();
  assert.equal(out.welcomes, 0, 'welcome never repeats');

  // Complete every phase-1 step (manual ticks override auto) → one phase email,
  // introducing Phase 2, plus a milestone heads-up to the account team.
  const before = stubs.sent.length;
  for (const key of ['explore', 'install', 'notifications', 'owlchat', 'digest', 'branding', 'team']) {
    await app.req('POST', `/api/my/onboarding/${e.id}/${key}`, { as: user, body: { done: true } });
  }
  out = await api.evaluate();
  assert.equal(out.phaseMails, 1);
  const phaseMail = stubs.sent.slice(before).find((m) => (m.subject || '').includes('Next up'));
  assert.ok(phaseMail, 'phase-completion email sent');
  assert.match(phaseMail.subject, /Goals & first sends/);
  out = await api.evaluate();
  assert.equal(out.phaseMails, 0, 'phase email never repeats');

  await app.close();
});

test('clients that predate the email layer are baselined silently', async () => {
  const stubs = makeStubs();
  const app = await startApp(mountWith(stubs));
  reset();
  const api = require('../server/onboarding').mount({ get: () => {}, post: () => {}, put: () => {} }, { db: h.db, auth: h.auth, mailer: stubs.mailer, os: stubs.os });

  const e = h.makeEntity('Gamma', 'Gamma Org');
  h.makeClient('u@gamma.test', [e.id]);
  // Age EVERY entity past the welcome window (this file shares one DB, and
  // reset() wiped the mail log — earlier tests' clients must baseline too).
  h.db.db.prepare('UPDATE entities SET created_at=?').run(new Date(Date.now() - 60 * 86400000).toISOString());

  const out = await api.evaluate();
  assert.equal(out.welcomes, 0);
  assert.equal(stubs.sent.length, 0, 'no late welcome for an old client');

  // Admin view reflects the baseline + mail controls work.
  const admin = h.makeAdmin('admin@gamma.test');
  let r = await app.req('GET', `/api/admin/entities/${e.id}/onboarding`, { as: admin });
  assert.equal(r.status, 200);
  assert.equal(r.body.mail.welcomeSentAt, 'baseline');
  r = await app.req('PUT', `/api/admin/entities/${e.id}/onboarding-mail`, { as: admin, body: { on: false } });
  assert.equal(r.body.on, false);
  // Opted out → even a fresh-looking client would be skipped (flip age back).
  h.db.db.prepare('UPDATE entities SET created_at=? WHERE id=?').run(new Date().toISOString(), e.id);
  h.db.db.prepare('DELETE FROM onboarding_mail_log WHERE entity_id=?').run(e.id);
  const out2 = await api.evaluate();
  assert.equal(out2.welcomes, 0, 'per-client opt-out respected');

  await app.close();
});
