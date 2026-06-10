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

module.exports = { generateInsight, streamInsight, streamDashboardInsight, describeTile, extractSettlement, extractInvoice, isConfigured: (apiKey) => !!(apiKey || process.env.ANTHROPIC_API_KEY) };
