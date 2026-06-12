import { useOutletContext } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import DigestManager from '../components/DigestManager.jsx';

// Scheduled digests as a first-class page in the client shell (promoted out of
// Settings). Clients manage their own entity; an admin in preview manages the
// previewed client's.
export default function DigestsPage() {
  const { user, isAdmin } = useAuth();
  const { previewEntityId } = useOutletContext() || {};
  // The layout's context carries the active profile (client) or previewed client (admin).
  const entityId = previewEntityId || (isAdmin ? null : ((user?.entities || [])[0]?.id || (user?.entityIds || [])[0]));

  return (
    <main style={{ flex: 1, padding: '26px 22px', maxWidth: 1080, margin: '0 auto', width: '100%', boxSizing: 'border-box', overflowY: 'auto' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 6 }}>🗓 Scheduled digests</h1>
      <p style={{ color: 'var(--muted)', marginBottom: 18, fontSize: 14 }}>Automated briefing emails for your team — personalised by role (exec, marketing, finance…) and sent on your schedule.</p>
      {!entityId
        ? <p style={{ color: 'var(--muted)' }}>{isAdmin ? 'Open a client suite first so the preview knows which client to show.' : 'No client account is linked to your login yet.'}</p>
        : <DigestManager entityId={entityId} scope={isAdmin ? 'admin' : 'my'} />}
    </main>
  );
}
