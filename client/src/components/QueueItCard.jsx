import { useState, useEffect, useMemo, useRef } from 'react';
import ReactECharts from 'echarts-for-react/lib/core';
import echarts from '../lib/echarts.js';
import { brandPrimary } from '../lib/brand.js';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';

// Queue-it live waiting-room stats — the SAME component on both surfaces via the
// scope prop ('my' | 'admin-client'), like MetaConnectCard. Credentials are
// entered in the 🚦 Queue-it section of IntegrationsForm above; this card shows
// what those credentials unlock: the waiting rooms, a live per-minute summary and
// a time-series chart. Admin scope additionally assigns which rooms the client's
// own view is scoped to (essential when the client rides the shared platform
// account). Read-only — Pulse never changes a queue's state.

const METRICS = [
  ['queueinflow', 'Inflow'],
  ['queueoutflow', 'Passed through'],
  ['queueidsinqueue', 'In queue'],
  ['queueidscanceled', 'Cancelled'],
];
const RANGES = [
  ['1h', 'Last hour', 3600_000],
  ['24h', '24 hours', 24 * 3600_000],
  ['7d', '7 days', 7 * 86400_000],
  ['30d', '30 days', 30 * 86400_000],
];
const fmt = (n) => (n == null ? '—' : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}m` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export default function QueueItCard({ entityId, scope = 'my' }) {
  const isMobile = useIsMobile();
  const [status, setStatus] = useState(null);
  const [roomsData, setRoomsData] = useState(null); // { rooms, assignedIds?, source }
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(''); // expanded room id
  const [testState, setTestState] = useState('');

  useEffect(() => {
    setStatus(null); setRoomsData(null); setErr(''); setOpen('');
    api.queueitStatus(entityId, scope).then(setStatus).catch(() => setStatus(null));
  }, [entityId, scope]);
  useEffect(() => {
    if (!status?.configured) return;
    api.queueitRooms(entityId, scope).then(setRoomsData).catch((e) => setErr(e.message));
  }, [entityId, scope, status?.configured]);

  // Nothing to say to a client whose account has no Queue-it at all; admins get
  // a hint so they know where the stats will appear once creds are saved.
  if (!status) return null;
  if (!status.configured) {
    if (scope !== 'admin-client') return null;
    return (
      <div style={card}>
        <div style={title}>🚦 Queue-it — waiting-room stats</div>
        <p style={sub}>Add the Queue-it <b>customer ID + API key</b> in the section above (or on Admin → Integrations for the shared platform account) and live queue stats appear here.</p>
      </div>
    );
  }

  const rooms = roomsData?.rooms || [];
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ ...title, flex: 1, minWidth: 0, marginBottom: 0 }}>🚦 Queue-it — waiting-room stats</div>
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
          {status.source === 'client' ? `own account · ${status.customerId}` : 'via Howler\'s account'}
        </span>
      </div>
      <p style={{ ...sub, marginTop: 6 }}>Live queue numbers straight from Queue-it — who's waiting, who got through, and how the queue moved over time.</p>
      {err && <p style={{ ...sub, color: 'var(--danger, #dc2626)' }}>{err}</p>}

      {!roomsData && !err && <p style={sub}>Loading waiting rooms…</p>}
      {roomsData && rooms.length === 0 && (
        <p style={sub}>
          {scope === 'admin-client'
            ? 'No waiting rooms found on this Queue-it account yet.'
            : 'Your waiting rooms haven\'t been linked yet — ask Howler to assign them to your account.'}
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rooms.map((r) => (
          <RoomRow
            key={r.id} room={r} entityId={entityId} scope={scope} isMobile={isMobile}
            open={open === r.id} onToggle={() => setOpen(open === r.id ? '' : r.id)}
          />
        ))}
      </div>

      {scope === 'admin-client' && roomsData && rooms.length > 0 && (
        <RoomAssignment entityId={entityId} rooms={rooms} assignedIds={roomsData.assignedIds || []} />
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
        <button type="button" style={ghostBtn} disabled={testState === '…'}
          onClick={async () => {
            setTestState('…');
            try { const r = await api.queueitVerify(entityId, scope); setTestState(`✓ Connected — ${r.roomCount} waiting room${r.roomCount === 1 ? '' : 's'}`); }
            catch (e) { setTestState(`✗ ${e.message}`); }
          }}>{testState === '…' ? 'Testing…' : 'Test connection'}</button>
        {testState && testState !== '…' && (
          <span style={{ fontSize: 12.5, fontWeight: 600, color: testState.startsWith('✓') ? 'var(--success, #10b981)' : 'var(--danger, #dc2626)' }}>{testState}</span>
        )}
      </div>
    </div>
  );
}

// One waiting room: header row (name + state chip), expanding into the live
// summary tiles + the time-series chart.
function RoomRow({ room, entityId, scope, isMobile, open, onToggle }) {
  const running = /running/i.test(room.status);
  const paused = /paused/i.test(room.status);
  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 10, overflow: 'hidden' }}>
      <button type="button" onClick={onToggle}
        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 44, padding: '10px 12px', background: 'var(--elevated, rgba(128,128,128,0.05))', border: 'none', cursor: 'pointer', font: 'inherit', textAlign: 'left', color: 'var(--text)' }}>
        <span style={{ width: 12, fontSize: 9, color: 'var(--muted)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {room.name}
          {room.isTest && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', marginLeft: 6, border: '1px solid var(--hairline)', borderRadius: 4, padding: '1px 5px' }}>TEST</span>}
        </span>
        <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, borderRadius: 980, padding: '3px 10px', color: running ? 'var(--success, #10b981)' : paused ? '#d97706' : 'var(--muted)', border: `1px solid ${running ? 'var(--success, #10b981)' : paused ? '#d97706' : 'var(--hairline)'}` }}>
          {running ? '● Running' : paused ? '⏸ Paused' : room.status || 'Off'}
        </span>
      </button>
      {open && <RoomStats room={room} entityId={entityId} scope={scope} isMobile={isMobile} />}
    </div>
  );
}

function RoomStats({ room, entityId, scope, isMobile }) {
  const [summary, setSummary] = useState(null);
  const [sumErr, setSumErr] = useState('');
  const [metric, setMetric] = useState('queueinflow');
  const [range, setRange] = useState('24h');
  const [series, setSeries] = useState(null);
  const [serErr, setSerErr] = useState('');
  const timer = useRef(null);

  // Queue-it refreshes stats each minute — poll the open room on the same beat.
  useEffect(() => {
    let dead = false;
    const load = () => api.queueitSummary(entityId, scope, room.id).then((s) => { if (!dead) { setSummary(s); setSumErr(''); } }).catch((e) => { if (!dead) setSumErr(e.message); });
    load();
    timer.current = setInterval(load, 60_000);
    return () => { dead = true; clearInterval(timer.current); };
  }, [entityId, scope, room.id]);

  useEffect(() => {
    let dead = false;
    setSeries(null); setSerErr('');
    const ms = RANGES.find(([k]) => k === range)?.[2] || 24 * 3600_000;
    const to = new Date(); const from = new Date(to.getTime() - ms);
    api.queueitDetails(entityId, scope, room.id, { type: metric, from: from.toISOString(), to: to.toISOString() })
      .then((d) => { if (!dead) setSeries(d); })
      .catch((e) => { if (!dead) setSerErr(e.message); });
    return () => { dead = true; };
  }, [entityId, scope, room.id, metric, range]);

  const tiles = summary ? [
    ['Waiting now', summary.waitingNow],
    ['Redirects / min', summary.redirectsLastMinute],
    ['Total queued', summary.totalQueued],
    ['Passed through', summary.totalRedirected],
    ['Left the queue', summary.leftQueue],
    ['Queued pre-start', summary.queuedBeforeStart],
  ] : [];

  return (
    <div style={{ padding: isMobile ? 10 : 14 }}>
      {sumErr && <p style={{ ...sub, color: 'var(--danger, #dc2626)' }}>{sumErr}</p>}
      {!summary && !sumErr && <p style={sub}>Loading live summary…</p>}
      {summary && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${isMobile ? 130 : 150}px, 1fr))`, gap: 8 }}>
            {tiles.map(([label, v]) => (
              <div key={label} style={{ border: '1px solid var(--hairline)', borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>{label}</div>
                <div style={{ fontSize: 22, fontWeight: 800, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{fmt(v)}</div>
              </div>
            ))}
          </div>
          {summary.asOf && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>As of {new Date(summary.asOf).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · refreshes every minute</div>}
        </>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '14px 0 8px' }}>
        {METRICS.map(([k, label]) => <Chip key={k} on={metric === k} onClick={() => setMetric(k)}>{label}</Chip>)}
        <span style={{ flex: 1 }} />
        {RANGES.map(([k, label]) => <Chip key={k} on={range === k} onClick={() => setRange(k)}>{isMobile ? k : label}</Chip>)}
      </div>
      {serErr && <p style={{ ...sub, color: 'var(--danger, #dc2626)' }}>{serErr}</p>}
      {!series && !serErr && <p style={sub}>Loading chart…</p>}
      {series && (series.points || []).length > 0 && <TrendChart series={series} isMobile={isMobile} />}
      {series && (series.points || []).length === 0 && <p style={sub}>No data in this range yet.</p>}
    </div>
  );
}

// Single-series line: brand hue, thin 2px line, soft area fill, crosshair
// tooltip, recessive axes. One axis, no legend (the metric chip names it).
function TrendChart({ series, isMobile }) {
  const option = useMemo(() => {
    const brand = brandPrimary();
    const hourly = series.interval === 'hour';
    return {
      animationDuration: 300,
      grid: { left: 8, right: 12, top: 12, bottom: 8, containLabel: true },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', label: { backgroundColor: brand } },
        valueFormatter: (v) => (v == null ? '—' : Number(v).toLocaleString('en-ZA')),
      },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: 'rgba(128,128,128,0.25)' } },
        axisLabel: { color: 'var(--muted, #888)', fontSize: 10.5, hideOverlap: true },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: 'var(--muted, #888)', fontSize: 10.5, formatter: (v) => fmt(v) },
        splitLine: { lineStyle: { color: 'rgba(128,128,128,0.12)' } },
      },
      series: [{
        type: 'line',
        showSymbol: false,
        smooth: 0.15,
        lineStyle: { width: 2, color: brand },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: `${brand}55` }, { offset: 1, color: `${brand}05` },
          ]),
        },
        data: (series.points || []).map((p) => [p.t, p.v]),
      }],
      // Per-hour buckets beyond 7 days come back from Queue-it pre-summed.
      ...(hourly ? {} : {}),
    };
  }, [series]);
  return (
    <div style={{ width: '100%', overflow: 'hidden' }}>
      <ReactECharts echarts={echarts} option={option} notMerge style={{ height: isMobile ? 200 : 260, width: '100%' }} opts={{ renderer: 'canvas' }} />
    </div>
  );
}

// Admin-only: choose which waiting rooms the CLIENT's own view is scoped to —
// the guardrail that makes the shared platform account safe to reuse.
function RoomAssignment({ entityId, rooms, assignedIds }) {
  const [picked, setPicked] = useState(() => new Set(assignedIds));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');
  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const save = async () => {
    setBusy(true); setErr('');
    try { await api.queueitSetRooms(entityId, 'admin-client', [...picked]); setSaved(true); setTimeout(() => setSaved(false), 1600); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <div style={{ border: '1px dashed var(--hairline)', borderRadius: 10, padding: 12, marginTop: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>Rooms the client sees</div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
        On the shared Howler account, tick only THIS client's waiting rooms — unticked rooms stay invisible to them. (With the client's own account, no ticks = they see all their rooms.)
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {rooms.map((r) => (
          <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, minHeight: 32, cursor: 'pointer' }}>
            <input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name} <span style={{ color: 'var(--muted)' }}>· {r.id}</span></span>
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
        <button type="button" style={ghostBtn} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save room assignment'}</button>
        {saved && <span style={{ color: 'var(--success, #10b981)', fontSize: 12.5, fontWeight: 600 }}>✓ Saved</span>}
        {err && <span style={{ color: 'var(--danger, #dc2626)', fontSize: 12.5 }}>{err}</span>}
      </div>
    </div>
  );
}

function Chip({ on, onClick, children }) {
  return (
    <button type="button" onClick={onClick}
      style={{ minHeight: 32, padding: '5px 12px', borderRadius: 980, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: `1px solid ${on ? 'var(--brand)' : 'var(--hairline)'}`, background: on ? 'var(--brand)' : 'transparent', color: on ? '#fff' : 'var(--muted)' }}>
      {children}
    </button>
  );
}

const card = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: 16, marginTop: 16 };
const title = { fontSize: 14, fontWeight: 700, marginBottom: 6 };
const sub = { fontSize: 13, color: 'var(--muted)', margin: '0 0 12px' };
const ghostBtn = { border: '1px solid var(--hairline)', background: 'transparent', color: 'var(--text)', borderRadius: 980, padding: '9px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', minHeight: 40 };
