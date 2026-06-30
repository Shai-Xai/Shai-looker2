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
const { resolveGuidance: guidance } = require('./owlGuidance');
const { actionViewPath } = require('./owlActionLinks'); // where a created action is viewed

// ── Live "thinking" status ───────────────────────────────────────────────────
// The Owl can pause for seconds while it reasons or runs a Looker query, so we
// stream short status pings between turns ("Reading your ticket data…") that the
// client shows as an animated indicator. Each ping is a self-delimited span the
// client strips out of the answer text (see client/src/lib/api.js owlChat).
const STATUS_OPEN = '<<<OWL_STATUS>>>';
const STATUS_CLOSE = '<<</OWL_STATUS>>>';
const TOOL_STATUS = {
  askData: 'Reading your ticket data…',
  queryDashboard: 'Digging into the data…',
  getDashboard: 'Reading the dashboard…',
  getGoals: 'Checking your goals…',
  getAlerts: 'Checking your alerts…',
  getCampaigns: 'Checking your campaigns…',
  askUpload: 'Reading your attached data…',
  createAlert: 'Setting up that alert…',
};
function statusForTools(toolUses) {
  const names = [...new Set((toolUses || []).map((t) => t.name))];
  if (names.length === 1) return TOOL_STATUS[names[0]] || 'Working on it…';
  return 'Gathering your data…';
}

// The chat Owl's system prompt. Unlike every other Owl surface (handed already-
// resolved numbers), the chat Owl FETCHES its own answers via the askData tool and
// must never state a figure it didn't get from a tool result. Registered for the
// AI audit via insights.promptRegistry() (lazy require there → no load cycle).
const OWL_CHAT_SYSTEM = `You are the Owl — Howler Pulse's data analyst — answering an event organiser's questions about THEIR OWN ticketing data, in a chat. Write money in THIS client's reporting currency: if a "Currency:" note appears in your instructions, follow it exactly (symbol + code) and never relabel amounts as Rand; only if there is no such note, default to South African Rand (R).

HOW YOU KNOW THINGS (non-negotiable):
- You do NOT know any numbers on your own. The ONLY way to learn a raw data figure is to call the askData tool, which runs a query over this client's data and returns rows.
- For any question about the raw ticketing data, call askData with the right measure (and optional dimensions, filters, or date range from the catalogue). Then answer ONLY from the rows it returns, and cite the figures you used.
- NEVER invent, estimate, or guess a number. If you haven't called a tool for it, you don't know it.
- If a tool returns "ok": false (e.g. no data scope, or the field isn't in the catalogue), tell the user plainly that you can't answer that and why — do not fabricate an answer.
- The data is AUTOMATICALLY scoped to this client and event server-side. You never need to — and cannot — widen it to anyone else's data. Don't ask for or pass organiser identifiers.

WHICH TOOL TO USE (route every question to the right one — do not answer goal questions with askData):
- askData → any raw figure from the ticketing data: tickets sold, revenue, breakdowns by ticket type / date / city, customer lookups, trends. It is the only way to learn a raw number.
- getGoals → ANY question about GOALS, TARGETS, the North Star, pace, forecast, or "are we on track / how are we tracking / how are the goals doing". It returns the event's configured goals with their target, current value, pace (ahead/on-track/behind) and forecast landing. askData has NO concept of a target, so NEVER use it for goal questions — always call getGoals. If getGoals returns goals, report them (lead with the North Star). If it returns an empty list with a note, relay that note honestly — don't claim there are no goals if the note says otherwise.
- getDashboard → questions about the dashboard the user is currently viewing: "this dashboard", "what is this telling me", "summarise what's on screen", "which tile/number is highest". It returns the open dashboard's tiles + each tile's current value AND the dashboard's queryable fields. If it returns ok:false because no dashboard is open, tell them to open a dashboard first.
- queryDashboard → when the user wants to DIG DEEPER into the data behind the dashboard they're viewing — re-group it, break it down, trend it, filter it (anything beyond the headline tile values). ALWAYS call getDashboard first to read the available field names ("fields"), then call queryDashboard passing measure/dimensions/filters using those EXACT field names. It runs a fresh scoped query over the dashboard's own data and returns rows (which auto-chart, like askData). Use this — not askData — for deeper questions about the current dashboard, because askData only knows the ticketing catalogue while queryDashboard speaks the dashboard's own dataset.
- getAlerts → questions about ALERTS / alarms / thresholds / notifications: "what alerts are set", "has anything triggered", "what am I being notified about". Returns each alert's condition, whether it's active/paused and armed/triggered, its last value and last fire. Read-only.
- getCampaigns → questions about email/SMS CAMPAIGNS / marketing sends: "what have we sent", "campaign performance", "open/click rates", "any campaigns running". Returns each campaign's status, channel, recipient count and results (sent/opens/clicks/conversions) — never individual contacts. Read-only.
- askUpload → questions about a file or Google Sheet the user ATTACHED (listed under "Attached data sources" when present) — query/aggregate that table. To answer a question that spans the attachment AND the ticketing data (e.g. "uploaded target vs actual sold by event"), call BOTH askUpload and askData, then combine the figures in one answer/table. If no sources are attached, say so and point them to the 📎 attach button.
- createAlert → when the user wants to be NOTIFIED / ALERTED / TOLD / REMINDED when a number reaches a level ("let me know when tickets hit 1000", "alert me if VIP sells out", "tell me when revenue passes R1m"). It DRAFTS the alert and the user confirms with a button — see ACTING below.
- createSegment → when the user wants to BUILD or SAVE an AUDIENCE / cohort of people for later marketing ("make a segment of VIP buyers in Cape Town", "save these people as an audience", "build a guest list segment", "audience of 18-25 year olds"). The cohort is defined by curated dimensions (age, gender, buyer city/country, ticket type, ticket category, complimentary = guest list). It DRAFTS the segment + previews the size and reach; the user confirms with a button — see ACTING below. NEVER list or name individual people; only the count + reach. Contact fields (email/phone) cannot define a segment.
- draftCampaign → when the user wants to MESSAGE or MARKET to a cohort ("draft a win-back email to lapsed VIP buyers", "send an offer to Cape Town 18-25s", "email my guest-list segment"). Give it the goal plus an audience that is EITHER a saved segment (pass segmentName when the user names one, or one was just created) OR a new cohort (pass filters). It drafts the email/SMS copy and previews the reach. It creates a DRAFT only — a human reviews, approves and SENDS it in Engage. You never send. See ACTING below.

ACTING (tools that DO something, not just read):
- Some tools DRAFT an action for the user to confirm instead of just reading data (createAlert, createSegment). You NEVER create/change anything silently: the tool returns a proposed action and the user taps a button to confirm it.
- After calling createSegment, do NOT say it's saved. Say you've DRAFTED it, state the cohort and the previewed size + reach (e.g. "a segment of VIP buyers in Cape Town — about 1,240 people, 1,180 emailable"), and tell them to tap "Create segment" to save it. Never list individuals. If it returns ok:false, relay why (e.g. pick a client, or contact fields can't define a segment).
- Work like a campaign manager: BEFORE calling draftCampaign, if the brief is thin, ask 1-3 SHORT setup questions to nail the essentials that are missing — the angle/offer (the hook), the channel (email / SMS / both), any promo or incentive, the destination link for the button, and which event it's for. Ask only what's missing and material; don't interrogate. Then call draftCampaign with a rich goal (fold in the offer/angle and any promo) and pass ctaUrl if they gave a link.
- The audience can be an existing saved segment (pass segmentName) or a new cohort (pass filters). When you draft from a NEW cohort, that cohort is automatically SAVED as a reusable segment and the campaign is pointed at it — so tell the user the segment was saved too.
- After calling draftCampaign, do NOT say it's sent or scheduled. Say you've DRAFTED the campaign, give the audience (size + reach) and the subject line, and tell them to tap "Create draft campaign" then review, approve and send it in Engage — you never send anything to customers. If it returns ok:false, relay why.
- After calling createAlert, do NOT say the alert is on or active. Say you've DRAFTED it, state plainly what it will watch and the exact condition (e.g. "I've drafted an alert for when Tickets Sold reaches 1,000"), and tell them to tap "Create alert" below to switch it on. If no event is selected, the card has an event picker on it — tell them to pick the event there; NEVER tell them to go elsewhere to select an event first. If it returns ok:false, relay why and what to do.
- An alert needs a measure, an operator (at/above, at/below, above, below) and a threshold. If the user's wish is missing one (e.g. they didn't give a number), ask one short clarifying question before drafting.
- Delivery defaults to an in-app/push notification at normal priority (inbox is always on). Only set the channels or priority if the user actually says how they want to be told (e.g. "email me", "text me", "make it important") — otherwise leave the defaults and don't ask. Mention how they'll be notified when you confirm the draft.

CHARTS: Whenever you return a BREAKDOWN from askData (a measure grouped by a dimension), the app AUTOMATICALLY renders it as a real interactive chart below your reply, and the user can switch it between bar / line / pie / metric with a toggle on the chart. So:
- You CAN show charts. NEVER say you can't generate a chart/image, and NEVER draw ASCII or text bar graphs.
- To visualise something, just call askData for the relevant breakdown (e.g. group by Purchased Date for a daily trend, or by Ticket Type for a split) — the chart appears automatically. Then add a one-line summary; do NOT re-list the rows as text.
- If the user asks for a different chart type (bar/line/pie/metric), tell them they can tap the chart-type toggle on the chart — no need to regenerate.
- To compare TWO measures together (e.g. revenue AND tickets sold), call askData with measures: [a, b] — they render as separate coloured bars the user can stack.

TABLES: For comparisons or any multi-row breakdown, present the figures as a Markdown table (| col | col |, with a |---|---| separator row) — it renders as a real table. Use tables instead of long free-form lists of numbers.

INSIGHT: When you present data, add a short one-line takeaway — what stands out or why it matters — not just the bare number.

FOLLOW-UPS: At the very END of your reply, on its own final line, output the marker <<<FOLLOWUPS>>> immediately followed by a JSON array of 2-3 SHORT (≤6 words) follow-up questions the user is likely to ask next, specific to what you just answered (e.g. ["Compare to last year","Break down by city","Add-ons only"]). The app turns these into tappable chips and hides this line — never mention it, and always put it last.

STYLE: concise, plain English, lead with the answer/number, money in the client's reporting currency (see the Currency note; default ZAR only if none). If a question is genuinely ambiguous (e.g. which event, for a multi-event client), ask one short clarifying question instead of guessing.`;

// ── Personas (depth modes the user toggles) ───────────────────────────────────
// Not different models or temperatures — the same grounded brain with a different
// BRIEF + reasoning budget. Quick = today's fast lookup. Analyst = deeper: more
// reasoning effort, more query rounds, multi-cut analysis + a recommendation, sharper
// follow-ups. (Operator — proactively proposes + drafts actions — is the next phase.)
const OWL_ANALYST_LAYER = `DEPTH — ANALYST MODE: the user wants a deeper read, so work like a senior data analyst, not a lookup.
- Don't stop at the headline number. Pull the supporting cuts with askData — the trend over time, the breakdown by the most telling dimension (ticket type / city / channel), and a comparison to a prior period or a comparable event — then SYNTHESISE them into one read.
- Lead with the answer, then explain WHAT'S DRIVING IT and WHY IT MATTERS (the "so what"), and end with a concrete recommended next step.
- Call out anything notable: an outlier, an inflection point, a segment over/under-performing, a pacing risk against the goal.
- Favour a tight Markdown table + one chart-worthy breakdown over a wall of prose — insight density, not length.
- Make your follow-ups PROBING and strategic (e.g. "What's driving the VIP dip?", "Compare channels for this event", "Forecast final sales"), not just the obvious next cut.`;

// Each persona is a bundle: reasoning effort + output budget + how many tool rounds it
// may run + the prompt layer appended to the instructions.
const PERSONAS = {
  quick: { effort: 'low', maxTokens: 1500, maxRounds: 5, layer: '' },
  analyst: { effort: 'high', maxTokens: 3500, maxRounds: 9, layer: OWL_ANALYST_LAYER },
};
const personaKey = (m) => (PERSONAS[m] ? m : 'quick');
const personaOf = (m) => PERSONAS[personaKey(m)];

// One streamed assistant turn via Claude (uses insights' shared client + model +
// instruction layering). Returns the final Message; its content blocks may include
// tool_use the loop must run. Kept here so insights.js stays a prompt/AI library
// and this disposable module owns its own conversational turn.
async function owlTurn(insights, { messages, tools, instructions, apiKey, onText, effort = 'low', maxTokens = 1500 }) {
  const c = insights.requireClient(apiKey);
  const stream = c.messages.stream({
    model: insights.MODEL,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort },
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
async function runOwlLoop({ llmTurn, toolMap, tools, messages, ctx, onText, onStatus, maxRounds = 5 }) {
  const convo = [...messages];
  const trail = [];
  let rounds = 0;
  for (; rounds < maxRounds; rounds++) {
    // Tell the user we're working before each model turn (the silent pre-text gap).
    if (onStatus) onStatus(rounds === 0 ? 'Thinking…' : 'Working through it…');
    const final = await llmTurn({ messages: convo, tools, onText });
    const blocks = final.content || [];
    convo.push({ role: 'assistant', content: blocks });
    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    if (!toolUses.length) {
      return { text: textOf(blocks), trail, rounds: rounds + 1 };
    }
    // About to run tool(s) — say which kind of thing we're fetching.
    if (onStatus) onStatus(statusForTools(toolUses));
    const results = [];
    for (const tu of toolUses) {
      const tool = toolMap[tu.name];
      const result = tool ? await tool.run(tu.input || {}, ctx) : { ok: false, reason: 'unknown_tool', message: `No such tool: ${tu.name}` };
      trail.push({ name: tu.name, input: tu.input || {}, result });
      // Feed the model a compact result. Pass through whatever the tool returned
      // (askData → rows/count, getGoals → goals/note, …) so no tool's payload is
      // silently dropped; just strip the bulky queryBody and cap any rows array.
      let forModel;
      if (result.ok) {
        const { queryBody, ...rest } = result; // eslint-disable-line no-unused-vars
        if (Array.isArray(rest.rows)) rest.rows = rest.rows.slice(0, 100);
        forModel = rest;
      } else {
        forModel = { ok: false, reason: result.reason, message: result.message };
      }
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

function mount(app, { db, auth, insights, owlTools, uploads, getExploreFields, messaging, getAlertsApi, getSegmentsApi, getActionsApi, anthropicKeyForSuite, anthropicKeyForEntity, currencyNote, languageNote, whatsappDigestFor }) {
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
  // Migration: chats can belong to a folder (added after launch).
  try { sql.exec("ALTER TABLE owl_threads ADD COLUMN folder TEXT NOT NULL DEFAULT ''"); } catch { /* already present */ }
  // Migration: a chat remembers its depth persona (quick | analyst) as its default.
  try { sql.exec("ALTER TABLE owl_threads ADD COLUMN persona TEXT NOT NULL DEFAULT 'quick'"); } catch { /* already present */ }
  const now = () => new Date().toISOString();
  const insThread = sql.prepare('INSERT INTO owl_threads (id,entity_id,user_id,suite_id,title,persona,created_at) VALUES (?,?,?,?,?,?,?)');
  const getThread = sql.prepare('SELECT * FROM owl_threads WHERE id = ?');
  const renameThread = sql.prepare('UPDATE owl_threads SET title = ? WHERE id = ?');
  const setThreadFolder = sql.prepare('UPDATE owl_threads SET folder = ? WHERE id = ?');
  const setThreadPersona = sql.prepare('UPDATE owl_threads SET persona = ? WHERE id = ?');
  const delThread = sql.prepare('DELETE FROM owl_threads WHERE id = ?');
  const delThreadMsgs = sql.prepare('DELETE FROM owl_messages WHERE thread_id = ?');
  const insMsg = sql.prepare('INSERT INTO owl_messages (id,thread_id,role,body,tool_calls,created_at) VALUES (?,?,?,?,?,?)');
  const listMsgs = sql.prepare('SELECT * FROM owl_messages WHERE thread_id = ? ORDER BY created_at ASC');
  // A user's recent chats, newest activity first (for the history list).
  const listThreadsStmt = sql.prepare(
    `SELECT t.*, (SELECT MAX(created_at) FROM owl_messages WHERE thread_id = t.id) AS last_at
     FROM owl_threads t WHERE t.user_id = ? ORDER BY COALESCE(last_at, t.created_at) DESC LIMIT 50`,
  );

  // Build the tool registry once: name → tool, plus the schemas for the model.
  const toolEntries = Object.values(owlTools).filter((t) => t && t.schema && t.run);
  const toolMap = Object.fromEntries(toolEntries.map((t) => [t.schema.name, t]));
  const toolSchemas = toolEntries.map((t) => t.schema);

  // ── Citation chips: turn an answer's tool TRAIL into human-readable "sources" the
  // client renders under the bubble (the grounding made visible). Reuses the curated
  // catalogue's labels. Streamed after the answer text behind SOURCES_MARK.
  const cat = owlTools.catalogue || {};
  // Live label maps — refreshed per request from the field dictionary (owlFields) so
  // admin renames show up in citations without a restart.
  let measLabel = new Map((cat.measures || []).map((m) => [m.name, m.label]));
  let dimLabel = new Map((cat.dimensions || []).map((d) => [d.name, d.label]));
  const dimType = new Map((cat.dimensions || []).map((d) => [d.name, d.type]));
  const SCOPE_LABEL = { 'core_organisers.name': 'organiser', 'core_events.name': 'event' };
  const fieldLabel = (f) => SCOPE_LABEL[f] || dimLabel.get(f) || String(f).split('.').pop().replace(/_/g, ' ');
  function sourcesFromTrail(trail) {
    const data = (trail || [])
      .filter((t) => (t.name === 'askData' || t.name === 'queryDashboard') && t.result && t.result.ok)
      .map((t) => {
        const qb = t.result.queryBody || {};
        const m = t.input.measure;
        const dims = t.input.dimensions || [];
        const rows = t.result.rows || [];
        // Single scalar answer (one row, no group-by) → surface the value on the chip.
        let value = null;
        if (rows.length === 1 && !dims.length && rows[0][m] != null) value = rows[0][m];
        // The actual result table behind the answer (columns + capped rows), so the
        // citation can show the data — not just the query — like a spreadsheet.
        const fields = qb.fields || [...dims, m];
        return {
          measure: measLabel.get(m) || m,
          value,
          count: t.result.count,
          dimensions: dims.map((d) => dimLabel.get(d) || d),
          filters: Object.entries(qb.filters || {}).map(([f, v]) => ({ label: fieldLabel(f), value: String(v) })),
          explore: cat.label || qb.view || '',
          columns: fields.map((f) => ({ field: f, label: measLabel.get(f) || dimLabel.get(f) || fieldLabel(f), kind: measLabel.has(f) ? 'measure' : 'dimension' })),
          rows: rows.slice(0, 50),
          queryBody: qb, // the live Looker query — used when pinning the chart to a dashboard
          // Auto-chart hint: a breakdown (>=1 dimension, >1 row) charts; a date
          // dimension → line, otherwise → bar. A single scalar stays text.
          chartType: (dims.length >= 1 && rows.length > 1) ? (dimType.get(dims[0]) === 'date' ? 'line' : 'bar') : null,
        };
      });
    // getDashboard answers carry no Looker query of their own, but the model read the
    // dashboard's tiles — surface that (each tile's explore/fields/filters/value) as a
    // `kind:'dashboard'` source so a fix-brief shows what's behind a dashboard answer.
    const dash = (trail || [])
      .filter((t) => t.name === 'getDashboard' && t.result && t.result.ok)
      .map((t) => ({
        kind: 'dashboard',
        dashboard: t.result.dashboard || {},
        tiles: (t.result.tiles || []).map((ti) => ({
          title: ti.title, value: ti.value, visType: ti.visType,
          explore: ti.explore || '', fields: ti.fields || [],
          filters: Object.entries(ti.filters || {}).map(([f, v]) => ({ label: fieldLabel(f), value: String(v) })),
        })),
      }));
    return [...data, ...dash];
  }
  const SOURCES_MARK = '\n<<<OWL_SOURCES>>>';
  // ── Proposed actions: act-tools (createAlert…) return a draft + confirm:true that
  // the loop captures in the trail. We surface those as "actions" the client renders
  // as a confirm card (the act-layer's equivalent of a citation chip). Streamed after
  // the sources behind ACTIONS_MARK; the user taps the card to actually commit.
  const ACTIONS_MARK = '\n<<<OWL_ACTIONS>>>';
  function actionsFromTrail(trail) {
    return (trail || [])
      .filter((t) => t.result && t.result.ok && t.result.confirm && t.result.action)
      .map((t) => t.result.action);
  }
  const J = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };

  // Prior turns → Anthropic messages (text only; intra-turn tool rounds are ephemeral).
  const historyFor = (threadId) => listMsgs.all(threadId)
    .filter((m) => m.role === 'user' || m.role === 'owl')
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.body }));

  // POST /api/owl/chat — ask the Owl. Streams the grounded answer as plain text.
  app.post('/api/owl/chat', auth.requireAuth, async (req, res) => {
    if (!owlAllowed(req.user)) return res.status(403).json({ error: 'The native Owl isn\'t enabled for your account yet.' });
    const { suiteId, message, entityId, dashboardId, mode } = req.body || {};
    let { threadId } = req.body || {};
    if (!message || !String(message).trim()) return res.status(400).json({ error: 'Empty message.' });
    // Scope context is an EVENT (suiteId) and/or a CLIENT (entityId). Clients are
    // auto-scoped server-side even with neither; admins need at least one (askData
    // refuses otherwise). Validate access to whatever was supplied.
    const su = suiteId ? db.getSuite(suiteId) : null;
    if (suiteId && !su) return res.status(404).json({ error: 'Event not found.' });
    const scopeEntityId = entityId || (su && su.entityId) || '';
    if (req.user.role !== 'admin') {
      if (suiteId && !auth.canAccessSuite(req.user, suiteId)) return res.status(403).json({ error: 'Not allowed.' });
      if (scopeEntityId && !(req.user.entityIds || []).includes(scopeEntityId)) return res.status(403).json({ error: 'Not allowed.' });
    }
    const apiKey = su ? anthropicKeyForSuite(suiteId) : anthropicKeyForEntity(scopeEntityId || undefined);
    if (!insights.isConfigured(apiKey)) return res.status(400).json({ error: 'AI is not configured. Set an Anthropic API key in Admin → Integrations (or .env).' });

    // Human-readable scope label so the Owl can STATE whose data it's answering for.
    const scopeEnt = scopeEntityId ? db.getEntity(scopeEntityId) : null;
    const scopeLabel = [scopeEnt && scopeEnt.name, su && su.name].filter(Boolean).join(' · ');
    const nowSa = new Date(Date.now() + 2 * 60 * 60 * 1000); // SAST (UTC+2) — Howler's local day/hour
    const today = nowSa.toISOString().slice(0, 10);
    const hourSa = nowSa.getUTCHours();
    const parts = [
      `Today's date is ${today} and the current time is about ${String(hourSa).padStart(2, '0')}:00 (SAST, UTC+2). For "upcoming"/"future"/"past"/"this year" questions, compare against today — e.g. filter Event Date (core_events.start_date) with a Looker date expression such as "after ${today}" for future events or "before ${today}" for past ones. (Event Date is the date of the event; Purchased Date is when a ticket was bought.) For a "today so far vs yesterday (to the same time)" comparison, use ${hourSa} as the cut-off hour (filter Purchased Hour of Day to "0 to ${hourSa}") so both days are trimmed to the same window.`,
    ];
    if (scopeLabel) parts.push(`All data in this conversation is scoped to: ${scopeLabel}. Make clear in your answer which client/event the numbers are for — lead your answer with "For ${scopeLabel}:" (or naturally name it). Never imply the figures cover other clients or events.`);
    // Surface the curated catalogue's field meanings + rules to the model — it only
    // sees raw field names in the tool enum otherwise, so labels/synonyms/notes
    // (e.g. the add-on split rule) must be passed in here.
    // Field guide from the live dictionary (admin-editable labels/synonyms/questions).
    // Also refresh the citation label maps so renames show there too.
    const fmeta = owlFields.list();
    measLabel = new Map(fmeta.filter((f) => f.kind === 'measure').map((f) => [f.name, f.label]));
    dimLabel = new Map(fmeta.filter((f) => f.kind === 'dimension').map((f) => [f.name, f.label]));
    const gloss = fmeta.map((f) => `${f.name} = ${f.label}${(f.aka || []).length ? ` (aka: ${f.aka.join(', ')})` : ''}`).join('; ');
    if (gloss) parts.push(`Field guide (name = meaning): ${gloss}.`);
    const qs = fmeta.filter((f) => (f.questions || []).length).map((f) => `${f.label} → ${f.questions.join(' / ')}`);
    if (qs.length) parts.push(`Typical questions by field: ${qs.join(' | ')}.`);
    if ((cat.notes || []).length) parts.push(`Rules:\n- ${cat.notes.join('\n- ')}`);
    // Reporting currency: write money in the organiser's currency (blank for ZAR).
    try { const cn = currencyNote && currencyNote(scopeEntityId || undefined, suiteId || undefined); if (cn) parts.push(cn); } catch { /* ignore */ }
    // AI content language: write generated prose in the organiser's language (blank for English).
    try { const ln = languageNote && languageNote(scopeEntityId || undefined, suiteId || undefined); if (ln) parts.push(ln); } catch { /* ignore */ }
    // Tell the model what external data is attached (so it knows it can use askUpload).
    try {
      const ups = uploads && uploads.listUploads && scopeEntityId ? uploads.listUploads(scopeEntityId) : [];
      if (ups.length) parts.push(`Attached data sources (query with askUpload; combine with askData to answer across sources): ${ups.map((u) => `"${u.name}" [${u.source}] columns: ${(u.columns || []).map((c) => `${c.name}(${c.type})`).join(', ')}`).join(' | ')}.`);
    } catch { /* ignore */ }
    // No-code steering layer: admin/client guidance (server/owlGuidance.js), injected
    // last so it can override the catalogue's defaults without a deploy.
    try { const g = guidance(db, scopeEntityId); if (g) parts.push(g); } catch { /* ignore */ }

    // Load or create the thread (must belong to this user).
    let thread = threadId ? getThread.get(threadId) : null;
    if (thread && thread.user_id !== req.user.id) return res.status(403).json({ error: 'Not your thread.' });
    // Depth persona: this message's explicit `mode` wins; else the chat's saved default.
    const pKey = personaKey(mode || (thread && thread.persona) || 'quick');
    const persona = PERSONAS[pKey];
    if (!thread) {
      threadId = crypto.randomUUID();
      insThread.run(threadId, scopeEntityId, req.user.id, suiteId || null, String(message).slice(0, 80), pKey, now());
      thread = getThread.get(threadId);
    } else if (mode && thread.persona !== pKey) {
      setThreadPersona.run(pKey, thread.id); // an explicit toggle becomes the chat's default
    }
    // Persona layer is appended last so its deeper brief sits over the base instructions.
    const instructions = [...parts, persona.layer].filter(Boolean).join('\n\n');

    const history = historyFor(thread.id);
    insMsg.run(crypto.randomUUID(), thread.id, 'user', String(message), '[]', now());
    const messages = [...history, { role: 'user', content: String(message) }];

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Owl-Thread', thread.id);
    res.setHeader('X-Owl-Persona', pKey);
    res.flushHeaders?.();
    try {
      const { text, trail } = await runOwlLoop({
        llmTurn: ({ messages: m, tools, onText }) => owlTurn(insights, { messages: m, tools, instructions, apiKey, onText, effort: persona.effort, maxTokens: persona.maxTokens }),
        toolMap,
        tools: toolSchemas,
        messages,
        ctx: { user: req.user, suiteId, entityId, dashboardId },
        maxRounds: persona.maxRounds,
        onText: (t) => res.write(t),
        // Stream a status ping between turns; the client renders it as the thinking line.
        onStatus: (label) => { try { res.write(STATUS_OPEN + String(label).replace(/[<>]/g, '') + STATUS_CLOSE); } catch { /* socket gone */ } },
      });
      // Persist the answer WITHOUT the follow-ups marker (the client strips it live).
      const cleanText = String(text || '').split('<<<FOLLOWUPS>>>')[0].replace(/\s+$/, '');
      insMsg.run(crypto.randomUUID(), thread.id, 'owl', cleanText, JSON.stringify(trail), now());
      // Citation chips: stream the sources as a trailing record the client splits off.
      res.write(SOURCES_MARK + JSON.stringify(sourcesFromTrail(trail)));
      // Proposed actions (e.g. a drafted alert) — the confirm card; live response only.
      const actions = actionsFromTrail(trail);
      if (actions.length) res.write(ACTIONS_MARK + JSON.stringify(actions));
      res.end();
    } catch (err) {
      console.error('[POST /api/owl/chat]', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'The Owl hit a problem answering that.' });
      else { res.write(`\n\n[error: the Owl hit a problem answering that.]`); res.end(); }
    }
  });

  // GET /api/owl/capabilities — the slash-command palette, derived from the tool
  // registry (each read tool's `menu`). Sourced here so it can never drift from what
  // the Owl can actually do; the client renders it as the "/" menu in the composer.
  const owlCommands = Object.values(owlTools).filter((t) => t && t.menu).map((t) => t.menu);
  app.get('/api/owl/capabilities', auth.requireAuth, (req, res) => {
    if (!owlAllowed(req.user)) return res.status(403).json({ error: 'The native Owl isn\'t enabled for your account yet.' });
    res.json({ commands: owlCommands });
  });

  // GET /api/owl/threads — the user's recent chats (for the history list).
  app.get('/api/owl/threads', auth.requireAuth, (req, res) => {
    if (!owlAllowed(req.user)) return res.status(403).json({ error: 'The native Owl isn\'t enabled for your account yet.' });
    const rows = listThreadsStmt.all(req.user.id).map((t) => ({
      id: t.id, title: t.title || 'Chat', folder: t.folder || '', suiteId: t.suite_id || '', entityId: t.entity_id || '', at: t.last_at || t.created_at,
    }));
    res.json({ threads: rows });
  });

  // PATCH /api/owl/threads/:id — rename a chat and/or move it to a folder (own threads).
  app.patch('/api/owl/threads/:id', auth.requireAuth, (req, res) => {
    if (!owlAllowed(req.user)) return res.status(403).json({ error: 'The native Owl isn\'t enabled for your account yet.' });
    const thread = getThread.get(req.params.id);
    if (!thread) return res.status(404).json({ error: 'Not found.' });
    if (thread.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Not allowed.' });
    const body = req.body || {};
    if (body.title !== undefined) {
      const title = String(body.title || '').trim().slice(0, 120);
      if (!title) return res.status(400).json({ error: 'A title is required.' });
      renameThread.run(title, req.params.id);
    }
    if (body.folder !== undefined) setThreadFolder.run(String(body.folder || '').trim().slice(0, 80), req.params.id);
    const t = getThread.get(req.params.id);
    res.json({ ok: true, id: t.id, title: t.title, folder: t.folder || '' });
  });

  // DELETE /api/owl/threads/:id — delete a chat and its messages (own threads only).
  app.delete('/api/owl/threads/:id', auth.requireAuth, (req, res) => {
    if (!owlAllowed(req.user)) return res.status(403).json({ error: 'The native Owl isn\'t enabled for your account yet.' });
    const thread = getThread.get(req.params.id);
    if (!thread) return res.status(404).json({ error: 'Not found.' });
    if (thread.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Not allowed.' });
    delThreadMsgs.run(req.params.id);
    delThread.run(req.params.id);
    res.json({ ok: true });
  });

  // GET /api/owl/threads/:id/messages — reload a conversation (own threads only).
  app.get('/api/owl/threads/:id/messages', auth.requireAuth, (req, res) => {
    if (!owlAllowed(req.user)) return res.status(403).json({ error: 'The native Owl isn\'t enabled for your account yet.' });
    const thread = getThread.get(req.params.id);
    if (!thread) return res.status(404).json({ error: 'Not found.' });
    if (thread.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Not allowed.' });
    res.json({
      thread: { id: thread.id, suiteId: thread.suite_id, title: thread.title },
      messages: listMsgs.all(thread.id).map((m) => ({
        role: m.role, body: m.body, at: m.created_at,
        sources: m.role === 'owl' ? sourcesFromTrail(J(m.tool_calls)) : undefined,
      })),
    });
  });

  // ── Act layer: commit a drafted action the Owl proposed ──────────────────────
  // POST /api/owl/act/create-alert — the user tapping "Create alert" on the card the
  // createAlert tool produced. The tool only DRAFTS; this is the confirm step. Scope
  // is re-checked here AND inside alerts.createAlert (canManage / alerts.manage), so
  // the Owl can never create an alert the user couldn't make by hand.
  app.post('/api/owl/act/create-alert', auth.requireAuth, (req, res) => {
    if (!owlAllowed(req.user)) return res.status(403).json({ error: 'The native Owl isn\'t enabled for your account yet.' });
    const { suiteId, draft } = req.body || {};
    if (!suiteId || !draft || typeof draft !== 'object') return res.status(400).json({ error: 'suiteId and draft are required.' });
    const su = db.getSuite(suiteId);
    if (!su) return res.status(404).json({ error: 'Event not found.' });
    if (req.user.role !== 'admin' && !auth.canAccessSuite(req.user, suiteId)) return res.status(403).json({ error: 'Not allowed.' });
    const alertsApi = typeof getAlertsApi === 'function' ? getAlertsApi() : null;
    if (!alertsApi || !alertsApi.createAlert) return res.status(503).json({ error: 'Alerts aren\'t available right now.' });
    const r = alertsApi.createAlert({ suiteId, draft, user: req.user });
    if (!r.ok) return res.status(400).json({ error: r.error || 'Could not create the alert.' });
    res.status(201).json({ ok: true, alert: { id: r.alert.id, name: r.alert.name }, url: actionViewPath('createAlert') });
  });

  // POST /api/owl/act/create-segment — the user tapping "Create segment" on the card
  // the createSegment tool produced. Commits via the segment module's create path,
  // which re-checks entity ownership + campaigns.approve (the Owl can never create a
  // segment the user couldn't make by hand). Never receives or returns any PII.
  app.post('/api/owl/act/create-segment', auth.requireAuth, (req, res) => {
    if (!owlAllowed(req.user)) return res.status(403).json({ error: 'The native Owl isn\'t enabled for your account yet.' });
    const { entityId, name, draft } = req.body || {};
    if (!entityId || !draft || typeof draft !== 'object') return res.status(400).json({ error: 'entityId and draft are required.' });
    // A query-segment can only be built from the ticket-data catalogue (not a dashboard's
    // own explore, which the people-resolver can't scope) — reject clearly otherwise.
    if (draft.mode === 'query') {
      const cat = owlTools && owlTools.catalogue;
      if (cat && (draft.model !== cat.model || draft.view !== cat.explore)) {
        return res.status(400).json({ error: "I can only save a segment from your ticket data, not this dashboard's own data." });
      }
    }
    const segmentsApi = typeof getSegmentsApi === 'function' ? getSegmentsApi() : null;
    if (!segmentsApi || !segmentsApi.createSegment) return res.status(503).json({ error: 'Segments aren\'t available right now.' });
    const r = segmentsApi.createSegment({ entityId, name, definition: draft, user: req.user });
    if (!r.ok) return res.status(r.error === 'Not allowed' ? 403 : 400).json({ error: r.error || 'Could not create the segment.' });
    res.status(201).json({ ok: true, segment: { id: r.segment.id, name: r.segment.name }, url: actionViewPath('createSegment') });
  });

  // POST /api/owl/act/draft-campaign — the user tapping "Create draft campaign" on the
  // card the draftCampaign tool produced. Creates a DRAFT campaign only (status 'draft',
  // never sends); a human reviews, approves and sends it in Engage. Re-checks entity
  // ownership + campaigns.approve inside createDraftCampaign.
  app.post('/api/owl/act/draft-campaign', auth.requireAuth, (req, res) => {
    if (!owlAllowed(req.user)) return res.status(403).json({ error: 'The native Owl isn\'t enabled for your account yet.' });
    const { entityId, name, channel, goal, subject, body, ctaText, ctaUrl, suiteId, audienceName, customHtml, language: lang } = req.body || {};
    let { audience } = req.body || {};
    if (!entityId || !audience || typeof audience !== 'object') return res.status(400).json({ error: 'entityId and audience are required.' });
    const actionsApi = typeof getActionsApi === 'function' ? getActionsApi() : null;
    if (!actionsApi || !actionsApi.createDraftCampaign) return res.status(503).json({ error: 'Campaigns aren\'t available right now.' });
    // A custom (chat) cohort: SAVE it as a reusable segment, then point the campaign at
    // that segment — so the audience is reusable and visibly the same one in Engage. The
    // curated-explore guard applies before we persist it (same as create-segment).
    if (audience.mode === 'query') {
      const cat = owlTools && owlTools.catalogue;
      if (cat && (audience.model !== cat.model || audience.view !== cat.explore)) {
        return res.status(400).json({ error: "I can only build an audience from your ticket data, not this dashboard's own data." });
      }
      const segmentsApi = typeof getSegmentsApi === 'function' ? getSegmentsApi() : null;
      if (segmentsApi && segmentsApi.createSegment) {
        const segName = String(audienceName || name || 'Campaign audience').slice(0, 120);
        const sr = segmentsApi.createSegment({ entityId, name: segName, definition: audience, user: req.user, suiteId: suiteId || '' });
        if (sr.ok) audience = { mode: 'segment', segmentId: sr.segment.id }; // reference the saved segment
        // (if the segment couldn't be saved, fall back to the inline query audience — the campaign still resolves)
      }
    }
    const html = String(customHtml || '').slice(0, 500000);
    const config = {
      channel: ['email', 'sms', 'both'].includes(channel) ? channel : 'email',
      audience, subject: String(subject || ''), body: String(body || ''), ctaText: String(ctaText || ''),
      ctaUrl: String(ctaUrl || ''),
      goal: String(goal || ''), eventSuiteId: String(suiteId || ''), campaignMode: 'once',
      language: String(lang || '').slice(0, 5).toLowerCase(), // per-campaign AI language (blank → client default)
      // Custom HTML body when the user uploaded one; otherwise the rendered template.
      contentMode: html ? 'html' : 'template', customHtml: html,
    };
    const r = actionsApi.createDraftCampaign({ entityId, title: name, config, user: req.user });
    if (!r.ok) return res.status(r.error === 'Not allowed' ? 403 : 400).json({ error: r.error || 'Could not create the campaign.' });
    res.status(201).json({ ok: true, campaign: { id: r.action.id, title: r.action.title }, url: actionViewPath('draftCampaign') });
  });

  // Pin-to-dashboard lives in its own disposable module; mount it here so index.js
  // stays at budget. Shares the Owl allowlist gate.
  require('./owlPin').mount(app, { db, auth });
  require('./owlGuidance').mount(app, { db, auth }); // resolveGuidance is required at top
  const owlFields = require('./owlFields').mount(app, { db, auth, getExploreFields }); // no-code field labels/synonyms/questions
  require('./owlWhatsapp').mount(app, { db, auth, insights, messaging, owlTools, owlFields, anthropicKeyForEntity, currencyNote, languageNote, whatsappDigestFor, getAlertsApi, getSegmentsApi, getActionsApi }); // WhatsApp door onto the Owl (Clickatell)
  console.log('[owlChat] agentic Owl chat module mounted');
}

module.exports = { mount, runOwlLoop, owlTurn, textOf, OWL_CHAT_SYSTEM, OWL_ANALYST_LAYER, owlAllowed };
