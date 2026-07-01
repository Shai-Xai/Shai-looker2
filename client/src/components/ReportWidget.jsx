// App-wide host for the "Report a bug/idea" modal. There's no floating button any
// more — the entry points live in the LEFT NAV of each shell (ClientLayout +
// AdminPage), which call openReport() to open this. Mounted globally so the form
// (and the current-screen capture) works from anywhere. Form lives in ReportForm.
import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import ReportForm from './ReportForm.jsx';

const REPORT_EVENT = 'pulse:open-report';
// Open the report modal from anywhere (e.g. a left-nav "Report an issue" item).
export function openReport() {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(REPORT_EVENT));
}

// A readable label for the current screen (strip ids so it reads as an area).
function screenLabel(pathname) {
  if (!pathname || pathname === '/') return 'Home';
  return pathname;
}

export default function ReportWidget() {
  const { user } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(REPORT_EVENT, onOpen);
    return () => window.removeEventListener(REPORT_EVENT, onOpen);
  }, []);

  // Only for logged-in users; never on the login/recovery screens.
  if (!user) return null;

  return <ReportForm open={open} onClose={() => setOpen(false)} screen={screenLabel(location.pathname)} />;
}
