// Route-level pins for the extracted Inventive module (server/inventive.js).
// Locks the auth gate, the configured-status flag, and the pre-network 400s —
// so the extraction from index.js is provably behaviour-preserving. The external
// getAuthorizedUrl call isn't exercised (no network in tests); we pin everything
// up to that point.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { startApp } = require('./http');

let app;
let homeEntityId = ''; // what the injected homeEntityFor returns (per-test)
before(async () => {
  app = await startApp((expressApp) => {
    require('../server/inventive').mount(expressApp, {
      db: h.db,
      auth: h.auth,
      homeEntityFor: () => homeEntityId,
    });
  });
});
after(async () => { if (app) await app.close(); });
beforeEach(() => {
  homeEntityId = '';
  h.db.setSetting('inventive_api_key', '');
  h.db.setSetting('inventive_embed_auth_token', '');
});

test('both routes require auth', async () => {
  assert.equal((await app.req('GET', '/api/inventive/status')).status, 401);
  assert.equal((await app.req('POST', '/api/inventive/embed-url', { body: {} })).status, 401);
});

test('status reflects whether Inventive keys are configured', async () => {
  const u = h.makeClient('inv@test.local', [h.makeEntity('Inv Co', 'inv-org').id], 'owner');
  assert.equal((await app.req('GET', '/api/inventive/status', { as: u })).body.configured, false);
  h.db.setSetting('inventive_api_key', 'k');
  h.db.setSetting('inventive_embed_auth_token', 't');
  assert.equal((await app.req('GET', '/api/inventive/status', { as: u })).body.configured, true);
});

test('embed-url 400s when unconfigured, and when there is no client context', async () => {
  const u = h.makeClient('inv2@test.local', [h.makeEntity('Inv2 Co', 'inv2-org').id], 'owner');
  // Unconfigured → 400 before any network call.
  let r = await app.req('POST', '/api/inventive/embed-url', { as: u, body: {} });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not configured/i);
  // Configured but no resolvable client context → 400 (still no network call).
  h.db.setSetting('inventive_api_key', 'k');
  h.db.setSetting('inventive_embed_auth_token', 't');
  homeEntityId = '';
  r = await app.req('POST', '/api/inventive/embed-url', { as: u, body: {} });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /client context/i);
});
