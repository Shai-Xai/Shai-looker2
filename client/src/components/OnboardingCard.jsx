import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { getGuide } from '../lib/guides.js';
import { firstDashboardPath } from '../lib/onboardingNav.js';
import GuideModal from './GuideModal.jsx';

// The "Getting started" journey card on the home page — the client side of the
// onboarding pack. Steps live in layered PHASES (fundamentals → goals & sends →
// the Owl everywhere → automate): the current phase is open and actionable, done
// phases fold away, later phases sit collapsed as "up next" so the path ahead is
// visible without being noisy. Auto-detected steps tick themselves; manual ones
// get a "Mark done". Hides once complete or dismissed. Mobile-first: one column,
// big tap targets.
export default function OnboardingCard({ entityId }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [guide, setGuide] = useState(null); // the open walkthrough, or null
  // Collapsed by default — it's a nudge, not the main event. The header (progress
  // bar + phase position) stays visible; the journey reveals on tap. Remembered
  // per entity so it stays the way you left it.
  const [open, setOpen] = useState(false);
  const [openPhase, setOpenPhase] = useState(null); // phase key the user opened, or null → current
  useEffect(() => {
    if (!entityId) { setData(null); return; }
    setOpen(localStorage.getItem(`howler_onboarding_open:${entityId}`) === '1');
    setOpenPhase(null);
    api.getMyOnboarding(entityId).then(setData).catch(() => setData(null));
  }, [entityId]);
  const toggle = () => setOpen((v) => { const n = !v; localStorage.setItem(`howler_onboarding_open:${entityId}`, n ? '1' : '0'); return n; });

  if (!entityId || !data || data.dismissed || data.complete || !(data.steps || []).length) return null;

  const mark = (key, done) => api.setMyOnboardingStep(entityId, key, done).then(setData).catch(() => {});
  // "Go" → the step's route, except "explore" resolves to a real dashboard (its
  // route is just '/', which would no-op since we're already on the home page).
  const goTo = async (s) => {
    if (s.key === 'explore') { const p = await firstDashboardPath(entityId); if (p) { navigate(p); return; } }
    navigate(s.cta || '/');
  };
  const dismiss = () => api.dismissMyOnboarding(entityId).then(setData).catch(() => {});
  const pct = data.total ? Math.round((data.done / data.total) * 100) : 0;

  const phases = data.phases || [];
  const currentIdx = Math.max(0, phases.findIndex((p) => p.key === data.currentPhase));
  const expandedKey = openPhase || data.currentPhase;
  const stepsOf = (p) => (data.steps || []).filter((s) => s.phase === p.key);

  const stepRow = (s) => (
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
          <button type="button" onClick={() => goTo(s)} style={goBtn}>Go →</button>
          {!s.auto && <button type="button" onClick={() => mark(s.key, true)} style={tickBtn} title="Mark this step done">✓</button>}
        </div>
      )}
    </div>
  );

  return (
    <section style={{ background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 16, padding: 18, marginBottom: 18, boxShadow: 'var(--shadow-sm)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <button type="button" onClick={toggle} style={{ display: 'flex', alignItems: 'baseline', gap: 10, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text)', textAlign: 'left' }} aria-expanded={open}>
          <span style={{ fontSize: 11, color: 'var(--muted)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s', display: 'inline-block' }}>▶</span>
          <span style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-0.01em' }}>🚀 Getting started</span>
          <span style={{ fontSize: 12.5, color: 'var(--muted)', fontWeight: 600 }}>
            {phases.length ? `Phase ${currentIdx + 1} of ${phases.length}` : ''} · {data.done} of {data.total} done
          </span>
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={dismiss} style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 12.5, cursor: 'pointer' }}>Dismiss</button>
      </div>
      <div style={{ height: 6, borderRadius: 999, background: 'rgba(128,128,128,0.15)', overflow: 'hidden', marginBottom: open ? 14 : 0 }}>
        <div style={{ height: '100%', width: `${pct}%`, background: 'var(--brand)', borderRadius: 999, transition: 'width .25s' }} />
      </div>
      {open && (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {phases.map((p, i) => {
          const expanded = p.key === expandedKey;
          const state = p.complete ? 'done' : (i === currentIdx ? 'current' : 'next');
          return (
            <div key={p.key} style={{ border: expanded ? '1.5px solid var(--brand)' : '1px solid var(--hairline)', borderRadius: 12, overflow: 'hidden', opacity: state === 'next' && !expanded ? 0.75 : 1 }}>
              <button type="button" onClick={() => setOpenPhase(expanded ? '__none' : p.key)} aria-expanded={expanded}
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', background: p.complete ? 'rgba(var(--brand-rgb),0.07)' : 'none', border: 'none', padding: '11px 12px', cursor: 'pointer', color: 'var(--text)', minHeight: 44 }}>
                <span style={{ fontSize: 17, flexShrink: 0 }}>{p.complete ? '✅' : p.icon}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13.5, fontWeight: 800 }}>
                    <span style={{ color: 'var(--muted)', fontWeight: 700 }}>Phase {i + 1} · </span>{p.title}
                    {state === 'current' && <span style={{ marginLeft: 8, fontSize: 10.5, fontWeight: 800, color: 'var(--brand)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>You are here</span>}
                    {state === 'next' && <span style={{ marginLeft: 8, fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Up next</span>}
                  </span>
                  {!expanded && <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.tagline}</span>}
                </span>
                <span style={{ fontSize: 12, fontWeight: 800, color: p.complete ? 'var(--brand)' : 'var(--muted)', flexShrink: 0 }}>{p.done}/{p.total}</span>
              </button>
              {expanded && (
                <div style={{ padding: '2px 10px 10px' }}>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 4px 6px', lineHeight: 1.4 }}>{p.tagline}</div>
                  {stepsOf(p).map(stepRow)}
                </div>
              )}
            </div>
          );
        })}
      </div>
      )}
      {guide && <GuideModal guide={guide} entityId={entityId} onClose={() => setGuide(null)} />}
    </section>
  );
}

const goBtn = { padding: '6px 13px', borderRadius: 980, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
const tickBtn = { padding: '6px 10px', borderRadius: 980, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--muted)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' };
