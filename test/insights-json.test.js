// AI core — the resilient model→JSON parser (server/insights.js). This is the
// deterministic salvage layer every AI feature depends on: the model returns text
// that's *usually* JSON but is sometimes wrapped in prose/fences, has trailing
// commas, raw control chars, or is truncated when it hits the token cap. These
// tests pin that behaviour (no network — pure parsing + repair) so the four
// extractors routed through it (M10) stay 500-proof.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseModelJson, parseModelJsonResilient, systemWith } = require('../server/insights');

test('parses clean JSON', () => {
  assert.deepEqual(parseModelJson('{"a":1,"b":"x"}'), { a: 1, b: 'x' });
});

test('strips ```json fences', () => {
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
});

test('extracts an object embedded in prose', () => {
  assert.deepEqual(parseModelJson('Sure! Here it is: {"ok":true} — done.'), { ok: true });
});

test('repairs trailing commas', () => {
  assert.deepEqual(parseModelJson('{"a":1,"b":[1,2,],}'), { a: 1, b: [1, 2] });
});

test('salvages JSON truncated mid-value (hit the token cap)', () => {
  const out = parseModelJson('{"headline":"Sales are up","bullets":["first","seco');
  assert.equal(out.headline, 'Sales are up');
  assert.ok(Array.isArray(out.bullets));
  assert.ok(out.bullets.includes('first'), 'keeps the complete earlier element');
});

test('escapes a raw newline inside a string value', () => {
  const out = parseModelJson('{"note":"line one\nline two"}');
  assert.equal(typeof out.note, 'string');
  assert.match(out.note, /line one/);
});

test('throws a labelled error on non-JSON', () => {
  assert.throws(() => parseModelJson('totally not json', 'tile'), /tile/);
});

test('resilient parser does NOT call the model when static repair succeeds', async () => {
  let called = false;
  const client = { messages: { create: async () => { called = true; return { content: [] }; } } };
  const out = await parseModelJsonResilient(client, '{"a":1,}', 'thing'); // trailing comma → static fix
  assert.deepEqual(out, { a: 1 });
  assert.equal(called, false, 'static repair handled it — no model round-trip');
});

test('resilient parser falls back to model repair when static repair cannot', async () => {
  const client = {
    messages: { create: async () => ({ content: [{ type: 'text', text: '{"fixed":true}' }] }) },
  };
  const out = await parseModelJsonResilient(client, 'there is no json here at all', 'thing');
  assert.deepEqual(out, { fixed: true });
});

test('systemWith returns the base prompt unchanged when there are no instructions', () => {
  assert.equal(systemWith('BASE', ''), 'BASE');
  assert.equal(systemWith('BASE', '   '), 'BASE'); // whitespace-only is "none"
  assert.equal(systemWith('BASE', null), 'BASE');
});

test('systemWith appends client standing instructions under a clear, labelled section', () => {
  const out = systemWith('BASE PROMPT', 'Always mention the VIP package.');
  assert.match(out, /^BASE PROMPT/);
  assert.match(out, /Standing instructions from the Howler team/);
  assert.match(out, /Always mention the VIP package\./);
});
