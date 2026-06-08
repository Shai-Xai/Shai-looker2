// ─── AI insights ─────────────────────────────────────────────────────────────
// Given a dashboard tile's data + context, ask Claude for a concise,
// business-focused insight. Single Messages API call via the official SDK;
// the API key stays server-side.

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-4-8';
const MAX_ROWS = 60; // cap rows sent to keep the prompt small and cheap

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return client;
}

const SYSTEM = `You are a senior data analyst for Howler, an events ticketing platform (organisers run events; customers buy tickets; amounts are in South African Rand, ZAR).

You are given the data behind a single dashboard tile. Produce a tight, business-focused insight for a non-technical reader:
- Lead with the single most important takeaway.
- Call out notable trends, comparisons, concentrations, or outliers, with specific numbers.
- If useful, add one short, concrete suggested action.

Rules: interpret, don't just restate every number. Be specific and quantitative. Keep it to 2-4 short sentences or up to 4 brief bullet points. No preamble, no headings, no restating the question. If the data is too sparse to say anything meaningful, say so briefly.

The reader may then ask follow-up questions about this tile. Answer them directly and concisely, grounded in the data you were given. If a question can't be answered from the data available, say so plainly rather than guessing.`;

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

  // Render rows as a compact pipe table using the rendered (formatted) values.
  const cols = [...(fields?.dimensions || []), ...(fields?.measures || []), ...(fields?.table_calculations || [])];
  const header = cols.map((c) => c.label_short || c.label || c.name).join(' | ');
  const body = (rows || []).slice(0, MAX_ROWS).map((row) =>
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

  lines.push('\nData:');
  lines.push(header);
  lines.push(...body);
  if ((rows || []).length > MAX_ROWS) lines.push(`… (${rows.length - MAX_ROWS} more rows omitted)`);

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

function requireClient() {
  const c = getClient();
  if (!c) {
    const err = new Error('AI insights are not configured. Set ANTHROPIC_API_KEY in your .env to enable them.');
    err.code = 'NO_API_KEY';
    throw err;
  }
  return c;
}

const REQUEST = (messages) => ({
  model: MODEL,
  max_tokens: 1024,
  thinking: { type: 'adaptive' },
  output_config: { effort: 'low' }, // keep insights snappy
  system: SYSTEM,
  messages,
});

// Non-streaming (kept for completeness / non-stream callers).
async function generateInsight(tileContext) {
  const c = requireClient();
  const resp = await c.messages.create(REQUEST(buildMessages(tileContext)));
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return { insight: text, model: resp.model, usage: resp.usage };
}

// Streaming: invokes onText(deltaString) as the model produces text. Handles both
// the initial insight and follow-up questions (via tileContext.history).
async function streamInsight(tileContext, onText) {
  const c = requireClient();
  const stream = c.messages.stream(REQUEST(buildMessages(tileContext)));
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

async function describeTile({ title, visType, fields, model, explore }) {
  const c = requireClient();
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
    system: LIBRARY_SYSTEM,
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

module.exports = { generateInsight, streamInsight, describeTile, isConfigured: () => !!process.env.ANTHROPIC_API_KEY };
