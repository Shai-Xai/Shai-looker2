// ─── Query & scope engine ──────────────────────────────────────────────────────
// SHARED LIBRARY (not a routes module). The Looker query runner + result cache,
// the hard organiser-scope boundary, and the filter/lock helpers that build a
// tile's scoped query body. Everything that talks to Looker on behalf of a user
// goes through here, so the per-client scope is enforced in ONE place.
//
// Factory: require('./query')({ looker, auth }) → the helper set. Called once in
// index.js so there is a single shared query cache. Depends only on `looker`
// (lookerRequest) and `auth` (scopeForQuery, filterNameToField) — no db, no app.
//
// Behaviour note: these functions were lifted verbatim out of index.js; the only
// change is that `looker`/`auth` arrive as injected deps instead of module
// requires. The cache (qCache/qInflight) and the env-tunable windows live here.

const fx = require('./filterExpression'); // combined-field OR → Looker filter_expression

module.exports = function createQueryEngine({ looker, auth }) {
  // Cache windows (ms). fresh: serve from cache; stale: serve cached + refresh
  // behind; beyond stale: wait for live Looker data.
  const QCACHE_TTL = (Number(process.env.QUERY_CACHE_TTL) || 300) * 1000;
  const QCACHE_STALE = (Number(process.env.QUERY_CACHE_STALE) || 1800) * 1000;
  const QCACHE_MAX = Number(process.env.QUERY_CACHE_MAX) || 500;
  // Entry-size guard: QCACHE_MAX bounds the COUNT, not the bytes. A campaign
  // audience pull can be 50k+ rows (~25-100 MB parsed) — on a 512 MB instance a
  // handful of those pinned in the cache is an OOM. Results over this row count
  // are served but never stored (in-flight dedupe still coalesces callers).
  // Normal tile queries are ≤500 rows, so they're unaffected.
  const QCACHE_MAX_ROWS = Number(process.env.QUERY_CACHE_MAX_ROWS) || 2000;
  // Byte guard: 500 entries × 2000 rows can still exceed the whole 512 MB
  // instance. Track approximate bytes per entry (first row's JSON × row count)
  // and evict oldest until under budget.
  const QCACHE_MAX_BYTES = (Number(process.env.QUERY_CACHE_MAX_MB) || 48) * 1024 * 1024;
  const qCache = new Map();    // key -> { at, runStart, data, bytes }
  const qInflight = new Map(); // key -> { promise, live, start }
  let qSeq = 0; // monotonic run counter — Date.now() can tie within a millisecond
  let qBytes = 0;
  const qEvict = (key) => { const e = qCache.get(key); if (e) { qBytes -= e.bytes; qCache.delete(key); } };

  function stableKey(obj) {
    if (Array.isArray(obj)) return '[' + obj.map(stableKey).join(',') + ']';
    if (obj && typeof obj === 'object') return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + stableKey(obj[k])).join(',') + '}';
    return JSON.stringify(obj);
  }
  function refreshQuery(key, path, body, live = false) {
    // In-flight dedupe — BUT a user-forced LIVE run must never join an in-flight
    // CACHED run (background serve-stale refresh, briefing warmer): that run will
    // hand back Looker's own cached result (up to ~1h old) and "refresh" silently
    // changes nothing. Live joins live; cached joins anything.
    const cur = qInflight.get(key);
    if (cur && (cur.live || !live)) return cur.promise;
    // `live` (a user-forced refresh) also busts LOOKER's own result cache —
    // without it "refresh" could still return Looker's cached run (up to ~1h
    // old), which is how a live event-day capacity tile sat hours behind.
    // The cache KEY stays the plain path, so the truly-live result updates the
    // same entry every other reader shares.
    const runPath = live ? `${path}${path.includes('?') ? '&' : '?'}cache=false` : path;
    const start = ++qSeq;
    const p = looker.lookerRequest('POST', runPath, body)
      .then((data) => {
        if (qInflight.get(key)?.promise === p) qInflight.delete(key);
        // Row list: json_detail wraps rows in .data; the compact /json format IS the array.
        const list = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : null);
        const rows = list ? list.length : 0;
        // Never let an earlier-started run (a superseded cached one) clobber the
        // cache entry a later live run already wrote.
        if (rows <= QCACHE_MAX_ROWS && (qCache.get(key)?.runStart || 0) <= start) {
          let bytes = 4096;
          try { bytes += rows ? JSON.stringify(list[0]).length * rows : 0; } catch { /* keep the floor */ }
          qEvict(key); // replacing: release the old entry's bytes first
          qCache.set(key, { at: Date.now(), runStart: start, data, bytes });
          qBytes += bytes;
          while ((qCache.size > QCACHE_MAX || qBytes > QCACHE_MAX_BYTES) && qCache.size > 1) qEvict(qCache.keys().next().value);
        }
        return data;
      })
      .catch((e) => { if (qInflight.get(key)?.promise === p) qInflight.delete(key); throw e; });
    qInflight.set(key, { promise: p, live, start });
    return p;
  }
  // `ttl` optionally overrides the fresh window for this query (ms).
  // `force` skips the cache entirely and waits for live Looker data — used when
  // the user explicitly asks for a refresh (otherwise the serve-stale path would
  // hand back up-to-10-minute-old rows instantly and "refresh" changes nothing).
  async function runLookerQuery(path, body, ttl = QCACHE_TTL, force = false) {
    const key = path + '|' + stableKey(body);
    if (force) return refreshQuery(key, path, body, true); // user asked for LIVE — bust Looker's cache too
    const hit = qCache.get(key);
    const age = hit ? Date.now() - hit.at : Infinity;
    if (hit && age < ttl) return hit.data;                       // fresh
    if (hit && age < ttl + QCACHE_STALE) {                        // stale → serve now, refresh behind
      refreshQuery(key, path, body).catch(() => {});
      return hit.data;
    }
    return refreshQuery(key, path, body);                         // miss → wait for it
  }

  // "Is any value" sentinel (mirrors client/src/lib/filterConstants.js ANY_VALUE).
  // A filter set to this means "no constraint" — drop the field from the query
  // entirely. Sending "" instead would make Looker filter for blank values.
  const ANY_VALUE = ' __ANY_VALUE__';
  // A range filter the user cleared to BOTH bounds empty ("[,]", "( , )", "[,)")
  // is not a real constraint — but Looker reads an empty range as "match nothing"
  // and zeroes the tile (the days-before-event dashboard showing 0 for a real
  // event). Clearing a range means "no filter", so drop it like ANY_VALUE so a
  // blanked range behaves the same as a truly-empty one. A HALF-open range
  // ("[10,]" = >=10, "[,360]" = <=360) is a real constraint and is kept.
  const EMPTY_RANGE = /^[[(]\s*,\s*[\])]$/;
  function stripAnyValue(filters) {
    const out = {};
    for (const [k, v] of Object.entries(filters || {})) {
      if (v === ANY_VALUE) continue;
      if (typeof v === 'string' && EMPTY_RANGE.test(v.trim())) continue;
      out[k] = v;
    }
    return out;
  }

  // Force the user's ENTITY (organiser) lock onto every query — the hard security
  // boundary. Uses the organiser field that belongs to the query's OWN explore
  // (so GA4 etc. don't get core_organisers.name injected, which Looker rejects).
  // A suite context (client view or admin preview) scopes to that suite's
  // organiser; no suite + admin is unscoped. Returns false to deny (fail closed).
  async function applyScope(query, user, suiteId) {
    const scope = await auth.scopeForQuery(query, user, suiteId);
    if (scope === false) return false; // fail closed
    query.filters = { ...(query.filters || {}) };
    // The forced organiser scope is a CEILING, not an override. If the dashboard
    // already narrowed this field (e.g. the user picked one of several organisers
    // the client owns), keep that narrower selection — but only to values inside
    // the allowed set, so it can never widen past the security boundary. With no
    // selection (or a selection wholly outside the allowed set), fall back to the
    // full allowed set. This fixes multi-organiser clients where narrowing the
    // Organiser filter was being clobbered back to "all organisers".
    for (const [field, allowedVal] of Object.entries(scope)) {
      const requested = query.filters[field];
      if (requested && typeof requested === 'string' && requested.trim()) {
        const allowed = new Set(String(allowedVal).split(',').map((s) => s.trim()).filter(Boolean));
        const kept = requested.split(',').map((s) => s.trim()).filter((v) => allowed.has(v));
        query.filters[field] = kept.length ? kept.join(',') : allowedVal;
      } else {
        query.filters[field] = allowedVal;
      }
    }
    return true;
  }

  // Row-order-sensitive comparison tiles (offset() table calcs over current-vs-past
  // events) must return the CURRENT (most recent) event first, or the comparison
  // reads backwards (the −83%/−865 bug). Sorting by event NAME is unreliable
  // (naming conventions vary, e.g. "Event" vs "Event 2025"), so force a sort by the
  // event start date, newest first. Returns a modified query, or null if N/A.
  function currentFirstEventSort(query) {
    try {
      if (!query) return null;
      const raw = query.dynamic_fields;
      const dyn = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const hasOffset = Array.isArray(dyn) && dyn.some((d) => typeof d?.expression === 'string' && /\boffset\s*\(/i.test(d.expression));
      if (!hasOffset) return null;
      const fields = query.fields || [];
      if (!fields.some((f) => /^core_events\./.test(String(f)))) return null;
      const DATE = 'core_events.start_date';
      const nextFields = fields.includes(DATE) ? fields : [...fields, DATE];
      return { ...query, fields: nextFields, sorts: [`${DATE} desc`] };
    } catch { return null; }
  }

  const cleanFilterMap = (f) => {
    const out = {};
    if (f && typeof f === 'object' && !Array.isArray(f)) {
      for (const [k, v] of Object.entries(f).slice(0, 60)) if (typeof v === 'string') out[String(k).slice(0, 200)] = v.slice(0, 2000);
    }
    return out;
  };

  // The offset()-based "change" tiles are row-order sensitive: a single-value
  // tile shows the FIRST row, so the CURRENT event must lead the combined event
  // filters or the comparison reads backwards (the −83% vs +83% bug). Reorder
  // "Current & Past Events" / "Comparison Events" (+ cashless) so the Current
  // Event value(s) come first — deterministic regardless of how an admin entered
  // them, and harmless when a tile sorts its own rows (just reorders the IN-list).
  const COMBO_EVENT_FILTERS = {
    'Current & Past Events': ['Current Event', 'Event Name'],
    'Comparison Events': ['Current Event', 'Event Name'],
    'Comparison Cashless Events': ['Current Cashless Event'],
  };
  function orderCurrentFirst(lockMap) {
    const splitV = (v) => String(v == null ? '' : v).split(',').map((s) => s.trim()).filter(Boolean);
    const out = { ...lockMap };
    for (const [combo, currentNames] of Object.entries(COMBO_EVENT_FILTERS)) {
      if (out[combo] == null || out[combo] === '') continue;
      const vals = splitV(out[combo]);
      if (vals.length < 2) continue;
      let currentVals = [];
      for (const n of currentNames) { currentVals = splitV(lockMap[n]); if (currentVals.length) break; }
      if (!currentVals.length) continue;
      const lead = vals.filter((v) => currentVals.includes(v));
      const rest = vals.filter((v) => !currentVals.includes(v));
      if (lead.length && rest.length) out[combo] = [...lead, ...rest].join(',');
    }
    return out;
  }

  // Expand the map so each name-keyed lock also appears under its resolved field
  // — then a dashboard whose organiser filter is named differently still locks.
  // Name keys stay (and win client-side) so same-field filters (Current/Past
  // Event) keep locking independently.
  function expandLockMap(lockMap) {
    const ordered = orderCurrentFirst(lockMap || {});
    const out = { ...ordered };
    for (const [k, v] of Object.entries(ordered)) {
      if (k.includes('.')) continue;
      const field = auth.filterNameToField(k);
      if (field && out[field] == null) out[field] = v;
    }
    return out;
  }

  function effectiveFilterValues(def, lockMap = {}, overlay = null) {
    const norm = {};
    for (const [k, v] of Object.entries(lockMap)) norm[k.trim().toLowerCase()] = v;
    const fv = {};
    for (const f of def.filters || []) {
      const field = (f.field || f.dimension || '').trim().toLowerCase();
      const nameKey = (f.name || '').trim().toLowerCase();
      let v = f.default_value || '';
      if (overlay && typeof overlay[f.name] === 'string') v = overlay[f.name];
      const locked = norm[nameKey] != null ? norm[nameKey] : (field ? norm[field] : undefined);
      if (locked != null && locked !== '') v = locked;
      fv[f.name] = v;
    }
    return fv;
  }

  // `extraOverrides` (queryField → value) are dashboard filters captured into a
  // saved segment; they override the per-tile defaults. applyScope runs AFTER, so
  // the forced organiser/entity scope always wins — a segment can't widen scope.
  async function tileQueryBody(tile, def, user, suiteId, lockMap = {}, extraOverrides = {}) {
    const q = tile.query;
    if (tile.type === 'text' || !q?.model || !q?.view || !(q.fields || []).length) return null;
    const fv = effectiveFilterValues(def, lockMap);
    const overrides = {};
    for (const [filterName, queryField] of Object.entries(tile.listenTo || {})) {
      const v = fv[filterName];
      if (v && String(v).trim()) overrides[queryField] = String(v).trim();
    }
    const body = { ...q, filters: stripAnyValue({ ...(q.filters || {}), ...overrides, ...extraOverrides }) };
    if (!(await applyScope(body, user, suiteId))) return null;
    // Combined-field OR locks (one value across several fields) can't live in the
    // per-field filters map — apply them as a filter_expression, which Looker
    // AND-combines with `filters`, so the organiser scope above is never weakened.
    // A block field may be a filter NAME — resolve it to a real field via the tile's
    // own listenTo wiring first (most accurate), then the platform name→field vote.
    const blocks = fx.combinedBlocksFromLockMap(lockMap);
    if (blocks.length) {
      const nameField = (f) => (String(f).includes('.') ? f : ((tile.listenTo || {})[f] || (auth.filterNameToField && auth.filterNameToField(f)) || null));
      const resolved = blocks.map((b) => ({ ...b, fields: (b.fields || []).map(nameField).filter(Boolean) }));
      fx.applyCombinedToBody(body, resolved, body, { anyValue: ANY_VALUE });
    }
    return body;
  }

  // First numeric value in a json_detail result (measures → table calcs → dims) —
  // the days-before-event number a single-value source tile surfaces.
  function firstNumberFromDetail(res) {
    const row = res?.data?.[0];
    if (!row) return null;
    const fields = [...(res.fields?.measures || []), ...(res.fields?.table_calculations || []), ...(res.fields?.dimensions || [])];
    for (const f of fields) {
      const v = row[f.name]?.value;
      if (v != null && v !== '' && !Number.isNaN(Number(v))) return Math.round(Number(v));
    }
    return null;
  }

  // Server mirror of ViewPage.applyDaysToGo: for a dashboard whose days-to-go sync
  // is in APPLY mode, read the live days-before-event number from its source tile
  // and return a { filterName: expr } overlay (e.g. { "Days Before": ">=42" }) so
  // digest facts compare like-for-like to the same point in last year's cycle —
  // matching what the dashboard shows. Returns null when there's no sync to apply
  // (or the number can't be read), leaving the tile queries untouched.
  async function daysBeforeOverlayFor(def, user, suiteId, lockMap) {
    const sync = def.daysBeforeSync;
    if (!sync || sync.mode !== 'apply' || !sync.sourceTileId || !sync.filterName) return null;
    const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
    const src = tiles.find((t) => t.id === sync.sourceTileId);
    if (!src?.query) return null;
    const body = await tileQueryBody(src, def, user, suiteId, lockMap);
    if (!body) return null;
    try {
      const data = await runLookerQuery('/queries/run/json_detail', body, undefined, false);
      const n = firstNumberFromDetail(data);
      if (n == null) return null;
      return { [sync.filterName]: String(sync.expr || '>={n}').replace('{n}', String(n)) };
    } catch { return null; }
  }

  // ── The number a single-value tile actually SHOWS ──
  // Mirrors client SingleValueTile: honour Looker's hidden_fields (it hides a raw
  // measure and shows the visible one — often a % table-calc), take the first
  // visible measure/table-calc (else first visible field), resolve the latest
  // pivot column, and use the RENDERED value so the magnitude matches the
  // dashboard ("64%" → 64, not the hidden count 20976, and not the ratio 0.64).
  // `preferKey` (when given) pins a specific pivot column — e.g. the CURRENT event on
  // a current-vs-past comparison tile — rather than defaulting to the latest column.
  function resolvePivotCellSrv(cell, pivots, preferKey) {
    if (!cell || cell.value !== undefined || cell.rendered !== undefined) return cell;
    if (preferKey && cell[preferKey] && (cell[preferKey].value != null || (cell[preferKey].rendered != null && cell[preferKey].rendered !== ''))) return cell[preferKey];
    const keys = (pivots && pivots.length) ? pivots.map((p) => p.key) : Object.keys(cell);
    for (let i = keys.length - 1; i >= 0; i--) { const c = cell[keys[i]]; if (c && (c.value != null || (c.rendered != null && c.rendered !== ''))) return c; }
    return cell[keys[keys.length - 1]] || null;
  }
  function numFromCell(cell) {
    if (!cell) return null;
    const r = cell.rendered;
    if (r != null && r !== '') {
      const m = String(r).replace(/[\s,]/g, '').match(/(-?\d+(?:\.\d+)?)\s*(k|m|bn|b)?/i);
      if (m) { let n = parseFloat(m[1]); const s = (m[2] || '').toLowerCase(); if (s === 'k') n *= 1e3; else if (s === 'm') n *= 1e6; else if (s === 'b' || s === 'bn') n *= 1e9; if (Number.isFinite(n)) return n; }
    }
    const v = Number(cell.value);
    return Number.isFinite(v) ? v : null;
  }
  function primaryTileValue(data, visConfig = {}, preferKey) {
    const fields = data?.fields || {};
    const rows = data?.data || [];
    if (!rows.length) return null;
    const hidden = new Set(visConfig.hidden_fields || []);
    const measures = [...(fields.measures || []), ...(fields.table_calculations || [])].filter((f) => !hidden.has(f.name));
    const dims = (fields.dimensions || []).filter((f) => !hidden.has(f.name));
    const primary = measures[0] || [...measures, ...dims][0];
    if (!primary) return null;
    return numFromCell(resolvePivotCellSrv(rows[0][primary.name], data.pivots || [], preferKey));
  }

  // Wipe every cached query result (admin "Clear cache" — e.g. a live event day
  // where even background-refreshed entries must be recomputed from scratch).
  function clearCache() { const n = qCache.size; qCache.clear(); qBytes = 0; qInflight.clear(); return n; }

  return {
    runLookerQuery,
    applyScope,
    clearCache,
    primaryTileValue,
    stripAnyValue,
    ANY_VALUE,
    currentFirstEventSort,
    cleanFilterMap,
    expandLockMap,
    effectiveFilterValues,
    tileQueryBody,
    daysBeforeOverlayFor,
    firstNumberFromDetail,
  };
};
