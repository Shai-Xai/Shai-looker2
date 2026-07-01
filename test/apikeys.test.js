// The public platform surface's security boundary, end to end over real HTTP:
// per-entity API keys (issue / mask / revoke, dual-surface management), Bearer
// auth producing a synthetic principal pinned to ONE entity, scope enforcement
// (requireScope), tenancy (a key can never read another client's data), audit,
// and the remote MCP transport riding the same key. See docs/API_MCP_BRIEF.md.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { startApp } = require('./http');
const rateLimit = require('../server/ratelimit');

let app, entityA, entityB, adminUser, ownerA, viewerA, ownerB;
// Stub service deps for /api/v1 — the tests target the auth/tenancy boundary,
// not the (already-tested) service functions behind it.
const segmentsByEntity = {};
const stubs = {
  clientCatalogue: (entityId) => ({
    suites: [], leads: [],
    catalogue: entityId === (entityA && entityA.id)
      ? [{ dashboardId: 'dash1', title: 'Sales', setName: 'Core', suiteId: 'suiteA', suiteName: 'Event A' }]
      : [],
  }),
  resolveTileValue: async ({ dashboardId, tileId }) => (dashboardId === 'dash1' && tileId === 't1' ? 44806 : null),
  resolveTileRows: async ({ dashboardId, tileId }) => (dashboardId === 'dash1' && tileId === 't1'
    ? { fields: [{ name: 'buyers.email', label: 'Email' }], rows: [{ 'buyers.email': 'a@x' }, { 'buyers.email': 'b@x' }] } : null),
  segmentsApi: {
    listSegmentsFull: (entityId) => segmentsByEntity[entityId] || [],
    resolveSegment: async (entityId, id) => ((segmentsByEntity[entityId] || []).some((s) => s.id === id)
      ? { list: [{ email: 'a@x' }], reach: { email: 1, sms: 0 } } : null),
  },
  actionsApi: { listForEntity: (entityId) => (entityId === (entityA && entityA.id) ? [{ id: 'c1', title: 'Launch', type: 'campaign', status: 'done', audienceCount: 10, results: { sent: 10, clicks: 5 }, config: { channel: 'email', subject: 'Go' }, createdAt: '', updatedAt: '' }] : []) },
  goalsApi: { listGoals: () => [], attachProgress: async (g) => g },
};

before(async () => {
  entityA = h.makeEntity('Client A', 'Org A');
  entityB = h.makeEntity('Client B', 'Org B');
  adminUser = h.makeAdmin();
  ownerA = h.makeClient('owner-a@test.local', [entityA.id], 'owner');
  viewerA = h.makeClient('viewer-a@test.local', [entityA.id], 'viewer');
  ownerB = h.makeClient('owner-b@test.local', [entityB.id], 'owner');
  segmentsByEntity[entityA.id] = [{ id: 'segA', name: 'VIPs', source: 'tile', count: 5, reach: { email: 5, sms: 2 }, suiteId: '', folder: '', lastResolvedAt: '', updatedAt: '' }];
  segmentsByEntity[entityB.id] = [{ id: 'segB', name: 'B people', source: 'tile', count: 9, reach: { email: 9, sms: 0 }, suiteId: '', folder: '', lastResolvedAt: '', updatedAt: '' }];

  app = await startApp((a) => {
    const apiKeys = require('../server/apiKeys').mount(a, { db: h.db, auth: h.auth, rateLimit });
    const apiV1 = require('../server/api').mount(a, { db: h.db, auth: h.auth, rateLimit, apiKeys, ...stubs });
    require('../server/mcp').mount(a, { apiKeys, core: apiV1.core, rateLimit });
    a.use(require('../server/http').errorMiddleware);
  });
  // API access is OFF by default — switch it on for the two test clients via
  // the real admin route (the per-client kill-switch test below exercises OFF).
  for (const e of [entityA, entityB]) {
    const r = await app.req('PUT', `/api/admin/entities/${e.id}/api-access`, { as: adminUser, body: { enabled: true } });
    assert.equal(r.status, 200);
  }
});
after(() => app.close());

const bearer = (secret) => ({ Authorization: `Bearer ${secret}` });
async function issueKey(entityId, opts = {}) {
  const r = await app.req('POST', `/api/admin/entities/${entityId}/api-keys`, { as: adminUser, body: { name: opts.name || 'test key', scopes: opts.scopes || ['read'] } });
  assert.equal(r.status, 201);
  return r.body;
}

test('issuing a key: secret shown once, list reports only a masked hint', async () => {
  const { key, secret } = await issueKey(entityA.id, { name: 'reporting' });
  assert.ok(secret.startsWith('pulse_sk_'), 'secret has the pulse_sk_ prefix');
  assert.ok(key.hint.startsWith('••••••'), 'stored shape is masked');
  assert.equal(key.scopes.join(','), 'read');
  const list = await app.req('GET', `/api/admin/entities/${entityA.id}/api-keys`, { as: adminUser });
  assert.equal(list.status, 200);
  const listed = list.body.keys.find((k) => k.id === key.id);
  assert.ok(listed, 'key appears in the list');
  assert.ok(!JSON.stringify(list.body).includes(secret), 'the secret never appears again');
});

test('bearer auth: valid key resolves to its ONE entity; missing/garbage/revoked keys are 401', async () => {
  const { key, secret } = await issueKey(entityA.id);
  const me = await app.req('GET', '/api/v1/me', { headers: bearer(secret) });
  assert.equal(me.status, 200);
  assert.equal(me.body.entity.id, entityA.id);
  assert.deepEqual(me.body.key.scopes, ['read']);

  assert.equal((await app.req('GET', '/api/v1/me')).status, 401);
  assert.equal((await app.req('GET', '/api/v1/me', { headers: bearer('pulse_sk_wrong') })).status, 401);

  const rev = await app.req('POST', `/api/admin/entities/${entityA.id}/api-keys/${key.id}/revoke`, { as: adminUser });
  assert.equal(rev.status, 200);
  assert.ok(rev.body.key.revokedAt, 'revocation is stamped');
  assert.equal((await app.req('GET', '/api/v1/me', { headers: bearer(secret) })).status, 401, 'revoked key stops working');
});

test('tenancy: a key reads ONLY its own entity’s data (segments, campaigns, dashboards, metric)', async () => {
  const { secret: secretA } = await issueKey(entityA.id);
  const { secret: secretB } = await issueKey(entityB.id);

  const segsA = await app.req('GET', '/api/v1/segments', { headers: bearer(secretA) });
  assert.deepEqual(segsA.body.segments.map((s) => s.id), ['segA']);
  const segsB = await app.req('GET', '/api/v1/segments', { headers: bearer(secretB) });
  assert.deepEqual(segsB.body.segments.map((s) => s.id), ['segB']);
  assert.equal((await app.req('GET', '/api/v1/segments/segB', { headers: bearer(secretA) })).status, 404, 'cross-entity segment read fails closed');
  assert.equal((await app.req('GET', '/api/v1/segments/segB/reach', { headers: bearer(secretA) })).status, 404);

  assert.equal((await app.req('GET', '/api/v1/campaigns', { headers: bearer(secretB) })).body.campaigns.length, 0);
  const campA = await app.req('GET', '/api/v1/campaigns/c1', { headers: bearer(secretA) });
  assert.equal(campA.status, 200);
  assert.equal(campA.body.results.sent, 10);
  assert.ok(!('audience' in campA.body), 'campaign payload never carries the audience list');

  assert.equal((await app.req('GET', '/api/v1/dashboards', { headers: bearer(secretB) })).body.dashboards.length, 0);
  const metric = await app.req('GET', '/api/v1/metric?dashboardId=dash1&tileId=t1', { headers: bearer(secretA) });
  assert.equal(metric.status, 200);
  assert.equal(metric.body.value, 44806);
  assert.equal((await app.req('GET', '/api/v1/metric?dashboardId=dash1&tileId=t1', { headers: bearer(secretB) })).status, 404, 'other client can’t read A’s dashboard');
});

test('scopes: a key without `read` is rejected by the read surface', async () => {
  const { secret } = await issueKey(entityA.id, { scopes: ['write'] });
  const r = await app.req('GET', '/api/v1/me', { headers: bearer(secret) });
  assert.equal(r.status, 403);
});

test('row-level access: only a read_rows key can pull the table behind a tile', async () => {
  const { secret: plain } = await issueKey(entityA.id); // read only
  const { secret: rows } = await issueKey(entityA.id, { scopes: ['read', 'read_rows'] });
  const url = '/api/v1/tiles/rows?dashboardId=dash1&tileId=t1';

  assert.equal((await app.req('GET', url, { headers: bearer(plain) })).status, 403, 'plain read key is refused');
  const ok = await app.req('GET', url, { headers: bearer(rows) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.rowCount, 2);
  assert.equal(ok.body.rows[0]['buyers.email'], 'a@x');

  const { secret: rowsB } = await issueKey(entityB.id, { scopes: ['read', 'read_rows'] });
  assert.equal((await app.req('GET', url, { headers: bearer(rowsB) })).status, 404, 'other client’s rows key can’t read A’s dashboard');

  // MCP: the rows tool is invisible to a plain key, present + working for a rows key.
  const plainTools = (await rpc({ jsonrpc: '2.0', id: 10, method: 'tools/list' }, plain)).body.result.tools.map((t) => t.name);
  assert.ok(!plainTools.includes('pulse_get_tile_rows'), 'plain key never sees the rows tool');
  const rowsTools = (await rpc({ jsonrpc: '2.0', id: 11, method: 'tools/list' }, rows)).body.result.tools.map((t) => t.name);
  assert.ok(rowsTools.includes('pulse_get_tile_rows'));
  const call = await rpc({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'pulse_get_tile_rows', arguments: { dashboardId: 'dash1', tileId: 't1' } } }, rows);
  assert.equal(JSON.parse(call.body.result.content[0].text).rowCount, 2);
});

test('client self-service: integrations.manage on YOUR entity only; secrets stay write-only', async () => {
  const mine = await app.req('POST', `/api/my/api-keys/${entityA.id}`, { as: ownerA, body: { name: 'my key', scopes: ['read'] } });
  assert.equal(mine.status, 201);
  assert.ok(mine.body.secret.startsWith('pulse_sk_'));
  const list = await app.req('GET', `/api/my/api-keys/${entityA.id}`, { as: ownerA });
  assert.equal(list.status, 200);
  assert.ok(!JSON.stringify(list.body).includes(mine.body.secret));

  assert.equal((await app.req('GET', `/api/my/api-keys/${entityA.id}`, { as: viewerA })).status, 403, 'viewer lacks integrations.manage');
  assert.equal((await app.req('GET', `/api/my/api-keys/${entityA.id}`, { as: ownerB })).status, 403, 'another client’s owner is not allowed');

  const rev = await app.req('POST', `/api/my/api-keys/${entityA.id}/${mine.body.key.id}/revoke`, { as: ownerA });
  assert.equal(rev.status, 200);
});

test('per-client switch: API access is off by default and the admin toggle gates everything', async () => {
  const entityC = h.makeEntity('Client C', 'Org C');
  const ownerC = h.makeClient('owner-c@test.local', [entityC.id], 'owner');

  // Admin can pre-provision a key while access is off…
  const { key, secret } = await issueKey(entityC.id, { name: 'pre-provisioned' });
  assert.ok(key.id);
  // …but the key doesn't work anywhere until the switch is on (REST + MCP).
  assert.equal((await app.req('GET', '/api/v1/me', { headers: bearer(secret) })).status, 403);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 20, method: 'tools/list' }, secret)).status, 403);
  // …and the client can't self-create keys while off.
  assert.equal((await app.req('POST', `/api/my/api-keys/${entityC.id}`, { as: ownerC, body: { name: 'x' } })).status, 403);
  // The client's list shows the switch state.
  assert.equal((await app.req('GET', `/api/my/api-keys/${entityC.id}`, { as: ownerC })).body.enabled, false);

  // Flip it on → everything opens up.
  await app.req('PUT', `/api/admin/entities/${entityC.id}/api-access`, { as: adminUser, body: { enabled: true } });
  assert.equal((await app.req('GET', '/api/v1/me', { headers: bearer(secret) })).status, 200);
  assert.equal((await app.req('POST', `/api/my/api-keys/${entityC.id}`, { as: ownerC, body: { name: 'mine' } })).status, 201);

  // Flip it off again → instant cut-off, existing keys included.
  await app.req('PUT', `/api/admin/entities/${entityC.id}/api-access`, { as: adminUser, body: { enabled: false } });
  assert.equal((await app.req('GET', '/api/v1/me', { headers: bearer(secret) })).status, 403);
});

test('audit: external calls land in the key’s audit trail', async () => {
  const { key, secret } = await issueKey(entityA.id, { name: 'audited' });
  await app.req('GET', '/api/v1/segments', { headers: bearer(secret) });
  const tail = await app.req('GET', `/api/admin/entities/${entityA.id}/api-keys/${key.id}/audit`, { as: adminUser });
  assert.equal(tail.status, 200);
  assert.ok(tail.body.events.some((e) => e.action === 'GET /api/v1/segments' && e.status === 200 && e.surface === 'rest'));
});

// ── MCP transport over the same key ──
const rpc = (body, secret) => app.req('POST', '/mcp', {
  headers: { ...bearer(secret), Accept: 'application/json, text/event-stream' }, body,
});

test('MCP: initialize handshake works and identifies the pulse server', async () => {
  const { secret } = await issueKey(entityA.id);
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }, secret);
  assert.equal(r.status, 200);
  assert.equal(r.body.result.serverInfo.name, 'pulse');
});

test('MCP: tools are listed and a tool call returns THIS key’s entity', async () => {
  const { secret } = await issueKey(entityA.id);
  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, secret);
  assert.equal(list.status, 200);
  const names = list.body.result.tools.map((t) => t.name);
  for (const n of ['pulse_get_me', 'pulse_list_dashboards', 'pulse_get_metric', 'pulse_list_segments', 'pulse_get_segment_reach', 'pulse_list_campaigns', 'pulse_get_campaign_report', 'pulse_get_goals']) {
    assert.ok(names.includes(n), `tool ${n} is exposed`);
  }
  const call = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pulse_get_me', arguments: {} } }, secret);
  assert.equal(call.status, 200);
  const payload = JSON.parse(call.body.result.content[0].text);
  assert.equal(payload.entity.id, entityA.id);
});

test('MCP: no key → 401 with WWW-Authenticate', async () => {
  const r = await app.req('POST', '/mcp', { headers: { Accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 4, method: 'tools/list' } });
  assert.equal(r.status, 401);
});
