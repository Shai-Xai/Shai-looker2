// ─── Shared scoped tile readers ────────────────────────────────────────────────
// The one place a server-side feature reads "the number a dashboard tile shows"
// (goals, alerts, pulse, the Owl, the public API). Every reader runs through the
// SAME scope-enforced query path as the dashboards themselves (tileQueryBody →
// applyScope), so the per-tenant boundary can't be bypassed and a resolved value
// always equals what the dashboard displays. Lifted out of server/index.js;
// behaviour unchanged.
//
// Usage: const { resolveTileValue, resolveTileSeries, resolveTileSeriesAll,
//   resolveEventDate } = require('./tileValues')({ db, query });

module.exports = function tileValues({ db, query }) {
  const { runLookerQuery, applyScope, expandLockMap, tileQueryBody, primaryTileValue } = query;

  // Per-tile lock overrides (queryField -> value) for ONE tile, from
  // suite.tileLocks. Passed as tileQueryBody's extraOverrides so a server-side
  // read (goals, curves) honours the same per-tile lock the dashboard applies.
  function tileLockOverrides(su, tile, def) {
    const lock = (su && su.tileLocks && su.tileLocks[tile.id]) || {};
    const o = {};
    for (const [filterName, v] of Object.entries(lock)) {
      if (v == null || String(v).trim() === '') continue;
      const queryField = tileLockField(tile, filterName, def && def.filters);
      if (queryField) o[queryField] = String(v).trim();
    }
    return o;
  }
  // The suite's CURRENT event value — the "Current Event" lock (by name; else "Event
  // Name"). On a current-vs-past COMPARISON tile the measure is pivoted by event, and
  // this pins which pivot column is THIS event — far more reliable than guessing by
  // largest total or newest-sorting key (both of which pick the wrong column when this
  // year is smaller than, or sorts below, a prior edition — the actual/last-time swap).
  function currentEventValue(rawLocks) {
    if (!rawLocks || typeof rawLocks !== 'object') return '';
    const keys = Object.keys(rawLocks);
    const k = keys.find((x) => /current\s*event/i.test(x)) || keys.find((x) => /^\s*event\s*name\s*$/i.test(x));
    return String((k ? rawLocks[k] : '') || '').split(',')[0].trim();
  }
  // The pivot key equal to `val` (case/space-insensitive), or null — so a pivot column
  // can be matched to the current event by its value.
  function matchPivotKey(pivots, val) {
    if (!val || !Array.isArray(pivots)) return null;
    const n = (s) => String(s == null ? '' : s).trim().toLowerCase();
    const hit = pivots.find((pv) => n(pv.key) === n(val));
    return hit ? hit.key : null;
  }

  // The query field a per-tile lock on `filterName` writes to: the tile's listenTo
  // wiring if present, else the dashboard filter's own field when the tile's query
  // already uses that field's view (mirrors client lib/tileLockFields.js).
  function tileLockField(tile, filterName, dashFilters) {
    if (tile.listenTo && tile.listenTo[filterName]) return tile.listenTo[filterName];
    const f = (dashFilters || []).find((x) => x.name === filterName);
    const field = f && (f.field || f.dimension);
    if (!field || !String(field).includes('.')) return null;
    const q = tile.query || {};
    const views = new Set();
    if (q.view) views.add(q.view);
    for (const ff of q.fields || []) views.add(String(ff).split('.')[0]);
    for (const k of Object.keys(q.filters || {})) views.add(String(k).split('.')[0]);
    return views.has(String(field).split('.')[0]) ? field : null;
  }

  // `preferPivotKey` (optional) explicitly names which pivot column to read — a goal's
  // saved "this event" override. It beats the Current-Event-lock auto-match below.
  async function resolveTileValue({ dashboardId, tileId, user, suiteId, preferPivotKey }) {
    const def = db.getDashboard(dashboardId);
    if (!def) return null;
    const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
    const tile = tiles.find((t) => t.id === tileId);
    if (!tile) return null;
    // Match the dashboard view exactly: apply its client-default saved filters (e.g.
    // a date range — which a GA4 tile needs to return anything but 0), with the
    // suite's organiser/event locks layered on top so scope still wins.
    const su = db.getSuite(suiteId);
    const entityView = su?.entityId ? (db.getFilterView('entity', su.entityId, dashboardId) || {}) : {};
    const lockMap = { ...expandLockMap(entityView), ...expandLockMap(db.lockedFiltersForSuite(suiteId, dashboardId)) };
    const body = await tileQueryBody(tile, def, user, suiteId, lockMap, tileLockOverrides(su, tile, def));
    if (!body) return null; // scope denied or non-queryable tile
    // Drop any "days before event" / days-to-go clip so a running-total KPI reads the
    // FULL to-date figure the dashboard headline shows (e.g. Total Tickets Sold 44,806),
    // not an as-of slice (43,310). Same treatment the curve resolver gives — keeps the
    // goal, the curve and the dashboard on one number. No-op for tiles without such a
    // filter (date ranges and other filters are untouched).
    body.filters = stripDaysBeforeFilters(body.filters, def, tile).filters;
    const data = await runLookerQuery('/queries/run/json_detail', body);
    // On a current-vs-past comparison (measure pivoted by event), read THIS event's
    // column specifically — identified by the suite's Current Event lock — instead of
    // the latest/biggest pivot (which can be a prior edition). Falls back to the
    // default pick when the current event can't be matched, so nothing else changes.
    const curKey = matchPivotKey(data.pivots || [], preferPivotKey || '') || matchPivotKey(data.pivots || [], currentEventValue(db.lockedFiltersForSuite(suiteId, dashboardId)));
    // Use the number the tile actually SHOWS (honours hidden_fields, picks the
    // visible primary measure, reads the rendered value) so the goal == the dashboard.
    const value = primaryTileValue(data, tile.vis || {}, curKey);
    // Diagnostic for "tile reads 0" (e.g. GA4): log the scoped query + fields + first
    // row so we can see WHY it resolved to nothing (wrong scope field? empty rows?).
    if (value == null || value === 0) {
      try {
        const names = (k) => (data?.fields?.[k] || []).map((f) => f.name);
        console.warn('[goals] tile-value', value, JSON.stringify({
          dashboardId, tileId, vis: tile.vis?.type, filters: body.filters,
          measures: names('measures'), tableCalcs: names('table_calculations'), dims: names('dimensions'),
          rowCount: (data?.data || []).length, firstRow: (data?.data || [])[0],
        }).slice(0, 1800));
      } catch { /* logging only */ }
    }
    return value;
  }

  // Row-level sibling of resolveTileValue: the TABLE behind a tile — every field
  // (dimensions, measures, table calcs) and the rows, under the same scoped,
  // suite-locked query the tile itself runs. Unlike the KPI reader it keeps the
  // tile's filters as-is (rows should match the tile's view, not a stripped
  // total) and includes hidden fields (the point IS the underlying data — e.g.
  // an email column a table hides for display). Pivoted tiles flatten to one
  // column per (measure × pivot value). Returns { fields, rows } or null.
  async function resolveTileRows({ dashboardId, tileId, user, suiteId, limit }) {
    const def = db.getDashboard(dashboardId);
    if (!def) return null;
    const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
    const tile = tiles.find((t) => t.id === tileId);
    if (!tile) return null;
    const su = db.getSuite(suiteId);
    const entityView = su?.entityId ? (db.getFilterView('entity', su.entityId, dashboardId) || {}) : {};
    const lockMap = { ...expandLockMap(entityView), ...expandLockMap(db.lockedFiltersForSuite(suiteId, dashboardId)) };
    const body = await tileQueryBody(tile, def, user, suiteId, lockMap, tileLockOverrides(su, tile, def));
    if (!body) return null; // scope denied or non-queryable tile
    body.limit = String(Math.min(Math.max(Number(limit) || 500, 1), 10000));
    const data = await runLookerQuery('/queries/run/json_detail', body);
    const f = data?.fields || {};
    const dims = f.dimensions || [];
    const measures = [...(f.measures || []), ...(f.table_calculations || [])];
    const pivots = data?.pivots || [];
    const cell = (c) => (c && c.value !== undefined ? c.value : null);
    const fields = [
      ...dims.map((d) => ({ name: d.name, label: d.label_short || d.label || d.name })),
      ...(pivots.length
        ? measures.flatMap((m) => pivots.map((pv) => ({ name: `${m.name}|${pv.key}`, label: `${m.label_short || m.label || m.name} — ${pv.key}` })))
        : measures.map((m) => ({ name: m.name, label: m.label_short || m.label || m.name }))),
    ];
    const rows = (data?.data || []).map((row) => {
      const out = {};
      for (const d of dims) out[d.name] = cell(row[d.name]);
      for (const m of measures) {
        if (pivots.length) for (const pv of pivots) out[`${m.name}|${pv.key}`] = cell(row[m.name]?.[pv.key]);
        else out[m.name] = cell(row[m.name]);
      }
      return out;
    });
    return { fields, rows };
  }

  // Remove "Days Before Event" / days-to-go type filters from a built query body, so a
  // forecast curve reads last time's FULL sell-through to event day rather than the
  // to-date slice these comparison dashboards usually clip it to. Targets the field by
  // name (days_before / days_to_event / …) and by the dashboard's days-to-go sync
  // mapping. Returns { filters, stripped:[keys removed] }.
  function stripDaysBeforeFilters(filters, def, tile) {
    if (!filters) return { filters, stripped: [] };
    const out = { ...filters };
    const stripped = [];
    const isDays = (k) => /day[s_]*\s*(before|to|until|remaining)/i.test(String(k)) || /before[_\s]*event/i.test(String(k));
    const syncName = def && def.daysBeforeSync ? def.daysBeforeSync.filterName : null;
    const mappedField = syncName && tile && tile.listenTo ? tile.listenTo[syncName] : null;
    for (const k of Object.keys(out)) {
      if (isDays(k) || (mappedField && k === mappedField)) { delete out[k]; stripped.push(k); }
    }
    return { filters: out, stripped };
  }

  // Put a tile series into CHRONOLOGICAL order before anyone accumulates it. Looker's
  // row sort is arbitrary (a countdown tile may arrive event-day-first, 0→117), and the
  // curve engine accumulates in array order — ascending countdown rows built the
  // cumulative BACKWARDS in time, flipping the axis-direction detector and making
  // "last time by now" read the wrong end of the curve (the 1-vs-247 bug). A numeric
  // axis is ambiguous once accumulated, so orientation is decided HERE, where the date
  // dimension's NAME is known: countdown dims ("days before/until/left/to go", or a
  // "day" axis that includes 0 with range > 31 — day-of-month is 1..31, never 0) sort
  // DESCENDING (117→0 = oldest first); dates + forward numerics sort ASCENDING.
  // Mixed/categorical labels are left in the tile's own row order.
  function orientSeries(series, dateFieldName) {
    const pts = Array.isArray(series) ? series : [];
    if (pts.length < 2) return pts;
    const isISO = (t) => /^\d{4}-\d{2}/.test(String(t));
    if (pts.every((p) => isISO(p.t))) return [...pts].sort((a, b) => String(a.t).localeCompare(String(b.t)));
    // Predominantly-numeric axis (≥80%): sort the numeric points and DROP the strays —
    // they're totals rows / null buckets, which have no place on the axis and would
    // double-count once the curve is accumulated. Mixed/categorical stays in row order.
    const numeric = pts.filter((p) => p.t !== '' && p.t != null && Number.isFinite(Number(p.t)));
    if (numeric.length < Math.max(2, Math.ceil(pts.length * 0.8))) return pts;
    const ns = numeric.map((p) => Number(p.t));
    const min = Math.min(...ns), max = Math.max(...ns);
    const name = String(dateFieldName || '');
    const countdown = /before|until|till|countdown|days?[ _-]?(out|left|to[ _-]?go|remaining)/i.test(name)
      || (/day/i.test(name) && min === 0 && max > 31);
    return [...numeric].sort((a, b) => (countdown ? Number(b.t) - Number(a.t) : Number(a.t) - Number(b.t)));
  }

  // Time-series version of resolveTileValue: run the SAME scoped query, but return
  // the whole [{ t, v }] series (a date dimension × the primary measure) instead of
  // one number. This is what powers "review last time's curve" when setting goal
  // checkpoints — the goal links a chart/table tile that carries the sell-by-now
  // shape, and we read its rows under the chosen event's scope. Scope is still
  // enforced inside tileQueryBody, exactly like the single-value path.
  async function resolveTileSeries({ dashboardId, tileId, user, suiteId }) {
    const def = db.getDashboard(dashboardId);
    if (!def) return [];
    const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
    const tile = tiles.find((t) => t.id === tileId);
    if (!tile) return [];
    const su = db.getSuite(suiteId);
    const entityView = su?.entityId ? (db.getFilterView('entity', su.entityId, dashboardId) || {}) : {};
    const lockMap = { ...expandLockMap(entityView), ...expandLockMap(db.lockedFiltersForSuite(suiteId, dashboardId)) };
    const body = await tileQueryBody(tile, def, user, suiteId, lockMap, tileLockOverrides(su, tile, def));
    if (!body) return [];
    body.filters = stripDaysBeforeFilters(body.filters, def, tile).filters; // full curve to event day
    body.limit = Math.max(Number(body.limit) || 0, 1000); // enough rows for a full curve
    const data = await runLookerQuery('/queries/run/json_detail', body);
    const fields = data?.fields || {};
    const rows = data?.data || [];
    if (!rows.length) return [];
    const hidden = new Set((tile.vis || {}).hidden_fields || []);
    const dims = (fields.dimensions || []).filter((f) => !hidden.has(f.name));
    const measures = [...(fields.measures || []), ...(fields.table_calculations || [])].filter((f) => !hidden.has(f.name));
    const isDateName = (n) => /date|day|week|month|year|created|time/i.test(n || '');
    const looksDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}/.test(v);
    const dateDim = dims.find((f) => isDateName(f.name)) || dims.find((f) => looksDate(rows[0][f.name]?.value)) || dims[0];
    const measure = measures[0] || dims.find((f) => f !== dateDim);
    if (!dateDim || !measure) return [];
    const numOf = (cell) => {
      if (!cell) return null;
      const r = cell.rendered;
      if (r != null && r !== '') { const m = String(r).replace(/[\s,]/g, '').match(/-?\d+(?:\.\d+)?/); if (m && Number.isFinite(Number(m[0]))) return Number(m[0]); }
      const v = Number(cell.value); return Number.isFinite(v) ? v : null;
    };
    // Pivoted trend (e.g. "26 vs 25 vs 24" pivots the measure by year): the measure cell
    // is keyed by pivot value. Pick the pivot column with the largest total — typically a
    // COMPLETE prior period rather than the partial current one — so we read a full curve.
    const pivots = data.pivots || [];
    let pickValue;
    if (pivots.length) {
      const totals = {};
      for (const pv of pivots) { let s = 0; for (const row of rows) { const v = numOf(row[measure.name]?.[pv.key]); if (v != null) s += v; } totals[pv.key] = s; }
      const bestKey = pivots.map((pv) => pv.key).sort((a, b) => (totals[b] || 0) - (totals[a] || 0))[0];
      pickValue = (row) => numOf(row[measure.name]?.[bestKey]);
    } else {
      pickValue = (row) => numOf(row[measure.name]);
    }
    const series = rows.map((row) => ({ t: String(row[dateDim.name]?.value ?? ''), v: pickValue(row) })).filter((p) => p.v != null);
    return orientSeries(series, dateDim.name); // chronological order (dates asc, countdown desc)
  }

  // Diagnostic sibling: return EVERY pivot column of a trend tile (not just one),
  // so the forecast probe can read both last-year (the shape) and this-year (recent
  // momentum) at once. Same scoped query path; returns { dateField, measureField,
  // columns:[{ key, series:[{t,v}] }] } or null. Read-only, used by the probe route.
  async function resolveTileSeriesAll({ dashboardId, tileId, user, suiteId }) {
    const def = db.getDashboard(dashboardId);
    if (!def) return null;
    const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
    const tile = tiles.find((t) => t.id === tileId);
    if (!tile) return null;
    const su = db.getSuite(suiteId);
    const entityView = su?.entityId ? (db.getFilterView('entity', su.entityId, dashboardId) || {}) : {};
    const lockMap = { ...expandLockMap(entityView), ...expandLockMap(db.lockedFiltersForSuite(suiteId, dashboardId)) };
    const body = await tileQueryBody(tile, def, user, suiteId, lockMap, tileLockOverrides(su, tile, def));
    if (!body) return null;
    const stripResult = stripDaysBeforeFilters(body.filters, def, tile);
    body.filters = stripResult.filters; // full curve to event day
    body.limit = Math.max(Number(body.limit) || 0, 1000);
    const data = await runLookerQuery('/queries/run/json_detail', body);
    const fields = data?.fields || {};
    const rows = data?.data || [];
    if (!rows.length) return null;
    const hidden = new Set((tile.vis || {}).hidden_fields || []);
    const dims = (fields.dimensions || []).filter((f) => !hidden.has(f.name));
    const measures = [...(fields.measures || []), ...(fields.table_calculations || [])].filter((f) => !hidden.has(f.name));
    const isDateName = (n) => /date|day|week|month|year|created|time/i.test(n || '');
    const looksDate2 = (v) => typeof v === 'string' && /^\d{4}-\d{2}/.test(v);
    const dateDim = dims.find((f) => isDateName(f.name)) || dims.find((f) => looksDate2(rows[0][f.name]?.value)) || dims[0];
    const measure = measures[0] || dims.find((f) => f !== dateDim);
    if (!dateDim || !measure) return null;
    const num = (cell) => { if (!cell) return null; const r = cell.rendered; if (r != null && r !== '') { const m = String(r).replace(/[\s,]/g, '').match(/-?\d+(?:\.\d+)?/); if (m && Number.isFinite(Number(m[0]))) return Number(m[0]); } const v = Number(cell.value); return Number.isFinite(v) ? v : null; };
    const x = rows.map((row) => String(row[dateDim.name]?.value ?? ''));
    const pivots = data.pivots || [];
    const columns = [];
    if (pivots.length) {
      for (const pv of pivots) columns.push({ key: pv.key, series: orientSeries(rows.map((row, i) => ({ t: x[i], v: num(row[measure.name]?.[pv.key]) })).filter((p) => p.v != null), dateDim.name) });
    } else {
      columns.push({ key: measure.label || measure.name, series: orientSeries(rows.map((row, i) => ({ t: x[i], v: num(row[measure.name]) })).filter((p) => p.v != null), dateDim.name) });
    }
    // Which column is THIS event — matched to the suite's Current Event lock — so the
    // goal chart/pace uses the real current event, not the newest-sorting pivot key.
    const currentKey = matchPivotKey(pivots, currentEventValue(db.lockedFiltersForSuite(suiteId, dashboardId)));
    return { dateField: dateDim.name, measureField: measure.name, strippedFilters: stripResult.stripped, currentKey, columns: columns.filter((c) => c.series.length) };
  }

  // The event's start date straight from Looker (core_events.start_date), scoped to
  // the suite so it returns THIS event — the authoritative anchor for "days to go" so
  // goals don't depend on a hand-typed deadline being entered. Runs a tiny inline
  // query on an explore the suite already uses (one that exposes core_events), newest
  // event first. Returns "YYYY-MM-DD" or null (callers fall back to the briefing date).
  async function resolveEventDate({ suiteId, user }) {
    const DATE = 'core_events.start_date';
    // Find an explore (model+view) the suite uses that references core_events.
    const defs = db.dashboardsInSuite(suiteId).map((id) => db.getDashboard(id)).filter(Boolean);
    const candidates = [];
    for (const def of defs) {
      const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
      for (const t of tiles) {
        const q = t.query;
        if (!q?.model || !q?.view) continue;
        const refsEvents = (q.fields || []).some((f) => /^core_events\./.test(String(f)));
        candidates.push({ model: q.model, view: q.view, refsEvents });
      }
    }
    // Prefer an explore we KNOW exposes core_events; else try the rest.
    const seen = new Set();
    const ordered = [...candidates.filter((c) => c.refsEvents), ...candidates.filter((c) => !c.refsEvents)]
      .filter((c) => { const k = `${c.model}|${c.view}`; if (seen.has(k)) return false; seen.add(k); return true; });
    for (const c of ordered) {
      const q = { model: c.model, view: c.view, fields: [DATE], sorts: [`${DATE} desc`], limit: 1 };
      if (!(await applyScope(q, user, suiteId))) continue; // fail closed → try next / fall back
      try {
        const rows = await runLookerQuery('/queries/run/json', q);
        const v = rows && rows[0] && rows[0][DATE];
        if (v != null && v !== '') { const m = String(v).match(/^\d{4}-\d{2}-\d{2}/); if (m) return m[0]; }
      } catch { /* explore may not expose start_date — try the next */ }
    }
    return null;
  }

  return { resolveTileValue, resolveTileRows, resolveTileSeries, resolveTileSeriesAll, resolveEventDate, stripDaysBeforeFilters, tileLockOverrides, currentEventValue, matchPivotKey, orientSeries };
};
