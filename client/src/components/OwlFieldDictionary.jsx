import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// ─── Owl field dictionary editor ──────────────────────────────────────────────
// Review + rename every measure/dimension the Owl can read, manage its synonyms, and
// give example "typical questions". Saved as overrides (server/owlFields.js); the Owl
// uses them live in its field guide. One card per field, grouped Measures / Dimensions.
export default function OwlFieldDictionary() {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sync, setSync] = useState(null); // null | 'loading' | result object
  const checkLooker = async () => {
    setSync('loading');
    try { setSync(await api.owlFieldsLookerSync()); } catch (e) { setSync({ error: (e && e.message) || 'Could not check Looker.' }); }
  };

  const hydrate = (fields) => (fields || []).map((f) => ({ ...f, akaStr: (f.aka || []).join(', '), qStr: (f.questions || []).join('\n') }));
  useEffect(() => { api.owlFieldDict().then((r) => setRows(hydrate(r.fields))).catch(() => setRows([])); }, []);
  const set = (name, patch) => setRows((rs) => rs.map((r) => (r.name === name ? { ...r, ...patch } : r)));
  const save = async () => {
    setBusy(true);
    try {
      const payload = rows.map((r) => ({ name: r.name, label: r.label, aka: r.akaStr.split(',').map((s) => s.trim()).filter(Boolean), questions: r.qStr.split('\n').map((s) => s.trim()).filter(Boolean) }));
      const res = await api.saveOwlFieldDict(payload);
      setRows(hydrate(res.fields)); setSaved(true); setTimeout(() => setSaved(false), 1800);
    } catch { /* ignore */ }
    setBusy(false);
  };
  if (!rows) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p>;

  const lbl = { display: 'block', fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted)', margin: '6px 0 2px' };
  const fld = { width: '100%', boxSizing: 'border-box', padding: '6px 9px', borderRadius: 7, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 13, fontFamily: 'inherit' };
  const saveBar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 10px' }}>
      <button onClick={save} disabled={busy} style={{ border: 'none', background: 'var(--brand)', color: '#fff', borderRadius: 8, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>{busy ? 'Saving…' : 'Save dictionary'}</button>
      {saved && <span style={{ fontSize: 12.5, color: '#34c759', fontWeight: 600 }}>Saved ✓</span>}
    </div>
  );
  const card = (f) => (
    <div key={f.name} style={{ border: '1px solid var(--hairline)', borderRadius: 10, padding: '9px 11px', marginBottom: 8, background: 'var(--card)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <code style={{ fontSize: 11.5, color: 'var(--muted)' }}>{f.name}</code>
        {f.group ? <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>· {f.group}</span> : null}
        {f.filterOnly && <span style={{ fontSize: 10, fontWeight: 700, color: '#b45309', background: 'rgba(180,83,9,0.12)', borderRadius: 6, padding: '1px 6px' }}>lookup-only (PII)</span>}
        {f.edited && <span style={{ fontSize: 10, color: 'var(--brand)', marginLeft: 'auto' }}>edited</span>}
      </div>
      <label style={lbl}>Label (how it’s shown & named)</label>
      <input value={f.label} onChange={(e) => set(f.name, { label: e.target.value })} style={fld} />
      <label style={lbl}>Synonyms (comma-separated — phrasings that mean this field)</label>
      <input value={f.akaStr} onChange={(e) => set(f.name, { akaStr: e.target.value })} placeholder="e.g. revenue, sales, gross" style={fld} />
      <label style={lbl}>Typical questions (one per line)</label>
      <textarea value={f.qStr} onChange={(e) => set(f.name, { qStr: e.target.value })} rows={2} placeholder={'e.g. How much revenue have we made?\nRevenue by ticket type'} style={{ ...fld, resize: 'vertical', lineHeight: 1.4 }} />
    </div>
  );
  const measures = rows.filter((r) => r.kind === 'measure');
  const dims = rows.filter((r) => r.kind === 'dimension');
  const head = { fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', margin: '12px 0 6px' };
  return (
    <div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 8px' }}>Rename any field, add the phrasings people use for it (synonyms), and example questions. The Owl uses these live to understand questions and label answers — no deploy needed.</p>
      <div style={{ border: '1px solid var(--hairline)', borderRadius: 10, padding: '10px 12px', margin: '0 0 10px', background: 'var(--bg, #fafafe)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 12.5 }}>New fields in Looker?</strong>
          <span style={{ fontSize: 12, color: 'var(--muted)', flex: 1 }}>Check what your Looker explore has that the Owl isn’t using yet.</span>
          <button onClick={checkLooker} disabled={sync === 'loading'} style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 8, padding: '5px 12px', fontSize: 12.5, cursor: 'pointer' }}>{sync === 'loading' ? 'Checking…' : 'Check Looker'}</button>
        </div>
        {sync && sync !== 'loading' && (sync.error
          ? <div style={{ fontSize: 12.5, color: 'var(--warn, #b45309)', marginTop: 8 }}>{sync.error}</div>
          : sync.supported === false
            ? <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 8 }}>Looker field metadata isn’t available right now.</div>
            : (
              <div style={{ marginTop: 8, fontSize: 12.5 }}>
                <div style={{ color: 'var(--muted)', marginBottom: 6 }}>{sync.curatedCount} curated · {sync.lookerCount} in Looker ({sync.explore})</div>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>New in Looker, not in the Owl ({(sync.newInLooker || []).length})</div>
                {(sync.newInLooker || []).length === 0 && <div style={{ color: 'var(--muted)' }}>Nothing new — the Owl already covers everything curated. ✓</div>}
                {(sync.newInLooker || []).slice(0, 80).map((f) => (
                  <div key={f.name} style={{ display: 'flex', gap: 8, padding: '2px 0' }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: f.kind === 'measure' ? 'var(--brand)' : 'var(--muted)', width: 28 }}>{f.kind === 'measure' ? 'M' : 'D'}</span>
                    <span style={{ flex: 1, color: 'var(--text)' }}>{f.label} <code style={{ color: 'var(--muted)', fontSize: 11 }}>{f.name}</code></span>
                  </div>
                ))}
                {(sync.newInLooker || []).length > 80 && <div style={{ color: 'var(--muted)', marginTop: 4 }}>…and {sync.newInLooker.length - 80} more.</div>}
                {(sync.missingFromLooker || []).length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontWeight: 700, marginBottom: 4, color: 'var(--warn, #b45309)' }}>In the Owl but no longer in Looker ({sync.missingFromLooker.length})</div>
                    {sync.missingFromLooker.map((n) => <div key={n} style={{ color: 'var(--muted)' }}><code style={{ fontSize: 11 }}>{n}</code></div>)}
                  </div>
                )}
                <div style={{ color: 'var(--muted)', marginTop: 8, fontStyle: 'italic' }}>To add a new field to the Owl, send the field name to Claude/your dev — no-code adding is the next step.</div>
              </div>
            ))}
      </div>
      {saveBar}
      <div style={head}>Measures ({measures.length})</div>
      {measures.map(card)}
      <div style={head}>Dimensions ({dims.length})</div>
      {dims.map(card)}
      {saveBar}
    </div>
  );
}
