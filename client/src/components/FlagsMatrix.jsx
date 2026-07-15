import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { bustFlagsCache } from '../lib/flags.js';

// 🚩 Admin → Product → Flags: which client sees which feature. Clients as rows,
// sections as columns; a section with sub-flags expands in place (▸ N sub). Each
// cell is tri-state — auto (inherits the ⚙️ platform default row) → ON → OFF —
// and saves on click. A section OFF is a master kill: its children lock. The
// columns come from the server registry, so a newly shipped flag appears here
// automatically. Wide matrix scrolls sideways (admin tool; first column sticks).
export default function FlagsMatrix() {
  const [data, setData] = useState(null); // { registry, defaults, overrides, entities }
  const [expanded, setExpanded] = useState({});
  const [q, setQ] = useState('');
  const [toast, setToast] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => { api.adminFlags().then(setData).catch((e) => setErr(e.message)); }, []);
  const flash = (m) => { setToast(m); clearTimeout(flash.t); flash.t = setTimeout(() => setToast(''), 2200); };

  if (err) return <div style={{ color: 'var(--error)', fontSize: 13 }}>⚠️ {err}</div>;
  if (!data) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading flags…</div>;

  const { registry, defaults, overrides, entities } = data;
  const cols = [];
  for (const s of registry) {
    cols.push({ ...s, kind: 'parent' });
    if (s.kids?.length && expanded[s.key]) for (const k of s.kids) cols.push({ ...k, kind: 'kid', parent: s });
  }
  const ov = (eid, key) => (overrides[eid] || {})[key] || '';
  const effParentOn = (eid, pkey) => { const o = ov(eid, pkey); return o ? o === 'on' : !!defaults[pkey]; };

  const setDefault = async (key, name) => {
    const next = defaults[key] ? 'off' : 'on';
    setData((d) => ({ ...d, defaults: { ...d.defaults, [key]: next === 'on' } })); // optimistic
    try { const r = await api.setFlagDefault(key, next); setData((d) => ({ ...d, defaults: r.defaults })); bustFlagsCache(); flash(`⚙️ Default: ${name} → ${next.toUpperCase()} — every “auto” client follows`); }
    catch (e) { flash(`⚠️ ${e.message}`); api.adminFlags().then(setData).catch(() => {}); }
  };
  const cycle = async (eid, key, name, entName) => {
    const cur = ov(eid, key);
    const next = !cur ? 'on' : cur === 'on' ? 'off' : ''; // auto → on → off → auto
    setData((d) => { // optimistic
      const o = { ...(d.overrides[eid] || {}) };
      if (next) o[key] = next; else delete o[key];
      return { ...d, overrides: { ...d.overrides, [eid]: o } };
    });
    try { await api.setFlagOverride(eid, key, next); bustFlagsCache(); flash(`${name} → ${next ? next.toUpperCase() : `auto (${defaults[key] ? 'on' : 'off'})`} for ${entName} · saved`); }
    catch (e) { flash(`⚠️ ${e.message}`); api.adminFlags().then(setData).catch(() => {}); }
  };

  const shown = entities.filter((e) => !q.trim() || e.name.toLowerCase().includes(q.trim().toLowerCase()));
  const pill = (kind, effOn, locked, title) => {
    if (locked) return <span style={{ ...pillBase, ...pillLocked }} title="The section is OFF for this client — sub-features cannot leak through">🔒 off</span>;
    if (kind === 'on') return <span style={{ ...pillBase, ...pillOn }} title={title}>✓ ON</span>;
    if (kind === 'off') return <span style={{ ...pillBase, ...pillOff }} title={title}>✕ OFF</span>;
    return <span style={{ ...pillBase, ...pillAuto }} title={title}><span style={{ ...dot, background: effOn ? 'var(--success)' : 'var(--error)' }} /> auto</span>;
  };

  return (
    <div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 10px', lineHeight: 1.5, maxWidth: 760 }}>
        Which client sees which feature. <b>auto</b> inherits the ⚙️ platform default (top row); click a cell to cycle <b>auto → on → off</b> — saves instantly.
        A section OFF is a <b>master kill</b> for its sub-features. Flags marked <i>legacy</i> still use their existing switch — they migrate here next.
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter clients…" style={search} />
      </div>
      <div style={{ background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'separate', borderSpacing: 0, minWidth: 760, width: '100%' }}>
            <thead>
              <tr>
                <th style={{ ...clientCell, fontSize: 10, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--muted)', verticalAlign: 'bottom' }}>Client</th>
                {cols.map((c) => (
                  <th key={c.key} style={{ ...featTh, ...(c.kind === 'kid' ? kidBand : null) }} title={c.desc || ''}>
                    {c.kind === 'parent' ? (<>
                      <span style={{ fontSize: 15, display: 'block', marginBottom: 2 }}>{c.emoji}</span>
                      <span style={{ fontSize: 10.5, fontWeight: 750, display: 'block', lineHeight: 1.2 }}>{c.name}</span>
                      {c.beta && <span style={beta}>BETA</span>}{c.legacy && <span style={{ ...beta, color: 'var(--muted)', background: 'rgba(128,128,128,0.13)' }}>LEGACY</span>}
                      {c.kids?.length > 0 && (
                        <button onClick={() => setExpanded((x) => ({ ...x, [c.key]: !x[c.key] }))} style={{ ...expander, ...(expanded[c.key] ? expanderOpen : null) }}>
                          {expanded[c.key] ? '▾ hide' : `▸ ${c.kids.length} sub`}
                        </button>
                      )}
                    </>) : (<>
                      <span style={{ fontSize: 10, fontWeight: 650, color: 'var(--muted)', display: 'block', lineHeight: 1.25 }}>{c.parent.emoji} ↳ <b style={{ color: 'var(--text)' }}>{c.name}</b></span>
                      {c.beta && <span style={beta}>BETA</span>}
                    </>)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ ...clientCell, background: 'rgba(var(--brand-rgb,10,132,255),0.07)' }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--brand)' }}>⚙️ Platform default</div>
                  <div style={{ fontSize: 10, color: 'var(--muted)' }}>what “auto” resolves to</div>
                </td>
                {cols.map((c) => (
                  <td key={c.key} style={{ ...cell, background: 'rgba(var(--brand-rgb,10,132,255),0.07)', cursor: 'pointer' }} onClick={() => setDefault(c.key, c.name)}>
                    {defaults[c.key]
                      ? <span style={{ ...pillBase, ...pillOn }} title="Default ON — click to default OFF">✓ ON</span>
                      : <span style={{ ...pillBase, ...pillOff }} title="Default OFF — click to default ON">✕ OFF</span>}
                  </td>
                ))}
              </tr>
              {shown.map((e) => (
                <tr key={e.id}>
                  <td style={clientCell}><div style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap' }}>{e.name}</div></td>
                  {cols.map((c) => {
                    const locked = c.kind === 'kid' && !effParentOn(e.id, c.parent.key);
                    const o = ov(e.id, c.key);
                    return (
                      <td key={c.key} style={{ ...cell, ...(c.kind === 'kid' ? kidBand : null), cursor: locked ? 'not-allowed' : 'pointer' }}
                        onClick={locked ? undefined : () => cycle(e.id, c.key, c.name, e.name)}>
                        {pill(o || 'auto', !!defaults[c.key], locked, o ? (o === 'on' ? 'Forced ON — click: force OFF' : 'Forced OFF — click: back to auto') : 'Auto — inherits the platform default. Click: force ON')}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {toast && <div style={toastStyle}>{toast}</div>}
    </div>
  );
}

const search = { flex: '0 1 260px', padding: '8px 12px', border: '1.5px solid var(--hairline)', borderRadius: 9, background: 'var(--card)', color: 'var(--text)', fontSize: 13, outline: 'none', fontFamily: 'inherit' };
const clientCell = { position: 'sticky', left: 0, background: 'var(--card)', zIndex: 2, textAlign: 'left', padding: '10px 14px', minWidth: 170, borderRight: '1px solid var(--hairline)', borderBottom: '1px solid var(--hairline)' };
const featTh = { verticalAlign: 'bottom', padding: '10px 6px 8px', textAlign: 'center', minWidth: 78, borderBottom: '1px solid var(--hairline)' };
const kidBand = { background: 'rgba(var(--brand-rgb,10,132,255),0.045)' };
const cell = { textAlign: 'center', padding: '7px 6px', borderBottom: '1px solid var(--hairline)' };
const pillBase = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4, minWidth: 50, height: 24, borderRadius: 999, fontSize: 10, fontWeight: 800, border: '1.5px solid transparent', userSelect: 'none' };
const pillOn = { background: 'rgba(18,163,107,0.14)', color: 'var(--success)' };
const pillOff = { background: 'rgba(220,38,38,0.11)', color: 'var(--error)' };
const pillAuto = { borderColor: 'var(--hairline)', color: 'var(--muted)', fontWeight: 600 };
const pillLocked = { color: 'var(--muted)', opacity: 0.55, fontWeight: 600 };
const dot = { width: 7, height: 7, borderRadius: '50%', display: 'inline-block' };
const beta = { display: 'inline-block', fontSize: 8, fontWeight: 800, letterSpacing: '.05em', color: 'var(--brand)', background: 'rgba(var(--brand-rgb,10,132,255),0.1)', borderRadius: 999, padding: '1px 5px', marginTop: 2 };
const expander = { display: 'inline-flex', alignItems: 'center', gap: 3, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--muted)', borderRadius: 999, padding: '1px 7px', fontSize: 9, fontWeight: 800, cursor: 'pointer', marginTop: 4, fontFamily: 'inherit' };
const expanderOpen = { color: 'var(--brand)', borderColor: 'var(--brand)', background: 'rgba(var(--brand-rgb,10,132,255),0.08)' };
const toastStyle = { position: 'fixed', left: '50%', bottom: 22, transform: 'translateX(-50%)', zIndex: 200, background: 'var(--text)', color: 'var(--bg)', borderRadius: 999, padding: '9px 18px', fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', maxWidth: '92vw', overflow: 'hidden', textOverflow: 'ellipsis' };
