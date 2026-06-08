import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';

// Icon control: an emoji, or an uploaded image (downscaled to a small data-URL).
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
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={iconPreview}>
        {isImg ? <img src={value} alt="" style={{ width: 26, height: 26, objectFit: 'contain' }} /> : (value ? <span style={{ fontSize: 22 }}>{value}</span> : <span style={{ color: '#c8c8cc', fontSize: 18 }}>＋</span>)}
      </div>
      <input style={{ ...input, width: 72, minWidth: 0, textAlign: 'center' }} placeholder="emoji" value={isImg ? '' : (value || '')} onChange={(e) => onChange(e.target.value)} maxLength={4} title="Type/paste an emoji" />
      <button style={miniBtn} onClick={() => fileRef.current?.click()}>Upload image</button>
      <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onFile} />
      {value && <button style={delBtn} onClick={() => onChange('')} title="Clear">✕</button>}
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
        <Tab active={tab === 'suites'} onClick={() => setTab('suites')}>Suites</Tab>
        <Tab active={tab === 'library'} onClick={() => setTab('library')}>Tile library</Tab>
        <Tab active={tab === 'users'} onClick={() => setTab('users')}>Logins</Tab>
      </div>
      {tab === 'entities' && <Entities fields={fields} />}
      {tab === 'sets' && <Sets />}
      {tab === 'suites' && <Suites fields={fields} />}
      {tab === 'library' && <Library />}
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
      <SaveRow onSave={save} saved={saved} id={set.id} />
    </div>
  );
}

// ─── Suites (a client's event context: locks + bundled Sets) ──────────────────
function Suites({ fields }) {
  const [items, setItems] = useState([]);
  const [entities, setEntities] = useState([]);
  const [sets, setSets] = useState([]);
  const [loading, setLoading] = useState(true);
  const load = () => { setLoading(true); Promise.all([api.adminListSuites(), api.adminListEntities(), api.adminListSets()]).then(([su, e, s]) => { setItems(su); setEntities(e); setSets(s); }).finally(() => setLoading(false)); };
  useEffect(load, []);

  async function add() {
    if (!entities.length) { alert('Create at least one client first.'); return; }
    await api.adminCreateSuite({ entityId: entities[0].id, name: 'New suite', lockedFilters: {}, setIds: [] });
    load();
  }
  if (loading) return <Muted>Loading…</Muted>;
  return (
    <div>
      <p style={hint}>A Suite is what a client opens — an event context. It bundles Sets and locks the event (and any other) filters. Organiser is locked on the Client.</p>
      {items.map((su) => <SuiteCard key={su.id} suite={su} entities={entities} sets={sets} fields={fields} onChange={load} />)}
      <button style={addBtn} onClick={add}>+ Add suite</button>
    </div>
  );
}
function SuiteCard({ suite, entities, sets, fields, onChange }) {
  const [name, setName] = useState(suite.name);
  const [icon, setIcon] = useState(suite.icon || '');
  const [entityId, setEntityId] = useState(suite.entityId);
  const [setIds, setSetIds] = useState(suite.setIds || []);
  const [locks, setLocks] = useState(suite.lockedFilters || {});
  const [saved, setSaved] = useState(false);
  const toggleSet = (id) => setSetIds((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  const save = async () => { await api.adminUpdateSuite(suite.id, { name, icon, entityId, setIds, lockedFilters: locks }); flash(setSaved); onChange(); };
  const remove = async () => { if (confirm(`Delete suite "${suite.name}"?`)) { await api.adminDeleteSuite(suite.id); onChange(); } };
  return (
    <div style={cardStyle}>
      <Row>
        <input style={{ ...input, fontWeight: 700, flex: 1 }} value={name} onChange={(e) => setName(e.target.value)} />
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
const iconPreview = { width: 38, height: 38, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--hairline)', borderRadius: 10, background: '#fafafa' };
const chip = { display: 'inline-flex', alignItems: 'center', gap: 2, background: '#fff0f3', color: 'var(--brand)', borderRadius: 980, padding: '3px 10px', fontSize: 12, fontWeight: 600 };
