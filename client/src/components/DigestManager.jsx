import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';

// Scheduled digests — role-lensed briefing emails on a cadence. One component
// for both surfaces: admin (manage any client) and client self-service (own
// entity), switched by `scope`. `logins` (optional) gives quick-add recipients.
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function DigestManager({ entityId, scope = 'admin', logins = [] }) {
  const isAdmin = scope === 'admin';
  const A = {
    list: () => (isAdmin ? api.getDigests(entityId) : api.getMyDigests(entityId)),
    create: (b) => (isAdmin ? api.createDigest(entityId, b) : api.createMyDigest(entityId, b)),
    update: (id, b) => (isAdmin ? api.updateDigest(id, b) : api.updateMyDigest(entityId, id, b)),
    remove: (id) => (isAdmin ? api.deleteDigest(id) : api.deleteMyDigest(entityId, id)),
    test: (id) => (isAdmin ? api.testDigest(id) : api.testMyDigest(entityId, id)),
    run: (id) => api.runDigest(id),
    preview: (b) => (isAdmin ? api.previewDigest({ ...b, entityId }) : api.previewMyDigest(entityId, b)),
    tiles: () => (isAdmin ? api.getDigestTiles(entityId) : api.getMyDigestTiles(entityId)),
  };
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null); // job object or 'new'

  const load = () => A.list().then(setData).catch(() => setData({ jobs: [], roles: [] }));
  useEffect(() => { load(); }, [entityId, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p>;
  const roleLabel = (k) => data.roles.find((r) => r.key === k)?.label || k;

  if (editing) {
    return <DigestEditor job={editing === 'new' ? null : editing} roles={data.roles} logins={logins} api={A}
      onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />;
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>Automated briefing emails, written for a role and sent on a schedule.</p>
        <button style={primary} onClick={() => setEditing('new')}>+ New digest</button>
      </div>
      {data.jobs.length === 0 ? (
        <div style={{ ...card, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No digests yet. Create one to send a scheduled, role-personalised briefing.</div>
      ) : data.jobs.map((j) => (
        <div key={j.id} style={{ ...card, display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 14 }}>{j.title || `${roleLabel(j.role)} digest`}</span>
              <span style={roleChip}>{roleLabel(j.role)}</span>
              <span style={{ ...statusChip, ...(j.status === 'active' ? activeChip : j.status === 'paused' ? pausedChip : doneChip) }}>{j.status}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
              {scheduleSummary(j)} · {j.recipients.length} recipient{j.recipients.length === 1 ? '' : 's'}
              {j.nextRunAt && j.status === 'active' ? ` · next ${fmt(j.nextRunAt)}` : ''}
            </div>
            {j.lastStatus && <div style={{ fontSize: 11, color: j.lastStatus.startsWith('ok') ? 'var(--success,#10b981)' : 'var(--muted)', marginTop: 2 }}>Last: {j.lastStatus}{j.lastRunAt ? ` (${fmt(j.lastRunAt)})` : ''}</div>}
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button style={mini} onClick={() => A.test(j.id).then((r) => alert(r.to ? `Test sent to ${r.to}` : 'Sent')).catch((e) => alert(e.message))}>Test</button>
            <button style={mini} onClick={() => setEditing(j)}>Edit</button>
            <button style={{ ...mini, color: 'var(--error,#ef4444)' }} onClick={() => { if (confirm('Delete this digest?')) A.remove(j.id).then(load); }}>Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function DigestEditor({ job, roles, logins, api: A, onClose, onSaved }) {
  const [f, setF] = useState(() => ({
    title: job?.title || '', role: job?.role || 'exec', roleFocus: job?.roleFocus || '',
    cadence: job?.cadence || 'daily', timeOfDay: job?.timeOfDay || '07:00', weekday: job?.weekday ?? 1,
    runAt: job?.runAt || '', recipients: (job?.recipients || []).join(', '), status: job?.status || 'active',
    contentMode: job?.contentMode || 'ai', tiles: job?.tiles || [],
  }));
  const [preview, setPreview] = useState({ html: '', sample: false });
  const [busy, setBusy] = useState(false);
  const debounce = useRef(null);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  const payload = () => ({
    title: f.title, role: f.role, roleFocus: f.roleFocus, cadence: f.cadence, timeOfDay: f.timeOfDay,
    weekday: Number(f.weekday), runAt: f.runAt ? new Date(f.runAt).toISOString() : '', status: f.status,
    contentMode: f.contentMode, tiles: f.tiles, recipients: f.recipients.split(',').map((s) => s.trim()).filter(Boolean),
  });

  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => { A.preview(payload()).then(setPreview).catch(() => {}); }, 400);
    return () => clearTimeout(debounce.current);
  }, [f.role, f.roleFocus, f.contentMode, JSON.stringify(f.tiles)]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    setBusy(true);
    try { job ? await A.update(job.id, payload()) : await A.create(payload()); onSaved(); }
    catch (e) { alert('Save failed: ' + e.message); } finally { setBusy(false); }
  }
  const addRecipient = (email) => { const cur = f.recipients.split(',').map((s) => s.trim()).filter(Boolean); if (!cur.includes(email)) set('recipients', [...cur, email].join(', ')); };

  return (
    <div>
      <button style={{ ...mini, marginBottom: 12 }} onClick={onClose}>← Back to digests</button>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 20, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Name"><input style={input} value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Exec daily" /></Field>
          <Field label="Role lens — personalises the whole email">
            <select style={input} value={f.role} onChange={(e) => set('role', e.target.value)}>
              {roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
            <div style={hintS}>{roles.find((r) => r.key === f.role)?.focus}</div>
          </Field>
          <Field label="Custom focus (optional — overrides the role's default)">
            <textarea style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} rows={2} value={f.roleFocus} onChange={(e) => set('roleFocus', e.target.value)} placeholder="Leave blank to use the role default above" />
          </Field>

          <Field label="Content">
            <div style={{ display: 'flex', gap: 8 }}>
              <Toggle on={f.contentMode === 'ai'} onClick={() => set('contentMode', 'ai')}>AI-led</Toggle>
              <Toggle on={f.contentMode === 'curated'} onClick={() => set('contentMode', 'curated')}>Curated tiles</Toggle>
            </div>
            <div style={hintS}>{f.contentMode === 'ai' ? 'The analyst picks what matters for this role.' : 'Pick the exact tiles to feed the digest — the analyst writes the email around them, through the role lens.'}</div>
            {f.contentMode === 'curated' && <TilePicker load={A.tiles} selected={f.tiles} onChange={(t) => set('tiles', t)} />}
          </Field>

          <Field label="Schedule">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <select style={{ ...input, width: 'auto' }} value={f.cadence} onChange={(e) => set('cadence', e.target.value)}>
                <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="once">Once</option>
              </select>
              {f.cadence === 'weekly' && (
                <select style={{ ...input, width: 'auto' }} value={f.weekday} onChange={(e) => set('weekday', e.target.value)}>
                  {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                </select>
              )}
              {f.cadence === 'once'
                ? <input type="datetime-local" style={{ ...input, width: 'auto' }} value={f.runAt ? f.runAt.slice(0, 16) : ''} onChange={(e) => set('runAt', e.target.value)} />
                : <input type="time" style={{ ...input, width: 'auto' }} value={f.timeOfDay} onChange={(e) => set('timeOfDay', e.target.value)} />}
            </div>
            <div style={hintS}>Times are SAST (GMT+2).</div>
          </Field>

          <Field label="Recipients (comma-separated)">
            <textarea style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} rows={2} value={f.recipients} onChange={(e) => set('recipients', e.target.value)} placeholder="name@client.co.za, ceo@client.co.za" />
            {logins.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                {logins.map((u) => <button key={u.id || u.email} type="button" style={chipBtn} onClick={() => addRecipient(u.email)}>+ {u.email}</button>)}
              </div>
            )}
          </Field>

          <Field label="Status">
            <div style={{ display: 'flex', gap: 8 }}>
              <Toggle on={f.status === 'active'} onClick={() => set('status', 'active')}>Active</Toggle>
              <Toggle on={f.status === 'paused'} onClick={() => set('status', 'paused')}>Paused</Toggle>
            </div>
          </Field>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 4 }}>
            <button style={primary} onClick={save} disabled={busy}>{busy ? 'Saving…' : (job ? 'Save changes' : 'Create digest')}</button>
            <button style={mini} onClick={onClose}>Cancel</button>
          </div>
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={hintLbl}>Live preview</div>
            {preview.sample && <span style={{ fontSize: 11, color: '#b45309', fontWeight: 600 }}>Sample — live data on the server</span>}
          </div>
          <iframe title="Digest preview" srcDoc={preview.html} style={{ width: '100%', height: 540, border: '1px solid var(--hairline)', borderRadius: 12, background: '#fff' }} />
        </div>
      </div>
    </div>
  );
}

// Curated picker: dashboards (collapsible) with selectable data tiles.
function TilePicker({ load, selected, onChange }) {
  const [cat, setCat] = useState(null);
  const [open, setOpen] = useState({});
  useEffect(() => { load().then(setCat).catch(() => setCat({ dashboards: [] })); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!cat) return <div style={{ ...hintS, marginTop: 8 }}>Loading tiles…</div>;
  if (!cat.dashboards.length) return <div style={{ ...hintS, marginTop: 8 }}>No selectable tiles found for this client yet.</div>;

  const key = (d, t) => `${d}|${t}`;
  const sel = new Set(selected.map((t) => key(t.dashboardId, t.tileId)));
  const toggle = (d, t) => {
    const k = key(d, t);
    onChange(sel.has(k) ? selected.filter((x) => key(x.dashboardId, x.tileId) !== k) : [...selected, { dashboardId: d, tileId: t }]);
  };
  const countIn = (dash) => dash.tiles.filter((t) => sel.has(key(dash.dashboardId, t.tileId))).length;

  return (
    <div style={{ marginTop: 8, border: '1px solid var(--hairline)', borderRadius: 10, maxHeight: 300, overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 10px', borderBottom: '1px solid var(--hairline)', fontSize: 11.5, color: 'var(--muted)' }}>
        <span>{selected.length} tile{selected.length === 1 ? '' : 's'} selected</span>
        {selected.length > 0 && <button type="button" style={{ ...chipBtn, padding: '1px 8px' }} onClick={() => onChange([])}>Clear all</button>}
      </div>
      {cat.dashboards.map((d) => {
        const n = countIn(d);
        const isOpen = open[d.dashboardId];
        return (
          <div key={d.dashboardId} style={{ borderBottom: '1px solid var(--hairline)' }}>
            <button type="button" onClick={() => setOpen((o) => ({ ...o, [d.dashboardId]: !o[d.dashboardId] }))}
              style={{ width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', padding: '9px 10px', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text)' }}>
              <span style={{ fontSize: 11, color: 'var(--muted)', width: 10 }}>{isOpen ? '▾' : '▸'}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{d.title}</span>
                <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 6 }}>{d.setName}</span>
              </span>
              {n > 0 && <span style={{ ...roleChip, background: 'rgba(255,56,92,0.12)', color: 'var(--brand)' }}>{n}</span>}
            </button>
            {isOpen && (
              <div style={{ padding: '0 10px 8px 28px' }}>
                {d.tiles.map((t) => {
                  const checked = sel.has(key(d.dashboardId, t.tileId));
                  return (
                    <label key={t.tileId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12.5, cursor: 'pointer' }}>
                      <input type="checkbox" checked={checked} onChange={() => toggle(d.dashboardId, t.tileId)} />
                      <span style={{ flex: 1 }}>{t.title}</span>
                      {t.visType && <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{t.visType}</span>}
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const scheduleSummary = (j) => j.cadence === 'daily' ? `Every day at ${j.timeOfDay}`
  : j.cadence === 'weekly' ? `Every ${DAYS[j.weekday] || 'Monday'} at ${j.timeOfDay}`
  : j.runAt ? `Once on ${fmt(j.runAt)}` : 'One-off';
const fmt = (iso) => { try { return new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

function Field({ label, children }) { return <div><div style={hintLbl}>{label}</div>{children}</div>; }
function Toggle({ on, onClick, children }) {
  return <button type="button" onClick={onClick} style={{ flex: 1, padding: '8px 10px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: on ? '1.5px solid var(--brand)' : '1.5px solid var(--hairline)', background: on ? 'rgba(255,56,92,0.08)' : 'transparent', color: on ? 'var(--brand)' : 'var(--text)' }}>{children}</button>;
}

const card = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: 14, marginBottom: 10 };
const input = { width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', background: 'var(--card)', color: 'var(--text)' };
const primary = { padding: '9px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const mini = { padding: '7px 12px', background: 'rgba(128,128,128,0.10)', color: 'var(--text)', border: '1px solid var(--hairline)', borderRadius: 980, fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const chipBtn = { padding: '4px 9px', background: 'rgba(128,128,128,0.10)', border: '1px solid var(--hairline)', borderRadius: 980, fontSize: 11, cursor: 'pointer', color: 'var(--text)' };
const roleChip = { fontSize: 10.5, fontWeight: 700, borderRadius: 980, padding: '2px 8px', background: 'rgba(10,132,255,0.12)', color: '#0a66c2' };
const statusChip = { fontSize: 10, fontWeight: 700, borderRadius: 980, padding: '2px 8px', textTransform: 'capitalize' };
const activeChip = { background: 'rgba(52,199,89,0.15)', color: '#2da44e' };
const pausedChip = { background: 'rgba(128,128,128,0.16)', color: 'var(--muted)' };
const doneChip = { background: 'rgba(128,128,128,0.10)', color: 'var(--muted)' };
const hintLbl = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', margin: '0 0 5px' };
const hintS = { fontSize: 11, color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 };
