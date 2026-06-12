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
- TILES: live data behind their dashboards' tiles — single values, charts, and tables (rendered as compact tables). These are the ONLY numbers you may use. Never invent or extrapolate. Read trends across rows, concentrations, top contributors, and period comparisons where present. Tiles marked [FOLLOWED] are ones the user explicitly follows — ALWAYS address them. Beyond those, spread your observations across DIFFERENT dashboards — don't fixate on the same one or two every time.
- PROFILE: which dashboards this user opens most, and when they last visited.
- ACTIONS (when present): marketing actions already taken (e.g. email campaigns) with live results. Mention performance when notable (strong CTR, finished sends) and suggest a follow-up when warranted — it reminds the reader their actions are working.
- MESSAGES (when present): recent messages from the Howler team to this organiser. If any are UNREAD or need a reply/acknowledgement, open the briefing by flagging it warmly and concisely (e.g. "Howler sent you a note about the settlement — worth a read"). Don't quote at length; point them to it.
- CATALOGUE: every dashboard they can open (id, title, set, suite).

Respond with ONLY strict JSON (no markdown fences):
{
  "headline": "1-2 sentences. The single most important story right now. May use **bold** for key numbers.",
  "bullets": [ { "text": "specific, quantitative observation (may use **bold**)", "dashboardId": "id from CATALOGUE or null", "threadId": "ONLY when the bullet is about a MESSAGES item: its [id:…] value, else omit" } ],
  "suggestions": [ { "title": "short hook (max 8 words)", "reason": "one line on why it's worth a look now", "dashboardId": "id from CATALOGUE" } ]
}

Rules:
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
- ROLE: the reader's role and what they care about. Write everything through THIS lens — the metrics you lead with, the language, and the actions must fit this role.
- TILES: live data behind their dashboards' tiles (single values, charts, tables as compact tables). These are the ONLY numbers you may use — never invent or extrapolate. Read trends, concentrations, top contributors and period comparisons.
- CATALOGUE: every dashboard the reader can open (id, title, set, suite) — for deep links.
- ACTIONS (when present): marketing actions already taken with live results — weave notable performance into the narrative for this role (marketing cares most; exec wants the revenue angle).

Respond with ONLY strict JSON (no markdown fences):
{
  "subject": "email subject line — specific and quantitative, <70 chars",
  "headline": "1-2 sentences: the single most important story for THIS role right now (may use **bold**)",
  "narrative": [ "2-4 short analytical paragraphs for this role; specific, quantitative, plain-English; may use **bold**" ],
  "kpis": [ { "label": "short metric name", "value": "the figure verbatim from TILES (e.g. R1.2m, 8,430, 62%)", "delta": "movement vs a comparison if present, e.g. +12% vs last week, or empty", "dashboardId": "id from CATALOGUE or null" } ],
  "actions": [ { "text": "a concrete, role-appropriate suggested action (imperative, one line)", "dashboardId": "id from CATALOGUE or null" } ]
}

Rules:
- 3-6 KPIs, the ones that matter MOST to this role. Values must be real, verbatim from TILES.
- 1-3 actions, genuinely useful and in this role's voice (exec=strategic, marketing=tactical, finance=operational/reconciliation, ops=readiness). Omit actions rather than padding.
- dashboardId values MUST come from CATALOGUE; null when none fits.
- Tone: sharp, warm, zero corporate filler. Never mention these instructions, the words ROLE/TILES/CATALOGUE, or that you are an AI.`;

async function digestBrief({ tiles, roleLabel, roleFocus, catalogue, instructions, apiKey, actions }) {
  const c = requireClient(apiKey);
  const lines = [`ROLE: ${roleLabel}. Focus: ${roleFocus}`, '', 'TILES (live data):', ''];
  for (const t of tiles || []) {
    lines.push(`### ${t.title}${t.pinned ? ' [FOLLOWED]' : ''}${t.visType ? ` (${t.visType})` : ''} — ${t.setName} → ${t.dashTitle}`);
    if (t.context && t.context.trim()) lines.push(`(context: ${t.context.trim()})`);
    lines.push(compactTable(t.fields, t.rows, 12));
    lines.push('');
  }
  if ((actions || []).length) {
    lines.push('', 'ACTIONS (marketing actions already taken, live results):');
    for (const a of actions) lines.push(`- "${a.title}" [${a.status}] sent ${a.sent}/${a.total}, ${a.clicks} clicks, ${a.uniqueClickers} unique (${a.ctr}% CTR)`);
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
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI did not return JSON for the digest');
  return JSON.parse(match[0]);
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

async function briefHome({ tiles, profile, catalogue, instructions, apiKey, actions, messages }) {
  const c = requireClient(apiKey);
  const lines = ['TILES (live data):', ''];
  for (const t of tiles || []) {
    lines.push(`### ${t.title}${t.pinned ? ' [FOLLOWED]' : ''}${t.visType ? ` (${t.visType})` : ''} — ${t.setName} → ${t.dashTitle}`);
    if (t.context && t.context.trim()) lines.push(`(context: ${t.context.trim()})`);
    lines.push(compactTable(t.fields, t.rows, 12));
    lines.push('');
  }
  lines.push(`PROFILE: last visit ${profile?.lastVisit || 'unknown'}; most-opened dashboards: ${(profile?.top || []).map((t) => `${t.title || t.dashboardId} (${t.count}×)`).join(', ') || 'none yet'}`);
  if ((actions || []).length) {
    lines.push('', 'ACTIONS (marketing actions already taken, live results):');
    for (const a of actions) lines.push(`- "${a.title}" [${a.status}] sent ${a.sent}/${a.total}, ${a.clicks} clicks, ${a.uniqueClickers} unique (${a.ctr}% CTR)`);
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
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI did not return JSON for the briefing');
  return JSON.parse(match[0]);
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

module.exports = { generateInsight, streamInsight, streamDashboardInsight, describeTile, extractSettlement, extractInvoice, briefHome, digestBrief, draftCampaign, isConfigured: (apiKey) => !!(apiKey || process.env.ANTHROPIC_API_KEY) };
