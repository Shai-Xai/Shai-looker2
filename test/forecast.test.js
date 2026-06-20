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

test('fractionAtNow reads last year’s ACTUAL value at days-before = days-left (not by index)', () => {
  // x-axis is "days before the event" (the ticket trend tile). 11 days out last year
  // was 46k, not the ~50k an index-position guess (≈7 days out) would give.
  const series = [
    { t: '30', v: 40000 }, { t: '20', v: 44000 }, { t: '11', v: 46000 },
    { t: '5', v: 52000 }, { t: '0', v: 55000 }, { t: '-2', v: 55997 },
  ];
  const deadlineMs = Date.now() + 11 * 86400000; // event 11 days away → read at days-before 11
  const at = fc.fractionAtNow(series, { deadlineMs });
  assert.equal(at.basis, 'days-before');
  assert.equal(at.daysLeft, 11);
  assert.equal(at.total, 55997, 'total = last year’s final (post-event) cumulative');
  assert.ok(Math.abs(at.valueAtNow - 46000) <= 1, `last year at this point ≈ 46k, got ${Math.round(at.valueAtNow)}`);
});

test('fractionAtNow falls back to the window fraction for an ISO-date axis', () => {
  // No shared event anchor across years → position between start and deadline by index.
  const series = [{ t: '2025-01-01', v: 1000 }, { t: '2025-02-01', v: 3000 }];
  const startMs = Date.now() - 10 * 86400000, deadlineMs = Date.now() + 10 * 86400000;
  const at = fc.fractionAtNow(series, { deadlineMs, startMs });
  assert.equal(at.basis, 'window');
  assert.equal(at.total, 3000);
  assert.ok(at.valueAtNow > 1000 && at.valueAtNow < 3000, 'reads a mid-window point');
});

test('forecast is null when there is no usable curve', () => {
  assert.equal(fc.forecast({ cum: [], currentValue: 100, target: 200, r: 0.5 }), null);
});
