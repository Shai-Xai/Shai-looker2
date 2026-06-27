import { useState, useEffect, useRef } from 'react';
import { chartPalette } from '../../lib/brand.js';
import { useIsMobile } from '../../lib/useIsMobile.js';

// Shared presentational pieces for the Results pillar — the compact goal card and
// its progress visuals (bar / ring / dial), the state→colour/chip logic, and value
// formatting. Used by the home GoalsStrip (teaser), the dedicated Goals page, and
// the goal detail view, so a goal looks identical wherever it's shown.

// Horizontal snap strip — one row, scroll for more (like the pinned tiles).
export function Strip({ children }) {
  return (
    <div style={{ display: 'flex', gap: 10, overflowX: 'auto', scrollSnapType: 'x proximity', padding: '4px 4px 8px', margin: '0 -4px', scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>
      {children}
    </div>
  );
}

export function GoalCard({ goal, onClick, index = 0, colorIndex, draggable = false, onDragStartCard, onDropCard, onMoveUp, onMoveDown, onDelete, grid = false }) {
  const p = goal.progress || {};
  const { chip } = goalState(goal, p);
  // Brand identity colour for healthy/in-progress goals; semantic still wins for state.
  const tone = goalColor(goal, p, colorIndex != null ? paletteColor(colorIndex) : undefined);
  const viz = goal.display || 'bar';
  const clickable = !!onClick;
  const [confirming, setConfirming] = useState(false);
  // Mobile: require a SECOND tap to open (first tap arms it, with a hint), so a
  // stray tap while scrolling doesn't fling you into a goal. Desktop opens on click.
  const isMobile = useIsMobile();
  const [armed, setArmed] = useState(false);
  const armRef = useRef(null);
  useEffect(() => () => clearTimeout(armRef.current), []);
  const activate = () => {
    if (!onClick) return;
    if (!isMobile) { onClick(); return; }
    if (armed) { clearTimeout(armRef.current); setArmed(false); onClick(); }
    else { setArmed(true); clearTimeout(armRef.current); armRef.current = setTimeout(() => setArmed(false), 1800); }
  };
  const cardStyle = grid ? { ...card, flex: '1 1 150px', minWidth: 0, maxWidth: 260 } : card;
  return (
    <div className="lift msg-in"
      role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? activate : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter') onClick(); } : undefined}
      draggable={draggable}
      onDragStart={draggable ? onDragStartCard : undefined}
      onDragOver={draggable ? (e) => e.preventDefault() : undefined}
      onDrop={draggable ? (e) => { e.preventDefault(); onDropCard && onDropCard(); } : undefined}
      title={draggable ? 'Drag to reorder' : undefined}
      style={{ ...cardStyle, position: 'relative', animationDelay: `${index * 60}ms`, cursor: clickable ? 'pointer' : 'default', boxShadow: armed ? '0 0 0 2px var(--brand)' : cardStyle.boxShadow }}
    >
      {armed && <div style={tapHint}>Tap again to open</div>}
      {/* Title row. For ring/dial the pace chip moves to the centre (under the ring);
          for the bar layout it stays here, where there's no central column. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        {goal.isNorthStar && <span title="North Star" style={{ fontSize: 12, flexShrink: 0 }}>⭐</span>}
        <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{goal.name}</span>
        {(viz === 'bar' || goal.direction === 'composition') && chip}
        {/* Mobile reorder — drag is desktop-only, so phones get ▲▼ move controls
            (same position the dashboard strip orders by). Hidden when not reorderable. */}
        {isMobile && (onMoveUp || onMoveDown) && (
          <span style={{ display: 'flex', gap: 2, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
            <button onClick={(e) => { e.stopPropagation(); onMoveUp && onMoveUp(); }} disabled={!onMoveUp} title="Move up" aria-label="Move up" style={{ ...moveBtn, opacity: onMoveUp ? 0.7 : 0.25 }}>▲</button>
            <button onClick={(e) => { e.stopPropagation(); onMoveDown && onMoveDown(); }} disabled={!onMoveDown} title="Move down" aria-label="Move down" style={{ ...moveBtn, opacity: onMoveDown ? 0.7 : 0.25 }}>▼</button>
          </span>
        )}
        {onDelete && (confirming ? (
          <span style={{ display: 'flex', gap: 3, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
            <button onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Delete this goal" style={delYes}>Delete</button>
            <button onClick={(e) => { e.stopPropagation(); setConfirming(false); }} title="Keep it" style={delNo}>✕</button>
          </span>
        ) : (
          <button onClick={(e) => { e.stopPropagation(); setConfirming(true); }} title="Delete this goal" aria-label="Delete goal" style={cardX}>✕</button>
        ))}
      </div>
      {goal.direction === 'composition' ? (
        <div style={{ marginTop: 'auto', paddingTop: 12 }}>
          {viz === 'ring' ? (
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 4 }}><CompositionDonut parts={p.parts} size={96} /></div>
          ) : viz === 'dial' ? (
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 2 }}><CompositionArc parts={p.parts} size={132} /></div>
          ) : (
            <CompositionBar parts={p.parts} />
          )}
          <CompositionLegend parts={p.parts} compact />
        </div>
      ) : viz === 'bar' ? (
        <div style={{ marginTop: 'auto', paddingTop: 12 }}>
          <div style={{ fontSize: 19, fontWeight: 800 }}>{fmtVal(p.value, goal.unit)}</div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>{goal.direction === 'range' ? 'aim ' : 'of '}{fmtTarget(goal)}{p.pct != null ? ` · ${p.pct}%` : ''}</div>
          <Bar pct={p.pct} tone={tone} />
          <VsLast goal={goal} p={p} />
          <Forecast goal={goal} p={p} />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 5, marginTop: 2 }}>
          {viz === 'ring' ? <Ring pct={p.pct} tone={tone} size={78} label={rangeLabel(goal, p)} /> : <Dial pct={p.pct} tone={tone} size={86} label={rangeLabel(goal, p)} />}
          <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', lineHeight: 1.3 }}>{fmtVal(p.value, goal.unit)} / {fmtTarget(goal)}</div>
          {chip && <div style={{ marginTop: 1 }}>{chip}</div>}
          <VsLast goal={goal} p={p} align="center" />
        </div>
      )}
    </div>
  );
}

// Composition: a stacked bar of the actual shares, with TARGET markers (thin lines at
// the cumulative target boundaries) so you can see actual vs the target split. Slices
// outside their band turn amber. Parts are interlinked (they sum to ~100% of total).
export function CompositionBar({ parts = [] }) {
  const shown = parts.filter((p) => Number.isFinite(p.share));
  if (!shown.length) return <div style={{ height: 16, borderRadius: 8, background: 'rgba(128,128,128,0.16)' }} />;
  // Cumulative target boundaries (skip the last = 100%).
  let acc = 0; const marks = shown.slice(0, -1).map((p) => (acc += Number(p.target) || 0));
  return (
    <div style={{ position: 'relative', height: 16, borderRadius: 8, overflow: 'hidden', background: 'rgba(128,128,128,0.16)' }}>
      <div style={{ display: 'flex', height: '100%' }}>
        {shown.map((p, i) => (
          <div key={p.label} title={`${p.label} ${p.share}% (target ${p.target}%)`}
            style={{ width: `${Math.max(0, p.share)}%`, background: p.status !== 'in' ? AMBER : partColors[i % partColors.length], borderRight: '1.5px solid var(--card)' }} />
        ))}
      </div>
      {marks.map((m, i) => (
        <span key={i} title={`target boundary ${Math.round(m)}%`} style={{ position: 'absolute', top: -2, bottom: -2, left: `${m}%`, width: 0, borderLeft: '2px dashed var(--text)', opacity: 0.55 }} />
      ))}
    </div>
  );
}

// Donut of the actual shares (display 'ring' for compositions), with target-boundary
// ticks around the rim.
export function CompositionDonut({ parts = [], size = 96 }) {
  const shown = parts.filter((p) => Number.isFinite(p.share));
  const total = shown.reduce((s, p) => s + Math.max(0, p.share), 0) || 100;
  const r = (size - 14) / 2, cx = size / 2, cy = size / 2, C = 2 * Math.PI * r;
  let off = 0;
  const seg = (frac) => { const len = frac * C; const el = { dasharray: `${len} ${C - len}`, dashoffset: -off }; off += len; return el; };
  const tickAt = (frac) => { const a = -Math.PI / 2 + 2 * Math.PI * frac; return [cx + (r + 7) * Math.cos(a), cy + (r + 7) * Math.sin(a), cx + (r - 7) * Math.cos(a), cy + (r - 7) * Math.sin(a)]; };
  let tacc = 0; const marks = shown.slice(0, -1).map((p) => (tacc += (Number(p.target) || 0) / 100));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <g transform={`rotate(-90 ${cx} ${cy})`}>
        {shown.map((p, i) => { const e = seg(Math.max(0, p.share) / total); return (
          <circle key={p.label} cx={cx} cy={cy} r={r} fill="none" stroke={p.status !== 'in' ? AMBER : partColors[i % partColors.length]} strokeWidth="12" strokeDasharray={e.dasharray} strokeDashoffset={e.dashoffset} />
        ); })}
      </g>
      {marks.map((m, i) => { const [x1, y1, x2, y2] = tickAt(m); return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--text)" strokeOpacity="0.55" strokeWidth="2" strokeDasharray="2 2" />; })}
    </svg>
  );
}

// Semicircle stacked arc (display 'dial' for compositions), with target-boundary ticks.
export function CompositionArc({ parts = [], size = 132 }) {
  const shown = parts.filter((p) => Number.isFinite(p.share));
  const total = shown.reduce((s, p) => s + Math.max(0, p.share), 0) || 100;
  const sw = 12, r = (size - sw) / 2, cx = size / 2, cy = size / 2;
  const pt = (frac) => { const a = Math.PI - Math.PI * frac; return [cx + r * Math.cos(a), cy - r * Math.sin(a)]; };
  const arc = (f0, f1) => { const [x0, y0] = pt(f0), [x1, y1] = pt(f1); return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`; };
  const h = Math.ceil(cy + sw);
  let acc = 0; const segs = shown.map((p, i) => { const f0 = acc / total; acc += Math.max(0, p.share); const f1 = acc / total; return { f0, f1, color: p.status !== 'in' ? AMBER : partColors[i % partColors.length], key: p.label }; });
  let tacc = 0; const marks = shown.slice(0, -1).map((p) => (tacc += (Number(p.target) || 0) / 100));
  return (
    <svg width={size} height={h} viewBox={`0 0 ${size} ${h}`} aria-hidden="true">
      <path d={arc(0, 1)} fill="none" stroke="rgba(128,128,128,0.18)" strokeWidth={sw} />
      {segs.map((s) => <path key={s.key} d={arc(s.f0, s.f1)} fill="none" stroke={s.color} strokeWidth={sw} />)}
      {marks.map((m, i) => { const [x, y] = pt(m); const [xo, yo] = [cx + (r + sw / 2 + 2) * Math.cos(Math.PI - Math.PI * m), cy - (r + sw / 2 + 2) * Math.sin(Math.PI - Math.PI * m)]; return <line key={i} x1={x} y1={y} x2={xo} y2={yo} stroke="var(--text)" strokeOpacity="0.6" strokeWidth="2" />; })}
    </svg>
  );
}

export function CompositionLegend({ parts = [], compact = false }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 3 : 6, marginTop: 8 }}>
      {parts.map((p, i) => (
        <div key={p.label} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5 }}>
          <span style={{ width: 9, height: 9, borderRadius: 2, flexShrink: 0, background: p.status !== 'in' ? AMBER : partColors[i % partColors.length] }} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.focus ? '🎯 ' : ''}{p.label}</span>
          <span style={{ fontWeight: 700 }}>{p.share}%</span>
          <span style={{ color: 'var(--muted)' }}>/ {p.target}%</span>
          {p.status === 'over' && <span style={{ color: AMBER, fontWeight: 700 }} title="above band">↑</span>}
          {p.status === 'under' && <span style={{ color: AMBER, fontWeight: 700 }} title="below band">↓</span>}
          {Number.isFinite(p.deltaPp) && p.deltaPp !== 0 && (
            <span style={{ color: 'var(--muted)', fontSize: 10.5 }} title={`vs last year (${p.lastShare}%)`}>{p.deltaPp > 0 ? '▲' : '▼'}{Math.abs(p.deltaPp)}pp</span>
          )}
        </div>
      ))}
    </div>
  );
}

// Centre label for a ring/dial: range goals show the real % (uncapped) so going over
// the band reads as e.g. "105%" instead of a flat "100%". Others fall back to the arc %.
export function rangeLabel(goal, p = {}) {
  if (goal.direction === 'range' && p.pct != null) return `${Math.round(p.pct)}%`;
  return undefined;
}

// Plain-English read of a mix/split goal — the same kind of narrative the other goal
// types get (pace / forecast / vs last time), built from the resolved parts: which
// slice leads, whether the mix is balanced or drifting (and how), movement vs last
// year, and a nudge on the focus slice. Returns '' when there's nothing to say.
export function compositionCommentary(goal, p = {}) {
  const parts = (p.parts || []).filter((x) => Number.isFinite(x.share));
  if (!parts.length) return '';
  const bits = [];
  const lead = parts.reduce((a, b) => (b.share > a.share ? b : a), parts[0]);
  const drift = parts.filter((x) => x.status !== 'in');
  if (p.balanced === true) {
    bits.push(`${lead.label} leads at ${lead.share}% and the mix is balanced — every slice sits within its target band.`);
  } else if (drift.length) {
    const names = drift.map((x) => `${x.label} is ${x.status === 'over' ? 'above' : 'below'} target (${x.share}% vs ${x.target}%)`);
    bits.push(`The mix is drifting: ${names.join('; ')}.`);
  } else {
    bits.push(`${lead.label} leads at ${lead.share}%.`);
  }
  const moved = parts.filter((x) => Number.isFinite(x.deltaPp) && x.deltaPp !== 0);
  if (moved.length) {
    bits.push(`Versus last year, ${moved.map((x) => `${x.label} is ${x.deltaPp > 0 ? 'up' : 'down'} ${Math.abs(x.deltaPp)}pp`).join(' and ')}.`);
  }
  const focus = parts.find((x) => x.focus);
  if (focus && focus.status !== 'over') {
    bits.push(`Focus on growing ${focus.label} (now ${focus.share}%, target ${focus.target}%).`);
  }
  return bits.join(' ');
}

export function Bar({ pct, tone }) {
  const w = Math.max(0, Math.min(100, Math.round(pct || 0)));
  return (
    <div style={{ height: 6, borderRadius: 980, background: 'rgba(128,128,128,0.16)', overflow: 'hidden', marginTop: 7 }}>
      <div style={{ height: '100%', width: `${w}%`, background: tone, borderRadius: 980, transition: 'width .4s ease' }} />
    </div>
  );
}
export function Chip({ t, c, bg }) {
  return <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 980, padding: '2px 8px', background: bg, color: c, whiteSpace: 'nowrap' }}>{t}</span>;
}

// "vs last time" at the same point in the cycle — curve goals compare to last time's
// value at now (lastAtNow); others to the stored baseline. Same basis as the detail
// view, just compact. Colour is good/bad by direction (for an "under a cap" goal,
// lower than last time is good), arrow follows the actual change.
function vsLastBaseline(goal, p) {
  if (p.lastAtNow != null) return Number(p.lastAtNow);
  if (goal.baselineValue != null) return Number(goal.baselineValue);
  return null;
}
export function VsLast({ goal, p, align = 'left' }) {
  const base = vsLastBaseline(goal, p);
  if (base == null || !base || p.value == null) return null;
  const pct = Math.round(((Number(p.value) - base) / Math.abs(base)) * 100);
  if (!Number.isFinite(pct)) return null;
  const flat = pct === 0;
  const dir = goal.direction || p.direction || 'at_least';
  const good = dir === 'at_most' ? pct < 0 : pct > 0;
  const color = flat ? 'var(--muted)' : (good ? GREEN : RED);
  const arrow = flat ? '' : (pct > 0 ? '▲' : '▼');
  return (
    <div style={{ fontSize: 10.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 4, marginTop: 4, justifyContent: align === 'center' ? 'center' : 'flex-start', whiteSpace: 'nowrap' }}>
      <span style={{ color, fontWeight: 700 }}>{arrow}{arrow ? ' ' : ''}{flat ? 'same' : `${pct > 0 ? '+' : ''}${pct}%`}</span>
      <span>vs last time</span>
    </div>
  );
}

// Projected final landing (curve goals heading up to a target) — "where you'll end
// if you finish like last time's shape." Compact one-liner for the card; the detail
// view spells out the gap. Green when on track to hit, amber/red when short.
export function Forecast({ goal, p }) {
  const f = p && p.forecast;
  if (!f || f.projected == null) return null;
  const hit = f.status === 'will_hit';
  const color = hit ? GREEN : (f.status === 'short' ? RED : AMBER);
  return (
    <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
      <span style={{ color, fontWeight: 700 }}>→ {fmtVal(f.projected, goal.unit)}</span> projected{f.vsTargetPct != null ? ` · ${f.vsTargetPct}%` : ''}
    </div>
  );
}

// Circular progress ring with the % in the centre. The arc always clamps to 100%, but
// `label` can override the centre text (e.g. a range goal over the band shows the real
// 105% rather than a flat 100%).
export function Ring({ pct, tone, size = 78, label }) {
  const w = Math.max(0, Math.min(100, Math.round(pct || 0)));
  const [shown, setShown] = useState(0); // animate the arc in on load
  useEffect(() => { const t = setTimeout(() => setShown(w), 90); return () => clearTimeout(t); }, [w]);
  const sw = 7, r = (size - sw) / 2, c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(128,128,128,0.18)" strokeWidth={sw} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth={sw} strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - shown / 100)} transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 1.2s cubic-bezier(.34,1,.4,1)' }} />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" fontSize={size * 0.25} fontWeight="800" fill="var(--text)">{label != null ? label : `${w}%`}</text>
    </svg>
  );
}

// Half-circle gauge (speedometer style); fills left→right with the % below. `label`
// can override the centre text (range over-band shows the real >100% reading).
export function Dial({ pct, tone, size = 86, label }) {
  const w = Math.max(0, Math.min(100, Math.round(pct || 0)));
  const [shown, setShown] = useState(0); // animate the gauge in on load
  useEffect(() => { const t = setTimeout(() => setShown(w), 90); return () => clearTimeout(t); }, [w]);
  const sw = 8, r = (size - sw) / 2, cx = size / 2, cy = size / 2;
  const at = (frac) => { const a = Math.PI - Math.PI * frac; return [cx + r * Math.cos(a), cy - r * Math.sin(a)]; };
  const [sx, sy] = at(0), [ex, ey] = at(1);
  const full = `M ${sx.toFixed(1)} ${sy.toFixed(1)} A ${r} ${r} 0 0 1 ${ex.toFixed(1)} ${ey.toFixed(1)}`;
  const arcLen = Math.PI * r; // semicircle length — drives the dash draw-in
  const h = Math.ceil(cy + size * 0.24);
  return (
    <svg width={size} height={h} viewBox={`0 0 ${size} ${h}`} aria-hidden="true">
      <path d={full} fill="none" stroke="rgba(128,128,128,0.18)" strokeWidth={sw} strokeLinecap="round" />
      <path d={full} fill="none" stroke={tone} strokeWidth={sw} strokeLinecap="round"
        strokeDasharray={arcLen} strokeDashoffset={arcLen * (1 - shown / 100)}
        style={{ transition: 'stroke-dashoffset 1.2s cubic-bezier(.34,1,.4,1)' }} />
      <text x={cx} y={cy + 1} textAnchor="middle" fontSize={size * 0.2} fontWeight="800" fill="var(--text)">{label != null ? label : `${w}%`}</text>
    </svg>
  );
}

export const GREEN = '#2da44e', BLUE = '#0a66c2', AMBER = '#b45309', RED = '#dc2626';
export const bandTone = (b) => ({ smashed: GREEN, hit: GREEN, near: AMBER, missed: RED, over: AMBER }[b] || BLUE);
// Target label: a band (lo–hi) for range goals, else the single target.
export function fmtTarget(goal) {
  if (goal.direction === 'range' && goal.targetMax != null) {
    if (goal.unit === '%') return `${goal.targetValue}–${goal.targetMax}%`;
    return `${fmtVal(goal.targetValue, goal.unit)}–${fmtVal(goal.targetMax, goal.unit)}`;
  }
  return fmtVal(goal.targetValue, goal.unit);
}

// Distinct per-goal identity colours, drawn from the white-label brand chart palette
// (adapts per client). Used for healthy / in-progress goals so each ring + tile reads
// as its own thing; the semantic state colours below still win for trouble (red/amber)
// and done (green). Leads with cool hues and skips the red-ish brand primary, so a
// healthy goal is never mistaken for the over-target red.
// A client's palette can include very light colours that vanish on the white card,
// so darken anything too light to a readable contrast.
function ensureContrast(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return hex;
  let r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), b = parseInt(m[1].slice(4, 6), 16);
  const lum = 0.299 * r + 0.587 * g + 0.114 * b; // perceived brightness 0-255
  const MAX = 150;
  if (lum > MAX) { const f = MAX / lum; r *= f; g *= f; b *= f; }
  return '#' + [r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');
}
function identityPalette() {
  const c = chartPalette();
  return [c[3], c[4], c[7], c[6], c[9], c[2], c[1]].filter(Boolean).map(ensureContrast);
}
export function paletteColor(i) { const p = identityPalette(); return p.length ? p[((i % p.length) + p.length) % p.length] : BLUE; }
// The colour for a goal's ring/tile: semantic when it matters (reached → green, over a
// cap → red, behind → amber, finished → its result band), else the goal's brand
// identity colour (falls back to blue when none is supplied).
// Part colours for composition slices (distinct, theme-agnostic).
export const partColors = ['#0a84ff', '#34c759', '#ff9f0a', '#bf5af2', '#ff375f', '#5ac8fa', '#ffd60a', '#64d2ff'];
export function goalColor(goal, p = {}, brandColor) {
  const dir = goal.direction || p.direction || 'at_least';
  const v = p.value, t = goal.targetValue;
  if (dir === 'composition') return p.balanced === false ? AMBER : p.balanced === true ? GREEN : (brandColor || BLUE);
  if (p.band) return bandTone(p.band);
  if (dir === 'range') {
    if (p.over) return AMBER;          // above the healthy band → flagged
    if (p.inRange) return GREEN;       // inside the band → good
    if (p.status === 'behind') return AMBER;
    return brandColor || BLUE;
  }
  const have = v != null && t != null;
  const reached = have && (dir === 'at_most' ? v <= t : (p.pct != null ? p.pct >= 100 : v >= t));
  if (reached) return GREEN;
  if (dir === 'at_most' && have && v > t) return RED;
  if (p.status === 'behind') return AMBER;
  return brandColor || BLUE;
}
// Colour + chip from the goal's state: GREEN once the target is reached, RED when
// an "under a cap" goal goes over, AMBER when behind pace, BLUE while in progress,
// and the result band once the deadline has passed.
export function goalState(goal, p) {
  const dir = goal.direction || p.direction || 'at_least';
  const v = p.value, t = goal.targetValue;
  if (dir === 'composition') {
    if (p.balanced === false) return { tone: AMBER, chip: <Chip t="⚠ Mix drifting" c={AMBER} bg="rgba(245,158,11,0.16)" /> };
    if (p.balanced === true) return { tone: GREEN, chip: <Chip t="✓ Balanced" c={GREEN} bg="rgba(52,199,89,0.16)" /> };
    return { tone: BLUE, chip: null };
  }
  if (p.band) return { tone: bandTone(p.band), chip: <Chip {...bandChip(p.band)} /> };
  if (dir === 'range') {
    if (p.over) return { tone: AMBER, chip: <Chip t="⚠ Above range" c={AMBER} bg="rgba(245,158,11,0.16)" /> };
    if (p.inRange) return { tone: GREEN, chip: <Chip t="✓ On target" c={GREEN} bg="rgba(52,199,89,0.16)" /> };
    if (p.status === 'behind') return { tone: AMBER, chip: <Chip t="Behind" c={AMBER} bg="rgba(245,158,11,0.16)" /> };
    if (p.status) return { tone: BLUE, chip: <Chip {...statusChip(p.status)} /> };
    return { tone: BLUE, chip: null };
  }
  const have = v != null && t != null;
  const reached = have && (dir === 'at_most' ? v <= t : (p.pct != null ? p.pct >= 100 : v >= t));
  const overCap = dir === 'at_most' && have && v > t;
  if (reached) return { tone: GREEN, chip: <Chip t={dir === 'at_most' ? '✓ Under target' : '✓ Reached'} c={GREEN} bg="rgba(52,199,89,0.16)" /> };
  if (overCap) return { tone: RED, chip: <Chip t="Over target" c={RED} bg="rgba(239,68,68,0.12)" /> };
  if (p.status === 'behind') return { tone: AMBER, chip: <Chip t="Behind" c={AMBER} bg="rgba(245,158,11,0.16)" /> };
  if (p.status) return { tone: BLUE, chip: <Chip {...statusChip(p.status)} /> };
  return { tone: BLUE, chip: null };
}
export const statusChip = (s) => ({
  ahead: { t: 'Ahead', c: GREEN, bg: 'rgba(52,199,89,0.15)' },
  on_track: { t: 'On track', c: BLUE, bg: 'rgba(10,132,255,0.13)' },
  behind: { t: 'Behind', c: AMBER, bg: 'rgba(245,158,11,0.16)' },
}[s] || { t: s, c: BLUE, bg: 'rgba(10,132,255,0.13)' });
export const bandChip = (b) => ({
  smashed: { t: '🎉 Smashed', c: GREEN, bg: 'rgba(52,199,89,0.16)' },
  hit: { t: '✓ Hit', c: GREEN, bg: 'rgba(52,199,89,0.16)' },
  near: { t: 'Just missed', c: AMBER, bg: 'rgba(245,158,11,0.16)' },
  missed: { t: 'Missed', c: RED, bg: 'rgba(239,68,68,0.12)' },
  over: { t: '⚠ Above range', c: AMBER, bg: 'rgba(245,158,11,0.16)' },
}[b] || { t: b, c: BLUE, bg: 'rgba(10,132,255,0.13)' });

export function fmtVal(v, unit) {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (unit === '%') return `${n}%`;
  const s = Math.abs(n) >= 1000 ? n.toLocaleString('en-ZA') : String(n);
  if (unit === 'ZAR') return `R${s}`;
  return unit && unit !== 'count' ? `${s} ${unit}` : s;
}

const card = { flex: '0 0 172px', scrollSnapAlign: 'start', boxSizing: 'border-box', minHeight: 138, display: 'flex', flexDirection: 'column', background: 'var(--tile-bg, var(--card))', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow-sm)', padding: '11px 13px', color: 'var(--text)' };
const tapHint = { position: 'absolute', bottom: 6, left: '50%', transform: 'translateX(-50%)', background: 'var(--brand)', color: '#fff', fontSize: 10.5, fontWeight: 700, padding: '2px 9px', borderRadius: 980, whiteSpace: 'nowrap', pointerEvents: 'none', boxShadow: '0 2px 8px rgba(0,0,0,0.18)' };
const cardX = { border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 11, lineHeight: 1, padding: 2, flexShrink: 0, opacity: 0.55 };
const moveBtn = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', cursor: 'pointer', fontSize: 9, lineHeight: 1, borderRadius: 6, padding: '3px 5px', flexShrink: 0, minWidth: 22, minHeight: 22 };
const delYes = { border: 'none', background: 'var(--error, #dc2626)', color: '#fff', borderRadius: 6, fontSize: 10, fontWeight: 700, padding: '2px 7px', cursor: 'pointer', flexShrink: 0 };
const delNo = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--muted)', borderRadius: 6, fontSize: 10, padding: '2px 5px', cursor: 'pointer', flexShrink: 0 };
