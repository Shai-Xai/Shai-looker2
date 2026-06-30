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

module.exports = function createQueryEngine({ looker, auth }) {
  // Cache windows (ms). fresh: serve from cache; stale: serve cached + refresh
  // behind; beyond stale: wait for live Looker data.
  const QCACHE_TTL = (Number(process.env.QUERY_CACHE_TTL) || 300) * 1000;
  const QCACHE_STALE = (Number(process.env.QUERY_CACHE_STALE) || 1800) * 1000;
  const QCACHE_MAX = Number(process.env.QUERY_CACHE_MAX) || 500;
  const qCache = new Map();    // key -> { at, data }
  const qInflight = new Map(); // key -> Promise

  function stableKey(obj) {
    if (Array.isArray(obj)) return '[' + obj.map(stableKey).join(',') + ']';
    if (obj && typeof obj === 'object') return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + stableKey(obj[k])).join(',') + '}';
    return JSON.stringify(obj);
  }
  function refreshQuery(key, path, body) {
    if (qInflight.has(key)) return qInflight.get(key);
    const p = looker.lookerRequest('POST', path, body)
      .then((data) => {
        qInflight.delete(key);
        qCache.set(key, { at: Date.now(), data });
        if (qCache.size > QCACHE_MAX) qCache.delete(qCache.keys().next().value);
        return data;
      })
      .catch((e) => { qInflight.delete(key); throw e; });
    qInflight.set(key, p);
    return p;
  }
  // `ttl` optionally overrides the fresh window for this query (ms).
  // `force` skips the cache entirely and waits for live Looker data — used when
  // the user explicitly asks for a refresh (otherwise the serve-stale path would
  // hand back up-to-10-minute-old rows instantly and "refresh" changes nothing).
  async function runLookerQuery(path, body, ttl = QCACHE_TTL, force = false) {
    const key = path + '|' + stableKey(body);
    if (force) return refreshQuery(key, path, body);
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
  function stripAnyValue(filters) {
    const out = {};
    for (const [k, v] of Object.entries(filters || {})) if (v !== ANY_VALUE) out[k] = v;
    return out;
  }

  // Ticket category/type NAMES collide (several "Loyalty Tickets" with different
  // ids), so a name-keyed filter can't isolate one. When the value a user gave is
  // purely numeric id(s) — typed, or picked from the id-labelled dropdown — retarget
  // it to the matching `.id` dimension so the report filters to that EXACT category.
  // Plain names stay on the name field; a mixed id+name value also stays put (two
  // different fields would AND to nothing), so this only ever narrows correctly.
  function routeTicketIdFilters(filters) {
    if (!filters || typeof filters !== 'object') return filters;
    const out = { ...filters };
    for (const key of Object.keys(out)) {
      const m = /^(core_ticket_(?:categories|types))\.name$/.exec(key);
      if (!m) continue;
      const parts = String(out[key] == null ? '' : out[key]).split(',').map((s) => s.trim()).filter(Boolean);
      if (!parts.length || !parts.every((p) => /^\d+$/.test(p))) continue;
      const idKey = `${m[1]}.id`;
      out[idKey] = out[idKey] ? `${out[idKey]},${parts.join(',')}` : parts.join(',');
      delete out[key];
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
    const body = { ...q, filters: routeTicketIdFilters(stripAnyValue({ ...(q.filters || {}), ...overrides, ...extraOverrides })) };
    if (!(await applyScope(body, user, suiteId))) return null;
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
  function resolvePivotCellSrv(cell, pivots) {
    if (!cell || cell.value !== undefined || cell.rendered !== undefined) return cell;
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
  function primaryTileValue(data, visConfig = {}) {
    const fields = data?.fields || {};
    const rows = data?.data || [];
    if (!rows.length) return null;
    const hidden = new Set(visConfig.hidden_fields || []);
    const measures = [...(fields.measures || []), ...(fields.table_calculations || [])].filter((f) => !hidden.has(f.name));
    const dims = (fields.dimensions || []).filter((f) => !hidden.has(f.name));
    const primary = measures[0] || [...measures, ...dims][0];
    if (!primary) return null;
    return numFromCell(resolvePivotCellSrv(rows[0][primary.name], data.pivots || []));
  }

  return {
    runLookerQuery,
    applyScope,
    primaryTileValue,
    stripAnyValue,
    routeTicketIdFilters,
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
