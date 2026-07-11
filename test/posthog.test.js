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
    return HOGQL(['day', 'event_ref', 'event_name', 'uniques', 'interactions', 'views', 'cta_taps', 'purchases', 'purchase_value', 'notif_events'],
      [[today, '101', 'Milk & Cookies JHB', 500, 2000, 900, 120, 30, 4500, 75], [today, '202', 'Ultra SA', 300, 1100, 500, 60, 10, 1500, 25]]);
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
  assert.equal(ev.notif_events, 75, 'notification counts land per event too');
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

test('property-values explorer: values, slice-aware, key listing, escaped, admin only', async () => {
  let captured = '';
  const h = makeHarness({ responder: (q) => {
    captured = q;
    if (q.includes('JSONExtractKeys')) return HOGQL(['k', 'n'], [['cta_label', 107], ['interaction_type', 107]]);
    return HOGQL(['v', 'n'], [['event_view', 9000], ['cta_tap', 800]]);
  } });
  const out = await h.invoke('GET /api/admin/posthog/property-values', { query: { event: "inter'action", key: 'action' }, user: { role: 'admin' } });
  assert.equal(out.status, 200);
  assert.equal(out.body.values[0].value, 'event_view');
  assert.ok(captured.includes("event = 'inter\\'action'"), 'event name escaped');
  // slice form narrows to one interaction type
  await h.invoke('GET /api/admin/posthog/property-values', { query: { event: 'interaction : interaction_type=cta_click', key: 'cta_label' }, user: { role: 'admin' } });
  assert.ok(captured.includes("event = 'interaction' AND toString(properties['interaction_type']) = 'cta_click'"), 'qualified slice compiles');
  // no key = list the slice's property keys
  const keys = await h.invoke('GET /api/admin/posthog/property-values', { query: { event: 'interaction : interaction_type=cta_click' }, user: { role: 'admin' } });
  assert.equal(keys.body.keys[0].key, 'cta_label', 'key discovery for rare slices');
  const bad = await h.invoke('GET /api/admin/posthog/property-values', { query: {}, user: { role: 'admin' } });
  assert.equal(bad.status, 400);
  const denied = await h.invoke('GET /api/admin/posthog/property-values', { query: { event: 'x', key: 'y' }, user: { role: 'member' } });
  assert.equal(denied.status, 403);
});

test('the =* wildcard maps property-presence (any labelled CTA counts)', () => {
  assert.equal(
    posthog.mapCond(['interaction : CTA_Label=*']),
    "(event = 'interaction' AND notEmpty(toString(properties['CTA_Label'])))",
  );
});

test('breakdowns are scoped, and clients can only use the configured keys', async () => {
  let captured = '';
  const h = makeHarness({
    suites: [{ id: 's1', entityId: 'e1' }],
    locks: { s1: { 'core_events.id': '101' } },
    responder: (q) => { captured = q; return HOGQL(['v', 'n', 'u'], [['event_view', 9000, 1500], ['share', 400, 300]]); },
  });
  const out = await h.invoke('GET /api/my/app-analytics/:entityId/breakdown', { params: { entityId: 'e1' }, query: { key: 'interaction_type' } });
  assert.equal(out.status, 200);
  assert.equal(out.body.values[0].value, 'event_view');
  assert.ok(captured.includes("IN ('101')"), 'client breakdown is forced to their event ids');
  const probe = await h.invoke('GET /api/my/app-analytics/:entityId/breakdown', { params: { entityId: 'e1' }, query: { key: '$geoip_city_name' } });
  assert.equal(probe.status, 400, 'unconfigured keys are rejected — no property probing');
});

test('CTA labels: mapped slice + label prop, scoped, top-N with an Other rollup', async () => {
  const queries = [];
  const h = makeHarness({
    suites: [{ id: 's1', entityId: 'e1' }],
    locks: { s1: { 'core_events.id': '101' } },
    responder: (q) => {
      queries.push(q);
      // 15 labels, descending — the default top-12 leaves 3 for the Other bucket
      return HOGQL(['label', 'clicks', 'uniques'], Array.from({ length: 15 }, (_, i) => [`cta_${i}`, 150 - i * 10, 40 - i]));
    },
  });
  // Unmapped (no ctaEvents) → mapped:false and NO PostHog query burned.
  const cold = await h.invoke('GET /api/my/app-analytics/:entityId/cta-labels', { params: { entityId: 'e1' } });
  assert.equal(cold.status, 200);
  assert.equal(cold.body.mapped, false);
  assert.deepEqual(cold.body.labels, []);
  assert.equal(queries.length, 0, 'unmapped short-circuits before PostHog');
  h.settings.posthog_metric_map = JSON.stringify({ ctaEvents: ['interaction : interaction_type=cta_click'], ctaLabelProp: 'CTA_Label' });
  const out = await h.invoke('GET /api/my/app-analytics/:entityId/cta-labels', { params: { entityId: 'e1' } });
  assert.equal(out.status, 200);
  assert.equal(out.body.mapped, true);
  assert.equal(out.body.labelProp, 'CTA_Label');
  assert.equal(out.body.labels.length, 12, 'top N');
  assert.deepEqual(out.body.labels[0], { label: 'cta_0', clicks: 150, uniques: 40 });
  assert.equal(out.body.otherCount, 3);
  assert.equal(out.body.otherClicks, (150 - 120) + (150 - 130) + (150 - 140), 'the tail rolls into one bucket');
  assert.equal(out.body.total, out.body.labels.reduce((s, r) => s + r.clicks, 0) + out.body.otherClicks);
  const q = queries[0];
  assert.ok(q.includes("event = 'interaction' AND toString(properties['interaction_type']) = 'cta_click'"), 'counts only the mapped CTA taps');
  assert.ok(q.includes("notEmpty(toString(properties['CTA_Label']))"), 'unlabelled taps are excluded');
  assert.ok(q.includes("IN ('101')"), 'scoped to the client\'s events');
  // No event locks → fail closed with an empty, unmapped shape.
  const h2 = makeHarness({ suites: [{ id: 's2', entityId: 'e2' }], locks: {} });
  h2.settings.posthog_metric_map = JSON.stringify({ ctaEvents: ['interaction : interaction_type=cta_click'] });
  const closed = await h2.invoke('GET /api/my/app-analytics/:entityId/cta-labels', { params: { entityId: 'e2' }, user: { id: 'u2', role: 'member', entityIds: ['e2'] } });
  assert.equal(closed.status, 200);
  assert.deepEqual(closed.body.labels, []);
  assert.equal(h2.queries.length, 0, 'no ids, no query');
  // The label property round-trips through the mapping settings.
  const put = await h.invoke('PUT /api/admin/posthog/settings', { user: { id: 'a', role: 'admin' }, body: { metricMap: { ctaLabelProp: '  cta_label  ' } } });
  assert.equal(put.status, 200);
  const got = await h.invoke('GET /api/admin/posthog/settings', { user: { id: 'a', role: 'admin' } });
  assert.equal(got.body.metricMap.ctaLabelProp, 'cta_label');
});

test('reports carry the configured breakdown keys and live window uniques', async () => {
  const h = makeHarness({ responder: syncResponder });
  await h.api.syncDaily(7);
  assert.deepEqual(h.api.appReport(7).breakdowns, ['interaction_type', 'CTA_Label', 'surface']);
  const u = await h.api.windowUniques(['101'], 28);
  assert.equal(typeof u, 'number');
});

test('getAppAnalytics Owl tool: scoped report + live, honest refusals, breakdown validation', async () => {
  const createOwlTools = require('../server/owlTools');
  const h = makeHarness({
    responder: syncResponder,
    suites: [{ id: 's1', entityId: 'e1' }],
    locks: { s1: { 'core_events.id': '101' } },
  });
  await h.api.syncDaily(7);
  const t = createOwlTools({ query: { applyScope: () => false, runLookerQuery: async () => [] }, auth: {}, db: {}, getPosthogApi: () => h.api });
  const noClient = await t.getAppAnalytics.run({}, { user: { id: 'u1' } });
  assert.equal(noClient.reason, 'no_client');
  const res = await t.getAppAnalytics.run({ days: 28 }, { user: { id: 'u1' }, entityId: 'e1' });
  assert.equal(res.ok, true);
  assert.equal(res.totals.uniques, 500, 'only their own event rows');
  assert.equal(res.events[0].eventRef, '101');
  assert.ok(res.live && typeof res.live.windowUniques === 'number', 'live tier rides along');
  assert.match(res.note, /revenue truth lives in the dashboards/);
  const badBd = await t.getAppAnalytics.run({ breakdown: '$geoip_city_name' }, { user: { id: 'u1' }, entityId: 'e1' });
  assert.equal(badBd.reason, 'unknown_breakdown', 'only configured breakdown keys');
  // no event locks → fail closed, with a message the Owl can relay
  const h2 = makeHarness({ responder: syncResponder, suites: [{ id: 's2', entityId: 'e2' }], locks: {} });
  const t2 = createOwlTools({ query: { applyScope: () => false, runLookerQuery: async () => [] }, auth: {}, db: {}, getPosthogApi: () => h2.api });
  const noScope = await t2.getAppAnalytics.run({}, { user: { id: 'u1' }, entityId: 'e2' });
  assert.equal(noScope.reason, 'no_scope');
  // unconfigured platform
  const h3 = makeHarness({ configured: false });
  const t3 = createOwlTools({ query: { applyScope: () => false, runLookerQuery: async () => [] }, auth: {}, db: {}, getPosthogApi: () => h3.api });
  const nc = await t3.getAppAnalytics.run({}, { user: { id: 'u1' }, entityId: 'e1' });
  assert.equal(nc.reason, 'not_configured');
});

test('breakdown-series charts per-value daily lines, scoped, top-N when unnamed', async () => {
  const queries = [];
  const h = makeHarness({
    suites: [{ id: 's1', entityId: 'e1' }],
    locks: { s1: { 'core_events.id': '101' } },
    responder: (q) => {
      queries.push(q);
      if (q.includes('GROUP BY day, v')) return HOGQL(['day', 'v', 'n', 'u'], [[today, 'event_detail', 5655, 1985], [today, 'home_feed', 900, 700]]);
      return HOGQL(['v', 'n', 'u'], [['event_detail', 5655, 1985], ['home_feed', 900, 700]]);
    },
  });
  const out = await h.invoke('GET /api/my/app-analytics/:entityId/breakdown-series', { params: { entityId: 'e1' }, query: { key: 'surface' } });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.values, ['event_detail', 'home_feed'], 'unnamed values default to the window top-N');
  assert.equal(out.body.series[0].count, 5655);
  const seriesQ = queries.find((q) => q.includes('GROUP BY day, v'));
  assert.ok(seriesQ.includes("IN ('101')"), 'scoped to the client\'s events');
  assert.ok(seriesQ.includes("IN ('event_detail', 'home_feed')"), 'restricted to the chosen values');
  // hourly granularity buckets by hour (the "hourly today" breakdown view)
  const hr = await h.invoke('GET /api/my/app-analytics/:entityId/breakdown-series', { params: { entityId: 'e1' }, query: { key: 'surface', granularity: 'hour', from: today, to: today } });
  assert.equal(hr.status, 200);
  assert.equal(hr.body.granularity, 'hour');
  assert.ok(queries[queries.length - 1].includes('toStartOfHour'), 'hourly grain reaches the query');
  const tooLong = await h.invoke('GET /api/my/app-analytics/:entityId/breakdown-series', { params: { entityId: 'e1' }, query: { key: 'surface', granularity: 'hour', days: 28 } });
  assert.equal(tooLong.status, 400, 'hourly is capped at 14 days');
});

test('people supports order-by-activity and OFFSET-free paging (personal keys forbid OFFSET)', async () => {
  let captured = '';
  const mk = (n) => Array.from({ length: n }, (_, i) => [`u${i}@x.com`, '', '', '', '2026-07-10 12:00:00', 100 - i, []]);
  const h = makeHarness({ responder: (q) => { captured = q; const m = q.match(/LIMIT (\d+)/); return HOGQL(['email', 'firstName', 'lastName', 'phone', 'lastSeen', 'interactions', 'eventNames'], mk(Math.min(401, Number(m[1])))); } });
  const r = await h.api.people({ ids: ['101'], days: 28, orderBy: 'active', limit: 200 });
  assert.ok(captured.includes('ORDER BY interactions DESC'), 'most-active ordering');
  assert.equal(r.people.length, 200, 'page trimmed to the limit');
  assert.equal(r.hasMore, true, 'rows beyond the page signal another page');
  const page2 = await h.api.people({ ids: ['101'], days: 28, offset: 200 });
  assert.ok(!captured.includes('OFFSET'), 'OFFSET never reaches PostHog — personal API keys reject it');
  assert.ok(captured.includes('LIMIT 401'), 'page 2 fetches to the end of the page and slices locally');
  assert.equal(page2.people.length, 200);
  assert.equal(page2.people[0].email, 'u200@x.com', 'slice starts where page 1 ended');
  assert.ok(captured.includes('ORDER BY lastSeen DESC'), 'default ordering is most recent');
});

test('today view returns hourly rows, scoped and fail-closed', async () => {
  let captured = '';
  const h = makeHarness({
    suites: [{ id: 's1', entityId: 'e1' }],
    locks: { s1: { 'core_events.id': '101' } },
    responder: (q) => {
      captured = q;
      return HOGQL(['hour', 'uniques', 'interactions', 'views', 'cta_taps', 'purchases'],
        [['2026-07-11 09:00:00', 120, 800, 300, 40, 5], ['2026-07-11 10:00:00', 180, 1100, 420, 60, 9]]);
    },
  });
  const out = await h.invoke('GET /api/my/app-analytics/:entityId/today', { params: { entityId: 'e1' } });
  assert.equal(out.status, 200);
  assert.equal(out.body.hours.length, 2);
  assert.equal(out.body.hours[1].ctaTaps, 60);
  assert.ok(captured.includes('toStartOfHour'), 'hourly grain');
  assert.ok(captured.includes("IN ('101')"), 'scoped to the client\'s events');
  const h2 = makeHarness({ suites: [{ id: 's2', entityId: 'e2' }], locks: {} });
  const closed = await h2.invoke('GET /api/my/app-analytics/:entityId/today', { params: { entityId: 'e2' }, user: { id: 'u1', role: 'member', entityIds: ['e2'] } });
  assert.deepEqual(closed.body.hours, [], 'no event scope → empty, never whole-app');
});

test('history search sweeps event names AND breakdown values over a year, escaped, admin only', async () => {
  const queries = [];
  const h = makeHarness({
    responder: (q) => {
      queries.push(q);
      if (q.includes('GROUP BY event')) return HOGQL(['event', 'n', 'firstSeen', 'lastSeen'], [['notification_opened', 3200, '2025-09-01 10:00:00', '2026-02-14 08:00:00']]);
      return HOGQL(['v', 'n', 'firstSeen', 'lastSeen'], []);
    },
  });
  const out = await h.invoke('GET /api/admin/posthog/search-events', { query: { q: "not'if" }, user: { role: 'admin' } });
  assert.equal(out.status, 200);
  assert.equal(out.body.events[0].event, 'notification_opened');
  assert.equal(out.body.events[0].firstSeen.slice(0, 10), '2025-09-01', 'first/last seen ride along');
  assert.ok(queries[0].includes('INTERVAL 365 DAY'), 'searches the full year');
  assert.ok(queries[0].includes("%not\\'if%"), 'term is escaped');
  assert.equal(queries.length, 4, 'one event-name sweep + one per configured breakdown property');
  const noQ = await h.invoke('GET /api/admin/posthog/search-events', { query: {}, user: { role: 'admin' } });
  assert.equal(noQ.status, 400);
  const denied = await h.invoke('GET /api/admin/posthog/search-events', { query: { q: 'x' }, user: { role: 'member' } });
  assert.equal(denied.status, 403);
});

test('moments overlay merges posts + campaign sends, scoped and windowed; graceful without those modules', async () => {
  const h = makeHarness({});
  // Fresh harness has neither sibling module's tables — must degrade, not throw.
  assert.deepEqual(h.api.moments('e1', { days: 28 }), []);
  h.sqlite.exec(`
    CREATE TABLE socialplus_posts (entity_id TEXT, post_id TEXT, community_name TEXT, text TEXT, posted_at TEXT, impressions INTEGER, reach INTEGER, reactions INTEGER, comments INTEGER, shares INTEGER);
    CREATE TABLE actions (entity_id TEXT, title TEXT, status TEXT, approved_at TEXT, config TEXT);
    CREATE TABLE chottu_links (id TEXT PRIMARY KEY, entity_id TEXT, short_url TEXT);
  `);
  h.sqlite.prepare('INSERT INTO socialplus_posts VALUES (?,?,?,?,?,?,?,?,?,?)').run('e1', 'p1', 'Stella fans', 'Lineup drop! 🎉', `${today}T09:00:00.000Z`, 5400, 3100, 210, 33, 12);
  h.sqlite.prepare('INSERT INTO socialplus_posts VALUES (?,?,?,?,?,?,?,?,?,?)').run('e2', 'p2', 'Other club', 'not yours', `${today}T10:00:00.000Z`, 1, 1, 0, 0, 0);
  h.sqlite.prepare('INSERT INTO socialplus_posts VALUES (?,?,?,?,?,?,?,?,?,?)').run('e1', 'p3', 'Stella fans', 'ancient post', '2020-01-01T09:00:00.000Z', 1, 1, 0, 0, 0);
  h.sqlite.prepare('INSERT INTO chottu_links VALUES (?,?,?)').run('l1', 'e1', 'https://hwlr.app/x1');
  h.sqlite.prepare('INSERT INTO actions VALUES (?,?,?,?,?)').run('e1', 'VIP push', 'done', `${today}T12:00:00.000Z`, JSON.stringify({ channelTag: 'app' }));
  h.sqlite.prepare('INSERT INTO actions VALUES (?,?,?,?,?)').run('e1', 'Cashless topup', 'done', `${today}T13:00:00.000Z`, JSON.stringify({ channelTag: 'cashless', body: 'topup at https://hwlr.app/x1' }));
  h.sqlite.prepare('INSERT INTO actions VALUES (?,?,?,?,?)').run('e1', 'Untagged with link', 'done', `${today}T14:00:00.000Z`, JSON.stringify({ body: 'get the app https://hwlr.app/x1 now' }));
  h.sqlite.prepare('INSERT INTO actions VALUES (?,?,?,?,?)').run('e1', 'Untagged no link', 'done', `${today}T15:00:00.000Z`, JSON.stringify({ body: 'nothing appy here' }));
  h.sqlite.prepare('INSERT INTO actions VALUES (?,?,?,?,?)').run('e1', 'Unsent draft', 'draft', `${today}T16:00:00.000Z`, '{}');
  const m = h.api.moments('e1', { days: 28 });
  assert.deepEqual(m.map((x) => x.type), ['post', 'campaign', 'campaign', 'campaign', 'campaign'], 'their post + their sent campaigns, in time order');
  assert.match(m[0].label, /Stella fans: Lineup drop/);
  assert.equal(m[0].appLinked, true, 'posts are in-app by nature');
  assert.equal(m[0].impressions, 5400, 'post view metadata rides along for the detail card + stem height');
  assert.equal(m[0].reactions, 210);
  assert.deepEqual(m.slice(1).map((x) => [x.label, x.appLinked]), [
    ['VIP push', true],            // explicit app tag
    ['Cashless topup', false],     // explicit non-app tag WINS over the link in its body
    ['Untagged with link', true],  // auto-detected via the Chottu short URL
    ['Untagged no link', false],
  ]);
  assert.ok(!m.some((x) => /not yours|ancient|Unsent/.test(x.label)), 'other entities, out-of-window and unsent drafts excluded');
  const denied = await h.invoke('GET /api/my/app-analytics/:entityId/moments', { params: { entityId: 'e2' }, user: { id: 'u1', role: 'member', entityIds: ['e1'] } });
  assert.equal(denied.status, 403);
});

test('link clicks derive daily deltas from Chottu cumulative snapshots, scoped', () => {
  const h = makeHarness({});
  assert.deepEqual(h.api.linkClicks('e1', { days: 28 }), [], 'graceful when Chottu is not installed');
  h.sqlite.exec(`
    CREATE TABLE chottu_links (id TEXT PRIMARY KEY, entity_id TEXT);
    CREATE TABLE chottu_link_stats (link_id TEXT, captured_on TEXT, total_clicks INTEGER, clicks_7d INTEGER, clicks_30d INTEGER);
  `);
  const d = (off) => new Date(Date.now() + off * 86400_000).toISOString().slice(0, 10);
  h.sqlite.prepare('INSERT INTO chottu_links VALUES (?,?)').run('l1', 'e1');
  h.sqlite.prepare('INSERT INTO chottu_links VALUES (?,?)').run('l2', 'e2');
  h.sqlite.prepare('INSERT INTO chottu_link_stats VALUES (?,?,?,0,0)').run('l1', d(-2), 100);
  h.sqlite.prepare('INSERT INTO chottu_link_stats VALUES (?,?,?,0,0)').run('l1', d(-1), 160);
  h.sqlite.prepare('INSERT INTO chottu_link_stats VALUES (?,?,?,0,0)').run('l1', d(0), 190);
  h.sqlite.prepare('INSERT INTO chottu_link_stats VALUES (?,?,?,0,0)').run('l2', d(-1), 9999);
  const out = h.api.linkClicks('e1', { days: 28 });
  assert.deepEqual(out, [{ date: d(-1), clicks: 60 }, { date: d(0), clicks: 30 }], 'daily deltas, other entities excluded');
});

test('Owl page-summary prompt: registered in the AI audit, fact sheet covers every panel', () => {
  const reg = posthog.promptRegistry();
  assert.equal(reg[0].key, 'appAnalyticsSummary');
  assert.match(reg[0].text, /Try next/);
  const insights = require('../server/insights');
  assert.ok(insights.promptRegistry().some((p) => p.key === 'appAnalyticsSummary'), 'insights registry spreads the module prompt (AI audit stays complete)');
  const txt = posthog.buildAppInsightPrompt({
    report: {
      from: '2026-06-14', to: '2026-07-11', days: 28,
      totals: { interactions: 10300, views: 233, ctaTaps: 107, purchases: 0, purchaseValue: 0 },
      series: [{ date: '2026-07-10', uniques: 460, interactions: 3100, views: 90, ctaTaps: 40 }],
      events: [{ eventRef: '40669', eventName: 'The Soirée', uniques: 1787, interactions: 10300, views: 233, ctaTaps: 107, purchases: 0 }],
    },
    live: { actives: 368, windowUniques: 4568 },
    moments: [
      { type: 'post', at: '2026-07-10T12:19:00Z', community: 'The Soirée by Stella Artois', text: 'Think you know the drill?', impressions: 361, reactions: 8, comments: 2 },
      { type: 'campaign', at: '2026-07-09T10:00:00Z', label: 'VIP push', appLinked: true },
    ],
    linkClicks: [{ date: '2026-07-10', clicks: 60 }],
    breakdowns: [{ key: 'interaction_type', values: [{ value: 'cta_click', count: 107, uniques: 45 }] }],
    topUsers: [{ firstName: 'Thandi', lastName: 'Nkosi', email: 't@x.com', interactions: 31, lastSeen: '2026-07-10 23:33:00' }],
    ctaLabels: { labels: [{ label: 'view_tickets', clicks: 1326, uniques: 402 }], otherCount: 5, otherClicks: 587 },
  });
  for (const must of ['368 unique viewers today', '4568 unique viewers across', 'The Soirée · 1787', 'cta_click · 107 · 45', 'Think you know the drill?', 'VIP push · yes', '2026-07-10:60 (total 60)', 'Thandi Nkosi · 31', 'view_tickets · 1326 · 402', '5 smaller labels totalling 587']) {
    assert.ok(txt.includes(must), `fact sheet includes: ${must}`);
  }
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
