// Once-off campaign conversion tracking: convMode (does it apply?) and
// recomputeConversion (how many of the original recipients have since converted).
// Dropout = left the abandoned list; list = appears in a separate orders source.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createAutomations = require('../server/actionAutomations');

// Minimal stubs — we only exercise convMode + recomputeConversion (no DB/timers).
function make(audienceForImpl) {
  const noop = () => {};
  return createAutomations({
    sql: { prepare: () => ({ all: () => [], run: noop, get: () => ({}) }) },
    now: () => '2026-07-17T00:00:00.000Z', uuid: () => 'x', enabled: () => false,
    getAction: () => null, audienceFor: audienceForImpl, saveResults: noop, push: {},
    enrollSequence: noop, sysUser: { id: 'sys', role: 'admin', entityIds: [] },
  });
}

test('convMode: dropout for a tile once-off, list when a source is set, null for sequences', () => {
  const { convMode } = make(async () => ({ list: [] }));
  assert.equal(convMode({ config: { audience: { mode: 'tile' } } }), 'dropout');
  assert.equal(convMode({ config: { audience: { mode: 'paste' }, conversion: { mode: 'list', source: { mode: 'tile' } } } }), 'list');
  assert.equal(convMode({ config: { campaignMode: 'sequence', audience: { mode: 'tile' } } }), null);
  assert.equal(convMode({ config: { audience: { mode: 'paste' } } }), null, 'a pasted list with no source is not trackable');
});

test('dropout: recipients no longer in the re-run abandoned list count as converted (case-insensitive)', async () => {
  // Original send: 3 abandoners. On re-check the tile only still lists ONE of them —
  // the other two bought (dropped off), so converted = 2.
  const stillAbandoning = [{ email: 'A@x.com' }]; // note different casing than the snapshot
  const { recomputeConversion } = make(async () => ({ list: stillAbandoning }));
  const action = {
    entityId: 'e1', config: { audience: { mode: 'tile' } },
    audience: [{ email: 'a@x.com' }, { email: 'b@x.com' }, { email: 'c@x.com' }],
  };
  const out = await recomputeConversion(action);
  assert.equal(out.mode, 'dropout');
  assert.equal(out.audience, 3);
  assert.equal(out.converted, 2, 'b and c left the list → converted; a still abandoning (casing ignored)');
});

test('list: recipients who appear in the separate orders source count as converted', async () => {
  // conversion.source resolves (via audienceFor) to the orders list.
  const orders = [{ email: 'b@x.com' }, { email: 'zzz@x.com' }];
  const { recomputeConversion } = make(async (_e, cfg) => ({ list: cfg.audience && cfg.audience.__orders ? orders : [] }));
  const action = {
    entityId: 'e1',
    config: { audience: { mode: 'paste' }, conversion: { mode: 'list', source: { mode: 'tile', __orders: true } } },
    audience: [{ email: 'a@x.com' }, { email: 'b@x.com' }],
  };
  const out = await recomputeConversion(action);
  assert.equal(out.mode, 'list');
  assert.equal(out.converted, 1, 'only b is in the orders source');
});
