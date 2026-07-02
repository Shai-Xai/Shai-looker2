const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const aiUsage = require('../server/aiUsage');

test('priceFor longest-prefix matches models and defaults to Opus pricing', () => {
  assert.deepEqual(aiUsage.priceFor('claude-opus-4-8'), [5, 25]);
  assert.deepEqual(aiUsage.priceFor('claude-sonnet-4-6'), [3, 15]);
  assert.deepEqual(aiUsage.priceFor('claude-haiku-4-5-20251001'), [1, 5]);
  assert.deepEqual(aiUsage.priceFor('claude-sonnet-5'), [3, 15]); // longer prefix wins over claude-sonnet-4? no overlap, exact key
  assert.deepEqual(aiUsage.priceFor('some-unknown-model'), [5, 25]); // over-estimate, never under-report
});

test('costOf prices input/output/cache tokens with cache multipliers', () => {
  // 1M in + 1M out on Opus = $5 + $25; cache write 1.25×in, cache read 0.1×in.
  assert.equal(aiUsage.costOf({ model: 'claude-opus-4-8', in_tok: 1e6, out_tok: 1e6 }), 30);
  assert.equal(aiUsage.costOf({ model: 'claude-opus-4-8', cache_w: 1e6 }), 6.25);
  assert.equal(aiUsage.costOf({ model: 'claude-opus-4-8', cache_r: 1e6 }), 0.5);
});

test('wrapClient records usage with the async-local entity/kind context', async () => {
  const db = new Database(':memory:');
  aiUsage.init(db);
  const fake = { messages: { create: async (req) => ({ model: req.model, usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } }) } };
  const wrapped = aiUsage.wrapClient(fake);
  await aiUsage.run({ entityId: 'ent1', kind: 'briefing' }, () => wrapped.messages.create({ model: 'claude-sonnet-4-6' }));
  await wrapped.messages.create({ model: 'claude-opus-4-8' }); // no context → other
  // Nested contexts: inner wins, missing fields inherit from the outer scope.
  await aiUsage.run({ entityId: 'entA', kind: 'owl_chat' }, () =>
    aiUsage.run({ kind: 'email_design' }, () => wrapped.messages.create({ model: 'claude-opus-4-8' })));
  const rows = db.prepare('SELECT * FROM ai_usage ORDER BY rowid').all();
  assert.equal(rows.length, 3);
  assert.equal(rows[0].entity_id, 'ent1');
  assert.equal(rows[0].kind, 'briefing');
  assert.equal(rows[0].in_tok, 100);
  assert.equal(rows[0].out_tok, 40);
  assert.equal(rows[0].cache_r, 10);
  assert.equal(rows[0].cache_w, 5);
  assert.equal(rows[1].kind, 'other');
  assert.equal(rows[2].entity_id, 'entA');
  assert.equal(rows[2].kind, 'email_design');
});
