// ─── Owl chat — the agentic Owl's conversational loop (one of "two doors") ─────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns owl_threads + owl_messages and the
// /api/owl/* routes. Mounted from index.js with injected deps; remove that line +
// this file to uninstall.
//
// This is the human-driven "pull" door onto the same brain + tools the autonomous
// Skills will use (the "push" door). The loop:
//   user message → Claude turn (streamed) → if it calls a tool, run it (scoped) →
//   feed the result back → repeat → final grounded answer.
// askData (server/owlTools.js) is read-only and rides the SAME applyScope gate as
// every tile, so the conversation can never reach another client's data.
//
// Spec: docs/specs/AGENTIC_OWL_SPEC.md (§4 one loop/two doors). Plan: §5.

const crypto = require('crypto');

// The chat Owl's system prompt. Unlike every other Owl surface (handed already-
// resolved numbers), the chat Owl FETCHES its own answers via the askData tool and
// must never state a figure it didn't get from a tool result. Registered for the
// AI audit via insights.promptRegistry() (lazy require there → no load cycle).
const OWL_CHAT_SYSTEM = `You are the Owl — Howler Pulse's data analyst — answering an event organiser's questions about THEIR OWN ticketing data, in a chat. Amounts are South African Rand (ZAR).

HOW YOU KNOW THINGS (non-negotiable):
- You do NOT know any numbers on your own. The ONLY way to learn a figure is to call the askData tool, which runs a query over this client's data and returns rows.
- For any question about the data, call askData with the right measure (and optional dimensions, filters, or date range from the catalogue). Then answer ONLY from the rows it returns, and cite the figures you used.
- NEVER invent, estimate, or guess a number. If you haven't called askData for it, you don't know it.
- If askData returns "ok": false (e.g. no data scope, or the field isn't in the catalogue), tell the user plainly that you can't answer that from their data and why — do not fabricate an answer.
- The data is AUTOMATICALLY scoped to this client and event server-side. You never need to — and cannot — widen it to anyone else's data. Don't ask for or pass organiser identifiers.

STYLE: concise, plain English, lead with the answer/number, ZAR for money. If a question is genuinely ambiguous (e.g. which event, for a multi-event client), ask one short clarifying question instead of guessing.`;

// One streamed assistant turn via Claude (uses insights' shared client + model +
// instruction layering). Returns the final Message; its content blocks may include
// tool_use the loop must run. Kept here so insights.js stays a prompt/AI library
// and this disposable module owns its own conversational turn.
async function owlTurn(insights, { messages, tools, instructions, apiKey, onText }) {
  const c = insights.requireClient(apiKey);
  const stream = c.messages.stream({
    model: insights.MODEL,
    max_tokens: 1500,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: insights.systemWith(OWL_CHAT_SYSTEM, instructions),
    tools: tools || [],
    messages: messages || [],
  });
  stream.on('text', (delta) => { if (onText) onText(delta); });
  return stream.finalMessage();
}

// ── The loop (pure + injectable, so it's unit-testable without a live model) ──
// llmTurn({ messages, tools, onText }) → final Message (content blocks, maybe tool_use)
// toolMap: { [toolName]: { run(input, ctx) } }
// Returns { text, trail, rounds }. `trail` is the audit ledger for this turn.
async function runOwlLoop({ llmTurn, toolMap, tools, messages, ctx, onText, maxRounds = 5 }) {
  const convo = [...messages];
  const trail = [];
  let rounds = 0;
  for (; rounds < maxRounds; rounds++) {
    const final = await llmTurn({ messages: convo, tools, onText });
    const blocks = final.content || [];
    convo.push({ role: 'assistant', content: blocks });
    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    if (!toolUses.length) {
      return { text: textOf(blocks), trail, rounds: rounds + 1 };
    }
    const results = [];
    for (const tu of toolUses) {
      const tool = toolMap[tu.name];
      const result = tool ? await tool.run(tu.input || {}, ctx) : { ok: false, reason: 'unknown_tool', message: `No such tool: ${tu.name}` };
      trail.push({ name: tu.name, input: tu.input || {}, result });
      // Feed the model a compact result (drop the bulky queryBody; cap rows).
      const forModel = result.ok
        ? { ok: true, count: result.count, rows: (result.rows || []).slice(0, 100), measure: result.measure, dimensions: result.dimensions }
        : { ok: false, reason: result.reason, message: result.message };
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(forModel) });
    }
    convo.push({ role: 'user', content: results });
  }
  // Hit the round cap without a final text answer.
  return { text: textOf((messages[messages.length - 1] || {}).content || []) || '', trail, rounds, truncated: true };
}

function textOf(blocks) {
  return (blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

// Per-user gate while the native Owl is in development: only allowlisted accounts
// can use it (mirrors the client's owlNativeChatEnabled). Configure with the
// OWL_CHAT_ALLOW env (comma-separated emails, or "all" to open it); defaults to the
// single dogfooding account. The real data boundary is still applyScope — this just
// limits who can reach the endpoint at all.
const OWL_ALLOW = String(process.env.OWL_CHAT_ALLOW || 'shai.evian@howler.co.za').toLowerCase();
function owlAllowed(user) {
  if (OWL_ALLOW === 'all') return true;
  const email = String(user?.email || '').trim().toLowerCase();
  return !!email && OWL_ALLOW.split(',').map((s) => s.trim()).filter(Boolean).includes(email);
}

function mount(app, { db, auth, insights, owlTools, anthropicKeyForSuite }) {
  const sql = db.db;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS owl_threads (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL,
      suite_id TEXT, title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS owl_messages (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '', tool_calls TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_owl_messages_thread ON owl_messages(thread_id, created_at);
  `);
  const now = () => new Date().toISOString();
  const insThread = sql.prepare('INSERT INTO owl_threads (id,entity_id,user_id,suite_id,title,created_at) VALUES (?,?,?,?,?,?)');
  const getThread = sql.prepare('SELECT * FROM owl_threads WHERE id = ?');
  const insMsg = sql.prepare('INSERT INTO owl_messages (id,thread_id,role,body,tool_calls,created_at) VALUES (?,?,?,?,?,?)');
  const listMsgs = sql.prepare('SELECT * FROM owl_messages WHERE thread_id = ? ORDER BY created_at ASC');

  // Build the tool registry once: name → tool, plus the schemas for the model.
  const toolEntries = Object.values(owlTools).filter((t) => t && t.schema && t.run);
  const toolMap = Object.fromEntries(toolEntries.map((t) => [t.schema.name, t]));
  const toolSchemas = toolEntries.map((t) => t.schema);

  // Prior turns → Anthropic messages (text only; intra-turn tool rounds are ephemeral).
  const historyFor = (threadId) => listMsgs.all(threadId)
    .filter((m) => m.role === 'user' || m.role === 'owl')
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.body }));

  // POST /api/owl/chat — ask the Owl. Streams the grounded answer as plain text.
  app.post('/api/owl/chat', auth.requireAuth, async (req, res) => {
    if (!owlAllowed(req.user)) return res.status(403).json({ error: 'The native Owl isn\'t enabled for your account yet.' });
    const { suiteId, message, entityId } = req.body || {};
    let { threadId } = req.body || {};
    if (!message || !String(message).trim()) return res.status(400).json({ error: 'Empty message.' });
    if (!suiteId) return res.status(400).json({ error: 'An event (suiteId) is required.' });
    const su = db.getSuite(suiteId);
    if (!su) return res.status(404).json({ error: 'Event not found.' });
    if (req.user.role !== 'admin' && !auth.canAccessSuite(req.user, suiteId)) return res.status(403).json({ error: 'Not allowed.' });
    const apiKey = anthropicKeyForSuite(suiteId);
    if (!insights.isConfigured(apiKey)) return res.status(400).json({ error: 'AI is not configured. Set an Anthropic API key in Admin → Integrations (or .env).' });

    // Load or create the thread (must belong to this user).
    let thread = threadId ? getThread.get(threadId) : null;
    if (thread && thread.user_id !== req.user.id) return res.status(403).json({ error: 'Not your thread.' });
    if (!thread) {
      threadId = crypto.randomUUID();
      insThread.run(threadId, su.entityId || '', req.user.id, suiteId, String(message).slice(0, 80), now());
      thread = getThread.get(threadId);
    }

    const history = historyFor(thread.id);
    insMsg.run(crypto.randomUUID(), thread.id, 'user', String(message), '[]', now());
    const messages = [...history, { role: 'user', content: String(message) }];

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Owl-Thread', thread.id);
    res.flushHeaders?.();
    try {
      const instructions = ''; // standing per-client AI instructions can layer in here later
      const { text, trail } = await runOwlLoop({
        llmTurn: ({ messages: m, tools, onText }) => owlTurn(insights, { messages: m, tools, instructions, apiKey, onText }),
        toolMap,
        tools: toolSchemas,
        messages,
        ctx: { user: req.user, suiteId, entityId },
        onText: (t) => res.write(t),
      });
      insMsg.run(crypto.randomUUID(), thread.id, 'owl', text || '', JSON.stringify(trail), now());
      res.end();
    } catch (err) {
      console.error('[POST /api/owl/chat]', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'The Owl hit a problem answering that.' });
      else { res.write(`\n\n[error: the Owl hit a problem answering that.]`); res.end(); }
    }
  });

  // GET /api/owl/threads/:id/messages — reload a conversation (own threads only).
  app.get('/api/owl/threads/:id/messages', auth.requireAuth, (req, res) => {
    if (!owlAllowed(req.user)) return res.status(403).json({ error: 'The native Owl isn\'t enabled for your account yet.' });
    const thread = getThread.get(req.params.id);
    if (!thread) return res.status(404).json({ error: 'Not found.' });
    if (thread.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Not allowed.' });
    res.json({
      thread: { id: thread.id, suiteId: thread.suite_id, title: thread.title },
      messages: listMsgs.all(thread.id).map((m) => ({ role: m.role, body: m.body, at: m.created_at })),
    });
  });

  console.log('[owlChat] agentic Owl chat module mounted');
}

module.exports = { mount, runOwlLoop, textOf, OWL_CHAT_SYSTEM, owlAllowed };
