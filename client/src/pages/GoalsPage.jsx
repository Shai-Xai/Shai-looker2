import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useProfile } from '../lib/profile.jsx';
import { vtNavigate } from '../lib/viewTransition.js';
import { GoalCard } from '../components/goals/GoalViz.jsx';
import GoalDetail from '../components/goals/GoalDetail.jsx';
import GoalEditor from '../components/GoalEditor.jsx';

// The dedicated Goals page (the Results pillar, full surface). The home strip is a
// teaser that links here; this is where goals live in full — grouped by event,
// each card opens a read-only DETAIL view (Edit/Delete inside it), so the cards are
// never an edit trap (the mobile fix). Personal goals (Slice D) and milestones
// (Slice C) extend this page. Deep links: ?goal=<id> opens a detail, ?new=<suiteId>
// opens the editor for that event.
export default function GoalsPage() {
  const navigate = useNavigate();
  const { activeEntityId } = useProfile();
  const [suites, setSuites] = useState([]);
  const [bySuite, setBySuite] = useState({}); // suiteId -> { goals, canManage }
  const [editor, setEditor] = useState(null);  // { suiteId, goal } | null
  const [detail, setDetail] = useState(null);   // { suiteId, goalId } | null
  const [params, setParams] = useSearchParams();
  const handled = useRef(false);

  useEffect(() => { api.mySuites().then(setSuites).catch(() => {}); }, []);
  const visibleSuites = activeEntityId ? suites.filter((s) => s.entityId === activeEntityId) : suites;

  const loadSuite = useCallback((sid) => {
    api.suiteGoals(sid).then((r) => setBySuite((m) => ({ ...m, [sid]: r }))).catch(() => {});
  }, []);
  useEffect(() => { visibleSuites.forEach((s) => loadSuite(s.id)); }, [visibleSuites.map((s) => s.id).join(','), loadSuite]); // eslint-disable-line react-hooks/exhaustive-deps

  const reloadAll = () => visibleSuites.forEach((s) => loadSuite(s.id));

  const rows = visibleSuites
    .map((s) => ({ suite: s, ...(bySuite[s.id] || { goals: [], canManage: false }) }))
    .filter((r) => (r.goals && r.goals.length) || r.canManage);
  const manageableSuites = rows.filter((r) => r.canManage).map((r) => ({ id: r.suite.id, name: r.suite.name }));

  // Deep links from the home teaser / onboarding (run once the goals have loaded).
  useEffect(() => {
    if (handled.current || !Object.keys(bySuite).length) return;
    const goalId = params.get('goal');
    const newSuite = params.get('new');
    if (goalId) {
      const found = rows.find((r) => r.goals.some((g) => g.id === goalId));
      if (found) { setDetail({ suiteId: found.suite.id, goalId }); handled.current = true; }
    } else if (newSuite) {
      const target = rows.find((r) => r.suite.id === newSuite && r.canManage) || rows.find((r) => r.canManage);
      if (target) { setEditor({ suiteId: target.suite.id, goal: null }); handled.current = true; }
    }
    if (goalId || newSuite) { const next = new URLSearchParams(params); next.delete('goal'); next.delete('new'); setParams(next, { replace: true }); }
  }, [bySuite, rows, params, setParams]);

  const openEvent = (suiteId, dashboardId) => {
    if (dashboardId) vtNavigate(navigate, `/suite/${suiteId}/d/${dashboardId}`);
    else vtNavigate(navigate, '/');
  };

  const detailGoal = detail && (bySuite[detail.suiteId]?.goals || []).find((g) => g.id === detail.goalId);
  const detailSuite = detail && visibleSuites.find((s) => s.id === detail.suiteId);

  return (
    <div style={{ maxWidth: 920, margin: '0 auto', padding: '4px 2px 40px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, margin: '6px 0 4px' }}>
        <span style={{ fontSize: 22 }}>🎯</span>
        <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>Your goals</h1>
      </div>
      <p style={{ color: 'var(--muted)', fontSize: 13.5, margin: '0 0 18px', lineHeight: 1.5 }}>
        Targets on the numbers that matter — tracked live, the North Star leading. Tap a goal to see its detail, or set a new one.
      </p>

      {!rows.length && (
        <div style={{ padding: '28px 18px', textAlign: 'center', color: 'var(--muted)', border: '1px dashed var(--hairline)', borderRadius: 14 }}>
          No goals yet. Once you have an event, set its first goal here.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        {rows.map(({ suite, goals = [], canManage }) => (
          <section key={suite.id}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <h2 style={eventName}>{suite.name}</h2>
              <span style={{ flex: 1 }} />
              {canManage && (
                <button onClick={() => setEditor({ suiteId: suite.id, goal: null })} style={addBtn}>＋ {goals.length ? 'Add a goal' : 'Set a goal'}</button>
              )}
            </div>
            {goals.length ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                {goals.map((g, i) => (
                  <GoalCard key={g.id} goal={g} index={i} onClick={() => setDetail({ suiteId: suite.id, goalId: g.id })} />
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>No goals for this event yet.</div>
            )}
          </section>
        ))}
      </div>

      {detail && detailGoal && (
        <GoalDetail
          goal={detailGoal}
          suiteName={detailSuite?.name}
          canManage={!!bySuite[detail.suiteId]?.canManage}
          onClose={() => setDetail(null)}
          onEdit={() => { setEditor({ suiteId: detail.suiteId, goal: detailGoal }); setDetail(null); }}
          onDelete={() => { setDetail(null); loadSuite(detail.suiteId); }}
          onChanged={() => loadSuite(detail.suiteId)}
          onOpenEvent={(dashboardId) => openEvent(detail.suiteId, dashboardId)}
        />
      )}
      {editor && (
        <GoalEditor
          entityId={activeEntityId}
          suiteId={editor.suiteId}
          suites={manageableSuites}
          goal={editor.goal}
          onClose={() => setEditor(null)}
          onSaved={reloadAll}
        />
      )}
    </div>
  );
}

const eventName = { fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' };
const addBtn = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--brand)', borderRadius: 9, fontSize: 12.5, fontWeight: 700, padding: '6px 11px', cursor: 'pointer', flexShrink: 0 };
