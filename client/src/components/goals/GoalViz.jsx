import { useState, useEffect } from 'react';

// Shared presentational pieces for the Results pillar — the compact goal card and
// its progress visuals (bar / ring / dial), the state→colour/chip logic, and value
// formatting. Used by the home GoalsStrip (teaser), the dedicated Goals page, and
// the goal detail view, so a goal looks identical wherever it's shown.

// Horizontal snap strip — one row, scroll for more (like the pinned tiles).
export function Strip({ children }) {
  return (
    <div style={{ display: 'flex', gap: 10, overflowX: 'auto', scrollSnapType: 'x proximity', paddingBottom: 4, scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>
      {children}
    </div>
  );
}

export function GoalCard({ goal, onClick, index = 0, draggable = false, onDragStartCard, onDropCard, onDelete }) {
  const p = goal.progress || {};
  const { tone, chip } = goalState(goal, p);
  const viz = goal.display || 'bar';
  const clickable = !!onClick;
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="lift msg-in"
      role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined}
      onClick={onClick || undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter') onClick(); } : undefined}
      draggable={draggable}
      onDragStart={draggable ? onDragStartCard : undefined}
      onDragOver={draggable ? (e) => e.preventDefault() : undefined}
      onDrop={draggable ? (e) => { e.preventDefault(); onDropCard && onDropCard(); } : undefined}
      title={draggable ? 'Drag to reorder' : undefined}
      style={{ ...card, animationDelay: `${index * 60}ms`, cursor: clickable ? 'pointer' : 'default' }}
    >
      {/* Title + pace chip share the top row, so the chip never costs its own line. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        {goal.isNorthStar && <span title="North Star" style={{ fontSize: 12, flexShrink: 0 }}>⭐</span>}
        <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{goal.name}</span>
        {chip}
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
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 5, marginTop: 2 }}>
          {viz === 'ring' ? <Ring pct={p.pct} tone={tone} size={78} /> : <Dial pct={p.pct} tone={tone} size={86} />}
          <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', lineHeight: 1.3 }}>{fmtVal(p.value, goal.unit)} / {fmtVal(goal.targetValue, goal.unit)}</div>
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
const cardX = { border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 11, lineHeight: 1, padding: 2, flexShrink: 0, opacity: 0.55 };
const delYes = { border: 'none', background: 'var(--error, #dc2626)', color: '#fff', borderRadius: 6, fontSize: 10, fontWeight: 700, padding: '2px 7px', cursor: 'pointer', flexShrink: 0 };
const delNo = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--muted)', borderRadius: 6, fontSize: 10, padding: '2px 5px', cursor: 'pointer', flexShrink: 0 };
