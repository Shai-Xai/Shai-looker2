import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useIsMobile } from '../../lib/useIsMobile.js';
import { Ring, Dial, Bar, goalState, fmtVal } from './GoalViz.jsx';

// The goal DETAIL view — the read surface for a goal. Tapping a goal card (on the
// home strip or the Goals page) opens this; Edit/Delete live in here, so the card
// itself is no longer an edit trap (the mobile fix). Shows progress big, the pace
// state, "vs last time" (baseline), the source, and an event link through to the
// dashboard the goal is tracked from. Milestones (Slice C) render here later.
export default function GoalDetail({ goal, suiteName, onEdit, onDelete, onClose, onOpenEvent, onChanged, canManage = true, me, contributors = [], linkedGoalName }) {
  const isMobile = useIsMobile();
  const [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [manualVal, setManualVal] = useState('');
  if (!goal) return null;
  const p = goal.progress || {};
  const { tone, chip } = goalState(goal, p);
  const viz = goal.display || 'bar';
  const ref = goal.metricRef || {};
  const tileSourced = !!(ref.dashboardId && ref.tileId);
  const hasBaseline = goal.baselineValue != null && Number.isFinite(Number(goal.baselineValue));

  async function saveManual() {
    const v = Number(manualVal);
    if (!Number.isFinite(v)) return;
    setBusy(true);
    try { await api.goalSnapshot(goal.id, v); setManualVal(''); onChanged?.(); }
    finally { setBusy(false); }
  }
  async function del() {
    setBusy(true);
    try { await api.deleteGoal(goal.id); onDelete?.(); }
    finally { setBusy(false); }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={{ ...sheet, maxWidth: isMobile ? '100%' : 460 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          {goal.isNorthStar && <span title="North Star" style={{ fontSize: 16 }}>⭐</span>}
          <h2 style={{ fontSize: 17, fontWeight: 800, flex: 1, minWidth: 0 }}>{goal.name}</h2>
          <button onClick={onClose} style={xBtn} aria-label="Close">✕</button>
        </div>

        {/* Progress — the big number, with the chosen viz. */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '14px 0 6px' }}>
          {viz === 'bar' ? (
            <div style={{ width: '100%' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 30, fontWeight: 800 }}>{fmtVal(p.value, goal.unit)}</span>
                <span style={{ fontSize: 14, color: 'var(--muted)' }}>of {fmtVal(goal.targetValue, goal.unit)}{p.pct != null ? ` · ${p.pct}%` : ''}</span>
              </div>
              <Bar pct={p.pct} tone={tone} />
            </div>
          ) : (
            <>
              {viz === 'ring' ? <Ring pct={p.pct} tone={tone} size={132} /> : <Dial pct={p.pct} tone={tone} size={150} />}
              <div style={{ fontSize: 14, color: 'var(--muted)' }}>{fmtVal(p.value, goal.unit)} / {fmtVal(goal.targetValue, goal.unit)}</div>
            </>
          )}
          {chip && <div>{chip}</div>}
        </div>

        {/* Pace line — only when a deadline gives an "expected by now". */}
        {p.expected != null && p.status && p.status !== 'final' && (
          <div style={row}>
            <span style={rowLabel}>Pace</span>
            <span style={{ color: p.status === 'behind' ? 'var(--error,#dc2626)' : 'var(--text)' }}>
              {p.status === 'behind' ? 'Behind' : p.status === 'ahead' ? 'Ahead of' : 'On'} pace · expected ≈ {fmtVal(p.expected, goal.unit)} by now
            </span>
          </div>
        )}

        {/* "vs last time" — apples-to-apples at the equivalent point in the cycle when a
            curve is linked (lastAtNow), with last time's final total as a secondary line;
            otherwise the plain baseline comparison. */}
        {p.lastAtNow != null ? (
          <>
            <div style={row}>
              <span style={rowLabel}>vs last time</span>
              <span>last time had {fmtVal(p.lastAtNow, goal.unit)} by now{p.value != null ? deltaText(p.value, p.lastAtNow) : ''}</span>
            </div>
            {p.baselineFinal != null && (
              <div style={row}><span style={rowLabel}>Last time total</span><span>{fmtVal(p.baselineFinal, goal.unit)}</span></div>
            )}
          </>
        ) : hasBaseline ? (
          <div style={row}>
            <span style={rowLabel}>vs last time</span>
            <span>{fmtVal(goal.baselineValue, goal.unit)}{p.value != null ? deltaText(p.value, goal.baselineValue) : ''}</span>
          </div>
        ) : null}

        {/* Deadline */}
        {goal.byDate && (
          <div style={row}><span style={rowLabel}>By</span><span>{fmtDate(goal.byDate)}</span></div>
        )}

        {/* Checkpoints — pace is measured against the nearest upcoming one. */}
        {Array.isArray(p.milestones) && p.milestones.length > 0 && (
          <div style={{ paddingTop: 8, borderTop: '1px solid var(--hairline)' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 4 }}>Checkpoints</div>
            {p.milestones.map((m, i) => {
              const hit = p.value != null && (goal.direction === 'at_most' ? p.value <= m.targetValue : p.value >= m.targetValue);
              const isNext = p.nextMilestone && p.nextMilestone.byDate === m.byDate && p.nextMilestone.targetValue === m.targetValue;
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '4px 0', fontSize: 13 }}>
                  <span style={{ width: 18, flexShrink: 0 }}>{hit ? '✅' : isNext ? '➡️' : '○'}</span>
                  <span style={{ flex: 1, color: isNext ? 'var(--text)' : 'var(--muted)', fontWeight: isNext ? 700 : 500 }}>{fmtDate(m.byDate)}</span>
                  {m.lastValue != null && <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>last time {fmtVal(m.lastValue, goal.unit)}</span>}
                  <span style={{ fontWeight: 700 }}>{fmtVal(m.targetValue, goal.unit)}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Source + event link */}
        <div style={row}>
          <span style={rowLabel}>Source</span>
          <span>{tileSourced ? '📊 Live from a dashboard tile' : '✍️ You enter the value'}</span>
        </div>
        {suiteName && (
          <div style={row}>
            <span style={rowLabel}>Event</span>
            <button onClick={() => onOpenEvent?.(tileSourced ? ref.dashboardId : null)} style={eventLink}
              title={tileSourced ? 'Open the source dashboard' : 'Open this event'}>
              {suiteName} →
            </button>
          </div>
        )}

        {/* Personal-goal context: owner (if not you), visibility, and the event goal it feeds. */}
        {goal.scope === 'personal' && (
          <>
            {goal.ownerRef && goal.ownerRef !== me && (
              <div style={row}><span style={rowLabel}>Owner</span><span>{goal.ownerRef}</span></div>
            )}
            <div style={row}><span style={rowLabel}>Visibility</span><span>{goal.visibility === 'private' ? '🔒 Private — you + admins' : '👥 Visible to the team'}</span></div>
            {linkedGoalName && (
              <div style={row}><span style={rowLabel}>Contributes to</span><span>{linkedGoalName}</span></div>
            )}
          </>
        )}

        {/* Event goal: the personal goals rolling up into it. */}
        {contributors.length > 0 && (
          <div style={{ paddingTop: 8, borderTop: '1px solid var(--hairline)' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 4 }}>Contributing personal goals</div>
            {contributors.map((c) => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '4px 0', fontSize: 13 }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}{c.ownerRef ? ` · ${c.ownerRef}` : ''}</span>
                <span style={{ fontWeight: 700, color: 'var(--muted)', flexShrink: 0 }}>{c.progress && c.progress.pct != null ? `${c.progress.pct}%` : '—'}</span>
              </div>
            ))}
          </div>
        )}

        {/* Manual goals: quick value update (the universal fallback / sponsorship). */}
        {!tileSourced && canManage && (
          <div style={{ marginTop: 12, padding: '10px 12px', background: 'rgba(128,128,128,0.07)', borderRadius: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Update the current value</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={manualVal} onChange={(e) => setManualVal(e.target.value)} placeholder={p.value != null ? String(p.value) : 'e.g. 120000'} inputMode="decimal" style={inp} />
              <button onClick={saveManual} disabled={busy || manualVal === ''} style={btnPrimarySm}>{busy ? '…' : 'Save'}</button>
            </div>
          </div>
        )}

        {canManage && (
          <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
            {confirmDel ? (
              <button onClick={del} disabled={busy} style={btnDanger}>Delete goal</button>
            ) : (
              <button onClick={() => setConfirmDel(true)} style={btnDelGhost} title="Delete this goal" aria-label="Delete goal">🗑</button>
            )}
            <span style={{ flex: 1 }} />
            <button onClick={onEdit} style={btnPrimary}>Edit goal</button>
          </div>
        )}
      </div>
    </div>
  );
}

function deltaText(value, baseline) {
  const b = Number(baseline); if (!b) return '';
  const pct = Math.round(((Number(value) - b) / Math.abs(b)) * 100);
  if (!Number.isFinite(pct) || pct === 0) return ' · same';
  return ` · ${pct > 0 ? '+' : ''}${pct}%`;
}
function fmtDate(s) {
  const d = new Date(s); if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 100 };
const sheet = { width: '100%', maxHeight: '90vh', overflowY: 'auto', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, padding: '18px 18px 20px', boxShadow: 'var(--shadow-lg, 0 12px 40px rgba(0,0,0,0.28))', color: 'var(--text)' };
const row = { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--hairline)', fontSize: 13.5 };
const rowLabel = { fontSize: 12, fontWeight: 700, color: 'var(--muted)', width: 92, flexShrink: 0 };
const eventLink = { border: 'none', background: 'transparent', color: 'var(--brand)', fontWeight: 700, fontSize: 13.5, cursor: 'pointer', padding: 0, fontFamily: 'inherit' };
const xBtn = { border: 'none', background: 'rgba(128,128,128,0.12)', color: 'var(--muted-2)', borderRadius: 980, width: 28, height: 28, fontSize: 13, cursor: 'pointer', flexShrink: 0 };
const inp = { flex: 1, boxSizing: 'border-box', padding: '8px 11px', border: '1.5px solid var(--hairline)', borderRadius: 9, fontSize: 14, outline: 'none', background: 'var(--card)', color: 'var(--text)', fontFamily: 'inherit' };
const btnPrimary = { padding: '10px 16px', borderRadius: 10, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 13.5, fontWeight: 800, cursor: 'pointer' };
const btnPrimarySm = { padding: '8px 14px', borderRadius: 9, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', flexShrink: 0 };
const btnDanger = { padding: '10px 14px', borderRadius: 10, border: 'none', background: 'var(--error, #dc2626)', color: '#fff', fontSize: 13.5, fontWeight: 800, cursor: 'pointer' };
const btnDelGhost = { padding: '10px 12px', borderRadius: 10, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--error, #dc2626)', fontSize: 15, cursor: 'pointer' };
