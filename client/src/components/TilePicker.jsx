import { useState, useEffect } from 'react';

// Pick dashboards/tiles from a client's catalogue — shared by digests and the
// briefing tuner. `load` returns { dashboards: [{ dashboardId, title, setName,
// tiles: [{ tileId, title, visType }] }] }; `selected` is an array of
// { dashboardId, tileId } where tileId '*' means the whole dashboard.
// `phases` (optional, [{key,label}]): when given, every SELECTED pick gets a small
// scope select — "All phases" or one lifecycle phase (stored as `phase` on the
// selection). The briefing then feeds that pick only while its event is in that
// phase, so a launch board can lead during Launch and a gates board on Event Day.
export default function TilePicker({ load, catalogue, selected, onChange, phases = null }) {
  const [cat, setCat] = useState(catalogue || null);
  const [open, setOpen] = useState({});
  useEffect(() => {
    if (catalogue) { setCat(catalogue); return; }
    load().then(setCat).catch(() => setCat({ dashboards: [] }));
  }, [catalogue]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!cat) return <div style={{ ...hintS, marginTop: 8 }}>Loading tiles…</div>;
  if (!cat.dashboards.length) return <div style={{ ...hintS, marginTop: 8 }}>No selectable tiles found for this client yet.</div>;

  const key = (d, t) => `${d}|${t}`;
  const sel = new Set(selected.map((t) => key(t.dashboardId, t.tileId)));
  const whole = (dashId) => sel.has(key(dashId, '*'));
  const toggle = (d, t) => {
    if (whole(d)) return; // whole-dashboard selected; individual toggles are no-ops
    const k = key(d, t);
    onChange(sel.has(k) ? selected.filter((x) => key(x.dashboardId, x.tileId) !== k) : [...selected, { dashboardId: d, tileId: t }]);
  };
  const toggleWhole = (dashId) => {
    if (whole(dashId)) onChange(selected.filter((x) => !(x.dashboardId === dashId && x.tileId === '*')));
    else onChange([...selected.filter((x) => x.dashboardId !== dashId), { dashboardId: dashId, tileId: '*' }]); // replaces individual picks
  };
  const countIn = (dash) => whole(dash.dashboardId) ? dash.tiles.length : dash.tiles.filter((t) => sel.has(key(dash.dashboardId, t.tileId))).length;
  const phaseOf = (d, t) => selected.find((x) => x.dashboardId === d && x.tileId === t)?.phase || '';
  const setPhase = (d, t, phase) => onChange(selected.map((x) => (x.dashboardId === d && x.tileId === t ? { ...x, ...(phase ? { phase } : { phase: undefined }) } : x)));
  const phaseSel = (d, t) => (phases && phases.length ? (
    <select value={phaseOf(d, t)} onClick={(e) => e.stopPropagation()} onChange={(e) => setPhase(d, t, e.target.value)}
      title="Only feed the briefing during this lifecycle phase"
      style={{ flexShrink: 0, fontSize: 10.5, padding: '2px 4px', borderRadius: 6, border: '1px solid var(--hairline)', background: 'var(--card)', color: phaseOf(d, t) ? 'var(--ai, #7c3aed)' : 'var(--muted)', maxWidth: 120 }}>
      <option value="">All phases</option>
      {phases.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
    </select>
  ) : null);

  return (
    <div style={{ marginTop: 8, border: '1px solid var(--hairline)', borderRadius: 10, maxHeight: 300, overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 10px', borderBottom: '1px solid var(--hairline)', fontSize: 11.5, color: 'var(--muted)' }}>
        <span>{selected.length} tile{selected.length === 1 ? '' : 's'} selected</span>
        {selected.length > 0 && <button type="button" style={{ ...chipBtn, padding: '1px 8px' }} onClick={() => onChange([])}>Clear all</button>}
      </div>
      {cat.dashboards.map((d) => {
        const n = countIn(d);
        const isOpen = open[d.dashboardId];
        return (
          <div key={d.dashboardId} style={{ borderBottom: '1px solid var(--hairline)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px' }}>
              <button type="button" onClick={() => setOpen((o) => ({ ...o, [d.dashboardId]: !o[d.dashboardId] }))}
                style={{ flex: 1, minWidth: 0, textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text)', padding: 0 }}>
                <span style={{ fontSize: 11, color: 'var(--muted)', width: 10 }}>{isOpen ? '▾' : '▸'}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{d.title}</span>
                  <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 6 }}>{d.setName}</span>
                </span>
                {n > 0 && <span style={{ ...roleChip, background: 'rgba(var(--brand-rgb), 0.12)', color: 'var(--brand)' }}>{whole(d.dashboardId) ? 'All' : n}</span>}
              </button>
              {whole(d.dashboardId) && phaseSel(d.dashboardId, '*')}
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--muted)', cursor: 'pointer', flexShrink: 0 }} title="Include the whole dashboard">
                <input type="checkbox" checked={whole(d.dashboardId)} onChange={() => toggleWhole(d.dashboardId)} /> Whole
              </label>
            </div>
            {isOpen && (
              <div style={{ padding: '0 10px 8px 28px', opacity: whole(d.dashboardId) ? 0.55 : 1 }}>
                {d.tiles.map((t) => {
                  const checked = whole(d.dashboardId) || sel.has(key(d.dashboardId, t.tileId));
                  return (
                    <label key={t.tileId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12.5, cursor: whole(d.dashboardId) ? 'default' : 'pointer' }}>
                      <input type="checkbox" checked={checked} disabled={whole(d.dashboardId)} onChange={() => toggle(d.dashboardId, t.tileId)} />
                      <span style={{ flex: 1 }}>{t.title}</span>
                      {!whole(d.dashboardId) && checked && phaseSel(d.dashboardId, t.tileId)}
                      {t.visType && <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{t.visType}</span>}
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const chipBtn = { padding: '4px 9px', background: 'rgba(128,128,128,0.10)', border: '1px solid var(--hairline)', borderRadius: 980, fontSize: 11, cursor: 'pointer', color: 'var(--text)' };
const roleChip = { fontSize: 10.5, fontWeight: 700, borderRadius: 980, padding: '2px 8px', background: 'rgba(10,132,255,0.12)', color: '#0a66c2' };
const hintS = { fontSize: 11, color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 };
