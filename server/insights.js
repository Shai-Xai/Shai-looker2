// ─── AI insights ─────────────────────────────────────────────────────────────
// Given a dashboard tile's data + context, ask Claude for a concise,
// business-focused insight. Single Messages API call via the official SDK;
// the API key stays server-side.

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-4-8';
const MAX_ROWS = 60; // cap rows sent to keep the prompt small and cheap

// One Anthropic client per API key (admin default from env/DB, or a client's own).
const clientsByKey = new Map();
function clientFor(apiKey) {
  const key = (apiKey || process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return null;
  if (!clientsByKey.has(key)) clientsByKey.set(key, new Anthropic({ apiKey: key }));
  return clientsByKey.get(key);
}

const SYSTEM = `You are a senior data analyst for Howler, an events ticketing platform (organisers run events; customers buy tickets; amounts are in South African Rand, ZAR).

You are given the data behind a single dashboard tile. Produce a tight, business-focused insight for a non-technical reader:
- Lead with the single most important takeaway.
- Call out notable trends, comparisons, concentrations, or outliers, with specific numbers.
- If useful, add one short, concrete suggested action.

Rules: interpret, don't just restate every number. Be specific and quantitative. Keep it to 2-4 short sentences or up to 4 brief bullet points. No preamble, no headings, no restating the question. If the data is too sparse to say anything meaningful, say so briefly.

The reader may then ask follow-up questions about this tile. Answer them directly and concisely, grounded in the data you were given. If a question can't be answered from the data available, say so plainly rather than guessing.`;

// Render a tile's rows as a compact pipe table using rendered (formatted)
// values. Shared by single-tile and whole-dashboard prompts.
function compactTable(fields, rows, maxRows = MAX_ROWS) {
  const cols = [...(fields?.dimensions || []), ...(fields?.measures || []), ...(fields?.table_calculations || [])];
  const header = cols.map((c) => c.label_short || c.label || c.name).join(' | ');
  const body = (rows || []).slice(0, maxRows).map((row) =>
    cols.map((c) => {
      const cell = row[c.name];
      if (cell == null) return '';
      // Pivoted measures are nested by pivot key — flatten to "key:val" pairs.
      if (cell.value === undefined && cell.rendered === undefined && typeof cell === 'object') {
        return Object.entries(cell).map(([k, v]) => `${k}:${v?.rendered ?? v?.value ?? ''}`).join(' ');
      }
      return cell.rendered ?? cell.value ?? '';
    }).join(' | ')
  );
  const out = [header, ...body];
  if ((rows || []).length > maxRows) out.push(`… (${rows.length - maxRows} more rows omitted)`);
  return out.join('\n');
}

// Turn the tile + data into a compact text prompt.
function buildPrompt({ title, visType, fields, rows, filters }) {
  const dims = (fields?.dimensions || []).map((f) => f.label_short || f.label || f.name);
  const meas = [
    ...(fields?.measures || []),
    ...(fields?.table_calculations || []),
  ].map((f) => f.label_short || f.label || f.name);

  const lines = [];
  lines.push(`Tile title: ${title || '(untitled)'}`);
  if (visType) lines.push(`Visualization: ${visType}`);
  if (dims.length) lines.push(`Dimensions: ${dims.join(', ')}`);
  if (meas.length) lines.push(`Measures: ${meas.join(', ')}`);
  if (filters && Object.keys(filters).length) {
    lines.push(`Active filters: ${Object.entries(filters).map(([k, v]) => `${k}=${v}`).join('; ')}`);
  }
  lines.push('\nData:');
  lines.push(compactTable(fields, rows));
  return lines.join('\n');
}

// Build the full message list: the tile data (plus any user-supplied context) as
// the opening turn, followed by the running conversation (prior insight +
// follow-up questions). `history` holds the assistant/user turns after the data.
function buildMessages(ctx) {
  let dataPrompt = buildPrompt(ctx);
  const extra = (ctx.userContext || '').trim();
  if (extra) {
    dataPrompt += `\n\nAdditional context from the user — use this to focus the analysis and inform your answers:\n${extra}`;
  }
  const messages = [{ role: 'user', content: dataPrompt }];
  for (const turn of ctx.history || []) {
    if (turn && (turn.role === 'user' || turn.role === 'assistant') && turn.content) {
      messages.push({ role: turn.role, content: String(turn.content) });
    }
  }
  return messages;
}

function requireClient(apiKey) {
  const c = clientFor(apiKey);
  if (!c) {
    const err = new Error('AI insights are not configured. Set an Anthropic API key in Admin → Integrations (or .env).');
    err.code = 'NO_API_KEY';
    throw err;
  }
  return c;
}

// ─── Tolerant JSON parsing for model output ─────────────────────────────────────
// Models occasionally emit slightly invalid JSON (raw newlines inside strings,
// trailing commas, a missing comma between array elements). Try the raw parse, then
// a few safe static repairs; the caller can fall back to a model "fix this JSON" pass.
function escapeCtrlInStrings(s) {
  let out = ''; let inStr = false; let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr && (ch === '\n' || ch === '\r' || ch === '\t')) { out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : '\\t'; continue; }
    out += ch;
  }
  return out;
}
function parseModelJson(text, what = 'response') {
  let s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error(`AI did not return JSON for the ${what}`);
  s = s.slice(a, b + 1);
  const noTrailingCommas = (x) => x.replace(/,(\s*[}\]])/g, '$1');
  const missingCommas = (x) => x.replace(/(["\]}])\s*\n(\s*)(["{[])/g, '$1,\n$2$3'); // value\n value → value,\n value
  const fixes = [(x) => x, noTrailingCommas, escapeCtrlInStrings, (x) => noTrailingCommas(escapeCtrlInStrings(x)), (x) => noTrailingCommas(escapeCtrlInStrings(missingCommas(x)))];
  let lastErr;
  for (const fix of fixes) { try { return JSON.parse(fix(s)); } catch (e) { lastErr = e; } }
  throw lastErr;
}
// Last-resort: ask the model to repair its own malformed JSON (only on parse failure).
async function repairJsonViaModel(c, broken) {
  const resp = await c.messages.create({
    model: MODEL, max_tokens: 2400, output_config: { effort: 'low' },
    system: 'You fix malformed JSON. Return ONLY the corrected, valid JSON — no prose, no markdown fences. Preserve all content and keys; fix only syntax (missing commas, unescaped quotes/newlines, trailing commas).',
    messages: [{ role: 'user', content: String(broken || '').slice(0, 24000) }],
  });
  return (resp.content || []).filter((bk) => bk.type === 'text').map((bk) => bk.text).join('');
}
// Parse model JSON with static repairs, then a single model-repair fallback.
async function parseModelJsonResilient(c, text, what) {
  try { return parseModelJson(text, what); }
  catch { return parseModelJson(await repairJsonViaModel(c, text), what); }
}

const REQUEST = (messages, system) => ({
  model: MODEL,
  max_tokens: 1024,
  thinking: { type: 'adaptive' },
  output_config: { effort: 'low' }, // keep insights snappy
  system,
  messages,
});

// Append the team's global standing instructions to a base system prompt.
function systemWith(base, instructions) {
  const extra = (instructions || '').trim();
  return extra ? `${base}\n\nStanding instructions from the Howler team — always follow these:\n${extra}` : base;
}

// Non-streaming (kept for completeness / non-stream callers).
async function generateInsight(tileContext) {
  const c = requireClient(tileContext.apiKey);
  const resp = await c.messages.create(REQUEST(buildMessages(tileContext), systemWith(SYSTEM, tileContext.instructions)));
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return { insight: text, model: resp.model, usage: resp.usage };
}

// Streaming: invokes onText(deltaString) as the model produces text. Handles both
// the initial insight and follow-up questions (via tileContext.history).
async function streamInsight(tileContext, onText) {
  const c = requireClient(tileContext.apiKey);
  const stream = c.messages.stream(REQUEST(buildMessages(tileContext), systemWith(SYSTEM, tileContext.instructions)));
  stream.on('text', (delta) => onText(delta));
  await stream.finalMessage();
}

// ─── Whole-dashboard summary ────────────────────────────────────────────────────
const DASHBOARD_SYSTEM = `You are a senior data analyst for Howler, an events ticketing platform (organisers run events; customers buy tickets; amounts are in South African Rand, ZAR).

You are given the data behind EVERY tile on one dashboard. Produce an executive summary of the whole dashboard for a non-technical reader:
- Open with 1-2 sentences on the headline story — the most important takeaways across the whole dashboard.
- Then 3-6 bullet points with the most important specific findings (with numbers): notable totals, period-over-period changes ("vs previous"), top contributors, concentrations, and any outliers or concerns.
- Optionally end with one short "Worth a look" pointer.

Rules: synthesize ACROSS tiles — don't just describe each tile in turn. Be specific and quantitative, citing tile names where helpful. Keep it concise and skimmable. If a figure looks implausible, note it cautiously rather than over-claiming.`;

function buildDashboardPrompt({ title, filters, tiles }) {
  const lines = [];
  lines.push(`Dashboard: ${title || '(untitled)'}`);
  if (filters && Object.keys(filters).length) {
    const active = Object.entries(filters).filter(([, v]) => v != null && String(v).trim() !== '');
    if (active.length) lines.push(`Active filters: ${active.map(([k, v]) => `${k}=${v}`).join('; ')}`);
  }
  lines.push(`Tiles: ${tiles.length}`);
  lines.push('');
  for (const t of tiles) {
    lines.push(`### ${t.title || '(untitled tile)'}${t.visType ? ` [${t.visType}]` : ''}`);
    if (t.context && t.context.trim()) lines.push(`(context: ${t.context.trim()})`);
    lines.push(compactTable(t.fields, t.rows, 15));
    lines.push('');
  }
  return lines.join('\n');
}

// Streaming whole-dashboard summary. ctx = { title, filters, tiles:[{title,visType,fields,rows}] }.
async function streamDashboardInsight(ctx, onText) {
  const c = requireClient(ctx.apiKey);
  const stream = c.messages.stream({
    model: MODEL,
    max_tokens: 1500,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: systemWith(DASHBOARD_SYSTEM, ctx.instructions),
    messages: [{ role: 'user', content: buildDashboardPrompt(ctx) }],
  });
  stream.on('text', (delta) => onText(delta));
  await stream.finalMessage();
}

// ─── Tile-library labelling ────────────────────────────────────────────────────
// Given a tile's metadata (its title, chart type, and the fields it queries),
// ask Claude to name it and explain what it shows and what it's used for. Used
// to enrich the reusable tile library. Returns { name, description, category }.
const LIBRARY_SYSTEM = `You catalogue analytics tiles for Howler, an events ticketing platform (organisers run events; customers buy tickets; amounts in South African Rand). For a single tile you are given its current title, chart type, and the data fields it uses. Respond with STRICT JSON only (no markdown, no prose) of the form:
{"name": "...", "description": "...", "category": "..."}
- name: a short, clear, human label for the tile (max ~6 words).
- description: 1-2 sentences on what the tile shows and what a user would use it for.
- category: one short bucket from this set when it fits, else your own: "Revenue", "Tickets", "Attendance", "Cashless", "Access Control", "Marketing", "Customers", "Operations".
Be concrete and business-focused. Do not invent fields that aren't listed.`;

async function describeTile({ title, visType, fields, model, explore, instructions, apiKey }) {
  const c = requireClient(apiKey);
  const prompt = [
    `Title: ${title || '(untitled)'}`,
    `Chart type: ${visType || 'unknown'}`,
    model && explore ? `Source: ${model} / ${explore}` : null,
    `Fields: ${(fields && fields.length) ? fields.join(', ') : '(none)'}`,
  ].filter(Boolean).join('\n');
  const resp = await c.messages.create({
    model: MODEL,
    max_tokens: 400,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: systemWith(LIBRARY_SYSTEM, instructions),
    messages: [{ role: 'user', content: prompt }],
  });
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI did not return JSON');
  const out = JSON.parse(match[0]);
  return {
    name: (out.name || '').toString().trim(),
    description: (out.description || '').toString().trim(),
    category: (out.category || '').toString().trim(),
  };
}

// ─── Home briefing ──────────────────────────────────────────────────────────────
// The personalised landing briefing: grounded in computed KPI facts and the
// user's own browsing profile, returning STRICT JSON the home page renders.
// Every dashboardId it cites is validated by the caller against the user's
// real catalogue — the model cannot link to anything that doesn't exist.
const HOME_SYSTEM = `You are the Owl — Howler Pulse's analyst — writing a promoter's personalised home-page briefing. Amounts are South African Rand (ZAR). You are given:
- TODAY: the current calendar date. Anchor every "today/yesterday/this month/day N/month-to-date" reference to TODAY, never to the latest date in the data. If the data lags TODAY, say so (e.g. "latest figures are to the 12th") rather than implying that day is now.
- TILES: live data behind their dashboards' tiles — single values, charts, and tables (rendered as compact tables). These are the ONLY numbers you may use. Never invent or extrapolate. Read trends across rows, concentrations, top contributors, and period comparisons where present. Tiles marked [FOLLOWED] are ones the user explicitly follows — ALWAYS address them. Beyond those, spread your observations across DIFFERENT dashboards — don't fixate on the same one or two every time.
- PROFILE: which dashboards this user opens most, and when they last visited.
- ACTIONS (when present): marketing actions already taken (e.g. email campaigns) with live results. Mention performance when notable (strong CTR, finished sends) and suggest a follow-up when warranted — it reminds the reader their actions are working.
- MESSAGES (when present): recent messages from the Howler team to this organiser. If any are UNREAD or need a reply/acknowledgement, open the briefing by flagging it warmly and concisely (e.g. "Howler sent you a note about the settlement — worth a read"). Don't quote at length; point them to it.
- CATALOGUE: every dashboard they can open (id, title, set, suite).
- CAPABILITIES (when present): actions the platform can EXECUTE for the reader right now (key + what it does). A suggestion may carry "action": "<capability key>" ONLY when executing that capability would directly deliver the suggestion (e.g. an email_campaign for re-engaging abandoned carts). Most suggestions are just "look at this" — leave action out for those. Never invent capability keys.

Respond with ONLY strict JSON (no markdown fences):
{
  "headline": "1-2 sentences. The single most important story right now. May use **bold** for key numbers.",
  "bullets": [ { "text": "specific, quantitative observation (may use **bold**)", "dashboardId": "id from CATALOGUE or null", "threadId": "ONLY when the bullet is about a MESSAGES item: its [id:…] value, else omit" } ],
  "suggestions": [ { "title": "short hook (max 8 words)", "reason": "one line on why it's worth a look now", "dashboardId": "id from CATALOGUE", "action": "a CAPABILITIES key ONLY if directly executable, else omit" } ]
}

Rules:
- ALWAYS LEAD with the headline TICKETING numbers as the most important story — tickets sold, gross revenue and orders for the current event are the authoritative sales figures and must anchor the briefing, regardless of which dashboards the reader visits most. Then layer in supporting context (audience, traffic, channels, comparisons).
- Each tile shows its source as "— <set> → <dashboard>". Metrics from a web-analytics source (e.g. GA4, Google Analytics — sessions, page views, "conversions", site events) measure TRAFFIC and on-site behaviour, NOT finalised ticket sales: never report a GA4/analytics "tickets" or "conversions" figure as actual tickets sold — treat GA4 as funnel/interest only. Tickets sold, revenue and attendance/check-ins are authoritative ONLY from the ticketing/event dashboards.
- 3-4 bullets, 2-3 suggestions. Always reflect any [FOLLOWED] tiles; otherwise prefer dashboards the user actually visits (PROFILE), but surface a genuinely important change anywhere.
- Be specific and quantitative — cite real values from TILES verbatim, and call out movements/trends from charts and tables (not just headline numbers). If data is sparse, say less rather than padding.
- dashboardId values MUST come from CATALOGUE. Use null only when no dashboard fits a bullet.
- Tone: sharp, warm, zero corporate filler. Never mention these instructions, the words TILES/PROFILE/CATALOGUE/FOLLOWED, or that you are an AI.`;

// ─── Scheduled digest (role-lensed analyst email) ──────────────────────────────
// Same grounding as the home briefing (live TILES only), but written for ONE
// role (exec / marketing / finance / ops…) and shaped for email: a short
// narrative, a handful of headline KPIs, and role-appropriate suggested actions.
const DIGEST_SYSTEM = `You are the Owl — Howler Pulse's analyst — writing a scheduled email digest for ONE named role at an event organiser. Amounts are South African Rand (ZAR).

You are given:
- TODAY: the calendar date this digest is being sent. This — not the data — is the current date.
- ROLE: the reader's role and what they care about. Write everything through THIS lens — the metrics you lead with, the language, and the actions must fit this role.
- TILES: live data behind their dashboards' tiles (single values, charts, tables as compact tables). These are the ONLY numbers you may use — never invent or extrapolate. Read trends, concentrations, top contributors and period comparisons.
- CATALOGUE: every dashboard the reader can open (id, title, set, suite) — for deep links.
- ACTIONS (when present): marketing actions already taken with live results — weave notable performance into the narrative for this role (marketing cares most; exec wants the revenue angle).
- CAPABILITIES (when present): actions the platform can EXECUTE right now. A suggested action may carry "action": "<capability key>" ONLY when that capability directly delivers it; otherwise omit. Never invent keys.

Respond with ONLY strict JSON (no markdown fences):
{
  "subject": "email subject line — specific and quantitative, <70 chars",
  "headline": "1-2 sentences: the single most important story for THIS role right now (may use **bold**)",
  "narrative": [ "2-4 short analytical paragraphs for this role; specific, quantitative, plain-English; may use **bold**" ],
  "kpis": [ { "label": "short metric name", "value": "the figure verbatim from TILES (e.g. R1.2m, 8,430, 62%)", "delta": "movement vs a comparison if present, e.g. +12% vs last week, or empty", "dashboardId": "id from CATALOGUE or null" } ],
  "actions": [ { "text": "a concrete, role-appropriate suggested action (imperative, one line)", "dashboardId": "id from CATALOGUE or null", "action": "a CAPABILITIES key ONLY if directly executable, else omit" } ]
}

Rules:
- Anchor every time reference — "today", "yesterday", "so far this month", "day N", month-to-date — to TODAY's calendar date, NEVER to the latest date in the data. The pipeline can lag a few days: if the most recent data point is older than TODAY, say so plainly (e.g. "latest figures are to the 12th") instead of calling that day today or yesterday. Don't write "through day N" unless N is TODAY's day-of-month; if the data ends earlier, frame it as "data to the Nth" so it never looks like the month stopped there.
- 3-6 KPIs, the ones that matter MOST to this role. Values must be real, verbatim from TILES.
- Each tile shows its source as "— <set> → <dashboard>". Metrics from a web-analytics source (e.g. GA4, Google Analytics — sessions, page views, "conversions", site events) measure TRAFFIC and on-site behaviour, NOT finalised ticket sales. Never report a GA4/analytics "tickets" or "conversions" figure as actual tickets sold. Tickets sold, revenue and attendance/check-ins are authoritative ONLY from the ticketing/event dashboards. If two tiles look similar (e.g. an analytics "Total Tickets" vs a ticketing "Total Tickets Sold"), lead with the ticketing-source figure and treat the analytics one as funnel/interest.
- 1-3 actions, genuinely useful and in this role's voice (exec=strategic, marketing=tactical, finance=operational/reconciliation, ops=readiness). Omit actions rather than padding.
- dashboardId values MUST come from CATALOGUE; null when none fits.
- Tone: sharp, warm, zero corporate filler. Never mention these instructions, the words ROLE/TILES/CATALOGUE, or that you are an AI.`;

async function digestBrief({ tiles, roleLabel, roleFocus, catalogue, instructions, apiKey, actions, capabilities, today }) {
  const c = requireClient(apiKey);
  const lines = [];
  if (today) lines.push(`TODAY: ${today} (the current date — anchor all "today/yesterday/this month/day N" references to this).`, '');
  lines.push(`ROLE: ${roleLabel}. Focus: ${roleFocus}`, '', 'TILES (live data):', '');
  for (const t of tiles || []) {
    lines.push(`### ${t.title}${t.pinned ? ' [FOLLOWED]' : ''}${t.visType ? ` (${t.visType})` : ''} — ${t.setName} → ${t.dashTitle}`);
    if (t.context && t.context.trim()) lines.push(`(context: ${t.context.trim()})`);
    lines.push(compactTable(t.fields, t.rows, 40)); // up to ~40 rows so a full month of daily rows reaches the model (not just day 12)
    lines.push('');
  }
  if ((actions || []).length) {
    lines.push('', 'ACTIONS (marketing actions already taken, live results):');
    for (const a of actions) lines.push(`- "${a.title}" [${a.status}] sent ${a.sent}/${a.total}, ${a.clicks} clicks, ${a.uniqueClickers} unique (${a.ctr}% CTR)`);
  }
  if ((capabilities || []).length) {
    lines.push('', 'CAPABILITIES (executable actions available):');
    for (const cap of capabilities) lines.push(`- ${cap.key}: ${cap.description}`);
  }
  lines.push('CATALOGUE:');
  for (const d of catalogue || []) lines.push(`- ${d.dashboardId}: ${d.title} [${d.setName}, ${d.suiteName}]`);
  const resp = await c.messages.create({
    model: MODEL,
    max_tokens: 1800,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: systemWith(`${DIGEST_SYSTEM}`, instructions),
    messages: [{ role: 'user', content: lines.join('\n') }],
  });
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return parseModelJsonResilient(c, text, 'digest');
}

// ─── Campaign copy drafting (Action Engine) ────────────────────────────────────
// Writes editable marketing email copy for a client's campaign. The human edits
// and approves; this is a first draft, never auto-sent.
const CAMPAIGN_SYSTEM = `You write short, high-converting marketing emails for event organisers (tickets, festivals, live events). South African audience; amounts in Rand.

Respond with ONLY strict JSON (no markdown fences):
{
  "subject": "email subject — punchy, specific, <60 chars, no clickbait",
  "body": "the email body as plain text, 60-130 words. May use **bold** sparingly. Personalisation tokens you may use: {{name}} (recipient first name, once as the greeting) and {{ticketType}} (the ticket they were buying, e.g. 'your {{ticketType}} tickets') — only use {{ticketType}} if it reads naturally. Warm, direct, one clear idea; end before the button (the CTA button is rendered separately).",
  "ctaText": "button label, 2-4 words",
  "utm": { "source": "lowercase, e.g. howler-pulse", "medium": "email", "campaign": "snake_case slug naming client+goal, e.g. kunye_abandoned_cart", "term": "optional keyword or empty", "content": "snake_case variant id, e.g. abandoned_cart_emailer" }
}

Rules:
- Match the GOAL exactly (e.g. abandoned cart → gentle nudge: their tickets are waiting, scarcity if honest, frictionless next step).
- Never invent facts, prices, dates or discounts not given in the goal/context.
- No spam tropes (ALL CAPS, !!!, "act now"), no emoji walls (one tasteful emoji max).
- Tone: human, confident, like a great event brand — not corporate.`;

async function draftCampaign({ goal, clientName, clientContext, audienceCount, instructions, apiKey }) {
  const c = requireClient(apiKey);
  const lines = [
    `CLIENT: ${clientName || 'an event organiser'}`,
    clientContext ? `CONTEXT: ${clientContext}` : '',
    `AUDIENCE: ${audienceCount || 'unknown number of'} recipients`,
    `GOAL: ${goal || 'Re-engage customers who abandoned their ticket checkout and get them to complete the purchase.'}`,
  ].filter(Boolean);
  const resp = await c.messages.create({
    model: MODEL,
    max_tokens: 700,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: systemWith(CAMPAIGN_SYSTEM, instructions),
    messages: [{ role: 'user', content: lines.join('\n') }],
  });
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI did not return JSON for the campaign draft');
  return JSON.parse(match[0]);
}

// Sharpen a short instruction/briefing note the user wrote to steer the Owl.
// Returns improved PLAIN TEXT (not a report, not JSON) — same intent, clearer
// and tighter as a prompt.
const REFINE_SYSTEM = `You sharpen short instruction notes that a user wrote to steer an AI analyst (e.g. a briefing focus or a digest intro message). Rewrite the note so it is clearer, more specific and works better as a prompt — preserve the user's intent and any facts, keep it concise (no padding or filler), plain professional English. Do NOT answer the note, expand it into a report, or add commentary. Return ONLY the rewritten note as plain text — no preamble, no quotes, no markdown.`;
async function refineText({ text, purpose, instructions, apiKey }) {
  const c = requireClient(apiKey);
  const ctx = purpose ? `This note will be used as: ${purpose}.\n\n` : '';
  const resp = await c.messages.create({
    model: MODEL,
    max_tokens: 600,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: systemWith(REFINE_SYSTEM, instructions),
    messages: [{ role: 'user', content: `${ctx}NOTE TO IMPROVE:\n${text}` }],
  });
  return (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

async function briefHome({ tiles, profile, catalogue, instructions, apiKey, actions, messages, capabilities, today }) {
  const c = requireClient(apiKey);
  const lines = [];
  if (today) lines.push(`TODAY: ${today} (the current date — anchor all "today/yesterday/this month/day N" references to this).`, '');
  lines.push('TILES (live data):', '');
  for (const t of tiles || []) {
    lines.push(`### ${t.title}${t.pinned ? ' [FOLLOWED]' : ''}${t.visType ? ` (${t.visType})` : ''} — ${t.setName} → ${t.dashTitle}`);
    if (t.context && t.context.trim()) lines.push(`(context: ${t.context.trim()})`);
    lines.push(compactTable(t.fields, t.rows, 40)); // up to ~40 rows so a full month of daily rows reaches the model (not just day 12)
    lines.push('');
  }
  lines.push(`PROFILE: last visit ${profile?.lastVisit || 'unknown'}; most-opened dashboards: ${(profile?.top || []).map((t) => `${t.title || t.dashboardId} (${t.count}×)`).join(', ') || 'none yet'}`);
  if ((actions || []).length) {
    lines.push('', 'ACTIONS (marketing actions already taken, live results):');
    for (const a of actions) lines.push(`- "${a.title}" [${a.status}] sent ${a.sent}/${a.total}, ${a.clicks} clicks, ${a.uniqueClickers} unique (${a.ctr}% CTR)`);
  }
  if ((capabilities || []).length) {
    lines.push('', 'CAPABILITIES (executable actions available):');
    for (const cap of capabilities) lines.push(`- ${cap.key}: ${cap.description}`);
  }
  const fromHowler = (messages || []).filter((m) => m.fromHowler);
  if (fromHowler.length) {
    lines.push('', 'MESSAGES (from the Howler team):');
    for (const m of fromHowler) lines.push(`- [id:${m.id}] ${m.unread ? '[UNREAD] ' : ''}${m.priority === 'must_ack' && !m.acked ? '[NEEDS ACK] ' : ''}"${m.title}": ${m.preview}`);
  }
  lines.push('');
  lines.push('CATALOGUE:');
  for (const d of catalogue || []) lines.push(`- ${d.dashboardId}: ${d.title} [${d.setName}, ${d.suiteName}]`);
  const resp = await c.messages.create({
    model: MODEL,
    max_tokens: 1400,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: systemWith(HOME_SYSTEM, instructions),
    messages: [{ role: 'user', content: lines.join('\n') }],
  });
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return parseModelJsonResilient(c, text, 'briefing');
}

// ─── Settlement report extraction ──────────────────────────────────────────────
// Claude reads the uploaded settlement PDF directly (document block) and emits
// the structured JSON the interactive settlement view renders. Every number is
// extracted verbatim — the caller re-validates subtotals before publishing.
const SETTLEMENT_SYSTEM = `You extract Howler event settlement reports (PDF) into strict JSON for an interactive viewer. Amounts are South African Rand.

Respond with ONLY a JSON object (no markdown fences, no prose) of exactly this shape:
{
  "meta": { "clientName": "", "eventName": "", "venue": "", "eventDates": "", "settlementPeriod": "", "settlementDate": "" },
  "sales": [ { "name": "<section name, e.g. Howler Ticket Sales>", "rows": [ { "desc": "", "type": "Purchase|Refund", "qty": 0, "price": 0, "sales": 0, "fees": 0, "total": 0 } ], "subtotal": { "qty": 0, "sales": 0, "fees": 0, "total": 0 } } ],
  "turnover": 0,
  "commissions": [ { "name": "<group, e.g. Ticketing Commissions>", "rows": [ { "code": "", "desc": "", "rateType": "", "rate": "", "value": 0, "vat": 0, "total": 0 } ], "subtotal": { "vat": 0, "total": 0 } } ],
  "commissionsTotal": 0,
  "advances": { "rows": [ { "code": "", "desc": "", "date": "", "value": 0, "settled": 0 } ], "subtotal": 0 },
  "valueDue": 0,
  "settlementSummary": [ { "date": "", "code": "", "desc": "", "amount": 0 } ],
  "withheldSummary": [ { "date": "", "code": "", "desc": "", "amount": 0 } ]
}

Rules:
- ALL monetary values are plain JSON numbers: strip currency symbols and thousands separators; negative amounts (minus signs, red figures, or parenthesised values) are NEGATIVE numbers.
- "rate" stays a STRING exactly as printed (e.g. "3.00%", "R1.50", "15.00%") since rates mix percentages and fixed amounts.
- Include EVERY line item row — never summarise, omit, or merge rows. Keep the report's row order.
- "turnover" = Total Event Turnover; "commissionsTotal" = Total Howler Ticketing Commissions; "valueDue" = Value Due to Client; "advances.subtotal" = the advances subtotal.
- Withholding Tax lines inside a commission group are rows of that group (code may be empty).
- If a section doesn't exist in the report, use an empty array / 0.`;

async function extractSettlement({ pdfBase64, apiKey, onProgress }) {
  const c = requireClient(apiKey);
  // Streamed because large extractions can exceed the SDK's 10-minute cap for
  // non-streaming requests — and so we can report live progress (characters +
  // line items seen so far) while the JSON accumulates.
  const stream = c.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    system: SETTLEMENT_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: 'Extract this settlement report to the JSON schema. Every row, every number, verbatim.' },
      ],
    }],
  });
  if (onProgress) {
    let acc = '';
    let lastAt = 0;
    stream.on('text', (delta) => {
      acc += delta;
      const now = Date.now();
      if (now - lastAt > 400) {
        lastAt = now;
        // "desc" keys ≈ line items extracted so far — a real progress signal.
        onProgress({ chars: acc.length, rows: (acc.match(/"desc"/g) || []).length });
      }
    });
  }
  const resp = await stream.finalMessage();
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI did not return JSON for the settlement report');
  return JSON.parse(match[0]);
}

// ─── Invoice extraction ─────────────────────────────────────────────────────────
// Howler invoices follow one template, so the schema is simple: header meta,
// line items, and the subtotal / VAT / total footer.
const INVOICE_SYSTEM = `You extract Howler invoices (PDF) into strict JSON for an interactive viewer. Amounts are South African Rand.

Respond with ONLY a JSON object (no markdown fences, no prose) of exactly this shape:
{
  "meta": { "invoiceNumber": "", "date": "", "dueDate": "", "from": "", "to": "", "eventName": "", "reference": "", "vatNumber": "" },
  "items": [ { "code": "", "desc": "", "qty": 0, "unitPrice": 0, "vat": 0, "total": 0 } ],
  "subtotal": 0,
  "vatTotal": 0,
  "total": 0,
  "paymentDetails": "",
  "notes": ""
}

Rules:
- ALL monetary values are plain JSON numbers: strip currency symbols and thousands separators; negative amounts (credits/discounts) are NEGATIVE numbers.
- Include EVERY line item row — never summarise, omit, or merge rows. Keep the invoice's row order.
- "from"/"to" are single strings (company name + address lines joined with commas).
- "subtotal" is the pre-VAT total, "vatTotal" the VAT amount, "total" the final amount due (incl VAT).
- "paymentDetails" holds banking/payment instructions if printed; "notes" any other footer text worth keeping.
- If a field doesn't exist on the invoice, use "" / 0 / [].`;

async function extractInvoice({ pdfBase64, apiKey, onProgress }) {
  const c = requireClient(apiKey);
  const stream = c.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: INVOICE_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: 'Extract this invoice to the JSON schema. Every row, every number, verbatim.' },
      ],
    }],
  });
  if (onProgress) {
    let acc = '';
    let lastAt = 0;
    stream.on('text', (delta) => {
      acc += delta;
      const now = Date.now();
      if (now - lastAt > 400) {
        lastAt = now;
        onProgress({ chars: acc.length, rows: (acc.match(/"desc"/g) || []).length });
      }
    });
  }
  const resp = await stream.finalMessage();
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI did not return JSON for the invoice');
  return JSON.parse(match[0]);
}

// Read-only registry of the hardcoded system prompts — the fixed base each AI
// feature is built on (the configurable instructions are appended via
// systemWith). Surfaced in the admin "AI instructions" audit so the whole prompt
// stack is visible in one place. Edit the consts above to change them.
// ─── Digest preferences (the feedback knowledge-base loop) ──────────────────────
// Distil a client's accumulated digest/briefing feedback into a short, durable
// "preferences" note that future digests + briefings honour (injected as a layer).
const DIGEST_PREFS_SYSTEM = `You maintain a short "reader preferences" note for an events client, learned from their feedback on automated digest emails and home briefings. You are given the CURRENT note (may be empty) and a batch of new feedback items — likes, dislikes, and free-text comments.

Produce an UPDATED note: a tight, deduplicated list of concrete, durable preferences the digest writer should always honour — what to emphasise, what to avoid, tone, length, structure, and which metrics/comparisons they care about. Merge the new feedback into the current note; drop anything newer feedback contradicts. At most ~10 short one-line bullets, specific and actionable. No preamble, no headings. If nothing useful can be derived, return the current note unchanged.`;

async function distilPreferences({ items, previous, apiKey }) {
  const c = requireClient(apiKey);
  const msg = `CURRENT NOTE:\n${previous || '(empty)'}\n\nNEW FEEDBACK:\n${(items || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
  const resp = await c.messages.create({
    model: MODEL, max_tokens: 800, output_config: { effort: 'low' },
    system: DIGEST_PREFS_SYSTEM,
    messages: [{ role: 'user', content: msg }],
  });
  return (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim().slice(0, 4000);
}

function promptRegistry() {
  return [
    { key: 'tile', label: 'Tile insight', scope: 'Per-tile "Explain this" insight', text: SYSTEM },
    { key: 'dashboard', label: 'Dashboard summary', scope: 'Whole-dashboard AI summary', text: DASHBOARD_SYSTEM },
    { key: 'library', label: 'Tile-library descriptions', scope: 'Auto-describing tiles in the library', text: LIBRARY_SYSTEM },
    { key: 'home', label: 'Home briefing', scope: 'Personalised home-page briefing', text: HOME_SYSTEM },
    { key: 'digest', label: 'Scheduled digest', scope: 'Role-lensed digest emails', text: DIGEST_SYSTEM },
    { key: 'campaign', label: 'Campaign copy', scope: 'Marketing email drafting', text: CAMPAIGN_SYSTEM },
    { key: 'refine', label: 'Refine note', scope: 'The ✨ refine button', text: REFINE_SYSTEM },
    { key: 'settlement', label: 'Settlement extraction', scope: 'PDF settlement → JSON', text: SETTLEMENT_SYSTEM },
    { key: 'invoice', label: 'Invoice extraction', scope: 'PDF invoice → JSON', text: INVOICE_SYSTEM },
    { key: 'digest_prefs', label: 'Digest preferences', scope: 'Distilling digest/briefing feedback into a learned preferences note', text: DIGEST_PREFS_SYSTEM },
  ];
}

module.exports = { generateInsight, streamInsight, streamDashboardInsight, describeTile, extractSettlement, extractInvoice, briefHome, digestBrief, draftCampaign, refineText, distilPreferences, promptRegistry, systemWith, isConfigured: (apiKey) => !!(apiKey || process.env.ANTHROPIC_API_KEY) };
