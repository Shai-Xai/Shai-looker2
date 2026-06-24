import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api.js';
import { lockableFilters } from '../lib/tileLockFields.js';

// Admin: lock one tile's filter(s) to a specific value for THIS client, written
// to suite.tileLocks[tileId]. Every dashboard filter applicable to this tile is
// offered (its wired `listenTo` filters PLUS any whose field the tile's query
// uses); each lock overrides the dashboard value for that one tile.
export default function TileLockModal({ tile, filters, suiteId, current, onSave, onClose }) {
  const fields = lockableFilters(tile, filters || []);
  const [vals, setVals] = useState(() => ({ ...(current || {}) }));
  const [saving, setSaving] = useState(false);

  const setVal = (name, v) => setVals((p) => { const n = { ...p }; if (v && String(v).trim()) n[name] = v; else delete n[name]; return n; });
  const save = async () => {
    setSaving(true);
    const ok = await onSave(tile.id, vals);
    setSaving(false);
    if (ok) onClose();
  };

  return createPortal(
    <div style={overlay} onClick={onClose}>
      <div style={card} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <div style={{ fontSize: 16, fontWeight: 700, flex: 1 }}>🔒 Lock this tile’s filters</div>
          <button onClick={onClose} style={xBtn} aria-label="Close">✕</button>
        </div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>
          Pin a filter on <b>{tile.title || 'this tile'}</b> for this client only — it overrides the dashboard’s value for this one tile. Leave blank to follow the dashboard.
        </div>
        {fields.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>This tile doesn’t listen to any dashboard filters, so there’s nothing to lock. Wire it to a filter in the tile editor first.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {fields.map((f) => (
              <ValueRow key={f.name} filter={f} suiteId={suiteId} value={vals[f.name] || ''} onChange={(v) => setVal(f.name, v)} />
            ))}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 18 }}>
          <button style={saveBtn} onClick={save} disabled={saving || fields.length === 0}>{saving ? 'Saving…' : 'Save locks'}</button>
          <button style={linkBtn} onClick={onClose}>Cancel</button>
          {Object.keys(vals).length > 0 && <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>{Object.keys(vals).length} locked</span>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// One filter row: chip for the current value + a searchable picker (Looker
// suggestions scoped to the suite). Single value (comma-separate for several).
function ValueRow({ filter, suiteId, value, onChange }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const field = filter.field || filter.dimension;
  const canSuggest = !!(filter.model && filter.explore && field);

  useEffect(() => {
    if (!open || !canSuggest) return;
    let alive = true;
    setLoading(true);
    const t = setTimeout(async () => {
      try { const d = await api.filterSuggest({ model: filter.model, explore: filter.explore, field, q, suiteId, pair: true }); if (alive) setResults(d.suggestions || []); }
      catch { if (alive) setResults([]); }
      finally { if (alive) setLoading(false); }
    }, 280);
    return () => { alive = false; clearTimeout(t); };
  }, [q, open, canSuggest, field, filter.model, filter.explore, suiteId]);

  const norm = (s) => (typeof s === 'string' ? { value: s, label: s } : { value: String(s.value), label: s.label || String(s.value) });

  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginBottom: 5 }}>{filter.title || filter.name}</div>
      {value && (
        <div style={{ marginBottom: 6 }}>
          <span style={chip}>{value}<span style={{ cursor: 'pointer', fontWeight: 700 }} onClick={() => onChange('')}> ✕</span></span>
        </div>
      )}
      <div style={{ position: 'relative' }}>
        <input
          style={input}
          value={open ? q : value}
          onChange={(e) => { setQ(e.target.value); if (!open) setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) { onChange(q.trim()); setQ(''); setOpen(false); } }}
          placeholder={canSuggest ? 'Search values…' : 'Type a value, Enter to set'}
        />
        {open && (
          <ul style={ddList}>
            {!canSuggest ? <li style={ddMuted}>Type a value and press Enter</li>
              : loading ? <li style={ddMuted}>Searching…</li>
                : results.length === 0 ? <li style={ddMuted}>{q ? 'No matches — Enter to use as typed' : 'Type to search…'}</li>
                  : results.map((raw, i) => { const o = norm(raw); return (
                    <li key={i} style={ddItem} onMouseDown={(e) => { e.preventDefault(); onChange(o.value); setQ(''); setOpen(false); }}>{o.label}</li>
                  ); })}
          </ul>
        )}
      </div>
    </div>
  );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 600, padding: 20 };
const card = { width: 'min(460px, 96vw)', maxHeight: '86vh', overflowY: 'auto', background: 'var(--card)', borderRadius: 14, boxShadow: '0 12px 48px rgba(0,0,0,0.25)', padding: 20 };
const xBtn = { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 16, color: 'var(--muted)' };
const input = { width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', background: 'var(--card)', color: 'var(--text)' };
const chip = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 980, fontSize: 12.5, fontWeight: 600, background: 'rgba(var(--brand-rgb,255,56,92),0.10)', color: 'var(--brand)', border: '1px solid rgba(var(--brand-rgb,255,56,92),0.30)' };
const ddList = { position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, marginTop: 4, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 6px 20px rgba(0,0,0,0.12)', maxHeight: 220, overflowY: 'auto', listStyle: 'none', margin: 0, padding: '4px 0' };
const ddItem = { padding: '8px 11px', cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const ddMuted = { padding: '8px 11px', fontSize: 13, color: 'var(--muted)' };
const saveBtn = { padding: '8px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const linkBtn = { padding: '8px 12px', background: 'transparent', color: 'var(--text)', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
