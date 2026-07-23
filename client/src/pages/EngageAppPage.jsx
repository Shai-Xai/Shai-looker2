import { useParams, useNavigate, useOutletContext } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { useProfile } from '../lib/profile.jsx';
import { vtNavigate } from '../lib/viewTransition.js';
import { useMyFlags, flagOn } from '../lib/flags.js';
import PageHeader from '../components/PageHeader.jsx';
import CommunityFeedManager from '../components/CommunityFeedManager.jsx';
import ModerationManager from '../components/ModerationManager.jsx';

// Engage → App — the client's presence INSIDE the Howler consumer app, as a
// first-class section (moved out of the Engage tab row where it lived as one
// long "Community" tab). Tab order mirrors how organisers actually work:
// publish (Posts), talk (Channels), then structure (Communities) and reach
// (Share links). Gated by the same `community` feature flag as before — the
// server route gates on /api/my/social + /api/my/chat are the real boundary.
const TABS = [
  { key: 'posts', label: 'Posts', icon: '📰', blurb: 'Post updates, photos and videos straight to fans in the Howler app — or repost from Instagram. On mobile this works exactly like posting from the app.' },
  { key: 'channels', label: 'Channels', icon: '💬', blurb: 'Per-event chat — message one channel or broadcast to all, run official channels, and keep an eye on fan-made groups.' },
  { key: 'communities', label: 'Communities', icon: '👥', blurb: 'The containers fans join: one for your brand, one per event. Event communities are ring-fenced to ticket holders and joiners.' },
  { key: 'share', label: 'Share links', icon: '📣', blurb: 'How your posts travel outside the app — clicks on shared links, chat-preview reach, and the fans driving them.' },
  // Gated separately (community.moderation): clients see it only when their
  // self-serve console is on; admins always can (they manage on behalf).
  { key: 'moderation', label: 'Moderation', icon: '🛡️', blurb: 'Banned words, phrases and emoji — enforced the moment a fan posts, comments or chats. Near-miss attempts wait here for your approve/decline.', flag: 'community.moderation' },
];

export default function EngageAppPage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const { activeEntityId } = useProfile();
  const { previewEntityId } = useOutletContext() || {};
  // Always the client in context: the previewed client (admin) or the active profile.
  const entityId = previewEntityId || (isAdmin ? null : activeEntityId);
  const myFlags = useMyFlags(entityId);
  const enabled = flagOn(myFlags, 'community');
  const tabs = TABS.filter((t) => !t.flag || isAdmin || flagOn(myFlags, t.flag));

  const active = tabs.find((t) => t.key === tab) ? tab : 'posts';
  const go = (key) => { if (key !== active) vtNavigate(navigate, `/engage/app/${key}`); };
  const blurb = tabs.find((t) => t.key === active)?.blurb;

  return (
    <main style={{ flex: 1, padding: '26px 22px', maxWidth: 1080, margin: '0 auto', width: '100%', boxSizing: 'border-box', overflowY: 'auto' }}>
      <PageHeader kicker="Engage" title="App" />

      {/* Tab bar — scrolls horizontally on small screens (mobile-first) and
          sticks to the top of the scroll area, same pattern as EngagePage. */}
      <div className="no-scrollbar" style={{ position: 'sticky', top: 0, zIndex: 5, display: 'flex', gap: 6, overflowX: 'auto', borderBottom: '1px solid var(--hairline)', marginBottom: 18, marginLeft: -22, marginRight: -22, padding: '6px 22px 0', background: 'var(--bg)', WebkitOverflowScrolling: 'touch' }}>
        {tabs.map((t) => {
          const on = t.key === active;
          return (
            <button
              key={t.key}
              onClick={() => go(t.key)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
                minHeight: 40, padding: '8px 14px', border: 'none', background: 'none',
                borderBottom: on ? '2px solid var(--brand)' : '2px solid transparent',
                color: on ? 'var(--brand)' : 'var(--text)',
                fontWeight: on ? 700 : 600, fontSize: 13.5, cursor: 'pointer', marginBottom: -1,
              }}
            >
              <span style={{ fontSize: 15 }}>{t.icon}</span>{t.label}
            </button>
          );
        })}
      </div>

      {!entityId ? (
        <p style={{ color: 'var(--muted)' }}>{isAdmin ? 'Open a client suite first so the preview knows which client to show.' : 'No client account is linked to your login yet.'}</p>
      ) : !enabled ? (
        <p style={{ color: 'var(--muted)' }}>The in-app Community suite isn’t switched on for this account yet — ask Howler to enable it.</p>
      ) : (
        <>
          {blurb && <p style={{ color: 'var(--muted)', marginBottom: 18, fontSize: 14 }}>{blurb}</p>}
          {active === 'moderation'
            ? <ModerationManager entityId={entityId} scope={isAdmin ? 'admin' : 'my'} />
            : <CommunityFeedManager entityId={entityId} scope={isAdmin ? 'admin' : 'my'} section={active} />}
        </>
      )}
    </main>
  );
}
