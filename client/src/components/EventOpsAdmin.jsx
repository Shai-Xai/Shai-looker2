import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import EventOpsConsole from './EventOpsConsole.jsx';

// Admin surface for the Event Ops pilot, shown under Admin → a client → "Event Ops".
// Leads with the per-client on/off switch (the pilot is OFF by default and invisible to
// the client until Howler flips it here). Once on, the same <EventOpsConsole> the client
// uses is rendered so staff can manage devices/stations/issues on the client's behalf.
export default function EventOpsAdmin({ entityId }) {
  const [enabled, setEnabled] = useState(null); // null = loading
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api.eventopsGetEnabled(entityId).then((r) => alive && setEnabled(!!r.enabled)).catch(() => alive && setEnabled(false));
    return () => { alive = false; };
  }, [entityId]);

  async function toggle() {
    setBusy(true);
    try { const r = await api.eventopsSetEnabled(entityId, !enabled); setEnabled(!!r.enabled); }
    catch (e) { alert(e.message); }
    setBusy(false);
  }

  return (
    <div>
      <div style={banner}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Event Ops {enabled ? '· live for this client' : '· off'}</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
            Pilot: device &amp; station logistics for an event. When on, the client sees an <b>Event Ops</b> area in their own app
            (team members need the <code>eventops.manage</code> permission). Off by default — flip it on per pilot client.
          </div>
        </div>
        <button onClick={toggle} disabled={busy || enabled === null} style={toggleBtn(enabled)}>
          {enabled === null ? '…' : enabled ? 'Switch off' : 'Switch on'}
        </button>
      </div>

      {enabled
        ? <EventOpsConsole entityId={entityId} scope="admin" />
        : <p style={{ color: 'var(--muted)', fontSize: 13 }}>Switch Event Ops on above to add devices, stations and start scanning for this client.</p>}
    </div>
  );
}

const banner = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap', padding: 14, marginBottom: 16, borderRadius: 12, border: '1px solid var(--hairline)', background: 'var(--card)' };
const toggleBtn = (on) => ({ padding: '9px 16px', borderRadius: 10, border: '1px solid ' + (on ? 'var(--border)' : 'var(--brand)'), background: on ? 'transparent' : 'var(--brand)', color: on ? 'var(--text)' : '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' });
