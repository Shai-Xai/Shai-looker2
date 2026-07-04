import { useEffect, useState } from 'react';

// 🚨 Hive → Alerts (staff alerts, phase 1 🧪): the bridge between the Data
// health board's station names and Event Ops stations, with the staff who'd
// be called when a station goes dark. Auto name-matches; any row can be
// re-mapped by hand. Alerts fire server-side (half the devices dark) — in
// test mode only the test email hears about them.
const card = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 10, padding: 12 };
const sel = { padding: '7px 9px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 12.5, background: 'var(--card)', color: 'var(--text)', fontFamily: 'inherit', maxWidth: '100%', minHeight: 36 };

export default function StaffAlertsTab({ suiteId }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    fetch(`/api/my/staff-alerts?suiteId=${encodeURIComponent(suiteId || '')}`)
      .then((r) => r.json()).then((d) => { if (alive) { if (d.error) setErr(d.error); else { setData(d); setErr(''); } } })
      .catch((e) => { if (alive) setErr(e.message); });
    const t = setInterval(() => setTick((v) => v + 1), 60000);
    return () => { alive = false; clearInterval(t); };
  }, [suiteId, tick]);

  const remap = (healthStation, opsStationId) => {
    fetch('/api/my/staff-alerts/bridge', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suiteId, healthStation, opsStationId: opsStationId === 'auto' ? null : opsStationId }),
    }).then(() => setTick((v) => v + 1)).catch(() => {});
  };

  if (err) return <div style={{ ...card, fontSize: 12.5, color: '#dc2626' }}>⚠️ {err}</div>;
  if (!data) return <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: 12 }}>Loading staff alerts…</div>;
  const unmapped = data.stations.filter((s) => !s.opsStationId).length;
  const uncrewed = data.stations.filter((s) => s.opsStationId && !s.staff.length).length;
  return (
    <div>
      {data.testMode && (
        <div style={{ ...card, borderLeft: '4px solid #d97706', fontSize: 12, marginBottom: 10 }}>
          🧪 <b>Test mode</b> — station alerts email {data.testEmail} only; assigned staff are listed but never contacted. Go live in Admin → Data health.
        </div>
      )}
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 10px' }}>
        When half a station's devices go dark, Pulse alerts the staff assigned to it.
        {unmapped ? <> · <b style={{ color: '#dc2626' }}>{unmapped} station{unmapped > 1 ? 's' : ''} unmapped</b></> : null}
        {uncrewed ? <> · <b style={{ color: '#d97706' }}>{uncrewed} mapped but no staff assigned</b></> : null}
      </p>
      <div style={{ display: 'grid', gap: 8 }}>
        {data.stations.map((s) => (
          <div key={s.station} style={{ ...card, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', borderLeft: `4px solid ${s.alerting ? '#dc2626' : s.off ? '#d97706' : '#16a34a'}`, padding: '9px 12px' }}>
            <span style={{ minWidth: 0, flex: '1 1 170px' }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.station}</span>
              <span style={{ fontSize: 10.5, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
                <b style={{ color: '#16a34a' }}>{s.on}</b> on · <b style={{ color: s.off ? '#dc2626' : 'var(--muted)' }}>{s.off}</b> dark{s.alerting ? ' · 🚨 alerting' : ''}
              </span>
            </span>
            <select value={s.manual ? (s.opsStationId || '') : 'auto'} onChange={(e) => remap(s.station, e.target.value)} aria-label={`Event Ops station for ${s.station}`} style={sel}>
              <option value="auto">auto{!s.manual && s.opsStationId ? ` → ${(data.opsStations.find((o) => o.id === s.opsStationId) || {}).name || '?'}` : ' (no match)'}</option>
              <option value="">— not mapped —</option>
              {data.opsStations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            <span style={{ flex: '1 1 160px', fontSize: 11.5, color: s.staff.length ? 'var(--text)' : 'var(--muted)' }}>
              {s.staff.length
                ? s.staff.map((x) => `${x.name}${x.role ? ` (${x.role})` : ''}`).join(', ')
                : s.opsStationId ? 'no staff assigned' : 'map to an Event Ops station'}
            </span>
          </div>
        ))}
        {!data.stations.length && <div style={{ ...card, fontSize: 12.5, color: 'var(--muted)' }}>No board stations yet — they appear once Data health monitors have run for this event.</div>}
      </div>
      {data.log.length > 0 && (
        <div style={{ ...card, marginTop: 12 }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.2, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 4 }}>Alert log</div>
          {data.log.map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 11.5, padding: '3px 0', borderTop: i ? '1px solid var(--hairline)' : 'none', color: 'var(--muted)' }}>
              <b style={{ color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{new Date(l.at).toTimeString().slice(0, 5)}</b>
              <span>{l.kind === 'alert' ? '🚨' : '✅'}</span>
              <b style={{ color: 'var(--text)' }}>{l.station}</b>
              <span style={{ minWidth: 0 }}>{l.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
