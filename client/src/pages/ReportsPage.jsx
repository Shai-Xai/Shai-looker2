import { useOutletContext } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { useProfile } from '../lib/profile.jsx';
import ReportStudio from '../components/ReportStudio.jsx';
import HomeButton from '../components/HomeButton.jsx';

// Report Studio as a first-class page in the client shell. Clients manage their
// own entity; an admin in preview manages the previewed client's. (Mirrors
// DigestsPage — same dual-surface convention.)
export default function ReportsPage() {
  const { isAdmin } = useAuth();
  const { activeEntityId } = useProfile();
  const { previewEntityId } = useOutletContext() || {};
  const entityId = previewEntityId || (isAdmin ? null : activeEntityId);

  return (
    <main style={{ flex: 1, padding: '26px 22px', maxWidth: 1080, margin: '0 auto', width: '100%', boxSizing: 'border-box', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
        <HomeButton />
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>📑 Reports</h1>
      </div>
      <p style={{ color: 'var(--muted)', marginBottom: 18, fontSize: 14 }}>Build polished reports from your dashboard tiles — with sections, notes and AI analysis — then share them by link or PDF, once-off or on a schedule.</p>
      {!entityId
        ? <p style={{ color: 'var(--muted)' }}>{isAdmin ? 'Open a client suite first so the preview knows which client to show.' : 'No client account is linked to your login yet.'}</p>
        : <ReportStudio entityId={entityId} scope={isAdmin ? 'admin' : 'my'} />}
    </main>
  );
}
