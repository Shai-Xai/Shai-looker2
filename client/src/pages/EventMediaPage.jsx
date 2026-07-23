import { useProfile } from '../lib/profile.jsx';
import HomeButton from '../components/HomeButton.jsx';
import EventAssets from '../components/EventAssets.jsx';

// Client self-service surface for Event Media (/event-media). The matching admin
// surface is the "Event Media" tab under Admin → a client. Both render the same
// <EventAssets>; the nav item that leads here appears for team members with the
// map.manage permission when the eventassets flag is on. Access is enforced
// server-side regardless.
export default function EventMediaPage() {
  const { activeEntityId, active } = useProfile();
  return (
    <div style={{ width: '100%', padding: '4px 20px 40px', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '6px 0 14px' }}>
        <HomeButton />
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 2 }}>Event Media</div>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>App media{active?.name ? ` · ${active.name}` : ''}</h1>
        </div>
      </div>
      <EventAssets entityId={activeEntityId} scope="my" />
    </div>
  );
}
