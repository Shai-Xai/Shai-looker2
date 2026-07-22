import { useProfile } from '../lib/profile.jsx';
import HomeButton from '../components/HomeButton.jsx';
import MapStudio from '../components/MapStudio.jsx';

// Client self-service surface for Map Studio (/event-map). The matching admin
// surface is the "Map Studio" tab under Admin → a client. Both render the same
// <MapStudio>; the nav item that leads here appears for team members with the
// map.manage permission. Access is enforced server-side regardless.
export default function MapStudioPage() {
  const { activeEntityId, active } = useProfile();
  return (
    <div style={{ width: '100%', padding: '4px 20px 40px', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '6px 0 14px' }}>
        <HomeButton />
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 2 }}>Map Studio</div>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>Event map{active?.name ? ` · ${active.name}` : ''}</h1>
        </div>
      </div>
      <MapStudio entityId={activeEntityId} scope="my" />
    </div>
  );
}
