// PostHog app-analytics connector — HogQL escaping, the daily rollup sync (+ its
// never-throw error path), report rollups, entity→event-id scoping (fail closed,
// id locks, name locks resolved via Looker, caching), write-only settings and the
// once-a-day tick guard. PostHog traffic is stubbed via fetchImpl — no network.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const posthog = require('../server/posthog');

test('hqlStr escapes quotes and backslashes (config can never break out of a literal)', () => {
  assert.equal(posthog.hqlStr("o'brien"), "'o\\'brien'");
  assert.equal(posthog.hqlStr('a\\b'), "'a\\\\b'");
  assert.equal(posthog.prop("event'ID"), "properties['event\\'ID']");
});

test('countIn with an empty mapping is a constant 0, never an empty OR', () => {
  assert.equal(posthog.countIn([], 'x'), '0 AS x');
  assert.equal(posthog.countIn(['$screen'], 'views'), "countIf(event = '$screen') AS views");
});

test('property-qualified mapping entries compile to event+property conditions', () => {
  assert.deepEqual(posthog.parseMapEntry('interaction : action=event_view'), { event: 'interaction', prop: 'action', value: 'event_view' });
  assert.deepEqual(posthog.parseMapEntry('$screen'), { event: '$screen' });
  assert.equal(
    posthog.mapCond(['$screen', 'interaction : action=event_view']),
    "event = '$screen' OR (event = 'interaction' AND toString(properties['action']) = 'event_view')",
  );
  // a hostile value still can't break out of the literal
  assert.equal(
    posthog.mapCond(["interaction : a='); DROP--=x"]),
    "(event = 'interaction' AND toString(properties['a']) = '\\'); DROP--=x')",
  );
});

test('nameList splits commas/newlines, trims, dedupes', () => {
  assert.deepEqual(posthog.nameList('a, b\n a,,c'), ['a', 'b', 'c']);
  assert.deepEqual(posthog.nameList(['x', ' x ', '']), ['x']);
});

test('zipRows aligns array rows to columns', () => {
  assert.deepEqual(posthog.zipRows({ columns: ['a', 'b'], results: [[1, 2], [3, 4]] }), [{ a: 1, b: 2 }, { a: 3, b: 4 }]);
  assert.deepEqual(posthog.zipRows(null), []);
});

// ── harness ─────────────────────────────────────────────────────────────────────
const HOGQL = (columns, results) => ({ columns, results });

function makeHarness({ responder, suites = [], locks = {}, dashboards = [], lookerRows = [], configured = true } = {}) {
  const sqlite = new Database(':memory:');
  const settings = configured ? { posthog_project_id: '42', posthog_api_key: 'phx_test' } : {};
  const db = {
    db: sqlite,
    getSetting: (k, d = '') => (k in settings ? settings[k] : d),
    setSetting: (k, v) => { settings[k] = v; },
    listSuitesForEntity: (eid) => suites.filter((s) => s.entityId === eid),
    lockedFiltersForSuite: (sid) => locks[sid] || {},
    listDashboards: () => dashboards,
    getDashboard: (id) => dashboards.find((d) => d.id === id) || null,
  };
  const auth = {
    requireAuth: (q, s, n) => n(),
    requireAdmin: (q, s, n) => (q.user?.role === 'admin' ? n() : s.status(403).json({ error: 'admin' })),
    filterNameToField: (name) => ({ 'Event Name': 'core_events.name', 'Current Event': 'core_events.name', 'Organiser Name': 'core_organisers.name' }[name] || null),
  };
  const queries = [];
  const fetchImpl = async (url, opts) => {
    const q = JSON.parse(opts.body).query.query;
    queries.push(q);
    const body = responder ? responder(q) : HOGQL([], []);
    if (body instanceof Error) throw body;
    if (body?.httpStatus) return { ok: false, status: body.httpStatus, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  const lookerCalls = [];
  const runLookerQuery = async (path, q) => { lookerCalls.push(q); return lookerRows; };
  const routes = {};
  const capture = (m) => (path, ...handlers) => { routes[`${m} ${path}`] = handlers; };
  const app = { get: capture('GET'), post: capture('POST'), put: capture('PUT'), delete: capture('DELETE') };
  const api = posthog.mount(app, { db, auth, runLookerQuery, fetchImpl, startTimer: false });
  async function invoke(key, { params = {}, body = {}, query = {}, user = { id: 'u1', role: 'member', entityIds: ['e1'] } } = {}) {
    const handlers = routes[key];
    assert.ok(handlers, `route ${key} exists`);
    const req = { params, body, query, user };
    const out = { status: 200, body: null };
    const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
    for (const h of handlers) {
      let nexted = false;
      await h(req, res, (e) => { nexted = !e; if (e) { out.status = e.status || 500; out.body = { error: e.message }; } });
      if (!nexted) break;
    }
    return out;
  }
  return { api, db, sqlite, settings, invoke, queries, lookerCalls };
}

// A responder covering every sync query by shape.
const today = new Date().toISOString().slice(0, 10);
function syncResponder(q) {
  if (q.includes('FROM persons')) return HOGQL(['day', 'new_users'], [[today, 41]]);
  if (q.includes('GROUP BY day, event_ref')) {
    return HOGQL(['day', 'event_ref', 'event_name', 'uniques', 'interactions', 'views', 'cta_taps', 'purchases', 'purchase_value'],
      [[today, '101', 'Milk & Cookies JHB', 500, 2000, 900, 120, 30, 4500], [today, '202', 'Ultra SA', 300, 1100, 500, 60, 10, 1500]]);
  }
  if (q.includes('INTERVAL 7 DAY') && q.includes('uniq(person_id) AS n')) return HOGQL(['n'], [[2100]]);
  if (q.includes('INTERVAL 30 DAY') && q.includes('uniq(person_id) AS n')) return HOGQL(['n'], [[6800]]);
  if (q.includes('toStartOfDay(now())') && q.includes('AS actives')) return HOGQL(['actives', 'sessions', 'interactions', 'views'], [[480, 700, 3100, 1400]]);
  // app-wide daily
  return HOGQL(['day', 'dau', 'sessions', 'interactions', 'views', 'notif_events'], [[today, 800, 1200, 5000, 2200, 90]]);
}

test('syncDaily writes both rollup tables, the headline uniques and last-sync', async () => {
  const h = makeHarness({ responder: syncResponder });
  const r = await h.api.syncDaily(7);
  assert.equal(r.ok, true);
  assert.equal(r.eventRows, 2);
  const app = h.sqlite.prepare('SELECT * FROM posthog_daily_app WHERE date=?').get(today);
  assert.equal(app.dau, 800);
  assert.equal(app.new_users, 41, 'new-user counts merge into the same row');
  const ev = h.sqlite.prepare('SELECT * FROM posthog_daily_event WHERE event_ref=?').get('101');
  assert.equal(ev.uniques, 500);
  assert.equal(ev.purchase_value, 4500);
  assert.ok(h.settings.posthog_last_sync, 'last sync recorded');
  assert.deepEqual(JSON.parse(h.settings.posthog_headline).wau, 2100);
});

test('syncDaily upserts idempotently — a restated day overwrites, never duplicates', async () => {
  const h = makeHarness({ responder: syncResponder });
  await h.api.syncDaily(7);
  await h.api.syncDaily(7);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) c FROM posthog_daily_event').get().c, 2);
});

test('syncDaily NEVER throws — a dead PostHog records the error and reports ok:false', async () => {
  const h = makeHarness({ responder: () => new Error('boom') });
  const r = await h.api.syncDaily(7);
  assert.equal(r.ok, false);
  assert.ok(h.settings.posthog_last_error, 'error recorded for the admin card');
});

test('syncDaily on an unconfigured platform is a graceful no-op', async () => {
  const h = makeHarness({ configured: false });
  const r = await h.api.syncDaily(7);
  assert.equal(r.reason, 'not_configured');
});

test('appReport rolls the window up and ranks top events by uniques', async () => {
  const h = makeHarness({ responder: syncResponder });
  await h.api.syncDaily(7);
  const rep = h.api.appReport(28);
  assert.equal(rep.totals.interactions, 5000);
  assert.equal(rep.topEvents[0].eventRef, '101');
  assert.equal(rep.topEvents[0].eventName, 'Milk & Cookies JHB');
});

test('scoping: id locks pass straight through; wildcards are never scope', () => {
  const h = makeHarness({});
  const s = h.api.suiteEventScope({ 'core_events.id': '101, 202', 'core_events.name': 'Ultra %' });
  assert.deepEqual(s.ids, ['101', '202']);
  assert.deepEqual(s.names, [], 'LIKE patterns must not become scope');
});

test('eventIdsForEntity resolves NAME locks to ids via Looker and caches the result', async () => {
  const h = makeHarness({
    suites: [{ id: 's1', entityId: 'e1' }],
    locks: { s1: { 'Event Name': 'Milk & Cookies JHB' } },
    dashboards: [{ id: 'd1', filters: [{ field: 'core_events.name', model: 'howler', explore: 'tickets' }] }],
    lookerRows: [{ 'core_events.name': 'Milk & Cookies JHB', 'core_events.id': 101 }],
  });
  const ids = await h.api.eventIdsForEntity('e1');
  assert.deepEqual(ids, ['101']);
  assert.equal(h.lookerCalls.length, 1);
  const again = await h.api.eventIdsForEntity('e1');
  assert.deepEqual(again, ['101']);
  assert.equal(h.lookerCalls.length, 1, 'second call served from the cache');
});

test('eventIdsForEntity fails CLOSED — no locks, no ids, no data', async () => {
  const h = makeHarness({ suites: [{ id: 's1', entityId: 'e1' }], locks: { s1: { 'Organiser Name': 'Ultra' } } });
  assert.deepEqual(await h.api.eventIdsForEntity('e1'), []);
});

test('entityReport only ever sums the entity\'s own event rows', async () => {
  const h = makeHarness({ responder: syncResponder });
  await h.api.syncDaily(7);
  const rep = h.api.entityReport('e1', 28, ['101']);
  assert.equal(rep.scoped, true);
  assert.equal(rep.totals.uniques, 500, 'event 202 is not theirs and does not leak in');
  assert.equal(rep.events.length, 1);
  const none = h.api.entityReport('e1', 28, []);
  assert.equal(none.scoped, false);
  assert.equal(none.totals, null);
});

test('my route rejects a user reaching for another client', async () => {
  const h = makeHarness({});
  const out = await h.invoke('GET /api/my/app-analytics/:entityId', { params: { entityId: 'e2' }, user: { id: 'u1', role: 'member', entityIds: ['e1'] } });
  assert.equal(out.status, 403);
});

test('settings are write-only: the key never comes back, clear works, admin only', async () => {
  const h = makeHarness({});
  await h.invoke('PUT /api/admin/posthog/settings', { body: { apiKey: 'phx_secret', host: 'https://eu.posthog.com' }, user: { role: 'admin' } });
  assert.equal(h.settings.posthog_api_key, 'phx_secret');
  const view = await h.invoke('GET /api/admin/posthog/settings', { user: { role: 'admin' } });
  assert.equal(view.body.keySet, true);
  assert.ok(!JSON.stringify(view.body).includes('phx_secret'), 'secret value never leaves the server');
  await h.invoke('PUT /api/admin/posthog/settings', { body: { clearApiKey: true }, user: { role: 'admin' } });
  assert.equal(h.settings.posthog_api_key, '');
  const denied = await h.invoke('GET /api/admin/posthog/settings', { user: { role: 'member' } });
  assert.equal(denied.status, 403);
});

test('people query is scoped to the given event ids and searches person props', async () => {
  let captured = '';
  const h = makeHarness({
    responder: (q) => {
      captured = q;
      return HOGQL(['email', 'firstName', 'lastName', 'phone', 'lastSeen', 'interactions', 'eventNames'],
        [['thandi@x.com', 'Thandi', 'Nkosi', '+27821112222', '2026-07-10 12:00:00', 14, ['Milk & Cookies JHB']]]);
    },
  });
  const r = await h.api.people({ ids: ['101'], days: 28, q: "o'brien" });
  assert.equal(r.people[0].email, 'thandi@x.com');
  assert.ok(captured.includes("IN ('101')"), 'event-id scope is in the query');
  assert.ok(captured.includes("\\'brien"), 'search terms are escaped');
  assert.ok(captured.includes("person.properties['$email']"), 'default person props apply');
});

test('per-event sync keeps the NEWEST days if the row cap ever bites', async () => {
  const h = makeHarness({ responder: syncResponder });
  await h.api.syncDaily(7);
  const evQuery = h.queries.find((q) => q.includes('GROUP BY day, event_ref'));
  assert.match(evQuery, /ORDER BY day DESC/);
});

test('diagnose reports tagged-event counts, sample ids and rollup state (admin only)', async () => {
  const h = makeHarness({
    responder: (q) => {
      if (q.includes('JSONExtractKeys(person.properties)')) return HOGQL(['key', 'n'], [['$email', 900], ['first_name', 800]]);
      if (q.includes('JSONExtractKeys(properties)')) return HOGQL(['key', 'n'], [['eventId', 5000], ['screen', 4000]]);
      if (q.includes('AS ids')) return HOGQL(['n', 'ids'], [[0, 0]]);
      return HOGQL(['v', 'name', 'n'], []);
    },
  });
  const out = await h.invoke('GET /api/admin/posthog/diagnose', { user: { role: 'admin' } });
  assert.equal(out.status, 200);
  assert.equal(out.body.taggedEvents7d, 0, 'a mis-named property reads as zero tagged events');
  assert.equal(out.body.eventPropertyKeys[0].key, 'eventId', 'the real key is surfaced for the admin to pick');
  assert.equal(out.body.rollup.eventRows, 0);
  const denied = await h.invoke('GET /api/admin/posthog/diagnose', { user: { role: 'member' } });
  assert.equal(denied.status, 403);
});

test('tick syncs once per day and respects the kill switch', async () => {
  const h = makeHarness({ responder: syncResponder });
  await h.api.tick();
  const after = h.settings.posthog_last_sync;
  assert.ok(after, 'first tick synced');
  await h.api.tick();
  assert.equal(h.settings.posthog_last_sync, after, 'same-day tick is a no-op');
  h.settings.posthog_last_auto = '2000-01-01';
  h.settings.posthog_sync_enabled = '0';
  await h.api.tick();
  assert.equal(h.settings.posthog_last_sync, after, 'kill switch stops the tick');
});
