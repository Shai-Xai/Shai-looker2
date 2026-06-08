import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';
import IntegrationsForm from '../components/IntegrationsForm.jsx';

// Client self-service: connect your own Looker / Anthropic accounts. Falls back
// to Howler's platform defaults when left blank.
export default function ClientIntegrationsPage() {
  const [items, setItems] = useState(null);
  useEffect(() => { api.getMyIntegrations().then(setItems).catch(() => setItems([])); }, []);

  return (
    <main style={{ flex: 1, padding: '32px 24px', maxWidth: 680, margin: '0 auto', width: '100%' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 6 }}>Integrations</h1>
      <p style={{ color: 'var(--muted)', marginBottom: 22 }}>Connect your own Looker and Anthropic accounts. Leave anything blank to keep using Howler's defaults.</p>
      {!items ? (
        <p style={{ color: 'var(--muted)' }}>Loading…</p>
      ) : items.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>No client account is linked to your login yet.</p>
      ) : (
        items.map((it) => (
          <div key={it.entityId} style={{ marginBottom: 30 }}>
            {items.length > 1 && <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 10 }}>{it.name}</h2>}
            <IntegrationsForm
              value={it}
              lookerActive={false}
              onSave={async (p) => {
                const v = await api.saveMyIntegrations(it.entityId, p);
                setItems((arr) => arr.map((x) => (x.entityId === it.entityId ? { ...x, ...v } : x)));
              }}
            />
          </div>
        ))
      )}
    </main>
  );
}
