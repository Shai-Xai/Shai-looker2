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
export default function GoalEditor({ entityId, suiteId, goal, onClose, onSaved }) {
  const isMobile = useIsMobile();
  const editing = !!goal;
  const hasTile = !!(goal?.metricRef?.tileId);
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
  const [cat, setCat] = useState(null);       // tile catalogue { dashboards: [...] }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Load the client's dashboards/tiles only when they choose tile-tracking.
  useEffect(() => {
    if (track !== 'tile' || cat || !entityId) return;
    api.getMyDigestTiles(entityId).then(setCat).catch(() => setCat({ dashboards: [] }));
  }, [track, cat, entityId]);

  const dashboards = cat?.dashboards || [];
  const tilesFor = (dId) => dashboards.find((d) => d.dashboardId === dId)?.tiles || [];

  async function save() {
    if (!name.trim()) { setErr('Give the goal a name.'); return; }
    if (track === 'tile' && (!dashboardId || !tileId)) { setErr('Pick the dashboard tile to track.'); return; }
    if (!target || Number.isNaN(Number(target))) { setErr('Set a numeric target.'); return; }
    setBusy(true); setErr('');
    const body = {
      name: name.trim(),
      source: 'manual', // resolution is driven by the tile ref below, not this label
      metricRef: track === 'tile' ? { dashboardId, tileId } : {},
      targetValue: Number(target),
      unit, direction, byDate,
      isNorthStar: northStar,
    };
    try {
      let saved;
      if (editing) saved = (await api.updateGoal(goal.id, body)).goal;
      else saved = (await api.createGoal(suiteId, body)).goal;
      // Manual goal with a starting value → record the first snapshot.
      if (track === 'manual' && current !== '' && !Number.isNaN(Number(current)) && saved?.id) {
        await api.goalSnapshot(saved.id, Number(current)).catch(() => {});
      }
      onSaved?.();
      onClose();
    } catch (e) { setErr(e.message || 'Could not save the goal.'); setBusy(false); }
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

        <Field label="How do you want to track it?">
          <div style={{ display: 'flex', gap: 8 }}>
            <Seg active={track === 'tile'} onClick={() => setTrack('tile')}>📊 From my dashboard</Seg>
            <Seg active={track === 'manual'} onClick={() => setTrack('manual')}>✍️ I'll enter it</Seg>
          </div>
        </Field>

        {track === 'tile' ? (
          <Field label="Which number?" hint="Pick the tile you already look at — the goal tracks that live number.">
            <select value={dashboardId} onChange={(e) => { setDashboardId(e.target.value); setTileId(''); }} style={inp}>
              <option value="">{cat ? 'Choose a dashboard…' : 'Loading…'}</option>
              {dashboards.map((d) => <option key={d.dashboardId} value={d.dashboardId}>{d.title}{d.setName ? ` · ${d.setName}` : ''}</option>)}
            </select>
            {dashboardId && (
              <select value={tileId} onChange={(e) => setTileId(e.target.value)} style={{ ...inp, marginTop: 8 }}>
                <option value="">Choose a tile…</option>
                {tilesFor(dashboardId).map((t) => <option key={t.tileId} value={t.tileId}>{t.title}</option>)}
              </select>
            )}
          </Field>
        ) : (
          <Field label="Current value (optional)" hint="You can update this any time; the goal tracks what you enter.">
            <input value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="e.g. 120000" inputMode="decimal" style={inp} />
          </Field>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <Field label="Target" style={{ flex: 1 }}>
            <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="e.g. 25000" inputMode="decimal" style={inp} />
          </Field>
          <Field label="Unit" style={{ width: 120 }}>
            <select value={unit} onChange={(e) => setUnit(e.target.value)} style={inp}>
              {['tickets', 'ZAR', '%', 'count'].map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </Field>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <Field label="Direction" style={{ flex: 1 }}>
            <select value={direction} onChange={(e) => setDirection(e.target.value)} style={inp}>
              <option value="at_least">Reach at least</option>
              <option value="at_most">Keep under</option>
            </select>
          </Field>
          <Field label="By (deadline)" style={{ flex: 1 }} hint="Defaults to event day">
            <input type="date" value={byDate} onChange={(e) => setByDate(e.target.value)} style={inp} />
          </Field>
        </div>

        <label style={northRow}>
          <input type="checkbox" checked={northStar} onChange={(e) => setNorthStar(e.target.checked)} />
          <span style={{ fontWeight: 700 }}>⭐ Make this the North Star</span>
          <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>the one headline goal for this event</span>
        </label>

        {err && <div style={{ color: 'var(--error, #dc2626)', fontSize: 12.5, marginTop: 10 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
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

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 100 };
const sheet = { width: '100%', maxHeight: '90vh', overflowY: 'auto', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, padding: '18px 18px 20px', boxShadow: 'var(--shadow-lg, 0 12px 40px rgba(0,0,0,0.28))', color: 'var(--text)' };
const inp = { width: '100%', boxSizing: 'border-box', padding: '9px 11px', border: '1.5px solid var(--hairline)', borderRadius: 9, fontSize: 14, outline: 'none', background: 'var(--card)', color: 'var(--text)', fontFamily: 'inherit' };
const xBtn = { border: 'none', background: 'rgba(128,128,128,0.12)', color: 'var(--muted-2)', borderRadius: 980, width: 28, height: 28, fontSize: 13, cursor: 'pointer' };
const northRow = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6, padding: '10px 12px', border: '1px solid var(--hairline)', borderRadius: 10, cursor: 'pointer', fontSize: 13 };
const btnGhost = { flex: '0 0 auto', padding: '10px 16px', borderRadius: 10, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' };
const btnPrimary = { flex: 1, padding: '10px 16px', borderRadius: 10, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 13.5, fontWeight: 800, cursor: 'pointer' };
