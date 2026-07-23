// Recipe (action-template) audience resolution — pins the multi-event scoping so
// a "Worth a look → Make it happen" deep link never binds a campaign to the wrong
// event's audience. Regression guard for: on a multi-event client, a Golden Hour
// suggestion opened Palette Range's abandoned-cart audience because resolveAudience
// (first-match wins) fell through to another event's tile when Golden Hour's
// pointed dashboard had none. scopeDashboards HARD-restricts to the target event.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const at = require('../server/actionTemplates');

// A multi-event catalogue: Golden Hour has a plain sales tile (no abandon tile);
// Palette Range carries the abandoned-cart list. Same shape tileCatalogueWithFields
// produces: { dashboardId, suiteId, title, tiles:[{tileId, title, fields }] }.
const CATALOGUE = [
  { dashboardId: 'gh-sales', suiteId: 'golden', title: 'Golden Hour Sales', tiles: [
    { tileId: 'gh-t1', title: 'Ticket Sales by Day', fields: ['order_date', 'revenue'] },
  ] },
  { dashboardId: 'gh-carts', suiteId: 'golden', title: 'Golden Hour Checkout', tiles: [
    { tileId: 'gh-cart', title: 'Abandoned Carts', fields: ['customer_email', 'customer_name', 'ticket_type'] },
  ] },
  { dashboardId: 'pr-carts', suiteId: 'palette', title: 'Palette Range Checkout', tiles: [
    { tileId: 'pr-cart', title: 'Abandoned Carts', fields: ['customer_email', 'customer_name', 'ticket_type'] },
  ] },
];

const abandonTpl = at.get('abandoned_cart');

test('deep link scoped to an event resolves that event’s audience, never another', () => {
  // Suggestion pointed at Golden Hour's SALES dashboard (no abandon tile) but the
  // event is Golden Hour. Must resolve Golden Hour's own abandon tile — not Palette.
  const scoped = at.scopeDashboards(CATALOGUE, { dashboardId: 'gh-sales', suiteId: 'golden' });
  const r = at.resolveAudience(abandonTpl, scoped);
  assert.equal(r.ready, true);
  assert.equal(r.suiteId, 'golden');
  assert.equal(r.tileId, 'gh-cart');
});

test('a suite alone (no dashboard) still hard-scopes to that event', () => {
  const scoped = at.scopeDashboards(CATALOGUE, { suiteId: 'golden' });
  assert.ok(scoped.every((d) => d.suiteId === 'golden'));
  assert.equal(at.resolveAudience(abandonTpl, scoped).suiteId, 'golden');
});

test('target event with no matching tile returns ready:false — never falls through to another event', () => {
  // Golden Hour minus its abandon tile: the only abandon tile left is Palette's.
  const noGhCart = CATALOGUE.filter((d) => d.dashboardId !== 'gh-carts');
  const scoped = at.scopeDashboards(noGhCart, { suiteId: 'golden' });
  const r = at.resolveAudience(abandonTpl, scoped);
  assert.equal(r.ready, false); // user picks manually — the wrong event is never bound
});

test('a dashboardId alone infers its owning suite and scopes to it', () => {
  const scoped = at.scopeDashboards(CATALOGUE, { dashboardId: 'gh-sales' });
  assert.ok(scoped.every((d) => d.suiteId === 'golden'));
});

test('the pointed dashboard is ordered first within its event', () => {
  const scoped = at.scopeDashboards(CATALOGUE, { dashboardId: 'gh-carts', suiteId: 'golden' });
  assert.equal(scoped[0].dashboardId, 'gh-carts');
});

test('no prefer returns the full catalogue unchanged (gallery scans everything)', () => {
  const scoped = at.scopeDashboards(CATALOGUE, {});
  assert.equal(scoped.length, CATALOGUE.length);
  assert.equal(at.resolveAudience(abandonTpl, scoped).ready, true);
});

// ── Journey recipes ────────────────────────────────────────────────────────────
// Regression: the Journeys revert (45fa7f8d) removed JOURNEY_RECIPES /
// listJourneys() from this module, but journeys.js kept calling it after the
// feature returned to main — GET /api/journeys/:entityId/recipes 500'd
// ("actionTemplates.listJourneys is not a function") on every Journeys-tab open.
test('listJourneys returns the starter recipes in the shape the wizard renders', () => {
  const recipes = at.listJourneys();
  assert.ok(Array.isArray(recipes) && recipes.length >= 4, 'has the starter recipe set');
  for (const r of recipes) {
    assert.ok(r.key && r.label && r.summary, `recipe ${r.key || '?'} carries key/label/summary`);
    assert.ok(Array.isArray(r.nodes) && r.nodes.length, `recipe ${r.key} has a node tree`);
    for (const n of r.nodes) assert.ok(n.type === 'message' || n.type === 'decision', 'nodes are message/decision');
  }
  assert.equal(at.getJourney(recipes[0].key)?.key, recipes[0].key);
  assert.equal(at.getJourney('nope'), null);
});

test('journey recipe copy follows house style (no em dashes in user-visible text)', () => {
  const flat = JSON.stringify(at.listJourneys());
  assert.ok(!flat.includes('—'), 'no em dashes in recipe copy');
});
