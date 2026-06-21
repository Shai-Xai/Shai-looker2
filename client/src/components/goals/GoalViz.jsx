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
        {viz === 'bar' && chip}
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
      {viz === 'bar' ? (
        <div style={{ marginTop: 'auto', paddingTop: 12 }}>
          <div style={{ fontSize: 19, fontWeight: 800 }}>{fmtVal(p.value, goal.unit)}</div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>of {fmtVal(goal.targetValue, goal.unit)}{p.pct != null ? ` · ${p.pct}%` : ''}</div>
          <Bar pct={p.pct} tone={tone} />
          <VsLast goal={goal} p={p} />
          <Forecast goal={goal} p={p} />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 5, marginTop: 2 }}>
          {viz === 'ring' ? <Ring pct={p.pct} tone={tone} size={78} /> : <Dial pct={p.pct} tone={tone} size={86} />}
          <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', lineHeight: 1.3 }}>{fmtVal(p.value, goal.unit)} / {fmtVal(goal.targetValue, goal.unit)}</div>
          {chip && <div style={{ marginTop: 1 }}>{chip}</div>}
          <VsLast goal={goal} p={p} align="center" />
        </div>
      )}
    </div>
  );
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

// Circular progress ring with the % in the centre.
export function Ring({ pct, tone, size = 78 }) {
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
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" fontSize={size * 0.25} fontWeight="800" fill="var(--text)">{w}%</text>
    </svg>
  );
}

// Half-circle gauge (speedometer style); fills left→right with the % below.
export function Dial({ pct, tone, size = 86 }) {
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
      <text x={cx} y={cy + 1} textAnchor="middle" fontSize={size * 0.2} fontWeight="800" fill="var(--text)">{w}%</text>
    </svg>
  );
}

export const GREEN = '#2da44e', BLUE = '#0a66c2', AMBER = '#b45309', RED = '#dc2626';
export const bandTone = (b) => ({ smashed: GREEN, hit: GREEN, near: AMBER, missed: RED }[b] || BLUE);

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
export function goalColor(goal, p = {}, brandColor) {
  const dir = goal.direction || p.direction || 'at_least';
  const v = p.value, t = goal.targetValue;
  if (p.band) return bandTone(p.band);
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
  if (p.band) return { tone: bandTone(p.band), chip: <Chip {...bandChip(p.band)} /> };
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
