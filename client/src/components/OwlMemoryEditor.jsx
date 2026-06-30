import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// ─── Owl memory editor (admin) ────────────────────────────────────────────────
// See + edit the durable facts the Owl remembers about a client. These are injected
// into every Owl answer for that client (web + WhatsApp). The Owl also proposes facts
// in chat ("Remember it"); this is the manual surface to review/curate them.
export default function OwlMemoryEditor() {
  const [ents, setEnts] = useState([]);
  const [eid, setEid] = useState('');
  const [items, setItems] = useState([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { api.adminListEntities().then((r) => setEnts(Array.isArray(r) ? r : (r.entities || []))).catch(() => setEnts([])); }, []);
  useEffect(() => { if (!eid) { setItems([]); return; } api.owlMemory(eid).then((r) => setItems(r.items || [])).catch(() => setItems([])); }, [eid]);

  const add = () => { const t = draft.trim(); if (!t) return; setItems((x) => [{ id: `new-${Date.now()}`, text: t }, ...x]); setDraft(''); };
  const removeItem = (id) => setItems((x) => x.filter((m) => m.id !== id));
  const save = async () => {
    if (!eid) return;
    setBusy(true);
    try { const r = await api.saveOwlMemory(eid, items.map((m) => ({ id: m.id, text: m.text }))); setItems(r.items || []); setSaved(true); setTimeout(() => setSaved(false), 1600); } catch { /* ignore */ }
    setBusy(false);
  };

  const fld = { padding: '6px 9px', borderRadius: 7, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 13, fontFamily: 'inherit' };

  return (
    <div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 8px' }}>Durable facts the Owl remembers about a client — its priority tier, how it defines revenue, naming conventions, what it focuses on. Injected into <strong>every</strong> Owl answer for that client (web + WhatsApp). The Owl also offers to remember things in chat; this is where you review and curate them.</p>
      <select value={eid} onChange={(e) => setEid(e.target.value)} style={{ ...fld, width: 260 }}>
        <option value="">Pick a client…</option>
        {ents.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
      </select>
      {eid && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
            <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} placeholder="Add a fact the Owl should remember…" style={{ ...fld, flex: 1 }} />
            <button onClick={add} disabled={!draft.trim()} style={{ ...fld, cursor: draft.trim() ? 'pointer' : 'default' }}>＋ Add</button>
          </div>
          {items.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--muted)', margin: '2px 0 8px' }}>Nothing remembered yet — add a fact above, or the Owl will offer to remember things as you chat.</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {items.map((m) => (
              <div key={m.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 9px', borderRadius: 8, border: '1px solid var(--hairline)', background: 'var(--card)' }}>
                <span style={{ fontSize: 13 }}>🧠</span>
                <input value={m.text} onChange={(e) => setItems((x) => x.map((z) => (z.id === m.id ? { ...z, text: e.target.value } : z)))} style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', color: 'var(--text)', fontSize: 13, fontFamily: 'inherit' }} />
                <button onClick={() => removeItem(m.id)} title="Remove" style={{ border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 13 }}>🗑</button>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
            <button onClick={save} disabled={busy} style={{ border: 'none', background: 'var(--brand)', color: '#fff', borderRadius: 8, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>{busy ? 'Saving…' : 'Save memory'}</button>
            {saved && <span style={{ fontSize: 12.5, color: '#34c759', fontWeight: 600 }}>Saved ✓</span>}
          </div>
        </div>
      )}
    </div>
  );
}
