// Unit pins for the extracted query/scope engine (server/query.js) — the
// security-critical surface that index.js's /api/run-query, /api/drill, digests
// and briefings all funnel through. The extraction is behaviour-preserving only
// if applyScope still forces the organiser lock and fails closed; these lock that.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Seed a shared org-scoped dashboard so auth.scopeForQuery can resolve the
// organiser field from saved dashboards without calling Looker (same trick as
// scope.test.js).
before(() => { h.seedOrganiserDashboard({ model: 'ticketing', explore: 'core' }); });

function makeEngine(lookerStub) {
  return require('../server/query')({
    looker: lookerStub || { lookerRequest: async () => ({ ok: true }) },
    auth: h.auth,
  });
}

test('applyScope forces a client to their own organiser scope', async () => {
  const q = makeEngine();
  const ent = h.makeEntity('Q Co', 'Q-org');
  const user = h.makeClient('q@test.local', [ent.id]);
  const query = { model: 'ticketing', view: 'core', fields: ['core.count'], filters: {} };
  assert.equal(await q.applyScope(query, user), true);
  assert.equal(query.filters[h.ORG_FIELD], 'Q-org');
});

test('applyScope fails CLOSED (false) when no organiser is configured', async () => {
  const q = makeEngine();
  const user = h.makeClient('ns@test.local', [h.makeEntity('NoScope', null).id]);
  const query = { model: 'ticketing', view: 'core', fields: ['core.count'] };
  assert.equal(await q.applyScope(query, user), false);
});

test('applyScope leaves an admin unscoped', async () => {
  const q = makeEngine();
  const admin = h.makeAdmin('q-admin@test.local');
  const query = { model: 'ticketing', view: 'core', fields: ['core.count'], filters: {} };
  assert.equal(await q.applyScope(query, admin), true);
  assert.equal(query.filters[h.ORG_FIELD], undefined); // unscoped
});

test('stripAnyValue drops only the ANY_VALUE sentinel', () => {
  const q = makeEngine();
  assert.deepEqual(q.stripAnyValue({ a: '1', b: q.ANY_VALUE, c: '' }), { a: '1', c: '' });
});

test('runLookerQuery caches by path+body; force bypasses the cache', async () => {
  let calls = 0;
  const q = makeEngine({ lookerRequest: async () => { calls += 1; return { n: calls }; } });
  const body = { model: 'm', fields: ['x'] };
  const a = await q.runLookerQuery('/queries/run/json_detail', body);
  const b = await q.runLookerQuery('/queries/run/json_detail', body); // identical → cached
  assert.equal(calls, 1, 'second identical query served from cache');
  assert.deepEqual(a, b);
  await q.runLookerQuery('/queries/run/json_detail', body, undefined, true); // force
  assert.equal(calls, 2, 'force skips the cache and re-fetches');
});

test('primaryTileValue shows the number the tile DISPLAYS, not the first raw field', () => {
  const q = makeEngine();
  // A "New Customers" tile: a hidden raw count + a visible % table-calc (rendered
  // "64%", stored as the ratio 0.64). The dashboard shows 64%.
  const data = {
    fields: { measures: [{ name: 'orders.new_customers' }], table_calculations: [{ name: 'new_pct' }], dimensions: [] },
    data: [{ 'orders.new_customers': { value: 20976, rendered: '20,976' }, new_pct: { value: 0.64, rendered: '64%' } }],
    pivots: [],
  };
  // Looker hides the raw count → the goal must read 64 (the rendered %), not 20976.
  assert.equal(q.primaryTileValue(data, { hidden_fields: ['orders.new_customers'] }), 64);
  // With nothing hidden, the first visible measure leads.
  assert.equal(q.primaryTileValue(data, {}), 20976);
});

test('primaryTileValue parses currency, thousands and magnitude suffixes from the rendered value', () => {
  const q = makeEngine();
  const mk = (rendered, value) => ({ fields: { measures: [{ name: 'm' }] }, data: [{ m: { value, rendered } }], pivots: [] });
  assert.equal(q.primaryTileValue(mk('R20,976', 20976), {}), 20976);
  assert.equal(q.primaryTileValue(mk('R1.2M', 1200000), {}), 1200000);
  assert.equal(q.primaryTileValue(mk('', 4200), {}), 4200); // no rendered → fall back to the raw value
});

test('tileQueryBody scopes the body, and returns null when scope is denied', async () => {
  const q = makeEngine();
  const user = h.makeClient('tile@test.local', [h.makeEntity('Tile Co', 'Tile-org').id]);
  const def = { filters: [] };
  const tile = { type: 'vis', query: { model: 'ticketing', view: 'core', fields: ['core.count'], filters: {} } };
  const body = await q.tileQueryBody(tile, def, user, undefined);
  assert.ok(body, 'builds a body for a scoped user');
  assert.equal(body.filters[h.ORG_FIELD], 'Tile-org');
  // A user with no organiser configured → scope denied → null (tile renders nothing).
  const user2 = h.makeClient('tile2@test.local', [h.makeEntity('NoScope2', null).id]);
  assert.equal(await q.tileQueryBody(tile, def, user2, undefined), null);
});

test('tileQueryBody applies a hand-added (custom-field) lock the tile isn\'t wired to, matching the live report', async () => {
  const q = makeEngine();
  const user = h.makeClient('mlock@test.local', [h.makeEntity('MonthLock Co', 'ML-org').id]);
  // A hand-added "custom field" filter (no Looker model/explore, so no tile listenTo
  // wiring) locked to July — exactly the Start/Purchased Month Name locks in the UI.
  const def = { filters: [{ name: 'Start Month Name', field: 'core.start_month_name' }] };
  const lockMap = { 'Start Month Name': 'July' };
  // Tile whose query joins the 'core' view → the month field is filterable, so the
  // lock must apply even without listenTo (mirrors client useTileData field-match).
  const tile = { type: 'vis', query: { model: 'ticketing', view: 'core', fields: ['core.count'], filters: {} } };
  const body = await q.tileQueryBody(tile, def, user, undefined, lockMap);
  assert.equal(body.filters['core.start_month_name'], 'July', 'month lock reaches the tile query server-side');
  assert.equal(body.filters[h.ORG_FIELD], 'ML-org', 'organiser scope still forced');

  // A lock whose field lives in a view the tile's query does NOT join must NOT apply
  // (you can't filter a field the query doesn't select) — same guard the client uses.
  const otherViewDef = { filters: [{ name: 'Start Month Name', field: 'payments.start_month_name' }] };
  const otherBody = await q.tileQueryBody(tile, otherViewDef, user, undefined, lockMap);
  assert.equal(otherBody.filters['payments.start_month_name'], undefined, 'a lock never touches a query that doesn\'t join its view');

  // A Looker-wired filter (model/explore) stays listenTo-only — no field-match fallback.
  const wiredDef = { filters: [{ name: 'Month', field: 'core.month', model: 'ticketing', explore: 'core' }] };
  const wiredBody = await q.tileQueryBody(tile, wiredDef, user, undefined, { Month: 'July' });
  assert.equal(wiredBody.filters['core.month'], undefined, 'wired filters are not auto-applied by view match (listenTo only)');
});

test('oversized results (campaign audiences) are served but never cached', async () => {
  // A 50k-row audience pull is ~25-100 MB parsed — caching a handful of those
  // OOMs the 512 MB instance. Rows > QCACHE_MAX_ROWS must bypass the cache;
  // small results still cache (second call = no Looker hit).
  let calls = 0;
  const bigRows = Array.from({ length: 2001 }, (_, i) => ({ n: i }));
  const q = makeEngine({ lookerRequest: async (m, p) => { calls++; return { data: p.includes('big') ? bigRows : [{ n: 1 }] }; } });

  await q.runLookerQuery('/big', { q: 1 });
  await q.runLookerQuery('/big', { q: 1 });
  assert.equal(calls, 2); // no cache hit — refetched

  await q.runLookerQuery('/small', { q: 1 });
  await q.runLookerQuery('/small', { q: 1 });
  assert.equal(calls, 3); // cached — one Looker call
});
