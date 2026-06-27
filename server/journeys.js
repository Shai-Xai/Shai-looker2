// ─── Journeys (Engage → Journeys) ─────────────────────────────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the journey AI drafter + the journey
// recipe routes, and contributes its system prompt to the AI audit via
// promptRegistry() (insights.js spreads this in, so the "Everything the AI is
// told" screen still shows it). A journey is a tree of `message` + `decision`
// nodes; the AI turns a plain-language description into that tree and a human
// reviews it before anything is created. Recipes live in actionTemplates.js.
// Mounts in one line from index.js.
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

// Turns a promoter's plain-language description ("if they open but don't buy in
// 2 days, text them a code; if they buy, thank them") into a STRUCTURED BRANCHING
// journey (a decision tree). Messages are nodes; decisions branch on behaviour
// (opened / clicked / bought / no response). The AI proposes; a human reviews.
const JOURNEY_SYSTEM = `You design multi-step, multi-channel marketing journeys for event organisers (tickets, festivals, live events). South African audience; amounts in Rand. A journey is a DECISION TREE: messages (email/SMS) interleaved with decision points that branch on what the customer did (opened, clicked, bought, or didn't respond).

The user describes, in plain language, what they want — including conditions like "if they open but don't click", "if they buy", "keep following up if they don't". Turn it into a concrete branching journey.

Respond with ONLY strict JSON (no markdown fences). A journey has a tree of NODES. Every node is one of two types:

{
  "name": "short journey name, <40 chars",
  "goal": "one sentence: the outcome this journey drives",
  "summary": "2-3 plain sentences a non-technical promoter can read to understand what happens and how it branches",
  "nodes": [ <node>, <node>, ... ]
}

A <node> is either a MESSAGE:
{
  "type": "message",
  "channel": "email" | "sms",
  "delayHours": 0,
  "subject": "email subject (<60 chars); empty string for SMS",
  "body": "copy. Email: 50-120 words, **bold** sparingly. SMS: <=300 chars, plain. You may use {{name}} once as a greeting and {{ticketType}} only if natural. A CTA button/link is rendered separately.",
  "ctaText": "button label, 2-4 words"
}

…or a DECISION:
{
  "type": "decision",
  "question": "the behaviour being checked, as a short question, e.g. 'After 2 days, did they buy?' or 'Did they click?'",
  "waitHours": 48,
  "branches": [
    { "label": "short outcome label, e.g. 'Bought', 'Clicked but didn't buy', 'No response'", "nodes": [ <node>, ... ] }
  ]
}

Rules:
- Model the user's conditions as DECISION nodes. Use decisions for "if they open/click/buy/don't respond".
- Each decision has 2-3 branches; each branch holds its own follow-on nodes (which may include further decisions, nested at most 2 levels deep).
- Keep it tight: aim for ~6-10 nodes total. First message usually delayHours 0; decisions wait a sensible window (24/48/72h).
- A "bought" branch should usually thank them and stop; a "no response" branch can keep nurturing.
- Never invent prices, dates or discounts not given. No spam tropes (ALL CAPS, !!!, "act now"); one tasteful emoji max. Tone: human, confident, like a great event brand.`;

async function draft({ description, clientName, clientContext, audienceCount, instructions, apiKey }) {
  const c = clientFor(apiKey);
  if (!c) { const e = new Error('AI is not configured for this client'); e.code = 'NO_API_KEY'; throw e; }
  const lines = [
    `CLIENT: ${clientName || 'an event organiser'}`,
    clientContext ? `CONTEXT: ${clientContext}` : '',
    audienceCount ? `AUDIENCE: ~${audienceCount} people` : '',
    `WHAT THEY WANT: ${description || 'A short win-back journey: email lapsed customers, and if they do not respond, follow up with an SMS offer.'}`,
  ].filter(Boolean);
  const resp = await c.messages.create({
    model: MODEL, max_tokens: 1500, thinking: { type: 'adaptive' }, output_config: { effort: 'low' },
    system: systemWith(JOURNEY_SYSTEM, instructions),
    messages: [{ role: 'user', content: lines.join('\n') }],
  });
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI did not return JSON for the journey draft');
  return JSON.parse(match[0]);
}

// Exposed to insights.promptRegistry() so the journey prompt is in the AI audit.
function promptRegistry() {
  return [{ key: 'journey', label: 'Journey draft', scope: 'Engage → Journeys: plain-language → multi-step journey', text: JOURNEY_SYSTEM }];
}

// resolveContext(entityId) → { apiKey, clientName, clientContext, instructions }
// (built in index.js, which owns the per-entity key + AI instruction layers).
function mount(app, { auth, resolveContext }) {
  app.get('/api/journeys/:entityId/recipes', auth.requireAuth, auth.requirePermission('campaigns.view'), (req, res) => {
    res.json({ recipes: actionTemplates.listJourneys() });
  });
  app.post('/api/journeys/:entityId/draft', auth.requireAuth, auth.requirePermission('campaigns.approve'), async (req, res) => {
    try {
      const ctx = resolveContext(req.params.entityId) || {};
      if (!ctx.apiKey && !process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'AI is not configured for this client' });
      const out = await draft({ description: String((req.body || {}).description || '').slice(0, 1000), ...ctx });
      res.json(out);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
}

module.exports = { mount, draft, promptRegistry, JOURNEY_SYSTEM };
