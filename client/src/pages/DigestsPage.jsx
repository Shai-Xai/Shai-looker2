import { useOutletContext } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { useProfile } from '../lib/profile.jsx';
import DigestManager from '../components/DigestManager.jsx';
import DigestHistory from '../components/DigestHistory.jsx';
import HomeButton from '../components/HomeButton.jsx';

// Scheduled digests as a first-class page in the client shell (promoted out of
// Settings). Clients manage their own entity; an admin in preview manages the
// previewed client's.
export default function DigestsPage() {
  const { isAdmin } = useAuth();
  const { activeEntityId } = useProfile();
  const { previewEntityId } = useOutletContext() || {};
  // Always the client in context: the previewed client (admin) or the active
  // profile (client). Switching profile is how a multi-client login changes here.
  const entityId = previewEntityId || (isAdmin ? null : activeEntityId);

  return (
    <main style={{ flex: 1, padding: '26px 22px', maxWidth: 1080, margin: '0 auto', width: '100%', boxSizing: 'border-box', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
        <HomeButton />
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>🗓 Scheduled digests</h1>
      </div>
      <p style={{ color: 'var(--muted)', marginBottom: 18, fontSize: 14 }}>Automated briefing emails for your team — personalised by role (exec, marketing, finance…) and sent on your schedule.</p>
      {!entityId
        ? <p style={{ color: 'var(--muted)' }}>{isAdmin ? 'Open a client suite first so the preview knows which client to show.' : 'No client account is linked to your login yet.'}</p>
        : <><DigestManager entityId={entityId} scope={isAdmin ? 'admin' : 'my'} /><DigestHistory entityId={entityId} /></>}
    </main>
  );
}
