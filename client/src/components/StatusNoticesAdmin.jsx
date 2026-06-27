import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';

// Admin → Status: author platform incidents, post updates, mark resolved. The
// client-facing surfaces (banner + feed in ClientLayout) read the same notices via
// /api/my/notices. Mirrors the dual-surface rule: staff manage here, clients consume.

const SEVERITIES = [
  ['info', 'ℹ️ Info', '#2563eb'],
  ['maintenance', '🛠️ Maintenance', '#7c3aed'],
  ['degraded', '🟠 Degraded', '#ea580c'],
  ['outage', '🔴 Outage', '#dc2626'],
];
const STATUSES = [
  ['investigating', 'Investigating'],
  ['identified', 'Identified'],
  ['monitoring', 'Monitoring'],
];
const SEV_COLOR = Object.fromEntries(SEVERITIES.map(([k, , c]) => [k, c]));
const SEV_LABEL = Object.fromEntries(SEVERITIES.map(([k, l]) => [k, l]));
// Mirrors SEVERITY_CHANNELS in server/notices.js — shown so the author knows how
// loud a given severity is before posting.
const SEV_CHANNELS = { info: 'Email', maintenance: 'Email', degraded: 'Email · Push', outage: 'Email · Push · SMS' };

const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 14, boxShadow: '0 1px 6px rgba(0,0,0,0.05)' };
const input = { padding: '9px 11px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box', width: '100%', fontFamily: 'inherit' };
const ta = { ...input, resize: 'vertical', lineHeight: 1.5, minHeight: 70 };
const label = { fontSize: 11, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 4, display: 'block' };
const btn = { padding: '9px 16px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: 'pointer' };
const ghostBtn = { padding: '7px 13px', background: 'var(--card)', border: '1.5px solid var(--hairline)', borderRadius: 7, fontWeight: 600, fontSize: 12.5, cursor: 'pointer', color: 'var(--text)' };

function SevPill({ severity }) {
  return <span style={{ fontSize: 11.5, fontWeight: 700, color: SEV_COLOR[severity] || 'var(--muted)' }}>{SEV_LABEL[severity] || severity}</span>;
}
function StatusChip({ status }) {
  const resolved = status === 'resolved';
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 980, textTransform: 'uppercase', letterSpacing: 0.3,
      background: resolved ? 'rgba(22,163,74,0.14)' : 'rgba(234,88,12,0.14)', color: resolved ? '#16a34a' : '#ea580c' }}>
      {status}
    </span>
  );
}

export default function StatusNoticesAdmin() {
  const [notices, setNotices] = useState(null);
  const [entities, setEntities] = useState([]);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState('');
  const isMobile = useIsMobile();

  const load = () => api.adminListNotices().then((r) => setNotices(r.notices || [])).catch((e) => { setErr(e.message); setNotices([]); });
  useEffect(() => { load(); api.adminListEntities().then(setEntities).catch(() => setEntities([])); }, []);

  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>
        Tell clients about platform issues — set it across <strong>all clients</strong> or for <strong>specific ones</strong>,
        post updates as you learn more, and mark it resolved. Clients see a banner and a status feed in their app; how loudly it’s
        sent (email · push · SMS) follows the severity.
      </p>

      {!creating && (
        <button style={{ ...btn, marginBottom: 14 }} onClick={() => setCreating(true)}>+ New notice</button>
      )}
      {creating && (
        <NoticeComposer entities={entities} isMobile={isMobile}
          onCancel={() => setCreating(false)}
          onCreated={() => { setCreating(false); load(); }} />
      )}

      {err && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 10 }}>{err}</div>}
      {notices === null && <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>}
      {notices && notices.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 13 }}>No notices yet — all clear.</div>}
      {notices && notices.map((n) => (
        <NoticeCard key={n.id} notice={n} entities={entities} isMobile={isMobile} onChanged={load} />
      ))}
    </div>
  );
}

function NoticeComposer({ entities, onCancel, onCreated, isMobile }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState('degraded');
  const [scope, setScope] = useState('global');
  const [entityIds, setEntityIds] = useState([]);
  const [smsRecipients, setSmsRecipients] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const toggle = (id) => setEntityIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const submit = async () => {
    setErr(''); setBusy(true);
    try {
      await api.adminCreateNotice({
        title, body, severity, scope,
        entityIds: scope === 'targeted' ? entityIds : [],
        smsRecipients: smsRecipients.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
      });
      onCreated();
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  return (
    <div style={{ ...card, borderColor: 'var(--brand)' }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>New status notice</div>
      <div style={{ marginBottom: 10 }}>
        <label style={label}>Title</label>
        <input style={input} placeholder="e.g. Dashboards loading slowly" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div style={{ marginBottom: 10 }}>
        <label style={label}>What’s the problem?</label>
        <textarea style={ta} placeholder="Describe the issue clients are seeing and what you’re doing about it." value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12, marginBottom: 10 }}>
        <div>
          <label style={label}>Severity</label>
          <select style={input} value={severity} onChange={(e) => setSeverity(e.target.value)}>
            {SEVERITIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>Notifies: banner + {SEV_CHANNELS[severity]}</div>
        </div>
        <div>
          <label style={label}>Who sees it?</label>
          <select style={input} value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="global">All clients (company-wide)</option>
            <option value="targeted">Specific clients</option>
          </select>
        </div>
      </div>

      {scope === 'targeted' && (
        <div style={{ marginBottom: 10 }}>
          <label style={label}>Clients ({entityIds.length} selected)</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, maxHeight: 160, overflowY: 'auto', padding: 4 }}>
            {entities.map((e) => {
              const on = entityIds.includes(e.id);
              return (
                <button key={e.id} type="button" onClick={() => toggle(e.id)} style={{
                  padding: '6px 12px', borderRadius: 980, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
                  border: `1.5px solid ${on ? 'var(--brand)' : 'var(--hairline)'}`,
                  background: on ? 'var(--brand)' : 'var(--card)', color: on ? '#fff' : 'var(--text)',
                }}>{e.name}</button>
              );
            })}
            {entities.length === 0 && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>No clients found.</span>}
          </div>
        </div>
      )}

      {severity === 'outage' && (
        <div style={{ marginBottom: 10 }}>
          <label style={label}>SMS recipients (optional — for this critical incident)</label>
          <textarea style={{ ...ta, minHeight: 50 }} placeholder="One phone number per line, e.g. +27821234567" value={smsRecipients} onChange={(e) => setSmsRecipients(e.target.value)} />
        </div>
      )}

      {err && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 10 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={{ ...btn, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={submit}>{busy ? 'Posting…' : 'Post notice'}</button>
        <button style={ghostBtn} onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

function NoticeCard({ notice: n, entities, onChanged, isMobile }) {
  const [update, setUpdate] = useState('');
  const [newStatus, setNewStatus] = useState(n.status === 'resolved' ? 'monitoring' : n.status);
  const [busy, setBusy] = useState(false);
  const resolved = n.status === 'resolved';
  const fmt = (d) => { const dt = new Date(d); return isNaN(dt) ? d : dt.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
  const targetNames = n.scope === 'global' ? 'All clients'
    : (n.entityIds.map((id) => entities.find((e) => e.id === id)?.name || id).join(', ') || `${n.entityIds.length} clients`);

  const post = async () => {
    if (!update.trim()) return;
    setBusy(true);
    try { await api.adminPostNoticeUpdate(n.id, { body: update, status: newStatus }); setUpdate(''); onChanged(); }
    catch (e) { alert(e.message); } finally { setBusy(false); }
  };
  const resolve = async () => {
    setBusy(true);
    try { await api.adminResolveNotice(n.id, { body: update.trim() || undefined }); setUpdate(''); onChanged(); }
    catch (e) { alert(e.message); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!confirm(`Delete notice "${n.title}"? This removes it for clients too.`)) return;
    setBusy(true);
    try { await api.adminDeleteNotice(n.id); onChanged(); }
    catch (e) { alert(e.message); } finally { setBusy(false); }
  };

  return (
    <div style={{ ...card, borderLeft: `4px solid ${resolved ? '#16a34a' : (SEV_COLOR[n.severity] || 'var(--border)')}`, opacity: resolved ? 0.85 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 700 }}>{n.title}</span>
            <StatusChip status={n.status} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 4, fontSize: 12, color: 'var(--muted)' }}>
            <SevPill severity={n.severity} />
            <span>·</span>
            <span>{targetNames}</span>
            <span>·</span>
            <span>started {fmt(n.startedAt || n.createdAt)}</span>
          </div>
        </div>
        <button style={{ ...ghostBtn, color: '#dc2626' }} onClick={del} disabled={busy}>Delete</button>
      </div>

      {/* Timeline */}
      <div style={{ marginTop: 12, borderTop: '1px solid var(--hairline)', paddingTop: 10 }}>
        {(n.updates || []).slice().reverse().map((u) => (
          <div key={u.id} style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
            <div style={{ width: 9, height: 9, borderRadius: 980, background: u.status === 'resolved' ? '#16a34a' : (SEV_COLOR[n.severity] || 'var(--muted)'), marginTop: 5, flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.3, fontWeight: 700 }}>
                {u.status} · {fmt(u.createdAt)}
              </div>
              <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.5, marginTop: 2 }}>{u.body}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Update / resolve controls */}
      {!resolved && (
        <div style={{ marginTop: 8, borderTop: '1px solid var(--hairline)', paddingTop: 12 }}>
          <textarea style={ta} placeholder="Post an update — what’s changed, what you’ve found, or the fix." value={update} onChange={(e) => setUpdate(e.target.value)} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select style={{ ...input, width: 'auto', minWidth: 150 }} value={newStatus} onChange={(e) => setNewStatus(e.target.value)}>
              {STATUSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <button style={{ ...btn, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={post}>Post update</button>
            <span style={{ flex: isMobile ? '0' : '1' }} />
            <button style={{ ...ghostBtn, color: '#16a34a', borderColor: '#16a34a' }} disabled={busy} onClick={resolve}>✓ Mark resolved</button>
          </div>
        </div>
      )}
      {resolved && <div style={{ marginTop: 8, fontSize: 12.5, color: '#16a34a', fontWeight: 600 }}>✓ Resolved {fmt(n.resolvedAt)}</div>}
    </div>
  );
}
