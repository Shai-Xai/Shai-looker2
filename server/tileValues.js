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

  async function resolveTileValue({ dashboardId, tileId, user, suiteId }) {
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
    // Use the number the tile actually SHOWS (honours hidden_fields, picks the
    // visible primary measure, reads the rendered value) so the goal == the dashboard.
    const value = primaryTileValue(data, tile.vis || {});
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
    // Preserve the tile's own (chronological) row order; only re-sort when x is ISO dates.
    if (series.length && looksDate(series[0].t)) series.sort((a, b) => a.t.localeCompare(b.t));
    return series;
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
      for (const pv of pivots) columns.push({ key: pv.key, series: rows.map((row, i) => ({ t: x[i], v: num(row[measure.name]?.[pv.key]) })).filter((p) => p.v != null) });
    } else {
      columns.push({ key: measure.label || measure.name, series: rows.map((row, i) => ({ t: x[i], v: num(row[measure.name]) })).filter((p) => p.v != null) });
    }
    return { dateField: dateDim.name, measureField: measure.name, strippedFilters: stripResult.stripped, columns: columns.filter((c) => c.series.length) };
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

  return { resolveTileValue, resolveTileSeries, resolveTileSeriesAll, resolveEventDate, stripDaysBeforeFilters, tileLockOverrides };
};
