// Resolving which dashboard filters can be LOCKED on a given tile, and to which
// query field each maps. A tile's `listenTo` ({ filterName -> queryField }) is the
// Looker-validated wiring and always wins. Beyond that, any dashboard filter whose
// underlying field belongs to a view the tile's own query already uses is also a
// valid lock target (the explore joins that view, so filtering it is safe) — this
// is why the lock picker offers more than just the wired filters.

// The set of view prefixes the tile's query touches (explore + selected fields +
// existing query filters).
export function tileQueryViews(tile) {
  const q = tile?.query || {};
  const views = new Set();
  if (q.view) views.add(q.view);
  for (const f of q.fields || []) views.add(String(f).split('.')[0]);
  for (const k of Object.keys(q.filters || {})) views.add(String(k).split('.')[0]);
  return views;
}

// The query field a lock on `filterName` should write to, or null if the filter
// isn't applicable to this tile. `dashFilters` is the dashboard's filter defs.
export function lockFieldFor(tile, filterName, dashFilters = []) {
  if (tile?.listenTo && tile.listenTo[filterName]) return tile.listenTo[filterName];
  const f = (dashFilters || []).find((x) => x.name === filterName);
  const field = f && (f.field || f.dimension);
  if (!field || !String(field).includes('.')) return null;
  return tileQueryViews(tile).has(String(field).split('.')[0]) ? field : null;
}

// Every dashboard filter that can be locked on this tile (wired or field-applicable).
export function lockableFilters(tile, dashFilters = []) {
  return (dashFilters || []).filter((f) => lockFieldFor(tile, f.name, dashFilters) != null);
}
