import { useOutletContext } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import SegmentManager from '../components/SegmentManager.jsx';

// Segments — reusable live audiences, part of the "Engage" area (alongside
// Campaigns). Automations / Templates / Connections will join this group later.
export default function SegmentsPage() {
  const { user, isAdmin } = useAuth();
  const { previewEntityId } = useOutletContext() || {};
  const entityId = previewEntityId || (isAdmin ? null : ((user?.entities || [])[0]?.id || (user?.entityIds || [])[0]));

  return (
    <main style={{ flex: 1, padding: '26px 22px', maxWidth: 1080, margin: '0 auto', width: '100%', boxSizing: 'border-box', overflowY: 'auto' }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 2 }}>Engage</div>
      <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 6 }}>🎯 Segments</h1>
      <p style={{ color: 'var(--muted)', marginBottom: 18, fontSize: 14 }}>Build reusable, always-live audiences from your data — then act on them in campaigns.</p>
      {!entityId
        ? <p style={{ color: 'var(--muted)' }}>{isAdmin ? 'Open a client suite first so the preview knows which client to show.' : 'No client account is linked to your login yet.'}</p>
        : <SegmentManager entityId={entityId} scope={isAdmin ? 'admin' : 'my'} />}
    </main>
  );
}
