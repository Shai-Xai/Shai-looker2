import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';

// CC-the-Owl address for one client, with copy (and regenerate for admins).
// Same component on both surfaces: admin (client detail) and client self-serve.
export default function OwlAddressCard({ entityId, admin = false }) {
  const [data, setData] = useState(null);
  const [copied, setCopied] = useState(false);

  const load = () => (admin ? api.getEntityInbox(entityId) : api.getMyInbox(entityId)).then(setData).catch(() => setData({ configured: false }));
  useEffect(() => { load(); }, [entityId, admin]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return null;
  if (!data.configured || !data.address) {
    return (
      <div style={card}>
        <div style={title}>📨 CC the Owl</div>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
          Inbound email isn’t switched on yet{admin ? ' — set the inbound domain in Admin → Integrations.' : '. Ask your Howler contact to enable it.'}
        </p>
      </div>
    );
  }

  const copy = () => {
    const t = data.address;
    (navigator.clipboard?.writeText(t) || Promise.reject()).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); })
      .catch(() => window.prompt('Copy this address:', t));
  };
  const regen = async () => {
    if (!window.confirm('Generate a new address? The old one will stop working immediately.')) return;
    setData(await api.regenEntityInbox(entityId));
  };

  return (
    <div style={card}>
      <div style={title}>📨 CC the Owl</div>
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 10px' }}>
        Add this address as a CC (or forward to it) on any email — it’s captured automatically in the inbox here, so nothing lives only in someone’s mailbox.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <code style={pill}>{data.address}</code>
        <button style={btn} onClick={copy}>{copied ? '✓ Copied' : 'Copy'}</button>
        {admin && <button style={{ ...btn, background: 'transparent', color: 'var(--muted)' }} onClick={regen}>Regenerate</button>}
      </div>
    </div>
  );
}

const card = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: 16, marginBottom: 16 };
const title = { fontSize: 14, fontWeight: 700, marginBottom: 6 };
const pill = { fontSize: 13.5, fontWeight: 600, background: 'var(--elevated, #f3f3f5)', border: '1px solid var(--hairline)', borderRadius: 8, padding: '8px 12px', userSelect: 'all' };
const btn = { border: '1px solid var(--hairline)', background: 'var(--brand)', color: '#fff', borderRadius: 980, padding: '8px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
