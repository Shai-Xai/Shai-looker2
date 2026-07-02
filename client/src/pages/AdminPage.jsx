import { useState, useEffect, useRef, useMemo, useId } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';
import { useAuth } from '../lib/auth.jsx';
import { fanOwlSettingsEnabled } from '../lib/features.js';
import { useTheme } from '../lib/theme.jsx';
import { useProfile } from '../lib/profile.jsx';
import IntegrationsForm from '../components/IntegrationsForm.jsx';
import MailTemplateEditor from '../components/MailTemplateEditor.jsx';
import MailLogView from '../components/MailLogView.jsx';
import OwlAddressCard from '../components/OwlAddressCard.jsx';
import ApiKeysCard from '../components/ApiKeysCard.jsx';
import DigestManager from '../components/DigestManager.jsx';
import CampaignManager from '../components/CampaignManager.jsx';
import SegmentManager from '../components/SegmentManager.jsx';
import EventOpsAdmin from '../components/EventOpsAdmin.jsx';
import RateCard from '../components/RateCard.jsx';
import { BriefingConfigForm } from '../components/BriefingTuneModal.jsx';
import StatusNoticesAdmin from '../components/StatusNoticesAdmin.jsx';
import TicketBoard from '../components/TicketBoard.jsx';
import { openReport } from '../components/ReportWidget.jsx';
import OwlGuidanceEditor from '../components/OwlGuidanceEditor.jsx';
import OwlFieldDictionary from '../components/OwlFieldDictionary.jsx';
import OwlMemoryEditor from '../components/OwlMemoryEditor.jsx';
import WhatsAppOwl from '../components/WhatsAppOwl.jsx';
import OwlEmbedAdmin from '../components/OwlEmbedAdmin.jsx';
import FanOwlAdmin from '../components/FanOwlAdmin.jsx';
import OwlCatalogue from '../components/OwlCatalogue.jsx';
import UploadHint from '../components/UploadHint.jsx';
import { currencyList } from '../lib/currency.js';
import { languageList } from '../lib/language.js';
import { makeCombinedKey, parseCombinedKey } from '../lib/combinedFilters.js';
import VersionStamp from '../components/VersionStamp.jsx';
import { GUIDES } from '../lib/guides.js';

// Icon control: an emoji, or an uploaded image (downscaled to a small data-URL).
// Offers a palette of common dashboard-category icons for quick picking.
const ICON_PRESETS = [
  ['🎟️', 'Ticketing'], ['💳', 'Cashless'], ['🛂', 'Access control'], ['👥', 'Audience'],
  ['📱', 'App'], ['📊', 'GA4'], ['📈', 'Analytics'], ['🌐', 'Web'], ['🤖', 'AI'],
  ['💰', 'Revenue'], ['🎫', 'Comps'], ['🔁', 'Resale'], ['🏷️', 'Pricing'], ['🧑‍💼', 'Reps'],
  ['🍔', 'Food & bev'], ['🍺', 'Bar'], ['📍', 'Stations'], ['🗓️', 'Schedule'], ['⭐', 'Overview'],
];
// Client logo: an uploaded image (downscaled to a reasonable size), shown to
// the client as their brand. Larger/clearer than the small emoji IconPicker.
function LogoPicker({ value, onChange }) {
  const fileRef = useRef(null);
  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 256, scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        onChange(c.toDataURL('image/png'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(f);
  };
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={logoPreview}>
          {value ? <img src={value} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} /> : <span style={{ color: '#c8c8cc', fontSize: 12 }}>No logo</span>}
        </div>
        <button style={miniBtn} onClick={() => fileRef.current?.click()}>Upload logo</button>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onFile} />
        {value && <button style={delBtn} onClick={() => onChange('')}>Remove</button>}
      </div>
      <UploadHint kind="logo" />
    </div>
  );
}

function IconPicker({ value, onChange }) {
  const fileRef = useRef(null);
  const isImg = typeof value === 'string' && value.startsWith('data:');
  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 64, scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        onChange(c.toDataURL('image/png'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(f);
  };
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={iconPreview}>
          {isImg ? <img src={value} alt="" style={{ width: 26, height: 26, objectFit: 'contain' }} /> : (value ? <span style={{ fontSize: 22 }}>{value}</span> : <span style={{ color: '#c8c8cc', fontSize: 18 }}>＋</span>)}
        </div>
        <input style={{ ...input, width: 72, minWidth: 0, textAlign: 'center' }} placeholder="emoji" value={isImg ? '' : (value || '')} onChange={(e) => onChange(e.target.value)} maxLength={4} title="Type/paste an emoji" />
        <button style={miniBtn} onClick={() => fileRef.current?.click()}>Upload image</button>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onFile} />
        {value && <button style={delBtn} onClick={() => onChange('')} title="Clear">✕</button>}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8, maxWidth: 360 }}>
        {ICON_PRESETS.map(([emo, label]) => (
          <button
            key={label}
            type="button"
            onClick={() => onChange(emo)}
            title={label}
            style={{ ...iconChip, ...(value === emo ? { borderColor: 'var(--brand)', background: '#fff0f3' } : null) }}
          >
            {emo}
          </button>
        ))}
      </div>
      <UploadHint kind="icon" />
    </div>
  );
}

// Admin console for the multi-tenant model:
//   Clients (Entities)  – who, with organiser-level locked filters
//   Templates           – reusable groups of dashboards
//   Dashboard Sets      – a template applied to an entity, with event/other locks
//   Logins (Users)      – credentials, assigned to one or more entities
const ADMIN_NAV = [
  ['entities', 'Clients', '👥'],
  ['wizard', 'Setup wizard', '🧙'],
  ['users', 'Users', '🧑'],
  ['sets', 'Sets', '🗂️'],
  ['library', 'Tile library', '🧩'],
  ['ai', 'AI', '🤖'],
  ['onboarding', 'Onboarding', '🚀'],
  ['settlements', 'Settlements', '💰'],
  ['billing', 'Billing', '💳'],
  ['integrations', 'Integrations', '🔌'],
  ['email', 'Email', '✉️'],
  ['status', 'Status', '🚨'],
  ['product', 'Product', '📦'],
  ['backup', 'Backup', '💾'],
];

export default function AdminPage() {
  const [tab, setTab] = useState('entities');
  const [fields, setFields] = useState([]);
  const isMobile = useIsMobile();
  useEffect(() => { api.adminFilterFields().then(setFields).catch(() => setFields([])); }, []);

  const content = (
    <>
      {tab === 'entities' && <Entities fields={fields} onOpenWizard={() => setTab('wizard')} />}
      {tab === 'wizard' && <SetupWizard fields={fields} />}
      {tab === 'users' && <UsersTab />}
      {tab === 'sets' && <Sets />}
      {tab === 'library' && <Library />}
      {tab === 'ai' && <AISettings />}
      {tab === 'onboarding' && <OnboardingInsights />}
      {tab === 'settlements' && <Settlements />}
      {tab === 'billing' && <Billing />}
      {tab === 'integrations' && <AdminIntegrations />}
      {tab === 'email' && <MailLog />}
      {tab === 'status' && <StatusNoticesAdmin />}
      {tab === 'product' && <Product />}
      {tab === 'backup' && <BackupRestore />}
    </>
  );

  // Mobile-first: a horizontal tab row on phones; a left nav rail on desktop.
  if (isMobile) {
    return (
      <main style={{ flex: 1, padding: '20px 16px', width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700 }}>Admin</h1>
          <span style={{ flex: 1 }} />
          <Link to="/dashboards" style={dashAdminBtn}>📊 Dashboard admin</Link>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 18, overflowX: 'auto', paddingBottom: 4 }}>
          {ADMIN_NAV.map(([key, label]) => <Tab key={key} active={tab === key} onClick={() => setTab(key)}>{label}</Tab>)}
          <Tab active={false} onClick={openReport}>💬 Report</Tab>
        </div>
        {content}
      </main>
    );
  }

  return (
    <main style={{ flex: 1, padding: '28px 24px', maxWidth: 1240, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>Admin</h1>
        <span style={{ flex: 1 }} />
        <Link to="/dashboards" style={dashAdminBtn}>📊 Dashboard admin</Link>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '188px minmax(0,1fr)', gap: 28, alignItems: 'start' }}>
        <nav className="glass" style={{ position: 'sticky', top: 12, display: 'flex', flexDirection: 'column', gap: 2, padding: 8, borderRadius: 14 }}>
          {ADMIN_NAV.map(([key, label, icon]) => (
            <button key={key} onClick={() => setTab(key)} style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', cursor: 'pointer',
              padding: '9px 12px', borderRadius: 9, border: 'none', fontSize: 13.5,
              fontWeight: tab === key ? 700 : 500,
              background: tab === key ? 'var(--brand)' : 'transparent',
              color: tab === key ? '#fff' : 'var(--text)',
            }}>
              <span style={{ fontSize: 15, width: 18, textAlign: 'center', opacity: tab === key ? 1 : 0.8 }}>{icon}</span>
              {label}
            </button>
          ))}
          {/* Report an issue — opens the report modal (replaces the old floating button). */}
          <button onClick={openReport} style={{
            display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', cursor: 'pointer',
            padding: '9px 12px', borderRadius: 9, border: 'none', fontSize: 13.5, fontWeight: 500,
            background: 'transparent', color: 'var(--text)', marginTop: 6,
          }}>
            <span style={{ fontSize: 15, width: 18, textAlign: 'center', opacity: 0.8 }}>💬</span>
            Report an issue
          </button>
          {/* Account (theme · Log out) pinned at the bottom of the rail, mirroring
              the client sidebar's bottom-left profile menu. */}
          <AdminProfileFooter />
        </nav>
        <div style={{ minWidth: 0 }}>{content}</div>
      </div>
    </main>
  );
}

// ─── Onboarding insights ───────────────────────────────────────────────────────
// Learn from how clients actually use the onboarding wizards: the funnel (where
// people open, advance, skip or complete each guide) and which features they use.
// Measure → recommend → a human decides what to change in guides.js. We don't
// auto-rewrite the flow: a noisy signal silently steering copy is exactly the
// failure mode we want to avoid.

const FEATURE_LABELS = {
  pin: '📌 Pinned a tile', follow: '👁 Followed a tile', briefing_tune: '⚙ Tuned the briefing',
  insight: '🦉 Asked the Owl for an insight', dashboard: '📊 Opened a dashboard',
  notifications_enabled: '🔔 Turned on notifications', install: '📲 Installed the app',
};

// Global Reminders defaults — cadence + the editable client-nudge wording. Applies
// to every client; each client can still override the timing in its own Reminders
// panel. Lives in the onboarding tab next to the funnel insights.
function NudgeGlobalSettings() {
  const [s, setS] = useState(null);
  const [saved, setSaved] = useState(false);
  const [open, setOpen] = useState(false);
  const [testMsg, setTestMsg] = useState('');
  useEffect(() => { api.getSetupNudgeSettings().then(setS).catch(() => setS(null)); }, []);
  if (!s) return null;
  const set = (k, v) => setS((c) => ({ ...c, [k]: v }));
  const setCopy = (k, v) => setS((c) => ({ ...c, copy: { ...c.copy, [k]: v } }));
  const persist = () => api.saveSetupNudgeSettings({ enabled: s.enabled, aiCopy: s.aiCopy, graceDays: s.graceDays, repeatDays: s.repeatDays, hour: s.hour, copy: s.copy });
  const save = async () => { try { await persist(); flash(setSaved); } catch (e) { alert(e.message); } };
  // Save first so the preview reflects what's on screen, then email the admin.
  const test = async () => { setTestMsg('Sending…'); try { await persist(); const r = await api.testSetupNudgeSettings(); setTestMsg(`✓ Sent to ${r.to}`); } catch (e) { setTestMsg(`✗ ${e.message || 'Send failed'}`); } };
  const fld = { ...input, minWidth: 0, width: '100%' };
  const num = (k, label, h) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <L>{label}</L>
      <input type="number" min="0" value={s[k]} onChange={(e) => set(k, e.target.value)} style={fld} />
      {h && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{h}</span>}
    </label>
  );
  const txt = (k, label) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <L>{label}</L>
      <input value={s.copy[k]} onChange={(e) => setCopy(k, e.target.value)} placeholder={s.copyDefaults?.[k] || ''} style={fld} />
    </label>
  );
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 14, background: 'var(--card)', overflow: 'hidden' }}>
      <button onClick={() => setOpen((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', background: 'transparent', border: 'none', padding: 16, cursor: 'pointer', color: 'var(--text)' }}>
        <span style={{ fontSize: 11, color: 'var(--muted)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 14.5, fontWeight: 800 }}>🔔 Reminder defaults</span>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>Cadence + wording for the outstanding-setup nudges. Applies to all clients; each client can override the timing in its own Reminders panel.</span>
        </span>
        {!s.enabled && <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--error)', flexShrink: 0 }}>OFF</span>}
      </button>
      {open && (
        <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!s.enabled} onChange={(e) => set('enabled', e.target.checked)} />
            <span style={{ fontWeight: 700, fontSize: 13.5 }}>Reminders enabled</span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>· global kill switch</span>
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 12 }}>
            {num('graceDays', 'Grace (days)', 'Wait after a client is created before the first nudge.')}
            {num('repeatDays', 'Repeat (days)', 'How often to re-nudge while items stay open.')}
            {num('hour', 'Send hour (0–23)', 'Hour of day the daily check runs.')}
          </div>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!s.aiCopy} onChange={(e) => set('aiCopy', e.target.checked)} style={{ marginTop: 3 }} />
            <span>
              <span style={{ display: 'block', fontWeight: 700, fontSize: 13.5 }}>Personalise the subject & opening with AI</span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>Writes a fresh subject + opening line tailored to each client’s outstanding items, so repeat emails read differently as they finish setup. Falls back to the wording below when AI is off or unavailable.</span>
            </span>
          </label>
          <div>
            <L>Client message wording {s.aiCopy && <span style={{ fontWeight: 400, textTransform: 'none', color: 'var(--muted)' }}>· fallback when AI is off/unavailable</span>}</L>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 6 }}>
              {txt('subject', `Email subject${s.aiCopy ? ' (fallback)' : ''}`)}
              {txt('title', 'In-app title')}
              {txt('intro', `Opening line${s.aiCopy ? ' (fallback)' : ''}`)}
              {txt('button', 'Button label (email)')}
              {txt('signoff', 'Sign-off line')}
            </div>
            <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>The list of outstanding items and the personalised opportunity line are added automatically. Clear a field to fall back to the default.</p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button style={saveBtn} onClick={save}>Save defaults</button>
            {saved && <span style={{ color: 'var(--brand)', fontSize: 13, fontWeight: 600 }}>✓ Saved</span>}
            <span style={{ flex: 1 }} />
            <button style={miniBtnOutline} onClick={test}>Send me a test</button>
            {testMsg && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{testMsg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function OnboardingInsights() {
  const [stats, setStats] = useState(null);
  const [err, setErr] = useState(false);
  useEffect(() => { api.adminOnboardingStats().then(setStats).catch(() => setErr(true)); }, []);

  if (err || !stats) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 720 }}>
      <NudgeGlobalSettings />
      <p style={{ color: 'var(--muted)', fontSize: 13 }}>{err ? 'Couldn’t load usage stats.' : 'Loading…'}</p>
    </div>
  );

  // Build an ordered funnel per guide using the real step order from guides.js.
  const guideIds = Object.keys(stats.guides || {}).filter((id) => GUIDES[id]).sort((a, b) => (stats.guides[b].opens || 0) - (stats.guides[a].opens || 0));
  const recs = [];
  for (const id of guideIds) {
    const g = stats.guides[id];
    const steps = GUIDES[id].steps;
    const baseline = g.opens || (g.steps['0']?.viewed || 0);
    if (baseline < 5) continue; // too little signal to advise on
    let worst = null;
    for (let n = 1; n < steps.length; n++) {
      const prev = g.steps[String(n - 1)]?.viewed || 0;
      const here = g.steps[String(n)]?.viewed || 0;
      const drop = prev - here;
      if (prev > 0 && (!worst || drop > worst.drop)) worst = { n, drop, prev, here };
    }
    if (worst && worst.drop > 0 && worst.drop / (worst.prev || 1) >= 0.4) {
      recs.push(`In “${GUIDES[id].title}”, ${worst.drop} of ${worst.prev} people drop at “${steps[worst.n].title}”. Consider simplifying that step or moving it later.`);
    }
    const rate = g.opens ? Math.round((g.completes / g.opens) * 100) : 0;
    if (g.opens >= 5 && rate < 50) recs.push(`Only ${rate}% finish “${GUIDES[id].title}” (${g.completes}/${g.opens}). It may be too long — trim it.`);
  }
  const features = stats.features || [];
  const topFeature = features[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 720 }}>
      <NudgeGlobalSettings />
      <div>
        <h2 style={{ fontSize: 17, fontWeight: 800 }}>Onboarding insights</h2>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3 }}>
          How clients use the welcome wizard and guides. Use this to refine the steps in <code>client/src/lib/guides.js</code>. {stats.total === 0 && 'No usage recorded yet — check back once clients have started using the wizards.'}
        </p>
      </div>

      {recs.length > 0 && (
        <div style={{ background: 'rgba(124,58,237,0.07)', border: '1px solid rgba(124,58,237,0.25)', borderRadius: 12, padding: 14 }}>
          <div style={{ fontSize: 12.5, fontWeight: 800, color: '#7c3aed', marginBottom: 8 }}>💡 Recommendations</div>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {recs.map((r, i) => <li key={i} style={{ fontSize: 13, lineHeight: 1.5 }}>{r}</li>)}
          </ul>
        </div>
      )}

      {guideIds.map((id) => {
        const g = stats.guides[id];
        const steps = GUIDES[id].steps;
        const baseline = Math.max(g.opens || 0, g.steps['0']?.viewed || 0, 1);
        const rate = g.opens ? Math.round((g.completes / g.opens) * 100) : 0;
        return (
          <div key={id} style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 16, background: 'var(--card)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
              <span style={{ fontSize: 14.5, fontWeight: 800 }}>{GUIDES[id].title}</span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{g.opens} opened · {g.completes} finished · {rate}% completion</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {steps.map((s, n) => {
                const st = g.steps[String(n)] || { viewed: 0, cta: 0, skip: 0 };
                const pct = Math.round((st.viewed / baseline) * 100);
                return (
                  <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ flex: '0 0 38%', minWidth: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n + 1}. {s.title}</span>
                    <div style={{ flex: 1, height: 16, borderRadius: 6, background: 'rgba(128,128,128,0.13)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: 'var(--brand)', borderRadius: 6, transition: 'width .25s' }} />
                    </div>
                    <span style={{ flex: '0 0 auto', fontSize: 11.5, color: 'var(--muted)', minWidth: 92, textAlign: 'right' }}>
                      {st.viewed} seen{st.cta ? ` · ${st.cta} acted` : ''}{st.skip ? ` · ${st.skip} left` : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 16, background: 'var(--card)' }}>
        <div style={{ fontSize: 14.5, fontWeight: 800, marginBottom: 4 }}>Feature usage</div>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 0, marginBottom: 12 }}>What clients actually do — the most-used features are the ones worth teaching in the wizard.</p>
        {features.length === 0 ? (
          <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>No feature usage recorded yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {features.map((f) => {
              const pct = Math.round((f.people / (topFeature.people || 1)) * 100);
              return (
                <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ flex: '0 0 38%', minWidth: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{FEATURE_LABELS[f.name] || f.name}</span>
                  <div style={{ flex: 1, height: 16, borderRadius: 6, background: 'rgba(128,128,128,0.13)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${pct}%`, background: '#2da44e', borderRadius: 6 }} />
                  </div>
                  <span style={{ flex: '0 0 auto', fontSize: 11.5, color: 'var(--muted)', minWidth: 92, textAlign: 'right' }}>{f.people} {f.people === 1 ? 'client' : 'clients'} · {f.hits}×</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Product ──────────────────────────────────────────────────────────────────
// One home for product collateral: the living sales overview (HTML that renders
// docs/PRODUCT_OVERVIEW_SALES.md), a curated feature matrix, and the daily
// release notes the team authors here (persisted, newest-first).

// Status key mirrors the sales overview doc.
const PRODUCT_STATUS = {
  live: { icon: '✅', label: 'Live', color: '#1a8a4a', bg: 'rgba(26,138,74,0.12)' },
  setup: { icon: '🟡', label: 'Needs setup', color: '#9a6a00', bg: 'rgba(214,158,46,0.16)' },
  beta: { icon: '🧪', label: 'Beta', color: '#7C3AED', bg: 'rgba(124,58,237,0.12)' },
  soon: { icon: '🔜', label: 'Coming soon', color: '#5a6270', bg: 'rgba(110,110,115,0.14)' },
};
// Curated catalogue — keep in step with docs/PRODUCT_OVERVIEW_SALES.md.
const PRODUCT_FEATURES = [
  ['Dashboards & insight', [
    ['Live dashboards (KPIs, tables & charts on real data)', 'live'],
    ['Per-tile AI insight + follow-up questions', 'live'],
    ['Personalised home briefing', 'live'],
    ['Mobile-first, installable PWA', 'live'],
  ]],
  ['Scheduled digests', [
    ['Role-written email digests (exec / marketing / finance / ops)', 'live'],
    ['Configurable cadence & focus', 'live'],
    ['Admin-managed + client self-service', 'live'],
  ]],
  ['Messaging inbox', [
    ['Two-way client ↔ Howler threads (read/unread, attachments)', 'live'],
    ['Must-acknowledge messages', 'live'],
    ['In-app, web-push & email notifications', 'live'],
  ]],
  ['Settlements & documents', [
    ['Settlement PDF → interactive statement', 'live'],
    ['Event documents area', 'live'],
  ]],
  ['Engage · Segments', [
    ['Always-live audiences (tile / CSV / paste / Google Sheet)', 'live'],
    ['Column matching (email / name / mobile)', 'live'],
    ['Target on any column', 'live'],
    ['Multi-source combine (Union / Intersect / Exclude)', 'live'],
  ]],
  ['Engage · Campaigns', [
    ['Email, SMS or both to a segment / tile / list', 'live'],
    ['AI-drafted copy, branded templates, hero image', 'live'],
    ['Merge fields from any column', 'live'],
    ['Promo / discount codes', 'live'],
    ['UTM + per-recipient open & click tracking', 'live'],
    ['Consent-aware (POPIA), one-click unsubscribe', 'live'],
    ['Approval workflow', 'live'],
  ]],
  ['Engage · Drip sequences', [
    ['Multi-step journeys with delays', 'live'],
    ['Timing modes (fresh-abandonment / forward-from-send)', 'live'],
    ['Auto-stop on purchase or unsubscribe', 'live'],
    ['Journey waterfall (open / click / convert + drop-off)', 'live'],
  ]],
  ['Engage · Ad audience sync', [
    ['Push a segment to Meta / TikTok Custom Audiences', 'setup'],
    ['Mirror membership + daily auto-sync', 'setup'],
    ['Hashed identities before they leave Pulse', 'setup'],
  ]],
  ['Branding & integrations', [
    ['Per-client branding (logo / colours / sender)', 'live'],
    ['Looker / Anthropic keys', 'live'],
    ['Email (Resend) / SMS (Clickatell)', 'live'],
    ['Meta / TikTok ad accounts', 'setup'],
    ['Inventive embedded AI analyst ("Ask")', 'beta'],
  ]],
  ['Admin console', [
    ['Manage clients, sets/suites, tile library, AI, settlements', 'live'],
    ['Preview as a client', 'live'],
    ['AI audit ("Everything the AI is told")', 'live'],
  ]],
  ['Trust, security & scope', [
    ['Server-side multi-tenant scoping (fails closed)', 'live'],
    ['POPIA-minded consent + hashed ad sync', 'live'],
    ['Roles & permissions', 'live'],
  ]],
  ['On the horizon', [
    ['Conversational / agentic Owl', 'soon'],
    ['Portfolio / "all events" view', 'soon'],
    ['Event tasks + AM cockpit', 'soon'],
    ['WhatsApp & app-push channels', 'soon'],
  ]],
];

function StatusBadge({ status }) {
  const s = PRODUCT_STATUS[status] || PRODUCT_STATUS.live;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 9px', borderRadius: 980, fontSize: 11.5, fontWeight: 700, color: s.color, background: s.bg, whiteSpace: 'nowrap' }}>
      <span aria-hidden>{s.icon}</span>{s.label}
    </span>
  );
}

// The Product section: everything about the product in one place, split into tabs —
// the live Tickets board (bug/feature reports), the feature matrix + sales overview,
// and the daily release notes.
const PRODUCT_TABS = [['tickets', '🎟️ Tickets'], ['matrix', '🧩 Feature matrix'], ['releases', '📝 Release notes']];
function Product() {
  const [sub, setSub] = useState('tickets');
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16, borderBottom: '1px solid var(--hairline)', paddingBottom: 10 }}>
        {PRODUCT_TABS.map(([k, label]) => (
          <button key={k} onClick={() => setSub(k)} style={sub === k ? { ...miniBtn, background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' } : miniBtnOutline}>{label}</button>
        ))}
      </div>
      {sub === 'tickets' && <TicketBoard />}
      {sub === 'matrix' && (
        <>
          <p style={hint}>What the product does today — the living sales overview and the feature matrix.</p>
          <ProductOverviewCard />
          <ProductFeatureTable />
        </>
      )}
      {sub === 'releases' && <ProductReleaseNotes />}
    </div>
  );
}

// The living overview opens in a new tab — it renders docs/PRODUCT_OVERVIEW_SALES.md
// live, so it always reflects the current doc.
function ProductOverviewCard() {
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 26 }}>📄</span>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Product overview (sales)</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
            Living page — renders <code style={codeChip}>docs/PRODUCT_OVERVIEW_SALES.md</code> live, so edits to the doc show up automatically.
          </div>
        </div>
        <a href="/product-overview-sales" target="_blank" rel="noopener noreferrer" style={{ ...miniBtn, textDecoration: 'none', color: 'var(--text)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          Open page ↗
        </a>
      </div>
    </div>
  );
}

// Curated feature matrix: each section with its features + status. Grouped rows
// on desktop; the wrapper scrolls horizontally on narrow phones.
function ProductFeatureTable() {
  const legend = ['live', 'setup', 'beta', 'soon'];
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Feature matrix</div>
        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {legend.map((k) => <StatusBadge key={k} status={k} />)}
        </div>
      </div>
      <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 360 }}>
          <tbody>
            {PRODUCT_FEATURES.map(([section, feats]) => (
              <FeatureSection key={section} section={section} feats={feats} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
function FeatureSection({ section, feats }) {
  return (
    <>
      <tr>
        <th colSpan={2} style={{ textAlign: 'left', padding: '14px 10px 6px', fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--brand)' }}>
          {section}
        </th>
      </tr>
      {feats.map(([feature, status]) => (
        <tr key={feature}>
          <td style={{ ...td, width: '100%' }}>{feature}</td>
          <td style={{ ...td, textAlign: 'right' }}><StatusBadge status={status} /></td>
        </tr>
      ))}
    </>
  );
}

// Daily release notes — authored here, persisted server-side, newest day first.
function ProductReleaseNotes() {
  const today = () => new Date().toISOString().slice(0, 10);
  const blank = () => ({ date: today(), title: '', body: '', howTo: '', deepLink: '', bodyDev: '', published: true });
  const [items, setItems] = useState(null);
  const [draft, setDraft] = useState(blank);
  const [editing, setEditing] = useState(null); // { id, date, title, body, howTo, deepLink, bodyDev, published }
  const [err, setErr] = useState('');
  const [gen, setGen] = useState({ busy: false, msg: '' });
  const load = () => api.adminListReleaseNotes().then(setItems).catch(() => setItems([]));
  useEffect(() => { load(); }, []);
  // Three lenses on one note: `body` is the end-user summary, `howTo` the end-user
  // steps (both reach clients), `bodyDev` the internal-only technical view.
  const ta = { width: '100%', boxSizing: 'border-box', padding: '10px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5, marginTop: 4 };
  const lensLabel = { fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase', color: 'var(--muted)' };
  const lensBody = { fontSize: 13, color: 'var(--text)', marginTop: 3, whiteSpace: 'pre-wrap', lineHeight: 1.55 };
  const generate = async () => {
    setGen({ busy: true, msg: '' });
    try {
      const r = await api.adminGenerateReleaseNotes(14);
      await load();
      setGen({ busy: false, msg: r.created ? `Added ${r.created} draft${r.created === 1 ? '' : 's'} from recent commits — review and publish below.` : (r.message || 'Nothing new to add.') });
    } catch (e) { setGen({ busy: false, msg: e.message }); }
  };
  const add = async () => {
    setErr('');
    try { await api.adminCreateReleaseNote(draft); setDraft(blank()); load(); }
    catch (e) { setErr(e.message); }
  };
  const save = async () => { await api.adminUpdateReleaseNote(editing.id, editing); setEditing(null); load(); };
  const del = async (n) => { if (confirm(`Delete release note "${n.title || n.date}"?`)) { await api.adminDeleteReleaseNote(n.id); load(); } };
  const togglePub = async (n) => { await api.adminUpdateReleaseNote(n.id, { published: !n.published }); load(); };
  const fmtDate = (d) => { const dt = new Date(d); return isNaN(dt) ? d : dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); };

  // The lens editor (composer + inline edit share it). `v`/`set` read+write one note object.
  const lensFields = (v, set) => (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Date"><input type="date" style={{ ...input, minWidth: 150 }} value={v.date} onChange={(e) => set({ ...v, date: e.target.value })} /></Field>
        <Field label="Title"><input style={{ ...input, minWidth: 240 }} placeholder="e.g. Engage hardening" value={v.title} onChange={(e) => set({ ...v, title: e.target.value })} /></Field>
      </div>
      <div style={{ marginTop: 8 }}>
        <L>What shipped — the end-user summary clients see (Markdown)</L>
        <textarea rows={3} value={v.body} onChange={(e) => set({ ...v, body: e.target.value })} placeholder={'- New: …\n- Fixed: …'} style={ta} />
      </div>
      <div style={{ marginTop: 8 }}>
        <L>How to use it — end-user steps (shown to clients in What's New + the weekly email)</L>
        <textarea rows={3} value={v.howTo} onChange={(e) => set({ ...v, howTo: e.target.value })} placeholder={'1. Go to Settings → …\n2. …'} style={ta} />
      </div>
      <div style={{ marginTop: 8 }}>
        <Field label="Deep link — in-app path to the feature"><input style={{ ...input, minWidth: 240 }} placeholder="/settings/branding" value={v.deepLink} onChange={(e) => set({ ...v, deepLink: e.target.value })} /></Field>
      </div>
      <div style={{ marginTop: 8 }}>
        <L>Dev notes — technical, internal only (never shown to clients)</L>
        <textarea rows={3} value={v.bodyDev} onChange={(e) => set({ ...v, bodyDev: e.target.value })} placeholder={'- Refactored … (sha)\n- Migration: …'} style={ta} />
      </div>
    </>
  );

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Daily release notes</div>
        <span style={{ flex: 1 }} />
        <button style={miniBtn} onClick={generate} disabled={gen.busy} title="Summarise the last 14 days of git commits into draft notes for days not yet covered">
          {gen.busy ? 'Generating…' : '✨ Generate from commits'}
        </button>
      </div>
      <p style={hint}>Each day has three lenses: the end-user <b>summary</b> + <b>how-to</b> reach clients (What's New + the weekly email); the <b>dev notes</b> stay internal. Drafts stay hidden until you publish.</p>
      {gen.msg && <div style={{ fontSize: 12.5, color: 'var(--muted)', margin: '-6px 0 12px' }}>{gen.msg}</div>}

      {/* Composer */}
      <div style={{ border: '1px solid var(--hairline)', borderRadius: 10, padding: 12, marginBottom: 16 }}>
        {lensFields(draft, setDraft)}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--muted)', cursor: 'pointer' }}>
            <input type="checkbox" checked={draft.published} onChange={(e) => setDraft({ ...draft, published: e.target.checked })} /> Publish now
          </label>
          <button style={miniBtn} onClick={add} disabled={!draft.title.trim() && !draft.body.trim()}>+ Add release note</button>
          {err && <span style={{ color: 'var(--error)', fontSize: 12.5 }}>{err}</span>}
        </div>
      </div>

      {/* List */}
      {items === null ? <Muted>Loading…</Muted>
        : items.length === 0 ? <Muted>No release notes yet — add the first above.</Muted>
        : items.map((n) => (
          <div key={n.id} style={{ borderTop: '1px solid var(--hairline)', padding: '12px 0' }}>
            {editing?.id === n.id ? (
              <div>
                {lensFields(editing, setEditing)}
                <div style={{ marginTop: 10 }}>
                  <button style={miniBtn} onClick={save}>Save</button>{' '}
                  <button style={miniBtnOutline} onClick={() => setEditing(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>{fmtDate(n.date)}</span>
                  <span style={{ fontSize: 14, fontWeight: 700 }}>{n.title || '(untitled)'}</span>
                  {!n.published && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', border: '1px solid var(--hairline)', borderRadius: 980, padding: '1px 7px' }}>DRAFT</span>}
                  {n.source === 'auto' && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--brand)', border: '1px solid var(--brand)', borderRadius: 980, padding: '1px 7px' }}>AUTO</span>}
                  {n.source === 'seed' && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', border: '1px solid var(--hairline)', borderRadius: 980, padding: '1px 7px' }}>SEEDED</span>}
                  <span style={{ flex: 1 }} />
                  <button style={miniBtnOutline} onClick={() => togglePub(n)}>{n.published ? 'Unpublish' : 'Publish'}</button>
                  <button style={miniBtnOutline} onClick={() => setEditing({ id: n.id, date: n.date, title: n.title, body: n.body, howTo: n.howTo || '', deepLink: n.deepLink || '', bodyDev: n.bodyDev || '', published: n.published })}>Edit</button>
                  <button style={delBtn} onClick={() => del(n)}>Delete</button>
                </div>
                {n.body && <div style={lensBody}>{n.body}</div>}
                {n.howTo && (<div style={{ marginTop: 9 }}><div style={lensLabel}>How to use it · client-facing</div><div style={lensBody}>{n.howTo}</div></div>)}
                {n.deepLink && <div style={{ marginTop: 6 }}><span style={codeChip}>{n.deepLink}</span></div>}
                {n.bodyDev && (<div style={{ marginTop: 9 }}><div style={lensLabel}>Dev notes · internal only</div><div style={{ ...lensBody, color: 'var(--muted)' }}>{n.bodyDev}</div></div>)}
              </div>
            )}
          </div>
        ))}
    </div>
  );
}
const codeChip = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.85em', background: 'var(--elevated)', padding: '1px 6px', borderRadius: 5 };

// ─── Billing (master rate card + spend rollup) ────────────────────────────────
function Billing() {
  const [rollup, setRollup] = useState(null);
  useEffect(() => { api.getBillingRollup().then(setRollup).catch(() => setRollup({ clients: [], total: 0 })); }, []);
  const cur = rollup?.currency || 'ZAR';
  const money = (n) => `${cur === 'ZAR' ? 'R' : `${cur} `}${Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return (
    <div style={{ maxWidth: 720 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Campaign billing</h2>
      <p style={{ ...hint }}>Set the platform master rates per channel. Each client inherits these unless you set a client-specific fee under <b>Clients → [client] → Fees</b>. Costs are per message sent.</p>
      <RateCard scope="master" />
      <div style={{ borderTop: '1px solid var(--hairline)', margin: '24px 0 16px' }} />
      <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Spend rollup — all clients</h3>
      {!rollup ? <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p> : (
        <>
          <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', marginBottom: 12 }}>{money(rollup.total)}<span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600, marginLeft: 8 }}>total across {rollup.clients?.length || 0} client{rollup.clients?.length === 1 ? '' : 's'}</span></div>
          {(rollup.clients || []).length === 0 ? <p style={{ color: 'var(--muted)', fontSize: 13 }}>No campaign spend yet.</p> : (
            <div style={{ border: '1px solid var(--hairline)', borderRadius: 10, overflow: 'hidden' }}>
              {rollup.clients.map((c) => (
                <div key={c.entityId} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: '1px solid var(--hairline)', fontSize: 13 }}>
                  <span style={{ flex: 1, minWidth: 0, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 12, flexShrink: 0 }}>{c.campaigns} campaign{c.campaigns === 1 ? '' : 's'}</span>
                  <span style={{ fontWeight: 800, flexShrink: 0, minWidth: 90, textAlign: 'right' }}>{money(c.total)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Clients (Entities) ───────────────────────────────────────────────────────
function Entities({ fields, onOpenWizard }) {
  const [items, setItems] = useState([]);
  const [suites, setSuites] = useState([]);
  const [sets, setSets] = useState([]);
  const [users, setUsers] = useState([]);
  const [dashTitle, setDashTitle] = useState({});
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [q, setQ] = useState(''); // client search
  // Refreshes (onChange after a save / new suite) must NOT toggle `loading` —
  // doing so unmounts ClientDetail and resets its tab to Settings. Only the first
  // load shows the blocking spinner; later loads update in place.
  const load = () => Promise.all([api.adminListEntities(), api.adminListSuites(), api.adminListSets(), api.adminListUsers(), api.listDashboards()])
    .then(([e, su, s, u, d]) => { setItems(e); setSuites(su); setSets(s); setUsers(u); setDashTitle(Object.fromEntries(d.map((x) => [x.id, x.title]))); });
  useEffect(() => { load().finally(() => setLoading(false)); }, []);
  if (loading) return <Muted>Loading…</Muted>;

  const suitesOf = (eid) => suites.filter((s) => s.entityId === eid);
  const loginsOf = (eid) => users.filter((u) => (u.entityIds || []).includes(eid)); // any role linked to the client

  // Detail view: a single client with its own Settings / Suites / Logins nav.
  const selected = items.find((e) => e.id === selectedId);
  if (selected) {
    return (
      <ClientDetail
        entity={selected}
        fields={fields}
        allEntities={items}
        allSets={sets}
        dashTitle={dashTitle}
        suites={suitesOf(selected.id)}
        users={loginsOf(selected.id)}
        allUsers={users}
        onChange={load}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  // List view: client names only, sorted alphabetically and filtered by search.
  const ql = q.trim().toLowerCase();
  const sorted = [...items].sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
  const shown = ql ? sorted.filter((e) => (e.name || '').toLowerCase().includes(ql)) : sorted;
  const addClient = async () => { const ent = await api.adminCreateEntity({ name: 'New client', lockedFilters: {} }); await load(); setSelectedId(ent.id); };
  return (
    <div>
      <p style={hint}>Pick a client to manage its settings, suites and logins.</p>
      {/* Top bar: search + quick add + the guided wizard, all in reach. */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ ...searchWrap, marginBottom: 0, flex: '1 1 200px' }}>
          <span style={{ color: 'var(--muted)', fontSize: 13, flexShrink: 0 }}>⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search clients…" style={searchInput} />
          {ql && <button onClick={() => setQ('')} style={searchClear} aria-label="Clear search">✕</button>}
        </div>
        <button style={addBtn} onClick={addClient}>+ Add client</button>
        {onOpenWizard && <button style={{ ...addBtn, background: 'var(--brand)', color: '#fff', border: '1.5px solid var(--brand)' }} onClick={onOpenWizard} title="Stand a new client up with the guided, step-by-step wizard">🧙 Setup wizard</button>}
      </div>
      <div style={clientList}>
        {shown.map((e) => (
          <button key={e.id} className="lift" style={clientRow} onClick={() => setSelectedId(e.id)}>
            <span style={{ fontWeight: 600, fontSize: 15 }}>{e.name}</span>
            <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 12 }}>
              {suitesOf(e.id).length} suite{suitesOf(e.id).length === 1 ? '' : 's'} · {loginsOf(e.id).length} login{loginsOf(e.id).length === 1 ? '' : 's'}
            </span>
            <span style={{ color: '#bbb', marginLeft: 10 }}>›</span>
          </button>
        ))}
        {items.length === 0 && <Muted>No clients yet.</Muted>}
        {items.length > 0 && shown.length === 0 && <Muted>No clients match “{q.trim()}”.</Muted>}
      </div>
    </div>
  );
}

// ─── Client Setup Wizard — a guided, step-by-step path for account managers ────
// Stands a new client up end to end without hunting through tabs: create the
// client → lock their data scope → build their suites → add a login → brand it.
// It is LINEAR and ENFORCED — each step explains what to do, you do it inline
// (reusing the very same editors the Clients tab uses, so nothing is a throwaway
// mock), and the "Continue" button stays locked until that step is done. You can
// step back, but you can't skip ahead past unfinished work. Back-end / admin only.
//
// The steps are EDITABLE from the admin UI (the ⚙ on the start screen): wording,
// order, and the AM's own custom guidance steps are stored server-side via
// server/setupWizard.js and merged over these built-in DEFAULTS by key. The
// built-in steps' ACTIONS are fixed (they create real records); only their copy,
// order and extra guidance steps are configurable.
const WIZARD_DEFAULTS = [
  { kind: 'builtin', key: 'client', icon: '🏢', title: 'The client', short: 'Client',
    req: 'a client name', lock: 'Enter a client name to continue', does: 'Creates the client (entity) record.',
    blurb: 'Everything in Pulse hangs off a “client” (internally an entity). Give it a name — usually the organiser or brand you’re onboarding — and, if you have it, their logo. You can change both later.' },
  { kind: 'builtin', key: 'scope', icon: '🔒', title: 'Data scope', short: 'Scope',
    req: 'an organiser (or “All organisers”)', lock: 'Pick an organiser, or tick “All organisers”', does: 'Locks the client to their organiser(s).',
    blurb: 'This is the most important step. Pulse force-filters every query on the server to this client’s organiser, so they only ever see their own numbers. Until you set a scope the account fails closed — they’ll see nothing. Pick the organiser(s) this client owns.' },
  { kind: 'builtin', key: 'suites', icon: '🗂️', title: 'Suites & dashboards', short: 'Suites',
    req: 'at least one suite', lock: 'Add at least one suite to continue', does: 'Builds the client’s suites of dashboards.',
    blurb: 'A suite is one event/context for the client (e.g. “Bushfire 2026”). Inside it you choose which sets of dashboards they get, and lock it to that event. Add one suite per event. You can fine-tune which dashboards each set shows, and reorder them, right here.' },
  { kind: 'builtin', key: 'logins', icon: '🔑', title: 'Logins', short: 'Logins',
    req: 'at least one login', lock: 'Add (or link) at least one login to continue', does: 'Creates the people who can sign in.',
    blurb: 'Create the people who can sign in for this client and set what each can see with a role. Give them a temporary password — they’ll be prompted to change it. You can also link an existing login if someone works across several clients.' },
  { kind: 'builtin', key: 'branding', icon: '🎨', title: 'Branding', short: 'Branding', optional: true, does: 'Opens the per-client branding editor (logo, colours, sender).',
    blurb: 'Optional, but it makes the account feel like the client’s own. Set their logo, brand colours and email sender name — these white-label the whole app (UI accents + charts) and every email Pulse sends for them. Anything left blank inherits the Howler default.' },
];
const REVIEW_STEP = { kind: 'review', key: 'review', icon: '✅', title: 'Review & finish', short: 'Finish',
  blurb: 'Everything required is in place. Preview the account exactly as the client will see it, or set up another.' };
const newKey = (p) => `${p}_${Math.random().toString(36).slice(2, 8)}`;

// Merge the saved override (or null) over the built-in defaults, keyed by step.
// Built-ins keep their behaviour fields from code but take saved wording; custom
// steps come straight from the saved config; any new built-in (added in code
// later) is appended; the client step is always pinned first.
function mergeWizardSteps(saved) {
  const defByKey = Object.fromEntries(WIZARD_DEFAULTS.map((s) => [s.key, s]));
  const pick = (o, keys) => { const out = {}; for (const k of keys) if (o[k] != null) out[k] = o[k]; return out; };
  // Merge a built-in step's walkthrough (the red-border guide): saved overrides
  // (title/body/off + order) layered over the code defaults, keyed by the section
  // anchor. Any new default anchor (added in code) is appended; stale saved ones
  // (anchor no longer in code) are dropped. The anchor + icon stay from code.
  const mergeWalk = (key, savedWalk) => {
    const defs = TOUR_DEFAULTS[key] || [];
    const byTour = Object.fromEntries(defs.map((w) => [w.tour, w]));
    if (!Array.isArray(savedWalk) || !savedWalk.length) return defs.map((w) => ({ ...w }));
    const out = savedWalk.filter((w) => w && byTour[w.tour]).map((w) => ({ ...byTour[w.tour], ...pick(w, ['title', 'body']), off: !!w.off }));
    for (const d of defs) if (!out.some((w) => w.tour === d.tour)) out.push({ ...d });
    return out;
  };
  let list;
  if (Array.isArray(saved) && saved.length) {
    list = saved.filter((s) => s && (s.kind === 'custom' || defByKey[s.key])).map((s) => (
      s.kind === 'custom'
        ? { kind: 'custom', key: s.key || newKey('custom'), icon: s.icon || '📌', title: s.title || 'Guidance step', blurb: s.blurb || '', items: Array.isArray(s.items) ? s.items.filter((it) => it && it.key).map((it) => ({ key: it.key, label: it.label || '' })) : [] }
        : { ...defByKey[s.key], ...pick(s, ['icon', 'title', 'blurb', 'req', 'lock']), walk: mergeWalk(s.key, s.walk) }
    ));
    for (const d of WIZARD_DEFAULTS) if (!list.some((s) => s.key === d.key)) list.push({ ...d, walk: mergeWalk(d.key) });
  } else {
    list = WIZARD_DEFAULTS.map((s) => ({ ...s, walk: mergeWalk(s.key) }));
  }
  const client = list.find((s) => s.key === 'client');
  return client ? [client, ...list.filter((s) => s.key !== 'client')] : list;
}

function SetupWizard({ fields }) {
  const navigate = useNavigate();
  const { setProfile } = useProfile();
  const isMobile = useIsMobile();
  const [data, setData] = useState(null); // { entities, suites, users, sets, dashTitle }
  const [steps, setSteps] = useState(() => mergeWizardSteps(null)); // configurable steps (no review)
  const [entityId, setEntityId] = useState(null);
  const [stepKey, setStepKey] = useState('start'); // 'start' then a step key
  const [ticks, setTicks] = useState({}); // per-client custom-step checklist: { "stepKey:itemKey": 1 }
  const [editing, setEditing] = useState(false);
  // Working state for the steps the wizard saves itself (client + scope).
  const [name, setName] = useState('');
  const [logo, setLogo] = useState('');
  const [locks, setLocks] = useState({});
  const [allOrg, setAllOrg] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [tourOn, setTourOn] = useState(false); // the in-step spotlight walkthrough
  const initFor = useRef(null);
  const bodyRef = useRef(null);
  const autoTourSeen = useRef(new Set());

  const reload = () => Promise.all([api.adminListEntities(), api.adminListSuites(), api.adminListUsers(), api.adminListSets(), api.listDashboards()])
    .then(([entities, suites, users, sets, dash]) => setData({ entities, suites, users, sets, dashTitle: Object.fromEntries(dash.map((d) => [d.id, d.title])) }));
  useEffect(() => { reload(); }, []);
  // Load the admin-edited step config (falls back to defaults if none / on error).
  useEffect(() => { api.getSetupWizard().then((r) => setSteps(mergeWizardSteps(r.steps))).catch(() => {}); }, []);

  const entity = data ? (data.entities.find((e) => e.id === entityId) || null) : null;
  // Seed the editable fields once per client (don't clobber edits on every reload).
  useEffect(() => {
    if (entity && initFor.current !== entity.id) {
      initFor.current = entity.id;
      setName(entity.name || ''); setLogo(entity.logo || '');
      setLocks(entity.lockedFilters || {}); setAllOrg(!!entity.allOrganisers);
    }
    if (!entityId) { initFor.current = null; setName(''); setLogo(''); setLocks({}); setAllOrg(false); }
  }, [entityId, entity]);
  // Load this client's custom-step checklist ticks.
  useEffect(() => {
    if (entityId) api.getSetupWizardProgress(entityId).then((r) => setTicks(r.ticks || {})).catch(() => setTicks({}));
    else setTicks({});
  }, [entityId]);
  // Close any open walkthrough when moving between steps.
  useEffect(() => { setTourOn(false); }, [stepKey]);
  // Auto-launch the spotlight walkthrough the first time the AM reaches a guided
  // step (once per client per step). Non-client steps need the entity to exist;
  // suites also waits until there's a suite to point at.
  useEffect(() => {
    const s = steps.find((x) => x.key === stepKey);
    if (!s || !(s.walk || []).some((w) => !w.off)) return;
    if (stepKey !== 'client' && !entity) return;
    if (stepKey === 'suites' && entity && !data.suites.some((x) => x.entityId === entity.id)) return;
    const k = `${entity?.id || 'new'}:${stepKey}`;
    if (!autoTourSeen.current.has(k)) { autoTourSeen.current.add(k); setTourOn(true); }
  }, [stepKey, entityId, data, steps]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <Muted>Loading…</Muted>;

  const suitesOf = (eid) => data.suites.filter((s) => s.entityId === eid);
  const loginsOf = (eid) => data.users.filter((u) => (u.entityIds || []).includes(eid));
  // The enabled walkthrough points for a step (the red-border guide), in order.
  const walkOf = (key) => { const s = steps.find((x) => x.key === key); return s && s.walk ? s.walk.filter((w) => !w.off) : []; };
  const entHasScope = (e) => e.allOrganisers || Object.values(e.lockedFilters || {}).some((v) => String(v || '').trim());
  // Built-in required-step completion, from SAVED state — drives the resume target
  // and the "needs …" chips. (Branding/custom steps aren't part of this.)
  const reqDone = (e) => ({ client: !!(e.name || '').trim(), scope: entHasScope(e), suites: suitesOf(e.id).length > 0, logins: loginsOf(e.id).length > 0 });
  // Has a given step been completed (for ticks / reachability)? Custom steps are
  // complete once all their checklist items are ticked.
  const stepComplete = (s) => {
    if (!s) return false;
    if (s.kind === 'custom') return (s.items || []).every((it) => ticks[`${s.key}:${it.key}`]);
    if (!entity) return s.key === 'client' ? !!(name || '').trim() : false;
    switch (s.key) {
      case 'client': return !!(entity.name || '').trim();
      case 'scope': return entHasScope(entity);
      case 'suites': return suitesOf(entity.id).length > 0;
      case 'logins': return loginsOf(entity.id).length > 0;
      case 'branding': return !!entity.logo; // optional — for the ✓ only, never blocks
      default: return true;
    }
  };
  // LIVE check on the working fields — can the CURRENT step's Continue unlock yet?
  const hasLock = allOrg || Object.values(locks).some((v) => String(v || '').trim());
  const curStep = stepKey === 'review' ? REVIEW_STEP : (steps.find((s) => s.key === stepKey) || REVIEW_STEP);
  const canProceed = stepKey === 'review' ? true
    : curStep.kind === 'custom' ? (curStep.items || []).every((it) => ticks[`${curStep.key}:${it.key}`])
    : stepKey === 'client' ? !!name.trim()
    : stepKey === 'scope' ? hasLock
    : stepKey === 'suites' ? (!!entity && suitesOf(entity.id).length > 0)
    : stepKey === 'logins' ? (!!entity && loginsOf(entity.id).length > 0)
    : true; // branding + anything else
  const lockHint = curStep.kind === 'custom' ? 'Tick every item to continue' : curStep.lock;

  const go = (key) => { setError(null); setStepKey(key); };
  const seq = [...steps.map((s) => s.key), 'review'];
  const sidx = seq.indexOf(stepKey);
  const nextKey = sidx >= 0 && sidx < seq.length - 1 ? seq[sidx + 1] : 'review';
  const prevKey = sidx > 0 ? seq[sidx - 1] : 'start';
  // A step is reachable only when every blocking step before it (in the current
  // order) is complete — this is what keeps the flow linear. Optional built-ins
  // (branding) never block; custom steps block until their items are ticked.
  const reachable = (key) => {
    if (key === 'client') return true;
    if (!entity) return false;
    const i = key === 'review' ? steps.length : steps.findIndex((s) => s.key === key);
    return steps.slice(0, i < 0 ? steps.length : i).every((s) => s.optional || stepComplete(s));
  };
  const firstUnfinished = (e) => ['client', 'scope', 'suites', 'logins'].find((k) => !reqDone(e)[k]) || steps[0]?.key || 'review';

  const toggleTick = (sk, ik, done) => {
    const k = `${sk}:${ik}`;
    setTicks((t) => ({ ...t, [k]: done ? 1 : 0 }));
    if (entityId) api.setSetupWizardProgress(entityId, k, done).then((r) => setTicks(r.ticks || {})).catch(() => {});
  };

  // Save handlers for the two steps the wizard owns directly.
  const saveClient = async () => {
    if (!name.trim()) { setError('Give the client a name to continue.'); return; }
    setBusy(true); setError(null);
    try {
      if (!entityId) { const ent = await api.adminCreateEntity({ name: name.trim(), logo, lockedFilters: {} }); setEntityId(ent.id); initFor.current = ent.id; }
      else { await api.adminUpdateEntity(entityId, { name: name.trim(), logo }); }
      await reload();
      go(nextKey);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const saveScope = async () => {
    setBusy(true); setError(null);
    try { await api.adminUpdateEntity(entity.id, { lockedFilters: locks, allOrganisers: allOrg }); await reload(); go(nextKey); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  // Preview the account as the client sees it (scope the shell, open first dash).
  const previewAccount = async () => {
    const ents = suitesOf(entity.id);
    setProfile(entity.id, { name: entity.name, logo: entity.logo });
    try {
      for (const su of ents) { const d = await api.mySuite(su.id); const first = d.sets.flatMap((s) => s.dashboards)[0]; if (first) { navigate(`/suite/${su.id}/d/${first.id}`); return; } }
      navigate('/');
    } catch (e) { alert('Could not open preview: ' + e.message); }
  };

  // ── Step editor (the ⚙): edit wording, reorder, add custom guidance steps ────
  if (editing) return <WizardEditor steps={steps} onClose={() => setEditing(false)} onSaved={(saved) => { setSteps(mergeWizardSteps(saved)); setEditing(false); }} />;

  const allSteps = [...steps, REVIEW_STEP];

  // ── Start screen: explain the journey, then begin (new) or resume (existing) ──
  if (stepKey === 'start') {
    const incomplete = [...data.entities]
      .map((e) => ({ e, miss: ['scope', 'suites', 'logins'].filter((k) => !reqDone(e)[k]) }))
      .filter((x) => x.miss.length)
      .sort((a, b) => (a.e.name || '').localeCompare(b.e.name || ''));
    return (
      <div>
        <div style={{ ...cardStyle, background: 'linear-gradient(135deg, rgba(var(--brand-rgb),0.10), rgba(var(--brand-rgb),0.02))', borderColor: 'rgba(var(--brand-rgb),0.25)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', marginBottom: 6, flex: 1 }}>🧙 Client setup wizard</div>
            <button style={miniBtnOutline} onClick={() => setEditing(true)} title="Edit the wizard’s steps, wording and order">⚙ Edit steps</button>
          </div>
          <p style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.55, margin: '0 0 14px', maxWidth: 620 }}>
            A guided, step-by-step path to stand a new client up — the right way, in order. It walks you through
            each step, doing the work as you go, and won’t let you move on from a step until it’s done. Optional
            bits are marked and can be skipped.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
            {allSteps.map((s, i) => (
              <div key={s.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13.5 }}>
                <span style={{ flexShrink: 0, width: 22, height: 22, borderRadius: '50%', background: 'var(--brand)', color: '#fff', fontSize: 12, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</span>
                <span><b>{s.icon} {s.title}</b>{s.optional ? <span style={{ color: 'var(--muted)' }}> · optional</span> : ''}{s.kind === 'custom' ? <span style={{ color: 'var(--muted)' }}> · your step</span> : ''} — <span style={{ color: 'var(--muted)' }}>{(s.blurb || '').split('. ')[0]}.</span></span>
              </div>
            ))}
          </div>
          <button style={{ ...saveBtn, padding: '11px 22px', fontSize: 14 }} onClick={() => { autoTourSeen.current = new Set(); setEntityId(null); go('client'); }}>Start a new client →</button>
        </div>
        {incomplete.length > 0 && (
          <div style={cardStyle}>
            <L>Resume a client that isn’t finished</L>
            <p style={{ ...hint, marginTop: 4 }}>These clients are missing a required step. Pick one to drop straight back in where it left off.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {incomplete.map(({ e, miss }) => (
                <button key={e.id} className="lift" style={clientRow} onClick={() => { setEntityId(e.id); go(firstUnfinished(e)); }}>
                  <span style={{ fontWeight: 600, fontSize: 14.5 }}>{e.name}</span>
                  <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 12 }}>needs {miss.map((m) => (WIZARD_DEFAULTS.find((s) => s.key === m) || {}).short?.toLowerCase() || m).join(' · ')}</span>
                  <span style={{ color: '#bbb', marginLeft: 10 }}>›</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  const step = curStep;

  // ── Stepper header: numbered progress. Click only to revisit a reachable step;
  //    you can't click forward past a step that isn't done. ──
  const Stepper = () => (
    <div style={{ display: 'flex', gap: isMobile ? 6 : 10, marginBottom: 14, overflowX: 'auto', paddingBottom: 4 }}>
      {allSteps.map((s, i) => {
        const active = s.key === stepKey;
        const ok = s.key === 'review' ? false : stepComplete(s);
        const open = reachable(s.key);
        return (
          <button key={s.key} onClick={() => open && go(s.key)} disabled={!open} title={open ? '' : 'Finish the earlier steps first'}
            style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0, padding: isMobile ? '7px 10px' : '8px 13px', borderRadius: 980, cursor: open ? 'pointer' : 'not-allowed',
              border: active ? '1.5px solid var(--brand)' : '1.5px solid var(--hairline)', background: active ? 'var(--brand)' : 'var(--card)', color: active ? '#fff' : (open ? 'var(--text)' : 'var(--muted)'), opacity: open ? 1 : 0.55 }}>
            <span style={{ width: 20, height: 20, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800,
              background: active ? 'rgba(255,255,255,0.25)' : (ok ? 'var(--brand)' : 'rgba(128,128,128,0.18)'), color: active || ok ? '#fff' : 'var(--muted)' }}>{ok ? '✓' : (open ? i + 1 : '🔒')}</span>
            {(!isMobile || active) && <span style={{ fontSize: 13, fontWeight: active ? 700 : 600 }}>{isMobile ? (s.short || s.title) : s.title}</span>}
          </button>
        );
      })}
    </div>
  );

  // Required / optional badge shown at the top of each step.
  const ReqBadge = () => (
    step.optional
      ? <div style={{ ...badgeBase, color: 'var(--muted)', background: 'rgba(128,128,128,0.12)', border: '1px solid var(--hairline)' }}>○ Optional — you can skip this step</div>
      : <div style={{ ...badgeBase, color: 'var(--brand)', background: 'rgba(var(--brand-rgb),0.10)', border: '1px solid rgba(var(--brand-rgb),0.3)' }}>● Required{step.req ? ` — needs ${step.req}` : step.kind === 'custom' ? ' — tick every item' : ''}</div>
  );

  // Continue stays locked until this step is done (optional steps are always
  // unlocked). The lock hint explains exactly what's missing.
  const Footer = ({ primary, primaryLabel = 'Continue', secondary }) => {
    const locked = busy || !canProceed;
    return (
      <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <button style={miniBtnOutline} onClick={() => go(prevKey)} disabled={busy}>← Back</button>
        <span style={{ flex: 1 }} />
        {!canProceed && lockHint && <span style={{ fontSize: 12, color: 'var(--muted)' }}>🔒 {lockHint}</span>}
        {secondary}
        <button style={{ ...saveBtn, opacity: locked ? 0.5 : 1, cursor: locked ? 'not-allowed' : 'pointer' }} onClick={primary} disabled={locked}>{busy ? 'Saving…' : primaryLabel}</button>
      </div>
    );
  };

  return (
    <div>
      <AdminBack onBack={() => go('start')}>Setup wizard</AdminBack>
      <h2 style={{ fontSize: 20, fontWeight: 700, margin: '12px 0 4px' }}>{step.icon} {step.title}{entity ? <span style={{ color: 'var(--muted)', fontWeight: 600 }}> · {entity.name}</span> : ''}</h2>
      <Stepper />
      <div ref={bodyRef} style={cardStyle}>
        {stepKey !== 'review' && <ReqBadge />}
        <p style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.55, margin: '0 0 14px' }}>{step.blurb}</p>
        {walkOf(stepKey).length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <button style={miniBtn} title="Walk through each part of this step, one at a time"
              onClick={() => { if (stepKey === 'suites' && !suitesOf(entity?.id).length) { alert('Add a suite first (the “+ Add suite” button), then I’ll walk you through it.'); return; } setTourOn(true); }}>▶ Guide me through this step</button>
          </div>
        )}

        {stepKey === 'client' && (
          <>
            <div data-tour="client-name"><Field label="Client name · required"><input style={{ ...input, fontWeight: 700, maxWidth: 360 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. MTN Bushfire" autoFocus /></Field></div>
            <div data-tour="client-logo" style={{ marginTop: 14 }}>
              <L>Client logo · optional</L>
              <div style={{ marginTop: 6 }}><LogoPicker value={logo} onChange={setLogo} /></div>
            </div>
            {entity
              ? <><CurrencyField entityId={entity.id} /><LanguageField entityId={entity.id} /><SlugField entityId={entity.id} /><LoginBackgroundField entityId={entity.id} /></>
              : <div data-tour="client-currency" style={{ marginTop: 12, fontSize: 12.5, color: 'var(--muted)' }}>💱 <b>Reporting currency</b>, 🗣 <b>AI copy language</b>, a <b>vanity login URL</b> and a <b>login background</b> can be set here once the client is created.</div>}
            <Footer primary={saveClient} primaryLabel={entityId ? 'Save & continue' : 'Create client & continue'} />
          </>
        )}

        {stepKey === 'scope' && entity && (
          <>
            <label data-tour="scope-all" style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', border: '1px solid var(--hairline)', borderRadius: 10, margin: '4px 0 12px', cursor: 'pointer', background: allOrg ? 'rgba(var(--brand-rgb),0.08)' : 'transparent' }}>
              <input type="checkbox" checked={allOrg} onChange={(e) => setAllOrg(e.target.checked)} style={{ marginTop: 2 }} />
              <span>
                <span style={{ fontWeight: 700, fontSize: 13.5 }}>🌐 All organisers (internal / management)</span>
                <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>This client sees <b>every organiser’s</b> data — no scope is applied. Only for Howler-internal logins. Leave off for a normal client.</span>
              </span>
            </label>
            {!allOrg && (
              <div data-tour="scope-org">
                <L>Organiser scope · required (applies across all this client’s suites)</L>
                <LockedFilterEditor value={locks} onChange={setLocks} fields={fields} restrictTo={['Organiser Name']} />
              </div>
            )}
            {!hasLock && <div style={{ fontSize: 12.5, color: 'var(--error)', marginTop: 6 }}>⚠ No scope set yet — pick an organiser above, or the client will see no data.</div>}
            <Footer primary={saveScope} primaryLabel="Save scope & continue" />
          </>
        )}

        {stepKey === 'suites' && entity && (
          <>
            <ClientSuites entity={entity} suites={suitesOf(entity.id)} allEntities={data.entities} allSets={data.sets} dashTitle={data.dashTitle} fields={fields} onChange={reload} />
            {!stepComplete(step) && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 8 }}>Add at least one suite (the “+ Add suite” button) so the client has dashboards to open — then Continue unlocks.</div>}
            <Footer primary={() => go(nextKey)} />
          </>
        )}

        {stepKey === 'logins' && entity && (
          <>
            <EntityLogins entity={entity} users={loginsOf(entity.id)} allUsers={data.users} onChange={reload} />
            {!stepComplete(step) && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 8 }}>Add or link at least one login so someone can sign in — then Continue unlocks.</div>}
            <Footer primary={() => go(nextKey)} />
          </>
        )}

        {stepKey === 'branding' && entity && (
          <>
            <MailTemplateEditor scope="admin-client" entityId={entity.id} canTest />
            <Footer primary={() => go(nextKey)} primaryLabel="Continue"
              secondary={<button style={miniBtnOutline} onClick={() => go(nextKey)} disabled={busy}>Skip — do it later</button>} />
          </>
        )}

        {step.kind === 'custom' && entity && (
          <>
            {(step.items || []).length === 0
              ? <p style={{ fontSize: 13, color: 'var(--muted)' }}>No checklist items on this step — read the guidance above, then continue.</p>
              : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {step.items.map((it) => {
                    const on = !!ticks[`${step.key}:${it.key}`];
                    return (
                      <button key={it.key} onClick={() => toggleTick(step.key, it.key, !on)} style={{ display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', background: 'transparent', border: '1px solid var(--hairline)', borderRadius: 10, padding: '10px 12px', cursor: 'pointer' }}>
                        <span style={{ width: 22, height: 22, borderRadius: 6, flexShrink: 0, border: `1.5px solid ${on ? 'var(--brand)' : 'var(--hairline)'}`, background: on ? 'var(--brand)' : 'transparent', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800 }}>{on ? '✓' : ''}</span>
                        <span style={{ fontSize: 13.5, fontWeight: 600, textDecoration: on ? 'line-through' : 'none', opacity: on ? 0.65 : 1 }}>{it.label}</span>
                      </button>
                    );
                  })}
                </div>}
            <Footer primary={() => go(nextKey)} />
          </>
        )}

        {stepKey === 'review' && entity && (
          <>
            <div style={{ ...badgeBase, color: 'var(--brand)', background: 'rgba(var(--brand-rgb),0.10)', border: '1px solid rgba(var(--brand-rgb),0.3)', fontSize: 13, padding: '8px 12px' }}>🎉 {entity.name} is ready to go live</div>
            <p style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.55, margin: '10px 0 14px' }}>{step.blurb}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
              {steps.map((s) => {
                const ok = stepComplete(s);
                const opt = s.optional;
                return (
                  <button key={s.key} onClick={() => reachable(s.key) && go(s.key)} disabled={!reachable(s.key)} style={{ display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left', background: 'transparent', border: '1px solid var(--hairline)', borderRadius: 10, padding: '10px 12px', cursor: reachable(s.key) ? 'pointer' : 'default' }}>
                    <span style={{ fontSize: 18 }}>{ok ? '✅' : (opt ? '➖' : '⚠️')}</span>
                    <span style={{ flex: 1 }}>
                      <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700 }}>{s.title}{opt ? <span style={{ color: 'var(--muted)', fontWeight: 600 }}> · optional</span> : ''}</span>
                      <span style={{ display: 'block', fontSize: 12, color: ok ? 'var(--muted)' : 'var(--error)' }}>{ok ? 'Done' : (opt ? 'Not set — fine to skip' : 'Still needs attention — tap to finish')}</span>
                    </span>
                    <span style={{ color: '#bbb' }}>›</span>
                  </button>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <button style={miniBtnOutline} onClick={() => go(prevKey)}>← Back</button>
              <span style={{ flex: 1 }} />
              <button style={previewBtn} onClick={previewAccount} title="Open the account as the client sees it">👁 Preview account</button>
              <button style={saveBtn} onClick={() => { setEntityId(null); go('start'); }}>Set up another client</button>
            </div>
            <p style={{ ...hint, marginTop: 14, marginBottom: 0 }}>Need to go deeper (digests, campaigns, settlements, integrations, per-event briefing)? Find <b>{entity.name}</b> any time under the <b>Clients</b> tab for the full set of controls.</p>
          </>
        )}

        {error && <div style={{ color: 'var(--error)', fontSize: 13, marginTop: 10 }}>{error}</div>}
        {tourOn && walkOf(stepKey).length > 0 && <SectionTour steps={walkOf(stepKey)} container={bodyRef} onClose={() => setTourOn(false)} />}
      </div>
    </div>
  );
}
const badgeBase = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 700, padding: '3px 10px', borderRadius: 980, marginBottom: 12 };

// ─── Section tour — a forced, spotlight walkthrough of a step's sub-sections ───
// Highlights each section in turn (a brand ring with the rest dimmed), scrolls it
// into view, and shows a description with Back / Next. Anchors to elements by their
// [data-tour="<key>"] attribute, scoped to a container. It never blocks the form
// underneath (the dim is a pointer-through box-shadow), so the AM can fill a field
// then hit Next. Reusable for any step — drive it with a list of { tour, title, body }.
const CLIENT_TOUR = [
  { tour: 'client-name', icon: '🏢', title: 'Name the client', body: 'Type the organiser or brand you’re onboarding — this is what everything else hangs off. It’s the only thing you must fill in here.' },
  { tour: 'client-logo', icon: '🖼️', title: 'Add their logo (optional)', body: 'Upload a logo if you have one — it shows as the client’s brand across the app. You can always add or change it later.' },
  { tour: 'client-currency', icon: '💱', title: 'Set their reporting currency', body: 'Pick the currency this client reports in (ZAR by default). It controls how money shows and how the Owl writes amounts — across insights, briefings, goals, alerts and digests. Available once the client is created; clients can’t change it themselves.' },
  { tour: 'client-language', icon: '🗣', title: 'Set their AI copy language', body: 'Pick the language the AI writes in (English by default) — briefings, digests, insights, goal & alert reads, campaign copy and the Owl all speak it. It steers AI wording only; the app’s own buttons and labels stay in English. Available once the client is created; clients can’t change it themselves.' },
  { tour: 'client-slug', icon: '🔗', title: 'Give them a vanity login URL', body: 'Optionally give the client their own white-labelled sign-in page at /<slug> (e.g. /kunye) — their logo, colours and background, so it feels like their own product. Leave blank for the standard login.' },
  { tour: 'client-loginbg', icon: '🖼️', title: 'Login background image', body: 'Upload a full-screen background for that vanity login page. A dark scrim is added automatically so the sign-in card stays readable.' },
];
const SCOPE_TOUR = [
  { tour: 'scope-org', icon: '🔒', title: 'Pick their organiser', body: 'Choose the organiser(s) this client owns. Every dashboard is then force-filtered to only their data on the server — this is what keeps clients apart.' },
  { tour: 'scope-all', icon: '🌐', title: 'Or: all organisers', body: 'Only for Howler-internal / management logins — this lets them see every organiser’s data. Leave it OFF for a normal client.' },
];
const SUITES_TOUR = [
  { tour: 'suite-name', icon: '🏷️', title: 'Name the suite', body: 'Give the suite a name — usually the event itself (e.g. “Bushfire 2026”). It’s the heading the client sees for this event.' },
  { tour: 'suite-icon', icon: '🎨', title: 'Give the suite an icon', body: 'Pick an emoji (or upload a small image). It’s how this event shows up in the client’s sidebar.' },
  { tour: 'suite-sets', icon: '🗂️', title: 'Choose the dashboard sets', body: 'Tick the sets this event should include — e.g. Ticketing, Cashless. Expand a set to include or leave out individual dashboards.' },
  { tour: 'suite-roles', icon: '👥', title: 'Who sees what (optional)', body: 'Restrict a set or dashboard to certain roles — e.g. finance-only views. Leave it alone to show everything to everyone.' },
  { tour: 'suite-locks', icon: '🔒', title: 'Lock it to the event', body: 'The important one — open this and pick the event (and cashless event, if used) so every dashboard here only shows THIS event’s numbers.' },
  { tour: 'suite-ticket', icon: '🔗', title: 'Add the ticket link', body: 'Paste the event’s buy / checkout URL. Campaigns for this event auto-fill it as their call-to-action.' },
  { tour: 'suite-save', icon: '💾', title: 'Save the suite', body: 'Hit Save to apply everything above. (Event branding below saves on its own.)' },
  { tour: 'suite-branding', icon: '✨', title: 'Event branding (optional)', body: 'Override the look just for this event — logo, colours, sender. Blank fields inherit the client’s branding.' },
];
const LOGINS_TOUR = [
  { tour: 'login-add', icon: '🔑', title: 'Add a login', body: 'Enter the person’s name, email and a temporary password. They’ll be prompted to change it the first time they sign in.' },
  { tour: 'login-role', icon: '🎚️', title: 'Choose their role', body: 'The role controls what this person can see and do. Pick the access level that fits them.' },
  { tour: 'login-link', icon: '🔗', title: 'Or link an existing person', body: 'If someone already has a login on another client, link them here instead of creating a duplicate account.' },
];
const BRANDING_TOUR = [
  { tour: 'mte-senderName', icon: '✉️', title: 'Sender name', body: 'The “From” name on this client’s emails — usually their brand. Blank inherits the Howler default.' },
  { tour: 'mte-brandColor', icon: '🎨', title: 'Brand colours', body: 'The primary (and secondary) colour drive the whole app look — buttons, accents, chart series — and their emails.' },
  { tour: 'mte-logo', icon: '🖼️', title: 'Logo', body: 'Upload their logo or paste a URL — it shows in the sidebar and atop every email. Tip: “Extract colours” pulls a palette straight from the logo.' },
  { tour: 'mte-preview', icon: '👀', title: 'Live preview', body: 'See exactly how an email will look as you edit. Anything left blank falls back to the client’s — then Howler’s — defaults.' },
  { tour: 'mte-save', icon: '💾', title: 'Save the branding', body: 'Save to apply it — the app re-themes live, no reload. You can also send yourself a test email.' },
];
// Per-step walkthrough DEFAULTS, keyed by step. Each is an ordered list of
// { tour, icon, title, body } where `tour` matches a [data-tour] anchor inside
// that step's content. The AM can edit the title/body/order/on-off of these from
// the ⚙ editor (stored as each step's `walk`); the anchor + icon stay from code.
const TOUR_DEFAULTS = { client: CLIENT_TOUR, scope: SCOPE_TOUR, suites: SUITES_TOUR, logins: LOGINS_TOUR, branding: BRANDING_TOUR };

function SectionTour({ steps, container, onClose, zIndex = 4000 }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState(null);
  const last = useRef(null);
  const cur = steps[i];

  useEffect(() => {
    const root = () => (container && container.current) || document;
    const find = () => root().querySelector(`[data-tour="${cur.tour}"]`);
    const el0 = find();
    if (el0) el0.scrollIntoView({ behavior: 'smooth', block: 'center' });
    let raf;
    const tick = () => {
      const el = find();
      if (el) {
        const r = el.getBoundingClientRect();
        const nr = { top: r.top, left: r.left, width: r.width, height: r.height };
        const p = last.current;
        if (!p || Math.abs(p.top - nr.top) > 0.5 || Math.abs(p.left - nr.left) > 0.5 || Math.abs(p.width - nr.width) > 0.5 || Math.abs(p.height - nr.height) > 0.5) { last.current = nr; setRect(nr); }
      } else if (last.current) { last.current = null; setRect(null); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [i, cur.tour, container]);

  const isLast = i === steps.length - 1;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 360;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 640;
  const cardW = Math.min(360, vw - 24);
  let cardTop, cardLeft;
  if (rect) {
    const below = rect.top + rect.height + 12;
    const placeAbove = below + 170 > vh && rect.top - 170 > 0;
    cardTop = placeAbove ? Math.max(12, rect.top - 12 - 158) : Math.min(vh - 178, below);
    cardLeft = Math.min(Math.max(12, rect.left), vw - cardW - 12);
  } else { cardTop = Math.max(12, vh / 2 - 90); cardLeft = vw / 2 - cardW / 2; }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex, pointerEvents: 'none' }}>
      {rect && <div style={{ position: 'fixed', top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12, border: '2.5px solid var(--brand)', borderRadius: 12, boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)', transition: 'top .2s, left .2s, width .2s, height .2s', pointerEvents: 'none' }} />}
      <div style={{ position: 'fixed', top: cardTop, left: cardLeft, width: cardW, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: '0 16px 48px -10px rgba(0,0,0,0.5)', padding: 16, pointerEvents: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--brand)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Step {i + 1} of {steps.length}</span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1 }} title="Close guide">✕</button>
        </div>
        <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 6 }}>{cur.icon ? `${cur.icon} ` : ''}{cur.title}</div>
        <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.5, margin: '0 0 14px' }}>{cur.body}</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {i > 0 && <button style={miniBtnOutline} onClick={() => setI(i - 1)}>← Back</button>}
          <span style={{ flex: 1 }} />
          <button style={saveBtn} onClick={() => (isLast ? onClose() : setI(i + 1))}>{isLast ? 'Done' : 'Next →'}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Wizard step editor — edit wording, reorder, add custom guidance steps ─────
// Back-end editor for the setup wizard itself (opened from the ⚙). The built-in
// steps' actions are fixed, so only their copy is editable; the AM can reorder
// everything (the client step stays first) and add their own guidance steps with
// a tick-off checklist. Saves the whole ordered list to server/setupWizard.js.
function WizardEditor({ steps, onClose, onSaved }) {
  const [list, setList] = useState(() => steps.map((s) => ({ ...s, items: s.items ? s.items.map((it) => ({ ...it })) : undefined, walk: s.walk ? s.walk.map((w) => ({ ...w })) : undefined })));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [openEdit, setOpenEdit] = useState({}); // which step cards are expanded (collapsed by default)
  const [previewStep, setPreviewStep] = useState(null); // index of the step being previewed

  const patch = (i, p) => setList((l) => l.map((x, j) => (j === i ? { ...x, ...p } : x)));
  // Walkthrough-point edits (the red-border guide): change text, reorder, on/off.
  const walkPatch = (i, wi, p) => setList((l) => l.map((x, j) => (j === i ? { ...x, walk: x.walk.map((w, k) => (k === wi ? { ...w, ...p } : w)) } : x)));
  const walkMove = (i, wi, dir) => setList((l) => l.map((x, j) => { if (j !== i) return x; const w = x.walk.slice(); const t = wi + dir; if (t < 0 || t >= w.length) return x; [w[wi], w[t]] = [w[t], w[wi]]; return { ...x, walk: w }; }));
  const move = (i, dir) => setList((l) => {
    const j = i + dir;
    if (l[i].key === 'client' || j < 1 || j >= l.length) return l; // client pinned first; stay in range
    const n = l.slice(); [n[i], n[j]] = [n[j], n[i]]; return n;
  });
  const addCustom = () => setList((l) => [...l, { kind: 'custom', key: newKey('custom'), icon: '📌', title: 'New guidance step', blurb: 'Explain what to do at this step.', items: [] }]);
  const removeStep = (i) => setList((l) => l.filter((_, j) => j !== i));
  const addItem = (i) => setList((l) => l.map((x, j) => (j === i ? { ...x, items: [...(x.items || []), { key: newKey('item'), label: '' }] } : x)));
  const setItem = (i, ii, label) => setList((l) => l.map((x, j) => (j === i ? { ...x, items: x.items.map((it, k) => (k === ii ? { ...it, label } : it)) } : x)));
  const removeItem = (i, ii) => setList((l) => l.map((x, j) => (j === i ? { ...x, items: x.items.filter((_, k) => k !== ii) } : x)));

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      // Strip behaviour-only fields; the server stores wording + order + customs.
      const payload = list.map((s) => (s.kind === 'custom'
        ? { kind: 'custom', key: s.key, icon: s.icon, title: s.title, blurb: s.blurb, items: (s.items || []).filter((it) => (it.label || '').trim()).map((it) => ({ key: it.key, label: it.label.trim() })) }
        : { kind: 'builtin', key: s.key, icon: s.icon, title: s.title, blurb: s.blurb, ...(s.req != null ? { req: s.req } : {}), ...(s.lock != null ? { lock: s.lock } : {}), walk: (s.walk || []).map((w) => ({ tour: w.tour, title: w.title, body: w.body, off: !!w.off })) }));
      const r = await api.saveSetupWizard(payload);
      onSaved(r.steps);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const reset = async () => {
    if (!confirm('Reset the wizard to its built-in defaults? This removes your wording changes and custom steps.')) return;
    setBusy(true); setErr(null);
    try { const r = await api.resetSetupWizard(); onSaved(r.steps); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div>
      <AdminBack onBack={onClose}>Back to wizard</AdminBack>
      <h2 style={{ fontSize: 20, fontWeight: 700, margin: '12px 0 4px' }}>⚙ Edit the setup wizard</h2>
      <p style={{ ...hint }}>Change each step’s wording, reorder them, edit the <b>walkthrough points</b> (the red-border guide on each section), and add your own guidance steps. The built-in steps still <b>do</b> their job (create the client, scope, suites, logins, branding) — you’re editing what the AM reads, the order, and any extra steps you add. The “client” step stays first.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {list.map((s, i) => {
          const def = WIZARD_DEFAULTS.find((d) => d.key === s.key);
          const isCustom = s.kind === 'custom';
          return (
            <div key={s.key} style={cardStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: openEdit[s.key] ? 10 : 0 }}>
                <button onClick={() => setOpenEdit((o) => ({ ...o, [s.key]: !o[s.key] }))} title={openEdit[s.key] ? 'Collapse' : 'Expand to edit'}
                  style={{ width: 16, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--muted)', fontSize: 11, padding: 0, flexShrink: 0, transform: openEdit[s.key] ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</button>
                <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 }}>Step {i + 1}</span>
                <button onClick={() => setOpenEdit((o) => ({ ...o, [s.key]: !o[s.key] }))} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', padding: 0, color: 'var(--text)' }}>
                  {isCustom
                    ? <span style={{ ...badgeBase, marginBottom: 0, color: 'var(--brand)', background: 'rgba(var(--brand-rgb),0.10)', border: '1px solid rgba(var(--brand-rgb),0.3)' }}>Your step</span>
                    : <span style={{ ...badgeBase, marginBottom: 0, color: 'var(--muted)', background: 'rgba(128,128,128,0.12)', border: '1px solid var(--hairline)' }} title={def?.does || ''}>Built-in{s.optional ? ' · optional' : ''}</span>}
                  <span style={{ fontWeight: 700, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.icon} {s.title}</span>
                </button>
                <button style={miniBtnOutline} onClick={() => setPreviewStep(i)} title="Preview how this step looks in the wizard">👁 Preview</button>
                <button style={miniBtnOutline} onClick={() => move(i, -1)} disabled={s.key === 'client' || i <= 1} title="Move up">↑</button>
                <button style={miniBtnOutline} onClick={() => move(i, 1)} disabled={s.key === 'client' || i >= list.length - 1} title="Move down">↓</button>
                {isCustom && <button style={delBtn} onClick={() => removeStep(i)}>Remove</button>}
              </div>
              {openEdit[s.key] && (<>
              {def?.does && !isCustom && <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 10px' }}>What it does: {def.does}</p>}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <Field label="Icon"><input style={{ ...input, width: 64, minWidth: 0, textAlign: 'center' }} value={s.icon || ''} onChange={(e) => patch(i, { icon: e.target.value })} maxLength={4} /></Field>
                <Field label="Title"><input style={{ ...input, minWidth: 220 }} value={s.title || ''} onChange={(e) => patch(i, { title: e.target.value })} /></Field>
              </div>
              <div style={{ marginTop: 10 }}>
                <L>Explanation (what the AM reads)</L>
                <textarea value={s.blurb || ''} onChange={(e) => patch(i, { blurb: e.target.value })} rows={3} style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5, marginTop: 4 }} />
              </div>
              {!isCustom && s.req != null && (
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
                  <Field label="“Needs …” label"><input style={{ ...input, minWidth: 220 }} value={s.req || ''} onChange={(e) => patch(i, { req: e.target.value })} /></Field>
                  <Field label="Locked-button hint"><input style={{ ...input, minWidth: 260 }} value={s.lock || ''} onChange={(e) => patch(i, { lock: e.target.value })} /></Field>
                </div>
              )}
              {!isCustom && (s.walk || []).length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <L>Walkthrough points — the red-border guide</L>
                  <div style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 8px' }}>Edit what each highlighted section says, reorder them, or switch one off. Each point is pinned to a part of this step (you can’t add new highlights — those need a matching field on the page).</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {s.walk.map((w, wi) => (
                      <div key={w.tour} style={{ border: '1px solid var(--hairline)', borderRadius: 8, padding: 10, opacity: w.off ? 0.55 : 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                          <span style={{ fontSize: 15 }}>{w.icon}</span>
                          <input style={{ ...input, flex: 1, fontWeight: 600 }} value={w.title || ''} onChange={(e) => walkPatch(i, wi, { title: e.target.value })} />
                          <button style={miniBtnOutline} onClick={() => walkMove(i, wi, -1)} disabled={wi === 0} title="Move up">↑</button>
                          <button style={miniBtnOutline} onClick={() => walkMove(i, wi, 1)} disabled={wi === s.walk.length - 1} title="Move down">↓</button>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--muted)', cursor: 'pointer' }} title="Show this point in the guide">
                            <input type="checkbox" checked={!w.off} onChange={() => walkPatch(i, wi, { off: !w.off })} /> on
                          </label>
                        </div>
                        <textarea value={w.body || ''} onChange={(e) => walkPatch(i, wi, { body: e.target.value })} rows={2} style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 12.5, outline: 'none', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.45 }} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {isCustom && (
                <div style={{ marginTop: 12 }}>
                  <L>Checklist items (the AM ticks these to continue)</L>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '6px 0' }}>
                    {(s.items || []).map((it, ii) => (
                      <div key={it.key} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <span style={{ color: 'var(--muted)' }}>☐</span>
                        <input style={{ ...input, flex: 1 }} value={it.label} placeholder="e.g. Send the welcome email" onChange={(e) => setItem(i, ii, e.target.value)} />
                        <button style={delBtn} onClick={() => removeItem(i, ii)}>✕</button>
                      </div>
                    ))}
                    {(s.items || []).length === 0 && <span style={{ fontSize: 12, color: 'var(--muted)' }}>No items — this step is just guidance the AM reads, with nothing to tick.</span>}
                  </div>
                  <button style={miniBtn} onClick={() => addItem(i)}>+ Add checklist item</button>
                </div>
              )}
              </>)}
            </div>
          );
        })}
      </div>
      <button style={{ ...addBtn, marginTop: 12 }} onClick={addCustom}>+ Add a guidance step</button>
      {err && <div style={{ color: 'var(--error)', fontSize: 13, marginTop: 10 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <button style={miniBtnOutline} onClick={onClose} disabled={busy}>Cancel</button>
        <button style={delBtn} onClick={reset} disabled={busy}>Reset to defaults</button>
        <span style={{ flex: 1 }} />
        <button style={{ ...saveBtn, opacity: busy ? 0.6 : 1 }} onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save wizard'}</button>
      </div>
      {previewStep != null && list[previewStep] && <StepPreviewModal steps={list} index={previewStep} onClose={() => setPreviewStep(null)} />}
    </div>
  );
}

// ─── Step preview — the actual wizard screen, WITH the live walkthrough ───────
// A faithful mock of the wizard screen for one step (numbered stepper, the step
// card with its badge/title/explanation, a sketch of that step's controls, and
// the footer) — crucially, the mock sections carry the SAME [data-tour] anchors
// as the real step, so the real SectionTour plays its red-border spotlight
// animation right over them. So the AM sees exactly what the user will see,
// animation and all, driven entirely by the edited config.
function StepPreviewModal({ steps, index, onClose }) {
  const s = steps[index];
  const isCustom = s.kind === 'custom';
  const walk = (s.walk || []).filter((w) => !w.off);
  const chips = [...steps, { key: 'review', icon: '✅', title: 'Review & finish', short: 'Finish' }];
  const [playing, setPlaying] = useState(false);
  const bodyRef = useRef(null);
  // Auto-play the walkthrough shortly after open (lets the mock paint first),
  // mirroring how the real wizard auto-launches it.
  useEffect(() => { if (!walk.length) return; const t = setTimeout(() => setPlaying(true), 450); return () => clearTimeout(t); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const badge = isCustom
    ? <div style={{ ...badgeBase, color: 'var(--muted)', background: 'rgba(128,128,128,0.12)', border: '1px solid var(--hairline)' }}>{(s.items || []).length ? '● Required — tick every item' : '○ Guidance'}</div>
    : s.optional
      ? <div style={{ ...badgeBase, color: 'var(--muted)', background: 'rgba(128,128,128,0.12)', border: '1px solid var(--hairline)' }}>○ Optional — you can skip this step</div>
      : <div style={{ ...badgeBase, color: 'var(--brand)', background: 'rgba(var(--brand-rgb),0.10)', border: '1px solid rgba(var(--brand-rgb),0.3)' }}>● Required{s.req ? ` — needs ${s.req}` : ''}</div>;
  const lockMsg = isCustom ? ((s.items || []).length ? 'Tick every item to continue' : '') : (s.req ? (s.lock || `needs ${s.req}`) : '');
  const fauxInput = { ...input, display: 'flex', alignItems: 'center', background: 'rgba(128,128,128,0.06)', color: 'var(--muted)', pointerEvents: 'none' };
  const lbl = (t) => <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '2px 0 4px' }}>{t}</div>;
  // A mock section wrapped with the real [data-tour] anchor so the tour highlights it.
  const sec = (tour, child) => <div data-tour={tour} style={{ marginTop: 10 }}>{child}</div>;
  const secHead = (title) => <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 8px', border: '1px solid var(--hairline)', borderRadius: 8 }}><span style={{ color: '#b0b0b6', fontSize: 11 }}>▶</span><span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted)' }}>{title}</span></div>;
  const body = () => {
    if (isCustom) {
      return (s.items || []).length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
          {s.items.map((it) => (
            <div key={it.key} style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--hairline)', borderRadius: 10, padding: '10px 12px' }}>
              <span style={{ width: 22, height: 22, borderRadius: 6, border: '1.5px solid var(--hairline)', flexShrink: 0 }} />
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{it.label || <em style={{ color: 'var(--muted)' }}>empty item</em>}</span>
            </div>
          ))}
        </div>
      ) : <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 8 }}>Guidance only — the AM reads the explanation above, then continues.</div>;
    }
    switch (s.key) {
      case 'client': return (<>
        {sec('client-name', <>{lbl('Client name · required')}<div style={{ ...fauxInput, maxWidth: 320 }}>e.g. MTN Bushfire</div></>)}
        {sec('client-logo', <>{lbl('Client logo · optional')}<div style={{ width: 120, height: 44, border: '1px dashed var(--hairline)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 12 }}>logo</div></>)}
        {sec('client-currency', <>{lbl('Reporting currency')}<div style={{ ...fauxInput, maxWidth: 320 }}>Platform default (ZAR)</div></>)}
        {sec('client-language', <>{lbl('AI copy language')}<div style={{ ...fauxInput, maxWidth: 320 }}>Platform default (English)</div></>)}
        {sec('client-slug', <>{lbl('Vanity login URL')}<div style={{ ...fauxInput, maxWidth: 320 }}>{window.location.host}/kunye</div></>)}
        {sec('client-loginbg', <>{lbl('Login background image')}<div style={{ width: 160, height: 90, border: '1px dashed var(--hairline)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 12 }}>background</div></>)}
      </>);
      case 'scope': return (<>
        {sec('scope-all', <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: '1px solid var(--hairline)', borderRadius: 10 }}>
          <span style={{ width: 16, height: 16, border: '1.5px solid var(--hairline)', borderRadius: 4, flexShrink: 0 }} />
          <span style={{ fontWeight: 700, fontSize: 13 }}>🌐 All organisers (internal / management)</span>
        </div>)}
        {sec('scope-org', <>{lbl('Organiser scope · required')}<div style={fauxInput}>Pick the client’s organiser…</div></>)}
      </>);
      case 'suites': return (<>
        {sec('suite-name', <>{lbl('Suite name')}<div style={fauxInput}>e.g. Bushfire 2026</div></>)}
        {sec('suite-icon', <>{lbl('Icon')}<div style={{ width: 40, height: 40, border: '1px solid var(--hairline)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>🎟️</div></>)}
        {sec('suite-sets', secHead('Sets in this suite (1)'))}
        {sec('suite-roles', secHead('Dashboard access by role'))}
        {sec('suite-locks', <>{secHead('Locked filters (the event, cashless events…)')}<div style={{ display: 'flex', gap: 8, marginTop: 6 }}><div style={{ ...miniBtn, opacity: 0.8, pointerEvents: 'none' }}>+ Add locked filter</div><div style={{ ...miniBtn, opacity: 0.8, pointerEvents: 'none' }}>+ Add default filters</div></div></>)}
        {sec('suite-ticket', <>{lbl('Ticket / checkout link')}<div style={fauxInput}>https://tickets.example.com/your-event</div></>)}
        {sec('suite-save', <div style={{ ...saveBtn, display: 'inline-block', opacity: 0.8, pointerEvents: 'none' }}>Save</div>)}
        {sec('suite-branding', secHead('Event branding (logo / colours / sender)'))}
      </>);
      case 'logins': return (<>
        {sec('login-add', <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div><div style={fauxInput}>First name</div></div>
          <div><div style={fauxInput}>Email</div></div>
          {sec('login-role', <div style={{ ...fauxInput, minWidth: 110 }}>Role ▾</div>)}
          <div style={{ ...miniBtn, opacity: 0.8, pointerEvents: 'none' }}>+ Add login</div>
        </div>)}
        {sec('login-link', <>{lbl('Or link an existing login')}<div style={fauxInput}>Pick a login…</div></>)}
      </>);
      case 'branding': return (<>
        {sec('mte-senderName', <>{lbl('Sender name')}<div style={fauxInput}>e.g. Kunye</div></>)}
        {sec('mte-brandColor', <>{lbl('Primary colour')}<div style={{ display: 'flex', gap: 8 }}><div style={{ width: 44, height: 34, borderRadius: 8, background: 'var(--brand)' }} /><div style={{ ...fauxInput, flex: 1 }}>#FF385C</div></div></>)}
        {sec('mte-logo', <>{lbl('Logo')}<div style={{ width: 120, height: 44, border: '1px dashed var(--hairline)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 12 }}>logo</div></>)}
        {sec('mte-preview', <>{lbl('Live preview')}<div style={{ height: 90, border: '1px solid var(--hairline)', borderRadius: 10, background: '#fff' }} /></>)}
        {sec('mte-save', <div style={{ ...saveBtn, display: 'inline-block', opacity: 0.8, pointerEvents: 'none' }}>Save</div>)}
      </>);
      default: return <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 8 }}>This step’s controls appear here.</div>;
    }
  };
  return (
    <>
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 5000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg, var(--card))', borderRadius: 16, boxShadow: '0 24px 64px -12px rgba(0,0,0,0.6)', width: 'min(720px, 96vw)', maxHeight: '92vh', overflowY: 'auto', padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Preview — the wizard screen, as the AM sees it</span>
          <span style={{ flex: 1 }} />
          {walk.length > 0 && <button style={miniBtn} onClick={() => setPlaying(true)}>▶ Play walkthrough</button>}
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }} title="Close">✕</button>
        </div>
        <div ref={bodyRef}>
          <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4, marginBottom: 14 }}>
            {chips.map((c, k) => {
              const active = k === index;
              return (
                <div key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0, padding: '7px 11px', borderRadius: 980, border: active ? '1.5px solid var(--brand)' : '1.5px solid var(--hairline)', background: active ? 'var(--brand)' : 'var(--card)', color: active ? '#fff' : 'var(--muted)', opacity: k > index ? 0.55 : 1 }}>
                  <span style={{ width: 20, height: 20, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, background: active ? 'rgba(255,255,255,0.25)' : 'rgba(128,128,128,0.18)', color: active ? '#fff' : 'var(--muted)' }}>{k + 1}</span>
                  {active && <span style={{ fontSize: 13, fontWeight: 700 }}>{c.title}</span>}
                </div>
              );
            })}
          </div>
          <div style={{ ...cardStyle, marginBottom: 0 }}>
            {badge}
            <h2 style={{ fontSize: 20, fontWeight: 700, margin: '2px 0 8px' }}>{s.icon} {s.title}</h2>
            <p style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.55, margin: '0 0 12px' }}>{s.blurb}</p>
            {walk.length > 0 && <div style={{ ...miniBtn, display: 'inline-block', opacity: 0.75, pointerEvents: 'none' }}>▶ Guide me through this step</div>}
            {body()}
            <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ ...miniBtnOutline, opacity: 0.7, pointerEvents: 'none' }}>← Back</div>
              <span style={{ flex: 1 }} />
              {lockMsg && <span style={{ fontSize: 12, color: 'var(--muted)' }}>🔒 {lockMsg}</span>}
              <div style={{ ...saveBtn, opacity: lockMsg ? 0.5 : 1, pointerEvents: 'none' }}>{index === 0 ? 'Create client & continue' : 'Continue'}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
    {playing && walk.length > 0 && <SectionTour steps={walk} container={bodyRef} zIndex={6000} onClose={() => setPlaying(false)} />}
    </>
  );
}

// ─── Users: every login in one place, with a drill-in detail view ─────────────
// A directory of ALL users (Howler admins + client logins). Click a user to see
// their profile, client roles, last login and a full activity timeline (what
// they did and what they viewed). Read-only — editing still lives under a
// client's Logins tab / Admin logins.
function relTime(iso) {
  if (!iso) return 'Never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = (Date.now() - t) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtWhen(iso) {
  if (!iso) return 'Never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
// A short, friendly device label from a user-agent (for the install marker).
function shortDevice(ua = '') {
  const s = String(ua);
  if (/iphone/i.test(s)) return 'iPhone';
  if (/ipad/i.test(s)) return 'iPad';
  if (/android/i.test(s)) return 'Android';
  if (/mac os x|macintosh/i.test(s)) return 'Mac';
  if (/windows/i.test(s)) return 'Windows';
  return 'device';
}
// One emoji per action family — keeps the timeline scannable at a glance.
function actionGlyph(action = '') {
  const a = String(action);
  if (a.startsWith('auth')) return '🔑';
  if (a.startsWith('campaign')) return '📣';
  if (a.startsWith('segment')) return '👥';
  if (a.startsWith('goal')) return '🎯';
  if (a.startsWith('alert')) return '🔔';
  if (a.startsWith('digest')) return '📧';
  if (a.startsWith('settings') || a.startsWith('home')) return '⚙️';
  if (a.startsWith('briefing')) return '📝';
  if (a.startsWith('team') || a.startsWith('admin.user')) return '🧑';
  if (a.startsWith('admin')) return '🛠️';
  if (a.startsWith('dashboard')) return '📊';
  if (a.startsWith('guide') || a.startsWith('feature')) return '🚀';
  return '•';
}
// Emails received: glyph + friendly label by send kind, colour by delivery status.
function mailGlyph(kind = '') {
  const k = String(kind);
  if (k === 'digest') return '📧';
  if (k === 'campaign') return '📣';
  if (k.startsWith('notif') || k === 'alert') return '🔔';
  if (k === 'otp' || k === 'auth' || k === 'welcome' || k === 'invite') return '🔑';
  return '✉️';
}
const MAIL_KIND_LABELS = { digest: 'Digest', campaign: 'Campaign', notification: 'Notification', alert: 'Alert', welcome: 'Welcome', invite: 'Invite', otp: 'Sign-in code', other: 'Email' };
const mailKindLabel = (k) => MAIL_KIND_LABELS[k] || (k ? k[0].toUpperCase() + k.slice(1) : 'Email');
function mailStatusStyle(status = '') {
  const s = String(status).toLowerCase();
  if (s.startsWith('sent')) return { color: '#1a7f37', background: '#e8f5ec' };
  if (s.startsWith('fail')) return { color: 'var(--error)', background: '#fdeceb' };
  return { color: 'var(--muted)', background: 'var(--elevated)' }; // skipped / other
}

function UsersTab() {
  const isMobile = useIsMobile();
  const [users, setUsers] = useState(null);
  const [entities, setEntities] = useState([]);
  const [roles, setRoles] = useState([]);
  const [howlerRoles, setHowlerRoles] = useState([]);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('active'); // active | email | login
  const [roleFilter, setRoleFilter] = useState('all'); // all | admin | client
  const [selectedId, setSelectedId] = useState(null);
  const [openInEdit, setOpenInEdit] = useState(false);
  const [adding, setAdding] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [installs, setInstalls] = useState({});
  const load = () => Promise.all([api.adminListUsers(), api.adminListEntities(), api.getRoles().catch(() => ({ roles: [] })), api.adminInstalls().catch(() => ({ installs: {} }))])
    .then(([u, e, r, ins]) => { setUsers(u); setEntities(e); setRoles(r.roles || []); setHowlerRoles(r.howlerRoles || []); setInstalls(ins.installs || {}); });
  useEffect(() => { load(); }, []);
  // Open a user's detail; `edit` jumps straight into the edit form.
  const openUser = (u, edit = false) => { setOpenInEdit(edit); setSelectedId(u.id); };
  const removeUser = async (u) => {
    if (!confirm(`Delete ${u.fullName || u.email}? This removes the login for every client and can't be undone.`)) return;
    try { await api.adminDeleteUser(u.id); load(); } catch (e) { alert(e.message); }
  };
  if (!users) return <Muted>Loading…</Muted>;
  if (selectedId) return <UserDetail userId={selectedId} entities={entities} roles={roles} install={installs[selectedId] || null} initialEditing={openInEdit} onBack={() => { setSelectedId(null); setOpenInEdit(false); load(); }} />;
  if (adding) return <AddUserForm entities={entities} roles={roles} howlerRoles={howlerRoles} onCancel={() => setAdding(false)} onCreated={(id) => { setAdding(false); load().then(() => { if (id) setSelectedId(id); }); }} />;

  const entName = Object.fromEntries(entities.map((e) => [e.id, e.name]));
  const clientsOf = (u) => (u.memberships || []).map((m) => entName[m.entityId] || m.entityId);
  const ql = q.trim().toLowerCase();
  const byRole = roleFilter === 'all' ? users : users.filter((u) => (roleFilter === 'admin' ? u.role === 'admin' : u.role !== 'admin'));
  const matched = ql ? byRole.filter((u) => u.email.toLowerCase().includes(ql) || (u.fullName || '').toLowerCase().includes(ql) || (u.mobile || '').includes(ql) || clientsOf(u).some((n) => n.toLowerCase().includes(ql))) : byRole;
  const sorted = [...matched].sort((a, b) => {
    if (sort === 'email') return a.email.localeCompare(b.email, undefined, { sensitivity: 'base' });
    const key = sort === 'login' ? 'lastLogin' : 'lastActiveAt';
    return String(b[key] || '').localeCompare(String(a[key] || '')); // newest first; nulls sink
  });
  const adminCount = users.filter((u) => u.role === 'admin').length;

  const clientsCell = (u) => {
    if (u.role === 'admin' && !(u.memberships || []).length) return <span style={{ color: 'var(--muted)' }}>All (admin)</span>;
    const names = clientsOf(u);
    if (!names.length) return <span style={{ color: 'var(--muted)' }}>—</span>;
    return <span title={names.join(', ')}>{names.length === 1 ? names[0] : `${names.length} clients`}</span>;
  };
  const adminBadge = (u) => u.role === 'admin' && <span style={howlerBadge}>HOWLER</span>;
  // 📱 marker when the user has opened Pulse as an installed app (PWA on their phone).
  const installMark = (u) => { const i = installs[u.id]; return i ? <span title={`📱 App installed · last opened ${fmtWhen(i.lastAt)}`} style={{ fontSize: 13, cursor: 'help' }}>📱</span> : null; };
  const lastActiveCell = (u) => (
    <>
      <span>{relTime(u.lastActiveAt)}</span>
      {u.lastAction && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{u.lastAction.label}</div>}
    </>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <p style={{ ...hint, marginBottom: 0, flex: 1, minWidth: 180 }}>Every login on Pulse — {users.length} user{users.length === 1 ? '' : 's'} ({adminCount} Howler admin{adminCount === 1 ? '' : 's'}). Click a user for their profile, roles and activity.</p>
        <button style={showReport ? { ...miniBtn, background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' } : miniBtnOutline} onClick={() => setShowReport((s) => !s)}>📊 Activity report</button>
        <button style={{ ...miniBtn, background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' }} onClick={() => setAdding(true)}>+ Add user</button>
      </div>
      {showReport && <ActivityReport />}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ ...searchWrap, marginBottom: 0 }}>
          <span style={{ color: 'var(--muted)', fontSize: 13, flexShrink: 0 }}>⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, email, mobile or client…" style={searchInput} />
          {ql && <button onClick={() => setQ('')} style={searchClear} aria-label="Clear search">✕</button>}
        </div>
        <select style={{ ...input, minWidth: 150 }} value={sort} onChange={(e) => setSort(e.target.value)} title="Sort">
          <option value="active">Recently active</option>
          <option value="login">Recent login</option>
          <option value="email">Email (A–Z)</option>
        </select>
        <div style={{ display: 'flex', gap: 4 }}>
          {[['all', `All (${users.length})`], ['admin', `Howler (${adminCount})`], ['client', `Clients (${users.length - adminCount})`]].map(([key, label]) => (
            <button key={key} onClick={() => setRoleFilter(key)} style={roleFilter === key ? { ...miniBtn, background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' } : miniBtnOutline}>{label}</button>
          ))}
        </div>
      </div>

      {isMobile ? (
        <div style={clientList}>
          {sorted.map((u) => (
            <div key={u.id} className="lift" style={{ ...clientRow, gap: 8 }}>
              <div onClick={() => openUser(u)} style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, textAlign: 'left', flex: 1, cursor: 'pointer' }}>
                <span style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.fullName || u.email} {adminBadge(u)} {installMark(u)}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{u.fullName ? `${u.email} · ` : ''}{u.role === 'admin' ? 'Howler admin' : 'Client'} · {clientsOf(u).length || (u.role === 'admin' ? '∞' : 0)} client{clientsOf(u).length === 1 ? '' : 's'}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{u.mobile ? `${u.mobile} · ` : ''}active {relTime(u.lastActiveAt)}</span>
              </div>
              <button style={miniBtnOutline} onClick={() => openUser(u, true)}>Edit</button>
              <button style={delBtn} onClick={() => removeUser(u)}>Del</button>
            </div>
          ))}
          {sorted.length === 0 && <Muted>{ql ? `No users match “${q.trim()}”.` : 'No users in this view.'}</Muted>}
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              {['User', 'Type', 'Clients', 'Inventive workspace', 'Mobile', 'Last active', ''].map((h, i) => <th key={i} style={thS}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {sorted.map((u) => (
              <tr key={u.id} className="lift" style={{ cursor: 'pointer' }} onClick={() => openUser(u)}>
                <td style={td}>
                  <div style={{ fontWeight: 600 }}>{u.fullName || u.email} {adminBadge(u)} {installMark(u)}</div>
                  {u.fullName && <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{u.email}</div>}
                </td>
                <td style={td}>{u.role === 'admin' ? (u.howlerRoleLabel ? `Howler · ${u.howlerRoleLabel}` : 'Howler admin') : 'Client'}</td>
                <td style={td}>{clientsCell(u)}</td>
                <td style={td}>{u.inventiveWorkspaceName || <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                <td style={td}>{u.mobile || <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                <td style={td} title={`Last login ${fmtWhen(u.lastLogin)}`}>{lastActiveCell(u)}</td>
                <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                  <button style={miniBtnOutline} onClick={() => openUser(u, true)}>Edit</button>
                  <button style={{ ...delBtn, marginLeft: 6 }} onClick={() => removeUser(u)}>Delete</button>
                </td>
              </tr>
            ))}
            {sorted.length === 0 && <tr><td style={td} colSpan={7}><Muted>{ql ? `No users match “${q.trim()}”.` : 'No users in this view.'}</Muted></td></tr>}
          </tbody>
        </table>
      )}
    </div>
  );
}

// Platform-wide usage summary: active users + top users / dashboards / features
// over a selectable window. Read-only, lazy-loaded when the panel is opened.
function ActivityReport() {
  const [days, setDays] = useState(30);
  const [rep, setRep] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { setRep(null); setErr(''); api.adminUserActivityReport(days).then(setRep).catch((e) => setErr(e.message || 'Failed to load')); }, [days]);
  const card = { flex: '1 1 200px', minWidth: 180, border: '1px solid var(--hairline)', borderRadius: 12, padding: '12px 14px', background: 'var(--card)' };
  const head = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginBottom: 8 };
  const row = (left, right) => <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13, padding: '4px 0', borderTop: '1px solid var(--hairline)' }}><span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{left}</span><span style={{ flexShrink: 0, fontWeight: 700, color: 'var(--brand)' }}>{right}</span></div>;
  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 14, padding: 16, margin: '4px 0 16px', background: 'rgba(var(--brand-rgb,255,56,92),0.03)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 15, flex: 1 }}>📊 Activity report</span>
        <select style={{ ...input, width: 'auto' }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={1}>Today</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>
      {err ? <Muted>{err}</Muted> : !rep ? <Muted>Loading…</Muted> : (() => {
        const num = { fontSize: 22, fontWeight: 800 };
        const sub = { fontSize: 11, color: 'var(--muted)' };
        const winLabel = rep.days === 1 ? 'today' : `last ${rep.days} days`;
        return (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
            <div style={card}><div style={head} title="An active user opened a dashboard or performed an audited action in the window.">Active users ⓘ</div>
              <div style={{ display: 'flex', gap: 16 }}>
                <div><div style={num}>{rep.active.d1}</div><div style={sub}>today</div></div>
                <div><div style={num}>{rep.active.d7}</div><div style={sub}>7 days</div></div>
                <div><div style={num}>{rep.active.d30}</div><div style={sub}>30 days</div></div>
              </div>
            </div>
            {rep.surfaces && (
              <div style={card}><div style={head} title="Of the active users in this window, how many opened the installed app (PWA) vs only a regular browser.">Active by surface · {winLabel}</div>
                <div style={{ display: 'flex', gap: 16 }}>
                  <div><div style={num}>{rep.surfaces.app}</div><div style={sub}>📱 app</div></div>
                  <div><div style={num}>{rep.surfaces.web}</div><div style={sub}>🖥 web/desktop</div></div>
                </div>
              </div>
            )}
            <div style={card}><div style={head}>Volume · {winLabel}</div>
              <div style={{ display: 'flex', gap: 16 }}>
                <div><div style={num}>{rep.totals.views}</div><div style={sub}>dashboard opens</div></div>
                <div><div style={num}>{rep.totals.actions}</div><div style={sub}>actions</div></div>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <div style={card}><div style={head}>Top users</div>
              {rep.topUsers.length ? rep.topUsers.map((u) => row(<span title={u.name}>{u.name}{u.role === 'admin' ? ' · Howler' : ''}</span>, u.total)) : <Muted>No activity yet.</Muted>}
            </div>
            <div style={card}><div style={head}>Most active dashboards</div>
              {rep.topDashboards.length ? rep.topDashboards.map((d) => row(<span title={d.title}>{d.title}</span>, d.opens)) : <Muted>No opens yet.</Muted>}
            </div>
            <div style={card}><div style={head}>Most used features</div>
              {rep.topFeatures.length ? rep.topFeatures.map((f) => row(<span title={f.label}>{f.label}</span>, f.uses)) : <Muted>No actions yet.</Muted>}
            </div>
          </div>
          {rep.inactiveClients && (
            <div style={{ ...card, marginTop: 10, maxHeight: 320, overflowY: 'auto' }}>
              <div style={head} title="Clients with no login, dashboard open or action in the window — 'Never' means no engagement ever (incl. clients with no logins set up).">😴 Inactive clients · no activity in {winLabel} ({rep.inactiveClients.length})</div>
              {rep.inactiveClients.length === 0 ? <Muted>Every client has been active in this window. 🎉</Muted>
                : rep.inactiveClients.map((c) => row(
                    <span title={c.entityName}>{c.entityName}{c.userCount === 0 ? ' · no logins yet' : ''}</span>,
                    <span style={{ color: c.never ? 'var(--error,#ef4444)' : 'var(--muted)', fontWeight: 600 }}>{c.never ? 'Never' : relTime(c.lastActiveAt)}</span>,
                  ))}
            </div>
          )}
          {rep.inactiveUsers && (
            <div style={{ ...card, marginTop: 10, maxHeight: 320, overflowY: 'auto' }}>
              <div style={head} title="Client logins with no login, dashboard open or action in the window — 'Never' means they've never engaged.">😴 Inactive users · no activity in {winLabel} ({rep.inactiveUsers.length})</div>
              {rep.inactiveUsers.length === 0 ? <Muted>Every client user has been active in this window. 🎉</Muted>
                : rep.inactiveUsers.map((u) => row(
                    <span title={`${u.name} · ${u.email}`}>{u.name}{u.client ? ` · ${u.client}` : ''}</span>,
                    <span style={{ color: u.never ? 'var(--error,#ef4444)' : 'var(--muted)', fontWeight: 600 }}>{u.never ? 'Never' : relTime(u.lastActiveAt)}</span>,
                  ))}
            </div>
          )}
        </>
        );
      })()}
    </div>
  );
}

// Create either a Howler admin (full access) or a client login (scoped to the
// clients you pick). Replaces the old separate "Add admin" / per-client "Add
// login" forms — one entry point for both.
function AddUserForm({ entities, roles, howlerRoles = [], onCancel, onCreated }) {
  const [accountType, setAccountType] = useState('client'); // client | admin
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', mobile: '', password: '' });
  const [entityIds, setEntityIds] = useState([]);
  const [role, setRole] = useState('viewer');
  const [howlerRole, setHowlerRole] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const roleOpts = roles.length ? roles : [{ key: 'owner', label: 'Owner' }];
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const isClient = accountType === 'client';
  const canSubmit = form.email.trim() && form.password && (!isClient || entityIds.length > 0);

  const submit = async () => {
    setError(''); setBusy(true);
    const base = { firstName: form.firstName, lastName: form.lastName, email: form.email.trim(), mobile: form.mobile, password: form.password };
    try {
      const created = isClient
        ? await api.adminCreateUser({ ...base, role: 'client', entityIds: entityIds.map((id) => ({ entityId: id, role })) })
        : await api.adminCreateUser({ ...base, role: 'admin', entityIds, howlerRole });
      onCreated(created?.id);
    } catch (e) {
      // Duplicate email → for an admin, offer to promote the existing login (keeps its access).
      if (/already exists/i.test(e.message || '') && !isClient
        && confirm(`A login with ${base.email} already exists. Convert it to a Howler admin?\n\nIt keeps its current client access, plus any clients ticked here.`)) {
        try { await api.adminPromoteUser({ email: base.email, entityIds }); onCreated(null); return; }
        catch (e2) { setError(e2.message); }
      } else if (/already exists/i.test(e.message || '')) {
        setError('A login with that email already exists — open it from the list to add this client to it.');
      } else setError(e.message);
    } finally { setBusy(false); }
  };

  return (
    <div>
      <AdminBack onBack={onCancel}>All users</AdminBack>
      <h2 style={{ fontSize: 20, fontWeight: 700, margin: '12px 0 4px' }}>Add a user</h2>
      <p style={{ ...hint, marginBottom: 16 }}>Create a Howler admin (full access to every client + the console) or a client login (scoped to the clients you pick).</p>
      <div style={{ ...cardStyle, maxWidth: 560 }}>
        <L>Account type</L>
        <div style={{ display: 'flex', gap: 6, margin: '4px 0 14px' }}>
          {[['client', 'Client login'], ['admin', 'Howler admin']].map(([k, label]) => (
            <button key={k} onClick={() => setAccountType(k)} style={accountType === k ? { ...miniBtn, background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' } : miniBtnOutline}>{label}</button>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
          <Field label="First name"><input style={{ ...input, minWidth: 0 }} value={form.firstName} onChange={set('firstName')} /></Field>
          <Field label="Surname"><input style={{ ...input, minWidth: 0 }} value={form.lastName} onChange={set('lastName')} /></Field>
          <Field label="Email"><input style={{ ...input, minWidth: 0 }} value={form.email} onChange={set('email')} autoComplete="off" /></Field>
          <Field label="Mobile"><input style={{ ...input, minWidth: 0 }} value={form.mobile} onChange={set('mobile')} placeholder="+27…" /></Field>
          <Field label="Temp password"><input style={{ ...input, minWidth: 0 }} type="text" value={form.password} onChange={set('password')} placeholder="they can change it" autoComplete="off" /></Field>
        </div>
        {isClient ? (
          <>
            <L>Clients {entityIds.length === 0 && <span style={{ color: 'var(--error)', fontWeight: 400 }}>· pick at least one</span>}</L>
            <div style={{ marginTop: 4 }}><ClientLinkPicker entities={entities} value={entityIds} onChange={setEntityIds} /></div>
            <div style={{ marginTop: 10 }}>
              <Field label="Role at these clients"><select style={input} value={role} onChange={(e) => setRole(e.target.value)}>{roleOpts.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select></Field>
            </div>
            {roleOpts.find((r) => r.key === role)?.description && <p style={{ ...hint, marginTop: 8 }}>{roleOpts.find((r) => r.key === role).description}</p>}
          </>
        ) : (
          <>
            {howlerRoles.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <Field label="Howler role">
                  <select style={input} value={howlerRole} onChange={(e) => setHowlerRole(e.target.value)}>
                    <option value="">— none —</option>
                    {howlerRoles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                  </select>
                </Field>
                <p style={{ ...hint, marginTop: 6 }}>Their job title at Howler. Shown to clients they own as “Your Howler Support”.</p>
              </div>
            )}
            <L>Also a customer of (optional)</L>
            <div style={{ marginTop: 4 }}><ClientLinkPicker entities={entities} value={entityIds} onChange={setEntityIds} /></div>
            <p style={{ ...hint, marginTop: 8 }}>Howler admins see every client and the console regardless. Ticking clients also gives them that client's customer view.</p>
          </>
        )}
        <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
          <button style={{ ...miniBtn, background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' }} onClick={submit} disabled={!canSubmit || busy}>{busy ? 'Creating…' : 'Create user'}</button>
          <button style={miniBtnOutline} onClick={onCancel}>Cancel</button>
        </div>
        {error && <div style={{ color: 'var(--error)', fontSize: 13, marginTop: 10 }}>{error}</div>}
      </div>
    </div>
  );
}

// One user's detail: identity, client roles, usage profile and activity timeline.
function UserDetail({ userId, entities = [], roles = [], install = null, initialEditing = false, onBack }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [section, setSection] = useState('overview');
  const [editing, setEditing] = useState(!!initialEditing);
  const load = () => api.adminGetUser(userId).then(setData).catch((e) => setErr(e.message || 'Failed to load'));
  useEffect(() => { setData(null); setErr(''); setEditing(!!initialEditing); load(); }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div><AdminBack onBack={onBack}>All users</AdminBack><p style={{ color: 'var(--error)', marginTop: 12 }}>{err}</p></div>;
  if (!data) return <div><AdminBack onBack={onBack}>All users</AdminBack><p style={{ marginTop: 12 }}><Muted>Loading…</Muted></p></div>;

  const { user, memberships, profile, dashboards, activity, usageByClient = [], emails = [] } = data;
  const isAdmin = user.role === 'admin';
  const nav = [
    ['overview', 'Overview'],
    ['roles', `Clients & roles (${memberships.length})`],
    ['usage', 'Usage'],
    ['emails', `Emails (${emails.length})`],
    ['activity', `Activity (${activity.length})`],
  ];
  const mostRecent = activity[0] || null;
  const del = async () => {
    if (!confirm(`Delete ${user.fullName || user.email}? This removes the login for every client.`)) return;
    try { await api.adminDeleteUser(user.id); onBack(); } catch (e) { alert(e.message); }
  };

  if (editing) return <UserEditCard user={user} memberships={memberships} entities={entities} roles={roles} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); setData(null); load(); }} />;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button style={adminBackBtn} onClick={onBack}>
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
          All users
        </button>
        <span style={{ flex: 1 }} />
        <button style={miniBtn} onClick={() => setEditing(true)}>✏️ Edit</button>
        <button style={delBtn} onClick={del}>Delete</button>
      </div>
      <h2 style={{ fontSize: 20, fontWeight: 700, margin: '12px 0 4px', wordBreak: 'break-word' }}>{user.fullName || user.email} {isAdmin && <span style={howlerBadge}>HOWLER</span>}</h2>
      <p style={{ ...hint, marginBottom: 16 }}>{user.fullName ? `${user.email} · ` : ''}{isAdmin ? 'Howler admin — full access to every client.' : `Client login · ${memberships.length} client${memberships.length === 1 ? '' : 's'}`}</p>
      <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <nav style={detailNav}>
          {nav.map(([key, label]) => (
            <button key={key} onClick={() => setSection(key)} style={{ ...detailNavItem, ...(section === key ? detailNavActive : null) }}>{label}</button>
          ))}
        </nav>
        <div style={{ flex: 1, minWidth: 280 }}>
          {section === 'overview' && (
            <div style={cardStyle}>
              <KV label="Name" value={user.fullName || '—'} />
              <KV label="Email" value={user.email} />
              <KV label="Mobile" value={user.mobile || '—'} />
              <KV label="Account type" value={isAdmin ? 'Howler admin' : 'Client login'} />
              <KV label="Member of" value={isAdmin ? 'All clients (admin)' : (memberships.length ? memberships.map((m) => m.entityName).join(', ') : 'No clients linked')} />
              <KV label="Last login" value={fmtWhen(user.lastLogin)} sub={user.lastLogin ? relTime(user.lastLogin) : ''} />
              <KV label="App installed" value={install ? '📱 Yes — on their phone' : 'Not detected'} sub={install ? `last opened ${relTime(install.lastAt)}` : 'never opened as an installed app'} />
              <KV label="Most recent action" value={mostRecent ? mostRecent.label : 'No activity yet'} sub={mostRecent ? `${relTime(mostRecent.at)}${mostRecent.entityName ? ` · ${mostRecent.entityName}` : ''}` : ''} />
              <KV label="Account created" value={fmtWhen(user.createdAt)} />
              <KV label="Notifications" value={`Email ${user.notifyEmail ? 'on' : 'off'} · Push ${user.notifyPush ? 'on' : 'off'}`} />
              <KV label="Inventive workspace" value={user.inventiveWorkspace ? (user.inventiveWorkspace.name || '(unnamed)') : 'Not linked'} sub={user.inventiveWorkspace ? `ref ${user.inventiveWorkspace.refId || '—'}` : 'uses the user’s own ID'} />
            </div>
          )}

          {section === 'roles' && (
            <div>
              {isAdmin && <div style={{ ...cardStyle, marginBottom: 12 }}><b>Howler admin.</b> <span style={{ color: 'var(--muted)' }}>Has full access to every client regardless of the memberships below.</span></div>}
              {memberships.length === 0 ? (
                <Muted>{isAdmin ? 'No explicit client links (admins see everything anyway).' : 'Not linked to any client.'}</Muted>
              ) : memberships.map((m) => (
                <div key={m.entityId} style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                  <span style={{ fontSize: 22, width: 30, textAlign: 'center' }}>{m.entityLogo && m.entityLogo.length <= 4 ? m.entityLogo : '🏢'}</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{m.entityName}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>{m.roleLabel} · {(m.permissions || []).length} permission{(m.permissions || []).length === 1 ? '' : 's'} · {m.lens} lens</div>
                  </div>
                  <span style={{ ...rolePill, marginLeft: 'auto' }}>{m.roleLabel}</span>
                </div>
              ))}
            </div>
          )}

          {section === 'usage' && (
            <div>
              <div style={cardStyle}>
                <h3 style={subhead}>Usage by client <span style={{ fontWeight: 400, color: 'var(--muted)' }}>(last 90 days)</span></h3>
                {usageByClient.length === 0 ? <Muted>No client-attributed dashboard activity yet.</Muted> : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {usageByClient.map((c) => (
                      <div key={c.entityId} style={{ borderLeft: '3px solid var(--brand)', paddingLeft: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 600, fontSize: 14 }}>{c.entityName}</span>
                          <span style={{ color: 'var(--muted)', fontSize: 12 }}>{c.views} view{c.views === 1 ? '' : 's'} · active {relTime(c.lastAt)}</span>
                        </div>
                        <ul style={{ listStyle: 'none', margin: '5px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                          {c.topDashboards.map((d) => (
                            <li key={d.dashboardId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                              <span>📊</span>
                              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
                              <span style={{ color: 'var(--muted)' }}>{d.count}× · {relTime(d.lastAt)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div style={cardStyle}>
                <h3 style={subhead}>Most-used dashboards <span style={{ fontWeight: 400, color: 'var(--muted)' }}>(last 90 days)</span> <span style={{ fontWeight: 400, color: 'var(--muted)' }}>· across all clients</span></h3>
                {(dashboards.used || []).length === 0 ? <Muted>No dashboard activity yet.</Muted> : (
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {dashboards.used.map((d) => (
                      <li key={d.dashboardId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                        <span>📊</span><span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
                        <span style={{ color: 'var(--muted)', fontSize: 12 }}>{d.count}× · {relTime(d.lastAt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div style={cardStyle}>
                <h3 style={subhead}>Dashboards they can access</h3>
                {dashboards.accessibleAll ? <Muted>All dashboards (Howler admin).</Muted>
                  : (dashboards.accessible || []).length === 0 ? <Muted>No dashboards reachable (no client membership or sets).</Muted>
                  : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{dashboards.accessible.map((d) => <span key={d.dashboardId} style={chipNeutral} title={d.suiteName}>{d.title}</span>)}</div>}
              </div>
            </div>
          )}

          {section === 'emails' && (
            <div>
              <p style={hint}>Emails Pulse has sent to <b>{user.email}</b> — digests, campaigns and notifications.</p>
              {emails.length === 0 ? <Muted>No emails sent to this address yet.</Muted> : (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {emails.map((m, i) => (
                    <div key={i} style={{ display: 'flex', gap: 11, alignItems: 'center', padding: '9px 0', borderBottom: i < emails.length - 1 ? '1px solid var(--hairline)' : 'none' }}>
                      <span style={{ fontSize: 16, width: 22, textAlign: 'center', flexShrink: 0 }}>{mailGlyph(m.kind)}</span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.subject || '(no subject)'}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1 }}>{mailKindLabel(m.kind)}{m.entityName ? ` · ${m.entityName}` : ''} · {fmtWhen(m.at)}</div>
                      </div>
                      <span style={{ fontSize: 10.5, fontWeight: 700, borderRadius: 980, padding: '2px 8px', flexShrink: 0, ...mailStatusStyle(m.status) }}>{m.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {section === 'activity' && (
            <div>
              {/* App install — is Pulse on their phone, and when did they last open it as an app? */}
              <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 24, width: 30, textAlign: 'center', flexShrink: 0 }}>{install ? '📱' : '🌐'}</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{install ? 'Pulse installed on their phone' : 'Not installed as an app'}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 }}>
                    {install
                      ? <>Last opened in-app {relTime(install.lastAt)} · first installed {fmtWhen(install.firstAt)}{install.ua ? ` · ${shortDevice(install.ua)}` : ''}</>
                      : 'We haven’t seen this user open Pulse from a home-screen / installed app — they may only use it in a browser tab.'}
                  </div>
                </div>
              </div>
              {activity.length === 0 ? <Muted>No activity recorded yet.</Muted> : (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {activity.map((e, i) => (
                    <div key={i} style={{ display: 'flex', gap: 11, padding: '9px 0', borderBottom: i < activity.length - 1 ? '1px solid var(--hairline)' : 'none' }}>
                      <span style={{ fontSize: 16, width: 22, textAlign: 'center', flexShrink: 0 }}>{actionGlyph(e.action)}</span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13.5 }}>{e.label}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1 }}>
                          {fmtWhen(e.at)}{e.entityName ? ` · ${e.entityName}` : ''}{e.kind === 'view' ? ' · viewed' : ''}
                        </div>
                      </div>
                      <span style={{ fontSize: 11.5, color: 'var(--muted)', flexShrink: 0, whiteSpace: 'nowrap' }}>{relTime(e.at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Edit an existing user's identity, account type and client links. Per-client
// roles stay on each client's Logins tab; this covers everything else in one place.
function UserEditCard({ user, memberships, entities, roles, onCancel, onSaved }) { // eslint-disable-line no-unused-vars
  const [form, setForm] = useState({ firstName: user.firstName || '', lastName: user.lastName || '', email: user.email, mobile: user.mobile || '', password: '', inventiveWorkspaceId: user.inventiveWorkspaceId || '', howlerRole: user.howlerRole || '', roles: user.roles || [] });
  const [accountType, setAccountType] = useState(user.role === 'admin' ? 'admin' : 'client');
  const [entityIds, setEntityIds] = useState((memberships || []).map((m) => m.entityId));
  const [workspaces, setWorkspaces] = useState([]);
  const [howlerRoles, setHowlerRoles] = useState([]);
  useEffect(() => { api.adminListInventiveWorkspaces().then(setWorkspaces).catch(() => {}); api.getRoles().then((r) => setHowlerRoles(r.howlerRoles || [])).catch(() => {}); }, []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const save = async () => {
    setError(''); setBusy(true);
    try {
      const patch = { firstName: form.firstName, lastName: form.lastName, email: form.email.trim(), mobile: form.mobile, role: accountType, entityIds, inventiveWorkspaceId: form.inventiveWorkspaceId, howlerRole: form.howlerRole, roles: form.roles };
      if (form.password) patch.password = form.password; // blank = keep current
      await api.adminUpdateUser(user.id, patch);
      onSaved();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <div>
      <AdminBack onBack={onCancel}>Back</AdminBack>
      <h2 style={{ fontSize: 20, fontWeight: 700, margin: '12px 0 14px', wordBreak: 'break-word' }}>Edit {user.fullName || user.email}</h2>
      <div style={{ ...cardStyle, maxWidth: 560 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
          <Field label="First name"><input style={{ ...input, minWidth: 0 }} value={form.firstName} onChange={set('firstName')} /></Field>
          <Field label="Surname"><input style={{ ...input, minWidth: 0 }} value={form.lastName} onChange={set('lastName')} /></Field>
          <Field label="Email"><input style={{ ...input, minWidth: 0 }} value={form.email} onChange={set('email')} autoComplete="off" /></Field>
          <Field label="Mobile"><input style={{ ...input, minWidth: 0 }} value={form.mobile} onChange={set('mobile')} placeholder="+27…" /></Field>
          <Field label="New password (blank = keep)"><input style={{ ...input, minWidth: 0 }} type="text" value={form.password} onChange={set('password')} autoComplete="off" /></Field>
        </div>
        <L>Account type</L>
        <div style={{ display: 'flex', gap: 6, margin: '4px 0 14px' }}>
          {[['client', 'Client login'], ['admin', 'Howler admin']].map(([k, label]) => (
            <button key={k} onClick={() => setAccountType(k)} style={accountType === k ? { ...miniBtn, background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' } : miniBtnOutline}>{label}</button>
          ))}
        </div>
        {accountType === 'admin' && howlerRoles.length > 0 && (
          <>
            <L>Howler role</L>
            <p style={{ ...hint, marginTop: 2 }}>Their job title at Howler — shown to clients they support as “Your Howler Support”.</p>
            <select style={{ ...input, width: '100%', margin: '4px 0 14px' }} value={form.howlerRole} onChange={set('howlerRole')}>
              <option value="">— none —</option>
              {howlerRoles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </>
        )}
        <L>Designations</L>
        <p style={{ ...hint, marginTop: 2 }}>Extra roles this person holds — a user can have several. <b>Developer</b> makes them assignable to tickets on the product board.</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '4px 0 14px' }}>
          {[['dev', 'Developer']].map(([key, label]) => {
            const on = (form.roles || []).includes(key);
            return (
              <button key={key} onClick={() => setForm({ ...form, roles: on ? form.roles.filter((r) => r !== key) : [...(form.roles || []), key] })}
                style={on ? { ...miniBtn, background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' } : miniBtnOutline}>
                {on ? '✓ ' : ''}{label}
              </button>
            );
          })}
        </div>
        <L>{accountType === 'admin' ? 'Also a customer of (optional)' : 'Clients'}</L>
        <div style={{ marginTop: 4 }}><ClientLinkPicker entities={entities} value={entityIds} onChange={setEntityIds} /></div>
        <p style={{ ...hint, marginTop: 8 }}>Per-client roles are set on each client's <b>Logins</b> tab; newly-linked clients default to Owner.</p>
        <L>Inventive workspace</L>
        <p style={{ ...hint, marginTop: 2 }}>Link this user to a workspace (create them in Admin → Integrations → <b>Inventive workspaces</b>). Unlinked → falls back to the user’s own ID.</p>
        <select style={{ ...input, width: '100%', margin: '4px 0 14px' }} value={form.inventiveWorkspaceId} onChange={set('inventiveWorkspaceId')}>
          <option value="">— None (use the user’s own ID) —</option>
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name || '(unnamed)'}{w.refId ? ` · ${w.refId}` : ''}</option>)}
        </select>
        <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
          <button style={{ ...miniBtn, background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' }} onClick={save} disabled={!form.email.trim() || busy}>{busy ? 'Saving…' : 'Save changes'}</button>
          <button style={miniBtnOutline} onClick={onCancel}>Cancel</button>
        </div>
        {error && <div style={{ color: 'var(--error)', fontSize: 13, marginTop: 10 }}>{error}</div>}
      </div>
    </div>
  );
}

// A label/value row for the user overview card.
function KV({ label, value, sub }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--hairline)' }}>
      <span style={{ width: 150, flexShrink: 0, color: 'var(--muted)', fontSize: 12.5 }}>{label}</span>
      <span style={{ fontSize: 13.5, minWidth: 0, wordBreak: 'break-word' }}>{value}{sub ? <span style={{ color: 'var(--muted)', fontSize: 12 }}> · {sub}</span> : null}</span>
    </div>
  );
}

// One client's settings hub: a left nav (Settings / Suites / Logins) + panel.
// ─── Account-manager setup checklist — the full lifecycle of standing a client up ──
// Auto-detects what's done from real data, lets the AM tick the manual ones, and
// jumps straight to the right tab for each task. Manual ticks persist per client
// (reusing the setup-wizard progress store, prefixed amchk_). Split into the
// client-wide ACCOUNT SETUP (done once) and the PER-EVENT work (repeated for each
// suite the client runs — goals, briefing, audiences, abandoned-cart campaigns).
// Per-client reminder config — who gets nudged about outstanding setup, managed
// right here in the onboarding section. Account team = factual; clients = value-led
// (opt-in). Blank recipient lists fall back to sensible defaults server-side.
function SetupNudgeConfig({ entity, clientUsers = [], adminUsers = [] }) {
  const [cfg, setCfg] = useState(null);
  const [saved, setSaved] = useState(false);
  const [testMsg, setTestMsg] = useState('');
  useEffect(() => { api.getSetupNudge(entity.id).then(setCfg).catch(() => setCfg(null)); }, [entity.id]);
  if (!cfg) return <div style={cardStyle}><Muted>Loading…</Muted></div>;
  const has = (key, id) => (cfg[key] || []).includes(id);
  const toggleId = (key, id) => setCfg((c) => ({ ...c, [key]: has(key, id) ? c[key].filter((x) => x !== id) : [...(c[key] || []), id] }));
  const cad = cfg.cadence || {};
  const setCad = (k, v) => setCfg((c) => ({ ...c, cadence: { ...(c.cadence || {}), [k]: v } }));
  const save = async () => { try { await api.saveSetupNudge(entity.id, { clientOn: cfg.clientOn, clientRecipients: cfg.clientRecipients || [], adminRecipients: cfg.adminRecipients || [], graceOverride: cad.graceOverride ?? '', repeatOverride: cad.repeatOverride ?? '' }); flash(setSaved); } catch (e) { alert(e.message); } };
  const test = async (audience) => { setTestMsg('Sending…'); try { const r = await api.testSetupNudge(entity.id, audience); setTestMsg(`✓ Sent · ${r.missing} outstanding`); } catch { setTestMsg('✗ Send failed'); } };
  const chip = (key, u) => { const on = has(key, u.id); return <button key={u.id} type="button" onClick={() => toggleId(key, u.id)} style={{ ...folderChip, borderColor: on ? 'var(--brand)' : 'var(--border)', color: on ? 'var(--brand)' : 'var(--text)', fontWeight: on ? 700 : 400 }}>{on ? '✓ ' : ''}{u.fullName || u.email}</button>; };
  const sub = { fontWeight: 400, textTransform: 'none', color: 'var(--muted)' };
  return (
    <div style={cardStyle}>
      <p style={{ ...hint, marginTop: 0 }}>A reminder while setup is outstanding (after a grace period, then on a repeat cadence — set below or globally). The account team gets a factual summary bulked across their clients; clients get a value-led nudge in-app and by email.</p>
      <L>Account team <span style={sub}>· who at Howler gets the summary · blank = the client’s owner/support</span></L>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '6px 0 14px' }}>{adminUsers.length ? adminUsers.map((u) => chip('adminRecipients', u)) : <Muted>No admins.</Muted>}</div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: cfg.clientOn ? 8 : 0, cursor: 'pointer' }}>
        <input type="checkbox" checked={!!cfg.clientOn} onChange={(e) => setCfg({ ...cfg, clientOn: e.target.checked })} />
        <span style={{ fontWeight: 700, fontSize: 13.5 }}>Also nudge the client’s users to finish</span>
      </label>
      {cfg.clientOn && (
        <div style={{ marginBottom: 8 }}>
          <p style={{ ...hint, margin: '0 0 6px' }}>Delivered on both surfaces: an in-app message in the client’s Pulse inbox <b>and</b> an email to the recipients below.</p>
          <L>Client recipients <span style={sub}>· blank = all the client’s users</span></L>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>{clientUsers.length ? clientUsers.map((u) => chip('clientRecipients', u)) : <Muted>No client logins yet.</Muted>}</div>
        </div>
      )}
      <div style={{ marginTop: 14 }}>
        <L>Timing for this client <span style={sub}>· blank = use the global default</span></L>
        <div style={{ display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>Grace (days)</span>
            <input type="number" min="0" value={cad.graceOverride ?? ''} placeholder={cad.globalGrace != null ? String(cad.globalGrace) : ''} onChange={(e) => setCad('graceOverride', e.target.value)} style={{ ...input, minWidth: 0, width: 120 }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>Repeat (days)</span>
            <input type="number" min="0" value={cad.repeatOverride ?? ''} placeholder={cad.globalRepeat != null ? String(cad.globalRepeat) : ''} onChange={(e) => setCad('repeatOverride', e.target.value)} style={{ ...input, minWidth: 0, width: 120 }} />
          </label>
        </div>
        <p style={{ ...hint, margin: '6px 0 0' }}>Edit the wording + global defaults in Admin → 📋 Onboarding → Reminder defaults.</p>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <button style={saveBtn} onClick={save}>Save</button>
        {saved && <span style={{ color: 'var(--brand)', fontSize: 13, fontWeight: 600 }}>✓ Saved</span>}
        <span style={{ flex: 1 }} />
        <button style={miniBtnOutline} onClick={() => test('admin')}>Send me a test</button>
        {cfg.clientOn && <button style={miniBtnOutline} onClick={() => test('client')}>Test client nudge</button>}
        {testMsg && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{testMsg}</span>}
      </div>
      {cfg.settings && !cfg.settings.enabled && <div style={{ fontSize: 12, color: 'var(--error)', marginTop: 8 }}>⚠ Setup nudges are globally turned off.</div>}
    </div>
  );
}

// Account-level tasks — the client-wide foundation, set once.
const AM_TASKS = [
  { key: 'client', icon: '🏢', title: 'Set up the client', desc: 'Name, logo and AI context.', section: 'settings', auto: (d) => !!(d.entity.name || '').trim() },
  { key: 'scope', icon: '🔒', title: 'Lock their data scope', desc: 'Pick the organiser so they only ever see their own data.', section: 'settings', auto: (d) => d.entity.allOrganisers || Object.values(d.entity.lockedFilters || {}).some((v) => String(v || '').trim()) },
  { key: 'branding', icon: '🎨', title: 'Add branding', desc: 'Logo, colours and sender — white-labels the app and emails.', section: 'email', auto: (d) => d.brandingSet },
  { key: 'emailtmpl', icon: '✉️', title: 'Email template added', desc: 'Set the email header, intro and footer wording.', section: 'email', auto: (d) => d.emailTemplateSet },
  { key: 'logins', icon: '🔑', title: 'Create logins & roles', desc: 'Add the people who sign in and set each one’s role.', section: 'logins', auto: (d) => d.users.length > 0 },
  { key: 'inventive', icon: '✨', title: 'Assign Inventive', desc: 'Link the client’s Inventive analyst workspace.', section: 'integrations', auto: (d) => !!(d.entity.inventiveRefId || d.entity.inventiveName) },
  { key: 'integrations', icon: '🔌', title: 'Add integrations', desc: 'Connect Looker / Meta / TikTok / email as needed.', section: 'integrations' },
  { key: 'digest', icon: '🗓', title: 'Create a digest', desc: 'Schedule a recurring briefing email to their team.', section: 'digests', auto: (d) => d.digests > 0 },
  { key: 'briefing', icon: '📝', title: 'Tune the briefing', desc: 'Global briefing focus, phase defaults and instructions for the Owl.', section: 'briefing' },
];
// Per-event tasks — repeated for EACH event (suite). `auto` reads the suite's own
// data; the rest are manual ticks scoped to that suite.
const EVENT_TASKS = [
  { key: 'goals', icon: '⭐', title: 'Set event goals', desc: 'A live target for this event — opens the client view to add one.', section: 'suites', live: '/goals', auto: (sd) => sd.goals > 0 },
  { key: 'alerts', icon: '🔔', title: 'Set up alerts', desc: 'Metric watchers for this event — opens the client view to add one.', section: 'suites', live: '/alerts', auto: (sd) => sd.alerts > 0 },
  { key: 'branding', icon: '🎨', title: 'Custom event branding', desc: 'Override the look for this event — logo, colours, sender.', section: 'suites', auto: (sd) => sd.brandingSet },
  { key: 'emailtmpl', icon: '✉️', title: 'Email template added', desc: 'Tailor this event’s email header, intro and footer.', section: 'suites', auto: (sd) => sd.templateSet },
  { key: 'briefing', icon: '📝', title: 'Tune the briefing', desc: 'Key dates, phase and instructions so the Owl reads this event right.', section: 'briefing' },
  { key: 'digest', icon: '🗓', title: 'Schedule an event digest', desc: 'A recurring briefing email focused on this event.', section: 'digests' },
  { key: 'segment', icon: '🎯', title: 'Build the audience', desc: 'e.g. everyone who abandoned a cart for this event.', section: 'segments' },
  { key: 'cart', icon: '🛒', title: 'Abandoned-cart campaign', desc: 'Win back checkouts that didn’t finish for this event.', section: 'campaigns' },
];
function ClientSetupChecklist({ entity, suites, users, allUsers = [], go, preview }) {
  const [aux, setAux] = useState(null);
  const [open, setOpen] = useState({}); // section key → expanded? (collapsed by default)
  const toggle = (k) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  useEffect(() => {
    let alive = true;
    const tmplOf = (m) => (m && (m.template || m.branding)) || {};
    const hasBranding = (t) => !!(t.logo || t.brandColor || t.senderName || t.secondaryColor);
    const hasTemplate = (t) => !!(t.header || t.intro || t.footer);
    Promise.all([
      api.getEntityMailTemplate(entity.id).catch(() => null),
      api.getDigests(entity.id).catch(() => []),
      api.getSetupWizardProgress(entity.id).catch(() => ({ ticks: {} })),
      Promise.all(suites.map((su) => api.suiteGoals(su.id).then((r) => (Array.isArray(r) ? r : r.goals || [])).catch(() => []))),
      Promise.all(suites.map((su) => api.getSuiteMailTemplate(su.id).catch(() => null))),
      Promise.all(suites.map((su) => api.suiteAlerts(su.id).then((r) => (Array.isArray(r) ? r : r.alerts || [])).catch(() => []))),
    ]).then(([mt, digests, prog, goalsArr, suiteMtArr, alertsArr]) => {
      if (!alive) return;
      const acc = tmplOf(mt);
      setAux({
        brandingSet: hasBranding(acc) || !!entity.logo,
        emailTemplateSet: hasTemplate(acc),
        digests: (digests || []).length,
        goalsBySuite: Object.fromEntries(suites.map((su, i) => [su.id, (goalsArr[i] || []).length])),
        brandingBySuite: Object.fromEntries(suites.map((su, i) => [su.id, hasBranding(tmplOf(suiteMtArr[i]))])),
        templateBySuite: Object.fromEntries(suites.map((su, i) => [su.id, hasTemplate(tmplOf(suiteMtArr[i]))])),
        alertsBySuite: Object.fromEntries(suites.map((su, i) => [su.id, (alertsArr[i] || []).length])),
        ticks: prog.ticks || {},
      });
    });
    return () => { alive = false; };
  }, [entity.id, suites.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const ticks = aux?.ticks || {};
  const setTick = (key, v) => {
    setAux((a) => ({ ...a, ticks: { ...(a?.ticks || {}), [key]: v ? 1 : 0 } }));
    api.setSetupWizardProgress(entity.id, key, v).then((r) => setAux((a) => ({ ...a, ticks: r.ticks || a.ticks }))).catch(() => {});
  };
  const accData = { entity, suites, users, brandingSet: aux?.brandingSet, emailTemplateSet: aux?.emailTemplateSet, digests: aux?.digests || 0 };
  const accAuto = (t) => !!(t.auto && t.auto(accData));
  const accManual = (t) => ticks['amchk_' + t.key] === 1;
  const accDone = (t) => accAuto(t) || accManual(t);
  const evData = (su) => ({ goals: aux?.goalsBySuite?.[su.id] || 0, brandingSet: aux?.brandingBySuite?.[su.id], templateSet: aux?.templateBySuite?.[su.id], alerts: aux?.alertsBySuite?.[su.id] || 0 });
  const evAuto = (su, t) => !!(t.auto && t.auto(evData(su)));
  const evManual = (su, t) => ticks[`amchk_${su.id}_${t.key}`] === 1;
  const evDone = (su, t) => evAuto(su, t) || evManual(su, t);

  const accDoneCount = AM_TASKS.filter(accDone).length;
  const evDoneCount = suites.reduce((n, su) => n + EVENT_TASKS.filter((t) => evDone(su, t)).length, 0);
  const total = AM_TASKS.length + suites.length * EVENT_TASKS.length;
  const doneCount = accDoneCount + evDoneCount;
  const pct = total ? Math.round((doneCount / total) * 100) : 0;

  const taskRow = (key, icon, title, desc, ok, onGo, onTick) => (
    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: '11px 13px', opacity: ok ? 0.72 : 1 }}>
      <span style={{ fontSize: 19, width: 24, textAlign: 'center', flexShrink: 0 }}>{ok ? '✅' : icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, textDecoration: ok ? 'line-through' : 'none' }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.4 }}>{desc}</div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <button style={miniBtn} onClick={onGo}>Go →</button>
        {onTick && <button style={{ ...chkTick, ...(ok ? { color: 'var(--brand)', borderColor: 'var(--brand)' } : null) }} onClick={onTick} title={ok ? 'Mark not done' : 'Mark done'}>✓</button>}
      </div>
    </div>
  );
  // Collapsible section header bar. `big` = an event (suite) heading. Turns brand
  // red once every task in the section is done.
  const bar = (k, title, caption, n, m, big) => {
    const complete = m > 0 && n === m;
    return (
      <button onClick={() => toggle(k)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', background: complete ? 'rgba(var(--brand-rgb),0.09)' : 'var(--card)', border: complete ? '1.5px solid var(--brand)' : '1px solid var(--hairline)', borderRadius: 12, padding: '12px 14px', cursor: 'pointer', color: 'var(--text)' }}>
        <span style={{ fontSize: 11, color: complete ? 'var(--brand)' : 'var(--muted)', flexShrink: 0, transform: open[k] ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: big ? 14.5 : 12, fontWeight: 800, textTransform: big ? 'none' : 'uppercase', letterSpacing: big ? 0 : '0.05em', color: complete ? 'var(--brand)' : 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
          {caption && !open[k] && <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{caption}</span>}
        </span>
        <span style={{ fontSize: 12, fontWeight: 800, color: complete ? 'var(--brand)' : 'var(--muted)', flexShrink: 0 }}>{complete ? `✓ ${n}/${m}` : `${n}/${m}`}</span>
      </button>
    );
  };

  return (
    <div>
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 16, fontWeight: 800 }}>Setting up {entity.name}</span>
          <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>{doneCount} of {total} done{aux ? '' : ' · checking…'}</span>
          <span style={{ flex: 1 }} />
          {preview && <button style={previewBtn} onClick={() => preview('/')} title="Open this client's account as they see it">👁 Preview account</button>}
        </div>
        <div style={{ height: 8, borderRadius: 999, background: 'rgba(128,128,128,0.15)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: 'var(--brand)', borderRadius: 999, transition: 'width .3s' }} />
        </div>
        <p style={{ ...hint, marginTop: 10, marginBottom: 0 }}>Tap a section to expand it. Tasks auto-tick as you go; tick the manual ones, or hit <b>Go →</b> to jump straight to it. Account setup is done once; the event tasks repeat for every event.</p>
      </div>

      {/* Reminders — who gets nudged about outstanding setup */}
      <div style={{ marginTop: 14 }}>
        <button onClick={() => toggle('reminders')} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: '12px 14px', cursor: 'pointer', color: 'var(--text)' }}>
          <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0, transform: open.reminders ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' }}>🔔 Reminders</span>
            {!open.reminders && <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>Who gets nudged about outstanding setup.</span>}
          </span>
        </button>
        {open.reminders && <div style={{ marginTop: 8 }}><SetupNudgeConfig entity={entity} clientUsers={users} adminUsers={(allUsers || []).filter((u) => u.role === 'admin')} /></div>}
      </div>

      {/* Account setup — collapsible */}
      <div style={{ marginTop: 14 }}>
        {bar('account', 'Account setup', 'The client-wide foundation — set once.', accDoneCount, AM_TASKS.length, false)}
        {open.account && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {AM_TASKS.map((t) => taskRow(t.key, t.icon, t.title, t.desc, accDone(t), () => go(t.section), accAuto(t) ? null : () => setTick('amchk_' + t.key, !accManual(t))))}
          </div>
        )}
      </div>

      {/* Per event — one collapsible block per suite */}
      <div style={{ margin: '18px 2px 8px' }}>
        <div style={{ fontSize: 11.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text)' }}>Per event <span style={{ color: 'var(--muted)' }}>{evDoneCount}/{suites.length * EVENT_TASKS.length}</span></div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>Repeat for each event (suite) the client runs.</div>
      </div>
      {suites.length === 0 ? (
        <div style={{ ...cardStyle, marginBottom: 0, textAlign: 'center' }}>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 10px' }}>No events yet. Create the client’s first event (suite) to start its checklist.</p>
          <button style={addBtn} onClick={() => go('suites')}>+ Create the first event</button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {suites.map((su) => {
            const sDone = EVENT_TASKS.filter((t) => evDone(su, t)).length;
            const title = `${su.icon && !String(su.icon).startsWith('data:') ? `${su.icon} ` : '🗂️ '}${su.name}`;
            return (
              <div key={su.id}>
                {bar(su.id, title, null, sDone, EVENT_TASKS.length, true)}
                {open[su.id] && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                    {EVENT_TASKS.map((t) => taskRow(`${su.id}_${t.key}`, t.icon, t.title, t.desc, evDone(su, t), t.live && preview ? () => preview(t.live) : () => go(t.section), evAuto(su, t) ? null : () => setTick(`amchk_${su.id}_${t.key}`, !evManual(su, t))))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
const chkTick = { padding: '6px 10px', borderRadius: 8, border: '1.5px solid var(--hairline)', background: 'var(--card)', color: 'var(--muted)', fontSize: 13, fontWeight: 700, cursor: 'pointer' };

function ClientDetail({ entity, fields, allEntities, allSets, dashTitle, suites, users, allUsers, onChange, onBack }) {
  const [section, setSection] = useState('checklist');
  const navigate = useNavigate();
  const { setProfile } = useProfile();
  const { user: authUser } = useAuth();
  const showFanOwl = fanOwlSettingsEnabled(authUser); // dogfood gate — server enforces the same list
  // Switch the detail panel AND scroll to the top, so a "Go →" jump is obvious.
  const goSection = (s) => { setSection(s); try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch { /* ignore */ } };
  // Enter THIS client's live experience (scoped to them), landing on `path` — used
  // by the "Preview account" button and the goals/alerts tasks, which are set up
  // inside the client experience, not the admin panels.
  const previewAccount = (path = '/') => { setProfile(entity.id, { name: entity.name, logo: entity.logo }); navigate(path); };
  const nav = [['checklist', '✅ Setup checklist'], ['settings', 'Settings'], ['suites', `Suites (${suites.length})`], ['sets', 'Custom sets'], ['briefing', 'Briefing'], ['messages', 'Messages'], ['digests', 'Digests'], ['campaigns', 'Campaigns'], ['segments', 'Segments'], ['eventops', 'Event Ops'], ...(showFanOwl ? [['fanowl', '🦉 Fan Owl']] : []), ['fees', 'Fees'], ['settlements', 'Settlements'], ['logins', `Logins (${users.length})`], ['integrations', 'Integrations'], ['email', 'Branding']];
  return (
    <div>
      <AdminBack onBack={onBack}>All clients</AdminBack>
      <h2 style={{ fontSize: 20, fontWeight: 700, margin: '12px 0 16px' }}>{entity.name}</h2>
      <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <nav style={detailNav}>
          {nav.map(([key, label]) => (
            <button key={key} onClick={() => setSection(key)} style={{ ...detailNavItem, ...(section === key ? detailNavActive : null) }}>{label}</button>
          ))}
        </nav>
        <div style={{ flex: 1, minWidth: 280 }}>
          {section === 'checklist' && <ClientSetupChecklist entity={entity} suites={suites} users={users} allUsers={allUsers} go={goSection} preview={previewAccount} />}
          {section === 'settings' && <ClientSettings entity={entity} suites={suites} fields={fields} onChange={onChange} onBack={onBack} />}
          {section === 'fanowl' && showFanOwl && <div style={cardStyle}><FanOwlAdmin scope="admin-client" entityId={entity.id} /></div>}
          {section === 'suites' && <ClientSuites entity={entity} suites={suites} allEntities={allEntities} allSets={allSets} dashTitle={dashTitle} fields={fields} onChange={onChange} />}
          {section === 'sets' && <CustomSets entity={entity} />}
          {section === 'briefing' && (
            <>
              <div style={cardStyle}>
                <p style={hint}>
                  Per-event briefing setup for this client: key dates (the phase follows them automatically), a manual phase override,
                  event instructions, and per-phase wording. Global phase defaults live under <b>AI → Home briefing</b>;
                  each reader's personal focus text is theirs (set via ⚙ Tune on their home page).
                </p>
                <BriefingConfigForm entityId={entity.id} showTune={false} />
              </div>
              <BriefingFeedback entityId={entity.id} />
            </>
          )}
          {section === 'messages' && <ClientMessages entity={entity} />}
          {section === 'fees' && (
            <div>
              <p style={hint}>Per-message campaign fees for <b>{entity.name}</b>. Leave a channel blank to inherit the platform master rate (set under the top-level <b>Billing</b> tab).</p>
              <RateCard scope="admin-client" entityId={entity.id} />
            </div>
          )}
          {section === 'campaigns' && (
            <div>
              <p style={hint}>Turn data into action for <b>{entity.name}</b> — e.g. email customers who abandoned checkout. Preview the audience and copy, then explicitly approve the send.</p>
              <CampaignManager entityId={entity.id} scope="admin" />
            </div>
          )}
          {section === 'segments' && (
            <div>
              <p style={hint}>Reusable, always-live audiences for <b>{entity.name}</b> — built from their data and used by campaigns. Clients can also manage these themselves.</p>
              <SegmentManager entityId={entity.id} scope="admin" />
            </div>
          )}
          {section === 'eventops' && (
            <div>
              <p style={hint}>Event Ops pilot for <b>{entity.name}</b> — track devices &amp; stations live at an event. Switch it on per client; they can then run it themselves too.</p>
              <EventOpsAdmin entityId={entity.id} />
            </div>
          )}
          {section === 'digests' && (
            <div>
              <p style={hint}>Scheduled, role-personalised briefing emails for <b>{entity.name}</b>. Clients can also manage these themselves.</p>
              <DigestManager entityId={entity.id} scope="admin" logins={users} />
            </div>
          )}
          {section === 'settlements' && <Settlements entityId={entity.id} />}
          {section === 'logins' && <EntityLogins entity={entity} users={users} allUsers={allUsers} onChange={onChange} />}
          {section === 'integrations' && <ClientIntegrations entity={entity} />}
          {section === 'email' && (
            <div>
              <p style={hint}>This client's branding — the primary/secondary colours and logo here white-label their whole platform (UI accents + charts) and their emails. Anything left blank inherits the Howler default.</p>
              <MailTemplateEditor scope="admin-client" entityId={entity.id} canTest />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Account menu for the admin console, pinned at the bottom of the left nav rail
// (mirrors the client sidebar's bottom-left profile). Holds the theme toggle and
// Log out; the top bar drops these on the console so they live in one place.
function AdminProfileFooter() {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative', marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--hairline)' }}>
      {open && <div style={{ position: 'fixed', inset: 0, zIndex: 70 }} onClick={() => setOpen(false)} />}
      {open && (
        <div className="modal-in" style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 71, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 10px 36px -8px rgba(0,0,0,0.25)', padding: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <button className="nav-row" style={adminMenuItem} onClick={toggle}>
            <span style={{ width: 18, textAlign: 'center' }}>{theme === 'dark' ? '☀️' : '🌙'}</span> {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
          <button className="nav-row" style={{ ...adminMenuItem, color: 'var(--error)' }} onClick={() => logout()}>
            <span style={{ width: 18, textAlign: 'center' }}>↪</span> Log out
          </button>
        </div>
      )}
      <button className="nav-row" style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', border: 'none', background: 'transparent', cursor: 'pointer', padding: '8px', borderRadius: 10, color: 'var(--text)' }} onClick={() => setOpen((v) => !v)} title="Account">
        <span style={{ flexShrink: 0, width: 30, height: 30, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 800, color: '#fff', background: 'linear-gradient(135deg, var(--brand) 0%, var(--brand-2) 45%, #7C3AED 100%)' }}>H</span>
        <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
          <span style={{ display: 'block', fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Howler · Admin</span>
          <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.email}</span>
        </span>
        <span style={{ color: 'var(--muted)', fontSize: 14, flexShrink: 0 }}>⋯</span>
      </button>
      <VersionStamp />
    </div>
  );
}
const adminMenuItem = { display: 'flex', alignItems: 'center', gap: 9, width: '100%', border: 'none', background: 'transparent', cursor: 'pointer', padding: '9px 10px', borderRadius: 8, fontSize: 13, fontWeight: 600, color: 'var(--text)', textAlign: 'left' };

// Reporting currency (admin-only). How Pulse shows money and the Owl writes
// amounts across insights, briefings, goals, alerts and digests. Stored in the
// client's branding blob (so it resolves + rides to the app like the rest of the
// brand); edited here, NOT in the client's own self-service. Autosaves on change
// and re-themes the shell live. Blank = the platform default (ZAR).
function CurrencyField({ entityId }) {
  const [cur, setCur] = useState(null);   // explicit code, or '' = inherit default
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let alive = true;
    api.getEntityMailTemplate(entityId).then((d) => { if (alive) setCur(d.branding?.currency || ''); }).catch(() => { if (alive) setCur(''); });
    return () => { alive = false; };
  }, [entityId]);
  if (cur === null) return null;
  const onPick = async (v) => {
    setCur(v);
    try { await api.saveEntityMailTemplate(entityId, { currency: v }); flash(setSaved); window.dispatchEvent(new CustomEvent('pulse-branding-saved', { detail: { entityId } })); }
    catch (e) { alert('Save failed: ' + e.message); }
  };
  return (
    <div data-tour="client-currency" style={{ marginTop: 12 }}>
      <L>Reporting currency</L>
      <div style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 6px' }}>How Pulse shows money and the Owl writes amounts — across insights, briefings, goals, alerts and digests. Dashboard tile values keep the format from their data source.</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <select value={cur} onChange={(e) => onPick(e.target.value)} style={{ ...input, maxWidth: 340, cursor: 'pointer' }}>
          <option value="">Platform default (ZAR)</option>
          {currencyList().map((c) => <option key={c.code} value={c.code}>{`${c.code} — ${c.name} (${c.symbol})`}</option>)}
        </select>
        {saved && <span style={{ color: 'var(--success,#10b981)', fontSize: 12.5, fontWeight: 600 }}>✓ Saved</span>}
      </div>
    </div>
  );
}

// AI content language (admin-only). The language Pulse's AI WRITES generated copy
// in — briefings, digests, per-tile insights, goal reads, alert notes and campaign
// copy, plus the Owl. It steers AI prose only; it does NOT translate the app's own
// buttons/labels (that's a separate, larger i18n job). Stored in the client's
// branding blob (so it resolves + inherits like the rest of the brand); autosaves.
// Blank = the platform default (English).
function LanguageField({ entityId }) {
  const [lang, setLang] = useState(null);   // explicit code, or '' = inherit default (English)
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let alive = true;
    api.getEntityMailTemplate(entityId).then((d) => { if (alive) setLang(d.branding?.aiLanguage || ''); }).catch(() => { if (alive) setLang(''); });
    return () => { alive = false; };
  }, [entityId]);
  if (lang === null) return null;
  const onPick = async (v) => {
    setLang(v);
    try { await api.saveEntityMailTemplate(entityId, { aiLanguage: v }); flash(setSaved); }
    catch (e) { alert('Save failed: ' + e.message); }
  };
  return (
    <div data-tour="client-language" style={{ marginTop: 12 }}>
      <L>AI copy language</L>
      <div style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 6px' }}>The language the AI writes in — briefings, digests, insights, goal &amp; alert reads, campaign copy and the Owl. Steers AI-written wording only; the app's own buttons and labels stay in English (full UI translation is separate).</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <select value={lang} onChange={(e) => onPick(e.target.value)} style={{ ...input, maxWidth: 340, cursor: 'pointer' }}>
          <option value="">Platform default (English)</option>
          {languageList().filter((l) => l.code !== 'en').map((l) => <option key={l.code} value={l.code}>{l.native === l.name ? l.name : `${l.name} — ${l.native}`}</option>)}
        </select>
        {saved && <span style={{ color: 'var(--success,#10b981)', fontSize: 12.5, fontWeight: 600 }}>✓ Saved</span>}
      </div>
    </div>
  );
}

// White-label vanity login (admin-only). A per-client URL slug → a sign-in page
// at /<slug> painted with their brand. The slug lives in its own table
// (server/vanity.js); validation (format / reserved / uniqueness) is server-side.
function SlugField({ entityId }) {
  const [slug, setSlug] = useState(null);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { let alive = true; api.getClientSlug(entityId).then((d) => { if (alive) setSlug(d.slug || ''); }).catch(() => { if (alive) setSlug(''); }); return () => { alive = false; }; }, [entityId]);
  if (slug === null) return null;
  const save = async () => {
    setErr('');
    try { const d = await api.saveClientSlug(entityId, slug); setSlug(d.slug); flash(setSaved); }
    catch (e) { setErr(e.message || 'Could not save'); }
  };
  return (
    <div data-tour="client-slug" style={{ marginTop: 12 }}>
      <L>Vanity login URL</L>
      <div style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 6px' }}>Gives this client a white-labelled sign-in page at the address below — their logo, colours and background image. Leave blank for the standard login. Set by Howler.</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>{window.location.host}/</span>
        <input value={slug} onChange={(e) => setSlug(e.target.value)} onBlur={save} placeholder="e.g. kunye" style={{ ...input, maxWidth: 220 }} />
        {saved && <span style={{ color: 'var(--success,#10b981)', fontSize: 12.5, fontWeight: 600 }}>✓ Saved</span>}
        {slug && <a href={`${window.location.origin}/${slug}`} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, color: 'var(--brand)', fontWeight: 600 }}>↗ Open</a>}
      </div>
      {err && <div style={{ color: 'var(--error)', fontSize: 12.5, marginTop: 5 }}>{err}</div>}
    </div>
  );
}

// Login background image for the vanity page — stored in the branding blob and
// served (with the logo + colours) by the public /api/branding/:slug endpoint.
function LoginBackgroundField({ entityId }) {
  const [bg, setBg] = useState(null);
  const [saved, setSaved] = useState(false);
  const fileRef = useRef(null);
  useEffect(() => { let alive = true; api.getEntityMailTemplate(entityId).then((d) => { if (alive) setBg(d.branding?.loginBackground || ''); }).catch(() => { if (alive) setBg(''); }); return () => { alive = false; }; }, [entityId]);
  if (bg === null) return null;
  const persist = async (v) => { setBg(v); try { await api.saveEntityMailTemplate(entityId, { loginBackground: v }); flash(setSaved); } catch (e) { alert('Save failed: ' + e.message); } };
  const onFile = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { const img = new Image(); img.onload = () => {
      const max = 1600, scale = Math.min(1, max / img.width);
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      persist(c.toDataURL('image/jpeg', 0.82));
    }; img.src = reader.result; };
    reader.readAsDataURL(f); e.target.value = '';
  };
  return (
    <div data-tour="client-loginbg" style={{ marginTop: 12 }}>
      <L>Login background image</L>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
        <div style={{ width: 160, height: 90, borderRadius: 8, border: '1px solid var(--hairline)', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 11, background: bg ? `center/cover no-repeat url(${JSON.stringify(bg)})` : 'var(--elevated)' }}>{!bg && 'No image'}</div>
        <button style={miniBtn} onClick={() => fileRef.current?.click()}>Upload image</button>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onFile} />
        {bg && <button style={delBtn} onClick={() => persist('')}>Remove</button>}
        {saved && <span style={{ color: 'var(--success,#10b981)', fontSize: 12.5, fontWeight: 600 }}>✓ Saved</span>}
      </div>
      <UploadHint kind="banner" text="JPG or PNG, landscape — a full-screen background for the vanity login page. About 1600px wide or larger, under 2MB. A dark scrim is added automatically so the sign-in card stays readable." />
    </div>
  );
}

// Per-client campaign audience cap (Howler-admin only). The max recipients a
// single campaign can reach for this client; blank = the platform default.
function AudienceCapField({ entityId }) {
  const [data, setData] = useState(null); // { cap, smsCap, default, smsDefault, max }
  const [val, setVal] = useState('');     // audience cap (blank = default)
  const [sms, setSms] = useState('');     // SMS sub-cap (blank = default, 0 = block)
  const [saved, setSaved] = useState(false);
  const hydrate = (d) => { setData(d); setVal(d.cap === d.default ? '' : String(d.cap)); setSms(d.smsCap === d.smsDefault ? '' : String(d.smsCap)); };
  useEffect(() => { let alive = true; api.getAudienceCap(entityId).then((d) => { if (alive) hydrate(d); }).catch(() => { if (alive) setData({ cap: 0, smsCap: 0, default: 0, smsDefault: 0, max: 0 }); }); return () => { alive = false; }; }, [entityId]);
  if (!data) return null;
  const save = async (body) => { try { const d = await api.saveAudienceCap(entityId, body); hydrate(d); flash(setSaved); } catch (e) { alert('Save failed: ' + e.message); } };
  return (
    <div style={{ marginTop: 12 }}>
      <L>Campaign audience cap</L>
      <div style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 6px' }}>The most recipients one campaign can reach for this client. Leave blank for the platform default ({(data.default || 0).toLocaleString()}). Max {(data.max || 0).toLocaleString()}.</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input value={val} onChange={(e) => setVal(e.target.value.replace(/[^0-9]/g, ''))} onBlur={() => save({ cap: parseInt(val, 10) || 0 })} placeholder={`Default (${(data.default || 0).toLocaleString()})`} inputMode="numeric" style={{ ...input, maxWidth: 200 }} />
      </div>
      <div style={{ marginTop: 12 }}>
        <L>SMS sub-cap</L>
        <div style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 6px' }}>A tighter ceiling on how many SMS one campaign can send (so a big email blast can't fire an equally-big, costly SMS blast). Email is unaffected once it's hit. Leave blank for the default ({(data.smsDefault || 0).toLocaleString()}); set <strong>0</strong> to block SMS for this client.</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input value={sms} onChange={(e) => setSms(e.target.value.replace(/[^0-9]/g, ''))} onBlur={() => save({ smsCap: sms === '' ? '' : (parseInt(sms, 10) || 0) })} placeholder={`Default (${(data.smsDefault || 0).toLocaleString()})`} inputMode="numeric" style={{ ...input, maxWidth: 200 }} />
          {saved && <span style={{ color: 'var(--success,#10b981)', fontSize: 12.5, fontWeight: 600 }}>✓ Saved</span>}
        </div>
      </div>
    </div>
  );
}

// Client settings: name, organiser locks, preview, delete.
function ClientSettings({ entity, suites, fields, onChange, onBack }) {
  const navigate = useNavigate();
  const { setProfile } = useProfile();
  const [name, setName] = useState(entity.name);
  const [logo, setLogo] = useState(entity.logo || '');
  const [aiContext, setAiContext] = useState(entity.aiContext || '');
  const [locks, setLocks] = useState(entity.lockedFilters || {});
  const [allOrganisers, setAllOrganisers] = useState(!!entity.allOrganisers);
  const [saved, setSaved] = useState(false);
  const save = async () => { await api.adminUpdateEntity(entity.id, { name, logo, aiContext, lockedFilters: locks, allOrganisers }); flash(setSaved); onChange(); };
  const remove = async () => { if (confirm(`Delete client "${entity.name}"? This removes its sets too.`)) { await api.adminDeleteEntity(entity.id); onBack(); onChange(); } };
  const preview = async () => {
    if (!suites.length) { alert('This client has no suites yet.'); return; }
    // Enter THIS client's experience so every scoped page (Goals, Engage, Home)
    // sees only their data — not all clients. Then land on the first dashboard.
    setProfile(entity.id, { name: entity.name, logo: entity.logo });
    try {
      for (const su of suites) {
        const d = await api.mySuite(su.id);
        const first = d.sets.flatMap((s) => s.dashboards)[0];
        if (first) { navigate(`/suite/${su.id}/d/${first.id}`); return; }
      }
      navigate('/'); // no dashboards yet — still drop into the client home, scoped to them
    } catch (e) { alert('Could not open preview: ' + e.message); }
  };
  return (
    <div style={cardStyle}>
      <Row>
        <input style={{ ...input, fontWeight: 700, flex: 1 }} value={name} onChange={(e) => setName(e.target.value)} />
        <button style={previewBtn} onClick={preview} title="Preview this client's account">👁 Preview account</button>
        <button style={delBtn} onClick={remove}>Delete</button>
      </Row>
      <div style={{ marginBottom: 12 }}>
        <L>Client logo</L>
        <div style={{ marginTop: 6 }}><LogoPicker value={logo} onChange={setLogo} /></div>
      </div>
      {/* Internal/management clients see every organiser's data — no scope. A
          deliberate, admin-only opt-out of the organiser boundary. */}
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', border: '1px solid var(--hairline)', borderRadius: 10, margin: '4px 0 12px', cursor: 'pointer', background: allOrganisers ? 'rgba(var(--brand-rgb),0.08)' : 'transparent' }}>
        <input type="checkbox" checked={allOrganisers} onChange={(e) => setAllOrganisers(e.target.checked)} style={{ marginTop: 2 }} />
        <span>
          <span style={{ fontWeight: 700, fontSize: 13.5 }}>🌐 All organisers (internal / management)</span>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>
            This client sees <b>every organiser's</b> data — no organiser scope is applied. Use only for Howler-internal/management logins. Leave off for a normal client.
          </span>
        </span>
      </label>
      <L>Locked filters (organiser-level — apply across all this client's sets)</L>
      {allOrganisers
        ? <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '4px 0' }}>Not needed — “All organisers” is on, so this client is intentionally unscoped.</p>
        : <LockedFilterEditor value={locks} onChange={setLocks} fields={fields} restrictTo={['Organiser Name']} />}
      <div style={{ marginTop: 12 }}>
        <L>Client AI context</L>
        <div style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 4px' }}>Added to the AI for this client's insights & dashboard summaries (on top of the global AI instructions).</div>
        <textarea
          value={aiContext}
          onChange={(e) => setAiContext(e.target.value)}
          rows={5}
          placeholder={"e.g. MTN Bushfire is a 3-day festival in Eswatini each May. Compare 2026 vs 2025. Capacity ~25k/day. Cashless is closed-loop tokens."}
          style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
        />
      </div>
      <OwlGuidanceEditor scope="admin-client" entityId={entity.id} />
      <CurrencyField entityId={entity.id} />
      <LanguageField entityId={entity.id} />
      <AudienceCapField entityId={entity.id} />
      <SlugField entityId={entity.id} />
      <LoginBackgroundField entityId={entity.id} />
      <SaveRow onSave={save} saved={saved} id={entity.id} />
    </div>
  );
}

// Client suites: the full suite editor for each, plus add.
function ClientSuites({ entity, suites, allEntities, allSets, dashTitle, fields, onChange }) {
  const [customSets, setCustomSets] = useState([]);
  useEffect(() => { api.getEntitySets(entity.id).then((d) => setCustomSets(d.sets || [])).catch(() => setCustomSets([])); }, [entity.id]);
  const sets = [...allSets, ...customSets]; // shared templates + this client's bespoke sets
  const addSuite = async () => { await api.adminCreateSuite({ entityId: entity.id, name: 'New suite', lockedFilters: {}, setIds: [] }); onChange(); };
  return (
    <div>
      {suites.map((su) => (
        <SuiteCard key={su.id} suite={su} entities={allEntities} sets={sets} dashTitle={dashTitle} fields={fields} onChange={onChange} />
      ))}
      {suites.length === 0 && <Muted>No suites yet.</Muted>}
      <button style={addBtn} onClick={addSuite}>+ Add suite</button>
    </div>
  );
}

// Multi-select of clients as toggle chips — used to attach customer profiles.
function ClientLinkPicker({ entities, value = [], onChange }) {
  const toggle = (id) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {entities.map((e) => {
        const on = value.includes(e.id);
        return (
          <button key={e.id} type="button" onClick={() => toggle(e.id)}
            style={{ ...folderChip, borderColor: on ? 'var(--brand)' : 'var(--border)', color: on ? 'var(--brand)' : 'var(--text)', fontWeight: on ? 700 : 400 }}>
            {on ? '✓ ' : ''}{e.name}
          </button>
        );
      })}
    </div>
  );
}
// Compact login management scoped to one client: list its logins (remove access
// or delete), add a new client login, or LINK an existing login (client or
// admin) so one person can hold several profiles.
// Who at Howler supports this client — the contacts the client sees as "Your
// Howler Support". An admin can reassign, add a second, or change each one's job
// title (the title is the admin's global Howler role).
function HowlerSupportCard({ entity, allUsers = [], howlerRoles = [], onChange }) {
  const admins = allUsers.filter((u) => u.role === 'admin');
  const byId = Object.fromEntries(admins.map((u) => [u.id, u]));
  const current = (entity.howlerSupportIds || []).filter((id) => byId[id]);
  const [addId, setAddId] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (ids) => { setBusy(true); try { await api.setEntityHowlerSupport(entity.id, ids); onChange(); } finally { setBusy(false); } };
  const addOne = async () => { if (!addId) return; await save([...current, addId]); setAddId(''); };
  const setTitle = async (id, howlerRole) => { setBusy(true); try { await api.adminUpdateUser(id, { howlerRole }); onChange(); } finally { setBusy(false); } };
  const available = admins.filter((u) => !current.includes(u.id));
  return (
    <div style={{ ...cardStyle, marginBottom: 16 }}>
      <L>🦉 Howler support</L>
      <p style={{ ...hint, margin: '2px 0 10px' }}>The Howler contact(s) this client sees under <b>Settings → Team</b>. Reassign, add a second, or change each one's job title.</p>
      {current.length === 0 ? <Muted>No Howler support assigned yet.</Muted> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {current.map((id) => { const u = byId[id]; return (
            <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 140 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{u.fullName || u.email}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{u.email}</div>
              </div>
              <select style={{ ...input, width: 'auto', minWidth: 180 }} value={u.howlerRole || ''} disabled={busy} onChange={(e) => setTitle(id, e.target.value)}>
                <option value="">— no job title —</option>
                {howlerRoles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
              </select>
              <button style={delBtn} disabled={busy} onClick={() => save(current.filter((x) => x !== id))}>Remove</button>
            </div>
          ); })}
        </div>
      )}
      {available.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <select style={{ ...input, flex: 1, minWidth: 200 }} value={addId} onChange={(e) => setAddId(e.target.value)}>
            <option value="">Add a Howler admin…</option>
            {available.map((u) => <option key={u.id} value={u.id}>{u.fullName || u.email}{u.howlerRoleLabel ? ` · ${u.howlerRoleLabel}` : ''}</option>)}
          </select>
          <button style={{ ...miniBtn, background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' }} disabled={!addId || busy} onClick={addOne}>+ Add</button>
        </div>
      )}
    </div>
  );
}

function EntityLogins({ entity, users, allUsers = [], onChange }) {
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', mobile: '', password: '', role: 'owner' });
  const [error, setError] = useState(null);
  const [linkId, setLinkId] = useState('');
  const [linkRole, setLinkRole] = useState('viewer');
  const [showAdd, setShowAdd] = useState(false);
  const [roles, setRoles] = useState([]);
  const [howlerRoles, setHowlerRoles] = useState([]);
  useEffect(() => { api.getRoles().then((r) => { setRoles(r.roles || []); setHowlerRoles(r.howlerRoles || []); }).catch(() => setRoles([])); }, []);
  const linkable = allUsers.filter((u) => !(u.entityIds || []).includes(entity.id));
  // This login's role at THIS client (from its membership list).
  const roleOf = (u) => (u.memberships || []).find((m) => m.entityId === entity.id)?.role || 'owner';
  const add = async () => {
    setError(null);
    try {
      const u = await api.adminCreateUser({ firstName: form.firstName, lastName: form.lastName, email: form.email, mobile: form.mobile, password: form.password, role: 'client', entityIds: [entity.id] });
      if (form.role !== 'owner') await api.setMembershipRole(entity.id, u.id, form.role); // owner is the default
      setForm({ firstName: '', lastName: '', email: '', mobile: '', password: '', role: 'owner' });
      setShowAdd(false);
      onChange();
    } catch (e) { setError(e.message); }
  };
  const link = async () => {
    const u = linkable.find((x) => x.id === linkId);
    if (!u) return;
    await api.adminUpdateUser(u.id, { entityIds: [...(u.entityIds || []), entity.id] });
    await api.setMembershipRole(entity.id, u.id, linkRole);
    setLinkId(''); setLinkRole('viewer'); setShowAdd(false); onChange();
  };
  const changeRole = async (u, role) => { await api.setMembershipRole(entity.id, u.id, role); onChange(); };
  const removeAccess = async (u) => {
    const nextIds = (u.entityIds || []).filter((x) => x !== entity.id);
    await api.adminUpdateUser(u.id, { entityIds: nextIds });
    onChange();
  };
  const del = async (u) => { if (confirm(`Delete login ${u.email}? (removes it for all clients)`)) { await api.adminDeleteUser(u.id); onChange(); } };
  const roleOpts = roles.length ? roles : [{ key: 'owner', label: 'Owner' }];
  const addUI = !showAdd ? (
    <button data-tour="login-add" style={{ ...miniBtn, background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)', marginBottom: 12 }} onClick={() => { setError(null); setShowAdd(true); }}>+ Add user</button>
  ) : (
    <div style={{ ...cardStyle, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>Add a user to {entity.name}</span>
        <button style={miniBtnOutline} onClick={() => { setShowAdd(false); setError(null); }}>Cancel</button>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="First name"><input style={{ ...input, minWidth: 110 }} value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} /></Field>
        <Field label="Surname"><input style={{ ...input, minWidth: 110 }} value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></Field>
        <Field label="Email"><input style={input} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Mobile"><input style={{ ...input, minWidth: 130 }} value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} placeholder="+27…" /></Field>
        <Field label="Password"><input style={input} type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
        <div data-tour="login-role"><Field label="Role"><select style={input} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{roleOpts.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select></Field></div>
        <button style={{ ...miniBtn, background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' }} onClick={add} disabled={!form.email || !form.password}>+ Add login</button>
      </div>
      {roles.length > 0 && (
        <p style={{ ...hint, marginTop: 8 }}>{roleOpts.find((r) => r.key === form.role)?.description || ''}</p>
      )}
      {linkable.length > 0 && (
        <div data-tour="login-link" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--hairline)' }}>
          <Field label="Or link an existing login (one person, several profiles)">
            <select style={input} value={linkId} onChange={(e) => setLinkId(e.target.value)}>
              <option value="">Pick a login…</option>
              {linkable.map((u) => <option key={u.id} value={u.id}>{u.email}{u.role === 'admin' ? ' (Howler admin)' : ''}</option>)}
            </select>
          </Field>
          <Field label="Role"><select style={input} value={linkRole} onChange={(e) => setLinkRole(e.target.value)}>{roleOpts.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select></Field>
          <button style={miniBtn} onClick={link} disabled={!linkId}>Link to {entity.name}</button>
        </div>
      )}
      {error && <div style={{ color: 'var(--error)', fontSize: 13, marginTop: 6 }}>{error}</div>}
    </div>
  );
  return (
    <div>
      <HowlerSupportCard entity={entity} allUsers={allUsers} howlerRoles={howlerRoles} onChange={onChange} />
      {addUI}
      {users.length === 0 ? (
        <Muted>No logins yet for this client.</Muted>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td style={td}>
                  {u.fullName ? <span style={{ fontWeight: 600 }}>{u.fullName}</span> : u.email}
                  {u.role === 'admin' && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: 'var(--brand)', border: '1px solid var(--brand)', borderRadius: 980, padding: '1px 7px', verticalAlign: 'middle' }}>HOWLER</span>}
                  <div style={{ color: 'var(--muted)', fontSize: 11 }}>{u.fullName ? `${u.email} · ` : ''}{u.mobile ? `${u.mobile} · ` : ''}{(u.entityIds || []).length > 1 ? 'also other clients' : 'this client'}</div>
                </td>
                <td style={{ ...td, width: 130 }}>
                  {u.role === 'admin'
                    ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>Full access</span>
                    : <select style={{ ...input, padding: '4px 8px', fontSize: 12 }} value={roleOf(u)} onChange={(e) => changeRole(u, e.target.value)} title="Role at this client">
                        {roleOpts.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                      </select>}
                </td>
                <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button style={miniBtnOutline} onClick={() => removeAccess(u)}>Remove access</button>
                  <button style={{ ...delBtn, marginLeft: 6 }} onClick={() => del(u)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── Custom sets (a client's bespoke collections, hidden from the shared library) ──
function CustomSets({ entity }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [cloneId, setCloneId] = useState('');
  const [imp, setImp] = useState({ lookerDashboardId: '', setId: '', title: '', keepImportedFilters: true, busy: false, err: '' });
  const load = () => api.getEntitySets(entity.id).then(setData).catch(() => setData({ sets: [], pool: [], templates: [] }));
  // Wrap: load returns a promise, and useEffect would call it as a cleanup fn.
  useEffect(() => { load(); }, [entity.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <Muted>Loading…</Muted>;

  const doImport = async () => {
    if (!imp.lookerDashboardId.trim()) return;
    setImp((s) => ({ ...s, busy: true, err: '' }));
    try { await api.importEntityDashboard(entity.id, { lookerDashboardId: imp.lookerDashboardId.trim(), setId: imp.setId || undefined, title: imp.title || undefined, keepImportedFilters: imp.keepImportedFilters }); setImp({ lookerDashboardId: '', setId: '', title: '', keepImportedFilters: true, busy: false, err: '' }); load(); }
    catch (e) { setImp((s) => ({ ...s, busy: false, err: e.message })); }
  };

  return (
    <div>
      <p style={hint}>Bespoke sets for <b>{entity.name}</b> — visible only here and attachable only to this client's suites (never in the shared Sets library). Clone a standard template to tweak it, or import a custom Looker dashboard.</p>

      {/* Create / clone */}
      <div style={{ ...cardStyle, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
        <button style={miniBtn} onClick={() => api.createEntitySet(entity.id, { name: 'New custom set', dashboardIds: [] }).then(load)}>+ New empty set</button>
        <span style={{ color: 'var(--muted)', alignSelf: 'center' }}>or</span>
        <Field label="Clone a template">
          <select style={input} value={cloneId} onChange={(e) => setCloneId(e.target.value)}>
            <option value="">Pick a shared set…</option>
            {data.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <button style={miniBtn} disabled={!cloneId} onClick={() => api.cloneEntitySet(entity.id, cloneId).then(() => { setCloneId(''); load(); })}>Clone</button>
      </div>

      {/* Import a bespoke Looker dashboard */}
      <div style={{ ...cardStyle, marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Import a custom dashboard from Looker</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Looker dashboard ID"><input style={input} value={imp.lookerDashboardId} onChange={(e) => setImp({ ...imp, lookerDashboardId: e.target.value })} placeholder="e.g. 1234" /></Field>
          <Field label="Title (optional)"><input style={input} value={imp.title} onChange={(e) => setImp({ ...imp, title: e.target.value })} /></Field>
          <Field label="Add to set (optional)">
            <select style={input} value={imp.setId} onChange={(e) => setImp({ ...imp, setId: e.target.value })}>
              <option value="">Don't add yet</option>
              {data.sets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <button style={miniBtn} onClick={doImport} disabled={imp.busy || !imp.lookerDashboardId.trim()}>{imp.busy ? 'Importing…' : 'Import'}</button>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--muted)', marginTop: 10, cursor: 'pointer' }}>
          <input type="checkbox" checked={imp.keepImportedFilters} onChange={(e) => setImp({ ...imp, keepImportedFilters: e.target.checked })} />
          📌 Keep Looker's default filters (don't let client/user/lock settings override them)
        </label>
        {imp.err && <div style={{ color: 'var(--error)', fontSize: 13, marginTop: 6 }}>{imp.err}</div>}
        <div style={hint}>The imported dashboard is private to this client — it's filed under <b>Custom / {entity.name}</b> in your dashboard library. Add it to a custom set, then bundle that set into one of their suites.</div>
        {data.pool.some((d) => d.ownerEntityId === entity.id) && (
          <div style={{ marginTop: 10 }}>
            <L>This client's custom dashboards</L>
            {data.pool.filter((d) => d.ownerEntityId === entity.id).map((d) => (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--hairline)', fontSize: 13 }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>{d.tileCount} tiles</span>
                <button style={miniBtnOutline} onClick={() => navigate(`/d/${d.id}`)}>View</button>
                <button style={miniBtnOutline} onClick={() => navigate(`/d/${d.id}/edit`)}>Edit</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {data.sets.length === 0 ? <Muted>No custom sets yet.</Muted>
        : data.sets.map((s) => <SetCard key={s.id} set={s} dashboards={data.pool} onChange={load} />)}
    </div>
  );
}

// ─── Sets (reusable dashboard collections: Ticketing, Cashless, …) ────────────
function Sets() {
  const [items, setItems] = useState([]);
  const [dashboards, setDashboards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({}); // folder -> expanded? (default collapsed)
  // Shared library only ever bundles shared dashboards — never a client's bespoke one.
  const load = () => { setLoading(true); Promise.all([api.adminListSets(), api.listDashboards()]).then(([t, d]) => { setItems(t); setDashboards(d.filter((x) => !x.ownerEntityId)); }).finally(() => setLoading(false)); };
  useEffect(() => { load(); }, []);
  if (loading) return <Muted>Loading…</Muted>;

  const folderNames = [...new Set(items.map((s) => s.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  // Named folders (sorted) first, then the ungrouped bucket last.
  const groups = [...folderNames.map((f) => [f, items.filter((s) => s.folder === f)]), ['', items.filter((s) => !s.folder)]];
  const isOpen = (f) => !!expanded[f];
  const toggle = (f) => setExpanded((e) => ({ ...e, [f]: !e[f] }));
  const addSet = (folder) => { setExpanded((e) => ({ ...e, [folder]: true })); return api.adminCreateSet({ name: 'New set', folder, dashboardIds: [] }).then(load); };
  const newFolder = () => { const name = prompt('New folder name'); if (name && name.trim()) addSet(name.trim()); };

  return (
    <div>
      <p style={hint}>A Set is a reusable group of dashboards (e.g. Ticketing, Cashless). Bundle them into a client's Suite. Group related sets into folders to keep the library tidy.</p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <button style={addBtn} onClick={() => addSet('')}>+ Add set</button>
        <button style={addBtn} onClick={newFolder}>+ New folder</button>
      </div>
      {groups.map(([folder, sets]) => {
        if (folder === '' && sets.length === 0) return null;
        const open = isOpen(folder);
        return (
          <div key={folder || '__ungrouped__'} style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px' }}>
              <button onClick={() => toggle(folder)} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, color: 'var(--text)' }}>
                <span style={{ width: 12, color: '#b0b0b6', fontSize: 11, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
                <span style={{ fontSize: 13, fontWeight: 800, textTransform: folder ? 'none' : 'uppercase', letterSpacing: folder ? 0 : '0.06em', color: folder ? 'var(--text)' : 'var(--muted)' }}>{folder ? `📁 ${folder}` : 'Ungrouped'}</span>
                <span style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 400 }}>· {sets.length} set{sets.length === 1 ? '' : 's'}</span>
              </button>
              <button style={{ ...addBtn, margin: 0, padding: '5px 10px', fontSize: 12 }} onClick={() => addSet(folder)}>+ Set</button>
            </div>
            {open && (
              <div style={{ borderLeft: folder ? '2px solid var(--hairline)' : 'none', paddingLeft: folder ? 10 : 0 }}>
                {sets.length === 0 ? <Muted>Empty — add a set.</Muted>
                  : sets.map((t) => <SetCard key={t.id} set={t} dashboards={dashboards} folders={folderNames} showFolder onChange={load} />)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
function SetCard({ set, dashboards, onChange, folders = [], showFolder = false }) {
  const navigate = useNavigate();
  const [name, setName] = useState(set.name);
  const [icon, setIcon] = useState(set.icon || '');
  const [folder, setFolder] = useState(set.folder || '');
  const [ids, setIds] = useState(set.dashboardIds || []);
  // Sub-dashboards: id -> parentId for ids nested as tabs of another dashboard.
  const [parents, setParents] = useState(() => {
    const m = {};
    for (const e of set.dashboards || []) if (e.parentId) m[e.id] = e.parentId;
    return m;
  });
  // Per-dashboard display-name override in this set (id -> label). Blank = native name.
  const [displayNames, setDisplayNames] = useState(() => {
    const m = {};
    for (const e of set.dashboards || []) if (e.displayName) m[e.id] = e.displayName;
    return m;
  });
  const setDisplayName = (id, label) => setDisplayNames((cur) => {
    const next = { ...cur };
    if (label.trim()) next[id] = label; else delete next[id];
    return next;
  });
  const [fpath, setFpath] = useState(''); // current folder path in the picker; '' = top
  const [saved, setSaved] = useState(false);
  const toggle = (id) => setIds((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  const setParent = (id, parentId) => setParents((cur) => {
    const next = { ...cur };
    if (parentId) next[id] = parentId; else delete next[id];
    // Anything nested under `id` un-nests if `id` itself becomes a child.
    if (parentId) for (const k of Object.keys(next)) if (next[k] === id) delete next[k];
    return next;
  });
  const save = async () => {
    const patch = { name, icon, dashboards: ids.map((id) => ({ id, parentId: parents[id] || null, displayName: displayNames[id] || '' })) };
    if (showFolder) patch.folder = folder.trim();
    await api.adminUpdateSet(set.id, patch);
    flash(setSaved); onChange();
  };
  const remove = async () => { if (confirm(`Delete set "${set.name}"?`)) { await api.adminDeleteSet(set.id); onChange(); } };

  // Folder picker: drill through nested folders (paths are "/"-separated).
  const allFolders = [...new Set(dashboards.map((d) => d.folder).filter(Boolean))];
  const fullChild = (seg) => (fpath ? `${fpath}/${seg}` : seg);
  const childSegs = (() => {
    const s = new Set();
    for (const f of allFolders) {
      if (fpath) { if (f === fpath || !f.startsWith(fpath + '/')) continue; s.add(f.slice(fpath.length + 1).split('/')[0]); }
      else s.add(f.split('/')[0]);
    }
    return [...s].sort((a, b) => a.localeCompare(b));
  })();
  const dashHere = dashboards.filter((d) => (d.folder || '') === fpath); // directly in this folder
  const underPath = dashboards.filter((d) => { const f = d.folder || ''; return fpath ? (f === fpath || f.startsWith(fpath + '/')) : true; });
  const fsegs = fpath ? fpath.split('/') : [];
  const addAllUnder = () => setIds((cur) => [...new Set([...cur, ...underPath.map((d) => d.id)])]);

  // Reordering the set's dashboards (the array order is the saved order).
  const byId = Object.fromEntries(dashboards.map((d) => [d.id, d]));
  const dragFrom = useRef(null);
  const [dragOver, setDragOver] = useState(null);
  const onDragOverRow = (i) => {
    const from = dragFrom.current;
    if (from === null || from === i) { setDragOver(i); return; }
    setIds((cur) => { const n = cur.slice(); const [m] = n.splice(from, 1); n.splice(i, 0, m); return n; });
    dragFrom.current = i;
    setDragOver(i);
  };
  const removeId = (id) => {
    setIds((cur) => cur.filter((x) => x !== id));
    setParents((cur) => {
      const next = { ...cur };
      delete next[id];
      for (const k of Object.keys(next)) if (next[k] === id) delete next[k]; // children go top-level
      return next;
    });
    setDisplayNames((cur) => { const next = { ...cur }; delete next[id]; return next; });
  };
  const [open, setOpen] = useState(false);

  return (
    <div style={cardStyle}>
      <Row>
        <button onClick={() => setOpen((o) => !o)} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }}>
          <span style={{ width: 12, color: '#b0b0b6', fontSize: 11, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
          {set.icon && <span style={{ fontSize: 16 }}>{set.icon.startsWith('data:') ? <img src={set.icon} alt="" style={{ width: 18, height: 18, objectFit: 'contain', verticalAlign: 'middle' }} /> : set.icon}</span>}
          <span style={{ fontWeight: 700, fontSize: 15 }}>{name || 'Untitled set'}</span>
          <span style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 400 }}>· {ids.length} dashboard{ids.length === 1 ? '' : 's'}</span>
        </button>
        <button style={delBtn} onClick={remove}>Delete</button>
      </Row>
      {!open ? null : (<>
      <L>Name</L>
      <input style={{ ...input, fontWeight: 700, width: '100%' }} value={name} onChange={(e) => setName(e.target.value)} />
      {showFolder && (
        <>
          <L>Folder</L>
          <input list={`folders-${set.id}`} style={{ ...input, width: '100%' }} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Ungrouped — type a name to file it in a folder" />
          <datalist id={`folders-${set.id}`}>{folders.map((f) => <option key={f} value={f} />)}</datalist>
        </>
      )}
      <Field label="Icon"><IconPicker value={icon} onChange={setIcon} /></Field>
      <Section title="Add dashboards from folder">
      <div style={{ border: '1px solid var(--hairline)', borderRadius: 8, padding: 10, margin: '6px 0' }}>
        {/* Breadcrumb */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 13, marginBottom: 8 }}>
          <button style={crumbLink} onClick={() => setFpath('')}>All folders</button>
          {fsegs.map((s, i) => (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: 'var(--muted)' }}>/</span>
              <button style={crumbLink} onClick={() => setFpath(fsegs.slice(0, i + 1).join('/'))}>{s}</button>
            </span>
          ))}
          <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 12 }}>{ids.length} selected</span>
        </div>
        {/* Subfolders */}
        {childSegs.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {childSegs.map((seg) => (
              <button key={seg} style={folderChip} onClick={() => setFpath(fullChild(seg))}>📁 {seg}</button>
            ))}
          </div>
        )}
        {/* Add-all for the current folder (incl. subfolders) */}
        {underPath.length > 0 && (
          <button style={{ ...miniBtn, marginBottom: 8 }} onClick={addAllUnder}>+ Add all {fpath ? 'in this folder' : ''} ({underPath.length})</button>
        )}
        {/* Dashboards directly in this folder */}
        <div style={{ ...checkList, margin: 0 }}>
          {dashHere.map((d) => (
            <label key={d.id} style={checkItem}>
              <input type="checkbox" checked={ids.includes(d.id)} onChange={() => toggle(d.id)} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}{!d.folder && <span style={{ color: '#bbb' }}> · unfiled</span>}</span>
            </label>
          ))}
          {dashHere.length === 0 && <Muted>{childSegs.length ? 'Open a subfolder, or add all above.' : 'No dashboards here.'}</Muted>}
        </div>
      </div>
      </Section>
      {ids.length > 0 && (
        <Section title="Order & names in this set (drag to reorder · rename to override the sidebar label · nest a dashboard as a tab of another)">
          <div style={orderList}>
            {ids.map((id, i) => {
              const parentId = parents[id] || '';
              // Valid parents: top-level dashboards in this set (not itself).
              const parentOptions = ids.filter((x) => x !== id && !parents[x]);
              return (
                <div
                  key={id}
                  draggable
                  onDragStart={(e) => { dragFrom.current = i; e.dataTransfer.effectAllowed = 'move'; }}
                  onDragOver={(e) => { e.preventDefault(); onDragOverRow(i); }}
                  onDragEnd={() => { dragFrom.current = null; setDragOver(null); }}
                  onDrop={(e) => { e.preventDefault(); dragFrom.current = null; setDragOver(null); }}
                  style={{ ...orderRow, cursor: 'grab', background: dragOver === i ? '#fff0f3' : 'transparent', borderRadius: 6, paddingLeft: parentId ? 26 : 0 }}
                >
                  <span style={{ color: '#c4c4c8', flexShrink: 0, fontSize: 15, lineHeight: 1 }} title="Drag to reorder">⠿</span>
                  <span style={{ color: 'var(--muted)', width: 20, textAlign: 'right', flexShrink: 0 }}>{parentId ? '↳' : `${i + 1}.`}</span>
                  {byId[id] ? (
                    <input
                      style={{ ...input, flex: 1, minWidth: 100, padding: '4px 8px', fontSize: 13 }}
                      value={displayNames[id] || ''}
                      onChange={(e) => setDisplayName(id, e.target.value)}
                      placeholder={byId[id].title}
                      title={`Display name in the sidebar/top-nav — blank uses the native name “${byId[id].title}”`}
                    />
                  ) : (
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--muted)' }}>(dashboard not found)</span>
                  )}
                  <select
                    value={parentId}
                    onChange={(e) => setParent(id, e.target.value)}
                    title="Show as a tab inside another dashboard"
                    style={{ ...input, minWidth: 120, maxWidth: 180, padding: '4px 8px', fontSize: 12 }}
                  >
                    <option value="">Sidebar item</option>
                    {parentOptions.map((pid) => (
                      <option key={pid} value={pid}>Tab of: {byId[pid]?.title || pid}</option>
                    ))}
                  </select>
                  <button style={orderBtn} onClick={() => navigate(`/d/${id}`)} title="View dashboard">👁</button>
                  <button style={{ ...orderBtn, color: 'var(--error)' }} onClick={() => removeId(id)} title="Remove from set">✕</button>
                </div>
              );
            })}
          </div>
        </Section>
      )}
      <SaveRow onSave={save} saved={saved} id={set.id} />
      </>)}
    </div>
  );
}

// Role allowlist editor: toggle-chip per role. Empty = "Everyone" (open). When
// `inherit` is set, empty reads as "Inherit" (a dashboard with no override
// follows its set). Persists on every change.
function RoleChips({ value = [], roles, onChange, inherit = false }) {
  const on = new Set(value);
  const toggle = (key) => { const next = on.has(key) ? value.filter((r) => r !== key) : [...value, key]; onChange(next); };
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
      <span style={{ fontSize: 11, color: 'var(--muted)', marginRight: 2 }}>{value.length ? 'Only:' : (inherit ? 'Inherit' : 'Everyone')}</span>
      {roles.map((r) => {
        const sel = on.has(r.key);
        return (
          <button key={r.key} type="button" onClick={() => toggle(r.key)} title={r.description}
            style={{ fontSize: 11, fontWeight: sel ? 700 : 500, padding: '2px 8px', borderRadius: 980, cursor: 'pointer',
              border: `1px solid ${sel ? 'var(--brand)' : 'var(--border)'}`, color: sel ? 'var(--brand)' : 'var(--muted)', background: sel ? 'rgba(var(--brand-rgb,255,56,92),0.08)' : 'transparent' }}>
            {sel ? '✓ ' : ''}{r.label}
          </button>
        );
      })}
    </span>
  );
}

// ─── Suite editor (a client's event context: locks + bundled Sets) ────────────
// Rendered inside a client's Suites section (see ClientSuites).
function SuiteCard({ suite, entities, sets, dashTitle = {}, fields, onChange }) {
  const navigate = useNavigate();
  const { setProfile } = useProfile();
  const [openSets, setOpenSets] = useState({});
  const [name, setName] = useState(suite.name);
  const [icon, setIcon] = useState(suite.icon || '');
  const [entityId, setEntityId] = useState(suite.entityId);
  const [setIds, setSetIds] = useState(suite.setIds || []);
  const [locks, setLocks] = useState(suite.lockedFilters || {});
  // Dashboards an admin left OUT of a selected set for this client, and
  // per-dashboard locked-filter overrides ({ dashboardId: { field: 'v1,v2' } }).
  const [excluded, setExcluded] = useState(suite.excludedDashboards || []);
  const [dashLocks, setDashLocks] = useState(suite.dashboardLocks || {});
  const [eventUrl, setEventUrl] = useState(suite.eventUrl || '');
  const [saved, setSaved] = useState(false);
  const toggleDash = (did) => setExcluded((cur) => (cur.includes(did) ? cur.filter((x) => x !== did) : [...cur, did]));
  const setDashLock = (did, map) => setDashLocks((cur) => {
    const next = { ...cur };
    if (map && Object.keys(map).length) next[did] = map; else delete next[did];
    return next;
  });
  // Role-based visibility for this client (keyed to the suite's entity).
  const [cr, setCr] = useState({ sets: {}, dashboards: {} });
  const [roleCat, setRoleCat] = useState([]);
  useEffect(() => {
    if (!entityId) return;
    api.getEntityContentRoles(entityId).then((r) => { setCr(r.content || { sets: {}, dashboards: {} }); setRoleCat(r.roles || []); }).catch(() => {});
  }, [entityId]);
  const saveScope = async (scopeType, scopeId, list) => {
    setCr((c) => ({ ...c, [scopeType === 'set' ? 'sets' : 'dashboards']: { ...c[scopeType === 'set' ? 'sets' : 'dashboards'], [scopeId]: list } }));
    try { await api.setContentRoles(entityId, scopeType, scopeId, list); } catch (e) { alert('Could not save visibility: ' + e.message); }
  };
  const toggleSet = (id) => setSetIds((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  const setById = Object.fromEntries(sets.map((s) => [s.id, s]));
  // Which standard filter groups this suite needs — cashless dashboards bring the
  // cashless filters, every other dashboard type uses the event filters.
  const lockCategories = useMemo(() => {
    const cats = new Set();
    for (const id of setIds) cats.add(/cashless/i.test(setById[id]?.name || '') ? 'Cashless' : 'Event');
    return [...cats];
  }, [setIds, sets]); // eslint-disable-line react-hooks/exhaustive-deps
  const dragFrom = useRef(null);
  const [dragOver, setDragOver] = useState(null);
  const onDragOverRow = (i) => {
    const from = dragFrom.current;
    if (from === null || from === i) { setDragOver(i); return; }
    setSetIds((cur) => { const n = cur.slice(); const [m] = n.splice(from, 1); n.splice(i, 0, m); return n; });
    dragFrom.current = i; setDragOver(i);
  };
  const save = async () => { await api.adminUpdateSuite(suite.id, { name, icon, entityId, setIds, lockedFilters: locks, excludedDashboards: excluded, dashboardLocks: dashLocks, eventUrl }); flash(setSaved); onChange(); };
  // Sets grouped by their library folder (item: show folder → set → dashboards),
  // named folders first then the ungrouped bucket.
  const setsByFolder = (() => { const m = {}; for (const s of sets) { const f = s.folder || ''; (m[f] = m[f] || []).push(s); } return m; })();
  const setFolderOrder = Object.keys(setsByFolder).sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  // The dashboards actually reaching the client through this suite (selected sets
  // minus per-dashboard exclusions), de-duped — drives the per-dashboard lock list.
  const includedDashboards = (() => {
    const seen = new Set(); const out = [];
    for (const sid of setIds) { const s = setById[sid]; if (!s) continue; for (const did of (s.dashboardIds || [])) { if (excluded.includes(did) || seen.has(did)) continue; seen.add(did); out.push({ id: did, title: dashTitle[did] || did }); } }
    return out;
  })();
  const remove = async () => { if (confirm(`Delete suite "${suite.name}"?`)) { await api.adminDeleteSuite(suite.id); onChange(); } };
  // Open this suite exactly as the client sees it (preview), jumping to its
  // first dashboard. Uses the client suite endpoint (admins can read any suite).
  const preview = async () => {
    try {
      // Scope the whole client shell to this suite's client, then open the suite.
      const ent = (entities || []).find((e) => e.id === suite.entityId);
      if (suite.entityId) setProfile(suite.entityId, { name: ent?.name, logo: ent?.logo });
      const d = await api.mySuite(suite.id);
      const first = d.sets.flatMap((s) => s.dashboards)[0];
      if (first) navigate(`/suite/${suite.id}/d/${first.id}`);
      else alert('This suite has no dashboards to preview yet.');
    } catch (e) { alert('Could not open preview: ' + e.message); }
  };
  return (
    <div style={cardStyle}>
      <Row>
        <input data-tour="suite-name" style={{ ...input, fontWeight: 700, flex: 1 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Suite name — e.g. Bushfire 2026" />
        <button style={previewBtn} onClick={preview} title="Preview as the client sees it">👁 Preview</button>
        <button style={delBtn} onClick={remove}>Delete</button>
      </Row>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Client"><select style={input} value={entityId} onChange={(e) => setEntityId(e.target.value)}>{entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        <div data-tour="suite-icon"><Field label="Icon"><IconPicker value={icon} onChange={setIcon} /></Field></div>
      </div>
      <Section tour="suite-sets" title={`Sets in this suite (${setIds.length})`}>
        <p style={{ ...hint, marginTop: 0 }}>Tick a set to include it. Expand a set to choose which of its dashboards this client gets — untick any you want to leave out.</p>
        <div style={checkList}>
          {sets.length === 0 ? <Muted>Create a Set first.</Muted> : setFolderOrder.map((folder) => (
            <div key={folder || '__ungrouped__'} style={{ marginBottom: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 800, textTransform: folder ? 'none' : 'uppercase', letterSpacing: folder ? 0 : '0.06em', color: 'var(--muted)', padding: '4px 0 2px' }}>{folder ? `📁 ${folder}` : 'Ungrouped'}</div>
              {setsByFolder[folder].map((s) => {
                const open = !!openSets[s.id];
                const setOn = setIds.includes(s.id);
                return (
                  <div key={s.id} style={{ paddingLeft: folder ? 8 : 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <button onClick={() => setOpenSets((p) => ({ ...p, [s.id]: !p[s.id] }))} title="Show dashboards" style={{ width: 14, border: 'none', background: 'transparent', cursor: 'pointer', color: '#b0b0b6', fontSize: 10, padding: 0, transform: open ? 'rotate(90deg)' : 'none' }}>▶</button>
                      <label style={{ ...checkItem, flex: 1 }}>
                        <input type="checkbox" checked={setOn} onChange={() => toggleSet(s.id)} />
                        <span>{s.name} <span style={{ color: 'var(--muted)' }}>({s.dashboardIds.length})</span></span>
                      </label>
                    </div>
                    {open && (
                      <div style={{ paddingLeft: 26, margin: '2px 0 6px' }}>
                        {s.dashboardIds.length === 0 ? (
                          <div style={{ fontSize: 12, color: 'var(--muted)' }}>No dashboards in this set.</div>
                        ) : s.dashboardIds.map((did) => {
                          const included = setOn && !excluded.includes(did);
                          return (
                            <label key={did} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, padding: '2px 0', opacity: setOn ? 1 : 0.45, cursor: setOn ? 'pointer' : 'default' }}>
                              <input type="checkbox" disabled={!setOn} checked={included} onChange={() => toggleDash(did)} />
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dashTitle[did] || did}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </Section>
      {setIds.length > 1 && (
        <Section title="Order in this suite (drag to reorder)">
          <div style={orderList}>
            {setIds.map((id, i) => (
              <div
                key={id}
                draggable
                onDragStart={(e) => { dragFrom.current = i; e.dataTransfer.effectAllowed = 'move'; }}
                onDragOver={(e) => { e.preventDefault(); onDragOverRow(i); }}
                onDragEnd={() => { dragFrom.current = null; setDragOver(null); }}
                onDrop={(e) => { e.preventDefault(); dragFrom.current = null; setDragOver(null); }}
                style={{ ...orderRow, cursor: 'grab', background: dragOver === i ? '#fff0f3' : 'transparent', borderRadius: 6 }}
              >
                <span style={{ color: '#c4c4c8', flexShrink: 0, fontSize: 15, lineHeight: 1 }} title="Drag to reorder">⠿</span>
                <span style={{ color: 'var(--muted)', width: 20, textAlign: 'right', flexShrink: 0 }}>{i + 1}.</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{setById[id] ? setById[id].name : '(set not found)'}</span>
                <button style={{ ...orderBtn, color: 'var(--error)' }} onClick={() => toggleSet(id)} title="Remove from suite">✕</button>
              </div>
            ))}
          </div>
        </Section>
      )}
      {roleCat.length > 0 && setIds.length > 0 && (
        <Section tour="suite-roles" title="Dashboard access by role">
          <p style={{ ...hint, marginTop: 0 }}>Who sees what at <b>{entities.find((e) => e.id === entityId)?.name || 'this client'}</b>. A set defaults to <b>Everyone</b>; pick roles to restrict it. Each dashboard can override its set. Saves immediately. (Howler staff always see everything.)</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {setIds.map((sid) => {
              const s = setById[sid];
              if (!s) return null;
              const open = !!openSets[`acc-${sid}`];
              return (
                <div key={sid} style={{ border: '1px solid var(--hairline)', borderRadius: 8, padding: '8px 10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <button onClick={() => setOpenSets((p) => ({ ...p, [`acc-${sid}`]: !p[`acc-${sid}`] }))} style={{ width: 14, border: 'none', background: 'transparent', cursor: 'pointer', color: '#b0b0b6', fontSize: 10, padding: 0, transform: open ? 'rotate(90deg)' : 'none' }}>▶</button>
                    <span style={{ fontWeight: 700, fontSize: 13, flex: '0 0 auto' }}>{s.name}</span>
                    <RoleChips value={cr.sets[sid] || []} roles={roleCat} onChange={(list) => saveScope('set', sid, list)} />
                  </div>
                  {open && (
                    <div style={{ paddingLeft: 22, marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {(s.dashboardIds || []).length === 0 ? <Muted>No dashboards in this set.</Muted>
                        : s.dashboardIds.map((did) => (
                          <div key={did} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 12, flex: '0 0 auto', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dashTitle[did] || did}</span>
                            <RoleChips value={cr.dashboards[did] || []} roles={roleCat} inherit onChange={(list) => saveScope('dashboard', did, list)} />
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}
      <Section tour="suite-locks" title="Locked filters (the event, cashless events…)" defaultOpen>
        <LockedFilterEditor value={locks} onChange={setLocks} fields={fields} categories={lockCategories} clientOrganiser={organiserValsFromLocks(entities.find((e) => e.id === entityId)?.lockedFilters)} />
      </Section>
      {includedDashboards.length > 0 && (
        <Section title="Per-dashboard locked filters (override the suite locks for one dashboard)">
          <p style={{ ...hint, marginTop: 0 }}>Lock a filter on just ONE dashboard for <b>{entities.find((e) => e.id === entityId)?.name || 'this client'}</b> — e.g. pin a specific event on a single dashboard while the rest of the suite uses the suite-wide locks above. Leave a dashboard untouched to follow those.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {includedDashboards.map((d) => {
              const open = !!openSets[`lock-${d.id}`];
              const count = Object.values(dashLocks[d.id] || {}).filter((v) => String(v || '') !== '').length;
              return (
                <div key={d.id} style={{ border: '1px solid var(--hairline)', borderRadius: 8, padding: '8px 10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button onClick={() => setOpenSets((p) => ({ ...p, [`lock-${d.id}`]: !p[`lock-${d.id}`] }))} style={{ width: 14, border: 'none', background: 'transparent', cursor: 'pointer', color: '#b0b0b6', fontSize: 10, padding: 0, transform: open ? 'rotate(90deg)' : 'none' }}>▶</button>
                    <span style={{ fontWeight: 600, fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
                    {count > 0 && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--brand)', background: 'rgba(var(--brand-rgb,255,56,92),0.10)', borderRadius: 980, padding: '2px 8px', flexShrink: 0 }}>{count} locked</span>}
                  </div>
                  {open && (
                    <div style={{ marginTop: 8 }}>
                      <LockedFilterEditor value={dashLocks[d.id] || {}} onChange={(m) => setDashLock(d.id, m)} fields={fields} categories={[]} clientOrganiser={organiserValsFromLocks(entities.find((e) => e.id === entityId)?.lockedFilters)} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}
      <div data-tour="suite-ticket" style={{ marginTop: 12 }}>
        <L>Ticket / checkout link</L>
        <div style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 6px' }}>The event's buy / checkout URL. Campaigns linked to this event auto-fill it as the call-to-action link.</div>
        <input style={{ ...input, width: '100%' }} value={eventUrl} onChange={(e) => setEventUrl(e.target.value)} placeholder="https://tickets.example.com/your-event" />
      </div>
      <div data-tour="suite-save"><SaveRow onSave={save} saved={saved} id={suite.id} /></div>
      <Section tour="suite-branding" title="Event branding (logo / colours / sender)">
        <p style={hint}>Override this <b>event's</b> look — its logo, colours and sender name — used for this event's campaigns and single-event digests, and the in-app theme while viewing it. Anything left blank inherits <b>{entities.find((e) => e.id === entityId)?.name || 'the client'}</b>'s branding. Saved on its own (separate from the suite settings above).</p>
        <MailTemplateEditor scope="admin-suite" entityId={entityId} suiteId={suite.id} />
      </Section>
    </div>
  );
}

// ─── Locked-filter editor (field → value(s)) ──────────────────────────────────
// Keeps its own row state so in-progress (empty) rows persist; pushes only
// completed rows (with a field) up to the parent as a { field: "v1,v2" } map.
// Standard locked filters for the known Howler dashboards, grouped by dashboard
// type so the picker isn't a wall of every Looker field. Source filters
// (Current/Past) auto-fill the derived comparison filters listed in `feeds`.
const LOCK_PRESETS = [
  // Event Name is the primary input — typing it cascades into Current Event and
  // the comparison filters below.
  { title: 'Event Name', category: 'Event', feeds: ['Current Event', 'Current & Past Events', 'Comparison Events'] },
  { title: 'Current Event', category: 'Event', feeds: ['Current & Past Events', 'Comparison Events'] },
  { title: 'Past Event', category: 'Event', feeds: ['Current & Past Events', 'Comparison Events'] },
  { title: 'Current & Past Events', category: 'Event' },
  { title: 'Comparison Events', category: 'Event' },
  { title: 'Event Slug', category: 'Event' }, // suggestions scoped to the chosen organiser (see orgScopeFor)
  { title: 'Organiser Name', category: 'Event' },
  { title: 'Current Cashless Event', category: 'Cashless', feeds: ['Comparison Cashless Events'] },
  { title: 'Past Cashless Event', category: 'Cashless', feeds: ['Comparison Cashless Events'] },
  { title: 'Comparison Cashless Events', category: 'Cashless' },
];
const LOCK_CATEGORIES = ['Event', 'Cashless'];
const splitVals = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const uniqJoin = (arr) => [...new Set(arr)].join(',');
// Organiser-name field matcher + extracting the organiser value(s) from a locks
// map (used to carry the client-level organiser scope into the suite editor).
const ORG_NAME_RE = /(^|[._])organiser_?name$|organisers?\.name$/i;
const organiserValsFromLocks = (locks) => Object.entries(locks || {})
  .filter(([k]) => k.toLowerCase() === 'organiser name' || ORG_NAME_RE.test(k))
  .flatMap(([, v]) => splitVals(v));

function LockedFilterEditor({ value, onChange, fields, categories, restrictTo = null, clientOrganiser = [] }) {
  // restrictTo limits the offered filters (e.g. the organiser-level editor only
  // exposes Organiser Name — scope is set once per client there).
  const PRESETS = restrictTo ? LOCK_PRESETS.filter((p) => restrictTo.includes(p.title)) : LOCK_PRESETS;
  // Resolve each preset title to the lock key as it appears in `fields` (byName
  // filters key on their name; real fields on their field id). Fallback to the
  // title so a preset still works if its field isn't in the catalogue.
  const keyByTitle = {};
  for (const f of fields) keyByTitle[(f.title || '').toLowerCase()] = f.field;
  const keyFor = (title) => keyByTitle[title.toLowerCase()] || title;
  const presets = PRESETS.map((p) => ({ ...p, key: keyFor(p.title), feedKeys: (p.feeds || []).map(keyFor) }));
  const presetByKey = Object.fromEntries(presets.map((p) => [p.key, p]));
  const presetKeys = new Set(presets.map((p) => p.key));
  // targetKey -> [feeder titles] (for the "auto-filled from …" hint)
  const fedBy = {};
  for (const p of presets) for (const tk of p.feedKeys) (fedBy[tk] = fedBy[tk] || []).push(p.title);

  // A row is { field (primary), orFields[] (extra OR fields), op, vals }. A plain
  // single-field "is" lock loads as one field with no OR fields; a combined key
  // (__or__:op:f1|f2) unpacks into primary + OR fields + operator.
  const [rows, setRows] = useState(() => Object.entries(value || {}).map(([key, vals]) => {
    const c = parseCombinedKey(key);
    return c ? { field: c.fields[0], orFields: c.fields.slice(1), op: c.op, vals } : { field: key, orFields: [], op: 'is', vals };
  }));
  // Track which categories we've already seeded so we never disturb a suite
  // that's already configured; brand-new suites seed as their types appear.
  const seeded = useRef(null);
  if (seeded.current === null) {
    const s = new Set();
    for (const p of presets) if ((value || {})[p.key] != null) s.add(p.category);
    seeded.current = s;
  }

  const push = (next) => {
    const cleaned = next.map((r) => ({ ...r, vals: uniqJoin(splitVals(r.vals)) }));
    setRows(cleaned);
    const map = {};
    for (const r of cleaned) {
      if (!r.field) continue;
      const extra = (r.orFields || []).filter(Boolean);
      // Combined (multi-field OR, or a non-"is" operator) → composite key. We store the
      // picked keys VERBATIM (byName filters keep their name) so the pickers round-trip;
      // a name is resolved to its real Looker field at apply time (per-tile via listenTo).
      // A plain single "is" field keeps its original key shape (backward compatible).
      if (extra.length || (r.op && r.op !== 'is')) {
        const key = makeCombinedKey(r.op || 'is', [r.field, ...extra]);
        if (key) map[key] = r.vals || '';
      } else {
        map[r.field] = r.vals || '';
      }
    }
    onChange(map);
  };
  const setRow = (i, patch) => {
    const before = rows[i];
    let next = rows.map((r, j) => (j === i ? { ...r, ...patch } : r));
    // A source filter gaining values also fills its comparison targets (only
    // newly-added values — manual removals on a target are left alone).
    const src = before && presetByKey[before.field];
    if (src?.feedKeys?.length && patch.vals !== undefined) {
      const added = splitVals(patch.vals).filter((v) => !splitVals(before.vals).includes(v));
      if (added.length) next = next.map((r) => (src.feedKeys.includes(r.field) ? { ...r, vals: uniqJoin([...splitVals(r.vals), ...added]) } : r));
    }
    push(next);
  };
  const addRow = () => setRows([...rows, { field: '', orFields: [], op: 'is', vals: '' }]);
  const removeRow = (i) => push(rows.filter((_, j) => j !== i));
  // Combined-field OR helpers (one value matched across several fields).
  const addOrField = (i) => setRow(i, { orFields: [...(rows[i].orFields || []), ''] });
  const setOrField = (i, k, field) => setRow(i, { orFields: (rows[i].orFields || []).map((f, j) => (j === k ? field : f)) });
  const removeOrField = (i, k) => setRow(i, { orFields: (rows[i].orFields || []).filter((_, j) => j !== k) });
  const seedDefaults = (cats, { force } = {}) => {
    const next = rows.slice(); let changed = false;
    for (const cat of cats) {
      if (!force && seeded.current.has(cat)) continue;
      seeded.current.add(cat);
      for (const p of presets.filter((x) => x.category === cat)) if (!next.some((r) => r.field === p.key)) { next.push({ field: p.key, vals: '' }); changed = true; }
    }
    if (changed) push(next);
  };
  // Seed standard filters as a suite's dashboard types appear (auto-seed on new
  // suites). The organiser-level editor passes no categories → no auto-seed.
  const catKey = (categories || []).join(',');
  useEffect(() => { if (categories && categories.length) seedDefaults(categories); }, [catKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // The organiser-level editor (restrictTo) always surfaces its preset row(s) —
  // e.g. Organiser Name — even before a value is set, so a brand-new client
  // shows the organiser picker straight away instead of an empty section.
  const restrictedKeys = restrictTo ? presets.map((p) => p.key).join('|') : '';
  useEffect(() => {
    if (!restrictTo) return;
    setRows((cur) => {
      const have = new Set(cur.map((r) => r.field));
      const add = presets.filter((p) => !have.has(p.key)).map((p) => ({ field: p.key, vals: '' }));
      return add.length ? [...cur, ...add] : cur;
    });
  }, [restrictedKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  const defModel = fields.find((f) => f.model)?.model;
  const defExplore = fields.find((f) => f.explore)?.explore;
  const otherFields = restrictTo ? [] : fields.filter((f) => !presetKeys.has(f.field));
  const showCustom = !restrictTo;
  // Selectable fields for the "OR another field" pickers (presets + other fields).
  const orFieldOptions = [
    ...presets.map((p) => ({ value: p.key, label: p.label || p.title })),
    ...otherFields.map((f) => ({ value: f.field, label: f.byName ? `${f.title} — filter` : `${f.title} (${f.field})` })),
  ];
  // Scope Event-category pickers to the chosen organiser: when Organiser Name has
  // a value, every other Event filter (Event Name, Current/Past/Comparison, Slug)
  // only suggests events for that organiser. Each explore has its own organiser
  // field — slug lives in a different explore from the organiser — so we resolve
  // the organiser field PER explore from the catalogue and filter within it.
  const orgFieldByExplore = {};
  for (const f of fields) {
    const isOrg = (f.title || '').toLowerCase() === 'organiser name' || ORG_NAME_RE.test(f.suggestField || f.field || '');
    if (!isOrg) continue;
    const ex = `${f.model || ''}::${f.explore || ''}`;
    if (!orgFieldByExplore[ex] || (f.title || '').toLowerCase() === 'organiser name') orgFieldByExplore[ex] = f.suggestField || f.field;
  }
  const orgKey = keyFor('Organiser Name');
  const orgRow = rows.find((x) => x.field === orgKey);
  // Organiser scope: a value set in THIS editor wins; otherwise fall back to the
  // client-level organiser (set in the client's Settings), so suite event pickers
  // are scoped to the client's organiser without re-entering it here.
  const orgVals = (orgRow ? splitVals(orgRow.vals) : []).length ? splitVals(orgRow.vals) : (clientOrganiser || []);
  // Warn (but don't block) when this suite sets its OWN organiser to something
  // other than the client's Settings organiser — an easy-to-miss override.
  const suiteOrgVals = orgRow ? splitVals(orgRow.vals) : [];
  const orgMismatch = (clientOrganiser || []).length > 0 && suiteOrgVals.length > 0
    && (suiteOrgVals.length !== clientOrganiser.length || suiteOrgVals.some((v) => !clientOrganiser.includes(v)));
  // The organiser filter for a target picker's explore (null if none / it IS the
  // organiser row / no organiser value set).
  const orgScopeFor = (meta, field, category) => {
    if (category !== 'Event' || field === orgKey || !orgVals.length || !meta) return null;
    const orgField = orgFieldByExplore[`${meta.model || ''}::${meta.explore || ''}`];
    return orgField ? { [orgField]: orgVals.join(',') } : null;
  };

  return (
    <div style={{ margin: '6px 0 4px' }}>
      {orgMismatch && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 11px', margin: '0 0 10px', borderRadius: 9, background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.35)', fontSize: 12, color: 'var(--text)', lineHeight: 1.45 }}>
          <span style={{ flexShrink: 0 }}>⚠️</span>
          <span>This suite's <b>Organiser Name</b> ({suiteOrgVals.join(', ')}) differs from the client's Settings organiser ({(clientOrganiser || []).join(', ')}). The suite value overrides it here — make sure that's intended.</span>
        </div>
      )}
      {/* One filter per row, stacked. */}
      <div>
        {rows.map((r, i) => {
          const known = fields.find((f) => f.field === r.field);
          const isCustom = r.custom || (!!r.field && !known && !presetByKey[r.field]);
          const meta = known
            ? { field: known.suggestField || known.field, model: known.model, explore: known.explore }
            : (r.field ? { field: r.field, model: defModel, explore: defExplore } : null);
          const preset = presetByKey[r.field];
          const orgScope = orgScopeFor(meta, r.field, preset?.category);
          return (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <select
                  style={{ ...input, minWidth: 240 }}
                  value={isCustom ? '__custom' : r.field}
                  onChange={(e) => (e.target.value === '__custom' ? setRow(i, { custom: true, field: '' }) : setRow(i, { custom: false, field: e.target.value }))}
                >
                  <option value="">Choose a filter…</option>
                  {LOCK_CATEGORIES.filter((cat) => presets.some((p) => p.category === cat)).map((cat) => (
                    <optgroup key={cat} label={cat}>
                      {presets.filter((p) => p.category === cat).map((p) => <option key={p.key} value={p.key}>{p.label || p.title}{p.feeds ? ' →' : ''}</option>)}
                    </optgroup>
                  ))}
                  {otherFields.length > 0 && (
                    <optgroup label="Other fields">
                      {otherFields.map((f) => <option key={f.field} value={f.field}>{f.byName ? `${f.title} — filter` : `${f.title} (${f.field})`}</option>)}
                    </optgroup>
                  )}
                  {showCustom && <option value="__custom">✎ Custom field…</option>}
                </select>
                {isCustom && (
                  <input
                    style={{ ...input, minWidth: 220 }}
                    value={r.field}
                    onChange={(e) => setRow(i, { field: e.target.value, custom: true })}
                    placeholder="Looker field, e.g. core_events.is_past"
                  />
                )}
                {/* Combined-field OR (not on preset/organiser rows — those have their
                    own event-combo machinery). ONE operator + ONE value below apply
                    to the primary field AND every OR field, matched with OR logic. */}
                {!restrictTo && !preset && (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <select style={{ ...input, minWidth: 96 }} value={r.op || 'is'} onChange={(e) => setRow(i, { op: e.target.value })} title="How the value is matched across the field(s)">
                      <option value="is">Is</option>
                      <option value="is_not">Is not</option>
                      <option value="contains">Contains</option>
                    </select>
                    {(r.orFields || []).map((of, k) => (
                      <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--brand)' }}>OR</span>
                        <select style={{ ...input, minWidth: 200 }} value={of} onChange={(e) => setOrField(i, k, e.target.value)}>
                          <option value="">Choose a field…</option>
                          {orFieldOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                        <button style={{ ...delBtn, padding: '0 4px' }} onClick={() => removeOrField(i, k)} title="Remove this OR field">✕</button>
                      </span>
                    ))}
                    <button style={miniBtn} onClick={() => addOrField(i)} title="Match this value across another field too (OR)">＋ OR field</button>
                  </div>
                )}
                {(r.orFields || []).filter(Boolean).length > 0 && <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>↳ one value, matched across {1 + (r.orFields || []).filter(Boolean).length} fields (OR)</span>}
                {fedBy[r.field] && <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>↳ auto-filled from {fedBy[r.field].join(' + ')} (editable)</span>}
                {preset?.feeds && <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>also fills {preset.feeds.join(', ')}</span>}
                {orgScope && <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>↳ showing only {orgVals.join(', ')} events</span>}
              </div>
              <ValuePicker meta={meta} value={r.vals} extraFilters={orgScope} onChange={(v) => setRow(i, { vals: v })} />
              <button style={delBtn} onClick={() => removeRow(i)} title="Remove">✕</button>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
        <button style={miniBtn} onClick={addRow}>+ Add locked filter</button>
        {!restrictTo && <button style={miniBtn} onClick={() => seedDefaults(categories && categories.length ? categories : LOCK_CATEGORIES, { force: true })}>+ Add default filters</button>}
      </div>
    </div>
  );
}

// Value picker for a locked filter: selected values shown as chips, plus a
// search box that queries Looker server-side (works with thousands of values).
function ValuePicker({ meta, value, onChange, extraFilters = null }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const selected = String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
  const canSuggest = !!(meta && meta.model && meta.explore);

  // Debounced server search whenever the box is open and the term changes.
  useEffect(() => {
    if (!open || !canSuggest) return;
    let alive = true;
    setLoading(true);
    const t = setTimeout(async () => {
      try { const d = await api.filterSuggest({ model: meta.model, explore: meta.explore, field: meta.field, q, pair: true, filters: extraFilters || undefined }); if (alive) setResults(d.suggestions || []); }
      catch { if (alive) setResults([]); }
      finally { if (alive) setLoading(false); }
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [q, open, canSuggest, meta, JSON.stringify(extraFilters)]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = (s) => { if (s && !selected.includes(s)) onChange([...selected, s].join(',')); };
  const remove = (s) => onChange(selected.filter((x) => x !== s).join(','));
  const toggle = (s) => (selected.includes(s) ? remove(s) : add(s));
  // Results may be plain strings or { value, label } pairs (organiser/event).
  const norm = (s) => (typeof s === 'string' ? { value: s, label: s } : s);

  return (
    <div style={{ position: 'relative', flex: '1 1 280px', minWidth: 240 }}>
      {selected.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          {selected.map((s) => (
            <span key={s} style={chip}>{s}<span style={{ cursor: 'pointer', fontWeight: 700 }} onClick={() => remove(s)}> ✕</span></span>
          ))}
        </div>
      )}
      <input
        style={{ ...input, width: '100%' }}
        value={q}
        onChange={(e) => { setQ(e.target.value); if (!open) setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) { add(q.trim()); setQ(''); } }}
        placeholder={canSuggest ? 'Search values…' : 'Type value(s), Enter to add'}
      />
      {open && (
        <ul style={ddList}>
          {!canSuggest ? (
            <li style={ddMuted}>Type a value and press Enter</li>
          ) : loading ? (
            <li style={ddMuted}>Searching…</li>
          ) : results.length === 0 ? (
            <li style={ddMuted}>{q ? 'No matches — press Enter to use as typed' : 'Type to search…'}</li>
          ) : (
            results.map((raw, i) => {
              const o = norm(raw);
              const on = selected.includes(o.value);
              return (
                <li key={i} style={ddItem} onMouseDown={(e) => { e.preventDefault(); toggle(o.value); }}>
                  <span style={{ color: on ? 'var(--brand)' : '#bbb' }}>{on ? '☑' : '☐'}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.label}</span>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}

// ─── Small shared bits ────────────────────────────────────────────────────────
function flash(setSaved) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
// Shared back affordance for the admin console's drill-downs (client / user
// detail, add-user). Sticky so it stays reachable down a long detail page, and a
// round chevron + label to match the back buttons everywhere else in the app.
function AdminBack({ onBack, children }) {
  return (
    <div style={{ position: 'sticky', top: 0, zIndex: 6, background: 'var(--bg)', padding: '6px 0 8px', margin: '-6px 0 4px' }}>
      <button style={adminBackBtn} onClick={onBack}>
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
        {children}
      </button>
    </div>
  );
}
const adminBackBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px 7px 10px', background: 'var(--card)', border: '1.5px solid var(--hairline)', borderRadius: 980, fontWeight: 600, fontSize: 13, cursor: 'pointer', color: 'var(--text)' };
function Row({ children }) { return <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10 }}>{children}</div>; }
function SaveRow({ onSave, saved, id }) {
  return (
    <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
      <button style={saveBtn} onClick={onSave}>Save</button>
      {saved && <SavedChip />}
      <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 'auto' }}>id: {id.slice(0, 8)}</span>
    </div>
  );
}
// "Saved" with a checkmark that draws itself on.
function SavedChip() {
  return (
    <span className="saved-chip" style={{ color: 'var(--success)', fontSize: 13, fontWeight: 600 }}>
      <svg className="check-anim" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
      Saved
    </span>
  );
}
// ─── Tile library ─────────────────────────────────────────────────────────────
// Tiles harvested from imported dashboards. Curate their label, description and
// category (optionally with AI) so they can be reused when building dashboards.
function Library() {
  const [tiles, setTiles] = useState([]);
  const [categories, setCategories] = useState([]);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [loading, setLoading] = useState(true);
  const [backfilling, setBackfilling] = useState(false);

  const load = () => {
    setLoading(true);
    api.libraryList({ search, category })
      .then((r) => { setTiles(r.tiles || []); setCategories(r.categories || []); setAiEnabled(!!r.aiEnabled); })
      .finally(() => setLoading(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [search, category]);

  async function backfill() {
    setBackfilling(true);
    try { const r = await api.libraryBackfill(); alert(`Harvested ${r.added} new tile(s) from ${r.scanned} dashboard(s).`); load(); }
    catch (e) { alert('Harvest failed: ' + e.message); }
    finally { setBackfilling(false); }
  }

  return (
    <div>
      <p style={hint}>Every visualization imported from Looker is catalogued here. Label what each tile is and what it’s used for — these become reusable building blocks in the dashboard editor (“+ From library”).</p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tiles…" style={{ ...input, minWidth: 220 }} />
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={input}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <div style={{ flex: 1 }} />
        <button style={addBtn} onClick={backfill} disabled={backfilling}>{backfilling ? 'Harvesting…' : '↻ Harvest existing dashboards'}</button>
      </div>
      {loading ? <Muted>Loading…</Muted>
        : tiles.length === 0 ? <Muted>No tiles yet. Import a dashboard, or harvest your existing dashboards above.</Muted>
        : tiles.map((t) => <LibraryRow key={t.id} tile={t} aiEnabled={aiEnabled} onSaved={load} onDeleted={load} />)}
    </div>
  );
}

function LibraryRow({ tile, aiEnabled, onSaved, onDeleted }) {
  const [name, setName] = useState(tile.name);
  const [description, setDescription] = useState(tile.description);
  const [category, setCategory] = useState(tile.category);
  const [busy, setBusy] = useState(false);
  const dirty = name !== tile.name || description !== tile.description || category !== tile.category;

  async function save() {
    setBusy(true);
    try { await api.libraryUpdate(tile.id, { name, description, category }); onSaved(); }
    catch (e) { alert('Save failed: ' + e.message); }
    finally { setBusy(false); }
  }
  async function describe() {
    setBusy(true);
    try {
      const r = await api.libraryDescribe(tile.id);
      setName(r.name); setDescription(r.description); setCategory(r.category);
      onSaved();
    } catch (e) { alert('AI describe failed: ' + e.message); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!confirm('Remove this tile from the library?')) return;
    await api.libraryDelete(tile.id); onDeleted();
  }

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ ...chip, background: 'rgba(0,0,0,0.05)', color: 'var(--muted)' }}>{tile.visType || 'vis'}</span>
        {tile.fieldsSummary && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{tile.fieldsSummary}</span>}
        <div style={{ flex: 1 }} />
        {tile.usageCount > 0 && <span style={{ fontSize: 11, color: 'var(--muted)' }}>used {tile.usageCount}×</span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: 10 }}>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} style={{ ...input, minWidth: 0, width: '100%' }} /></Field>
        <Field label="Category"><input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Revenue" style={{ ...input, minWidth: 0, width: '100%' }} /></Field>
      </div>
      <div style={{ marginTop: 10 }}>
        <Field label="What it is / used for">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} style={{ ...input, minWidth: 0, width: '100%', resize: 'vertical', fontFamily: 'inherit' }} />
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        {aiEnabled && <button style={miniBtn} onClick={describe} disabled={busy}>{busy ? '…' : '✨ Describe with AI'}</button>}
        <div style={{ flex: 1 }} />
        <button style={delBtn} onClick={remove} disabled={busy}>Delete</button>
        <button style={saveBtn} onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

// ─── Global AI instructions ───────────────────────────────────────────────────
// One set of standing instructions appended to every AI prompt (tile insights,
// dashboard summary, tile-library descriptions).
// Owner-only control (Admin → AI) to switch the native Owl on for other users —
// for everyone, or a specific allowlist. Renders nothing for anyone but the owner.
function OwlAccessCard() {
  const { user } = useAuth();
  const [cfg, setCfg] = useState(null);
  const [emailsText, setEmailsText] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!user?.owlOwner) return;
    api.getOwlAccess().then((c) => { setCfg(c); setEmailsText((c.emails || []).join('\n')); }).catch(() => {});
  }, [user]);
  if (!user?.owlOwner || !cfg) return null;
  const setAccess = async (access) => {
    setBusy(true);
    try { const c = await api.saveOwlAccess({ access }); setCfg((p) => ({ ...p, ...c })); } catch { /* ignore */ } finally { setBusy(false); }
  };
  const saveEmails = async () => {
    setBusy(true);
    try {
      const emails = emailsText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      const c = await api.saveOwlAccess({ emails });
      setCfg((p) => ({ ...p, ...c })); setEmailsText((c.emails || []).join('\n')); flash(setSaved);
    } catch { /* ignore */ } finally { setBusy(false); }
  };
  const allOn = cfg.access === 'all';
  return (
    <Section title="🦉 Owl access (owner only)">
      <p style={hint}>Control who can use the native Owl chat. Only you ({cfg.owner}) can change this. Switch it on for everyone, or list specific emails to roll it out to a test group first.</p>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '10px 0 14px', cursor: busy ? 'default' : 'pointer' }}>
        <input type="checkbox" checked={allOn} disabled={busy} onChange={(e) => setAccess(e.target.checked ? 'all' : 'off')} />
        <span style={{ fontSize: 14, fontWeight: 600 }}>Enable the Owl for everyone</span>
      </label>
      <div style={{ opacity: allOn ? 0.45 : 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>…or just these emails{allOn ? ' (ignored while it’s on for everyone)' : ''}</div>
        <textarea value={emailsText} onChange={(e) => setEmailsText(e.target.value)} rows={4} placeholder={'one email per line\ne.g. sam@howler.co.za'}
          style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
          <button style={saveBtn} onClick={saveEmails} disabled={busy}>Save list</button>
          {saved && <SavedChip />}
        </div>
      </div>
    </Section>
  );
}

function AISettings() {
  const [text, setText] = useState('');
  const [orig, setOrig] = useState('');
  const [aiEnabled, setAiEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api.getAiInstructions().then((r) => { setText(r.instructions || ''); setOrig(r.instructions || ''); setAiEnabled(!!r.aiEnabled); }).finally(() => setLoading(false));
  }, []);
  const save = async () => { const r = await api.saveAiInstructions(text); setOrig(r.instructions || ''); flash(setSaved); };
  if (loading) return <Muted>Loading…</Muted>;
  return (
    <div>
      <OwlAccessCard />
      <p style={hint}>Standing instructions added to every AI prompt — tile insights, the dashboard summary, and tile-library descriptions. Use it for terminology, tone, comparison rules, and anything the AI should always know or avoid.</p>
      {!aiEnabled && <p style={{ color: 'var(--warn, #b45309)', fontSize: 13, marginBottom: 10 }}>⚠ AI is not configured (set ANTHROPIC_API_KEY) — instructions are saved but won't be used until it is.</p>}
      <Section title="Global AI instructions">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={12}
          placeholder={"e.g.\n- All amounts are in South African Rand (ZAR).\n- Always compare against the previous event when a comparison is available.\n- Be concise and avoid speculation; flag implausible figures.\n- Refer to attendees, organisers, and events using Howler terminology."}
          style={{ width: '100%', boxSizing: 'border-box', marginTop: 6, padding: '10px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <button style={saveBtn} onClick={save} disabled={text === orig}>Save</button>
          {saved && <SavedChip />}
          <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>{text.length} characters</span>
        </div>
      </Section>
      <Section title="Owl guidance (chat assistant)">
        <p style={hint}>Steers the agentic Owl (the data chat assistant) — how it should read your data: which measure to use, how to split add-ons, what “revenue”/“today” mean. Separate from the instructions above (which drive tile insights & briefings). Takes effect immediately.</p>
        <OwlGuidanceEditor scope="global" />
      </Section>
      <Section title="Owl field dictionary">
        <OwlFieldDictionary />
      </Section>
      <Section title="Owl data catalogue (what the Owl can read)">
        <OwlCatalogue />
      </Section>
      <Section title="Owl memory (per client)">
        <OwlMemoryEditor />
      </Section>
      <Section title="WhatsApp Owl (beta)">
        <WhatsAppOwl />
      </Section>
      <Section title="Organizer portal Owl (pilot)">
        <OwlEmbedAdmin />
      </Section>
      <Section title="Home briefing"><BriefingSettings /></Section>
      <Section title="Reader feedback"><BriefingFeedback /></Section>
      <Section title="Everything the AI is told (audit)"><AIOverview /></Section>
    </div>
  );
}

// Read-only audit of every AI instruction across the platform: the hardcoded
// system prompts + role lenses (code), the resolved briefing defaults, and every
// configured layer (global, per-client, per-event, per-digest, per-reader,
// per-tile). One screen to see exactly what the AI is told everywhere.
function AIOverview() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.getAiOverview().then(setD).catch((e) => setErr(e.message)); }, []);
  if (err) return <Muted>Could not load: {err}</Muted>;
  if (!d) return <Muted>Loading…</Muted>;
  const pre = { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11.5, lineHeight: 1.5, fontFamily: 'ui-monospace, Menlo, monospace', background: 'var(--bg, #f6f6f7)', border: '1px solid var(--hairline)', borderRadius: 8, padding: '8px 10px', margin: '4px 0 0', color: 'var(--text)' };
  const grp = { border: '1px solid var(--hairline)', borderRadius: 10, padding: '4px 12px', marginBottom: 8, background: 'var(--card)' };
  const sum = { cursor: 'pointer', padding: '8px 2px', fontSize: 13, fontWeight: 700, color: 'var(--text)' };
  const lbl = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '12px 0 4px' };
  const meta = { fontSize: 11, color: 'var(--muted)' };
  const Item = ({ title, scope, text }) => (
    <details style={grp}><summary style={sum}>{title}{scope ? <span style={{ ...meta, fontWeight: 400 }}> — {scope}</span> : null}</summary><pre style={pre}>{text || '—'}</pre></details>
  );
  // Each top-level group is collapsible and collapsed by default — the audit is
  // long, so you open only the layer you're inspecting.
  const Sec = ({ title, count, children }) => (
    <details style={{ ...grp, padding: '0 12px' }}>
      <summary style={{ ...sum, padding: '11px 2px' }}>{title}{count != null ? <span style={{ ...meta, fontWeight: 400 }}> ({count})</span> : null}</summary>
      <div style={{ padding: '2px 0 12px' }}>{children}</div>
    </details>
  );
  return (
    <div>
      <p style={hint}>Read-only. The runtime prompt for any feature = its built-in system prompt + the global instructions + the matching client / event / reader layers. Built-in prompts are edited in code (<code>server/insights.js</code>, <code>server/index.js</code>); everything else is editable in the screens noted. Sections are collapsed — open the one you need.</p>

      <Sec title="Built-in system prompts (code)" count={d.builtins.systemPrompts.length}>
        {d.builtins.systemPrompts.map((p) => <Item key={p.key} title={p.label} scope={p.scope} text={p.text} />)}
      </Sec>

      <Sec title="Resolved prompt — exactly what's sent for a feature">
        <ResolvedPromptTool features={d.builtins.systemPrompts} clients={d.clients} roles={d.builtins.roleLenses} preStyle={pre} />
      </Sec>

      <Sec title="Role lenses (code) — personalise every briefing & digest" count={d.builtins.roleLenses.length}>
        {d.builtins.roleLenses.map((r) => <Item key={r.key} title={r.label} text={r.focus} />)}
      </Sec>

      <Sec title="Briefing phase & time-of-day defaults">
        {d.builtins.phaseDefaults.map((p) => <Item key={p.key} title={`${p.label}${p.overridden ? ' • overridden' : ' • code default'}`} text={p.text} />)}
        {d.builtins.timeDefaults.map((t) => <Item key={t.key} title={`${t.label}${t.overridden ? ' • overridden' : ' • code default'}`} text={t.text} />)}
      </Sec>

      <Sec title="Global instructions (Admin → AI)">
        <Item title="Global AI instructions" scope="appended to every AI prompt" text={d.global.aiInstructions} />
        <Item title="Global briefing rules" scope="home briefing & digests" text={d.global.briefingInstructions} />
        {d.owlGuidanceGlobal && <Item title="Owl guidance — house rules" scope="agentic Owl (data chat)" text={d.owlGuidanceGlobal} />}
      </Sec>

      <Sec title="Per-client (Admin → Clients → [client])" count={d.clients.length}>
        {d.clients.map((c) => {
          const has = c.aiContext || c.owlGuidance || c.events.length || c.digests.length || c.readerTunes.length;
          return (
            <details key={c.id} style={grp}>
              <summary style={sum}>{c.name}{!has ? <span style={{ ...meta, fontWeight: 400 }}> — no custom AI instructions</span> : null}</summary>
              {c.aiContext && (<><div style={lbl}>Client AI context</div><pre style={pre}>{c.aiContext}</pre></>)}
              {c.owlGuidance && (<><div style={lbl}>Owl guidance (data chat)</div><pre style={pre}>{c.owlGuidance}</pre></>)}
              {c.events.map((e, i) => (
                <div key={i}>
                  <div style={lbl}>Event: {e.suiteName}{e.phase ? ` — phase: ${e.phase}` : ''}{e.eventStart ? ` (${e.eventStart}${e.eventEnd ? `–${e.eventEnd}` : ''})` : ''}</div>
                  {e.instructions && <pre style={pre}>{e.instructions}</pre>}
                  {e.phaseOverrides.map((po, j) => <pre key={j} style={pre}>[{po.phase}] {po.text}</pre>)}
                </div>
              ))}
              {c.digests.length > 0 && <div style={lbl}>Digest focuses</div>}
              {c.digests.map((j, i) => (
                <pre key={i} style={pre}>{`${j.title || j.role} [${j.role}]`}{j.roleFocus ? `\nfocus (${j.focusMode}): ${j.roleFocus}` : ''}{j.customMessage ? `\nnote: ${j.customMessage}` : ''}{!j.roleFocus && !j.customMessage ? '\n(role lens only)' : ''}</pre>
              ))}
              {c.readerTunes.length > 0 && <div style={lbl}>Reader tunes (personal standing requests)</div>}
              {c.readerTunes.map((t, i) => <pre key={i} style={pre}>{`${t.email}:\n${t.tune}`}</pre>)}
            </details>
          );
        })}
      </Sec>

      <Sec title="Dashboard AI context" count={d.dashContexts.length}>
        {d.dashContexts.map((x, i) => <Item key={i} title={x.dashTitle} text={x.context} />)}
      </Sec>
      <Sec title="Tile AI context" count={d.tileContexts.length}>
        {d.tileContexts.map((x, i) => <Item key={i} title={`${x.dashTitle} › ${x.tileTitle}`} text={x.context} />)}
      </Sec>
    </div>
  );
}

// Composes the literal prompt sent for one feature (built-in + the resolved
// configured layers) for a chosen client/role — so you can see/copy exactly what
// the AI gets, e.g. for a specific client's digest.
function ResolvedPromptTool({ features, clients, roles, preStyle }) {
  const [feature, setFeature] = useState('digest');
  const [entityId, setEntityId] = useState(clients[0]?.id || '');
  const [role, setRole] = useState('exec');
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const needsClient = ['tile', 'dashboard', 'home', 'digest'].includes(feature);
  const needsRole = ['home', 'digest'].includes(feature);
  const resolve = async () => {
    setBusy(true); setCopied(false);
    try { setOut(await api.getResolvedPrompt({ feature, entityId: needsClient ? entityId : null, role: needsRole ? role : null })); }
    catch (e) { setOut({ text: 'Could not resolve: ' + e.message, note: '' }); }
    finally { setBusy(false); }
  };
  const copy = () => { if (out?.text && navigator.clipboard) navigator.clipboard.writeText(out.text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); };
  const sel = { padding: '6px 9px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 12.5, background: 'var(--card)', color: 'var(--text)' };
  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 10, padding: 12, marginBottom: 8, background: 'var(--card)' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select style={sel} value={feature} onChange={(e) => setFeature(e.target.value)}>{features.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select>
        {needsClient && <select style={sel} value={entityId} onChange={(e) => setEntityId(e.target.value)}>{clients.length === 0 && <option value="">No clients</option>}{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
        {needsRole && <select style={sel} value={role} onChange={(e) => setRole(e.target.value)}>{roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select>}
        <button style={saveBtn} onClick={resolve} disabled={busy || (needsClient && !entityId)}>{busy ? 'Resolving…' : 'Resolve'}</button>
        {out && <button style={miniBtn} onClick={copy}>{copied ? '✓ Copied' : 'Copy'}</button>}
      </div>
      {out?.note && <p style={{ fontSize: 11, color: 'var(--muted)', margin: '8px 0 0' }}>{out.note}</p>}
      {out && <pre style={preStyle}>{out.text}</pre>}
    </div>
  );
}

// Reader reactions to home briefings — the Investigate items are requests for
// Howler to dig into the data; resolve them once handled. With `entityId` the
// list scopes to one client (embedded in the client's Briefing section).
function BriefingFeedback({ entityId = null }) {
  const [items, setItems] = useState(null);
  const [filter, setFilter] = useState('open'); // open | investigate | all
  const load = () => { api.adminListBriefingFeedback().then(setItems).catch(() => setItems([])); };
  // NB: don't pass `load` straight to useEffect — returning a promise makes
  // React call it as a cleanup fn on unmount ("x is not a function" crash).
  useEffect(() => { load(); }, []);
  if (!items) return null;
  const scoped = entityId ? items.filter((f) => f.entityId === entityId) : items;
  const shown = scoped.filter((f) =>
    filter === 'all' ? true : filter === 'investigate' ? f.kind === 'investigate' : f.status === 'new');
  const ICON = { like: '♥', dislike: '👎', investigate: '🔍' };
  if (entityId && scoped.length === 0) return null;
  return (
    <div style={{ ...cardStyle, marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <L>Briefing feedback</L>
        <span style={{ flex: 1 }} />
        {[['open', 'Open'], ['investigate', 'Investigate'], ['all', 'All']].map(([k, label]) => (
          <button key={k} onClick={() => setFilter(k)} style={{ ...miniBtnOutline, ...(filter === k ? { background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' } : null) }}>{label}</button>
        ))}
      </div>
      {shown.length === 0 ? (
        <Muted>{filter === 'open' ? 'No open feedback.' : 'Nothing here yet.'}</Muted>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shown.map((f) => (
            <div key={f.id} style={{ border: '1px solid var(--hairline)', borderRadius: 10, padding: '10px 12px', opacity: f.status === 'resolved' ? 0.55 : 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                <span style={{ fontSize: 14 }}>{ICON[f.kind] || '•'}</span>
                <b>{f.entityName || '—'}</b>
                <span style={{ color: 'var(--muted)' }}>{f.userEmail}</span>
                <span style={{ color: 'var(--muted)' }}>· {new Date(f.createdAt).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                <span style={{ flex: 1 }} />
                {f.status === 'new'
                  ? <button style={miniBtnOutline} onClick={() => api.adminResolveBriefingFeedback(f.id, 'resolved').then(load)}>Resolve</button>
                  : <span style={{ fontSize: 11, fontWeight: 700, color: '#2da44e' }}>✓ Resolved</span>}
              </div>
              {f.comment && <div style={{ fontSize: 13, marginTop: 6, whiteSpace: 'pre-wrap' }}>{f.comment}</div>}
              {f.briefing?.headline && (
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6, fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  re: “{f.briefing.headline.replace(/\*\*/g, '')}”
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Global home-briefing rules + the editable per-phase default instructions.
// Clients can override any phase per event from their briefing Tune panel.
function BriefingSettings() {
  const [data, setData] = useState(null);
  const [instructions, setInstructions] = useState('');
  const [defaults, setDefaults] = useState({});
  const [timeDefs, setTimeDefs] = useState({});
  const [openPhase, setOpenPhase] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api.getBriefingSettings().then((r) => { setData(r); setInstructions(r.instructions || ''); setDefaults(r.phaseDefaults || {}); setTimeDefs(r.timeDefaults || {}); });
  }, []);
  if (!data) return null;
  const save = async () => { await api.saveBriefingSettings({ instructions, phaseDefaults: defaults, timeDefaults: timeDefs }); flash(setSaved); };
  return (
    <div style={{ ...cardStyle, marginTop: 6 }}>
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 8px' }}>
        Rules for the Owl's home-page briefing, plus the default instruction for each event phase.
        The phase is picked automatically from each event's dates (set in the client's briefing panel); clients can override any phase's wording for their event.
      </p>
      <textarea
        value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={4}
        placeholder={'e.g.\n- Lead with money, then tickets.\n- Always name the ticket tier driving change.\n- Never speculate about causes you can\'t see in the data.'}
        style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
      />
      <div style={{ marginTop: 12 }}>
        <L>Time of day</L>
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 6px' }}>The reader's local time shapes the angle: morning recaps, midday tracks today, evening wraps the day.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(data.times || []).map((t) => (
            <div key={t.key}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 3 }}>{t.label}
                {(timeDefs[t.key] || '') !== (data.builtInTimes?.[t.key] || '') && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--brand)', marginLeft: 6 }}>edited</span>}
              </div>
              <textarea
                value={timeDefs[t.key] || ''} onChange={(e) => setTimeDefs({ ...timeDefs, [t.key]: e.target.value })} rows={2}
                style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 12.5, outline: 'none', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
              />
            </div>
          ))}
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <L>Phase defaults</L>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
          {data.phases.map((p) => (
            <div key={p.key} style={{ border: '1px solid var(--hairline)', borderRadius: 9, overflow: 'hidden' }}>
              <button onClick={() => setOpenPhase(openPhase === p.key ? null : p.key)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', border: 'none', background: 'var(--elevated)', cursor: 'pointer', fontSize: 13, fontWeight: 700, color: 'var(--text)', textAlign: 'left' }}>
                <span style={{ width: 12, fontSize: 9, color: 'var(--muted)', transform: openPhase === p.key ? 'rotate(90deg)' : 'none' }}>▶</span>
                {p.label}
                {(defaults[p.key] || '') !== (data.builtIn?.[p.key] || '') && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--brand)', marginLeft: 6 }}>edited</span>}
              </button>
              {openPhase === p.key && (
                <div style={{ padding: 10 }}>
                  <textarea
                    value={defaults[p.key] || ''} onChange={(e) => setDefaults({ ...defaults, [p.key]: e.target.value })} rows={3}
                    style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 12.5, outline: 'none', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
                  />
                  {(defaults[p.key] || '') !== (data.builtIn?.[p.key] || '') && (
                    <button style={{ ...miniBtnOutline, marginTop: 6 }} onClick={() => setDefaults({ ...defaults, [p.key]: data.builtIn?.[p.key] || '' })}>Reset to built-in</button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
        <button style={saveBtn} onClick={save}>Save briefing settings</button>
        {saved && <SavedChip />}
      </div>
    </div>
  );
}

// ─── Email audit: everything sent + what's scheduled next ──────────────────────
function MailLog() {
  return (
    <div>
      <p style={hint}>Every email the platform sends — notifications, digests, campaigns, tests — and what's scheduled to go out next.</p>
      <MailLogView load={(params) => api.getMailLog(params)} showClient />
    </div>
  );
}

// ─── Integrations (admin: primary Looker + Anthropic accounts) ─────────────────
// Reusable Inventive workspaces: create once (name + reference), link users on
// their profile (Admin → Users → Edit). One workspace can be shared by many users.
function InventiveWorkspaces() {
  const [items, setItems] = useState(null);
  const [draft, setDraft] = useState({ name: '', refId: '' });
  const [editId, setEditId] = useState(null);
  const [edit, setEdit] = useState({ name: '', refId: '' });
  const load = () => api.adminListInventiveWorkspaces().then(setItems).catch(() => setItems([]));
  useEffect(() => { load(); }, []);
  const add = async () => { if (!draft.name.trim()) return; await api.adminCreateInventiveWorkspace(draft); setDraft({ name: '', refId: '' }); load(); };
  const saveEdit = async () => { await api.adminUpdateInventiveWorkspace(editId, edit); setEditId(null); load(); };
  const del = async (w) => { if (confirm(`Delete workspace "${w.name || '(unnamed)'}"? ${w.userCount} linked user${w.userCount === 1 ? '' : 's'} will be unlinked.`)) { await api.adminDeleteInventiveWorkspace(w.id); load(); } };
  if (!items) return <Muted>Loading…</Muted>;
  return (
    <div>
      <p style={hint}>Create one workspace per provisioned Inventive workspace (name + reference), then link users to it on each user's profile (Admin → Users → Edit). Many users can share one workspace.</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
        <Field label="Name"><input style={input} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Movement Entertainment" /></Field>
        <Field label="Reference (externalRefId)"><input style={{ ...input, fontFamily: 'monospace', fontSize: 12, minWidth: 280 }} value={draft.refId} onChange={(e) => setDraft({ ...draft, refId: e.target.value })} placeholder="workspace ref / UUID" /></Field>
        <button style={miniBtn} onClick={add} disabled={!draft.name.trim()}>+ Add workspace</button>
      </div>
      {items.length === 0 ? <Muted>No workspaces yet.</Muted> : (
        <div style={{ border: '1px solid var(--hairline)', borderRadius: 10, overflow: 'hidden' }}>
          {items.map((w) => (
            <div key={w.id} style={{ borderBottom: '1px solid var(--hairline)', padding: '8px 10px' }}>
              {editId === w.id ? (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input style={{ ...input, flex: 1, minWidth: 140 }} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                  <input style={{ ...input, flex: 1, minWidth: 200, fontFamily: 'monospace', fontSize: 12 }} value={edit.refId} onChange={(e) => setEdit({ ...edit, refId: e.target.value })} />
                  <button style={miniBtn} onClick={saveEdit}>Save</button>
                  <button style={miniBtnOutline} onClick={() => setEditId(null)}>Cancel</button>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600, minWidth: 0 }}>{w.name || '(unnamed)'}</span>
                  <code style={{ fontSize: 11.5, color: 'var(--muted)', background: 'rgba(128,128,128,0.12)', padding: '2px 7px', borderRadius: 6, userSelect: 'all' }}>{w.refId || '—'}</code>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{w.userCount} user{w.userCount === 1 ? '' : 's'}</span>
                  <span style={{ flex: 1 }} />
                  <button style={miniBtnOutline} onClick={() => { setEditId(w.id); setEdit({ name: w.name, refId: w.refId }); }}>Edit</button>
                  <button style={delBtn} onClick={() => del(w)}>Delete</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AdminIntegrations() {
  const [value, setValue] = useState(null);
  const [clients, setClients] = useState([]);
  useEffect(() => { api.getAdminIntegrations().then(setValue); }, []);
  useEffect(() => { api.adminListEntities().then((e) => setClients((e || []).map((x) => ({ id: x.id, name: x.name })))).catch(() => {}); }, []);
  if (!value) return <Muted>Loading…</Muted>;
  return (
    <div>
      <p style={hint}>Accounts (Looker · Anthropic · Email · <b>Inventive</b>) is open below; other sections are collapsed — tap to open. Accounts override the values in <code>.env</code>; clients can set their own Looker/Anthropic (Client → Integrations), which take precedence for their data.</p>
      <Section title="🔑 Accounts — Looker · Anthropic · Email · Inventive">
        <IntegrationsForm value={value} collapsible showResend showInventive clients={clients} canManageLock lockableKeys={['looker', 'anthropic', 'resend', 'inventive']} locks={value.locks || {}} onToggleLock={async (k, locked) => setValue(await api.setAdminIntegrationLock(k, locked))} onTestEmail={() => api.sendMailTest()} onSave={async (p) => setValue(await api.saveAdminIntegrations(p))} />
      </Section>
      <Section title="✨ Inventive workspaces">
        <InventiveWorkspaces />
      </Section>
      <Section title="◇ Audience sync — connector health">
        <p style={hint}>Per-client status of the Meta / TikTok audience syncs: which clients are connected, how many audiences are live, and any recent failures. Drill into a client to see each segment's audience.</p>
        <AudienceSyncHealth />
      </Section>
      <Section title="📧 Email template — platform default">
        <p style={hint}>The default look of every notification email. Each client can layer their own branding on top (Client → Email branding).</p>
        <MailTemplateEditor scope="platform" canTest />
      </Section>
      <Section title="💬 SMS (Clickatell)">
        <p style={hint}>Your Clickatell One API key powers SMS campaigns. The key is write-only — we only show whether it's set. Sender ID is your approved alphanumeric ID (e.g. a short brand name) or number.</p>
        <SmsConfig />
      </Section>
      <Section title="🔔 Notifications">
        <p style={hint}>How push reminders behave platform-wide.</p>
        <NotificationSettings />
      </Section>
      <Section title="🦉 Inbound email — CC the Owl">
        <p style={hint}>Lets emails be captured into client inboxes by CC’ing a per-client address. Set the inbound domain, then point your mail forwarder at the webhook below.</p>
        <InboundConfig />
      </Section>
      <Section title="📥 Owl auto-ingest — settlements & invoices">
        <p style={hint}>When a PDF settlement or invoice is CC’d to a client’s Owl address from a trusted sender, the Owl extracts it, cross-checks the totals, and auto-publishes it — or holds a draft for review if the numbers don’t reconcile.</p>
        <OwlIngestConfig />
      </Section>
    </div>
  );
}

// Audience-sync health: per-client Meta/TikTok connection + sync outcomes, drawn
// from what the connectors record on each push. Expand a client for per-segment detail.
function AudienceSyncHealth() {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState({});
  const [err, setErr] = useState('');
  const [verify, setVerify] = useState({}); // `${entityId}:${channel}` -> result | 'checking'
  const [sizes, setSizes] = useState({}); // `${entityId}:${channel}:${audienceId}` -> result | 'checking'
  const [logs, setLogs] = useState({}); // entityId -> log rows
  const load = () => api.getIntegrationsHealth().then((r) => setData(r.clients || [])).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const doVerify = async (entityId, channel) => {
    const k = `${entityId}:${channel}`;
    setVerify((v) => ({ ...v, [k]: 'checking' }));
    try { const r = await api.verifyConnector(entityId, channel); setVerify((v) => ({ ...v, [k]: r })); }
    catch (e) { setVerify((v) => ({ ...v, [k]: { ok: false, status: 'error', detail: e.message } })); }
  };
  const doSize = async (entityId, channel, audienceId) => {
    const k = `${entityId}:${channel}:${audienceId}`;
    setSizes((s) => ({ ...s, [k]: 'checking' }));
    try { const r = await api.audienceStatus(entityId, channel, audienceId); setSizes((s) => ({ ...s, [k]: r })); }
    catch (e) { setSizes((s) => ({ ...s, [k]: { ok: false, error: e.message } })); }
  };
  const toggleClient = (entityId) => {
    setOpen((o) => ({ ...o, [entityId]: !o[entityId] }));
    if (!logs[entityId]) api.getAudienceSyncLog(entityId).then((r) => setLogs((l) => ({ ...l, [entityId]: r.log || [] }))).catch(() => {});
  };
  if (err) return <Muted>Couldn’t load health: {err}</Muted>;
  if (!data) return <Muted>Loading…</Muted>;
  if (!data.length) return <Muted>No client has a Meta or TikTok connection or sync yet.</Muted>;

  const when = (iso) => { if (!iso) return 'never'; try { return new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return iso; } };
  const Pill = ({ ch }) => {
    const tone = !ch.configured ? ['#9ca3af', 'not connected']
      : ch.errors > 0 ? ['var(--error,#ef4444)', `${ch.errors} failing`]
        : ch.audienceCount > 0 ? ['var(--success,#10b981)', `${ch.audienceCount} ok`]
          : ['var(--brand)', 'connected'];
    return <span style={{ fontSize: 11, fontWeight: 700, color: tone[0], border: `1px solid ${tone[0]}`, borderRadius: 980, padding: '2px 9px', whiteSpace: 'nowrap' }}>{tone[1]}</span>;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button onClick={load} style={{ ...healthRefreshBtn }}>↻ Refresh</button></div>
      {data.map((c) => {
        const channels = [['Meta', '◇', 'meta', c.channels.meta], ['TikTok', '♪', 'tiktok', c.channels.tiktok]];
        const isOpen = open[c.entityId];
        return (
          <div key={c.entityId} style={{ border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)' }}>
            <button onClick={() => toggleClient(c.entityId)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left' }}>
              <span style={{ width: 12, fontSize: 9, color: 'var(--muted)', transform: isOpen ? 'rotate(90deg)' : 'none' }}>▶</span>
              <span style={{ flex: 1, minWidth: 0, fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
              {channels.filter(([, , , ch]) => ch.configured || ch.audienceCount).map(([label, icon, , ch]) => (
                <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--muted)' }}>{icon} {label} <Pill ch={ch} /></span>
              ))}
            </button>
            {isOpen && (
              <div style={{ padding: '0 14px 12px 38px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                {channels.map(([label, icon, key, ch]) => {
                  const vk = `${c.entityId}:${key}`; const vr = verify[vk];
                  return (
                  <div key={label}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span>{icon} {label} — {ch.configured ? 'connected' : 'not connected'}{ch.lastAt ? ` · last activity ${when(ch.lastAt)}` : ''}</span>
                      {ch.configured && <button onClick={() => doVerify(c.entityId, key)} style={{ ...healthRefreshBtn, padding: '2px 9px', fontSize: 11 }} disabled={vr === 'checking'}>{vr === 'checking' ? 'Checking…' : 'Verify now'}</button>}
                      {ch.audiencesUrl && <a href={ch.audiencesUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, fontWeight: 600, color: 'var(--brand)' }}>Open in {label} ↗</a>}
                    </div>
                    {vr && vr !== 'checking' && (
                      <div style={{ fontSize: 11.5, marginBottom: 4, color: vr.ok ? 'var(--success,#10b981)' : 'var(--error,#ef4444)' }}>
                        {vr.ok ? `✓ Token valid — ${vr.account || 'connected'}${vr.accountStatus != null ? ` (status ${vr.accountStatus})` : ''}` : `✗ ${vr.status}${vr.detail ? ` — ${vr.detail}` : ''}`}
                      </div>
                    )}
                    {ch.lastError && <div style={{ fontSize: 11.5, color: 'var(--error,#ef4444)', marginBottom: 4 }}>Last error ({when(ch.lastError.at)}): {ch.lastError.error}</div>}
                    {ch.audiences.length === 0
                      ? <Muted>No audiences synced yet.</Muted>
                      : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                          {ch.audiences.sort((a, b) => String(b.at).localeCompare(String(a.at))).map((a) => {
                            const sk = `${c.entityId}:${key}:${a.audienceId}`; const sr = sizes[sk];
                            return (
                            <div key={a.segmentId} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12, flexWrap: 'wrap' }}>
                              <span style={{ flexShrink: 0, color: a.status === 'error' ? 'var(--error,#ef4444)' : 'var(--success,#10b981)', fontWeight: 700 }}>{a.status === 'error' ? '✗' : '✓'}</span>
                              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name || a.segmentId}{a.status === 'error' ? <span style={{ color: 'var(--error,#ef4444)' }}> — {a.error}</span> : <span style={{ color: 'var(--muted)' }}> · {a.received} synced{a.audienceId ? ` · audience ${a.audienceId}` : ''}</span>}</span>
                              <span style={{ flexShrink: 0, color: 'var(--muted)', fontSize: 11 }}>{when(a.at)}</span>
                              {a.audienceId && a.status !== 'error' && <button onClick={() => doSize(c.entityId, key, a.audienceId)} style={{ ...healthRefreshBtn, padding: '1px 8px', fontSize: 10.5 }} disabled={sr === 'checking'}>{sr === 'checking' ? '…' : 'size?'}</button>}
                              {sr && sr !== 'checking' && <span style={{ flexBasis: '100%', fontSize: 11, color: sr.ok ? 'var(--muted)' : 'var(--error,#ef4444)', paddingLeft: 20 }}>{sr.ok ? `↳ ${sr.size == null || sr.size < 0 ? 'still processing on platform' : `~${sr.size} on platform`}${sr.operation ? ` · ${sr.operation}` : ''}` : `↳ ${sr.error}`}</span>}
                            </div>
                            );
                          })}
                        </div>
                      )}
                  </div>
                  );
                })}
                {(logs[c.entityId] || []).length > 0 && (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>Recent activity</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {logs[c.entityId].map((row, i) => (
                        <div key={i} style={{ fontSize: 11.5, display: 'flex', gap: 8, alignItems: 'baseline' }}>
                          <span style={{ flexShrink: 0, color: row.status === 'error' ? 'var(--error,#ef4444)' : 'var(--success,#10b981)', fontWeight: 700 }}>{row.status === 'error' ? '✗' : '✓'}</span>
                          <span style={{ flexShrink: 0, color: 'var(--muted)' }}>{row.channel === 'tiktok' ? '♪' : '◇'}</span>
                          <span style={{ flex: 1, minWidth: 0, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {row.status === 'error' ? row.error : `${row.received} synced${(row.added != null || row.removed != null) ? ` (+${row.added || 0} −${row.removed || 0})` : ''}${row.by ? ` · ${row.by}` : ''}`}
                          </span>
                          <span style={{ flexShrink: 0, color: 'var(--muted)' }}>{when(row.at)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
const healthRefreshBtn = { padding: '5px 11px', fontSize: 12, fontWeight: 600, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 980, cursor: 'pointer' };

// Clickatell SMS provider config — write-only key + sender ID + a live test.
function SmsConfig() {
  const [cfg, setCfg] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [sender, setSender] = useState('');
  const [saved, setSaved] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testState, setTestState] = useState('');
  useEffect(() => { api.getSmsConfig().then((c) => { setCfg(c); setSender(c.sender || ''); }).catch(() => setCfg({})); }, []);
  if (!cfg) return <Muted>Loading…</Muted>;
  const save = async () => { const c = await api.setSmsConfig({ ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), sender }); setCfg(c); setApiKey(''); flash(setSaved); };
  const test = async () => {
    if (!testTo.trim()) return;
    setTestState('sending');
    try { const r = await api.smsTest(testTo.trim()); setTestState(r.ok ? `✓ Sent to ${r.to || testTo}` : `✗ ${r.error?.description || r.error || 'failed'}`); }
    catch (e) { setTestState(`✗ ${e.message}`); }
  };
  return (
    <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label={`Clickatell API key ${cfg.configured ? `(set · ${cfg.keyHint})` : '(not set)'}`}>
          <input style={input} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={cfg.configured ? 'Enter a new key to replace' : 'Paste your One API key'} autoComplete="off" />
        </Field>
        <Field label="Sender ID"><input style={input} value={sender} onChange={(e) => setSender(e.target.value)} placeholder="e.g. MTNBush" /></Field>
        <button style={miniBtn} onClick={save}>Save</button>
        {saved && <span style={{ color: 'var(--success,#10b981)', fontSize: 13, fontWeight: 600 }}>✓</span>}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Send a test SMS to"><input style={input} value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="082 123 4567" /></Field>
        <button style={miniBtnOutline} onClick={test} disabled={!cfg.configured || testState === 'sending'}>{testState === 'sending' ? 'Sending…' : 'Send test'}</button>
        {testState && testState !== 'sending' && <span style={{ fontSize: 13, color: testState.startsWith('✓') ? 'var(--success,#10b981)' : 'var(--error)' }}>{testState}</span>}
      </div>
    </div>
  );
}

// Platform push-reminder cadence: how long a must-acknowledge message can sit
// unacknowledged before Pulse re-nudges (and keeps re-nudging once per window).
function NotificationSettings() {
  const [hours, setHours] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { api.getNotificationSettings().then((s) => setHours(String(s.ackReminderHours))).catch(() => setHours('12')); }, []);
  if (hours === '') return <Muted>Loading…</Muted>;
  const save = async () => { const s = await api.setNotificationSettings({ ackReminderHours: Number(hours) }); setHours(String(s.ackReminderHours)); flash(setSaved); };
  return (
    <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={lblS}>Must-acknowledge reminder</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>Re-nudge if not acknowledged after</span>
        <input style={{ ...inS, width: 70 }} type="number" min="1" max="168" value={hours} onChange={(e) => setHours(e.target.value)} />
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>hours (then once per window until acknowledged).</span>
        <button style={miniBtn} onClick={save}>Save</button>
        {saved && <span style={{ color: 'var(--success,#10b981)', fontSize: 13, fontWeight: 600 }}>✓</span>}
      </div>
    </div>
  );
}

// Platform inbound config: the inbound domain + the webhook URL & secret to wire
// into whatever forwards mail (Cloudflare Email Worker, SendGrid Parse, etc.).
function InboundConfig() {
  const [cfg, setCfg] = useState(null);
  const [domain, setDomain] = useState('');
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState('');
  useEffect(() => { api.getInboundConfig().then((c) => { setCfg(c); setDomain(c.domain || ''); }); }, []);
  if (!cfg) return <Muted>Loading…</Muted>;
  const webhookUrl = `${window.location.origin}${cfg.webhookPath}`;
  const copy = (label, text) => { (navigator.clipboard?.writeText(text) || Promise.reject()).then(() => { setCopied(label); setTimeout(() => setCopied(''), 1500); }).catch(() => window.prompt('Copy:', text)); };
  const save = async () => { const c = await api.saveInboundConfig({ domain }); setCfg(c); setDomain(c.domain || ''); setSaved(true); setTimeout(() => setSaved(false), 1600); };
  const regen = async () => { if (window.confirm('Rotate the webhook secret? Your forwarder must be updated with the new value.')) setCfg(await api.saveInboundConfig({ regenerateSecret: true })); };
  return (
    <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={lblS}>Inbound domain</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input style={inS} value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="in.howler-pulse.com" />
          <button style={miniBtn} onClick={save}>Save</button>
          {saved && <span style={{ color: 'var(--success,#10b981)', fontSize: 13, fontWeight: 600 }}>✓</span>}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Client addresses become <code>token@{domain || 'in.yourdomain.com'}</code>.</div>
      </div>
      <div>
        <div style={lblS}>Webhook URL</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <code style={{ ...inS, padding: '8px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{webhookUrl}</code>
          <button style={miniBtn} onClick={() => copy('url', webhookUrl)}>{copied === 'url' ? '✓' : 'Copy'}</button>
        </div>
      </div>
      <div>
        <div style={lblS}>Webhook secret</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <code style={{ ...inS, padding: '8px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cfg.secret}</code>
          <button style={miniBtn} onClick={() => copy('secret', cfg.secret)}>{copied === 'secret' ? '✓' : 'Copy'}</button>
          <button style={{ ...miniBtn, background: 'transparent', color: 'var(--muted)' }} onClick={regen}>Rotate</button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Send it as header <code>x-owl-secret</code> on every webhook POST.</div>
      </div>
    </div>
  );
}
const lblS = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginBottom: 5 };
const inS = { flex: 1, boxSizing: 'border-box', padding: '9px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', background: 'var(--card)', color: 'var(--text)' };

// Owl auto-ingest config: the kill-switch + the trusted-sender allowlist that may
// trigger settlement/invoice auto-publish from email. Backed by /api/admin/owl-ingest.
function OwlIngestConfig() {
  const [cfg, setCfg] = useState(null);
  const [senders, setSenders] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { api.getOwlIngest().then((c) => { setCfg(c); setSenders(c.senders || ''); }); }, []);
  if (!cfg) return <Muted>Loading…</Muted>;
  const save = async (patch) => {
    const c = await api.saveOwlIngest(patch);
    setCfg(c); setSenders(c.senders || ''); setSaved(true); setTimeout(() => setSaved(false), 1600);
  };
  return (
    <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
        <input type="checkbox" checked={cfg.enabled} onChange={(e) => save({ enabled: e.target.checked })} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Auto-ingest enabled</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{cfg.enabled ? 'on' : 'off — emailed PDFs are captured to the inbox only'}</span>
      </label>
      <div>
        <div style={lblS}>Trusted senders</div>
        <textarea style={{ ...inS, minHeight: 60, resize: 'vertical', fontFamily: 'inherit' }} value={senders} onChange={(e) => setSenders(e.target.value)} placeholder="howler.co.za, settlements@howler.co.za" />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
          <button style={miniBtn} onClick={() => save({ senders })}>Save</button>
          {saved && <span style={{ color: 'var(--success,#10b981)', fontSize: 13, fontWeight: 600 }}>✓</span>}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Emails or bare domains, comma/space-separated. Only PDFs from these senders are auto-ingested; everything else is just captured to the inbox. A settlement only auto-<b>publishes</b> when its totals reconcile — otherwise it’s held as a draft for review.</div>
      </div>
    </div>
  );
}

// Per-client integrations (admin), shown inside a client's detail nav.
function ClientIntegrations({ entity }) {
  const [value, setValue] = useState(null);
  useEffect(() => { api.getEntityIntegrations(entity.id).then(setValue); }, [entity.id]);
  if (!value) return <Muted>Loading…</Muted>;
  return (
    <div>
      <p style={hint}>Optional per-client accounts. Anything left blank falls back to the platform default (Admin → Integrations).</p>
      <IntegrationsForm
        key={entity.id}
        value={value}
        lookerActive={false}
        showMeta
        showTikTok
        showSlack
        canManageLock
        lockableKeys={['looker', 'anthropic', 'meta', 'tiktok', 'slack']}
        locks={value.locks || {}}
        onTestSlack={() => api.testEntitySlack(entity.id)}
        onToggleLock={async (k, locked) => setValue(await api.setEntityIntegrationLock(entity.id, k, locked))}
        onSave={async (p) => setValue(await api.saveEntityIntegrations(entity.id, p))}
      />
      <ApiKeysCard entityId={entity.id} scope="admin-client" />
    </div>
  );
}

// ─── Backup / restore ─────────────────────────────────────────────────────────
// Download a full JSON snapshot (clients, suites, sets, dashboards, logins,
// settings, tile library) and restore it on another instance. Used to migrate
// local → production, and as an ongoing backup.
function BackupRestore() {
  const [busy, setBusy] = useState('');
  async function doExport() {
    setBusy('export');
    try {
      const data = await api.exportData();
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `pulse-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click(); URL.revokeObjectURL(url);
    } catch (e) { alert('Export failed: ' + e.message); }
    finally { setBusy(''); }
  }
  async function doImport(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!confirm('Restore from this backup? It REPLACES all current clients, suites, sets, dashboards, logins and settings on THIS server. You may need to log in again with the credentials from the backup afterwards.')) return;
    setBusy('import');
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const r = await api.importData(data);
      alert('Restored. Counts: ' + JSON.stringify(r.counts) + '\n\nReloading…');
      window.location.href = '/';
    } catch (err) { alert('Import failed: ' + err.message); }
    finally { setBusy(''); }
  }
  return (
    <div>
      <p style={hint}>Download a full snapshot of everything (clients, suites, sets, dashboards, logins, settings, tile library), or restore one. Use it to move your local setup to production, or as a backup.</p>
      <div style={cardStyle}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>⬇ Export</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>Saves a JSON backup of this server's data to your computer.</div>
        <button style={saveBtn} onClick={doExport} disabled={!!busy}>{busy === 'export' ? 'Exporting…' : 'Download backup'}</button>
      </div>
      <div style={{ ...cardStyle, borderColor: '#f0c0c0' }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>⬆ Restore</div>
        <div style={{ fontSize: 13, color: 'var(--error)', marginBottom: 12 }}>Replaces ALL data on this server with the contents of a backup file. Use the file you exported from your other instance.</div>
        <label style={{ ...addBtn, display: 'inline-block', cursor: busy ? 'default' : 'pointer' }}>
          {busy === 'import' ? 'Restoring…' : 'Choose backup file…'}
          <input type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={doImport} disabled={!!busy} />
        </label>
      </div>
    </div>
  );
}

// ─── Messages (Experience OS) ───────────────────────────────────────────────────
// Send an announcement to this client and see the thread list. Clients see it
// in their Inbox; must-acknowledge ones raise a banner until acknowledged.
function ClientMessages({ entity }) {
  const navigate = useNavigate();
  const [threads, setThreads] = useState(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState('normal');
  const [channels, setChannels] = useState({ email: true, push: true }); // send-time channel choice
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [files, setFiles] = useState([]); // [{name, mime, size, data}]
  const fileRef = useRef(null);
  const load = () => { api.osInbox(entity.id).then((r) => setThreads(r.threads)).catch(() => setThreads([])); };
  useEffect(() => { load(); }, [entity.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const addFiles = (list) => {
    for (const f of Array.from(list || []).slice(0, 5)) {
      if (f.size > 10 * 1024 * 1024) { alert(`${f.name} is over 10MB`); continue; }
      const r = new FileReader();
      r.onload = () => setFiles((cur) => cur.length >= 5 ? cur : [...cur, { name: f.name, mime: f.type || 'application/octet-stream', size: f.size, data: String(r.result).split(',')[1] }]);
      r.readAsDataURL(f);
    }
  };
  async function send() {
    if (!body.trim() && !files.length) return;
    setBusy(true);
    const chans = Object.entries(channels).filter(([, on]) => on).map(([k]) => k);
    try { await api.osAnnounce({ entityId: entity.id, title, body, priority, attachments: files, channels: chans }); setTitle(''); setBody(''); setPriority('normal'); setFiles([]); flash(setSent); load(); }
    catch (e) { alert(e.message); } finally { setBusy(false); }
  }
  const PRI = { fyi: 'FYI', normal: 'Normal', needs_reply: 'Needs reply', must_ack: 'Must acknowledge' };

  return (
    <div>
      <OwlAddressCard entityId={entity.id} admin />
      <p style={hint}>Send a message to <b>{entity.name}</b>. It lands in their Inbox; “Must acknowledge” raises a banner on their home until they confirm — and you'll see who acknowledged, when.</p>
      <div style={cardStyle}>
        <input style={{ ...input, width: '100%', fontWeight: 700, marginBottom: 8 }} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Subject (optional)" />
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder="Your message to the client…"
          style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} />
        {files.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            {files.map((f, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, background: 'var(--elevated, #f7f7f8)', border: '1px solid var(--hairline)', borderRadius: 980, padding: '4px 10px' }}>
                📎 {f.name}
                <button onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--muted)', padding: 0 }}>✕</button>
              </span>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <select style={input} value={priority} onChange={(e) => setPriority(e.target.value)}>
            {Object.entries(PRI).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button style={miniBtn} onClick={() => fileRef.current?.click()}>📎 Attach</button>
          <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--muted)', marginLeft: 4 }} title="In-app inbox is always delivered; these add outside nudges. Each recipient's own preference still applies.">
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}><input type="checkbox" checked={channels.email} onChange={(e) => setChannels((c) => ({ ...c, email: e.target.checked }))} /> Email</label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}><input type="checkbox" checked={channels.push} onChange={(e) => setChannels((c) => ({ ...c, push: e.target.checked }))} /> Push</label>
          </span>
          <span style={{ flex: 1 }} />
          {sent && <SavedChip />}
          <button style={{ ...saveBtn }} onClick={send} disabled={busy || (!body.trim() && !files.length)}>{busy ? 'Sending…' : 'Send message'}</button>
        </div>
      </div>
      <h3 style={{ fontSize: 14, fontWeight: 700, margin: '18px 0 8px' }}>Conversations</h3>
      {!threads ? <Muted>Loading…</Muted> : threads.length === 0 ? <Muted>No messages yet.</Muted> : (
        <div style={clientList}>
          {threads.map((t) => (
            <button key={t.id} className="lift" style={clientRow} onClick={() => navigate('/inbox')}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>{t.title || '(no subject)'}</span>
              {t.priority === 'must_ack' && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: t.acked ? '#2da44e' : '#b45309' }}>{t.acked ? '✓ acknowledged' : 'awaiting ack'}</span>}
              <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 12 }}>{t.preview?.body?.slice(0, 40) || ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Settlements ───────────────────────────────────────────────────────────────
// Upload a settlement PDF → Claude extracts it to structured JSON → review the
// recomputed totals against the report's own → assign a client → publish.
// With `entityId` set (the client-space section) everything is pre-scoped to
// that client: the list filters to them and uploads assign automatically.
function Settlements({ entityId = null }) {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [entities, setEntities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);
  // Live extraction progress: { stage:'upload'|'reading'|'extracting', chars, rows, fileName, startedAt }
  const [prog, setProg] = useState(null);
  // Draft being reviewed before publish: { data, fileBase64, fileName, fileType, entityId, status }
  const [draft, setDraft] = useState(null);

  const load = () => {
    Promise.all([api.adminListSettlements(), api.adminListEntities()])
      .then(([s, e]) => { setItems(entityId ? s.filter((x) => x.entityId === entityId) : s); setEntities(e); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [entityId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.type !== 'application/pdf') { setError('Please upload a PDF settlement report.'); return; }
    setError(null);
    const startedAt = Date.now();
    setProg({ stage: 'upload', chars: 0, rows: 0, fileName: file.name, startedAt });
    try {
      const fileBase64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1]);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      setProg({ stage: 'reading', chars: 0, rows: 0, fileName: file.name, startedAt });
      const data = await api.adminExtractSettlement(fileBase64, 'application/pdf', (p) => {
        setProg({ stage: p.stage || 'extracting', chars: p.chars || 0, rows: p.rows || 0, fileName: file.name, startedAt });
      });
      // Guess type + product from the filename: events get many weekly
      // settlements before the one final report, and ticketing & cashless come
      // as separate reports. The admin can still override below.
      const status = /weekly/i.test(file.name) ? 'weekly' : /interim/i.test(file.name) ? 'interim' : 'final';
      const kind = /cashless/i.test(file.name) ? 'cashless' : 'ticketing';
      setDraft({ data, fileBase64, fileName: file.name, fileType: 'application/pdf', entityId: entityId || '', status, kind });
    } catch (err) {
      setError(err.message);
    } finally {
      setProg(null);
    }
  }

  async function publish() {
    setBusy('Publishing…');
    try {
      await api.adminCreateSettlement({
        entityId: draft.entityId || null,
        title: draft.data?.meta?.eventName || draft.fileName,
        status: draft.status,
        kind: draft.kind,
        settlementDate: draft.data?.meta?.settlementDate || '',
        data: draft.data,
        fileBase64: draft.fileBase64, fileName: draft.fileName, fileType: draft.fileType,
      });
      setDraft(null);
      load();
    } catch (err) { setError(err.message); } finally { setBusy(''); }
  }

  if (loading) return <Muted>Loading…</Muted>;

  return (
    <div>
      <p style={hint}>Upload a settlement PDF; the Owl extracts it into the interactive report clients see under <b>Reports → Settlements</b>. Review the totals before publishing.</p>
      {error && <p style={{ color: 'var(--error)', fontSize: 13, marginBottom: 10 }}>⚠ {error}</p>}

      {!draft && !prog && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 18, flexWrap: 'wrap' }}>
          <label style={{ ...addBtn, display: 'inline-block', opacity: busy ? 0.6 : 1 }}>
            {busy || '⤴ Upload settlement PDF'}
            <input type="file" accept="application/pdf" style={{ display: 'none' }} onChange={onFile} disabled={!!busy} />
          </label>
          {!entityId && (
            <button style={miniBtnOutline} disabled={!!busy} onClick={() => { setBusy('Loading example…'); api.adminLoadSettlementExample().then(load).catch((e) => setError(e.message)).finally(() => setBusy('')); }}>
              Load example report
            </button>
          )}
        </div>
      )}

      {prog && <ExtractProgress prog={prog} />}

      {/* Draft review before publish */}
      {draft && (
        <div style={{ ...cardStyle, borderColor: 'var(--brand)' }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 2 }}>{draft.data?.meta?.eventName || draft.fileName}</h3>
          <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
            {[draft.data?.meta?.clientName, draft.data?.meta?.venue, draft.data?.meta?.eventDates].filter(Boolean).join(' · ')}
          </p>
          <SettlementChecks data={draft.data} />
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }}>
            {entityId ? (
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>Client: <b style={{ color: 'var(--text)' }}>{entities.find((en) => en.id === entityId)?.name || '—'}</b></span>
            ) : (
              <select style={input} value={draft.entityId} onChange={(e) => setDraft({ ...draft, entityId: e.target.value })}>
                <option value="">— Assign to client —</option>
                {entities.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
              </select>
            )}
            <select style={input} value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
              <option value="weekly">Weekly settlement</option>
              <option value="interim">Interim</option>
              <option value="final">Final settlement</option>
            </select>
            <select style={input} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
              <option value="ticketing">🎟 Ticketing</option>
              <option value="cashless">💳 Cashless</option>
            </select>
            <span style={{ flex: 1 }} />
            <button style={miniBtnOutline} onClick={() => setDraft(null)} disabled={!!busy}>Discard</button>
            <button style={{ ...miniBtn, background: 'var(--brand)', color: '#fff', border: 'none' }} onClick={publish} disabled={!!busy}>{busy || 'Publish'}</button>
          </div>
        </div>
      )}

      {/* Published reports */}
      <div style={clientList}>
        {items.map((s) => (
          <div key={s.id} style={{ ...clientRow, cursor: 'default', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{s.kind === 'cashless' ? '💳' : '🎟'} {s.eventName || s.title}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                {[s.settlementDate && `settled ${s.settlementDate}`, s.valueDue != null && `due R${Number(s.valueDue).toLocaleString('en-US', { minimumFractionDigits: 2 })}`].filter(Boolean).join(' · ')}
              </div>
            </div>
            <span style={{ flex: 1 }} />
            <SettlementEventPicker s={s} eventNames={[...new Set(items.map((x) => x.eventName || x.title))]} onSaved={load} />
            <select
              style={{ ...input, minWidth: 90 }}
              value={s.status}
              onChange={(e) => api.adminUpdateSettlement(s.id, { status: e.target.value }).then(load)}
              title="Settlement type"
            >
              <option value="weekly">Weekly</option>
              <option value="interim">Interim</option>
              <option value="final">Final</option>
            </select>
            <select
              style={{ ...input, minWidth: 100 }}
              value={s.kind || 'ticketing'}
              onChange={(e) => api.adminUpdateSettlement(s.id, { kind: e.target.value }).then(load)}
              title="Product"
            >
              <option value="ticketing">🎟 Ticketing</option>
              <option value="cashless">💳 Cashless</option>
            </select>
            {!entityId && (
              <select
                style={{ ...input, minWidth: 150 }}
                value={s.entityId || ''}
                onChange={(e) => api.adminUpdateSettlement(s.id, { entityId: e.target.value || null }).then(load)}
              >
                <option value="">— No client (hidden) —</option>
                {entities.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
              </select>
            )}
            <button style={miniBtnOutline} onClick={() => navigate(`/settlements/${s.id}`)}>Open</button>
            <button style={{ ...miniBtnOutline, color: 'var(--error)' }} onClick={() => { if (confirm(`Delete the settlement report "${s.eventName || s.title}"?`)) api.adminDeleteSettlement(s.id).then(load); }}>Delete</button>
          </div>
        ))}
        {items.length === 0 && !draft && <Muted>No settlement reports yet.</Muted>}
      </div>

      {/* Invoices live in the client space, where the client context is known. */}
      {entityId && <EventDocuments entityId={entityId} eventNames={[...new Set(items.map((s) => s.eventName || s.title))]} />}
    </div>
  );
}

// ─── Event documents (invoices) ─────────────────────────────────────────────────
// Invoice PDFs go through the same AI extract → review → publish flow as
// settlements, so the client gets an interactive invoice view. Other file
// types (images etc.) upload straight through and render as-is.
function EventDocuments({ entityId, eventNames }) {
  const navigate = useNavigate();
  const [docs, setDocs] = useState([]);
  const [eventName, setEventName] = useState(eventNames[0] || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [prog, setProg] = useState(null);   // extraction progress
  const [queue, setQueue] = useState([]);   // PDFs waiting to be extracted
  const [draft, setDraft] = useState(null); // extracted invoice under review
  const load = () => { api.adminListDocuments(entityId).then(setDocs).catch((e) => setError(e.message)); };
  useEffect(() => { load(); }, [entityId]); // eslint-disable-line react-hooks/exhaustive-deps

  const readB64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });

  async function onFiles(e) {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    setError(null);
    // Non-PDFs upload directly; PDFs queue for extraction one at a time.
    const pdfs = files.filter((f) => f.type === 'application/pdf');
    const others = files.filter((f) => f.type !== 'application/pdf');
    if (others.length) {
      setBusy(true);
      try {
        for (const file of others) {
          const fileBase64 = await readB64(file);
          await api.adminCreateDocument({ entityId, eventName: eventName.trim(), title: file.name.replace(/\.[^.]+$/, ''), category: 'invoice', fileBase64, fileName: file.name, fileType: file.type || 'application/octet-stream' });
        }
        load();
      } catch (err) { setError(err.message); } finally { setBusy(false); }
    }
    if (pdfs.length) setQueue((q) => [...q, ...pdfs]);
  }

  // Pull the next queued PDF into extraction whenever we're idle.
  useEffect(() => {
    if (draft || prog || !queue.length) return;
    const file = queue[0];
    setQueue((q) => q.slice(1));
    (async () => {
      const startedAt = Date.now();
      setProg({ stage: 'upload', chars: 0, rows: 0, fileName: file.name, startedAt });
      let fileBase64 = '';
      try {
        fileBase64 = await readB64(file);
        setProg({ stage: 'reading', chars: 0, rows: 0, fileName: file.name, startedAt });
        const data = await api.adminExtractInvoice(fileBase64, (p) => {
          setProg({ stage: p.stage || 'extracting', chars: p.chars || 0, rows: p.rows || 0, fileName: file.name, startedAt });
        });
        // The name printed on the invoice rarely matches our event names —
        // fuzzy-match it onto a known event, falling back to the picker value.
        setDraft({
          data, fileBase64, fileName: file.name, fileType: 'application/pdf',
          title: data.meta?.invoiceNumber ? `Invoice ${data.meta.invoiceNumber}` : file.name.replace(/\.[^.]+$/, ''),
          eventName: matchEvent(data.meta?.eventName, eventNames) || eventName || data.meta?.eventName || '',
        });
      } catch (err) {
        // Extraction failed — let the admin publish the raw PDF anyway.
        setDraft({
          data: null, extractError: err.message, fileBase64, fileName: file.name, fileType: 'application/pdf',
          title: file.name.replace(/\.[^.]+$/, ''), eventName,
        });
      } finally {
        setProg(null);
      }
    })();
  }, [queue, draft, prog]); // eslint-disable-line react-hooks/exhaustive-deps

  async function publish() {
    setBusy(true);
    try {
      await api.adminCreateDocument({
        entityId, eventName: (draft.eventName || '').trim(), title: (draft.title || '').trim() || draft.fileName,
        category: 'invoice', data: draft.data || {},
        fileBase64: draft.fileBase64, fileName: draft.fileName, fileType: draft.fileType,
      });
      setDraft(null);
      load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  // Group by event for the list.
  const groups = [];
  for (const doc of docs) {
    const key = doc.eventName || 'Other documents';
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, items: [] }; groups.push(g); }
    g.items.push(doc);
  }

  return (
    <div style={{ marginTop: 28 }}>
      <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Invoices & documents</h3>
      <p style={hint}>Upload invoices for this client's events — PDFs are read by the Owl into an interactive view (totals cross-checked before publishing); other files are stored as-is.</p>
      {error && <p style={{ color: 'var(--error)', fontSize: 13, marginBottom: 8 }}>⚠ {error}</p>}
      {!draft && !prog && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
          <EventPicker value={eventName} onChange={setEventName} eventNames={eventNames} style={{ ...input, minWidth: 200 }} />
          <label style={{ ...addBtn, display: 'inline-block', opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Uploading…' : '⤴ Upload invoices'}
            <input type="file" multiple style={{ display: 'none' }} onChange={onFiles} disabled={busy} />
          </label>
          {queue.length > 0 && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{queue.length} more queued…</span>}
        </div>
      )}

      {prog && <ExtractProgress prog={prog} />}

      {/* Extracted invoice under review */}
      {draft && (
        <div style={{ ...cardStyle, borderColor: 'var(--brand)' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
            <input style={{ ...input, fontWeight: 700, minWidth: 200 }} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Title" />
            <EventPicker value={draft.eventName} onChange={(v) => setDraft({ ...draft, eventName: v })} eventNames={eventNames} style={{ ...input, minWidth: 200 }} />
          </div>
          {draft.data ? (
            <InvoiceChecks data={draft.data} />
          ) : (
            <p style={{ color: 'var(--error)', fontSize: 13 }}>⚠ Extraction failed ({draft.extractError}). You can still publish the PDF — it will render as the original document without the interactive view.</p>
          )}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 12 }}>
            <button style={miniBtnOutline} onClick={() => setDraft(null)} disabled={busy}>Discard</button>
            <button style={{ ...miniBtn, background: 'var(--brand)', color: '#fff', border: 'none' }} onClick={publish} disabled={busy}>{busy ? '…' : 'Publish'}</button>
          </div>
        </div>
      )}
      {groups.map((g) => (
        <div key={g.key} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginBottom: 6 }}>{g.key}</div>
          <div style={clientList}>
            {g.items.map((doc) => (
              <div key={doc.id} style={{ ...clientRow, cursor: 'default', gap: 10, padding: '10px 14px' }}>
                <span style={{ fontSize: 15 }}>🧾</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.title}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {[doc.fileName, new Date(doc.createdAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }), doc.total != null && `R${Number(doc.total).toLocaleString('en-US', { minimumFractionDigits: 2 })}`, doc.hasData ? 'interactive' : null].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <DocEventPicker doc={doc} eventNames={eventNames} onSaved={load} />
                <button style={miniBtnOutline} onClick={() => navigate(`/documents/${doc.id}`)}>Open</button>
                <a href={`/api/documents/${doc.id}/file`} style={{ ...miniBtnOutline, textDecoration: 'none' }}>⤓</a>
                <button style={{ ...miniBtnOutline, color: 'var(--error)' }} onClick={() => { if (confirm(`Delete "${doc.title}"?`)) api.adminDeleteDocument(doc.id).then(load); }}>Delete</button>
              </div>
            ))}
          </div>
        </div>
      ))}
      {docs.length === 0 && <Muted>No documents yet.</Muted>}
    </div>
  );
}

// Live progress for the AI extraction. The % is an estimate (we can't know the
// report's size up front) but the row counter and elapsed time are real, so
// it's always visibly moving while the Owl works.
function ExtractProgress({ prog }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = Math.max(0, Math.round((Date.now() - prog.startedAt) / 1000));
  // upload → ~4%; reading (waiting for first tokens) creeps to ~14%; extracting
  // ramps with output volume and saturates at 96% until the data lands.
  let pct = 4;
  if (prog.stage === 'reading') pct = Math.min(14, 6 + elapsed * 0.5);
  if (prog.stage === 'extracting') pct = 15 + 81 * (prog.chars / (prog.chars + 9000));
  const stageLabel = prog.stage === 'upload' ? 'Uploading the PDF…'
    : prog.stage === 'reading' ? 'The Owl is reading the report…'
    : 'Extracting line items…';
  return (
    <div style={{ ...cardStyle, marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{stageLabel}</span>
        <span style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{prog.fileName}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{elapsed}s</span>
      </div>
      <div style={{ height: 8, borderRadius: 980, background: 'rgba(128,128,128,0.18)', overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${pct}%`, borderRadius: 980,
          background: 'linear-gradient(90deg, #ff385c, #ff6b35, #7c3aed)',
          transition: 'width .45s ease',
        }} />
      </div>
      <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
        {prog.rows > 0
          ? `${prog.rows} line item${prog.rows === 1 ? '' : 's'} extracted so far — totals get cross-checked before anything is published.`
          : 'This usually takes 30–90 seconds depending on the report size. Leave this tab open.'}
      </div>
    </div>
  );
}

// Recompute every subtotal from the extracted line items and compare with the
// report's own totals — the safety net against extraction slips.
function SettlementChecks({ data }) {
  const d = data || {};
  const close = (a, b) => Math.abs((a || 0) - (b || 0)) < 0.05;
  const checks = [];
  for (const g of d.sales || []) {
    const sum = (g.rows || []).reduce((a, r) => a + (r.total || 0), 0);
    checks.push({ label: `${g.name} subtotal`, ok: close(sum, g.subtotal?.total), got: sum, want: g.subtotal?.total });
  }
  const salesTotal = (d.sales || []).reduce((a, g) => a + (g.subtotal?.total || 0), 0);
  checks.push({ label: 'Turnover = sales − refunds', ok: close(salesTotal, d.turnover), got: salesTotal, want: d.turnover });
  for (const g of d.commissions || []) {
    const sum = (g.rows || []).reduce((a, r) => a + (r.total || 0), 0);
    checks.push({ label: `${g.name} subtotal`, ok: close(sum, g.subtotal?.total), got: sum, want: g.subtotal?.total });
  }
  const commTotal = (d.commissions || []).reduce((a, g) => a + (g.subtotal?.total || 0), 0);
  checks.push({ label: 'Commissions total', ok: close(commTotal, d.commissionsTotal), got: commTotal, want: d.commissionsTotal });
  const due = (d.turnover || 0) + (d.commissionsTotal || 0) + (d.advances?.subtotal || 0);
  checks.push({ label: 'Value due = turnover − commissions − advances', ok: close(due, d.valueDue), got: due, want: d.valueDue });
  const bad = checks.filter((c) => !c.ok);
  const R = (n) => `R${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  return (
    <div style={{ fontSize: 13 }}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
        <span><b>Turnover</b> {R(d.turnover)}</span>
        <span><b>Commissions</b> {R(d.commissionsTotal)}</span>
        <span><b>Advances</b> {R(d.advances?.subtotal)}</span>
        <span><b>Value due</b> {R(d.valueDue)}</span>
      </div>
      {bad.length === 0 ? (
        <p style={{ color: '#2da44e', fontWeight: 600 }}>✓ All {checks.length} cross-checks pass — extracted totals reconcile.</p>
      ) : (
        <div style={{ color: 'var(--error)' }}>
          <p style={{ fontWeight: 700 }}>⚠ {bad.length} check{bad.length > 1 ? 's' : ''} failed — compare against the PDF before publishing:</p>
          {bad.map((c, i) => <p key={i} style={{ fontSize: 12 }}>· {c.label}: rows sum to {R(c.got)}, report says {R(c.want)}</p>)}
        </div>
      )}
    </div>
  );
}

// Assign-to-event control: a select fed by the client's known events (from
// their settlements), with an "Other / new event…" escape hatch to type a name
// that doesn't exist yet. Values not in the list show as "(custom)".
// Free-text event name with autocomplete suggestions from known events. A plain
// input (no select↔input mode-switching, which kept breaking focus/typing) — so
// it ALWAYS accepts typing. Picking a suggestion or typing a new name both just
// set the value; onCommit (optional) fires on blur/Enter so a consumer saves once.
function EventPicker({ value, onChange, onCommit, eventNames, style }) {
  const known = [...new Set((eventNames || []).filter(Boolean))];
  const listId = useId();
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      <input
        style={style}
        value={value}
        list={known.length ? listId : undefined}
        placeholder="Event name"
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onCommit && onCommit(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
      />
      {known.length > 0 && (
        <datalist id={listId}>
          {known.map((n) => <option key={n} value={n} />)}
        </datalist>
      )}
    </span>
  );
}

// Per-document event assignment. Types into LOCAL state and saves once on
// blur/Enter (or immediately on a dropdown pick) — never per keystroke, which
// would refetch + re-group the list mid-type and make the field feel "stuck".
function DocEventPicker({ doc, eventNames, onSaved }) {
  const [val, setVal] = useState(doc.eventName || '');
  useEffect(() => { setVal(doc.eventName || ''); }, [doc.eventName]);
  const commit = (v) => {
    const t = String(v == null ? val : v).trim();
    if (!t) return;                          // ignore empty (the "Other" transition / accidental blur) — don't wipe or reload mid-edit
    if (t === (doc.eventName || '')) return; // unchanged
    api.adminUpdateDocument(doc.id, { eventName: t }).then(onSaved);
  };
  return <EventPicker value={val} onChange={setVal} onCommit={commit} eventNames={eventNames} style={{ ...input, minWidth: 150, maxWidth: 190 }} />;
}

// Per-settlement event assignment — mirrors DocEventPicker but saves onto the
// settlement's extracted meta (so the card, the client-side grouping, and the
// report header stay in sync). Type a new name or pick an existing event.
function SettlementEventPicker({ s, eventNames, onSaved }) {
  const [val, setVal] = useState(s.eventName || s.title || '');
  useEffect(() => { setVal(s.eventName || s.title || ''); }, [s.eventName, s.title]);
  const commit = (v) => {
    const t = String(v == null ? val : v).trim();
    if (!t || t === (s.eventName || s.title || '')) return;
    api.adminUpdateSettlement(s.id, { eventName: t }).then(onSaved);
  };
  return <EventPicker value={val} onChange={setVal} onCommit={commit} eventNames={eventNames} style={{ ...input, minWidth: 150, maxWidth: 200 }} />;
}

// Best-overlap match of a free-text name (as printed on an invoice) onto one of
// our known event names. Returns '' when nothing matches convincingly.
function matchEvent(name, eventNames) {
  if (!name) return '';
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const words = new Set(norm(name));
  let best = '', score = 0;
  for (const ev of eventNames || []) {
    const evWords = norm(ev);
    if (!evWords.length) continue;
    const hit = evWords.filter((w) => words.has(w)).length;
    const s = hit / evWords.length;
    if (s > score) { score = s; best = ev; }
  }
  return score >= 0.5 ? best : '';
}

// Cross-check the extracted invoice: line items must sum to the subtotal, and
// subtotal + VAT must equal the total.
function InvoiceChecks({ data }) {
  const d = data || {};
  const close = (a, b) => Math.abs((a || 0) - (b || 0)) < 0.05;
  const itemSum = (d.items || []).reduce((a, r) => a + (r.total || 0), 0);
  const checks = [];
  if (d.subtotal != null && d.subtotal !== 0) checks.push({ label: 'Line items sum to subtotal', ok: close(itemSum, d.subtotal), got: itemSum, want: d.subtotal });
  else if (d.total != null) checks.push({ label: 'Line items sum to total', ok: close(itemSum, d.total), got: itemSum, want: d.total });
  if (d.subtotal != null && d.vatTotal != null && d.total != null && d.total !== 0) {
    checks.push({ label: 'Subtotal + VAT = total', ok: close((d.subtotal || 0) + (d.vatTotal || 0), d.total), got: (d.subtotal || 0) + (d.vatTotal || 0), want: d.total });
  }
  const bad = checks.filter((c) => !c.ok);
  const R = (n) => `R${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  return (
    <div style={{ fontSize: 13 }}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
        {d.meta?.invoiceNumber && <span><b>Nº</b> {d.meta.invoiceNumber}</span>}
        {d.meta?.date && <span><b>Date</b> {d.meta.date}</span>}
        <span><b>Items</b> {(d.items || []).length}</span>
        <span><b>Subtotal</b> {R(d.subtotal)}</span>
        <span><b>VAT</b> {R(d.vatTotal)}</span>
        <span><b>Total</b> {R(d.total)}</span>
      </div>
      {bad.length === 0 ? (
        <p style={{ color: '#2da44e', fontWeight: 600 }}>✓ {checks.length ? `All ${checks.length} cross-checks pass — extracted totals reconcile.` : 'Extracted (no totals to cross-check).'}</p>
      ) : (
        <div style={{ color: 'var(--error)' }}>
          <p style={{ fontWeight: 700 }}>⚠ {bad.length} check{bad.length > 1 ? 's' : ''} failed — compare against the PDF before publishing:</p>
          {bad.map((c, i) => <p key={i} style={{ fontSize: 12 }}>· {c.label}: got {R(c.got)}, invoice says {R(c.want)}</p>)}
        </div>
      )}
    </div>
  );
}

function Tab({ active, onClick, children }) {
  return <button onClick={onClick} style={{ padding: '8px 16px', borderRadius: 8, border: active ? '1.5px solid var(--brand)' : '1.5px solid var(--hairline)', background: active ? 'var(--brand)' : 'var(--card)', color: active ? '#fff' : 'var(--text)', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>{children}</button>;
}
function Field({ label, children }) { return <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><L>{label}</L>{children}</div>; }
// Collapsible labelled section. Admin-panel rule: sections start collapsed.
function Section({ title, children, defaultOpen = false, tour }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div data-tour={tour} style={{ marginTop: 14 }}>
      <button onClick={() => setOpen((o) => !o)} style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }}>
        <span style={{ width: 12, color: '#b0b0b6', fontSize: 11, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted)' }}>{title}</span>
      </button>
      {open && <div style={{ marginTop: 6 }}>{children}</div>}
    </div>
  );
}
function L({ children }) { return <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{children}</span>; }
function Muted({ children }) { return <p style={{ color: 'var(--muted)' }}>{children}</p>; }

const hint = { fontSize: 13, color: 'var(--muted)', marginBottom: 14 };
const dashAdminBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 980, border: '1.5px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 13, fontWeight: 600, textDecoration: 'none', cursor: 'pointer' };
const cardStyle = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: 18, marginBottom: 14, boxShadow: '0 1px 6px rgba(0,0,0,0.05)' };
const input = { padding: '8px 10px', border: '1.5px solid var(--hairline)', borderRadius: 7, fontSize: 13, outline: 'none', boxSizing: 'border-box', minWidth: 160 };
const saveBtn = { padding: '8px 16px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const addBtn = { padding: '9px 16px', background: 'var(--elevated)', border: '1.5px solid var(--hairline)', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const miniBtn = { padding: '6px 12px', background: 'var(--elevated)', border: '1.5px solid var(--hairline)', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' };
const miniBtnOutline = { padding: '5px 11px', background: 'var(--card)', border: '1.5px solid var(--hairline)', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer', color: 'var(--text)' };
const clientList = { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 };
const searchWrap = { display: 'flex', alignItems: 'center', gap: 8, background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 10, padding: '9px 12px', marginBottom: 12, maxWidth: 360 };
const searchInput = { flex: 1, minWidth: 0, border: 'none', background: 'transparent', outline: 'none', fontSize: 14, color: 'var(--text)', fontFamily: 'inherit' };
const searchClear = { flexShrink: 0, border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 13, padding: 0, lineHeight: 1 };
const clientRow = { display: 'flex', alignItems: 'center', width: '100%', textAlign: 'left', background: 'var(--card)', border: '1px solid #e6e6e6', borderRadius: 10, padding: '14px 16px', cursor: 'pointer', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' };
const detailNav = { display: 'flex', flexDirection: 'column', gap: 4, width: 170, flexShrink: 0 };
const detailNavItem = { textAlign: 'left', padding: '9px 13px', border: 'none', background: 'transparent', borderRadius: 8, fontSize: 14, fontWeight: 600, color: 'var(--muted-2, #555)', cursor: 'pointer' };
const detailNavActive = { background: 'var(--brand)', color: '#fff' };
const delBtn = { padding: '6px 12px', background: 'var(--card)', color: 'var(--error)', border: '1.5px solid #f0c0c0', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' };
const previewBtn = { padding: '6px 12px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' };
const th = { textAlign: 'left', padding: '8px 10px', borderBottom: '2px solid #e0e0e0', fontSize: 12, color: 'var(--muted)' };
const td = { padding: '8px 10px', borderBottom: '1px solid var(--hairline)' };
// Admin → Users
const thS = { textAlign: 'left', padding: '6px 10px', borderBottom: '1.5px solid var(--hairline)', fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4 };
const howlerBadge = { fontSize: 10, fontWeight: 700, color: 'var(--brand)', border: '1px solid var(--brand)', borderRadius: 980, padding: '1px 7px', verticalAlign: 'middle' };
const rolePill = { fontSize: 11, fontWeight: 700, color: 'var(--brand)', background: '#fff0f3', borderRadius: 980, padding: '3px 10px', flexShrink: 0 };
const subhead = { fontSize: 14, fontWeight: 700, margin: '0 0 10px' };
const chipNeutral = { display: 'inline-flex', alignItems: 'center', background: 'var(--elevated)', border: '1px solid var(--hairline)', borderRadius: 980, padding: '3px 10px', fontSize: 12, color: 'var(--text)' };
const checkList = { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto', border: '1px solid var(--hairline)', borderRadius: 8, padding: 10, margin: '6px 0' };
const checkItem = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' };
const crumbLink = { border: 'none', background: 'transparent', color: 'var(--brand)', fontWeight: 600, fontSize: 13, cursor: 'pointer', padding: 0 };
const folderChip = { display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--border)', background: 'var(--elevated)', borderRadius: 8, padding: '5px 10px', fontSize: 13, cursor: 'pointer', color: 'var(--text)' };
const orderList = { display: 'flex', flexDirection: 'column', gap: 4, border: '1px solid var(--hairline)', borderRadius: 8, padding: 8, margin: '6px 0' };
const orderRow = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '4px 2px' };
const orderBtn = { width: 26, height: 26, flexShrink: 0, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--elevated)', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0 };
const pickBtn = { position: 'absolute', right: 4, top: 4, padding: '4px 8px', fontSize: 11, fontWeight: 600, border: '1px solid var(--border)', borderRadius: 5, background: 'var(--elevated)', cursor: 'pointer' };
const ddList = { position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, marginTop: 4, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 6px 20px rgba(0,0,0,0.12)', maxHeight: 220, overflowY: 'auto', listStyle: 'none', margin: 0, padding: '4px 0' };
const ddItem = { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', fontSize: 13, cursor: 'pointer' };
const ddMuted = { padding: '7px 12px', fontSize: 13, color: 'var(--muted)' };
const iconPreview = { width: 38, height: 38, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--hairline)', borderRadius: 10, background: 'var(--elevated)' };
const iconChip = { width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, border: '1px solid #e6e6e6', borderRadius: 8, background: 'var(--card)', cursor: 'pointer', padding: 0, lineHeight: 1 };
const logoPreview = { width: 120, height: 56, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--hairline)', borderRadius: 10, background: 'var(--elevated)', padding: 6, boxSizing: 'border-box' };
const chip = { display: 'inline-flex', alignItems: 'center', gap: 2, background: '#fff0f3', color: 'var(--brand)', borderRadius: 980, padding: '3px 10px', fontSize: 12, fontWeight: 600 };
