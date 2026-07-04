import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import ShareMenu from './ShareMenu.jsx';
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
function DeepDive({ apiBase, mid, station, unit }) {
  const [t, setT] = useState(null);
  const [obs, setObs] = useState(null); // the observed offline log — fuels the 🚦 robot view
  const [robot, setRobot] = useState(true);
  const [err, setErr] = useState('');
  const [tryN, setTryN] = useState(0); // Retry bumps this — live reads can hiccup mid-event
  useEffect(() => {
    let alive = true; setT(null); setObs(null); setErr('');
    fetch(`${apiBase}/monitors/${encodeURIComponent(mid)}/timeline?hours=start&interval=30&station=${encodeURIComponent(station)}`)
      .then((r) => r.json()).then((d) => { if (alive) { if (d && d.devices) setT(d); else setErr((d && d.error) || 'No timeline'); } })
      .catch((e) => { if (alive) setErr(e.message); });
    fetch(`${apiBase}/monitors/${encodeURIComponent(mid)}/observed?hours=start`)
      .then((r) => r.json()).then((d) => { if (alive) setObs(d); }).catch(() => {});
    return () => { alive = false; };
  }, [apiBase, mid, station, tryN]);
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
        return (
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.1, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 3 }}>Devices online through the day</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1.5, height: H }}>
              {ticks.map((k, i) => {
                const off = Math.min(offN[i], devSet.size);
                const on = Math.max(0, devSet.size - off);
                return (
                  <span key={i} title={`${String(k.at || '').slice(11, 16)} · ${on} online · ${off} offline`} style={{ flex: '1 1 0', maxWidth: 7, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: H }}>
                    {off > 0 && <i style={{ display: 'block', height: Math.max(2, Math.round((off / devSet.size) * H)), background: STATUS_COLOR.stale, borderRadius: '1px 1px 0 0', opacity: 0.85 }} />}
                    {on > 0 && <i style={{ display: 'block', height: Math.max(2, Math.round((on / devSet.size) * H)), background: STATUS_COLOR.fresh, borderRadius: off ? 0 : '1px 1px 0 0' }} />}
                  </span>
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
              <span>{String(ticks[0].at || '').slice(11, 16)}</span>
              <span><span style={{ color: STATUS_COLOR.fresh, fontWeight: 700 }}>online</span> · <span style={{ color: STATUS_COLOR.stale, fontWeight: 700 }}>offline</span> at each check</span>
              <span>{String(ticks[ticks.length - 1].at || '').slice(11, 16)}</span>
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
            <DeepDive apiBase={apiBase} mid={sel.mid} station={sel.sn} unit={sel.unit} />
          </div>
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
        <OwlSummary entityId={entityId} suiteId={suiteId} title="Signal board" />
        <ShareMenu variant="header" heading="Signal board — live site status" text={healthShareText(data.monitors)} />
        <button title="Refresh now" onClick={() => setTick((v) => v + 1)} style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 8, minWidth: 40, minHeight: 34, cursor: 'pointer', fontSize: 14 }}>🔄</button>
      </div>
      <SignalBoard monitors={data.monitors || []} />
    </div>
  );
}
