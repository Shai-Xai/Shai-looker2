import { useEffect, useState } from 'react';

// 🚨 Hive → Alerts (staff alerts, phase 1 🧪): the bridge between the Data
// health board's station names and Event Ops stations, with the staff who'd
// be called when a station goes dark. Auto name-matches; any row can be
// re-mapped by hand. Alerts fire server-side (half the devices dark) — in
// test mode only the test email hears about them.
const card = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 10, padding: 12 };
const sel = { padding: '7px 9px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 12.5, background: 'var(--card)', color: 'var(--text)', fontFamily: 'inherit', maxWidth: '100%', minHeight: 36 };

const chip = (on) => ({ border: `1px solid ${on ? 'var(--brand)' : 'var(--hairline)'}`, borderRadius: 999, cursor: 'pointer', background: 'var(--card)', color: on ? 'var(--brand)' : 'var(--text)', fontWeight: on ? 800 : 600, padding: '5px 12px', fontSize: 12, fontFamily: 'inherit', minHeight: 30 });

export default function StaffAlertsTab({ suiteId }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);
  const [q, setQ] = useState(''); // text filter (station name)
  const [view, setView] = useState('all'); // all | alerting | dark | unmapped | nostaff
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
  const saveThreshold = (v) => {
    const n = Math.max(10, Math.min(100, Math.round(Number(v) || 50)));
    fetch('/api/my/staff-alerts/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suiteId, thresholdPct: n }),
    }).then(() => setTick((v2) => v2 + 1)).catch(() => {});
  };
  const setPaused = (p) => {
    fetch('/api/my/staff-alerts/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suiteId, paused: p }),
    }).then(() => setTick((v2) => v2 + 1)).catch(() => {});
  };
  const setAllOff = (p) => {
    fetch('/api/my/staff-alerts/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suiteId, allOff: p }),
    }).then(() => setTick((v2) => v2 + 1)).catch(() => {});
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
      {/* Master OFF — kills every event's ops alerts. Distinct from per-event pause. */}
      {data.allOff ? (
        <div style={{ ...card, borderLeft: '4px solid #dc2626', background: 'rgba(220,38,38,0.08)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          <span style={{ fontSize: 12.5 }}>🛑 <b>All ops alerts are OFF</b> — nothing will send for any event until you switch them back on.</span>
          <span style={{ flex: 1 }} />
          <button onClick={() => setAllOff(false)} style={{ border: 'none', background: '#16a34a', color: '#fff', borderRadius: 8, padding: '7px 14px', fontSize: 12.5, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit', minHeight: 34 }}>▶ Switch alerts on</button>
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
          <button onClick={() => { if (confirm('Switch OFF ops alerts for EVERY event? Nothing will send until you turn them back on.')) setAllOff(true); }} title="Master switch — stop all ops alerts everywhere" style={{ border: '1px solid #dc2626', background: 'var(--card)', color: '#dc2626', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', minHeight: 32 }}>🛑 Switch off all ops alerts</button>
        </div>
      )}
      {/* Pause switch — a big honest banner when paused, a quiet button when live. */}
      {data.paused ? (
        <div style={{ ...card, borderLeft: '4px solid #6b7280', background: 'var(--hover, rgba(127,127,127,0.08))', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          <span style={{ fontSize: 12.5 }}>⏸️ <b>Alerts paused</b> — no station alerts will be sent for this event until you resume.</span>
          <span style={{ flex: 1 }} />
          <button onClick={() => setPaused(false)} style={{ border: 'none', background: '#16a34a', color: '#fff', borderRadius: 8, padding: '7px 14px', fontSize: 12.5, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit', minHeight: 34 }}>▶ Resume alerts</button>
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
          <button onClick={() => setPaused(true)} title="Stop sending station alerts for this event" style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', minHeight: 32 }}>⏸️ Pause alerts</button>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '0 0 10px', fontSize: 12, color: 'var(--muted)' }}>
        <span>
          Alert the assigned staff when{' '}
          <input type="number" min={10} max={100} key={data.thresholdPct} defaultValue={data.thresholdPct} aria-label="Dark threshold %"
            onKeyDown={(e) => { if (e.key === 'Enter') saveThreshold(e.currentTarget.value); }}
            onBlur={(e) => { if (Number(e.currentTarget.value) !== data.thresholdPct) saveThreshold(e.currentTarget.value); }}
            style={{ ...sel, width: 58, minHeight: 30, padding: '4px 6px', fontVariantNumeric: 'tabular-nums' }} />
          % of a station's devices go dark (recovers under {Math.round(data.thresholdPct / 2)}%).
        </span>
        {unmapped ? <b style={{ color: '#dc2626' }}>{unmapped} station{unmapped > 1 ? 's' : ''} unmapped</b> : null}
        {uncrewed ? <b style={{ color: '#d97706' }}>{uncrewed} mapped but no staff assigned</b> : null}
      </div>
      {data.whatsappFrom && (
        <div style={{ ...card, borderLeft: '4px solid #25D366', fontSize: 12, marginBottom: 10 }}>
          💬 <b>Staff WhatsApp:</b> {data.whatsappFrom} — staff message this number once to switch alerts on (opens WhatsApp’s 24h window; they don’t reach the Owl). 🔔 = push on this phone · 💬 = WhatsApp reachable.
        </div>
      )}
      {/* Filters: status chips + a name search, so a 65-station board is
          navigable — jump straight to the ones alerting or missing a crew. */}
      {data.stations.length > 6 && (() => {
        const alerting = data.stations.filter((s) => s.alerting).length;
        const dark = data.stations.filter((s) => s.off > 0).length;
        return (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
            <button onClick={() => setView('all')} style={chip(view === 'all')}>All · {data.stations.length}</button>
            {alerting > 0 && <button onClick={() => setView('alerting')} style={chip(view === 'alerting')}>🚨 Alerting · {alerting}</button>}
            {dark > 0 && <button onClick={() => setView('dark')} style={chip(view === 'dark')}>🟠 Has dark · {dark}</button>}
            {unmapped > 0 && <button onClick={() => setView('unmapped')} style={chip(view === 'unmapped')}>Unmapped · {unmapped}</button>}
            {uncrewed > 0 && <button onClick={() => setView('nostaff')} style={chip(view === 'nostaff')}>No staff · {uncrewed}</button>}
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔎 Find a station…" aria-label="Find a station" style={{ ...sel, flex: '1 1 160px', minWidth: 120 }} />
          </div>
        );
      })()}
      <div style={{ display: 'grid', gap: 8 }}>
        {data.stations.filter((s) => (
          (!q.trim() || s.station.toLowerCase().includes(q.trim().toLowerCase()))
          && (view === 'all'
            || (view === 'alerting' && s.alerting)
            || (view === 'dark' && s.off > 0)
            || (view === 'unmapped' && !s.opsStationId)
            || (view === 'nostaff' && s.opsStationId && !s.staff.length))
        )).map((s) => (
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
                ? s.staff.map((x) => `${x.reachable ? '🔔 ' : ''}${x.whatsapp ? '💬 ' : ''}${x.name}${x.role ? ` (${x.role})` : ''}`).join(', ')
                : s.opsStationId ? 'no staff assigned' : 'map to an Event Ops station'}
            </span>
          </div>
        ))}
        {!data.stations.length && <div style={{ ...card, fontSize: 12.5, color: 'var(--muted)' }}>No board stations yet — they appear once Data health monitors have run for this event.</div>}
      </div>
      {data.acks && data.acks.length > 0 && (
        <div style={{ ...card, borderLeft: '4px solid #16a34a', marginTop: 12 }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.2, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 4 }}>Acknowledged — who's on it</div>
          {data.acks.map((a, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 11.5, padding: '3px 0', borderTop: i ? '1px solid var(--hairline)' : 'none', color: 'var(--muted)' }}>
              <b style={{ color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{new Date(a.acked_at).toTimeString().slice(0, 5)}</b>
              <span>✓</span>
              <b style={{ color: '#16a34a' }}>{a.name}</b>
              <span>is on {a.station}</span>
            </div>
          ))}
        </div>
      )}
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
