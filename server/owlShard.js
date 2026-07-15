// ─── Heavy-query chunking for the Owl's explore tools ────────────────────────
// Some cuts genuinely need a heavy cross join — every sale × the buyer's
// demographics ("average spend by country of birth") — and blow past Looker's
// own query timeout. But the SAME query filtered to a handful of dimension
// values completes fine (confirmed live: single-country works). So: fetch the
// dimension's values with a light query (selecting only the dimension makes
// Looker join just that field's own view, not the fact table), re-run the heavy
// query per value-chunk with a bounded concurrency, and merge — all inside a
// hard deadline so the tool's own budget is never blown. Complete assemblies
// are cached in-memory for hours: they're expensive, and "spend by demographic"
// is a question users re-ask all day.
//
// Factory-style library (like server/query.js), NOT a routes module.

const TTL_MS = 6 * 60 * 60 * 1000; // warm-cache lifetime for assembled results
const MAX_VALUES = 150;  // beyond this chunking can't fit any budget — caller refuses
const CHUNK = 20;        // dimension values per chunk query
const CONCURRENCY = 3;   // chunk queries in flight at once

const cache = new Map(); // bodyJson → { rows, note, at }
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) { cache.delete(key); return null; }
  return hit;
}
function cacheSet(key, rows, note) {
  cache.set(key, { rows, note, at: Date.now() });
  if (cache.size > 50) cache.delete(cache.keys().next().value); // oldest-in cap
}

// Re-compute `body` (a scoped, locked Looker query grouped by exactly `dim`) in
// value chunks. Returns { rows, note, complete } or null when chunking can't help
// (values unfetchable, too many values, or nothing completed).
async function shardQuery(query, body, dim, measure, { deadlineMs = 45000 } = {}) {
  const t0 = Date.now();
  const left = () => deadlineMs - (Date.now() - t0);
  let vals;
  try {
    const rows = await query.runLookerQuery('/queries/run/json', { model: body.model, view: body.view, fields: [dim], filters: { ...body.filters }, sorts: [dim], limit: 500 });
    vals = [...new Set((rows || []).map((r) => r[dim]).filter((v) => v != null && String(v).trim() !== ''))];
  } catch { return null; }
  // A value containing a comma would corrupt a Looker OR-filter — skip it honestly.
  const skipped = vals.filter((v) => String(v).includes(',')).length;
  vals = vals.filter((v) => !String(v).includes(','));
  if (!vals.length || vals.length > MAX_VALUES) return null;
  const chunks = [];
  for (let i = 0; i < vals.length; i += CHUNK) chunks.push(vals.slice(i, i + CHUNK));
  const out = [];
  let missed = 0;
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    if (left() < 5000) { missed += chunks.length - i; break; } // honest partial beats a blown budget
    const wave = chunks.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(wave.map((c) => query.runLookerQuery('/queries/run/json', { ...body, filters: { ...body.filters, [dim]: c.join(',') } })));
    for (const s of settled) {
      if (s.status === 'fulfilled' && Array.isArray(s.value)) out.push(...s.value);
      else missed += 1;
    }
  }
  if (!out.length) return null;
  out.sort((a, b) => (Number(b[measure]) || 0) - (Number(a[measure]) || 0));
  const rows = out.slice(0, body.limit || 500);
  const parts = [`Heavy cross-join computed by CHUNKING on ${dim} (${chunks.length - missed}/${chunks.length} chunks${skipped ? `; ${skipped} value(s) containing commas skipped` : ''}).`];
  if (missed) parts.push('PARTIAL RESULT — some value chunks did not complete in time, so their values are missing from these figures. Tell the user this is partial.');
  return { rows, note: parts.join(' '), complete: missed === 0 && skipped === 0 };
}

module.exports = { shardQuery, cacheGet, cacheSet };
