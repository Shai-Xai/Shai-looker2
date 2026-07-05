// Lineup (artist/set schedule) — config store: [{ day, stage, artist, start, end }]
// per event, admin + my-scope routes with entity ownership. Handlers invoked directly.

const test = require('node:test');
const assert = require('node:assert');
const { db, auth, makeEntity, makeClient, makeAdmin } = require('./helpers');
const lineup = require('../server/lineup');

function mount() {
  const routes = {};
  const reg = (m) => (p, ...h) => { routes[`${m} ${p}`] = h[h.length - 1]; };
  const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE') };
  lineup.mount(app, { db, auth });
  return routes;
}
function call(handler, { user, params = {}, body = {}, query = {} } = {}) {
  let code = 200, payload;
  const res = { status(c) { code = c; return res; }, json(d) { payload = d; return res; } };
  handler({ user, params, body, query }, res);
  return { code, body: payload };
}

const routes = mount();
const entity = makeEntity('LineCo', 'lineco');
const suite = db.createSuite({ entityId: entity.id, name: 'Line Fest' });
const owner = makeClient('owner@lineco.test', [entity.id]);
const other = makeClient('other@otherco2.test', [makeEntity('OtherCo2', 'otherco2').id]);
const admin = makeAdmin();

test('empty lineup comes back as an empty list', () => {
  const r = call(routes['GET /api/my/lineup/:suiteId'], { user: owner, params: { suiteId: suite.id } });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.sets, []);
});

test('owner saves sets; junk rows dropped, fields trimmed/clamped', () => {
  const r = call(routes['PUT /api/my/lineup/:suiteId'], {
    user: owner, params: { suiteId: suite.id },
    body: { sets: [
      { day: '2026-07-05', stage: 'Main', artist: 'Charlotte de Witte', start: '23:00', end: '00:30' },
      { day: '2026-07-05', stage: 'Solar', artist: '  Amelie Lens ', start: '21:00', end: '' },
      { artist: 'No start time', start: 'nope' },      // invalid start → dropped
      { artist: '', start: '20:00' },                    // no artist → dropped
      { day: '2026-07-05', stage: 'Solar', artist: 'Bad end kept as blank', start: '19:00', end: '99:99' },
    ] },
  });
  assert.equal(r.code, 200);
  assert.equal(r.body.sets.length, 3);
  assert.deepEqual(r.body.sets[0], { day: '2026-07-05', stage: 'Main', artist: 'Charlotte de Witte', start: '23:00', end: '00:30' });
  assert.equal(r.body.sets[1].artist, 'Amelie Lens'); // trimmed
  assert.equal(r.body.sets[1].end, '');
  assert.equal(r.body.sets[2].end, ''); // invalid end coerced to blank, row kept
});

test('a non-array sets payload is rejected', () => {
  const r = call(routes['PUT /api/admin/lineup/:suiteId'], { user: admin, params: { suiteId: suite.id }, body: { sets: 'nope' } });
  assert.equal(r.code, 400);
});

test('admin can read any event; saved sets persist across reads', () => {
  const r = call(routes['GET /api/admin/lineup/:suiteId'], { user: admin, params: { suiteId: suite.id } });
  assert.equal(r.code, 200);
  assert.equal(r.body.sets.length, 3);
});

test('an outsider cannot read or write another client\'s lineup', () => {
  const g = call(routes['GET /api/my/lineup/:suiteId'], { user: other, params: { suiteId: suite.id } });
  assert.equal(g.code, 403);
  const p = call(routes['PUT /api/my/lineup/:suiteId'], { user: other, params: { suiteId: suite.id }, body: { sets: [] } });
  assert.equal(p.code, 403);
});
