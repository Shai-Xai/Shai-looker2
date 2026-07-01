import { useEffect, useState, useMemo } from 'react';
import { api } from '../lib/api.js';

// ─── Owl data catalogue editor ────────────────────────────────────────────────
// Lists EVERY field in the Active Tickets explore and lets an admin tick which ones
// the Owl (askData) may use. Extras are added on top of the curated seed; unticked
// seed fields are turned off. Contact/PII fields are locked (lookup-only, for privacy).
// Takes effect on the Owl's next turn — no restart.
export default function OwlCatalogue() {
  const [data, setData] = useState(null);   // { model, explore, label, measures[], dimensions[] }
  const [enabled, setEnabled] = useState(null); // Set of enabled field names
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  const load = () => {
    setErr('');
    api.owlCatalogueFields().then((r) => {
      if (r && r.error) { setErr(typeof r.error === 'string' ? r.error : 'Could not load fields'); setData({ measures: [], dimensions: [] }); return; }
      setData(r);
      const on = new Set([...(r.measures || []), ...(r.dimensions || [])].filter((f) => f.enabled).map((f) => f.name));
      setEnabled(on);
    }).catch((e) => { setErr((e && e.message) || 'Could not reach Looker'); setData({ measures: [], dimensions: [] }); });
  };
  useEffect(() => { load(); }, []);

  const toggle = (name) => setEnabled((s) => { const n = new Set(s); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  const save = async () => {
    setBusy(true); setErr(''); setSaved(false);
    try {
      const r = await api.saveOwlCatalogue([...enabled]);
      if (r && r.error) throw new Error(typeof r.error === 'string' ? r.error : 'Save rejected');
      setSaved(true); setTimeout(() => setSaved(false), 2500);
      load(); // reflect the persisted truth (extras/disabled recomputed server-side)
    } catch (e) { setErr((e && e.message) || 'Save failed'); }
    setBusy(false);
  };

  const filtered = useMemo(() => {
    if (!data) return { measures: [], dimensions: [] };
    const m = q.trim().toLowerCase();
    const hit = (f) => !m || f.label.toLowerCase().includes(m) || f.name.toLowerCase().includes(m) || (f.group || '').toLowerCase().includes(m);
    return { measures: (data.measures || []).filter(hit), dimensions: (data.dimensions || []).filter(hit) };
  }, [data, q]);

  if (!data) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading the explore fields…</p>;

  const total = (data.measures || []).length + (data.dimensions || []).length;
  const onCount = enabled ? enabled.size : 0;

  const Row = (f) => (
    <label key={f.name} title={f.name}
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 7, cursor: f.pii ? 'not-allowed' : 'pointer', opacity: f.pii ? 0.55 : 1, background: enabled.has(f.name) ? 'rgba(52,199,89,0.08)' : 'transparent', border: '1px solid var(--hairline)' }}>
      <input type="checkbox" checked={f.pii ? false : enabled.has(f.name)} disabled={f.pii} onChange={() => !f.pii && toggle(f.name)} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{f.label}</span>
        <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 6, fontFamily: 'ui-monospace, monospace' }}>{f.name}</span>
        {f.inSeed && <span style={badge('#3b5bfd')}>curated</span>}
        {f.pii && <span style={badge('#b45309')}>contact · lookup-only</span>}
        {f.group ? <span style={{ fontSize: 10.5, color: 'var(--muted)', marginLeft: 6 }}>· {f.group}</span> : null}
      </span>
    </label>
  );

  return (
    <div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 8px' }}>
        Tick the fields the Owl’s <strong>askData</strong> may use in the <strong>{data.label || data.explore}</strong> explore. Ticked fields become groupable/filterable in chat and WhatsApp; unticked ones are hidden from the Owl. <strong>Contact fields</strong> (email, phone, name…) are locked — they stay privacy-safe lookup-only. Changes apply on the Owl’s next answer.
      </p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter fields (e.g. order, payment, revenue)…" style={{ flex: '1 1 240px', minWidth: 180, padding: '7px 10px', border: '1px solid var(--hairline)', borderRadius: 8, background: 'var(--card)', color: 'var(--text)', fontSize: 13 }} />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{onCount} of {total} enabled</span>
        <button onClick={save} disabled={busy || !enabled} style={{ border: 'none', background: 'var(--brand)', color: '#fff', borderRadius: 8, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>{busy ? 'Saving…' : 'Save catalogue'}</button>
        <button onClick={load} disabled={busy} style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 8, padding: '7px 12px', fontSize: 12.5, cursor: 'pointer' }}>Reset</button>
        {saved && <span style={{ fontSize: 12.5, color: '#34c759', fontWeight: 600 }}>Saved ✓</span>}
        {err && <span style={{ fontSize: 12.5, color: '#e0414a', fontWeight: 600 }}>⚠ {err}</span>}
      </div>
      {total === 0 && !err && <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>No fields returned — is Looker connected for this explore?</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
        <div>
          <div style={colHead}>Measures ({filtered.measures.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{filtered.measures.map(Row)}</div>
        </div>
        <div>
          <div style={colHead}>Dimensions ({filtered.dimensions.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{filtered.dimensions.map(Row)}</div>
        </div>
      </div>
    </div>
  );
}

const badge = (c) => ({ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: c, background: `${c}1a`, padding: '1px 6px', borderRadius: 5, marginLeft: 6 });
const colHead = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted)', margin: '0 0 6px' };
