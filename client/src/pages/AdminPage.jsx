import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';

export default function AdminPage() {
  const [tab, setTab] = useState('tenants');
  return (
    <main style={{ flex: 1, padding: '28px 24px', maxWidth: 1000, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        <Link to="/" style={{ color: 'var(--muted)', fontSize: 13, textDecoration: 'none' }}>← Back</Link>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>Admin</h1>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <Tab active={tab === 'tenants'} onClick={() => setTab('tenants')}>Clients</Tab>
        <Tab active={tab === 'users'} onClick={() => setTab('users')}>Logins</Tab>
      </div>
      {tab === 'tenants' ? <Tenants /> : <Users />}
    </main>
  );
}

// ─── Clients (tenants) ──────────────────────────────────────────────────────
function Tenants() {
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = () => { setLoading(true); api.adminListTenants().then(setTenants).finally(() => setLoading(false)); };
  useEffect(load, []);

  async function add() {
    await api.adminCreateTenant({ name: 'New client', organiserNames: [], eventNames: [] });
    load();
  }

  if (loading) return <Muted>Loading…</Muted>;
  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>
        Each client is scoped to their organiser name(s) — and optionally specific events. Every query they run is filtered to these on the server.
      </p>
      {tenants.map((t) => <TenantCard key={t.id} tenant={t} onChange={load} />)}
      <button style={addBtn} onClick={add}>+ Add client</button>
    </div>
  );
}

function TenantCard({ tenant, onChange }) {
  const [name, setName] = useState(tenant.name);
  const [orgs, setOrgs] = useState((tenant.organiserNames || []).join('\n'));
  const [events, setEvents] = useState((tenant.eventNames || []).join('\n'));
  const [saved, setSaved] = useState(false);

  async function save() {
    await api.adminUpdateTenant(tenant.id, {
      name,
      organiserNames: lines(orgs),
      eventNames: lines(events),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    onChange();
  }
  async function remove() {
    if (!confirm(`Delete client "${tenant.name}"?`)) return;
    await api.adminDeleteTenant(tenant.id);
    onChange();
  }

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10 }}>
        <input style={{ ...input, fontWeight: 700, flex: 1 }} value={name} onChange={(e) => setName(e.target.value)} />
        <button style={delBtn} onClick={remove}>Delete</button>
      </div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 300px' }}>
          <L>Organiser name(s) — one per line, must match Looker exactly</L>
          <textarea style={ta} value={orgs} onChange={(e) => setOrgs(e.target.value)} placeholder="Ultra South Africa" />
        </div>
        <div style={{ flex: '1 1 300px' }}>
          <L>Event name(s) — optional, one per line (blank = all their events)</L>
          <textarea style={ta} value={events} onChange={(e) => setEvents(e.target.value)} placeholder="Ultra South Africa 2025 - Johannesburg" />
        </div>
      </div>
      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
        <button style={saveBtn} onClick={save}>Save</button>
        {saved && <span style={{ color: 'var(--success)', fontSize: 13 }}>✓ Saved</span>}
        <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 'auto' }}>id: {tenant.id.slice(0, 8)}</span>
      </div>
    </div>
  );
}

// ─── Logins (users) ─────────────────────────────────────────────────────────
function Users() {
  const [users, setUsers] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ email: '', password: '', role: 'client', tenantId: '' });
  const [error, setError] = useState(null);

  const load = () => {
    setLoading(true);
    Promise.all([api.adminListUsers(), api.adminListTenants()])
      .then(([u, t]) => { setUsers(u); setTenants(t); })
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  async function add() {
    setError(null);
    try {
      await api.adminCreateUser({
        email: form.email, password: form.password, role: form.role,
        tenantId: form.role === 'client' ? form.tenantId || null : null,
      });
      setForm({ email: '', password: '', role: 'client', tenantId: '' });
      load();
    } catch (e) { setError(e.message); }
  }
  async function del(id) { if (confirm('Delete this login?')) { await api.adminDeleteUser(id); load(); } }

  const tenantName = (id) => tenants.find((t) => t.id === id)?.name || '—';

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
          {form.role === 'client' && (
            <Field label="Client">
              <select style={input} value={form.tenantId} onChange={(e) => setForm({ ...form, tenantId: e.target.value })}>
                <option value="">Select client…</option>
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
          )}
          <button style={saveBtn} onClick={add}>Create</button>
        </div>
        {error && <div style={{ color: 'var(--error)', fontSize: 13, marginTop: 8 }}>{error}</div>}
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
        <thead><tr>{['Email', 'Role', 'Client', ''].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td style={td}>{u.email}</td>
              <td style={td}>{u.role}</td>
              <td style={td}>{u.role === 'admin' ? '—' : tenantName(u.tenantId)}</td>
              <td style={{ ...td, textAlign: 'right' }}><button style={delBtn} onClick={() => del(u.id)}>Delete</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);

function Tab({ active, onClick, children }) {
  return <button onClick={onClick} style={{ padding: '8px 16px', borderRadius: 8, border: active ? '1.5px solid var(--brand)' : '1.5px solid #e0e0e0', background: active ? 'var(--brand)' : '#fff', color: active ? '#fff' : 'var(--text)', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>{children}</button>;
}
function Field({ label, children }) { return <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><L>{label}</L>{children}</div>; }
function L({ children }) { return <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{children}</span>; }
function Muted({ children }) { return <p style={{ color: 'var(--muted)' }}>{children}</p>; }

const cardStyle = { background: '#fff', border: '1px solid #e0e0e0', borderRadius: 12, padding: 18, marginBottom: 14, boxShadow: '0 1px 6px rgba(0,0,0,0.05)' };
const input = { padding: '8px 10px', border: '1.5px solid #e0e0e0', borderRadius: 7, fontSize: 13, outline: 'none', boxSizing: 'border-box', minWidth: 160 };
const ta = { width: '100%', minHeight: 70, padding: '8px 10px', border: '1.5px solid #e0e0e0', borderRadius: 7, fontSize: 13, outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', resize: 'vertical', marginTop: 4 };
const saveBtn = { padding: '8px 16px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const addBtn = { padding: '9px 16px', background: '#f7f7f7', border: '1.5px solid #e0e0e0', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const delBtn = { padding: '6px 12px', background: '#fff', color: 'var(--error)', border: '1.5px solid #f0c0c0', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' };
const th = { textAlign: 'left', padding: '8px 10px', borderBottom: '2px solid #e0e0e0', fontSize: 12, color: 'var(--muted)' };
const td = { padding: '8px 10px', borderBottom: '1px solid #f0f0f0' };
