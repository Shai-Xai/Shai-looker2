import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';

// Client self-service team management — a client Owner invites teammates and
// sets their role, scoped to one client. Mirror of the admin Users console: a
// clean member list with a "+ Add user" button that opens the add form in a
// modal (the form no longer sits permanently under the list). Uses the
// ownership-enforced /api/my/team endpoints; Howler staff never appear here.
// Server enforces team.manage + the last-owner guard.
export default function TeamManager({ entityId, entityName }) {
  const isMobile = useIsMobile();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const load = () => api.myTeam(entityId).then(setData).catch(() => setData({ members: [], roles: [] }));
  useEffect(() => { load(); }, [entityId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <p style={{ color: 'var(--muted)' }}>Loading…</p>;
  const roles = data.roles || [];

  const setRole = async (m, role) => { setError(''); try { await api.myTeamSetRole(entityId, m.id, role); load(); } catch (e) { setError(e.message); } };
  const remove = async (m) => {
    if (!confirm(`Remove ${m.email} from ${entityName || 'this client'}?`)) return;
    setError('');
    try { await api.myTeamRemove(entityId, m.id); load(); } catch (e) { setError(e.message); }
  };

  const roleLabel = (key) => roles.find((r) => r.key === key)?.label || key;
  const members = data.members || [];

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <p style={{ ...hint, marginBottom: 0, flex: 1, minWidth: 180 }}>
          Invite your team and choose what each person can see and do — {members.length} member{members.length === 1 ? '' : 's'}. Roles take effect immediately.
        </p>
        <button style={addBtn} onClick={() => { setError(''); setAdding(true); }}>+ Add user</button>
      </div>

      {/* Your Howler Support — the Howler account contact(s) for this client. */}
      {Array.isArray(data.support) && data.support.length > 0 && (
        <div style={{ borderRadius: 14, border: '1px solid var(--hairline)', background: 'rgba(var(--brand-rgb,255,56,92),0.05)', marginBottom: 16, overflow: 'hidden' }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', padding: '10px 14px 4px' }}>Your Howler Support</div>
          {data.support.map((s, i) => (
            <div key={s.id || i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderTop: i ? '1px solid var(--hairline)' : 'none', flexWrap: 'wrap' }}>
              <div style={{ fontSize: 20, flexShrink: 0 }}>🦉</div>
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{s.name}</div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{s.roleLabel}</div>
              </div>
              <a href={`mailto:${s.email}`} style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 980, background: 'var(--brand)', color: '#fff', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>✉️ Email</a>
            </div>
          ))}
        </div>
      )}

      {members.length === 0 ? (
        <div style={{ padding: '24px 18px', textAlign: 'center', color: 'var(--muted)', border: '1px dashed var(--hairline)', borderRadius: 14 }}>
          No teammates yet. Add your first with “+ Add user”.
        </div>
      ) : isMobile ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {members.map((m) => (
            <div key={m.id} style={{ border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.fullName || m.email}</div>
                <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                  {m.fullName ? `${m.email}` : ''}{m.fullName && m.mobile ? ' · ' : ''}{m.mobile || ''}
                  {m.isYou && ' · you'}{m.alsoOtherClients && ' · also other clients'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select style={{ ...sel, flex: 1 }} value={m.role} onChange={(e) => setRole(m, e.target.value)}>
                  {roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                </select>
                <button style={delBtn} onClick={() => remove(m)} disabled={m.isYou}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>{['Member', 'Role', ''].map((h, i) => <th key={i} style={thS}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} style={{ borderBottom: '1px solid var(--hairline)' }}>
                <td style={{ padding: '10px 6px' }}>
                  <span style={m.fullName ? { fontWeight: 600 } : null}>{m.fullName || m.email}</span>
                  {m.isYou && <span style={{ color: 'var(--muted)', fontSize: 11 }}> · you</span>}
                  {m.alsoOtherClients && <span style={{ color: 'var(--muted)', fontSize: 11 }}> · also other clients</span>}
                  {(m.fullName || m.mobile) && <div style={{ color: 'var(--muted)', fontSize: 11 }}>{m.fullName ? m.email : ''}{m.fullName && m.mobile ? ' · ' : ''}{m.mobile || ''}</div>}
                </td>
                <td style={{ padding: '10px 6px', width: 150 }}>
                  <select style={sel} value={m.role} onChange={(e) => setRole(m, e.target.value)}>
                    {roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                  </select>
                </td>
                <td style={{ padding: '10px 6px', textAlign: 'right' }}>
                  <button style={delBtn} onClick={() => remove(m)} disabled={m.isYou}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {error && <div style={{ color: 'var(--error)', fontSize: 13, marginTop: 10 }}>{error}</div>}

      {adding && (
        <AddUserModal
          entityId={entityId}
          entityName={entityName}
          roles={roles}
          onClose={() => setAdding(false)}
          onAdded={() => { setAdding(false); load(); }}
        />
      )}
    </div>
  );
}

// Add-a-teammate form, in a modal so the list stays put. Mirrors the back-end
// "Add user" form (name / email / mobile / temp password / role).
function AddUserModal({ entityId, entityName, roles, onClose, onAdded }) {
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', mobile: '', password: '', role: 'viewer' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setError(''); setBusy(true);
    try { await api.myTeamAdd(entityId, form); onAdded(); }
    catch (e) { setError(e.message); setBusy(false); }
  };
  const roleDesc = roles.find((r) => r.key === form.role)?.description || '';
  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0, flex: 1 }}>Add a user</h2>
          <button onClick={onClose} aria-label="Close" style={{ border: 'none', background: 'transparent', fontSize: 20, color: 'var(--muted)', cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>
        <p style={hint}>They’ll join {entityName || 'this client'}. Leave the password blank and we’ll email them a link to set their own — or set a temporary one to share directly.</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="First name"><input style={inp} value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} /></Field>
          <Field label="Surname"><input style={inp} value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></Field>
          <Field label="Email" span><input style={inp} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="teammate@company.com" /></Field>
          <Field label="Mobile"><input style={inp} value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} placeholder="+27…" /></Field>
          <Field label="Temp password (optional)"><input style={inp} type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="blank → email them a set-password link" /></Field>
          <Field label="Role" span>
            <select style={sel} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select>
          </Field>
        </div>
        {roleDesc && <p style={{ ...hint, marginTop: 8 }}>{roleDesc}</p>}
        {error && <div style={{ color: 'var(--error)', fontSize: 13, marginTop: 8 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button style={ghostBtn} onClick={onClose} disabled={busy}>Cancel</button>
          <button style={addBtn} onClick={submit} disabled={busy || !form.email}>{busy ? 'Adding…' : '+ Add user'}</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, span, children }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 4, gridColumn: span ? '1 / -1' : 'auto' }}><span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>{label}</span>{children}</div>;
}
const inp = { padding: '8px 10px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', background: 'var(--card)', color: 'var(--text)', width: '100%', boxSizing: 'border-box' };
const sel = { ...inp, cursor: 'pointer' };
const addBtn = { padding: '8px 14px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0 };
const ghostBtn = { padding: '8px 14px', background: 'var(--card)', color: 'var(--text)', border: '1px solid var(--hairline)', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const delBtn = { padding: '5px 12px', background: 'transparent', color: 'var(--error)', border: '1px solid var(--hairline)', borderRadius: 980, fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const hint = { fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5, margin: '0 0 10px' };
const thS = { textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted)', padding: '0 6px 8px', borderBottom: '1px solid var(--hairline)' };
const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 1000 };
const modal = { background: 'var(--card)', borderRadius: 16, padding: '20px 22px', width: '100%', maxWidth: 460, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' };
