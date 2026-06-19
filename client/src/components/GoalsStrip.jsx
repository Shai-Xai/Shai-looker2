import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
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
  const [params, setParams] = useSearchParams();
  const [hidden, setHidden] = useState(true);  // start hidden until we read the flag
  const hideKey = `howler_goals_hidden:${entityId}`;
  useEffect(() => { setHidden(!!(entityId && localStorage.getItem(hideKey))); }, [hideKey, entityId]);
  // Per-event dismiss (when a client has several events) — remembered locally.
  const suitesHideKey = `howler_goals_suites_hidden:${entityId}`;
  const [dismissedSuites, setDismissedSuites] = useState([]);
  useEffect(() => { try { setDismissedSuites(JSON.parse(localStorage.getItem(suitesHideKey) || '[]')); } catch { setDismissedSuites([]); } }, [suitesHideKey]);
  const dismissSuite = (sid) => setDismissedSuites((d) => { const next = [...new Set([...d, sid])]; try { localStorage.setItem(suitesHideKey, JSON.stringify(next)); } catch { /* ignore */ } return next; });

  const list = suites || [];
  const dragId = useRef(null); // id of the card being dragged
  const loadSuite = useCallback((sid) => {
    api.suiteGoals(sid).then((r) => setBySuite((m) => ({ ...m, [sid]: r }))).catch(() => {});
  }, []);

  // Drag-to-reorder within an event: move the dragged goal before the drop target,
  // renumber positions, optimistically reorder, and persist each new position.
  const reorder = (suiteId, fromId, toId) => {
    if (!fromId || fromId === toId) return;
    setBySuite((m) => {
      const r = m[suiteId];
      if (!r) return m;
      const goals = [...r.goals];
      const fi = goals.findIndex((g) => g.id === fromId);
      const ti = goals.findIndex((g) => g.id === toId);
      if (fi < 0 || ti < 0) return m;
      const [moved] = goals.splice(fi, 1);
      goals.splice(ti, 0, moved);
      goals.forEach((g, i) => { if (g.position !== i) api.updateGoal(g.id, { position: i }).catch(() => {}); });
      return { ...m, [suiteId]: { ...r, goals: goals.map((g, i) => ({ ...g, position: i })) } };
    });
  };
  useEffect(() => { list.forEach((s) => loadSuite(s.id)); }, [list.map((s) => s.id).join(','), loadSuite]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = list.map((s) => ({ suite: s, ...(bySuite[s.id] || { goals: [], canManage: false }) }))
    .filter((r) => ((r.goals && r.goals.length) || r.canManage) && !dismissedSuites.includes(r.suite.id));
  // Manageable events — the options for the editor's "which event?" picker (kept
  // even if an event is dismissed from the home, so you can still add to it).
  const manageableSuites = list.map((s) => ({ suite: s, ...(bySuite[s.id] || {}) })).filter((r) => r.canManage).map((r) => ({ id: r.suite.id, name: r.suite.name }));

  // Deep link from onboarding / the Learn wizard: /?goals=new opens the editor
  // (un-hiding the section if it was dismissed). Waits for the suites to load.
  useEffect(() => {
    if (params.get('goals') !== 'new' || !Object.keys(bySuite).length) return;
    const target = rows.find((r) => r.canManage);
    if (hidden) { try { localStorage.removeItem(hideKey); } catch { /* ignore */ } setHidden(false); }
    if (target) setEditor({ suiteId: target.suite.id, goal: null });
    const next = new URLSearchParams(params); next.delete('goals'); setParams(next, { replace: true });
  }, [params, rows.length, hidden]); // eslint-disable-line react-hooks/exhaustive-deps

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
          const canDrag = canManage && goals.length > 1; // reorder only when there's a point
          return (
            <div key={suite.id}>
              {multi && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 6 }}>
                  <span style={eventName}>{suite.name}</span>
                  <button onClick={() => dismissSuite(suite.id)} title={`Hide ${suite.name} goals`} aria-label="Hide this event's goals" style={miniX}>✕</button>
                </div>
              )}
              <Strip>
                {goals.map((g, i) => (
                  <GoalCard key={g.id} goal={g} index={i}
                    onClick={canManage ? () => setEditor({ suiteId: suite.id, goal: g }) : null}
                    draggable={canDrag}
                    onDragStartCard={() => { dragId.current = g.id; }}
                    onDropCard={() => reorder(suite.id, dragId.current, g.id)} />
                ))}
                {canManage && (
                  <button className="lift msg-in" onClick={() => setEditor({ suiteId: suite.id, goal: null })} style={{ ...addCard, animationDelay: `${goals.length * 60}ms` }}>
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
          suites={manageableSuites}
          goal={editor.goal}
          onClose={() => setEditor(null)}
          onSaved={() => list.forEach((s) => loadSuite(s.id))}
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

function GoalCard({ goal, onClick, index = 0, draggable = false, onDragStartCard, onDropCard }) {
  const p = goal.progress || {};
  const { tone, chip } = goalState(goal, p);
  const viz = goal.display || 'bar';
  const clickable = !!onClick;
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
function Ring({ pct, tone, size = 78 }) {
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
function Dial({ pct, tone, size = 86 }) {
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

const GREEN = '#2da44e', BLUE = '#0a66c2', AMBER = '#b45309', RED = '#dc2626';
const bandTone = (b) => ({ smashed: GREEN, hit: GREEN, near: AMBER, missed: RED }[b] || BLUE);
// Colour + chip from the goal's state: GREEN once the target is reached, RED when
// an "under a cap" goal goes over, AMBER when behind pace, BLUE while in progress,
// and the result band once the deadline has passed.
function goalState(goal, p) {
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

const eventName = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', padding: '0 2px' };
const miniX = { border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 11, lineHeight: 1, padding: 2, flexShrink: 0 };
const card = { flex: '0 0 172px', scrollSnapAlign: 'start', boxSizing: 'border-box', minHeight: 138, display: 'flex', flexDirection: 'column', background: 'var(--tile-bg, var(--card))', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow-sm)', padding: '11px 13px', color: 'var(--text)' };
const addCard = { flex: '0 0 124px', scrollSnapAlign: 'start', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 138, border: '1px dashed var(--border)', borderRadius: 14, background: 'transparent', color: 'var(--brand)', cursor: 'pointer' };
const dismissBtn = { border: 'none', background: 'rgba(128,128,128,0.12)', color: 'var(--muted-2)', borderRadius: 980, width: 26, height: 26, fontSize: 12, cursor: 'pointer', flexShrink: 0 };
