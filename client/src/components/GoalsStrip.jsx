import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import GoalEditor from './GoalEditor.jsx';

// The Goals strip on the client home (the Results pillar, surfaced). Goals live
// per event (suite), so this shows each of the client's events with goals — the
// North Star leading, secondary goals below, each with a progress bar + a pace
// chip (ahead / on track / behind, or the final result band). "Set a goal" opens
// the dual-surface editor. Renders nothing when there's nothing to show and the
// viewer can't add goals (keeps the home uncluttered).
export default function GoalsStrip({ entityId, suites }) {
  const [bySuite, setBySuite] = useState({}); // suiteId -> { goals, canManage }
  const [editor, setEditor] = useState(null); // { suiteId, goal } | null

  const list = suites || [];
  const loadSuite = useCallback((sid) => {
    api.suiteGoals(sid).then((r) => setBySuite((m) => ({ ...m, [sid]: r }))).catch(() => {});
  }, []);
  useEffect(() => { list.forEach((s) => loadSuite(s.id)); }, [list.map((s) => s.id).join(','), loadSuite]); // eslint-disable-line react-hooks/exhaustive-deps

  // Show an event row if it has goals OR the viewer can add them.
  const rows = list.map((s) => ({ suite: s, ...(bySuite[s.id] || { goals: [], canManage: false }) }))
    .filter((r) => (r.goals && r.goals.length) || r.canManage);
  if (!rows.length) return null;

  const multi = rows.length > 1;
  return (
    <>
      <h2 style={head}><span>🎯</span>Your goals</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {rows.map(({ suite, goals = [], canManage }) => {
          const north = goals.find((g) => g.isNorthStar);
          const others = goals.filter((g) => !g.isNorthStar);
          return (
            <div key={suite.id} style={card}>
              {multi && <div style={eventName}>{suite.name}</div>}
              {north && <GoalRow goal={north} hero onClick={canManage ? () => setEditor({ suiteId: suite.id, goal: north }) : null} />}
              {others.map((g) => <GoalRow key={g.id} goal={g} onClick={canManage ? () => setEditor({ suiteId: suite.id, goal: g }) : null} />)}
              {!goals.length && (
                <div style={{ fontSize: 13, color: 'var(--muted)', padding: '4px 2px 2px' }}>
                  No goals set for {suite.name} yet.
                </div>
              )}
              {canManage && (
                <button onClick={() => setEditor({ suiteId: suite.id, goal: null })} style={addBtn}>
                  ＋ {goals.length ? 'Add a goal' : `Set your first goal for ${suite.name}`}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {editor && (
        <GoalEditor
          entityId={entityId}
          suiteId={editor.suiteId}
          goal={editor.goal}
          onClose={() => setEditor(null)}
          onSaved={() => loadSuite(editor.suiteId)}
        />
      )}
    </>
  );
}

function GoalRow({ goal, hero, onClick }) {
  const p = goal.progress || {};
  const tone = paceTone(p);
  const viz = goal.display || 'bar';
  const clickable = !!onClick;
  const chip = p.band ? <Chip {...bandChip(p.band)} /> : (p.status && p.status !== 'final' ? <Chip {...statusChip(p.status)} /> : null);
  const title = (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
      {hero && <span title="North Star" style={{ fontSize: 14 }}>⭐</span>}
      <span style={{ fontSize: hero ? 15 : 13.5, fontWeight: hero ? 800 : 600, flex: 1, minWidth: 0 }}>{goal.name}</span>
      {chip}
    </div>
  );
  const values = (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: hero ? 4 : 2, flexWrap: 'wrap' }}>
      <span style={{ fontSize: hero ? 20 : 15, fontWeight: 800 }}>{fmtVal(p.value, goal.unit)}</span>
      <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
        of {fmtVal(goal.targetValue, goal.unit)}{viz === 'bar' && p.pct != null ? ` · ${p.pct}%` : ''}
      </span>
    </div>
  );
  const rowProps = {
    role: clickable ? 'button' : undefined, tabIndex: clickable ? 0 : undefined,
    onClick: onClick || undefined,
    onKeyDown: clickable ? (e) => { if (e.key === 'Enter') onClick(); } : undefined,
    style: { padding: hero ? '12px 4px 14px' : '10px 4px', borderTop: hero ? 'none' : '1px solid var(--hairline)', cursor: clickable ? 'pointer' : 'default' },
  };
  if (viz === 'bar') {
    return <div {...rowProps}>{title}{values}<Bar pct={p.pct} tone={tone} /></div>;
  }
  const size = hero ? 78 : 60;
  return (
    <div {...rowProps}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>{title}{values}</div>
        <div style={{ flexShrink: 0 }}>{viz === 'ring' ? <Ring pct={p.pct} tone={tone} size={size} /> : <Dial pct={p.pct} tone={tone} size={size} />}</div>
      </div>
    </div>
  );
}

function Bar({ pct, tone }) {
  const w = Math.max(0, Math.min(100, Math.round(pct || 0)));
  return (
    <div style={{ height: 7, borderRadius: 980, background: 'rgba(128,128,128,0.16)', overflow: 'hidden', marginTop: 7 }}>
      <div style={{ height: '100%', width: `${w}%`, background: tone, borderRadius: 980, transition: 'width .4s ease' }} />
    </div>
  );
}
function Chip({ t, c, bg }) {
  return <span style={{ fontSize: 10.5, fontWeight: 700, borderRadius: 980, padding: '2px 9px', background: bg, color: c, flexShrink: 0 }}>{t}</span>;
}

// Circular progress ring with the % in the centre.
function Ring({ pct, tone, size = 60 }) {
  const w = Math.max(0, Math.min(100, Math.round(pct || 0)));
  const sw = 6, r = (size - sw) / 2, c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(128,128,128,0.18)" strokeWidth={sw} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth={sw} strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - w / 100)} transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset .5s ease' }} />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" fontSize={size * 0.27} fontWeight="800" fill="var(--text)">{w}%</text>
    </svg>
  );
}

// Half-circle gauge (speedometer style); fills left→right with the % below.
function Dial({ pct, tone, size = 60 }) {
  const w = Math.max(0, Math.min(100, Math.round(pct || 0)));
  const sw = 7, r = (size - sw) / 2, cx = size / 2, cy = size / 2;
  const at = (frac) => { const a = Math.PI - Math.PI * frac; return [cx + r * Math.cos(a), cy - r * Math.sin(a)]; };
  const [sx, sy] = at(0), [ex, ey] = at(1), [px, py] = at(w / 100);
  const arc = (x, y) => `M ${sx.toFixed(1)} ${sy.toFixed(1)} A ${r} ${r} 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)}`;
  const h = Math.ceil(cy + size * 0.24);
  return (
    <svg width={size} height={h} viewBox={`0 0 ${size} ${h}`} aria-hidden="true">
      <path d={arc(ex, ey)} fill="none" stroke="rgba(128,128,128,0.18)" strokeWidth={sw} strokeLinecap="round" />
      {w > 0 && <path d={arc(px, py)} fill="none" stroke={tone} strokeWidth={sw} strokeLinecap="round" style={{ transition: 'all .5s ease' }} />}
      <text x={cx} y={cy + 1} textAnchor="middle" fontSize={size * 0.22} fontWeight="800" fill="var(--text)">{w}%</text>
    </svg>
  );
}

const GREEN = '#2da44e', BLUE = '#0a66c2', AMBER = '#b45309', RED = '#dc2626';
function paceTone(p) {
  if (p.band) return ({ smashed: GREEN, hit: GREEN, near: AMBER, missed: RED })[p.band] || BLUE;
  if (p.status === 'behind') return AMBER;
  if (p.status === 'ahead') return GREEN;
  return BLUE;
}
const statusChip = (s) => ({
  ahead: { t: 'Ahead', c: GREEN, bg: 'rgba(52,199,89,0.15)' },
  on_track: { t: 'On track', c: BLUE, bg: 'rgba(10,132,255,0.13)' },
  behind: { t: 'Behind', c: AMBER, bg: 'rgba(245,158,11,0.16)' },
}[s] || { t: s, c: BLUE, bg: 'rgba(10,132,255,0.13)' });
const bandChip = (b) => ({
  smashed: { t: '🎉 Smashed', c: GREEN, bg: 'rgba(52,199,89,0.16)' },
  hit: { t: '✓ Hit', c: GREEN, bg: 'rgba(52,199,89,0.16)' },
  near: { t: 'Just missed', c: AMBER, bg: 'rgba(245,158,11,0.16)' },
  missed: { t: 'Missed', c: RED, bg: 'rgba(239,68,68,0.12)' },
}[b] || { t: b, c: BLUE, bg: 'rgba(10,132,255,0.13)' });

function fmtVal(v, unit) {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (unit === '%') return `${n}%`;
  const s = Math.abs(n) >= 1000 ? n.toLocaleString('en-ZA') : String(n);
  if (unit === 'ZAR') return `R${s}`;
  return unit && unit !== 'count' ? `${s} ${unit}` : s;
}

const head = { fontSize: 14, fontWeight: 800, letterSpacing: '-0.01em', margin: '22px 0 10px', display: 'flex', alignItems: 'center', gap: 7 };
const card = { background: 'var(--tile-bg, var(--card))', border: '1px solid var(--border)', borderRadius: 16, boxShadow: 'var(--shadow-sm)', padding: '6px 16px 14px' };
const eventName = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', padding: '12px 2px 2px' };
const addBtn = { marginTop: 10, width: '100%', padding: '9px 12px', borderRadius: 10, border: '1px dashed var(--border)', background: 'transparent', color: 'var(--brand)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' };
