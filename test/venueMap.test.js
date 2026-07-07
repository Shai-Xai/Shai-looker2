// Venue map (Signal board 🗺️) — config store: pins + site-plan image per event,
// admin + my-scope routes with entity ownership. Handlers invoked directly.

const test = require('node:test');
const assert = require('node:assert');
const { db, auth, makeEntity, makeClient, makeAdmin } = require('./helpers');
const venueMap = require('../server/venueMap');

function mount() {
  const routes = {};
  const reg = (m) => (p, ...h) => { routes[`${m} ${p}`] = h[h.length - 1]; };
  const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE') };
  venueMap.mount(app, { db, auth });
  return routes;
}
function call(handler, { user, params = {}, body = {}, query = {} } = {}) {
  let code = 200, payload;
  const res = { status(c) { code = c; return res; }, json(d) { payload = d; return res; } };
  handler({ user, params, body, query }, res);
  return { code, body: payload };
}

const routes = mount();
const entity = makeEntity('MapCo', 'mapco');
const suite = db.createSuite({ entityId: entity.id, name: 'Map Fest' });
const owner = makeClient('owner@mapco.test', [entity.id]);
const other = makeClient('other@otherco.test', [makeEntity('OtherCo', 'otherco').id]);
const admin = makeAdmin();

test('empty config comes back with defaults', () => {
  const r = call(routes['GET /api/my/venue-map/:suiteId'], { user: owner, params: { suiteId: suite.id } });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.pins, {});
  assert.equal(r.body.image, '');
});

test('owner saves pins; values are clamped and junk dropped', () => {
  const r = call(routes['PUT /api/my/venue-map/:suiteId'], {
    user: owner, params: { suiteId: suite.id },
    body: { pins: { 'Futur Bar': { x: 0.31, y: 0.62 }, 'Gate A': { x: 4, y: -1 }, '': { x: 0.5, y: 0.5 }, Bad: { x: 'zz', y: 0.1 } } },
  });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.pins['Futur Bar'], { x: 0.31, y: 0.62 });
  assert.deepEqual(r.body.pins['Gate A'], { x: 1, y: 0 });
  assert.equal(Object.keys(r.body.pins).length, 2);
});

test('pins survive an image-only update (partial PUT keeps the other half)', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const r = call(routes['PUT /api/admin/venue-map/:suiteId'], { user: admin, params: { suiteId: suite.id }, body: { image: png } });
  assert.equal(r.body.image, png);
  assert.deepEqual(r.body.pins['Futur Bar'], { x: 0.31, y: 0.62 });
  const r2 = call(routes['PUT /api/admin/venue-map/:suiteId'], { user: admin, params: { suiteId: suite.id }, body: { image: '' } });
  assert.equal(r2.body.image, '');
  assert.deepEqual(r2.body.pins['Futur Bar'], { x: 0.31, y: 0.62 });
});

test('a non-image data URL is rejected', () => {
  const r = call(routes['PUT /api/admin/venue-map/:suiteId'], { user: admin, params: { suiteId: suite.id }, body: { image: 'data:text/html;base64,PGI+' } });
  assert.equal(r.code, 400);
});

test('an outsider cannot read or write another client\'s map', () => {
  const g = call(routes['GET /api/my/venue-map/:suiteId'], { user: other, params: { suiteId: suite.id } });
  assert.equal(g.code, 403);
  const p = call(routes['PUT /api/my/venue-map/:suiteId'], { user: other, params: { suiteId: suite.id }, body: { pins: {} } });
  assert.equal(p.code, 403);
});
