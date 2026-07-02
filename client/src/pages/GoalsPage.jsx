import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useProfile } from '../lib/profile.jsx';
import { vtNavigate } from '../lib/viewTransition.js';
import { GoalCard, fmtVal } from '../components/goals/GoalViz.jsx';
import GoalRingsCard from '../components/goals/GoalRings.jsx';
import GoalsBriefModal from '../components/goals/GoalsBriefModal.jsx';
import GoalDetail from '../components/goals/GoalDetail.jsx';
import GapPlanModal from '../components/goals/GapPlanModal.jsx';
import GoalEditor from '../components/GoalEditor.jsx';
import HomeButton from '../components/HomeButton.jsx';

// The dedicated Goals page (the Results pillar, full surface). The home strip is a
// teaser that links here; this is where goals live in full — grouped by event, with
// the event's shared goals and a "Personal goals" section (yours + the team's, per
// Slice D). Each card opens a read-only DETAIL view (Edit/Delete inside it), so the
// cards are never an edit trap (the mobile fix). Deep links: ?goal=<id> opens a
// detail, ?new=<suiteId> opens the editor for that event.
export default function GoalsPage() {
  const navigate = useNavigate();
  const { activeEntityId, isAdmin } = useProfile();
  const [suites, setSuites] = useState([]);
  const [bySuite, setBySuite] = useState({}); // suiteId -> { goals, personalGoals, canManage, me }
  const [me, setMe] = useState('');
  const [editor, setEditor] = useState(null);  // { suiteId, goal, scope } | null
  const [detail, setDetail] = useState(null);   // { suiteId, goalId } | null
  const [brief, setBrief] = useState(null);     // { suiteId, name } | null
  const [gap, setGap] = useState(null);         // { suiteId, goalName, loading, plan, error } | null
  const [params, setParams] = useSearchParams();
  const handled = useRef(false);
  const [suitesLoading, setSuitesLoading] = useState(true);
  const [tab, setTab] = useState('goals');        // 'goals' | 'templates'
  const [activeSuite, setActiveSuite] = useState(''); // which event's goals are shown (one at a time)
  const [templates, setTemplates] = useState(null); // reusable templates for this client (+ global)

  const loadTemplates = useCallback(() => {
    if (!activeEntityId) { setTemplates([]); return; }
    api.goalTemplates(activeEntityId).then((r) => setTemplates(r.templates || [])).catch(() => setTemplates([]));
  }, [activeEntityId]);
  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  useEffect(() => { api.mySuites().then(setSuites).catch(() => {}).finally(() => setSuitesLoading(false)); }, []);
  const visibleSuites = activeEntityId ? suites.filter((s) => s.entityId === activeEntityId) : suites;

  const loadSuite = useCallback((sid) => {
    api.suiteGoals(sid).then((r) => { setBySuite((m) => ({ ...m, [sid]: r })); if (r.me) setMe(r.me); }).catch(() => {});
  }, []);
  useEffect(() => { visibleSuites.forEach((s) => loadSuite(s.id)); }, [visibleSuites.map((s) => s.id).join(','), loadSuite]); // eslint-disable-line react-hooks/exhaustive-deps

  const reloadAll = () => visibleSuites.forEach((s) => loadSuite(s.id));

  // Templates tab: start a new goal from a template, or remove one.
  const useTemplate = (t) => {
    const sid = (rows.find((r) => r.canManage)?.suite.id) || visibleSuites[0]?.id;
    if (!sid) { window.alert('Add an event first, then create a goal from a template.'); return; }
    setTab('goals');
    setEditor({ suiteId: sid, goal: null, scope: 'event', template: t.payload });
  };
  const deleteTpl = (t) => {
    if (!window.confirm(`Delete template “${t.name}”?`)) return;
    api.deleteGoalTemplate(t.id).then(() => setTemplates((x) => (x || []).filter((y) => y.id !== t.id))).catch((e) => window.alert(e.message));
  };

  // Admin: preview the weekly goal nudge — sends the real summary push to MY own
  // devices (not the client team) so we can see exactly what would go out.
  const [nudging, setNudging] = useState(null); // entityId being tested
  const testNudge = (entityId) => {
    setNudging(entityId);
    api.goalNudgeTest(entityId)
      .then((r) => {
        if (r?.error) window.alert(`Couldn't send: ${r.error}`);
        else if (r.sent > 0) window.alert(`Sent to ${r.sent} device${r.sent > 1 ? 's' : ''}:\n\n“${r.body}”`);
        else if (r.wouldSend) window.alert(`Nothing sent — turn on push for this device first.\n\nThe weekly message would read:\n\n“${r.body}”`);
        else window.alert(`No nudge this week — ${r.body}`);
      })
      .catch((e) => window.alert(`Couldn't send: ${e.message}`))
      .finally(() => setNudging(null));
  };

  // Drag-to-reorder event goals (desktop): move the dragged card before the drop
  // target, renumber positions, optimistically reorder, and persist each — the same
  // `position` the dashboard strip orders by, so the new order reflects there too.
  const dragId = useRef(null);
  const reorder = (suiteId, fromId, toId) => {
    if (!fromId || fromId === toId) return;
    setBySuite((m) => {
      const r = m[suiteId];
      if (!r) return m;
      const goals = [...(r.goals || [])];
      const fi = goals.findIndex((g) => g.id === fromId);
      const ti = goals.findIndex((g) => g.id === toId);
      if (fi < 0 || ti < 0) return m;
      const [moved] = goals.splice(fi, 1);
      goals.splice(ti, 0, moved);
      goals.forEach((g, i) => { if (g.position !== i) api.updateGoal(g.id, { position: i }).catch(() => {}); });
      return { ...m, [suiteId]: { ...r, goals: goals.map((g, i) => ({ ...g, position: i })) } };
    });
  };
  // Mobile reorder (▲▼) — move one event goal up/down by one and persist positions.
  const move = (suiteId, idx, dir) => {
    setBySuite((m) => {
      const r = m[suiteId];
      if (!r) return m;
      const goals = [...(r.goals || [])];
      const j = idx + dir;
      if (idx < 0 || j < 0 || idx >= goals.length || j >= goals.length) return m;
      [goals[idx], goals[j]] = [goals[j], goals[idx]];
      goals.forEach((g, i) => { if (g.position !== i) api.updateGoal(g.id, { position: i }).catch(() => {}); });
      return { ...m, [suiteId]: { ...r, goals: goals.map((g, i) => ({ ...g, position: i })) } };
    });
  };

  // Every accessible event is shown — even with no goals yet, a member can add a
  // personal goal there.
  const rows = visibleSuites.map((s) => ({ suite: s, goals: [], personalGoals: [], canManage: false, loaded: bySuite[s.id] !== undefined, ...(bySuite[s.id] || {}) }));

  const goalsIn = (r) => [...(r.goals || []), ...(r.personalGoals || [])];

  // Deep links from the home teaser / onboarding (run once the goals have loaded).
  useEffect(() => {
    if (handled.current || !Object.keys(bySuite).length) return;
    const goalId = params.get('goal');
    const newSuite = params.get('new');
    if (goalId) {
      const found = rows.find((r) => goalsIn(r).some((g) => g.id === goalId));
      if (found) { setActiveSuite(found.suite.id); setDetail({ suiteId: found.suite.id, goalId }); handled.current = true; }
    } else if (newSuite) {
      const target = rows.find((r) => r.suite.id === newSuite && r.canManage) || rows.find((r) => r.canManage);
      if (target) { setActiveSuite(target.suite.id); setEditor({ suiteId: target.suite.id, goal: null, scope: 'event' }); handled.current = true; }
    }
    if (goalId || newSuite) { const next = new URLSearchParams(params); next.delete('goal'); next.delete('new'); setParams(next, { replace: true }); }
  }, [bySuite, rows, params, setParams]);

  const openEvent = (suiteId, dashboardId) => {
    if (dashboardId) vtNavigate(navigate, `/suite/${suiteId}/d/${dashboardId}`);
    else vtNavigate(navigate, '/');
  };

  // "Close the gap": ask the Owl (as marketing/insights manager) for the data nuggets
  // + a targeted campaign to push a behind goal to target, then hand it to the editor.
  const openGapPlan = (suiteId, goal) => {
    setGap({ suiteId, goalName: goal.name, loading: true });
    api.goalGapPlan(goal.id)
      .then((r) => setGap({ suiteId, goalName: goal.name, plan: r.plan }))
      .catch((e) => setGap({ suiteId, goalName: goal.name, error: e.message || 'failed' }));
  };
  const launchGap = (plan) => {
    const suiteId = gap?.suiteId;
    setGap(null);
    const text = plan?.campaignGoal || 'Re-engage the most likely buyers to lift sales before the deadline.';
    // Carry the goal's EVENT (scopes the campaign's audience/tiles to it), the first
    // nugget's dashboard (a concrete audience source) and the plan's segment name
    // (pre-selects the saved segment) — a bare goal string lost all three.
    const q = new URLSearchParams({ goal: text, type: 'email_campaign' });
    if (suiteId) q.set('suite', suiteId);
    const did = (plan?.nuggets || []).find((n) => n.dashboardId)?.dashboardId;
    if (did) q.set('dashboard', did);
    if (plan?.segmentName) q.set('segment', plan.segmentName);
    vtNavigate(navigate, `/engage/campaigns?${q.toString()}`);
  };

  // Drag-to-reorder the event tabs: reorder locally for instant feedback, persist the
  // entity's suite order server-side (shared by the whole client — the sidebar and
  // every suites list follow it on their next load).
  const reorderEvents = (fromId, toId) => {
    setSuites((cur) => {
      const list = [...cur];
      const from = list.findIndex((s) => s.id === fromId);
      const to = list.findIndex((s) => s.id === toId);
      if (from < 0 || to < 0 || from === to) return cur;
      const [moved] = list.splice(from, 1);
      list.splice(to, 0, moved);
      api.saveSuiteOrder(moved.entityId, list.filter((s) => s.entityId === moved.entityId).map((s) => s.id)).catch(() => {});
      return list;
    });
  };

  // One event at a time: a tab strip picks which event's goals show. Fall back to
  // the first event when nothing's selected yet (or the selection went away).
  const activeSuiteId = rows.some((r) => r.suite.id === activeSuite) ? activeSuite : (rows[0]?.suite.id || '');
  const activeRow = rows.find((r) => r.suite.id === activeSuiteId) || null;

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
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '6px 0 12px' }}>
        <HomeButton />
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 2 }}>Results</div>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>Your goals</h1>
        </div>
      </div>
      <p style={{ color: 'var(--muted)', fontSize: 13.5, margin: '0 0 14px', lineHeight: 1.5 }}>
        Targets on the numbers that matter — tracked live, the North Star leading. Tap a goal to see its detail, or set a new one.
      </p>

      {/* Tabs: live goals vs the reusable templates available to this client. */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 18, borderBottom: '1px solid var(--hairline)' }}>
        <TabBtn active={tab === 'goals'} onClick={() => setTab('goals')}>Goals</TabBtn>
        <TabBtn active={tab === 'templates'} onClick={() => setTab('templates')}>Templates{templates && templates.length ? ` (${templates.length})` : ''}</TabBtn>
      </div>

      {tab === 'templates' && (
        <TemplatesView templates={templates} canManage={rows.some((r) => r.canManage) || visibleSuites.length > 0} isAdmin={isAdmin} onUse={useTemplate} onDelete={deleteTpl} />
      )}

      {tab === 'goals' && (<>
      {suitesLoading && <SectionSkeleton />}

      {!suitesLoading && !rows.length && (
        <div style={{ padding: '28px 18px', textAlign: 'center', color: 'var(--muted)', border: '1px dashed var(--hairline)', borderRadius: 14 }}>
          No events yet. Once you have an event, set its first goal here.
        </div>
      )}

      {/* One tab per event — view a single event's goals at a time instead of a long
          stacked list. Horizontally scrollable so it stays tidy on a phone. */}
      {rows.length > 1 && (
        <EventTabs rows={rows} active={activeSuiteId} onPick={setActiveSuite} onReorder={reorderEvents} />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
        {(activeRow ? [activeRow] : []).map(({ suite, goals = [], personalGoals = [], canManage, loaded }) => (
          <section key={suite.id}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <h2 style={eventName}>{suite.name}</h2>
              <span style={{ flex: 1 }} />
              {loaded && goals.length > 0 && (
                <button onClick={() => setBrief({ suiteId: suite.id, name: suite.name })} style={owlBtn} title="Owl summary of these goals">🦉 Owl summary</button>
              )}
              {loaded && isAdmin && goals.length > 0 && (
                <button onClick={() => testNudge(suite.entityId)} disabled={nudging === suite.entityId} style={owlBtn} title="Preview the weekly goal nudge — sends to your own devices">
                  {nudging === suite.entityId ? '…' : '🔔 Test nudge'}
                </button>
              )}
              {loaded && canManage && (
                <button onClick={() => setEditor({ suiteId: suite.id, goal: null, scope: 'event' })} style={addBtn}>＋ {goals.length ? 'Add a goal' : 'Set a goal'}</button>
              )}
            </div>
            {/* Still resolving this event's live goal values — show a skeleton, not a
                premature "no goals" (the resolve hits Looker and can take a few seconds). */}
            {!loaded && <SuiteSkeleton />}
            {/* Activity-Rings hero — all of this event's targets at a glance (Apple-style). */}
            {loaded && [...goals, ...personalGoals].length >= 2 && (
              <div style={{ marginBottom: 14 }}>
                <GoalRingsCard
                  goals={[...goals, ...personalGoals]}
                  onPick={(g) => setDetail({ suiteId: suite.id, goalId: g.id })} />
              </div>
            )}
            {loaded && (goals.length ? (() => {
              // Each card keeps its GLOBAL index (stable colour + working reorder),
              // even when goals are grouped into one row per tag.
              const renderCard = (g) => { const i = goals.indexOf(g); return (
                <GoalCard key={g.id} goal={g} index={i} colorIndex={i} grid
                  draggable={canManage && goals.length > 1}
                  onDragStartCard={() => { dragId.current = g.id; }}
                  onDropCard={() => reorder(suite.id, dragId.current, g.id)}
                  onMoveUp={canManage && goals.length > 1 && i > 0 ? () => move(suite.id, i, -1) : undefined}
                  onMoveDown={canManage && goals.length > 1 && i < goals.length - 1 ? () => move(suite.id, i, 1) : undefined}
                  onClick={() => setDetail({ suiteId: suite.id, goalId: g.id })} />
              ); };
              const tagged = goals.some((g) => (g.tag || '').trim());
              if (!tagged) return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>{goals.map(renderCard)}</div>;
              // One row per tag (insertion order), untagged goals collected under "Other".
              const groups = [];
              goals.forEach((g) => {
                const key = (g.tag || '').trim();
                let grp = groups.find((x) => x.key === key);
                if (!grp) { grp = { key, goals: [] }; groups.push(grp); }
                grp.goals.push(g);
              });
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {groups.map((grp) => (
                    <div key={grp.key || '_other'}>
                      <div style={tagHead}>{grp.key || 'Other'}</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>{grp.goals.map(renderCard)}</div>
                    </div>
                  ))}
                </div>
              );
            })() : (
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>No event goals yet.</div>
            ))}

            {/* Personal goals — yours + (team-visible) the team's. Anyone can add one. */}
            {loaded && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '16px 0 10px' }}>
                  <h3 style={subHead}>🙋 Personal goals</h3>
                  <span style={{ flex: 1 }} />
                  <button onClick={() => setEditor({ suiteId: suite.id, goal: null, scope: 'personal' })} style={addBtn}>＋ Add a personal goal</button>
                </div>
                {personalGoals.length ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                    {personalGoals.map((g, i) => (
                      <GoalCard key={g.id} goal={g} index={i} colorIndex={goals.length + i} grid onClick={() => setDetail({ suiteId: suite.id, goalId: g.id })} />
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: 'var(--muted)' }}>No personal goals yet — set yours, and link it to an event goal if it helps reach one.</div>
                )}
              </>
            )}
          </section>
        ))}
      </div>
      </>)}

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
          onCloseGap={() => { const sid = detail.suiteId; const g = detailGoal; setDetail(null); openGapPlan(sid, g); }}
        />
      )}
      {gap && (
        <GapPlanModal
          goalName={gap.goalName}
          state={gap}
          onClose={() => setGap(null)}
          onLaunch={launchGap}
          onOpenDashboard={(did) => { const sid = gap.suiteId; setGap(null); openEvent(sid, did); }}
        />
      )}
      {brief && (
        <GoalsBriefModal suiteId={brief.suiteId} eventName={brief.name} onClose={() => setBrief(null)} />
      )}
      {editor && (
        <GoalEditor
          entityId={suites.find((s) => s.id === editor.suiteId)?.entityId || activeEntityId}
          suiteId={editor.suiteId}
          suites={rows.filter((r) => r.canManage).map((r) => ({ id: r.suite.id, name: r.suite.name }))}
          goal={editor.goal}
          scope={editor.scope || 'event'}
          eventGoals={(bySuite[editor.suiteId]?.goals || []).map((g) => ({ id: g.id, name: g.name }))}
          initialTemplate={editor.template || null}
          onClose={() => setEditor(null)}
          onSaved={() => { reloadAll(); loadTemplates(); }}
        />
      )}
    </div>
  );
}

// Shimmer placeholders shown while goals resolve (live values hit Looker, so a
// section can take a few seconds). Uses the app's standard `.skel` shimmer.
function Skel({ w = '100%', h = 14, r = 8, style }) {
  return <div className="skel" style={{ width: w, height: h, borderRadius: r, ...style }} />;
}
function SuiteSkeleton() {
  return (
    <div>
      <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap', background: 'var(--tile-bg, var(--card))', border: '1px solid var(--border)', borderRadius: 18, padding: '18px 20px', marginBottom: 14 }}>
        <Skel w={150} h={150} r={980} />
        <div style={{ flex: 1, minWidth: 160, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[0, 1, 2, 3].map((i) => <Skel key={i} w={`${80 - i * 8}%`} h={16} />)}
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {[0, 1].map((i) => <Skel key={i} w={160} h={138} r={14} />)}
      </div>
    </div>
  );
}
function SectionSkeleton() {
  return (
    <div style={{ marginBottom: 26 }}>
      <Skel w={120} h={12} style={{ marginBottom: 12 }} />
      <SuiteSkeleton />
    </div>
  );
}

// Event picker — one pill per event, the selected one highlighted. Scrolls
// horizontally (hidden scrollbar) so a long event list stays a single tidy row
// on mobile. Shows a goal count once the event has loaded.
function EventTabs({ rows, active, onPick, onReorder }) {
  // Drag a tab onto another to reorder (desktop pointer drag; taps still switch).
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  return (
    <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4, marginBottom: 18, scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>
      {rows.map(({ suite, goals = [], personalGoals = [], loaded }) => {
        const n = (goals.length || 0) + (personalGoals.length || 0);
        const on = suite.id === active;
        return (
          <button key={suite.id} type="button" onClick={() => onPick(suite.id)}
            draggable={!!onReorder}
            onDragStart={() => setDragId(suite.id)}
            onDragEnd={() => { setDragId(null); setOverId(null); }}
            onDragOver={(e) => { if (dragId && dragId !== suite.id) { e.preventDefault(); if (overId !== suite.id) setOverId(suite.id); } }}
            onDrop={(e) => { e.preventDefault(); if (onReorder && dragId && dragId !== suite.id) onReorder(dragId, suite.id); setDragId(null); setOverId(null); }}
            title={onReorder ? 'Drag to reorder your events' : undefined}
            style={{
              flexShrink: 0, whiteSpace: 'nowrap', cursor: dragId ? 'grabbing' : 'pointer', font: 'inherit',
              border: `1px solid ${overId === suite.id && dragId ? 'var(--brand)' : on ? 'var(--brand)' : 'var(--hairline)'}`,
              background: on ? 'var(--brand)' : 'var(--card)', color: on ? '#fff' : 'var(--text)',
              borderRadius: 980, padding: '8px 15px', fontSize: 13, fontWeight: on ? 800 : 600,
              opacity: dragId === suite.id ? 0.5 : 1,
            }}>
            {suite.name}{loaded && n > 0 && <span style={{ marginLeft: 7, opacity: 0.75, fontWeight: 600 }}>{n}</span>}
          </button>
        );
      })}
    </div>
  );
}

function TabBtn({ active, onClick, children }) {
  return (
    <button type="button" onClick={onClick} style={{
      border: 'none', background: 'none', cursor: 'pointer', font: 'inherit', padding: '8px 4px', marginBottom: -1,
      fontSize: 14, fontWeight: active ? 800 : 600, color: active ? 'var(--text)' : 'var(--muted)',
      borderBottom: `2px solid ${active ? 'var(--brand)' : 'transparent'}`,
    }}>{children}</button>
  );
}

// All reusable templates available to this client — their own plus 🌐 global ones.
function TemplatesView({ templates, canManage, isAdmin, onUse, onDelete }) {
  if (templates === null) return <SectionSkeleton />;
  if (!templates.length) {
    return (
      <div style={{ padding: '28px 18px', textAlign: 'center', color: 'var(--muted)', border: '1px dashed var(--hairline)', borderRadius: 14 }}>
        No templates yet. Save a goal as a template (in the goal editor) to reuse it here.
      </div>
    );
  }
  const desc = (p = {}) => {
    const bits = [];
    if (p.targetValue != null) bits.push(`${fmtVal(p.targetValue, p.unit)} target`);
    else if (p.unit) bits.push(p.unit);
    if (p.curveRef?.tileName || p.curveRef?.cadence) bits.push(`${p.curveRef.cadence || 'curve'}${p.curveRef.tileName ? ` · ${p.curveRef.tileName}` : ''}`);
    else if (p.metricRef?.tileName) bits.push(p.metricRef.tileName);
    return bits.join(' · ');
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {templates.map((t) => (
        <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 12, border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)', padding: '12px 14px' }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              {t.global && <span title="Global template (available to every client)" style={{ fontSize: 10, fontWeight: 800, color: 'var(--brand)', border: '1px solid var(--hairline)', borderRadius: 980, padding: '1px 7px' }}>🌐 GLOBAL</span>}
              <span style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.payload?.name || t.name}</span>
            </span>
            {desc(t.payload) && <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{desc(t.payload)}</span>}
          </span>
          {canManage && <button onClick={() => onUse(t)} style={addBtn}>＋ Use</button>}
          {(!t.global || isAdmin) && <button onClick={() => onDelete(t)} aria-label="Delete template" style={{ border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 13, padding: 4 }}>🗑</button>}
        </div>
      ))}
    </div>
  );
}

const eventName = { fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' };
const tagHead = { fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 8, display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--hairline)', borderRadius: 980, padding: '3px 11px' };
const subHead = { fontSize: 12, fontWeight: 700, color: 'var(--muted)' };
const addBtn = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--brand)', borderRadius: 9, fontSize: 12.5, fontWeight: 700, padding: '6px 11px', cursor: 'pointer', flexShrink: 0 };
const owlBtn = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 9, fontSize: 12.5, fontWeight: 700, padding: '6px 11px', cursor: 'pointer', flexShrink: 0 };
