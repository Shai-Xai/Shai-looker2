// App-wide "Report" widget — a floating button on every screen (for staff AND
// clients) that opens the shared report form. Because it's mounted globally it
// auto-captures the screen the reporter was on. Bottom-LEFT so it never collides
// with the Owl chat launcher (bottom-right). The form itself lives in ReportForm.
import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
import ReportForm from './ReportForm.jsx';

// A readable label for the current screen (strip ids so it reads as an area).
function screenLabel(pathname) {
  if (!pathname || pathname === '/') return 'Home';
  return pathname;
}

export default function ReportWidget() {
  const { user } = useAuth();
  const location = useLocation();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  // Only for logged-in users; never on the login/recovery screens.
  if (!user) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Report a bug or idea"
        title="Report a bug, improvement or idea"
        style={{
          // Bottom-left, but on desktop the persistent sidebar pins the account
          // "ProfileFooter" here — sit ABOVE it so both stay visible/tappable. On
          // mobile the nav is a drawer (no fixed footer), so keep it low.
          position: 'fixed', bottom: isMobile ? 20 : 88, left: isMobile ? 16 : 24, zIndex: 54,
          width: 54, height: 54, borderRadius: '50%', border: '1px solid var(--hairline)',
          background: 'var(--card)', boxShadow: '0 6px 22px rgba(0,0,0,0.3)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22,
        }}
      >💬</button>
      <ReportForm open={open} onClose={() => setOpen(false)} screen={screenLabel(location.pathname)} />
    </>
  );
}
