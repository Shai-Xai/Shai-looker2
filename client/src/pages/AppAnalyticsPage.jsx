import { useProfile } from '../lib/profile.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
import { AppAnalyticsPanel } from '../components/AppAnalytics.jsx';

// 📲 App — how the client's events perform inside the Howler consumer app,
// straight from PostHog (views, unique viewers, CTA taps, purchases, app-user
// profiles). Scoped server-side to the client's own events — see
// server/posthog.js. Mobile-first single column, like SocialPage.

export default function AppAnalyticsPage() {
  const { activeEntityId } = useProfile();
  const isMobile = useIsMobile();
  return (
    <div style={{ maxWidth: 880, margin: '0 auto', padding: isMobile ? '16px 14px 40px' : '24px 24px 56px', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <h1 style={{ fontSize: isMobile ? 22 : 26, fontWeight: 800, margin: 0, flex: 1 }}>App</h1>
      </div>
      {!activeEntityId
        ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>Pick a client (top-left) to see their events in the Howler app.</div>
        : <AppAnalyticsPanel entityId={activeEntityId} scope="my" />}
    </div>
  );
}
