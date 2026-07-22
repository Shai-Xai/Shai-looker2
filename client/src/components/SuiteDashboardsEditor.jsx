import { useState, useEffect, useRef, useMemo } from 'react';
import { api } from '../lib/api.js';

// Attach dashboards DIRECTLY to a suite — no set needed. Same component on both
// surfaces via the `scope` prop: 'admin' (Admin → suite editor) | 'my' (client
// Settings → Dashboards). Mobile-first: single column, ≥40px tap targets.
// The picker only ever offers this client's pool (shared + their bespoke), so a
// client can never attach another client's dashboard (server enforces the same).
export default function SuiteDashboardsEditor({ suiteId, scope = 'admin', onChange }) {
  const [pool, setPool] = useState([]);
  const [ids, setIds] = useState([]);           // ordered dashboard ids attached to the suite
  const [displayNames, setDisplayNames] = useState({}); // id -> label override (blank = native title)
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    api.suiteDashboardPool(suiteId, scope).then((d) => {
      if (!live) return;
      setPool(d.pool || []);
      const entries = d.directDashboards || [];
      setIds(entries.map((e) => e.id));
      const dn = {}; for (const e of entries) if (e.displayName) dn[e.id] = e.displayName;
      setDisplayNames(dn);
    }).catch((e) => setError(e.message || 'Could not load dashboards.'));
    return () => { live = false; };
  }, [suiteId, scope]);

  const byId = useMemo(() => Object.fromEntries(pool.map((d) => [d.id, d])), [pool]);
  const titleOf = (id) => displayNames[id] || byId[id]?.title || id;
  const toggle = (id) => setIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const remove = (id) => { setIds((cur) => cur.filter((x) => x !== id)); setDisplayNames((cur) => { const n = { ...cur }; delete n[id]; return n; }); };

  // Drag-to-reorder the attached list (array order is the rendered order).
  const dragFrom = useRef(null);
  const [dragOver, setDragOver] = useState(null);
  const onDragOverRow = (i) => {
    const from = dragFrom.current;
    if (from === null || from === i) { setDragOver(i); return; }
    setIds((cur) => { const n = cur.slice(); const [m] = n.splice(from, 1); n.splice(i, 0, m); return n; });
    dragFrom.current = i; setDragOver(i);
  };

  const save = async () => {
    setBusy(true); setError('');
    try {
      const entries = ids.map((id) => ({ id, displayName: displayNames[id] || '' }));
      await api.saveSuiteDashboards(suiteId, entries, scope);
      setSaved(true); setTimeout(() => setSaved(false), 1600);
      if (onChange) onChange();
    } catch (e) { setError(e.message || 'Could not save.'); }
    setBusy(false);
  };

  // Pool not already attached, filtered by the search box.
  const term = q.trim().toLowerCase();
  const candidates = pool
    .filter((d) => !ids.includes(d.id))
    .filter((d) => !term || (d.title || '').toLowerCase().includes(term) || (d.folder || '').toLowerCase().includes(term));

  return (
    <div>
      <p style={hint}>Dashboards attached straight to this suite show up before its sets — handy for a one-off dashboard that doesn't need a set of its own.</p>

      {/* Attached dashboards */}
      {ids.length === 0 ? (
        <div style={empty}>No dashboards attached directly yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {ids.map((id, i) => (
            <div
              key={id}
              draggable
              onDragStart={(e) => { dragFrom.current = i; e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={(e) => { e.preventDefault(); onDragOverRow(i); }}
              onDragEnd={() => { dragFrom.current = null; setDragOver(null); }}
              onDrop={(e) => { e.preventDefault(); dragFrom.current = null; setDragOver(null); }}
              style={{ ...row, background: dragOver === i ? 'rgba(var(--brand-rgb,255,56,92),0.06)' : 'var(--card)' }}
            >
              <span style={{ color: 'var(--muted)', cursor: 'grab', fontSize: 15, flexShrink: 0 }} title="Drag to reorder">⠿</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{titleOf(id)}</span>
              {!byId[id] && <span style={{ color: 'var(--muted)', fontSize: 11 }}>(unavailable)</span>}
              <button type="button" onClick={() => remove(id)} style={removeBtn} title="Remove from suite" aria-label="Remove">✕</button>
            </div>
          ))}
        </div>
      )}

      {/* Add dashboards (multi-select) */}
      {!adding ? (
        <button type="button" style={addBtn} onClick={() => setAdding(true)}>+ Add dashboard</button>
      ) : (
        <div style={picker}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search dashboards…" style={search} autoFocus />
            <button type="button" style={miniBtn} onClick={() => { setAdding(false); setQ(''); }}>Done</button>
          </div>
          <div style={{ maxHeight: 280, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
            {candidates.length === 0 ? (
              <div style={empty}>{term ? 'No matches.' : 'Every available dashboard is already attached.'}</div>
            ) : candidates.map((d) => (
              <label key={d.id} style={pickRow}>
                <input type="checkbox" checked={false} onChange={() => toggle(d.id)} style={{ width: 18, height: 18, flexShrink: 0 }} />
                <span style={{ flex: 1, overflow: 'hidden' }}>
                  <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
                  {d.folder && <span style={{ color: 'var(--muted)', fontSize: 11 }}>{d.folder}</span>}
                </span>
                {d.ownerEntityId && <span style={ownBadge}>bespoke</span>}
              </label>
            ))}
          </div>
        </div>
      )}

      {error && <div style={{ color: 'var(--error)', fontSize: 13, marginTop: 8 }}>{error}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
        <button type="button" style={saveBtn} onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save dashboards'}</button>
        {saved && <span style={{ color: 'var(--brand)', fontSize: 13, fontWeight: 600 }}>✓ Saved</span>}
      </div>
    </div>
  );
}

const hint = { color: 'var(--muted)', fontSize: 13, margin: '0 0 12px', lineHeight: 1.5 };
const empty = { color: 'var(--muted)', fontSize: 13, padding: '10px 0' };
const row = { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', minHeight: 44, border: '1px solid var(--hairline)', borderRadius: 10, fontSize: 13.5, boxSizing: 'border-box' };
const removeBtn = { border: 'none', background: 'transparent', color: 'var(--error)', cursor: 'pointer', fontSize: 15, padding: '6px 8px', flexShrink: 0, lineHeight: 1 };
const addBtn = { border: '1.5px dashed var(--hairline)', background: 'transparent', color: 'var(--text)', borderRadius: 10, padding: '11px 16px', minHeight: 44, fontSize: 14, fontWeight: 600, cursor: 'pointer', width: '100%' };
const picker = { border: '1px solid var(--hairline)', borderRadius: 12, padding: 12, background: 'var(--surface)' };
const search = { flex: 1, padding: '10px 12px', minHeight: 40, borderRadius: 10, border: '1.5px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 14, boxSizing: 'border-box' };
const miniBtn = { border: '1.5px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 980, padding: '8px 14px', minHeight: 40, fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0 };
const pickRow = { display: 'flex', alignItems: 'center', gap: 10, padding: '9px 4px', minHeight: 44, borderBottom: '1px solid var(--hairline)', fontSize: 13.5, cursor: 'pointer', boxSizing: 'border-box' };
const ownBadge = { fontSize: 10, fontWeight: 700, color: 'var(--brand)', border: '1px solid var(--brand)', borderRadius: 980, padding: '1px 7px', flexShrink: 0 };
const saveBtn = { background: 'var(--brand)', color: '#fff', border: '1px solid var(--brand)', borderRadius: 980, padding: '10px 20px', minHeight: 44, fontSize: 14, fontWeight: 700, cursor: 'pointer' };
