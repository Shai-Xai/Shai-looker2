import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';

// Light-touch "Getting started" card on the home page. Auto-detected steps tick
// themselves; manual ones get a "Mark done". Hides once complete or dismissed.
export default function OnboardingCard({ entityId }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  useEffect(() => {
    if (!entityId) { setData(null); return; }
    api.getMyOnboarding(entityId).then(setData).catch(() => setData(null));
  }, [entityId]);

  if (!entityId || !data || data.dismissed || data.complete || !(data.steps || []).length) return null;

  const mark = (key, done) => api.setMyOnboardingStep(entityId, key, done).then(setData).catch(() => {});
  const dismiss = () => api.dismissMyOnboarding(entityId).then(setData).catch(() => {});
  const pct = data.total ? Math.round((data.done / data.total) * 100) : 0;

  return (
    <section style={{ background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 16, padding: 18, marginBottom: 18, boxShadow: 'var(--shadow-sm)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-0.01em' }}>🚀 Getting started</span>
        <span style={{ fontSize: 12.5, color: 'var(--muted)', fontWeight: 600 }}>{data.done} of {data.total} done</span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={dismiss} style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 12.5, cursor: 'pointer' }}>Dismiss</button>
      </div>
      <div style={{ height: 6, borderRadius: 999, background: 'rgba(128,128,128,0.15)', overflow: 'hidden', marginBottom: 14 }}>
        <div style={{ height: '100%', width: `${pct}%`, background: 'var(--brand)', borderRadius: 999, transition: 'width .25s' }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {data.steps.map((s) => (
          <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 4px', opacity: s.done ? 0.62 : 1 }}>
            <span style={{ fontSize: 18, width: 24, textAlign: 'center', flexShrink: 0 }}>{s.done ? '✅' : s.icon}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, textDecoration: s.done ? 'line-through' : 'none' }}>{s.title}</div>
              {!s.done && <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.4 }}>{s.desc}</div>}
            </div>
            {!s.done && (
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button type="button" onClick={() => navigate(s.cta)} style={goBtn}>Go →</button>
                {!s.auto && <button type="button" onClick={() => mark(s.key, true)} style={tickBtn} title="Mark this step done">✓</button>}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

const goBtn = { padding: '6px 13px', borderRadius: 980, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
const tickBtn = { padding: '6px 10px', borderRadius: 980, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--muted)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' };
