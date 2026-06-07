import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';

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
        <Tab active={tab === 'templates'} onClick={() => setTab('templates')}>Templates</Tab>
        <Tab active={tab === 'sets'} onClick={() => setTab('sets')}>Dashboard Sets</Tab>
        <Tab active={tab === 'users'} onClick={() => setTab('users')}>Logins</Tab>
      </div>
      {tab === 'entities' && <Entities fields={fields} />}
      {tab === 'templates' && <Templates />}
      {tab === 'sets' && <Sets fields={fields} />}
      {tab === 'users' && <Users />}
    </main>
  );
}

// ─── Clients (Entities) ───────────────────────────────────────────────────────
function Entities({ fields }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const load = () => { setLoading(true); api.adminListEntities().then(setItems).finally(() => setLoading(false)); };
  useEffect(load, []);
  if (loading) return <Muted>Loading…</Muted>;
  return (
    <div>
      <p style={hint}>A client (entity) is locked to its organiser(s). These filters are forced onto every query the client runs.</p>
      {items.map((e) => <EntityCard key={e.id} entity={e} fields={fields} onChange={load} />)}
      <button style={addBtn} onClick={() => api.adminCreateEntity({ name: 'New client', lockedFilters: {} }).then(load)}>+ Add client</button>
    </div>
  );
}
function EntityCard({ entity, fields, onChange }) {
  const [name, setName] = useState(entity.name);
  const [locks, setLocks] = useState(entity.lockedFilters || {});
  const [saved, setSaved] = useState(false);
  const save = async () => { await api.adminUpdateEntity(entity.id, { name, lockedFilters: locks }); flash(setSaved); onChange(); };
  const remove = async () => { if (confirm(`Delete client "${entity.name}"? This removes its sets too.`)) { await api.adminDeleteEntity(entity.id); onChange(); } };
  return (
    <div style={cardStyle}>
      <Row>
        <input style={{ ...input, fontWeight: 700, flex: 1 }} value={name} onChange={(e) => setName(e.target.value)} />
        <button style={delBtn} onClick={remove}>Delete</button>
      </Row>
      <L>Locked filters (organiser-level — apply across all this client's sets)</L>
      <LockedFilterEditor value={locks} onChange={setLocks} fields={fields} />
      <SaveRow onSave={save} saved={saved} id={entity.id} />
    </div>
  );
}

// ─── Templates ────────────────────────────────────────────────────────────────
function Templates() {
  const [items, setItems] = useState([]);
  const [dashboards, setDashboards] = useState([]);
  const [loading, setLoading] = useState(true);
  const load = () => { setLoading(true); Promise.all([api.adminListTemplates(), api.listDashboards()]).then(([t, d]) => { setItems(t); setDashboards(d); }).finally(() => setLoading(false)); };
  useEffect(load, []);
  if (loading) return <Muted>Loading…</Muted>;
  return (
    <div>
      <p style={hint}>A template is a reusable group of dashboards. Apply it to clients via Dashboard Sets.</p>
      {items.map((t) => <TemplateCard key={t.id} template={t} dashboards={dashboards} onChange={load} />)}
      <button style={addBtn} onClick={() => api.adminCreateTemplate({ name: 'New template', dashboardIds: [] }).then(load)}>+ Add template</button>
    </div>
  );
}
function TemplateCard({ template, dashboards, onChange }) {
  const [name, setName] = useState(template.name);
  const [ids, setIds] = useState(template.dashboardIds || []);
  const [saved, setSaved] = useState(false);
  const toggle = (id) => setIds((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  const save = async () => { await api.adminUpdateTemplate(template.id, { name, dashboardIds: ids }); flash(setSaved); onChange(); };
  const remove = async () => { if (confirm(`Delete template "${template.name}"?`)) { await api.adminDeleteTemplate(template.id); onChange(); } };
  return (
    <div style={cardStyle}>
      <Row>
        <input style={{ ...input, fontWeight: 700, flex: 1 }} value={name} onChange={(e) => setName(e.target.value)} />
        <button style={delBtn} onClick={remove}>Delete</button>
      </Row>
      <L>Dashboards in this template ({ids.length})</L>
      <div style={checkList}>
        {dashboards.map((d) => (
          <label key={d.id} style={checkItem}>
            <input type="checkbox" checked={ids.includes(d.id)} onChange={() => toggle(d.id)} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
          </label>
        ))}
        {dashboards.length === 0 && <Muted>No dashboards yet.</Muted>}
      </div>
      <SaveRow onSave={save} saved={saved} id={template.id} />
    </div>
  );
}

// ─── Dashboard Sets ───────────────────────────────────────────────────────────
function Sets({ fields }) {
  const [items, setItems] = useState([]);
  const [entities, setEntities] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const load = () => { setLoading(true); Promise.all([api.adminListSets(), api.adminListEntities(), api.adminListTemplates()]).then(([s, e, t]) => { setItems(s); setEntities(e); setTemplates(t); }).finally(() => setLoading(false)); };
  useEffect(load, []);

  async function add() {
    if (!entities.length || !templates.length) { alert('Create at least one client and one template first.'); return; }
    await api.adminCreateSet({ entityId: entities[0].id, templateId: templates[0].id, name: 'New set', lockedFilters: {} });
    load();
  }
  if (loading) return <Muted>Loading…</Muted>;
  return (
    <div>
      <p style={hint}>A Dashboard Set applies a template to a client, with the event (and any other) filters locked in. This is what the client opens.</p>
      {items.map((s) => <SetCard key={s.id} set={s} entities={entities} templates={templates} fields={fields} onChange={load} />)}
      <button style={addBtn} onClick={add}>+ Add set</button>
    </div>
  );
}
function SetCard({ set, entities, templates, fields, onChange }) {
  const [name, setName] = useState(set.name);
  const [entityId, setEntityId] = useState(set.entityId);
  const [templateId, setTemplateId] = useState(set.templateId);
  const [locks, setLocks] = useState(set.lockedFilters || {});
  const [saved, setSaved] = useState(false);
  const save = async () => { await api.adminUpdateSet(set.id, { name, entityId, templateId, lockedFilters: locks }); flash(setSaved); onChange(); };
  const remove = async () => { if (confirm(`Delete set "${set.name}"?`)) { await api.adminDeleteSet(set.id); onChange(); } };
  return (
    <div style={cardStyle}>
      <Row>
        <input style={{ ...input, fontWeight: 700, flex: 1 }} value={name} onChange={(e) => setName(e.target.value)} />
        <button style={delBtn} onClick={remove}>Delete</button>
      </Row>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 10 }}>
        <Field label="Client"><select style={input} value={entityId} onChange={(e) => setEntityId(e.target.value)}>{entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        <Field label="Template"><select style={input} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>{templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.dashboardIds.length})</option>)}</select></Field>
      </div>
      <L>Locked filters for this set (e.g. the event, cashless flags…)</L>
      <LockedFilterEditor value={locks} onChange={setLocks} fields={fields} />
      <SaveRow onSave={save} saved={saved} id={set.id} />
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

// ─── Logins (Users) ───────────────────────────────────────────────────────────
function Users() {
  const [users, setUsers] = useState([]);
  const [entities, setEntities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ email: '', password: '', role: 'client', entityIds: [] });
  const [error, setError] = useState(null);
  const load = () => { setLoading(true); Promise.all([api.adminListUsers(), api.adminListEntities()]).then(([u, e]) => { setUsers(u); setEntities(e); }).finally(() => setLoading(false)); };
  useEffect(load, []);

  async function add() {
    setError(null);
    try {
      await api.adminCreateUser({ email: form.email, password: form.password, role: form.role, entityIds: form.role === 'client' ? form.entityIds : [] });
      setForm({ email: '', password: '', role: 'client', entityIds: [] });
      load();
    } catch (e) { setError(e.message); }
  }
  const del = async (id) => { if (confirm('Delete this login?')) { await api.adminDeleteUser(id); load(); } };
  const toggleEntity = (id) => setForm((f) => ({ ...f, entityIds: f.entityIds.includes(id) ? f.entityIds.filter((x) => x !== id) : [...f.entityIds, id] }));
  const entityNames = (ids) => (ids || []).map((id) => entities.find((e) => e.id === id)?.name).filter(Boolean).join(', ') || '—';

  if (loading) return <Muted>Loading…</Muted>;
  return (
    <div>
      <div style={cardStyle}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>Create a login</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Email"><input style={input} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Password"><input style={input} type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          <Field label="Role">
            <select style={input} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="client">Client</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
          <button style={saveBtn} onClick={add}>Create</button>
        </div>
        {form.role === 'client' && (
          <div style={{ marginTop: 12 }}>
            <L>Clients this login can access</L>
            <div style={checkList}>
              {entities.map((e) => (
                <label key={e.id} style={checkItem}>
                  <input type="checkbox" checked={form.entityIds.includes(e.id)} onChange={() => toggleEntity(e.id)} />
                  <span>{e.name}</span>
                </label>
              ))}
              {entities.length === 0 && <Muted>Create a client first.</Muted>}
            </div>
          </div>
        )}
        {error && <div style={{ color: 'var(--error)', fontSize: 13, marginTop: 8 }}>{error}</div>}
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
        <thead><tr>{['Email', 'Role', 'Clients', ''].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td style={td}>{u.email}</td>
              <td style={td}>{u.role}</td>
              <td style={td}>{u.role === 'admin' ? '—' : entityNames(u.entityIds)}</td>
              <td style={{ ...td, textAlign: 'right' }}><button style={delBtn} onClick={() => del(u.id)}>Delete</button></td>
            </tr>
          ))}
        </tbody>
      </table>
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
const delBtn = { padding: '6px 12px', background: '#fff', color: 'var(--error)', border: '1.5px solid #f0c0c0', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' };
const th = { textAlign: 'left', padding: '8px 10px', borderBottom: '2px solid #e0e0e0', fontSize: 12, color: 'var(--muted)' };
const td = { padding: '8px 10px', borderBottom: '1px solid #f0f0f0' };
const checkList = { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto', border: '1px solid #eee', borderRadius: 8, padding: 10, margin: '6px 0' };
const checkItem = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' };
const pickBtn = { position: 'absolute', right: 4, top: 4, padding: '4px 8px', fontSize: 11, fontWeight: 600, border: '1px solid #e0e0e0', borderRadius: 5, background: '#fafafa', cursor: 'pointer' };
const ddList = { position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, marginTop: 4, background: '#fff', border: '1px solid #e0e0e0', borderRadius: 8, boxShadow: '0 6px 20px rgba(0,0,0,0.12)', maxHeight: 220, overflowY: 'auto', listStyle: 'none', margin: 0, padding: '4px 0' };
const ddItem = { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', fontSize: 13, cursor: 'pointer' };
const ddMuted = { padding: '7px 12px', fontSize: 13, color: 'var(--muted)' };
const chip = { display: 'inline-flex', alignItems: 'center', gap: 2, background: '#fff0f3', color: 'var(--brand)', borderRadius: 980, padding: '3px 10px', fontSize: 12, fontWeight: 600 };
