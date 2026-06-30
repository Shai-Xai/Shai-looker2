import { useState, useEffect, useRef } from 'react';
import { api } from './api.js';
import { withLimit } from './limit.js';
import { useScope } from './ScopeContext.jsx';
import { ANY_VALUE } from './filterConstants.js';
import { lockFieldFor } from './tileLockFields.js';

// A query is only worth running once it has a model, an explore (view) and at
// least one field — otherwise Looker returns a validation error.
export function isRunnableQuery(q) {
  return !!(q && q.model && q.view && Array.isArray(q.fields) && q.fields.length > 0);
}

// Runs a tile's Looker query, re-running when the query or the active filter
// values change. Returns { data, loading, error }. Looker does the calculation;
// we only receive json_detail rows.
export function useTileData(tile, filterValues) {
  const { suiteId, refreshKey = 0, softKey = 0, tileLocks = {}, lockFilters = [] } = useScope();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(tile.type !== 'text' && isRunnableQuery(tile.query));
  const [error, setError] = useState(null);
  const abortRef = useRef(null);
  const hasData = useRef(false);
  // Previous trigger inputs — to tell a HARD refresh (refreshKey, force a live
  // fetch) from a SOFT auto-refresh (softKey, on focus/interval — silent + cached)
  // from a normal change (query/filter/scope — show the skeleton).
  const prev = useRef({ queryKey: '', overrideKey: '', suiteId, refreshKey, softKey });

  // Build filter overrides for this tile from the dashboard-level filter values,
  // using the tile's listenTo wiring ({ filterName -> queryField }). A per-tile
  // lock (suite.tileLocks for this client) forces this ONE tile's value for a
  // filter, overriding the dashboard's value.
  const myLocks = tileLocks?.[tile.id] || {};
  const overrides = {};
  for (const [filterName, queryField] of Object.entries(tile.listenTo || {})) {
    const locked = myLocks[filterName];
    const val = (locked != null && String(locked).trim() !== '') ? locked : filterValues?.[filterName];
    // "Any value": send the ANY_VALUE sentinel so the server DROPS this field
    // from the query entirely (true "is any value"). An empty string wouldn't
    // work — Looker reads "" as "is blank", not "no constraint".
    if (val === ANY_VALUE) overrides[queryField] = ANY_VALUE;
    else if (val && String(val).trim()) overrides[queryField] = String(val).trim();
  }
  // A hand-added dashboard filter (no Looker model/explore, so it was never wired
  // into any tile's `listenTo`) still has to filter the report. Apply its value to
  // any tile whose own query already uses that field's view — the same field-match
  // the lock picker uses. Looker-imported filters carry model/explore and keep
  // their explicit listenTo wiring only, so nothing over-filters.
  for (const f of lockFilters || []) {
    if (f.model || f.explore) continue;                     // Looker-wired → listenTo only (above)
    if (tile.listenTo && f.name in tile.listenTo) continue; // already handled in Loop 1
    const val = filterValues?.[f.name];
    if (!val || val === ANY_VALUE || !String(val).trim()) continue;
    const queryField = lockFieldFor(tile, f.name, lockFilters);
    if (queryField) overrides[queryField] = String(val).trim();
  }
  // Per-tile locks on filters the tile ISN'T wired to via listenTo — resolve the
  // filter to a query field the tile's own query already uses, and apply it.
  for (const [filterName, locked] of Object.entries(myLocks)) {
    if (tile.listenTo && filterName in tile.listenTo) continue; // handled above
    if (locked == null || String(locked).trim() === '') continue;
    const queryField = lockFieldFor(tile, filterName, lockFilters);
    if (queryField) overrides[queryField] = String(locked).trim();
  }

  const queryKey = JSON.stringify(tile.query);
  const overrideKey = JSON.stringify(overrides);

  useEffect(() => {
    if (tile.type === 'text' || !isRunnableQuery(tile.query)) {
      setLoading(false);
      setData(null);
      setError(null);
      return;
    }

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const p = prev.current;
    // HARD refresh (Refresh button) → force a cache-bypassing live fetch.
    const force = refreshKey !== p.refreshKey;
    // SOFT auto-refresh (focus / interval): only softKey changed, we already have
    // data → re-fetch quietly via the cache, no skeleton flash.
    const softOnly = !force && p.queryKey === queryKey && p.overrideKey === overrideKey && p.suiteId === suiteId && softKey !== p.softKey && hasData.current;
    prev.current = { queryKey, overrideKey, suiteId, refreshKey, softKey };

    if (!softOnly) setLoading(true);
    setError(null);

    withLimit(() => api.runQuery(tile.query, overrides, controller.signal, suiteId, force))
      .then((d) => { setData(d); hasData.current = true; })
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tile.type, queryKey, overrideKey, suiteId, refreshKey, softKey]);

  return { data, loading, error };
}
