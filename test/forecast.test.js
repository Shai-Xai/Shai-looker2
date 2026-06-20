// Pins the deterministic forecast model (server/forecast.js). Uses the REAL KFF 26
// last-year curve (from the goal-detail screenshot) so the numbers are grounded.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('../server/forecast');

// Last year's cumulative ticket sales, ending at the event-day total.
const KFF = [6843, 6844, 7450, 8006, 8895, 10018, 16836, 25433, 30293, 33606, 38321, 43310];

test('toCumulative passes a cumulative series through; accumulates an incremental one', () => {
  assert.deepEqual(fc.toCumulative([1000, 3000, 6000]), [1000, 3000, 6000]); // non-decreasing → as-is
  assert.deepEqual(fc.toCumulative([{ v: 100 }, { v: 50 }, { v: 200 }, { v: 50 }]), [100, 150, 350, 400]); // dips → accumulate
});

test('fractionAt reads the cumulative fraction along the curve', () => {
  const cum = [1000, 3000];
  assert.equal(fc.fractionAt(cum, 0), 1000 / 3000);
  assert.equal(fc.fractionAt(cum, 1), 1);
  assert.equal(fc.fractionAt(cum, 0.5), 2000 / 3000);
});

test('shape forecast scales the current value by last time’s fraction-by-now', () => {
  // KFF: ~95% of the way through the cycle, current 41,029 → ~level with last year.
  const r = (10 + 10 / 22) / (KFF.length - 1);
  const proj = fc.shapeForecast({ cum: KFF, currentValue: 41029, r });
  assert.ok(proj > 43000 && proj < 45000, `shape projection ~44k, got ${Math.round(proj)}`);
});

test('forecast verdict flips with the target (real KFF curve)', () => {
  const r = (10 + 10 / 22) / (KFF.length - 1);
  const base = { cum: KFF, currentValue: 41029, r, daysLeft: 12, recentRatePerDay: 230 };
  assert.equal(fc.forecast({ ...base, target: 60000 }).status, 'short', '60k target is out of reach');
  assert.equal(fc.forecast({ ...base, target: 45000 }).status, 'borderline', '45k is borderline');
  assert.equal(fc.forecast({ ...base, target: 40000 }).status, 'will_hit', '40k is already in hand');
});

test('forecast returns an ordered range spanning the two signals', () => {
  const r = (10 + 10 / 22) / (KFF.length - 1);
  const f = fc.forecast({ cum: KFF, currentValue: 41029, target: 60000, r, daysLeft: 12, recentRatePerDay: 450 });
  assert.ok(f.range[0] <= f.projected && f.projected <= f.range[1], 'projected sits within the range');
  assert.ok(f.range[1] >= f.shape && f.range[1] >= f.momentum, 'range top covers both signals');
});

test('forecast is null when there is no usable curve', () => {
  assert.equal(fc.forecast({ cum: [], currentValue: 100, target: 200, r: 0.5 }), null);
});
