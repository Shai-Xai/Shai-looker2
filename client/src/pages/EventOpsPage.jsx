import { useProfile } from '../lib/profile.jsx';
import HomeButton from '../components/HomeButton.jsx';
import EventOpsConsole from '../components/EventOpsConsole.jsx';

// Client self-service surface for Event Ops (/event-ops). The matching admin surface is
// the "Event Ops" tab under Admin → a client. Both render the same <EventOpsConsole>; the
// nav item that leads here only appears for clients whose pilot is switched on (gated in
// ClientLayout via api.eventopsEnabled). Access is enforced server-side regardless.
export default function EventOpsPage() {
  const { activeEntityId, active } = useProfile();
  return (
    <div style={{ width: '100%', padding: '2px 20px 40px', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '2px 0 8px' }}>
        <HomeButton />
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 1 }}>Event Ops</div>
          <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em' }}>Devices &amp; stations{active?.name ? ` · ${active.name}` : ''}</h1>
        </div>
      </div>
      <EventOpsConsole entityId={activeEntityId} scope="my" />
    </div>
  );
}
