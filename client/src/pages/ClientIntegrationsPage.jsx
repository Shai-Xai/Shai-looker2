import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';
import IntegrationsForm from '../components/IntegrationsForm.jsx';
import MailTemplateEditor from '../components/MailTemplateEditor.jsx';
import OwlAddressCard from '../components/OwlAddressCard.jsx';
import DigestManager from '../components/DigestManager.jsx';

// Client self-service: connect your own Looker / Anthropic accounts and brand
// your notification emails. Everything falls back to Howler's defaults if blank.
export default function ClientIntegrationsPage() {
  const [items, setItems] = useState(null);
  useEffect(() => { api.getMyIntegrations().then(setItems).catch(() => setItems([])); }, []);

  return (
    <main style={{ flex: 1, padding: '32px 24px', maxWidth: 980, margin: '0 auto', width: '100%' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 6 }}>Integrations & branding</h1>
      <p style={{ color: 'var(--muted)', marginBottom: 22 }}>Connect your own Looker and Anthropic accounts, and brand the emails Howler sends your team. Leave anything blank to keep using Howler's defaults.</p>
      {!items ? (
        <p style={{ color: 'var(--muted)' }}>Loading…</p>
      ) : items.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>No client account is linked to your login yet.</p>
      ) : (
        items.map((it) => (
          <div key={it.entityId} style={{ marginBottom: 40 }}>
            {items.length > 1 && <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 12 }}>{it.name}</h2>}
            <div style={{ maxWidth: 680 }}>
              <OwlAddressCard entityId={it.entityId} />
            </div>
            <div style={{ maxWidth: 680 }}>
              <IntegrationsForm
                value={it}
                lookerActive={false}
                onSave={async (p) => {
                  const v = await api.saveMyIntegrations(it.entityId, p);
                  setItems((arr) => arr.map((x) => (x.entityId === it.entityId ? { ...x, ...v } : x)));
                }}
              />
            </div>
            <h3 style={{ fontSize: 15, fontWeight: 700, margin: '22px 0 4px' }}>Email branding</h3>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12 }}>How your notification emails look. Sends come from Howler's verified domain; a “Powered by Howler : Pulse” line stays in the footer.</p>
            <MailTemplateEditor scope="my" entityId={it.entityId} />
            <h3 style={{ fontSize: 15, fontWeight: 700, margin: '26px 0 4px' }}>Scheduled digests</h3>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12 }}>Automated briefing emails for your team — personalised by role (exec, marketing, finance…) and sent on your schedule.</p>
            <DigestManager entityId={it.entityId} scope="my" />
          </div>
        ))
      )}
    </main>
  );
}
