// ─── Tile library — harvest + curation (factory library) ───────────────────────
// Extracted from server/db.js (line-budget discipline): everything that touches
// the `tile_library` table. Tiles are harvested from imported dashboards, deduped
// by a stable signature over their query + vis, given friendly derived labels
// (until a human/AI curates them), and stamped into new dashboards from the
// library. db.js spreads this factory's return into its own exports, so callers
// are unchanged.
//
// Usage: `require('./tileLibrary')(db, { uuid, now, J })` — db is the raw
// better-sqlite3 handle; uuid/now/J are db.js's id, timestamp and JSON helpers.

const crypto = require('crypto');

module.exports = (db, { uuid, now, J }) => {
  // A stable signature for a tile's underlying query + visualization, used to
  // dedupe the same tile imported from many dashboards.
  function tileSignature(tile) {
    const q = tile.query || {};
    const parts = [
      q.model || '', q.view || '',
      (q.fields || []).slice().sort().join(','),
      (q.pivots || []).join(','),
      tile.vis?.type || '',
    ];
    return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
  }

  // Friendly defaults derived from the query, used until a human/AI improves them.
  const VIS_LABELS = {
    looker_column: 'Column chart', looker_bar: 'Bar chart', looker_line: 'Line chart',
    looker_area: 'Area chart', looker_scatter: 'Scatter chart', looker_pie: 'Pie chart',
    looker_donut_multiples: 'Donut chart', looker_grid: 'Table', table: 'Table',
    looker_single_record: 'Record', single_value: 'Single value', looker_funnel: 'Funnel',
    looker_map: 'Map', looker_geo_choropleth: 'Map', looker_timeline: 'Timeline', text: 'Text',
  };
  function shortField(f) { const i = f.indexOf('.'); return i >= 0 ? f.slice(i + 1).replace(/_/g, ' ') : f; }
  function deriveFieldsSummary(tile) {
    const fields = (tile.query?.fields || []).map(shortField);
    return fields.join(', ');
  }
  function deriveName(tile) {
    if (tile.title && tile.title.trim()) return tile.title.trim();
    const vis = VIS_LABELS[tile.vis?.type] || 'Visualization';
    const fs = deriveFieldsSummary(tile);
    return fs ? `${vis}: ${fs}` : vis;
  }
  function deriveDescription(tile) {
    const vis = VIS_LABELS[tile.vis?.type] || 'Visualization';
    const fs = deriveFieldsSummary(tile);
    return fs ? `${vis} showing ${fs}.` : `${vis}.`;
  }

  function rowToLibraryTile(r) {
    if (!r) return null;
    return {
      id: r.id, signature: r.signature, name: r.name, description: r.description,
      category: r.category, visType: r.vis_type, fieldsSummary: r.fields_summary,
      model: r.model, explore: r.explore, def: J(r.def, {}),
      sourceDashboardId: r.source_dashboard_id, sourceTitle: r.source_title,
      usageCount: r.usage_count, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }
  function listLibraryTiles({ search, category } = {}) {
    let rows = db.prepare('SELECT * FROM tile_library ORDER BY usage_count DESC, name').all();
    if (category) rows = rows.filter((r) => r.category === category);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((r) => `${r.name} ${r.description} ${r.fields_summary} ${r.category}`.toLowerCase().includes(q));
    }
    return rows.map(rowToLibraryTile);
  }
  function listLibraryCategories() {
    return db.prepare("SELECT DISTINCT category FROM tile_library WHERE category != '' ORDER BY category").all().map((r) => r.category);
  }
  function getLibraryTile(id) { return rowToLibraryTile(db.prepare('SELECT * FROM tile_library WHERE id=?').get(id)); }

  // Harvest a single tile into the library. Skips non-query tiles. Returns the
  // library row (existing or newly created); never overwrites a curated label.
  function harvestTile(tile, { sourceDashboardId, sourceTitle } = {}) {
    if (!tile || tile.type === 'text' || !tile.query?.model) return null;
    const signature = tileSignature(tile);
    const existing = db.prepare('SELECT * FROM tile_library WHERE signature=?').get(signature);
    if (existing) return rowToLibraryTile(existing);
    const ts = now();
    const id = uuid();
    // Store a clean, position-free copy of the tile to stamp into new dashboards.
    const { id: _i, layout: _l, ...tileDef } = tile;
    db.prepare(`INSERT INTO tile_library
      (id,signature,name,description,category,vis_type,fields_summary,model,explore,def,source_dashboard_id,source_title,usage_count,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`).run(
      id, signature, deriveName(tile), deriveDescription(tile), '', tile.vis?.type || '',
      deriveFieldsSummary(tile), tile.query?.model || null, tile.query?.view || null,
      JSON.stringify(tileDef), sourceDashboardId || null, sourceTitle || null, ts, ts,
    );
    return getLibraryTile(id);
  }
  // Harvest all tiles of a dashboard definition. Returns how many were newly added.
  function harvestDashboardTiles(def, { sourceDashboardId } = {}) {
    let added = 0;
    const all = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
    const before = db.prepare('SELECT COUNT(*) c FROM tile_library').get().c;
    for (const t of all) harvestTile(t, { sourceDashboardId, sourceTitle: def.title });
    added = db.prepare('SELECT COUNT(*) c FROM tile_library').get().c - before;
    return added;
  }
  function updateLibraryTile(id, patch) {
    const cur = db.prepare('SELECT * FROM tile_library WHERE id=?').get(id);
    if (!cur) return null;
    const name = patch.name ?? cur.name;
    const description = patch.description ?? cur.description;
    const category = patch.category ?? cur.category;
    db.prepare('UPDATE tile_library SET name=?, description=?, category=?, updated_at=? WHERE id=?')
      .run(name, description, category, now(), id);
    return getLibraryTile(id);
  }
  function deleteLibraryTile(id) { return db.prepare('DELETE FROM tile_library WHERE id=?').run(id).changes > 0; }
  function bumpLibraryUsage(id) { db.prepare('UPDATE tile_library SET usage_count = usage_count + 1 WHERE id=?').run(id); }

  return { tileSignature, listLibraryTiles, listLibraryCategories, getLibraryTile, harvestTile, harvestDashboardTiles, updateLibraryTile, deleteLibraryTile, bumpLibraryUsage };
};
