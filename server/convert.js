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
      // Stable link back to the Looker element this tile came from. This is the
      // key `reconcileDashboard` matches on so a re-sync updates a tile in place
      // instead of appending a duplicate. (Legacy tiles imported before this
      // existed fall back to a title+vis signature — see reconcileDashboard.)
      sourceElementId: String(el.id),
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

// ─── Idempotent re-sync ───────────────────────────────────────────────────────
// Reconcile a freshly-fetched Looker dashboard INTO an existing editable
// definition without duplicating tiles. Incoming Looker elements are matched to
// existing tiles by a stable key: the `sourceElementId` stamped at import, with
// a title+vis-type signature as a fallback for legacy tiles that predate it.
// Matched tiles are refreshed IN PLACE — their local id, layout, hidden flag and
// carousel placement are kept; only the Looker-owned parts (query, vis, title,
// text, filter wiring) update. Genuinely-new Looker tiles are appended at the
// bottom of the grid; tiles no longer present in Looker are left untouched
// (never silently deleted — that stays a manual decision). Running this twice in
// a row is a no-op, which is exactly what the duplication bug was missing.
function tileSignature(t) {
  const title = (t.title || '').trim().toLowerCase();
  const vis = t.type === 'text' ? 'text' : (t.vis?.type || '');
  return `${title}|${vis}`;
}

function reconcileDashboard(existing, source) {
  const incoming = convertDashboard(source); // fresh tiles, each with sourceElementId

  // Index incoming tiles by element id, plus by signature but ONLY when that
  // signature is unambiguous (so a legacy match can't bind to the wrong tile).
  const incById = new Map();
  const sigCount = new Map();
  for (const t of incoming.tiles) {
    incById.set(t.sourceElementId, t);
    const s = tileSignature(t);
    sigCount.set(s, (sigCount.get(s) || 0) + 1);
  }
  const incBySig = new Map();
  for (const t of incoming.tiles) {
    const s = tileSignature(t);
    if (sigCount.get(s) === 1) incBySig.set(s, t);
  }

  const consumed = new Set();
  let updated = 0;
  const findIncoming = (t) => {
    // A tile that was already stamped matches ONLY by its source id — never fall
    // back to a signature (that could bind it to the wrong element). Legacy tiles
    // with no id fall back to an unambiguous title+vis signature.
    if (t.sourceElementId) {
      const byId = incById.get(t.sourceElementId);
      return byId && !consumed.has(byId.sourceElementId) ? byId : null;
    }
    const bySig = incBySig.get(tileSignature(t));
    return bySig && !consumed.has(bySig.sourceElementId) ? bySig : null;
  };
  const refresh = (t) => {
    const inc = findIncoming(t);
    if (!inc) return t; // orphan — Looker no longer has it; keep as-is
    consumed.add(inc.sourceElementId);
    updated++;
    return { ...t, title: inc.title, body_text: inc.body_text, rich: inc.rich, query: inc.query, vis: inc.vis, listenTo: inc.listenTo, sourceElementId: inc.sourceElementId };
  };

  const tiles = (existing.tiles || []).map(refresh);
  const carousels = (existing.carousels || []).map((c) => ({ ...c, tiles: (c.tiles || []).map(refresh) }));

  // Position brand-new tiles below everything that already exists.
  let nextY = [...tiles, ...carousels].reduce((m, x) => Math.max(m, (x.layout?.y ?? 0) + (x.layout?.h ?? 6)), 0);
  const added = [];
  for (const inc of incoming.tiles) {
    if (consumed.has(inc.sourceElementId)) continue;
    added.push({ ...inc, layout: { ...inc.layout, x: 0, y: nextY } });
    nextY += inc.layout?.h ?? 6;
  }

  // Filters reconcile by name: refresh in place, append new, keep orphans.
  const incFilters = new Map(incoming.filters.map((f) => [f.name, f]));
  let updatedFilters = 0;
  const filters = (existing.filters || []).map((f) => {
    const inc = incFilters.get(f.name);
    if (!inc) return f;
    incFilters.delete(f.name);
    updatedFilters++;
    return { ...f, title: inc.title, type: inc.type, default_value: inc.default_value, model: inc.model, explore: inc.explore, field: inc.field, ui_config: inc.ui_config, allow_multiple_values: inc.allow_multiple_values };
  });
  const addedFilters = [...incFilters.values()];
  for (const inc of addedFilters) filters.push(inc);

  return {
    tiles: [...tiles, ...added],
    carousels,
    filters,
    stats: { updated, added: added.length, updatedFilters, addedFilters: addedFilters.length },
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

module.exports = { convertDashboard, reconcileDashboard };
