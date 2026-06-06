// ─── Looker → editable dashboard converter ───────────────────────────────────
// Converts a fetched Looker dashboard (shell + elements + filters) into our
// own editable dashboard definition. After import there is no link back to
// Looker's dashboard object — the definition is fully owned and editable here.

const { extractQueryFromElement, extractVisFromElement } = require('./looker');
const { defaultTheme } = require('./store');

function convertDashboard({ dashboard, elements, filters }) {
  const tiles = elements.map((el) => {
    const isText = el.type === 'text';
    return {
      id: cryptoId(),
      type: isText ? 'text' : 'vis',
      title: el.title || '',
      body_text: el.body_text || '',
      layout: {
        x: el.col ?? 0,
        y: el.row ?? 0,
        w: el.width ?? 8,
        h: el.height ?? 6,
      },
      query: isText ? null : extractQueryFromElement(el),
      vis: isText ? {} : extractVisFromElement(el),
      listenTo: extractListenTo(el),
    };
  });

  const convertedFilters = filters.map((f) => ({
    id: cryptoId(),
    name: f.name,
    title: f.title || f.name,
    type: f.type,
    default_value: f.default_value || '',
    model: f.model || null,
    explore: f.explore || null,
    field: f.dimension || null,
    ui_config: f.ui_config || {},
    allow_multiple_values: f.allow_multiple_values ?? false,
  }));

  return {
    title: dashboard.title || 'Imported dashboard',
    description: dashboard.description || '',
    theme: defaultTheme(),
    filters: convertedFilters,
    tiles,
    source: { lookerDashboardId: String(dashboard.id) },
  };
}

// Build a tile's filter wiring ({ dashboardFilterName -> queryField }) from the
// result_maker's filterables. This is how Looker maps dashboard filters onto
// each tile's underlying query.
function extractListenTo(el) {
  const listenTo = {};
  for (const fb of el.result_maker?.filterables || []) {
    for (const l of fb.listen || []) {
      if (l.dashboard_filter_name && l.field) {
        listenTo[l.dashboard_filter_name] = l.field;
      }
    }
  }
  return listenTo;
}

function cryptoId() {
  return require('crypto').randomUUID();
}

module.exports = { convertDashboard };
