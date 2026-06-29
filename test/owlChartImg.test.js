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

test('chartFromTrail returns null when nothing is chartable (scalar answer)', () => {
  const trail = [{ name: 'askData', result: { ok: true, rows: [{ m: 5 }] }, input: { measure: 'm', dimensions: [] } }];
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
