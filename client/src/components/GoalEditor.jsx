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
export default function GoalEditor({ entityId, suiteId, suites = [], goal, onClose, onSaved }) {
  const isMobile = useIsMobile();
  const editing = !!goal;
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
  const [pastSuites, setPastSuites] = useState([]); // other events to compare against
  const [cat, setCat] = useState(null);       // tile catalogue { dashboards: [...] }
  const [preview, setPreview] = useState(null); // live value of the picked tile
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);

  // Load the client's dashboards/tiles only when they choose tile-tracking.
  useEffect(() => {
    if (track !== 'tile' || cat || !entityId) return;
    api.getMyDigestTiles(entityId).then(setCat).catch(() => setCat({ dashboards: [] }));
  }, [track, cat, entityId]);

  // Live value of the chosen tile, so the target is set against the real number.
  useEffect(() => {
    if (track !== 'tile' || !dashboardId || !tileId || !activeSuite) { setPreview(null); return undefined; }
    let alive = true; setPreview({ loading: true });
    api.goalTileValue(activeSuite, dashboardId, tileId)
      .then((r) => { if (alive) setPreview({ value: r.value }); })
      .catch(() => { if (alive) setPreview({ value: null }); });
    return () => { alive = false; };
  }, [track, dashboardId, tileId, activeSuite]);

  // Candidate "previous events" to baseline against. Derive the entity from the
  // CURRENT suite (not the activeEntityId prop, which can be blank) so the picker
  // is reliable; prefer the same client's other events, but if there are none under
  // that entity, fall back to any other event the user can access (the resolver
  // still enforces per-event scope) so the picker never silently disappears.
  useEffect(() => {
    api.mySuites().then((all) => {
      const listAll = all || [];
      const cur = listAll.find((s) => s.id === activeSuite);
      const entId = cur?.entityId || entityId;
      const sameEntity = entId ? listAll.filter((s) => s.entityId === entId && s.id !== activeSuite) : [];
      setPastSuites(sameEntity.length ? sameEntity : listAll.filter((s) => s.id !== activeSuite));
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

  const dashboards = cat?.dashboards || [];
  // A goal tracks ONE headline number, so only single-value (KPI) tiles qualify —
  // a chart/table tile has no single "the number" (and the resolver would read its
  // first row, e.g. an early 0). Mirrors TileFrame's metric-tile test.
  const isKpi = (t) => { const v = t.visType || ''; return v === 'single_value' || v === 'single_value_period_over_period' || v.includes('bar_gauge'); };
  const tilesFor = (dId) => (dashboards.find((d) => d.dashboardId === dId)?.tiles || []).filter(isKpi);

  // Baseline UI state: do we have a usable "last time" number, are we auto-reading
  // it off a past event's tile, and did that read succeed?
  const baseFinite = baselineValue !== '' && Number.isFinite(Number(baselineValue));
  const autoMode = !!baselineSuiteId && track === 'tile'; // reading the same tile under a past event
  const resolvedOk = autoMode && !baselineLoading && baseFinite;

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
      unit, direction, display, byDate,
      isNorthStar: northStar,
      // Baseline persists whenever there's a number — whether read from a past
      // event's tile or typed in by hand (last year isn't always in Pulse).
      baselineEventId: baseNum != null ? baselineSuiteId : '',
      baselineValue: baseNum,
      baselineSource: baseNum != null ? (baselineSuiteId && track === 'tile' ? 'looker' : 'manual') : '',
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
          <span style={{ fontSize: 20 }}>🎯</span>
          <h2 style={{ fontSize: 17, fontWeight: 800, flex: 1 }}>{editing ? 'Edit goal' : 'Set a goal'}</h2>
          <button onClick={onClose} style={xBtn} aria-label="Close">✕</button>
        </div>

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
          {pastSuites.length > 0 && (
            <select value={baselineSuiteId} onChange={(e) => { setBaselineSuiteId(e.target.value); if (!e.target.value) setBaselineValue(''); }} style={inp}>
              <option value="">Enter it manually…</option>
              {pastSuites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          {autoMode && baselineLoading && <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--muted)' }}>reading last time…</div>}
          {autoMode && !baselineLoading && !baseFinite && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>Couldn’t read that tile for the chosen event — enter it below.</div>}
          {!resolvedOk && !(autoMode && baselineLoading) && (
            <input value={baselineValue} onChange={(e) => setBaselineValue(e.target.value)} placeholder="Last time’s value" inputMode="decimal" style={{ ...inp, marginTop: pastSuites.length > 0 ? 8 : 0 }} />
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

        <Field label="By (deadline)" hint="Defaults to event day">
          <input type="date" value={byDate} onChange={(e) => setByDate(e.target.value)} style={inp} />
        </Field>

        <Field label="Show it as">
          <div style={{ display: 'flex', gap: 8 }}>
            <Seg active={display === 'bar'} onClick={() => setDisplay('bar')}>▭ Bar</Seg>
            <Seg active={display === 'ring'} onClick={() => setDisplay('ring')}>◯ Circle</Seg>
            <Seg active={display === 'dial'} onClick={() => setDisplay('dial')}>◔ Dial</Seg>
          </div>
        </Field>

        <label style={northRow}>
          <input type="checkbox" checked={northStar} onChange={(e) => setNorthStar(e.target.checked)} />
          <span style={{ fontWeight: 700 }}>⭐ Make this the North Star</span>
          <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>the one headline goal for this event</span>
        </label>

        {err && <div style={{ color: 'var(--error, #dc2626)', fontSize: 12.5, marginTop: 10 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
          {editing && (confirmDel ? (
            <button onClick={del} disabled={busy} style={btnDanger} title="Confirm delete">Delete goal</button>
          ) : (
            <button onClick={() => setConfirmDel(true)} style={btnDelGhost} title="Delete this goal" aria-label="Delete goal">🗑</button>
          ))}
          <button onClick={onClose} style={btnGhost}>Cancel</button>
          <button onClick={save} disabled={busy} style={btnPrimary}>{busy ? 'Saving…' : (editing ? 'Save goal' : 'Set goal')}</button>
        </div>
      </div>
    </div>
  );
}

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

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 100 };
const sheet = { width: '100%', maxHeight: '90vh', overflowY: 'auto', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, padding: '18px 18px 20px', boxShadow: 'var(--shadow-lg, 0 12px 40px rgba(0,0,0,0.28))', color: 'var(--text)' };
const inp = { width: '100%', boxSizing: 'border-box', padding: '9px 11px', border: '1.5px solid var(--hairline)', borderRadius: 9, fontSize: 14, outline: 'none', background: 'var(--card)', color: 'var(--text)', fontFamily: 'inherit' };
const xBtn = { border: 'none', background: 'rgba(128,128,128,0.12)', color: 'var(--muted-2)', borderRadius: 980, width: 28, height: 28, fontSize: 13, cursor: 'pointer' };
const northRow = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6, padding: '10px 12px', border: '1px solid var(--hairline)', borderRadius: 10, cursor: 'pointer', fontSize: 13 };
const suggestBtn = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--brand)', borderRadius: 980, fontSize: 11.5, fontWeight: 700, padding: '3px 10px', cursor: 'pointer' };
const btnGhost = { flex: '0 0 auto', padding: '10px 16px', borderRadius: 10, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' };
const btnDanger = { flex: '0 0 auto', padding: '10px 14px', borderRadius: 10, border: 'none', background: 'var(--error, #dc2626)', color: '#fff', fontSize: 13.5, fontWeight: 800, cursor: 'pointer' };
const btnDelGhost = { flex: '0 0 auto', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--error, #dc2626)', fontSize: 15, cursor: 'pointer' };
const btnPrimary = { flex: 1, padding: '10px 16px', borderRadius: 10, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 13.5, fontWeight: 800, cursor: 'pointer' };
