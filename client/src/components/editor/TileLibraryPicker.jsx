import { useState, useEffect } from 'react';
import { api } from '../../lib/api.js';

// Modal picker over the reusable tile library. The admin searches/filters and
// clicks a tile to stamp a copy into the dashboard they're editing.
export default function TileLibraryPicker({ onPick, onClose }) {
  const [tiles, setTiles] = useState([]);
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.libraryList({ search, category })
      .then((r) => { setTiles(r.tiles || []); setCategories(r.categories || []); })
      .catch(() => setTiles([]))
      .finally(() => setLoading(false));
  }, [search, category]);

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>Tile library</div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>Add a tile from the library</div>
          </div>
          <button style={closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div style={{ display: 'flex', gap: 8, padding: '12px 18px', borderBottom: '1px solid var(--hairline)' }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tiles…" style={searchInput} autoFocus />
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={select}>
            <option value="">All categories</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div style={list}>
          {loading ? (
            <div style={muted}>Loading…</div>
          ) : tiles.length === 0 ? (
            <div style={muted}>No tiles in the library yet. Import a dashboard, or run “Harvest existing” in Admin → Library.</div>
          ) : (
            tiles.map((t) => (
              <div key={t.id} style={card} className="lift">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 14, fontWeight: 700 }}>{t.name}</span>
                    {t.category && <span style={tag}>{t.category}</span>}
                    <span style={visTag}>{t.visType || 'vis'}</span>
                  </div>
                  {t.description && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.45 }}>{t.description}</div>}
                  {t.fieldsSummary && <div style={{ fontSize: 11, color: 'var(--muted-2, #999)', marginTop: 3 }}>{t.fieldsSummary}</div>}
                </div>
                <button style={addBtn} onClick={() => onPick(t)}>Add</button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 500, padding: 20 };
const panel = { width: 'min(640px, 96vw)', maxHeight: '86vh', background: 'var(--card)', borderRadius: 16, boxShadow: '0 12px 48px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', overflow: 'hidden' };
const header = { display: 'flex', alignItems: 'center', gap: 12, padding: '16px 18px', borderBottom: '1px solid var(--border)' };
const closeBtn = { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 17, color: '#888' };
const searchInput = { flex: 1, border: '1px solid var(--hairline)', borderRadius: 10, padding: '9px 12px', fontSize: 14, outline: 'none' };
const select = { border: '1px solid var(--hairline)', borderRadius: 10, padding: '9px 12px', fontSize: 13, outline: 'none', background: 'var(--card)' };
const list = { flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 };
const card = { display: 'flex', alignItems: 'center', gap: 12, border: '1px solid var(--border, #eee)', borderRadius: 12, padding: '12px 14px', background: 'var(--card, #fff)' };
const addBtn = { flexShrink: 0, padding: '8px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const tag = { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--brand)', background: '#fff0f3', borderRadius: 6, padding: '2px 6px' };
const visTag = { fontSize: 10, fontWeight: 600, color: 'var(--muted)', background: 'rgba(0,0,0,0.05)', borderRadius: 6, padding: '2px 6px' };
const muted = { color: 'var(--muted)', fontSize: 13, padding: 24, textAlign: 'center' };
