import { useState, useEffect } from 'react';
import { goalState, fmtVal } from './GoalViz.jsx';

// Apple-Fitness "Activity Rings" for goals — ALL of an event's targets at a glance,
// as concentric rings (the headline summary). Like Move/Exercise/Stand, each goal is
// one ring; fullness = progress to target, so you read the whole event in one shape.
//
// Colour = MEANING, not identity: each ring takes the goal's semantic state tone
// (goalState) — blue/green when ahead or reached, amber when behind, red when an
// "under a cap" goal is over — so the hero matches the goal tiles below it exactly.
// Concentric rings sit at different radii (and the legend is ordered outer→inner),
// so they stay distinguishable even when two share a colour. North Star leads.

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n || 0)));

// The concentric SVG. `rings` = [{ pct, color }] from outer → inner.
export function ActivityRings({ rings, size = 180, stroke, gap = 4, onPick }) {
  const n = rings.length || 1;
  // Derive a stroke that fits all rings inside `size` with gaps between them.
  const sw = stroke || Math.max(7, Math.min(20, Math.round((size / 2 - 6) / n) - gap));
  const [draw, setDraw] = useState(false);
  useEffect(() => { const t = setTimeout(() => setDraw(true), 80); return () => clearTimeout(t); }, [rings.length]);
  const cx = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Goal progress rings">
      {rings.map((ring, i) => {
        const r = size / 2 - sw / 2 - i * (sw + gap);
        if (r <= sw) return null;
        const c = 2 * Math.PI * r;
        const pct = clamp(ring.pct);
        return (
          <g key={i} style={{ cursor: onPick ? 'pointer' : 'default' }} onClick={onPick ? () => onPick(i) : undefined}>
            {/* faint track */}
            <circle cx={cx} cy={cx} r={r} fill="none" stroke={ring.color} strokeOpacity={0.18} strokeWidth={sw} />
            {/* progress arc — drawn from the top, clockwise, rounded cap */}
            <circle cx={cx} cy={cx} r={r} fill="none" stroke={ring.color} strokeWidth={sw} strokeLinecap="round"
              strokeDasharray={c} strokeDashoffset={c * (1 - (draw ? pct : 0) / 100)}
              transform={`rotate(-90 ${cx} ${cx})`}
              style={{ transition: 'stroke-dashoffset 1.1s cubic-bezier(.34,1,.4,1)', transitionDelay: `${i * 110}ms`, filter: pct >= 100 ? `drop-shadow(0 0 5px ${ring.color}aa)` : 'none' }} />
          </g>
        );
      })}
    </svg>
  );
}

// The full hero card: rings on the left, a tappable legend on the right (name,
// value / target, % and pace chip) — the Apple "Summary" Activity-Rings card.
export default function GoalRingsCard({ goals = [], title, onPick, size = 176, maxRings = 6 }) {
  const usable = goals.filter(Boolean);
  if (!usable.length) return null;
  // North Star outermost, then by existing order; cap the rings so they stay legible.
  const ordered = [...usable].sort((a, b) => (b.isNorthStar ? 1 : 0) - (a.isNorthStar ? 1 : 0));
  const shown = ordered.slice(0, maxRings);
  const extra = ordered.length - shown.length;
  const rings = shown.map((g) => ({ pct: g.progress?.pct, color: goalState(g, g.progress || {}).tone }));

  return (
    <div style={card}>
      <div style={{ flexShrink: 0, position: 'relative', width: size, height: size, alignSelf: 'center' }}>
        <ActivityRings rings={rings} size={size} onPick={(i) => onPick?.(shown[i])} />
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 11 }}>
        {title && <div style={{ fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>{title}</div>}
        {shown.map((g) => {
          const p = g.progress || {};
          const { tone, chip } = goalState(g, p);
          return (
            <button key={g.id} onClick={() => onPick?.(g)} style={legendRow} className="lift">
              <span style={{ width: 9, height: 9, borderRadius: 980, background: tone, flexShrink: 0, boxShadow: `0 0 6px ${tone}88` }} />
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, gap: 1, textAlign: 'left' }}>
                <span style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {g.isNorthStar && <span title="North Star">⭐</span>}{g.name}
                </span>
                <span style={{ fontSize: 16, fontWeight: 800, color: tone, lineHeight: 1.1 }}>
                  {fmtVal(p.value, g.unit)}<span style={{ color: 'var(--muted)', fontWeight: 700, fontSize: 12 }}> / {fmtVal(g.targetValue, g.unit)}</span>
                </span>
              </span>
              {chip && <span style={{ flexShrink: 0 }}>{chip}</span>}
            </button>
          );
        })}
        {extra > 0 && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>+{extra} more</span>}
      </div>
    </div>
  );
}

const card = { display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap', background: 'var(--tile-bg, var(--card))', border: '1px solid var(--border)', borderRadius: 18, boxShadow: 'var(--shadow-sm)', padding: '18px 20px', color: 'var(--text)' };
const legendRow = { display: 'flex', alignItems: 'center', gap: 9, background: 'transparent', border: 'none', padding: '2px 0', cursor: 'pointer', width: '100%', color: 'var(--text)', fontFamily: 'inherit' };
