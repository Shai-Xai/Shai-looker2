import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';
import IntegrationsForm from '../components/IntegrationsForm.jsx';
import MailTemplateEditor from '../components/MailTemplateEditor.jsx';
import OwlAddressCard from '../components/OwlAddressCard.jsx';
import MailLogView from '../components/MailLogView.jsx';
import NotificationPrefs from '../components/NotificationPrefs.jsx';
import TeamManager from '../components/TeamManager.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
import { useProfile } from '../lib/profile.jsx';
import { useAccess, PERMS } from '../lib/access.js';

// Client self-service Settings — one place for everything the client manages
// themselves, organised by a section nav: Integrations, Branding, CC-the-Owl.
// (Digests + Actions are first-class pages in the left nav, not settings.)
// Each section declares the permission that reveals it; Notifications is
// personal so it's always available.
const SECTIONS = [
  ['team', 'Team', '👥', PERMS.TEAM_MANAGE],
  ['integrations', 'Integrations', '🔌', PERMS.INTEGRATIONS_MANAGE],
  ['notifications', 'Notifications', '🔔', null],
  ['email', 'Branding', '🎨', PERMS.BRANDING_MANAGE],
  ['sentmail', 'Sent emails', '📤', PERMS.INTEGRATIONS_MANAGE],
  ['inbox', 'CC the Owl', '📨', PERMS.INTEGRATIONS_MANAGE],
];

export default function ClientIntegrationsPage() {
  const isMobile = useIsMobile();
  const { can } = useAccess();
  const { active } = useProfile(); // team management is scoped to the active client
  const [items, setItems] = useState(null);
  // Only the sections this role can use (Notifications is personal, always on).
  const sections = SECTIONS.filter(([, , , perm]) => !perm || can(perm));
  const [section, setSection] = useState(sections[0]?.[0] || 'notifications');
  useEffect(() => { api.getMyIntegrations().then(setItems).catch(() => setItems([])); }, []);
  // If the active section isn't permitted (e.g. after a profile switch), fall back.
  useEffect(() => { if (!sections.some(([k]) => k === section)) setSection(sections[0]?.[0] || 'notifications'); }, [sections, section]);

  return (
    <main style={{ flex: 1, padding: isMobile ? '20px 14px' : '32px 24px', maxWidth: 1080, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 6 }}>Settings</h1>
      <p style={{ color: 'var(--muted)', marginBottom: 18, fontSize: 14 }}>Manage your integrations, branding and inbox address. Anything left blank falls back to Howler's defaults.</p>

      {/* Section nav */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 22, flexWrap: 'wrap', borderBottom: '1px solid var(--hairline)', paddingBottom: 10 }}>
        {sections.map(([key, label, icon]) => (
          <button key={key} onClick={() => setSection(key)} style={tabBtn(section === key)}>
            <span style={{ marginRight: 6 }}>{icon}</span>{label}
          </button>
        ))}
      </div>

      {section === 'team' ? (
        active ? (
          <div>
            <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 8 }}>{active.name} · Team</h2>
            <TeamManager entityId={active.id} entityName={active.name} />
          </div>
        ) : <p style={{ color: 'var(--muted)' }}>Switch to a client to manage its team.</p>
      ) : section === 'notifications' ? (
        <div style={{ maxWidth: 520 }}>
          <p style={hint}>Choose how Howler reaches you. These apply to your login across all your profiles — the in-app inbox always receives messages regardless.</p>
          <NotificationPrefs />
        </div>
      ) : !items ? (
        <p style={{ color: 'var(--muted)' }}>Loading…</p>
      ) : items.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>No client account is linked to your login yet.</p>
      ) : (
        items.map((it) => (
          <div key={it.entityId} style={{ marginBottom: 36 }}>
            {items.length > 1 && <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 12 }}>{it.name}</h2>}

            {section === 'integrations' && (
              <div style={{ maxWidth: 680 }}>
                <p style={hint}>Connect your own Looker and Anthropic accounts. Leave blank to use Howler's.</p>
                <IntegrationsForm
                  value={it}
                  lookerActive={false}
                  onSave={async (p) => {
                    const v = await api.saveMyIntegrations(it.entityId, p);
                    setItems((arr) => arr.map((x) => (x.entityId === it.entityId ? { ...x, ...v } : x)));
                  }}
                />
              </div>
            )}

            {section === 'email' && (
              <div>
                <p style={hint}>Your colours and logo — they style your whole Pulse platform (buttons, accents, charts) and your notification emails. Blank fields keep Howler's defaults.</p>
                <MailTemplateEditor scope="my" entityId={it.entityId} />
              </div>
            )}



            {section === 'sentmail' && (
              <div>
                <p style={hint}>Every email sent on your behalf — digests, campaigns and notifications — and what's scheduled next.</p>
                <MailLogView load={(params) => api.getMyMailLog(it.entityId, params)} />
              </div>
            )}

            {section === 'inbox' && (
              <div style={{ maxWidth: 680 }}>
                <p style={hint}>CC this address on any email and the conversation is captured in your Pulse inbox — nothing lives only in someone's mailbox.</p>
                <OwlAddressCard entityId={it.entityId} />
              </div>
            )}
          </div>
        ))
      )}
    </main>
  );
}

const tabBtn = (active) => ({
  padding: '8px 14px', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  border: active ? '1.5px solid var(--brand)' : '1.5px solid var(--hairline)',
  background: active ? 'rgba(var(--brand-rgb), 0.08)' : 'transparent',
  color: active ? 'var(--brand)' : 'var(--text)',
});
const hint = { color: 'var(--muted)', fontSize: 13, marginBottom: 14, lineHeight: 1.5 };
