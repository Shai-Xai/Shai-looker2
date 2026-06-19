import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import GoalEditor from './GoalEditor.jsx';

// The Goals strip on the client home (the Results pillar, surfaced). Goals live
// per event (suite); each event shows a horizontal strip of compact goal cards
// (like the pinned tiles) — the North Star leads, each card has its progress as
// a bar / circle / dial + a pace chip. "Set a goal" opens the dual-surface
// editor. The whole section can be dismissed per client (remembered locally).
// Renders nothing when there's nothing to show, nothing to manage, or dismissed.
export default function GoalsStrip({ entityId, suites }) {
  const [bySuite, setBySuite] = useState({}); // suiteId -> { goals, canManage }
  const [editor, setEditor] = useState(null); // { suiteId, goal } | null
  const [hidden, setHidden] = useState(true);  // start hidden until we read the flag
  const hideKey = `howler_goals_hidden:${entityId}`;
  useEffect(() => { setHidden(!!(entityId && localStorage.getItem(hideKey))); }, [hideKey, entityId]);

  const list = suites || [];
  const loadSuite = useCallback((sid) => {
    api.suiteGoals(sid).then((r) => setBySuite((m) => ({ ...m, [sid]: r }))).catch(() => {});
  }, []);
  useEffect(() => { list.forEach((s) => loadSuite(s.id)); }, [list.map((s) => s.id).join(','), loadSuite]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = list.map((s) => ({ suite: s, ...(bySuite[s.id] || { goals: [], canManage: false }) }))
    .filter((r) => (r.goals && r.goals.length) || r.canManage);
  if (!rows.length || hidden) return null;

  const dismiss = () => { try { localStorage.setItem(hideKey, '1'); } catch { /* ignore */ } setHidden(true); };
  const multi = rows.length > 1;
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, margin: '22px 0 10px' }}>
        <h2 style={{ fontSize: 14, fontWeight: 800, letterSpacing: '-0.01em', display: 'flex', alignItems: 'center', gap: 7 }}><span>🎯</span>Your goals</h2>
        <span style={{ flex: 1 }} />
        <button onClick={dismiss} title="Hide goals from your home" aria-label="Hide goals" style={dismissBtn}>✕</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {rows.map(({ suite, goals = [], canManage }) => {
          // North Star leads, then the rest.
          const ordered = [...goals].sort((a, b) => (b.isNorthStar ? 1 : 0) - (a.isNorthStar ? 1 : 0));
          return (
            <div key={suite.id}>
              {multi && <div style={eventName}>{suite.name}</div>}
              <Strip>
                {ordered.map((g) => (
                  <GoalCard key={g.id} goal={g} onClick={canManage ? () => setEditor({ suiteId: suite.id, goal: g }) : null} />
                ))}
                {canManage && (
                  <button onClick={() => setEditor({ suiteId: suite.id, goal: null })} style={addCard}>
                    <span style={{ fontSize: 22, lineHeight: 1 }}>＋</span>
                    <span style={{ fontSize: 12.5, fontWeight: 700 }}>{goals.length ? 'Add a goal' : 'Set a goal'}</span>
                  </button>
                )}
              </Strip>
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

// Horizontal snap strip — one row, scroll for more (like the pinned tiles).
function Strip({ children }) {
  return (
    <div style={{ display: 'flex', gap: 10, overflowX: 'auto', scrollSnapType: 'x proximity', paddingBottom: 4, scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>
      {children}
    </div>
  );
}

function GoalCard({ goal, onClick }) {
  const p = goal.progress || {};
  const tone = paceTone(p);
  const viz = goal.display || 'bar';
  const clickable = !!onClick;
  const chip = p.band ? <Chip {...bandChip(p.band)} /> : (p.status && p.status !== 'final' ? <Chip {...statusChip(p.status)} /> : null);
  return (
    <div
      role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined}
      onClick={onClick || undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter') onClick(); } : undefined}
      style={{ ...card, cursor: clickable ? 'pointer' : 'default' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        {goal.isNorthStar && <span title="North Star" style={{ fontSize: 12 }}>⭐</span>}
        <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{goal.name}</span>
      </div>
      {viz === 'bar' ? (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 17, fontWeight: 800 }}>{fmtVal(p.value, goal.unit)}</div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>of {fmtVal(goal.targetValue, goal.unit)}{p.pct != null ? ` · ${p.pct}%` : ''}</div>
          <Bar pct={p.pct} tone={tone} />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: 6, gap: 3 }}>
          {viz === 'ring' ? <Ring pct={p.pct} tone={tone} size={62} /> : <Dial pct={p.pct} tone={tone} size={66} />}
          <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center' }}>{fmtVal(p.value, goal.unit)} / {fmtVal(goal.targetValue, goal.unit)}</div>
        </div>
      )}
      <div style={{ marginTop: 8, minHeight: 18 }}>{chip}</div>
    </div>
  );
}

function Bar({ pct, tone }) {
  const w = Math.max(0, Math.min(100, Math.round(pct || 0)));
  return (
    <div style={{ height: 6, borderRadius: 980, background: 'rgba(128,128,128,0.16)', overflow: 'hidden', marginTop: 7 }}>
      <div style={{ height: '100%', width: `${w}%`, background: tone, borderRadius: 980, transition: 'width .4s ease' }} />
    </div>
  );
}
function Chip({ t, c, bg }) {
  return <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 980, padding: '2px 8px', background: bg, color: c, whiteSpace: 'nowrap' }}>{t}</span>;
}

// Circular progress ring with the % in the centre.
function Ring({ pct, tone, size = 62 }) {
  const w = Math.max(0, Math.min(100, Math.round(pct || 0)));
  const sw = 6, r = (size - sw) / 2, c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(128,128,128,0.18)" strokeWidth={sw} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth={sw} strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - w / 100)} transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset .5s ease' }} />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" fontSize={size * 0.26} fontWeight="800" fill="var(--text)">{w}%</text>
    </svg>
  );
}

// Half-circle gauge (speedometer style); fills left→right with the % below.
function Dial({ pct, tone, size = 66 }) {
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
      <text x={cx} y={cy + 1} textAnchor="middle" fontSize={size * 0.2} fontWeight="800" fill="var(--text)">{w}%</text>
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

const eventName = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', padding: '0 2px 6px' };
const card = { flex: '0 0 170px', scrollSnapAlign: 'start', boxSizing: 'border-box', minHeight: 118, background: 'var(--tile-bg, var(--card))', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow-sm)', padding: '11px 13px', color: 'var(--text)' };
const addCard = { flex: '0 0 130px', scrollSnapAlign: 'start', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 118, border: '1px dashed var(--border)', borderRadius: 14, background: 'transparent', color: 'var(--brand)', cursor: 'pointer' };
const dismissBtn = { border: 'none', background: 'rgba(128,128,128,0.12)', color: 'var(--muted-2)', borderRadius: 980, width: 26, height: 26, fontSize: 12, cursor: 'pointer', flexShrink: 0 };
