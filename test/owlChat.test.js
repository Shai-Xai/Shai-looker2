// Owl chat loop tests — the orchestration that ties the model to the tools.
//
// runOwlLoop is tested with a FAKE llmTurn (queued responses) so no real model is
// needed, but REAL owlTools + the REAL scope engine (Looker stubbed). This pins:
//   - a tool_use is executed under scope and its result fed back, then the model
//     produces a grounded final answer,
//   - a scope failure surfaces to the model as ok:false (never a fabricated number),
//   - a no-tool turn returns immediately,
//   - an unknown tool is handled, not thrown.

const { test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const looker = require('../server/looker');
const queryEngine = require('../server/query')({ looker, auth: h.auth });
const createOwlTools = require('../server/owlTools');
const catalogue = require('../server/owlCatalogueSeed');
const { runOwlLoop } = require('../server/owlChat');

before(() => { h.seedOrganiserDashboard({ model: catalogue.model, explore: catalogue.explore }); });

let lookerCalls = 0;
const origRequest = looker.lookerRequest;
beforeEach(() => {
  lookerCalls = 0;
  looker.lookerRequest = async () => { lookerCalls++; return [{ 'all_tickets.sold_tickets': 42 }]; };
});
afterEach(() => { looker.lookerRequest = origRequest; });

// A fake model: returns queued responses in order, recording what it was sent.
function fakeLlm(responses) {
  const calls = [];
  const llmTurn = async ({ messages, tools, onText }) => {
    calls.push({ messages: messages.map((m) => m.role), tools });
    const r = responses.shift();
    for (const b of r.content) if (b.type === 'text' && onText) onText(b.text);
    return r;
  };
  return { llmTurn, calls };
}

const owlTools = () => createOwlTools({ query: queryEngine });
const toolBits = () => {
  const t = owlTools();
  return { toolMap: { askData: t.askData }, tools: [t.askData.schema] };
};

test('a tool_use runs under scope, then the model answers from the result', async () => {
  const ent = h.makeEntity('Ultra SA', 'Ultra South Africa');
  const user = h.makeClient('chat-a@client.test', [ent.id]);
  const { llmTurn } = fakeLlm([
    { content: [{ type: 'tool_use', id: 'tu1', name: 'askData', input: { measure: 'all_tickets.sold_tickets' } }] },
    { content: [{ type: 'text', text: 'You sold 42 tickets.' }] },
  ]);
  let streamed = '';
  const { text, trail, rounds } = await runOwlLoop({
    llmTurn, ...toolBits(),
    messages: [{ role: 'user', content: 'How many tickets did I sell?' }],
    ctx: { user },
    onText: (t) => { streamed += t; },
  });
  assert.equal(text, 'You sold 42 tickets.');
  assert.equal(streamed, 'You sold 42 tickets.');
  assert.equal(rounds, 2);
  assert.equal(trail.length, 1);
  assert.equal(trail[0].result.ok, true);
  assert.equal(trail[0].result.queryBody.filters[h.ORG_FIELD], 'Ultra South Africa'); // ran scoped
  assert.equal(lookerCalls, 1);
});

test('a scope failure reaches the model as ok:false (no fabricated number)', async () => {
  const ent = h.makeEntity('Misconfigured Co', null); // no organiser → fails closed
  const user = h.makeClient('chat-b@client.test', [ent.id]);
  let toolResultSeen = null;
  const responses = [
    { content: [{ type: 'tool_use', id: 'tu1', name: 'askData', input: { measure: 'all_tickets.sold_tickets' } }] },
    { content: [{ type: 'text', text: "I can't answer that — no data scope is set." }] },
  ];
  // Spy on what the model is fed after the tool runs (the 2nd turn's last message).
  const llmTurn = async ({ messages, onText }) => {
    const last = messages[messages.length - 1];
    if (last.role === 'user' && Array.isArray(last.content)) toolResultSeen = last.content[0];
    const r = responses.shift();
    for (const b of r.content) if (b.type === 'text' && onText) onText(b.text);
    return r;
  };
  const { trail, text } = await runOwlLoop({
    llmTurn, ...toolBits(),
    messages: [{ role: 'user', content: 'Revenue?' }],
    ctx: { user },
  });
  assert.equal(trail[0].result.ok, false);
  assert.equal(trail[0].result.reason, 'no_scope');
  assert.equal(lookerCalls, 0); // never reached Looker
  assert.match(toolResultSeen.content, /"ok":false/); // model was told the truth
  assert.match(text, /can't answer/);
});

test('a no-tool turn returns immediately', async () => {
  const user = h.makeClient('chat-c@client.test', [h.makeEntity('A', 'A-org').id]);
  const { llmTurn } = fakeLlm([{ content: [{ type: 'text', text: 'Hi! Ask me about your ticket sales.' }] }]);
  const { text, trail, rounds } = await runOwlLoop({
    llmTurn, ...toolBits(),
    messages: [{ role: 'user', content: 'hello' }],
    ctx: { user },
  });
  assert.equal(text, 'Hi! Ask me about your ticket sales.');
  assert.equal(trail.length, 0);
  assert.equal(rounds, 1);
  assert.equal(lookerCalls, 0);
});

test('an unknown tool is handled, not thrown', async () => {
  const user = h.makeClient('chat-d@client.test', [h.makeEntity('A', 'A-org').id]);
  const { llmTurn } = fakeLlm([
    { content: [{ type: 'tool_use', id: 'tu1', name: 'frobnicate', input: {} }] },
    { content: [{ type: 'text', text: 'Sorry, I can\'t do that.' }] },
  ]);
  const { trail } = await runOwlLoop({
    llmTurn, ...toolBits(),
    messages: [{ role: 'user', content: 'frobnicate please' }],
    ctx: { user },
  });
  assert.equal(trail[0].result.ok, false);
  assert.equal(trail[0].result.reason, 'unknown_tool');
});
