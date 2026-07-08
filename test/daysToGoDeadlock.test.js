// Days-to-go sync must not gate its own SOURCE tile by the days-before filter it
// SETS. Real bug (Milk & Cookies "M&C TEST"): the source "Days To Go" tile ran
// with the static "[-3,360]" window applied; that window excluded the current
// event, so the tile returned nothing → n was null → the sync bailed → the
// window was never corrected → every current-event tile read 0 and the "N days
// to go" label vanished. The source tile must read the true days-to-go regardless
// of the current window, so apply-mode can drive the correct one.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const looker = require('../server/looker');
const engine = require('../server/query')({ looker, auth: h.auth });

test('the days-to-go source query drops the days-before filter it sets, keeps the rest', async () => {
  h.seedOrganiserDashboard();
  const admin = h.makeAdmin();
  const model = 'ticketing', explore = 'core';
  const def = {
    id: 'dash1', model, view: explore,
    filters: [
      { name: 'Days Before Event', field: 'core_events.days_before', dimension: 'core_events.days_before', model, explore },
      { name: 'Current Event', field: 'core_events.name', dimension: 'core_events.name', model, explore },
    ],
    tiles: [{
      id: 'src', type: 'vis', title: 'Days To Go',
      query: { model, view: explore, fields: ['core_events.days_before'] },
      listenTo: { 'Days Before Event': 'core_events.days_before', 'Current Event': 'core_events.name' },
    }],
    daysBeforeSync: { mode: 'apply', sourceTileId: 'src', filterName: 'Days Before Event', expr: '>={n}' },
  };
  let captured = null;
  const orig = looker.lookerRequest;
  looker.lookerRequest = async (_m, _p, body) => {
    captured = body;
    return { data: [{ 'core_events.days_before': { value: -186 } }], fields: { dimensions: [{ name: 'core_events.days_before' }] } };
  };
  try {
    // The static window that WOULD have zeroed the source:
    const lockMap = { 'Days Before Event': '[-3,360]', 'Current Event': 'Milk and Cookies Festival South Africa 2026 | Cape Town' };
    const overlay = await engine.daysBeforeOverlayFor(def, admin, '', lockMap);
    // It still computed the number → the sync fires with the corrected window.
    assert.deepEqual(overlay, { 'Days Before Event': '>=-186' });
    // Because the source query dropped the days-before filter it sets…
    assert.equal('core_events.days_before' in (captured.filters || {}), false);
    // …but kept every other filter (e.g. the current-event scope).
    assert.equal(captured.filters['core_events.name'], 'Milk and Cookies Festival South Africa 2026 | Cape Town');
  } finally { looker.lookerRequest = orig; }
});
