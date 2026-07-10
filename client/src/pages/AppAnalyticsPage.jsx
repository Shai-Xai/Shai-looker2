import { useState } from 'react';
import { useProfile } from '../lib/profile.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
import { useMyFlags, flagOn } from '../lib/flags.js';
import { AppAnalyticsPanel } from '../components/AppAnalytics.jsx';
import SocialPlusPanel from '../components/SocialPlusPanel.jsx';

// 📲 App — how the client's events perform inside the Howler consumer app.
// Two tabs: Analytics (PostHog — views, unique viewers, CTA taps, purchases,
// app users; server/posthog.js) and Community (Social+ — the client's linked
// in-app communities & chats; server/socialplus.js, flag appanalytics.socialplus).
// Both scoped server-side to the client's own events/communities. Mobile-first.

export default function AppAnalyticsPage() {
  const { activeEntityId } = useProfile();
  const isMobile = useIsMobile();
  const myFlags = useMyFlags(activeEntityId);
  const showCommunity = flagOn(myFlags, 'appanalytics.socialplus');
  const [tab, setTab] = useState('analytics');
  const active = showCommunity ? tab : 'analytics';
  return (
    <div style={{ maxWidth: 880, margin: '0 auto', padding: isMobile ? '16px 14px 40px' : '24px 24px 56px', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <h1 style={{ fontSize: isMobile ? 22 : 26, fontWeight: 800, margin: 0, flex: 1 }}>App</h1>
        {showCommunity && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setTab('analytics')} style={{ ...tabChip, ...(active === 'analytics' ? tabChipOn : null) }}>📊 Analytics</button>
            <button onClick={() => setTab('community')} style={{ ...tabChip, ...(active === 'community' ? tabChipOn : null) }}>👥 Community</button>
          </div>
        )}
      </div>
      {!activeEntityId
        ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>Pick a client (top-left) to see their events in the Howler app.</div>
        : active === 'community'
          ? <SocialPlusPanel entityId={activeEntityId} scope="my" />
          : <AppAnalyticsPanel entityId={activeEntityId} scope="my" />}
    </div>
  );
}

const tabChip = { minHeight: 36, padding: '6px 14px', borderRadius: 980, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--muted)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' };
const tabChipOn = { background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' };
