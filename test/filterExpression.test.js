// Combined-field OR filters: the composite-key codec + the Looker filter_expression
// builder. These guard the exact string sent to Looker (cross-field OR is ONLY
// expressible via filter_expression) and the tile-applicability narrowing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fx = require('../server/filterExpression');

test('makeCombinedKey: single "is" field stays plain (backward compatible)', () => {
  assert.equal(fx.makeCombinedKey('is', ['core_ticket_categories.name']), 'core_ticket_categories.name');
  assert.equal(fx.isCombinedKey('core_ticket_categories.name'), false);
});

test('makeCombinedKey/parseCombinedKey: multi-field round-trips', () => {
  const key = fx.makeCombinedKey('is', ['a.x', 'b.y']);
  assert.equal(key, '__or__:is:a.x|b.y');
  assert.ok(fx.isCombinedKey(key));
  assert.deepEqual(fx.parseCombinedKey(key), { op: 'is', fields: ['a.x', 'b.y'] });
});

test('makeCombinedKey: a non-"is" operator encodes even for one field', () => {
  assert.equal(fx.makeCombinedKey('contains', ['a.x']), '__or__:contains:a.x');
  assert.equal(fx.makeCombinedKey('is_not', ['a.x']), '__or__:is_not:a.x');
});

test('parseCombinedKey: rejects junk / unknown operators', () => {
  assert.equal(fx.parseCombinedKey('a.x'), null);
  assert.equal(fx.parseCombinedKey('__or__:bogus:a.x'), null);
  assert.equal(fx.parseCombinedKey('__or__:is:'), null);
});

test('buildOrGroup: is → cross-field OR of ${field} = "value"', () => {
  assert.equal(
    fx.buildOrGroup(['core_ticket_categories.name', 'product.addon_category'], 'is', ['VIP']),
    '(${core_ticket_categories.name} = "VIP" OR ${product.addon_category} = "VIP")',
  );
});

test('buildOrGroup: multiple values fan out across every field', () => {
  assert.equal(
    fx.buildOrGroup(['a.x', 'b.y'], 'is', ['P', 'Q']),
    '(${a.x} = "P" OR ${a.x} = "Q" OR ${b.y} = "P" OR ${b.y} = "Q")',
  );
});

test('buildOrGroup: contains → contains(); is_not → NOT(...)', () => {
  assert.equal(fx.buildOrGroup(['a.x'], 'contains', ['blue']), '(contains(${a.x}, "blue"))');
  assert.equal(
    fx.buildOrGroup(['a.x', 'b.y'], 'is_not', ['VIP']),
    'NOT (${a.x} = "VIP" OR ${b.y} = "VIP")',
  );
});

test('buildOrGroup: escapes quotes/backslashes and drops empties', () => {
  assert.equal(fx.buildOrGroup(['a.x'], 'is', ['say "hi"']), '(${a.x} = "say \\"hi\\"")');
  assert.equal(fx.buildOrGroup([], 'is', ['x']), '');
  assert.equal(fx.buildOrGroup(['a.x'], 'is', []), '');
});

test('combinedExpression: AND-joins multiple blocks', () => {
  const expr = fx.combinedExpression([
    { fields: ['a.x', 'b.y'], op: 'is', value: 'VIP' },
    { fields: ['c.z'], op: 'contains', values: ['gold'] },
  ]);
  assert.equal(expr, '(${a.x} = "VIP" OR ${b.y} = "VIP") AND (contains(${c.z}, "gold"))');
});

test('combinedBlocksFromLockMap: pulls only combined keys', () => {
  const blocks = fx.combinedBlocksFromLockMap({
    'core_organisers.name': 'Org',                 // plain — ignored
    '__or__:is:a.x|b.y': 'VIP',
  });
  assert.deepEqual(blocks, [{ op: 'is', fields: ['a.x', 'b.y'], value: 'VIP' }]);
});

test('blocksForQuery: keeps only fields the tile query joins', () => {
  const query = { view: 'a', fields: ['a.count', 'b.name'] }; // joins views a, b — not c
  const blocks = [{ op: 'is', fields: ['a.x', 'c.z'], value: 'VIP' }];
  assert.deepEqual(fx.blocksForQuery(blocks, query), [{ op: 'is', fields: ['a.x'], values: ['VIP'] }]);
});

test('blocksForQuery: drops blocks with no applicable field, blank, or ANY_VALUE', () => {
  const query = { view: 'a', fields: ['a.count'] };
  assert.deepEqual(fx.blocksForQuery([{ op: 'is', fields: ['z.z'], value: 'X' }], query), []);
  assert.deepEqual(fx.blocksForQuery([{ op: 'is', fields: ['a.x'], value: '' }], query), []);
  assert.deepEqual(fx.blocksForQuery([{ op: 'is', fields: ['a.x'], value: ' __ANY_VALUE__' }], query, { anyValue: ' __ANY_VALUE__' }), []);
});

test('applyCombinedToBody: sets filter_expression and AND-appends to an existing one', () => {
  const body = { view: 'a', fields: ['a.count', 'b.name'], filters: { 'core_organisers.name': 'Org' } };
  fx.applyCombinedToBody(body, [{ op: 'is', fields: ['a.x', 'b.y'], value: 'VIP' }], body);
  assert.equal(body.filter_expression, '(${a.x} = "VIP" OR ${b.y} = "VIP")');
  // Scope stays in the filters map (Looker AND-combines the two) — never weakened.
  assert.equal(body.filters['core_organisers.name'], 'Org');

  const body2 = { view: 'a', fields: ['a.x'], filter_expression: '${a.old} = "1"' };
  fx.applyCombinedToBody(body2, [{ op: 'is', fields: ['a.x'], value: 'P' }], body2);
  assert.equal(body2.filter_expression, '(${a.old} = "1") AND (${a.x} = "P")'); // groups self-parenthesize
});

test('applyCombinedToBody: no applicable blocks leaves the body untouched', () => {
  const body = { view: 'a', fields: ['a.count'] };
  fx.applyCombinedToBody(body, [{ op: 'is', fields: ['z.z'], value: 'X' }], body);
  assert.equal(body.filter_expression, undefined);
});
