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
