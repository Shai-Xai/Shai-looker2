import { useState } from 'react';

// A small ⓘ that reveals a short explainer on hover (desktop) or tap (touch) —
// used to tuck a page's helper text out of the vertical flow so the content
// below sits higher. Self-contained; renders inline next to whatever it follows.
export default function InfoTip({ children, label = 'What is this?', width = 270 }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button" aria-label={label} aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ width: 18, height: 18, borderRadius: '50%', border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--muted)', fontSize: 12, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, padding: 0, fontFamily: 'inherit' }}
      >ⓘ</button>
      {open && (
        <span
          role="tooltip"
          style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 40, width, maxWidth: '72vw', padding: '9px 11px', borderRadius: 10, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', boxShadow: '0 10px 30px rgba(0,0,0,0.22)', fontSize: 12, lineHeight: 1.4, fontWeight: 400, whiteSpace: 'normal', textAlign: 'left' }}
        >{children}</span>
      )}
    </span>
  );
}
