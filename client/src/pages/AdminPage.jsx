import { useState, useEffect, useRef, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';
import IntegrationsForm from '../components/IntegrationsForm.jsx';
import MailTemplateEditor from '../components/MailTemplateEditor.jsx';
import MailLogView from '../components/MailLogView.jsx';
import OwlAddressCard from '../components/OwlAddressCard.jsx';
import DigestManager from '../components/DigestManager.jsx';
import CampaignManager from '../components/CampaignManager.jsx';
import SegmentManager from '../components/SegmentManager.jsx';
import { BriefingConfigForm } from '../components/BriefingTuneModal.jsx';

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
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={logoPreview}>
        {value ? <img src={value} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} /> : <span style={{ color: '#c8c8cc', fontSize: 12 }}>No logo</span>}
      </div>
      <button style={miniBtn} onClick={() => fileRef.current?.click()}>Upload logo</button>
      <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onFile} />
      {value && <button style={delBtn} onClick={() => onChange('')}>Remove</button>}
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
  ['logins', 'Admin logins', '🔑'],
  ['sets', 'Sets', '🗂️'],
  ['library', 'Tile library', '🧩'],
  ['ai', 'AI', '🤖'],
  ['settlements', 'Settlements', '💰'],
  ['integrations', 'Integrations', '🔌'],
  ['email', 'Email', '✉️'],
  ['backup', 'Backup', '💾'],
];

export default function AdminPage() {
  const [tab, setTab] = useState('entities');
  const [fields, setFields] = useState([]);
  const isMobile = useIsMobile();
  useEffect(() => { api.adminFilterFields().then(setFields).catch(() => setFields([])); }, []);

  const content = (
    <>
      {tab === 'entities' && <Entities fields={fields} />}
      {tab === 'logins' && <AdminLoginsTab />}
      {tab === 'sets' && <Sets />}
      {tab === 'library' && <Library />}
      {tab === 'ai' && <AISettings />}
      {tab === 'settlements' && <Settlements />}
      {tab === 'integrations' && <AdminIntegrations />}
      {tab === 'email' && <MailLog />}
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
        </nav>
        <div style={{ minWidth: 0 }}>{content}</div>
      </div>
    </main>
  );
}

// ─── Clients (Entities) ───────────────────────────────────────────────────────
function Entities({ fields }) {
  const [items, setItems] = useState([]);
  const [suites, setSuites] = useState([]);
  const [sets, setSets] = useState([]);
  const [users, setUsers] = useState([]);
  const [dashTitle, setDashTitle] = useState({});
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const load = () => {
    setLoading(true);
    Promise.all([api.adminListEntities(), api.adminListSuites(), api.adminListSets(), api.adminListUsers(), api.listDashboards()])
      .then(([e, su, s, u, d]) => { setItems(e); setSuites(su); setSets(s); setUsers(u); setDashTitle(Object.fromEntries(d.map((x) => [x.id, x.title]))); })
      .finally(() => setLoading(false));
  };
  useEffect(load, []);
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

  // List view: client names only.
  return (
    <div>
      <p style={hint}>Pick a client to manage its settings, suites and logins.</p>
      <div style={clientList}>
        {items.map((e) => (
          <button key={e.id} className="lift" style={clientRow} onClick={() => setSelectedId(e.id)}>
            <span style={{ fontWeight: 600, fontSize: 15 }}>{e.name}</span>
            <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 12 }}>
              {suitesOf(e.id).length} suite{suitesOf(e.id).length === 1 ? '' : 's'} · {loginsOf(e.id).length} login{loginsOf(e.id).length === 1 ? '' : 's'}
            </span>
            <span style={{ color: '#bbb', marginLeft: 10 }}>›</span>
          </button>
        ))}
        {items.length === 0 && <Muted>No clients yet.</Muted>}
      </div>
      <button style={addBtn} onClick={() => api.adminCreateEntity({ name: 'New client', lockedFilters: {} }).then(load)}>+ Add client</button>
    </div>
  );
}

// Admin team logins — its own top-level admin section (not buried under Clients).
function AdminLoginsTab() {
  const [users, setUsers] = useState(null);
  const [entities, setEntities] = useState([]);
  const load = () => Promise.all([api.adminListUsers(), api.adminListEntities()]).then(([u, e]) => { setUsers(u); setEntities(e); });
  useEffect(() => { load(); }, []);
  if (!users) return <Muted>Loading…</Muted>;
  return <AdminLogins admins={users.filter((u) => u.role === 'admin')} entities={entities} onChange={load} />;
}

// One client's settings hub: a left nav (Settings / Suites / Logins) + panel.
function ClientDetail({ entity, fields, allEntities, allSets, dashTitle, suites, users, allUsers, onChange, onBack }) {
  const [section, setSection] = useState('settings');
  const nav = [['settings', 'Settings'], ['suites', `Suites (${suites.length})`], ['sets', 'Custom sets'], ['briefing', 'Briefing'], ['messages', 'Messages'], ['digests', 'Digests'], ['campaigns', 'Campaigns'], ['segments', 'Segments'], ['settlements', 'Settlements'], ['logins', `Logins (${users.length})`], ['integrations', 'Integrations'], ['email', 'Branding']];
  return (
    <div>
      <button style={miniBtnOutline} onClick={onBack}>← All clients</button>
      <h2 style={{ fontSize: 20, fontWeight: 700, margin: '12px 0 16px' }}>{entity.name}</h2>
      <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <nav style={detailNav}>
          {nav.map(([key, label]) => (
            <button key={key} onClick={() => setSection(key)} style={{ ...detailNavItem, ...(section === key ? detailNavActive : null) }}>{label}</button>
          ))}
        </nav>
        <div style={{ flex: 1, minWidth: 280 }}>
          {section === 'settings' && <ClientSettings entity={entity} suites={suites} fields={fields} onChange={onChange} onBack={onBack} />}
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

// Client settings: name, organiser locks, preview, delete.
function ClientSettings({ entity, suites, fields, onChange, onBack }) {
  const navigate = useNavigate();
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
    try {
      for (const su of suites) {
        const d = await api.mySuite(su.id);
        const first = d.sets.flatMap((s) => s.dashboards)[0];
        if (first) { navigate(`/suite/${su.id}/d/${first.id}`); return; }
      }
      alert('This client has no dashboards to preview yet.');
    } catch (e) { alert('Could not open preview: ' + e.message); }
  };
  return (
    <div style={cardStyle}>
      <Row>
        <input style={{ ...input, fontWeight: 700, flex: 1 }} value={name} onChange={(e) => setName(e.target.value)} />
        <button style={previewBtn} onClick={preview} title="Preview this client's account">👁 Preview account</button>
        <button style={delBtn} onClick={remove}>Delete</button>
      </Row>
      {/* Reference ID — the join key for integrations (Inventive workspace
          externalRefId, future API keys). Read-only; click to copy. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0 14px', fontSize: 12, color: 'var(--muted)' }}>
        <span style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Ref ID</span>
        <code style={{ fontSize: 12, background: 'rgba(128,128,128,0.12)', padding: '3px 8px', borderRadius: 6, userSelect: 'all' }}>{entity.id}</code>
        <button type="button" style={{ padding: '3px 10px', fontSize: 11, fontWeight: 600, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 980, cursor: 'pointer' }} onClick={() => { navigator.clipboard?.writeText(entity.id).catch(() => {}); }} title="Copy — use as the Inventive workspace externalRefId">Copy</button>
        <span>· Inventive workspace ref / integration ID</span>
      </div>
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
        : <LockedFilterEditor value={locks} onChange={setLocks} fields={fields} />}
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

// Full-access team logins. An admin sees every client and the admin console;
// optionally they can ALSO be a customer of chosen clients (the same login can
// open those clients' customer experience). Linking here = the entity profiles
// on the admin login.
function AdminLogins({ admins, entities = [], onChange }) {
  const [form, setForm] = useState({ email: '', password: '', entityIds: [] });
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // { id, email, password, entityIds }
  const nameOf = (id) => entities.find((e) => e.id === id)?.name || id;
  const add = async () => {
    setError(null);
    try { await api.adminCreateUser({ email: form.email, password: form.password, role: 'admin', entityIds: form.entityIds }); setForm({ email: '', password: '', entityIds: [] }); onChange(); }
    catch (e) { setError(e.message); }
  };
  const del = async (u) => { if (confirm(`Delete admin ${u.email}?`)) { await api.adminDeleteUser(u.id); onChange(); } };
  const save = async () => {
    setError(null);
    try {
      const patch = { email: editing.email, entityIds: editing.entityIds };
      if (editing.password) patch.password = editing.password; // blank = keep current
      await api.adminUpdateUser(editing.id, patch);
      setEditing(null); onChange();
    } catch (e) { setError(e.message); }
  };
  return (
    <div style={cardStyle}>
      <p style={hint}>Full-access logins for your team — they see every client and the admin console. Tick clients to also make a login a <b>customer</b> of those clients (they can open that client's customer view from the profile switcher).</p>
      {admins.length === 0 ? <Muted>No admin logins.</Muted> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <tbody>
            {admins.map((u) => (
              editing?.id === u.id ? (
                <tr key={u.id}>
                  <td style={td} colSpan={2}>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                      <input style={input} value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} placeholder="Email" autoComplete="off" />
                      <input style={input} type="text" value={editing.password} onChange={(e) => setEditing({ ...editing, password: e.target.value })} placeholder="New password (blank = keep)" autoComplete="off" />
                    </div>
                    <ClientLinkPicker entities={entities} value={editing.entityIds} onChange={(ids) => setEditing({ ...editing, entityIds: ids })} />
                    <div style={{ marginTop: 8 }}>
                      <button style={miniBtn} onClick={save} disabled={!editing.email.trim()}>Save</button>{' '}
                      <button style={delBtn} onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={u.id}>
                  <td style={td}>
                    {u.email}
                    {(u.entityIds || []).length > 0 && <span style={{ color: 'var(--muted)', fontSize: 11 }}> · customer of {(u.entityIds || []).map(nameOf).join(', ')}</span>}
                  </td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button style={miniBtn} onClick={() => setEditing({ id: u.id, email: u.email, password: '', entityIds: u.entityIds || [] })}>Edit</button>{' '}
                    <button style={delBtn} onClick={() => del(u)} disabled={admins.length === 1} title={admins.length === 1 ? 'Cannot delete the only admin' : ''}>Delete</button>
                  </td>
                </tr>
              )
            ))}
          </tbody>
        </table>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 8 }}>
        <Field label="Email"><input style={input} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Password"><input style={input} type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
        <button style={miniBtn} onClick={add} disabled={!form.email || !form.password}>+ Add admin</button>
      </div>
      {entities.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <L>Also a customer of (optional)</L>
          <ClientLinkPicker entities={entities} value={form.entityIds} onChange={(ids) => setForm({ ...form, entityIds: ids })} />
        </div>
      )}
      {error && <div style={{ color: 'var(--error)', fontSize: 13, marginTop: 6 }}>{error}</div>}
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
function EntityLogins({ entity, users, allUsers = [], onChange }) {
  const [form, setForm] = useState({ email: '', password: '', role: 'owner' });
  const [error, setError] = useState(null);
  const [linkId, setLinkId] = useState('');
  const [linkRole, setLinkRole] = useState('viewer');
  const [roles, setRoles] = useState([]);
  useEffect(() => { api.getRoles().then((r) => setRoles(r.roles || [])).catch(() => setRoles([])); }, []);
  const linkable = allUsers.filter((u) => !(u.entityIds || []).includes(entity.id));
  // This login's role at THIS client (from its membership list).
  const roleOf = (u) => (u.memberships || []).find((m) => m.entityId === entity.id)?.role || 'owner';
  const add = async () => {
    setError(null);
    try {
      const u = await api.adminCreateUser({ email: form.email, password: form.password, role: 'client', entityIds: [entity.id] });
      if (form.role !== 'owner') await api.setMembershipRole(entity.id, u.id, form.role); // owner is the default
      setForm({ email: '', password: '', role: 'owner' });
      onChange();
    } catch (e) { setError(e.message); }
  };
  const link = async () => {
    const u = linkable.find((x) => x.id === linkId);
    if (!u) return;
    await api.adminUpdateUser(u.id, { entityIds: [...(u.entityIds || []), entity.id] });
    await api.setMembershipRole(entity.id, u.id, linkRole);
    setLinkId(''); setLinkRole('viewer'); onChange();
  };
  const changeRole = async (u, role) => { await api.setMembershipRole(entity.id, u.id, role); onChange(); };
  const removeAccess = async (u) => {
    const nextIds = (u.entityIds || []).filter((x) => x !== entity.id);
    await api.adminUpdateUser(u.id, { entityIds: nextIds });
    onChange();
  };
  const del = async (u) => { if (confirm(`Delete login ${u.email}? (removes it for all clients)`)) { await api.adminDeleteUser(u.id); onChange(); } };
  const roleOpts = roles.length ? roles : [{ key: 'owner', label: 'Owner' }];
  return (
    <div>
      {users.length === 0 ? (
        <Muted>No logins yet for this client.</Muted>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td style={td}>
                  {u.email}
                  {u.role === 'admin' && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: 'var(--brand)', border: '1px solid var(--brand)', borderRadius: 980, padding: '1px 7px', verticalAlign: 'middle' }}>HOWLER</span>}
                  {(u.entityIds || []).length > 1 && <span style={{ color: 'var(--muted)', fontSize: 11 }}> · also other clients</span>}
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
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 8 }}>
        <Field label="Email"><input style={input} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Password"><input style={input} type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
        <Field label="Role"><select style={input} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{roleOpts.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select></Field>
        <button style={miniBtn} onClick={add} disabled={!form.email || !form.password}>+ Add login</button>
      </div>
      {linkable.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 10 }}>
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
      {roles.length > 0 && (
        <p style={{ ...hint, marginTop: 10 }}>{roleOpts.find((r) => r.key === form.role)?.description || ''}</p>
      )}
      {error && <div style={{ color: 'var(--error)', fontSize: 13, marginTop: 6 }}>{error}</div>}
    </div>
  );
}

// ─── Custom sets (a client's bespoke collections, hidden from the shared library) ──
function CustomSets({ entity }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [cloneId, setCloneId] = useState('');
  const [imp, setImp] = useState({ lookerDashboardId: '', setId: '', title: '', busy: false, err: '' });
  const load = () => api.getEntitySets(entity.id).then(setData).catch(() => setData({ sets: [], pool: [], templates: [] }));
  // Wrap: load returns a promise, and useEffect would call it as a cleanup fn.
  useEffect(() => { load(); }, [entity.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <Muted>Loading…</Muted>;

  const doImport = async () => {
    if (!imp.lookerDashboardId.trim()) return;
    setImp((s) => ({ ...s, busy: true, err: '' }));
    try { await api.importEntityDashboard(entity.id, { lookerDashboardId: imp.lookerDashboardId.trim(), setId: imp.setId || undefined, title: imp.title || undefined }); setImp({ lookerDashboardId: '', setId: '', title: '', busy: false, err: '' }); load(); }
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
  useEffect(load, []);
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
    const patch = { name, icon, dashboards: ids.map((id) => ({ id, parentId: parents[id] || null })) };
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
        <Section title="Order in this set (drag to reorder · nest a dashboard as a tab of another)">
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
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{byId[id] ? byId[id].title : '(dashboard not found)'}</span>
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
  const [openSets, setOpenSets] = useState({});
  const [name, setName] = useState(suite.name);
  const [icon, setIcon] = useState(suite.icon || '');
  const [entityId, setEntityId] = useState(suite.entityId);
  const [setIds, setSetIds] = useState(suite.setIds || []);
  const [locks, setLocks] = useState(suite.lockedFilters || {});
  const [eventUrl, setEventUrl] = useState(suite.eventUrl || '');
  const [saved, setSaved] = useState(false);
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
  const save = async () => { await api.adminUpdateSuite(suite.id, { name, icon, entityId, setIds, lockedFilters: locks, eventUrl }); flash(setSaved); onChange(); };
  const remove = async () => { if (confirm(`Delete suite "${suite.name}"?`)) { await api.adminDeleteSuite(suite.id); onChange(); } };
  // Open this suite exactly as the client sees it (preview), jumping to its
  // first dashboard. Uses the client suite endpoint (admins can read any suite).
  const preview = async () => {
    try {
      const d = await api.mySuite(suite.id);
      const first = d.sets.flatMap((s) => s.dashboards)[0];
      if (first) navigate(`/suite/${suite.id}/d/${first.id}`);
      else alert('This suite has no dashboards to preview yet.');
    } catch (e) { alert('Could not open preview: ' + e.message); }
  };
  return (
    <div style={cardStyle}>
      <Row>
        <input style={{ ...input, fontWeight: 700, flex: 1 }} value={name} onChange={(e) => setName(e.target.value)} />
        <button style={previewBtn} onClick={preview} title="Preview as the client sees it">👁 Preview</button>
        <button style={delBtn} onClick={remove}>Delete</button>
      </Row>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Client"><select style={input} value={entityId} onChange={(e) => setEntityId(e.target.value)}>{entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        <Field label="Icon"><IconPicker value={icon} onChange={setIcon} /></Field>
      </div>
      <Section title={`Sets in this suite (${setIds.length})`}>
        <div style={checkList}>
          {sets.map((s) => {
            const open = !!openSets[s.id];
            return (
              <div key={s.id}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button onClick={() => setOpenSets((p) => ({ ...p, [s.id]: !p[s.id] }))} title="Show dashboards" style={{ width: 14, border: 'none', background: 'transparent', cursor: 'pointer', color: '#b0b0b6', fontSize: 10, padding: 0, transform: open ? 'rotate(90deg)' : 'none' }}>▶</button>
                  <label style={{ ...checkItem, flex: 1 }}>
                    <input type="checkbox" checked={setIds.includes(s.id)} onChange={() => toggleSet(s.id)} />
                    <span>{s.name} <span style={{ color: 'var(--muted)' }}>({s.dashboardIds.length})</span></span>
                  </label>
                </div>
                {open && (
                  <div style={{ paddingLeft: 26, margin: '2px 0 6px' }}>
                    {s.dashboardIds.length === 0 ? (
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>No dashboards in this set.</div>
                    ) : s.dashboardIds.map((id) => (
                      <div key={id} style={{ fontSize: 12.5, color: 'var(--muted-2, #555)', padding: '2px 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>• {dashTitle[id] || id}</div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {sets.length === 0 && <Muted>Create a Set first.</Muted>}
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
        <Section title="Dashboard access by role">
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
      <Section title="Locked filters (the event, cashless events…)">
        <LockedFilterEditor value={locks} onChange={setLocks} fields={fields} categories={lockCategories} />
      </Section>
      <div style={{ marginTop: 12 }}>
        <L>Ticket / checkout link</L>
        <div style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 6px' }}>The event's buy / checkout URL. Campaigns linked to this event auto-fill it as the call-to-action link.</div>
        <input style={{ ...input, width: '100%' }} value={eventUrl} onChange={(e) => setEventUrl(e.target.value)} placeholder="https://tickets.example.com/your-event" />
      </div>
      <SaveRow onSave={save} saved={saved} id={suite.id} />
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
  { title: 'Organiser Name', label: 'Organiser Name (GA4)', category: 'Event' },
  { title: 'Current Cashless Event', category: 'Cashless', feeds: ['Comparison Cashless Events'] },
  { title: 'Past Cashless Event', category: 'Cashless', feeds: ['Comparison Cashless Events'] },
  { title: 'Comparison Cashless Events', category: 'Cashless' },
];
const LOCK_CATEGORIES = ['Event', 'Cashless'];
const splitVals = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const uniqJoin = (arr) => [...new Set(arr)].join(',');

function LockedFilterEditor({ value, onChange, fields, categories }) {
  // Resolve each preset title to the lock key as it appears in `fields` (byName
  // filters key on their name; real fields on their field id). Fallback to the
  // title so a preset still works if its field isn't in the catalogue.
  const keyByTitle = {};
  for (const f of fields) keyByTitle[(f.title || '').toLowerCase()] = f.field;
  const keyFor = (title) => keyByTitle[title.toLowerCase()] || title;
  const presets = LOCK_PRESETS.map((p) => ({ ...p, key: keyFor(p.title), feedKeys: (p.feeds || []).map(keyFor) }));
  const presetByKey = Object.fromEntries(presets.map((p) => [p.key, p]));
  const presetKeys = new Set(presets.map((p) => p.key));
  // targetKey -> [feeder titles] (for the "auto-filled from …" hint)
  const fedBy = {};
  for (const p of presets) for (const tk of p.feedKeys) (fedBy[tk] = fedBy[tk] || []).push(p.title);

  const [rows, setRows] = useState(() => Object.entries(value || {}).map(([field, vals]) => ({ field, vals })));
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
    for (const r of cleaned) if (r.field) map[r.field] = r.vals || '';
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
  const addRow = () => setRows([...rows, { field: '', vals: '' }]);
  const removeRow = (i) => push(rows.filter((_, j) => j !== i));
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

  const defModel = fields.find((f) => f.model)?.model;
  const defExplore = fields.find((f) => f.explore)?.explore;
  const otherFields = fields.filter((f) => !presetKeys.has(f.field));
  // Scope Event-category pickers to the chosen organiser: when Organiser Name has
  // a value, every other Event filter (Event Name, Current/Past/Comparison, Slug)
  // only suggests events for that organiser. Each explore has its own organiser
  // field — slug lives in a different explore from the organiser — so we resolve
  // the organiser field PER explore from the catalogue and filter within it.
  const ORG_RE = /(^|[._])organiser_?name$|organisers?\.name$/i;
  const orgFieldByExplore = {};
  for (const f of fields) {
    const isOrg = (f.title || '').toLowerCase() === 'organiser name' || ORG_RE.test(f.suggestField || f.field || '');
    if (!isOrg) continue;
    const ex = `${f.model || ''}::${f.explore || ''}`;
    if (!orgFieldByExplore[ex] || (f.title || '').toLowerCase() === 'organiser name') orgFieldByExplore[ex] = f.suggestField || f.field;
  }
  const orgKey = keyFor('Organiser Name');
  const orgRow = rows.find((x) => x.field === orgKey);
  const orgVals = orgRow ? splitVals(orgRow.vals) : [];
  // The organiser filter for a target picker's explore (null if none / it IS the
  // organiser row / no organiser value set).
  const orgScopeFor = (meta, field, category) => {
    if (category !== 'Event' || field === orgKey || !orgVals.length || !meta) return null;
    const orgField = orgFieldByExplore[`${meta.model || ''}::${meta.explore || ''}`];
    return orgField ? { [orgField]: orgVals.join(',') } : null;
  };

  return (
    <div style={{ margin: '6px 0 4px' }}>
      {/* Same per-filter row as before (select + value side by side); two rows sit
          next to each other on wider screens, one-up when narrow. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 460px), 1fr))', gap: '4px 24px', alignItems: 'start' }}>
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
                  {LOCK_CATEGORIES.map((cat) => (
                    <optgroup key={cat} label={cat}>
                      {presets.filter((p) => p.category === cat).map((p) => <option key={p.key} value={p.key}>{p.label || p.title}{p.feeds ? ' →' : ''}</option>)}
                    </optgroup>
                  ))}
                  {otherFields.length > 0 && (
                    <optgroup label="Other fields">
                      {otherFields.map((f) => <option key={f.field} value={f.field}>{f.byName ? `${f.title} — filter` : `${f.title} (${f.field})`}</option>)}
                    </optgroup>
                  )}
                  <option value="__custom">✎ Custom field…</option>
                </select>
                {isCustom && (
                  <input
                    style={{ ...input, minWidth: 220 }}
                    value={r.field}
                    onChange={(e) => setRow(i, { field: e.target.value, custom: true })}
                    placeholder="Looker field, e.g. core_events.is_past"
                  />
                )}
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
        <button style={miniBtn} onClick={() => seedDefaults(categories && categories.length ? categories : LOCK_CATEGORIES, { force: true })}>+ Add default filters</button>
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
  useEffect(load, [search, category]);

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
      </Sec>

      <Sec title="Per-client (Admin → Clients → [client])" count={d.clients.length}>
        {d.clients.map((c) => {
          const has = c.aiContext || c.events.length || c.digests.length || c.readerTunes.length;
          return (
            <details key={c.id} style={grp}>
              <summary style={sum}>{c.name}{!has ? <span style={{ ...meta, fontWeight: 400 }}> — no custom AI instructions</span> : null}</summary>
              {c.aiContext && (<><div style={lbl}>Client AI context</div><pre style={pre}>{c.aiContext}</pre></>)}
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
function AdminIntegrations() {
  const [value, setValue] = useState(null);
  const [clients, setClients] = useState([]);
  useEffect(() => { api.getAdminIntegrations().then(setValue); }, []);
  useEffect(() => { api.adminListEntities().then((e) => setClients((e || []).map((x) => ({ id: x.id, name: x.name })))).catch(() => {}); }, []);
  if (!value) return <Muted>Loading…</Muted>;
  return (
    <div>
      <p style={hint}>Everything below is collapsed — tap a section to open it. Accounts override the values in <code>.env</code>; clients can set their own Looker/Anthropic (Client → Integrations), which take precedence for their data.</p>
      <Section title="🔑 Accounts — Looker · Anthropic · Email · Inventive">
        <IntegrationsForm value={value} showResend showInventive clients={clients} onTestEmail={() => api.sendMailTest()} onSave={async (p) => setValue(await api.saveAdminIntegrations(p))} />
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
    </div>
  );
}

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

// Per-client integrations (admin), shown inside a client's detail nav.
function ClientIntegrations({ entity }) {
  const [value, setValue] = useState(null);
  useEffect(() => { api.getEntityIntegrations(entity.id).then(setValue); }, [entity.id]);
  if (!value) return <Muted>Loading…</Muted>;
  return (
    <div>
      <p style={hint}>Optional per-client accounts. Anything left blank falls back to the platform default (Admin → Integrations).</p>
      <IntegrationsForm value={value} lookerActive={false} onSave={async (p) => setValue(await api.saveEntityIntegrations(entity.id, p))} />
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
  useEffect(load, [entityId]); // eslint-disable-line react-hooks/exhaustive-deps

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
                <EventPicker value={doc.eventName} onChange={(v) => api.adminUpdateDocument(doc.id, { eventName: v }).then(load)} eventNames={eventNames} style={{ ...input, minWidth: 150, maxWidth: 190 }} />
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
function EventPicker({ value, onChange, eventNames, style }) {
  const known = [...new Set((eventNames || []).filter(Boolean))];
  const custom = !!value && !known.includes(value);
  const [typing, setTyping] = useState(false);
  if (typing || known.length === 0) {
    return (
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <input style={style} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Event name" autoFocus={typing} />
        {known.length > 0 && <button style={miniBtnOutline} title="Pick from known events" onClick={() => setTyping(false)}>▾</button>}
      </span>
    );
  }
  return (
    <select
      style={style}
      value={custom ? '__custom' : value}
      onChange={(e) => {
        if (e.target.value === '__other') { setTyping(true); onChange(''); }
        else if (e.target.value !== '__custom') onChange(e.target.value);
      }}
    >
      <option value="">— Assign to event —</option>
      {known.map((n) => <option key={n} value={n}>{n}</option>)}
      {custom && <option value="__custom">{value} (custom)</option>}
      <option value="__other">Other / new event…</option>
    </select>
  );
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
function Section({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginTop: 14 }}>
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
const clientRow = { display: 'flex', alignItems: 'center', width: '100%', textAlign: 'left', background: 'var(--card)', border: '1px solid #e6e6e6', borderRadius: 10, padding: '14px 16px', cursor: 'pointer', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' };
const detailNav = { display: 'flex', flexDirection: 'column', gap: 4, width: 170, flexShrink: 0 };
const detailNavItem = { textAlign: 'left', padding: '9px 13px', border: 'none', background: 'transparent', borderRadius: 8, fontSize: 14, fontWeight: 600, color: 'var(--muted-2, #555)', cursor: 'pointer' };
const detailNavActive = { background: 'var(--brand)', color: '#fff' };
const delBtn = { padding: '6px 12px', background: 'var(--card)', color: 'var(--error)', border: '1.5px solid #f0c0c0', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' };
const previewBtn = { padding: '6px 12px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' };
const th = { textAlign: 'left', padding: '8px 10px', borderBottom: '2px solid #e0e0e0', fontSize: 12, color: 'var(--muted)' };
const td = { padding: '8px 10px', borderBottom: '1px solid var(--hairline)' };
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
