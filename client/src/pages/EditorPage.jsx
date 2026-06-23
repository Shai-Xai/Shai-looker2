import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import EditableGrid from '../components/EditableGrid.jsx';
import FilterBar from '../components/FilterBar.jsx';
import TileEditorPanel from '../components/editor/TileEditorPanel.jsx';
import FilterManager from '../components/editor/FilterManager.jsx';
import TileLibraryPicker from '../components/editor/TileLibraryPicker.jsx';
import BackButton from '../components/BackButton.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

export default function EditorPage() {
  const { id, suiteId } = useParams();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  // Where "View" / Save-and-return goes — back to the suite view when we got
  // here from inside a suite, otherwise the standalone dashboard view.
  const viewPath = suiteId ? `/suite/${suiteId}/d/${id}` : `/d/${id}`;
  const [def, setDef] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedTileId, setSelectedTileId] = useState(null);
  const [showFilters, setShowFilters] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showAiContext, setShowAiContext] = useState(false);
  const [showDaysSync, setShowDaysSync] = useState(false);
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

  // Stamp a copy of a library tile into the dashboard, positioned at the bottom.
  function addLibraryTile(libTile) {
    const nextY = def.tiles.reduce((max, t) => Math.max(max, (t.layout?.y ?? 0) + (t.layout?.h ?? 6)), 0);
    const base = libTile.def || {};
    const tile = {
      ...structuredClone(base),
      id: crypto.randomUUID(),
      type: base.type || 'vis',
      title: base.title || libTile.name || 'New tile',
      layout: { x: 0, y: nextY, w: base.layout?.w ?? 8, h: base.layout?.h ?? 6 },
      vis: base.vis || { type: 'looker_column' },
      listenTo: base.listenTo || {},
    };
    mutate((d) => ({ ...d, tiles: [...d.tiles, tile] }));
    setSelectedTileId(tile.id);
    setShowLibrary(false);
    api.libraryUse(libTile.id).catch(() => {});
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

  // ─── Carousels & sections ─────────────────────────────────────────────────────
  // A "section" is the same container as a carousel but with mode 'grid' — its
  // tiles flow in a wrapping grid instead of a horizontal scroller.
  function addContainer(mode) {
    const all = [...def.tiles, ...(def.carousels || [])];
    const maxY = all.reduce((m, x) => Math.max(m, (x.layout?.y ?? 0) + (x.layout?.h ?? 6)), 0);
    const c = {
      id: crypto.randomUUID(),
      title: mode === 'grid' ? 'New section' : 'New row',
      mode: mode === 'grid' ? 'grid' : undefined,
      cardW: 300, tiles: [],
      layout: { x: 0, y: maxY, w: 24, h: mode === 'grid' ? 9 : 7 },
    };
    mutate((d) => ({ ...d, carousels: [...(d.carousels || []), c] }));
  }
  function addCarousel() { addContainer('carousel'); }
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
  // Free-form layout of tiles inside a grid "section".
  function setSectionTileLayouts(cid, map) {
    mutate((d) => ({
      ...d,
      carousels: (d.carousels || []).map((c) => (c.id === cid
        ? { ...c, tiles: c.tiles.map((t) => (map[t.id] ? { ...t, layout: { ...(t.layout || {}), ...map[t.id] } } : t)) }
        : c)),
    }));
  }
  function addTileToCarousel(cid, type) {
    // For grid sections, auto-place the new tile beside the others (rows of 3
    // for vis tiles) so they sit side by side; scrolling carousels ignore layout.
    const cur = (def.carousels || []).find((x) => x.id === cid);
    const n = cur ? cur.tiles.length : 0;
    const w = type === 'text' ? 24 : 8;
    const perRow = Math.max(1, Math.floor(24 / w));
    const layout = { x: (n % perRow) * w, y: Math.floor(n / perRow) * 6, w, h: type === 'text' ? 3 : 6 };
    const tile = type === 'text'
      ? { id: crypto.randomUUID(), type: 'text', title: '', body_text: '## New text tile', query: null, vis: {}, listenTo: {}, layout }
      : { id: crypto.randomUUID(), type: 'vis', title: 'New tile', body_text: '', query: null, vis: { type: 'looker_column' }, listenTo: {}, layout };
    mutate((d) => ({ ...d, carousels: (d.carousels || []).map((c) => (c.id === cid ? { ...c, tiles: [...c.tiles, tile] } : c)) }));
    setSelectedTileId(tile.id);
  }
  function removeTileFromCarousel(cid, tileId) {
    mutate((d) => ({ ...d, carousels: (d.carousels || []).map((c) => (c.id === cid ? { ...c, tiles: c.tiles.filter((t) => t.id !== tileId) } : c)) }));
    if (selectedTileId === tileId) setSelectedTileId(null);
  }
  // Move an existing tile (from the grid or another carousel) into a carousel.
  // Move/insert a tile into a carousel. `beforeId` (a tile id, or '__end__'/null)
  // sets the drop position, so this powers both dragging a tile IN and dragging
  // to REORDER within the same carousel (drop position preserved, no index drift
  // since we resolve by id after removing the dragged tile).
  function moveTileToCarousel(tileId, targetId, beforeId = null) {
    mutate((d) => {
      let moved = null;
      const tiles = d.tiles.filter((t) => { if (t.id === tileId) { moved = { ...t }; return false; } return true; });
      const carousels = (d.carousels || []).map((c) => ({
        ...c,
        tiles: c.tiles.filter((t) => { if (t.id === tileId) { moved = { ...t }; return false; } return true; }),
      }));
      if (!moved) return d;
      // Cap the width to half so it can sit beside another tile. Grid sections use
      // this layout; scrolling carousels ignore it (they size by card width).
      moved.layout = { x: 0, y: 9999, w: Math.min(moved.layout?.w || 8, 12), h: moved.layout?.h || 6 };
      return {
        ...d,
        tiles,
        carousels: carousels.map((c) => {
          if (c.id !== targetId) return c;
          const arr = c.tiles.slice();
          let idx = arr.length;
          if (beforeId && beforeId !== '__end__') { const j = arr.findIndex((t) => t.id === beforeId); if (j >= 0) idx = j; }
          arr.splice(idx, 0, moved);
          return { ...c, tiles: arr };
        }),
      };
    });
  }

  // Move a tile OUT of a carousel/section back onto the main dashboard grid,
  // keeping the tile (the inverse of moveTileToCarousel). Lands it full-ish width
  // at the bottom of the grid.
  function moveTileOutOfCarousel(cid, tileId) {
    mutate((d) => {
      let moved = null;
      const carousels = (d.carousels || []).map((c) => {
        if (c.id !== cid) return c;
        return { ...c, tiles: c.tiles.filter((t) => { if (t.id === tileId) { moved = { ...t }; return false; } return true; }) };
      });
      if (!moved) return d;
      const nextY = d.tiles.reduce((max, t) => Math.max(max, (t.layout?.y ?? 0) + (t.layout?.h ?? 6)), 0);
      moved.layout = { x: 0, y: nextY, w: Math.min(moved.layout?.w || 8, 12), h: moved.layout?.h || 6 };
      return { ...d, tiles: [...d.tiles, moved], carousels };
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

  // The editor is a Howler-staff tool. Mounted on client routes only so an admin
  // acting as a client can reach it; a real client who deep-links here is sent home.
  if (!isAdmin) return <Navigate to={viewPath} replace />;
  if (loading) return <Centered>Loading…</Centered>;
  if (error) return <Centered error>Error: {error}</Centered>;
  if (!def) return null;

  const selectedTile = selectedTileId
    ? (def.tiles.find((t) => t.id === selectedTileId)
       || (def.carousels || []).flatMap((c) => c.tiles).find((t) => t.id === selectedTileId)
       || null)
    : null;
  const theme = def.theme || {};
  const dark = document.documentElement.dataset.theme === 'dark';
  const canvasBg = dark ? 'var(--bg)' : (theme.background || '#f5f6f8');
  // Omit --tile-bg in dark so tiles inherit the global dark token (avoids a
  // self-referential var cycle).
  const canvasInner = { flex: 1, overflowY: 'auto', padding: '16px 24px', ...(dark ? null : { '--tile-bg': theme.tileBackground || '#fff' }) };
  const carouselHandlers = (c) => ({
    onEditTile: setSelectedTileId,
    onRemoveTile: (tid) => removeTileFromCarousel(c.id, tid),
    onDuplicateTile: (tid) => duplicateTileInCarousel(c.id, tid),
    onAddTile: (type) => addTileToCarousel(c.id, type),
    onChangeTitle: (t) => changeCarouselTitle(c.id, t),
    onRemove: () => removeCarousel(c.id),
    onDropTile: (tileId, beforeId) => moveTileToCarousel(tileId, c.id, beforeId),
    onMoveTileOut: (tid) => moveTileOutOfCarousel(c.id, tid),
    onChangeTileW: (tileId, w) => setTileWidth(tileId, w),
    onTileLayout: (map) => setSectionTileLayouts(c.id, map),
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* Toolbar */}
      <div style={toolbar}>
        <BackButton fallback={viewPath} title="Back" />
        <input
          style={titleInput}
          value={def.title}
          onChange={(e) => mutate((d) => ({ ...d, title: e.target.value }))}
        />
        <button style={btn} onClick={() => addTile('vis')}>+ Visualization</button>
        <button style={btn} onClick={() => setShowLibrary(true)}>+ From library</button>
        <button style={btn} onClick={() => addTile('text')}>+ Text</button>
        <button style={btn} onClick={() => addContainer('grid')}>+ Section</button>
        <button style={btn} onClick={addCarousel}>+ Carousel</button>
        <button style={btn} onClick={() => setShowFilters(true)}>Filters ({def.filters?.length || 0})</button>
        <button style={btn} onClick={() => setShowAiContext(true)}>✨ AI context</button>
        <button style={btn} onClick={() => setShowDaysSync(true)}>⏳ Days-to-go{def.daysBeforeSync?.mode && def.daysBeforeSync.mode !== 'off' ? ' ●' : ''}</button>
        <button
          style={{ ...btn, ...(def.keepImportedFilters ? { background: 'var(--success,#10b981)', borderColor: 'var(--success,#10b981)', color: '#fff' } : null) }}
          onClick={() => mutate((d) => ({ ...d, keepImportedFilters: !d.keepImportedFilters }))}
          title={`Use this dashboard's imported (Looker) default filters as authoritative — client defaults, saved user views and suite locks won't override them. Live in-session changes still apply.${def.folderKeepImported ? '\n\nNote: its folder also pins imported filters, so this stays ON for viewers regardless.' : ''}`}>
          📌 Imported filters: {def.keepImportedFilters ? 'On' : 'Off'}{def.folderKeepImported && !def.keepImportedFilters ? ' (on via folder)' : ''}
        </button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: dirty ? 'var(--warn)' : 'var(--muted)' }}>
          {dirty ? '● Unsaved changes' : '✓ Saved'}
        </span>
        <button style={viewBtn} onClick={() => navigate(viewPath)}>View</button>
        <button className="btn-key" style={saveBtn} onClick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save'}</button>
      </div>

      {/* Filter bar preview */}
      {def.filters?.length > 0 && (
        <FilterBar filters={def.filters} values={filterValues} onChange={(name, value) => setFilterValues((p) => ({ ...p, [name]: value }))} />
      )}

      {/* Canvas + side panel */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, background: canvasBg }}>
        <div style={canvasInner}>
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

      {showLibrary && (
        <TileLibraryPicker onPick={addLibraryTile} onClose={() => setShowLibrary(false)} />
      )}

      {showAiContext && (
        <div style={aiOverlay} onClick={() => setShowAiContext(false)}>
          <div style={aiCard} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Dashboard AI context</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>Background for this dashboard, used by AI insights and the dashboard summary (on top of the global and per-client context). Saved with the dashboard.</div>
            <textarea
              autoFocus
              value={def.aiContext || ''}
              onChange={(e) => mutate((d) => ({ ...d, aiContext: e.target.value }))}
              rows={7}
              placeholder={"e.g. This is the cashless overview. 'With Tokens' includes pre-loaded balances. Compare current vs previous event. Day numbers are festival days, not calendar days."}
              style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
              <button style={saveBtn} onClick={() => setShowAiContext(false)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {showDaysSync && (
        <DaysBeforeSyncModal def={def} onChange={(sync) => mutate((d) => ({ ...d, daysBeforeSync: sync }))} onClose={() => setShowDaysSync(false)} />
      )}
    </div>
  );
}

// Per-dashboard "days to go" sync. Reads the current days-before-event number
// live from a source tile (no manual date), shows it next to the title, and —
// when set to Auto-apply — sets the days-before filter so YoY tiles align to
// today's point in the sales cycle.
function DaysBeforeSyncModal({ def, onChange, onClose }) {
  const sync = def.daysBeforeSync || { mode: 'off', filterName: '', sourceTileId: '', expr: '>={n}' };
  const set = (patch) => onChange({ ...sync, ...patch });
  const visTiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))]
    .filter((t) => t.type !== 'text' && t.query?.fields?.length);
  return (
    <div style={aiOverlay} onClick={onClose}>
      <div style={aiCard} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>⏳ Days-to-go sync</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>
          Reads the current days-before-event number live from a tile and shows it as “N days to go”. Auto-apply also sets the days-before filter so YoY comparisons align to today’s point in the cycle.
        </div>

        <L>Mode</L>
        <select style={fInput} value={sync.mode} onChange={(e) => set({ mode: e.target.value })}>
          <option value="off">Off</option>
          <option value="heading">Show “N days to go” only</option>
          <option value="apply">Auto-apply to the days-before filter (+ show)</option>
        </select>

        {sync.mode !== 'off' && (
          <>
            <L>Source tile — its single value is the days-to-go</L>
            <select style={fInput} value={sync.sourceTileId} onChange={(e) => set({ sourceTileId: e.target.value })}>
              <option value="">Select a tile…</option>
              {visTiles.map((t) => <option key={t.id} value={t.id}>{t.title || '(untitled)'}</option>)}
            </select>
          </>
        )}

        {sync.mode === 'apply' && (
          <>
            <L>Days-before filter to set</L>
            <select style={fInput} value={sync.filterName} onChange={(e) => set({ filterName: e.target.value })}>
              <option value="">Select a filter…</option>
              {(def.filters || []).map((f) => <option key={f.id || f.name} value={f.name}>{f.title || f.name}</option>)}
            </select>
            <L>Filter expression — {'{n}'} is replaced with the number</L>
            <input style={fInput} value={sync.expr || '>={n}'} onChange={(e) => set({ expr: e.target.value })} placeholder=">={n}" />
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>e.g. <code>{'>={n}'}</code> includes everything from N+ days out (usual YoY-to-date); or <code>{'<={n}'}</code>, or just <code>{'{n}'}</code>.</div>
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button style={saveBtn} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
function L({ children }) {
  return <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', margin: '10px 0 4px' }}>{children}</div>;
}
const fInput = { width: '100%', boxSizing: 'border-box', padding: '8px 11px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', fontFamily: 'inherit', background: 'var(--card)', color: 'var(--text)' };

function Centered({ children, error }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48 }}>
      <p style={{ fontSize: 15, color: error ? 'var(--error)' : 'var(--muted)' }}>{children}</p>
    </div>
  );
}

const toolbar = { background: 'var(--frost)', backdropFilter: 'saturate(180%) blur(20px)', WebkitBackdropFilter: 'saturate(180%) blur(20px)', borderBottom: '1px solid var(--hairline)', padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' };
const titleInput = { fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', border: '1px solid transparent', borderRadius: 8, padding: '6px 10px', outline: 'none', minWidth: 200, background: 'rgba(0,0,0,0.04)' };
const btn = { padding: '8px 14px', background: 'rgba(0,0,0,0.05)', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer', color: 'var(--text)' };
const viewBtn = { padding: '8px 16px', background: 'rgba(0,0,0,0.05)', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer', color: 'var(--text)' };
const saveBtn = { padding: '8px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const aiOverlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 500, padding: 20 };
const aiCard = { width: 'min(560px, 96vw)', background: 'var(--card)', borderRadius: 14, boxShadow: '0 12px 48px rgba(0,0,0,0.25)', padding: 22 };
