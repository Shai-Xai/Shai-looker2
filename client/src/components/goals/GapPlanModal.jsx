import { useIsMobile } from '../../lib/useIsMobile.js';

// "Close the gap" plan — the Owl acting as marketing & insights manager: the specific
// nuggets from the event's data (ticket types, segments, demographics, channels) that
// can push a behind/short goal to target, and a recommended targeted campaign. The
// "Launch this campaign" button hands the AI's campaign goal to the campaign editor.
export default function GapPlanModal({ goalName, state, onClose, onLaunch, onOpenDashboard }) {
  const isMobile = useIsMobile();
  const plan = state?.plan;
  return (
    <div style={overlay} onClick={onClose}>
      <div style={{ ...sheet, maxWidth: isMobile ? '100%' : 520 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 18 }}>⚡</span>
          <h2 style={{ fontSize: 16, fontWeight: 800, flex: 1, minWidth: 0 }}>Close the gap{goalName ? ` — ${goalName}` : ''}</h2>
          <button onClick={onClose} style={xBtn} aria-label="Close">✕</button>
        </div>

        {state?.loading && (
          <div style={{ padding: '22px 4px', color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.5 }}>
            🔎 Reading this event’s data for the opportunities that can close the gap — ticket types, segments, cities, ages, channels…
          </div>
        )}
        {state?.error && (
          <div style={{ padding: '16px 4px', color: 'var(--error,#dc2626)', fontSize: 13.5 }}>Couldn’t build a plan: {state.error}</div>
        )}

        {plan && (
          <div>
            {plan.summary && <p style={{ fontSize: 14, lineHeight: 1.5, margin: '2px 0 12px' }}>{plan.summary}</p>}

            {Array.isArray(plan.nuggets) && plan.nuggets.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
                {plan.nuggets.map((n, i) => (
                  <div key={i} style={{ border: '1px solid var(--hairline)', borderRadius: 10, padding: '10px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <span style={{ fontSize: 13.5, fontWeight: 800, flex: 1 }}>{n.headline}</span>
                      {n.dashboardId && onOpenDashboard && (
                        <button onClick={() => onOpenDashboard(n.dashboardId)} style={miniLink}>view →</button>
                      )}
                    </div>
                    {n.detail && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.45 }}>{n.detail}</div>}
                  </div>
                ))}
              </div>
            )}

            <div style={{ background: 'rgba(128,128,128,0.07)', borderRadius: 10, padding: '11px 12px', marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginBottom: 6 }}>Recommended campaign</div>
              {plan.audience && <Line label="Audience" value={plan.segmentName ? `${plan.segmentName} — ${plan.audience}` : plan.audience} />}
              {plan.angle && <Line label="Angle" value={plan.angle} />}
            </div>

            <button onClick={() => onLaunch(plan)} style={launchBtn}>⚡ Launch this campaign</button>
            <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', marginTop: 7 }}>Opens the campaign editor pre-filled — you review and send.</div>
          </div>
        )}
      </div>
    </div>
  );
}

function Line({ label, value }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 13, padding: '3px 0' }}>
      <span style={{ color: 'var(--muted)', fontWeight: 700, flexShrink: 0, minWidth: 64 }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 110 };
const sheet = { width: '100%', maxHeight: '90vh', overflowY: 'auto', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, padding: '18px 18px 20px', boxShadow: 'var(--shadow-lg, 0 12px 40px rgba(0,0,0,0.28))', color: 'var(--text)' };
const xBtn = { border: 'none', background: 'rgba(128,128,128,0.12)', color: 'var(--muted-2)', borderRadius: 980, width: 28, height: 28, fontSize: 13, cursor: 'pointer', flexShrink: 0 };
const miniLink = { border: 'none', background: 'transparent', color: 'var(--brand)', fontWeight: 700, fontSize: 11.5, cursor: 'pointer', padding: 0, flexShrink: 0 };
const launchBtn = { display: 'block', width: '100%', boxSizing: 'border-box', padding: '12px 16px', borderRadius: 10, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 14, fontWeight: 800, cursor: 'pointer' };
