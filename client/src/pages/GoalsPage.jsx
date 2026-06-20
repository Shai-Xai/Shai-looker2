import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useProfile } from '../lib/profile.jsx';
import { vtNavigate } from '../lib/viewTransition.js';
import { GoalCard } from '../components/goals/GoalViz.jsx';
import GoalDetail from '../components/goals/GoalDetail.jsx';
import GoalEditor from '../components/GoalEditor.jsx';

// The dedicated Goals page (the Results pillar, full surface). The home strip is a
// teaser that links here; this is where goals live in full — grouped by event, with
// the event's shared goals and a "Personal goals" section (yours + the team's, per
// Slice D). Each card opens a read-only DETAIL view (Edit/Delete inside it), so the
// cards are never an edit trap (the mobile fix). Deep links: ?goal=<id> opens a
// detail, ?new=<suiteId> opens the editor for that event.
export default function GoalsPage() {
  const navigate = useNavigate();
  const { activeEntityId } = useProfile();
  const [suites, setSuites] = useState([]);
  const [bySuite, setBySuite] = useState({}); // suiteId -> { goals, personalGoals, canManage, me }
  const [me, setMe] = useState('');
  const [editor, setEditor] = useState(null);  // { suiteId, goal, scope } | null
  const [detail, setDetail] = useState(null);   // { suiteId, goalId } | null
  const [params, setParams] = useSearchParams();
  const handled = useRef(false);

  useEffect(() => { api.mySuites().then(setSuites).catch(() => {}); }, []);
  const visibleSuites = activeEntityId ? suites.filter((s) => s.entityId === activeEntityId) : suites;

  const loadSuite = useCallback((sid) => {
    api.suiteGoals(sid).then((r) => { setBySuite((m) => ({ ...m, [sid]: r })); if (r.me) setMe(r.me); }).catch(() => {});
  }, []);
  useEffect(() => { visibleSuites.forEach((s) => loadSuite(s.id)); }, [visibleSuites.map((s) => s.id).join(','), loadSuite]); // eslint-disable-line react-hooks/exhaustive-deps

  const reloadAll = () => visibleSuites.forEach((s) => loadSuite(s.id));

  // Every accessible event is shown — even with no goals yet, a member can add a
  // personal goal there.
  const rows = visibleSuites.map((s) => ({ suite: s, goals: [], personalGoals: [], canManage: false, ...(bySuite[s.id] || {}) }));

  const goalsIn = (r) => [...(r.goals || []), ...(r.personalGoals || [])];

  // Deep links from the home teaser / onboarding (run once the goals have loaded).
  useEffect(() => {
    if (handled.current || !Object.keys(bySuite).length) return;
    const goalId = params.get('goal');
    const newSuite = params.get('new');
    if (goalId) {
      const found = rows.find((r) => goalsIn(r).some((g) => g.id === goalId));
      if (found) { setDetail({ suiteId: found.suite.id, goalId }); handled.current = true; }
    } else if (newSuite) {
      const target = rows.find((r) => r.suite.id === newSuite && r.canManage) || rows.find((r) => r.canManage);
      if (target) { setEditor({ suiteId: target.suite.id, goal: null, scope: 'event' }); handled.current = true; }
    }
    if (goalId || newSuite) { const next = new URLSearchParams(params); next.delete('goal'); next.delete('new'); setParams(next, { replace: true }); }
  }, [bySuite, rows, params, setParams]);

  const openEvent = (suiteId, dashboardId) => {
    if (dashboardId) vtNavigate(navigate, `/suite/${suiteId}/d/${dashboardId}`);
    else vtNavigate(navigate, '/');
  };

  const suiteData = (detail && bySuite[detail.suiteId]) || {};
  const detailGoal = detail && [...(suiteData.goals || []), ...(suiteData.personalGoals || [])].find((g) => g.id === detail.goalId);
  const detailSuite = detail && visibleSuites.find((s) => s.id === detail.suiteId);
  // Event goal → its contributing personal goals; personal goal → the event goal it feeds.
  const contributors = detailGoal && detailGoal.scope === 'event'
    ? (suiteData.personalGoals || []).filter((pg) => pg.rollsUpTo === detailGoal.id) : [];
  const linkedGoal = detailGoal && detailGoal.scope === 'personal' && detailGoal.rollsUpTo
    ? (suiteData.goals || []).find((g) => g.id === detailGoal.rollsUpTo) : null;
  const detailCanManage = !!detailGoal && (detailGoal.scope === 'personal' ? detailGoal.ownerRef === me : !!suiteData.canManage);

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
          No events yet. Once you have an event, set its first goal here.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
        {rows.map(({ suite, goals = [], personalGoals = [], canManage }) => (
          <section key={suite.id}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <h2 style={eventName}>{suite.name}</h2>
              <span style={{ flex: 1 }} />
              {canManage && (
                <button onClick={() => setEditor({ suiteId: suite.id, goal: null, scope: 'event' })} style={addBtn}>＋ {goals.length ? 'Add a goal' : 'Set a goal'}</button>
              )}
            </div>
            {goals.length ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                {goals.map((g, i) => (
                  <GoalCard key={g.id} goal={g} index={i} onClick={() => setDetail({ suiteId: suite.id, goalId: g.id })} />
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>No event goals yet.</div>
            )}

            {/* Personal goals — yours + (team-visible) the team's. Anyone can add one. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '16px 0 10px' }}>
              <h3 style={subHead}>🙋 Personal goals</h3>
              <span style={{ flex: 1 }} />
              <button onClick={() => setEditor({ suiteId: suite.id, goal: null, scope: 'personal' })} style={addBtn}>＋ Add a personal goal</button>
            </div>
            {personalGoals.length ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                {personalGoals.map((g, i) => (
                  <GoalCard key={g.id} goal={g} index={i} onClick={() => setDetail({ suiteId: suite.id, goalId: g.id })} />
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>No personal goals yet — set yours, and link it to an event goal if it helps reach one.</div>
            )}
          </section>
        ))}
      </div>

      {detail && detailGoal && (
        <GoalDetail
          goal={detailGoal}
          suiteName={detailSuite?.name}
          canManage={detailCanManage}
          me={me}
          contributors={contributors}
          linkedGoalName={linkedGoal?.name}
          onClose={() => setDetail(null)}
          onEdit={() => { setEditor({ suiteId: detail.suiteId, goal: detailGoal, scope: detailGoal.scope }); setDetail(null); }}
          onDelete={() => { setDetail(null); loadSuite(detail.suiteId); }}
          onChanged={() => loadSuite(detail.suiteId)}
          onOpenEvent={(dashboardId) => openEvent(detail.suiteId, dashboardId)}
        />
      )}
      {editor && (
        <GoalEditor
          entityId={suites.find((s) => s.id === editor.suiteId)?.entityId || activeEntityId}
          suiteId={editor.suiteId}
          suites={rows.filter((r) => r.canManage).map((r) => ({ id: r.suite.id, name: r.suite.name }))}
          goal={editor.goal}
          scope={editor.scope || 'event'}
          eventGoals={(bySuite[editor.suiteId]?.goals || []).map((g) => ({ id: g.id, name: g.name }))}
          onClose={() => setEditor(null)}
          onSaved={reloadAll}
        />
      )}
    </div>
  );
}

const eventName = { fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' };
const subHead = { fontSize: 12, fontWeight: 700, color: 'var(--muted)' };
const addBtn = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--brand)', borderRadius: 9, fontSize: 12.5, fontWeight: 700, padding: '6px 11px', cursor: 'pointer', flexShrink: 0 };
