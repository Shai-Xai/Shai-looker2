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
    testSendSms: (b) => (isAdmin ? api.testSendDigestSms({ ...b, entityId }) : api.testSendMyDigestSms(entityId, b)),
    tiles: () => (isAdmin ? api.getDigestTiles(entityId) : api.getMyDigestTiles(entityId)),
    followed: () => (isAdmin ? api.getFollowedTiles(entityId) : api.getMyFollowedTiles(entityId)),
    events: () => (isAdmin ? api.getDigestEvents(entityId) : api.getMyDigestEvents(entityId)),
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
            {(j.status === 'active' || j.status === 'paused') && (
              <button
                style={j.status === 'active' ? mini : { ...mini, color: 'var(--success,#10b981)' }}
                title={j.status === 'active' ? 'Pause — stop sending until resumed' : 'Resume sending on schedule'}
                onClick={() => A.update(j.id, { ...j, status: j.status === 'active' ? 'paused' : 'active' }).then(load).catch((e) => alert(e.message))}
              >{j.status === 'active' ? '⏸ Pause' : '▶ Resume'}</button>
            )}
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
    channel: job?.channel || 'email', smsRecipients: (job?.smsRecipients || []).join(', '),
    alignDaysBefore: job ? !!job.alignDaysBefore : true, // new digests align comparisons like the home briefing; existing keep their saved choice
    priorityDashboards: job?.priorityDashboards || [],
    includeFollowed: job?.includeFollowed || false,
    followedVisual: job?.followedVisual || false,
    followedTiles: job?.followedTiles || [], // chosen subset; [] = all followed tiles
    includeGoals: job?.includeGoals || false,
    suiteIds: job?.suiteIds || [], // events this digest covers ([] = all)
  }));
  // The client's followed tiles available to pick from (loaded when the option
  // is switched on). [] selection = include them all.
  const [followedList, setFollowedList] = useState(null);
  // The client's events (suites) — for the per-event scope picker (multi-event
  // clients only). [] selection = all events.
  const [eventList, setEventList] = useState(null);
  useEffect(() => { A.events().then((r) => setEventList(r.events || [])).catch(() => setEventList([])); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [preview, setPreview] = useState({ html: '', sample: false });
  const [previewBusy, setPreviewBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testState, setTestState] = useState('');
  const debounce = useRef(null);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const hasEmail = f.channel !== 'sms';
  const hasSms = f.channel !== 'email';

  const payload = () => ({
    title: f.title, role: f.role, roleFocus: f.roleFocus, focusMode: f.focusMode, customMessage: f.customMessage, cadence: f.cadence, timeOfDay: f.timeOfDay,
    weekday: Number(f.weekday), runAt: f.runAt ? new Date(f.runAt).toISOString() : '', status: f.status,
    contentMode: f.contentMode, tiles: f.tiles, recipients: f.recipients.split(',').map((s) => s.trim()).filter(Boolean),
    channel: f.channel, smsRecipients: f.smsRecipients.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean),
    alignDaysBefore: f.alignDaysBefore, priorityDashboards: f.priorityDashboards,
    includeFollowed: f.includeFollowed, followedVisual: f.followedVisual, includeGoals: f.includeGoals,
    suiteIds: f.suiteIds,
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
  }, [f.role, f.roleFocus, f.focusMode, f.customMessage, f.contentMode, JSON.stringify(f.tiles), f.includeFollowed, f.followedVisual, JSON.stringify(f.followedTiles), f.includeGoals, JSON.stringify(f.suiteIds)]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load the client's followed tiles once the option is switched on.
  useEffect(() => {
    if (!f.includeFollowed || followedList) return;
    A.followed().then((r) => setFollowedList(r.tiles || [])).catch(() => setFollowedList([]));
  }, [f.includeFollowed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-tile selection. [] = all selected (the default). Toggling collapses back
  // to [] when every tile ends up selected, so "all" stays the simple default.
  const sameTile = (a, b) => a.dashboardId === b.dashboardId && a.tileId === b.tileId;
  const tileSelected = (t) => f.followedTiles.length === 0 || f.followedTiles.some((x) => sameTile(x, t));
  const toggleFollowedTile = (t) => {
    const all = (followedList || []).map((x) => ({ dashboardId: x.dashboardId, tileId: x.tileId }));
    const cur = f.followedTiles.length === 0 ? all : f.followedTiles;
    const has = cur.some((x) => sameTile(x, t));
    let next = has ? cur.filter((x) => !sameTile(x, t)) : [...cur, { dashboardId: t.dashboardId, tileId: t.tileId }];
    if (next.length === 0 || next.length === all.length) next = []; // all selected (or none) → "all"
    set('followedTiles', next);
  };

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

          {/* Events to include — multi-event clients only. The digest leads with a
              portfolio summary, then a clearly-separated section per chosen event. */}
          {(eventList || []).length > 1 && (() => {
            const allIds = eventList.map((e) => e.id);
            const selected = f.suiteIds.length ? f.suiteIds : allIds;
            const selSet = new Set(selected);
            const toggle = (id) => {
              const cur = new Set(selected);
              if (cur.has(id)) cur.delete(id); else cur.add(id);
              let next = allIds.filter((x) => cur.has(x));
              if (!next.length) next = [id]; // never zero events
              set('suiteIds', next.length === allIds.length ? [] : next);
            };
            return (
              <Field label="Events">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {eventList.map((ev) => {
                    const on = selSet.has(ev.id);
                    return (
                      <button key={ev.id} type="button" onClick={() => toggle(ev.id)}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 34, padding: '5px 12px', borderRadius: 980, cursor: 'pointer',
                          border: `1px solid ${on ? 'var(--brand)' : 'var(--hairline)'}`, background: on ? 'rgba(var(--brand-rgb,255,56,92),0.10)' : 'transparent',
                          color: on ? 'var(--brand)' : 'var(--muted)', fontSize: 12.5, fontWeight: 700 }}>
                        {on ? '✓ ' : ''}{ev.name}{!ev.active && <span style={{ fontSize: 10, fontWeight: 600, opacity: 0.7 }}>· past</span>}
                      </button>
                    );
                  })}
                </div>
                <div style={hintS}>{f.suiteIds.length ? `${selected.length} of ${eventList.length} events` : `All ${eventList.length} events`} · the email leads with a portfolio summary, then one clearly-separated section per event.</div>
              </Field>
            );
          })()}

          <Field label="Content">
            <div style={{ display: 'flex', gap: 8 }}>
              <Toggle on={f.contentMode === 'ai'} onClick={() => set('contentMode', 'ai')}>AI-led</Toggle>
              <Toggle on={f.contentMode === 'curated'} onClick={() => set('contentMode', 'curated')}>Curated tiles</Toggle>
            </div>
            <div style={hintS}>{f.contentMode === 'ai' ? 'The analyst picks what matters for this role.' : 'Pick the exact tiles to feed the digest — the analyst writes the email around them, through the role lens.'}</div>
            {f.contentMode === 'curated' && <TilePicker load={A.tiles} selected={f.tiles} onChange={(t) => set('tiles', t)} />}
            {f.contentMode === 'ai' && (
              <details style={{ marginTop: 10, border: '1px solid var(--hairline)', borderRadius: 8, padding: '0 10px' }}>
                <summary style={{ cursor: 'pointer', padding: '9px 2px', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>
                  Always include these dashboards{f.priorityDashboards.length ? <span style={{ color: 'var(--brand)' }}> · {f.priorityDashboards.length} selected</span> : ''}
                </summary>
                <div style={{ padding: '2px 0 10px' }}>
                  <div style={{ ...hintS, marginTop: 0, marginBottom: 8 }}>The analyst still picks the story, but these boards are guaranteed into the data it reads — so key numbers (e.g. ticketing, audience) are never crowded out by busier dashboards.</div>
                  <DashboardMultiPicker load={A.tiles} selected={f.priorityDashboards} onChange={(d) => set('priorityDashboards', d)} />
                </div>
              </details>
            )}
            {/* Followed tiles — works alongside both modes. Pulls in the tiles
                this client follows ("always read this"), and can render them as
                charts/metrics in the email. */}
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--hairline)' }}>
              <Toggle on={f.includeFollowed} onClick={() => set('includeFollowed', !f.includeFollowed)}>
                📌 {f.includeFollowed ? 'Including saved tiles' : 'Include saved tiles'}
              </Toggle>
              <div style={hintS}>Adds the tiles this client has saved — 📌 pinned (on home) or ⭐ followed — to the digest{f.contentMode === 'curated' ? ' — on top of the curated picks above.' : ' — guaranteed into the analyst’s facts.'}</div>
              {f.includeFollowed && (
                <div style={{ marginTop: 8 }}>
                  {/* Pick which followed tiles to include — there may be several. */}
                  {followedList == null ? (
                    <div style={{ ...hintS, marginTop: 0 }}>Loading followed tiles…</div>
                  ) : followedList.length === 0 ? (
                    <div style={{ ...hintS, marginTop: 0 }}>This client hasn’t saved any tiles yet. Open a dashboard tile’s ⋯ menu and choose “📌 Pin” or “⭐ Follow” to make it available here.</div>
                  ) : (
                    <div style={{ border: '1px solid var(--hairline)', borderRadius: 8, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>{f.followedTiles.length === 0 ? `All ${followedList.length} saved tile${followedList.length === 1 ? '' : 's'} included` : `${f.followedTiles.length} of ${followedList.length} selected`}</div>
                      {followedList.map((t) => (
                        <label key={`${t.dashboardId}|${t.tileId}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 2px', cursor: 'pointer', fontSize: 13 }}>
                          <input type="checkbox" checked={tileSelected(t)} onChange={() => toggleFollowedTile(t)} />
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ marginRight: 5 }}>{(t.kinds || []).includes('pin') ? '📌' : ''}{(t.kinds || []).includes('follow') ? '⭐' : ''}</span>
                            <span style={{ fontWeight: 600 }}>{t.title}</span>
                            <span style={{ color: 'var(--muted)', fontSize: 11.5 }}> · {t.setName ? `${t.setName} → ` : ''}{t.dashTitle}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                  <div style={{ marginTop: 8 }}>
                    <Toggle on={f.followedVisual} onClick={() => set('followedVisual', !f.followedVisual)}>
                      📊 {f.followedVisual ? 'Showing as charts & metrics' : 'Show as charts & metrics'}
                    </Toggle>
                    <div style={hintS}>When on, each followed tile is rendered into the email — chart tiles as a graph image, single-value tiles as a metric chip.</div>
                  </div>
                </div>
              )}
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--hairline)' }}>
                <Toggle on={f.includeGoals} onClick={() => set('includeGoals', !f.includeGoals)}>
                  🎯 {f.includeGoals ? 'Including a goals summary' : 'Include a goals summary'}
                </Toggle>
                <div style={hintS}>Adds a goals paragraph to the digest — the event’s targets with live progress, pace, vs last time and the projected finish (leads with the North Star).</div>
              </div>
            </div>
          </Field>

          <Field label="Event-aligned comparisons">
            <Toggle on={f.alignDaysBefore} onClick={() => set('alignDaysBefore', !f.alignDaysBefore)}>
              ⏳ {f.alignDaysBefore ? 'Aligning to days-to-go' : 'Off — use each tile’s own dates'}
            </Toggle>
            <div style={hintS}>On by default. Dashboards with a days-to-go countdown compare like-for-like to the same point in last year’s cycle (e.g. “42 days out”) — matching what you see on the dashboard, not last year’s full-event total. Turn off only to compare against each tile’s own raw dates. Tiles without a countdown are unaffected.</div>
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

          <Field label="Channel">
            <div style={{ display: 'flex', gap: 8 }}>
              <Toggle on={f.channel === 'email'} onClick={() => set('channel', 'email')}>✉️ Email</Toggle>
              <Toggle on={f.channel === 'sms'} onClick={() => set('channel', 'sms')}>💬 SMS</Toggle>
              <Toggle on={f.channel === 'both'} onClick={() => set('channel', 'both')}>Both</Toggle>
            </div>
            <div style={hintS}>Email sends the full briefing; SMS sends a short headline + a link back into Pulse.</div>
          </Field>

          {hasEmail && (
            <Field label="Email recipients (comma-separated)">
              <textarea style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} rows={2} value={f.recipients} onChange={(e) => set('recipients', e.target.value)} placeholder="name@client.co.za, ceo@client.co.za" />
              {logins.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  {logins.map((u) => <button key={u.id || u.email} type="button" style={chipBtn} onClick={() => addRecipient(u.email)}>+ {u.email}</button>)}
                </div>
              )}
            </Field>
          )}

          {hasSms && (
            <Field label="SMS recipients (mobile numbers)">
              <textarea style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} rows={2} value={f.smsRecipients} onChange={(e) => set('smsRecipients', e.target.value)} placeholder="+27821234567, +27831234568" />
              <div style={hintS}>Any separator. SMS needs the client's Clickatell SMS to be configured.</div>
            </Field>
          )}

          <Field label="Status">
            <div style={{ display: 'flex', gap: 8 }}>
              <Toggle on={f.status === 'active'} onClick={() => set('status', 'active')}>Active</Toggle>
              <Toggle on={f.status === 'paused'} onClick={() => set('status', 'paused')}>Paused</Toggle>
            </div>
          </Field>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
            <button style={primary} onClick={save} disabled={busy}>{busy ? 'Saving…' : (job?.id ? 'Save changes' : 'Create digest')}</button>
            {hasEmail && (
              <button
                type="button" style={mini} disabled={testState === 'sending'}
                onClick={async () => { setTestState('sending'); try { const r = await A.testSend(payload()); setTestState(`✓ Sent to ${r.to}`); } catch (e) { setTestState(`✗ ${e.message}`); } }}
              >{testState === 'sending' ? 'Sending…' : 'Email me a test'}</button>
            )}
            {hasSms && (
              <button
                type="button" style={mini} disabled={testState === 'sending'}
                onClick={async () => { const phone = prompt('Text a test of this digest to which mobile number?'); if (!phone) return; setTestState('sending'); try { const r = await A.testSendSms({ ...payload(), phone }); setTestState(`✓ SMS sent to ${r.to}`); } catch (e) { setTestState(`✗ ${e.message}`); } }}
              >{testState === 'sending' ? 'Sending…' : 'Text me a test'}</button>
            )}
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
              ? <span style={{ fontSize: 11, color: '#b45309', fontWeight: 600 }}>Sample layout — press refresh for live data{f.includeFollowed ? ' (your saved tiles only show here)' : ''}</span>
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

          {!preview.sample && (preview.facts?.length > 0) && (
            <details style={{ marginTop: 10, border: '1px solid var(--hairline)', borderRadius: 10, background: 'var(--card)' }}>
              <summary style={{ cursor: 'pointer', padding: '8px 12px', fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>
                🔎 Data the analyst read ({preview.facts.length} tile{preview.facts.length === 1 ? '' : 's'})
              </summary>
              <div style={{ padding: '4px 12px 10px' }}>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.4 }}>The exact tiles and values fed to the digest, under its scope. If a number here differs from the dashboard, the digest is reading a different tile or missing a filter — pin the right tile via “Curated tiles”.</div>
                {preview.facts.map((fct, i) => {
                  const filterPairs = Object.entries(fct.filters || {}).filter(([, v]) => v != null && String(v).trim());
                  return (
                    <div key={i} style={{ padding: '6px 0', borderTop: i ? '1px solid var(--hairline)' : 'none' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{fct.title}</div>
                          <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{[fct.suiteName, fct.dashTitle, fct.setName].filter(Boolean).join(' › ')}</div>
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--brand)', whiteSpace: 'nowrap' }}>{fct.value}</div>
                      </div>
                      {filterPairs.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                          {filterPairs.map(([k, v]) => (
                            <span key={k} style={{ fontSize: 10, color: 'var(--muted)', background: 'rgba(128,128,128,0.10)', borderRadius: 5, padding: '1px 6px' }}>{k}: {String(v)}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </details>
          )}
          {/* Tiles that were EXCLUDED and why — so a missing source (e.g. GA4) is
              diagnosable: "scope blocked" = config/connector; "no rows" = the
              query returned nothing (often GA4's daily processing lag early in
              the day). */}
          {!preview.sample && (preview.dropped?.length > 0) && (
            <details style={{ marginTop: 8, border: '1px solid #f0c674', borderRadius: 10, background: 'rgba(245,158,11,0.06)' }}>
              <summary style={{ cursor: 'pointer', padding: '8px 12px', fontSize: 12, fontWeight: 700, color: '#b45309' }}>
                ⚠ {preview.dropped.length} tile{preview.dropped.length === 1 ? '' : 's'} excluded (no data / scope)
              </summary>
              <div style={{ padding: '4px 12px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {preview.dropped.map((d, i) => (
                  <div key={i} style={{ fontSize: 11.5, color: 'var(--muted-2,#555)' }}>{d}</div>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

// Multi-select of whole dashboards (for AI mode's "always include" list). Loads
// the same grouped catalogue the curated tile picker uses, one chip per board.
function DashboardMultiPicker({ load, selected, onChange }) {
  const [dashboards, setDashboards] = useState(null);
  useEffect(() => { load().then((r) => setDashboards(r.dashboards || [])).catch(() => setDashboards([])); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!dashboards) return <p style={{ ...hintS, marginTop: 0 }}>Loading dashboards…</p>;
  if (!dashboards.length) return <p style={{ ...hintS, marginTop: 0 }}>No dashboards available for this client yet.</p>;
  const toggle = (id) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  // Group dashboards by their set (and suite, when this client spans more than
  // one) so the picker reads as tidy sections instead of one long wall of chips.
  const multiSuite = new Set(dashboards.map((d) => d.suiteName)).size > 1;
  const groups = [];
  const byKey = new Map();
  for (const d of dashboards) {
    const label = multiSuite ? `${d.suiteName || '—'} › ${d.setName || 'Other'}` : (d.setName || 'Other');
    if (!byKey.has(label)) { const g = { label, items: [] }; byKey.set(label, g); groups.push(g); }
    byKey.get(label).items.push(d);
  }
  const chip = (d) => {
    const on = selected.includes(d.dashboardId);
    return (
      <button key={d.dashboardId} type="button" onClick={() => toggle(d.dashboardId)} title={[d.suiteName, d.setName].filter(Boolean).join(' › ')}
        style={{ padding: '5px 11px', borderRadius: 980, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: on ? '1.5px solid var(--brand)' : '1.5px solid var(--hairline)', background: on ? 'rgba(var(--brand-rgb), 0.08)' : 'transparent', color: on ? 'var(--brand)' : 'var(--text)' }}>
        {on ? '✓ ' : ''}{d.title}
      </button>
    );
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {groups.map((g) => {
        const sel = g.items.filter((d) => selected.includes(d.dashboardId)).length;
        return (
          <div key={g.label}>
            <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted)', marginBottom: 5 }}>{g.label}{sel ? <span style={{ color: 'var(--brand)' }}> · {sel}</span> : ''}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{g.items.map(chip)}</div>
          </div>
        );
      })}
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
