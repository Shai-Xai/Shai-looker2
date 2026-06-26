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

function makeEngine({ suites = [], sets = {}, dashboards = {}, prefs = {} } = {}) {
  const db = {
    listSuitesForEntity: () => suites,
    getSet: (id) => sets[id] || null,
    getUserPref: (_uid, key) => prefs[key] || '',
    getSetting: (_k, d) => d ?? '{}',
  };
  const store = { get: (id) => dashboards[id] || null };
  return require('../server/briefing')({ db, store, query: stubQuery });
}

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

test('phaseDefaults / timeDefaults expose editable text for every phase + segment', () => {
  const e = makeEngine();
  const pd = e.phaseDefaults();
  for (const p of e.PHASES) assert.ok((pd[p.key] || '').length > 10, `phase ${p.key} has default guidance`);
  const td = e.timeDefaults();
  for (const t of e.TIMES) assert.ok((td[t.key] || '').length > 10, `segment ${t.key} has default guidance`);
});
