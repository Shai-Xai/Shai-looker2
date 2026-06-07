import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import EditableGrid from '../components/EditableGrid.jsx';
import Carousel from '../components/Carousel.jsx';
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
  const [tenants, setTenants] = useState([]);

  useEffect(() => {
    api.getDashboard(id)
      .then((data) => {
        setDef(data);
        const defaults = {};
        for (const f of data.filters || []) defaults[f.name] = f.default_value || '';
        setFilterValues(defaults);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    api.listTenants().then(setTenants).catch(() => {});
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
  function applyLayout(layoutMap) {
    mutate((d) => ({
      ...d,
      tiles: d.tiles.map((t) => (layoutMap[t.id] ? { ...t, layout: layoutMap[t.id] } : t)),
    }));
  }

  // ─── Carousels ───────────────────────────────────────────────────────────────
  function addCarousel() {
    const c = { id: crypto.randomUUID(), title: 'New row', cardW: 320, cardH: 200, tiles: [] };
    mutate((d) => ({ ...d, carousels: [...(d.carousels || []), c] }));
  }
  function removeCarousel(cid) {
    mutate((d) => ({ ...d, carousels: (d.carousels || []).filter((c) => c.id !== cid) }));
  }
  function changeCarouselTitle(cid, title) {
    mutate((d) => ({ ...d, carousels: (d.carousels || []).map((c) => (c.id === cid ? { ...c, title } : c)) }));
  }
  function setCarouselSize(cid, patch) {
    mutate((d) => ({ ...d, carousels: (d.carousels || []).map((c) => (c.id === cid ? { ...c, ...patch } : c)) }));
  }
  // Move a carousel up/down through the combined order of [carousels above the
  // grid, the GRID, carousels below the grid]. gridAfter = how many carousels
  // render above the grid. Crossing the grid boundary flips a carousel from
  // below to above (or vice-versa) without reordering the array.
  function moveCarousel(cid, dir) {
    mutate((d) => {
      const cs = [...(d.carousels || [])];
      let ga = d.gridAfter ?? 0;
      const i = cs.findIndex((c) => c.id === cid);
      if (i < 0) return d;
      if (dir === -1) {
        if (i === ga) ga += 1;                       // first below grid → above grid
        else if (i > 0) { [cs[i], cs[i - 1]] = [cs[i - 1], cs[i]]; } // swap within section
        else return d;
      } else {
        if (i === ga - 1) ga -= 1;                   // last above grid → below grid
        else if (i < cs.length - 1) { [cs[i], cs[i + 1]] = [cs[i + 1], cs[i]]; }
        else return d;
      }
      return { ...d, carousels: cs, gridAfter: Math.max(0, Math.min(cs.length, ga)) };
    });
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
  const ga = def.gridAfter || 0;
  const renderCarousel = (c, idx) => {
    const ci = idx < ga ? idx : idx + 1; // index in combined order (grid counts as 1 slot)
    return (
      <Carousel
        key={c.id}
        carousel={c}
        filterValues={filterValues}
        editable
        onEditTile={setSelectedTileId}
        onRemoveTile={(tid) => removeTileFromCarousel(c.id, tid)}
        onDuplicateTile={(tid) => duplicateTileInCarousel(c.id, tid)}
        onAddTile={(type) => addTileToCarousel(c.id, type)}
        onChangeTitle={(t) => changeCarouselTitle(c.id, t)}
        onRemove={() => removeCarousel(c.id)}
        onDropTile={(tileId) => moveTileToCarousel(tileId, c.id)}
        onChangeSize={(patch) => setCarouselSize(c.id, patch)}
        onMoveUp={() => moveCarousel(c.id, -1)}
        onMoveDown={() => moveCarousel(c.id, 1)}
        canMoveUp={ci > 0}
        canMoveDown={ci < def.carousels.length}
      />
    );
  };

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
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
          Visible to:
          <select
            style={{ ...btn, padding: '7px 10px', cursor: 'pointer' }}
            value={def.tenantId || ''}
            onChange={(e) => mutate((d) => ({ ...d, tenantId: e.target.value || null }))}
          >
            <option value="">All clients (shared)</option>
            {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
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
          {def.carousels.slice(0, ga).map((c, i) => renderCarousel(c, i))}

          {def.tiles.length > 0 && (
            <EditableGrid
              tiles={def.tiles}
              filterValues={filterValues}
              editable
              onLayoutChange={applyLayout}
              onEditTile={setSelectedTileId}
              onDuplicateTile={duplicateTile}
              onRemoveTile={removeTile}
            />
          )}

          {def.carousels.slice(ga).map((c, i) => renderCarousel(c, ga + i))}

          {def.tiles.length === 0 && def.carousels.length === 0 && (
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

const toolbar = { background: '#fff', borderBottom: '1px solid #e0e0e0', padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' };
const titleInput = { fontSize: 16, fontWeight: 700, border: '1.5px solid transparent', borderRadius: 6, padding: '5px 8px', outline: 'none', minWidth: 200, background: '#fafafa' };
const btn = { padding: '7px 12px', background: '#fff', border: '1.5px solid #e0e0e0', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const viewBtn = { padding: '7px 14px', background: '#fff', border: '1.5px solid #e0e0e0', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const saveBtn = { padding: '7px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: 'pointer' };
