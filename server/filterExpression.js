// ─── Combined-field filters (OR across fields) → Looker filter_expression ──────
// A normal dashboard/locked filter targets ONE field and Looker AND-combines the
// per-field `filters` map. To let a single filter block match ANY of several
// fields (e.g. "Ticket Category = X OR Add-on Category = X"), we need Looker's
// `filter_expression` — the only place cross-field OR can be expressed. This is a
// PURE module (no db, no Looker) so the string it builds is unit-testable.
//
// Storage: a combined block rides inside the existing flat lock map as a single
// KEY (value stays a plain value string, so all the existing splitVals/expand
// plumbing ignores it). Key shape:  __or__:<op>:<field1>|<field2>|…
//   op ∈ is | is_not | contains          fields joined by '|'
// A plain single-field "is" lock keeps its normal `{ "view.field": "vals" }` shape
// (fully backward compatible) — only multi-field or a non-"is" operator encodes here.
//
// SECURITY: filter_expression is applied by Looker IN ADDITION TO the `filters`
// map (AND-combined), so the forced organiser scope (which always lives in the
// filters map via applyScope) is NEVER weakened by adding an OR expression.

const OR_PREFIX = '__or__';
const OPS = ['is', 'is_not', 'contains'];

const isCombinedKey = (key) => typeof key === 'string' && key.startsWith(`${OR_PREFIX}:`);

// Build the composite key for a combined block. Returns a plain field key when it's
// a single field with the default "is" operator (keep the backward-compatible shape).
function makeCombinedKey(op, fields) {
  const list = (fields || []).map((f) => String(f || '').trim()).filter(Boolean);
  const o = OPS.includes(op) ? op : 'is';
  if (!list.length) return '';
  if (list.length === 1 && o === 'is') return list[0]; // plain, backward-compatible
  return `${OR_PREFIX}:${o}:${list.join('|')}`;
}

// Parse a composite key → { op, fields }, or null if it isn't one.
function parseCombinedKey(key) {
  if (!isCombinedKey(key)) return null;
  const rest = key.slice(OR_PREFIX.length + 1); // drop "__or__:"
  const ci = rest.indexOf(':');
  if (ci < 0) return null;
  const op = rest.slice(0, ci);
  const fields = rest.slice(ci + 1).split('|').map((f) => f.trim()).filter(Boolean);
  if (!OPS.includes(op) || !fields.length) return null;
  return { op, fields };
}

// Values are comma-separated in the lock map (same convention as everywhere else).
const splitValues = (v) => String(v == null ? '' : v).split(',').map((s) => s.trim()).filter(Boolean);

// A Looker expression string literal: double-quoted, backslash-escaped.
const lit = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// One OR group for a combined block: match ANY (field, value) pair.
//   is       → (${f1} = "a" OR ${f1} = "b" OR ${f2} = "a" …)
//   contains → (contains(${f1}, "a") OR …)
//   is_not   → NOT (${f1} = "a" OR …)          (exclude if any field equals any value)
// Returns '' when there's nothing to constrain (no fields or no values).
function buildOrGroup(fields, op, values) {
  const fs = (fields || []).map((f) => String(f || '').trim()).filter(Boolean);
  const vs = Array.isArray(values) ? values.filter((v) => String(v).trim() !== '') : splitValues(values);
  if (!fs.length || !vs.length) return '';
  const o = OPS.includes(op) ? op : 'is';
  const clauses = [];
  for (const f of fs) for (const v of vs) {
    clauses.push(o === 'contains' ? `contains(\${${f}}, ${lit(v)})` : `\${${f}} = ${lit(v)}`);
  }
  const inner = clauses.join(' OR ');
  if (o === 'is_not') return `NOT (${inner})`;
  return `(${inner})`;
}

// Combine several blocks (each { fields, op, value|values }) into one expression,
// AND-joined. Skips blocks that resolve to nothing. Returns '' when none apply.
function combinedExpression(blocks) {
  const groups = (blocks || [])
    .map((b) => buildOrGroup(b.fields, b.op, b.values != null ? b.values : b.value))
    .filter(Boolean);
  return groups.join(' AND ');
}

// The view prefixes a tile's query touches (view + fields + existing filters) —
// a combined block's field only applies to a tile whose query joins that view.
// Mirrors client tileLockFields.tileQueryViews so both sides agree.
function queryViews(query) {
  const q = query || {};
  const views = new Set();
  if (q.view) views.add(q.view);
  for (const f of q.fields || []) views.add(String(f).split('.')[0]);
  for (const k of Object.keys(q.filters || {})) views.add(String(k).split('.')[0]);
  return views;
}
const fieldView = (field) => String(field || '').split('.')[0];

// Given a lock map, pull out the combined blocks as { op, fields, value }. `values`
// come from the map value (comma list). Ignores non-combined keys.
function combinedBlocksFromLockMap(lockMap) {
  const out = [];
  for (const [key, value] of Object.entries(lockMap || {})) {
    const parsed = parseCombinedKey(key);
    if (parsed) out.push({ op: parsed.op, fields: parsed.fields, value });
  }
  return out;
}

// Narrow a set of combined blocks to what actually applies to a tile's query:
// keep only the fields whose view the query joins, drop blocks with no applicable
// field or no value. Returns a clean [{ op, fields, values }] ready for the builder.
function blocksForQuery(blocks, query, { anyValue } = {}) {
  const views = queryViews(query);
  const out = [];
  for (const b of blocks || []) {
    const value = b.value != null ? b.value : b.values;
    if (value == null || value === '' || value === anyValue) continue;
    const fields = (b.fields || []).filter((f) => views.has(fieldView(f)));
    if (!fields.length) continue;
    out.push({ op: b.op, fields, values: splitValues(value) });
  }
  return out;
}

// Attach a combined-OR expression to a query body (AND-appending to any existing
// filter_expression). Mutates + returns the body. No-op when no blocks apply.
function applyCombinedToBody(body, blocks, query, opts) {
  const applicable = blocksForQuery(blocks, query || body, opts);
  const expr = combinedExpression(applicable);
  if (!expr) return body;
  body.filter_expression = body.filter_expression ? `(${body.filter_expression}) AND ${expr}` : expr;
  return body;
}

module.exports = {
  OR_PREFIX, OPS, isCombinedKey, makeCombinedKey, parseCombinedKey, splitValues,
  buildOrGroup, combinedExpression, queryViews, combinedBlocksFromLockMap,
  blocksForQuery, applyCombinedToBody,
};
