// House-style copy normalisation: em dashes (—) read as unprofessional in Pulse
// copy, so deEmDash rewrites them (and en dash / horizontal bar) to a spaced
// hyphen. These guard the replacement rules + that it leaves everything else alone.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deEmDash, deEmDashDeep, hasEmDash } = require('../server/textStyle');

test('deEmDash: em/en/other dashes normalise to a spaced hyphen', () => {
  assert.equal(deEmDash('Full access — dashboards and more.'), 'Full access - dashboards and more.');
  assert.equal(deEmDash('mix/split—shares'), 'mix/split - shares');   // unspaced em dash
  assert.equal(deEmDash('range 10–20'), 'range 10 - 20');             // en dash
  assert.equal(deEmDash('a ― b'), 'a - b');                           // horizontal bar
});

test('deEmDash: leaves ASCII hyphen, math minus and ordinary text untouched', () => {
  assert.equal(deEmDash('per-event branding'), 'per-event branding'); // hyphen stays
  assert.equal(deEmDash('temperature is −5'), 'temperature is −5');   // math minus stays
  assert.equal(deEmDash('no dashes here'), 'no dashes here');
});

test('deEmDash: is idempotent and never crosses a line break', () => {
  const once = deEmDash('Watch a number — get pinged.');
  assert.equal(deEmDash(once), once);                                 // idempotent
  assert.equal(deEmDash('line one\nline two'), 'line one\nline two'); // newline preserved
  assert.equal(deEmDash('Hi,\n\nyou were close — finish up.'), 'Hi,\n\nyou were close - finish up.');
});

test('deEmDash: safe on empty / non-string values', () => {
  assert.equal(deEmDash(''), '');
  assert.equal(deEmDash(null), null);
  assert.equal(deEmDash(undefined), undefined);
  assert.equal(deEmDash(42), 42);
});

test('deEmDashDeep: walks strings inside arrays and objects, leaves other types', () => {
  const input = { subject: 'A — B', steps: [{ body: 'x—y', delay: 3 }], on: true };
  assert.deepEqual(deEmDashDeep(input), {
    subject: 'A - B', steps: [{ body: 'x - y', delay: 3 }], on: true,
  });
});

test('hasEmDash: detects em-dash-like glyphs only', () => {
  assert.equal(hasEmDash('has — one'), true);
  assert.equal(hasEmDash('en – dash'), true);
  assert.equal(hasEmDash('plain - hyphen'), false);
  assert.equal(hasEmDash(''), false);
  assert.equal(hasEmDash(null), false);
});
