// Parse a Looker drill link — an /explore/{model}/{view}?… URL carrying the
// fields, filters and sorts of the drill — into a runnable inline query.
function parseDrillUrl(url) {
  if (!url) return null;
  const qIdx = url.indexOf('?');
  const path = qIdx >= 0 ? url.slice(0, qIdx) : url;
  const qs = qIdx >= 0 ? url.slice(qIdx + 1) : '';
  const m = path.match(/\/explore\/([^/]+)\/([^/?]+)/);
  if (!m) return null;

  const query = {
    model: decodeURIComponent(m[1]),
    view: decodeURIComponent(m[2]),
    filters: {},
    limit: '500',
  };

  const params = new URLSearchParams(qs);
  for (const [key, value] of params.entries()) {
    const fMatch = key.match(/^f\[(.+)\]$/);
    if (fMatch) { query.filters[fMatch[1]] = value; continue; }
    switch (key) {
      case 'fields': query.fields = value.split(',').filter(Boolean); break;
      case 'sorts': query.sorts = value.split(',').filter(Boolean); break;
      case 'pivots': query.pivots = value.split(',').filter(Boolean); break;
      case 'fill_fields': query.fill_fields = value.split(',').filter(Boolean); break;
      case 'limit': query.limit = value; break;
      case 'column_limit': query.column_limit = value; break;
      case 'dynamic_fields': query.dynamic_fields = value; break; // JSON string
      case 'query_timezone': query.query_timezone = value; break;
      case 'total': query.total = value === 'true'; break;
      default: break; // ignore vis, toggle, origin, etc.
    }
  }
  return query;
}

module.exports = { parseDrillUrl };
