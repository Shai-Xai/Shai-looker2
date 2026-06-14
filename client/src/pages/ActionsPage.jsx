import { useOutletContext, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import CampaignManager from '../components/CampaignManager.jsx';

// The Action Engine as a first-class page in the client shell (promoted out of
// Settings). Clients act on their own entity; an admin in preview acts on the
// previewed client's.
export default function ActionsPage() {
  const { user, isAdmin } = useAuth();
  const { previewEntityId } = useOutletContext() || {};
  // The layout's context carries the active profile (client) or previewed client (admin).
  const entityId = previewEntityId || (isAdmin ? null : ((user?.entities || [])[0]?.id || (user?.entityIds || [])[0]));
  // "Make it happen": a briefing/digest suggestion arrives as ?goal=… and
  // opens a new campaign pre-filled with it.
  const [params] = useSearchParams();
  const initialGoal = params.get('goal') || '';
  const initialType = params.get('type') || ''; // a template/capability key from "Make it happen"
  const initialActionId = params.get('action') || ''; // deep link from an approval notification

  return (
    <main style={{ flex: 1, padding: '26px 22px', maxWidth: 1080, margin: '0 auto', width: '100%', boxSizing: 'border-box', overflowY: 'auto' }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 2 }}>Engage</div>
      <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 6 }}>📣 Campaigns</h1>
      <p style={{ color: 'var(--muted)', marginBottom: 18, fontSize: 14 }}>Turn your data into action — e.g. email customers who abandoned checkout. Preview the audience and copy, then explicitly approve the send.</p>
      {!entityId
        ? <p style={{ color: 'var(--muted)' }}>{isAdmin ? 'Open a client suite first so the preview knows which client to show.' : 'No client account is linked to your login yet.'}</p>
        : <CampaignManager entityId={entityId} scope={isAdmin ? 'admin' : 'my'} initialGoal={initialGoal} initialType={initialType} initialActionId={initialActionId} />}
    </main>
  );
}
