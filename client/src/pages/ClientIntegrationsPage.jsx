import { useState, useEffect } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import HomeButton from '../components/HomeButton.jsx';
import IntegrationsForm from '../components/IntegrationsForm.jsx';
import MailTemplateEditor from '../components/MailTemplateEditor.jsx';
import OwlAddressCard from '../components/OwlAddressCard.jsx';
import MailLogView from '../components/MailLogView.jsx';
import NotificationPrefs from '../components/NotificationPrefs.jsx';
import TeamManager from '../components/TeamManager.jsx';
import RateCard from '../components/RateCard.jsx';
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
  ['fees', 'Fees & billing', '💳', PERMS.CAMPAIGNS_VIEW],
  ['sentmail', 'Sent emails', '📤', PERMS.INTEGRATIONS_MANAGE],
  ['inbox', 'CC the Owl', '📨', PERMS.INTEGRATIONS_MANAGE],
];

export default function ClientIntegrationsPage() {
  const isMobile = useIsMobile();
  const { can, role, isAdmin } = useAccess();
  const { active } = useProfile(); // every section is scoped to the active client profile
  const ctx = useOutletContext() || {};
  const [items, setItems] = useState(null);
  // Settings only ever show the profile in context — switching profile (top header)
  // is how you reach another client's settings. Never list multiple clients at once.
  // For an admin PREVIEWING a client (console mode) there's no `active` profile,
  // so fall back to the entity the shell resolved (previewEntityId) — that's the
  // client they opened — so admins who own the account can manage its settings.
  const scopeId = active?.id || ctx.previewEntityId || null;
  const activeItem = items && scopeId ? items.find((it) => it.entityId === scopeId) : null;
  // The entity (id + name) the page acts on — from the profile if present, else
  // derived from the resolved settings row.
  const ent = active || (activeItem ? { id: activeItem.entityId, name: activeItem.name } : null);
  // Only the sections this role can use (Notifications is personal, always on).
  const sections = SECTIONS.filter(([, , , perm]) => !perm || can(perm));
  // Deep link: /settings?section=integrations|team|notifications|email… opens that
  // section (used by the onboarding "Go" buttons). Falls back to the first allowed.
  const [params] = useSearchParams();
  const requested = params.get('section');
  const [section, setSection] = useState(
    requested && sections.some(([k]) => k === requested) ? requested : (sections[0]?.[0] || 'notifications'),
  );
  useEffect(() => { api.getMyIntegrations().then(setItems).catch(() => setItems([])); }, []);
  // If the active section isn't permitted (e.g. after a profile switch), fall back.
  useEffect(() => { if (!sections.some(([k]) => k === section)) setSection(sections[0]?.[0] || 'notifications'); }, [sections, section]);

  return (
    <main style={{ flex: 1, padding: isMobile ? '20px 14px' : '32px 24px', maxWidth: 1080, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
        <HomeButton />
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>Settings</h1>
      </div>
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
        ent ? (
          <div>
            <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 8 }}>{ent.name} · Team</h2>
            <TeamManager entityId={ent.id} entityName={ent.name} />
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
      ) : !activeItem ? (
        <p style={{ color: 'var(--muted)' }}>Switch to a client profile to manage its settings.</p>
      ) : (
        <div style={{ marginBottom: 36 }}>
          {items.length > 1 && <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 12 }}>{activeItem.name}</h2>}

          {section === 'integrations' && (
            <div style={{ maxWidth: 680 }}>
              <p style={hint}>Connect your own Looker and Anthropic accounts. Leave blank to use Howler's.</p>
              <IntegrationsForm
                value={activeItem}
                lookerActive={false}
                showMeta
                showTikTok
                canEdit={isAdmin || role === 'owner'}
                onSave={async (p) => {
                  const v = await api.saveMyIntegrations(activeItem.entityId, p);
                  setItems((arr) => arr.map((x) => (x.entityId === activeItem.entityId ? { ...x, ...v } : x)));
                }}
              />
            </div>
          )}

          {section === 'email' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <BrandingSection title="Account &amp; portfolio" subtitle="your overall look · used on portfolio digests">
                <p style={hint}>Your colours and logo — they style your whole Pulse platform (buttons, accents, charts) and your notification emails. Used everywhere by default, and on portfolio (multi-event) digests. Blank fields keep Howler's defaults.</p>
                <MailTemplateEditor scope="my" entityId={activeItem.entityId} />
              </BrandingSection>

              <BrandingSection title="Events" subtitle="brand a specific event">
                <p style={hint}>Give a specific event its own logo, colours and sender name — used for that event's campaigns and digests, and the in-app look while you're viewing it. Blank fields inherit your account branding above.</p>
                <EventBranding entityId={activeItem.entityId} />
              </BrandingSection>
            </div>
          )}

          {section === 'fees' && (
            <div style={{ maxWidth: 680 }}>
              <p style={hint}>Your per-message campaign rates and what you’ve spent so far.</p>
              <RateCard scope="my" entityId={activeItem.entityId} />
            </div>
          )}

          {section === 'sentmail' && (
            <div>
              <p style={hint}>Every email sent on your behalf — digests, campaigns and notifications — and what's scheduled next.</p>
              <MailLogView load={(params) => api.getMyMailLog(activeItem.entityId, params)} />
            </div>
          )}

          {section === 'inbox' && (
            <div style={{ maxWidth: 680 }}>
              <p style={hint}>CC this address on any email and the conversation is captured in your Pulse inbox — nothing lives only in someone's mailbox.</p>
              <OwlAddressCard entityId={activeItem.entityId} />
            </div>
          )}
        </div>
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
// A branding sub-section as a clearly-expandable white card (the old <details>
// hid its disclosure triangle behind a flex summary, so it read as a dead
// heading). Open by default so the controls — and the fact it expands — are
// obvious; collapsible via the chevron to keep the page tidy. Used for both the
// account branding and the per-event branding so they match.
function BrandingSection({ title, subtitle, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={acctCard}>
      <button type="button" onClick={() => setOpen((o) => !o)} style={acctHeader} aria-expanded={open}>
        <span style={{ ...acctChevron, transform: open ? 'rotate(90deg)' : 'none' }}>▸</span>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{title}</span>
        {subtitle && <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 500 }}>{subtitle}</span>}
      </button>
      {open && <div style={{ padding: '0 14px 14px' }}>{children}</div>}
    </div>
  );
}
const acctCard = { border: '1px solid var(--hairline)', borderRadius: 12, overflow: 'hidden', background: 'var(--card)' };
const acctHeader = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', width: '100%', textAlign: 'left', cursor: 'pointer', background: 'transparent', border: 'none', padding: '13px 14px', color: 'var(--text)' };
const acctChevron = { color: 'var(--muted)', fontSize: 12, transition: 'transform 0.15s', flexShrink: 0 };

// Per-event branding self-service: pick one of this client's events, then edit
// its branding override (inherits the account branding above where left blank).
function EventBranding({ entityId }) {
  const [suites, setSuites] = useState(null);
  const [picked, setPicked] = useState('');
  useEffect(() => {
    api.mySuites().then((all) => setSuites((all || []).filter((s) => s.entityId === entityId))).catch(() => setSuites([]));
  }, [entityId]);

  if (!suites) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading your events…</p>;
  if (!suites.length) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>No events yet — once Howler sets up an event for you, you can brand it here.</p>;

  return (
    <div>
      <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Event</label>
      <select value={picked} onChange={(e) => setPicked(e.target.value)} style={selectBox}>
        <option value="">Choose an event…</option>
        {suites.map((s) => {
          const icon = s.icon && !s.icon.startsWith('data:') ? `${s.icon} ` : '';
          return <option key={s.id} value={s.id}>{icon}{s.name}</option>;
        })}
      </select>
      {picked && <div style={{ marginTop: 16 }}><MailTemplateEditor key={picked} scope="my-suite" entityId={entityId} suiteId={picked} /></div>}
    </div>
  );
}

const selectBox = {
  padding: '9px 12px', borderRadius: 10, fontSize: 14, border: '1.5px solid var(--hairline)',
  background: 'var(--surface)', color: 'var(--text)', minWidth: 260, maxWidth: '100%',
};
