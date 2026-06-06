// ─── Looker → editable dashboard converter ───────────────────────────────────
// Converts a fetched Looker dashboard (shell + elements + filters) into our
// own editable dashboard definition. After import there is no link back to
// Looker's dashboard object — the definition is fully owned and editable here.

const { extractQueryFromElement } = require('./looker');
const { defaultTheme } = require('./store');

function convertDashboard({ dashboard, elements, filters }) {
  // Per-element filter wiring: elementId -> { filterName -> queryField }
  const elementFilterMap = {};
  for (const filter of filters) {
    for (const link of filter.listens_to_filters || []) {
      if (!elementFilterMap[link.dashboard_element_id]) {
        elementFilterMap[link.dashboard_element_id] = {};
      }
      elementFilterMap[link.dashboard_element_id][filter.name] =
        link.field || filter.dimension;
    }
  }

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
      vis: el.vis_config || { type: 'looker_column' },
      listenTo: elementFilterMap[el.id] || {},
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

function cryptoId() {
  return require('crypto').randomUUID();
}

module.exports = { convertDashboard };
