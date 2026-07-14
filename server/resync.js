// ─── Re-sync a Pulse dashboard from its Looker source — DISPOSABLE MODULE ─────
// Imported dashboards remember their origin (source.lookerDashboardId). This
// pulls the CURRENT Looker version and merges it into the existing Pulse
// definition, refreshing Looker-derived content (each tile's query / vis /
// title / wiring, plus new tiles and filters) while PRESERVING everything Pulse
// layers on top: tile ids (so tile locks + days-to-go sync keep pointing at the
// right tile), carousels, layout arrangement, added text tiles, theme, AI
// context, folder + filter settings and the owner of a client fork.
//
// Tiles match by their stable Looker element id (recorded at import). Dashboards
// imported before that was recorded fall back to a title + query signature, and
// get stamped with the element id on the first successful re-sync so subsequent
// syncs are exact. mergeDef is pure (no I/O) so it's unit-testable.
//
// Mount: const resync = require('./resync')({ looker, fetchDashboard, convertDashboard });

module.exports = function createResync({ looker, fetchDashboard, convertDashboard }) {
  const sig = (t) => {
    const q = t.query || {};
    return `${String(t.title || '').trim().toLowerCase()}|${q.model || ''}.${q.view || ''}|${(q.fields || []).join(',')}`;
  };
  // Merged tile: Pulse identity + arrangement + Pulse-only flags kept; the
  // Looker-derived content refreshed. Spread `cur` first so its id/layout/hidden/
  // width survive; then overwrite exactly the fields Looker owns.
  const mergeTile = (cur, fresh) => ({
    ...cur,
    sourceElementId: fresh.sourceElementId || cur.sourceElementId || '',
    type: fresh.type,
    title: fresh.title,
    body_text: fresh.body_text,
    rich: fresh.rich,
    query: fresh.query,
    vis: fresh.vis,
    listenTo: fresh.listenTo,
  });

  // Pure merge: (currentDef, freshLookerDef) → { def, summary }. Never throws.
  function mergeDef(current, fresh) {
    const curTop = current.tiles || [];
    const curCarousels = current.carousels || [];
    const allCur = [...curTop, ...curCarousels.flatMap((c) => c.tiles || [])];

    // Match maps over EVERY current tile (top-level and inside carousels).
    const byEl = new Map(); const bySig = new Map();
    for (const t of allCur) {
      if (t.sourceElementId) byEl.set(String(t.sourceElementId), t);
      else { const s = sig(t); if (!bySig.has(s)) bySig.set(s, t); }
    }

    const summary = { updated: 0, added: 0, removedInLooker: 0, keptCustom: 0, filtersUpdated: 0, filtersAdded: 0, added_: [], removed_: [] };
    const claimed = new Set();      // current tile ids consumed by a fresh tile
    const updates = new Map();      // current tile id -> merged tile
    const newTiles = [];            // brand-new Looker tiles (append top-level)

    for (const ft of fresh.tiles || []) {
      let cur = ft.sourceElementId ? byEl.get(String(ft.sourceElementId)) : null;
      if (!cur) { const c = bySig.get(sig(ft)); if (c && !claimed.has(c.id)) cur = c; }
      if (cur && !claimed.has(cur.id)) {
        claimed.add(cur.id);
        updates.set(cur.id, mergeTile(cur, ft));
        summary.updated++;
      } else {
        newTiles.push(ft);
        summary.added++; summary.added_.push(ft.title || '(untitled)');
      }
    }

    // Rewrite each current tile in place: matched → merged; a Looker-sourced tile
    // no longer in Looker → kept as-is but reported; a Pulse-only tile → kept.
    const transform = (t) => {
      if (updates.has(t.id)) return updates.get(t.id);
      if (t.sourceElementId && !claimed.has(t.id)) { summary.removedInLooker++; summary.removed_.push(t.title || '(untitled)'); }
      else if (!t.sourceElementId) summary.keptCustom++;
      return t;
    };
    const nextTiles = [...curTop.map(transform), ...newTiles];
    const nextCarousels = curCarousels.map((c) => ({ ...c, tiles: (c.tiles || []).map(transform) }));

    // Filters match by name: refresh Looker-owned fields, add new, keep Pulse-only.
    const curFilters = current.filters || [];
    const freshByName = new Map((fresh.filters || []).map((f) => [f.name, f]));
    const curNames = new Set(curFilters.map((f) => f.name));
    const nextFilters = curFilters.map((cf) => {
      const ff = freshByName.get(cf.name);
      if (!ff) return cf; // Pulse filter Looker no longer has — keep (may be wired to a lock)
      summary.filtersUpdated++;
      return { ...cf, title: ff.title, type: ff.type, field: ff.field, model: ff.model, explore: ff.explore, ui_config: ff.ui_config, allow_multiple_values: ff.allow_multiple_values, default_value: ff.default_value };
    });
    for (const ff of fresh.filters || []) if (!curNames.has(ff.name)) { nextFilters.push(ff); summary.filtersAdded++; }

    // Everything else (theme, aiContext, folder, keepImportedFilters, daysBeforeSync,
    // ownerEntityId, gridAfter, title, source) is preserved by spreading `current`.
    const def = { ...current, tiles: nextTiles, carousels: nextCarousels, filters: nextFilters };
    return { def, summary };
  }

  // Fetch + convert the current Looker dashboard into a fresh Pulse-shaped def.
  async function freshDefFor(lookerDashboardId) {
    const source = await fetchDashboard(lookerDashboardId);
    await looker.resolveElementQueries(source.elements);
    return convertDashboard(source);
  }

  // Resolve the fresh Looker def and merge it into `current`. Throws if the
  // dashboard has no Looker origin.
  async function resync(current) {
    const lid = current && current.source && current.source.lookerDashboardId;
    if (!lid) throw new Error('This dashboard was not imported from Looker, so there is nothing to re-sync.');
    const fresh = await freshDefFor(lid);
    return mergeDef(current, fresh);
  }

  return { mergeDef, freshDefFor, resync };
};
