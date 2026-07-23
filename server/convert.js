// ─── Looker → editable dashboard converter ───────────────────────────────────
// Converts a fetched Looker dashboard (shell + elements + filters) into our
// own editable dashboard definition. After import there is no link back to
// Looker's dashboard object — the definition is fully owned and editable here.

const { extractQueryFromElement, extractVisFromElement } = require('./looker');
const { defaultTheme } = require('./store');

function convertDashboard({ dashboard, elements, filters, layouts }) {
  // Modern Looker dashboards store tile positions in a separate layout object
  // (dashboard_layouts[].dashboard_layout_components), not on the element.
  // Build a map: elementId -> { row, column, width, height }.
  const activeLayout = (layouts || []).find((l) => l.active) || (layouts || [])[0];
  const posByElement = {};
  for (const c of activeLayout?.dashboard_layout_components || []) {
    posByElement[String(c.dashboard_element_id)] = c;
  }

  const tiles = elements.map((el) => {
    const isText = el.type === 'text';
    const pos = posByElement[String(el.id)];
    return {
      id: cryptoId(),
      sourceElementId: el.id != null ? String(el.id) : '', // stable Looker element id → lets a later re-sync match this tile
      type: isText ? 'text' : 'vis',
      title: el.title || '',
      body_text: el.body_text || '',
      rich: isText ? (el.rich_content_json || null) : null,
      layout: {
        x: pos?.column ?? el.col ?? 0,
        y: pos?.row ?? el.row ?? 0,
        w: pos?.width ?? el.width ?? 8,
        h: pos?.height ?? el.height ?? 6,
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
