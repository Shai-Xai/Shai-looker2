import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';

// Client self-service team management — a client Owner invites teammates and
// sets their role, scoped to one client. Mirror of the admin Logins tab, but
// uses the ownership-enforced /api/my/team endpoints. Howler staff never appear
// here. Server enforces team.manage + the last-owner guard.
export default function TeamManager({ entityId, entityName }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({ email: '', password: '', role: 'viewer' });
  const [error, setError] = useState('');
  const load = () => api.myTeam(entityId).then(setData).catch(() => setData({ members: [], roles: [] }));
  useEffect(() => { load(); }, [entityId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <p style={{ color: 'var(--muted)' }}>Loading…</p>;
  const roles = data.roles || [];

  const add = async () => {
    setError('');
    try { await api.myTeamAdd(entityId, form); setForm({ email: '', password: '', role: 'viewer' }); load(); }
    catch (e) { setError(e.message); }
  };
  const setRole = async (m, role) => { setError(''); try { await api.myTeamSetRole(entityId, m.id, role); load(); } catch (e) { setError(e.message); } };
  const remove = async (m) => {
    if (!confirm(`Remove ${m.email} from ${entityName || 'this client'}?`)) return;
    setError('');
    try { await api.myTeamRemove(entityId, m.id); load(); } catch (e) { setError(e.message); }
  };

  return (
    <div style={{ maxWidth: 640 }}>
      <p style={hint}>Invite your team and choose what each person can see and do. Roles take effect immediately.</p>
      {data.members.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>No teammates yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <tbody>
            {data.members.map((m) => (
              <tr key={m.id} style={{ borderBottom: '1px solid var(--hairline)' }}>
                <td style={{ padding: '8px 6px' }}>
                  {m.email}
                  {m.isYou && <span style={{ color: 'var(--muted)', fontSize: 11 }}> · you</span>}
                  {m.alsoOtherClients && <span style={{ color: 'var(--muted)', fontSize: 11 }}> · also other clients</span>}
                </td>
                <td style={{ padding: '8px 6px', width: 140 }}>
                  <select style={sel} value={m.role} onChange={(e) => setRole(m, e.target.value)}>
                    {roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                  </select>
                </td>
                <td style={{ padding: '8px 6px', textAlign: 'right' }}>
                  <button style={delBtn} onClick={() => remove(m)} disabled={m.isYou}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 12 }}>
        <Field label="Email"><input style={inp} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="teammate@company.com" /></Field>
        <Field label="Temp password"><input style={inp} type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="they can change it" /></Field>
        <Field label="Role"><select style={sel} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select></Field>
        <button style={addBtn} onClick={add} disabled={!form.email || !form.password}>+ Add teammate</button>
      </div>
      {roles.length > 0 && <p style={{ ...hint, marginTop: 10 }}>{roles.find((r) => r.key === form.role)?.description || ''}</p>}
      {error && <div style={{ color: 'var(--error)', fontSize: 13, marginTop: 8 }}>{error}</div>}
    </div>
  );
}

function Field({ label, children }) { return <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>{label}</span>{children}</div>; }
const inp = { padding: '8px 10px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', background: 'var(--card)', color: 'var(--text)' };
const sel = { ...inp, cursor: 'pointer' };
const addBtn = { padding: '8px 14px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const delBtn = { padding: '5px 10px', background: 'transparent', color: 'var(--error)', border: '1px solid var(--hairline)', borderRadius: 980, fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const hint = { fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5, margin: '0 0 10px' };
