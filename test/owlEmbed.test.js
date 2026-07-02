// Route-level pins for the organizer-portal Owl embed (server/owlEmbed.js):
// the admin config gates, the server-to-server session handshake (secret,
// enable switch, org→entity link), JIT shadow-user provisioning (and its
// refuse-to-widen rules), and the embed bearer token riding attachUser.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');
const { startApp } = require('./http');
const rateLimit = require('../server/ratelimit');

const SECRET = 'portal-shared-secret';
let app;
before(async () => {
  app = await startApp((expressApp) => {
    require('../server/owlEmbed').mount(expressApp, { db: h.db, auth: h.auth, rateLimit });
    // A cookie-free probe for the embed bearer token: proves attachUser accepts
    // the minted JWT as a full (entity-scoped) session and flags req.embedAuth.
    expressApp.get('/api/test/whoami', h.auth.requireAuth, (req, res) =>
      res.json({ id: req.user.id, email: req.user.email, entityIds: req.user.entityIds, embed: !!req.embedAuth }));
  });
});
after(async () => { if (app) await app.close(); });
beforeEach(() => {
  h.db.setSetting('owl_embed_enabled', '1');
  h.db.setSetting('owl_embed_secret', SECRET);
  h.db.setSetting('owl_embed_links', '[]');
});

const linkOrg = (orgId, entityId) => h.db.setSetting('owl_embed_links', JSON.stringify([{ orgId, entityId }]));
const mint = (body, secret = SECRET) =>
  app.req('POST', '/api/embed/owl/session', { body, headers: { Authorization: `Bearer ${secret}` } });

test('admin config routes are admin-only', async () => {
  const client = h.makeClient('embed-client@test.local', [h.makeEntity('EmbCfg Co', 'embcfg-org').id], 'owner');
  assert.equal((await app.req('GET', '/api/admin/owl-embed')).status, 401);
  assert.equal((await app.req('GET', '/api/admin/owl-embed', { as: client })).status, 403);
  assert.equal((await app.req('PUT', '/api/admin/owl-embed', { as: client, body: { enabled: true } })).status, 403);
});

test('admin config: secret is write-only (masked), links validate entities', async () => {
  const admin = h.makeAdmin('embed-admin@test.local');
  const e = h.makeEntity('EmbLink Co', 'emblink-org');
  const r = await app.req('PUT', '/api/admin/owl-embed', {
    as: admin,
    body: { enabled: true, secret: 'super-secret-value', links: [{ orgId: 'org-1', entityId: e.id }, { orgId: 'org-2', entityId: 'no-such-entity' }, { orgId: 'org-1', entityId: e.id }] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, true);
  assert.equal(r.body.secretSet, true);
  assert.ok(!JSON.stringify(r.body).includes('super-secret-value'), 'secret value must never be echoed');
  assert.match(r.body.secretHint, /alue$/); // last-4 mask
  assert.deepEqual(r.body.links.map((l) => l.orgId), ['org-1']); // unknown entity + duplicate org dropped
  assert.equal(r.body.links[0].entityName, 'EmbLink Co');
});

test('session handshake: secret required, enable switch enforced, unknown org 404s', async () => {
  const e = h.makeEntity('EmbGate Co', 'embgate-org');
  linkOrg('howler-9', e.id);
  assert.equal((await app.req('POST', '/api/embed/owl/session', { body: { orgId: 'howler-9', email: 'a@b.co' } })).status, 401);
  assert.equal((await mint({ orgId: 'howler-9', email: 'a@b.co' }, 'wrong-secret')).status, 401);
  h.db.setSetting('owl_embed_enabled', '0');
  assert.equal((await mint({ orgId: 'howler-9', email: 'a@b.co' })).status, 403);
  h.db.setSetting('owl_embed_enabled', '1');
  assert.equal((await mint({ orgId: 'unlinked-org', email: 'a@b.co' })).status, 404);
  assert.equal((await mint({ orgId: 'howler-9', email: 'not-an-email' })).status, 400);
});

test('happy path: JIT shadow user, entity-pinned, portal-tagged, working bearer token', async () => {
  const e = h.makeEntity('EmbHappy Co', 'embhappy-org');
  linkOrg('howler-42', e.id);
  const r = await mint({ orgId: 'howler-42', email: 'Jane@FestCo.com', firstName: 'Jane', lastName: 'Doe' });
  assert.equal(r.status, 200);
  assert.match(r.body.url, /\/embed\/owl#token=/);
  assert.equal(r.body.entity.id, e.id);

  const u = h.db.getUserByEmail('jane@festco.com');
  assert.ok(u, 'shadow user provisioned');
  assert.equal(u.role, 'client');
  assert.deepEqual(u.entityIds, [e.id]);
  assert.ok(u.roles.includes('portal'));
  assert.equal(u.firstName, 'Jane');

  // The token authenticates cookie-free API calls as that user (req.embedAuth set).
  const who = await app.req('GET', '/api/test/whoami', { headers: { Authorization: `Bearer ${r.body.token}` } });
  assert.equal(who.status, 200);
  assert.equal(who.body.id, u.id);
  assert.deepEqual(who.body.entityIds, [e.id]);
  assert.equal(who.body.embed, true);

  // Second mint reuses the same user — no duplicates.
  assert.equal((await mint({ orgId: 'howler-42', email: 'jane@festco.com' })).status, 200);
  assert.equal(h.db.listUsers().filter((x) => x.email === 'jane@festco.com').length, 1);
});

test('never widens an existing account: admin emails and other clients are refused', async () => {
  const e = h.makeEntity('EmbSafe Co', 'embsafe-org');
  linkOrg('howler-7', e.id);
  h.makeAdmin('boss@howler.co.za');
  assert.equal((await mint({ orgId: 'howler-7', email: 'boss@howler.co.za' })).status, 409);

  const other = h.makeEntity('Other Co', 'other-org');
  h.makeClient('rival@fest.co', [other.id], 'owner');
  assert.equal((await mint({ orgId: 'howler-7', email: 'rival@fest.co' })).status, 409);

  // An existing client OF THIS entity is reused and gains the portal tag.
  const same = h.makeClient('member@fest.co', [e.id], 'owner');
  const r = await mint({ orgId: 'howler-7', email: 'member@fest.co' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.id, same.id);
  assert.ok(h.db.getUser(same.id).roles.includes('portal'));
});

test('a random/garbage bearer never authenticates, and API-key-shaped bearers pass through', async () => {
  for (const bad of ['pulse_sk_abc123', 'nonsense', crypto.randomBytes(24).toString('base64url'), 'a.b.c']) {
    const r = await app.req('GET', '/api/test/whoami', { headers: { Authorization: `Bearer ${bad}` } });
    assert.equal(r.status, 401, `bearer "${bad.slice(0, 12)}…" must not authenticate`);
  }
});

test('portal-tagged users pass the Owl allowlist gate', () => {
  const { owlAllowed } = require('../server/owlChat');
  assert.equal(owlAllowed({ email: 'someone@fest.co', roles: ['portal'] }), true);
  assert.equal(owlAllowed({ email: 'someone@fest.co', roles: [] }), false);
});
