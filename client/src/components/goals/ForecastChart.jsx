import { fmtVal } from './GoalViz.jsx';

// "Last year · this year · forecast" — last time's full cumulative curve (muted), this
// year's actual to date (brand), the projected finish (dashed brand to the event), the
// target (dotted) and a "you are here" dot. Axis is days-before-event when numeric (so
// the two years align by point-in-cycle), else falls back to position.
export default function ForecastChart({ data, unit, w = 440, h = 150 }) {
  const last = (data?.lastYear || []).filter((p) => Number.isFinite(p.y));
  const cur = (data?.thisYear || []).filter((p) => Number.isFinite(p.y));
  if (last.length < 2 && cur.length < 2) return null;
  const isISO = (x) => /^\d{4}-\d{2}/.test(String(x));
  const numeric = last.concat(cur).every((p) => Number.isFinite(Number(p.x)) && !isISO(p.x));

  let lastPts, curPts;
  if (numeric) {
    const maxX = Math.max(...last.concat(cur).map((p) => Number(p.x)), 1);
    const xp = (x) => Math.max(0, Math.min(1, 1 - Number(x) / maxX)); // x=0 (event) → right
    lastPts = last.map((p) => ({ x: xp(p.x), y: p.y })).sort((a, b) => a.x - b.x);
    curPts = cur.map((p) => ({ x: xp(p.x), y: p.y })).sort((a, b) => a.x - b.x);
  } else {
    const N = Math.max(last.length, cur.length, 2);
    const idx = (arr) => arr.map((p, i) => ({ x: (i + (N - arr.length)) / (N - 1), y: p.y })); // align right (event)
    lastPts = idx(last); curPts = idx(cur);
  }
  const projected = Number.isFinite(data?.projected) ? data.projected : null;
  const target = Number.isFinite(data?.target) ? data.target : null;
  const ys = [...lastPts, ...curPts].map((p) => p.y);
  const yMax = Math.max(...ys, target || 0, projected || 0, 1) * 1.08;
  const pad = { l: 6, r: 6, t: 10, b: 8 };
  const X = (xp) => pad.l + xp * (w - pad.l - pad.r);
  const Y = (y) => h - pad.b - (y / yMax) * (h - pad.t - pad.b);
  const line = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
  const now = curPts.length ? curPts[curPts.length - 1] : null;
  const fcPath = (now && projected != null) ? `M${X(now.x).toFixed(1)},${Y(now.y).toFixed(1)} L${X(1).toFixed(1)},${Y(projected).toFixed(1)}` : null;
  const MUTED = 'rgba(128,128,128,0.55)';

  return (
    <div>
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }} aria-hidden="true">
        {target != null && (
          <g>
            <line x1={pad.l} x2={w - pad.r} y1={Y(target)} y2={Y(target)} stroke={MUTED} strokeWidth="1" strokeDasharray="2 3" />
          </g>
        )}
        {lastPts.length >= 2 && <path d={line(lastPts)} fill="none" stroke={MUTED} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />}
        {fcPath && <path d={fcPath} fill="none" stroke="var(--brand)" strokeWidth="1.75" strokeDasharray="4 3" strokeLinecap="round" opacity="0.8" />}
        {curPts.length >= 2 && <path d={line(curPts)} fill="none" stroke="var(--brand)" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />}
        {projected != null && <circle cx={X(1)} cy={Y(projected)} r="3" fill="var(--brand)" opacity="0.85" />}
        {now && <circle cx={X(now.x)} cy={Y(now.y)} r="3.5" fill="var(--brand)" stroke="var(--card)" strokeWidth="1.5" />}
      </svg>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 10.5, color: 'var(--muted)', marginTop: 4 }}>
        <Key color={MUTED}>last time{data?.lastKey ? ` (${data.lastKey})` : ''}</Key>
        <Key color="var(--brand)">this year</Key>
        <Key color="var(--brand)" dashed>forecast{projected != null ? ` ≈ ${fmtVal(projected, unit)}` : ''}</Key>
        {target != null && <Key color={MUTED} dotted>target {fmtVal(target, unit)}</Key>}
      </div>
    </div>
  );
}

function Key({ color, dashed, dotted, children }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 14, height: 0, borderTop: `2px ${dotted ? 'dotted' : dashed ? 'dashed' : 'solid'} ${color}`, display: 'inline-block' }} />
      {children}
    </span>
  );
}
