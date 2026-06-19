import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useIsMobile } from '../lib/useIsMobile.js';

// Reusable, mobile-first stepped walkthrough. One card at a time, progress dots,
// Back / Next, a Skip-all escape, and an optional "do it now" CTA per step that
// navigates into the app. Drives every guide: the first-run essentials wizard,
// per-task walkthroughs and the feature explainers (content lives in guides.js).
//
//   <GuideModal guide={GUIDES.briefing} onClose={() => setOpen(false)} />
//
export default function GuideModal({ guide, onClose, onComplete }) {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [i, setI] = useState(0);
  const steps = guide?.steps || [];
  const step = steps[i];
  const last = i === steps.length - 1;

  const close = useCallback(() => { onClose && onClose(); }, [onClose]);
  const next = () => { if (last) { onComplete && onComplete(); close(); } else setI((n) => n + 1); };
  const back = () => setI((n) => Math.max(0, n - 1));
  const doCta = () => { const to = step?.cta?.to; if (onComplete) onComplete(); close(); if (to) navigate(to); };

  // Esc closes; arrow keys page through — same affordances on phone and desktop.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // re-bind each render so next/back see the current step

  if (!guide || !step) return null;

  return (
    <div
      role="dialog" aria-modal="true" aria-label={guide.title}
      onClick={close}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: isMobile ? 'flex-end' : 'center', justifyContent: 'center', padding: isMobile ? 0 : 20 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="msg-in"
        style={{
          background: 'var(--card)', color: 'var(--text)', width: '100%', maxWidth: isMobile ? '100%' : 460,
          borderRadius: isMobile ? '20px 20px 0 0' : 18, border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg, 0 12px 40px rgba(0,0,0,0.25))',
          padding: '20px 20px 16px', display: 'flex', flexDirection: 'column', maxHeight: isMobile ? '88vh' : '82vh', boxSizing: 'border-box',
        }}
      >
        {/* Header: progress dots + close */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 6, flex: 1 }}>
            {steps.map((_, n) => (
              <span key={n} style={{ height: 5, flex: 1, maxWidth: 34, borderRadius: 999, background: n <= i ? 'var(--brand)' : 'rgba(128,128,128,0.22)', transition: 'background .2s' }} />
            ))}
          </div>
          <button type="button" onClick={close} aria-label="Close" style={{ flexShrink: 0, width: 32, height: 32, borderRadius: 980, border: 'none', background: 'rgba(128,128,128,0.12)', color: 'var(--muted)', fontSize: 16, cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', textAlign: 'center', padding: '4px 6px 8px' }}>
          {step.icon && <div style={{ fontSize: 40, marginBottom: 12, lineHeight: 1 }}>{step.icon}</div>}
          <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: '-0.01em', marginBottom: 8 }}>{step.title}</div>
          <p style={{ fontSize: 14.5, lineHeight: 1.6, color: 'var(--muted-2, var(--muted))', margin: 0 }}>{step.body}</p>
          {step.cta && (
            <button type="button" onClick={doCta} style={{ marginTop: 18, padding: '11px 20px', minHeight: 44, borderRadius: 980, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
              {step.cta.label} →
            </button>
          )}
        </div>

        {/* Footer nav */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--hairline)' }}>
          {i > 0
            ? <button type="button" onClick={back} style={navBtn}>← Back</button>
            : <button type="button" onClick={close} style={{ ...navBtn, color: 'var(--muted)' }}>Skip</button>}
          <span style={{ flex: 1, textAlign: 'center', fontSize: 12, color: 'var(--muted)' }}>{i + 1} of {steps.length}</span>
          <button type="button" onClick={next} style={{ ...navBtn, background: 'var(--brand)', color: '#fff', border: 'none' }}>{last ? 'Done' : 'Next →'}</button>
        </div>
      </div>
    </div>
  );
}

const navBtn = { minHeight: 40, padding: '9px 16px', borderRadius: 980, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' };
