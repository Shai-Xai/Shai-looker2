// ─── Journeys (Engage → Journeys) ─────────────────────────────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the journey-building Owl (a
// conversational, data-aware assistant) + the journey recipe list, and
// contributes its system prompt to the AI audit via promptRegistry() (insights.js
// spreads this in). A journey is a tree of `message` + `decision` nodes; the Owl
// turns a conversation into that tree, grounded in the client's real segments,
// and a human reviews it before anything is created. Recipes (starter prompts)
// live in actionTemplates.js. Mounts in one line from index.js.
const Anthropic = require('@anthropic-ai/sdk');
const actionTemplates = require('./actionTemplates');

const MODEL = 'claude-opus-4-8';

// One Anthropic client per API key (kept local so this module has no dependency
// on insights.js — a clean, removable unit).
const clients = new Map();
function clientFor(apiKey) {
  const key = (apiKey || process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return null;
  if (!clients.has(key)) clients.set(key, new Anthropic({ apiKey: key }));
  return clients.get(key);
}
function systemWith(base, instructions) {
  const extra = (instructions || '').trim();
  return extra ? `${base}\n\nStanding instructions from the Howler team — always follow these:\n${extra}` : base;
}

// The Owl as a journey builder: converses, grounds targeting in the client's real
// audiences (via the list_audiences tool), and emits/updates the decision tree
// (via the propose_journey tool). Proposes only — a human reviews and launches.
const OWL_JOURNEY_SYSTEM = `You are the Owl 🦉 — Howler Pulse's assistant — helping an event organiser build a marketing JOURNEY by talking to them. Warm, direct, concise; one or two short sentences per reply, no walls of text. You never send anything; everything you make is a draft the human reviews and approves in Pulse.

A journey is a DECISION TREE: email/SMS messages interleaved with decision points that branch on what the customer did (opened, clicked, bought, or didn't respond).

How to work:
- If the request is clear enough, propose a concrete journey straight away. If a key detail is genuinely missing (who to target, the goal), ask ONE short question — don't interrogate.
- Ground targeting in the client's REAL data: call the list_audiences tool to see their saved segments before suggesting who to target, and refer to them by name ("your 'Lapsed VIPs' segment — 1,240 people").
- Whenever you have a concrete journey, or the user asks for a change, call the propose_journey tool to show/update the tree. Then tell the user in one line what you did or ask what to tweak.
- Escalate channels sensibly (email → SMS for urgency). A "bought" branch usually thanks them and stops; a "no response" branch can keep nurturing.
- Never invent prices, dates or discounts not given. No spam tropes (ALL CAPS, !!!, "act now"); one tasteful emoji max. South African audience, amounts in Rand.

The propose_journey tool takes a journey { name, goal, summary, nodes }. Each node is either:
- a MESSAGE: { "type":"message", "channel":"email"|"sms", "delayHours":0, "subject":"(email only, <60 chars; empty for SMS)", "body":"(email 50-120 words, SMS <=300 chars; may use {{name}} once and {{ticketType}} if natural)", "ctaText":"2-4 words" }
- a DECISION: { "type":"decision", "question":"e.g. 'After 2 days, did they buy?'", "waitHours":48, "branches":[ { "label":"e.g. 'Bought' / 'Clicked but didn't buy' / 'No response'", "nodes":[ ...nodes... ] } ] }
Keep it tight (~6-10 nodes); decisions 2-3 branches; nest at most 2 levels deep.`;

const JOURNEY_SCHEMA = {
  type: 'object',
  required: ['name', 'nodes'],
  properties: {
    name: { type: 'string', description: 'short journey name, <40 chars' },
    goal: { type: 'string', description: 'one sentence: the outcome this journey drives' },
    summary: { type: 'string', description: '2-3 plain sentences on what happens and how it branches' },
    nodes: { type: 'array', description: 'ordered tree of message/decision nodes', items: { type: 'object' } },
  },
};
const TOOLS = [
  { name: 'list_audiences', description: "List the client's saved segments/audiences (with sizes) so journey targeting is grounded in real data. Call before suggesting who to target.", input_schema: { type: 'object', properties: {} } },
  { name: 'propose_journey', description: 'Show or update the journey decision tree for the user to review. Call whenever you have a concrete journey or a change to it.', input_schema: JOURNEY_SCHEMA },
];

function audiencesFor(db, entityId) {
  try {
    const rows = db.db.prepare('SELECT name, last_count AS people, last_email AS emailReach, last_sms AS smsReach FROM segments WHERE entity_id=? ORDER BY updated_at DESC LIMIT 40').all(entityId);
    return rows.map((r) => ({ name: r.name, people: r.people < 0 ? 'not yet counted' : r.people, emailReach: r.emailReach, smsReach: r.smsReach }));
  } catch { return []; }
}

// Run one conversational turn: the client sends the running text history + the
// current journey draft; the Owl replies and (via tools) may look up audiences
// and/or emit an updated tree. Returns { reply, journey }.
async function chat({ messages, currentJourney, clientName, clientContext, instructions, apiKey, lookupAudiences }) {
  const c = clientFor(apiKey);
  if (!c) throw new Error('AI is not configured for this client');
  const ctxBits = [
    clientName ? `You are helping: ${clientName}.` : '',
    clientContext ? `Client context: ${clientContext}` : '',
    currentJourney ? `The journey draft so far (modify it when asked):\n${JSON.stringify(currentJourney)}` : 'No journey drafted yet.',
  ].filter(Boolean).join('\n');
  const system = systemWith(`${OWL_JOURNEY_SYSTEM}\n\n${ctxBits}`, instructions);
  const convo = (messages || []).slice(-24)
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.text || '').slice(0, 4000) }))
    .filter((m) => m.content);
  if (!convo.length) return { reply: '', journey: currentJourney || null };

  let journey = currentJourney || null;
  let reply = '';
  for (let i = 0; i < 5; i++) {
    const resp = await c.messages.create({ model: MODEL, max_tokens: 1800, thinking: { type: 'adaptive' }, output_config: { effort: 'low' }, system, tools: TOOLS, messages: convo });
    reply = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim() || reply;
    const toolUses = (resp.content || []).filter((b) => b.type === 'tool_use');
    if (resp.stop_reason !== 'tool_use' || !toolUses.length) break;
    convo.push({ role: 'assistant', content: resp.content });
    const results = [];
    for (const tu of toolUses) {
      if (tu.name === 'propose_journey') { journey = tu.input; results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Journey updated and shown to the user.' }); }
      else if (tu.name === 'list_audiences') { results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(lookupAudiences ? lookupAudiences() : []).slice(0, 4000) }); }
      else results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Unknown tool' });
    }
    convo.push({ role: 'user', content: results });
  }
  return { reply, journey };
}

// Exposed to insights.promptRegistry() so the journey Owl prompt is in the AI audit.
function promptRegistry() {
  return [{ key: 'journey', label: 'Journey Owl', scope: 'Engage → Journeys: conversational, data-aware journey builder', text: OWL_JOURNEY_SYSTEM }];
}

// resolveContext(entityId) → { apiKey, clientName, clientContext, instructions }
// (built in index.js, which owns the per-entity key + AI instruction layers).
function mount(app, { auth, db, resolveContext }) {
  app.get('/api/journeys/:entityId/recipes', auth.requireAuth, auth.requirePermission('campaigns.view'), (req, res) => {
    res.json({ recipes: actionTemplates.listJourneys() });
  });
  app.post('/api/journeys/:entityId/chat', auth.requireAuth, auth.requirePermission('campaigns.approve'), async (req, res) => {
    try {
      const ctx = resolveContext(req.params.entityId) || {};
      if (!ctx.apiKey && !process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'AI is not configured for this client' });
      const out = await chat({
        messages: (req.body || {}).messages || [],
        currentJourney: (req.body || {}).currentJourney || null,
        ...ctx,
        lookupAudiences: () => audiencesFor(db, req.params.entityId),
      });
      res.json(out);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
}

module.exports = { mount, chat, promptRegistry, OWL_JOURNEY_SYSTEM };
