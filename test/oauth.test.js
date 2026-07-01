// The MCP "Connect" flow end to end: OAuth discovery → dynamic client
// registration → a logged-in Pulse user approves on /oauth/authorize → the
// PKCE-verified token exchange hands back a real API key → that key works on
// the read surface. Plus the failure modes that keep it safe (bad verifier,
// reused code, unregistered redirect, disabled client).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const h = require('./helpers');
const { startApp, cookieFor } = require('./http');
const rateLimit = require('../server/ratelimit');

let app, entityA, adminUser, ownerA;
const stubs = {
  clientCatalogue: () => ({ suites: [], leads: [], catalogue: [] }),
  resolveTileValue: async () => null,
  resolveTileRows: async () => null,
  segmentsApi: { listSegmentsFull: () => [], resolveSegment: async () => null },
  actionsApi: { listForEntity: () => [] },
  goalsApi: { listGoals: () => [], attachProgress: async (g) => g },
};

before(async () => {
  entityA = h.makeEntity('OAuth Fest', 'Org OAuth');
  adminUser = h.makeAdmin('admin-oauth@test.local');
  ownerA = h.makeClient('owner-oauth@test.local', [entityA.id], 'owner');
  app = await startApp((a) => {
    const apiKeys = require('../server/apiKeys').mount(a, { db: h.db, auth: h.auth, rateLimit });
    require('../server/api').mount(a, { db: h.db, auth: h.auth, rateLimit, apiKeys, ...stubs });
    require('../server/oauth').mount(a, { db: h.db, auth: h.auth, apiKeys, rateLimit });
    a.use(require('../server/http').errorMiddleware);
  });
  await app.req('PUT', `/api/admin/entities/${entityA.id}/api-access`, { as: adminUser, body: { enabled: true } });
});
after(() => app.close());

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
async function registerClient() {
  const r = await app.req('POST', '/oauth/register', { body: { client_name: 'Claude', redirect_uris: [REDIRECT] } });
  assert.equal(r.status, 201);
  assert.ok(r.body.client_id);
  return r.body.client_id;
}
const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};
// Drive the approve form like the browser would (cookie-authed POST, no redirect-follow).
async function approve(clientId, challenge, { entityId = entityA.id, rows = false, as = ownerA } = {}) {
  const form = new URLSearchParams({
    client_id: clientId, redirect_uri: REDIRECT, state: 'st4te', code_challenge: challenge,
    code_challenge_method: 'S256', entityId, ...(rows ? { rows: '1' } : {}),
  });
  return fetch(`${app.base}/oauth/approve`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieFor(as) },
    body: form.toString(),
  });
}
async function exchange(clientId, code, verifier) {
  return fetch(`${app.base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId }).toString(),
  });
}

test('discovery documents point an MCP client at the flow', async () => {
  const prm = await app.req('GET', '/.well-known/oauth-protected-resource/mcp');
  assert.equal(prm.status, 200);
  assert.ok(prm.body.resource.endsWith('/mcp'));
  const asm = await app.req('GET', '/.well-known/oauth-authorization-server');
  assert.ok(asm.body.authorization_endpoint.endsWith('/oauth/authorize'));
  assert.ok(asm.body.registration_endpoint.endsWith('/oauth/register'));
  assert.deepEqual(asm.body.code_challenge_methods_supported, ['S256']);
});

test('full connect flow: register → approve → token → the key reads Pulse', async () => {
  const clientId = await registerClient();
  const { verifier, challenge } = pkce();

  // The authorize page renders for a logged-in owner (entity picker present).
  const pageRes = await fetch(`${app.base}/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&state=st4te`, { headers: { Cookie: cookieFor(ownerA) } });
  const html = await pageRes.text();
  assert.ok(html.includes('OAuth Fest'), 'entity appears in the picker');

  const redir = await approve(clientId, challenge);
  assert.equal(redir.status, 302);
  const loc = new URL(redir.headers.get('location'));
  assert.ok(loc.href.startsWith(REDIRECT));
  assert.equal(loc.searchParams.get('state'), 'st4te');
  const code = loc.searchParams.get('code');

  const tok = await exchange(clientId, code, verifier);
  assert.equal(tok.status, 200);
  const body = await tok.json();
  assert.ok(body.access_token.startsWith('pulse_sk_'), 'access token IS a normal API key');

  const me = await app.req('GET', '/api/v1/me', { headers: { Authorization: `Bearer ${body.access_token}` } });
  assert.equal(me.status, 200);
  assert.equal(me.body.entity.id, entityA.id);
  assert.deepEqual(me.body.key.scopes, ['read'], 'rows unticked → read-only key');

  // The minted key shows up on the normal key card (revocable like any other).
  const list = await app.req('GET', `/api/admin/entities/${entityA.id}/api-keys`, { as: adminUser });
  assert.ok(list.body.keys.some((k) => k.name.startsWith('Claude (connected')));

  // Codes are single-use.
  assert.equal((await exchange(clientId, code, verifier)).status, 400);
});

test('PKCE: a wrong verifier is rejected and the code is not burned by the attacker', async () => {
  const clientId = await registerClient();
  const { verifier, challenge } = pkce();
  const code = new URL((await approve(clientId, challenge)).headers.get('location')).searchParams.get('code');
  assert.equal((await exchange(clientId, code, 'wrong-verifier')).status, 400);
  // The legitimate client can still redeem it (bad attempts don't consume it).
  assert.equal((await exchange(clientId, code, verifier)).status, 200);
});

test('unregistered redirect_uri is refused outright', async () => {
  const clientId = await registerClient();
  const { challenge } = pkce();
  const r = await fetch(`${app.base}/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`, { headers: { Cookie: cookieFor(ownerA) } });
  assert.equal(r.status, 400);
});

test('approval respects the per-client switch and entity ownership', async () => {
  const entityOff = h.makeEntity('Switched Off', 'Org Off'); // api access off (default)
  const ownerOff = h.makeClient('owner-off@test.local', [entityOff.id], 'owner');
  const clientId = await registerClient();
  const { challenge } = pkce();
  assert.equal((await approve(clientId, challenge, { entityId: entityOff.id, as: ownerOff })).status, 403, 'disabled client can’t be connected');
  assert.equal((await approve(clientId, challenge, { entityId: entityA.id, as: ownerOff })).status, 403, 'can’t connect someone else’s client');
});

test('rows opt-in on the approval form yields a read_rows key', async () => {
  const clientId = await registerClient();
  const { verifier, challenge } = pkce();
  const code = new URL((await approve(clientId, challenge, { rows: true })).headers.get('location')).searchParams.get('code');
  const body = await (await exchange(clientId, code, verifier)).json();
  const me = await app.req('GET', '/api/v1/me', { headers: { Authorization: `Bearer ${body.access_token}` } });
  assert.deepEqual(me.body.key.scopes, ['read', 'read_rows']);
});
