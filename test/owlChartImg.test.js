// owlChartImg — the WhatsApp chart pipeline. Pure functions (no DB/Looker), so we
// pin the routing + data-shaping + that a real PNG comes out the end.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ci = require('../server/owlChartImg');

test('wantsChart only fires when the question implies a visual', () => {
  for (const q of ['show me the daily trend', 'chart sales by event', 'break down by ticket type', 'plot revenue over time', 'sales by city'])
    assert.equal(ci.wantsChart(q), true, q);
  for (const q of ['how many tickets sold?', 'what is total revenue', 'who bought the most'])
    assert.equal(ci.wantsChart(q), false, q);
});

test('chartFromTrail picks the richest breakdown and normalises rows', () => {
  const trail = [
    { name: 'askData', result: { ok: true, rows: [{ d: 'A', m: 1 }] }, input: { measure: 'm', dimensions: ['d'] } }, // 1 row → not chartable
    { name: 'askData', result: { ok: true, rows: [{ 'e.name': 'KFF26', 's.count': '267,124' }, { 'e.name': 'Mvmt', 's.count': 98000 }] }, input: { measure: 's.count', dimensions: ['e.name'] } },
  ];
  const spec = ci.chartFromTrail(trail, { label: (f) => ({ 's.count': 'Tickets', 'e.name': 'Event' }[f]), dimType: () => '' });
  assert.equal(spec.title, 'Tickets by Event');
  assert.deepEqual(spec.cats, ['KFF26', 'Mvmt']);
  assert.deepEqual(spec.data, [267124, 98000]); // "267,124" string coerced to number
  assert.equal(spec.type, 'bar');
});

test('chartFromTrail returns null when only ONE scalar (no comparison)', () => {
  const trail = [{ name: 'askData', result: { ok: true, rows: [{ m: 5 }] }, input: { measure: 'm', dimensions: [] } }];
  assert.equal(ci.chartFromTrail(trail), null);
});

test('chartFromTrail builds a comparison from several single-value queries (May vs June)', () => {
  // The "compare two months" case: two scalar revenue lookups distinguished by dateRange.
  const trail = [
    { name: 'askData', result: { ok: true, rows: [{ 'rev.total': 1066650 }] }, input: { measure: 'rev.total', dimensions: [], filters: { 'org': 'Movement' }, dateRange: 'May 2026' } },
    { name: 'askData', result: { ok: true, rows: [{ 'rev.total': 1705000 }] }, input: { measure: 'rev.total', dimensions: [], filters: { 'org': 'Movement' }, dateRange: 'June 2026' } },
  ];
  const spec = ci.chartFromTrail(trail, { label: (f) => ({ 'rev.total': 'Revenue', '__date': 'Month' }[f]), dateDim: '__date' });
  assert.ok(spec, 'should produce a comparison chart');
  assert.deepEqual(spec.cats, ['May 2026', 'June 2026']); // labelled by the differing filter (date), not the identical org lock
  assert.deepEqual(spec.data, [1066650, 1705000]);
  assert.equal(spec.title, 'Revenue by Month');
  assert.equal(spec.type, 'line'); // a per-date comparison is a time series → line
});

test('per-day scalar lookups become a line chart (the "daily revenue last 7 days" case)', () => {
  const days = ['2026-06-27', '2026-06-28', '2026-06-29'];
  const vals = [61082, 58849, 78108];
  const trail = days.map((d, i) => ({ name: 'askData', result: { ok: true, rows: [{ 'rev.total': vals[i] }] }, input: { measure: 'rev.total', dimensions: [], filters: { 'd.date': d } } }));
  const spec = ci.chartFromTrail(trail, { label: (f) => 'Revenue', dateDim: 'd.date' });
  assert.equal(spec.type, 'line');
  assert.deepEqual(spec.cats, days);
  assert.deepEqual(spec.data, vals);
});

test('comparison ignores measures that differ (no apples-to-oranges bars)', () => {
  const trail = [
    { name: 'askData', result: { ok: true, rows: [{ 'rev.total': 100 }] }, input: { measure: 'rev.total', dimensions: [], dateRange: 'May' } },
    { name: 'askData', result: { ok: true, rows: [{ 'tix.count': 50 }] }, input: { measure: 'tix.count', dimensions: [], dateRange: 'June' } },
  ];
  // Only one call per measure → no like-for-like pair → null.
  assert.equal(ci.chartFromTrail(trail), null);
});

test('a date dimension renders as a line', () => {
  const trail = [{ name: 'askData', result: { ok: true, rows: [{ day: '2026-01-01', m: 1 }, { day: '2026-01-02', m: 2 }] }, input: { measure: 'm', dimensions: ['day'] } }];
  const spec = ci.chartFromTrail(trail, { dimType: () => 'date' });
  assert.equal(spec.type, 'line');
});

test('renderPng emits a valid PNG buffer', () => {
  const spec = { title: 'T', cats: ['A', 'B', 'C'], data: [3, 2, 1], type: 'bar' };
  const png = ci.renderPng(spec);
  assert.ok(Buffer.isBuffer(png) && png.length > 1000);
  assert.equal(png.slice(0, 4).toString('hex'), '89504e47'); // PNG magic bytes
});
