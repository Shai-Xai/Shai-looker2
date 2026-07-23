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
  assert.equal(r.body.phases.length, 5);
  assert.deepEqual(r.body.phases.map((p) => p.key), ['fundamentals', 'meetowl', 'engage', 'owl', 'automate']);
  assert.equal(r.body.currentPhase, 'fundamentals');
  assert.ok(r.body.phases.every((p) => p.sticker), 'every phase carries its sticker');
  // Every step belongs to a declared phase, totals add up, and steps carry points.
  assert.equal(r.body.phases.reduce((n, p) => n + p.total, 0), r.body.total);
  assert.ok(r.body.steps.every((s) => s.pts > 0), 'every step is worth points');

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

test('dismiss hides the checklist for that user only, not the whole client team', async () => {
  const stubs = makeStubs();
  const app = await startApp(mountWith(stubs));
  reset();
  const e = h.makeEntity('Dismissy', 'Dismissy Org');
  const a = h.makeClient('a@dismissy.test', [e.id]);
  const b = h.makeClient('b@dismissy.test', [e.id]); // teammate on the SAME client

  // A dismisses → A sees it dismissed, B does not.
  let r = await app.req('POST', `/api/my/onboarding/${e.id}/dismiss`, { as: a, body: { dismissed: true } });
  assert.equal(r.status, 200);
  assert.equal(r.body.dismissed, true, 'A now sees it dismissed');
  r = await app.req('GET', `/api/my/onboarding/${e.id}`, { as: b });
  assert.equal(r.body.dismissed, false, "teammate B is unaffected");
  r = await app.req('GET', `/api/my/onboarding/${e.id}`, { as: a });
  assert.equal(r.body.dismissed, true, 'A stays dismissed on reload');

  // A can restore it for themselves.
  r = await app.req('POST', `/api/my/onboarding/${e.id}/dismiss`, { as: a, body: { dismissed: false } });
  assert.equal(r.body.dismissed, false, 'A restored the checklist');

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
  // introducing Phase 2 (Meet the Owl), plus a milestone heads-up to the team.
  const before = stubs.sent.length;
  for (const key of ['explore', 'install', 'notifications', 'digest', 'branding', 'team']) {
    await app.req('POST', `/api/my/onboarding/${e.id}/${key}`, { as: user, body: { done: true } });
  }
  out = await api.evaluate();
  assert.equal(out.phaseMails, 1);
  const phaseMail = stubs.sent.slice(before).find((m) => (m.subject || '').includes('Next up'));
  assert.ok(phaseMail, 'phase-completion email sent');
  assert.match(phaseMail.subject, /Meet the Owl/);
  assert.match(phaseMail.text || phaseMail.html || '', /Pathfinder/); // the sticker is celebrated
  out = await api.evaluate();
  assert.equal(out.phaseMails, 0, 'phase email never repeats');

  await app.close();
});

test('gamify awards stickers + points and the cockpit reads the journey', async () => {
  const stubs = makeStubs();
  const onboardingApi = { current: null };
  const app = await startApp((a) => {
    onboardingApi.current = require('../server/onboarding').mount(a, { db: h.db, auth: h.auth, mailer: stubs.mailer, os: stubs.os });
    require('../server/gamify').mount(a, { db: h.db, auth: h.auth, onboarding: onboardingApi.current });
    require('../server/onboardingCockpit').mount(a, { db: h.db, auth: h.auth, onboarding: onboardingApi.current });
  });
  reset();
  try { h.db.db.exec('DELETE FROM badge_awards; DELETE FROM journey_pulse;'); } catch { /* new */ }
  const e = h.makeEntity('Delta', 'Delta Org');
  const user = h.makeClient('u@delta.test', [e.id]);
  const admin = h.makeAdmin('admin@delta.test');

  // Empty shelf: five stickers, none earned, points reflect auto-done steps only.
  let r = await app.req('GET', `/api/my/journey/${e.id}`, { as: user });
  assert.equal(r.status, 200);
  assert.equal(r.body.stickers.length, 5);
  assert.equal(r.body.stickers.filter((s) => s.earned).length, 0);
  assert.ok(Array.isArray(r.body.badges) && r.body.badges.length >= 5);

  // Finish phase 1 → the Pathfinder sticker awards, once, with the phase bonus.
  for (const key of ['explore', 'install', 'notifications', 'digest', 'branding', 'team']) {
    await app.req('POST', `/api/my/onboarding/${e.id}/${key}`, { as: user, body: { done: true } });
  }
  r = await app.req('GET', `/api/my/journey/${e.id}`, { as: user });
  const pathfinder = r.body.stickers.find((s) => s.key === 'fundamentals');
  assert.equal(pathfinder.earned, true);
  assert.ok(r.body.points.total >= 350 + 250, 'steps + phase bonus counted');
  // The ledger itemises the total exactly — no mystery numbers.
  assert.equal(r.body.ledger.reduce((n, l) => n + l.pts, 0), r.body.points.total);
  assert.ok(r.body.ledger.some((l) => l.kind === 'sticker' && /Pathfinder/.test(l.label)));
  assert.equal(r.body.points.steps + r.body.points.phases + r.body.points.activity, r.body.points.total);
  assert.ok(r.body.unseen.some((u) => u.key === 'phase:fundamentals'), 'unlock is queued for the toast');
  await app.req('POST', `/api/my/journey/${e.id}/seen`, { as: user });
  r = await app.req('GET', `/api/my/journey/${e.id}`, { as: user });
  assert.equal(r.body.unseen.length, 0, 'toast acked');

  // Outsider can't read the shelf.
  const outsider = h.makeClient('x@delta-out.test', [h.makeEntity('DeltaOut', 'DO Org').id]);
  r = await app.req('GET', `/api/my/journey/${e.id}`, { as: outsider });
  assert.equal(r.status, 403);

  // Cockpit: Delta shows phase 2 current with the Pathfinder milestone; admin only.
  r = await app.req('GET', '/api/admin/onboarding/cockpit', { as: user });
  assert.equal(r.status, 403);
  r = await app.req('GET', '/api/admin/onboarding/cockpit', { as: admin });
  assert.equal(r.status, 200);
  const row = r.body.rows.find((x) => x.id === e.id);
  assert.ok(row, 'client appears in the cockpit');
  assert.equal(row.currentPhase.key, 'meetowl');
  assert.equal(row.phases.filter((p) => p.complete).length, 1);
  assert.match(row.lastMilestone.label, /Pathfinder/);

  // One-tap nudge lists the open steps of the current phase on both surfaces.
  const beforeNudge = stubs.announced.length;
  r = await app.req('POST', `/api/admin/onboarding/cockpit/${e.id}/nudge`, { as: admin });
  assert.equal(r.body.ok, true);
  assert.equal(stubs.announced.length, beforeNudge + 1);

  // Scorecard aggregates per owning AM (Delta has no owner → may be absent),
  // but the endpoint always answers and is admin-only.
  r = await app.req('GET', '/api/admin/onboarding/scorecard', { as: admin });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.cards));

  await app.close();
});

test('milestone emails go only to the account team on the account — never all admins', async () => {
  const stubs = makeStubs();
  const app = await startApp(mountWith(stubs));
  reset();
  const api = require('../server/onboarding').mount({ get: () => {}, post: () => {}, put: () => {} }, { db: h.db, auth: h.auth, mailer: stubs.mailer, os: stubs.os });
  // Age earlier tests' entities out of the welcome window; two admins exist.
  h.db.db.prepare('UPDATE entities SET created_at=?').run(new Date(Date.now() - 60 * 86400000).toISOString());
  const owner = h.makeAdmin('owner-am@test.local');
  const bystander = h.makeAdmin('bystander-am@test.local');

  // Echo HAS an account owner; Foxtrot has nobody configured.
  const echo = h.makeEntity('Echo', 'Echo Org');
  h.db.db.prepare('UPDATE entities SET howler_owner_user_id=? WHERE id=?').run(owner.id, echo.id);
  const foxtrot = h.makeEntity('Foxtrot', 'Foxtrot Org');
  const uE = h.makeClient('u@echo.test', [echo.id]);
  const uF = h.makeClient('u@foxtrot.test', [foxtrot.id]);
  await api.evaluate(); // welcomes both

  const finish = async (eid, user) => { for (const k of ['explore', 'install', 'notifications', 'owlchat', 'digest', 'branding', 'team']) await app.req('POST', `/api/my/onboarding/${eid}/${k}`, { as: user, body: { done: true } }); };
  await finish(echo.id, uE); await finish(foxtrot.id, uF);
  await api.evaluate();

  const milestones = stubs.sent.filter((m) => /completed onboarding phase/.test(m.subject || ''));
  const echoMail = milestones.find((m) => /Echo/.test(m.subject));
  assert.ok(echoMail, 'owner notified for Echo');
  assert.deepEqual(echoMail.to, ['owner-am@test.local']);
  assert.ok(!milestones.some((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes('bystander-am@test.local')), 'uninvolved admins never emailed');
  assert.ok(!milestones.some((m) => /Foxtrot/.test(m.subject || '')), 'no account team configured → no team email at all');

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
