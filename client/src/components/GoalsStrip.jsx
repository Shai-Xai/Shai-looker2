import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { vtNavigate } from '../lib/viewTransition.js';
import { GoalCard, Strip } from './goals/GoalViz.jsx';

// The Goals strip on the client home — a TEASER for the Results pillar. It shows a
// compact, horizontal strip of goal cards per event (the North Star leads), but the
// full surface is the dedicated Goals page (/goals): tapping a card opens that
// goal's detail there, and "Set a goal" / "See all" link through. This keeps the
// home glanceable and means a tap never springs the editor on mobile (the cards
// used to open the editor directly — the mobile trap we're fixing). Desktop keeps
// drag-to-reorder. The whole section can be dismissed per client (remembered
// locally), and individual events dismissed when a client has several.
export default function GoalsStrip({ entityId, suites }) {
  const navigate = useNavigate();
  const [bySuite, setBySuite] = useState({}); // suiteId -> { goals, canManage }
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
    api.suiteGoals(sid, true).then((r) => setBySuite((m) => ({ ...m, [sid]: r }))).catch(() => {});
  }, []);

  // Drag-to-reorder within an event (desktop): move the dragged goal before the
  // drop target, renumber positions, optimistically reorder, and persist each one.
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

  // Deep link from onboarding / the Learn wizard: /?goals=new → the Goals page's
  // new-goal editor (the page owns the editor now). Waits for the suites to load.
  useEffect(() => {
    if (params.get('goals') !== 'new' || !Object.keys(bySuite).length) return;
    const target = rows.find((r) => r.canManage);
    const next = new URLSearchParams(params); next.delete('goals'); setParams(next, { replace: true });
    if (hidden) { try { localStorage.removeItem(hideKey); } catch { /* ignore */ } setHidden(false); }
    if (target) vtNavigate(navigate, `/goals?new=${target.suite.id}`);
    else vtNavigate(navigate, '/goals');
  }, [params, rows.length, hidden]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!rows.length || hidden) return null;

  const dismiss = () => { try { localStorage.setItem(hideKey, '1'); } catch { /* ignore */ } setHidden(true); };
  const multi = rows.length > 1;
  const openGoal = (id) => vtNavigate(navigate, `/goals?goal=${id}`);
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, margin: '22px 0 10px' }}>
        <h2 style={{ fontSize: 14, fontWeight: 800, letterSpacing: '-0.01em', display: 'flex', alignItems: 'center', gap: 7 }}><span>🎯</span>Your goals</h2>
        <button onClick={() => vtNavigate(navigate, '/goals')} style={seeAll}>See all →</button>
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
                  <GoalCard key={g.id} goal={g} index={i} colorIndex={i}
                    onClick={() => openGoal(g.id)}
                    draggable={canDrag}
                    onDragStartCard={() => { dragId.current = g.id; }}
                    onDropCard={() => reorder(suite.id, dragId.current, g.id)} />
                ))}
                {canManage && (
                  <button className="lift msg-in" onClick={() => vtNavigate(navigate, `/goals?new=${suite.id}`)} style={{ ...addCard, animationDelay: `${goals.length * 60}ms` }}>
                    <span style={{ fontSize: 22, lineHeight: 1 }}>＋</span>
                    <span style={{ fontSize: 12.5, fontWeight: 700 }}>{goals.length ? 'Add a goal' : 'Set a goal'}</span>
                  </button>
                )}
              </Strip>
            </div>
          );
        })}
      </div>
    </>
  );
}

const eventName = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', padding: '0 2px' };
const miniX = { border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 11, lineHeight: 1, padding: 2, flexShrink: 0 };
const seeAll = { border: 'none', background: 'transparent', color: 'var(--brand)', fontWeight: 700, fontSize: 12, cursor: 'pointer', padding: 0, fontFamily: 'inherit' };
const dismissBtn = { border: 'none', background: 'rgba(128,128,128,0.12)', color: 'var(--muted-2)', borderRadius: 980, width: 26, height: 26, fontSize: 12, cursor: 'pointer', flexShrink: 0 };
const addCard = { flex: '0 0 124px', scrollSnapAlign: 'start', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 138, border: '1px dashed var(--border)', borderRadius: 14, background: 'transparent', color: 'var(--brand)', cursor: 'pointer' };
