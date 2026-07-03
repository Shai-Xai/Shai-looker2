// ─── AI insights ─────────────────────────────────────────────────────────────
// Given a dashboard tile's data + context, ask Claude for a concise,
// business-focused insight. Single Messages API call via the official SDK;
// the API key stays server-side.

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-4-8';
// The home briefing is structured summarization-to-JSON over data we hand the
// model — a task a faster model handles well. Running it on Sonnet (instead of
// Opus) is the single biggest lever on briefing latency; flip this back to MODEL
// if the read quality regresses.
const BRIEF_MODEL = 'claude-sonnet-4-6';
const MAX_ROWS = 60; // cap rows sent to keep the prompt small and cheap

// One Anthropic client per API key (admin default from env/DB, or a client's own) — each wrapped by aiUsage so every call's token usage is metered (clientFor is the single chokepoint all modules get clients through).
const aiUsage = require('./aiUsage'); const clientsByKey = new Map();
function clientFor(apiKey) {
  const key = (apiKey || process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return null;
  // timeout/maxRetries override the SDK's 10-min ×2 default (a hung call would otherwise pin the sequential scheduler tick for ~30 min).
  if (!clientsByKey.has(key)) clientsByKey.set(key, aiUsage.wrapClient(new Anthropic({ apiKey: key, timeout: 120_000, maxRetries: 1 })));
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
// String-state-aware missing-comma repair: insert a comma between a value that
// ENDS ("/}/]) and the next value that STARTS ("/{/[) when only whitespace
// separates them (a comma already present, or a `:`/other token, is left alone).
// Tracks string state + escapes so it never touches content inside strings — the
// common "Expected ',' or ']' after array element" model slip, anywhere (not just
// at line breaks like the cheaper regex below).
function insertMissingCommas(s) {
  let out = ''; let inStr = false; let esc = false;
  const startsValue = (ch) => ch === '"' || ch === '{' || ch === '[';
  const nextNonWs = (from) => { let j = from; while (j < s.length && /\s/.test(s[j])) j++; return s[j]; };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    out += ch;
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') {
      if (inStr) { inStr = false; if (startsValue(nextNonWs(i + 1))) out += ','; }
      else inStr = true;
      continue;
    }
    if (!inStr && (ch === '}' || ch === ']')) { if (startsValue(nextNonWs(i + 1))) out += ','; }
  }
  return out;
}
// Last-ditch repair for a TRUNCATED response (the model hit its token cap
// mid-document): drop any incomplete trailing token, then close open strings,
// arrays and objects so the salvageable head still parses. Best-effort — only
// reached when every other fix has failed, so a rough recovery beats an error.
function closeTruncatedJson(s) {
  let inStr = false; let esc = false; const stack = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (inStr) { if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = s;
  if (inStr) out += '"';                 // close a string cut mid-value (keep the partial text)
  out = out.replace(/[,:]\s*$/, '');     // drop a dangling comma or colon
  // Drop a dangling KEY with no value left at the very end ({"k"  or ,"k").
  out = out.replace(/([{,])\s*"[^"]*"\s*$/, (_m, p) => (p === '{' ? '{' : ''));
  out = out.replace(/,\s*$/, '');        // tidy any comma the above left behind
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i];
  return out;
}
function parseModelJson(text, what = 'response') {
  let s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const a = s.indexOf('{');
  if (a < 0) throw new Error(`AI did not return JSON for the ${what}`);
  const b = s.lastIndexOf('}');
  // Prefer the full object; if truncated (no closing brace), keep from the first '{' so closeTruncatedJson can salvage it.
  s = b > a ? s.slice(a, b + 1) : s.slice(a);
  const noTrailingCommas = (x) => x.replace(/,(\s*[}\]])/g, '$1');
  const missingCommas = (x) => x.replace(/(["\]}])\s*\n(\s*)(["{[])/g, '$1,\n$2$3'); // value\n value → value,\n value
  const fixes = [
    (x) => x,
    noTrailingCommas,
    escapeCtrlInStrings,
    (x) => noTrailingCommas(escapeCtrlInStrings(x)),
    (x) => noTrailingCommas(escapeCtrlInStrings(missingCommas(x))),
    (x) => noTrailingCommas(insertMissingCommas(escapeCtrlInStrings(x))),
    (x) => noTrailingCommas(insertMissingCommas(closeTruncatedJson(escapeCtrlInStrings(x)))),
  ];
  let lastErr;
  for (const fix of fixes) { try { return JSON.parse(fix(s)); } catch (e) { lastErr = e; } }
  throw lastErr;
}
// Last-resort: ask the model to repair its own malformed JSON (only on parse failure).
const JSON_REPAIR_SYSTEM = `You fix malformed JSON. Return ONLY the corrected, valid JSON — no prose, no markdown fences. Preserve all content and keys; fix only syntax (missing commas, unescaped quotes/newlines, trailing commas).`;
async function repairJsonViaModel(c, broken) {
  const resp = await c.messages.create({
    model: MODEL, max_tokens: 8192, output_config: { effort: 'low' },
    system: JSON_REPAIR_SYSTEM,
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
// Same system text, but as a cacheable block: the briefing's big static prompt
// (rules + standing instructions) is stable across a prewarm+real pair and
// repeated refreshes, so caching the prefix shaves input-processing latency. The
// volatile tile data lives in the user message, after this prefix.
function cachedSystem(base, instructions) {
  return [{ type: 'text', text: systemWith(base, instructions), cache_control: { type: 'ephemeral' } }];
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

// ─── Goals (Results pillar) summary ──────────────────────────────────────────────
// A short Owl narrative over an event's goals. The values (current, %, pace,
// vs-last-time, next checkpoint) are ALREADY COMPUTED by the goals resolver and
// passed in — the model only phrases them (a Results non-negotiable: goal values
// are computed; the AI never recomputes or invents them).
const GOALS_SYSTEM = `You are a senior analyst for Howler, an events ticketing platform (organisers run events; customers buy tickets; amounts in South African Rand, ZAR).

You are given the GOALS for a single event, each with its progress ALREADY COMPUTED: current value, target, % to target, pace status (ahead / on track / behind versus where it should be by now), the value expected by now, the comparison to last time (both last time's value AT THIS SAME POINT in the cycle and last time's final total), the projected final landing (forecast — where it ends if it finishes like last time), days to go, and the next checkpoint. These numbers are facts — phrase them; never recompute, and never invent figures or goals that aren't listed.

Write a short, honest, motivating summary for the organiser:
- Lead with the North Star goal and whether it's on track.
- Call out what's ahead and what's behind pace, with the specific numbers.
- Mention the biggest move versus last time when it's notable.
- Point to the nearest checkpoint that needs attention, and end with one concrete nudge.

Keep it to 3-5 short sentences or up to 5 brief bullets. No preamble, no headings, no restating the question. If there's too little to say, say so briefly.`;

function buildGoalsPrompt({ eventName, goals }) {
  const fmt = (v) => (v == null ? '—' : (typeof v === 'number' ? v.toLocaleString('en-ZA') : String(v)));
  const lines = [`Event: ${eventName || '(untitled)'}`, `Goals: ${goals.length}`, ''];
  for (const g of goals) {
    const p = g.progress || {};
    const parts = [`- ${g.isNorthStar ? '★ ' : ''}${g.name}${g.unit ? ` (${g.unit})` : ''}`];
    parts.push(`  current ${fmt(p.value)} / target ${fmt(g.targetValue)}${p.pct != null ? ` (${p.pct}%)` : ''}`);
    if (g.direction === 'at_most') parts.push('  goal type: stay under the target');
    if (p.status) parts.push(`  pace: ${p.status}${p.expected != null ? `, expected ~${fmt(p.expected)} by now` : ''}`);
    if (p.daysLeft != null) parts.push(`  days to go: ${p.daysLeft}`);
    // vs last time — prefer the curve's "at this same point" (apples-to-apples), with
    // last time's final total; fall back to the plain stored baseline.
    if (p.lastAtNow != null) {
      const d = p.value != null && p.lastAtNow ? Math.round(((p.value - p.lastAtNow) / Math.abs(p.lastAtNow)) * 100) : null;
      parts.push(`  vs last time at this point: ${fmt(p.lastAtNow)}${d != null ? ` (${d > 0 ? '+' : ''}${d}%)` : ''}`);
      if (p.baselineFinal != null) parts.push(`  last time total: ${fmt(p.baselineFinal)}`);
    } else if (g.baselineValue != null) {
      parts.push(`  last time: ${fmt(g.baselineValue)}`);
    }
    // Forecast — projected final landing if it finishes like last time's shape.
    if (p.forecast && p.forecast.projected != null) {
      const f = p.forecast;
      const tail = f.status === 'will_hit' ? 'on track to hit target'
        : `${f.vsTargetPct != null ? `${f.vsTargetPct}% of target` : ''}${g.targetValue ? `, ~${fmt(Math.abs(g.targetValue - f.projected))} short` : ''}`;
      parts.push(`  forecast: projected ~${fmt(f.projected)}${tail ? ` (${tail})` : ''}`);
    }
    if (p.nextMilestone) parts.push(`  next checkpoint: ${fmt(p.nextMilestone.targetValue)} by ${p.nextMilestone.byDate}`);
    if (g.byDate) parts.push(`  deadline: ${g.byDate}`);
    lines.push(parts.join('\n'));
  }
  return lines.join('\n');
}

// Streaming Owl summary of an event's goals. ctx = { eventName, goals, instructions, apiKey }.
async function streamGoalsBrief(ctx, onText) {
  const c = requireClient(ctx.apiKey);
  const stream = c.messages.stream({
    model: MODEL,
    max_tokens: 1200,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: systemWith(GOALS_SYSTEM, ctx.instructions),
    messages: [{ role: 'user', content: buildGoalsPrompt(ctx) }],
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

const OPPORTUNITY_SYSTEM = `You are a friendly marketing & insights manager for an events organiser using Howler Pulse (customers buy tickets; amounts are in South African Rand, ZAR).
Write ONE short, punchy sentence (max ~22 words) nudging them to act on an outstanding Pulse setup item. When a live number from their own data is given, lead with it to make the opportunity concrete and compelling — the value they're leaving on the table, never the chore. Warm and specific, not salesy. No greeting, no emoji, no markdown — just the single line.`;

// A one-line, value-led nudge about an outstanding setup item, grounded in a live
// metric from the client's data when one is supplied. Best-effort — callers fall
// back to plain copy if AI isn't configured or this throws.
async function opportunityLine({ clientName, item, metric, apiKey, instructions }) {
  const c = requireClient(apiKey);
  const prompt = [clientName ? `Client: ${clientName}` : null, `Outstanding setup item: ${item}`, metric ? `Live number from their data: ${metric}` : null].filter(Boolean).join('\n');
  const resp = await c.messages.create({
    model: MODEL, max_tokens: 120, thinking: { type: 'adaptive' }, output_config: { effort: 'low' },
    system: systemWith(OPPORTUNITY_SYSTEM, instructions),
    messages: [{ role: 'user', content: prompt }],
  });
  return (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

const NUDGE_COPY_SYSTEM = `You are a friendly marketing & insights manager at Howler writing a short nudge email to a client who hasn't finished setting up Pulse (their events/insights platform; customers buy tickets in South African Rand, ZAR).
You are given the client's name, the list of setup items they still haven't done, and optionally a live data opportunity. Write a PERSONALISED subject line and a one-sentence opening that speak to THOSE SPECIFIC outstanding items and the value of finishing them — so the email feels tailored, not generic, and reads differently as their outstanding list changes.
Lead with value, never the chore. If a live opportunity is given, you may nod to it. Warm, specific, concise — not salesy.
Return ONLY a JSON object: {"subject": "...", "intro": "..."}. Subject ≤ 9 words, no emoji. Intro ONE sentence (≤ 28 words), may use a single friendly emoji. No markdown, no extra keys, no text outside the JSON.`;

// A personalised subject + opening line tailored to a client's current outstanding
// setup items, so repeat nudges read differently as the list changes. Returns
// { subject, intro } or null. Best-effort — callers fall back to static copy.
async function nudgeCopy({ clientName, outstanding = [], metric, apiKey, instructions }) {
  const c = requireClient(apiKey);
  const prompt = [clientName ? `Client: ${clientName}` : null, `Outstanding setup items:\n${outstanding.map((x) => `- ${x}`).join('\n')}`, metric ? `Live data opportunity: ${metric}` : null].filter(Boolean).join('\n');
  const resp = await c.messages.create({ model: MODEL, max_tokens: 220, thinking: { type: 'adaptive' }, output_config: { effort: 'low' }, system: systemWith(NUDGE_COPY_SYSTEM, instructions), messages: [{ role: 'user', content: prompt }] });
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  try {
    const obj = JSON.parse((text.match(/\{[\s\S]*\}/) || [text])[0]);
    const subject = String(obj.subject || '').trim(); const intro = String(obj.intro || '').trim();
    return subject && intro ? { subject, intro } : null;
  } catch { return null; }
}

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
  const out = await parseModelJsonResilient(c, text, 'tile description');
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
- GOALS (when present): the event's targets with progress ALREADY COMPUTED (current vs target & %, pace ahead/on-track/behind, vs last time at this same point, projected final landing, checkpoints hit/missed, days to go). When GOALS are present, anchor the briefing on the NORTH STAR (★) goal — its attainment, whether it's on pace, the vs-last-time move and the projected finish — and weave the others in as supporting context. Celebrate any wins (goals REACHED/SMASHED or checkpoints hit) and flag a MISSED checkpoint worth attention. Phrase the numbers; never recompute or invent goals.

Respond with ONLY strict JSON (no markdown fences):
{
  "headline": "1-2 sentences. The single most important story right now. May use **bold** for key numbers.",
  "bullets": [ { "text": "specific, quantitative observation (may use **bold**)", "dashboardId": "id from CATALOGUE or null", "threadId": "ONLY when the bullet is about a MESSAGES item: its [id:…] value, else omit" } ],
  "suggestions": [ { "title": "short hook (max 8 words)", "reason": "one line on why it's worth a look now", "dashboardId": "id from CATALOGUE", "action": "a CAPABILITIES key ONLY if directly executable, else omit" } ]
}

Rules:
- ALWAYS LEAD with the headline TICKETING numbers as the most important story — tickets sold, gross revenue and orders for the current event are the authoritative sales figures and must anchor the briefing, regardless of which dashboards the reader visits most. Then layer in supporting context (audience, traffic, channels, comparisons). Do NOT lead with a single sales CHANNEL (e.g. reps/agents/promoters), a sub-segment, or an overnight DELTA — those are supporting context, never the headline. The lead is the event's cumulative total tickets sold and gross revenue, even if they barely moved overnight. Cashless/top-ups are also supporting context, not the ticketing lead.
- Each tile shows its source as "— <set> → <dashboard>". Metrics from a web-analytics source (e.g. GA4, Google Analytics — sessions, page views, "conversions", site events) measure TRAFFIC and on-site behaviour, NOT finalised ticket sales: never report a GA4/analytics "tickets" or "conversions" figure as actual tickets sold — treat GA4 as funnel/interest only. Tickets sold, revenue and attendance/check-ins are authoritative ONLY from the ticketing/event dashboards.
- Each tile shows the EVENT its value is for ("· event: …"). A tile with the SAME title but an earlier-dated event is the same-event LAST-TIME comparison — frame it as the year-ago comparison (e.g. "3,297 vs 2,540 last time"), never as a conflicting current figure to reconcile.
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
- GOALS (when present): the event's targets, progress ALREADY COMPUTED (current vs target, pace, vs last time at this point, projected final landing, checkpoints hit/missed). Devote EXACTLY ONE narrative paragraph to goals — never more than one, even with many goals. In that single paragraph lead with the North Star (★) and whether it's on track, then the notable mover vs last time and the projected finish; CELEBRATE wins (goals REACHED/SMASHED or checkpoints hit) and flag the one MISSED checkpoint worth attention. Roll the rest of the goals into that same paragraph (e.g. "3 others on track") rather than spawning more bullets. EVERY OTHER narrative paragraph MUST be about the live TILE data (trends, concentrations, movers) — not goals. Phrase the numbers; never recompute or invent goals.

Respond with ONLY strict JSON (no markdown fences):
{
  "subject": "email subject line — specific and quantitative, <70 chars",
  "headline": "1 tight sentence: the single most important story for THIS role right now (may use **bold**)",
  "narrative": [ "2-4 TIGHT points for this role. Start EACH point with a SHORT bold heading (2-4 words) + a colon, then the point — e.g. '**Daily sales:** 312 sold yesterday, +18% on last week'. Keep each point to ONE sentence (two only if essential) — lean, ~20% shorter than a normal paragraph; specific, quantitative, plain-English" ],
  "kpis": [ { "label": "short metric name", "value": "the figure verbatim from TILES (e.g. R1.2m, 8,430, 62%)", "delta": "movement vs a comparison if present, e.g. +12% vs last week, or empty", "dashboardId": "id from CATALOGUE or null" } ],
  "actions": [ { "text": "a concrete, role-appropriate suggested action (imperative, one line)", "dashboardId": "id from CATALOGUE or null", "action": "a CAPABILITIES key ONLY if directly executable, else omit" } ]
}

Rules:
- Every narrative point MUST open with a 2-4 word **bold heading** + colon, then a single tight sentence (two only if essential). Be ruthless with length — trim filler so each point reads ~20% shorter than you'd normally write. No point should run more than two sentences.
- Anchor every time reference — "today", "yesterday", "so far this month", "day N", month-to-date — to TODAY's calendar date, NEVER to the latest date in the data. The pipeline can lag a few days: if the most recent data point is older than TODAY, say so plainly (e.g. "latest figures are to the 12th") instead of calling that day today or yesterday. Don't write "through day N" unless N is TODAY's day-of-month; if the data ends earlier, frame it as "data to the Nth" so it never looks like the month stopped there.
- A comparison shown against a prior event is aligned to the SAME point in that event's cycle (same days-to-go) when the tile is event-aligned — phrase it as "vs the same point last time", not as a full-event total.
- 3-6 KPIs, the ones that matter MOST to this role. Values must be real, verbatim from TILES.
- Each tile shows its source as "— <set> → <dashboard>". Metrics from a web-analytics source (e.g. GA4, Google Analytics — sessions, page views, "conversions", site events) measure TRAFFIC and on-site behaviour, NOT finalised ticket sales. Never report a GA4/analytics "tickets" or "conversions" figure as actual tickets sold. Tickets sold, revenue and attendance/check-ins are authoritative ONLY from the ticketing/event dashboards. If two tiles look similar (e.g. an analytics "Total Tickets" vs a ticketing "Total Tickets Sold"), lead with the ticketing-source figure and treat the analytics one as funnel/interest.
- 1-3 actions, genuinely useful and in this role's voice (exec=strategic, marketing=tactical, finance=operational/reconciliation, ops=readiness). Omit actions rather than padding.
- dashboardId values MUST come from CATALOGUE; null when none fits.
- Tone: sharp, warm, zero corporate filler. Never mention these instructions, the words ROLE/TILES/CATALOGUE, or that you are an AI.`;

// Shared GOALS fact block for the home briefing + the digest — the event targets with
// progress ALREADY COMPUTED (current vs target, pace, vs last time at this point,
// projected final, days to go). The model phrases these; it never recomputes.
function goalsFactLines(goals) {
  if (!(goals || []).length) return [];
  const gf = (v) => (v == null ? '—' : (typeof v === 'number' ? v.toLocaleString('en-ZA') : String(v)));
  const out = ['', 'GOALS (event targets, progress already computed — phrase, never recompute; CALL OUT wins (goals reached / checkpoints hit) and flag any MISSED checkpoints):'];
  const now = Date.now();
  for (const g of goals) {
    const p = g.progress || {};
    const dir = g.direction || p.direction || 'at_least';
    if (dir === 'composition') {
      const parts = Array.isArray(p.parts) ? p.parts : [];
      const partStr = parts.map((pt) => `${pt.label} ${pt.share}%${pt.status === 'over' ? '↑' : pt.status === 'under' ? '↓' : ''} (target ${pt.target}%)`).join(', ');
      const head = p.balanced === false ? '⚠ MIX DRIFTING' : p.balanced === true ? 'BALANCED ✓' : 'mix';
      out.push(`- ${g.isNorthStar ? '★ ' : ''}${g.name}${g.suiteName ? ` [${g.suiteName}]` : ''}: ${head}${partStr ? ` — ${partStr}` : ''}`);
      continue;
    }
    const meets = (val, tgt) => val != null && tgt != null && (dir === 'at_most' ? val <= Number(tgt) : val >= Number(tgt));
    const reached = dir === 'range' ? !!p.inRange : (p.pct != null ? (dir === 'at_most' ? meets(p.value, g.targetValue) : p.pct >= 100) : meets(p.value, g.targetValue));
    const aboveRange = dir === 'range' && p.over;
    const win = aboveRange ? null : (p.band === 'smashed' ? 'SMASHED ✓✓' : (reached || p.band === 'hit') ? (dir === 'range' ? 'IN RANGE ✓' : 'REACHED ✓') : null);
    const tgtLabel = dir === 'range' && g.targetMax != null ? `${gf(g.targetValue)}–${gf(g.targetMax)}` : gf(g.targetValue);
    const bits = [`- ${g.isNorthStar ? '★ ' : ''}${g.name}${g.suiteName ? ` [${g.suiteName}]` : ''}: ${gf(p.value)}/${tgtLabel}${p.pct != null ? ` (${p.pct}%)` : ''}${g.unit ? ` ${g.unit}` : ''}${win ? ` — ${win}` : ''}${aboveRange ? ' — ⚠ ABOVE RANGE' : ''}`];
    if (!win && p.status) bits.push(`pace ${p.status}${p.expected != null ? ` (expected ~${gf(p.expected)} by now)` : ''}`);
    if (p.lastAtNow != null) { const d = p.value != null && p.lastAtNow ? Math.round(((p.value - p.lastAtNow) / Math.abs(p.lastAtNow)) * 100) : null; bits.push(`vs last time ${gf(p.lastAtNow)}${d != null ? ` (${d > 0 ? '+' : ''}${d}%)` : ''}`); }
    if (!win && p.forecast && p.forecast.projected != null) bits.push(`forecast ~${gf(p.forecast.projected)}${p.forecast.status === 'will_hit' ? ' (on track)' : p.forecast.vsTargetPct != null ? ` (${p.forecast.vsTargetPct}% of target)` : ''}`);
    // Checkpoints (milestones): how many due ones we've hit, and the most recent miss.
    const due = (Array.isArray(p.milestones) ? p.milestones : []).filter((m) => { const t = Date.parse(m.byDate); return !Number.isNaN(t) && t <= now; });
    if (due.length) {
      const hit = due.filter((m) => meets(p.value, m.targetValue)).length;
      bits.push(`checkpoints ${hit}/${due.length} hit`);
      const missed = [...due].reverse().find((m) => !meets(p.value, m.targetValue));
      if (missed) bits.push(`MISSED checkpoint ${gf(Number(missed.targetValue))} by ${missed.byDate}`);
    }
    if (p.nextMilestone) bits.push(`next checkpoint ${gf(p.nextMilestone.targetValue)} by ${p.nextMilestone.byDate}`);
    if (p.daysLeft != null) bits.push(`${p.daysLeft}d to go`);
    out.push(bits.join(' · '));
  }
  return out;
}

async function digestBrief({ tiles, roleLabel, roleFocus, catalogue, instructions, apiKey, actions, capabilities, goals, today }) {
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
  if ((goals || []).length) {
    // GOALS: the event targets, with progress ALREADY COMPUTED. Facts — phrase, never recompute.
    lines.push(...goalsFactLines(goals));
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

// ─── Multi-event digest — the PORTFOLIO OVERVIEW ───────────────────────────────
// Used when a digest covers MORE THAN ONE event/suite. This writes ONLY the short
// cross-event overview that leads the email; each event's own section is written
// separately by the single-event digest call (scoped to that event), so every
// model response stays small and reliable.
const DIGEST_MULTI_SYSTEM = `You are the Owl — Howler Pulse's analyst — writing the SHORT cross-event OVERVIEW that opens a scheduled email digest for ONE named role at a promoter running SEVERAL events at once. Amounts are South African Rand (ZAR). Each event gets its OWN detailed section after this overview (written separately) — so here you write the portfolio-level picture only, not a per-event breakdown.

You are given:
- TODAY: the date this digest is sent. This — not the data — is the current date; anchor every "today/yesterday/this month/day N" to it. The pipeline can lag a few days: if the latest data point is older than TODAY, say "data to the Nth" rather than calling it today.
- ROLE: the reader's role and what they care about. Write EVERYTHING through this lens.
- TILES: live data behind their dashboards' tiles, GROUPED BY EVENT (each event has a CATALOGUE of dashboard ids for deep links). These are the ONLY numbers you may use — never invent or extrapolate.
- ACTIONS (when present): marketing actions already taken, with live results — weave notable performance in for this role.
- CAPABILITIES (when present): actions the platform can EXECUTE now. A suggested action may carry "action":"<key>" ONLY when that capability directly delivers it; otherwise omit. Never invent keys.
- GOALS (when present): event targets with progress ALREADY COMPUTED — phrase, never recompute. Fold goals into the narrative as ONE short paragraph (North Star first).

Respond with ONLY strict JSON (no markdown fences):
{
  "subject": "email subject — specific and quantitative across the portfolio, <70 chars",
  "headline": "1 tight sentence: the single most important cross-event story for THIS role, led by daily-sales pace (may use **bold**)",
  "narrative": [ "1-3 TIGHT cross-event points. Start EACH with a SHORT bold heading (2-4 words) + colon. The FIRST point MUST be '**Daily sales:** …' — the recent daily-sales pace across the events vs the comparison. Then the standout/biggest mover and anything needing attention; name events explicitly. One sentence each (two only if essential), ~20% leaner than usual. Include ONE '**Goals:** …' point if GOALS given." ],
  "kpis": [ { "label": "short metric (prefix the event if useful)", "value": "figure verbatim from TILES", "delta": "movement vs a comparison or empty", "dashboardId": "id from any CATALOGUE or null" } ],
  "actions": [ { "text": "a concrete, role-appropriate cross-event next step (imperative, one line)", "dashboardId": "id from CATALOGUE or null", "suiteId": "the EVENT id this action targets — copy it VERBATIM from that event's [id:…] heading", "action": "a CAPABILITIES key ONLY if directly executable, else omit" } ]
}

Rules:
- Each action with an "action" key targets ONE event — set "suiteId" to that event's id, read from its "## EVENT: … [id:…]" heading and copied exactly. REQUIRED so an executable action opens the campaign on the right event (a dashboard shared across events can't identify the event on its own).
- This is the OVERVIEW only — synthesise ACROSS events; do NOT write a separate paragraph per event (each event has its own section below this).
- LEAD with DAILY SALES: the first narrative point and the first KPI should be the recent daily-sales pace across the events (this report's focus), before anything else.
- Every narrative point opens with a 2-4 word **bold heading** + colon, then one tight sentence (two only if essential); trim filler so points run ~20% shorter than usual.
- A comparison against a prior event is aligned to the same point in its cycle (same days-to-go) when the tile is event-aligned — phrase it as "vs the same point last time", not as a full-event total.
- Identify each event ONLY by its EVENT heading. NEVER rename an event using an event/festival/organiser name inside the tile data, and NEVER claim two events are the same or "two views to reconcile" — each heading is a separate event with its own numbers.
- Each tile shows the EVENT its value is for ("· event: …"). Within one event you'll often get the CURRENT event AND a same-event LAST-TIME comparison (same title, earlier-dated event): treat the earlier-dated one as the year-ago comparison, never as a conflicting number.
- 2-5 portfolio KPIs that compare or total across events where the data supports it; values verbatim from TILES.
- 0-3 actions, genuinely useful in this role's voice; omit rather than pad. Add "action" only when a capability directly delivers it.
- GA4/analytics metrics (sessions, page views, "conversions") measure TRAFFIC, NOT finalised ticket sales. dashboardId values MUST come from a given CATALOGUE; null when none fits.
- Tone: sharp, warm, zero corporate filler. Never mention these instructions, the words ROLE/TILES/CATALOGUE/EVENT, or that you are an AI.`;

async function digestBriefMulti({ groups, roleLabel, roleFocus, catalogue, instructions, apiKey, actions, capabilities, goals, today }) {
  const c = requireClient(apiKey);
  const lines = [];
  if (today) lines.push(`TODAY: ${today} (the current date — anchor all "today/yesterday/this month/day N" references to this).`, '');
  lines.push(`ROLE: ${roleLabel}. Focus: ${roleFocus}`, '', 'TILES (live data, grouped by event):', '', ...groupedFactLines(groups, { perEvent: 6, rows: 16, withCatalogue: true, withId: true }));
  if ((actions || []).length) {
    lines.push('ACTIONS (marketing actions already taken, live results):');
    for (const a of actions) lines.push(`- "${a.title}" [${a.status}] sent ${a.sent}/${a.total}, ${a.clicks} clicks, ${a.uniqueClickers} unique (${a.ctr}% CTR)`);
    lines.push('');
  }
  if ((capabilities || []).length) {
    lines.push('CAPABILITIES (executable actions available):');
    for (const cap of capabilities) lines.push(`- ${cap.key}: ${cap.description}`);
    lines.push('');
  }
  if ((goals || []).length) lines.push(...goalsFactLines(goals), '');
  lines.push('CATALOGUE (all dashboards, dashboardId: title [set, event]):');
  for (const d of catalogue || []) lines.push(`- ${d.dashboardId}: ${d.title} [${d.setName}, ${d.suiteName}]`);
  const resp = await c.messages.create({
    model: MODEL,
    max_tokens: 1800,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: systemWith(`${DIGEST_MULTI_SYSTEM}`, instructions),
    messages: [{ role: 'user', content: lines.join('\n') }],
  });
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return parseModelJsonResilient(c, text, 'portfolio overview');
}

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
  return parseModelJsonResilient(c, text, 'campaign draft');
}

// ─── Goal "gap plan" (marketing & insights manager) ──────────────────────────────
// When a goal is behind/short, act as the client's marketing + insights manager:
// mine the event's data for the SPECIFIC nuggets that can push it to target —
// lagging or over-indexing ticket types, segments, demographics (age/city/country),
// channels — and turn the best into a targeted campaign brief. Numbers are FACTS from
// the tiles; never invent. Returns strict JSON the UI renders + uses to pre-fill a campaign.
const GOAL_GAP_SYSTEM = `You are the marketing & insights manager for an events organiser on Howler (tickets; amounts in South African Rand, ZAR). A specific GOAL is behind pace or forecast to fall short. Your job: find the concrete nuggets in THIS event's data that can close the gap, and turn them into a targeted campaign — not a generic "abandoned cart" blast.

You are given:
- TODAY and the GOAL (name, current vs target, the gap, days to go, pace, vs last time at this point, projected finish).
- TILES: live data for this event — ticket-type / price-tier splits, demographics (age, city, country, gender), sales channels (online, reps, cashless/top-ups), trends and last-year comparisons. These are the ONLY numbers you may use; never invent or extrapolate.
- SEGMENTS (when present): saved, ready-to-use audiences (name + size).
- CATALOGUE: dashboards you may deep-link a nugget to.

Find the levers. Look for: a ticket type lagging vs last year or selling out; a city/region or age band over-indexing (lean in) or collapsing (win back); a high-converting segment to double down on; a channel that over/under-performs; price/tier headroom. Each nugget must cite a real number and say what to DO about it.

Respond with ONLY strict JSON (no markdown fences):
{
  "summary": "1 sentence: where the gap is and the single biggest opportunity to close it",
  "nuggets": [ { "headline": "the opportunity in <=10 words", "detail": "1-2 sentences with the real number(s) and the action", "dashboardId": "id from CATALOGUE or null" } ],
  "audience": "who to target, described concretely (e.g. 'past buyers in Cape Town aged 18-24')",
  "segmentName": "the EXACT name of a SEGMENTS entry that best fits, or empty string if none",
  "angle": "the campaign angle / offer / hook in one line",
  "campaignGoal": "a ready 1-2 sentence campaign goal to hand to the copywriter — who to target, what to say, what action to drive, anchored to closing this goal's gap"
}
Rules: 2-4 nuggets, the highest-leverage ones. Every figure verbatim from TILES. Prefer a named SEGMENT for the audience when one fits. Be specific and commercial; no fluff, no preamble.`;
async function goalGapPlan({ goal, progress, tiles, segments, clientName, catalogue, instructions, today, apiKey }) {
  const c = requireClient(apiKey);
  const p = progress || {};
  const gf = (v) => (v == null ? '—' : (typeof v === 'number' ? v.toLocaleString('en-ZA') : String(v)));
  const gap = goal.targetValue != null && p.value != null ? goal.targetValue - p.value : null;
  const lines = [];
  if (today) lines.push(`TODAY: ${today}`, '');
  lines.push(`CLIENT: ${clientName || 'an event organiser'}`);
  const goalBits = [`GOAL: ${goal.isNorthStar ? '★ ' : ''}${goal.name}${goal.unit ? ` (${goal.unit})` : ''} — ${gf(p.value)} of ${gf(goal.targetValue)}${p.pct != null ? ` (${p.pct}%)` : ''}${gap != null ? `, ${gf(gap)} to go` : ''}`];
  if (p.status) goalBits.push(`pace ${p.status}${p.expected != null ? ` (expected ~${gf(p.expected)} by now)` : ''}`);
  if (p.lastAtNow != null) goalBits.push(`last time at this point ${gf(p.lastAtNow)}`);
  if (p.forecast && p.forecast.projected != null) goalBits.push(`forecast ~${gf(p.forecast.projected)}${p.forecast.vsTargetPct != null ? ` (${p.forecast.vsTargetPct}% of target)` : ''}`);
  if (p.daysLeft != null) goalBits.push(`${p.daysLeft} days to go`);
  lines.push(goalBits.join(' · '), '');
  lines.push('TILES (live data — the ONLY numbers you may use):', '');
  for (const t of tiles || []) {
    lines.push(`### ${t.title}${t.visType ? ` (${t.visType})` : ''} — ${t.setName} → ${t.dashTitle}`);
    if (t.context && t.context.trim()) lines.push(`(context: ${t.context.trim()})`);
    lines.push(compactTable(t.fields, t.rows, 40));
    lines.push('');
  }
  if ((segments || []).length) {
    lines.push('SEGMENTS (ready audiences — name · size):');
    for (const s of segments) lines.push(`- ${s.name}${s.count != null && s.count >= 0 ? ` · ${s.count}` : ''}`);
    lines.push('');
  }
  if ((catalogue || []).length) { lines.push('CATALOGUE:'); for (const d of catalogue) lines.push(`- ${d.dashboardId}: ${d.title} [${d.setName}, ${d.suiteName}]`); }
  const resp = await c.messages.create({
    model: MODEL,
    max_tokens: 1500,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: systemWith(GOAL_GAP_SYSTEM, instructions),
    messages: [{ role: 'user', content: lines.join('\n') }],
  });
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return parseModelJsonResilient(c, text, 'goal-gap');
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

// Summarise raw git commits into clean DAILY release notes, in three lenses:
// a non-technical end-user `summary`, an end-user `howTo`, and a technical `dev`
// view (internal only). `summary` + `howTo` reach clients (What's New + weekly
// email); `dev` never leaves the internal surface. See docs/specs/RELEASE_NOTES_SPEC.md.
const RELEASE_NOTES_SYSTEM = `You turn a software team's raw git commit messages into clean DAILY release notes for Howler Pulse (an events analytics + comms platform used by event organisers). You are given commits grouped by calendar day, and may be given a FEATURE MAP (feature → in-app screen/path) to ground links.

Respond with ONLY strict JSON (no markdown fences) of the form:
{ "days": [ {
  "date": "YYYY-MM-DD",
  "title": "short headline for the day, <8 words",
  "summary": "markdown bullet list of what shipped, benefit-led, for a non-technical reader",
  "howTo": "markdown: 1-3 short end-user steps to use the day's main change, or empty string if nothing is user-actionable",
  "deepLink": "in-app path to the headline feature (e.g. /settings/branding), or empty string if unknown",
  "dev": "markdown bullets for the dev team: what changed technically, notable commits, any breaking/migration notes"
} ] }

Rules:
- One object per day that has meaningful, user-noticeable changes. Use the exact date string given.
- Group related commits; merge duplicates. Each summary bullet starts with a verb (Added / Improved / Fixed / Faster …).
- summary + howTo are written for a NON-TECHNICAL end user: describe the BENEFIT and the steps, not the code. Translate jargon (e.g. "fix 422 on dashboard_elements" → "Fixed an error when recreating some dashboards").
- howTo names the actual screen and gives concrete steps. If a commit carries a "how-to:" line, use it (lightly cleaned up). Set howTo to "" when the change isn't something a user does (e.g. a backend-only fix).
- deepLink: only set it when you are confident of the path from the FEATURE MAP or a commit "link:" line; otherwise "".
- dev keeps the technical detail (jargon, commit refs, migration/flag notes) and is honest — never invent.
- DROP pure noise from summary/howTo: merge commits, version bumps, formatting/lint, CI, refactors with no visible effect, WIP. If a day has only noise, omit that day entirely (dev may still note a significant refactor on a day that survives for other reasons).
- Never invent features or claims not supported by the commits. No emojis. Keep each lens tight (~6 bullets max).`;
async function summariseReleaseNotes({ days, apiKey, instructions, featureMap }) {
  const c = requireClient(apiKey);
  const payload = (days || [])
    .map((d) => `## ${d.date}\n${(d.commits || []).map((m) => `- ${m}`).join('\n')}`)
    .join('\n\n');
  const map = (featureMap || '').trim();
  const user = (map ? `FEATURE MAP (feature → in-app path, for grounding howTo/deepLink):\n${map}\n\n` : '') + `COMMITS BY DAY:\n\n${payload}`;
  const resp = await c.messages.create({
    model: MODEL,
    max_tokens: 2400,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: systemWith(RELEASE_NOTES_SYSTEM, instructions),
    messages: [{ role: 'user', content: user }],
  });
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = await parseModelJsonResilient(c, text, 'release notes');
  return Array.isArray(parsed?.days) ? parsed.days : [];
}

async function briefHome({ tiles, profile, catalogue, instructions, apiKey, actions, messages, capabilities, goals, today }) {
  const c = requireClient(apiKey);
  const lines = [];
  if (today) lines.push(`TODAY: ${today} (the current date — anchor all "today/yesterday/this month/day N" references to this).`, '');
  lines.push('TILES (live data):', '');
  for (const t of tiles || []) {
    const ev = eventOf(t.filters);
    lines.push(`### ${t.title}${t.pinned ? ' [FOLLOWED]' : ''}${t.visType ? ` (${t.visType})` : ''} — ${t.setName} → ${t.dashTitle}${ev ? ` · event: ${ev}` : ''}`);
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
  if ((goals || []).length) lines.push(...goalsFactLines(goals));
  lines.push('');
  lines.push('CATALOGUE:');
  for (const d of catalogue || []) lines.push(`- ${d.dashboardId}: ${d.title} [${d.setName}, ${d.suiteName}]`);
  const resp = await c.messages.create({
    model: BRIEF_MODEL,
    max_tokens: 1400,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: cachedSystem(HOME_SYSTEM, instructions),
    messages: [{ role: 'user', content: lines.join('\n') }],
  });
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return parseModelJsonResilient(c, text, 'briefing');
}

// ─── Multi-event home briefing (portfolio + per-event) ──────────────────────────
// For a client running several events at once: an OVERALL portfolio summary, then
// a short brief PER event. Two passes so the overall can stream in first while the
// per-event sections load. Facts arrive grouped by event: [{ suiteId, suiteName, tiles }].
const HOME_OVERALL_SYSTEM = `You are the Owl — Howler Pulse's analyst — writing a PORTFOLIO summary for a promoter running MULTIPLE events at once. Amounts are South African Rand (ZAR).
You are given live TILES grouped by EVENT. Write a short cross-event picture: the overall position across all events, the standout/biggest mover, and anything needing attention — comparing events where the data supports it.
You may also be given CATALOGUE (dashboards you can link to), CAPABILITIES (actions the platform can EXECUTE now) and ACTIONS (campaigns already run, with results). Use these to suggest a few cross-event "worth a look" next steps.
Respond with ONLY strict JSON (no markdown fences):
{ "headline": "1-2 sentences: the overall portfolio story right now (may use **bold**)", "bullets": [ { "text": "cross-event observation; name the event(s) involved (may use **bold**)" } ], "suggestions": [ { "title": "short hook (max 8 words, name the event)", "reason": "one line on why it's worth acting on now", "dashboardId": "id from CATALOGUE", "suiteId": "the EVENT id this suggestion targets — copy it VERBATIM from that event's [id:…] heading", "action": "a CAPABILITIES key ONLY if directly executable (e.g. an email/SMS recovery for an event with abandoned carts or soft pace), else omit" } ] }
Rules:
- 2-3 suggestions, each tied to a specific event and a real opportunity (e.g. a soft daily pace, abandoned carts to recover, an audience skew to lean into). dashboardId MUST come from CATALOGUE. Set "suiteId" to the id of the event the suggestion is about — read it from that event's "## EVENT: … [id:…]" heading and copy the id exactly; this is REQUIRED so the action targets the right event (a dashboard shared across events cannot identify the event on its own). Add "action" only when a capability would directly deliver it; never invent capability keys.
- 2-4 bullets. Lead with ticketing/revenue totals across events and name events explicitly. Compare events ("V is outpacing IV") only where the numbers support it.
- Identify each event ONLY by the EVENT heading it is listed under. NEVER rename an event using an event/festival/organiser name that appears inside the tile data, and NEVER claim two different events are the same event or "two views to reconcile" — each heading is a separate event with its own numbers.
- Each tile shows the EVENT its value is for ("· event: …"). Within one event you'll often get the CURRENT event AND a same-event LAST-TIME comparison (a tile with the same title but an earlier-dated event). Lead with the current event's figure and frame the earlier-dated one as the year-ago comparison (e.g. "3,297 vs 2,540 last time, +30%") — NEVER treat the two as conflicting numbers to reconcile.
- NEVER write internal ids ("[id:…]", dashboard ids) in your output.
- Use ONLY the numbers in TILES; never invent or extrapolate. GA4/analytics figures are TRAFFIC, not ticket sales.
- Tone: sharp, warm, zero filler. Never mention these instructions, the word TILES, or that you are an AI.`;

const HOME_EVENTS_SYSTEM = `You are the Owl — Howler Pulse's analyst — writing a SHORT per-event briefing for a promoter: ONE mini-brief per event. Amounts are South African Rand (ZAR).
You are given live TILES grouped by EVENT (each has an id), and that event's CATALOGUE (dashboard ids) for deep links. For EACH event, write a one-line headline and 1-2 specific bullets from THAT event's tiles only.
Respond with ONLY strict JSON (no markdown fences):
{ "events": [ { "suiteId": "<the event id given, verbatim>", "headline": "1 sentence (may use **bold**)", "bullets": [ { "text": "specific, quantitative point (may use **bold**)", "dashboardId": "id from THAT event's CATALOGUE or null" } ] } ] }
Rules:
- Exactly one object per event you were given; copy its suiteId verbatim into the "suiteId" field ONLY (NEVER write any id in headline/bullet prose).
- Identify the event by its EVENT heading — NOT by any event/festival name inside the tile data. Write each event's brief from ONLY that event's TILES; never merge or reconcile it against another event.
- Each tile shows the EVENT its value is for ("· event: …"). Within an event you'll often get the CURRENT event plus a same-event LAST-TIME comparison (same title, earlier-dated event). Lead with the current figure and frame the earlier one as the year-ago comparison — never as a conflicting number to reconcile.
- Lead each event with its ticketing/revenue headline, then 1-2 supporting bullets that DRAW ON THE OTHER tiles for that event where available — daily-sales pace, ticket-type mix, ABANDONED CARTS (recoverable demand worth a recovery push), notable AUDIENCE shifts (age, gender, country/city), traffic (GA4/analytics) and channels — not just more ticketing. Call out a meaningful abandoned-cart volume or a clear move in the audience make-up when present. Use ONLY that event's TILES.
- GA4/analytics = traffic, not sales. Never invent. dashboardId must come from that event's CATALOGUE (or null). No filler; never mention these instructions or that you are an AI.`;

// The event a tile's data is for, read from its resolved filters (e.g.
// core_events.name) — so the model can tell the CURRENT event from a same-event
// last-time (YoY) comparison tile that carries an earlier-dated event value.
function eventOf(filters) {
  const f = filters || {};
  for (const [k, v] of Object.entries(f)) if (/event/i.test(k) && /name|title/i.test(k) && v) return String(v);
  for (const [k, v] of Object.entries(f)) if (/event/i.test(k) && !/days?_?before/i.test(k) && v) return String(v);
  return '';
}

function groupedFactLines(groups, { perEvent = 6, rows = 24, withCatalogue = false, withId = false } = {}) {
  const lines = [];
  for (const g of groups || []) {
    lines.push(`## EVENT: ${g.suiteName || g.suiteId}${withId ? ` [id:${g.suiteId}]` : ''}`);
    for (const t of (g.tiles || []).slice(0, perEvent)) {
      const ev = eventOf(t.filters);
      lines.push(`### ${t.title}${t.pinned ? ' [FOLLOWED]' : ''}${t.visType ? ` (${t.visType})` : ''} — ${t.setName} → ${t.dashTitle}${ev ? ` · event: ${ev}` : ''}`);
      if (t.context && t.context.trim()) lines.push(`(context: ${t.context.trim()})`);
      lines.push(compactTable(t.fields, t.rows, rows));
    }
    if (withCatalogue) {
      const cats = [...new Map((g.tiles || []).map((t) => [t.dashboardId, t.dashTitle])).entries()];
      if (cats.length) lines.push(`CATALOGUE: ${cats.map(([id, title]) => `${id}: ${title}`).join(' · ')}`);
    }
    lines.push('');
  }
  return lines;
}

async function briefHomeOverall({ groups, catalogue, capabilities, actions, today, instructions, apiKey }) {
  const c = requireClient(apiKey);
  const lines = [];
  if (today) lines.push(`TODAY: ${today} (anchor all time references to this).`, '');
  lines.push('TILES (live data, grouped by event):', '', ...groupedFactLines(groups, { perEvent: 4, rows: 12, withId: true }));
  if ((actions || []).length) {
    lines.push('ACTIONS (marketing actions already taken, live results):');
    for (const a of actions) lines.push(`- "${a.title}" [${a.status}] sent ${a.sent}/${a.total}, ${a.clicks} clicks (${a.ctr}% CTR)`);
    lines.push('');
  }
  if ((capabilities || []).length) {
    lines.push('CAPABILITIES (executable actions available):');
    for (const cap of capabilities) lines.push(`- ${cap.key}: ${cap.description}`);
    lines.push('');
  }
  lines.push('CATALOGUE (dashboardId: title [set, event]):');
  for (const d of catalogue || []) lines.push(`- ${d.dashboardId}: ${d.title} [${d.setName}, ${d.suiteName}]`);
  const resp = await c.messages.create({
    model: BRIEF_MODEL, max_tokens: 1100, thinking: { type: 'adaptive' }, output_config: { effort: 'low' },
    system: cachedSystem(HOME_OVERALL_SYSTEM, instructions),
    messages: [{ role: 'user', content: lines.join('\n') }],
  });
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return parseModelJsonResilient(c, text, 'portfolio briefing');
}

async function briefHomeEvents({ groups, today, instructions, apiKey }) {
  const c = requireClient(apiKey);
  const lines = [];
  if (today) lines.push(`TODAY: ${today} (anchor all time references to this).`, '');
  lines.push('TILES (live data, grouped by event):', '', ...groupedFactLines(groups, { perEvent: 12, rows: 24, withCatalogue: true, withId: true }));
  const resp = await c.messages.create({
    model: BRIEF_MODEL, max_tokens: 1600, thinking: { type: 'adaptive' }, output_config: { effort: 'low' },
    system: cachedSystem(HOME_EVENTS_SYSTEM, instructions),
    messages: [{ role: 'user', content: lines.join('\n') }],
  });
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return parseModelJsonResilient(c, text, 'per-event briefing');
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
  return parseModelJsonResilient(c, text, 'settlement report');
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
  return parseModelJsonResilient(c, text, 'invoice');
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

// ─── Document classification (Owl email auto-ingest) ────────────────────────────
// A cheap one-word triage so the Owl knows which extractor to run on a PDF that
// arrived by email. Only called when the subject/filename heuristic is ambiguous.
const CLASSIFY_SYSTEM = `You classify a single Howler PDF. Reply with EXACTLY one lowercase word and nothing else:
- "settlement" — an event settlement / reconciliation report (turnover, Howler commissions, advances, value due to the client).
- "invoice" — a tax invoice (line items, VAT, a total amount due).
- "other" — anything else.
One word only. If unsure, answer "other".`;

async function classifyDocument({ pdfBase64, apiKey }) {
  const c = requireClient(apiKey);
  const resp = await c.messages.create({
    model: MODEL, max_tokens: 8, output_config: { effort: 'low' },
    system: CLASSIFY_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: 'Classify this document. One word: settlement, invoice, or other.' },
      ],
    }],
  });
  const t = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').toLowerCase();
  if (t.includes('settlement')) return 'settlement';
  if (t.includes('invoice')) return 'invoice';
  return 'other';
}

function promptRegistry() {
  return [
    { key: 'tile', label: 'Tile insight', scope: 'Per-tile "Explain this" insight', text: SYSTEM },
    { key: 'dashboard', label: 'Dashboard summary', scope: 'Whole-dashboard AI summary', text: DASHBOARD_SYSTEM },
    { key: 'library', label: 'Tile-library descriptions', scope: 'Auto-describing tiles in the library', text: LIBRARY_SYSTEM },
    { key: 'home', label: 'Home briefing', scope: 'Personalised home-page briefing', text: HOME_SYSTEM },
    { key: 'homeOverall', label: 'Home briefing — portfolio', scope: 'Multi-event home briefing: the overall cross-event summary', text: HOME_OVERALL_SYSTEM },
    { key: 'homeEvents', label: 'Home briefing — per event', scope: 'Multi-event home briefing: the per-event sections', text: HOME_EVENTS_SYSTEM },
    { key: 'digest', label: 'Scheduled digest', scope: 'Role-lensed digest emails', text: DIGEST_SYSTEM },
    { key: 'digestMulti', label: 'Scheduled digest — multi-event', scope: 'Role-lensed digest for promoters running several events: portfolio overview + a section per event', text: DIGEST_MULTI_SYSTEM },
    { key: 'campaign', label: 'Campaign copy', scope: 'Marketing email drafting', text: CAMPAIGN_SYSTEM },
    { key: 'designSvg', label: 'Email banner designer', scope: 'Author an SVG banner (→ PNG) for a campaign email from a brief + brand colours', text: require('./emailBanner').DESIGN_SVG_SYSTEM },
    { key: 'designEmail', label: 'Email layout designer', scope: 'The Owl designs a full themed block email (theme + content blocks) from a goal', text: require('./emailDesign').DESIGN_EMAIL_SYSTEM },
    { key: 'opportunity', label: 'Setup opportunity line', scope: 'One-line, value-led nudge about an outstanding setup item, grounded in a live metric', text: OPPORTUNITY_SYSTEM },
    { key: 'nudgeCopy', label: 'Setup nudge subject & opening', scope: 'Personalised subject line + one-sentence opening for a client setup-reminder email, tailored to their outstanding items', text: NUDGE_COPY_SYSTEM },
    { key: 'refine', label: 'Refine note', scope: 'The ✨ refine button', text: REFINE_SYSTEM },
    { key: 'releaseNotes', label: 'Release notes', scope: 'Daily release notes summarised from git commits', text: RELEASE_NOTES_SYSTEM },
    { key: 'settlement', label: 'Settlement extraction', scope: 'PDF settlement → JSON', text: SETTLEMENT_SYSTEM },
    { key: 'invoice', label: 'Invoice extraction', scope: 'PDF invoice → JSON', text: INVOICE_SYSTEM },
    { key: 'digest_prefs', label: 'Digest preferences', scope: 'Distilling digest/briefing feedback into a learned preferences note', text: DIGEST_PREFS_SYSTEM },
    { key: 'classify', label: 'Document classification', scope: 'Owl email ingest: settlement vs invoice vs other', text: CLASSIFY_SYSTEM },
    { key: 'goals', label: 'Goals summary', scope: 'Owl summary of an event\'s goals on the Goals page', text: GOALS_SYSTEM },
    { key: 'goalGap', label: 'Goal gap plan', scope: 'Marketing/insights plan to close a behind-pace goal (→ targeted campaign)', text: GOAL_GAP_SYSTEM },
    { key: 'owlChat', label: 'Owl chat (agentic)', scope: 'The conversational Owl: tool-using analyst that answers questions by calling askData (grounded, scoped)', text: require('./owlChat').OWL_CHAT_SYSTEM },
    { key: 'owlChatAnalyst', label: 'Owl chat — Analyst depth', scope: 'Extra brief layered on the Owl chat when the user picks Analyst (deep) mode — multi-cut analysis + recommendation', text: require('./owlChat').OWL_ANALYST_LAYER },
    { key: 'owlChatOperator', label: 'Owl chat — Operator mode', scope: 'Extra brief (on top of Analyst) when the user picks Operator mode — proactively proposes + drafts the single best next action', text: require('./owlChat').OWL_OPERATOR_LAYER },
    { key: 'ticketDraft', label: 'Ticket drafting', scope: 'Turns a raw internal bug/feature report into a structured engineering ticket (Admin → Tickets)', text: require('./tickets').TICKET_DRAFT_SYSTEM }, { key: 'fanOwl', label: 'Fan Owl (booking guide)', scope: 'The consumer-facing Owl embedded on promoters\' public event sites — the persona + grounding rules every fan conversation runs under', text: require('./fanOwl').FAN_OWL_SYSTEM }, { key: 'fanIngest', label: 'Fan Owl — website reader', scope: 'Crawls the promoter\'s site and drafts SUGGESTED knowledge entries + page mappings for human review (nothing auto-saves)', text: require('./fanOwl').FAN_INGEST_SYSTEM }, { key: 'fanPitch', label: 'Fan Owl — pitch writer', scope: 'Drafts the per-page salesy ribbon line from each page\'s approved info + items (human reviews; served with zero AI cost)', text: require('./fanOwl').FAN_PITCH_SYSTEM },
    { key: 'jsonRepair', label: 'JSON repair', scope: 'Last-resort model repair of malformed AI JSON before parsing', text: JSON_REPAIR_SYSTEM }, { key: 'driveDocText', label: 'Drive PDF transcription', scope: 'Google Drive ingest: transcribes a shared PDF into searchable text the Owl can quote (metered per client as drive_ingest)', text: require('./googleDrive').DOC_TEXT_SYSTEM }, { key: 'skillTicketing', label: 'Skill — Ticketing Manager', scope: 'The autonomous Ticketing Manager skill: scheduled, tool-grounded review of one event\'s sales, pace and tiers (advise-only; SKILLS_BRIEF P1)', text: require('./skills').TICKETING_SKILL_SYSTEM }, { key: 'skillTicketingPlaybook', label: 'Skill — Ticketing Manager playbook (default)', scope: 'The platform-default playbook layered onto the Ticketing Manager skill; per-client additions layer on top (edited via the admin skills API)', text: require('./skills').TICKETING_DEFAULT_PLAYBOOK }, { key: 'dataHealthDiag', label: 'Data health — station diagnose', scope: 'The 🩺 Diagnose button on a Data health monitor: live station picture → plain-language verdict + ranked concerns', text: require('./dataHealth').DATA_HEALTH_DIAG_SYSTEM }, { key: 'dataHealthReport', label: 'Data health — event report', scope: 'The event-level Data health & diagnostics report (ops use + network-provider shareable)', text: require('./dataHealth').DATA_HEALTH_REPORT_SYSTEM }, { key: 'skillOps', label: 'Skill — Chief of Operations', scope: 'The autonomous Chief of Operations skill: event-day operational debrief (gates/entry, bars/cashless, devices) from the connected sources (advise-only)', text: require('./skills').OPS_SKILL_SYSTEM }, { key: 'skillOpsPlaybook', label: 'Skill — Chief of Operations playbook (default)', scope: 'The platform-default playbook layered onto the Chief of Operations skill; per-client additions layer on top', text: require('./skills').OPS_DEFAULT_PLAYBOOK },
  ];
}

module.exports = { generateInsight, streamInsight, streamDashboardInsight, streamGoalsBrief, describeTile, opportunityLine, nudgeCopy, extractSettlement, extractInvoice, classifyDocument, briefHome, briefHomeOverall, briefHomeEvents, digestBrief, digestBriefMulti, draftCampaign, goalGapPlan, refineText, distilPreferences, summariseReleaseNotes, promptRegistry, systemWith, requireClient, MODEL, isConfigured: (apiKey) => !!(apiKey || process.env.ANTHROPIC_API_KEY),
  // Exposed for tests: the deterministic JSON-salvage layer that guards every
  // model→JSON path (no network — pure parsing + repair).
  parseModelJson, parseModelJsonResilient };
