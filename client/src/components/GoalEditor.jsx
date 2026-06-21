import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';

// Set or edit an event goal (the Results pillar). Two ways to track it, per the
// spec: a LIVE number off a dashboard tile (the tile you look at becomes the goal
// you track — zero query-building), or MANUAL (you enter the number — the
// universal fallback for sponsorship, cash floats, anything not yet on a tile).
// Dual-surface: identical for a client self-serving and an admin acting on their
// behalf — the server guard decides who may write. `entityId` scopes the tile
// catalogue; `suiteId` is the event the goal belongs to.
export default function GoalEditor({ entityId, suiteId, suites = [], goal, scope = 'event', eventGoals = [], onClose, onSaved }) {
  const isMobile = useIsMobile();
  const editing = !!goal;
  const isPersonal = (goal ? goal.scope : scope) === 'personal';
  const hasTile = !!(goal?.metricRef?.tileId);
  const [activeSuite, setActiveSuite] = useState(goal?.suiteId || suiteId);
  const [name, setName] = useState(goal?.name || '');
  const [track, setTrack] = useState(hasTile ? 'tile' : 'manual'); // 'tile' | 'manual'
  const [dashboardId, setDashboardId] = useState(goal?.metricRef?.dashboardId || '');
  const [tileId, setTileId] = useState(goal?.metricRef?.tileId || '');
  const [target, setTarget] = useState(goal ? String(goal.targetValue ?? '') : '');
  const [unit, setUnit] = useState(goal?.unit || 'tickets');
  const [direction, setDirection] = useState(goal?.direction || 'at_least');
  const [byDate, setByDate] = useState(goal?.byDate ? goal.byDate.slice(0, 10) : '');
  const [startDate, setStartDate] = useState(goal?.startDate ? goal.startDate.slice(0, 10) : ''); // sell-window start (pace anchor)
  const [northStar, setNorthStar] = useState(!!goal?.isNorthStar);
  const [current, setCurrent] = useState(''); // manual goals: enter today's actual
  const [display, setDisplay] = useState(goal?.display || 'bar'); // bar | ring | dial
  // Baseline — "recreate last event": start the goal from a comparable past
  // event's actual, so the target isn't a blank guess and the goal shows
  // "vs last time". Tile goals read the SAME tile under that event's scope;
  // manual goals enter the number by hand.
  const [baselineSuiteId, setBaselineSuiteId] = useState(goal?.baselineEventId || '');
  const [baselineValue, setBaselineValue] = useState(goal?.baselineValue != null ? String(goal.baselineValue) : '');
  const [baselineLoading, setBaselineLoading] = useState(false);
  // How "last time" is sourced: a past event (reuse the tracking tile under its scope),
  // a dashboard tile you pick (read live now), or a number you type. Stored as a value.
  const [baselineMode, setBaselineMode] = useState(goal?.baselineRef?.tileId ? 'tile' : (goal?.baselineEventId ? 'event' : 'manual')); // 'manual' | 'event' | 'tile'
  const [baselineDashboardId, setBaselineDashboardId] = useState(goal?.baselineRef?.dashboardId || '');
  const [baselineTileId, setBaselineTileId] = useState(goal?.baselineRef?.tileId || '');
  const [pastSuites, setPastSuites] = useState([]); // other events to compare against
  // Milestones — weekly/monthly checkpoints on the way to the target (Slice C).
  const [milestones, setMilestones] = useState(goal?.milestones || []);
  // Checkpoint suggester — link a tile that holds the value over time (a sell-by-date
  // curve), read its shape under a comparable past event, and suggest checkpoints
  // scaled to this goal's target ("last year's sell-by shape → weekly checkpoints").
  const [curveOpen, setCurveOpen] = useState(!!(goal?.curveRef?.tileId)); // reopen showing the saved link
  const [curveDashboardId, setCurveDashboardId] = useState(goal?.curveRef?.dashboardId || '');
  const [curveTileId, setCurveTileId] = useState(goal?.curveRef?.tileId || '');
  const [curveCadence, setCurveCadence] = useState(goal?.curveRef?.cadence || 'monthly'); // 'weekly' | 'monthly'
  const [compareKey, setCompareKey] = useState(goal?.curveRef?.compareKey || ''); // '' = last year (auto)
  const [curveYears, setCurveYears] = useState([]); // prior-period keys to compare against
  const [curveSeries, setCurveSeries] = useState(null); // { loading } | [{ t, v }]
  const [suggInfo, setSuggInfo] = useState(null); // server-computed { checkpoints:[{byDate,fraction,lastValue}] }
  // Personal-goal fields (Slice D): who can see it + which event goal it feeds.
  const [visibility, setVisibility] = useState(goal?.visibility || 'team');
  const [rollsUpTo, setRollsUpTo] = useState(goal?.rollsUpTo || '');
  const [cat, setCat] = useState(null);       // tile catalogue { dashboards: [...] }
  const [preview, setPreview] = useState(null); // live value of the picked tile
  const [templates, setTemplates] = useState([]); // reusable goal templates for this entity
  const [tmplBusy, setTmplBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);

  // Load the client's dashboards/tiles for tile-tracking, the curve suggester, OR the
  // "compare to last time" tile picker.
  useEffect(() => {
    if ((track !== 'tile' && !curveOpen && baselineMode !== 'tile') || cat || !entityId) return;
    api.getMyDigestTiles(entityId).then(setCat).catch(() => setCat({ dashboards: [] }));
  }, [track, curveOpen, baselineMode, cat, entityId]);

  // Reusable goal templates for this client.
  useEffect(() => { if (entityId) api.goalTemplates(entityId).then((r) => setTemplates(r.templates || [])).catch(() => {}); }, [entityId]);

  // The reusable subset of the current form (no dates / North Star / snapshot).
  const templatePayload = () => ({
    name, source: track === 'tile' ? 'ticketing' : 'manual',
    metricRef: track === 'tile' && dashboardId && tileId ? { dashboardId, tileId } : null,
    targetValue: Number(target) || 0, unit, direction, display,
    curveRef: (curveDashboardId && curveTileId) ? { dashboardId: curveDashboardId, tileId: curveTileId, cadence: curveCadence, ...(compareKey ? { compareKey } : {}) } : null,
    baselineRef: baselineMode === 'tile' && baselineDashboardId && baselineTileId ? { dashboardId: baselineDashboardId, tileId: baselineTileId } : null,
  });
  const applyTemplate = (p) => {
    if (!p) return;
    if (p.name) setName(p.name);
    if (p.metricRef && p.metricRef.tileId) { setTrack('tile'); setDashboardId(p.metricRef.dashboardId || ''); setTileId(p.metricRef.tileId || ''); }
    if (p.targetValue != null) setTarget(String(p.targetValue));
    if (p.unit) setUnit(p.unit);
    if (p.direction) setDirection(p.direction);
    if (p.display) setDisplay(p.display);
    if (p.curveRef && p.curveRef.tileId) { setCurveOpen(true); setCurveDashboardId(p.curveRef.dashboardId || ''); setCurveTileId(p.curveRef.tileId || ''); setCurveCadence(p.curveRef.cadence || 'monthly'); setCompareKey(p.curveRef.compareKey || ''); }
    if (p.baselineRef && p.baselineRef.tileId) { setBaselineMode('tile'); setBaselineDashboardId(p.baselineRef.dashboardId || ''); setBaselineTileId(p.baselineRef.tileId || ''); }
  };
  const saveAsTemplate = async () => {
    const nm = (name || '').trim() || window.prompt('Template name?') || '';
    if (!nm.trim() || !entityId) return;
    setTmplBusy(true);
    try {
      const r = await api.saveGoalTemplate({ entityId, name: nm.trim(), payload: { ...templatePayload(), name: nm.trim() } });
      if (r?.template) { setTemplates((t) => [r.template, ...t]); window.alert(`Saved “${r.template.name}” as a reusable template.`); }
    } catch (e) { window.alert(`Couldn't save template: ${e.message}`); }
    finally { setTmplBusy(false); }
  };
  const removeTemplate = async (id) => {
    if (!window.confirm('Delete this template?')) return;
    try { await api.deleteGoalTemplate(id); setTemplates((t) => t.filter((x) => x.id !== id)); } catch { /* ignore */ }
  };

  // Read "last time's curve" AND its checkpoint suggestions in one server call — the
  // server uses the SAME days-before alignment as the live pace engine, returning the
  // shape (for the sparkline) plus per-checkpoint fractions (target-independent, so the
  // target field below doesn't re-query). Scope is enforced server-side. Re-runs when
  // the tile, cadence or the start/deadline change (NOT on every target keystroke).
  const curveSuiteId = (baselineMode === 'event' && baselineSuiteId) ? baselineSuiteId : activeSuite;
  useEffect(() => {
    if (!curveOpen || !curveDashboardId || !curveTileId || !curveSuiteId) { setCurveSeries(null); setSuggInfo(null); return undefined; }
    let alive = true; setCurveSeries({ loading: true });
    api.goalCheckpointSuggestions(curveSuiteId, { dashboardId: curveDashboardId, tileId: curveTileId, cadence: curveCadence, startDate, byDate, compareKey })
      .then((r) => { if (!alive) return; setCurveSeries(Array.isArray(r.series) ? r.series : []); setSuggInfo({ checkpoints: Array.isArray(r.checkpoints) ? r.checkpoints : [] }); setCurveYears(Array.isArray(r.years) ? r.years : []); })
      .catch(() => { if (alive) { setCurveSeries([]); setSuggInfo({ checkpoints: [] }); } });
    return () => { alive = false; };
  }, [curveOpen, curveDashboardId, curveTileId, curveSuiteId, curveCadence, startDate, byDate, compareKey]);

  // Live value of the chosen tile, so the target is set against the real number.
  useEffect(() => {
    if (track !== 'tile' || !dashboardId || !tileId || !activeSuite) { setPreview(null); return undefined; }
    let alive = true; setPreview({ loading: true });
    api.goalTileValue(activeSuite, dashboardId, tileId)
      .then((r) => { if (alive) setPreview({ value: r.value }); })
      .catch(() => { if (alive) setPreview({ value: null }); });
    return () => { alive = false; };
  }, [track, dashboardId, tileId, activeSuite]);

  // Candidate events to baseline against. Scoped STRICTLY to this profile's entity
  // — never other clients' events. Derive the entity from the CURRENT suite (not
  // the activeEntityId prop, which can be blank); if we can't resolve an entity,
  // fail closed to just the current event. The current event is included on
  // purpose: a recurring/annual event is its own "last time" (read the same tile
  // under its earlier data). The resolver still enforces per-event scope.
  useEffect(() => {
    api.mySuites().then((all) => {
      const listAll = all || [];
      const cur = listAll.find((s) => s.id === activeSuite);
      const entId = cur?.entityId || entityId;
      const scoped = entId
        ? listAll.filter((s) => s.entityId === entId)
        : listAll.filter((s) => s.id === activeSuite);
      setPastSuites(scoped);
    }).catch(() => setPastSuites([]));
  }, [entityId, activeSuite]);

  // Tile-sourced: read the SAME tile under the chosen past event's scope — that's
  // "last time's" number, with zero extra query-building (the resolver enforces
  // scope per event). Manual goals enter the baseline by hand below.
  useEffect(() => {
    if (track !== 'tile' || !baselineSuiteId || !dashboardId || !tileId) return undefined;
    let alive = true; setBaselineLoading(true);
    api.goalTileValue(baselineSuiteId, dashboardId, tileId)
      .then((r) => { if (alive) setBaselineValue(r.value == null ? '' : String(r.value)); })
      .catch(() => { if (alive) setBaselineValue(''); })
      .finally(() => { if (alive) setBaselineLoading(false); });
    return () => { alive = false; };
  }, [track, baselineSuiteId, dashboardId, tileId]);

  // Baseline from a PICKED tile — read it live (under this event's scope) and snapshot
  // the number into baselineValue, so you can compare to any tile (e.g. a last-year KPI),
  // not just the tracking tile under a past event.
  useEffect(() => {
    if (baselineMode !== 'tile' || !baselineDashboardId || !baselineTileId || !activeSuite) return undefined;
    let alive = true; setBaselineLoading(true);
    api.goalTileValue(activeSuite, baselineDashboardId, baselineTileId)
      .then((r) => { if (alive) setBaselineValue(r.value == null ? '' : String(r.value)); })
      .catch(() => { if (alive) setBaselineValue(''); })
      .finally(() => { if (alive) setBaselineLoading(false); });
    return () => { alive = false; };
  }, [baselineMode, baselineDashboardId, baselineTileId, activeSuite]);

  const dashboards = cat?.dashboards || [];
  // A goal tracks ONE headline number, so only single-value (KPI) tiles qualify —
  // a chart/table tile has no single "the number" (and the resolver would read its
  // first row, e.g. an early 0). Mirrors TileFrame's metric-tile test.
  const isKpi = (t) => { const v = t.visType || ''; return v === 'single_value' || v === 'single_value_period_over_period' || v.includes('bar_gauge'); };
  const tilesFor = (dId) => (dashboards.find((d) => d.dashboardId === dId)?.tiles || []).filter(isKpi);
  // Curve candidates are the opposite: charts/tables that carry a value-over-time
  // series (not single-value KPIs), so there's a shape to read.
  const seriesTilesFor = (dId) => (dashboards.find((d) => d.dashboardId === dId)?.tiles || []).filter((t) => !isKpi(t));

  // Suggested checkpoints for THIS goal: the SERVER computes each checkpoint's fraction
  // of last time's total using the SAME days-before alignment as the live pace engine
  // (so the suggestions and the card's Ahead/Behind use identical math). Here we just
  // scale those fractions by the live target — keeping the target field instant (no
  // re-query) while last time's actual value at each point stays reviewable.
  function buildSuggestions() {
    const tgt = Number(target);
    const cps = suggInfo?.checkpoints || [];
    if (!cps.length || !Number.isFinite(tgt) || tgt <= 0) return [];
    return cps.map((c) => ({ byDate: c.byDate, targetValue: Math.round(tgt * c.fraction), lastValue: c.lastValue }));
  }

  // When the curve read fine but no checkpoints came out, say WHY (instead of silence).
  function suggestReason() {
    if (!Number(target) || !byDate) return 'Set a target and deadline above, then we’ll suggest checkpoints.';
    const start = startDate ? new Date(startDate) : (goal?.createdAt ? new Date(goal.createdAt) : new Date());
    const end = new Date(byDate);
    if (!(end.getTime() > start.getTime())) return 'Set a deadline in the future to space checkpoints out.';
    const days = (end.getTime() - start.getTime()) / 86400000;
    if (curveCadence === 'monthly' && days < 31) return 'Less than a month to the deadline — switch to Weekly for checkpoints.';
    if (curveCadence === 'weekly' && days < 7) return 'Less than a week to the deadline — too short for checkpoints.';
    return 'Couldn’t build checkpoints from that curve — try the other cadence.';
  }

  // Baseline UI state: do we have a usable "last time" number, are we auto-reading
  // it off a past event's tile, and did that read succeed?
  const baseFinite = baselineValue !== '' && Number.isFinite(Number(baselineValue));
  // "Auto" = the value is read for you (past event reusing the tracking tile, or a tile
  // you picked) rather than typed.
  const autoMode = (baselineMode === 'event' && !!baselineSuiteId && track === 'tile') || (baselineMode === 'tile' && !!baselineTileId);

  const updateMilestone = (i, patch) => setMilestones((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const addMilestone = () => setMilestones((ms) => [...ms, { byDate: '', targetValue: '' }]);
  const removeMilestone = (i) => setMilestones((ms) => ms.filter((_, j) => j !== i));

  async function save() {
    if (!name.trim()) { setErr('Give the goal a name.'); return; }
    if (track === 'tile' && (!dashboardId || !tileId)) { setErr('Pick the dashboard tile to track.'); return; }
    if (!target || Number.isNaN(Number(target))) { setErr('Set a numeric target.'); return; }
    setBusy(true); setErr('');
    const baseNum = baselineValue !== '' && !Number.isNaN(Number(baselineValue)) ? Number(baselineValue) : null;
    const body = {
      name: name.trim(),
      source: 'manual', // resolution is driven by the tile ref below, not this label
      metricRef: track === 'tile' ? { dashboardId, tileId } : {},
      targetValue: Number(target),
      unit, direction, display, byDate, startDate,
      scope: isPersonal ? 'personal' : 'event',
      isNorthStar: isPersonal ? false : northStar,
      visibility: isPersonal ? visibility : 'team',
      rollsUpTo: isPersonal ? rollsUpTo : '',
      // Baseline persists whenever there's a number — whether read from a past
      // event's tile, a picked tile (remembered + re-read live), or typed by hand.
      baselineEventId: baseNum != null && baselineMode === 'event' ? baselineSuiteId : '',
      baselineValue: baseNum,
      baselineSource: baseNum != null ? (baselineMode === 'tile' ? 'looker' : (baselineMode === 'event' && track === 'tile' ? 'looker' : 'manual')) : '',
      baselineRef: baselineMode === 'tile' && baselineDashboardId && baselineTileId ? { dashboardId: baselineDashboardId, tileId: baselineTileId } : null,
      milestones: milestones
        .map((m) => ({ byDate: m.byDate, targetValue: Number(m.targetValue), ...(m.lastValue != null && m.lastValue !== '' ? { lastValue: Number(m.lastValue) } : {}) }))
        .filter((m) => m.byDate && Number.isFinite(m.targetValue)),
      // Remember the linked checkpoint-curve tile so reopening restores it.
      curveRef: (curveDashboardId && curveTileId) ? { dashboardId: curveDashboardId, tileId: curveTileId, cadence: curveCadence, ...(compareKey ? { compareKey } : {}) } : null,
    };
    try {
      let saved;
      if (editing) saved = (await api.updateGoal(goal.id, body)).goal;
      else saved = (await api.createGoal(activeSuite, body)).goal;
      // Manual goal with a starting value → record the first snapshot.
      if (track === 'manual' && current !== '' && !Number.isNaN(Number(current)) && saved?.id) {
        await api.goalSnapshot(saved.id, Number(current)).catch(() => {});
      }
      onSaved?.();
      onClose();
    } catch (e) { setErr(e.message || 'Could not save the goal.'); setBusy(false); }
  }

  async function del() {
    setBusy(true); setErr('');
    try { await api.deleteGoal(goal.id); onSaved?.(); onClose(); }
    catch (e) { setErr(e.message || 'Could not delete the goal.'); setBusy(false); }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={{ ...sheet, maxWidth: isMobile ? '100%' : 460 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <span style={{ fontSize: 20 }}>{isPersonal ? '🙋' : '🎯'}</span>
          <h2 style={{ fontSize: 17, fontWeight: 800, flex: 1 }}>{editing ? (isPersonal ? 'Edit personal goal' : 'Edit goal') : (isPersonal ? 'Set a personal goal' : 'Set a goal')}</h2>
          <button onClick={onClose} style={xBtn} aria-label="Close">✕</button>
        </div>

        {/* Start from a saved template (reuse a recurring goal's setup). */}
        {!editing && templates.length > 0 && (
          <Field label="Start from a template">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {templates.map((t) => (
                <span key={t.id} style={tmplChip}>
                  <button type="button" onClick={() => applyTemplate(t.payload)} style={tmplChipBtn} title="Use this template">{t.name}</button>
                  <button type="button" onClick={() => removeTemplate(t.id)} aria-label="Delete template" style={tmplChipX}>✕</button>
                </span>
              ))}
            </div>
          </Field>
        )}

        <Field label="What's the goal?">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sell-through, Bar revenue, Sponsorship secured" style={inp} autoFocus />
        </Field>

        {suites.length > 1 && (
          <Field label="For which event?" hint={editing ? 'A goal stays with its event.' : undefined}>
            <select value={activeSuite} onChange={(e) => setActiveSuite(e.target.value)} disabled={editing} style={inp}>
              {suites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
        )}

        <Field label="How do you want to track it?">
          <div style={{ display: 'flex', gap: 8 }}>
            <Seg active={track === 'tile'} onClick={() => setTrack('tile')}>📊 From my dashboard</Seg>
            <Seg active={track === 'manual'} onClick={() => setTrack('manual')}>✍️ I'll enter it</Seg>
          </div>
        </Field>

        {track === 'tile' ? (
          <Field label="Which number?" hint="Pick a single-value (KPI) tile you already look at — the goal tracks that live number.">
            <select value={dashboardId} onChange={(e) => { setDashboardId(e.target.value); setTileId(''); }} style={inp}>
              <option value="">{cat ? 'Choose a dashboard…' : 'Loading…'}</option>
              {dashboards.map((d) => <option key={d.dashboardId} value={d.dashboardId}>{d.title}{d.setName ? ` · ${d.setName}` : ''}</option>)}
            </select>
            {dashboardId && (tilesFor(dashboardId).length ? (
              <select value={tileId} onChange={(e) => setTileId(e.target.value)} style={{ ...inp, marginTop: 8 }}>
                <option value="">Choose a tile…</option>
                {tilesFor(dashboardId).map((t) => <option key={t.tileId} value={t.tileId}>{t.title}</option>)}
              </select>
            ) : (
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)', lineHeight: 1.4 }}>
                No single-value (KPI) tiles on this dashboard. Goals track one headline number — pick a dashboard with a KPI tile, or choose “✍️ I’ll enter it”.
              </div>
            ))}
            {tileId && (
              <div style={{ marginTop: 9, padding: '8px 11px', background: 'rgba(128,128,128,0.07)', borderRadius: 9, fontSize: 13, display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ color: 'var(--muted)', fontWeight: 600 }}>This tile reads:</span>
                {preview?.loading
                  ? <span style={{ color: 'var(--muted)' }}>reading…</span>
                  : preview && preview.value != null
                    ? <b style={{ fontSize: 15 }}>{fmtNum(preview.value, unit)}</b>
                    : <span style={{ color: 'var(--muted)' }}>— couldn't read it right now</span>}
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>updates live</span>
              </div>
            )}
          </Field>
        ) : (
          <Field label="Current value (optional)" hint="You can update this any time; the goal tracks what you enter.">
            <input value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="e.g. 120000" inputMode="decimal" style={inp} />
          </Field>
        )}

        <Field label="Compare to last time (optional)" hint="Start from last time — the goal shows “vs last time” and can suggest a target.">
          <select
            value={baselineMode === 'event' ? baselineSuiteId : (baselineMode === 'tile' ? '__tile__' : '')}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '') { setBaselineMode('manual'); setBaselineSuiteId(''); setBaselineValue(''); }
              else if (v === '__tile__') { setBaselineMode('tile'); setBaselineSuiteId(''); setBaselineValue(''); }
              else { setBaselineMode('event'); setBaselineSuiteId(v); }
            }}
            style={inp}
          >
            <option value="">Enter it manually…</option>
            <option value="__tile__">📊 From a dashboard tile…</option>
            {pastSuites.map((s) => <option key={s.id} value={s.id}>{s.name}{s.id === activeSuite ? ' (this event)' : ''}</option>)}
          </select>
          {/* Pick any dashboard + tile for last time's number (e.g. a last-year KPI). */}
          {baselineMode === 'tile' && (
            <>
              <select value={baselineDashboardId} onChange={(e) => { setBaselineDashboardId(e.target.value); setBaselineTileId(''); setBaselineValue(''); }} style={{ ...inp, marginTop: 8 }}>
                <option value="">{cat ? 'Choose a dashboard…' : 'Loading…'}</option>
                {dashboards.map((dd) => <option key={dd.dashboardId} value={dd.dashboardId}>{dd.title}{dd.setName ? ` · ${dd.setName}` : ''}</option>)}
              </select>
              {baselineDashboardId && (
                <select value={baselineTileId} onChange={(e) => setBaselineTileId(e.target.value)} style={{ ...inp, marginTop: 8 }}>
                  <option value="">Choose a tile…</option>
                  {tilesFor(baselineDashboardId).map((t) => <option key={t.tileId} value={t.tileId}>{t.title}</option>)}
                </select>
              )}
            </>
          )}
          {autoMode && baselineLoading && <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--muted)' }}>reading last time…</div>}
          {autoMode && !baselineLoading && !baseFinite && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>Couldn’t read that tile — pick another or enter it below.</div>}
          {(baselineMode === 'manual' || (autoMode && !baselineLoading && !baseFinite)) && (
            <input value={baselineValue} onChange={(e) => setBaselineValue(e.target.value)} placeholder="Last time’s value" inputMode="decimal" style={{ ...inp, marginTop: 8 }} />
          )}
          {baseFinite && (
            <div style={{ marginTop: 9 }}>
              <div style={{ fontSize: 13 }}><span style={{ color: 'var(--muted)', fontWeight: 600 }}>Last time:</span> <b>{fmtNum(Number(baselineValue), unit)}</b></div>
              <div style={{ display: 'flex', gap: 6, marginTop: 7, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11.5, color: 'var(--muted)', alignSelf: 'center' }}>Set target:</span>
                {[['Match', 1], ['+10%', 1.1], ['+15%', 1.15], ['+20%', 1.2]].map(([lbl, f]) => (
                  <button key={lbl} type="button" onClick={() => setTarget(String(Math.round(Number(baselineValue) * f)))} style={suggestBtn}>{lbl}</button>
                ))}
              </div>
            </div>
          )}
        </Field>

        <div style={{ display: 'flex', gap: 10 }}>
          <Field label="Target" style={{ flex: 1 }}>
            <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="e.g. 25000" inputMode="decimal" style={inp} />
          </Field>
          <Field label="Unit" style={{ width: 130 }}>
            <select value={unit} onChange={(e) => setUnit(e.target.value)} style={inp}>
              {[...new Set(['tickets', 'ZAR', '%', 'sessions', 'users', 'views', 'conversions', 'orders', 'count', unit].filter(Boolean))].map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </Field>
        </div>

        <Field label="Goal type" hint="Most goals (revenue, tickets, attendance) are “hit a target.”">
          <select value={direction} onChange={(e) => setDirection(e.target.value)} style={inp}>
            <option value="at_least">Hit a target — reach the number or beat it ↑</option>
            <option value="at_most">Stay under a cap — keep the number below it ↓</option>
          </select>
        </Field>

        <div style={{ display: 'flex', gap: 10 }}>
          <Field label="Track from" hint="When selling started — pace runs from here. Defaults to today." style={{ flex: 1 }}>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={inp} />
          </Field>
          <Field label="By (deadline)" hint="Defaults to event day" style={{ flex: 1 }}>
            <input type="date" value={byDate} onChange={(e) => setByDate(e.target.value)} style={inp} />
          </Field>
        </div>

        <Field label="Checkpoints (optional)" hint="Weekly or monthly targets on the way — pace is measured against the nearest one, so a back-loaded goal isn’t flagged “behind” too early.">
          {milestones.map((m, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              <input type="date" value={m.byDate || ''} onChange={(e) => updateMilestone(i, { byDate: e.target.value })} style={{ ...inp, flex: 1 }} />
              <input value={m.targetValue ?? ''} onChange={(e) => updateMilestone(i, { targetValue: e.target.value })} placeholder="target" inputMode="decimal" style={{ ...inp, width: 104 }} />
              <button type="button" onClick={() => removeMilestone(i)} aria-label="Remove checkpoint" style={msX}>✕</button>
            </div>
          ))}
          <button type="button" onClick={addMilestone} style={addMsBtn}>＋ Add a checkpoint</button>

          {/* Suggest checkpoints from last time's curve — link a value-over-time tile. */}
          <button type="button" onClick={() => setCurveOpen((o) => !o)} style={curveToggle}>
            📈 {curveOpen ? 'Hide suggestions' : 'Suggest from last time’s curve'}
          </button>
          {curveOpen && (
            <div style={curveBox}>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.45 }}>
                Link a tile that shows the value over time (e.g. sales by date). We read its shape under {baselineSuiteId ? 'the event chosen above' : 'this event'} and suggest checkpoints scaled to your target.
              </div>
              <select value={curveDashboardId} onChange={(e) => { setCurveDashboardId(e.target.value); setCurveTileId(''); }} style={inp}>
                <option value="">{cat ? 'Choose a dashboard…' : 'Loading…'}</option>
                {dashboards.map((dd) => <option key={dd.dashboardId} value={dd.dashboardId}>{dd.title}{dd.setName ? ` · ${dd.setName}` : ''}</option>)}
              </select>
              {curveDashboardId && (
                <select value={curveTileId} onChange={(e) => setCurveTileId(e.target.value)} style={{ ...inp, marginTop: 8 }}>
                  <option value="">Choose a time-series tile…</option>
                  {seriesTilesFor(curveDashboardId).map((t) => <option key={t.tileId} value={t.tileId}>{t.title}</option>)}
                </select>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <Seg active={curveCadence === 'weekly'} onClick={() => setCurveCadence('weekly')}>Weekly</Seg>
                <Seg active={curveCadence === 'monthly'} onClick={() => setCurveCadence('monthly')}>Monthly</Seg>
              </div>
              {/* Compare-against year — only when the tile carries more than one prior period. */}
              {curveYears.length > 1 && (
                <label style={{ display: 'block', marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
                  Compare against
                  <select value={compareKey} onChange={(e) => setCompareKey(e.target.value)} style={{ ...inp, marginTop: 4 }}>
                    <option value="">Last year ({curveYears[0]})</option>
                    {curveYears.map((y) => <option key={y} value={y}>{y}</option>)}
                  </select>
                </label>
              )}
              {curveSeries?.loading && <div style={hintRow}>reading last time…</div>}
              {Array.isArray(curveSeries) && curveSeries.length === 0 && curveTileId && <div style={hintRow}>Couldn’t read a time series from that tile — pick a chart with a date dimension.</div>}
              {Array.isArray(curveSeries) && curveSeries.length >= 2 && (() => {
                const sugg = buildSuggestions();
                return (
                  <div style={{ marginTop: 10 }}>
                    {/* Preview — last time's shape, so you can see we picked it up. */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <CurveSparkline series={curveSeries} />
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>last time’s shape · {curveSeries.length} points read</span>
                    </div>
                    {sugg.length ? (
                      <>
                        {sugg.map((s, i) => (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '3px 0', fontSize: 12.5 }}>
                            <span style={{ flex: 1, color: 'var(--muted)' }}>{fmtShort(s.byDate)}</span>
                            <span style={{ color: 'var(--muted)', fontSize: 11 }}>last time {fmtNum(s.lastValue, unit)}</span>
                            <span style={{ fontWeight: 700 }}>{fmtNum(s.targetValue, unit)}</span>
                          </div>
                        ))}
                        <button type="button" onClick={() => setMilestones(sugg.map((s) => ({ byDate: s.byDate, targetValue: String(s.targetValue), lastValue: s.lastValue })))} style={applyBtn}>
                          Use these {sugg.length} checkpoints
                        </button>
                      </>
                    ) : (
                      <div style={hintRow}>{suggestReason()}</div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}
        </Field>

        <Field label="Show it as">
          <div style={{ display: 'flex', gap: 8 }}>
            <Seg active={display === 'bar'} onClick={() => setDisplay('bar')}>▭ Bar</Seg>
            <Seg active={display === 'ring'} onClick={() => setDisplay('ring')}>◯ Circle</Seg>
            <Seg active={display === 'dial'} onClick={() => setDisplay('dial')}>◔ Dial</Seg>
          </div>
        </Field>

        {isPersonal ? (
          <>
            <Field label="Who can see this?" hint="Team-visible goals show on the event so everyone sees who’s driving what. Private goals are just you (and Howler admins).">
              <div style={{ display: 'flex', gap: 8 }}>
                <Seg active={visibility === 'team'} onClick={() => setVisibility('team')}>👥 My team</Seg>
                <Seg active={visibility === 'private'} onClick={() => setVisibility('private')}>🔒 Just me</Seg>
              </div>
            </Field>
            {eventGoals.length > 0 && (
              <Field label="Contributes to (optional)" hint="Link this to an event goal it helps reach — it’ll show as a contributor on that goal.">
                <select value={rollsUpTo} onChange={(e) => setRollsUpTo(e.target.value)} style={inp}>
                  <option value="">Not linked</option>
                  {eventGoals.map((eg) => <option key={eg.id} value={eg.id}>{eg.name}</option>)}
                </select>
              </Field>
            )}
          </>
        ) : (
          <label style={northRow}>
            <input type="checkbox" checked={northStar} onChange={(e) => setNorthStar(e.target.checked)} />
            <span style={{ fontWeight: 700 }}>⭐ Make this the North Star</span>
            <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>the one headline goal for this event</span>
          </label>
        )}

        {err && <div style={{ color: 'var(--error, #dc2626)', fontSize: 12.5, marginTop: 10 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
          {editing && (confirmDel ? (
            <button onClick={del} disabled={busy} style={btnDanger} title="Confirm delete">Delete goal</button>
          ) : (
            <button onClick={() => setConfirmDel(true)} style={btnDelGhost} title="Delete this goal" aria-label="Delete goal">🗑</button>
          ))}
          {!isPersonal && name.trim() && (
            <button onClick={saveAsTemplate} disabled={tmplBusy} style={btnGhost} title="Save this setup as a reusable template">
              {tmplBusy ? 'Saving…' : '📑 Save as template'}
            </button>
          )}
          <button onClick={onClose} style={btnGhost}>Cancel</button>
          <button onClick={save} disabled={busy} style={btnPrimary}>{busy ? 'Saving…' : (editing ? 'Save goal' : 'Set goal')}</button>
        </div>
      </div>
    </div>
  );
}

const tmplChip = { display: 'inline-flex', alignItems: 'center', gap: 2, border: '1px solid var(--hairline)', borderRadius: 980, background: 'var(--card)', overflow: 'hidden' };
const tmplChipBtn = { border: 'none', background: 'transparent', color: 'var(--brand)', fontWeight: 700, fontSize: 12, cursor: 'pointer', padding: '6px 4px 6px 11px', fontFamily: 'inherit' };
const tmplChipX = { border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 11, padding: '6px 9px 6px 4px', lineHeight: 1 };

function Field({ label, hint, children, style }) {
  return (
    <div style={{ marginBottom: 12, ...style }}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 5 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 }}>{hint}</div>}
    </div>
  );
}
function Seg({ active, onClick, children }) {
  return (
    <button type="button" onClick={onClick} style={{
      flex: 1, padding: '9px 8px', borderRadius: 10, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
      border: `1.5px solid ${active ? 'var(--brand)' : 'var(--hairline)'}`,
      background: active ? 'rgba(var(--brand-rgb,10,132,255),0.10)' : 'var(--card)',
      color: active ? 'var(--brand)' : 'var(--text)',
    }}>{children}</button>
  );
}

function fmtNum(v, unit) {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const s = Math.abs(n) >= 1000 ? n.toLocaleString('en-ZA') : String(n);
  if (unit === 'ZAR') return `R${s}`;
  if (unit === '%') return `${s}%`;
  return unit && unit !== 'count' ? `${s} ${unit}` : s;
}

function fmtShort(s) { const d = new Date(s); return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }); }

// Tiny cumulative-shape preview of last time's curve, so you can see it was read.
function CurveSparkline({ series, w = 60, h = 22 }) {
  const vals = (series || []).map((p) => Number(p.v)).filter((v) => Number.isFinite(v));
  if (vals.length < 2) return null;
  const nonDec = vals.every((v, i) => i === 0 || v >= vals[i - 1] - 1e-9);
  let run = 0; const cum = vals.map((v) => { run = nonDec ? v : run + v; return run; });
  const max = cum[cum.length - 1] || 1;
  const pts = cum.map((c, i) => `${((i / (cum.length - 1)) * w).toFixed(1)},${(h - (c / max) * h).toFixed(1)}`).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ flexShrink: 0 }} aria-hidden="true">
      <polyline points={pts} fill="none" stroke="var(--brand)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 100 };
const sheet = { width: '100%', maxHeight: '90vh', overflowY: 'auto', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, padding: '18px 18px 20px', boxShadow: 'var(--shadow-lg, 0 12px 40px rgba(0,0,0,0.28))', color: 'var(--text)' };
const inp = { width: '100%', boxSizing: 'border-box', padding: '9px 11px', border: '1.5px solid var(--hairline)', borderRadius: 9, fontSize: 14, outline: 'none', background: 'var(--card)', color: 'var(--text)', fontFamily: 'inherit' };
const xBtn = { border: 'none', background: 'rgba(128,128,128,0.12)', color: 'var(--muted-2)', borderRadius: 980, width: 28, height: 28, fontSize: 13, cursor: 'pointer' };
const northRow = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6, padding: '10px 12px', border: '1px solid var(--hairline)', borderRadius: 10, cursor: 'pointer', fontSize: 13 };
const suggestBtn = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--brand)', borderRadius: 980, fontSize: 11.5, fontWeight: 700, padding: '3px 10px', cursor: 'pointer' };
const msX = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--muted)', borderRadius: 9, fontSize: 13, cursor: 'pointer', flexShrink: 0, width: 38 };
const addMsBtn = { border: '1px dashed var(--hairline)', background: 'transparent', color: 'var(--brand)', borderRadius: 9, fontSize: 12.5, fontWeight: 700, padding: '7px 11px', cursor: 'pointer', width: '100%' };
const curveToggle = { border: 'none', background: 'transparent', color: 'var(--brand)', fontSize: 12, fontWeight: 700, padding: '8px 2px 2px', cursor: 'pointer', fontFamily: 'inherit' };
const curveBox = { marginTop: 4, padding: '11px 12px', background: 'rgba(128,128,128,0.06)', border: '1px solid var(--hairline)', borderRadius: 10 };
const hintRow = { marginTop: 8, fontSize: 12, color: 'var(--muted)', lineHeight: 1.4 };
const applyBtn = { marginTop: 9, width: '100%', border: 'none', background: 'var(--brand)', color: '#fff', borderRadius: 9, fontSize: 12.5, fontWeight: 700, padding: '8px 11px', cursor: 'pointer' };
const btnGhost = { flex: '0 0 auto', padding: '10px 16px', borderRadius: 10, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' };
const btnDanger = { flex: '0 0 auto', padding: '10px 14px', borderRadius: 10, border: 'none', background: 'var(--error, #dc2626)', color: '#fff', fontSize: 13.5, fontWeight: 800, cursor: 'pointer' };
const btnDelGhost = { flex: '0 0 auto', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--error, #dc2626)', fontSize: 15, cursor: 'pointer' };
const btnPrimary = { flex: 1, padding: '10px 16px', borderRadius: 10, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 13.5, fontWeight: 800, cursor: 'pointer' };
