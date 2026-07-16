import { useEffect, useMemo, useState } from 'react';

// 🌡️ Flow — how the event is performing, fused into one score. Connectivity
// (from the observed offline log — the authoritative uptime) × throughput
// (transactions per active device, from the non-truncated per-station line)
// blended into a Flow score, coloured across a red→green heat matrix, drillable
// zone → station → operator. Reuses the same reads the Stations view already
// makes, so it costs no extra Looker load beyond the two per-monitor fetches.
// Styled with Pulse theme tokens — light/dark follows the app.

const STATUS_COLOR = { fresh: '#16a34a', warn: '#d97706', stale: '#dc2626' };
const MID = '#eab308';                          // yellow midpoint for the heat ramp
const THRU = '6,182,212';                       // cyan — throughput intensity (distinct from the traffic-light scale)
const unitFor = (m) => (m && (m.area === 'Bar' || m.area === 'Vendors') ? 'transactions' : 'scans');
// Zone from a station name — kept in sync with EventSignal.zoneOf / staffAlerts.zoneOf.
const zoneOf = (name) => {
  const n = String(name || '').trim().toUpperCase();
  if (!n) return '—';
  const w = n.replace(/^(FOOD|RECYCLING|STORE|LOUNGE)\s+/, '').split(/\s+/)[0];
  if (w.startsWith('GATE')) return 'GATES';
  return w || '—';
};
const card = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: 12 };
const HR = 3600000;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const hx = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
// Traffic-light heat: 0 → red, mid → amber/yellow, 100 → green. Used for Flow + Connectivity.
function traffic(v) {
  const off = hx(STATUS_COLOR.stale), warn = hx(STATUS_COLOR.warn), mid = hx(MID), on = hx(STATUS_COLOR.fresh);
  const stops = [[0, off], [34, warn], [52, mid], [100, on]];
  v = clamp(v, 0, 100);
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [p0, c0] = stops[i - 1], [p1, c1] = stops[i], t = (v - p0) / (p1 - p0);
      return `rgb(${Math.round(lerp(c0[0], c1[0], t))},${Math.round(lerp(c0[1], c1[1], t))},${Math.round(lerp(c0[2], c1[2], t))})`;
    }
  }
  return STATUS_COLOR.fresh;
}
const thruColor = (t) => `rgba(${THRU},${(0.1 + 0.9 * clamp(t, 0, 1)).toFixed(3)})`;
const textOn = (col) => {
  const m = col.match(/[\d.]+/g); const a = col.startsWith('rgba') ? +m[3] : 1;
  const lum = (0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2]) / 255;
  return (lum > 0.62 && a > 0.5) ? 'rgba(0,0,0,.62)' : 'rgba(255,255,255,.94)';
};
const flowColorText = (v) => (v == null ? 'var(--muted)' : traffic(v));

// Build the whole flow model from the observed logs (connectivity) + timelines
// (throughput + operators). Pure — memoised on the raw inputs.
function buildModel(monitors, logs, tls, weight) {
  // 1. global hour axis from the observed ticks
  let lo = Infinity, hi = -Infinity;
  for (const m of monitors) {
    const d = logs[m.id];
    if (!d || !d.configured || !(d.ticks || []).length) continue;
    lo = Math.min(lo, Date.parse(d.ticks[0].at));
    hi = Math.max(hi, Date.parse(d.ticks[d.ticks.length - 1].at));
  }
  if (!Number.isFinite(lo)) return null;
  const h0 = Math.floor(lo / HR) * HR;
  const H = Math.min(24, Math.max(1, Math.ceil((hi - h0) / HR) + 1));
  const hourAt = (i) => new Date(h0 + i * HR).toTimeString().slice(0, 5);

  const stations = [];
  const rates = []; // per-device-per-hour throughput, for normalisation
  for (const m of monitors) {
    const d = logs[m.id];
    if (!d || !d.configured || !(d.ticks || []).length) continue;
    const tl = tls[m.id];
    const closedMon = m.status === 'closed';
    // group observed devices → station
    const byStation = new Map();
    (d.devices || []).forEach((dev) => { const s = dev.station || ''; if (!byStation.has(s)) byStation.set(s, []); byStation.get(s).push(dev); });
    const tickH = (d.ticks || []).map((k) => Math.floor((Date.parse(k.at) - h0) / HR));
    for (const [sn, devs] of byStation) {
      const total = devs.length;
      const offSets = devs.map((dev) => new Set(dev.offAt || []));
      // per-hour connectivity from the observed ticks
      const onSum = Array(H).fill(0), nTick = Array(H).fill(0);
      (d.ticks || []).forEach((k, ti) => {
        const hi2 = tickH[ti]; if (hi2 < 0 || hi2 >= H) return;
        let off = 0; for (const s of offSets) if (s.has(ti)) off += 1;
        onSum[hi2] += Math.max(0, total - off); nTick[hi2] += 1;
      });
      // per-hour throughput from the (non-truncated) per-station line
      const txnH = Array(H).fill(0);
      const line = tl && tl.byStation && tl.byStation[sn];
      const buckets = (tl && tl.buckets) || [];
      if (line) buckets.forEach((b, i) => { const hi2 = Math.floor((Date.parse(b) - h0) / HR); if (hi2 >= 0 && hi2 < H) txnH[hi2] += line[i] || 0; });
      // last hour that had any device on-air (for closed-trailing grey)
      let lastOn = -1; for (let i = 0; i < H; i++) if (nTick[i] && onSum[i] / nTick[i] > 0.01) lastOn = i;
      const hourly = [];
      for (let i = 0; i < H; i++) {
        const present = nTick[i] > 0;
        const closed = !present || (closedMon && i > lastOn);
        if (closed) { hourly.push({ closed: true }); continue; }
        const conn = onSum[i] / nTick[i] / total;            // 0..1
        const onlineDev = Math.max(1, Math.round(conn * total));
        const perDev = txnH[i] / onlineDev;
        rates.push(perDev);
        hourly.push({ closed: false, conn, txns: txnH[i], perDev, onlineDev, total });
      }
      const name = sn || m.name;
      stations.push({ mid: m.id, sn, name, zone: zoneOf(name), type: m.area || m.name || 'Other', unit: unitFor(m), total, hourly, devsObs: devs, monitor: m });
    }
  }
  // throughput reference = P92 of per-device-hour rates
  rates.sort((a, b) => a - b);
  const REF = rates.length ? (rates[Math.floor(rates.length * 0.92)] || rates[rates.length - 1] || 1) : 1;
  const thruIdx = (perDev) => clamp(perDev / (REF || 1), 0, 1);
  // finalise per-cell flow + station summaries
  for (const st of stations) {
    let cS = 0, tS = 0, fS = 0, n = 0, txns = 0, onl = 0;
    for (const c of st.hourly) {
      if (c.closed) continue;
      c.thru = thruIdx(c.perDev);
      c.flow = Math.round(100 * (weight * c.conn + (1 - weight) * c.thru));
      cS += c.conn; tS += c.thru; fS += c.flow; n += 1; txns += c.txns; onl += c.onlineDev;
    }
    const conn = n ? cS / n : 0, thru = n ? tS / n : 0;
    st.summary = { flow: n ? Math.round(fS / n) : null, conn, thru, txns, openHrs: n, avgOn: n ? Math.round(onl / n) : 0, drag: Math.round(clamp(conn - thru, 0, 1) * 100) };
  }
  return { H, hourAt, stations, REF, thruIdx };
}

// Operator rows for a station, from the timeline devices (operator + accurate
// total + active blocks). Connectivity here is the active-block fraction — a
// best-effort proxy (can read low on very large fleets whose per-device blocks
// truncate); txns are exact.
function operatorsFor(st, tl, weight, thruIdx) {
  if (!tl || !tl.devices) return [];
  const mine = tl.devices.filter((dv) => (dv.station || '') === st.sn);
  const buckets = (tl.buckets || []).length || 1;
  const ivPerHr = 2; // 30-min buckets
  const ops = mine.map((dv) => {
    const active = dv.active || [];
    const openBlocks = active.length || buckets;
    const conn = openBlocks ? active.reduce((a, x) => a + (x ? 1 : 0), 0) / openBlocks : 0;
    const hrsActive = Math.max(1, active.reduce((a, x) => a + (x ? 1 : 0), 0) / ivPerHr);
    const perDev = (dv.total || 0) / hrsActive;
    const thru = thruIdx(perDev);
    const flow = Math.round(100 * (weight * conn + (1 - weight) * thru));
    return { name: dv.operator || dv.device, role: /gate|check/i.test(st.type) ? 'scan' : 'till', conn, thru, flow, txns: dv.total || 0 };
  });
  ops.sort((a, b) => b.flow - a.flow);
  return ops;
}

export default function EventFlow({ monitors, apiBase = '/api/my/data-health', onSelect }) {
  const [logs, setLogs] = useState({});
  const [tls, setTls] = useState({});
  const [measure, setMeasure] = useState('flow'); // flow | conn | thru
  const [weight, setWeight] = useState(0.5);       // uptime weight
  const [sort, setSort] = useState('zone');        // zone | best | worst
  const [zones, setZones] = useState(null);        // Set of active zones (null = all)
  const [open, setOpen] = useState(null);          // expanded station key
  const [tip, setTip] = useState(null);

  const ids = monitors.map((m) => m.id).join(',');
  useEffect(() => {
    let alive = true;
    monitors.forEach((m) => {
      if (!logs[m.id]) fetch(`${apiBase}/monitors/${encodeURIComponent(m.id)}/observed?hours=start`)
        .then((r) => r.json()).then((d) => { if (alive && d) setLogs((p) => ({ ...p, [m.id]: d })); }).catch(() => {});
      if (!tls[m.id]) fetch(`${apiBase}/monitors/${encodeURIComponent(m.id)}/timeline?hours=start&interval=30`)
        .then((r) => r.json()).then((d) => {
          if (!alive || !d) return;
          const buckets = (d.buckets) || [];
          let byStation = (d.stationTotals && Object.keys(d.stationTotals).length) ? d.stationTotals : null;
          if (!byStation) {
            byStation = {};
            (d.devices || []).forEach((dev) => { const s = dev.station || ''; if (!byStation[s]) byStation[s] = buckets.map(() => 0); (dev.counts || []).forEach((c, i) => { if (byStation[s][i] != null) byStation[s][i] += (c || 0); }); });
          }
          setTls((p) => ({ ...p, [m.id]: { buckets, byStation, devices: d.devices || [] } }));
        }).catch(() => { if (alive) setTls((p) => ({ ...p, [m.id]: { buckets: [], byStation: {}, devices: [] } })); });
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, apiBase]);

  const model = useMemo(() => buildModel(monitors, logs, tls, weight), [ids, logs, tls, weight]); // eslint-disable-line react-hooks/exhaustive-deps
  const loading = monitors.some((m) => !logs[m.id] || !tls[m.id]);

  if (loading && !model) return <div style={{ ...card, fontSize: 12, color: 'var(--muted)' }}>Reading each station's day — connectivity and throughput…</div>;
  if (!model) return <div style={{ ...card, fontSize: 12, color: 'var(--muted)' }}>No observed checks yet — Flow appears once Pulse's offline log has coverage.</div>;

  const { H, hourAt, stations, thruIdx } = model;
  const allZones = [...new Set(stations.map((s) => s.zone))];
  const zActive = zones || new Set(allZones);
  const cellVal = (c) => (measure === 'conn' ? Math.round(c.conn * 100) : measure === 'thru' ? Math.round(c.thru * 100) : c.flow);
  const cellCol = (c) => (measure === 'thru' ? thruColor(c.thru) : traffic(measure === 'conn' ? c.conn * 100 : c.flow));

  let shown = stations.filter((s) => zActive.has(s.zone) && s.summary);
  if (sort === 'best') shown = [...shown].sort((a, b) => (b.summary.flow ?? -1) - (a.summary.flow ?? -1));
  else if (sort === 'worst') shown = [...shown].sort((a, b) => (a.summary.flow ?? 999) - (b.summary.flow ?? 999));

  const ranked = [...stations].filter((s) => s.summary && s.summary.flow != null).sort((a, b) => b.summary.flow - a.summary.flow);
  const evFlow = ranked.length ? Math.round(ranked.reduce((a, s) => a + s.summary.flow, 0) / ranked.length) : 0;
  let onl = 0, tot = 0;
  stations.forEach((st) => { for (let i = H - 1; i >= 0; i--) { const c = st.hourly[i]; if (!c.closed) { onl += c.onlineDev; tot += c.total; break; } } });
  const nowPct = tot ? Math.round(100 * onl / tot) : 0;
  const zAgg = allZones.map((z) => { const ss = stations.filter((s) => s.zone === z && s.summary && s.summary.flow != null); return { z, f: ss.length ? Math.round(ss.reduce((a, s) => a + s.summary.flow, 0) / ss.length) : null }; }).filter((x) => x.f != null);
  const bestZ = [...zAgg].sort((a, b) => b.f - a.f)[0], worstZ = [...zAgg].sort((a, b) => a.f - b.f)[0];
  const worstSt = ranked[ranked.length - 1];

  // ── styles ──
  const seg = { display: 'inline-flex', background: 'var(--bg, var(--card))', border: '1px solid var(--hairline)', borderRadius: 10, padding: 3, gap: 2 };
  const segBtn = (act, accent) => ({ border: 0, background: act ? (accent ? 'var(--brand)' : 'var(--card)') : 'transparent', color: act ? (accent ? '#fff' : 'var(--text)') : 'var(--muted)', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, padding: '6px 10px', borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap', boxShadow: act && !accent ? '0 1px 2px rgba(0,0,0,.12)' : 'none' });
  const chipS = (act) => ({ border: `1px solid ${act ? 'var(--brand)' : 'var(--hairline)'}`, background: act ? 'rgba(var(--brand-rgb,255,56,92),0.08)' : 'var(--card)', color: act ? 'var(--brand)' : 'var(--muted)', borderRadius: 999, padding: '5px 10px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' });
  const kpi = { ...card, padding: '12px 13px', minWidth: 0 };
  const kLab = { fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--muted)' };
  const labw = 'clamp(150px,32vw,205px)';

  const toggleZone = (z) => setZones((prev) => { const s = new Set(prev || allZones); if (s.has(z) && s.size > 1) s.delete(z); else s.add(z); return s; });

  const kpis = [
    { l: 'Event flow', v: <span style={{ color: traffic(evFlow) }}>{evFlow}</span>, m: 'across the open fleet' },
    { l: 'On-air now', v: <>{nowPct}<small style={{ fontSize: 14, color: 'var(--muted)' }}>%</small></>, m: `${onl} of ${tot} devices sending` },
    { l: 'Best zone', v: <span style={{ fontSize: 18 }}>{bestZ ? bestZ.z : '—'}</span>, m: bestZ ? <>flow <b style={{ color: traffic(bestZ.f) }}>{bestZ.f}</b>{worstZ ? <> · weakest {worstZ.z} {worstZ.f}</> : ''}</> : '' },
    { l: 'Weakest station', v: <span style={{ fontSize: 16 }}>{worstSt ? worstSt.name : '—'}</span>, m: worstSt ? <>flow <b style={{ color: traffic(worstSt.summary.flow) }}>{worstSt.summary.flow}</b> · tap to inspect</> : '', click: worstSt ? () => setOpen(open === worstSt.mid + '|' + worstSt.sn ? null : worstSt.mid + '|' + worstSt.sn) : null },
  ];

  const splitBar = (sm) => (
    <div style={{ height: 6, borderRadius: 4, background: 'var(--hairline)', overflow: 'hidden', display: 'flex', marginTop: 5, width: 120, maxWidth: '34vw' }} title={`connectivity ${Math.round(sm.conn * 100)} · throughput ${Math.round(sm.thru * 100)}`}>
      <i style={{ width: `${sm.conn * 50}%`, background: STATUS_COLOR.fresh }} />
      <i style={{ width: `${sm.thru * 50}%`, background: `rgb(${THRU})` }} />
    </div>
  );
  const lbRow = (x, rank) => {
    const key = x.mid + '|' + x.sn;
    return (
      <button key={key} onClick={() => { setOpen(open === key ? null : key); }} style={{ display: 'grid', gridTemplateColumns: '16px 1fr auto', alignItems: 'center', gap: 10, padding: '7px 6px', borderRadius: 9, cursor: 'pointer', background: 'transparent', border: 0, textAlign: 'left', fontFamily: 'inherit', width: '100%' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{rank}</span>
        <span style={{ minWidth: 0 }}>
          <b style={{ fontSize: 13, fontWeight: 650, display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.name}</b>
          <span style={{ fontSize: 10.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{x.zone}</span>
          {splitBar(x.summary)}
        </span>
        <span style={{ fontSize: 15, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: traffic(x.summary.flow), minWidth: 32, textAlign: 'right' }}>{x.summary.flow}</span>
      </button>
    );
  };

  // ── matrix rows ──
  const rows = [];
  rows.push(
    <div key="axis" style={{ display: 'grid', gridTemplateColumns: `${labw} repeat(${H},minmax(28px,1fr))` }}>
      <div style={{ position: 'sticky', left: 0, zIndex: 2, background: 'var(--card)', padding: '7px 0 7px 14px', fontSize: 9.5, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--muted)', borderBottom: '1px solid var(--hairline)' }}>Station</div>
      {Array.from({ length: H }, (_, i) => <div key={i} style={{ padding: '7px 2px', fontSize: 9.5, fontWeight: 700, color: 'var(--muted)', textAlign: 'center', fontVariantNumeric: 'tabular-nums', borderBottom: '1px solid var(--hairline)' }}>{hourAt(i).slice(0, 2)}</div>)}
    </div>
  );
  let lastZone = null;
  shown.forEach((st) => {
    if (sort === 'zone' && st.zone !== lastZone) {
      lastZone = st.zone;
      const zs = stations.filter((s) => s.zone === st.zone && s.summary && s.summary.flow != null);
      const zf = zs.length ? Math.round(zs.reduce((a, s) => a + s.summary.flow, 0) / zs.length) : null;
      rows.push(
        <div key={'z' + st.zone} style={{ position: 'sticky', left: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', background: 'var(--bg,var(--card))', borderBottom: '1px solid var(--hairline)', fontSize: 10.5, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--muted)' }}>
          {st.zone}<span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: flowColorText(zf), letterSpacing: 0 }}>flow {zf ?? '—'}</span>
        </div>
      );
    }
    const key = st.mid + '|' + st.sn, isOpen = open === key, sm = st.summary;
    rows.push(
      <div key={key} style={{ display: 'grid', gridTemplateColumns: `${labw} repeat(${H},minmax(28px,1fr))`, cursor: 'pointer', borderBottom: '1px solid var(--hairline)' }} onClick={() => setOpen(isOpen ? null : key)}>
        <div style={{ position: 'sticky', left: 0, zIndex: 2, background: 'var(--card)', display: 'flex', alignItems: 'center', gap: 7, padding: '0 10px 0 12px', minWidth: 0 }}>
          <span style={{ color: 'var(--muted)', fontSize: 10, transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s', width: 9, flex: 'none' }}>▶</span>
          <span style={{ minWidth: 0 }}>
            <b style={{ fontSize: 12.5, fontWeight: 600, display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{st.name}</b>
            <small style={{ fontSize: 10, color: 'var(--muted)' }}>{st.total} dev · ~{sm.avgOn} on-air{sm.drag > 18 ? ` · drag ${sm.drag}` : ''}</small>
          </span>
          <span style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 800, fontVariantNumeric: 'tabular-nums', flex: 'none', paddingLeft: 8, color: flowColorText(sm.flow) }}>{sm.flow ?? '—'}</span>
        </div>
        {st.hourly.map((c, i) => c.closed
          ? <div key={i} style={{ margin: 2, borderRadius: 4, minHeight: 26, background: 'var(--hairline)', opacity: 0.4 }} />
          : (() => { const col = cellCol(c); return (
            <div key={i} onMouseEnter={(e) => setTip({ x: e.clientX, y: e.clientY, st, c, i })} onMouseMove={(e) => setTip((t) => t && { ...t, x: e.clientX, y: e.clientY })} onMouseLeave={() => setTip(null)}
              style={{ margin: 2, borderRadius: 4, minHeight: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', background: col, color: textOn(col), fontSize: 9.5, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{cellVal(c)}</div>
          ); })())}
      </div>
    );
    if (isOpen) {
      const ops = operatorsFor(st, tls[st.mid], weight, thruIdx);
      ops.forEach((op, oi) => {
        rows.push(
          <div key={key + '|op' + oi} style={{ display: 'grid', gridTemplateColumns: `${labw} 1fr`, background: 'var(--bg,var(--card))', borderBottom: '1px solid var(--hairline)' }}>
            <div style={{ position: 'sticky', left: 0, background: 'var(--bg,var(--card))', display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px 5px 30px', minWidth: 0 }}>
              <span style={{ fontSize: 9.5, color: 'var(--muted)', flex: 'none' }}>{op.role}</span>
              <span style={{ fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{op.name}</span>
              {oi === 0 && <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 6px', borderRadius: 5, color: STATUS_COLOR.fresh, background: 'rgba(22,163,74,.14)', flex: 'none' }}>TOP</span>}
              {oi === ops.length - 1 && ops.length > 1 && <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 6px', borderRadius: 5, color: STATUS_COLOR.stale, background: 'rgba(220,38,38,.14)', flex: 'none' }}>LOW</span>}
              <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 800, fontVariantNumeric: 'tabular-nums', flex: 'none', color: traffic(op.flow) }}>{op.flow}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '5px 12px', fontSize: 11, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', flexWrap: 'wrap' }}>
              <span>{op.txns.toLocaleString('en-ZA')} {st.unit}</span>
              <span>uptime <b style={{ color: 'var(--text)' }}>{Math.round(op.conn * 100)}%</b></span>
              <span>throughput <b style={{ color: 'var(--text)' }}>{Math.round(op.thru * 100)}</b></span>
            </div>
          </div>
        );
      });
      rows.push(
        <div key={key + '|note'} style={{ position: 'sticky', left: 0, padding: '7px 14px 9px 30px', fontSize: 11, color: 'var(--muted)', background: 'var(--bg,var(--card))', borderBottom: '1px solid var(--hairline)', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <span>Drag <b style={{ color: sm.drag > 18 ? STATUS_COLOR.stale : 'var(--text)' }}>{sm.drag}</b>{sm.drag > 18 ? ' — signal is costing volume here' : ''}</span>
          {ops.length > 0 && <span><b style={{ color: 'var(--text)' }}>{ops[0].name}</b> leading · <b style={{ color: 'var(--text)' }}>{ops[ops.length - 1].name}</b> trailing</span>}
          {onSelect && <button onClick={(e) => { e.stopPropagation(); onSelect({ mid: st.mid, sn: st.sn, name: st.name, zone: st.zone, monitor: st.monitor.name, unit: st.unit, on: sm.avgOn, off: st.total - sm.avgOn, txnH: null, lagMin: null, status: sm.flow >= 70 ? 'fresh' : sm.flow >= 45 ? 'warn' : 'stale' }); }} style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--brand)', borderRadius: 7, padding: '3px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Open station →</button>}
        </div>
      );
    }
  });

  return (
    <div>
      {/* controls */}
      <div style={{ display: 'flex', gap: '10px 14px', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={{ ...kLab, fontSize: 9.5 }}>Colour by</span>
          <span style={seg}>
            {[['flow', 'Flow score'], ['conn', 'Connectivity'], ['thru', 'Throughput']].map(([k, l]) => <button key={k} style={segBtn(measure === k, true)} onClick={() => setMeasure(k)}>{l}</button>)}
          </span>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5, opacity: measure === 'flow' ? 1 : 0.4, pointerEvents: measure === 'flow' ? 'auto' : 'none' }}>
          <span style={{ ...kLab, fontSize: 9.5 }}>Weighting</span>
          <span style={seg}>
            {[[0.5, 'Balanced'], [0.7, 'Uptime-led'], [0.3, 'Volume-led']].map(([w, l]) => <button key={w} style={segBtn(weight === w)} onClick={() => setWeight(w)}>{l}</button>)}
          </span>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={{ ...kLab, fontSize: 9.5 }}>Order</span>
          <span style={seg}>
            {[['zone', 'By zone'], ['best', 'Best first'], ['worst', 'Worst first']].map(([k, l]) => <button key={k} style={segBtn(sort === k)} onClick={() => setSort(k)}>{l}</button>)}
          </span>
        </label>
        <div style={{ flex: '1 1 auto' }} />
        {allZones.length > 1 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {allZones.map((z) => <button key={z} style={chipS(zActive.has(z))} onClick={() => toggleZone(z)}>{z}</button>)}
        </div>}
      </div>

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10, marginBottom: 14 }}>
        {kpis.map((k, i) => (
          <div key={i} style={{ ...kpi, cursor: k.click ? 'pointer' : 'default' }} onClick={k.click || undefined}>
            <div style={kLab}>{k.l}</div>
            <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-.02em', marginTop: 5, lineHeight: 1 }}>{k.v}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{k.m}</div>
          </div>
        ))}
      </div>

      {/* leaderboards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 12, marginBottom: 14 }}>
        <div style={card}>
          <h3 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 7 }}>Strongest flow <span style={{ fontSize: 9.5, fontWeight: 700, padding: '2px 7px', borderRadius: 6, color: STATUS_COLOR.fresh, background: 'rgba(22,163,74,.12)' }}>TOP 5</span></h3>
          {ranked.slice(0, 5).map((x, i) => lbRow(x, i + 1))}
        </div>
        <div style={card}>
          <h3 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 7 }}>Needs attention <span style={{ fontSize: 9.5, fontWeight: 700, padding: '2px 7px', borderRadius: 6, color: STATUS_COLOR.stale, background: 'rgba(220,38,38,.12)' }}>BOTTOM 5</span></h3>
          {ranked.slice(-5).reverse().map((x, i) => lbRow(x, ranked.length - i))}
        </div>
      </div>

      {/* matrix */}
      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '11px 14px', borderBottom: '1px solid var(--hairline)', flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 14.5, fontWeight: 800 }}>{measure === 'flow' ? 'Flow' : measure === 'conn' ? 'Connectivity' : 'Throughput'} across the day</h2>
          <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>Tap a station to open its operators · scroll sideways →</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 560 }}>{rows}</div>
        </div>
      </div>

      {/* legend + metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 12, marginTop: 14 }}>
        <div style={card}>
          <h3 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 800 }}>Key flow metrics</h3>
          {[
            ['📶', 'Connectivity', <>Share of a station's devices Pulse saw <em>on-air</em> at each check — the authoritative uptime, from the observed log.</>],
            ['🍺', 'Throughput', <>Transactions per active device per hour, indexed against the busiest station-hour so a kiosk and a mega-bar compare fairly.</>],
            ['🎯', 'Flow score', <>The headline (0–100): a weighted blend <b>w·conn + (1−w)·thru</b>. Re-weight when uptime or volume matters more.</>],
            ['🔻', 'Drag', <>How far throughput fell below what the uptime should have supported — revenue lost to <em>signal</em>, not a quiet crowd.</>],
          ].map(([ic, t, p], i) => (
            <div key={i} style={{ display: 'flex', gap: 10, padding: '8px 0', borderTop: i ? '1px solid var(--hairline)' : 0 }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, background: 'var(--bg,var(--card))' }}>{ic}</div>
              <div><b style={{ fontSize: 12.5 }}>{t}</b><p style={{ margin: '2px 0 0', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.4 }}>{p}</p></div>
            </div>
          ))}
        </div>
        <div style={card}>
          <h3 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 800 }}>Reading the heat</h3>
          <div style={{ height: 14, borderRadius: 7, margin: '8px 0 6px', background: `linear-gradient(90deg,${STATUS_COLOR.stale},${STATUS_COLOR.warn} 34%,${MID} 52%,${STATUS_COLOR.fresh})` }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{[0, 25, 50, 75, 100].map((n) => <span key={n}>{n}</span>)}</div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 10 }}>Each cell = one station · one hour; the number is the score.</div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6, display: 'flex', alignItems: 'center', gap: 7 }}><i style={{ width: 10, height: 10, borderRadius: 3, background: 'var(--hairline)', opacity: 0.5, flex: 'none' }} /> Greyed = station closed / not open that hour.</div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>Throughput uses a cyan intensity ramp (more = deeper); Flow &amp; Connectivity use red→green.</div>
        </div>
      </div>

      {tip && (
        <div style={{ position: 'fixed', left: Math.min(tip.x + 12, (typeof window !== 'undefined' ? window.innerWidth : 400) - 200), top: tip.y + 12, zIndex: 60, pointerEvents: 'none', background: 'var(--text)', color: 'var(--card)', padding: '8px 10px', borderRadius: 8, fontSize: 11.5, lineHeight: 1.5, boxShadow: '0 10px 30px -8px rgba(0,0,0,.5)', maxWidth: 220 }}>
          <b>{tip.st.name}</b> · {hourAt(tip.i)}<br />
          On-air {tip.c.onlineDev}/{tip.c.total} ({Math.round(tip.c.conn * 100)}%)<br />
          {tip.c.txns.toLocaleString('en-ZA')} {tip.st.unit} · {Math.round(tip.c.thru * 100)} thru<br />
          Flow <b style={{ color: traffic(tip.c.flow) }}>{tip.c.flow}</b>
        </div>
      )}
    </div>
  );
}
