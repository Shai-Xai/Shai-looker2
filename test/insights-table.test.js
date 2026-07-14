// compactTable renders a tile's rows into the pipe table every briefing/digest
// prompt is grounded in. The critical behaviour under test: when a table is over
// the row cap, the sample keeps the START and the END with the omission marker in
// the MIDDLE — a head-only slice dropped the latest rows of date-ascending
// time-series tiles, so the model read a stale mid-month cumulative as the
// current month-to-date figure (the "R11.2m when it was R18.5m" digest bug).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compactTable } = require('../server/insights');

const fields = { dimensions: [{ name: 'd.date', label_short: 'Date' }], measures: [{ name: 'm.cum', label_short: 'Cumulative' }] };
const row = (i) => ({ 'd.date': { value: `2026-07-${String(i).padStart(2, '0')}` }, 'm.cum': { value: i * 100, rendered: `R${i * 100}` } });

test('compactTable: under the cap renders every row, no marker', () => {
  const out = compactTable(fields, [row(1), row(2)], 10);
  const lines = out.split('\n');
  assert.equal(lines.length, 3); // header + 2 rows
  assert.equal(lines[0], 'Date | Cumulative');
  assert.match(lines[2], /2026-07-02 \| R200/);
  assert.doesNotMatch(out, /omitted/);
});

test('compactTable: over the cap keeps the start AND the end (marker in the middle)', () => {
  const rows = Array.from({ length: 30 }, (_, i) => row(i + 1));
  const out = compactTable(fields, rows, 9);
  const lines = out.split('\n');
  assert.equal(lines.length, 1 + 9 + 1); // header + 9 sampled rows + marker
  assert.match(lines[1], /2026-07-01/); // first row survives
  assert.match(lines[lines.length - 1], /2026-07-30 \| R3000/); // LATEST row survives — the fix
  assert.match(out, /21 middle rows omitted/); // 30 - 9
  // The marker sits between the head and the tail, not at the end.
  const markerIdx = lines.findIndex((l) => /omitted/.test(l));
  assert.ok(markerIdx > 1 && markerIdx < lines.length - 1);
});

test('compactTable: flattens pivoted measures to key:value pairs', () => {
  const pfields = { dimensions: [{ name: 'd.day', label_short: 'Day' }], measures: [{ name: 'm.rev', label_short: 'Revenue' }] };
  const prow = { 'd.day': { value: 13 }, 'm.rev': { 2025: { rendered: 'R8.84m' }, 2026: { rendered: 'R11.19m' } } };
  const out = compactTable(pfields, [prow], 10);
  assert.match(out, /13 \| 2025:R8\.84m 2026:R11\.19m/);
});
