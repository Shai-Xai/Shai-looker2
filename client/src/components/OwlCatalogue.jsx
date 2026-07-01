import { useEffect, useState, useMemo } from 'react';
import { api } from '../lib/api.js';

// ─── Owl data catalogue editor (multi-explore) ────────────────────────────────
// Admin picks WHICH Looker explores the Owl may use (from a live list), and within
// each, TICKS the fields to include. The Active Tickets explore is the always-present
// primary; extras are added on top. Contact/PII fields are locked (lookup-only).
// Takes effect on the Owl's next answer — no restart.
export default function OwlCatalogue() {
  const [ex, setEx] = useState(null); // { primary, registered:[], available:[] }
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = () => api.owlExplores().then((r) => { if (r && r.error) setErr(typeof r.error === 'string' ? r.error : 'Could not load explores'); setEx(r || {}); }).catch((e) => { setErr((e && e.message) || 'Could not reach Looker'); setEx({ primary: null, registered: [], available: [] }); });
  useEffect(() => { load(); }, []);

  const registeredKeys = useMemo(() => new Set([...(ex?.registered || []).map((e) => `${e.model}::${e.view}`), ex?.primary ? `${ex.primary.model}::${ex.primary.view}` : '']), [ex]);
  const addable = useMemo(() => (ex?.available || []).filter((e) => !registeredKeys.has(`${e.model}::${e.view}`)), [ex, registeredKeys]);

  const add = async () => {
    if (!adding) return;
    const opt = addable.find((e) => `${e.model}::${e.view}` === adding);
    if (!opt) return;
    setBusy(true); setErr('');
    try { const r = await api.addOwlExplore(opt.model, opt.view, opt.label); if (r && r.error) throw new Error(r.error); setAdding(''); await load(); }
    catch (e) { setErr((e && e.message) || 'Could not add explore'); }
    setBusy(false);
  };
  const remove = async (e) => {
    if (!confirm(`Remove “${e.label}” from the Owl? Its field selection is cleared.`)) return;
    setBusy(true); setErr('');
    try { await api.removeOwlExplore(e.model, e.view); await load(); } catch (er) { setErr((er && er.message) || 'Could not remove'); }
    setBusy(false);
  };

  if (!ex) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading explores…</p>;

  return (
    <div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 10px' }}>
        Choose which Looker <strong>explores</strong> the Owl can read, and tick the <strong>fields</strong> in each. The <strong>Active Tickets</strong> explore is always on (primary). Contact fields (email, phone, name…) are locked — privacy-safe lookup-only. An explore only answers for a client if its data can be scoped to that client; otherwise the Owl safely declines it. Changes apply on the Owl’s next answer.
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '0 0 12px' }}>
        <select value={adding} onChange={(e) => setAdding(e.target.value)} style={{ flex: '1 1 320px', minWidth: 220, padding: '7px 10px', border: '1px solid var(--hairline)', borderRadius: 8, background: 'var(--card)', color: 'var(--text)', fontSize: 13 }}>
          <option value="">{addable.length ? '＋ Add an explore…' : (ex.available && ex.available.length ? 'All available explores are added' : 'No explores available (is Looker connected?)')}</option>
          {addable.map((e) => <option key={`${e.model}::${e.view}`} value={`${e.model}::${e.view}`}>{e.label} — {e.model}{e.description ? ` · ${e.description.slice(0, 60)}` : ''}</option>)}
        </select>
        <button onClick={add} disabled={busy || !adding} style={{ border: 'none', background: 'var(--brand)', color: '#fff', borderRadius: 8, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: (busy || !adding) ? 'default' : 'pointer', opacity: (busy || !adding) ? 0.6 : 1 }}>Add explore</button>
        {err && <span style={{ fontSize: 12.5, color: '#e0414a', fontWeight: 600 }}>⚠ {err}</span>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {ex.primary && <ExplorePanel explore={ex.primary} primary />}
        {(ex.registered || []).map((e) => <ExplorePanel key={`${e.model}::${e.view}`} explore={e} onRemove={() => remove(e)} />)}
        {(ex.registered || []).length === 0 && <p style={{ fontSize: 12, color: 'var(--muted)' }}>No extra explores yet — add one above (e.g. Cashless) to let the Owl answer from it too.</p>}
      </div>
    </div>
  );
}

// One explore's field editor — collapsible; loads its fields on first open.
function ExplorePanel({ explore, primary = false, defaultOpen = false, onRemove }) {
  const [open, setOpen] = useState(defaultOpen);
  const [data, setData] = useState(null);
  const [enabled, setEnabled] = useState(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  const load = () => {
    setErr('');
    api.owlCatalogueFields(explore.model, explore.view).then((r) => {
      if (r && r.error) { setErr(typeof r.error === 'string' ? r.error : 'Could not load fields'); setData({ measures: [], dimensions: [] }); return; }
      setData(r);
      setEnabled(new Set([...(r.measures || []), ...(r.dimensions || [])].filter((f) => f.enabled).map((f) => f.name)));
    }).catch((e) => { setErr((e && e.message) || 'Could not reach Looker'); setData({ measures: [], dimensions: [] }); });
  };
  useEffect(() => { if (open && !data) load(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (name) => setEnabled((s) => { const n = new Set(s); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  const save = async () => {
    setBusy(true); setErr(''); setSaved(false);
    try {
      const r = await api.saveOwlCatalogue([...enabled], explore.model, explore.view);
      if (r && r.error) throw new Error(typeof r.error === 'string' ? r.error : 'Save rejected');
      setSaved(true); setTimeout(() => setSaved(false), 2500); load();
    } catch (e) { setErr((e && e.message) || 'Save failed'); }
    setBusy(false);
  };

  const filtered = useMemo(() => {
    if (!data) return { measures: [], dimensions: [] };
    const m = q.trim().toLowerCase();
    const hit = (f) => !m || f.label.toLowerCase().includes(m) || f.name.toLowerCase().includes(m) || (f.group || '').toLowerCase().includes(m);
    return { measures: (data.measures || []).filter(hit), dimensions: (data.dimensions || []).filter(hit) };
  }, [data, q]);

  const total = data ? (data.measures || []).length + (data.dimensions || []).length : 0;
  const onCount = enabled ? enabled.size : 0;

  const Row = (f) => (
    <label key={f.name} title={f.name}
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderRadius: 7, cursor: f.pii ? 'not-allowed' : 'pointer', opacity: f.pii ? 0.55 : 1, background: enabled.has(f.name) ? 'rgba(52,199,89,0.08)' : 'transparent', border: '1px solid var(--hairline)' }}>
      <input type="checkbox" checked={f.pii ? false : enabled.has(f.name)} disabled={f.pii} onChange={() => !f.pii && toggle(f.name)} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{f.label}</span>
        <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 6, fontFamily: 'ui-monospace, monospace' }}>{f.name}</span>
        {f.inSeed && <span style={badge('#3b5bfd')}>curated</span>}
        {f.pii && <span style={badge('#b45309')}>contact · lookup-only</span>}
      </span>
    </label>
  );

  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 10, background: 'var(--card)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', cursor: 'pointer' }} onClick={() => setOpen((o) => !o)}>
        <span style={{ fontSize: 13, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▸</span>
        <span style={{ fontSize: 14, fontWeight: 700 }}>{explore.label}</span>
        <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'ui-monospace, monospace' }}>{explore.model}::{explore.view}</span>
        {primary ? <span style={badge('#3b5bfd')}>primary · always on</span> : <span style={badge('#8b8b93')}>extra</span>}
        {open && data && <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>{onCount} of {total} fields</span>}
        {!primary && <button onClick={(e) => { e.stopPropagation(); onRemove && onRemove(); }} title="Remove explore" style={{ marginLeft: primary ? 0 : (open ? 10 : 'auto'), border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 14 }}>🗑</button>}
      </div>
      {open && (
        <div style={{ padding: '0 12px 12px' }}>
          {!data ? <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>Loading fields…</p> : (
            <>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter fields…" style={{ flex: '1 1 200px', minWidth: 160, padding: '6px 9px', border: '1px solid var(--hairline)', borderRadius: 8, background: 'var(--card)', color: 'var(--text)', fontSize: 13 }} />
                <button onClick={save} disabled={busy || !enabled} style={{ border: 'none', background: 'var(--brand)', color: '#fff', borderRadius: 8, padding: '6px 14px', fontSize: 12.5, fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>
                {saved && <span style={{ fontSize: 12.5, color: '#34c759', fontWeight: 600 }}>Saved ✓</span>}
                {err && <span style={{ fontSize: 12.5, color: '#e0414a', fontWeight: 600 }}>⚠ {err}</span>}
              </div>
              {total === 0 && !err && <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>No fields returned for this explore.</p>}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
                <div><div style={colHead}>Measures ({filtered.measures.length})</div><div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{filtered.measures.map(Row)}</div></div>
                <div><div style={colHead}>Dimensions ({filtered.dimensions.length})</div><div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{filtered.dimensions.map(Row)}</div></div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const badge = (c) => ({ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: c, background: `${c}1a`, padding: '1px 6px', borderRadius: 5, marginLeft: 6 });
const colHead = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted)', margin: '0 0 6px' };
