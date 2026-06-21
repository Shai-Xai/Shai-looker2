import { useRef, useState } from 'react';
import { fmtVal } from './GoalViz.jsx';

// Linear-interpolate a series of {x,y} (sorted by x) at x=xq.
function interpAt(pts, xq) {
  if (!pts || !pts.length) return null;
  if (xq <= pts[0].x) return pts[0].y;
  if (xq >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].x >= xq) { const a = pts[i - 1], b = pts[i]; const f = (xq - a.x) / ((b.x - a.x) || 1); return a.y + (b.y - a.y) * f; }
  }
  return pts[pts.length - 1].y;
}

// "Last year · this year · forecast" — last time's full cumulative curve (muted), this
// year's actual to date (brand), the projected finish (dashed brand to the event), the
// target (dotted) and a "you are here" dot. Axis is days-before-event when numeric (so
// the two years align by point-in-cycle), else falls back to position.
export default function ForecastChart({ data, unit, w = 440, h = 150 }) {
  const svgRef = useRef(null);
  const [hover, setHover] = useState(null); // { xp, px } while inspecting
  const projected = Number.isFinite(data?.projected) ? data.projected : null;
  const target = Number.isFinite(data?.target) ? data.target : null;
  const cycleDays = Number.isFinite(data?.positioned?.cycleDays) ? data.positioned.cycleDays : null;

  // Prefer the server-positioned coordinates (0..1 x, where 1 = event) — they're
  // computed where daysLeft + the real axis are known, so the forecast curve always
  // has room. Fall back to positioning from raw x labels for older payloads.
  let lastPts, curPts, fcPts;
  const pos = data?.positioned;
  if (pos && (Array.isArray(pos.last) || Array.isArray(pos.cur))) {
    lastPts = (pos.last || []).filter((p) => Number.isFinite(p.y));
    curPts = (pos.cur || []).filter((p) => Number.isFinite(p.y));
    fcPts = (pos.forecast || []).filter((p) => Number.isFinite(p.y));
    if (!fcPts.length) fcPts = null;
    if (lastPts.length < 2 && curPts.length < 2) return null;
  } else {
    const last = (data?.lastYear || []).filter((p) => Number.isFinite(p.y));
    const cur = (data?.thisYear || []).filter((p) => Number.isFinite(p.y));
    if (last.length < 2 && cur.length < 2) return null;
    const isISO = (x) => /^\d{4}-\d{2}/.test(String(x));
    const numeric = last.concat(cur).every((p) => Number.isFinite(Number(p.x)) && !isISO(p.x));
    const dated = !numeric && last.concat(cur).every((p) => isISO(p.x) && !Number.isNaN(Date.parse(p.x)));
    const daysLeft = Number.isFinite(data?.daysLeft) ? Math.max(0, data.daysLeft) : null;
    if (numeric) {
      const maxX = Math.max(...last.concat(cur).map((p) => Number(p.x)), 1);
      const xp = (x) => Math.max(0, Math.min(1, 1 - Number(x) / maxX)); // x=0 (event) → right
      lastPts = last.map((p) => ({ x: xp(p.x), y: p.y })).sort((a, b) => a.x - b.x);
      curPts = cur.map((p) => ({ x: xp(p.x), y: p.y })).sort((a, b) => a.x - b.x);
    } else if (dated && daysLeft != null) {
      const day = 86400000;
      const cd = cur.map((p) => ({ t: Date.parse(p.x), y: p.y })).sort((a, b) => a.t - b.t);
      const ld = last.map((p) => ({ t: Date.parse(p.x), y: p.y })).sort((a, b) => a.t - b.t);
      const ty0 = cd[0]?.t, tyNow = cd[cd.length - 1]?.t;
      const total = (tyNow - ty0) / day + daysLeft;
      const ly0 = ld[0]?.t, lyEnd = ld[ld.length - 1]?.t; const lspan = (lyEnd - ly0) || 1;
      lastPts = ld.map((p) => ({ x: (p.t - ly0) / lspan, y: p.y }));
      curPts = total > 0 ? cd.map((p) => ({ x: (p.t - ty0) / (total * day), y: p.y })) : cd.map((p, i) => ({ x: i / Math.max(cd.length - 1, 1), y: p.y }));
    } else {
      const nowFrac = daysLeft != null && (cur.length + daysLeft) > 0 ? Math.min(1, (cur.length - 1) / (cur.length - 1 + daysLeft)) : 1;
      lastPts = last.map((p, i) => ({ x: (last.length > 1 ? i / (last.length - 1) : 0), y: p.y }));
      curPts = cur.map((p, i) => ({ x: (cur.length > 1 ? (i / (cur.length - 1)) * nowFrac : 0), y: p.y }));
    }
    const nowL = curPts.length ? curPts[curPts.length - 1] : null;
    const interp = (pts, xq) => {
      if (!pts.length) return null;
      if (xq <= pts[0].x) return pts[0].y;
      if (xq >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
      for (let i = 1; i < pts.length; i++) { if (pts[i].x >= xq) { const a = pts[i - 1], b = pts[i]; const t = (xq - a.x) / ((b.x - a.x) || 1); return a.y + (b.y - a.y) * t; } }
      return pts[pts.length - 1].y;
    };
    fcPts = null;
    if (nowL && lastPts.length >= 2) {
      const Lnow = interp(lastPts, nowL.x);
      if (Lnow && Lnow > 0) {
        const ahead = lastPts.filter((p) => p.x > nowL.x).map((p) => ({ x: p.x, y: (nowL.y * p.y) / Lnow }));
        fcPts = [{ x: nowL.x, y: nowL.y }, ...ahead];
        if (fcPts[fcPts.length - 1].x < 0.999) fcPts.push({ x: 1, y: (nowL.y * interp(lastPts, 1)) / Lnow });
      }
    }
    if (!fcPts && nowL && projected != null) fcPts = [{ x: nowL.x, y: nowL.y }, { x: 1, y: projected }];
  }

  const now = curPts.length ? curPts[curPts.length - 1] : null;
  const fcEndY = (fcPts && fcPts.length) ? fcPts[fcPts.length - 1].y : projected;

  // Target PACE line: last year's shape scaled up to the target (the increase), so
  // it hugs last year and lands exactly on the target at the event. Track actual +
  // forecast against this to see "ahead / behind the line you need for target".
  let tgtPace = null;
  if (target != null && lastPts.length >= 2) {
    const lastTotal = lastPts[lastPts.length - 1].y || Math.max(...lastPts.map((p) => p.y));
    if (lastTotal > 0) tgtPace = lastPts.map((p) => ({ x: p.x, y: (target * p.y) / lastTotal }));
  }

  const ys = [...lastPts, ...curPts, ...(fcPts || []), ...(tgtPace || [])].map((p) => p.y);
  const yMax = Math.max(...ys, target || 0, projected || 0, 1) * 1.08;
  const pad = { l: 6, r: 6, t: 10, b: cycleDays != null ? 18 : 8 }; // room for days-before labels
  const X = (xp) => pad.l + xp * (w - pad.l - pad.r);
  const Y = (y) => h - pad.b - (y / yMax) * (h - pad.t - pad.b);
  const line = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
  const MUTED = 'rgba(128,128,128,0.55)';
  const FC = '#f59e0b'; // forecast — distinct from the brand "actual" line
  const TGT = '#16a34a'; // target reference line — its own colour, distinct from "last time"
  const nowX = now ? now.x : null;
  const tipUnit = (unit === 'ZAR' || unit === '%') ? unit : ''; // keep R/% prefix; drop long word units

  // Pointer/touch inspection: map the cursor to an x-fraction, then read each
  // series' value there (so a flat stretch reads as "no change those days").
  const onMove = (clientX) => {
    const el = svgRef.current; if (!el) return;
    const rect = el.getBoundingClientRect();
    const vbX = ((clientX - rect.left) / rect.width) * w;
    const xp = Math.max(0, Math.min(1, (vbX - pad.l) / (w - pad.l - pad.r)));
    setHover({ xp, px: clientX - rect.left, cw: rect.width });
  };
  // Days-before-event ticks for the x-axis (when we know the cycle length).
  const ticks = cycleDays != null ? [0, 0.5, 1].map((xp) => ({ xp, d: Math.max(0, Math.round((1 - xp) * cycleDays)) })) : [];
  let hv = null;
  if (hover) {
    const xp = hover.xp;
    const actualY = curPts.length >= 2 && (nowX == null || xp <= nowX + 1e-6) ? interpAt(curPts, xp) : null;
    const lastY = lastPts.length >= 2 ? interpAt(lastPts, xp) : null;
    const fcY = fcPts && fcPts.length >= 2 && nowX != null && xp >= nowX - 1e-6 ? interpAt(fcPts, xp) : null;
    const tgtY = tgtPace ? interpAt(tgtPace, xp) : null;
    const daysToGo = cycleDays != null ? Math.max(0, Math.round((1 - xp) * cycleDays)) : null;
    hv = { xp, px: hover.px, cw: hover.cw, actualY, lastY, fcY, tgtY, daysToGo };
  }

  return (
    <div style={{ position: 'relative' }}>
      <svg
        ref={svgRef} width="100%" viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', touchAction: 'none' }}
        onMouseMove={(e) => onMove(e.clientX)} onMouseLeave={() => setHover(null)}
        onTouchStart={(e) => { if (e.touches[0]) onMove(e.touches[0].clientX); }}
        onTouchMove={(e) => { if (e.touches[0]) onMove(e.touches[0].clientX); }}
        onTouchEnd={() => setHover(null)}
      >
        {/* Target pace — last year's shape scaled to the target (hugs last year,
            lands on target). Falls back to a flat target line with no last-year shape. */}
        {tgtPace ? (
          <path d={line(tgtPace)} fill="none" stroke={TGT} strokeWidth="1.75" strokeDasharray="5 3" opacity="0.9" strokeLinejoin="round" strokeLinecap="round" />
        ) : target != null && (
          <line x1={pad.l} x2={w - pad.r} y1={Y(target)} y2={Y(target)} stroke={TGT} strokeWidth="1.5" strokeDasharray="5 3" opacity="0.9" />
        )}
        {/* "you are here" divider — actual to its left, forecast to its right */}
        {now && <line x1={X(now.x)} x2={X(now.x)} y1={pad.t} y2={h - pad.b} stroke={MUTED} strokeWidth="0.75" strokeDasharray="1 3" />}
        {lastPts.length >= 2 && <path d={line(lastPts)} fill="none" stroke={MUTED} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />}
        {fcPts && fcPts.length >= 2 && <path d={line(fcPts)} fill="none" stroke={FC} strokeWidth="2" strokeDasharray="4 3" strokeLinejoin="round" strokeLinecap="round" />}
        {curPts.length >= 2 && <path d={line(curPts)} fill="none" stroke="var(--brand)" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />}
        {fcEndY != null && <circle cx={X(1)} cy={Y(fcEndY)} r="3" fill={FC} opacity="0.9" />}
        {now && <circle cx={X(now.x)} cy={Y(now.y)} r="3.5" fill="var(--brand)" stroke="var(--card)" strokeWidth="1.5" />}
        {/* hover guide + markers */}
        {hv && (
          <g pointerEvents="none">
            <line x1={X(hv.xp)} x2={X(hv.xp)} y1={pad.t} y2={h - pad.b} stroke="var(--text)" strokeOpacity="0.35" strokeWidth="1" />
            {hv.tgtY != null && <circle cx={X(hv.xp)} cy={Y(hv.tgtY)} r="3" fill={TGT} />}
            {hv.lastY != null && <circle cx={X(hv.xp)} cy={Y(hv.lastY)} r="3" fill={MUTED} />}
            {hv.fcY != null && <circle cx={X(hv.xp)} cy={Y(hv.fcY)} r="3" fill={FC} />}
            {hv.actualY != null && <circle cx={X(hv.xp)} cy={Y(hv.actualY)} r="3.5" fill="var(--brand)" stroke="var(--card)" strokeWidth="1.5" />}
          </g>
        )}
        {/* x-axis: days before the event (0 = event day) */}
        {ticks.map((t, i) => (
          <text key={i} x={X(t.xp)} y={h - 5} fontSize="8" fill={MUTED}
            textAnchor={t.xp <= 0 ? 'start' : t.xp >= 1 ? 'end' : 'middle'}>
            {t.xp >= 1 ? 'event' : `${t.d}d before`}
          </text>
        ))}
      </svg>
      {hv && (() => {
        const cw = hv.cw || 280; const tipW = Math.min(150, cw - 8);
        const left = Math.max(4, Math.min(hv.px - tipW / 2, cw - tipW - 4));
        return (
          <div style={{
            position: 'absolute', top: 2, left, width: 'max-content', maxWidth: tipW, pointerEvents: 'none', zIndex: 2,
            background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 8,
            boxShadow: '0 6px 18px rgba(0,0,0,0.18)', padding: '6px 9px', fontSize: 11, lineHeight: 1.5,
          }}>
            <div style={{ fontWeight: 700, color: 'var(--muted)', marginBottom: 2 }}>
              {hv.daysToGo != null ? (hv.daysToGo === 0 ? 'event day' : `${hv.daysToGo}d before event`) : `${Math.round(hv.xp * 100)}% through`}
            </div>
            {hv.actualY != null && <TipRow color="var(--brand)" label="actual" val={fmtVal(Math.round(hv.actualY), tipUnit)} />}
            {hv.fcY != null && <TipRow color={FC} label="forecast" val={fmtVal(Math.round(hv.fcY), tipUnit)} />}
            {hv.tgtY != null && <TipRow color={TGT} label="target pace" val={fmtVal(Math.round(hv.tgtY), tipUnit)} />}
            {hv.lastY != null && <TipRow color={MUTED} label="last time" val={fmtVal(Math.round(hv.lastY), tipUnit)} />}
          </div>
        );
      })()}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 10.5, color: 'var(--muted)', marginTop: 4 }}>
        <Key color={MUTED}>last time{data?.lastKey ? ` (${data.lastKey})` : ''}</Key>
        <Key color="var(--brand)">actual</Key>
        <Key color={FC} dashed>forecast{projected != null ? ` ≈ ${fmtVal(projected, unit)}` : ''}</Key>
        {target != null && <Key color={TGT} dashed>{tgtPace ? 'target pace' : 'target'} {fmtVal(target, unit)}</Key>}
      </div>
    </div>
  );
}

function TipRow({ color, label, val }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span style={{ marginLeft: 'auto', fontWeight: 700, color: 'var(--text)' }}>{val}</span>
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
