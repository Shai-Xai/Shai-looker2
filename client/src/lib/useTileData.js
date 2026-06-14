import { useState, useEffect, useRef } from 'react';
import { api } from './api.js';
import { withLimit } from './limit.js';
import { useScope } from './ScopeContext.jsx';
import { ANY_VALUE } from './filterConstants.js';

// A query is only worth running once it has a model, an explore (view) and at
// least one field — otherwise Looker returns a validation error.
export function isRunnableQuery(q) {
  return !!(q && q.model && q.view && Array.isArray(q.fields) && q.fields.length > 0);
}

// Runs a tile's Looker query, re-running when the query or the active filter
// values change. Returns { data, loading, error }. Looker does the calculation;
// we only receive json_detail rows.
export function useTileData(tile, filterValues) {
  const { suiteId } = useScope();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(tile.type !== 'text' && isRunnableQuery(tile.query));
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  // Build filter overrides for this tile from the dashboard-level filter values,
  // using the tile's listenTo wiring ({ filterName -> queryField }).
  const overrides = {};
  for (const [filterName, queryField] of Object.entries(tile.listenTo || {})) {
    const val = filterValues?.[filterName];
    // "Any value": send an explicit empty override so Looker drops the tile's
    // baked filter on this field (an unset value would instead fall back to it).
    if (val === ANY_VALUE) overrides[queryField] = '';
    else if (val && String(val).trim()) overrides[queryField] = String(val).trim();
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

    setLoading(true);
    setError(null);

    withLimit(() => api.runQuery(tile.query, overrides, controller.signal, suiteId))
      .then((d) => setData(d))
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tile.type, queryKey, overrideKey, suiteId]);

  return { data, loading, error };
}
