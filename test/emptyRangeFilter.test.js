// A range dashboard filter the client CLEARED (both bounds empty) serialises to
// "[,]". Looker reads an empty range as "match nothing", so it zeroed a real
// event's tile (Milk & Cookies: the event had 12,297 sales but the days-before
// filter showed 0). Clearing a range means "no constraint" — stripAnyValue must
// drop an empty range like it drops ANY_VALUE, while KEEPING half-open ranges
// (which are real constraints). Both query entry points (/api/run-query and
// tileQueryBody) funnel their filters through stripAnyValue, so this is the fix.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const looker = require('../server/looker');
const engine = require('../server/query')({ looker, auth: h.auth });

test('an empty range ("[,]") is dropped — a cleared range means no constraint', () => {
  const out = engine.stripAnyValue({ 'core_events.days_before_event': '[,]' });
  assert.equal('core_events.days_before_event' in out, false);
});

test('empty-range variants (parens, spaces, half-brackets) are all dropped', () => {
  for (const v of ['[,]', '( , )', '[ , )', '(,]', '[  ,  ]']) {
    const out = engine.stripAnyValue({ f: v });
    assert.equal('f' in out, false, `expected ${JSON.stringify(v)} to be stripped`);
  }
});

test('half-open and closed ranges are REAL constraints — kept untouched', () => {
  for (const v of ['[10,]', '[,360]', '[-3,360]', '[10,20]']) {
    const out = engine.stripAnyValue({ f: v });
    assert.equal(out.f, v, `expected ${JSON.stringify(v)} to be kept`);
  }
});

test('ordinary values and other filters are unaffected', () => {
  const out = engine.stripAnyValue({ a: 'Milk and Cookies Festival', b: 'No', c: '[,]' });
  assert.deepEqual(out, { a: 'Milk and Cookies Festival', b: 'No' });
});
