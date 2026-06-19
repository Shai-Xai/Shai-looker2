// ─── Recreate a Looker dashboard inside Looker ───────────────────────────────
// The original Howler feature: copy a Looker dashboard's tiles + filters into a
// brand-new Looker dashboard via POST. Kept intact for the "clone in Looker"
// workflow; the editable-builder path uses convert.js + store.js instead.

const { lookerRequest, lookerBaseUrl, fetchDashboard } = require('./looker');

async function recreateDashboard(source, newTitle, folderId) {
  const { dashboard, elements, filters } = source;

  const newDashboard = await lookerRequest('POST', '/dashboards', {
    title: newTitle,
    folder_id: folderId,
    description: dashboard.description || '',
    background_color: dashboard.background_color || null,
    load_configuration: dashboard.load_configuration || null,
    lookml_link_id: null,
  });

  const results = {
    dashboardId: newDashboard.id,
    dashboardUrl: `${lookerBaseUrl()}/dashboards/${newDashboard.id}`,
    tilesCreated: 0,
    tilesFailed: 0,
    filtersCreated: 0,
    filtersFailed: 0,
    errors: [],
  };

  const elementIdMap = {};

  for (const el of elements) {
    try {
      const payload = buildElementPayload(el, newDashboard.id);
      const newEl = await lookerRequest('POST', '/dashboard_elements', payload);
      elementIdMap[el.id] = newEl.id;
      results.tilesCreated++;
    } catch (err) {
      results.tilesFailed++;
      results.errors.push(`Tile "${el.title || el.id}" failed: ${err.message}`);
    }
  }

  for (const filter of filters) {
    try {
      const payload = buildFilterPayload(filter, newDashboard.id, elementIdMap);
      await lookerRequest('POST', '/dashboard_filters', payload);
      results.filtersCreated++;
    } catch (err) {
      results.filtersFailed++;
      results.errors.push(`Filter "${filter.name || filter.id}" failed: ${err.message}`);
    }
  }

  return results;
}

function buildElementPayload(el, newDashboardId) {
  const payload = {
    dashboard_id: newDashboardId,
    title: el.title || '',
    type: el.type,
    vis_config: el.vis_config || null,
    note_text: el.note_text || null,
    note_display: el.note_display || null,
    note_state: el.note_state || null,
    row: el.row ?? null,
    col: el.col ?? null,
    width: el.width ?? null,
    height: el.height ?? null,
  };

  if (el.type === 'text') {
    payload.body_text = el.body_text || '';
    return payload;
  }
  if (el.look_id) {
    payload.look_id = el.look_id;
    return payload;
  }
  if (el.result_maker_id) {
    payload.result_maker_id = el.result_maker_id;
    return payload;
  }
  const queryId = el.result_maker?.query?.id || el.query?.id;
  if (queryId) {
    payload.query_id = queryId;
    return payload;
  }
  if (el.body_text !== undefined) {
    payload.body_text = el.body_text;
  }
  return payload;
}

function buildFilterPayload(filter, newDashboardId, elementIdMap) {
  const listensTo = (filter.listens_to_filters || []).map((link) => ({
    ...link,
    dashboard_element_id: elementIdMap[link.dashboard_element_id] || link.dashboard_element_id,
  }));

  return {
    dashboard_id: newDashboardId,
    name: filter.name,
    title: filter.title || filter.name,
    type: filter.type,
    default_value: filter.default_value || '',
    model: filter.model || null,
    explore: filter.explore || null,
    dimension: filter.dimension || null,
    row: filter.row ?? null,
    width: filter.width ?? null,
    field: filter.field || null,
    listens_to_filters: listensTo,
    allow_multiple_values: filter.allow_multiple_values ?? null,
    required: filter.required ?? false,
    ui_config: filter.ui_config || null,
  };
}

module.exports = { recreateDashboard, fetchDashboard };
