import { useEffect, useState, useMemo } from 'react';
import { api } from '../lib/api.js';

// ─── Owl data catalogue editor (multi-explore) ────────────────────────────────
// Admin picks WHICH Looker explores the Owl may use (from a live list), and within
// each, TICKS the fields to include. The Active Tickets explore is the always-present
// primary; extras are added on top. Contact/PII fields are locked (lookup-only).
// Takes effect on the Owl's next answer — no restart.
export default function OwlCatalogue() {
  const [ex, setEx] = useState(null); // { primary, registered:[], available:[] }
  const [ents, setEnts] = useState([]); // clients, for the per-client access switches
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = () => api.owlExplores().then((r) => { if (r && r.error) setErr(typeof r.error === 'string' ? r.error : 'Could not load explores'); setEx(r || {}); }).catch((e) => { setErr((e && e.message) || 'Could not reach Looker'); setEx({ primary: null, registered: [], available: [] }); });
  useEffect(() => { load(); api.adminListEntities().then((r) => setEnts(Array.isArray(r) ? r : (r.entities || []))).catch(() => setEnts([])); }, []);

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
        {(ex.registered || []).map((e) => <ExplorePanel key={`${e.model}::${e.view}`} explore={e} ents={ents} onRemove={() => remove(e)} />)}
        {(ex.registered || []).length === 0 && <p style={{ fontSize: 12, color: 'var(--muted)' }}>No extra explores yet — add one above (e.g. Cashless) to let the Owl answer from it too.</p>}
      </div>
    </div>
  );
}

// Per-client access for one EXTRA explore: a platform default (on/off for everyone)
// plus per-client overrides (inherit / on / off). Applies on the Owl's next answer.
function AccessEditor({ explore, ents }) {
  const a = explore.access || { defaultOn: true, clients: {} };
  const [defaultOn, setDefaultOn] = useState(a.defaultOn !== false);
  const [clients, setClients] = useState(a.clients || {});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');
  const [show, setShow] = useState(Object.keys(a.clients || {}).length > 0);
  const setC = (eid, v) => setClients((m) => { const n = { ...m }; if (v === 'inherit') delete n[eid]; else n[eid] = v === 'on'; return n; });
  const save = async () => {
    setBusy(true); setErr(''); setSaved(false);
    try {
      const r = await api.saveOwlExploreAccess(explore.model, explore.view, defaultOn, clients);
      if (r && r.error) throw new Error(typeof r.error === 'string' ? r.error : 'Save rejected');
      setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (e) { setErr((e && e.message) || 'Save failed'); }
    setBusy(false);
  };
  const overrides = Object.keys(clients).length;
  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 8, padding: '8px 10px', margin: '0 0 10px', background: 'var(--bg, transparent)' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted)' }}>Client access</span>
        <select value={defaultOn ? 'on' : 'off'} onChange={(e) => setDefaultOn(e.target.value === 'on')} style={accSel}>
          <option value="on">On for all clients (default)</option>
          <option value="off">Off by default</option>
        </select>
        <button onClick={() => setShow((s) => !s)} style={{ ...accSel, cursor: 'pointer' }}>{show ? 'Hide per-client' : `Per-client overrides${overrides ? ` (${overrides})` : ''}…`}</button>
        <button onClick={save} disabled={busy} style={{ border: 'none', background: 'var(--brand)', color: '#fff', borderRadius: 8, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>{busy ? 'Saving…' : 'Save access'}</button>
        {saved && <span style={{ fontSize: 12, color: '#34c759', fontWeight: 600 }}>Saved ✓</span>}
        {err && <span style={{ fontSize: 12, color: '#e0414a', fontWeight: 600 }}>⚠ {err}</span>}
      </div>
      {show && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 6, marginTop: 8 }}>
          {ents.map((en) => {
            const v = typeof clients[en.id] === 'boolean' ? (clients[en.id] ? 'on' : 'off') : 'inherit';
            return (
              <label key={en.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{en.name}</span>
                <select value={v} onChange={(e) => setC(en.id, e.target.value)} style={{ ...accSel, ...(v !== 'inherit' ? { borderColor: 'var(--brand)', color: 'var(--brand)', fontWeight: 600 } : null) }}>
                  <option value="inherit">Inherit ({defaultOn ? 'on' : 'off'})</option>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </label>
            );
          })}
          {ents.length === 0 && <span style={{ fontSize: 12, color: 'var(--muted)' }}>No clients found.</span>}
        </div>
      )}
    </div>
  );
}
const accSel = { padding: '4px 8px', borderRadius: 7, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 12 };

// One explore's field editor — collapsible; loads its fields on first open.
function ExplorePanel({ explore, primary = false, defaultOpen = false, ents = [], onRemove }) {
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
  // Bulk-clear a set of field names (a whole category, or all dimensions) so a bloated
  // catalogue can be cut to a focused set in a few taps instead of hundreds.
  const clearNames = (names) => setEnabled((s) => { const n = new Set(s); names.forEach((nm) => n.delete(nm)); return n; });
  // "Suggest a focused set" — the answer to "I can't decide what to keep". Auto-pick the
  // fields the Owl actually needs by name/label: money & count MEASURES, and the business
  // DIMENSIONS you break down by (who / where / what / when / which edition), dropping the
  // technical plumbing (ids, flags, device internals, raw timestamps). A starting point to
  // review — not perfect — so the admin tweaks from ~40 sensible picks, not 400 blanks.
  const suggestFocused = () => {
    if (!data) return;
    const DROP = /(_id$|_id\b|\buid\b|uuid|_key\b|_pk\b|_fk\b|hash|token|_flag\b|\bis_|\bhas_|latitude|longitude|timezone|_tz\b|device|terminal|reader|serial|firmware|battery|\bversion\b|_url|email|phone|mobile|passport)/i;
    const KEEP_DIM = /(countr|nationalit|birth|\bage\b|age_?band|gender|\bsex\b|city|region|province|station|\bbar\b|vendor|outlet|booth|zone|\barea\b|product|item|categor|\btype\b|brand|event|edition|festival|\bname\b|\bday\b|date|hour|weekday|payment|method|currency)/i;
    const KEEP_MEAS = /(sum|avg|average|total|count|amount|spend|revenue|sales|price|value|qty|quantit|transaction|tickets?)/i;
    const keep = new Set();
    (data.measures || []).filter((m) => !m.pii && (KEEP_MEAS.test(m.name) || KEEP_MEAS.test(m.label || ''))).slice(0, 15).forEach((m) => keep.add(m.name));
    if (keep.size === 0) (data.measures || []).filter((m) => !m.pii).slice(0, 8).forEach((m) => keep.add(m.name)); // keep it queryable
    (data.dimensions || []).filter((d) => !d.pii && (KEEP_DIM.test(d.name) || KEEP_DIM.test(d.label || '')) && !DROP.test(d.name)).slice(0, 30).forEach((d) => keep.add(d.name));
    setEnabled(keep);
  };
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
        {/* Queryability at a glance: without at least one ticked MEASURE the Owl never
            gets a tool for this explore — surface that instead of failing silently. */}
        {!primary && explore.status && (explore.status.queryable
          ? <span style={badge('#34c759')}>queryable · {explore.status.fields} field{explore.status.fields === 1 ? '' : 's'}</span>
          : <span style={badge('#b45309')}>{explore.status.fields === 0 ? '⚠ no fields ticked — Owl can’t use it yet' : '⚠ no measure ticked — Owl can’t query it'}</span>)}
        {open && data && <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>{onCount} of {total} fields</span>}
        {!primary && <button onClick={(e) => { e.stopPropagation(); onRemove && onRemove(); }} title="Remove explore" style={{ marginLeft: primary ? 0 : (open ? 10 : 'auto'), border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 14 }}>🗑</button>}
      </div>
      {open && (
        <div style={{ padding: '0 12px 12px' }}>
          {!primary && <AccessEditor explore={explore} ents={ents} />}
          {!data ? <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>Loading fields…</p> : (
            <>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter fields…" style={{ flex: '1 1 200px', minWidth: 160, padding: '6px 9px', border: '1px solid var(--hairline)', borderRadius: 8, background: 'var(--card)', color: 'var(--text)', fontSize: 13 }} />
                <button onClick={save} disabled={busy || !enabled} style={{ border: 'none', background: 'var(--brand)', color: '#fff', borderRadius: 8, padding: '6px 14px', fontSize: 12.5, fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>
                {data && (data.dimensions || []).length > 40 && (
                  <button onClick={() => { if (window.confirm('Auto-pick a focused starter set — the money/count measures and the business dimensions you break down by (who / where / what / when), dropping technical fields. This REPLACES the current selection; review and tweak, then Save.')) suggestFocused(); }}
                    style={{ border: '1px solid var(--brand)', background: 'transparent', color: 'var(--brand)', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>✨ Suggest a focused set</button>
                )}
                {/* Bulk-clear the dimensions so you can rebuild a FOCUSED set fast — unticking
                    hundreds by hand (esp. on a phone) is the reason big catalogues never get
                    trimmed. Measures stay ticked; then tick the ~30 dimensions you actually ask about. */}
                {enabled && (data.dimensions || []).some((d) => enabled.has(d.name)) && (
                  <button onClick={() => { if (window.confirm('Untick every dimension on this explore? Your measures stay ticked — then tick just the few dimensions you actually ask about, and Save.')) clearNames((data.dimensions || []).map((d) => d.name)); }}
                    style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Untick all dimensions</button>
                )}
                {enabled && enabled.size > 0 && (
                  <button onClick={() => { if (window.confirm('Untick EVERY field on this explore (measures and dimensions)? You then rebuild a small, focused set from zero — usually the fastest way. Tick what you need, then Save.')) setEnabled(new Set()); }}
                    style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--muted)', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Untick all</button>
                )}
                {saved && <span style={{ fontSize: 12.5, color: '#34c759', fontWeight: 600 }}>Saved ✓</span>}
                {err && <span style={{ fontSize: 12.5, color: '#e0414a', fontWeight: 600 }}>⚠ {err}</span>}
              </div>
              {total === 0 && !err && <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>No fields returned for this explore.</p>}
              {!primary && total > 0 && enabled && !(data.measures || []).some((m) => enabled.has(m.name)) && (
                <p style={{ fontSize: 12.5, color: 'var(--warn, #b45309)', margin: '0 0 8px', fontWeight: 600 }}>⚠ Tick at least one <u>measure</u> (a number, e.g. revenue or a count) — without one the Owl can’t query this explore, so it won’t appear in chat.</p>
              )}
              {/* Too many enabled fields is the #1 cause of slow/unreliable answers: the Owl
                  carries every ticked field on each turn, so it's both a bigger prompt AND
                  has to pick the right field out of hundreds of look-alikes — it guesses
                  wrong and retries. Keep it focused to the fields you actually ask about. */}
              {onCount > 60 && (
                <p style={{ fontSize: 12.5, color: 'var(--warn, #b45309)', margin: '0 0 8px', fontWeight: 600, lineHeight: 1.5 }}>⚠ {onCount} fields enabled — that’s a lot. The Owl reads every ticked field on <em>each</em> turn, so a big set makes answers <u>slower</u> and <u>less accurate</u> (it has to pick the right field out of many look-alikes and often retries). Trim to a focused set — the fields you actually ask about (e.g. the demographics, categories, dates + a few measures) — ideally under ~40.</p>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
                <div>
                  <div style={colHead}>Measures ({filtered.measures.length})</div>
                  {groupFields(filtered.measures).map(([g, fs]) => <FieldGroup key={g} name={g} fields={fs} enabled={enabled} renderRow={Row} forceOpen={!!q.trim()} onClear={clearNames} />)}
                </div>
                <div>
                  <div style={colHead}>Dimensions ({filtered.dimensions.length})</div>
                  {groupFields(filtered.dimensions).map(([g, fs]) => <FieldGroup key={g} name={g} fields={fs} enabled={enabled} renderRow={Row} forceOpen={!!q.trim()} onClear={clearNames} />)}
                </div>
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

// A field's category: Looker's own group_label if present, else the view prefix of
// its name (cashless_check_ins.count → "Cashless Check Ins"). Keeps the flat list of
// 1,000+ fields navigable — one collapsible section per category.
function catOf(f) {
  if (f.group && f.group.trim()) return f.group.trim();
  const pre = (f.name || '').split('.')[0] || '';
  const pretty = pre.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  return pretty || 'Other';
}
// Bucket fields into [name, fields[]] pairs, sorted by category name.
function groupFields(arr) {
  const m = new Map();
  for (const f of arr) { const c = catOf(f); if (!m.has(c)) m.set(c, []); m.get(c).push(f); }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

// One collapsible category. Auto-opens while a filter is active or the group holds
// ticked fields (so the current selection is always visible), but the admin can still
// collapse it manually.
function FieldGroup({ name, fields, enabled, renderRow, forceOpen, onClear }) {
  const [override, setOverride] = useState(null); // null = auto, true/false = manual
  const on = enabled ? fields.filter((f) => enabled.has(f.name)).length : 0;
  const auto = forceOpen || on > 0;
  const isOpen = override === null ? auto : override;
  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 8, marginBottom: 6, overflow: 'hidden' }}>
      <div onClick={() => setOverride(!isOpen)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', cursor: 'pointer', background: 'rgba(139,139,147,0.08)' }}>
        <span style={{ fontSize: 11, transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}>▸</span>
        <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        {on > 0 && <span style={badge('#34c759')}>{on} on</span>}
        {/* Clear a whole category in one tap — the fast way to drop entire groups you
            never ask about (access control, device internals…) from a bloated explore. */}
        {on > 0 && onClear && <button onClick={(e) => { e.stopPropagation(); onClear(fields.map((f) => f.name)); }} title={`Untick all ${fields.length} in ${name}`} style={{ border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 12, padding: '0 4px', fontWeight: 700 }}>untick</button>}
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{fields.length}</span>
      </div>
      {isOpen && <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 8px' }}>{fields.map(renderRow)}</div>}
    </div>
  );
}
