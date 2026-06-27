// Reporting currency: the resolved display currency for a client (NOT the billing
// currency, NOT a data filter). These guard the formatting + the AI prompt note
// that makes the Owl write amounts in the client's currency.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const currency = require('../server/currency');

test('normalize: unknown/blank falls back to the ZAR platform default; known codes pass through', () => {
  assert.equal(currency.normalize(''), 'ZAR');
  assert.equal(currency.normalize(null), 'ZAR');
  assert.equal(currency.normalize('made-up'), 'ZAR');
  assert.equal(currency.normalize('usd'), 'USD');   // case-insensitive
  assert.equal(currency.normalize(' EUR '), 'EUR');  // trimmed
});

test('format: symbol-prefixed, currency-appropriate decimals', () => {
  assert.equal(currency.format(1234.5, 'ZAR'), 'R1,234.50');
  assert.equal(currency.format(1234.5, 'USD'), '$1,234.50');
  assert.equal(currency.format(1000, 'JPY'), '¥1,000');  // 0-decimal currency
  assert.equal(currency.format('not a number', 'USD'), '');
});

test('aiNote: empty for the ZAR default, explicit override otherwise', () => {
  assert.equal(currency.aiNote('ZAR'), '');   // prompts already assume Rand
  assert.equal(currency.aiNote(''), '');       // blank → default → no note
  const usd = currency.aiNote('USD');
  assert.match(usd, /US Dollar \(USD\)/);
  assert.match(usd, /NOT South African Rand/);
  assert.match(usd, /\$/);
});

test('list: every entry is well-formed and ZAR leads the picker', () => {
  const list = currency.list();
  assert.equal(list[0].code, 'ZAR');
  for (const c of list) {
    assert.ok(c.code && c.symbol && c.name, `malformed entry: ${JSON.stringify(c)}`);
    assert.equal(currency.normalize(c.code), c.code, `${c.code} should be a known code`);
  }
});
