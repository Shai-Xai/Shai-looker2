import { useState, useRef, useLayoutEffect } from 'react';
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
      </div>
      {showCommunity && (
        <SubTabs
          tabs={[{ id: 'analytics', title: '📊 Analytics' }, { id: 'community', title: '👥 Community' }]}
          activeId={active} onSelect={setTab}
        />
      )}
      {!activeEntityId
        ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>Pick a client (top-left) to see their events in the Howler app.</div>
        : active === 'community'
          ? <SocialPlusPanel entityId={activeEntityId} scope="my" />
          : <AppAnalyticsPanel entityId={activeEntityId} scope="my" />}
    </div>
  );
}

// The same underline tab bar dashboards use (shared .subtabs/.subtab CSS; the
// gradient underline slides to the active tab) — mirrors ViewPage's SubTabs.
function SubTabs({ tabs, activeId, onSelect }) {
  const wrapRef = useRef(null);
  const [u, setU] = useState({ left: 0, width: 0, show: false });
  useLayoutEffect(() => {
    const el = wrapRef.current?.querySelector('[data-active="1"]');
    if (!el) { setU((s) => ({ ...s, show: false })); return; }
    setU({ left: el.offsetLeft + 10, width: Math.max(0, el.offsetWidth - 20), show: true });
  }, [activeId, tabs]);
  return (
    <div className="subtabs" ref={wrapRef} style={{ padding: 0, marginBottom: 10, background: 'transparent', backdropFilter: 'none', WebkitBackdropFilter: 'none' }}>
      {tabs.map((t) => (
        <button key={t.id} data-active={t.id === activeId ? '1' : undefined}
          className={`subtab${t.id === activeId ? ' active' : ''}`}
          onClick={() => { if (t.id !== activeId) onSelect(t.id); }}>
          {t.title}
        </button>
      ))}
      <span className="subtab-underline" style={{ transform: `translateX(${u.left}px)`, width: u.width, opacity: u.show ? 1 : 0 }} />
    </div>
  );
}
