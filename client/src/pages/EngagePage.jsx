import { useParams, useSearchParams, useNavigate, useOutletContext } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { useProfile } from '../lib/profile.jsx';
import { vtNavigate } from '../lib/viewTransition.js';
import PageHeader from '../components/PageHeader.jsx';
import CampaignManager from '../components/CampaignManager.jsx';
import SegmentManager from '../components/SegmentManager.jsx';
import AudienceHub from '../components/AudienceHub.jsx';
import TemplateManager from '../components/TemplateManager.jsx';
import JourneyWizard from '../components/JourneyWizard.jsx';
import ChottuLinks from '../components/ChottuLinks.jsx';

// Engage — the Action layer of the Experience OS as one first-class area.
// Sub-areas live as tabs: Campaigns + Segments today; Automations, Templates and
// Connections are reserved (shown as "soon") so the shape of the area is legible
// before each ships. Deep links to /actions and /segments redirect in here.
const TABS = [
  { key: 'campaigns', label: 'Campaigns', icon: '📣', ready: true },
  { key: 'journeys', label: 'Journeys', icon: '🧭', ready: true },
  { key: 'segments', label: 'Segments', icon: '🥧', ready: true },
  { key: 'audiences', label: 'Ad audiences', icon: '🎯', ready: true },
  { key: 'automations', label: 'Automations', icon: '⏱', ready: false },
  { key: 'links', label: 'Links', icon: '🔗', ready: true },
  { key: 'templates', label: 'Templates', icon: '📝', ready: true },
  { key: 'connections', label: 'Connections', icon: '🔌', ready: false },
];

export default function EngagePage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const { activeEntityId } = useProfile();
  const { previewEntityId } = useOutletContext() || {};
  // Always the client in context: the previewed client (admin) or the active
  // profile (client). Switching profile is how a multi-client login changes here.
  const entityId = previewEntityId || (isAdmin ? null : activeEntityId);
  const [params] = useSearchParams();

  const active = TABS.find((t) => t.key === tab && t.ready) ? tab : 'campaigns';
  const go = (key) => { if (key !== active) vtNavigate(navigate, `/engage/${key}`); };

  // "Make it happen" + approval deep links ride in on the Campaigns tab.
  const initialGoal = params.get('goal') || '';
  const initialType = params.get('type') || '';
  const initialActionId = params.get('action') || '';
  // The dashboard + event a "Worth a look" suggestion pointed at — so the campaign
  // editor scopes its pre-filled audience to that exact tile/event.
  const initialDashboardId = params.get('dashboard') || '';
  const initialSuiteId = params.get('suite') || '';
  // A goal-gap plan can also name a saved SEGMENT — pre-select it as the audience.
  const initialSegmentName = params.get('segment') || '';

  return (
    <main style={{ flex: 1, padding: '26px 22px', maxWidth: 1080, margin: '0 auto', width: '100%', boxSizing: 'border-box', overflowY: 'auto' }}>
      <PageHeader kicker="Engage" title="Turn data into action" />

      {/* Tab bar — scrolls horizontally on small screens (mobile-first) and
          sticks to the top of the scroll area so it stays in reach while the
          tab's content scrolls under it. Page-bg background masks that content;
          negative side margins + padding let it span the main's edge padding. */}
      <div className="no-scrollbar" style={{ position: 'sticky', top: 0, zIndex: 5, display: 'flex', gap: 6, overflowX: 'auto', borderBottom: '1px solid var(--hairline)', marginBottom: 18, marginLeft: -22, marginRight: -22, padding: '6px 22px 0', background: 'var(--bg)', WebkitOverflowScrolling: 'touch' }}>
        {TABS.map((t) => {
          const on = t.key === active;
          return (
            <button
              key={t.key}
              onClick={() => t.ready && go(t.key)}
              disabled={!t.ready}
              title={t.ready ? '' : 'Coming soon'}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
                minHeight: 40, padding: '8px 14px', border: 'none', background: 'none',
                borderBottom: on ? '2px solid var(--brand)' : '2px solid transparent',
                color: on ? 'var(--brand)' : t.ready ? 'var(--text)' : 'var(--muted)',
                fontWeight: on ? 700 : 600, fontSize: 13.5, cursor: t.ready ? 'pointer' : 'default',
                opacity: t.ready ? 1 : 0.55, marginBottom: -1,
              }}
            >
              <span style={{ fontSize: 15 }}>{t.icon}</span>{t.label}
              {!t.ready && <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', background: 'rgba(128,128,128,0.16)', color: 'var(--muted)', borderRadius: 980, padding: '1px 6px' }}>soon</span>}
            </button>
          );
        })}
      </div>

      {!entityId ? (
        <p style={{ color: 'var(--muted)' }}>{isAdmin ? 'Open a client suite first so the preview knows which client to show.' : 'No client account is linked to your login yet.'}</p>
      ) : active === 'segments' ? (
        <>
          <p style={{ color: 'var(--muted)', marginBottom: 18, fontSize: 14 }}>Build reusable, always-live audiences from your data — then act on them in campaigns.</p>
          <SegmentManager entityId={entityId} scope={isAdmin ? 'admin' : 'my'} />
        </>
      ) : active === 'journeys' ? (
        <>
          <p style={{ color: 'var(--muted)', marginBottom: 18, fontSize: 14 }}>Build a multi-step, multi-channel journey by chatting to the Owl — describe what you want, it drafts a branching journey (grounded in your saved audiences) and refines it as you talk. You review it before anything is created.</p>
          <JourneyWizard entityId={entityId} scope={isAdmin ? 'admin' : 'my'} />
        </>
      ) : active === 'audiences' ? (
        <>
          <p style={{ color: 'var(--muted)', marginBottom: 18, fontSize: 14 }}>Every audience Pulse mirrors to your Meta &amp; TikTok ad accounts — connection health, live size and status, all in one place.</p>
          <AudienceHub entityId={entityId} />
        </>
      ) : active === 'links' ? (
        <>
          <p style={{ color: 'var(--muted)', marginBottom: 18, fontSize: 14 }}>Short links into the Howler app — created from Pulse, tied to your events, with click counts. Share them in posts, bios, emails and QR codes.</p>
          <ChottuLinks entityId={entityId} scope={isAdmin ? 'admin' : 'my'} />
        </>
      ) : active === 'templates' ? (
        <>
          <p style={{ color: 'var(--muted)', marginBottom: 18, fontSize: 14 }}>Create reusable email templates, then apply them when building a campaign.</p>
          <TemplateManager entityId={entityId} scope={isAdmin ? 'admin' : 'my'} />
        </>
      ) : (
        <>
          <p style={{ color: 'var(--muted)', marginBottom: 18, fontSize: 14 }}>Turn your data into action — e.g. email customers who abandoned checkout. Preview the audience and copy, then explicitly approve the send.</p>
          <CampaignManager entityId={entityId} scope={isAdmin ? 'admin' : 'my'} initialGoal={initialGoal} initialType={initialType} initialActionId={initialActionId} initialDashboardId={initialDashboardId} initialSuiteId={initialSuiteId} initialSegmentName={initialSegmentName} />
        </>
      )}
    </main>
  );
}
