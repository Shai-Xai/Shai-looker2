// AI core — the briefing/digest engine's deterministic logic (server/briefing.js).
// buildFacts itself hits Looker (network), but the SELECTION + steering layer it
// sits on is pure and currently untested: event-phase derivation, the time-of-day
// lens, tile prioritisation (headline vs noisy), the always-include categories,
// and the suite→set→dashboard catalogue flatten. We inject tiny db/store stubs so
// these run with no network. (query is unused by the functions under test.)

const { test } = require('node:test');
const assert = require('node:assert/strict');

const stubQuery = {
  runLookerQuery: () => {}, expandLockMap: () => ({}), effectiveFilterValues: () => ({}),
  tileQueryBody: () => {}, daysBeforeOverlayFor: () => {},
};

function makeEngine({ suites = [], sets = {}, dashboards = {}, prefs = {}, query = stubQuery } = {}) {
  const db = {
    listSuitesForEntity: () => suites,
    getSuite: (id) => suites.find((s) => s.id === id) || null,
    getSet: (id) => sets[id] || null,
    getUserPref: (_uid, key) => prefs[key] || '',
    getSetting: (_k, d) => d ?? '{}',
    listMarks: () => [],
    lockedFiltersForSuite: () => ({}),
    getFilterView: () => null,
  };
  const store = { get: (id) => dashboards[id] || null };
  return require('../server/briefing')({ db, store, query });
}

// A query layer where every tile "runs" and returns one row — so buildFacts'
// SELECTION logic (focus picks, phase gate, caps) is what the test observes.
const liveQuery = {
  ...stubQuery,
  tileQueryBody: async () => ({ filters: {} }),
  runLookerQuery: async () => ({ fields: { measures: [{ name: 'v' }] }, data: [{ v: { value: 1 } }] }),
};

const AT = Date.parse('2026-06-15T12:00:00'); // a fixed "now" for phase math

test('resolvePhase derives the event phase from its dates', () => {
  const e = makeEngine();
  assert.equal(e.resolvePhase({ launchDate: '2026-07-01' }, AT).key, 'pre_launch'); // before on-sale
  assert.equal(e.resolvePhase({ launchDate: '2026-06-10' }, AT).key, 'launch');     // within 7d of on-sale
  assert.equal(e.resolvePhase({ eventStart: '2026-06-14', eventEnd: '2026-06-16' }, AT).key, 'event_day');
  assert.equal(e.resolvePhase({ eventStart: '2026-06-01', eventEnd: '2026-06-02' }, AT).key, 'post_event');
  assert.equal(e.resolvePhase({}, AT).key, null); // no dates configured
});

test('resolvePhase: a manual override wins over the date-derived phase', () => {
  const e = makeEngine();
  const r = e.resolvePhase({ manualPhase: 'build_up', launchDate: '2026-07-01' }, AT);
  assert.equal(r.key, 'build_up');
  assert.equal(r.source, 'manual');
});

test('timeSegment maps the local hour to a reading lens', () => {
  const e = makeEngine();
  assert.equal(e.timeSegment(8), 'morning');
  assert.equal(e.timeSegment(13), 'midday');
  assert.equal(e.timeSegment(19), 'evening');
});

test('tilePriority leads with headline tiles over noisy time-windowed ones', () => {
  const e = makeEngine();
  const headline = { title: 'Total Tickets Sold' };
  const noisy = { title: 'Sales in the last hour' };
  assert.ok(e.tilePriority(headline) < e.tilePriority(noisy), 'cumulative tile sorts ahead of a per-hour one');
});

test('briefingCats defaults to every category, honours a saved subset', () => {
  const all = makeEngine();
  assert.equal(all.briefingCats('u1', 'e1').size, all.BRIEF_CATS.length);

  const some = makeEngine({ prefs: { 'briefing_cats:e1': JSON.stringify(['daily_sales', 'ga4']) } });
  assert.deepEqual([...some.briefingCats('u1', 'e1')].sort(), ['daily_sales', 'ga4']);

  const bogus = makeEngine({ prefs: { 'briefing_cats:e1': JSON.stringify(['daily_sales', 'not_a_cat']) } });
  assert.deepEqual([...bogus.briefingCats('u1', 'e1')], ['daily_sales'], 'unknown keys are dropped');
});

test('clientCatalogue flattens suite → set → dashboards, with tabbed leads', () => {
  const e = makeEngine({
    suites: [{ id: 'su1', name: 'Summer Fest', setIds: ['set1'] }],
    sets: { set1: { id: 'set1', name: 'Ticketing', dashboards: [{ id: 'd1', parentId: null }, { id: 'd2', parentId: 'd1' }] } },
    dashboards: { d1: { id: 'd1', title: 'Overview' }, d2: { id: 'd2', title: 'By Type' } },
  });
  const { catalogue, leads } = e.clientCatalogue('e1');
  assert.equal(catalogue.length, 2);
  assert.equal(catalogue[0].suiteName, 'Summer Fest');
  assert.equal(catalogue[0].setName, 'Ticketing');
  assert.equal(leads.length, 1);
  assert.deepEqual(leads[0].dashboardIds, ['d1', 'd2'], 'lead dashboard carries its tab');
});

// ─── Focus picks (Tune → "Focus the Owl on specific dashboards & tiles") ──────
// The scenario a live client hit: gates/cashless tiles picked (some scoped to
// Event Day) but the briefing stayed ticketing-only. These pin the pick layer:
// picks feed, phase scoping gates correctly, an unresolvable phase FAILS OPEN
// (with a diag note) instead of silently dropping the reader's choice, and a
// whole-board pick can't eat the entire tile budget.
const tile = (id, title) => ({ id, title, type: 'kpi', query: { fields: ['f'] } });
function focusFixture({ briefing = {} } = {}) {
  return {
    suites: [{ id: 'su1', name: 'KFF 26', setIds: ['set1'], briefing }],
    sets: { set1: { id: 'set1', name: 'Cashless', dashboards: [{ id: 'gates' }, { id: 'bar' }] } },
    dashboards: {
      gates: { id: 'gates', title: 'Gates by Device', tiles: [tile('g1', 'GATE A'), tile('g2', 'GATE B')] },
      bar: { id: 'bar', title: 'Cashless Overview', tiles: [tile('b1', 'Total Bar Sales'), tile('b2', 'Top 10 Bars')] },
    },
    query: liveQuery,
  };
}

test('buildFacts: focus picks feed the briefing facts (and the diag says so)', async () => {
  const e = makeEngine({ ...focusFixture(), prefs: { 'briefing_tiles:e1': JSON.stringify([{ dashboardId: 'bar', tileId: 'b1' }]) } });
  const { tiles, focusDiag } = await e.buildFacts({ id: 'u1' }, 'e1');
  assert.ok(tiles.some((t) => t.title === 'Total Bar Sales' && t.pinned), 'picked tile is in the facts, marked pinned/[FOLLOWED]');
  assert.deepEqual(focusDiag.map((f) => [f.tile, f.status]), [['Total Bar Sales', 'feeding the briefing']]);
});

test('buildFacts: a phase-scoped pick is gated out while the event is in another phase', async () => {
  // Event is mid-campaign (launched a month ago, starts in a month) — the
  // Event Day pick must NOT feed, and the diag must say why.
  const on = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
  const e = makeEngine({
    ...focusFixture({ briefing: { launchDate: on(-30), eventStart: on(30), eventEnd: on(32) } }),
    prefs: { 'briefing_tiles:e1': JSON.stringify([{ dashboardId: 'gates', tileId: 'g1', phase: 'event_day' }, { dashboardId: 'bar', tileId: 'b1' }]) },
  });
  const { tiles, focusDiag } = await e.buildFacts({ id: 'u1' }, 'e1');
  assert.ok(!focusDiag.some((f) => f.tile === 'GATE A' && /feeding/.test(f.status)), 'out-of-phase pick does not feed');
  assert.match(focusDiag.find((f) => f.tile === 'GATE A').status, /out of phase \(event is in mid_campaign\)/);
  assert.ok(tiles.some((t) => t.title === 'Total Bar Sales'), 'the all-phases pick still feeds');
});

test('buildFacts: a phase-scoped pick feeds ON the phase, and FAILS OPEN when no phase is resolvable', async () => {
  const on = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
  // Event day today → the Event Day pick feeds.
  const live = makeEngine({
    ...focusFixture({ briefing: { eventStart: on(0), eventEnd: on(2) } }),
    prefs: { 'briefing_tiles:e1': JSON.stringify([{ dashboardId: 'gates', tileId: 'g1', phase: 'event_day' }]) },
  });
  const a = await live.buildFacts({ id: 'u1' }, 'e1');
  assert.ok(a.tiles.some((t) => t.title === 'GATE A'), 'event-day pick feeds on event day');
  // No dates + no manual phase anywhere → scoping can't bite: the pick STILL
  // feeds (the reader chose it) and the diag flags the missing dates.
  const dateless = makeEngine({
    ...focusFixture({ briefing: {} }),
    prefs: { 'briefing_tiles:e1': JSON.stringify([{ dashboardId: 'gates', tileId: 'g1', phase: 'event_day' }]) },
  });
  const b = await dateless.buildFacts({ id: 'u1' }, 'e1');
  assert.ok(b.tiles.some((t) => t.title === 'GATE A'), 'pick fails OPEN when no event phase is resolvable');
  assert.match(b.focusDiag.find((f) => f.tile === 'GATE A').status, /phase scope ignored/);
});

test('buildFacts: a whole-dashboard focus pick is capped so it cannot eat the tile budget', async () => {
  const many = Array.from({ length: 15 }, (_, i) => tile(`t${i}`, `Tile ${i}`));
  const e = makeEngine({
    suites: [{ id: 'su1', name: 'KFF 26', setIds: ['set1'], briefing: {} }],
    sets: { set1: { id: 'set1', name: 'Cashless', dashboards: [{ id: 'big' }] } },
    dashboards: { big: { id: 'big', title: 'Big Board', tiles: many } },
    prefs: { 'briefing_tiles:e1': JSON.stringify([{ dashboardId: 'big', tileId: '*' }]) },
    query: liveQuery,
  });
  const { focusDiag, tiles } = await e.buildFacts({ id: 'u1' }, 'e1');
  assert.equal(focusDiag[0].status, 'feeding the briefing');
  const focusFed = tiles.filter((t) => t.pinned).length;
  assert.ok(focusFed <= 6, `whole-board pick capped (fed ${focusFed})`);
});

test('phaseDefaults / timeDefaults expose editable text for every phase + segment', () => {
  const e = makeEngine();
  const pd = e.phaseDefaults();
  for (const p of e.PHASES) assert.ok((pd[p.key] || '').length > 10, `phase ${p.key} has default guidance`);
  const td = e.timeDefaults();
  for (const t of e.TIMES) assert.ok((td[t.key] || '').length > 10, `segment ${t.key} has default guidance`);
});
