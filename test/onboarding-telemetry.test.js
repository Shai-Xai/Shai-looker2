// Telemetry: /api/my/track is entity-scoped and aggregates into the admin
// onboarding stats (funnel + feature usage). These guard the ownership boundary
// and the aggregation maths that the "Onboarding insights" view depends on.

const { test } = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./http');
const h = require('./helpers');
const rateLimit = require('../server/ratelimit');

const mount = (app) => require('../server/telemetry').mount(app, { db: h.db, auth: h.auth, rateLimit });
// Tests in a file share one DB (one process), so reset events for isolation.
const reset = () => { try { h.db.db.exec('DELETE FROM usage_events'); } catch { /* table not created yet */ } };

test('track is scoped to entities the user owns; bad rows are dropped', async () => {
  const app = await startApp(mount);
  reset();
  const e = h.makeEntity('Acme', 'Acme Org');
  const user = h.makeClient('u@acme.test', [e.id]);

  // Owns it → accepted.
  let r = await app.req('POST', '/api/my/track', { as: user, body: { entityId: e.id, events: [
    { kind: 'guide', name: 'essentials', step: '0', event: 'open' },
    { kind: 'nonsense', name: 'x', event: 'use' },   // bad kind → skipped
    { kind: 'feature', name: 'pin', event: 'use' },
  ] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);

  // Doesn't own it → 403, nothing logged.
  r = await app.req('POST', '/api/my/track', { as: user, body: { entityId: 'other-entity', events: [{ kind: 'feature', name: 'pin', event: 'use' }] } });
  assert.equal(r.status, 403);

  // Missing entity → 403.
  r = await app.req('POST', '/api/my/track', { as: user, body: { events: [] } });
  assert.equal(r.status, 403);

  await app.close();
});

test('admin stats aggregates the funnel and feature usage', async () => {
  const app = await startApp(mount);
  reset();
  const e = h.makeEntity('Beta', 'Beta Org');
  const user = h.makeClient('u@beta.test', [e.id]);
  const admin = h.makeAdmin('admin@beta.test');

  await app.req('POST', '/api/my/track', { as: user, body: { entityId: e.id, events: [
    { kind: 'guide', name: 'essentials', step: '0', event: 'open' },
    { kind: 'guide', name: 'essentials', step: '0', event: 'step' },
    { kind: 'guide', name: 'essentials', step: '1', event: 'step' },
    { kind: 'guide', name: 'essentials', step: '1', event: 'skip' },
    { kind: 'feature', name: 'pin', event: 'use' },
    { kind: 'feature', name: 'pin', event: 'use' },
    { kind: 'feature', name: 'follow', event: 'use' },
  ] } });

  // Clients can't read admin stats.
  let r = await app.req('GET', '/api/admin/onboarding/stats', { as: user });
  assert.equal(r.status, 403);

  r = await app.req('GET', '/api/admin/onboarding/stats', { as: admin });
  assert.equal(r.status, 200);
  const s = r.body;
  assert.equal(s.total, 7);

  const g = s.guides.essentials;
  assert.equal(g.opens, 1);
  assert.equal(g.steps['0'].viewed, 1);
  assert.equal(g.steps['1'].viewed, 1);
  assert.equal(g.steps['1'].skip, 1);

  // Features ranked by distinct people; pin used twice by one person → people 1, hits 2.
  const pin = s.features.find((f) => f.name === 'pin');
  assert.deepEqual({ people: pin.people, hits: pin.hits }, { people: 1, hits: 2 });
  assert.ok(s.features.find((f) => f.name === 'follow'));

  await app.close();
});
