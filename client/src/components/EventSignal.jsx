import { useEffect, useState } from 'react';

// 🎛 Event Signal — the site board: every station a tile inside its venue zone,
// every device a countable tick (green = sending, red = dark). Data comes from
// the roster snapshots the Data health checks already store, so rendering this
// costs no Looker reads. Zones are derived from the station names themselves
// (FUTUR BAR → FUTUR), which mirrors how venues actually name their sites.
// Styled entirely with the app's theme tokens — light/dark follows Pulse.

const STATUS_COLOR = { fresh: '#16a34a', warn: '#d97706', stale: '#dc2626' };
const unitFor = (m) => (m && (m.area === 'Bar' || m.area === 'Vendors') ? 'transactions' : 'scans');
const fmtLag = (min) => {
  if (min == null) return '—';
  const m = Math.round(min);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

// Zone from a station name: drop FOOD/RECYCLING-style prefixes, take the first
// word; anything GATE-ish folds into one GATES zone.
const zoneOf = (name) => {
  const n = String(name || '').trim().toUpperCase();
  if (!n) return '—';
  const w = n.replace(/^(FOOD|RECYCLING|STORE|LOUNGE)\s+/, '').split(/\s+/)[0];
  if (w.startsWith('GATE')) return 'GATES';
  return w || '—';
};

const card = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 10, padding: 12 };

function Ticks({ on, off, dense }) {
  const w = dense ? 4 : 7; const h = dense ? 6 : 11;
  const cells = [];
  for (let i = 0; i < on + off; i++) {
    const isOn = i < on;
    cells.push(<span key={i} style={{
      width: w, height: h, borderRadius: 1, flexShrink: 0,
      background: isOn ? STATUS_COLOR.fresh : 'transparent',
      border: isOn ? 'none' : `1px solid ${STATUS_COLOR.stale}`,
      opacity: isOn ? 0.9 : 1,
    }} />);
  }
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: dense ? 1.5 : 2, margin: '6px 0 5px' }}>{cells}</div>;
}

function Spark({ spark }) {
  if (!spark || !spark.length) return null;
  const max = Math.max(1, ...spark);
  return (
    <span style={{ display: 'flex', alignItems: 'flex-end', gap: 1.5, height: 14, marginLeft: 'auto' }}>
      {spark.map((v, i) => (
        <i key={i} style={{ display: 'block', width: 4, borderRadius: '1px 1px 0 0', height: Math.max(2, Math.round((v / max) * 14)), background: i === spark.length - 1 && v ? 'var(--brand)' : 'var(--hairline)' }} />
      ))}
    </span>
  );
}

function StationTile({ s, selected, onSelect }) {
  const edge = STATUS_COLOR[s.status] || 'var(--hairline)';
  const tot = (s.on ?? 0) + (s.off ?? 0);
  return (
    <button onClick={() => onSelect(s)} style={{
      position: 'relative', textAlign: 'left', minWidth: 0, cursor: 'pointer', fontFamily: 'inherit',
      border: `1px solid ${selected ? 'var(--brand)' : 'var(--hairline)'}`, borderRadius: 8,
      background: 'var(--card)', padding: '7px 9px 7px 13px', color: 'var(--text)',
    }}>
      <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, borderRadius: '8px 0 0 8px', background: edge }} />
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 12.5, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{s.name}</span>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: s.status === 'stale' ? STATUS_COLOR.stale : 'var(--muted)', fontWeight: s.status === 'stale' ? 800 : 500, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{fmtLag(s.lagMin)}</span>
      </span>
      {s.on != null
        ? <Ticks on={s.on} off={s.off} dense={tot > 28} />
        : <div style={{ fontSize: 10, color: 'var(--muted)', margin: '6px 0 5px' }}>device counts arrive with the next check…</div>}
      <span style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: s.txnH ? 'var(--text)' : 'var(--muted)' }}>
          {s.txnH != null ? s.txnH.toLocaleString('en-ZA') : '—'}
          <span style={{ fontSize: 9, color: 'var(--muted)', fontWeight: 400 }}> /h</span>
        </span>
        <Spark spark={s.spark} />
      </span>
    </button>
  );
}

// Tap-through deep dive for one station: the day's per-device timeline pulled
// live into the card — who's sending, who's dark, and when each device worked.
function DeepDive({ apiBase, mid, station, unit }) {
  const [t, setT] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true; setT(null); setErr('');
    fetch(`${apiBase}/monitors/${encodeURIComponent(mid)}/timeline?hours=start&interval=30&station=${encodeURIComponent(station)}`)
      .then((r) => r.json()).then((d) => { if (alive) { if (d && d.devices) setT(d); else setErr((d && d.error) || 'No timeline'); } })
      .catch((e) => { if (alive) setErr(e.message); });
    return () => { alive = false; };
  }, [apiBase, mid, station]);
  if (err) return <div style={{ fontSize: 12, color: STATUS_COLOR.stale, marginTop: 10 }}>⚠️ {err}</div>;
  if (!t) return <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>Pulling the day's device timeline…</div>;
  const isOn = (d) => (d.lagMin != null ? d.lagMin <= (t.onlineMin || 15) : (d.active || []).slice(-2).some(Boolean));
  const devs = [...(t.devices || [])].sort((a, b) => (isOn(a) - isOn(b)) || String(a.device).localeCompare(String(b.device)));
  const tot = (d) => (d.counts || []).reduce((x, y) => x + y, 0);
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
        Today per device — each block 30 min from the start, <span style={{ color: STATUS_COLOR.fresh, fontWeight: 700 }}>green = sent data</span>, grey = silent. Dark devices listed first.
      </div>
      <div style={{ maxHeight: 340, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 5 }}>
        {devs.map((d) => (
          <div key={d.device} style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, fontSize: 11.5 }}>
            <span style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0, background: isOn(d) ? STATUS_COLOR.fresh : STATUS_COLOR.stale }} />
            <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '32%' }}>{d.device}</span>
            {d.operator ? <span style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '20%' }}>{d.operator}</span> : null}
            <span style={{ display: 'flex', gap: 1, flexShrink: 1, minWidth: 0, overflow: 'hidden' }}>
              {(d.active || []).map((a, i) => (
                <i key={i} style={{ width: 4, height: 10, borderRadius: 1, flexShrink: 0, background: a ? STATUS_COLOR.fresh : 'var(--hairline)' }} />
              ))}
            </span>
            <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', fontWeight: 700, flexShrink: 0 }}>{tot(d).toLocaleString('en-ZA')}</span>
            <span style={{ color: d.lagMin != null && !isOn(d) ? STATUS_COLOR.stale : 'var(--muted)', fontVariantNumeric: 'tabular-nums', width: 44, textAlign: 'right', flexShrink: 0 }}>{fmtLag(d.lagMin)}</span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6 }}>
        {devs.length} device{devs.length === 1 ? '' : 's'} · totals are today's {unit} per device · 🩺 Diagnose and the offline log live in the 📶 Data health tab.
      </div>
    </div>
  );
}

// The board itself — presentational; give it the monitors array the page
// already holds (admin groups) or let SignalOps below fetch for Event Ops.
export function SignalBoard({ monitors, apiBase = '/api/my/data-health' }) {
  const [sel, setSel] = useState(null);
  const [pick, setPick] = useState(''); // monitor id filter: '' = whole site
  const open = (monitors || []).filter((m) => m.status !== 'closed');

  const rows = [];
  for (const m of open) {
    const roll = new Map(((m.rosterSnapshot && m.rosterSnapshot.stations) || []).map((s) => [s.station, s]));
    for (const st of m.streams || []) {
      const name = st.station || m.name;
      // A monitor with no station split rolls all its devices into one ''
      // entry — that belongs to the monitor's own tile.
      const r = roll.get(name) || (st.station ? null : roll.get(''));
      rows.push({
        name, zone: zoneOf(name), status: st.status, lagMin: st.lagMin, unit: unitFor(m), monitor: m.name, mid: m.id, sn: st.station || '',
        on: r ? r.on : null, off: r ? r.off : 0, txnH: r ? r.txnH : null, spark: r ? r.spark : null,
      });
      roll.delete(name);
      if (r) roll.delete(r.station);
    }
    // stations the roll-up saw but the stream memory hasn't named yet
    for (const r of roll.values()) {
      if (r.station === '—' || !r.station) continue;
      rows.push({ name: r.station, zone: zoneOf(r.station), status: r.on ? (r.off ? 'warn' : 'fresh') : 'stale', lagMin: null, unit: unitFor(m), monitor: m.name, mid: m.id, sn: r.station, on: r.on, off: r.off, txnH: r.txnH, spark: r.spark });
    }
  }

  // Filter chips — one per monitor (Bars / Vendors / Check-in), so the board
  // can flick between station families without leaving the page.
  const chipIcon = (m) => (m.area === 'Bar' ? '🍺' : m.area === 'Vendors' ? '🧾' : '🎟️');
  const chips = open.filter((m) => rows.some((s) => s.mid === m.id));
  const shown = pick ? rows.filter((s) => s.mid === pick) : rows;

  const zones = new Map();
  for (const s of shown) {
    if (!zones.has(s.zone)) zones.set(s.zone, []);
    zones.get(s.zone).push(s);
  }
  const zoneList = [...zones.entries()]
    .map(([k, list]) => ({ k, list: list.sort((a, b) => a.name.localeCompare(b.name)), dev: list.reduce((a, s) => a + (s.on || 0) + (s.off || 0), 0) }))
    .sort((a, b) => b.dev - a.dev);

  const sum = (k) => shown.reduce((a, s) => a + (s[k] || 0), 0);
  const units = new Set(shown.map((s) => s.unit));
  const short = units.size > 1 ? 'scans+txns' : units.has('transactions') ? 'txns' : 'scans';
  const dials = [
    ['Stations', shown.length], ['Zones', zoneList.length],
    ['Devices on', sum('on'), STATUS_COLOR.fresh],
    ['Dark', sum('off'), sum('off') ? STATUS_COLOR.stale : undefined],
    [`${short}/h`, sum('txnH').toLocaleString('en-ZA')],
  ];

  if (!rows.length) {
    return <div style={{ ...card, fontSize: 12.5, color: 'var(--muted)' }}>No stations yet — the board builds itself from the Data health monitors once their first checks land.</div>;
  }

  const chipStyle = (act) => ({
    border: `1px solid ${act ? 'var(--brand)' : 'var(--hairline)'}`, borderRadius: 999, cursor: 'pointer',
    background: 'var(--card)', color: act ? 'var(--brand)' : 'var(--text)', fontWeight: act ? 800 : 600,
    padding: '5px 12px', fontSize: 12, fontFamily: 'inherit', minHeight: 30,
  });

  return (
    <div>
      {/* monitor filter chips — split the board by station family */}
      {chips.length > 1 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          <button onClick={() => { setPick(''); setSel(null); }} style={chipStyle(!pick)}>All stations · {rows.length}</button>
          {chips.map((m) => (
            <button key={m.id} onClick={() => { setPick(m.id); setSel(null); }} style={chipStyle(pick === m.id)}>
              {chipIcon(m)} {m.name} · {rows.filter((s) => s.mid === m.id).length}
            </button>
          ))}
        </div>
      )}

      {/* dials */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {dials.map(([l, v, c]) => (
          <div key={l} style={{ ...card, padding: '7px 13px', minWidth: 78 }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.2, textTransform: 'uppercase', color: 'var(--muted)' }}>{l}</div>
            <div style={{ fontSize: 17, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: c || 'var(--text)' }}>{v}</div>
          </div>
        ))}
        <div style={{ ...card, padding: '7px 13px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 10.5, color: 'var(--muted)' }}>
          <span style={{ width: 7, height: 11, background: STATUS_COLOR.fresh, borderRadius: 1, display: 'inline-block' }} /> sending
          <span style={{ width: 7, height: 11, border: `1px solid ${STATUS_COLOR.stale}`, borderRadius: 1, display: 'inline-block' }} /> dark — each tick is one device
        </div>
      </div>

      {/* the site board */}
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 250px), 1fr))' }}>
        {zoneList.map((z) => {
          const zon = z.list.reduce((a, s) => a + (s.on || 0), 0);
          const zoff = z.list.reduce((a, s) => a + (s.off || 0), 0);
          const ztx = z.list.reduce((a, s) => a + (s.txnH || 0), 0);
          return (
            <section key={z.k} style={{ border: '1px solid var(--hairline)', borderRadius: 10, background: 'var(--card)', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--hairline)' }}>
                <span style={{ fontSize: 11.5, fontWeight: 850, letterSpacing: 1.6, textTransform: 'uppercase' }}>{z.k}</span>
                <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  <b style={{ color: STATUS_COLOR.fresh }}>{zon}</b>/{zon + zoff}
                  {zoff ? <> · <b style={{ color: STATUS_COLOR.stale }}>{zoff} dark</b></> : null}
                  {' '}· {ztx.toLocaleString('en-ZA')}/h
                </span>
              </div>
              <div style={{ display: 'grid', gap: 7, padding: 8, gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
                {z.list.map((s) => <StationTile key={s.monitor + s.name} s={s} selected={sel && sel.name === s.name && sel.monitor === s.monitor} onSelect={setSel} />)}
              </div>
            </section>
          );
        })}
      </div>

      {/* selected station */}
      {sel && (
        <div style={{ ...card, marginTop: 10, borderLeft: `4px solid ${STATUS_COLOR[sel.status] || 'var(--hairline)'}` }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 14 }}>{sel.name}</strong>
            <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 1.4, textTransform: 'uppercase', color: 'var(--muted)' }}>{sel.zone}</span>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>monitor: {sel.monitor}</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => setSel(null)} style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 6, padding: '2px 9px', fontSize: 11, cursor: 'pointer' }}>✕</button>
          </div>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 8, fontSize: 12.5 }}>
            <span><b style={{ color: STATUS_COLOR.fresh }}>{sel.on ?? '—'}</b> sending</span>
            <span><b style={{ color: sel.off ? STATUS_COLOR.stale : 'var(--muted)' }}>{sel.off ?? 0}</b> dark</span>
            <span><b>{sel.txnH != null ? sel.txnH.toLocaleString('en-ZA') : '—'}</b> {sel.unit}/h</span>
            <span style={{ color: 'var(--muted)' }}>latest record {fmtLag(sel.lagMin)} ago</span>
          </div>
          <DeepDive apiBase={apiBase} mid={sel.mid} station={sel.sn} unit={sel.unit} />
        </div>
      )}
    </div>
  );
}

// Event Ops wrapper: fetches this event's monitors (entity-scoped, read only)
// and keeps the board fresh on the same cadence as the health tab.
export default function SignalOps({ entityId, suiteId }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0); // manual refresh bumps this
  const [at, setAt] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => fetch(`/api/my/data-health?entityId=${encodeURIComponent(entityId || '')}&suiteId=${encodeURIComponent(suiteId || '')}`)
      .then((r) => r.json()).then((d) => { if (alive) { setData(d); setAt(new Date()); setErr(''); } })
      .catch((e) => { if (alive) setErr(e.message); });
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, [entityId, suiteId, tick]);
  if (err) return <div style={{ ...card, fontSize: 12.5, color: STATUS_COLOR.stale }}>⚠️ {err}</div>;
  if (!data) return <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: 12 }}>Raising the board…</div>;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 10px' }}>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: 0, flex: 1, minWidth: 0 }}>
          Your event as a live board — every zone, every station, every device. Green ticks are devices sending now; red are dark. Numbers are this hour's volume per station.
        </p>
        <span style={{ fontSize: 10.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>updated {at ? at.toTimeString().slice(0, 5) : '—'} · auto every 60s</span>
        <button title="Refresh now" onClick={() => setTick((v) => v + 1)} style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 8, minWidth: 40, minHeight: 34, cursor: 'pointer', fontSize: 14 }}>🔄</button>
      </div>
      <SignalBoard monitors={data.monitors || []} />
    </div>
  );
}
