import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { getGuide } from '../lib/guides.js';
import GuideModal from './GuideModal.jsx';

// Light-touch "Getting started" card on the home page. Auto-detected steps tick
// themselves; manual ones get a "Mark done". Steps are grouped into plain phases
// and each carries a "Show me how" walkthrough. Hides once complete or dismissed.
export default function OnboardingCard({ entityId }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [guide, setGuide] = useState(null); // the open walkthrough, or null
  // Collapsed by default — it's a nudge, not the main event. The header (progress
  // bar + "N of M done") stays visible; the steps reveal on tap. Remembered per
  // entity so it stays the way you left it.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!entityId) { setData(null); return; }
    setOpen(localStorage.getItem(`howler_onboarding_open:${entityId}`) === '1');
    api.getMyOnboarding(entityId).then(setData).catch(() => setData(null));
  }, [entityId]);
  const toggle = () => setOpen((v) => { const n = !v; localStorage.setItem(`howler_onboarding_open:${entityId}`, n ? '1' : '0'); return n; });

  if (!entityId || !data || data.dismissed || data.complete || !(data.steps || []).length) return null;

  const mark = (key, done) => api.setMyOnboardingStep(entityId, key, done).then(setData).catch(() => {});
  const dismiss = () => api.dismissMyOnboarding(entityId).then(setData).catch(() => {});
  const pct = data.total ? Math.round((data.done / data.total) * 100) : 0;

  // Group steps into their plain-language phases, preserving server order.
  const groups = [];
  for (const s of data.steps) {
    const g = groups.find((x) => x.phase === (s.phase || ''));
    if (g) g.steps.push(s); else groups.push({ phase: s.phase || '', steps: [s] });
  }

  return (
    <section style={{ background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 16, padding: 18, marginBottom: 18, boxShadow: 'var(--shadow-sm)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <button type="button" onClick={toggle} style={{ display: 'flex', alignItems: 'baseline', gap: 10, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text)', textAlign: 'left' }} aria-expanded={open}>
          <span style={{ fontSize: 11, color: 'var(--muted)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s', display: 'inline-block' }}>▶</span>
          <span style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-0.01em' }}>🚀 Getting started</span>
          <span style={{ fontSize: 12.5, color: 'var(--muted)', fontWeight: 600 }}>{data.done} of {data.total} done</span>
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={dismiss} style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 12.5, cursor: 'pointer' }}>Dismiss</button>
      </div>
      <div style={{ height: 6, borderRadius: 999, background: 'rgba(128,128,128,0.15)', overflow: 'hidden', marginBottom: open ? 14 : 0 }}>
        <div style={{ height: '100%', width: `${pct}%`, background: 'var(--brand)', borderRadius: 999, transition: 'width .25s' }} />
      </div>
      {open && (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {groups.map((g) => (
          <div key={g.phase} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {g.phase && <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginTop: 8 }}>{g.phase}</div>}
            {g.steps.map((s) => (
              <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 4px', opacity: s.done ? 0.62 : 1 }}>
                <span style={{ fontSize: 18, width: 24, textAlign: 'center', flexShrink: 0 }}>{s.done ? '✅' : s.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, textDecoration: s.done ? 'line-through' : 'none' }}>{s.title}</div>
                  {!s.done && <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.4 }}>{s.desc}</div>}
                </div>
                {!s.done && (
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {s.guide && getGuide(s.guide) && (
                      <button type="button" onClick={() => setGuide(getGuide(s.guide))} style={tickBtn} title="Show me how">?</button>
                    )}
                    <button type="button" onClick={() => navigate(s.cta)} style={goBtn}>Go →</button>
                    {!s.auto && <button type="button" onClick={() => mark(s.key, true)} style={tickBtn} title="Mark this step done">✓</button>}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      )}
      {guide && <GuideModal guide={guide} onClose={() => setGuide(null)} />}
    </section>
  );
}

const goBtn = { padding: '6px 13px', borderRadius: 980, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
const tickBtn = { padding: '6px 10px', borderRadius: 980, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--muted)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' };
