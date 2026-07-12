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
  assert.deepEqual(posthog.parseMapEntry('interaction : action=event_view'),
    { event: 'interaction', prop: 'action', value: 'event_view', pairs: [{ prop: 'action', value: 'event_view' }] });
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

test('`&` chains pairs into an AND slice (the order-confirmation mapping)', () => {
  assert.equal(
    posthog.mapCond(['interaction : interaction_type=content_view & surface=order_success']),
    "(event = 'interaction' AND toString(properties['interaction_type']) = 'content_view' AND toString(properties['surface']) = 'order_success')",
  );
  // `=*` (present with any value) works inside a chain
  assert.equal(
    posthog.mapCond(['interaction : cta_label=* & surface=checkout']),
    "(event = 'interaction' AND notEmpty(toString(properties['cta_label'])) AND toString(properties['surface']) = 'checkout')",
  );
  // a value containing & (not pair syntax) still parses as ONE pair, greedily
  assert.equal(
    posthog.mapCond(['interaction : label=Tickets & Beer']),
    "(event = 'interaction' AND toString(properties['label']) = 'Tickets & Beer')",
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

function makeHarness({ responder, suites = [], locks = {}, dashboards = [], lookerRows = [], configured = true, presetSettings = {} } = {}) {
  const sqlite = new Database(':memory:');
  const settings = { ...(configured ? { posthog_project_id: '42', posthog_api_key: 'phx_test' } : {}), ...presetSettings };
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
    const out = { status: 200, body: null, headers: {} };
    const res = {
      status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; },
      setHeader(k, v) { out.headers[k.toLowerCase()] = v; }, send(b) { out.body = b; return this; },
    };
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

test('organiser locks widen scope to ALL that organiser\'s events — past ones without suites included', async () => {
  const h = makeHarness({
    suites: [{ id: 's1', entityId: 'e1' }],
    locks: { s1: { 'Organiser Name': 'G&G Productions', 'core_events.id': '39450' } },
    dashboards: [{ id: 'd1', filters: [{ field: 'core_events.name', model: 'howler', explore: 'tickets' }] }],
    lookerRows: [{ 'core_events.id': 39450 }, { 'core_events.id': 38001 }, { 'core_events.id': 37200 }],
  });
  const s = h.api.suiteEventScope({ 'Organiser Name': 'G&G Productions' });
  assert.deepEqual(s.orgs, ['G&G Productions']);
  const ids = await h.api.eventIdsForEntity('e1');
  assert.deepEqual(ids.sort(), ['37200', '38001', '39450'], 'organiser lookup unions with explicit id locks');
  const q = h.lookerCalls.find((c) => c.filters?.['core_organisers.name']);
  assert.equal(q.filters['core_organisers.name'], 'G&G Productions');
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
  assert.ok(!captured.includes('@howler.'), 'staff ride along unless excluded');
  await h.api.people({ ids: ['101'], days: 28, orderBy: 'active', excludeStaff: true });
  assert.ok(captured.includes("NOT (toString(person.properties['$email']) ILIKE '%@howler.%')"), 'the Super-fans toggle drops Howler staff emails');
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

test('reverse property lookup: which events carry a key, and are they event-id tagged', async () => {
  const h = makeHarness({
    responder: (q) => {
      if (q.includes('GROUP BY event')) {
        return HOGQL(['event', 'n', 'tagged', 'firstSeen', 'lastSeen'],
          [['order_completed', 550, 0, '2025-08-01 10:00:00', '2026-07-12 09:00:00'], ['interaction', 22, 22, '2026-06-01 10:00:00', '2026-07-11 09:00:00']]);
      }
      return HOGQL(['v', 'n'], [['85000', 12], ['12000', 9]]);
    },
  });
  const out = await h.invoke('GET /api/admin/posthog/property-values', { user: { role: 'admin' }, query: { key: 'order_amount_cents' } });
  assert.equal(out.status, 200);
  assert.equal(out.body.carriers[0].event, 'order_completed');
  assert.equal(out.body.carriers[0].tagged, 0, 'untagged rows are called out — they never reach a client');
  assert.equal(out.body.carriers[1].tagged, 22);
  assert.equal(out.body.values[0].value, '85000');
  const q = h.queries[0];
  assert.ok(q.includes("notEmpty(toString(properties['order_amount_cents']))"), 'filters to rows carrying the key');
  assert.ok(q.includes('INTERVAL 365 DAY'), 'a full year, not just recent data');
  // no event AND no key still errors helpfully
  const bad = await h.invoke('GET /api/admin/posthog/property-values', { user: { role: 'admin' }, query: {} });
  assert.equal(bad.status, 400);
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
  // Unmapped (ctaEvents emptied by the admin) → mapped:false, NO PostHog query burned.
  h.settings.posthog_metric_map = JSON.stringify({ ctaEvents: [] });
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

test('blank event names fill in from Looker (id → name), persist, and survive a re-sync', async () => {
  const nameless = (q) => {
    if (q.includes('GROUP BY day, event_ref')) {
      return HOGQL(['day', 'event_ref', 'event_name', 'uniques', 'interactions', 'views', 'cta_taps', 'purchases', 'purchase_value', 'notif_events'],
        [[today, '39450', '', 2053, 5166, 547, 646, 0, 0, 0]]); // the app didn't stamp eventName
    }
    return syncResponder(q);
  };
  const h = makeHarness({
    responder: nameless,
    suites: [{ id: 's1', entityId: 'e1' }],
    locks: { s1: { 'core_events.id': '39450' } },
    dashboards: [{ id: 'd1', filters: [{ field: 'core_events.name', model: 'howler', explore: 'tickets' }] }],
    lookerRows: [{ 'core_events.id': 39450, 'core_events.name': 'G&G Winter Fest' }],
  });
  await h.api.syncDaily(7);
  const out = await h.invoke('GET /api/my/app-analytics/:entityId', { params: { entityId: 'e1' } });
  assert.equal(out.status, 200);
  assert.equal(out.body.events[0].eventName, 'G&G Winter Fest', 'the Looker name replaces the blank');
  assert.equal(h.sqlite.prepare('SELECT event_name FROM posthog_daily_event WHERE event_ref=?').get('39450').event_name,
    'G&G Winter Fest', 'the learned name is persisted into the rollup');
  const calls = h.lookerCalls.length;
  await h.invoke('GET /api/my/app-analytics/:entityId', { params: { entityId: 'e1' } });
  assert.equal(h.lookerCalls.length, calls, 'no repeat lookup once the rollup carries the name');
  // a re-sync with a blank incoming name must NOT blank the learned one
  await h.api.syncDaily(7);
  assert.equal(h.sqlite.prepare('SELECT event_name FROM posthog_daily_event WHERE event_ref=?').get('39450').event_name, 'G&G Winter Fest');
});

test('time-in-app: avg session + avg per-user time from one nested query, scoped, rides the report', async () => {
  let captured = '';
  const h = makeHarness({
    suites: [{ id: 's1', entityId: 'e1' }],
    locks: { s1: { 'core_events.id': '101' } },
    responder: (q) => {
      if (q.includes('AS totalSeconds')) { captured = q; return HOGQL(['sessions', 'users', 'totalSeconds'], [[40, 10, 12000]]); }
      return syncResponder(q);
    },
  });
  const t = await h.api.timeMetrics(['101'], { days: 28 });
  assert.equal(t.avgSessionSec, 300, 'total ÷ sessions');
  assert.equal(t.avgUserSec, 1200, 'total ÷ users');
  assert.ok(captured.includes("dateDiff('second', min(timestamp), max(timestamp))"), 'duration = first→last event per session');
  assert.ok(captured.includes('GROUP BY person, sid'));
  assert.ok(captured.includes("IN ('101')"), 'scoped');
  assert.ok(captured.includes("notEmpty(toString(properties['$session_id']))"), 'session-less events excluded');
  await h.api.syncDaily(7);
  const out = await h.invoke('GET /api/my/app-analytics/:entityId', { params: { entityId: 'e1' } });
  assert.equal(out.status, 200);
  assert.equal(out.body.time.avgSessionSec, 300, 'the report carries the time metrics');
});

test('event-series: per-event daily rows from the rollup, scope is a hard wall', async () => {
  const twoEvents = (q) => {
    if (q.includes('GROUP BY day, event_ref')) {
      return HOGQL(['day', 'event_ref', 'event_name', 'uniques', 'interactions', 'views', 'cta_taps', 'purchases', 'purchase_value', 'notif_events'],
        [[today, '39450', 'Winter Fest', 2053, 5166, 547, 646, 0, 0, 0], [today, '39451', 'Summer Fest', 1800, 4713, 537, 729, 0, 0, 0], [today, '999', 'Not Yours', 50, 60, 5, 1, 0, 0, 0]]);
    }
    return syncResponder(q);
  };
  const h = makeHarness({
    responder: twoEvents,
    suites: [{ id: 's1', entityId: 'e1' }],
    locks: { s1: { 'core_events.id': '39450,39451' } },
  });
  await h.api.syncDaily(7);
  // no ?events= → all their events, one row per (day, event)
  const all = await h.invoke('GET /api/my/app-analytics/:entityId/event-series', { params: { entityId: 'e1' } });
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.events.map((e) => e.eventRef).sort(), ['39450', '39451']);
  assert.equal(all.body.series.find((r) => r.eventRef === '39450').uniques, 2053);
  // asking for a foreign event id gets silently filtered — never their data
  const sneaky = await h.invoke('GET /api/my/app-analytics/:entityId/event-series', { params: { entityId: 'e1' }, query: { events: '999,39451' } });
  assert.deepEqual(sneaky.body.events.map((e) => e.eventRef), ['39451'], 'foreign ids are dropped by the scope wall');
  // no locks → fail closed
  const h2 = makeHarness({ suites: [{ id: 's2', entityId: 'e2' }], locks: {} });
  const closed = await h2.invoke('GET /api/my/app-analytics/:entityId/event-series', { params: { entityId: 'e2' }, user: { id: 'u2', role: 'member', entityIds: ['e2'] } });
  assert.deepEqual(closed.body.series, []);
  // admin whole-app with nothing named defaults to the window's top events
  const top = await h.invoke('GET /api/admin/app-analytics/event-series', { user: { id: 'a', role: 'admin' } });
  assert.equal(top.status, 200);
  assert.ok(top.body.events.length >= 2, 'top events fill the default selection');
});

test('checkout funnel: one query, per-stage uniques, scoped and fail-closed; steps configurable', async () => {
  const queries = [];
  const h = makeHarness({
    suites: [{ id: 's1', entityId: 'e1' }],
    locks: { s1: { 'core_events.id': '101' } },
    responder: (q) => { queries.push(q); return HOGQL(['u0', 'n0', 'u1', 'n1', 'u2', 'n2', 'u3', 'n3', 'revenue'], [[900, 4000, 220, 600, 180, 210, 65, 70, 12400.5]]); },
  });
  const out = await h.invoke('GET /api/my/app-analytics/:entityId/funnel', { params: { entityId: 'e1' } });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.steps.map((s) => s.label), ['Tickets viewed', 'Checkout', 'Payment tapped', 'Order confirmed']);
  assert.deepEqual(out.body.steps.map((s) => s.people), [900, 220, 180, 65]);
  assert.equal(out.body.steps[0].events, 4000);
  assert.equal(out.body.revenue, 12400.5, 'in-app revenue rides the same query');
  assert.equal(queries.length, 1, 'all stages ride ONE HogQL query');
  assert.ok(queries[0].includes("sum(toFloat(properties['order_amount_cents'])) / 100 AS revenue"), 'revenue sums the mapped value prop, cents converted');
  const q = queries[0];
  assert.ok(q.includes("uniqIf(person_id, (event = 'interaction' AND toString(properties['surface']) = 'ticket_categories'))"), 'stage condition compiles from the mapping grammar');
  assert.ok(q.includes("toString(properties['interaction_type']) = 'content_view' AND toString(properties['surface']) = 'order_success'"), 'the & chain reaches the query');
  assert.ok(q.includes("IN ('101')"), 'scoped to the client\'s events');
  // no locks → fail closed, empty
  const h2 = makeHarness({ suites: [{ id: 's2', entityId: 'e2' }], locks: {} });
  const closed = await h2.invoke('GET /api/my/app-analytics/:entityId/funnel', { params: { entityId: 'e2' }, user: { id: 'u2', role: 'member', entityIds: ['e2'] } });
  assert.equal(closed.status, 200);
  assert.deepEqual(closed.body.steps, []);
  assert.equal(h2.queries.length, 0, 'no ids, no query');
  // custom steps round-trip; junk (blank label / no events) is dropped
  const put = await h.invoke('PUT /api/admin/posthog/settings', { user: { id: 'a', role: 'admin' }, body: { metricMap: { funnelSteps: [
    { label: '  Browsed  ', events: 'interaction : surface=home' },
    { label: '', events: ['interaction : surface=x'] },
    { label: 'No events', events: [] },
  ] } } });
  assert.equal(put.status, 200);
  const got = await h.invoke('GET /api/admin/posthog/settings', { user: { id: 'a', role: 'admin' } });
  assert.deepEqual(got.body.metricMap.funnelSteps, [{ label: 'Browsed', events: ['interaction : surface=home'] }]);
});

test('commerce scan sweeps a year of event names + mapped property values for order terms', async () => {
  const queries = [];
  const h = makeHarness({
    responder: (q) => {
      queries.push(q);
      if (q.includes('SELECT event')) return HOGQL(['event', 'n', 'firstSeen', 'lastSeen'], [['purchase_complete', 12, '2025-08-01 10:00:00', '2025-11-02 09:00:00']]);
      return HOGQL(['v', 'n', 'firstSeen', 'lastSeen'], [['pay_now', 572, '2026-06-01 08:00:00', '2026-07-11 12:00:00']]);
    },
  });
  const out = await h.invoke('GET /api/admin/posthog/commerce-scan', { user: { id: 'a', role: 'admin' } });
  assert.equal(out.status, 200);
  assert.equal(out.body.events[0].event, 'purchase_complete');
  assert.equal(out.body.values[0].value, 'pay_now');
  assert.ok(out.body.values.some((v) => v.key === 'cta_label'), 'the label property is swept too');
  assert.ok(queries[0].includes("event ILIKE '%order%'") && queries[0].includes("event ILIKE '%checkout%'"), 'terms reach the query');
  assert.ok(queries[0].includes('INTERVAL 365 DAY'), 'a full year, not just recent data');
  assert.equal(queries.length, 1 + 3, 'one event sweep + one per unique mapped property');
  const denied = await h.invoke('GET /api/admin/posthog/commerce-scan', { user: { id: 'u1', role: 'member' } });
  assert.equal(denied.status, 403, 'admin only');
});

test('a legacy stored mapping heals itself on mount — once, keeping custom values', () => {
  const legacy = JSON.stringify({
    screenEvents: ['$screen', '$pageview'], ctaEvents: ['Interaction'],
    breakdownProps: ['interaction_type', 'CTA_Label', 'surface'], ctaLabelProp: 'CTA_Label',
    personProps: { email: 'custom_email' },
  });
  const h = makeHarness({ presetSettings: { posthog_metric_map: legacy } });
  const m = JSON.parse(h.settings.posthog_metric_map);
  assert.deepEqual(m.screenEvents, ['interaction : interaction_type=content_view'], 'dead $screen mapping → confirmed views slice');
  assert.deepEqual(m.ctaEvents, ['interaction : interaction_type=cta_click'], 'bare mis-cased Interaction → confirmed CTA slice');
  assert.deepEqual(m.breakdownProps, ['surface', 'cta_label', 'interaction_type'], 'CTA_Label chip swapped for cta_label, standard set reordered surface-first (v3)');
  assert.equal(m.ctaLabelProp, 'cta_label');
  assert.deepEqual(m.purchaseEvents, ['interaction : interaction_type=content_view & surface=order_success'], 'blank Purchases → confirmed order-confirmation slice (v2)');
  assert.equal(m.personProps.email, 'custom_email', 'unrelated saved values survive');
  assert.equal(m.purchaseValueProp, 'order_amount_cents', 'blank value box → PostHog revenue tracker (v4)');
  assert.equal(m.purchaseValueCents, true);
  assert.equal(h.settings.posthog_map_healed, '4');
  // A v1-healed install upgrades to v2 (purchases fill) WITHOUT re-running the
  // v1 rewrites — deliberate edits stay.
  const v1 = JSON.stringify({ ctaEvents: ['my_custom_cta'], screenEvents: ['$screen'] });
  const h2 = makeHarness({ presetSettings: { posthog_metric_map: v1, posthog_map_healed: '1' } });
  const m2 = JSON.parse(h2.settings.posthog_metric_map);
  assert.deepEqual(m2.ctaEvents, ['my_custom_cta'], 'v1 rewrites do not re-run');
  assert.deepEqual(m2.screenEvents, ['$screen'], 'v1 rewrites do not re-run');
  assert.deepEqual(m2.purchaseEvents, ['interaction : interaction_type=content_view & surface=order_success'], 'v2 fills the blank Purchases box');
  assert.equal(h2.settings.posthog_map_healed, '4');
  // A customised chip set is never reordered by v3.
  const h2b = makeHarness({ presetSettings: { posthog_metric_map: JSON.stringify({ breakdownProps: ['interaction_type', 'my_prop'] }), posthog_map_healed: '2' } });
  assert.deepEqual(JSON.parse(h2b.settings.posthog_metric_map).breakdownProps, ['interaction_type', 'my_prop'], 'custom chips keep their order');
  // A v3-healed install gets ONLY the v4 value fill; a deliberate value prop is kept.
  const h2c = makeHarness({ presetSettings: { posthog_metric_map: JSON.stringify({ purchaseValueProp: 'my_amount' }), posthog_map_healed: '3' } });
  assert.equal(JSON.parse(h2c.settings.posthog_metric_map).purchaseValueProp, 'my_amount', 'deliberate value props are never overwritten');
  // Fully healed → the migration is a no-op, deliberate purchase mappings kept.
  const done = JSON.stringify({ purchaseEvents: ['my_purchase'] });
  const h3 = makeHarness({ presetSettings: { posthog_metric_map: done, posthog_map_healed: '4' } });
  assert.equal(h3.settings.posthog_metric_map, done, 'healed flag makes the migration a no-op');
});

test('purchase value: cents-denominated PostHog revenue lands ÷100 in the rollup', async () => {
  const h = makeHarness({ responder: syncResponder });
  await h.api.syncDaily(7);
  const q1 = h.queries.find((q) => q.includes('GROUP BY day, event_ref'));
  assert.ok(q1.includes("sum(toFloat(properties['order_amount_cents'])) / 100 AS purchase_value"), 'default = PostHog revenue tracker, converted to rand');
  // a rand-denominated custom prop skips the conversion
  h.settings.posthog_metric_map = JSON.stringify({ purchaseValueProp: 'amount_rand', purchaseValueCents: false });
  await h.api.syncDaily(7);
  const q2 = h.queries.filter((q) => q.includes('GROUP BY day, event_ref')).pop();
  assert.ok(q2.includes("sum(toFloat(properties['amount_rand'])) AS purchase_value"));
  assert.ok(!q2.includes('/ 100'));
});

test('reports carry the configured breakdown keys and live window uniques', async () => {
  const h = makeHarness({ responder: syncResponder });
  await h.api.syncDaily(7);
  assert.deepEqual(h.api.appReport(7).breakdowns, ['surface', 'cta_label', 'interaction_type']);
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

test('people.csv exports EVERY user in one file — page caps lifted, still scoped', async () => {
  const mkRows = (n) => Array.from({ length: n }, (_, i) => [`u${i}@x.com`, 'A', 'B', '+27', '2026-07-10 10:00:00', 5, ['E']]);
  let captured = '';
  const h = makeHarness({
    suites: [{ id: 's1', entityId: 'e1' }],
    locks: { s1: { 'core_events.id': '101' } },
    responder: (q) => { captured = q; return HOGQL(['email', 'firstName', 'lastName', 'phone', 'lastSeen', 'interactions', 'eventNames'], mkRows(2500)); },
  });
  const out = await h.invoke('GET /api/my/app-analytics/:entityId/people.csv', { params: { entityId: 'e1' } });
  assert.equal(out.status, 200);
  assert.match(captured, /LIMIT 50001/, 'the export lifts the 2000-row page cap');
  assert.ok(captured.includes("IN ('101')"), 'still scoped to their events');
  const lines = String(out.body).split('\n');
  assert.equal(lines.length, 1 + 2500, 'every row lands in the file (the UI list would have stopped at 2000)');
  assert.ok(lines[0].includes('"Email"'));
  assert.ok(lines[1].startsWith('"A","B","u0@x.com"'), 'row cells are quoted/escaped');
  assert.equal(out.headers['content-disposition'], 'attachment; filename="app-users.csv"');
  assert.match(out.headers['content-type'], /text\/csv/);
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
    funnel: { steps: [{ label: 'Tickets viewed', people: 900 }, { label: 'Order confirmed', people: 65 }] },
    time: { sessions: 40, avgSessionSec: 300, avgUserSec: 1200 },
  });
  for (const must of ['368 unique viewers today', '4568 unique viewers across', 'The Soirée · 1787', 'cta_click · 107 · 45', 'Think you know the drill?', 'VIP push · yes', '2026-07-10:60 (total 60)', 'Thandi Nkosi · 31', 'view_tickets · 1326 · 402', '5 smaller labels totalling 587', 'Tickets viewed · 900', 'Order confirmed · 65', 'average session 300s', 'average total per user 1200s']) {
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
