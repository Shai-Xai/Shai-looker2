import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import EditableGrid from '../components/EditableGrid.jsx';
import FilterBar from '../components/FilterBar.jsx';
import TileEditorPanel from '../components/editor/TileEditorPanel.jsx';
import FilterManager from '../components/editor/FilterManager.jsx';
import { api } from '../lib/api.js';

export default function EditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [def, setDef] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedTileId, setSelectedTileId] = useState(null);
  const [showFilters, setShowFilters] = useState(false);
  const [filterValues, setFilterValues] = useState({});

  useEffect(() => {
    api.getDashboard(id)
      .then((data) => {
        // Older dashboards predate carousels — normalise so render code is safe.
        data.carousels = data.carousels || [];
        data.gridAfter = data.gridAfter || 0;
        setDef(data);
        const defaults = {};
        for (const f of data.filters || []) defaults[f.name] = f.default_value || '';
        setFilterValues(defaults);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  // Mutate the definition locally and mark dirty.
  const mutate = useCallback((updater) => {
    setDef((prev) => (prev ? updater(prev) : prev));
    setDirty(true);
  }, []);

  async function save() {
    setSaving(true);
    try {
      const saved = await api.updateDashboard(id, def);
      setDef(saved);
      setDirty(false);
    } catch (e) {
      alert('Save failed: ' + e.message);
    } finally {
      setSaving(false);
    }
  }

  function addTile(type) {
    const nextY = def.tiles.reduce((max, t) => Math.max(max, (t.layout?.y ?? 0) + (t.layout?.h ?? 6)), 0);
    const tile = type === 'text'
      ? { id: crypto.randomUUID(), type: 'text', title: '', body_text: '## New text tile', layout: { x: 0, y: nextY, w: 24, h: 3 }, query: null, vis: {}, listenTo: {} }
      : { id: crypto.randomUUID(), type: 'vis', title: 'New tile', body_text: '', layout: { x: 0, y: nextY, w: 8, h: 6 }, query: null, vis: { type: 'looker_column' }, listenTo: {} };
    mutate((d) => ({ ...d, tiles: [...d.tiles, tile] }));
    setSelectedTileId(tile.id);
  }

  // Update a tile wherever it lives — main grid or any carousel.
  function updateTile(updated) {
    mutate((d) => ({
      ...d,
      tiles: d.tiles.map((t) => (t.id === updated.id ? updated : t)),
      carousels: (d.carousels || []).map((c) => ({ ...c, tiles: c.tiles.map((t) => (t.id === updated.id ? updated : t)) })),
    }));
  }
  function removeTile(tileId) {
    mutate((d) => ({ ...d, tiles: d.tiles.filter((t) => t.id !== tileId) }));
    if (selectedTileId === tileId) setSelectedTileId(null);
  }
  function duplicateTile(tileId) {
    const src = def.tiles.find((t) => t.id === tileId);
    if (!src) return;
    const copy = { ...structuredClone(src), id: crypto.randomUUID(), layout: { ...src.layout, y: (src.layout?.y ?? 0) + (src.layout?.h ?? 6) } };
    mutate((d) => ({ ...d, tiles: [...d.tiles, copy] }));
  }
  // Layout changes apply to tiles AND carousels (both are grid items).
  function applyLayout(layoutMap) {
    mutate((d) => ({
      ...d,
      tiles: d.tiles.map((t) => (layoutMap[t.id] ? { ...t, layout: layoutMap[t.id] } : t)),
      carousels: (d.carousels || []).map((c) => (layoutMap[c.id] ? { ...c, layout: { ...layoutMap[c.id] } } : c)),
    }));
  }

  // ─── Carousels ───────────────────────────────────────────────────────────────
  function addCarousel() {
    const all = [...def.tiles, ...(def.carousels || [])];
    const maxY = all.reduce((m, x) => Math.max(m, (x.layout?.y ?? 0) + (x.layout?.h ?? 6)), 0);
    const c = { id: crypto.randomUUID(), title: 'New row', cardW: 300, tiles: [], layout: { x: 0, y: maxY, w: 24, h: 7 } };
    mutate((d) => ({ ...d, carousels: [...(d.carousels || []), c] }));
  }
  function removeCarousel(cid) {
    mutate((d) => ({ ...d, carousels: (d.carousels || []).filter((c) => c.id !== cid) }));
  }
  function changeCarouselTitle(cid, title) {
    mutate((d) => ({ ...d, carousels: (d.carousels || []).map((c) => (c.id === cid ? { ...c, title } : c)) }));
  }
  // Per-tile width inside a carousel (each card sized on its own).
  function setTileWidth(tileId, w) {
    mutate((d) => ({
      ...d,
      carousels: (d.carousels || []).map((c) => ({ ...c, tiles: c.tiles.map((t) => (t.id === tileId ? { ...t, cw: w } : t)) })),
    }));
  }
  function addTileToCarousel(cid, type) {
    const tile = type === 'text'
      ? { id: crypto.randomUUID(), type: 'text', title: '', body_text: '## New text tile', query: null, vis: {}, listenTo: {} }
      : { id: crypto.randomUUID(), type: 'vis', title: 'New tile', body_text: '', query: null, vis: { type: 'looker_column' }, listenTo: {} };
    mutate((d) => ({ ...d, carousels: (d.carousels || []).map((c) => (c.id === cid ? { ...c, tiles: [...c.tiles, tile] } : c)) }));
    setSelectedTileId(tile.id);
  }
  function removeTileFromCarousel(cid, tileId) {
    mutate((d) => ({ ...d, carousels: (d.carousels || []).map((c) => (c.id === cid ? { ...c, tiles: c.tiles.filter((t) => t.id !== tileId) } : c)) }));
    if (selectedTileId === tileId) setSelectedTileId(null);
  }
  // Move an existing tile (from the grid or another carousel) into a carousel.
  function moveTileToCarousel(tileId, targetId) {
    mutate((d) => {
      let moved = null;
      const tiles = d.tiles.filter((t) => { if (t.id === tileId) { moved = { ...t }; return false; } return true; });
      const carousels = (d.carousels || []).map((c) => ({
        ...c,
        tiles: c.tiles.filter((t) => { if (t.id === tileId) { moved = { ...t }; return false; } return true; }),
      }));
      if (!moved) return d;
      delete moved.layout; // carousel tiles are fixed-size cards
      return {
        ...d,
        tiles,
        carousels: carousels.map((c) => (c.id === targetId ? { ...c, tiles: [...c.tiles, moved] } : c)),
      };
    });
  }

  function duplicateTileInCarousel(cid, tileId) {
    mutate((d) => ({
      ...d,
      carousels: (d.carousels || []).map((c) => {
        if (c.id !== cid) return c;
        const src = c.tiles.find((t) => t.id === tileId);
        if (!src) return c;
        return { ...c, tiles: [...c.tiles, { ...structuredClone(src), id: crypto.randomUUID() }] };
      }),
    }));
  }

  if (loading) return <Centered>Loading…</Centered>;
  if (error) return <Centered error>Error: {error}</Centered>;
  if (!def) return null;

  const selectedTile = selectedTileId
    ? (def.tiles.find((t) => t.id === selectedTileId)
       || (def.carousels || []).flatMap((c) => c.tiles).find((t) => t.id === selectedTileId)
       || null)
    : null;
  const theme = def.theme || {};
  const carouselHandlers = (c) => ({
    onEditTile: setSelectedTileId,
    onRemoveTile: (tid) => removeTileFromCarousel(c.id, tid),
    onDuplicateTile: (tid) => duplicateTileInCarousel(c.id, tid),
    onAddTile: (type) => addTileToCarousel(c.id, type),
    onChangeTitle: (t) => changeCarouselTitle(c.id, t),
    onRemove: () => removeCarousel(c.id),
    onDropTile: (tileId) => moveTileToCarousel(tileId, c.id),
    onChangeTileW: (tileId, w) => setTileWidth(tileId, w),
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* Toolbar */}
      <div style={toolbar}>
        <Link to="/" style={{ color: 'var(--muted)', fontSize: 13, textDecoration: 'none' }}>← Back</Link>
        <input
          style={titleInput}
          value={def.title}
          onChange={(e) => mutate((d) => ({ ...d, title: e.target.value }))}
        />
        <button style={btn} onClick={() => addTile('vis')}>+ Visualization</button>
        <button style={btn} onClick={() => addTile('text')}>+ Text</button>
        <button style={btn} onClick={addCarousel}>+ Carousel</button>
        <button style={btn} onClick={() => setShowFilters(true)}>Filters ({def.filters?.length || 0})</button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: dirty ? 'var(--warn)' : 'var(--muted)' }}>
          {dirty ? '● Unsaved changes' : '✓ Saved'}
        </span>
        <button style={viewBtn} onClick={() => navigate(`/d/${id}`)}>View</button>
        <button style={saveBtn} onClick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save'}</button>
      </div>

      {/* Filter bar preview */}
      {def.filters?.length > 0 && (
        <FilterBar filters={def.filters} values={filterValues} onChange={(name, value) => setFilterValues((p) => ({ ...p, [name]: value }))} />
      )}

      {/* Canvas + side panel */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, background: theme.background || '#f5f6f8' }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px', '--tile-bg': theme.tileBackground || '#fff' }}>
          {def.tiles.length > 0 || def.carousels.length > 0 ? (
            <EditableGrid
              tiles={def.tiles}
              carousels={def.carousels}
              filterValues={filterValues}
              editable
              onLayoutChange={applyLayout}
              onEditTile={setSelectedTileId}
              onDuplicateTile={duplicateTile}
              onRemoveTile={removeTile}
              carouselHandlers={carouselHandlers}
            />
          ) : (
            <Centered>Empty dashboard — add a visualization, text tile, or carousel to begin.</Centered>
          )}
        </div>

        {selectedTile && (
          <TileEditorPanel
            key={selectedTile.id}
            tile={selectedTile}
            dashboardFilters={def.filters}
            onChange={updateTile}
            onClose={() => setSelectedTileId(null)}
          />
        )}
      </div>

      {showFilters && (
        <FilterManager
          filters={def.filters || []}
          onChange={(filters) => mutate((d) => ({ ...d, filters }))}
          onClose={() => setShowFilters(false)}
        />
      )}
    </div>
  );
}

function Centered({ children, error }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48 }}>
      <p style={{ fontSize: 15, color: error ? 'var(--error)' : 'var(--muted)' }}>{children}</p>
    </div>
  );
}

const toolbar = { background: 'rgba(255,255,255,0.72)', backdropFilter: 'saturate(180%) blur(20px)', WebkitBackdropFilter: 'saturate(180%) blur(20px)', borderBottom: '1px solid var(--hairline)', padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' };
const titleInput = { fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', border: '1px solid transparent', borderRadius: 8, padding: '6px 10px', outline: 'none', minWidth: 200, background: 'rgba(0,0,0,0.04)' };
const btn = { padding: '8px 14px', background: 'rgba(0,0,0,0.05)', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer', color: 'var(--text)' };
const viewBtn = { padding: '8px 16px', background: 'rgba(0,0,0,0.05)', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer', color: 'var(--text)' };
const saveBtn = { padding: '8px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
