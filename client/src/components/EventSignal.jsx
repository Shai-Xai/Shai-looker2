import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ShareMenu from './ShareMenu.jsx';
import SignalReportPanel from './SignalReportPanel.jsx';
import EventFlow from './EventFlow.jsx';
import AiMark from './AiMark.jsx';
import OwlQuips from './OwlQuips.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
import { useSheetDrag } from '../lib/useSheetDrag.js';

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
function DeepDive({ apiBase, mid, station, unit, day = '' }) {
  const [t, setT] = useState(null);
  const [obs, setObs] = useState(null); // the observed offline log — fuels the 🚦 robot view
  const [robot, setRobot] = useState(true);
  const [err, setErr] = useState('');
  const [tryN, setTryN] = useState(0); // Retry bumps this — live reads can hiccup mid-event
  const [dayTip, setDayTip] = useState(''); // tap/hover readout for the day graph (title= is desktop-only)
  const [pulseTip, setPulseTip] = useState('');
  useEffect(() => {
    let alive = true; setT(null); setObs(null); setErr('');
    const hrs = day ? `day:${day}` : 'start'; // a picked festival day time-travels the whole dive
    fetch(`${apiBase}/monitors/${encodeURIComponent(mid)}/timeline?hours=${hrs}&interval=30&station=${encodeURIComponent(station)}`)
      .then((r) => r.json()).then((d) => { if (alive) { if (d && d.devices) setT(d); else setErr((d && d.error) || 'No timeline'); } })
      .catch((e) => { if (alive) setErr(e.message); });
    fetch(`${apiBase}/monitors/${encodeURIComponent(mid)}/observed?hours=${hrs}`)
      .then((r) => r.json()).then((d) => { if (alive) setObs(d); }).catch(() => {});
    return () => { alive = false; };
  }, [apiBase, mid, station, tryN, day]);
  if (err) {
    return (
      <div style={{ fontSize: 12, color: STATUS_COLOR.stale, marginTop: 10 }}>
        ⚠️ {err}{' '}
        <button onClick={() => setTryN((v) => v + 1)} style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 6, padding: '2px 10px', fontSize: 11, cursor: 'pointer', marginLeft: 6 }}>Retry</button>
      </div>
    );
  }
  if (!t) return <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>Pulling the day's device timeline…</div>;
  const isOn = (d) => (d.lagMin != null ? d.lagMin <= (t.onlineMin || 15) : (d.active || []).slice(-2).some(Boolean));
  const devs = [...(t.devices || [])].sort((a, b) => (isOn(a) - isOn(b)) || String(a.device).localeCompare(String(b.device)));
  const tot = (d) => (d.counts || []).reduce((x, y) => x + y, 0);
  // 🚦 Robot view: fuse the blocks with the OBSERVED log — per block: online +
  // data (green), seen OFFLINE at a check yet data synced later (amber),
  // offline + no data (red), online but quiet (grey). Same language as the
  // Combined mode in Data health; a late sync can never repaint the red.
  let offMap = null;
  if (robot && obs && obs.configured && (t.buckets || []).length) {
    const first = Date.parse(t.buckets[0]);
    const ivMs = (t.intervalMin || 30) * 60000;
    const n = t.buckets.length;
    const tickB = (obs.ticks || []).map((k) => Math.floor((Date.parse(k.at) - first) / ivMs));
    offMap = new Map((obs.devices || []).map((d) => [d.device, new Set((d.offAt || []).map((ti) => tickB[ti]).filter((b) => b >= 0 && b < n))]));
  }
  const cellBg = (dev, a, i) => {
    const off = !!(offMap && offMap.get(dev) && offMap.get(dev).has(i));
    if (a && off) return STATUS_COLOR.warn;
    if (a) return STATUS_COLOR.fresh;
    if (off) return STATUS_COLOR.stale;
    return 'var(--hairline)';
  };
  const chip = (act) => ({ border: `1px solid ${act ? 'var(--brand)' : 'var(--hairline)'}`, color: act ? 'var(--brand)' : 'var(--muted)', background: 'var(--card)', borderRadius: 999, padding: '2px 9px', fontSize: 10.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' });
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: 'var(--muted)', flex: 1, minWidth: 180 }}>
          Today per device — each block 30 min from the start.{' '}
          {offMap
            ? <><span style={{ color: STATUS_COLOR.fresh, fontWeight: 700 }}>green = online + data</span> · <span style={{ color: STATUS_COLOR.warn, fontWeight: 700 }}>amber = offline at a check, data synced later</span> · <span style={{ color: STATUS_COLOR.stale, fontWeight: 700 }}>red = offline + no data</span> · grey = quiet.</>
            : <><span style={{ color: STATUS_COLOR.fresh, fontWeight: 700 }}>green = sent data</span>, grey = silent.</>}
          {' '}Dark devices listed first.
        </span>
        <button style={chip(!robot)} onClick={() => setRobot(false)}>🟩 Blocks</button>
        <button style={chip(robot)} onClick={() => setRobot(true)}>🚦 Robot</button>
      </div>
      {robot && obs && !obs.configured && <div style={{ fontSize: 10.5, color: 'var(--muted)', marginBottom: 6 }}>No observed checks in this window yet — amber/red appear once Pulse's own offline log has coverage.</div>}
      {/* 📈 The station's pulse line — its hourly rate with the peak flagged,
          built from the same 30-min timeline (pairs summed into hours). */}
      {(t.buckets || []).length >= 4 && (() => {
        // Prefer the server's bucketTotals — on a big fleet the per-device counts are truncated (20k cap),
        // so summing them here loses the early hours; bucketTotals is the non-truncated line.
        const bt = (t.bucketTotals && t.bucketTotals.length === t.buckets.length) ? t.bucketTotals : null;
        const hourly = [];
        for (let i = 0; i + 1 < t.buckets.length; i += 2) {
          const v = bt ? ((bt[i] || 0) + (bt[i + 1] || 0)) : devs.reduce((a, d) => a + ((d.counts || [])[i] || 0) + ((d.counts || [])[i + 1] || 0), 0);
          hourly.push({ label: String(t.buckets[i]).slice(11, 16), v });
        }
        const max = Math.max(1, ...hourly.map((x) => x.v));
        const pk = hourly.reduce((bi, x, i) => (x.v > hourly[bi].v ? i : bi), 0);
        const act = hourly.filter((x) => x.v > 0);
        const mean = act.length ? Math.round(act.reduce((a, x) => a + x.v, 0) / act.length) : 0;
        if (!act.length) return null;
        return (
          <div style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.1, textTransform: 'uppercase', color: 'var(--muted)' }}>Station rhythm · {unit}/h</span>
              <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
                {pulseTip
                  ? <b style={{ color: 'var(--text)' }}>{pulseTip}</b>
                  : <>peak <b style={{ color: 'var(--brand)' }}>{hourly[pk].v.toLocaleString('en-ZA')}</b> at {hourly[pk].label} · ~{mean.toLocaleString('en-ZA')}/h avg</>}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 44, borderBottom: '1px solid var(--hairline)', marginTop: 3 }}>
              {hourly.map((x, i) => {
                const cap = `${x.label} · ${x.v.toLocaleString('en-ZA')} ${unit}/h`;
                return (
                  <i key={i} title={cap} onClick={() => setPulseTip(cap)} onMouseEnter={() => setPulseTip(cap)} onMouseLeave={() => setPulseTip('')}
                    style={{ flex: 1, borderRadius: '2px 2px 0 0', height: Math.max(2, Math.round((x.v / max) * 42)), background: i === pk ? 'var(--brand)' : STATUS_COLOR.fresh, opacity: i === pk ? 1 : 0.85, cursor: 'pointer' }} />
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', paddingTop: 2 }}>
              {[0, 0.25, 0.5, 0.75, 1].map((f) => <span key={f}>{hourly[Math.min(hourly.length - 1, Math.round(f * (hourly.length - 1)))].label}</span>)}
            </div>
          </div>
        );
      })()}
      {/* Stacked day graph — online (green) vs offline (red) at every Pulse
          check, scoped to THIS station's devices via the observed log. */}
      {obs && obs.configured && (obs.ticks || []).length >= 3 && devs.length > 0 && (() => {
        const devSet = new Set(devs.map((d) => d.device));
        const ticks = (obs.ticks || []).slice(-96);
        const base = (obs.ticks || []).length - ticks.length;
        const offN = ticks.map(() => 0);
        (obs.devices || []).forEach((d) => {
          if (!devSet.has(d.device)) return;
          (d.offAt || []).forEach((ti) => { const i = ti - base; if (i >= 0 && i < offN.length) offN[i] += 1; });
        });
        const H = 34;
        const lbl = (f) => String(ticks[Math.min(ticks.length - 1, Math.round(f * (ticks.length - 1)))].at || '').slice(11, 16);
        return (
          <div style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.1, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 3 }}>Devices online through the day</span>
              <span style={{ marginLeft: 'auto', fontSize: 9.5, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
                {dayTip
                  ? <b style={{ color: 'var(--text)' }}>{dayTip}</b>
                  : <><span style={{ color: STATUS_COLOR.fresh, fontWeight: 700 }}>online</span> · <span style={{ color: STATUS_COLOR.stale, fontWeight: 700 }}>offline</span> at each check — tap a bar</>}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1.5, height: H }}>
              {ticks.map((k, i) => {
                const off = Math.min(offN[i], devSet.size);
                const on = Math.max(0, devSet.size - off);
                const cap = `${String(k.at || '').slice(11, 16)} · ${on} online · ${off} offline`;
                return (
                  <span key={i} title={cap} onClick={() => setDayTip(cap)} onMouseEnter={() => setDayTip(cap)} onMouseLeave={() => setDayTip('')}
                    style={{ flex: '1 1 0', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: H, cursor: 'pointer' }}>
                    {off > 0 && <i style={{ display: 'block', height: Math.max(2, Math.round((off / devSet.size) * H)), background: STATUS_COLOR.stale, borderRadius: '1px 1px 0 0', opacity: 0.85 }} />}
                    {on > 0 && <i style={{ display: 'block', height: Math.max(2, Math.round((on / devSet.size) * H)), background: STATUS_COLOR.fresh, borderRadius: off ? 0 : '1px 1px 0 0' }} />}
                  </span>
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', borderTop: '1px solid var(--hairline)', paddingTop: 2 }}>
              {[0, 0.25, 0.5, 0.75, 1].map((f) => <span key={f}>{lbl(f)}</span>)}
            </div>
          </div>
        );
      })()}
      <div style={{ maxHeight: 340, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 5 }}>
        {devs.map((d) => (
          <div key={d.device} style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, fontSize: 11.5 }}>
            <span style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0, background: isOn(d) ? STATUS_COLOR.fresh : STATUS_COLOR.stale }} />
            <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '32%' }}>{d.device}</span>
            {d.operator ? <span style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '20%' }}>{d.operator}</span> : null}
            <span style={{ display: 'flex', gap: 1, flexShrink: 1, minWidth: 0, overflow: 'hidden' }}>
              {(d.active || []).map((a, i) => (
                <i key={i} style={{ width: 4, height: 10, borderRadius: 1, flexShrink: 0, background: cellBg(d.device, a, i) }} />
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

// One line per open monitor — the text that rides a Share (WhatsApp/Slack/email).
export function healthShareText(monitors) {
  return (monitors || []).filter((m) => m.status !== 'closed').map((m) => {
    const s = m.rosterSnapshot || {};
    return `${m.name}: ${s.online ?? '—'} online · ${s.offline ?? '—'} offline · ${(s.lastHourScans ?? 0).toLocaleString('en-ZA')} ${unitFor(m)} last hour`;
  }).join('\n');
}

// 🦉 The Owl summary — SAME affordance as every dashboard: the AiMark
// "Summary" pill that opens the docked right drawer (bottom sheet on phones).
export function OwlSummary({ entityId, suiteId, title = 'Data health' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} title="AI summary of this page"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 999, padding: '5px 13px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', minHeight: 34, fontFamily: 'inherit' }}>
        <AiMark size={18} /> Summary
      </button>
      {open && <OwlDrawer entityId={entityId} suiteId={suiteId} title={title} onClose={() => setOpen(false)} />}
    </>
  );
}

// ⋯ page-actions menu — on phones the header folds Summary/Share/refresh into
// this one button so the control row never crowds the screen. The children are
// the SAME components the desktop row renders; the menu stays mounted while
// their own drawers/popovers are open (tap the backdrop to dismiss).
export function ControlKebab({ children, label = 'Page actions' }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative', flexShrink: 0, display: 'inline-flex' }}>
      <button onClick={() => setOpen((v) => !v)} title={label} aria-label={label}
        style={{ border: '1px solid var(--hairline)', background: open ? 'var(--hover, rgba(127,127,127,0.12))' : 'var(--card)', color: 'var(--text)', borderRadius: 8, minWidth: 40, minHeight: 34, cursor: 'pointer', fontSize: 17, fontWeight: 800, lineHeight: 1 }}>⋯</button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 940 }} />
          <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 941, display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 8, padding: 10, borderRadius: 12, border: '1px solid var(--hairline)', background: 'var(--card)', boxShadow: '0 12px 32px rgba(0,0,0,0.3)', minWidth: 170 }}>
            {children}
          </div>
        </>
      )}
    </span>
  );
}

const OWL_W = 420; // keep in sync with the dashboard drawer's reflow width
function OwlDrawer({ entityId, suiteId, title, onClose }) {
  const isMobile = useIsMobile();
  const [state, setState] = useState('busy'); // 'busy' | {markdown} | {error}
  const run = () => {
    setState('busy');
    fetch('/api/my/data-health/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entityId: entityId || '', suiteId: suiteId || '' }) })
      .then((r) => r.json()).then((d) => setState(d && d.markdown ? d : { error: (d && d.error) || 'No summary came back' }))
      .catch((e) => setState({ error: e.message }));
  };
  useEffect(() => { run(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);
  // Desktop: dock as a right column and shift the app left, like the dashboard Owl.
  useEffect(() => {
    if (isMobile) return undefined;
    document.body.style.setProperty('--owl-width', `${OWL_W}px`);
    document.body.classList.add('owl-docked');
    return () => { document.body.classList.remove('owl-docked'); document.body.style.removeProperty('--owl-width'); };
  }, [isMobile]);
  const drag = useSheetDrag(onClose);
  const text = state && state.markdown ? String(state.markdown) : '';
  const md = (s) => s.split('\n').filter((l) => l.trim()).map((line, i) => {
    const t = line.trim();
    const head = /^#{1,6}\s+/.test(t);
    const bul = /^[-*]\s+/.test(t);
    const parts = t.replace(/^[-*]\s+/, '').replace(/^#{1,6}\s+/, '').split(/(\*\*[^*]+\*\*)/g)
      .map((p, j) => (p.startsWith('**') && p.endsWith('**') ? <strong key={j}>{p.slice(2, -2)}</strong> : p));
    if (head) return <div key={i} style={{ fontWeight: 700, margin: '12px 0 6px' }}>{parts}</div>;
    return <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>{bul && <span style={{ color: 'var(--brand)' }}>•</span>}<span>{parts}</span></div>;
  });
  const panel = { width: `min(${OWL_W}px, 94vw)`, height: '100%', background: 'var(--card)', boxShadow: '-4px 0 24px rgba(0,0,0,0.15)', borderLeft: '1px solid var(--hairline)', pointerEvents: 'auto', display: 'flex', flexDirection: 'column' };
  const btn = { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 17, color: '#888' };
  const node = (
    <div className={isMobile ? 'ai-overlay' : ''}
      style={isMobile ? { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 400 }
        : { position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, background: 'transparent', pointerEvents: 'none', display: 'flex', justifyContent: 'flex-end', zIndex: 400 }}
      onClick={isMobile ? onClose : undefined}>
      <div className={(isMobile ? 'ai-sheet' : 'ai-panel') + ' ai-glow'}
        style={isMobile ? { ...panel, width: '100%', maxHeight: '92dvh', borderRadius: '18px 18px 0 0', ...drag.style } : panel}
        onClick={(e) => e.stopPropagation()}>
        <style>{'@keyframes spin { to { transform: rotate(360deg); } }'}</style>
        {isMobile && <div className="sheet-grip" {...drag.handlers} style={{ marginTop: 8 }} />}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 18px', borderBottom: '1px solid var(--hairline)' }}>
          <AiMark size={28} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>Live status summary</div>
            <div style={{ fontSize: 15, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
          </div>
          {text && <ShareMenu variant="header" isMobile={isMobile} heading={`${title} · Owl summary`} text={text} />}
          <button style={btn} onClick={run} disabled={state === 'busy'} title="Regenerate">↻</button>
          <button style={{ ...btn, fontSize: isMobile ? 22 : 17 }} onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 18 }}>
          {state === 'busy' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ color: 'var(--muted)', fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⏳</span>
                Reading every station and summarising…
              </div>
              <OwlQuips prefix="" style={{ paddingLeft: 26 }} />
            </div>
          ) : state.error ? (
            <div style={{ color: STATUS_COLOR.stale, fontSize: 14, lineHeight: 1.5 }}>⚠ {state.error} <button onClick={run} style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 6, padding: '2px 10px', fontSize: 12, cursor: 'pointer', marginLeft: 6 }}>Retry</button></div>
          ) : (
            <div style={{ fontSize: 14, lineHeight: 1.65, color: 'var(--text)' }}>{md(text)}</div>
          )}
        </div>
        {!!text && (
          <div style={{ padding: '12px 18px 0' }}>
            <ShareMenu variant="footer" isMobile={isMobile} heading={`${title} · Owl summary`} text={text} label="Share this summary" />
          </div>
        )}
        <div style={{ padding: '10px 18px', borderTop: '1px solid var(--hairline)', fontSize: 11, color: 'var(--muted)' }}>
          Generated by Claude from this page's live station data. Verify important figures.
        </div>
      </div>
    </div>
  );
  return createPortal(node, document.body);
}

// 🚨 Needs eyes — the worst stations first: stale (red) then any with dark
// devices (amber), so the next radio call is always the top row. Collapsed by
// default (a one-line count) so it never eats the board.
function NeedsEyes({ rows, onSelect }) {
  const [open, setOpen] = useState(false);
  const bad = (rows || []).filter((s) => (s.off || 0) > 0 || s.status === 'stale')
    .sort((a, b) => ((b.status === 'stale') - (a.status === 'stale')) || ((b.off || 0) - (a.off || 0)) || ((b.lagMin || 0) - (a.lagMin || 0)))
    .slice(0, 6);
  if (!bad.length) return null;
  const reds = bad.filter((s) => s.status === 'stale').length;
  return (
    <div style={{ ...card, marginBottom: 10, paddingTop: 8, paddingBottom: open ? 12 : 8 }}>
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 30, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text)', fontFamily: 'inherit', textAlign: 'left' }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.2, textTransform: 'uppercase', color: 'var(--muted)' }}>Needs eyes — worst first</span>
        {reds > 0 && <span style={{ fontSize: 10.5, fontWeight: 800, color: STATUS_COLOR.stale }}>{reds} red</span>}
        {bad.length - reds > 0 && <span style={{ fontSize: 10.5, fontWeight: 800, color: STATUS_COLOR.warn }}>{bad.length - reds} amber</span>}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{open ? 'hide ▾' : 'show ▸'}</span>
      </button>
      {open && bad.map((s) => (
        <div key={s.monitor + s.name} role="button" tabIndex={0} onClick={() => onSelect && onSelect(s)}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.click(); }}
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderTop: '1px solid var(--hairline)', cursor: 'pointer', minWidth: 0 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, flexShrink: 0, background: s.status === 'stale' ? STATUS_COLOR.stale : STATUS_COLOR.warn }} />
          <span style={{ minWidth: 0, flex: 1 }}>
            <span style={{ display: 'block', fontSize: 12.5, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
            <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--muted)' }}>{s.zone}</span>
          </span>
          <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
            <span style={{ display: 'block', fontSize: 12 }}><b style={{ color: STATUS_COLOR.stale }}>{s.off} dark</b> · {s.on ?? '—'}/{(s.on || 0) + (s.off || 0)}</span>
            <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{fmtLag(s.lagMin)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

// 💓 Event pulse — the site's online/offline at every Pulse check, as a
// draggable strip: the playhead sits at LIVE; drag it back to replay the day
// (readout shows that moment's online vs offline). Built from the observed
// offline log — Pulse's own record, no live Looker cost.
function PulseStrip({ monitors, apiBase, rows, idx, setIdx, onScrub }) {
  const [logs, setLogs] = useState({}); // monitor id -> observed log
  const [journal, setJournal] = useState(false); // 30-min status journal open?
  useEffect(() => {
    let alive = true;
    monitors.forEach((m) => {
      if (logs[m.id]) return;
      fetch(`${apiBase}/monitors/${encodeURIComponent(m.id)}/observed?hours=start`)
        .then((r) => r.json()).then((d) => { if (alive && d && d.configured) setLogs((p) => ({ ...p, [m.id]: d })); })
        .catch(() => {});
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once per monitor
  }, [monitors.map((m) => m.id).join(','), apiBase]);
  const BIN = 10 * 60000;
  const bins = new Map(); // binStartMs -> {on, off}
  // ONLY the monitors currently on the board — a filter chip must re-scope
  // every number here, not show the whole site's darkness on a 1-station view.
  const active = monitors.map((m) => logs[m.id]).filter(Boolean);
  active.forEach((d) => {
    const offN = (d.ticks || []).map(() => 0);
    (d.devices || []).forEach((dev) => (dev.offAt || []).forEach((ti) => { if (offN[ti] != null) offN[ti] += 1; }));
    (d.ticks || []).forEach((k, ti) => {
      const b = Math.floor(Date.parse(k.at) / BIN) * BIN;
      if (!Number.isFinite(b)) return;
      if (!bins.has(b)) bins.set(b, { on: 0, off: 0 });
      const e = bins.get(b);
      e.off += offN[ti];
      e.on += k.online != null ? k.online : Math.max(0, (k.total || 0) - offN[ti]);
    });
  });
  const keys = [...bins.keys()].sort((a, b) => a - b).slice(-96);
  const series = keys.map((b) => ({ t: new Date(b), ...bins.get(b) }));
  // Scrub → tell the board WHICH devices were dark at that moment, grouped by
  // station, so the whole page can time-travel (tiles, dials, flow meter).
  useEffect(() => {
    if (!onScrub) return;
    if (idx == null || series.length < 3) { onScrub(null); return; }
    const cur0 = Math.min(idx, series.length - 1);
    const b0 = keys[cur0];
    const offBy = new Map(); // `${monitorId}|${station}` -> dark count then
    monitors.forEach((m) => {
      const d = logs[m.id];
      if (!d) return;
      let use = -1; // the monitor's last check at/before the scrubbed bin
      (d.ticks || []).forEach((k, ti) => { const t0 = Date.parse(k.at); if (Number.isFinite(t0) && t0 < b0 + BIN) use = ti; });
      if (use < 0) return;
      (d.devices || []).forEach((dev) => {
        if (!(dev.offAt || []).includes(use)) return;
        const key = `${m.id}|${dev.station || ''}`;
        offBy.set(key, (offBy.get(key) || 0) + 1);
      });
    });
    onScrub({ t: series[cur0].t, on: series[cur0].on, off: series[cur0].off, offBy });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- series/keys derive from logs
  }, [idx, logs]);
  if (keys.length < 3) return null;
  const max = Math.max(1, ...series.map((x) => x.on + x.off));
  const cur = idx == null ? series.length - 1 : Math.min(idx, series.length - 1);
  const ratePerMin = Math.round(monitors.reduce((a, m) => a + (((m.rosterSnapshot || {}).lastHourScans) || 0), 0) / 6) / 10;
  const H = 30;
  const hhmm = (d) => d.toTimeString().slice(0, 5);
  return (
    <div style={{ ...card, marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.2, textTransform: 'uppercase', color: 'var(--muted)', flexShrink: 0 }}>Event pulse · drag to replay</span>
        <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 180 }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1.5, height: H }}>
            {series.map((x, i) => (
              <span key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: H, opacity: i === cur ? 1 : 0.75 }}>
                {x.off > 0 && <i style={{ display: 'block', height: Math.max(1, Math.round((x.off / max) * (H - 2))), background: STATUS_COLOR.stale, borderRadius: '1px 1px 0 0' }} />}
                <i style={{ display: 'block', height: Math.max(2, Math.round((x.on / max) * (H - 2))), background: i === cur ? STATUS_COLOR.fresh : 'var(--hairline)', borderRadius: x.off ? 0 : '1px 1px 0 0' }} />
              </span>
            ))}
          </div>
          <span style={{ position: 'absolute', top: -3, bottom: -3, left: `${(cur / Math.max(1, series.length - 1)) * 100}%`, width: 2, background: 'var(--brand)', borderRadius: 2, pointerEvents: 'none' }} />
          <input type="range" min={0} max={series.length - 1} value={cur} aria-label="Replay the day"
            onChange={(e) => { const v = Number(e.target.value); setIdx(v >= series.length - 1 ? null : v); }}
            style={{ position: 'absolute', inset: '-8px 0', width: '100%', opacity: 0, cursor: 'ew-resize', touchAction: 'none' }} />
        </div>
        <span style={{ flexShrink: 0, fontSize: 11.5, fontWeight: 800, fontVariantNumeric: 'tabular-nums', border: '1px solid var(--hairline)', borderRadius: 8, padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {idx == null ? (
            <><span style={{ width: 7, height: 7, borderRadius: 4, background: STATUS_COLOR.fresh, display: 'inline-block' }} /> LIVE · {ratePerMin.toLocaleString('en-ZA')}/min</>
          ) : (
            <>
              ⏪ {hhmm(series[cur].t)} · <b style={{ color: STATUS_COLOR.fresh }}>{series[cur].on}</b> on · <b style={{ color: series[cur].off ? STATUS_COLOR.stale : 'var(--muted)' }}>{series[cur].off}</b> off
              <button onClick={() => setIdx(null)} style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 6, padding: '1px 8px', fontSize: 10.5, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' }}>LIVE</button>
            </>
          )}
        </span>
      </div>
      {/* Last 60 min — is it improving or getting worse? Volume bars from the
          stations' 10-min sparks; darkness compared with an hour ago. */}
      {(() => {
        const vol = [0, 0, 0, 0, 0, 0];
        (rows || []).forEach((s) => (s.spark || []).forEach((v, i) => { vol[i] += v || 0; }));
        const volTot = vol.reduce((a, b) => a + b, 0);
        if (!volTot && series.length < 7) return null;
        const vMax = Math.max(1, ...vol);
        const half = (a) => a.reduce((x, y) => x + y, 0);
        const volNow = half(vol.slice(3)); const volPrev = half(vol.slice(0, 3));
        const volPct = volPrev ? Math.round(((volNow - volPrev) / volPrev) * 100) : 0;
        const offNow = series[series.length - 1].off;
        const offAgo = series[Math.max(0, series.length - 7)].off;
        // The verdict follows the DARKNESS direction, full stop: more devices
        // dark than an hour ago = worse, fewer = improving. Volume is context
        // only — a quiet spell must not flip a recovering site to "worse".
        const worse = offNow > offAgo;
        const better = offNow < offAgo;
        const delta = Math.abs(offAgo - offNow);
        const big = offAgo > 0 && delta / offAgo >= 0.4; // 40%+ of the dark came back = a BIG swing
        const vc = worse ? STATUS_COLOR.stale : better ? STATUS_COLOR.fresh : 'var(--muted)';
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--hairline)' }}>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.2, textTransform: 'uppercase', color: 'var(--muted)', flexShrink: 0 }}>Last 60 min</span>
            <span style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 20 }}>
              {vol.map((v, i) => <i key={i} title={`${v.toLocaleString('en-ZA')} in 10 min`} style={{ display: 'block', width: 9, borderRadius: '1px 1px 0 0', height: Math.max(2, Math.round((v / vMax) * 20)), background: i >= 3 ? STATUS_COLOR.fresh : 'var(--hairline)' }} />)}
            </span>
            <span style={{ fontSize: 11.5, fontWeight: 800, color: vc }}>
              {worse ? '▼ Getting worse' : better ? (big ? '▲ Big improvement' : '▲ Improving') : '► Steady'}
            </span>
            <span style={{ fontSize: 10.5, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
              dark {offAgo}→{offNow}{better ? ` · ${delta} back online` : worse ? ` · ${delta} more went dark` : ''} · volume {volPct >= 0 ? '+' : ''}{volPct}% vs prev 30 min
            </span>
            <span style={{ flex: 1 }} />
            <button onClick={() => setJournal((v) => !v)} style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 6, padding: '3px 10px', fontSize: 10.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', minHeight: 26 }}>
              journal {journal ? '▾' : '▸'}
            </button>
          </div>
        );
      })()}
      {/* 30-min status journal — window by window: who came back, who went
          dark, and the verdict, newest first (from the same observed logs). */}
      {journal && (() => {
        const W = 30 * 60000;
        const bounds = [];
        for (let b = Math.floor((keys[keys.length - 1] + BIN) / W) * W; b >= keys[0] - W && bounds.length < 10; b -= W) bounds.unshift(b);
        if (bounds.length < 2) return null;
        const darkSetAt = (b) => {
          const s = new Set();
          monitors.forEach((m) => {
            const d = logs[m.id];
            if (!d) return;
            let use = -1;
            (d.ticks || []).forEach((k, ti) => { const t0 = Date.parse(k.at); if (Number.isFinite(t0) && t0 <= b) use = ti; });
            if (use < 0) return;
            (d.devices || []).forEach((dev) => { if ((dev.offAt || []).includes(use)) s.add(`${m.id}|${dev.device}`); });
          });
          return s;
        };
        const sets = bounds.map(darkSetAt);
        const lines = [];
        for (let i = sets.length - 1; i >= 1; i--) {
          let back = 0, went = 0;
          sets[i].forEach((k) => { if (!sets[i - 1].has(k)) went += 1; });
          sets[i - 1].forEach((k) => { if (!sets[i].has(k)) back += 1; });
          lines.push({ t: new Date(bounds[i]), a: sets[i - 1].size, b: sets[i].size, back, went });
        }
        return (
          <div style={{ marginTop: 6, borderTop: '1px solid var(--hairline)', paddingTop: 6, maxHeight: 170, overflowY: 'auto' }}>
            {lines.map((r) => (
              <div key={+r.t} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 10.5, fontVariantNumeric: 'tabular-nums', color: 'var(--muted)', padding: '2.5px 0' }}>
                <b style={{ color: 'var(--text)', flexShrink: 0 }}>{hhmm(r.t)}</b>
                <span style={{ fontWeight: 800, flexShrink: 0, color: r.b < r.a ? STATUS_COLOR.fresh : r.b > r.a ? STATUS_COLOR.stale : 'var(--muted)' }}>
                  {r.b < r.a ? '▲ better' : r.b > r.a ? '▼ worse' : '► steady'}
                </span>
                <span>{r.back} came back · {r.went} went dark · dark {r.a}→{r.b}</span>
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

// 📈 The Rate river — every station's pace on one shared clock: one row per
// station, one cell per hour, colour depth = how busy (green = transactions,
// blue = scans), the day's avg/h on the right. The site's stacked total sits
// on top. Hourly numbers come from each monitor's day timeline (hour blocks).
function RhythmView({ monitors, apiBase, rows, onSelect, day = '' }) {
  const [data, setData] = useState({}); // monitor id -> hourly timeline
  const hrs = day ? `day:${day}` : 'start';
  useEffect(() => {
    let alive = true;
    monitors.forEach((m) => {
      if (data[m.id]) return;
      fetch(`${apiBase}/monitors/${encodeURIComponent(m.id)}/timeline?hours=${hrs}&interval=60`)
        .then((r) => r.json()).then((d) => { if (alive && d && d.devices) setData((p) => ({ ...p, [m.id]: d })); })
        .catch(() => {});
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once per monitor
  }, [monitors.map((m) => m.id).join(','), apiBase]);

  const loaded = monitors.filter((m) => data[m.id]);
  // Global hour axis across all monitors (anchors differ per monitor).
  const hourSet = new Set();
  loaded.forEach((m) => (data[m.id].buckets || []).forEach((b) => hourSet.add(b.slice(0, 13))));
  const hours = [...hourSet].sort().slice(-24);
  const hIdx = new Map(hours.map((h, i) => [h, i]));
  const stations = new Map(); // name -> {name, unit, mid, vals[]}
  loaded.forEach((m) => {
    const t = data[m.id]; const unit = unitFor(m);
    (t.devices || []).forEach((d) => {
      const stn = d.station || m.name;
      if (!stations.has(stn)) stations.set(stn, { name: stn, unit, mid: m.id, vals: hours.map(() => 0) });
      const e = stations.get(stn);
      (t.buckets || []).forEach((b, i) => { const gi = hIdx.get(b.slice(0, 13)); if (gi != null) e.vals[gi] += (d.counts || [])[i] || 0; });
    });
  });
  const list = [...stations.values()].map((s) => {
    const act = s.vals.filter((v) => v > 0);
    return { ...s, total: s.vals.reduce((a, b) => a + b, 0), avg: act.length ? Math.round(act.reduce((a, b) => a + b, 0) / act.length) : 0 };
  }).sort((a, b) => b.total - a.total);
  const hh = (h) => `${h.slice(11, 13)}:00`;
  const totMax = Math.max(1, ...hours.map((_, i) => list.reduce((a, s) => a + s.vals[i], 0)));
  if (!hours.length) {
    return <div style={{ ...card, fontSize: 12.5, color: 'var(--muted)' }}>{loaded.length < monitors.length ? 'Reading each monitor’s day timeline…' : 'No hourly data in the window yet.'}</div>;
  }
  return (
    <div>
      {/* site total, stacked per hour: green = transactions, blue = scans */}
      <div style={{ ...card, marginBottom: 10 }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.1, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 4 }}>Whole site · per hour</div>
        <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 56 }}>
          {hours.map((h, i) => {
            const tx = list.filter((s) => s.unit === 'transactions').reduce((a, s) => a + s.vals[i], 0);
            const sc = list.filter((s) => s.unit === 'scans').reduce((a, s) => a + s.vals[i], 0);
            return (
              <span key={h} title={`${hh(h)} · ${tx.toLocaleString('en-ZA')} txns · ${sc.toLocaleString('en-ZA')} scans`} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: 56, minWidth: 3 }}>
                {sc > 0 && <i style={{ display: 'block', height: Math.max(2, Math.round((sc / totMax) * 54)), background: '#2563eb', opacity: 0.85, borderRadius: '1px 1px 0 0' }} />}
                {tx > 0 && <i style={{ display: 'block', height: Math.max(2, Math.round((tx / totMax) * 54)), background: STATUS_COLOR.fresh, borderRadius: sc ? 0 : '1px 1px 0 0' }} />}
              </span>
            );
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
          <span>{hh(hours[0])}</span>
          <span><span style={{ color: STATUS_COLOR.fresh, fontWeight: 700 }}>transactions</span> · <span style={{ color: '#2563eb', fontWeight: 700 }}>scans</span></span>
          <span>{hh(hours[hours.length - 1])}</span>
        </div>
      </div>
      {/* the river — deeper colour = busier hour; tap a row for the station modal */}
      <div style={{ ...card }}>
        {list.map((s) => {
          const max = Math.max(1, ...s.vals);
          const row = (rows || []).find((r) => r.name === s.name || r.sn === s.name);
          return (
            <div key={s.name} role="button" tabIndex={0} onClick={() => onSelect && onSelect(row || { name: s.name, zone: zoneOf(s.name), monitor: s.name, mid: s.mid, sn: s.name === s.mid ? '' : s.name, unit: s.unit, status: 'fresh', lagMin: null, on: null, off: 0, txnH: null })}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.click(); }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7, cursor: 'pointer', minWidth: 0 }}>
              <span style={{ width: 130, flexShrink: 0, fontSize: 11.5, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
              <span style={{ display: 'flex', gap: 2, flex: 1, height: 18 }}>
                {s.vals.map((v, i) => (
                  <i key={i} title={`${hh(hours[i])} · ${v.toLocaleString('en-ZA')}/h`} style={{ flex: 1, borderRadius: 2, background: v ? (s.unit === 'scans' ? `rgba(37,99,235,${(0.12 + 0.88 * (v / max)).toFixed(2)})` : `rgba(22,163,74,${(0.12 + 0.88 * (v / max)).toFixed(2)})`) : 'var(--hairline)' }} />
                ))}
              </span>
              <span style={{ width: 84, textAlign: 'right', fontSize: 12, fontWeight: 800, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                {s.avg.toLocaleString('en-ZA')}<span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 9 }}> {s.unit === 'scans' ? 'scans' : 'txns'}/h avg</span>
              </span>
            </div>
          );
        })}
        {loaded.length < monitors.length && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Still reading {monitors.length - loaded.length} monitor{monitors.length - loaded.length === 1 ? '' : 's'}…</div>}
      </div>
    </div>
  );
}

// The board itself — presentational; give it the monitors array the page
// already holds (admin groups) or let SignalOps below fetch for Event Ops.
// 📶 Signal flow meter — the one-glance answer to "are we flowing?".
// Score = the AVERAGE of each station's own online share (every station
// counts equally — one dark gate can't hide behind fifty healthy bars).
// The target is settable (⚙ · default 95% = we accept 5% dark) and saved in
// Pulse per EVENT — one number for everyone, every phone and wall screen the
// same: green at/above target · amber within 5 points below · red under that.
const FLOW_BAND = 5;
function FlowMeter({ rows, suiteId }) {
  const [target, setTarget] = useState(95);
  const [edit, setEdit] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch(`/api/my/data-health/flow-target?suiteId=${encodeURIComponent(suiteId || '')}`)
      .then((r) => r.json()).then((d) => { if (alive && d && d.flowTargetPct) setTarget(d.flowTargetPct); })
      .catch(() => {});
    return () => { alive = false; };
  }, [suiteId]);
  const save = (v) => {
    const n = Math.max(50, Math.min(100, Math.round(Number(v) || 95)));
    setTarget(n); setEdit(false);
    fetch('/api/my/data-health/flow-target', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ suiteId: suiteId || '', pct: n }) }).catch(() => {});
  };
  const st = (rows || []).filter((s) => (s.on || 0) + (s.off || 0) > 0);
  if (!st.length) return null;
  const flow = st.reduce((a, s) => a + (s.on || 0) / ((s.on || 0) + (s.off || 0)), 0) / st.length * 100;
  const dark = st.reduce((a, s) => a + (s.off || 0), 0);
  const total = st.reduce((a, s) => a + (s.on || 0) + (s.off || 0), 0);
  const color = flow >= target ? STATUS_COLOR.fresh : flow >= target - FLOW_BAND ? STATUS_COLOR.warn : STATUS_COLOR.stale;
  const word = flow >= target ? 'Flowing' : flow >= target - FLOW_BAND ? 'Choppy' : 'Blocked';
  return (
    <div style={{ ...card, padding: '9px 13px', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 1.4, textTransform: 'uppercase', color: 'var(--muted)' }}>Signal flow</span>
        <span style={{ fontSize: 19, fontWeight: 850, fontVariantNumeric: 'tabular-nums', color }}>{flow.toFixed(1)}%</span>
        <span style={{ fontSize: 11.5, fontWeight: 800, color }}>● {word}</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
          {edit ? (
            <>
              target ≥ <input type="number" min={50} max={100} defaultValue={target} autoFocus aria-label="Flow target %"
                onKeyDown={(e) => { if (e.key === 'Enter') save(e.currentTarget.value); }}
                onBlur={(e) => save(e.currentTarget.value)}
                style={{ width: 54, padding: '3px 6px', border: '1px solid var(--hairline)', borderRadius: 6, background: 'var(--card)', color: 'var(--text)', fontSize: 12, fontFamily: 'inherit' }} /> %
            </>
          ) : (
            <>
              target ≥{target}% · {dark ? `${dark} of ${total} devices dark` : 'no devices dark'}
              <button onClick={() => setEdit(true)} title="Set the flow target" aria-label="Set the flow target"
                style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 6, minWidth: 26, minHeight: 24, cursor: 'pointer', fontSize: 12, padding: 0 }}>⚙</button>
            </>
          )}
        </span>
      </div>
      {/* the meter: fill vs the target tick */}
      <div style={{ position: 'relative', height: 10, borderRadius: 6, background: 'var(--hairline)', marginTop: 7, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, width: `${Math.max(2, Math.min(100, flow))}%`, background: color, borderRadius: 6, transition: 'width 300ms' }} />
        <div title={`target ${target}%`} style={{ position: 'absolute', top: -1, bottom: -1, left: `${target}%`, width: 2, background: 'var(--text)', opacity: 0.55 }} />
      </div>
      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>average online share across {st.length} stations · we allow {100 - target}% dark before it counts against flow · amber down to {target - FLOW_BAND}%</div>
    </div>
  );
}

// 📶 Stations view — every station's day in one scannable row: the online/offline
// strip (from Pulse's observed log — no live Looker cost) plus a LAZILY-loaded
// average-transactions line, so throughput can be read against connectivity per
// station. Grouped by zone; a closed monitor's wind-down goes grey (not a fault);
// online / offline / transactions / closed are each a toggle you can hide.
const TXN_COL = '#8b7cf6';
const CLOSED_COL = 'rgba(150,160,175,0.6)';

// One station row. The transaction line (st.txnPts) is derived from its monitor's
// timeline — fetched ONCE per monitor by the parent, not per station — so a big
// site doesn't fire dozens of live Looker reads at once.
function StationRow({ st, show, onSelect }) {
  const pts = st.txnPts;
  const H = 32, span = Math.max(1, st.tN - st.t0);
  const line = (show.txn && pts && pts.length > 1) ? (() => {
    const max = Math.max(...pts.map((p) => p.v), 0.0001);
    const xy = pts.map((p) => [((p.at - st.t0) / span) * 100, 100 - (p.v / max) * 82 - 9]);
    const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
    return { d, area: `${d} L${xy[xy.length - 1][0].toFixed(1)} 100 L${xy[0][0].toFixed(1)} 100 Z` };
  })() : null;
  // Over the green/red bars a white line reads best; with the bars hidden (txns is
  // the only layer on) it sits on the card, so use the text colour (dark / light).
  const txnStroke = (show.online || show.offline) ? '#ffffff' : 'var(--text)';

  const nowCol = st.closed ? 'var(--muted)' : st.nowPct >= 95 ? STATUS_COLOR.fresh : st.nowPct >= 85 ? STATUS_COLOR.warn : STATUS_COLOR.stale;
  const stripe = st.closed ? 'transparent' : st.nowPct < 90 ? STATUS_COLOR.stale : st.minPct < 95 ? STATUS_COLOR.warn : 'transparent';

  return (
    <div role="button" tabIndex={0} onClick={() => onSelect && onSelect(st.pick)}
      onKeyDown={(e) => { if (e.key === 'Enter') onSelect && onSelect(st.pick); }}
      style={{ display: 'grid', gridTemplateColumns: 'var(--sv-l) 1fr var(--sv-r)', gap: 10, alignItems: 'center', padding: '7px 10px', borderTop: '1px solid var(--hairline)', boxShadow: stripe !== 'transparent' ? `inset 3px 0 0 ${stripe}` : 'none', cursor: 'pointer' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 650, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {st.name}{st.closed && <span style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: 0.3, textTransform: 'uppercase', background: CLOSED_COL, color: 'var(--card)', borderRadius: 4, padding: '1px 5px', marginLeft: 6, verticalAlign: 'middle' }}>Closed</span>}
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{st.total} device{st.total === 1 ? '' : 's'}</div>
      </div>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', gap: 1, height: H }}>
        {st.series.map((c, i) => {
          const onPct = st.total ? (c.on / st.total) * 100 : 0;
          if (c.closed) return <span key={i} style={{ flex: 1, minWidth: 1.5, display: 'block', height: H, background: CLOSED_COL, borderRadius: '1.5px 1.5px 0 0', opacity: 0.5 }} />;
          return (
            <span key={i} style={{ flex: 1, minWidth: 1.5, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: H }}>
              {show.offline && c.off > 0 && <i style={{ display: 'block', height: `${100 - onPct}%`, background: STATUS_COLOR.stale, borderRadius: '1.5px 1.5px 0 0' }} />}
              {show.online && <i style={{ display: 'block', height: `${onPct}%`, background: STATUS_COLOR.fresh, borderRadius: (show.offline && c.off) ? 0 : '1.5px 1.5px 0 0' }} />}
            </span>
          );
        })}
        {line && (
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible', pointerEvents: 'none' }}>
            <path d={line.area} fill={txnStroke} opacity="0.1" />
            <path d={line.d} fill="none" stroke={txnStroke} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
          </svg>
        )}
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 13.5, fontWeight: 800, color: nowCol, fontVariantNumeric: 'tabular-nums' }}>{st.closed ? 'Closed' : st.nowPct + '%'}</div>
        <div style={{ fontSize: 10, color: 'var(--muted)' }}>low {st.minPct}%</div>
      </div>
    </div>
  );
}

function StationDayView({ monitors, apiBase, onSelect, day = '' }) {
  const [logs, setLogs] = useState({});
  const [tl, setTl] = useState({}); // mid -> { buckets:[iso], byStation:{name:counts[]} } — ONE timeline read per monitor
  const [q, setQ] = useState('');
  const [typeF, setTypeF] = useState(''); // station-type filter ('' = all): Bars / Vendors / Check-in…
  const [show, setShow] = useState({ online: true, offline: true, txn: true, closed: true });
  const toggle = (k) => setShow((s) => ({ ...s, [k]: !s[k] }));
  useEffect(() => {
    let alive = true;
    monitors.forEach((m) => {
      if (logs[m.id]) return;
      fetch(`${apiBase}/monitors/${encodeURIComponent(m.id)}/observed?hours=${day ? 'day:' + day : 'start'}`)
        .then((r) => r.json()).then((d) => { if (alive && d) setLogs((p) => ({ ...p, [m.id]: d })); }).catch(() => {});
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once per monitor
  }, [monitors.map((m) => m.id).join(','), apiBase]);
  // Transaction lines: one timeline read per MONITOR (it carries every device's
  // per-station counts), summed to per-station totals — not one read per station.
  useEffect(() => {
    let alive = true;
    monitors.forEach((m) => {
      if (tl[m.id]) return;
      fetch(`${apiBase}/monitors/${encodeURIComponent(m.id)}/timeline?hours=${day ? 'day:' + day : 'start'}&interval=30`)
        .then((r) => r.json()).then((d) => {
          if (!alive) return;
          const buckets = (d && d.buckets) || [];
          // A big fleet (e.g. bars) truncates the per-device read, so summing dev.counts loses the early
          // hours. The server sends stationTotals (a non-truncated per-station line) when that happens — prefer it.
          let byStation = (d && d.stationTotals && Object.keys(d.stationTotals).length) ? d.stationTotals : null;
          if (!byStation) {
            byStation = {};
            if (buckets.length) (d.devices || []).forEach((dev) => {
              const s = dev.station || '';
              if (!byStation[s]) byStation[s] = buckets.map(() => 0);
              (dev.counts || []).forEach((c, i) => { if (byStation[s][i] != null) byStation[s][i] += (c || 0); });
            });
          }
          setTl((p) => ({ ...p, [m.id]: { buckets, byStation } }));
        }).catch(() => { if (alive) setTl((p) => ({ ...p, [m.id]: { buckets: [], byStation: {} } })); });
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once per monitor
  }, [monitors.map((m) => m.id).join(','), apiBase]);

  const stations = [];
  for (const m of monitors) {
    const d = logs[m.id];
    if (!d || !d.configured || !(d.ticks || []).length) continue;
    const ticks = (d.ticks || []).slice(-120);
    const base = (d.ticks || []).length - ticks.length;
    const byStation = new Map();
    (d.devices || []).forEach((dev) => { const s = dev.station || ''; if (!byStation.has(s)) byStation.set(s, []); byStation.get(s).push(dev); });
    const closedMon = m.status === 'closed';
    const mtl = tl[m.id]; // this monitor's timeline (buckets + per-station counts), if loaded
    for (const [sn, devs] of byStation) {
      const total = devs.length;
      const offSets = devs.map((dev) => new Set(dev.offAt || []));
      const series = ticks.map((k, i) => { let off = 0; for (const s of offSets) if (s.has(base + i)) off += 1; return { at: k.at, off, on: Math.max(0, total - off) }; });
      // Closed monitor: grey only the trailing run where the station is FULLY dark
      // (no device sending). A single dead device isn't "closed" — the station is
      // still trading on its other devices, so it stays green/red, not grey.
      if (closedMon) { let last = -1; for (let i = 0; i < series.length; i++) if (series[i].on > 0) last = i; series.forEach((c, i) => { c.closed = i > last; }); }
      const openCk = series.filter((c) => !c.closed);
      const nowC = series[series.length - 1] || { on: 0, off: 0 };
      const nowPct = total ? Math.round((nowC.on / total) * 100) : 0;
      const minPct = openCk.length ? Math.round(Math.min(...openCk.map((c) => c.on / total)) * 100) : 100;
      const name = sn || m.name;
      const isClosed = closedMon && !!nowC.closed;
      const status = isClosed ? 'stale' : nowPct >= 95 ? 'fresh' : nowPct >= 85 ? 'warn' : 'stale';
      const txnPts = (mtl && mtl.byStation[sn]) ? mtl.buckets.map((b, i) => ({ at: Date.parse(b), v: mtl.byStation[sn][i] || 0 })).filter((x) => Number.isFinite(x.at)) : null;
      stations.push({
        mid: m.id, station: sn, name, zone: zoneOf(name), total, series, closed: isClosed, nowPct, minPct, txnPts,
        type: m.area || m.name || 'Other', unit: unitFor(m), t0: Date.parse(ticks[0].at), tN: Date.parse(ticks[ticks.length - 1].at),
        pick: { mid: m.id, sn, name, zone: zoneOf(name), monitor: m.name, unit: unitFor(m), on: nowC.on, off: nowC.off, txnH: null, lagMin: null, status },
      });
    }
  }

  const loading = monitors.some((m) => !logs[m.id]);
  // Station types (bars / vendors / check-in…) — from each monitor's area — as a
  // first-level filter, then the name box narrows within it.
  const types = [...new Set(stations.map((s) => s.type))].filter(Boolean).sort();
  const typeIcon = (t) => (/bar/i.test(t) ? '🍺' : /vendor|food/i.test(t) ? '🧾' : /check|gate/i.test(t) ? '🎟️' : '📍');
  const ql = q.trim().toLowerCase();
  let shown = stations;
  if (typeF) shown = shown.filter((s) => s.type === typeF);
  if (ql) shown = shown.filter((s) => s.name.toLowerCase().includes(ql) || s.zone.toLowerCase().includes(ql));
  if (!show.closed) shown = shown.filter((s) => !s.closed);

  const zones = new Map();
  for (const s of shown) { if (!zones.has(s.zone)) zones.set(s.zone, []); zones.get(s.zone).push(s); }
  const zoneList = [...zones.entries()].map(([k, list]) => {
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const openS = list.filter((s) => !s.closed);
    const on = openS.reduce((a, s) => a + (s.series[s.series.length - 1] || {}).on || 0, 0);
    const tot = openS.reduce((a, s) => a + s.total, 0);
    return { k, list, pct: tot ? Math.round((on / tot) * 100) : null, dev: list.reduce((a, s) => a + s.total, 0) };
  }).sort((a, b) => b.dev - a.dev);

  const allT = stations.filter((s) => Number.isFinite(s.t0));
  const t0 = allT.length ? Math.min(...allT.map((s) => s.t0)) : 0;
  const tN = allT.length ? Math.max(...allT.map((s) => s.tN)) : 0;
  const timeLbl = (f) => (t0 && tN ? new Date(t0 + (tN - t0) * f).toTimeString().slice(0, 5) : '');

  const legendChip = (k, label, col) => (
    <button onClick={() => toggle(k)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: `1px solid ${show[k] ? 'var(--hairline)' : 'transparent'}`, background: show[k] ? 'var(--card)' : 'transparent', color: show[k] ? 'var(--text)' : 'var(--muted)', borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: show[k] ? 1 : 0.5, textDecoration: show[k] ? 'none' : 'line-through' }}>
      {k === 'txn'
        ? <svg width="15" height="9" style={{ display: 'block' }}><path d="M0 7 L5 4 L9 6 L15 1" fill="none" stroke={col} strokeWidth="1.6" /></svg>
        : <span style={{ width: 10, height: 10, borderRadius: 3, background: col, display: 'inline-block' }} />}
      {label}
    </button>
  );

  const typeChip = (active, label, onClick, icon) => (
    <button onClick={onClick} style={{ border: `1px solid ${active ? 'var(--brand)' : 'var(--hairline)'}`, background: active ? 'rgba(var(--brand-rgb,10,132,255),0.08)' : 'var(--card)', color: active ? 'var(--brand)' : 'var(--text)', fontWeight: active ? 800 : 600, borderRadius: 999, padding: '5px 11px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', minHeight: 30 }}>{icon ? `${icon} ` : ''}{label}</button>
  );

  return (
    <div style={{ '--sv-l': '150px', '--sv-r': '74px' }}>
      {types.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          {typeChip(!typeF, `All · ${stations.length}`, () => setTypeF(''))}
          {types.map((t) => typeChip(typeF === t, `${t} · ${stations.filter((s) => s.type === t).length}`, () => setTypeF(t), typeIcon(t)))}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by station name…"
          style={{ flex: '1 1 160px', minWidth: 130, padding: '7px 11px', border: '1px solid var(--hairline)', borderRadius: 8, background: 'var(--card)', color: 'var(--text)', fontSize: 12.5, fontFamily: 'inherit', outline: 'none' }} />
        {legendChip('online', 'Online', STATUS_COLOR.fresh)}
        {legendChip('offline', 'Offline', STATUS_COLOR.stale)}
        {legendChip('txn', 'Avg txns', TXN_COL)}
        {legendChip('closed', 'Closed', CLOSED_COL)}
      </div>
      {loading && !stations.length && <div style={{ ...card, fontSize: 12, color: 'var(--muted)' }}>Reading each station's day…</div>}
      {!loading && !stations.length && <div style={{ ...card, fontSize: 12, color: 'var(--muted)' }}>No observed checks yet — the strips appear once Pulse's offline log has coverage.</div>}
      {!!shown.length && (
        <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'var(--sv-l) 1fr var(--sv-r)', gap: 10, padding: '9px 10px 6px', borderBottom: '1px solid var(--hairline)' }}>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--muted)' }}>Station</span>
            <span style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
              {[0, 0.33, 0.66, 1].map((f) => <span key={f}>{timeLbl(f)}</span>)}
            </span>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--muted)', textAlign: 'right' }}>Now</span>
          </div>
          {zoneList.map((z) => (
            <div key={z.k}>
              <div style={{ display: 'grid', gridTemplateColumns: 'var(--sv-l) 1fr var(--sv-r)', gap: 10, alignItems: 'center', padding: '9px 10px 4px' }}>
                <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase' }}>{z.k}</span>
                <span style={{ height: 1, background: 'var(--hairline)' }} />
                <span style={{ fontSize: 10.5, fontWeight: 700, textAlign: 'right', color: 'var(--muted)' }}>{z.pct == null ? 'closed' : z.pct + '%'}</span>
              </div>
              {z.list.map((st) => <StationRow key={st.mid + '|' + st.station} st={st} show={show} onSelect={onSelect} />)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══ 🗺️ Venue map — the site plan as a LIVE board ═══════════════════════════════
// Pins live where stations physically stand (dragged into place once, stored per
// event via server/venueMap.js). Healthy pins ripple; a dark pin flashes red; and
// when 2+ alarmed pins sit in the same corner, a red halo blooms over that AREA —
// connectivity failures are usually spatial (one mast/switch), so the map shows
// WHERE it's dying, not just which list rows. Tap a pin → the station deep-dive.
// View switcher: ONE pill on the chips row — tap it and the other views SLIDE OUT
// inline from the button (Apple segmented-control feel); pick one and it collapses
// back to just the active view. No drawer, no overlay — all on the same line.
const SB_VIEWS = [
  ['board', '🎛️', 'Board'],
  ['rhythm', '📈', 'Rhythm'],
  ['stations', '📶', 'Stations'],
  ['flow', '🌡️', 'Flow'],
  ['map', '🗺️', 'Map'],
  ['river', '🌊', 'River'],
  ['network', '🕸️', 'Network'],
];
function ViewPill({ view, setView, open, setOpen }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', border: `1px solid ${open ? 'var(--brand)' : 'var(--hairline)'}`, borderRadius: 999, background: 'var(--card)', padding: 3, maxWidth: '100%', overflowX: 'auto', scrollbarWidth: 'none' }}>
      {SB_VIEWS.map(([k, ic, name]) => {
        const act = view === k;
        const show = open || act;
        return (
          <button key={k}
            onClick={() => {
              if (!open) { setOpen(true); return; }
              if (!act) setView(k);
              setTimeout(() => setOpen(false), act ? 0 : 170); // let the highlight land, then fold
            }}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              background: act ? 'color-mix(in srgb, var(--brand) 13%, transparent)' : 'transparent',
              color: act ? 'var(--brand)' : 'var(--text)', fontWeight: act ? 800 : 600, fontSize: 12,
              borderRadius: 999, minHeight: 30, whiteSpace: 'nowrap', overflow: 'hidden',
              maxWidth: show ? 150 : 0, opacity: show ? 1 : 0, padding: show ? '4px 12px' : '4px 0',
              transition: 'max-width .3s cubic-bezier(.32,.72,.28,1), opacity .18s ease, padding .3s cubic-bezier(.32,.72,.28,1)',
            }}>
            <span style={{ fontSize: 14 }}>{ic}</span>{name}
            {act && !open && <span style={{ fontSize: 9, opacity: 0.6 }}>▸</span>}
          </button>
        );
      })}
    </div>
  );
}

const VM_CSS = `
@keyframes vmPing{0%{transform:translate(-50%,-50%) scale(.5);opacity:.5}100%{transform:translate(-50%,-50%) scale(2.8);opacity:0}}
@keyframes vmFlash{0%,100%{box-shadow:0 0 0 3px rgba(220,38,38,.15)}50%{box-shadow:0 0 0 9px rgba(220,38,38,.45)}}
@keyframes vmHalo{0%,100%{opacity:.5}50%{opacity:.95}}
@media (prefers-reduced-motion:reduce){.vm-anim{animation:none !important}}`;
function VenueMapView({ rows, apiBase, suiteId, onSelect }) {
  const scope = apiBase.indexOf('/api/admin') === 0 ? '/api/admin' : '/api/my';
  const [cfg, setCfg] = useState(null);
  const [pins, setPins] = useState({});
  const [edit, setEdit] = useState(false);
  const [placing, setPlacing] = useState(''); // station being placed by tapping the map
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState(''); // unplaced-tray search
  const [zf, setZf] = useState(''); // unplaced-tray zone filter
  const [mode, setMode] = useState('station'); // 'station' pins only | 'operator' fans every device around its pin
  const [ar, setAr] = useState(4 / 3); // the uploaded plan's aspect ratio — box fits the screen without scrolling
  const [satOpen, setSatOpen] = useState(false); const [satPos, setSatPos] = useState(''); const [satW, setSatW] = useState('800'); // 🛰️ fetch-satellite form
  const [devs, setDevs] = useState({}); // mid -> { list, onlineMin } — fetched lazily on first Operator toggle
  const boxRef = useRef(null);
  const dragRef = useRef(null); // { name, moved } during a pin drag
  useEffect(() => {
    let alive = true;
    if (!suiteId) { setCfg({ image: '', pins: {} }); return () => {}; }
    fetch(`${scope}/venue-map/${encodeURIComponent(suiteId)}`).then((r) => r.json())
      .then((d) => { if (alive && d && !d.error) { setCfg(d); setPins(d.pins || {}); } else if (alive) setCfg({ image: '', pins: {} }); })
      .catch(() => { if (alive) setCfg({ image: '', pins: {} }); });
    return () => { alive = false; };
  }, [scope, suiteId]);
  // one row per station name (a name can appear under one monitor only in practice)
  const sts = []; const seenN = new Set();
  for (const r of rows) { if (!r.name || seenN.has(r.name)) continue; seenN.add(r.name); sts.push(r); }
  // Operator mode: one timeline read per monitor (cached) gives every device its
  // station + operator + freshness — the dots fan out around their station's pin.
  useEffect(() => {
    if (mode !== 'operator') return undefined;
    let alive = true;
    [...new Set(sts.map((s) => s.mid))].filter((mid) => !devs[mid]).forEach((mid) => {
      fetch(`${apiBase}/monitors/${encodeURIComponent(mid)}/timeline?hours=start&interval=60`)
        .then((r) => r.json())
        .then((d) => { if (alive && d) setDevs((p) => ({ ...p, [mid]: { list: d.devices || [], onlineMin: d.onlineMin || 15 } })); })
        .catch(() => { if (alive) setDevs((p) => ({ ...p, [mid]: { list: [], onlineMin: 15 } })); });
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once per monitor on first toggle
  }, [mode]);
  const devsFor = (s) => {
    const pack = devs[s.mid]; if (!pack) return null;
    const isOnD = (v) => (v.lagMin != null ? v.lagMin <= pack.onlineMin : (v.active || []).slice(-2).some(Boolean));
    return pack.list.filter((v) => (v.station || '') === s.name).map((v) => ({ ...v, isOn: isOnD(v) }));
  };
  const placed = sts.filter((s) => pins[s.name]);
  const unplaced = sts.filter((s) => !pins[s.name]);
  const isAlarm = (s) => s.status === 'stale' || ((s.off || 0) > 0 && !(s.on || 0));
  const alarmed = placed.filter(isAlarm);
  // area halos: 2+ alarmed pins within ~20% of the map of each other = the AREA is dying
  const halos = []; const used = new Set();
  for (const a of alarmed) {
    if (used.has(a.name)) continue;
    const pa = pins[a.name];
    const near = alarmed.filter((b) => { const pb = pins[b.name]; return Math.hypot(pb.x - pa.x, pb.y - pa.y) < 0.2; });
    if (near.length >= 2) { near.forEach((b) => used.add(b.name)); halos.push({ x: near.reduce((t, b) => t + pins[b.name].x, 0) / near.length, y: near.reduce((t, b) => t + pins[b.name].y, 0) / near.length, n: near.length }); }
  }
  const frac = (e) => { const b = boxRef.current.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), y: Math.min(1, Math.max(0, (e.clientY - b.top) / b.height)) }; };
  const savePins = (next) => {
    setSaving(true);
    fetch(`${scope}/venue-map/${encodeURIComponent(suiteId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pins: next }) })
      .then((r) => r.json()).then((d) => { if (d && !d.error) { setCfg(d); setPins(d.pins || {}); setDirty(false); } })
      .finally(() => setSaving(false));
  };
  const saveImage = (dataUrl) => {
    setSaving(true);
    return fetch(`${scope}/venue-map/${encodeURIComponent(suiteId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: dataUrl }) })
      .then((r) => r.json()).then((d) => { if (d && d.error) alert(d.error); else if (d) setCfg(d); })
      .finally(() => setSaving(false));
  };
  // 🛰️ Satellite: fetch real aerial imagery for typed coordinates (Esri World Imagery —
  // licensed for exactly this, unlike Google screenshots) and save it as the venue map.
  // Attribution is baked into the image itself so it travels with the map.
  const fetchSatellite = async () => {
    const mm = /(-?\d{1,3}\.\d+)[,\s]+(-?\d{1,3}\.\d+)/.exec(String(satPos));
    if (!mm) { alert('Paste coordinates like 45.0866, 7.6560 (a Google Maps link with them in it works too)'); return; }
    const lat = +mm[1], lon = +mm[2], span = Number(satW) || 800;
    const R = 20037508.34, x = (lon * R) / 180, y = (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180)) * (R / 180);
    const hw = span / 2, hh = hw * 0.75;
    const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${x - hw},${y - hh},${x + hw},${y + hh}&bboxSR=3857&imageSR=3857&size=1600,1200&format=jpg&f=image`;
    setSaving(true);
    try {
      const blob = await (await fetch(url)).blob();
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      const g2 = c.getContext('2d'); g2.drawImage(bmp, 0, 0);
      g2.font = '600 20px sans-serif'; g2.textAlign = 'right'; g2.lineWidth = 3;
      g2.strokeStyle = 'rgba(0,0,0,.55)'; g2.strokeText('Imagery © Esri & partners', c.width - 12, c.height - 12);
      g2.fillStyle = 'rgba(255,255,255,.9)'; g2.fillText('Imagery © Esri & partners', c.width - 12, c.height - 12);
      await saveImage(c.toDataURL('image/jpeg', 0.85));
      setSatOpen(false);
    } catch { alert('Could not fetch satellite imagery — check the coordinates and try again.'); setSaving(false); }
  };
  const uploadMap = (file) => {
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1600 / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL('image/jpeg', 0.82);
      setSaving(true);
      fetch(`${scope}/venue-map/${encodeURIComponent(suiteId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: dataUrl }) })
        .then((r) => r.json()).then((d) => { if (d && d.error) alert(d.error); else if (d) setCfg(d); })
        .finally(() => setSaving(false));
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  };
  const onMapPointerDown = (e) => {
    if (!edit || !placing) return;
    const p = frac(e);
    setPins((prev) => ({ ...prev, [placing]: p })); setPlacing(''); setDirty(true);
  };
  const onPinPointerDown = (name) => (e) => {
    if (!edit) return;
    e.stopPropagation(); e.preventDefault();
    dragRef.current = { name, moved: false };
    const move = (ev) => { dragRef.current.moved = true; const p = frac(ev); setPins((prev) => ({ ...prev, [name]: p })); setDirty(true); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); dragRef.current = null; };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const unpin = (name) => { setPins((prev) => { const n = { ...prev }; delete n[name]; return n; }); setDirty(true); };
  if (!cfg) return <div style={{ ...card, fontSize: 12, color: 'var(--muted)' }}>Loading the venue map…</div>;
  const btn = (act) => ({ border: `1px solid ${act ? 'var(--brand)' : 'var(--hairline)'}`, background: 'var(--card)', color: act ? 'var(--brand)' : 'var(--text)', borderRadius: 8, padding: '5px 11px', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', minHeight: 30 });
  const pinCol = (s) => (isAlarm(s) ? STATUS_COLOR.stale : (s.off || 0) > 0 ? STATUS_COLOR.warn : STATUS_COLOR.fresh);
  return (
    <div>
      <style>{VM_CSS}</style>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 11.5, color: 'var(--muted)', flex: 1, minWidth: 160 }}>
          {edit ? (placing ? <>Tap the map to place <b>{placing}</b></> : 'Drag pins to move · tap ✕ to unpin · tap a station below to place it')
            : <>Live site plan — tap a pin for its devices &amp; operators. <b style={{ color: STATUS_COLOR.stale }}>{alarmed.length ? `${alarmed.length} station${alarmed.length > 1 ? 's' : ''} dark` : ''}</b></>}
        </span>
        {!edit && <>
          <button style={btn(mode === 'station')} onClick={() => setMode('station')}>📍 Stations</button>
          <button style={btn(mode === 'operator')} onClick={() => setMode('operator')}>🧑 Operators</button>
        </>}
        {edit && <label style={{ ...btn(false), display: 'inline-flex', alignItems: 'center' }}>{cfg.image ? 'Replace map' : '⬆ Upload site plan'}<input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => uploadMap(e.target.files && e.target.files[0])} /></label>}
        {edit && <button style={btn(satOpen)} onClick={() => setSatOpen(!satOpen)}>🛰️ Satellite</button>}
        {edit && cfg.image && <button style={btn(false)} onClick={() => { setSaving(true); fetch(`${scope}/venue-map/${encodeURIComponent(suiteId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: '' }) }).then((r) => r.json()).then((d) => d && !d.error && setCfg(d)).finally(() => setSaving(false)); }}>Remove map</button>}
        {edit && dirty && <button style={btn(true)} disabled={saving} onClick={() => savePins(pins)}>{saving ? 'Saving…' : '💾 Save pins'}</button>}
        <button style={btn(edit)} onClick={() => { if (edit && dirty) savePins(pins); setEdit(!edit); setPlacing(''); }}>{edit ? '✓ Done' : '✏️ Edit pins'}</button>
      </div>
      {edit && satOpen && (
        <div style={{ ...card, marginBottom: 8, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--muted)', width: '100%' }}>🛰️ Real aerial imagery as the map (Esri, licence-safe)</span>
          <input value={satPos} onChange={(e) => setSatPos(e.target.value)} placeholder="45.0866, 7.6560 — or paste a maps link" inputMode="text"
            style={{ flex: '1 1 220px', border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', minHeight: 36 }} />
          <select value={satW} onChange={(e) => setSatW(e.target.value)} style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 8, padding: '8px 8px', fontSize: 12, fontFamily: 'inherit', minHeight: 36 }}>
            <option value="400">~400 m wide</option><option value="800">~800 m wide</option><option value="1200">~1.2 km wide</option><option value="2000">~2 km wide</option>
          </select>
          <button style={btn(true)} disabled={saving} onClick={fetchSatellite}>{saving ? 'Fetching…' : 'Fetch & set as map'}</button>
        </div>
      )}
      {/* The box keeps the image's exact aspect (pins are % of it) but must FIT the
          viewport with no scrolling — so when the height would overflow, the box
          narrows itself instead: width = min(100%, available-height × aspect). */}
      <div ref={boxRef} onPointerDown={onMapPointerDown}
        style={{ position: 'relative', width: `min(100%, calc((100dvh - 250px) * ${ar}))`, aspectRatio: String(ar), margin: '0 auto', borderRadius: 12, overflow: 'hidden', border: '1px solid var(--hairline)', background: 'var(--card)', touchAction: edit ? 'none' : 'auto', cursor: edit && placing ? 'crosshair' : 'default' }}>
        {cfg.image
          ? <img src={cfg.image} alt="venue site plan" onLoad={(e) => { const im = e.target; if (im.naturalWidth && im.naturalHeight) setAr(im.naturalWidth / im.naturalHeight); }} style={{ display: 'block', width: '100%', height: '100%', userSelect: 'none', pointerEvents: 'none' }} />
          : <div style={{ width: '100%', height: '100%', background: 'repeating-linear-gradient(0deg, transparent 0 39px, var(--hairline) 39px 40px), repeating-linear-gradient(90deg, transparent 0 39px, var(--hairline) 39px 40px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
              <span style={{ fontSize: 10.5, color: 'var(--muted)', padding: 8 }}>No site plan yet — ✏️ Edit pins → ⬆ Upload site plan (pins work on the blank grid too)</span>
            </div>}
        {halos.map((h2, i) => (
          <div key={i} className="vm-anim" style={{ position: 'absolute', left: `${h2.x * 100}%`, top: `${h2.y * 100}%`, width: 130 + h2.n * 30, height: 130 + h2.n * 30, transform: 'translate(-50%,-50%)', borderRadius: '50%', background: 'radial-gradient(circle, rgba(220,38,38,.30) 0%, transparent 70%)', animation: 'vmHalo 1.6s ease-in-out infinite', pointerEvents: 'none' }}>
            <span style={{ position: 'absolute', top: 6, left: '50%', transform: 'translateX(-50%)', whiteSpace: 'nowrap', fontSize: 9.5, fontWeight: 800, color: '#ef4444', textShadow: '0 1px 2px rgba(0,0,0,.5)' }}>⚠ AREA · {h2.n} stations</span>
          </div>
        ))}
        {mode === 'operator' && !edit && placed.map((s) => {
          const list = devsFor(s); const p = pins[s.name];
          if (!list) return <span key={'d' + s.name} style={{ position: 'absolute', left: `${p.x * 100}%`, top: `calc(${p.y * 100}% + 14px)`, transform: 'translateX(-50%)', fontSize: 8.5, color: 'var(--muted)' }}>…</span>;
          // A tidy dot GRID under the pin (10 per row) — the ring fan collided on dense
          // stations. No per-dot names (they're in the tap-through deep-dive); one
          // "n dark" label per station instead of a red name pile-up.
          const COLS = 10; const dark = list.filter((v) => !v.isOn).length;
          const rowsN = Math.ceil(list.length / COLS);
          return [
            ...list.map((v, i) => {
              const cols = Math.min(COLS, list.length - Math.floor(i / COLS) * COLS);
              const dx = ((i % COLS) - (cols - 1) / 2) * 11, dy = 18 + Math.floor(i / COLS) * 11;
              const dc = v.isOn ? STATUS_COLOR.fresh : STATUS_COLOR.stale;
              return (
                <span key={s.name + v.device} onClick={(e) => { e.stopPropagation(); onSelect(s); }} title={`${v.operator || v.device} · ${v.isOn ? 'online' : 'dark'}`}
                  className={v.isOn ? '' : 'vm-anim'}
                  style={{ position: 'absolute', left: `calc(${p.x * 100}% + ${dx}px)`, top: `calc(${p.y * 100}% + ${dy}px)`, transform: 'translate(-50%,-50%)', width: 8, height: 8, borderRadius: '50%', background: dc, border: '1.5px solid var(--card)', boxShadow: `0 0 4px ${dc}`, cursor: 'pointer', animation: v.isOn ? 'none' : 'vmFlash 0.9s ease-in-out infinite' }} />
              );
            }),
            dark > 0 && <i key={s.name + '·dark'} style={{ position: 'absolute', left: `${p.x * 100}%`, top: `calc(${p.y * 100}% + ${18 + rowsN * 11}px)`, transform: 'translateX(-50%)', whiteSpace: 'nowrap', fontSize: 8.5, fontStyle: 'normal', fontWeight: 800, color: STATUS_COLOR.stale, textShadow: '0 1px 3px var(--card)' }}>{dark} dark</i>,
          ];
        })}
        {placed.map((s) => {
          const p = pins[s.name]; const col = pinCol(s); const alarm = isAlarm(s);
          return (
            <div key={s.name} onPointerDown={onPinPointerDown(s.name)}
              onClick={(e) => { e.stopPropagation(); if (edit) return; onSelect(s); }}
              style={{ position: 'absolute', left: `${p.x * 100}%`, top: `${p.y * 100}%`, transform: 'translate(-50%,-50%)', width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: edit ? 'grab' : 'pointer' }}>
              {!alarm && <span className="vm-anim" style={{ position: 'absolute', left: '50%', top: '50%', width: 26, height: 26, borderRadius: '50%', border: `1.5px solid ${col}`, animation: 'vmPing 2.6s ease-out infinite', animationDelay: `${(s.name.length % 7) * 0.35}s` }} />}
              <span className={alarm ? 'vm-anim' : ''} style={{ width: 13, height: 13, borderRadius: '50%', background: col, border: '2px solid var(--card)', boxShadow: `0 0 8px ${col}`, animation: alarm ? 'vmFlash 0.9s ease-in-out infinite' : 'none' }} />
              <span style={{ position: 'absolute', top: -13, left: '50%', transform: 'translateX(-50%)', whiteSpace: 'nowrap', fontSize: 9.5, fontWeight: 700, color: 'var(--text)', textShadow: '0 1px 3px var(--card), 0 -1px 3px var(--card)' }}>{s.name}</span>
              <span style={{ position: 'absolute', bottom: -11, left: '50%', transform: 'translateX(-50%)', fontSize: 9, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: col, textShadow: '0 1px 3px var(--card)' }}>{(s.on || 0)}/{(s.on || 0) + (s.off || 0)}</span>
              {edit && <button onClick={(e) => { e.stopPropagation(); unpin(s.name); }} onPointerDown={(e) => e.stopPropagation()} style={{ position: 'absolute', top: -4, right: -6, width: 18, height: 18, borderRadius: '50%', border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 9, lineHeight: '15px', padding: 0, cursor: 'pointer' }}>✕</button>}
            </div>
          );
        })}
      </div>
      {edit && !!unplaced.length && (() => {
        const zonesU = [...new Set(unplaced.map((s) => s.zone))].sort();
        const list = unplaced
          .filter((s) => (!zf || s.zone === zf) && (!q || s.name.toLowerCase().includes(q.toLowerCase())))
          .sort((a, b) => a.name.localeCompare(b.name));
        return (
          <div style={{ ...card, marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--muted)', flex: 1, minWidth: 150 }}>Unplaced · {list.length}/{unplaced.length} · tap one, then tap the map</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 find a station…" inputMode="search"
              style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 8, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit', minHeight: 32, width: 160 }} />
            {zonesU.length > 1 && (
              <span style={{ display: 'flex', gap: 5, flexWrap: 'wrap', width: '100%' }}>
                <button style={btn(!zf)} onClick={() => setZf('')}>All zones</button>
                {zonesU.map((z) => <button key={z} style={btn(zf === z)} onClick={() => setZf(zf === z ? '' : z)}>{z} · {unplaced.filter((s) => s.zone === z).length}</button>)}
              </span>
            )}
            {list.map((s) => <button key={s.name} style={btn(placing === s.name)} onClick={() => setPlacing(placing === s.name ? '' : s.name)}>{s.name}</button>)}
            {!list.length && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>No station matches “{q}”{zf ? ` in ${zf}` : ''}.</span>}
          </div>
        );
      })()}
      {!edit && !!alarmed.length && (
        <div style={{ ...card, marginTop: 8, borderLeft: `4px solid ${STATUS_COLOR.stale}`, fontSize: 11.5, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {alarmed.map((s) => <button key={s.name} onClick={() => onSelect(s)} style={{ border: 'none', background: 'none', color: 'var(--text)', fontSize: 11.5, cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}><b style={{ color: STATUS_COLOR.stale }}>▲ {s.name}</b> · {(s.on || 0)}/{(s.on || 0) + (s.off || 0)} sending</button>)}
        </div>
      )}
      {!edit && !!unplaced.length && <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6 }}>{unplaced.length} station{unplaced.length > 1 ? 's' : ''} not on the map yet — ✏️ Edit pins to place: {unplaced.slice(0, 6).map((s) => s.name).join(' · ')}{unplaced.length > 6 ? ' …' : ''}</div>}
    </div>
  );
}

// ═══ 🌊 Flow river — transactions as moving particles ═══════════════════════════
// Every station streams sparks into the Pulse core; stream density IS throughput
// (txns/h from the same roster snapshots the board uses — no extra Looker reads).
// A dark station's stream stutters red and its node flashes. Tap a node → deep-dive.
// Tap a station node → the river DRILLS IN: that station's devices each become a
// stream (labelled by operator), so you see which barman's device is pouring and
// which is dry. ← back returns to the all-stations river.
function FlowRiverView({ rows, apiBase, onSelect }) {
  const cvRef = useRef(null);
  const nodesRef = useRef([]);
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const [focus, setFocus] = useState(null); // { s, nodes: [...] } = device-level river for one station
  const focusRef = useRef(null); focusRef.current = focus;
  const [loading, setLoading] = useState('');
  const drill = (s) => {
    setLoading(s.name);
    fetch(`${apiBase}/monitors/${encodeURIComponent(s.mid)}/timeline?hours=start&interval=30&station=${encodeURIComponent(s.sn || '')}`)
      .then((r) => r.json()).then((d) => {
        const devs = (d && d.devices) || [];
        const onlineMin = (d && d.onlineMin) || 15;
        const isOn = (v) => (v.lagMin != null ? v.lagMin <= onlineMin : (v.active || []).slice(-2).some(Boolean));
        const nodes = devs.map((v) => {
          const c = v.counts || [];
          const rate = (c[c.length - 1] || 0) + (c[c.length - 2] || 0); // last hour, txns
          return { key: v.device, label: v.operator || v.device, sub: `${v.operator ? v.device + ' · ' : ''}${rate.toLocaleString('en-ZA')}/h`, rate, alarm: !isOn(v), warn: false };
        }).sort((a, b) => b.rate - a.rate).slice(0, 40);
        setFocus({ s, nodes });
      }).catch(() => {}).finally(() => setLoading(''));
  };
  useEffect(() => {
    const cv = cvRef.current; if (!cv) return () => {};
    const ctx = cv.getContext('2d');
    const css = (n, f) => (getComputedStyle(cv).getPropertyValue(n) || '').trim() || f; // read from the canvas: Pulse sets theme vars below the root, so documentElement misses dark mode
    const C = { bg: css('--card', '#101418'), text: css('--text', '#e8eef6'), muted: css('--muted', '#8497ad'), line: css('--hairline', 'rgba(140,160,190,.2)'), brand: css('--brand', '#ff385c') };
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const parts = []; let raf = 0; let last = 0; let t = 0;
    const isAlarm = (s) => s.status === 'stale' || ((s.off || 0) > 0 && !(s.on || 0));
    const layout = () => {
      const f = focusRef.current;
      let list;
      if (f) list = f.nodes;
      else {
        const sts = []; const seenN = new Set();
        for (const r of rowsRef.current) { if (!r.name || seenN.has(r.name)) continue; seenN.add(r.name); sts.push(r); }
        sts.sort((a, b) => (b.txnH || 0) - (a.txnH || 0));
        const top = sts.slice(0, 22);
        for (const s of sts.slice(22)) if (s.status === 'stale') top.push(s);
        list = top.map((s) => ({ key: s.name, label: s.name, sub: `${s.on || 0}/${(s.on || 0) + (s.off || 0)} · ${(s.txnH || 0).toLocaleString('en-ZA')}/h`, rate: s.txnH || 0, alarm: isAlarm(s), warn: (s.off || 0) > 0, s }));
      }
      const w = cv.clientWidth || 720;
      const hgt = Math.max(340, list.length * 30 + 70);
      if (cv.width !== w * 2 || cv.height !== hgt * 2) { cv.width = w * 2; cv.height = hgt * 2; cv.style.height = hgt + 'px'; ctx.setTransform(2, 0, 0, 2, 0, 0); }
      const x0 = Math.min(190, Math.max(120, w * 0.32));
      nodesRef.current = list.map((n, i) => ({ ...n, x: x0, y: 44 + (hgt - 80) * (list.length === 1 ? 0.5 : i / (list.length - 1)) }));
      return { w, hgt, cx: w - 84, cy: hgt / 2, coreLabel: f ? (f.s.name.length > 11 ? f.s.name.slice(0, 10) + '…' : f.s.name) : 'PULSE' };
    };
    const frame = (ts) => {
      const dt = Math.min(0.05, (ts - last) / 1000 || 0.016); last = ts; t += dt;
      const { w, hgt, cx, cy, coreLabel } = layout();
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, hgt);
      const nodes = nodesRef.current;
      const maxTx = Math.max(1, ...nodes.map((n) => n.rate));
      const totTx = nodes.reduce((a, n) => a + n.rate, 0);
      const rr = 30 + 2.5 * Math.sin(t * 2.2);
      const g = ctx.createRadialGradient(cx, cy, 4, cx, cy, rr + 22);
      g.addColorStop(0, C.brand); g.addColorStop(1, 'transparent');
      ctx.globalAlpha = 0.35; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, rr + 22, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
      ctx.fillStyle = C.bg; ctx.strokeStyle = C.brand; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, rr, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = C.text; ctx.font = '800 11px -apple-system,sans-serif'; ctx.textAlign = 'center'; ctx.fillText(coreLabel, cx, cy);
      ctx.fillStyle = C.muted; ctx.font = '9px ui-monospace,monospace'; ctx.fillText(totTx.toLocaleString('en-ZA') + '/h', cx, cy + 13);
      for (const n of nodes) {
        const col = n.alarm ? STATUS_COLOR.stale : n.warn ? STATUS_COLOR.warn : STATUS_COLOR.fresh;
        ctx.strokeStyle = C.line; ctx.globalAlpha = 0.35; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.bezierCurveTo((n.x + cx) / 2, n.y, (n.x + cx) / 2, cy, cx - rr - 3, cy); ctx.stroke(); ctx.globalAlpha = 1;
        if (n.alarm) { const fl = (Math.sin(t * 7 + n.y) + 1) / 2; ctx.strokeStyle = `rgba(220,38,38,${0.3 + 0.55 * fl})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(n.x, n.y, 8 + 5 * fl, 0, 7); ctx.stroke(); }
        ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 7;
        ctx.beginPath(); ctx.arc(n.x, n.y, 4, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
        ctx.fillStyle = C.text; ctx.font = '600 10.5px -apple-system,sans-serif'; ctx.textAlign = 'right';
        ctx.fillText(n.label.length > 20 ? n.label.slice(0, 19) + '…' : n.label, n.x - 12, n.y + 3.5);
        ctx.fillStyle = n.alarm ? STATUS_COLOR.stale : C.muted; ctx.font = '9px ui-monospace,monospace';
        ctx.fillText(n.sub, n.x - 12, n.y + 14);
        const stutter = n.alarm && Math.sin(t * 3 + n.y) > -0.2;
        const spawn = reduced ? 0 : dt * (1.5 + 11 * (n.rate / maxTx)) * (stutter ? 0.12 : 1) * (n.alarm && !n.rate ? 0 : 1);
        if (Math.random() < spawn) parts.push({ p: 0, sp: 0.28 + Math.random() * 0.3, y0: n.y, x0: n.x, jit: (Math.random() - 0.5) * 12, col: n.alarm ? STATUS_COLOR.stale : TXN_COL });
      }
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]; p.p += dt * p.sp;
        if (p.p >= 1) { parts.splice(i, 1); continue; }
        const u = p.p, m = 1 - u, mx = (p.x0 + cx) / 2;
        const px = m * m * m * p.x0 + 3 * m * m * u * mx + 3 * m * u * u * mx + u * u * u * (cx - rr - 3);
        const py = m * m * m * p.y0 + 3 * m * m * u * p.y0 + 3 * m * u * u * cy + u * u * u * cy + p.jit * Math.sin(u * Math.PI);
        ctx.globalAlpha = 0.3 + 0.7 * Math.sin(u * Math.PI); ctx.fillStyle = p.col; ctx.fillRect(px, py, 2.2, 2.2); ctx.globalAlpha = 1;
      }
      if (parts.length > 2200) parts.splice(0, parts.length - 2200);
      if (!reduced) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);
  const pick = (e) => {
    const b = cvRef.current.getBoundingClientRect();
    const x = e.clientX - b.left, y = e.clientY - b.top;
    let best = null, bd = 26;
    for (const n of nodesRef.current) { const d = Math.hypot(x - n.x, y - n.y); if (d < bd) { bd = d; best = n; } }
    if (!best) return;
    if (focus) onSelect(focus.s);            // device river → the station deep-dive (that device's strip is inside)
    else if (best.s) drill(best.s);          // station river → drill into its devices
  };
  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '8px 12px', borderBottom: '1px solid var(--hairline)' }}>
        {focus ? <>
          <button onClick={() => setFocus(null)} style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 8, padding: '4px 11px', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', minHeight: 30 }}>← All stations</button>
          <b style={{ fontSize: 12.5 }}>{focus.s.name}</b>
          <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{focus.nodes.length} devices · each stream is one device (operator named)</span>
          <span style={{ flex: 1 }} />
          <button onClick={() => onSelect(focus.s)} style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 8, padding: '4px 11px', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', minHeight: 30 }}>📋 Details</button>
        </> : <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{loading ? `Opening ${loading}'s devices…` : 'Tap a station to open its devices as their own river'}</span>}
      </div>
      <canvas ref={cvRef} onClick={pick} style={{ display: 'block', width: '100%' }} />
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', padding: '7px 12px', borderTop: '1px solid var(--hairline)', fontSize: 10.5, color: 'var(--muted)' }}>
        <span>each spark = transactions · stream density = throughput{focus ? ' (per device, last hour)' : ''}</span>
        <span style={{ color: STATUS_COLOR.stale }}>red stutter = dark</span>
      </div>
    </div>
  );
}

// ═══ 🕸️ Network (Cascade) — the granular event as a river delta ═════════════════
// Four tiers, left → right: every OPERATOR pours into their STATION, stations merge
// into their monitor family (TYPE), types merge into Pulse. Sparks travel the whole
// chain, so a blockage is visible at the exact tier it lives in. Per station the
// busiest operators are named (dark ones always shown); the rest fold into "+n".
const TYPE_COLS = ['#ff8fa3', '#b39ddb', '#80cbc4', '#ffd166', '#8b7cf6'];
function CascadeView({ rows, apiBase, onSelect }) {
  const cvRef = useRef(null);
  const hitRef = useRef([]); // clickable node positions → station rows
  const [packs, setPacks] = useState({}); // mid -> { list, onlineMin }
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const packsRef = useRef(packs); packsRef.current = packs;
  useEffect(() => {
    let alive = true;
    [...new Set(rows.map((r) => r.mid))].forEach((mid) => {
      fetch(`${apiBase}/monitors/${encodeURIComponent(mid)}/timeline?hours=start&interval=30`)
        .then((r) => r.json())
        .then((d) => { if (alive && d) setPacks((p) => ({ ...p, [mid]: { list: d.devices || [], onlineMin: d.onlineMin || 15 } })); })
        .catch(() => { if (alive) setPacks((p) => ({ ...p, [mid]: { list: [], onlineMin: 15 } })); });
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one read per monitor at mount
  }, []);
  useEffect(() => {
    const cv = cvRef.current; if (!cv) return () => {};
    const ctx = cv.getContext('2d');
    const css = (n, f) => (getComputedStyle(cv).getPropertyValue(n) || '').trim() || f; // read from the canvas: Pulse sets theme vars below the root, so documentElement misses dark mode
    const C = { bg: css('--card', '#101418'), text: css('--text', '#e8eef6'), muted: css('--muted', '#8497ad'), line: css('--hairline', 'rgba(140,160,190,.2)'), brand: css('--brand', '#ff385c') };
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const parts = []; let raf = 0; let last = 0; let t = 0;
    const build = () => {
      // stations (deduped), grouped by monitor family so the tiers nest cleanly
      const sts = []; const seenN = new Set();
      for (const r of rowsRef.current) { if (!r.name || seenN.has(r.name)) continue; seenN.add(r.name); sts.push(r); }
      const types = new Map();
      sts.forEach((s) => { if (!types.has(s.monitor)) types.set(s.monitor, []); types.get(s.monitor).push(s); });
      const model = [];
      let ty = 0;
      for (const [type, list] of types) {
        const col = TYPE_COLS[ty++ % TYPE_COLS.length];
        list.sort((a, b) => (b.txnH || 0) - (a.txnH || 0));
        for (const s of list) {
          const pack = packsRef.current[s.mid];
          let ops = null;
          if (pack) {
            const isOnD = (v) => (v.lagMin != null ? v.lagMin <= pack.onlineMin : (v.active || []).slice(-2).some(Boolean));
            const all = pack.list.filter((v) => (v.station || '') === s.name)
              .map((v) => { const c = v.counts || []; return { name: v.operator || v.device, rate: (c[c.length - 1] || 0) + (c[c.length - 2] || 0), on: isOnD(v) }; })
              .sort((a, b) => b.rate - a.rate);
            const named = all.filter((o, i) => i < 5 || !o.on).slice(0, 9);
            const rest = all.filter((o) => !named.includes(o));
            ops = named;
            if (rest.length) ops = [...named, { name: `+${rest.length} more`, rate: rest.reduce((a2, o) => a2 + o.rate, 0), on: true, agg: true }];
          }
          model.push({ s, type, col, ops });
        }
      }
      return model;
    };
    const frame = (ts) => {
      const dt = Math.min(0.05, (ts - last) / 1000 || 0.016); last = ts; t += dt;
      const model = build();
      const w = cv.clientWidth || 720;
      const opRows = model.reduce((a, m) => a + (m.ops ? m.ops.length : 1), 0);
      const hgt = Math.max(380, opRows * 17 + model.length * 8 + 90);
      if (cv.width !== w * 2 || cv.height !== hgt * 2) { cv.width = w * 2; cv.height = hgt * 2; cv.style.height = hgt + 'px'; ctx.setTransform(2, 0, 0, 2, 0, 0); }
      const xO = Math.min(210, Math.max(130, w * 0.3)), xS = w * 0.52, xT = w * 0.74, xC = w - 66, cy = hgt / 2;
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, hgt);
      ctx.fillStyle = C.muted; ctx.font = '700 8.5px ui-monospace,monospace'; ctx.textAlign = 'left';
      ctx.fillText('OPERATORS', 12, 22); ctx.fillText('STATIONS', xS - 20, 22); ctx.fillText('TYPES', xT - 10, 22); ctx.fillText('PULSE', xC - 16, 22);
      // vertical layout
      let y = 44; const hits = [];
      const tyPos = new Map();
      for (const m of model) {
        const n = (m.ops ? m.ops.length : 1);
        m.opY = []; for (let i = 0; i < n; i++) { m.opY.push(y); y += 17; }
        m.y = m.opY.reduce((a2, b) => a2 + b, 0) / n; y += 8;
        if (!tyPos.has(m.type)) tyPos.set(m.type, []);
        tyPos.get(m.type).push(m.y);
      }
      const maxRate = Math.max(1, ...model.map((m) => m.s.txnH || 0));
      let totTx = 0;
      for (const m of model) {
        const tyY = tyPos.get(m.type).reduce((a2, b) => a2 + b, 0) / tyPos.get(m.type).length;
        const alarm = m.s.status === 'stale' || ((m.s.off || 0) > 0 && !(m.s.on || 0));
        totTx += m.s.txnH || 0;
        // station → type → (drawn once per type below) edges
        ctx.strokeStyle = m.col; ctx.globalAlpha = 0.22; ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.moveTo(xS, m.y); ctx.lineTo(xT, tyY); ctx.stroke(); ctx.globalAlpha = 1;
        // operators
        const ops = m.ops || [{ name: '…', rate: m.s.txnH || 0, on: true, agg: true }];
        ops.forEach((o, i) => {
          const oy = m.opY[i];
          const col = o.on ? (o.agg ? C.muted : STATUS_COLOR.fresh) : STATUS_COLOR.stale;
          ctx.strokeStyle = col; ctx.globalAlpha = o.on ? 0.13 : 0.32; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(xO, oy); ctx.lineTo(xS, m.y); ctx.stroke(); ctx.globalAlpha = 1;
          if (!o.on) { const fl = (Math.sin(t * 7 + oy) + 1) / 2; ctx.strokeStyle = `rgba(220,38,38,${0.3 + 0.5 * fl})`; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(xO, oy, 5 + 3 * fl, 0, 7); ctx.stroke(); }
          ctx.fillStyle = col; ctx.beginPath(); ctx.arc(xO, oy, o.agg ? 2 : 2.4, 0, 7); ctx.fill();
          ctx.fillStyle = o.on ? (o.agg ? C.muted : C.text) : STATUS_COLOR.stale; ctx.font = `${o.agg ? '' : '600 '}9px -apple-system,sans-serif`; ctx.textAlign = 'right';
          ctx.fillText(`${o.name.length > 17 ? o.name.slice(0, 16) + '…' : o.name} · ${Math.round(o.rate)}/h`, xO - 8, oy + 3);
          hits.push({ x: xO, y: oy, s: m.s });
          const stutter = !o.on;
          const spawn = reduced || stutter ? 0 : dt * (0.25 + 6 * (o.rate / Math.max(1, maxRate)));
          if (Math.random() < spawn) parts.push({ path: [[xO, oy], [xS, m.y], [xT, tyY], [xC - 26, cy]], leg: 0, p: 0, sp: 0.9 + Math.random() * 0.5, col: TXN_COL });
        });
        // station node
        ctx.fillStyle = alarm ? STATUS_COLOR.stale : m.col; ctx.shadowColor = alarm ? STATUS_COLOR.stale : m.col; ctx.shadowBlur = 6;
        ctx.beginPath(); ctx.arc(xS, m.y, 4, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
        ctx.fillStyle = alarm ? STATUS_COLOR.stale : C.text; ctx.font = '700 9.5px -apple-system,sans-serif'; ctx.textAlign = 'left';
        ctx.fillText(`${m.s.name.length > 16 ? m.s.name.slice(0, 15) + '…' : m.s.name} ${m.s.on || 0}/${(m.s.on || 0) + (m.s.off || 0)}`, xS + 8, m.y + 3);
        hits.push({ x: xS, y: m.y, s: m.s });
      }
      // type nodes + type → core edges
      let ti = 0;
      for (const [type, ys] of tyPos) {
        const tyY = ys.reduce((a2, b) => a2 + b, 0) / ys.length;
        const col = TYPE_COLS[ti++ % TYPE_COLS.length];
        ctx.strokeStyle = col; ctx.globalAlpha = 0.3; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(xT, tyY); ctx.lineTo(xC - 26, cy); ctx.stroke(); ctx.globalAlpha = 1;
        ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 8;
        ctx.beginPath(); ctx.arc(xT, tyY, 6, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
        ctx.fillStyle = col; ctx.font = '800 9px ui-monospace,monospace'; ctx.textAlign = 'left';
        ctx.fillText(type.toUpperCase(), xT + 10, tyY + 3);
      }
      // particles (multi-leg)
      for (let i = parts.length - 1; i >= 0; i--) {
        const q = parts[i]; q.p += dt * q.sp;
        if (q.p >= 1) { q.leg++; q.p = 0; if (q.leg >= q.path.length - 1) { parts.splice(i, 1); continue; } }
        const a = q.path[q.leg], b = q.path[q.leg + 1];
        const x = a[0] + (b[0] - a[0]) * q.p, yy = a[1] + (b[1] - a[1]) * q.p;
        ctx.globalAlpha = 0.35 + 0.65 * Math.sin(q.p * Math.PI); ctx.fillStyle = q.col; ctx.fillRect(x - 1.1, yy - 1.1, 2.2, 2.2); ctx.globalAlpha = 1;
      }
      if (parts.length > 2400) parts.splice(0, parts.length - 2400);
      // core
      const rr = 24 + 2 * Math.sin(t * 2.2);
      const g = ctx.createRadialGradient(xC - 26, cy, 4, xC - 26, cy, rr + 18);
      g.addColorStop(0, C.brand); g.addColorStop(1, 'transparent');
      ctx.globalAlpha = 0.35; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(xC - 26, cy, rr + 18, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
      ctx.fillStyle = C.bg; ctx.strokeStyle = C.brand; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(xC - 26, cy, rr, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = C.text; ctx.font = '800 11px -apple-system,sans-serif'; ctx.textAlign = 'center'; ctx.fillText('PULSE', xC - 26, cy + 1);
      ctx.fillStyle = C.muted; ctx.font = '8.5px ui-monospace,monospace'; ctx.fillText(totTx.toLocaleString('en-ZA') + '/h', xC - 26, cy + 13);
      hitRef.current = hits;
      if (!reduced) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);
  const pick = (e) => {
    const b = cvRef.current.getBoundingClientRect();
    const x = e.clientX - b.left, yy = e.clientY - b.top;
    let best = null, bd = 22;
    for (const n of hitRef.current) { const d = Math.hypot(x - n.x, yy - n.y); if (d < bd) { bd = d; best = n; } }
    if (best) onSelect(best.s);
  };
  const loadedAll = rows.length && [...new Set(rows.map((r) => r.mid))].every((mid) => packs[mid]);
  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <div style={{ maxHeight: '72vh', overflowY: 'auto' }}>
        <canvas ref={cvRef} onClick={pick} style={{ display: 'block', width: '100%' }} />
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', padding: '7px 12px', borderTop: '1px solid var(--hairline)', fontSize: 10.5, color: 'var(--muted)' }}>
        <span>{loadedAll ? 'operator → station → type → Pulse · busiest operators named, dark ones always shown' : 'naming operators…'}</span>
        <span style={{ color: STATUS_COLOR.stale }}>red ring = operator dark</span>
        <span>tap anything for the station deep-dive</span>
      </div>
    </div>
  );
}

export function SignalBoard({ monitors, apiBase = '/api/my/data-health' }) {
  const [sel, setSel] = useState(null);
  const [view, setView] = useState('board'); // 'board' | 'rhythm' | 'stations'
  const [viewMenu, setViewMenu] = useState(false); // the view pill: true = options slid out inline
  const [picks, setPicks] = useState([]); // monitor id filter — MULTI-select ([] = whole site)
  const [stPicks, setStPicks] = useState([]); // station-NAME drill under the family chips (multi-select)
  const [day, setDay] = useState(''); // 📅 '' = LIVE · 'YYYY-MM-DD' = that festival day (Stations/Rhythm/deep-dives)
  const picked = (list) => (picks.length ? list.filter((m) => picks.includes(m.id)) : list);
  const [scrubIdx, setScrubIdx] = useState(null); // pulse-strip playhead (null = LIVE)
  const [replay, setReplay] = useState(null); // that moment's dark map — time-travels the WHOLE board
  const openMons = (monitors || []).filter((m) => m.status !== 'closed');
  // A fully-closed event still deserves the board — fall back to ALL monitors so the
  // Board and Rhythm views show the final/historical state instead of disappearing.
  const open = openMons.length ? openMons : (monitors || []);
  const allClosed = !openMons.length && (monitors || []).length > 0;
  const backToLive = () => { setScrubIdx(null); setReplay(null); };

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
  const famShown = picks.length ? rows.filter((s) => picks.includes(s.mid)) : rows;
  const shown = stPicks.length ? famShown.filter((s) => stPicks.includes(s.name)) : famShown;

  // Replaying? Rewrite every station's on/off to THAT moment (from the scrub's
  // dark map) — tiles, zones, dials and the flow meter all time-travel as one.
  // Volume stays blank in the past: the observed log records connectivity.
  const boardRows = replay ? shown.map((s) => {
    const tot = (s.on || 0) + (s.off || 0);
    const off = Math.min(tot, replay.offBy.get(`${s.mid}|${s.sn}`) || 0);
    return tot ? { ...s, on: tot - off, off, status: off === 0 ? 'fresh' : off < tot ? 'warn' : 'stale', lagMin: null, txnH: null, spark: null } : s;
  }) : shown;

  const zones = new Map();
  for (const s of boardRows) {
    if (!zones.has(s.zone)) zones.set(s.zone, []);
    zones.get(s.zone).push(s);
  }
  const zoneList = [...zones.entries()]
    .map(([k, list]) => ({ k, list: list.sort((a, b) => a.name.localeCompare(b.name)), dev: list.reduce((a, s) => a + (s.on || 0) + (s.off || 0), 0) }))
    .sort((a, b) => b.dev - a.dev);

  const sum = (k) => boardRows.reduce((a, s) => a + (s[k] || 0), 0);
  const units = new Set(shown.map((s) => s.unit));
  const short = units.size > 1 ? 'scans+txns' : units.has('transactions') ? 'txns' : 'scans';
  const dials = [
    ['Stations', boardRows.length], ['Zones', zoneList.length],
    ['Devices on', sum('on'), STATUS_COLOR.fresh],
    ['Dark', sum('off'), sum('off') ? STATUS_COLOR.stale : undefined],
    ...(replay ? [] : [[`${short}/h`, sum('txnH').toLocaleString('en-ZA')]]),
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
      {/* monitor filter chips — split the board by station family — and the
          view toggle: 🎛️ tiles vs 📈 the rate river. */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
        {chips.length > 1 && <>
          <button onClick={() => { setPicks([]); setStPicks([]); setSel(null); backToLive(); }} style={chipStyle(!picks.length)}>All stations · {rows.length}</button>
          {chips.map((m) => (
            <button key={m.id} onClick={() => { setPicks((p) => (p.includes(m.id) ? p.filter((x) => x !== m.id) : [...p, m.id])); setStPicks([]); setSel(null); backToLive(); }} style={chipStyle(picks.includes(m.id))}>
              {chipIcon(m)} {m.name} · {rows.filter((s) => s.mid === m.id).length}
            </button>
          ))}
        </>}
        <ViewPill view={view} setView={(v) => { setView(v); backToLive(); }} open={viewMenu} setOpen={setViewMenu} />
      </div>
      {/* station-NAME drill: pick a family above and its stations appear here — tap to
          narrow every view to just those stations; scrolls sideways, never wraps tall. */}
      {!!picks.length && (() => {
        const names = [...new Set(famShown.map((s) => s.name))].sort((a, b) => a.localeCompare(b));
        if (names.length < 2) return null;
        const stChip = (act) => ({ ...chipStyle(act), padding: '3px 10px', fontSize: 11, minHeight: 26, flex: '0 0 auto' });
        return (
          <div style={{ display: 'flex', gap: 5, alignItems: 'center', overflowX: 'auto', scrollbarWidth: 'thin', marginBottom: 10, paddingBottom: 2 }}>
            <button onClick={() => setStPicks([])} style={stChip(!stPicks.length)}>All · {names.length}</button>
            {names.map((n) => (
              <button key={n} onClick={() => { setStPicks((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n])); setSel(null); }} style={stChip(stPicks.includes(n))}>{n}</button>
            ))}
          </div>
        );
      })()}

      {/* 📅 Day picker — the event's PAST days that actually have coverage, taken
          from the observed log (m.days, SAST dates) so it works whether a monitor
          uses a fixed start or a daily anchor. Applies to Stations, Rhythm and the
          deep-dives; Board/Map/River/Network stay live. A day runs start → +24h. */}
      {(view === 'stations' || view === 'rhythm') && (() => {
        const today = new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10); // SAST calendar date
        const set = new Set();
        (monitors || []).forEach((m) => (m.days || []).forEach((d) => { if (d < today) set.add(d); }));
        const days = [...set].sort().slice(-7);
        if (!days.length) return null;
        const dChip = (act) => ({ ...chipStyle(act), padding: '3px 10px', fontSize: 11, minHeight: 26, flex: '0 0 auto' });
        const lbl = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' });
        return (
          <div style={{ display: 'flex', gap: 5, alignItems: 'center', overflowX: 'auto', marginBottom: 10 }}>
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--muted)', flex: '0 0 auto' }}>📅</span>
            <button onClick={() => setDay('')} style={dChip(!day)}>LIVE · today</button>
            {days.map((d) => <button key={d} onClick={() => { setDay(day === d ? '' : d); setSel(null); }} style={dChip(day === d)}>{lbl(d)}</button>)}
          </div>
        );
      })()}

      {allClosed && (
        <div style={{ ...card, borderLeft: '4px solid var(--muted)', fontSize: 12.5, color: 'var(--muted)', marginBottom: 10, padding: '9px 12px' }}>
          This event is <b>closed</b> — you're looking at its final state and full day. Board and Rhythm show the closing snapshot; <b>📶 Stations</b> is the best view to replay each station's day.
        </div>
      )}

      {view === 'rhythm' && (
        <RhythmView key={'r' + day} monitors={picked(open)} apiBase={apiBase} rows={rows} onSelect={setSel} day={day} />
      )}

      {view === 'stations' && (
        <StationDayView key={'s' + day} monitors={picked(monitors)} apiBase={apiBase} onSelect={setSel} day={day} />
      )}

      {view === 'flow' && (
        <EventFlow monitors={picked(monitors)} apiBase={apiBase} onSelect={setSel} />
      )}

      {view === 'map' && (
        <VenueMapView rows={shown} apiBase={apiBase} suiteId={((open.find((m) => m.suiteId) || {}).suiteId) || ''} onSelect={setSel} />
      )}

      {/* key on the filter set: changing chips while drilled into a station's devices
          resets the river to the (re-filtered) all-stations level — otherwise the
          drill ignores the new filter and the chips look dead. */}
      {view === 'river' && <FlowRiverView key={picks.join('|') + '·' + stPicks.join('|')} rows={shown} apiBase={apiBase} onSelect={setSel} />}

      {view === 'network' && <CascadeView key={picks.join('|') + '·' + stPicks.join('|')} rows={shown} apiBase={apiBase} onSelect={setSel} />}

      {view === 'board' && <>
      <FlowMeter rows={boardRows} suiteId={(open.find((m) => m.suiteId) || {}).suiteId || ''} />
      <PulseStrip monitors={picked(open)} apiBase={apiBase} rows={shown} idx={scrubIdx} setIdx={setScrubIdx} onScrub={setReplay} />
      {replay && (
        <div style={{ ...card, borderLeft: '4px solid var(--brand)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 12px', marginBottom: 10 }}>
          <b style={{ fontSize: 12.5 }}>⏪ Replay · {replay.t.toTimeString().slice(0, 5)}</b>
          <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>the whole board shows that moment — <b style={{ color: STATUS_COLOR.fresh }}>{replay.on}</b> on · <b style={{ color: replay.off ? STATUS_COLOR.stale : 'var(--muted)' }}>{replay.off}</b> dark</span>
          <span style={{ flex: 1 }} />
          <button onClick={backToLive} style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 8, padding: '4px 12px', fontSize: 11.5, fontWeight: 800, cursor: 'pointer', minHeight: 30, fontFamily: 'inherit' }}>▶ Back to LIVE</button>
        </div>
      )}
      <NeedsEyes rows={boardRows} onSelect={setSel} />
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
      </>}

      {/* selected station — a sheet-style modal over the board (tap outside to close) */}
      {sel && (
        <div onClick={() => setSel(null)} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 10 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...card, borderLeft: `4px solid ${STATUS_COLOR[sel.status] || 'var(--hairline)'}`, width: '100%', maxWidth: 780, maxHeight: '85vh', overflowY: 'auto', borderRadius: 14, boxShadow: '0 18px 48px rgba(0,0,0,0.35)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 14 }}>{sel.name}</strong>
              <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 1.4, textTransform: 'uppercase', color: 'var(--muted)' }}>{sel.zone}</span>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>monitor: {sel.monitor}</span>
              <span style={{ flex: 1 }} />
              <button onClick={() => setSel(null)} style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 8, minWidth: 34, minHeight: 30, fontSize: 12, cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 8, fontSize: 12.5 }}>
              <span><b style={{ color: STATUS_COLOR.fresh }}>{sel.on ?? '—'}</b> sending</span>
              <span><b style={{ color: sel.off ? STATUS_COLOR.stale : 'var(--muted)' }}>{sel.off ?? 0}</b> dark</span>
              <span><b>{sel.txnH != null ? sel.txnH.toLocaleString('en-ZA') : '—'}</b> {sel.unit}/h</span>
              <span style={{ color: 'var(--muted)' }}>latest record {fmtLag(sel.lagMin)} ago</span>
            </div>
            <DeepDive apiBase={apiBase} mid={sel.mid} station={sel.sn} unit={sel.unit} day={(view === 'stations' || view === 'rhythm') ? day : ''} />
          </div>
        </div>
      )}
    </div>
  );
}

// Event Ops wrapper: fetches this event's monitors (entity-scoped, read only)
// and keeps the board fresh on the same cadence as the health tab.
export default function SignalOps({ entityId, suiteId }) {
  const isMobile = useIsMobile();
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
      {/* Compact control row. Phones get ONE ⋯ menu holding Summary/Share/
          refresh and skip the explainer; desktop keeps the inline buttons. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: isMobile ? '0 0 10px' : '0 0 6px' }}>
        <span style={{ fontSize: 10.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>updated {at ? at.toTimeString().slice(0, 5) : '—'} · auto 60s</span>
        <span style={{ flex: 1 }} />
        {(() => {
          const controls = <>
            <OwlSummary entityId={entityId} suiteId={suiteId} title="Signal board" />
            <ShareMenu variant="header" heading="Signal board — live site status" text={healthShareText(data.monitors)} />
            {suiteId && <SignalReportPanel suiteId={suiteId} />}
            <button className="no-print" title="Download this view as PDF" onClick={() => window.print()} style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 8, minWidth: 40, minHeight: 34, cursor: 'pointer', fontSize: 14, flexShrink: 0 }}>⤓ PDF</button>
            <button title="Refresh now" onClick={() => setTick((v) => v + 1)} style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 8, minWidth: 40, minHeight: 34, cursor: 'pointer', fontSize: 14, flexShrink: 0 }}>🔄 Refresh</button>
          </>;
          return <ControlKebab>{controls}</ControlKebab>; // one ⋯ menu at every width — keep the row uncluttered above the board
        })()}
      </div>
      {!isMobile && <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '0 0 6px' }}>
        Every zone, station and device, live — green ticks are sending, red are dark; numbers are this hour's volume.
      </p>}
      <SignalBoard monitors={data.monitors || []} />
    </div>
  );
}
