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

Rules: interpret, don't just restate every number. Be specific and quantitative. Keep it to 2-4 short sentences or up to 4 brief bullet points. No preamble, no headings, no restating the question. If the data is too sparse to say anything meaningful, say so briefly.`;

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

async function generateInsight(tileContext) {
  const c = getClient();
  if (!c) {
    const err = new Error('AI insights are not configured. Set ANTHROPIC_API_KEY in your .env to enable them.');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const prompt = buildPrompt(tileContext);

  const resp = await c.messages.create({
    model: MODEL,
    max_tokens: 1024,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = (resp.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  return { insight: text, model: resp.model, usage: resp.usage };
}

module.exports = { generateInsight, isConfigured: () => !!process.env.ANTHROPIC_API_KEY };
