import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import IntegrationsForm from '../components/IntegrationsForm.jsx';
import MailTemplateEditor from '../components/MailTemplateEditor.jsx';
import OwlAddressCard from '../components/OwlAddressCard.jsx';
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
export default function AdminPage() {
  const [tab, setTab] = useState('entities');
  const [fields, setFields] = useState([]);
  useEffect(() => { api.adminFilterFields().then(setFields).catch(() => setFields([])); }, []);

  return (
    <main style={{ flex: 1, padding: '28px 24px', maxWidth: 1040, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        <Link to="/" style={{ color: 'var(--muted)', fontSize: 13, textDecoration: 'none' }}>← Back</Link>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>Admin</h1>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        <Tab active={tab === 'entities'} onClick={() => setTab('entities')}>Clients</Tab>
        <Tab active={tab === 'sets'} onClick={() => setTab('sets')}>Sets</Tab>
        <Tab active={tab === 'library'} onClick={() => setTab('library')}>Tile library</Tab>
        <Tab active={tab === 'ai'} onClick={() => setTab('ai')}>AI</Tab>
        <Tab active={tab === 'settlements'} onClick={() => setTab('settlements')}>Settlements</Tab>
        <Tab active={tab === 'integrations'} onClick={() => setTab('integrations')}>Integrations</Tab>
        <Tab active={tab === 'backup'} onClick={() => setTab('backup')}>Backup</Tab>
      </div>
      {tab === 'entities' && <Entities fields={fields} />}
      {tab === 'sets' && <Sets />}
      {tab === 'library' && <Library />}
      {tab === 'ai' && <AISettings />}
      {tab === 'settlements' && <Settlements />}
      {tab === 'integrations' && <AdminIntegrations />}
      {tab === 'backup' && <BackupRestore />}
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
  const loginsOf = (eid) => users.filter((u) => u.role !== 'admin' && (u.entityIds || []).includes(eid));

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

      <div style={{ marginTop: 32 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Admin logins</h3>
        <AdminLogins admins={users.filter((u) => u.role === 'admin')} onChange={load} />
      </div>
    </div>
  );
}

// One client's settings hub: a left nav (Settings / Suites / Logins) + panel.
function ClientDetail({ entity, fields, allEntities, allSets, dashTitle, suites, users, onChange, onBack }) {
  const [section, setSection] = useState('settings');
  const nav = [['settings', 'Settings'], ['suites', `Suites (${suites.length})`], ['briefing', 'Briefing'], ['messages', 'Messages'], ['settlements', 'Settlements'], ['logins', `Logins (${users.length})`], ['integrations', 'Integrations'], ['email', 'Email branding']];
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
          {section === 'settlements' && <Settlements entityId={entity.id} />}
          {section === 'logins' && <EntityLogins entity={entity} users={users} onChange={onChange} />}
          {section === 'integrations' && <ClientIntegrations entity={entity} />}
          {section === 'email' && (
            <div>
              <p style={hint}>This client's email branding. Anything left blank inherits the Howler platform default. Sends still come from Howler's verified domain.</p>
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
  const [saved, setSaved] = useState(false);
  const save = async () => { await api.adminUpdateEntity(entity.id, { name, logo, aiContext, lockedFilters: locks }); flash(setSaved); onChange(); };
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
      <div style={{ marginBottom: 12 }}>
        <L>Client logo</L>
        <div style={{ marginTop: 6 }}><LogoPicker value={logo} onChange={setLogo} /></div>
      </div>
      <L>Locked filters (organiser-level — apply across all this client's sets)</L>
      <LockedFilterEditor value={locks} onChange={setLocks} fields={fields} />
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
  const addSuite = async () => { await api.adminCreateSuite({ entityId: entity.id, name: 'New suite', lockedFilters: {}, setIds: [] }); onChange(); };
  return (
    <div>
      {suites.map((su) => (
        <SuiteCard key={su.id} suite={su} entities={allEntities} sets={allSets} dashTitle={dashTitle} fields={fields} onChange={onChange} />
      ))}
      {suites.length === 0 && <Muted>No suites yet.</Muted>}
      <button style={addBtn} onClick={addSuite}>+ Add suite</button>
    </div>
  );
}

// Full-access team logins (not tied to any client).
function AdminLogins({ admins, onChange }) {
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // { id, email, password }
  const add = async () => {
    setError(null);
    try { await api.adminCreateUser({ email: form.email, password: form.password, role: 'admin', entityIds: [] }); setForm({ email: '', password: '' }); onChange(); }
    catch (e) { setError(e.message); }
  };
  const del = async (u) => { if (confirm(`Delete admin ${u.email}?`)) { await api.adminDeleteUser(u.id); onChange(); } };
  const save = async () => {
    setError(null);
    try {
      const patch = { email: editing.email };
      if (editing.password) patch.password = editing.password; // blank = keep current
      await api.adminUpdateUser(editing.id, patch);
      setEditing(null); onChange();
    } catch (e) { setError(e.message); }
  };
  return (
    <div style={cardStyle}>
      <p style={hint}>Full-access logins for your team — they see every client and the admin console.</p>
      {admins.length === 0 ? <Muted>No admin logins.</Muted> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <tbody>
            {admins.map((u) => (
              editing?.id === u.id ? (
                <tr key={u.id}>
                  <td style={td}>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <input style={input} value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} placeholder="Email" autoComplete="off" />
                      <input style={input} type="text" value={editing.password} onChange={(e) => setEditing({ ...editing, password: e.target.value })} placeholder="New password (blank = keep)" autoComplete="off" />
                    </div>
                  </td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button style={miniBtn} onClick={save} disabled={!editing.email.trim()}>Save</button>{' '}
                    <button style={delBtn} onClick={() => setEditing(null)}>Cancel</button>
                  </td>
                </tr>
              ) : (
                <tr key={u.id}>
                  <td style={td}>{u.email}</td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button style={miniBtn} onClick={() => setEditing({ id: u.id, email: u.email, password: '' })}>Edit</button>{' '}
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
      {error && <div style={{ color: 'var(--error)', fontSize: 13, marginTop: 6 }}>{error}</div>}
    </div>
  );
}
// Compact login management scoped to one client: list its logins (remove access
// or delete) and add a new client login pre-assigned to this entity.
function EntityLogins({ entity, users, onChange }) {
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState(null);
  const add = async () => {
    setError(null);
    try {
      await api.adminCreateUser({ email: form.email, password: form.password, role: 'client', entityIds: [entity.id] });
      setForm({ email: '', password: '' });
      onChange();
    } catch (e) { setError(e.message); }
  };
  const removeAccess = async (u) => {
    const nextIds = (u.entityIds || []).filter((x) => x !== entity.id);
    await api.adminUpdateUser(u.id, { entityIds: nextIds });
    onChange();
  };
  const del = async (u) => { if (confirm(`Delete login ${u.email}? (removes it for all clients)`)) { await api.adminDeleteUser(u.id); onChange(); } };
  return (
    <div>
      {users.length === 0 ? (
        <Muted>No logins yet for this client.</Muted>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td style={td}>{u.email}{(u.entityIds || []).length > 1 && <span style={{ color: 'var(--muted)', fontSize: 11 }}> · also other clients</span>}</td>
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
        <button style={miniBtn} onClick={add} disabled={!form.email || !form.password}>+ Add login</button>
      </div>
      {error && <div style={{ color: 'var(--error)', fontSize: 13, marginTop: 6 }}>{error}</div>}
    </div>
  );
}

// ─── Sets (reusable dashboard collections: Ticketing, Cashless, …) ────────────
function Sets() {
  const [items, setItems] = useState([]);
  const [dashboards, setDashboards] = useState([]);
  const [loading, setLoading] = useState(true);
  const load = () => { setLoading(true); Promise.all([api.adminListSets(), api.listDashboards()]).then(([t, d]) => { setItems(t); setDashboards(d); }).finally(() => setLoading(false)); };
  useEffect(load, []);
  if (loading) return <Muted>Loading…</Muted>;
  return (
    <div>
      <p style={hint}>A Set is a reusable group of dashboards (e.g. Ticketing, Cashless). Bundle them into a client's Suite.</p>
      {items.map((t) => <SetCard key={t.id} set={t} dashboards={dashboards} onChange={load} />)}
      <button style={addBtn} onClick={() => api.adminCreateSet({ name: 'New set', dashboardIds: [] }).then(load)}>+ Add set</button>
    </div>
  );
}
function SetCard({ set, dashboards, onChange }) {
  const [name, setName] = useState(set.name);
  const [icon, setIcon] = useState(set.icon || '');
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
    await api.adminUpdateSet(set.id, { name, icon, dashboards: ids.map((id) => ({ id, parentId: parents[id] || null })) });
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
  const [saved, setSaved] = useState(false);
  const toggleSet = (id) => setSetIds((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  const setById = Object.fromEntries(sets.map((s) => [s.id, s]));
  const dragFrom = useRef(null);
  const [dragOver, setDragOver] = useState(null);
  const onDragOverRow = (i) => {
    const from = dragFrom.current;
    if (from === null || from === i) { setDragOver(i); return; }
    setSetIds((cur) => { const n = cur.slice(); const [m] = n.splice(from, 1); n.splice(i, 0, m); return n; });
    dragFrom.current = i; setDragOver(i);
  };
  const save = async () => { await api.adminUpdateSuite(suite.id, { name, icon, entityId, setIds, lockedFilters: locks }); flash(setSaved); onChange(); };
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
      <Section title="Locked filters (the event, cashless events…)">
        <LockedFilterEditor value={locks} onChange={setLocks} fields={fields} />
      </Section>
      <SaveRow onSave={save} saved={saved} id={suite.id} />
    </div>
  );
}

// ─── Locked-filter editor (field → value(s)) ──────────────────────────────────
// Keeps its own row state so in-progress (empty) rows persist; pushes only
// completed rows (with a field) up to the parent as a { field: "v1,v2" } map.
function LockedFilterEditor({ value, onChange, fields }) {
  const [rows, setRows] = useState(() => Object.entries(value || {}).map(([field, vals]) => ({ field, vals })));
  const push = (next) => {
    setRows(next);
    const map = {};
    for (const r of next) if (r.field) map[r.field] = r.vals || '';
    onChange(map);
  };
  const setRow = (i, patch) => push(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows([...rows, { field: '', vals: '' }]); // empty row → no map change yet
  const removeRow = (i) => push(rows.filter((_, j) => j !== i));

  // Custom (typed) fields get value suggestions from the main explore.
  const defModel = fields.find((f) => f.model)?.model;
  const defExplore = fields.find((f) => f.explore)?.explore;

  return (
    <div style={{ margin: '6px 0 4px' }}>
      {rows.map((r, i) => {
        const known = fields.find((f) => f.field === r.field);
        const isCustom = r.custom || (!!r.field && !known);
        // meta drives value suggestions — use the option's suggestField (a real
        // Looker dimension) even when the lock key is a filter name.
        const meta = known
          ? { field: known.suggestField || known.field, model: known.model, explore: known.explore }
          : (r.field ? { field: r.field, model: defModel, explore: defExplore } : null);
        return (
          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <select
                style={{ ...input, minWidth: 240 }}
                value={isCustom ? '__custom' : r.field}
                onChange={(e) => (e.target.value === '__custom' ? setRow(i, { custom: true, field: '' }) : setRow(i, { custom: false, field: e.target.value }))}
              >
                <option value="">Choose a field…</option>
                {fields.map((f) => <option key={f.field} value={f.field}>{f.byName ? `${f.title} — filter` : `${f.title} (${f.field})`}</option>)}
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
            </div>
            <ValuePicker meta={meta} value={r.vals} onChange={(v) => setRow(i, { vals: v })} />
            <button style={delBtn} onClick={() => removeRow(i)} title="Remove">✕</button>
          </div>
        );
      })}
      <button style={miniBtn} onClick={addRow}>+ Add locked filter</button>
    </div>
  );
}

// Value picker for a locked filter: selected values shown as chips, plus a
// search box that queries Looker server-side (works with thousands of values).
function ValuePicker({ meta, value, onChange }) {
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
      try { const d = await api.filterSuggest({ model: meta.model, explore: meta.explore, field: meta.field, q, pair: true }); if (alive) setResults(d.suggestions || []); }
      catch { if (alive) setResults([]); }
      finally { if (alive) setLoading(false); }
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [q, open, canSuggest, meta]);

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
      <div style={cardStyle}>
        <L>Global AI instructions</L>
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
      </div>
      <BriefingSettings />
      <BriefingFeedback />
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
    <div style={{ ...cardStyle, marginTop: 14 }}>
      <L>Home briefing</L>
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 8px' }}>
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

// ─── Integrations (admin: primary Looker + Anthropic accounts) ─────────────────
function AdminIntegrations() {
  const [value, setValue] = useState(null);
  useEffect(() => { api.getAdminIntegrations().then(setValue); }, []);
  if (!value) return <Muted>Loading…</Muted>;
  return (
    <div>
      <p style={hint}>The primary Looker, Anthropic and email accounts for the whole platform. These override the values in <code>.env</code>. Clients can set their own Looker/Anthropic (Client → Integrations), which take precedence for their data.</p>
      <IntegrationsForm value={value} showResend onTestEmail={() => api.sendMailTest()} onSave={async (p) => setValue(await api.saveAdminIntegrations(p))} />
      <h3 style={{ fontSize: 15, fontWeight: 700, margin: '24px 0 4px' }}>Email template — platform default</h3>
      <p style={hint}>The default look of every notification email. Each client can layer their own branding on top (Client → Email branding).</p>
      <MailTemplateEditor scope="platform" canTest />
      <h3 style={{ fontSize: 15, fontWeight: 700, margin: '28px 0 4px' }}>Inbound email — CC the Owl</h3>
      <p style={hint}>Lets emails be captured into client inboxes by CC’ing a per-client address. Set the inbound domain, then point your mail forwarder at the webhook below.</p>
      <InboundConfig />
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
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const load = () => { api.osInbox(entity.id).then((r) => setThreads(r.threads)).catch(() => setThreads([])); };
  useEffect(() => { load(); }, [entity.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function send() {
    if (!body.trim()) return;
    setBusy(true);
    try { await api.osAnnounce({ entityId: entity.id, title, body, priority }); setTitle(''); setBody(''); setPriority('normal'); flash(setSent); load(); }
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <select style={input} value={priority} onChange={(e) => setPriority(e.target.value)}>
            {Object.entries(PRI).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <span style={{ flex: 1 }} />
          {sent && <SavedChip />}
          <button style={{ ...saveBtn }} onClick={send} disabled={busy || !body.trim()}>{busy ? 'Sending…' : 'Send message'}</button>
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
// Collapsible labelled section with a caret toggle.
function Section({ title, children, defaultOpen = true }) {
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
