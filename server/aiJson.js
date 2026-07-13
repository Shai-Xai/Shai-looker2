// ─── Tolerant JSON parsing for model output ─────────────────────────────────────
// SHARED LIBRARY (not a routes module), lifted verbatim out of server/insights.js.
// Models occasionally emit slightly invalid JSON (raw newlines inside strings,
// trailing commas, a missing comma between array elements). Try the raw parse, then
// a few safe static repairs; the resilient variant falls back to ONE model
// "fix this JSON" pass. Pure parsing + repair — no other dependencies.

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
async function repairJsonViaModel(c, broken, model) {
  const resp = await c.messages.create({
    model, max_tokens: 8192, output_config: { effort: 'low' },
    system: JSON_REPAIR_SYSTEM,
    messages: [{ role: 'user', content: String(broken || '').slice(0, 24000) }],
  });
  return (resp.content || []).filter((bk) => bk.type === 'text').map((bk) => bk.text).join('');
}
// Parse model JSON with static repairs, then a single model-repair fallback.
async function parseModelJsonResilient(c, text, what, model) {
  try { return parseModelJson(text, what); }
  catch { return parseModelJson(await repairJsonViaModel(c, text, model), what); }
}

module.exports = { parseModelJson, parseModelJsonResilient, JSON_REPAIR_SYSTEM };
