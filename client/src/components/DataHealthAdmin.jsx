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
};

// The raw tail of the feed: the last N (station, timestamp) records, pulled LIVE
// from Looker on open/refresh (cache-bypassed server-side) — so you can see what
// the pipe actually delivered, not just the lag number. (Inline fetch, same
// reasoning as TestModeBanner: keep this module out of the shared lib/api.js.)
function LatestRecords({ monitorId }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = async () => {
    setBusy(true); setErr('');
    try {
      const res = await fetch(`/api/admin/data-health/monitors/${monitorId}/latest?limit=20`);
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
function RosterPanel({ monitorId }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = async () => {
    setBusy(true); setErr('');
    try {
      const res = await fetch(`/api/admin/data-health/monitors/${monitorId}/roster`);
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
              <th style={{ padding: '4px 8px 4px 0', fontWeight: 600 }}>Device / operator</th>
              <th style={{ padding: '4px 8px', fontWeight: 600 }}>Last sync</th>
            </tr></thead>
            <tbody>{data.offline.map((d) => (
              <tr key={d.device} style={{ borderTop: '1px solid var(--hairline)' }}>
                <td style={{ padding: '5px 8px 5px 0', fontWeight: 700, color: STATUS_COLOR.stale }}>{d.device}</td>
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
function TimelinePanel({ monitorId }) {
  const [data, setData] = useState(null);
  const [hours, setHours] = useState('start'); // 'start' = from the roster's start time; else rolling hours
  const [interval, setIntervalMin] = useState(10); // 10-min blocks by default — hour blocks hide short dropouts
  const [mode, setMode] = useState('blocks'); // 'blocks' (green/grey grid) | 'counts' (numbers report)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = async (h, iv) => {
    setBusy(true); setErr('');
    try {
      const res = await fetch(`/api/admin/data-health/monitors/${monitorId}/timeline?hours=${h}&interval=${iv}`);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `Request failed (${res.status})`);
      setData(d);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load is stable per monitor; refetch on monitor/window/block change
  useEffect(() => { load(hours, interval); }, [monitorId, hours, interval]);
  if (err) return <div style={{ fontSize: 12.5, color: STATUS_COLOR.stale }}>⚠️ {err} <button style={{ ...ghostBtn, marginLeft: 8 }} onClick={() => load(hours, interval)}>Retry</button></div>;
  if (!data) return <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Building the day timeline from Looker…</div>;
  if (!data.configured) return <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{data.reason || 'No roster field set — pick a device/operator dimension in ✏️ Edit → Device roster.'}</div>;
  const iv = data.intervalMin || 60;
  const hourLabel = (iso) => new Date(iso).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }).slice(0, 5);
  const bw = iv >= 30 ? 12 : 8; // finer blocks get narrower cells so more fit before scrolling
  const perLabel = Math.max(1, Math.round((data.hours <= 12 ? 60 : 180) / iv)); // a time label every 1h (short windows) or 3h
  const lookback = Math.max(1, Math.ceil(30 / iv)); // "live" = active within the last ~30 min
  const maxCount = Math.max(1, ...data.devices.flatMap((d) => d.counts || []));
  const heat = (c) => `rgba(22, 163, 74, ${0.12 + 0.38 * Math.min(1, c / maxCount)})`; // busier block = deeper green
  const nameCell = { maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, fontWeight: 600, padding: '2px 8px 2px 0', textAlign: 'left' };
  const numCell = { fontSize: 10.5, padding: '2px 4px', textAlign: 'right', minWidth: 26, fontVariantNumeric: 'tabular-nums' };
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>{data.devices.length} device{data.devices.length === 1 ? '' : 's'}</span>
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{mode === 'counts' ? `scans per ${iv >= 60 ? 'hour' : `${iv} min`} · darker green = busier` : `each block = ${iv >= 60 ? '1 hour' : `${iv} min`} · green = sent data · grey = silent`}</span>
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
      {data.truncated && <div style={{ fontSize: 11.5, color: STATUS_COLOR.warn, marginBottom: 6 }}>⚠️ Very busy window — some blocks may be missing; try a shorter range or bigger blocks.</div>}
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
            <tbody>
              {data.devices.map(({ device, counts, active, total }) => {
                const liveNow = active.slice(-lookback).some((a) => a === 1);
                return (
                  <tr key={device}>
                    <td title={device} style={{ ...nameCell, color: liveNow ? 'var(--text)' : STATUS_COLOR.stale }}>{device}</td>
                    {counts.map((c, i) => (
                      <td key={i} title={`${hourLabel(data.buckets[i])} — ${c} scan${c === 1 ? '' : 's'}`}
                        style={{ ...numCell, borderRadius: 2, background: c ? heat(c) : 'transparent', color: c ? 'var(--text)' : 'var(--muted)' }}>{c || '·'}</td>
                    ))}
                    <td style={{ ...numCell, fontWeight: 700 }}>{total}</td>
                  </tr>
                );
              })}
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
          <div style={{ display: 'flex', gap: 2, marginLeft: 148, marginBottom: 2 }}>
            {data.buckets.map((b, i) => (
              <span key={b} style={{ width: bw, flexShrink: 0, fontSize: 8.5, color: 'var(--muted)', overflow: 'visible', whiteSpace: 'nowrap' }}>{i % perLabel === 0 ? hourLabel(b) : ''}</span>
            ))}
          </div>
          {data.devices.map(({ device, active }) => {
            const liveNow = active.slice(-lookback).some((a) => a === 1);
            return (
              <div key={device} style={{ display: 'flex', alignItems: 'center', gap: 2, marginBottom: 2 }}>
                <span title={device} style={{ width: 140, marginRight: 6, flexShrink: 0, fontSize: 11.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: liveNow ? 'var(--text)' : STATUS_COLOR.stale }}>{device}</span>
                {active.map((a, i) => (
                  <span key={i} title={`${hourLabel(data.buckets[i])} — ${a ? 'active' : 'silent'}`}
                    style={{ width: bw, height: 16, flexShrink: 0, borderRadius: 2, background: a ? STATUS_COLOR.fresh : 'var(--hairline)' }} />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Expandable history: the transition/alert feed + the raw pull log + a live peek
// at the last 20 records off the feed (+ the device roster when configured).
function HistoryPanel({ monitorId, rosterField }) {
  const [hist, setHist] = useState(null);
  // Roster monitors open straight onto the live timeline — that's the view the
  // card is expanded for; the history lists are one click away.
  const [tab, setTab] = useState(rosterField ? 'timeline' : 'events');
  useEffect(() => { api.dataMonitorHistory(monitorId).then(setHist).catch(() => setHist({ checks: [], events: [] })); }, [monitorId]);
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
        {tab === 'latest' && <LatestRecords monitorId={monitorId} />}
        {tab === 'roster' && <RosterPanel monitorId={monitorId} />}
        {tab === 'timeline' && <TimelinePanel monitorId={monitorId} />}
      </div>
    </div>
  );
}

function MonitorCard({ m, entities, onChanged, onEdit }) {
  const [busy, setBusy] = useState('');
  // Cards start collapsed to one summary row — with many monitors the page
  // stays scannable. Expanding opens the log straight away (that's what you
  // expanded for), full-height so a big device timeline is fully visible.
  const [expanded, setExpanded] = useState(false);
  const [showHist, setShowHist] = useState(true);
  const [checkMsg, setCheckMsg] = useState('');
  const stale = m.streams.filter((s) => s.status === 'stale').length;
  const warn = m.streams.filter((s) => s.status === 'warn').length;
  const overall = m.status === 'paused' ? 'paused' : m.lastError ? 'error' : stale ? 'stale' : warn ? 'warn' : m.streams.length ? 'fresh' : 'new';
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
    <div style={{ ...card, borderLeft: `4px solid ${headColor}`, opacity: m.status === 'paused' ? 0.75 : 1 }}>
      <div style={{ cursor: 'pointer' }} title={expanded ? 'Collapse' : 'Expand'} onClick={() => setExpanded((v) => !v)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minHeight: 28 }}>
          <Dot status={overall === 'error' ? 'stale' : overall === 'paused' || overall === 'new' ? undefined : overall} />
          <strong style={{ fontSize: 14.5 }}>{m.name}</strong>
          {m.area && <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 999, background: 'var(--hairline)', color: 'var(--text)' }}>{m.area}</span>}
          {m.status === 'paused' && <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}>PAUSED</span>}
          {!expanded && m.lastError && <span style={{ fontSize: 11.5, fontWeight: 700, color: STATUS_COLOR.stale }}>pull failed</span>}
          {!expanded && !m.streams.length && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>no data yet</span>}
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>checked {ago(m.lastCheckedAt)}</span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{expanded ? '▾' : '▸'}</span>
        </div>
        {/* Collapsed peek: the station chips (status + lag) and the last roster
            counts — enough to triage without opening the card. */}
        {!expanded && m.streams.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, alignItems: 'center' }}>
            {m.streams.slice(0, 6).map((s) => <StationChip key={s.station || '__feed'} s={s} />)}
            {m.streams.length > 6 && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>+{m.streams.length - 6} more</span>}
          </div>
        )}
        {!expanded && m.rosterField && m.rosterSnapshot && (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
            📟 <strong style={{ color: 'var(--text)' }}>{m.rosterSnapshot.total} linked</strong>
            {' '}({m.rosterSnapshot.startAt ? `seen since ${fmtAt(m.rosterSnapshot.startAt)}` : `last ${m.rosterSnapshot.baselineMin}m`})
            {' · '}<strong style={{ color: STATUS_COLOR.fresh }}>{m.rosterSnapshot.online} online</strong>
            {' · '}<strong style={{ color: m.rosterSnapshot.offline ? STATUS_COLOR.stale : 'var(--muted)' }}>{m.rosterSnapshot.offline} offline</strong>
            {' '}(no sync in {m.rosterSnapshot.onlineMin}m)
          </div>
        )}
      </div>
      {expanded && <>
      <div style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0 10px' }}>
        {m.view} · <code style={{ fontSize: 11.5 }}>{m.timeField}</code>
        {m.stationField ? <> · split by <code style={{ fontSize: 11.5 }}>{m.stationField}</code></> : ' · whole feed'}
        {entityName ? ` · scoped to ${entityName}` : ' · platform-wide'}
        {' '}· every {m.checkEveryMin >= 1 ? `${m.checkEveryMin}m` : 'master'} · warn {m.warnMin}m · stale {m.staleMin}m
      </div>
      {m.lastError && <div style={{ fontSize: 12.5, color: STATUS_COLOR.stale, marginBottom: 8 }}>⚠️ Last pull failed: {m.lastError}</div>}
      {m.streams.length ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          {m.streams.map((s) => (
            <StationChip key={s.station || '__feed'} s={s}
              onForget={() => run('forget', () => api.forgetDataStream(m.id, s.station))} />
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10 }}>No data pulled yet — hit <strong>Check now</strong> to take the first reading.</div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button style={ghostBtn} disabled={!!busy} onClick={checkNow}>{busy === 'check' ? 'Checking…' : '🔄 Check now'}</button>
        <button style={ghostBtn} onClick={() => setShowHist((v) => !v)}>{showHist ? 'Hide log' : '📜 Log'}</button>
        <button style={ghostBtn} onClick={() => onEdit(m)}>✏️ Edit</button>
        <button style={ghostBtn} title="Open the editor pre-filled with this monitor's setup, saved as a new monitor"
          onClick={() => onEdit({ ...m, id: undefined, name: `${m.name} (copy)` })}>⧉ Duplicate</button>
        <button style={ghostBtn} disabled={!!busy} onClick={() => run('pause', () => api.setDataMonitorStatus(m.id, m.status === 'paused' ? 'active' : 'paused'))}>
          {m.status === 'paused' ? '▶️ Resume' : '⏸ Pause'}
        </button>
        <button style={{ ...ghostBtn, color: STATUS_COLOR.stale }} disabled={!!busy}
          onClick={() => { if (window.confirm(`Delete monitor “${m.name}” and its history?`)) run('del', () => api.deleteDataMonitor(m.id)); }}>🗑</button>
        {checkMsg && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{checkMsg}</span>}
      </div>
      {showHist && <HistoryPanel monitorId={m.id} rosterField={m.rosterField} />}
      </>}
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

// Create / edit form. Explore + field pickers come from Looker metadata; filters
// let a monitor watch one event's feed (e.g. Event Name = this weekend's festival).
function MonitorEditor({ initial, entities, suites, onSaved, onCancel }) {
  const [f, setF] = useState(() => ({
    name: '', area: 'Check-in', entityId: '', suiteId: '', model: '', view: '', timeField: '', stationField: '',
    filters: {}, warnMin: 30, staleMin: 60, checkEveryMin: 0, channels: ['push'], notifyRecovery: true, cooldownMin: 60,
    rosterField: '', rosterBaselineMin: 1440, rosterOnlineMin: 30, rosterStart: '', rosterDaily: '',
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
  const loadDimValues = (field) => {
    if (!field || dimValues[field] != null || !f.model || !f.view) return;
    setDimValues((p) => ({ ...p, [field]: 'loading' }));
    fetch('/api/admin/data-health/field-values', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: f.model, view: f.view, field, entityId: f.entityId, suiteId: f.suiteId }),
    }).then((r) => r.json()).then((d) => setDimValues((p) => ({ ...p, [field]: Array.isArray(d.values) ? d.values : [] })))
      .catch(() => setDimValues((p) => ({ ...p, [field]: [] })));
  };

  useEffect(() => { api.dataHealthExplores().then((r) => setModels(r.models || [])).catch((e) => setErr(e.message)); }, []);
  useEffect(() => {
    setFields(null);
    if (f.model && f.view) api.dataHealthFields(f.model, f.view).then(setFields).catch((e) => setErr(e.message));
  }, [f.model, f.view]);

  const exploreOptions = (models || []).flatMap((mo) => (mo.explores || []).map((ex) => ({ key: `${mo.name}::${ex.name}`, label: `${ex.label} (${mo.label})`, model: mo.name, view: ex.name })));
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
                <select style={input} value={f.timeField} onChange={(e) => set('timeField', e.target.value)}>
                  <option value="">— pick the record time —</option>
                  {groupFields(fields.timeFields, { timeFirst: true }).map(([g, items]) => (
                    <optgroup key={g} label={g}>
                      {items.map((d) => <option key={d.name} value={d.name}>{d.short}{/time/i.test(d.type || '') ? '' : ' (day-level)'}</option>)}
                    </optgroup>
                  ))}
                </select>
                <span style={{ fontSize: 11.5, color: 'var(--muted)', display: 'block', marginTop: 3 }}>Pick the finest granularity available (a <em>Time</em> variant, not <em>Date</em>) — a day-level field can read as up to 24h behind.</span>
              </>
            )}
          </div>
          <div>
            <span style={label}>Split by station (optional)</span>
            {!fields ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }} /> : (
              <select style={input} value={f.stationField} onChange={(e) => set('stationField', e.target.value)}>
                <option value="">Whole feed (no split)</option>
                {groupFields((fields.dimensions || []).filter((d) => !/date|time/i.test(d.type || ''))).map(([g, items]) => (
                  <optgroup key={g} label={g}>
                    {items.map((d) => <option key={d.name} value={d.name}>{d.short}</option>)}
                  </optgroup>
                ))}
              </select>
            )}
          </div>
        </div>
      )}

      {f.model && f.view && fields && (
        <div style={{ ...grid2, marginTop: 12 }}>
          <div>
            <span style={label}>Device roster (optional — count linked vs offline)</span>
            <select style={input} value={f.rosterField} onChange={(e) => set('rosterField', e.target.value)}>
              <option value="">No roster</option>
              {(fields.dimensions || []).filter((d) => !/date|time/i.test(d.type || '')).map((d) => <option key={d.name} value={d.name}>{d.group_label ? `${d.group_label} · ` : ''}{d.label}</option>)}
            </select>
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
              <div style={{ marginTop: 8 }}>
                <span style={label}>Online window (min)</span>
                <input style={input} type="number" min="1" value={f.rosterOnlineMin} onChange={(e) => set('rosterOnlineMin', e.target.value)} />
              </div>
              <span style={{ fontSize: 11.5, color: 'var(--muted)', display: 'block', marginTop: 3 }}>
                {f.rosterDaily ? `Roster restarts every day at ${f.rosterDaily} (South Africa time) — the multi-day event shape.`
                  : f.rosterStart ? 'Roster = every device seen since the once-off start time (your local time). Clear it to use the rolling window.'
                    : 'Pick a daily time (multi-day events), a once-off start (single event day), or leave both blank for a rolling window.'}
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
              <select style={{ ...input, flex: 1 }} value={k} onChange={(e) => setDetailRows((rows) => rows.map((r, j) => (j === i ? e.target.value : r)))}>
                <option value="">— dimension —</option>
                {(fields.dimensions || []).map((d) => <option key={d.name} value={d.name}>{d.group_label ? `${d.group_label} · ` : ''}{d.label}</option>)}
              </select>
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
              <select style={{ ...input, flex: 1 }} value={k}
                onChange={(e) => { const nf = e.target.value; setFilterRows((rows) => rows.map((r, j) => (j === i ? [nf, r[1]] : r))); loadDimValues(nf); }}>
                <option value="">— dimension —</option>
                {groupFields(fields.dimensions).map(([g, items]) => (
                  <optgroup key={g} label={g}>
                    {items.map((d) => <option key={d.name} value={d.name}>{d.short}</option>)}
                  </optgroup>
                ))}
              </select>
              {/* Linked value box: native combo (datalist) — pick a real value or type one. */}
              <input style={{ ...input, flex: 1 }} value={v} list={`dh-vals-${i}`}
                placeholder={dimValues[k] === 'loading' ? 'loading values…' : Array.isArray(dimValues[k]) && dimValues[k].length ? 'pick or type a value (blank = not applied yet)' : 'value (blank = not applied yet)'}
                onFocus={() => loadDimValues(k)}
                onChange={(e) => setFilterRows((rows) => rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} />
              <datalist id={`dh-vals-${i}`}>
                {(Array.isArray(dimValues[k]) ? dimValues[k] : []).map((val) => <option key={val} value={val} />)}
              </datalist>
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
  const allStreams = monitors.flatMap((m) => m.streams);
  const staleN = allStreams.filter((s) => s.status === 'stale').length;
  const warnN = allStreams.filter((s) => s.status === 'warn').length;

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
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center' }}>
          {[[`${monitors.length} monitor${monitors.length === 1 ? '' : 's'}`, 'var(--text)'],
            [`${allStreams.length - staleN - warnN} fresh`, STATUS_COLOR.fresh],
            [`${warnN} warning`, STATUS_COLOR.warn],
            [`${staleN} stale`, STATUS_COLOR.stale]].map(([t, c], i) => (
            <span key={i} style={{ fontSize: 12.5, fontWeight: 700, color: c, padding: '5px 12px', borderRadius: 999, background: 'var(--card)', border: '1px solid var(--hairline)' }}>{t}</span>
          ))}
          <span style={{ flex: 1 }} />
          <MasterCadence tickMin={data.tickMin || 5} onChanged={load} />
          {editing == null && <button style={btn} onClick={() => setEditing('new')}>+ New monitor</button>}
        </div>
      )}

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
        ) : monitors.map((m) => (
          <MonitorCard key={m.id} m={m} entities={entities} onChanged={load} onEdit={(mm) => { setEditing(mm); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
        ))}
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
