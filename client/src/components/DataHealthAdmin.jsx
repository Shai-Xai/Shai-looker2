import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';

// Admin → 📡 Data health: the BigQuery → Looker stream monitor. Each monitor polls
// max(timestamp) on an explore (optionally split by a station dimension — check-in
// scanners, bars, vendors) so we can SEE how fresh the data feeding every dashboard
// is, with a per-station lag grid, a pull/activity log, and stale/recovery alerts.
// Internal tool (admin-only): it watches the pipe, not a client's numbers — that's
// what Alerts are for.

const AREAS = ['Check-in', 'Bar', 'Vendors', 'Cashless', 'Ticketing', 'Other'];
const STATUS_COLOR = { fresh: '#16a34a', warn: '#d97706', stale: '#dc2626' };
const STATUS_BG = { fresh: 'rgba(22,163,74,0.12)', warn: 'rgba(217,119,6,0.13)', stale: 'rgba(220,38,38,0.13)' };

const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 14, boxShadow: '0 1px 6px rgba(0,0,0,0.05)' };
const input = { padding: '9px 11px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box', width: '100%', fontFamily: 'inherit', background: 'var(--card)', color: 'var(--text)' };

// Bars & vendors sell — their per-record activity is "transactions"; gates scan.
const unitFor = (m) => (m && (m.area === 'Bar' || m.area === 'Vendors') ? 'transactions' : 'scans');
const label = { fontSize: 11, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 4, display: 'block' };
const btn = { padding: '9px 16px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: 'pointer' };
const ghostBtn = { padding: '7px 13px', background: 'var(--card)', border: '1.5px solid var(--hairline)', borderRadius: 7, fontWeight: 600, fontSize: 12.5, cursor: 'pointer', color: 'var(--text)' };

const fmtLag = (min) => {
  if (min == null || !Number.isFinite(Number(min))) return '—';
  const m = Math.round(Number(min));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
};
const fmtAt = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const ago = (iso) => (iso ? fmtLag((Date.now() - new Date(iso).getTime()) / 60000) + ' ago' : 'never');
// UTC ISO ⇄ the browser-local value a <input type="datetime-local"> wants.
const isoToLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

function Dot({ status, size = 9 }) {
  return <span style={{ display: 'inline-block', width: size, height: size, borderRadius: '50%', background: STATUS_COLOR[status] || 'var(--muted)', flexShrink: 0 }} />;
}

// One remembered station: name + how long since its last record.
function StationChip({ s, onForget }) {
  return (
    <span title={`Latest record ${fmtAt(s.lastEventAt)} · last appeared in a pull ${ago(s.lastSeenAt)}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
        background: STATUS_BG[s.status] || 'var(--card)', color: STATUS_COLOR[s.status] || 'var(--text)', border: '1px solid transparent' }}>
      <Dot status={s.status} size={7} />
      <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.station || 'Whole feed'}</span>
      <span style={{ opacity: 0.85 }}>· {fmtLag(s.lagMin)}</span>
      {onForget && s.station && (
        <button onClick={onForget} title="Forget this station (stop watching it)" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', opacity: 0.6, padding: 0, fontSize: 12, lineHeight: 1 }}>✕</button>
      )}
    </span>
  );
}

const EVENT_META = {
  stale: ['⛔', '#dc2626'], recovered: ['✅', '#16a34a'], alert: ['📣', '#dc2626'],
  recovery_alert: ['📣', '#16a34a'], error: ['⚠️', '#d97706'],
  device_alert: ['📟', '#dc2626'], device_recovered: ['📟', '#16a34a'],
};

// Shared JSON fetch for the live panels; `base` switches the same components
// between the admin surface (/api/admin/data-health) and the client one
// (/api/my/data-health — read-only, entity-enforced server-side).
const ADMIN_BASE = '/api/admin/data-health';
// UTC 'HH:MM' -> South Africa time label (fixed UTC+2, no DST).
const saTime = (hhmm) => { const [h, m2] = String(hhmm).split(':').map(Number); return `${String((h + 2) % 24).padStart(2, '0')}:${String(m2).padStart(2, '0')}`; };
// Flow score banding: ≥85 healthy, 60-84 needs attention, <60 degraded.
const flowColor = (v) => (v == null ? 'var(--muted)' : v >= 85 ? STATUS_COLOR.fresh : v >= 60 ? STATUS_COLOR.warn : STATUS_COLOR.stale);
const flowTitle = (f) => (f ? `Flow score = 60% uptime (${f.uptimePct}% of linked devices sending, averaged over the day's blocks) + 20% continuity (${f.continuityPct}% of blocks had data) + 20% throughput (last hour at ${f.throughputPct}% of the day's avg rate)` : '');
async function jget(url, opts) {
  const res = await fetch(url, opts);
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || `Request failed (${res.status})`);
  return d;
}

// The raw tail of the feed: the last N (station, timestamp) records, pulled LIVE
// from Looker on open/refresh (cache-bypassed server-side) — so you can see what
// the pipe actually delivered, not just the lag number. (Inline fetch, same
// reasoning as TestModeBanner: keep this module out of the shared lib/api.js.)
function LatestRecords({ monitorId, base = ADMIN_BASE }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = async () => {
    setBusy(true); setErr('');
    try {
      const res = await fetch(`${base}/monitors/${monitorId}/latest?limit=20`);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `Request failed (${res.status})`);
      setData(d);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load is stable per monitor; refetch only when the monitor changes
  useEffect(() => { load(); }, [monitorId]);
  if (err) return <div style={{ fontSize: 12.5, color: STATUS_COLOR.stale }}>⚠️ {err} <button style={{ ...ghostBtn, marginLeft: 8 }} onClick={load}>Retry</button></div>;
  if (!data) return <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Pulling the latest records from Looker…</div>;
  const hasStation = !!data.stationField;
  const extras = data.detailFields || [];
  // "cashless_check_ins.record_type" → "Record Type" — good enough for a header.
  const colName = (f) => String(f).split('.').pop().replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Newest first, straight off the explore (identical station+time records collapse into one row).</span>
        <span style={{ flex: 1 }} />
        <button style={{ ...ghostBtn, padding: '4px 10px' }} disabled={busy} onClick={load}>{busy ? 'Refreshing…' : '🔄 Refresh'}</button>
      </div>
      {!data.records.length ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No records found — check the monitor’s filters and scope.</div> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
              <th style={{ padding: '4px 8px 4px 0', fontWeight: 600 }}>#</th>
              {hasStation && <th style={{ padding: '4px 8px', fontWeight: 600 }}>Station</th>}
              {extras.map((f) => <th key={f} style={{ padding: '4px 8px', fontWeight: 600 }}>{colName(f)}</th>)}
              <th style={{ padding: '4px 8px', fontWeight: 600 }}>Record time</th>
              <th style={{ padding: '4px 8px', fontWeight: 600 }}>Age</th>
            </tr></thead>
            <tbody>{data.records.map((r, i) => (
              <tr key={i} style={{ borderTop: '1px solid var(--hairline)' }}>
                <td style={{ padding: '4px 8px 4px 0', color: 'var(--muted)' }}>{i + 1}</td>
                {hasStation && <td style={{ padding: '4px 8px', fontWeight: 600 }}>{r.station || '—'}</td>}
                {extras.map((f) => <td key={f} style={{ padding: '4px 8px' }}>{(r.extra && r.extra[f]) || '—'}</td>)}
                <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>{r.at ? fmtAt(r.at) : r.raw}</td>
                <td style={{ padding: '4px 8px', color: r.agoMin != null && r.agoMin < 30 ? STATUS_COLOR.fresh : 'var(--muted)' }}>{r.agoMin != null ? `${fmtLag(r.agoMin)} ago` : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// The device roster: expected vs actual. Everything seen in the baseline window
// is "linked"; anything silent longer than the online window is offline, named,
// with how long it's been quiet — the go-check-these list.
function RosterPanel({ monitorId, base = ADMIN_BASE }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = async () => {
    setBusy(true); setErr('');
    try {
      const res = await fetch(`${base}/monitors/${monitorId}/roster`);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `Request failed (${res.status})`);
      setData(d);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load is stable per monitor; refetch only when the monitor changes
  useEffect(() => { load(); }, [monitorId]);
  if (err) return <div style={{ fontSize: 12.5, color: STATUS_COLOR.stale }}>⚠️ {err} <button style={{ ...ghostBtn, marginLeft: 8 }} onClick={load}>Retry</button></div>;
  if (!data) return <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Building the device roster from Looker…</div>;
  if (!data.configured) return <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No roster field set — pick a device/operator dimension in ✏️ Edit → Device roster.</div>;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>{data.total} linked</span>
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>({data.startAt ? `seen since ${fmtAt(data.startAt)}` : `seen in the last ${fmtLag(data.baselineMin)}`})</span>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: STATUS_COLOR.fresh }}>{data.online} online</span>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: data.offline.length ? STATUS_COLOR.stale : 'var(--muted)' }}>{data.offline.length} offline</span>
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>(no sync in {fmtLag(data.onlineMin)})</span>
        <span style={{ flex: 1 }} />
        <button style={{ ...ghostBtn, padding: '4px 10px' }} disabled={busy} onClick={load}>{busy ? 'Refreshing…' : '🔄 Refresh'}</button>
      </div>
      {data.truncated && <div style={{ fontSize: 11.5, color: STATUS_COLOR.warn, marginBottom: 6 }}>⚠️ Very busy window — idle devices may be under-counted; consider a shorter linked window.</div>}
      {!data.offline.length ? (
        <div style={{ fontSize: 12.5, color: STATUS_COLOR.fresh }}>✅ Every linked device has synced within the online window.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 4 }}>Check these — longest silent first:</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
              <th style={{ padding: '4px 8px 4px 0', fontWeight: 600 }}>Device</th>
              {data.offline.some((d) => d.station) && <th style={{ padding: '4px 8px', fontWeight: 600 }}>Station</th>}
              {data.offline.some((d) => d.operator) && <th style={{ padding: '4px 8px', fontWeight: 600 }}>Operator</th>}
              <th style={{ padding: '4px 8px', fontWeight: 600 }}>Last sync</th>
            </tr></thead>
            <tbody>{data.offline.map((d) => (
              <tr key={d.device} style={{ borderTop: '1px solid var(--hairline)' }}>
                <td style={{ padding: '5px 8px 5px 0', fontWeight: 700, color: STATUS_COLOR.stale }}>{d.device}</td>
                {data.offline.some((x) => x.station) && <td style={{ padding: '5px 8px' }}>{d.station || '—'}</td>}
                {data.offline.some((x) => x.operator) && <td style={{ padding: '5px 8px' }}>{d.operator || '—'}</td>}
                <td style={{ padding: '5px 8px' }}>{fmtLag(d.lagMin)} ago</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// The day timeline: rows = devices, columns = time blocks (5–60 min each),
// green = sent data in that block, grey = silent — the "see the impact through
// the whole day" view. A red device name means nothing in the last ~30 minutes.
// The 🔢 Counts mode turns the same grid into a report: scans per device per
// block, with per-device and per-block totals.
function TimelinePanel({ monitorId, base = ADMIN_BASE, stations = [], unit = 'scans' }) {
  const [data, setData] = useState(null);
  const [station, setStation] = useState(''); // '' = all stations; else one station's devices only
  const [hours, setHours] = useState('start'); // 'start' = from the roster's start time; else rolling hours
  const [interval, setIntervalMin] = useState(10); // 10-min blocks by default — hour blocks hide short dropouts
  const [mode, setMode] = useState('blocks'); // 'blocks' (green/grey grid) | 'counts' (numbers report)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = async (h, iv, st = station) => {
    setBusy(true); setErr('');
    try {
      const res = await fetch(`${base}/monitors/${monitorId}/timeline?hours=${h}&interval=${iv}${st ? `&station=${encodeURIComponent(st)}` : ''}`);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `Request failed (${res.status})`);
      setData(d);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load is stable per monitor; refetch on monitor/window/block/station change
  useEffect(() => { load(hours, interval, station); }, [monitorId, hours, interval, station]);
  if (err) return <div style={{ fontSize: 12.5, color: STATUS_COLOR.stale }}>⚠️ {err} <button style={{ ...ghostBtn, marginLeft: 8 }} onClick={() => load(hours, interval)}>Retry</button></div>;
  if (!data) return <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Building the day timeline from Looker…</div>;
  if (!data.configured) return <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{data.reason || 'No roster field set — pick a device/operator dimension in ✏️ Edit → Device roster.'}</div>;
  const iv = data.intervalMin || 60;
  const hourLabel = (iso) => new Date(iso).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }).slice(0, 5);
  const bw = iv >= 30 ? 12 : 8; // finer blocks get narrower cells so more fit before scrolling
  const perLabel = Math.max(1, Math.round((data.hours <= 12 ? 60 : 180) / iv)); // a time label every 1h (short windows) or 3h
  const lookback = Math.max(1, Math.ceil(30 / iv)); // "live" = active within the last ~30 min
  // Online vs offline for the devices IN VIEW (the picked station's summary):
  // exact last-seen lag when the labels lookup delivered it, else recent blocks.
  const onlineMin = data.onlineMin || 30;
  const hasLag = data.devices.some((d) => d.lagMin != null);
  const onlineN = hasLag
    ? data.devices.filter((d) => d.lagMin != null && d.lagMin <= onlineMin).length
    : data.devices.filter((d) => d.active.slice(-lookback).some((a) => a === 1)).length;
  const offlineN = data.devices.length - onlineN;
  // All-stations view groups the rows under a station header — one glance per
  // station instead of one long pile. A picked station needs no grouping.
  const grouped = (!station && data.devices.some((d) => d.station))
    ? [...data.devices.reduce((m, d) => {
      const k = d.station || 'No station';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(d); return m;
    }, new Map()).entries()].sort((a, b) => a[0].localeCompare(b[0]))
    : null;
  const grpOnline = (devs) => (hasLag
    ? devs.filter((d) => d.lagMin != null && d.lagMin <= onlineMin).length
    : devs.filter((d) => d.active.slice(-lookback).some((a) => a === 1)).length);
  const stationHeader = (grpName, devs) => (
    <>
      <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.4, textTransform: 'uppercase' }}>{grpName}</span>{' '}
      <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--muted)' }}>
        {devs.length} device{devs.length === 1 ? '' : 's'} · <span style={{ color: STATUS_COLOR.fresh, fontWeight: 700 }}>{grpOnline(devs)} online</span> · <span style={{ color: devs.length - grpOnline(devs) ? STATUS_COLOR.stale : 'var(--muted)', fontWeight: 700 }}>{devs.length - grpOnline(devs)} offline</span>
      </span>
    </>
  );
  const maxCount = Math.max(1, ...data.devices.flatMap((d) => d.counts || []));
  const heat = (c) => `rgba(22, 163, 74, ${0.12 + 0.38 * Math.min(1, c / maxCount)})`; // busier block = deeper green
  const nameCell = { maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, fontWeight: 600, padding: '2px 8px 2px 0', textAlign: 'left' };
  const numCell = { fontSize: 10.5, padding: '2px 4px', textAlign: 'right', minWidth: 26, fontVariantNumeric: 'tabular-nums' };
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>{data.devices.length} device{data.devices.length === 1 ? '' : 's'}</span>
        {data.devices.length > 0 && (
          <span style={{ fontSize: 12.5 }}>
            <strong style={{ color: STATUS_COLOR.fresh }}>{onlineN} online</strong>
            {' · '}
            <strong style={{ color: offlineN ? STATUS_COLOR.stale : 'var(--muted)' }}>{offlineN} offline</strong>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}> (no sync in {onlineMin}m)</span>
          </span>
        )}
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{mode === 'counts' ? `${unit} per ${iv >= 60 ? 'hour' : `${iv} min`} · darker green = busier` : `each block = ${iv >= 60 ? '1 hour' : `${iv} min`} · green = sent data · grey = silent`}</span>
        {stations.length > 1 && (
          <select value={station} disabled={busy} onChange={(e) => setStation(e.target.value)}
            style={{ ...input, width: 'auto', maxWidth: 230, padding: '4px 8px', fontSize: 12 }}>
            <option value="">🏪 All stations</option>
            {stations.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        <span style={{ flex: 1 }} />
        {[['blocks', '🟩 Blocks'], ['counts', '🔢 Counts']].map(([k, l]) => (
          <button key={k} style={{ ...ghostBtn, padding: '4px 10px', ...(mode === k ? { borderColor: 'var(--brand)', color: 'var(--brand)' } : null) }} onClick={() => setMode(k)}>{l}</button>
        ))}
        <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--hairline)' }} />
        {[['start', '▶ Start'], [12, '12h'], [24, '24h'], [48, '48h']].map(([h, l]) => (
          <button key={h} style={{ ...ghostBtn, padding: '4px 10px', ...(hours === h ? { borderColor: 'var(--brand)', color: 'var(--brand)' } : null) }} disabled={busy} onClick={() => setHours(h)}>{l}</button>
        ))}
        <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--hairline)' }} />
        {[5, 10, 20, 30, 60].map((m) => (
          <button key={m} style={{ ...ghostBtn, padding: '4px 8px', ...(interval === m ? { borderColor: 'var(--brand)', color: 'var(--brand)' } : null) }} disabled={busy} onClick={() => setIntervalMin(m)}>{m === 60 ? '1h' : `${m}m`}</button>
        ))}
        <button style={{ ...ghostBtn, padding: '4px 10px' }} disabled={busy} onClick={() => load(hours, interval)}>{busy ? '…' : '🔄'}</button>
      </div>
      {data.anchored && data.startAt && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 6 }}>From the start time — {new Date(data.startAt).toLocaleString('en-ZA', { weekday: 'short', hour: '2-digit', minute: '2-digit' })} to now.</div>}
      {hours === 'start' && data.anchored === false && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 6 }}>No start time set on this monitor — showing the last 24h. Set "Daily from" or a once-off start in ✏️ Edit → Device roster.</div>}
      {(data.trimmedStart || (typeof hours === 'number' && data.hours < hours)) && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 6 }}>Showing the last {data.hours}h — {iv}-min blocks cap the grid; pick a bigger block for a longer window.</div>}
      {data.truncated && <div style={{ fontSize: 11.5, color: STATUS_COLOR.warn, marginBottom: 6 }}>⚠️ Very busy window — some blocks may be missing; try a shorter range, bigger blocks, or pick one station.</div>}
      {(data.devicesTotal || 0) > data.devices.length && <div style={{ fontSize: 11.5, color: STATUS_COLOR.warn, marginBottom: 6 }}>Showing {data.devices.length} of {data.devicesTotal} devices — pick a station above to see the rest.</div>}
      {!data.devices.length ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No device activity in this window.</div> : mode === 'counts' ? (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...nameCell, color: 'var(--muted)', fontWeight: 400, fontSize: 10.5 }}>Device</th>
                {data.buckets.map((b, i) => (
                  <th key={b} style={{ ...numCell, color: 'var(--muted)', fontWeight: 400, fontSize: 8.5 }}>{i % perLabel === 0 ? hourLabel(b) : ''}</th>
                ))}
                <th style={{ ...numCell, color: 'var(--muted)', fontWeight: 700, fontSize: 10.5 }}>Σ</th>
              </tr>
            </thead>
            {(grouped || [['', data.devices]]).map(([grpName, devs]) => (
              <tbody key={grpName || '__all'}>
                {grouped && <tr><td colSpan={data.buckets.length + 2} style={{ padding: '8px 8px 2px 0', whiteSpace: 'nowrap', textAlign: 'left' }}>{stationHeader(grpName, devs)}</td></tr>}
                {devs.map(({ device, counts, active, total, station: stn, operator: op }) => {
                  const liveNow = active.slice(-lookback).some((a) => a === 1);
                  const suffix = grouped ? op : `${stn || ''}${stn && op ? ' · ' : ''}${op || ''}`;
                  return (
                    <tr key={device}>
                      <td title={`${device}${stn ? ` — ${stn}` : ''}${op ? ` · ${op}` : ''}`} style={{ ...nameCell, color: liveNow ? 'var(--text)' : STATUS_COLOR.stale }}>
                        {device}{suffix ? <span style={{ fontWeight: 400, fontSize: 10, color: 'var(--muted)' }}> {suffix}</span> : null}
                      </td>
                      {counts.map((c, i) => (
                        <td key={i} title={`${hourLabel(data.buckets[i])} — ${c} ${c === 1 ? unit.replace(/s$/, '') : unit}`}
                          style={{ ...numCell, borderRadius: 2, background: c ? heat(c) : 'transparent', color: c ? 'var(--text)' : 'var(--muted)' }}>{c || '·'}</td>
                      ))}
                      <td style={{ ...numCell, fontWeight: 700 }}>{total}</td>
                    </tr>
                  );
                })}
              </tbody>
            ))}
            <tbody>
              <tr>
                <td style={{ ...nameCell, fontWeight: 700, borderTop: '1px solid var(--hairline)' }}>All devices</td>
                {data.bucketTotals.map((c, i) => (
                  <td key={i} style={{ ...numCell, fontWeight: 700, borderTop: '1px solid var(--hairline)' }}>{c || ''}</td>
                ))}
                <td style={{ ...numCell, fontWeight: 800, borderTop: '1px solid var(--hairline)' }}>{data.grandTotal}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          {/* Time scale: periodic labels aligned to the blocks. */}
          <div style={{ display: 'flex', gap: 2, marginLeft: 208, marginBottom: 2 }}>
            {data.buckets.map((b, i) => (
              <span key={b} style={{ width: bw, flexShrink: 0, fontSize: 8.5, color: 'var(--muted)', overflow: 'visible', whiteSpace: 'nowrap' }}>{i % perLabel === 0 ? hourLabel(b) : ''}</span>
            ))}
          </div>
          {(grouped || [['', data.devices]]).map(([grpName, devs]) => (
            <div key={grpName || '__all'}>
              {grouped && <div style={{ margin: '10px 0 3px' }}>{stationHeader(grpName, devs)}</div>}
              {devs.map(({ device, active, station: stn, operator: op }) => {
                const liveNow = active.slice(-lookback).some((a) => a === 1);
                const suffix = grouped ? op : `${stn || ''}${stn && op ? ' · ' : ''}${op || ''}`;
                return (
                  <div key={device} style={{ display: 'flex', alignItems: 'center', gap: 2, marginBottom: 2 }}>
                    <span title={`${device}${stn ? ` — ${stn}` : ''}${op ? ` · ${op}` : ''}`} style={{ width: 200, marginRight: 6, flexShrink: 0, fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span style={{ fontWeight: 600, color: liveNow ? 'var(--text)' : STATUS_COLOR.stale }}>{device}</span>
                      {suffix ? <span style={{ fontSize: 10, color: 'var(--muted)' }}> {suffix}</span> : null}
                    </span>
                    {active.map((a, i) => (
                      <span key={i} title={`${hourLabel(data.buckets[i])} — ${a ? 'active' : 'silent'}`}
                        style={{ width: bw, height: 16, flexShrink: 0, borderRadius: 2, background: a ? STATUS_COLOR.fresh : 'var(--hairline)' }} />
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Expandable history: the transition/alert feed + the raw pull log + a live peek
// at the last 20 records off the feed (+ the device roster when configured).
function HistoryPanel({ monitorId, rosterField, base = ADMIN_BASE, stations = [], unit = 'scans' }) {
  const [hist, setHist] = useState(null);
  // Roster monitors open straight onto the live timeline — that's the view the
  // card is expanded for; the history lists are one click away.
  const [tab, setTab] = useState(rosterField ? 'timeline' : 'events');
  useEffect(() => { jget(`${base}/monitors/${monitorId}/history`).then(setHist).catch(() => setHist({ checks: [], events: [] })); }, [monitorId, base]);
  if (!hist) return <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '8px 0' }}>Loading history…</div>;
  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--hairline)', paddingTop: 10 }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        {[['events', `Activity (${hist.events.length})`], ['checks', `Pull log (${hist.checks.length})`], ['latest', '🧾 Latest 20 (live)'],
          ...(rosterField ? [['roster', '📟 Devices (live)'], ['timeline', '📊 Timeline (live)']] : [])].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{ ...ghostBtn, padding: '5px 11px', ...(tab === k ? { borderColor: 'var(--brand)', color: 'var(--brand)' } : null) }}>{l}</button>
        ))}
      </div>
      {/* History lists scroll in place; the live tabs (Latest 20 / Devices /
          Timeline) get full height — a long device timeline should be seen
          whole, scrolling the page, not a letterbox. */}
      <div style={tab === 'events' || tab === 'checks' ? { maxHeight: 260, overflowY: 'auto' } : undefined}>
        {tab === 'events' && (hist.events.length ? hist.events.map((e, i) => {
          const [icon, color] = EVENT_META[e.kind] || ['·', 'var(--muted)'];
          return (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '5px 0', fontSize: 12.5, borderBottom: '1px solid var(--hairline)' }}>
              <span>{icon}</span>
              <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{fmtAt(e.at)}</span>
              {e.station ? <strong style={{ color }}>{e.station}</strong> : null}
              <span style={{ minWidth: 0 }}>{e.message}</span>
            </div>
          );
        }) : <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No activity yet — transitions (stale / recovered) and alerts will appear here.</div>)}
        {tab === 'checks' && (hist.checks.length ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead><tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
                <th style={{ padding: '4px 8px 4px 0', fontWeight: 600 }}>Pulled at</th><th style={{ padding: '4px 8px', fontWeight: 600 }}>Latest record</th>
                <th style={{ padding: '4px 8px', fontWeight: 600 }}>Stations</th><th style={{ padding: '4px 8px', fontWeight: 600 }}>Fresh / warn / stale</th><th style={{ padding: '4px 8px', fontWeight: 600 }}>Worst lag</th>
              </tr></thead>
              <tbody>{hist.checks.map((c, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--hairline)' }}>
                  <td style={{ padding: '5px 8px 5px 0', whiteSpace: 'nowrap' }}>{fmtAt(c.at)}</td>
                  {c.ok ? <>
                    <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }}>{fmtAt(c.latest_event_at)}</td>
                    <td style={{ padding: '5px 8px' }}>{c.stations}</td>
                    <td style={{ padding: '5px 8px' }}>
                      <span style={{ color: STATUS_COLOR.fresh }}>{c.fresh}</span> / <span style={{ color: STATUS_COLOR.warn }}>{c.warn}</span> / <span style={{ color: STATUS_COLOR.stale }}>{c.stale}</span>
                    </td>
                    <td style={{ padding: '5px 8px' }}>{fmtLag(c.max_lag_min)}</td>
                  </> : <td colSpan={4} style={{ padding: '5px 8px', color: STATUS_COLOR.warn }}>⚠️ Pull failed: {c.error}</td>}
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No pulls yet.</div>)}
        {tab === 'latest' && <LatestRecords monitorId={monitorId} base={base} />}
        {tab === 'roster' && <RosterPanel monitorId={monitorId} base={base} />}
        {tab === 'timeline' && <TimelinePanel monitorId={monitorId} base={base} stations={stations} unit={unit} />}
      </div>
    </div>
  );
}

// 🩺 One-tap AI diagnostics: the server pulls the station's live picture (lag,
// roster, per-device scan counts, timeline) and the AI returns a plain-language
// verdict with ranked concerns. Works on both surfaces via `base`.
function DiagnosePanel({ monitorId, base }) {
  const [state, setState] = useState(null); // null | 'busy' | {text, at} | {error}
  const run = async () => {
    setState('busy');
    try { setState(await jget(`${base}/monitors/${monitorId}/diagnose`, { method: 'POST' })); }
    catch (e) { setState({ error: e.message }); }
  };
  if (state == null) return <button style={{ ...ghostBtn, borderColor: 'var(--brand)', color: 'var(--brand)' }} onClick={run}>🩺 Diagnose</button>;
  if (state === 'busy') return <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>🩺 Reading the live feed, roster and timeline…</span>;
  if (state.error) return <span style={{ fontSize: 12.5, color: STATUS_COLOR.stale }}>⚠️ {state.error} <button style={{ ...ghostBtn, marginLeft: 6, padding: '3px 9px' }} onClick={run}>Retry</button></span>;
  return (
    <div style={{ border: '1px dashed var(--hairline)', borderRadius: 10, padding: '12px 14px', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <strong style={{ fontSize: 13 }}>🩺 Diagnostics — {fmtAt(state.at)}</strong>
        <span style={{ flex: 1 }} />
        <button style={{ ...ghostBtn, padding: '3px 9px' }} onClick={run}>↻ Re-run</button>
        <button style={{ ...ghostBtn, padding: '3px 9px' }} onClick={() => navigator.clipboard?.writeText(state.text)}>📋 Copy</button>
        <button style={{ ...ghostBtn, padding: '3px 9px' }} onClick={() => setState(null)}>✕</button>
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{state.text}</div>
    </div>
  );
}

function MonitorCard({ m, entities = [], onChanged, onEdit, base = ADMIN_BASE, readOnly = false }) {
  const [busy, setBusy] = useState('');
  // Cards start collapsed to one summary row — with many monitors the page
  // stays scannable. Expanding opens the log straight away (that's what you
  // expanded for), full-height so a big device timeline is fully visible.
  const [expanded, setExpanded] = useState(false);
  const [showHist, setShowHist] = useState(true);
  const [checkMsg, setCheckMsg] = useState('');
  // Clicking the offline count opens a LIVE offline list split by station.
  const [offPanel, setOffPanel] = useState(null); // null | 'busy' | roster json | {error}
  const loadOffline = async (e) => {
    e.stopPropagation();
    if (offPanel) { setOffPanel(null); return; }
    setOffPanel('busy');
    try { setOffPanel(await jget(`${base}/monitors/${m.id}/roster`)); }
    catch (err) { setOffPanel({ error: err.message }); }
  };
  const stale = m.streams.filter((s) => s.status === 'stale').length;
  const warn = m.streams.filter((s) => s.status === 'warn').length;
  const overall = m.status === 'closed' ? 'closed' : m.status === 'paused' ? 'paused' : m.lastError ? 'error' : stale ? 'stale' : warn ? 'warn' : m.streams.length ? 'fresh' : 'new';
  const headColor = overall === 'stale' || overall === 'error' ? STATUS_COLOR.stale : overall === 'warn' ? STATUS_COLOR.warn : overall === 'fresh' ? STATUS_COLOR.fresh : 'var(--muted)';
  const entityName = m.entityId ? (entities.find((e) => e.id === m.entityId)?.name || 'client') : '';

  const run = async (what, fn) => {
    setBusy(what); setCheckMsg('');
    try { await fn(); onChanged(); } catch (e) { setCheckMsg(e.message); }
    setBusy('');
  };
  const checkNow = () => run('check', async () => {
    const r = await api.checkDataMonitor(m.id);
    setCheckMsg(r.ok ? `Pulled ✓ — ${r.stations} stream${r.stations === 1 ? '' : 's'}, worst lag ${fmtLag(r.maxLagMin)}` : `Pull failed: ${r.error}`);
  });

  return (
    <div style={{ ...card, borderLeft: `4px solid ${headColor}`, opacity: m.status === 'paused' || m.status === 'closed' ? 0.75 : 1 }}>
      <div style={{ cursor: 'pointer' }} title={expanded ? 'Collapse' : 'Expand'} onClick={() => setExpanded((v) => !v)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minHeight: 28 }}>
          <Dot status={overall === 'error' ? 'stale' : overall === 'paused' || overall === 'new' ? undefined : overall} />
          <strong style={{ fontSize: 14.5 }}>{m.name}</strong>
          {m.area && <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 999, background: 'var(--hairline)', color: 'var(--text)' }}>{m.area}</span>}
          {m.status === 'paused' && <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}>PAUSED</span>}
          {m.status === 'closed' && <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 999, background: 'var(--hairline)', color: 'var(--muted)' }}>🚪 CLOSED</span>}
          {!expanded && m.lastError && <span style={{ fontSize: 11.5, fontWeight: 700, color: STATUS_COLOR.stale }}>pull failed</span>}
          {!expanded && !m.streams.length && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>no data yet</span>}
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>checked {ago(m.lastCheckedAt)}</span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{expanded ? '▾' : '▸'}</span>
        </div>
        {/* Collapsed peek: chips + roster line on the left, the coverage graph
            as a full-height chart column on the right (wraps below on mobile). */}
        {!expanded && (
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: '1 1 340px', minWidth: 0 }}>
        {m.streams.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, alignItems: 'center' }}>
            {m.streams.slice(0, 6).map((s) => <StationChip key={s.station || '__feed'} s={s} />)}
            {m.streams.length > 6 && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>+{m.streams.length - 6} more</span>}
          </div>
        )}
        {m.rosterField && m.rosterSnapshot && (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
            📟 <strong style={{ color: 'var(--text)' }}>{m.rosterSnapshot.total} linked</strong>
            {' '}({m.rosterSnapshot.startAt ? `seen since ${fmtAt(m.rosterSnapshot.startAt)}` : `last ${m.rosterSnapshot.baselineMin}m`})
            {' · '}<strong style={{ color: STATUS_COLOR.fresh }}>{m.rosterSnapshot.online} online</strong>
            {' · '}<strong style={{ color: m.rosterSnapshot.offline ? STATUS_COLOR.stale : 'var(--muted)', cursor: m.rosterSnapshot.offline ? 'pointer' : undefined, textDecoration: m.rosterSnapshot.offline ? 'underline dotted' : undefined }}
              onClick={m.rosterSnapshot.offline ? loadOffline : undefined}
              title={m.rosterSnapshot.offline ? 'Click for the live offline list, split by station' : undefined}>
              {m.rosterSnapshot.offline} offline{m.rosterSnapshot.total ? ` (${Math.round((m.rosterSnapshot.offline / m.rosterSnapshot.total) * 100)}%)` : ''}</strong>
            {' '}(no sync in {m.rosterSnapshot.onlineMin}m)
            {m.rosterSnapshot.flowScore != null && <>
              {' · '}<strong title={flowTitle(m.rosterSnapshot.flow)} style={{ color: flowColor(m.rosterSnapshot.flowScore) }}>flow {m.rosterSnapshot.flowScore}</strong>
            </>}
            {m.rosterSnapshot.scansPerHour != null && <>
              {' · '}<strong style={{ color: 'var(--text)' }}>{m.rosterSnapshot.scansApprox ? '≥' : ''}{Number(m.rosterSnapshot.totalScans).toLocaleString('en-ZA')} {unitFor(m)}</strong>
              {m.rosterSnapshot.lastHourScans != null && <> · last hour <strong style={{ color: 'var(--text)' }}>{Number(m.rosterSnapshot.lastHourScans).toLocaleString('en-ZA')}</strong></>}
              {' '}· ~{Number(m.rosterSnapshot.scansPerHour).toLocaleString('en-ZA')}/h avg
            </>}
          </div>
        )}
        {offPanel === 'busy' && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }} onClick={(e) => e.stopPropagation()}>Reading the live roster…</div>}
        {offPanel && offPanel !== 'busy' && (
          <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 6, border: '1px solid var(--hairline)', borderRadius: 8, padding: '8px 10px', cursor: 'default', fontSize: 12 }}>
            {offPanel.error ? <span style={{ color: STATUS_COLOR.stale }}>⚠️ {offPanel.error}</span> : (() => {
              const off = offPanel.offline || [];
              const by = new Map();
              for (const d of off) { const k = d.station || 'No station'; if (!by.has(k)) by.set(k, []); by.get(k).push(d); }
              const groups = [...by.entries()].sort((a, b) => b[1].length - a[1].length);
              const missing = Math.max(0, (offPanel.total - offPanel.online) - off.length);
              return (
                <div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
                    <strong style={{ color: off.length ? STATUS_COLOR.stale : STATUS_COLOR.fresh }}>{off.length} offline device{off.length === 1 ? '' : 's'}</strong>
                    <span style={{ color: 'var(--muted)', fontSize: 11 }}>live read · no sync in {offPanel.onlineMin}m{missing ? ` · +${missing} more` : ''}</span>
                    <span style={{ flex: 1 }} />
                    <button style={{ ...ghostBtn, padding: '1px 8px', fontSize: 11 }} onClick={(e) => { e.stopPropagation(); setOffPanel(null); }}>✕</button>
                  </div>
                  {!off.length ? <span style={{ color: STATUS_COLOR.fresh }}>✅ Every linked device has synced within the online window.</span> : groups.map(([stn, devs]) => (
                    <div key={stn} style={{ marginTop: 4 }}>
                      <div style={{ fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.4 }}>{stn} <span style={{ color: STATUS_COLOR.stale }}>{devs.length}</span></div>
                      <div style={{ color: 'var(--muted)' }}>{devs.map((d) => `${d.device} (${Math.round(d.lagMin)}m${d.operator ? ` · ${d.operator}` : ''})`).join(' · ')}</div>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        )}
        </div>
        {/* The approved tile graph: one bar per stored block, full height,
            grey stubs for zero blocks, SA-time labels at the ends. */}
        {m.rosterField && (m.rosterSnapshot?.coverage?.length || 0) > 1 && (() => {
          const cov = m.rosterSnapshot.coverage;
          const max = Math.max(1, ...cov.map((c) => c.n));
          return (
            <div style={{ flex: '0 1 320px', minWidth: 240, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
              <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>Devices online through the day</div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 52 }}>
                {cov.map((c, i) => (
                  <span key={i} title={`${saTime(c.t)} SA — ${c.n} of ${max} devices sending`}
                    style={{ flex: 1, maxWidth: 30, borderRadius: '3px 3px 0 0', height: c.n ? Math.max(3, Math.round((c.n / max) * 52)) : 3, background: c.n ? STATUS_COLOR.fresh : 'var(--hairline)' }} />
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, color: 'var(--muted)', marginTop: 3 }}>
                <span>{saTime(cov[0].t)}</span>
                {cov.length > 4 && <span>{saTime(cov[Math.floor(cov.length / 2)].t)}</span>}
                <span>{saTime(cov[cov.length - 1].t)}</span>
              </div>
            </div>
          );
        })()}
        </div>
        )}
      </div>
      {expanded && <>
      <div style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0 10px' }}>
        {readOnly ? (
          <>Watching {m.streams.length || 'the'} stream{m.streams.length === 1 ? '' : 's'} · warn after {m.warnMin}m of silence · stale after {m.staleMin}m</>
        ) : (
          <>
            {m.view} · <code style={{ fontSize: 11.5 }}>{m.timeField}</code>
            {m.stationField ? <> · split by <code style={{ fontSize: 11.5 }}>{m.stationField}</code></> : ' · whole feed'}
            {entityName ? ` · scoped to ${entityName}` : ' · platform-wide'}
            {' '}· every {m.checkEveryMin >= 1 ? `${m.checkEveryMin}m` : 'master'} · warn {m.warnMin}m · stale {m.staleMin}m
          </>
        )}
      </div>
      {m.lastError && <div style={{ fontSize: 12.5, color: STATUS_COLOR.stale, marginBottom: 8 }}>⚠️ Last pull failed: {m.lastError}</div>}
      {m.streams.length ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          {m.streams.map((s) => (
            <StationChip key={s.station || '__feed'} s={s}
              onForget={readOnly ? undefined : () => run('forget', () => api.forgetDataStream(m.id, s.station))} />
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10 }}>{readOnly ? 'No data pulled yet.' : <>No data pulled yet — hit <strong>Check now</strong> to take the first reading.</>}</div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {!readOnly && <>
          <button style={ghostBtn} disabled={!!busy} onClick={checkNow}>{busy === 'check' ? 'Checking…' : '🔄 Check now'}</button>
          <button style={ghostBtn} onClick={() => setShowHist((v) => !v)}>{showHist ? 'Hide log' : '📜 Log'}</button>
          <button style={ghostBtn} onClick={() => onEdit(m)}>✏️ Edit</button>
          <button style={ghostBtn} title="Open the editor pre-filled with this monitor's setup, saved as a new monitor"
            onClick={() => onEdit({ ...m, id: undefined, name: `${m.name} (copy)` })}>⧉ Duplicate</button>
          <button style={ghostBtn} disabled={!!busy} onClick={() => run('pause', () => api.setDataMonitorStatus(m.id, m.status === 'paused' ? 'active' : 'paused'))}>
            {m.status === 'paused' ? '▶️ Resume' : '⏸ Pause'}
          </button>
          <button style={ghostBtn} disabled={!!busy}
            title="Closed = the station is intentionally shut (gate closed for the night) — no checks, no alerts; its devices leave the fleet numbers, but its scans/transactions still count in the day totals"
            onClick={() => run('close', () => api.setDataMonitorStatus(m.id, m.status === 'closed' ? 'active' : 'closed'))}>
            {m.status === 'closed' ? '🚪 Reopen' : '🚪 Mark closed'}
          </button>
          <button style={{ ...ghostBtn, color: STATUS_COLOR.stale }} disabled={!!busy}
            onClick={() => { if (window.confirm(`Delete monitor “${m.name}” and its history?`)) run('del', () => api.deleteDataMonitor(m.id)); }}>🗑</button>
        </>}
        <DiagnosePanel monitorId={m.id} base={base} />
        {checkMsg && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{checkMsg}</span>}
      </div>
      {showHist && <HistoryPanel monitorId={m.id} rosterField={m.rosterField} base={base} stations={m.streams.map((s) => s.station).filter(Boolean)} unit={unitFor(m)} />}
      </>}
    </div>
  );
}

// 📝 The event-level Data health & diagnostics report: every station of the
// event in one AI-written Markdown document — for the ops team, and clean
// enough to forward to a network provider. Light markdown rendering; Copy /
// Download (.md) / Print for sharing.
function ReportPanel({ url, body, title }) {
  const [state, setState] = useState(null); // null | 'busy' | {markdown, at} | {error}
  const run = async () => {
    setState('busy');
    try { setState(await jget(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })); }
    catch (e) { setState({ error: e.message }); }
  };
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([state.markdown], { type: 'text/markdown' }));
    a.download = `${(title || 'data-health-report').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
    a.click(); URL.revokeObjectURL(a.href);
  };
  const print = () => {
    const w = window.open('', '_blank');
    w.document.write(`<title>${title || 'Data health report'}</title><pre style="font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;white-space:pre-wrap;max-width:800px;margin:24px auto;">${state.markdown.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`);
    w.document.close(); w.print();
  };
  const mdLine = (line, i) => {
    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) return <div key={i} style={{ fontWeight: 800, fontSize: h[1].length === 1 ? 16 : h[1].length === 2 ? 14 : 13, margin: '12px 0 4px' }}>{h[2].replace(/\*\*/g, '')}</div>;
    const bold = line.split(/(\*\*[^*]+\*\*)/g).map((p, j) => (p.startsWith('**') && p.endsWith('**') ? <strong key={j}>{p.slice(2, -2)}</strong> : p));
    if (/^\s*\|/.test(line)) return <div key={i} style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11.5, whiteSpace: 'pre' }}>{line}</div>;
    return <div key={i} style={{ minHeight: line.trim() ? undefined : 8 }}>{bold}</div>;
  };
  if (state == null) return <button style={{ ...ghostBtn, borderColor: 'var(--brand)', color: 'var(--brand)' }} onClick={run}>📝 Draft health report</button>;
  if (state === 'busy') return <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>📝 Reading every station and drafting the report…</span>;
  if (state.error) return <span style={{ fontSize: 12.5, color: STATUS_COLOR.stale }}>⚠️ {state.error} <button style={{ ...ghostBtn, marginLeft: 6, padding: '3px 9px' }} onClick={run}>Retry</button></span>;
  const charts = (state.charts || []).filter((c) => c.coverage && c.coverage.length);
  const num = (v) => (v == null ? '—' : Number(v).toLocaleString('en-ZA'));
  const sum = (k) => ((state.charts || []).some((c) => c[k] != null) ? (state.charts || []).reduce((a, c) => a + (c[k] || 0), 0) : null);
  const utcLabel = (hhmm) => { const [h, mm] = hhmm.split(':').map(Number); return `${String((h + 2) % 24).padStart(2, '0')}:${String(mm).padStart(2, '0')}`; };
  // One tile pair per metric — scans and transactions are never summed together.
  const rTiles = [];
  for (const u of ['scans', 'transactions']) {
    const cs = (state.charts || []).filter((c) => (c.unit || 'scans') === u);
    if (!cs.length) continue;
    const sumU = (k) => (cs.some((c) => c[k] != null) ? cs.reduce((a, c) => a + (c[k] || 0), 0) : null);
    const shortU = u === 'transactions' ? 'txns' : 'scans';
    rTiles.push([`Total ${shortU}`, num(sumU('totalScans'))], [`Avg ${shortU}/h`, num(sumU('scansPerHour'))]);
  }
  return (
    <div style={{ ...card, borderLeft: '4px solid var(--brand)', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13.5 }}>📝 Data health & diagnostics report — {fmtAt(state.at)}</strong>
        <span style={{ flex: 1 }} />
        <button style={{ ...ghostBtn, padding: '3px 9px' }} onClick={run}>↻ Redraft</button>
        <button style={{ ...ghostBtn, padding: '3px 9px' }} onClick={() => navigator.clipboard?.writeText(state.markdown)}>📋 Copy</button>
        <button style={{ ...ghostBtn, padding: '3px 9px' }} onClick={download}>⬇️ Download</button>
        <button style={{ ...ghostBtn, padding: '3px 9px' }} onClick={print}>🖨 Print / PDF</button>
        <button style={{ ...ghostBtn, padding: '3px 9px' }} onClick={() => setState(null)}>✕</button>
      </div>
      {/* Metric tiles — computed from the live data, not the AI text. */}
      {(state.charts || []).length > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          {[['Stations', num((state.charts || []).length)], ['Devices linked', num(sum('linked'))],
            ['Online', num(sum('online')), STATUS_COLOR.fresh], ['Offline', num(sum('offline')), sum('offline') ? STATUS_COLOR.stale : undefined],
            ...rTiles].map(([l, v, c]) => (
            <div key={l} style={{ border: '1px solid var(--hairline)', borderRadius: 10, padding: '8px 14px', minWidth: 92 }}>
              <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--muted)' }}>{l}</div>
              <div style={{ fontSize: 18, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: c || 'var(--text)' }}>{v}</div>
            </div>
          ))}
        </div>
      )}
      {/* Per-station coverage strips: devices sending per time block — the
          offline-trend picture behind report §4. One series per strip, so the
          row label carries identity; hover a column for the exact reading. */}
      {charts.map((c) => {
        const max = Math.max(1, c.devicesSeen, ...c.coverage.map((p) => p.activeDevices));
        const perLabel = Math.max(1, Math.round(180 / (c.intervalMin || 10)));
        return (
          <div key={c.station} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 12.5 }}>
              <strong>{c.station}</strong>
              {c.area && <span style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 8px', borderRadius: 999, background: 'var(--hairline)' }}>{c.area}</span>}
              <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                {num(c.linked)} linked · <span style={{ color: STATUS_COLOR.fresh, fontWeight: 700 }}>{num(c.online)} online</span> ·{' '}
                <span style={{ color: c.offline ? STATUS_COLOR.stale : 'var(--muted)', fontWeight: 700 }}>{num(c.offline)} offline</span> ·{' '}
                {num(c.totalScans)} {c.unit || 'scans'} · ~{num(c.scansPerHour)}/h
              </span>
            </div>
            <div style={{ overflowX: 'auto', paddingTop: 4 }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 40 }}>
                {c.coverage.map((pt, i) => (
                  <span key={i} title={`${utcLabel(pt.atUTC)} SA — ${pt.activeDevices} of ${max} devices sending`}
                    style={{ width: 5, flexShrink: 0, borderRadius: '2px 2px 0 0', height: Math.max(2, Math.round((pt.activeDevices / max) * 40)),
                      background: pt.activeDevices ? STATUS_COLOR.fresh : 'var(--hairline)' }} />
                ))}
              </div>
              <div style={{ display: 'flex', gap: 1, borderTop: '1px solid var(--hairline)', marginTop: 1 }}>
                {c.coverage.map((pt, i) => (
                  <span key={i} style={{ width: 5, flexShrink: 0, fontSize: 8, color: 'var(--muted)', overflow: 'visible', whiteSpace: 'nowrap' }}>{i % perLabel === 0 ? utcLabel(pt.atUTC) : ''}</span>
                ))}
              </div>
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6 }}>Devices sending per {c.intervalMin || 10}-min block (bar height = share of {max}) — dips are the offline windows; times SA.</div>
          </div>
        );
      })}
      <div style={{ fontSize: 13, lineHeight: 1.6, overflowX: 'auto', borderTop: charts.length ? '1px solid var(--hairline)' : 'none', paddingTop: charts.length ? 10 : 0 }}>{state.markdown.split('\n').map(mdLine)}</div>
    </div>
  );
}

// Permanent metrics row: fleet + volume headline computed from the stored
// snapshots (no live queries) — shown on the Admin page and the client tab.
function HealthMetrics({ monitors: allMonitors }) {
  // Closed stations are intentionally shut — their silence must not drag the
  // fleet numbers (devices/online/offline/flow). Their trading DID happen,
  // though, so the volume totals still count their frozen snapshots.
  const monitors = allMonitors.filter((m) => m.status !== 'closed');
  const snaps = monitors.map((m) => m.rosterSnapshot).filter(Boolean);
  const volSnaps = allMonitors.map((m) => m.rosterSnapshot).filter(Boolean); // incl. closed
  if (!volSnaps.length) return null;
  const sumOf = (arr, k) => (arr.some((x) => x[k] != null) ? arr.reduce((a, x) => a + (x[k] || 0), 0) : null);
  const sum = (k) => sumOf(snaps, k);
  const num = (v) => (v == null ? '—' : Number(v).toLocaleString('en-ZA'));
  // Scans (gates) and transactions (bars/vendors) are DIFFERENT metrics — each
  // unit gets its own volume tiles, never summed together. Totals include
  // closed stations' frozen snapshots; last-hour/avg only the open ones.
  const volTiles = [];
  for (const u of ['scans', 'transactions']) {
    const vol = allMonitors.filter((m) => m.rosterSnapshot && unitFor(m) === u).map((m) => m.rosterSnapshot);
    if (!vol.length) continue;
    const open = monitors.filter((m) => m.rosterSnapshot && unitFor(m) === u).map((m) => m.rosterSnapshot);
    const ap = vol.some((x) => x.scansApprox) ? '≥' : '';
    const shortU = u === 'transactions' ? 'txns' : 'scans';
    volTiles.push(
      [`Total ${shortU}`, sumOf(vol, 'totalScans') == null ? '—' : `${ap}${num(sumOf(vol, 'totalScans'))}`],
      [`Last hr ${shortU}`, num(sumOf(open, 'lastHourScans'))],
      [`Avg ${shortU}/h`, sumOf(open, 'scansPerHour') == null ? '—' : `~${num(sumOf(open, 'scansPerHour'))}`],
    );
  }
  const scored = snaps.filter((x) => x.flowScore != null && x.total);
  const flowAgg = scored.length ? Math.round(scored.reduce((a, x) => a + x.flowScore * x.total, 0) / Math.max(1, scored.reduce((a, x) => a + x.total, 0))) : null;
  const tiles = [
    ['Flow score', flowAgg == null ? '—' : String(flowAgg), flowColor(flowAgg)],
    ['Stations', num(monitors.length)],
    ['Devices linked', num(sum('total'))],
    ['Online', num(sum('online')), STATUS_COLOR.fresh],
    ['Offline', sum('offline') == null ? '—' : `${num(sum('offline'))}${sum('total') ? ` (${Math.round((sum('offline') / Math.max(1, sum('total'))) * 100)}%)` : ''}`, sum('offline') ? STATUS_COLOR.stale : undefined],
    ...volTiles,
  ];
  // Which stations the offline devices belong to — the drill-down for the
  // Offline tile, visible without hovering anything.
  const offenders = monitors
    .filter((m) => m.rosterSnapshot && m.rosterSnapshot.offline > 0)
    .sort((a, b) => b.rosterSnapshot.offline - a.rosterSnapshot.offline)
    .map((m) => ({ name: m.name, s: m.rosterSnapshot }));
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {tiles.map(([l, v, c]) => (
          <div key={l} style={{ background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 10, padding: '8px 14px', minWidth: 92 }}>
            <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--muted)' }}>{l}</div>
            <div style={{ fontSize: 18, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: c || 'var(--text)' }}>{v}</div>
          </div>
        ))}
      </div>
      {offenders.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
          Offline by station:{' '}
          {offenders.map(({ name, s: sn }, i) => (
            <span key={name} title={(sn.offlineDevices || []).length ? `${name} offline: ${sn.offlineDevices.map((d) => `${d.device} (${Math.round(d.lagMin)}m)`).join(', ')}${sn.offline > sn.offlineDevices.length ? ` +${sn.offline - sn.offlineDevices.length} more` : ''}` : undefined}
              style={{ cursor: (sn.offlineDevices || []).length ? 'help' : undefined }}>
              {i > 0 && ' · '}<strong style={{ color: STATUS_COLOR.stale }}>{name} {sn.offline}</strong>
              {sn.total ? ` (${Math.round((sn.offline / sn.total) * 100)}%)` : ''}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// One client·event group on the Admin page: its own health row, opened to the
// monitor cards — the platform overview drills down instead of a flat list.
function MonitorGroup({ label, monitors, entities, onChanged, onEdit, defaultOpen, reportBody }) {
  const [open, setOpen] = useState(defaultOpen);
  const openMons = monitors.filter((m) => m.status !== 'closed');
  const streams = openMons.flatMap((m) => m.streams);
  const staleN = streams.filter((s) => s.status === 'stale').length + openMons.filter((m) => m.lastError).length;
  const warnN = streams.filter((s) => s.status === 'warn').length;
  const dot = staleN ? 'stale' : warnN ? 'warn' : streams.length ? 'fresh' : undefined;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '12px 16px', marginBottom: open ? 10 : 0, cursor: 'pointer' }}
        title={open ? 'Collapse' : 'Expand'} onClick={() => setOpen((v) => !v)}>
        <Dot status={dot} />
        <strong style={{ fontSize: 14 }}>{label}</strong>
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
          {monitors.length} monitor{monitors.length === 1 ? '' : 's'} · {streams.length} stream{streams.length === 1 ? '' : 's'} ·{' '}
          {staleN ? <span style={{ color: STATUS_COLOR.stale, fontWeight: 700 }}>{staleN} stale</span>
            : warnN ? <span style={{ color: STATUS_COLOR.warn, fontWeight: 700 }}>{warnN} warn</span>
              : streams.length ? <span style={{ color: STATUS_COLOR.fresh, fontWeight: 700 }}>all fresh</span>
                : <span>no data yet</span>}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div style={{ marginLeft: 14 }}>
          {reportBody && <div style={{ marginBottom: 10 }}><ReportPanel url={`${ADMIN_BASE}/report`} body={reportBody} title={`Data health — ${label}`} /></div>}
          {monitors.map((m) => (
            <MonitorCard key={m.id} m={m} entities={entities} onChanged={onChanged} onEdit={onEdit} />
          ))}
        </div>
      )}
    </div>
  );
}

// Field pickers get one <optgroup> per Looker view, labelled with the fields'
// shared label prefix ("Check-Ins", "Closed Loop Sales", …) which is stripped
// from each option — so the dropdown reads Date Time / Created At Hour instead
// of a flat wall of forty near-identical names. timeFirst floats full-timestamp
// variants to the top of each group (they're the recommended pick).
function groupFields(list, { timeFirst = false } = {}) {
  const byView = new Map();
  for (const d of list || []) {
    const v = String(d.name).split('.')[0];
    if (!byView.has(v)) byView.set(v, []);
    byView.get(v).push(d);
  }
  const out = [];
  for (const [v, arr] of byView) {
    let prefix = arr.length > 1 ? String(arr[0].label || '') : '';
    for (const d of arr) {
      const l = String(d.label || '');
      let i = 0; while (i < prefix.length && i < l.length && prefix[i] === l[i]) i++;
      prefix = prefix.slice(0, i);
    }
    prefix = prefix.replace(/[^ ]*$/, '').trim(); // never cut mid-word
    const title = prefix.length >= 3 ? prefix : v.replace(/^(cashless|core)_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const items = arr.map((d) => ({ ...d, short: (prefix.length >= 3 && String(d.label).startsWith(prefix) && String(d.label).slice(prefix.length).trim()) || d.label }));
    items.sort((a, b) => (timeFirst ? (/time/i.test(String(b.type || '')) ? 1 : 0) - (/time/i.test(String(a.type || '')) ? 1 : 0) : 0) || String(a.short).localeCompare(String(b.short)));
    out.push([title, items]);
  }
  return out.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

// Searchable field picker with collapsible family sections — replaces the
// native <select> whose flat list of hundreds of Looker fields was unusable.
// Sections start collapsed (except the selected field's); typing searches
// across every family by label or field name.
function FieldPicker({ value, onChange, fields, timeFirst = false, noneLabel = '', placeholder = '— pick a field —', tag = null }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [openGroups, setOpenGroups] = useState({});
  const boxRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const groups = groupFields(fields || [], { timeFirst });
  // Several views can share a label prefix (three different "Event Sales"
  // families…) — make repeated section titles unique with the view name, and
  // show the raw field name on every row so twins are tellable apart.
  const titleCount = {};
  groups.forEach(([g]) => { titleCount[g] = (titleCount[g] || 0) + 1; });
  const groupTitle = (g, items) => (titleCount[g] > 1
    ? `${g} — ${String(items[0]?.name || '').split('.')[0].replace(/^(cashless|core|check_ins?)_/i, '').replace(/_/g, ' ')}`
    : g);
  const ql = q.trim().toLowerCase();
  const hit = (d) => !ql || String(d.label || '').toLowerCase().includes(ql) || String(d.name || '').toLowerCase().includes(ql);
  const sel = (fields || []).find((d) => d.name === value);
  const pick = (name) => { onChange(name); setOpen(false); setQ(''); };
  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <button type="button" style={{ ...input, textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }} onClick={() => setOpen((v) => !v)}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: sel || value ? 'var(--text)' : 'var(--muted)' }}>
          {sel ? `${(groupFields([sel])[0] || [''])[0]} · ${sel.label}` : (value || (noneLabel && !value ? noneLabel : placeholder))}
        </span>
        <span style={{ fontSize: 10, color: 'var(--muted)' }}>▾</span>
      </button>
      {open && (
        <div style={{ position: 'absolute', zIndex: 60, top: '100%', left: 0, right: 0, marginTop: 4, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 8px 28px rgba(0,0,0,.16)', maxHeight: 340, display: 'flex', flexDirection: 'column' }}>
          <input autoFocus style={{ ...input, border: 'none', borderBottom: '1px solid var(--hairline)', borderRadius: '10px 10px 0 0' }}
            placeholder="Search fields…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div style={{ overflowY: 'auto' }}>
            {noneLabel && !ql && (
              <div style={{ padding: '8px 12px', fontSize: 12.5, cursor: 'pointer', fontWeight: value ? 400 : 700, borderBottom: '1px solid var(--hairline)' }} onClick={() => pick('')}>{noneLabel}</div>
            )}
            {groups.map(([g, items]) => {
              const matches = items.filter(hit);
              if (!matches.length) return null;
              const expanded = ql ? true : (openGroups[g] ?? items.some((d) => d.name === value));
              return (
                <div key={g}>
                  <div style={{ padding: '7px 12px', fontSize: 11, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase', color: 'var(--muted)', cursor: 'pointer', background: 'var(--hairline)', display: 'flex', gap: 6, alignItems: 'center', position: 'sticky', top: 0 }}
                    onClick={() => setOpenGroups((og) => ({ ...og, [g]: !expanded }))}>
                    <span>{expanded ? '▾' : '▸'}</span><span style={{ flex: 1 }}>{groupTitle(g, items)}</span><span style={{ fontWeight: 400 }}>{matches.length}</span>
                  </div>
                  {expanded && matches.map((d) => (
                    <div key={d.name} style={{ padding: '7px 12px 7px 26px', fontSize: 12.5, cursor: 'pointer', fontWeight: d.name === value ? 700 : 400, color: d.name === value ? 'var(--brand)' : 'var(--text)', display: 'flex', gap: 8, alignItems: 'baseline' }}
                      onClick={() => pick(d.name)}>
                      <span style={{ flexShrink: 0 }}>{d.short || d.label}{tag ? tag(d) : ''}</span>
                      <span style={{ fontSize: 10.5, color: 'var(--muted)', fontFamily: 'ui-monospace, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                    </div>
                  ))}
                </div>
              );
            })}
            {!groups.some(([, items]) => items.some(hit)) && <div style={{ padding: '10px 12px', fontSize: 12.5, color: 'var(--muted)' }}>No fields match “{q}”.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// Scrollable value combo for the linked filter values — the native <datalist>
// can't scroll hundreds of events in Safari. Free typing still works; the
// panel just offers the (scoped) real values, filtered as you type.
function ValueCombo({ value, onChange, options, loading, onFocusLoad }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const q = String(value || '').toLowerCase();
  const list = (options || []).filter((v) => !q || String(v).toLowerCase().includes(q));
  return (
    <div ref={boxRef} style={{ position: 'relative', flex: 1 }}>
      <input style={{ ...input, width: '100%' }} value={value}
        placeholder={loading ? 'loading values…' : (options || []).length ? 'pick or type a value (blank = not applied yet)' : 'value (blank = not applied yet)'}
        onFocus={() => { onFocusLoad(); setOpen(true); }}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }} />
      {open && list.length > 0 && (
        <div style={{ position: 'absolute', zIndex: 60, top: '100%', left: 0, right: 0, marginTop: 4, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 8px 28px rgba(0,0,0,.16)', maxHeight: 260, overflowY: 'auto' }}>
          {list.slice(0, 200).map((v) => (
            <div key={v} style={{ padding: '7px 12px', fontSize: 12.5, cursor: 'pointer', fontWeight: v === value ? 700 : 400, color: v === value ? 'var(--brand)' : 'var(--text)' }}
              onMouseDown={(e) => { e.preventDefault(); onChange(v); setOpen(false); }}>{v}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// Create / edit form. Explore + field pickers come from Looker metadata; filters
// let a monitor watch one event's feed (e.g. Event Name = this weekend's festival).
function MonitorEditor({ initial, entities, suites, onSaved, onCancel }) {
  const [f, setF] = useState(() => ({
    name: '', area: 'Check-in', entityId: '', suiteId: '', model: '', view: '', timeField: '', stationField: '',
    filters: {}, warnMin: 30, staleMin: 60, checkEveryMin: 0, channels: ['push'], notifyRecovery: true, cooldownMin: 60,
    rosterField: '', rosterBaselineMin: 1440, rosterOnlineMin: 30, rosterStart: '', rosterDaily: '', rosterAlertPct: 0,
    ...(initial || {}),
  }));
  const [models, setModels] = useState(null);
  const [fields, setFields] = useState(null);
  const [filterRows, setFilterRows] = useState(() => Object.entries((initial && initial.filters) || {}));
  const [detailRows, setDetailRows] = useState(() => (initial && initial.detailFields) || []);
  const [dimValues, setDimValues] = useState({}); // field -> 'loading' | [values] (linked filter dropdowns)
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const isMobile = useIsMobile();
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  // Linked values: once a filter dimension is picked, fetch its real (scoped)
  // distinct values so the value box offers them as suggestions — live Looker
  // read, so only on demand and cached per field for this editor session.
  // Value lookups ride the OTHER filled-in filters (event name → only that
  // event's stations); the signature makes a changed filter refetch on focus.
  const dimFilters = (field) => Object.fromEntries(filterRows.filter(([k2, v2]) => k2 && k2 !== field && String(v2).trim()));
  const loadDimValues = (field) => {
    if (!field || !f.model || !f.view) return;
    const sig = JSON.stringify([f.entityId, f.suiteId, dimFilters(field)]);
    const cur = dimValues[field];
    if (cur === 'loading' || (cur && cur.sig === sig)) return;
    setDimValues((p) => ({ ...p, [field]: 'loading' }));
    fetch('/api/admin/data-health/field-values', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: f.model, view: f.view, field, entityId: f.entityId, suiteId: f.suiteId, filters: dimFilters(field) }),
    }).then((r) => r.json()).then((d) => setDimValues((p) => ({ ...p, [field]: { sig, values: Array.isArray(d.values) ? d.values : [] } })))
      .catch(() => setDimValues((p) => ({ ...p, [field]: { sig, values: [] } })));
  };

  useEffect(() => { api.dataHealthExplores().then((r) => setModels(r.models || [])).catch((e) => setErr(e.message)); }, []);
  useEffect(() => {
    setFields(null);
    if (f.model && f.view) api.dataHealthFields(f.model, f.view).then(setFields).catch((e) => setErr(e.message));
  }, [f.model, f.view]);

  const exploreOptions = (models || []).flatMap((mo) => (mo.explores || []).map((ex) => ({ key: `${mo.name}::${ex.name}`, label: `${ex.label} (${mo.label})`, model: mo.name, view: ex.name })));
  // Templates name only the VIEW (the model prefix isn't knowable up front) —
  // resolve it to a model::view pair as soon as the explore list arrives.
  useEffect(() => {
    if (!models || !f.templateView || f.view) return;
    const o = exploreOptions.find((x) => x.view === f.templateView);
    if (o) setF((p) => ({ ...p, model: o.model, view: o.view, templateView: '' }));
    else setF((p) => ({ ...p, templateView: '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resolve once when models land
  }, [models]);
  const entitySuites = suites.filter((s) => s.entityId === f.entityId);
  const grid2 = { display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 };

  const save = async () => {
    setErr('');
    // Filter rows with a dimension but no value yet are kept as "open" filters
    // (saved with the monitor, applied only once a value is chosen).
    const body = { ...f, filters: Object.fromEntries(filterRows.filter(([k]) => k)), detailFields: detailRows.filter(Boolean) };
    if (!body.name.trim()) return setErr('Give the monitor a name.');
    if (!body.model || !body.view || !body.timeField) return setErr('Pick the explore and its timestamp field.');
    setSaving(true);
    try {
      if (initial?.id) await api.updateDataMonitor(initial.id, body); else await api.createDataMonitor(body);
      onSaved();
    } catch (e) { setErr(e.message); }
    setSaving(false);
  };

  return (
    <div style={{ ...card, borderColor: 'var(--brand)' }}>
      <strong style={{ fontSize: 14.5, display: 'block', marginBottom: 12 }}>{initial?.id ? 'Edit monitor' : 'New stream monitor'}</strong>
      <div style={grid2}>
        <div>
          <span style={label}>Name</span>
          <input style={input} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Check-in scanners — main gate" />
        </div>
        <div>
          <span style={label}>Area</span>
          <select style={input} value={AREAS.includes(f.area) ? f.area : 'Other'} onChange={(e) => set('area', e.target.value)}>
            {AREAS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <span style={label}>Data source (Looker explore)</span>
        {!models ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Loading explores from Looker…</div> : (
          <select style={input} value={f.model && f.view ? `${f.model}::${f.view}` : ''}
            onChange={(e) => { const o = exploreOptions.find((x) => x.key === e.target.value); set('model', o?.model || ''); setF((p) => ({ ...p, model: o?.model || '', view: o?.view || '', timeField: '', stationField: '' })); }}>
            <option value="">— pick an explore —</option>
            {exploreOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        )}
      </div>

      {f.model && f.view && (
        <div style={{ ...grid2, marginTop: 12 }}>
          <div>
            <span style={label}>Timestamp field (what “new data” means)</span>
            {!fields ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Loading fields…</div> : (
              <>
                <FieldPicker value={f.timeField} onChange={(v) => set('timeField', v)} fields={fields.timeFields} timeFirst
                  placeholder="— pick the record time —" tag={(d) => (/time/i.test(d.type || '') ? '' : ' (day-level)')} />
                <span style={{ fontSize: 11.5, color: 'var(--muted)', display: 'block', marginTop: 3 }}>Pick the finest granularity available (a <em>Time</em> variant, not <em>Date</em>) — a day-level field can read as up to 24h behind.</span>
              </>
            )}
          </div>
          <div>
            <span style={label}>Split by station (optional)</span>
            {!fields ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }} /> : (
              <FieldPicker value={f.stationField} onChange={(v) => set('stationField', v)}
                fields={(fields.dimensions || []).filter((d) => !/date|time/i.test(d.type || ''))} noneLabel="Whole feed (no split)" />
            )}
          </div>
        </div>
      )}

      {f.model && f.view && fields && (
        <div style={{ ...grid2, marginTop: 12 }}>
          <div>
            <span style={label}>Device roster (optional — count linked vs offline)</span>
            <FieldPicker value={f.rosterField} onChange={(v) => set('rosterField', v)}
              fields={(fields.dimensions || []).filter((d) => !/date|time/i.test(d.type || ''))} noneLabel="No roster" />
            <span style={{ fontSize: 11.5, color: 'var(--muted)', display: 'block', marginTop: 3 }}>Pick the device ID or operator dimension. Anything seen in the linked window counts as connected; silence past the online window flags it offline by name.</span>
          </div>
          {f.rosterField && (
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                <div>
                  <span style={label}>Daily from (SA time)</span>
                  <input style={input} type="time" value={f.rosterDaily || ''} onChange={(e) => set('rosterDaily', e.target.value)} />
                </div>
                <div>
                  <span style={{ ...label, opacity: f.rosterDaily ? 0.45 : 1 }}>or once-off start</span>
                  <input style={{ ...input, opacity: f.rosterDaily ? 0.45 : 1 }} type="datetime-local" disabled={!!f.rosterDaily}
                    value={isoToLocalInput(f.rosterStart)}
                    onChange={(e) => set('rosterStart', e.target.value ? new Date(e.target.value).toISOString() : '')} />
                </div>
                <div>
                  <span style={{ ...label, opacity: (f.rosterDaily || f.rosterStart) ? 0.45 : 1 }}>or window (min)</span>
                  <input style={{ ...input, opacity: (f.rosterDaily || f.rosterStart) ? 0.45 : 1 }} type="number" min="10" disabled={!!(f.rosterDaily || f.rosterStart)}
                    value={f.rosterBaselineMin} onChange={(e) => set('rosterBaselineMin', e.target.value)} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 8 }}>
                <div>
                  <span style={label}>Online window (min)</span>
                  <input style={input} type="number" min="1" value={f.rosterOnlineMin} onChange={(e) => set('rosterOnlineMin', e.target.value)} />
                </div>
                <div>
                  <span style={label}>⚠️ Alert at % offline (0 = off)</span>
                  <input style={input} type="number" min="0" max="100" value={f.rosterAlertPct || 0} onChange={(e) => set('rosterAlertPct', e.target.value)} />
                </div>
              </div>
              <span style={{ fontSize: 11.5, color: 'var(--muted)', display: 'block', marginTop: 3 }}>
                {f.rosterDaily ? `Roster restarts every day at ${f.rosterDaily} (South Africa time) — the multi-day event shape.`
                  : f.rosterStart ? 'Roster = every device seen since the once-off start time (your local time). Clear it to use the rolling window.'
                    : 'Pick a daily time (multi-day events), a once-off start (single event day), or leave both blank for a rolling window.'}
                {Number(f.rosterAlertPct) >= 1 ? ` Fleet alert: fires once when ≥${f.rosterAlertPct}% of linked devices are offline (needs 3+ linked; shares the cooldown).` : ''}
              </span>
            </div>
          )}
        </div>
      )}

      {f.model && f.view && fields && (
        <div style={{ marginTop: 12 }}>
          <span style={label}>Extra columns in 🧾 Latest 20 (optional — e.g. station, action type)</span>
          {detailRows.map((k, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              <div style={{ flex: 1 }}>
                <FieldPicker value={k} onChange={(v) => setDetailRows((rows) => rows.map((r, j) => (j === i ? v : r)))} fields={fields.dimensions || []} placeholder="— dimension —" />
              </div>
              <button style={ghostBtn} onClick={() => setDetailRows((rows) => rows.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          {detailRows.length < 4 && <button style={{ ...ghostBtn, marginBottom: 12 }} onClick={() => setDetailRows((rows) => [...rows, ''])}>+ Add column</button>}
        </div>
      )}

      {f.model && f.view && fields && (
        <div style={{ marginTop: 12 }}>
          <span style={label}>Filters (optional — e.g. one event only)</span>
          {filterRows.map(([k, v], i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              <div style={{ flex: 1 }}>
                <FieldPicker value={k} placeholder="— dimension —" fields={fields.dimensions || []}
                  onChange={(nf) => { setFilterRows((rows) => rows.map((r, j) => (j === i ? [nf, r[1]] : r))); loadDimValues(nf); }} />
              </div>
              <ValueCombo value={v} options={dimValues[k]?.values || []} loading={dimValues[k] === 'loading'}
                onFocusLoad={() => loadDimValues(k)}
                onChange={(nv) => setFilterRows((rows) => rows.map((r, j) => (j === i ? [r[0], nv] : r)))} />
              <button style={ghostBtn} onClick={() => setFilterRows((rows) => rows.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          {filterRows.length < 5 && <button style={ghostBtn} onClick={() => setFilterRows((rows) => [...rows, ['', '']])}>+ Add filter</button>}
        </div>
      )}

      <div style={{ ...grid2, marginTop: 12 }}>
        <div>
          <span style={label}>Scope to a client (optional)</span>
          <select style={input} value={f.entityId} onChange={(e) => setF((p) => ({ ...p, entityId: e.target.value, suiteId: '' }))}>
            <option value="">Platform-wide (unscoped)</option>
            {entities.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
          </select>
          <span style={{ fontSize: 11.5, color: 'var(--muted)', display: 'block', marginTop: 3 }}>Scoped monitors read through the client’s organiser lock and can notify their team.</span>
        </div>
        {f.entityId && (
          <div>
            <span style={label}>Event (optional)</span>
            <select style={input} value={f.suiteId} onChange={(e) => set('suiteId', e.target.value)}>
              <option value="">All their data</option>
              {entitySuites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: 12, marginTop: 12 }}>
        {[['warnMin', 'Warn after (min)'], ['staleMin', 'Stale after (min)'], ['checkEveryMin', 'Check every (min)'], ['cooldownMin', 'Alert cooldown (min)']].map(([k, l]) => (
          <div key={k}>
            <span style={label}>{l}</span>
            <input style={input} type="number" min={k === 'checkEveryMin' ? '0' : '1'}
              value={k === 'checkEveryMin' ? (Number(f[k]) >= 1 ? f[k] : '') : f[k]}
              placeholder={k === 'checkEveryMin' ? 'master' : undefined}
              onChange={(e) => set(k, e.target.value)} />
          </div>
        ))}
      </div>

      <div style={{ marginTop: 12, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        {f.entityId && ['push', 'email', 'slack'].map((c) => (
          <label key={c} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={f.channels.includes(c)} onChange={(e) => set('channels', e.target.checked ? [...f.channels, c] : f.channels.filter((x) => x !== c))} />
            Notify client team by {c}
          </label>
        ))}
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!f.notifyRecovery} onChange={(e) => set('notifyRecovery', e.target.checked)} />
          Send an all-clear when data flows again
        </label>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>Stale alerts always post to Howler’s internal ops Slack.</div>

      {err && <div style={{ color: STATUS_COLOR.stale, fontSize: 13, marginTop: 10 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button style={btn} disabled={saving} onClick={save}>{saving ? 'Saving…' : initial?.id ? 'Save changes' : 'Create monitor'}</button>
        <button style={ghostBtn} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// One-tap monitor templates: the whole setup pre-filled with fields from ONE
// data family (mixing families joins nothing — the trap the templates avoid).
// The explore is resolved by view name once Looker's model list loads.
const MONITOR_TEMPLATES = {
  bar: {
    name: 'Bar', area: 'Bar', templateView: 'cashless_combine_data',
    timeField: 'cashless_open_loop_sales.date_time',
    stationField: 'cashless_stations.name',
    rosterField: 'cashless_open_loop_sales.device_id',
    detailFields: ['cashless_open_loop_sales.device_id', 'event_sales_operators.handler', 'cashless_operation_sale_item.product_name'],
    filters: { 'cashless_combine_data.name': '', 'cashless_open_loop_sales.station_category': '', 'cashless_stations.name': '' },
    rosterDaily: '12:00', rosterOnlineMin: 15, rosterAlertPct: 10, warnMin: 30, staleMin: 60,
  },
  vendor: {
    name: 'Vendors', area: 'Vendors', templateView: 'cashless_combine_data',
    timeField: 'cashless_open_loop_sales.date_time',
    stationField: 'cashless_stations.name',
    rosterField: 'cashless_open_loop_sales.device_id',
    detailFields: ['cashless_open_loop_sales.device_id', 'event_sales_operators.handler', 'cashless_operation_sale_item.product_name'],
    filters: { 'cashless_combine_data.name': '', 'cashless_open_loop_sales.station_category': 'vendor', 'cashless_stations.name': '' },
    rosterDaily: '12:00', rosterOnlineMin: 15, rosterAlertPct: 10, warnMin: 30, staleMin: 60,
  },
  checkin: {
    name: 'Check-in gate', area: 'Check-in', templateView: 'cashless_combine_data',
    timeField: 'cashless_check_ins.created_at_time',
    stationField: 'cashless_check_ins.station_name',
    rosterField: 'cashless_check_ins.device_id',
    detailFields: ['cashless_check_ins.device_id', 'Check_in_operators.handler', 'cashless_check_ins.station_name'],
    filters: { 'cashless_combine_data.name': '', 'cashless_check_ins.station_category': '', 'cashless_check_ins.station_name': '' },
    rosterDaily: '12:00', rosterOnlineMin: 15, rosterAlertPct: 10, warnMin: 30, staleMin: 60,
  },
};

export default function DataHealthAdmin() {
  const [data, setData] = useState(null);
  const [entities, setEntities] = useState([]);
  const [suites, setSuites] = useState([]);
  const [editing, setEditing] = useState(null); // null | 'new' | monitor
  const [err, setErr] = useState('');
  const timerRef = useRef(null);

  const load = () => api.dataHealth().then((r) => { setData(r); setErr(''); }).catch((e) => { setErr(e.message); setData((d) => d || { monitors: [] }); });
  useEffect(() => {
    load();
    api.adminListEntities().then(setEntities).catch(() => setEntities([]));
    api.adminListSuites().then((r) => setSuites(Array.isArray(r) ? r : r.suites || [])).catch(() => setSuites([]));
    timerRef.current = setInterval(load, 60000); // live-ish: the grid refreshes itself
    return () => clearInterval(timerRef.current);
  }, []);

  const monitors = data?.monitors || [];
  const openMonitors = monitors.filter((m) => m.status !== 'closed');
  const allStreams = openMonitors.flatMap((m) => m.streams);
  const staleN = allStreams.filter((s) => s.status === 'stale').length + openMonitors.filter((m) => m.lastError).length;
  const warnN = allStreams.filter((s) => s.status === 'warn').length;

  // Platform overview → drill in: group monitors by client · event. Monitors
  // without an event group under the client; platform-wide ones under 🌐.
  const groups = [];
  {
    const byKey = new Map();
    for (const m of monitors) {
      const key = `${m.entityId || ''}|${m.suiteId || ''}`;
      if (!byKey.has(key)) {
        const ent = m.entityId ? (entities.find((e) => e.id === m.entityId)?.name || 'Client') : '';
        const su = m.suiteId ? (suites.find((s) => s.id === m.suiteId)?.name || 'Event') : '';
        byKey.set(key, { key, label: ent ? (su ? `${ent} · ${su}` : ent) : '🌐 Platform-wide', entityId: m.entityId, suiteId: m.suiteId, monitors: [] });
      }
      byKey.get(key).monitors.push(m);
    }
    groups.push(...[...byKey.values()].sort((a, b) => a.label.localeCompare(b.label)));
  }
  const platformDot = staleN ? 'stale' : warnN ? 'warn' : allStreams.length ? 'fresh' : undefined;

  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>
        Watches the <strong>stream of data flowing into Looker from BigQuery / Howler</strong> — the pipe every dashboard reads.
        Each monitor pulls the latest record timestamp on an explore (optionally per station: check-in scanners, bars, vendors),
        logs every pull, and raises an alert when a stream goes quiet past its threshold. Reads always bypass the query cache, so
        the lag you see is the pipe’s real lag.
      </p>

      {data && <TestModeBanner testMode={!!data.testMode} testEmail={data.testEmail || ''} onChanged={load} />}

      {data && (
        <div style={{ ...card, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', borderLeft: `4px solid ${platformDot ? STATUS_COLOR[platformDot] : 'var(--hairline)'}` }}>
          <span style={{ fontSize: 22 }}>📡</span>
          <div>
            <div style={{ fontWeight: 800, fontSize: 14.5 }}>
              Platform health:{' '}
              {staleN ? <span style={{ color: STATUS_COLOR.stale }}>{staleN} stream{staleN === 1 ? '' : 's'} down</span>
                : warnN ? <span style={{ color: STATUS_COLOR.warn }}>{warnN} stream{warnN === 1 ? '' : 's'} need{warnN === 1 ? 's' : ''} attention</span>
                  : allStreams.length ? <span style={{ color: STATUS_COLOR.fresh }}>all streams flowing</span>
                    : <span style={{ color: 'var(--muted)' }}>no data yet</span>}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              {monitors.length} monitor{monitors.length === 1 ? '' : 's'} · {allStreams.length} stream{allStreams.length === 1 ? '' : 's'} ·{' '}
              <span style={{ color: STATUS_COLOR.fresh, fontWeight: 700 }}>{allStreams.length - allStreams.filter((s) => s.status !== 'fresh').length} fresh</span> ·{' '}
              <span style={{ color: STATUS_COLOR.warn, fontWeight: 700 }}>{warnN} warning</span> ·{' '}
              <span style={{ color: STATUS_COLOR.stale, fontWeight: 700 }}>{staleN} stale</span>
            </div>
          </div>
          <span style={{ flex: 1 }} />
          <MasterCadence tickMin={data.tickMin || 5} onChanged={load} />
          {editing == null && <>
            <button style={btn} onClick={() => setEditing('new')}>+ New monitor</button>
            <button style={ghostBtn} title="Pre-filled bar-sales monitor (Event Sales family) — just pick the client, the bar and save" onClick={() => setEditing({ ...MONITOR_TEMPLATES.bar })}>🍺 Bar template</button>
            <button style={ghostBtn} title="Pre-filled vendor-sales monitor (Event Sales family, station type vendor) — just pick the client, the event and save" onClick={() => setEditing({ ...MONITOR_TEMPLATES.vendor })}>🧾 Vendor template</button>
            <button style={ghostBtn} title="Pre-filled check-in monitor (Check-Ins family) — just pick the client, the gate and save" onClick={() => setEditing({ ...MONITOR_TEMPLATES.checkin })}>🛂 Check-in template</button>
          </>}
        </div>
      )}

      {data && monitors.length > 0 && <HealthMetrics monitors={monitors} />}

      {err && <div style={{ ...card, color: STATUS_COLOR.stale, fontSize: 13 }}>{err}</div>}
      {editing != null && (
        <MonitorEditor initial={editing === 'new' ? null : editing} entities={entities} suites={suites}
          onSaved={() => { setEditing(null); load(); }} onCancel={() => setEditing(null)} />
      )}

      {!data ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div>
        : !monitors.length && editing == null ? (
          <div style={card}>
            <strong style={{ fontSize: 14 }}>No monitors yet</strong>
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: '6px 0 10px' }}>
              Start with one per operational area — e.g. <em>Check-in scanners</em> split by station, <em>Bar sales</em> split by bar,
              <em> Vendor sales</em> split by vendor — so a single quiet device stands out during an event.
            </p>
            <button style={btn} onClick={() => setEditing('new')}>+ Create the first monitor</button>
          </div>
        ) : groups.map((g) => (
          <MonitorGroup key={g.key} label={g.label} monitors={g.monitors} entities={entities}
            defaultOpen={groups.length === 1}
            reportBody={g.entityId ? { entityId: g.entityId, suiteId: g.suiteId || '' } : null}
            onChanged={load} onEdit={(mm) => { setEditing(mm); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
        ))}
    </div>
  );
}

// ── Client-facing surface: the 📶 Data health tab inside Event Ops ──
// Same cards, read-only, scoped server-side to the caller's entity (+ the
// picked event). Renders in BOTH consoles — the client's /event-ops page and
// Admin → client → Event Ops (the dual-surface rule).
export function DataHealthOps({ entityId, suiteId }) {
  const [monitors, setMonitors] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    const load = () => jget(`/api/my/data-health?entityId=${encodeURIComponent(entityId || '')}&suiteId=${encodeURIComponent(suiteId || '')}`)
      .then((r) => { if (alive) { setMonitors(r.monitors || []); setErr(''); } })
      .catch((e) => { if (alive) { setErr(e.message); setMonitors((m) => m || []); } });
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, [entityId, suiteId]);
  if (monitors === null) return <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading data health…</div>;
  return (
    <div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 12px' }}>
        Live health of the data flowing from your stations (check-in scanners, bars, vendors) into Pulse.
        Tap a station to see its devices and the day timeline; 🩺 Diagnose gives an instant AI verdict. Howler manages the setup.
      </p>
      {err && <div style={{ ...card, color: STATUS_COLOR.stale, fontSize: 13 }}>{err}</div>}
      {!monitors.length ? (
        <div style={card}>
          <strong style={{ fontSize: 14 }}>No data-health monitors yet</strong>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: '6px 0 0' }}>Ask your Howler account manager to set up stream monitoring for this event.</p>
        </div>
      ) : <>
        <HealthMetrics monitors={monitors} />
        <div style={{ marginBottom: 12 }}>
          <ReportPanel url="/api/my/data-health/report" body={{ entityId: entityId || '', suiteId: suiteId || '' }} title="Data health report" />
        </div>
        {monitors.map((m) => (
          <MonitorCard key={m.id} m={m} base="/api/my/data-health" readOnly onChanged={() => {}} onEdit={() => {}} />
        ))}
      </>}
    </div>
  );
}

// Master auto-check cadence: how often the background sweep pulls each monitor
// (a monitor can still set its own cadence in the editor; blank = follow this).
// Saved via the same settings PUT the test-mode banner uses; applies within a
// minute — the server heartbeat re-reads it every 60s, no restart needed.
function MasterCadence({ tickMin, onChanged }) {
  const [v, setV] = useState(String(tickMin));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { setV(String(tickMin)); }, [tickMin]);
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const res = await fetch('/api/admin/data-health/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tickMin: Number(v) }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `Request failed (${res.status})`);
      onChanged();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--muted)' }}>
      auto-check every
      <input type="number" min="1" max="120" value={v} onChange={(e) => setV(e.target.value)}
        style={{ ...input, width: 58, padding: '4px 6px', fontSize: 12 }} />
      min
      {Number(v) !== Number(tickMin) && <button style={{ ...ghostBtn, padding: '4px 10px' }} disabled={busy} onClick={save}>{busy ? '…' : 'Save'}</button>}
      {err && <span style={{ color: STATUS_COLOR.stale }}>{err}</span>}
    </span>
  );
}

// Test-mode banner: while ON, every alert is emailed ONLY to the test address —
// ops Slack and client-team notifications stay muted, so thresholds can be tuned
// without paging anyone. (Settings PUT is called inline rather than via lib/api.js
// so this self-contained feature doesn't touch that shared file.)
function TestModeBanner({ testMode, testEmail, onChanged }) {
  const [email, setEmail] = useState(testEmail || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { setEmail(testEmail || ''); }, [testEmail]);

  const save = async (body) => {
    setBusy(true); setErr('');
    try {
      const res = await fetch('/api/admin/data-health/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `Request failed (${res.status})`);
      onChanged();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  if (!testMode) {
    return (
      <div style={{ ...card, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '10px 16px' }}>
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>🔔 Alerts are <strong>live</strong> — stale alerts post to ops Slack and (for client-pinned monitors) the client’s team.</span>
        <span style={{ flex: 1 }} />
        <button style={ghostBtn} disabled={busy} onClick={() => save({ testMode: true })}>🧪 Back to test mode</button>
        {err && <span style={{ fontSize: 12, color: STATUS_COLOR.stale }}>{err}</span>}
      </div>
    );
  }
  return (
    <div style={{ ...card, borderLeft: `4px solid ${STATUS_COLOR.warn}`, background: STATUS_BG.warn }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13.5 }}>🧪 Test mode</strong>
        <span style={{ fontSize: 12.5 }}>All alerts are emailed <strong>only</strong> to the address below — ops Slack and client notifications are muted.</span>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
        <input style={{ ...input, width: 260, flex: '0 1 auto' }} type="email" value={email} placeholder="you@howler.co.za" onChange={(e) => setEmail(e.target.value)} />
        <button style={ghostBtn} disabled={busy || !email.trim() || email === testEmail} onClick={() => save({ testEmail: email })}>Save address</button>
        <span style={{ flex: 1 }} />
        <button style={{ ...btn, background: STATUS_COLOR.fresh }} disabled={busy}
          onClick={() => { if (window.confirm('Go live? Stale alerts will start posting to ops Slack and, for client-pinned monitors, to the client’s team.')) save({ testMode: false }); }}>
          Go live
        </button>
      </div>
      {err && <div style={{ fontSize: 12, color: STATUS_COLOR.stale, marginTop: 6 }}>{err}</div>}
    </div>
  );
}
