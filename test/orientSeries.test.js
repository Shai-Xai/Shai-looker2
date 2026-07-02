// Chronological orientation of tile series (tileValues.orientSeries) + the pace
// read it protects. Guards the 1-vs-247 bug: a "days before event" tile whose rows
// arrive ascending (event day first, 0→117) was accumulated backwards in time, which
// flipped the countdown detector and made "last time by now" read the wrong end of
// the curve (≈1 ticket instead of the real by-now cumulative).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('../server/forecast');
// The factory only needs `query` for the Looker-bound readers; orientSeries is pure.
const { orientSeries } = require('../server/tileValues')({ db: {}, query: {} });

test('countdown axis (by name) arriving ascending is flipped to oldest-first (desc)', () => {
  const asc = [0, 1, 2, 50, 117].map((d) => ({ t: String(d), v: 10 }));
  const out = orientSeries(asc, 'core_tickets.days_before_event');
  assert.deepEqual(out.map((p) => p.t), ['117', '50', '2', '1', '0']);
});

test('countdown axis already oldest-first is left in order', () => {
  const desc = [117, 50, 0].map((d) => ({ t: String(d), v: 5 }));
  assert.deepEqual(orientSeries(desc, 'Days Before Event').map((p) => p.t), ['117', '50', '0']);
});

test('a "day" axis that includes 0 with range > 31 counts as countdown even unnamed', () => {
  const asc = [0, 10, 40, 90].map((d) => ({ t: String(d), v: 1 }));
  assert.deepEqual(orientSeries(asc, 'facts.event_day_axis').map((p) => p.t), ['90', '40', '10', '0']);
});

test('day-of-month (1..31) and week numbers stay ascending; ISO dates sort ascending; categories untouched', () => {
  const dom = [3, 1, 2].map((d) => ({ t: String(d), v: 1 }));
  assert.deepEqual(orientSeries(dom, 'orders.created_day_of_month').map((p) => p.t), ['1', '2', '3']);
  const iso = [{ t: '2026-03-02', v: 1 }, { t: '2026-03-01', v: 2 }];
  assert.deepEqual(orientSeries(iso, 'orders.created_date').map((p) => p.t), ['2026-03-01', '2026-03-02']);
  const cats = [{ t: 'VIP', v: 1 }, { t: 'GA', v: 2 }];
  assert.deepEqual(orientSeries(cats, 'ticket_types.name').map((p) => p.t), ['VIP', 'GA']);
});

test('stray totals/null rows: dropped on a numeric axis, mixed/categorical left alone', () => {
  // 10 numeric countdown points + a blank-label totals row → strays dropped, sorted desc.
  const pts = [];
  for (let d = 0; d <= 9; d++) pts.push({ t: String(d), v: d + 1 });
  pts.push({ t: '', v: 55 }); // totals row — would double-count once accumulated
  const out = orientSeries(pts, 'days_before_event');
  assert.deepEqual(out.map((p) => p.t), ['9', '8', '7', '6', '5', '4', '3', '2', '1', '0']);
  // Half numeric / half labels (<80%) → not an axis; keep the tile's row order.
  const mixed = [{ t: 'VIP', v: 1 }, { t: '3', v: 2 }, { t: 'GA', v: 3 }, { t: '1', v: 4 }];
  assert.deepEqual(orientSeries(mixed, 'ticket_types.name').map((p) => p.t), ['VIP', '3', 'GA', '1']);
});

test('regression: ascending countdown rows now yield the true "last time by now"', () => {
  // Last event: 117d of DAILY sales (jittered like real data — a constant series would
  // read as already-cumulative), back-loaded toward the event.
  const daily = [];
  for (let d = 117; d >= 0; d--) daily.push({ d, v: (d >= 65 ? 4 : 60) + (d % 3) }); // slow early, ramp late
  const expectedByNow = daily.filter((p) => p.d >= 65).reduce((s, p) => s + p.v, 0); // cumulative at 65d out
  const expectedTotal = daily.reduce((s, p) => s + p.v, 0);
  // The tile delivers rows ASCENDING (event day first) — the shape that broke.
  const ascendingRows = [...daily].sort((a, b) => a.d - b.d).map((p) => ({ t: String(p.d), v: p.v }));
  const oriented = orientSeries(ascendingRows, 'core_tickets.days_before_event');
  const at = fc.fractionAtNow(oriented, { daysLeft: 65 });
  assert.equal(at.basis, 'days-before');           // detector sees the countdown again
  assert.ok(Math.abs(at.valueAtNow - expectedByNow) < 1, `valueAtNow ${at.valueAtNow} ≈ ${expectedByNow}`);
  assert.ok(Math.abs(at.total - expectedTotal) < 1);
  // Un-oriented (the old behaviour) reads the wrong end of the curve — the bug.
  const bad = fc.fractionAtNow(ascendingRows, { daysLeft: 65, startMs: Date.now() - 2 * 86400000, deadlineMs: Date.now() + 65 * 86400000 });
  assert.notEqual(bad?.basis, 'days-before');
});
