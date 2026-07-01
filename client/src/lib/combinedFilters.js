// Client mirror of the combined-field OR codec (server/filterExpression.js). The
// server owns the Looker filter_expression SYNTAX; the client only needs to parse
// the composite lock keys and work out which apply to a given tile, then forward
// the structured blocks to /api/run-query (the server builds the expression). Keep
// the key format + view logic in sync with server/filterExpression.js.

const OR_PREFIX = '__or__';
const OPS = ['is', 'is_not', 'contains'];

export const isCombinedKey = (key) => typeof key === 'string' && key.startsWith(`${OR_PREFIX}:`);

// Composite key → { op, fields }, or null.
export function parseCombinedKey(key) {
  if (!isCombinedKey(key)) return null;
  const rest = key.slice(OR_PREFIX.length + 1);
  const ci = rest.indexOf(':');
  if (ci < 0) return null;
  const op = rest.slice(0, ci);
  const fields = rest.slice(ci + 1).split('|').map((f) => f.trim()).filter(Boolean);
  if (!OPS.includes(op) || !fields.length) return null;
  return { op, fields };
}

// Build the composite key (single "is" field stays plain — backward compatible).
export function makeCombinedKey(op, fields) {
  const list = (fields || []).map((f) => String(f || '').trim()).filter(Boolean);
  const o = OPS.includes(op) ? op : 'is';
  if (!list.length) return '';
  if (list.length === 1 && o === 'is') return list[0];
  return `${OR_PREFIX}:${o}:${list.join('|')}`;
}

// Extract combined blocks from a lock map → [{ op, fields, value }].
export function combinedBlocksFromLockMap(lockMap) {
  const out = [];
  for (const [key, value] of Object.entries(lockMap || {})) {
    const p = parseCombinedKey(key);
    if (p) out.push({ op: p.op, fields: p.fields, value });
  }
  return out;
}

const fieldView = (field) => String(field || '').split('.')[0];
function queryViews(query) {
  const q = query || {};
  const views = new Set();
  if (q.view) views.add(q.view);
  for (const f of q.fields || []) views.add(String(f).split('.')[0]);
  for (const k of Object.keys(q.filters || {})) views.add(String(k).split('.')[0]);
  return views;
}

// Narrow blocks to the ones that apply to a tile (≥1 field the tile actually
// filters on), keeping only the applicable fields. A field applies if its view is
// in the tile's static query OR the tile is wired to it via listenTo (a real Looker
// filter → field mapping, so the field is valid in the tile's explore). Returns the
// blocks to forward to the server, or [] — mirrors server blocksForQuery.
export function combinedFiltersForTile(blocks, query, anyValue, listenTo = {}) {
  const views = queryViews(query);
  const wired = new Set(Object.values(listenTo || {}));
  const applies = (f) => views.has(fieldView(f)) || wired.has(f);
  const out = [];
  for (const b of blocks || []) {
    if (b.value == null || b.value === '' || b.value === anyValue) continue;
    const fields = (b.fields || []).filter(applies);
    if (fields.length) out.push({ op: b.op, fields, value: b.value });
  }
  return out;
}
