import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import TilePicker from './TilePicker.jsx';
import RefineButton from './RefineButton.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';

// Scheduled digests — role-lensed briefing emails on a cadence. One component
// for both surfaces: admin (manage any client) and client self-service (own
// entity), switched by `scope`. `logins` (optional) gives quick-add recipients.
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function DigestManager({ entityId, scope = 'admin', logins = [] }) {
  const isAdmin = scope === 'admin';
  const isMobile = useIsMobile();
  const A = {
    list: () => (isAdmin ? api.getDigests(entityId) : api.getMyDigests(entityId)),
    create: (b) => (isAdmin ? api.createDigest(entityId, b) : api.createMyDigest(entityId, b)),
    update: (id, b) => (isAdmin ? api.updateDigest(id, b) : api.updateMyDigest(entityId, id, b)),
    remove: (id) => (isAdmin ? api.deleteDigest(id) : api.deleteMyDigest(entityId, id)),
    test: (id) => (isAdmin ? api.testDigest(id) : api.testMyDigest(entityId, id)),
    run: (id) => api.runDigest(id),
    preview: (b) => (isAdmin ? api.previewDigest({ ...b, entityId }) : api.previewMyDigest(entityId, b)),
    testSend: (b) => (isAdmin ? api.testSendDigest({ ...b, entityId }) : api.testSendMyDigest(entityId, b)),
    tiles: () => (isAdmin ? api.getDigestTiles(entityId) : api.getMyDigestTiles(entityId)),
  };
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null); // job object or 'new'

  const load = () => A.list().then(setData).catch(() => setData({ jobs: [], roles: [] }));
  useEffect(() => { load(); }, [entityId, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p>;
  const roleLabel = (k) => data.roles.find((r) => r.key === k)?.label || k;

  if (editing) {
    return <DigestEditor job={editing === 'new' ? null : editing} roles={data.roles} logins={logins} api={A} entityId={entityId}
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
        <div key={j.id} style={{ ...card, display: 'flex', alignItems: isMobile ? 'stretch' : 'center', flexDirection: isMobile ? 'column' : 'row', gap: isMobile ? 10 : 12 }}>
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
          <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', ...(isMobile ? { borderTop: '1px solid var(--hairline)', paddingTop: 10 } : null) }}>
            <button style={mini} onClick={() => A.test(j.id).then((r) => alert(r.to ? `Test sent to ${r.to}` : 'Sent')).catch((e) => alert(e.message))}>Test</button>
            <button style={mini} onClick={() => setEditing(j)}>Edit</button>
            <button style={mini} title="Duplicate as a new digest" onClick={() => setEditing({ ...j, id: undefined, status: 'paused', title: `${j.title || `${roleLabel(j.role)} digest`} (copy)` })}>Duplicate</button>
            <button style={{ ...mini, color: 'var(--error,#ef4444)' }} onClick={() => { if (confirm('Delete this digest?')) A.remove(j.id).then(load); }}>Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function DigestEditor({ job, roles, logins, api: A, entityId, onClose, onSaved }) {
  const isMobile = useIsMobile();
  const [f, setF] = useState(() => ({
    title: job?.title || '', role: job?.role || 'exec', roleFocus: job?.roleFocus || '', focusMode: job?.focusMode || 'override',
    customMessage: job?.customMessage || '',
    cadence: job?.cadence || 'daily', timeOfDay: job?.timeOfDay || '07:00', weekday: job?.weekday ?? 1,
    runAt: job?.runAt || '', recipients: (job?.recipients || []).join(', '), status: job?.status || 'active',
    contentMode: job?.contentMode || 'ai', tiles: job?.tiles || [],
  }));
  const [preview, setPreview] = useState({ html: '', sample: false });
  const [previewBusy, setPreviewBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testState, setTestState] = useState('');
  const debounce = useRef(null);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  const payload = () => ({
    title: f.title, role: f.role, roleFocus: f.roleFocus, focusMode: f.focusMode, customMessage: f.customMessage, cadence: f.cadence, timeOfDay: f.timeOfDay,
    weekday: Number(f.weekday), runAt: f.runAt ? new Date(f.runAt).toISOString() : '', status: f.status,
    contentMode: f.contentMode, tiles: f.tiles, recipients: f.recipients.split(',').map((s) => s.trim()).filter(Boolean),
  });

  // Two preview paths: the debounced auto-preview renders the SAMPLE layout
  // (instant, free — reflects branding/shell), while the explicit refresh
  // button generates with LIVE data (Looker + AI, can take ~30-60s). A request
  // sequence guard stops a slow older response overwriting a newer one.
  const seq = useRef(0);
  const refreshPreview = (live) => {
    const mine = ++seq.current;
    if (live) setPreviewBusy(true);
    return A.preview({ ...payload(), live: !!live })
      .then((r) => { if (seq.current === mine) setPreview(r); })
      .catch(() => {})
      .finally(() => { if (seq.current === mine) setPreviewBusy(false); });
  };
  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => refreshPreview(false), 350);
    return () => clearTimeout(debounce.current);
  }, [f.role, f.roleFocus, f.focusMode, f.customMessage, f.contentMode, JSON.stringify(f.tiles)]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    setBusy(true);
    try { job?.id ? await A.update(job.id, payload()) : await A.create(payload()); onSaved(); }
    catch (e) { alert('Save failed: ' + e.message); } finally { setBusy(false); }
  }
  const addRecipient = (email) => { const cur = f.recipients.split(',').map((s) => s.trim()).filter(Boolean); if (!cur.includes(email)) set('recipients', [...cur, email].join(', ')); };

  return (
    <div>
      <button style={{ ...mini, marginBottom: 12 }} onClick={onClose}>← Back to digests</button>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0,1fr) minmax(0,1fr)', gap: 20, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Name"><input style={input} value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Exec daily" /></Field>
          <Field label="Role lens — personalises the whole email">
            <select style={input} value={f.role} onChange={(e) => set('role', e.target.value)}>
              {roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
            <div style={hintS}>{roles.find((r) => r.key === f.role)?.focus}</div>
          </Field>
          <Field label="Custom focus (optional)" action={<RefineButton text={f.roleFocus} onRefined={(t) => set('roleFocus', t)} purpose="a focus note that steers what an AI digest emphasises" entityId={entityId} style={{ marginTop: 0 }} />}>
            <textarea style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} rows={2} value={f.roleFocus} onChange={(e) => set('roleFocus', e.target.value)} placeholder="Leave blank to use the role default above" />
            {f.roleFocus.trim() && (
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <Toggle on={f.focusMode === 'override'} onClick={() => set('focusMode', 'override')}>Override role</Toggle>
                <Toggle on={f.focusMode === 'blend'} onClick={() => set('focusMode', 'blend')}>Blend with role</Toggle>
              </div>
            )}
            {f.roleFocus.trim() && <div style={hintS}>{f.focusMode === 'override' ? 'Replaces the role lens entirely.' : 'Adds your emphasis on top of the role lens.'}</div>}
          </Field>

          <Field label="Custom message (optional — a personal note at the top of the email)" action={<RefineButton text={f.customMessage} onRefined={(t) => set('customMessage', t)} purpose="a personal intro note at the top of a digest email" entityId={entityId} style={{ marginTop: 0 }} />}>
            <textarea style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} rows={3} value={f.customMessage} onChange={(e) => set('customMessage', e.target.value)} placeholder="e.g. Hi team — big weekend ahead. Here's where we stand…" />
            <div style={hintS}>Sent verbatim above the AI summary. Supports **bold** and line breaks.</div>
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

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
            <button style={primary} onClick={save} disabled={busy}>{busy ? 'Saving…' : (job?.id ? 'Save changes' : 'Create digest')}</button>
            <button
              type="button" style={mini} disabled={testState === 'sending'}
              onClick={async () => { setTestState('sending'); try { const r = await A.testSend(payload()); setTestState(`✓ Sent to ${r.to}`); } catch (e) { setTestState(`✗ ${e.message}`); } }}
            >{testState === 'sending' ? 'Sending…' : 'Send test to me'}</button>
            <button style={mini} onClick={onClose}>Cancel</button>
            {testState && testState !== 'sending' && <span style={{ fontSize: 12, color: testState.startsWith('✓') ? 'var(--success,#10b981)' : 'var(--error,#ef4444)' }}>{testState}</span>}
          </div>
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 8, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ ...hintLbl, margin: 0 }}>Preview</span>
              <button type="button" style={{ ...mini, padding: '4px 10px' }} onClick={() => refreshPreview(true)} disabled={previewBusy}>
                {previewBusy ? 'Generating…' : '↻ Refresh with live data'}
              </button>
            </div>
            {preview.sample
              ? <span style={{ fontSize: 11, color: '#b45309', fontWeight: 600 }}>Sample layout — press refresh for live data</span>
              : preview.generatedAt && <span style={{ fontSize: 11, color: 'var(--success,#10b981)', fontWeight: 600 }}>✓ Live data · {new Date(preview.generatedAt).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}</span>}
          </div>
          {preview.sample && preview.reason && (
            <div style={{ fontSize: 11.5, color: 'var(--error,#ef4444)', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 8, padding: '6px 10px', marginBottom: 6 }}>
              Live generation failed: {preview.reason}
            </div>
          )}
          <div style={{ position: 'relative' }}>
            <iframe title="Digest preview" srcDoc={preview.html} style={{ width: '100%', height: isMobile ? 420 : 540, border: '1px solid var(--hairline)', borderRadius: 12, background: '#fff', opacity: previewBusy ? 0.45 : 1, transition: 'opacity 0.2s' }} />
            {previewBusy && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                <div style={{ background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: '14px 20px', fontSize: 13, fontWeight: 600, boxShadow: '0 4px 18px rgba(0,0,0,0.08)' }}>
                  Pulling live data & writing the digest…
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 400, marginTop: 3 }}>Usually 20–60 seconds — the analyst reads the tiles first.</div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Curated picker: dashboards (collapsible) with selectable data tiles.
const scheduleSummary = (j) => j.cadence === 'daily' ? `Every day at ${j.timeOfDay}`
  : j.cadence === 'weekly' ? `Every ${DAYS[j.weekday] || 'Monday'} at ${j.timeOfDay}`
  : j.runAt ? `Once on ${fmt(j.runAt)}` : 'One-off';
const fmt = (iso) => { try { return new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

function Field({ label, action, children }) {
  return <div><div style={{ ...hintLbl, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>{label}{action}</div>{children}</div>;
}
function Toggle({ on, onClick, children }) {
  return <button type="button" onClick={onClick} style={{ flex: 1, padding: '8px 10px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: on ? '1.5px solid var(--brand)' : '1.5px solid var(--hairline)', background: on ? 'rgba(var(--brand-rgb), 0.08)' : 'transparent', color: on ? 'var(--brand)' : 'var(--text)' }}>{children}</button>;
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
