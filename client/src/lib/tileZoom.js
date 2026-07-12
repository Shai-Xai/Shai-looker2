import { api } from './api.js';

// Per-user, per-tile chart zoom ("show only the last N points"). Loaded once
// per dashboard and cached; changes save debounced to the user's server-side
// prefs, so the zoom follows them across devices — and never leaks to other
// users (it's a personal view, not a dashboard edit).
const byDash = new Map(); // dashboardId -> { map: {tileId: n} | null, promise }
const timers = new Map();

export function loadTileZoom(dashboardId) {
  if (!dashboardId) return Promise.resolve({});
  let e = byDash.get(dashboardId);
  if (!e) {
    e = { map: null, promise: null };
    e.promise = api.getTileZoom(dashboardId)
      .then((r) => { e.map = r.zoom || {}; return e.map; })
      .catch(() => { e.map = {}; return e.map; });
    byDash.set(dashboardId, e);
  }
  return e.map != null ? Promise.resolve(e.map) : e.promise;
}

export function setTileZoom(dashboardId, tileId, n) {
  if (!dashboardId || !tileId) return;
  const e = byDash.get(dashboardId) || { map: {}, promise: null };
  e.map = { ...(e.map || {}) };
  if (n > 0) e.map[tileId] = n; else delete e.map[tileId];
  byDash.set(dashboardId, e);
  clearTimeout(timers.get(dashboardId));
  timers.set(dashboardId, setTimeout(() => { api.saveTileZoom(dashboardId, e.map).catch(() => { /* keep local */ }); }, 800));
}
