// People flow — aggregate crowd movement from wristband taps. Pure buildFlow logic
// + the my/admin routes with entity ownership (queryData stubbed).

const test = require('node:test');
const assert = require('node:assert');
const { db, auth, makeEntity, makeClient, makeAdmin } = require('./helpers');
const peopleFlow = require('../server/peopleFlow');

const F = { g: 'cashless_open_loop_sales.customer_gtag_id', s: 'cashless_open_loop_sales.station_name', b: 'cashless_open_loop_sales.date_minute10', h: 'cashless_open_loop_sales.date_hour_of_day', c: 'cashless_open_loop_sales.transaction_count' };
const row = (g, s, b) => ({ [F.g]: g, [F.s]: s, [F.b]: b, [F.c]: 1 });
const SAMPLE = [
  row(1, 'Gate A', '2026-07-05 18:00'), row(1, 'Nova Bar', '2026-07-05 18:20'), row(1, 'Nova Bar', '2026-07-05 18:30'), row(1, 'Kosmo Bar', '2026-07-05 19:10'),
  row(2, 'Gate A', '2026-07-05 18:05'), row(2, 'Nova Bar', '2026-07-05 18:40'),
  row(3, 'Nova Bar', '2026-07-05 20:00'), row(3, 'Gate B', '2026-07-05 18:10'), row(3, 'Kosmo Bar', '2026-07-05 19:00'),
  row(99, 'Nova Bar', '2026-07-05 15:00'), row(99, 'Nova Bar', '2026-07-05 22:00'), // operator tag → filtered
];

test('buildFlow: sorts taps, collapses repeats, filters single-station tags', () => {
  const f = peopleFlow.buildFlow(SAMPLE);
  assert.equal(f.journeys, 3); // operator tag 99 excluded
  const edge = (from, to) => (f.edges.find((e) => e.from === from && e.to === to) || {}).count || 0;
  assert.equal(edge('Gate A', 'Nova Bar'), 2);
  assert.equal(edge('Kosmo Bar', 'Nova Bar'), 1); // out-of-order rows sorted right
  assert.equal(edge('Gate B', 'Kosmo Bar'), 1);
  assert.deepEqual(f.entries[0], { station: 'Gate A', count: 2 }); // busiest entry point
});

test('buildFlow: empty input is safe', () => {
  const f = peopleFlow.buildFlow([]);
  assert.equal(f.journeys, 0);
  assert.deepEqual(f.edges, []);
});

function mount(queryData) {
  const routes = {};
  const reg = (m) => (p, ...h) => { routes[`${m} ${p}`] = h[h.length - 1]; };
  const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT') };
  peopleFlow.mount(app, { db, auth, queryData });
  return routes;
}
function call(handler, { user, params = {} } = {}) {
  return new Promise((resolve) => {
    let code = 200; const res = { status(c) { code = c; return res; }, json(d) { resolve({ code, body: d }); return res; } };
    handler({ user, params }, res);
  });
}

const entity = makeEntity('FlowCo', 'flowco');
const suite = db.createSuite({ entityId: entity.id, name: 'Flow Fest' });
const owner = makeClient('owner@flowco.test', [entity.id]);
const other = makeClient('other@nope.test', [makeEntity('Nope', 'nope').id]);
const admin = makeAdmin();

test('owner gets the aggregate flow + per-window frames; scoped to the suite', async () => {
  let sawSuite = null;
  const qd = async (user, args) => {
    sawSuite = args.suiteId;
    if ((args.dimensions || []).length === 1 && args.dimensions[0] === F.h) return { rows: [{ [F.h]: 18 }, { [F.h]: 19 }, { [F.h]: 20 }] };
    return { rows: SAMPLE };
  };
  const routes = mount(qd);
  const r = await call(routes['GET /api/my/people-flow/:suiteId'], { user: owner, params: { suiteId: suite.id } });
  assert.equal(r.code, 200);
  assert.equal(r.body.journeys, 3); // overall (windows merged)
  assert.equal(r.body.frames.length, 3); // one frame per active hour
  assert.equal(r.body.frames[0].label, '18:00–19:00');
  assert.equal(sawSuite, suite.id);
});

test('an outsider is refused', async () => {
  const routes = mount(async () => ({ rows: [] }));
  const r = await call(routes['GET /api/my/people-flow/:suiteId'], { user: other, params: { suiteId: suite.id } });
  assert.equal(r.code, 403);
});
