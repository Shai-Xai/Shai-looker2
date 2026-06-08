import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';

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
      </div>
      {tab === 'entities' && <Entities fields={fields} />}
      {tab === 'sets' && <Sets />}
      {tab === 'library' && <Library />}
      {tab === 'ai' && <AISettings />}
    </main>
  );
}

// ─── Clients (Entities) ───────────────────────────────────────────────────────
function Entities({ fields }) {
  const [items, setItems] = useState([]);
  const [suites, setSuites] = useState([]);
  const [sets, setSets] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const load = () => {
    setLoading(true);
    Promise.all([api.adminListEntities(), api.adminListSuites(), api.adminListSets(), api.adminListUsers()])
      .then(([e, su, s, u]) => { setItems(e); setSuites(su); setSets(s); setUsers(u); })
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
function ClientDetail({ entity, fields, allEntities, allSets, suites, users, onChange, onBack }) {
  const [section, setSection] = useState('settings');
  const nav = [['settings', 'Settings'], ['suites', `Suites (${suites.length})`], ['logins', `Logins (${users.length})`]];
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
          {section === 'suites' && <ClientSuites entity={entity} suites={suites} allEntities={allEntities} allSets={allSets} fields={fields} onChange={onChange} />}
          {section === 'logins' && <EntityLogins entity={entity} users={users} onChange={onChange} />}
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
  const [locks, setLocks] = useState(entity.lockedFilters || {});
  const [saved, setSaved] = useState(false);
  const save = async () => { await api.adminUpdateEntity(entity.id, { name, logo, lockedFilters: locks }); flash(setSaved); onChange(); };
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
      <SaveRow onSave={save} saved={saved} id={entity.id} />
    </div>
  );
}

// Client suites: the full suite editor for each, plus add.
function ClientSuites({ entity, suites, allEntities, allSets, fields, onChange }) {
  const addSuite = async () => { await api.adminCreateSuite({ entityId: entity.id, name: 'New suite', lockedFilters: {}, setIds: [] }); onChange(); };
  return (
    <div>
      {suites.map((su) => (
        <SuiteCard key={su.id} suite={su} entities={allEntities} sets={allSets} fields={fields} onChange={onChange} />
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
  const add = async () => {
    setError(null);
    try { await api.adminCreateUser({ email: form.email, password: form.password, role: 'admin', entityIds: [] }); setForm({ email: '', password: '' }); onChange(); }
    catch (e) { setError(e.message); }
  };
  const del = async (u) => { if (confirm(`Delete admin ${u.email}?`)) { await api.adminDeleteUser(u.id); onChange(); } };
  return (
    <div style={cardStyle}>
      <p style={hint}>Full-access logins for your team — they see every client and the admin console.</p>
      {admins.length === 0 ? <Muted>No admin logins.</Muted> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <tbody>
            {admins.map((u) => (
              <tr key={u.id}>
                <td style={td}>{u.email}</td>
                <td style={{ ...td, textAlign: 'right' }}>
                  <button style={delBtn} onClick={() => del(u)} disabled={admins.length === 1} title={admins.length === 1 ? 'Cannot delete the only admin' : ''}>Delete</button>
                </td>
              </tr>
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
  const [folder, setFolder] = useState(''); // '' = all, '__unfiled', else folder name
  const [saved, setSaved] = useState(false);
  const toggle = (id) => setIds((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  const save = async () => { await api.adminUpdateSet(set.id, { name, icon, dashboardIds: ids }); flash(setSaved); onChange(); };
  const remove = async () => { if (confirm(`Delete set "${set.name}"?`)) { await api.adminDeleteSet(set.id); onChange(); } };

  const folders = [...new Set(dashboards.map((d) => d.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const visible = dashboards.filter((d) => folder === '' || (folder === '__unfiled' ? !d.folder : d.folder === folder));
  const addAll = () => setIds((cur) => [...new Set([...cur, ...visible.map((d) => d.id)])]);

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
  const removeId = (id) => setIds((cur) => cur.filter((x) => x !== id));

  return (
    <div style={cardStyle}>
      <Row>
        <input style={{ ...input, fontWeight: 700, flex: 1 }} value={name} onChange={(e) => setName(e.target.value)} />
        <button style={delBtn} onClick={remove}>Delete</button>
      </Row>
      <Field label="Icon"><IconPicker value={icon} onChange={setIcon} /></Field>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
        <Field label="Folder">
          <select style={input} value={folder} onChange={(e) => setFolder(e.target.value)}>
            <option value="">All folders</option>
            {folders.map((f) => <option key={f} value={f}>{f}</option>)}
            <option value="__unfiled">Unfiled</option>
          </select>
        </Field>
        {folder !== '' && visible.length > 0 && <button style={miniBtn} onClick={addAll}>+ Add all in folder</button>}
        <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>{ids.length} selected</span>
      </div>
      <div style={checkList}>
        {visible.map((d) => (
          <label key={d.id} style={checkItem}>
            <input type="checkbox" checked={ids.includes(d.id)} onChange={() => toggle(d.id)} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}{!d.folder && <span style={{ color: '#bbb' }}> · unfiled</span>}</span>
          </label>
        ))}
        {visible.length === 0 && <Muted>No dashboards{folder ? ' in this folder' : ' yet'}.</Muted>}
      </div>
      {ids.length > 0 && (
        <>
          <L>Order in this set (drag to reorder)</L>
          <div style={orderList}>
            {ids.map((id, i) => (
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
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{byId[id] ? byId[id].title : '(dashboard not found)'}</span>
                <button style={{ ...orderBtn, color: 'var(--error)' }} onClick={() => removeId(id)} title="Remove from set">✕</button>
              </div>
            ))}
          </div>
        </>
      )}
      <SaveRow onSave={save} saved={saved} id={set.id} />
    </div>
  );
}

// ─── Suite editor (a client's event context: locks + bundled Sets) ────────────
// Rendered inside a client's Suites section (see ClientSuites).
function SuiteCard({ suite, entities, sets, fields, onChange }) {
  const navigate = useNavigate();
  const [name, setName] = useState(suite.name);
  const [icon, setIcon] = useState(suite.icon || '');
  const [entityId, setEntityId] = useState(suite.entityId);
  const [setIds, setSetIds] = useState(suite.setIds || []);
  const [locks, setLocks] = useState(suite.lockedFilters || {});
  const [saved, setSaved] = useState(false);
  const toggleSet = (id) => setSetIds((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
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
      <L>Sets in this suite ({setIds.length})</L>
      <div style={checkList}>
        {sets.map((s) => (
          <label key={s.id} style={checkItem}>
            <input type="checkbox" checked={setIds.includes(s.id)} onChange={() => toggleSet(s.id)} />
            <span>{s.name} <span style={{ color: 'var(--muted)' }}>({s.dashboardIds.length})</span></span>
          </label>
        ))}
        {sets.length === 0 && <Muted>Create a Set first.</Muted>}
      </div>
      <L>Locked filters (the event, cashless events…)</L>
      <LockedFilterEditor value={locks} onChange={setLocks} fields={fields} />
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
      {saved && <span style={{ color: 'var(--success)', fontSize: 13 }}>✓ Saved</span>}
      <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 'auto' }}>id: {id.slice(0, 8)}</span>
    </div>
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
          style={{ width: '100%', boxSizing: 'border-box', marginTop: 6, padding: '10px 12px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 13, outline: 'none', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <button style={saveBtn} onClick={save} disabled={text === orig}>Save</button>
          {saved && <span style={{ color: 'var(--success)', fontSize: 13 }}>✓ Saved</span>}
          <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>{text.length} characters</span>
        </div>
      </div>
    </div>
  );
}

function Tab({ active, onClick, children }) {
  return <button onClick={onClick} style={{ padding: '8px 16px', borderRadius: 8, border: active ? '1.5px solid var(--brand)' : '1.5px solid #e0e0e0', background: active ? 'var(--brand)' : '#fff', color: active ? '#fff' : 'var(--text)', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>{children}</button>;
}
function Field({ label, children }) { return <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><L>{label}</L>{children}</div>; }
function L({ children }) { return <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{children}</span>; }
function Muted({ children }) { return <p style={{ color: 'var(--muted)' }}>{children}</p>; }

const hint = { fontSize: 13, color: 'var(--muted)', marginBottom: 14 };
const cardStyle = { background: '#fff', border: '1px solid #e0e0e0', borderRadius: 12, padding: 18, marginBottom: 14, boxShadow: '0 1px 6px rgba(0,0,0,0.05)' };
const input = { padding: '8px 10px', border: '1.5px solid #e0e0e0', borderRadius: 7, fontSize: 13, outline: 'none', boxSizing: 'border-box', minWidth: 160 };
const saveBtn = { padding: '8px 16px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const addBtn = { padding: '9px 16px', background: '#f7f7f7', border: '1.5px solid #e0e0e0', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const miniBtn = { padding: '6px 12px', background: '#f7f7f7', border: '1.5px solid #e0e0e0', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' };
const miniBtnOutline = { padding: '5px 11px', background: '#fff', border: '1.5px solid #e0e0e0', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer', color: 'var(--text)' };
const clientList = { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 };
const clientRow = { display: 'flex', alignItems: 'center', width: '100%', textAlign: 'left', background: '#fff', border: '1px solid #e6e6e6', borderRadius: 10, padding: '14px 16px', cursor: 'pointer', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' };
const detailNav = { display: 'flex', flexDirection: 'column', gap: 4, width: 170, flexShrink: 0 };
const detailNavItem = { textAlign: 'left', padding: '9px 13px', border: 'none', background: 'transparent', borderRadius: 8, fontSize: 14, fontWeight: 600, color: 'var(--muted-2, #555)', cursor: 'pointer' };
const detailNavActive = { background: 'var(--brand)', color: '#fff' };
const delBtn = { padding: '6px 12px', background: '#fff', color: 'var(--error)', border: '1.5px solid #f0c0c0', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' };
const previewBtn = { padding: '6px 12px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' };
const th = { textAlign: 'left', padding: '8px 10px', borderBottom: '2px solid #e0e0e0', fontSize: 12, color: 'var(--muted)' };
const td = { padding: '8px 10px', borderBottom: '1px solid #f0f0f0' };
const checkList = { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto', border: '1px solid #eee', borderRadius: 8, padding: 10, margin: '6px 0' };
const checkItem = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' };
const orderList = { display: 'flex', flexDirection: 'column', gap: 4, border: '1px solid #eee', borderRadius: 8, padding: 8, margin: '6px 0' };
const orderRow = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '4px 2px' };
const orderBtn = { width: 26, height: 26, flexShrink: 0, border: '1px solid #e0e0e0', borderRadius: 6, background: '#fafafa', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0 };
const pickBtn = { position: 'absolute', right: 4, top: 4, padding: '4px 8px', fontSize: 11, fontWeight: 600, border: '1px solid #e0e0e0', borderRadius: 5, background: '#fafafa', cursor: 'pointer' };
const ddList = { position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, marginTop: 4, background: '#fff', border: '1px solid #e0e0e0', borderRadius: 8, boxShadow: '0 6px 20px rgba(0,0,0,0.12)', maxHeight: 220, overflowY: 'auto', listStyle: 'none', margin: 0, padding: '4px 0' };
const ddItem = { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', fontSize: 13, cursor: 'pointer' };
const ddMuted = { padding: '7px 12px', fontSize: 13, color: 'var(--muted)' };
const iconPreview = { width: 38, height: 38, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--hairline)', borderRadius: 10, background: '#fafafa' };
const iconChip = { width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, border: '1px solid #e6e6e6', borderRadius: 8, background: '#fff', cursor: 'pointer', padding: 0, lineHeight: 1 };
const logoPreview = { width: 120, height: 56, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--hairline)', borderRadius: 10, background: '#fafafa', padding: 6, boxSizing: 'border-box' };
const chip = { display: 'inline-flex', alignItems: 'center', gap: 2, background: '#fff0f3', color: 'var(--brand)', borderRadius: 980, padding: '3px 10px', fontSize: 12, fontWeight: 600 };
