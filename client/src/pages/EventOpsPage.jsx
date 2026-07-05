import { useProfile } from '../lib/profile.jsx';
import PageHeader from '../components/PageHeader.jsx';
import EventOpsConsole from '../components/EventOpsConsole.jsx';

// Client self-service surface for Event Ops (/event-ops). The matching admin surface is
// the "Event Ops" tab under Admin → a client. Both render the same <EventOpsConsole>; the
// nav item that leads here only appears for clients whose pilot is switched on (gated in
// ClientLayout via api.eventopsEnabled). Access is enforced server-side regardless.
export default function EventOpsPage() {
  const { activeEntityId, active } = useProfile();
  return (
    <div style={{ width: '100%', padding: '2px 20px 40px', boxSizing: 'border-box' }}>
      <PageHeader kicker="Event Ops" title={`Devices & stations${active?.name ? ` · ${active.name}` : ''}`} />
      <EventOpsConsole entityId={activeEntityId} scope="my" />
    </div>
  );
}
