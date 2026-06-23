import { useNavigate, useLocation } from 'react-router-dom';

// A round "back" affordance, twin of HomeButton. Goes to the previous page you
// were on (browser/app history). When there's no in-app history to pop (a fresh
// tab, a deep link), it falls back to `fallback` so the button is never a
// dead-end. Hidden entirely when there's nothing sensible to go back to and no
// fallback is wanted (pass `hideWhenNoHistory`).
export default function BackButton({ fallback = '/', style, title = 'Back', hideWhenNoHistory = false }) {
  const navigate = useNavigate();
  const location = useLocation();
  // react-router stamps a non-'default' key once we've navigated within the app,
  // so this tells us a back() will stay inside Pulse rather than leave the SPA.
  const hasHistory = location.key !== 'default';
  if (!hasHistory && hideWhenNoHistory) return null;
  const onClick = () => { if (hasHistory) navigate(-1); else navigate(fallback); };
  return (
    <button onClick={onClick} title={title} aria-label={title} className="btn-key" style={{ ...backBtn, ...style }}>
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M15 18l-6-6 6-6" />
      </svg>
    </button>
  );
}

const backBtn = { flexShrink: 0, width: 34, height: 34, borderRadius: '50%', background: 'rgba(128,128,128,0.15)', color: 'var(--text)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none', border: 'none', cursor: 'pointer' };
