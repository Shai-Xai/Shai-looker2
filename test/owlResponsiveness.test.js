// Responsiveness guarantees — "for every query you get a response".
//
// The Owl loop must NEVER leave the user on an infinite "Thinking…": a hung model
// turn is cut at its budget, a hung tool (Looker) call is cut at its budget, ⏹ Stop
// cuts INTO in-flight phases (not just between them), a tool that throws or returns
// garbage becomes a graceful failure the model can talk about, identical failing
// calls short-circuit (no retry storms), a round's tool calls run in parallel, and
// exhausting the round cap still returns a well-formed result. Finally, EVERY tool
// in the registry — called with empty input — still ends in a response.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { runOwlLoop } = require('../server/owlChat');

const textMsg = (s) => ({ content: [{ type: 'text', text: s }] });
const toolUse = (name, input = {}, id = 't1') => ({ content: [{ type: 'tool_use', id, name, input }] });
const never = () => new Promise(() => {}); // a promise that never settles (a hang)
const sawToolResult = (messages) => {
  const last = messages[messages.length - 1];
  return Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
};
const base = { tools: [], messages: [{ role: 'user', content: 'q' }], ctx: {} };

test('a hung tool call is cut at toolTimeoutMs and the turn still answers', async () => {
  const llmTurn = async ({ messages }) => {
    if (sawToolResult(messages)) {
      const blob = String(messages[messages.length - 1].content[0].content);
      assert.match(blob, /tool_timeout/, 'model is told the tool timed out');
      assert.match(blob, /Do NOT retry the identical call/i, 'anti-retry guidance included');
      return textMsg('answered anyway');
    }
    return toolUse('slowTool');
  };
  const t0 = Date.now();
  const r = await runOwlLoop({ ...base, llmTurn, toolMap: { slowTool: { run: () => never() } }, toolTimeoutMs: 120, turnTimeoutMs: 5000 });
  assert.equal(r.text, 'answered anyway');
  assert.ok(Date.now() - t0 < 3000, 'came back fast, not after minutes');
  assert.equal(r.trail[0].result.reason, 'tool_timeout', 'trail records the cut');
});

test('a hung model turn is cut at turnTimeoutMs — never an infinite Thinking…', async () => {
  const t0 = Date.now();
  const r = await runOwlLoop({ ...base, llmTurn: () => never(), toolMap: {}, turnTimeoutMs: 150 });
  assert.equal(r.timedOut, true, 'flagged so the door can add its friendly line');
  assert.equal(r.text, '');
  assert.ok(Date.now() - t0 < 2000);
});

test('⏹ Stop cuts INTO an in-flight model turn', async () => {
  let stop = false;
  setTimeout(() => { stop = true; }, 80);
  const t0 = Date.now();
  const r = await runOwlLoop({ ...base, llmTurn: () => never(), toolMap: {}, turnTimeoutMs: 60000, shouldStop: () => stop });
  assert.equal(r.stopped, true);
  assert.ok(Date.now() - t0 < 2000, 'stopped within the poll interval, not the phase');
});

test('⏹ Stop cuts INTO an in-flight tool call', async () => {
  let stop = false;
  setTimeout(() => { stop = true; }, 80);
  const t0 = Date.now();
  const r = await runOwlLoop({ ...base, llmTurn: async () => toolUse('slow'), toolMap: { slow: { run: () => never() } }, toolTimeoutMs: 60000, turnTimeoutMs: 60000, shouldStop: () => stop });
  assert.equal(r.stopped, true);
  assert.ok(Date.now() - t0 < 2000);
});

test('an identical failing call short-circuits — no retry storms', async () => {
  let toolRuns = 0; let round = 0;
  const llmTurn = async () => { round++; return round <= 2 ? toolUse('bad', { x: 1 }, `t${round}`) : textMsg('gave up gracefully'); };
  const r = await runOwlLoop({ ...base, llmTurn, toolMap: { bad: { run: () => { toolRuns++; return { ok: false, reason: 'query_failed', message: 'boom' }; } } }, maxRounds: 5 });
  assert.equal(r.text, 'gave up gracefully');
  assert.equal(toolRuns, 1, 'the repeat was served from the failure cache, not re-run');
  assert.match(r.trail[1].result.message, /do NOT repeat it/i);
});

test('a round with several tool calls runs them in PARALLEL', async () => {
  const mk = (ms) => ({ run: () => new Promise((res) => setTimeout(() => res({ ok: true, rows: [] }), ms)) });
  const llmTurn = async ({ messages }) => (sawToolResult(messages) ? textMsg('done') : ({ content: [
    { type: 'tool_use', id: 'a', name: 'ta', input: {} },
    { type: 'tool_use', id: 'b', name: 'tb', input: {} },
    { type: 'tool_use', id: 'c', name: 'tc', input: {} },
  ] }));
  const t0 = Date.now();
  const r = await runOwlLoop({ ...base, llmTurn, toolMap: { ta: mk(150), tb: mk(150), tc: mk(150) } });
  assert.equal(r.text, 'done');
  assert.ok(Date.now() - t0 < 400, `three 150ms tools took ${Date.now() - t0}ms — parallel, not 450ms+ sequential`);
  assert.equal(r.trail.length, 3, 'all three in the trail');
});

test('a tool that THROWS becomes a graceful failure, not a dead turn', async () => {
  const llmTurn = async ({ messages }) => {
    if (sawToolResult(messages)) {
      assert.match(String(messages[messages.length - 1].content[0].content), /failed internally/);
      return textMsg('handled it');
    }
    return toolUse('boomTool');
  };
  const r = await runOwlLoop({ ...base, llmTurn, toolMap: { boomTool: { run: () => { throw new Error('kaboom'); } } } });
  assert.equal(r.text, 'handled it');
  assert.equal(r.trail[0].result.ok, false);
});

test('a tool returning nothing becomes a graceful failure', async () => {
  const llmTurn = async ({ messages }) => (sawToolResult(messages) ? textMsg('ok') : toolUse('emptyTool'));
  const r = await runOwlLoop({ ...base, llmTurn, toolMap: { emptyTool: { run: () => undefined } } });
  assert.equal(r.text, 'ok');
  assert.equal(r.trail[0].result.reason, 'tool_error');
});

test('exhausting the round cap still returns a well-formed result (truncated)', async () => {
  let n = 0;
  const llmTurn = async () => toolUse('t', { n: n++ }, `t${n}`); // never a final answer
  const r = await runOwlLoop({ ...base, llmTurn, toolMap: { t: { run: () => ({ ok: true, rows: [] }) } }, maxRounds: 3 });
  assert.equal(r.truncated, true, 'flagged so the door adds its friendly line');
  assert.equal(r.text, '');
  assert.equal(r.rounds, 3);
});

// ── The registry sweep: EVERY tool, empty input, through the loop → a response ──
const looker = require('../server/looker');
const queryEngine = require('../server/query')({ looker, auth: h.auth });
const createOwlTools = require('../server/owlTools');
const catalogue = require('../server/owlCatalogueSeed');
const origRequest = looker.lookerRequest;
before(() => {
  h.seedOrganiserDashboard({ model: catalogue.model, explore: catalogue.explore });
  looker.lookerRequest = async () => [];
});
after(() => { looker.lookerRequest = origRequest; });

test('every registered tool, called with EMPTY input through the loop, still yields a response', async () => {
  const tools = createOwlTools({ query: queryEngine, auth: h.auth, db: h.db, catalogue });
  const ent = h.makeEntity('Resp Co', 'Resp-org');
  const user = h.makeClient('owl-resp@client.test', [ent.id]);
  const entries = Object.entries(tools).filter(([, t]) => t && t.schema && t.run);
  assert.ok(entries.length >= 5, `registry has tools to sweep (${entries.length})`);
  for (const [name] of entries) {
    const llmTurn = async ({ messages }) => (sawToolResult(messages) ? textMsg('done') : toolUse(name, {}));
    const r = await runOwlLoop({ llmTurn, toolMap: Object.fromEntries(entries), tools: [], messages: [{ role: 'user', content: 'q' }], ctx: { user }, toolTimeoutMs: 5000, turnTimeoutMs: 5000, maxRounds: 2 });
    assert.equal(r.text, 'done', `${name} produced a response through the loop (ok or graceful refusal)`);
  }
});
