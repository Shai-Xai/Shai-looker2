import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import TilePicker from './TilePicker.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';

// Report Studio — build custom, shareable client reports from blocks: dashboard
// tiles (KPI / chart / table), section headings, text, images, links and AI
// analysis. Generating freezes the data into a SNAPSHOT with a public share link
// (+ PDF); a cadence makes it recurring. One component for both surfaces —
// admin (any client) and client self-service — switched by `scope`, mirroring
// DigestManager. Mobile-first: everything stacks in one column.
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const uid = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export default function ReportStudio({ entityId, scope = 'admin', logins = [] }) {
  const isAdmin = scope === 'admin';
  const A = {
    list: () => (isAdmin ? api.getReports(entityId) : api.getMyReports(entityId)),
    create: (b) => (isAdmin ? api.createReport(entityId, b) : api.createMyReport(entityId, b)),
    update: (id, b) => (isAdmin ? api.updateReport(id, b) : api.updateMyReport(entityId, id, b)),
    remove: (id) => (isAdmin ? api.deleteReport(id) : api.deleteMyReport(entityId, id)),
    generate: (id) => (isAdmin ? api.generateReport(id) : api.generateMyReport(entityId, id)),
    send: (id, b) => (isAdmin ? api.sendReport(id, b) : api.sendMyReport(entityId, id, b)),
    snapshots: (id) => (isAdmin ? api.getReportSnapshots(id) : api.getMyReportSnapshots(entityId, id)),
    removeSnapshot: (sid) => (isAdmin ? api.deleteReportSnapshot(sid) : api.deleteMyReportSnapshot(entityId, sid)),
    tiles: () => (isAdmin ? api.getDigestTiles(entityId) : api.getMyDigestTiles(entityId)),
    campaigns: () => api.listActions(entityId), // campaign picker (works for both surfaces; 403s fail-soft to an empty list)
  };
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null); // template object or 'new'
  const load = () => A.list().then(setData).catch(() => setData({ templates: [] }));
  useEffect(() => { load(); }, [entityId, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p>;
  if (editing) {
    return <ReportEditor tpl={editing === 'new' ? null : editing} A={A} logins={logins}
      onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />;
  }
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>Compose a report from dashboard tiles, text and AI analysis — share it by link or PDF, once-off or on a schedule.</p>
        <button style={primary} onClick={() => setEditing('new')}>+ New report</button>
      </div>
      {data.templates.length === 0 ? (
        <div style={{ ...card, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No reports yet. Build one from your dashboard tiles — it takes a minute.</div>
      ) : data.templates.map((t) => (
        <div key={t.id} style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{t.title || 'Untitled report'}</span>
            <span style={{ ...statusChip, ...(t.status === 'active' && t.cadence !== 'none' ? activeChip : pausedChip) }}>{t.cadence === 'none' ? 'one-off' : t.status === 'paused' ? 'paused' : scheduleSummary(t)}</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
            {t.blocks.length} block{t.blocks.length === 1 ? '' : 's'} · {t.recipients.length} recipient{t.recipients.length === 1 ? '' : 's'}
            {t.lastStatus ? ` · last run: ${t.lastStatus}` : ''}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button style={mini} onClick={() => setEditing(t)}>Edit</button>
            <button style={mini} onClick={async () => { if (confirm(`Delete "${t.title || 'this report'}" and all its snapshots (share links stop working)?`)) { await A.remove(t.id); load(); } }}>Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── editor ──────────────────────────────────────────────────────────────────────
function ReportEditor({ tpl, A, logins, onClose, onSaved }) {
  const isMobile = useIsMobile();
  const [title, setTitle] = useState(tpl?.title || '');
  const [blocks, setBlocks] = useState(() => (tpl?.blocks || []).map((b) => ({ ...b, id: b.id || uid() })));
  const [recipients, setRecipients] = useState(tpl?.recipients || []);
  const [cadence, setCadence] = useState(tpl?.cadence || 'none');
  const [timeOfDay, setTimeOfDay] = useState(tpl?.timeOfDay || '07:00');
  const [weekday, setWeekday] = useState(tpl?.weekday ?? 1);
  const [monthday, setMonthday] = useState(tpl?.monthday ?? 1);
  const [status, setStatus] = useState(tpl?.status || 'active');
  const [catalogue, setCatalogue] = useState(null);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState([]);
  const [campaigns, setCampaigns] = useState(null); // null = not loaded yet
  const [campPicking, setCampPicking] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [savedId, setSavedId] = useState(tpl?.id || null);
  const [snapshots, setSnapshots] = useState(null);
  const [lastSnap, setLastSnap] = useState(null);
  const fileRef = useRef(null);
  const imgTarget = useRef(null);

  useEffect(() => { A.tiles().then(setCatalogue).catch(() => setCatalogue({ dashboards: [] })); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (campPicking && campaigns == null) A.campaigns().then((r) => setCampaigns(r.actions || r.campaigns || [])).catch(() => setCampaigns([])); }, [campPicking]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadSnaps = (id) => A.snapshots(id).then((r) => setSnapshots(r.snapshots || [])).catch(() => setSnapshots([]));
  useEffect(() => { if (savedId) loadSnaps(savedId); }, [savedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const tileTitle = (b) => {
    const d = (catalogue?.dashboards || []).find((x) => x.dashboardId === b.dashboardId);
    const t = d?.tiles?.find((x) => x.tileId === b.tileId);
    return t ? `${t.title}` : `${b.tileId}`;
  };
  const campaignTitle = (b) => {
    const c = (campaigns || []).find((x) => x.id === b.campaignId);
    return c ? (c.title || c.config?.subject || 'Campaign') : 'Campaign';
  };
  const patch = (id, p) => setBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, ...p } : b)));
  const remove = (id) => setBlocks((bs) => bs.filter((b) => b.id !== id));
  const move = (id, dir) => setBlocks((bs) => {
    const i = bs.findIndex((b) => b.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= bs.length) return bs;
    const out = [...bs]; [out[i], out[j]] = [out[j], out[i]]; return out;
  });
  const add = (b) => setBlocks((bs) => [...bs, { id: uid(), ...b }]);

  // "Add tiles" → TilePicker; whole-dashboard picks ('*') expand to that
  // dashboard's tiles from the catalogue so each becomes its own block.
  const confirmPick = () => {
    const out = [];
    for (const p of picked) {
      if (p.tileId === '*') {
        const d = (catalogue?.dashboards || []).find((x) => x.dashboardId === p.dashboardId);
        for (const t of d?.tiles || []) out.push({ type: 'tile', dashboardId: p.dashboardId, tileId: t.tileId, display: 'auto' });
      } else out.push({ type: 'tile', dashboardId: p.dashboardId, tileId: p.tileId, display: 'auto' });
    }
    setBlocks((bs) => [...bs, ...out.map((b) => ({ id: uid(), ...b }))]);
    setPicked([]); setPicking(false);
  };

  const onImageFile = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 1400000) { setError('Image too large — keep it under 1.4 MB.'); return; }
    const reader = new FileReader();
    reader.onload = () => { if (imgTarget.current) patch(imgTarget.current, { url: String(reader.result) }); else add({ type: 'image', url: String(reader.result), alt: f.name }); imgTarget.current = null; };
    reader.readAsDataURL(f);
  };

  const body = () => ({ title, blocks, recipients, cadence, timeOfDay, weekday: Number(weekday), monthday: Number(monthday), status });
  const save = async () => {
    setError('');
    if (!title.trim()) { setError('Give the report a title.'); return null; }
    setBusy('save');
    try {
      const r = savedId ? await A.update(savedId, body()) : await A.create(body());
      setSavedId(r.template.id);
      return r.template;
    } catch (e) { setError(e.message); return null; }
    finally { setBusy(''); }
  };
  const saveAnd = (fn, label) => async () => {
    const t = await save();
    if (!t) return;
    setBusy(label); setError('');
    try { await fn(t); if (savedId || t.id) loadSnaps(t.id); } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  };
  const generateNow = saveAnd(async (t) => { const r = await A.generate(t.id); setLastSnap(r.snapshot); }, 'generate');
  const sendNow = saveAnd(async (t) => {
    if (!recipients.length) throw new Error('Add at least one recipient first.');
    if (!confirm(`Generate and email this report to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}?`)) return;
    const r = await A.send(t.id, {});
    setLastSnap(r.snapshot);
    if (r.sendError) throw new Error(r.sendError);
  }, 'send');
  const sendTest = saveAnd(async (t) => { const r = await A.send(t.id, { test: true }); setLastSnap(r.snapshot); }, 'test');

  const copy = (path) => { try { navigator.clipboard.writeText(`${window.location.origin}${path}`); } catch { /* clipboard unavailable */ } };
  const addRecipient = (email) => { const e = String(email || '').trim().toLowerCase(); if (e && /.+@.+\..+/.test(e) && !recipients.includes(e)) setRecipients([...recipients, e]); };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <button style={mini} onClick={onClose}>← Back</button>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button style={mini} disabled={!!busy} onClick={generateNow}>{busy === 'generate' ? 'Generating…' : '⚡ Generate now'}</button>
          <button style={mini} disabled={!!busy} onClick={sendTest} title="Generate + email it to yourself only">{busy === 'test' ? 'Sending…' : 'Send me a test'}</button>
          <button style={mini} disabled={!!busy} onClick={sendNow}>{busy === 'send' ? 'Sending…' : '📤 Send to recipients'}</button>
          <button style={primary} disabled={!!busy} onClick={async () => { if (await save()) onSaved(); }}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
      {error && <div style={{ ...card, borderColor: '#e5484d', color: '#e5484d', fontSize: 13 }}>{error}</div>}
      {lastSnap && (
        <div style={{ ...card, background: 'rgba(52,199,89,0.08)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13 }}>✅ Snapshot ready:</span>
          <a href={lastSnap.path} target="_blank" rel="noreferrer" style={link}>Open report</a>
          <button style={chipBtn} onClick={() => copy(lastSnap.path)}>Copy share link</button>
          <a href={`/api/public/reports/${lastSnap.token}/pdf`} target="_blank" rel="noreferrer" style={link}>PDF</a>
        </div>
      )}

      <div style={card}>
        <Field label="Report title"><input style={input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Weekly sponsor update" /></Field>
      </div>

      {/* ── blocks ── */}
      <div style={{ ...hintLbl, marginTop: 4 }}>Content blocks</div>
      {blocks.length === 0 && <div style={{ ...card, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Empty report — add tiles, headings, text or AI analysis below.</div>}
      {blocks.map((b, i) => (
        <div key={b.id} style={{ ...card, padding: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: ['divider'].includes(b.type) ? 0 : 8 }}>
            <span style={blockTag}>{blockLabel(b)}</span>
            <span style={{ flex: 1 }} />
            <button style={iconBtn} title="Move up" disabled={i === 0} onClick={() => move(b.id, -1)}>↑</button>
            <button style={iconBtn} title="Move down" disabled={i === blocks.length - 1} onClick={() => move(b.id, 1)}>↓</button>
            <button style={iconBtn} title="Remove" onClick={() => remove(b.id)}>✕</button>
          </div>
          {b.type === 'heading' && (
            <div style={{ display: 'flex', gap: 8 }}>
              <input style={{ ...input, fontWeight: 700 }} value={b.text} onChange={(e) => patch(b.id, { text: e.target.value })} placeholder="Section heading" />
              <select style={{ ...input, width: 92, flexShrink: 0 }} value={b.level || 1} onChange={(e) => patch(b.id, { level: Number(e.target.value) })}>
                <option value={1}>Large</option><option value={2}>Small</option>
              </select>
            </div>
          )}
          {b.type === 'text' && <textarea style={{ ...input, minHeight: 74, resize: 'vertical' }} value={b.text} onChange={(e) => patch(b.id, { text: e.target.value })} placeholder="Write something… (**bold** and *italic* supported)" />}
          {b.type === 'tile' && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 140 }}>{tileTitle(b)}</span>
              <select style={{ ...input, width: 170, flexShrink: 0 }} value={b.display || 'auto'} onChange={(e) => patch(b.id, { display: e.target.value })} title="How this tile appears in the report">
                <option value="auto">Auto (chart / number)</option>
                <option value="chart">Chart</option>
                <option value="value">Number (KPI)</option>
                <option value="table">Table</option>
              </select>
            </div>
          )}
          {b.type === 'ai' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <select style={{ ...input, maxWidth: 340 }} value={b.scope || 'section'} onChange={(e) => patch(b.id, { scope: e.target.value })}>
                <option value="section">Analyse this section (tiles since the last heading)</option>
                <option value="report">Analyse the whole report (executive summary)</option>
              </select>
              <input style={input} value={b.focus || ''} onChange={(e) => patch(b.id, { focus: e.target.value })} placeholder="Optional focus — e.g. “compare weekend vs weekday sales”" />
              <div style={hintS}>Written fresh on every generate, from the live tile data — then frozen into the snapshot.</div>
            </div>
          )}
          {b.type === 'image' && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {b.url ? <img src={b.url} alt={b.alt || ''} style={{ maxHeight: 72, maxWidth: 180, borderRadius: 8 }} /> : <span style={hintS}>No image yet.</span>}
              <button style={chipBtn} onClick={() => { imgTarget.current = b.id; fileRef.current?.click(); }}>{b.url ? 'Replace image' : 'Upload image'}</button>
              <input style={{ ...input, flex: 1, minWidth: 140 }} value={b.alt || ''} onChange={(e) => patch(b.id, { alt: e.target.value })} placeholder="Alt text" />
            </div>
          )}
          {b.type === 'button' && (
            <div style={{ display: 'flex', gap: 8, flexDirection: isMobile ? 'column' : 'row' }}>
              <input style={input} value={b.text} onChange={(e) => patch(b.id, { text: e.target.value })} placeholder="Link label — e.g. Book your stand" />
              <input style={input} value={b.href || ''} onChange={(e) => patch(b.id, { href: e.target.value })} placeholder="https://…" />
            </div>
          )}
          {b.type === 'campaign' && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 140 }}>{campaignTitle(b)}</span>
              <span style={hintS}>Audience, sent, opens, clicks, click-rate & conversions — frozen at generate time.</span>
            </div>
          )}
          {b.type === 'app' && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select style={{ ...input, width: 'auto', flex: 1, minWidth: 170 }} value={b.appView || 'summary'} onChange={(e) => patch(b.id, { appView: e.target.value })}>
                <option value="summary">Summary (KPI chips)</option>
                <option value="trend">Daily trend (chart)</option>
                <option value="events">By event (table)</option>
              </select>
              <select style={{ ...input, width: 'auto', flexShrink: 0 }} value={b.days || 28} onChange={(e) => patch(b.id, { days: Number(e.target.value) })}>
                <option value={7}>Last 7 days</option>
                <option value={14}>Last 14 days</option>
                <option value={28}>Last 28 days</option>
                <option value={90}>Last 90 days</option>
              </select>
            </div>
          )}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '10px 0 18px' }}>
        <button style={chipBtn} onClick={() => setPicking(true)}>+ 📊 Tiles</button>
        <button style={chipBtn} onClick={() => add({ type: 'ai', scope: 'section', focus: '' })}>+ ✨ AI analysis</button>
        <button style={chipBtn} onClick={() => setCampPicking(true)}>+ 📣 Campaign</button>
        <button style={chipBtn} onClick={() => add({ type: 'app', appView: 'summary', days: 28 })}>+ 📱 App analytics</button>
        <button style={chipBtn} onClick={() => add({ type: 'heading', text: '', level: 1 })}>+ Heading</button>
        <button style={chipBtn} onClick={() => add({ type: 'text', text: '' })}>+ Text</button>
        <button style={chipBtn} onClick={() => { imgTarget.current = null; fileRef.current?.click(); }}>+ Image</button>
        <button style={chipBtn} onClick={() => add({ type: 'button', text: '', href: '' })}>+ Link button</button>
        <button style={chipBtn} onClick={() => add({ type: 'divider' })}>+ Divider</button>
      </div>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: 'none' }} onChange={onImageFile} />
      {picking && (
        <div style={card}>
          <div style={{ ...hintLbl }}>Pick tiles to add (whole dashboards expand to their tiles)</div>
          <TilePicker catalogue={catalogue} selected={picked} onChange={setPicked} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button style={primary} onClick={confirmPick} disabled={!picked.length}>Add {picked.length || ''} selection{picked.length === 1 ? '' : 's'}</button>
            <button style={mini} onClick={() => { setPicked([]); setPicking(false); }}>Cancel</button>
          </div>
        </div>
      )}
      {campPicking && (
        <div style={card}>
          <div style={{ ...hintLbl }}>Pick a campaign to add its results</div>
          {campaigns == null ? <p style={hintS}>Loading campaigns…</p>
            : campaigns.length === 0 ? <p style={hintS}>No campaigns found for this client (or Engage isn't enabled for them).</p>
            : campaigns.slice(0, 30).map((c) => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--hairline)', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 150 }}>{c.title || c.config?.subject || 'Untitled campaign'}</span>
                <span style={{ ...statusChip, ...(c.status === 'done' || c.status === 'running' ? activeChip : pausedChip) }}>{c.status}</span>
                {c.results?.sent ? <span style={hintS}>{c.results.sent} sent</span> : null}
                <button style={chipBtn} onClick={() => { add({ type: 'campaign', campaignId: c.id }); setCampPicking(false); }}>Add</button>
              </div>
            ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button style={mini} onClick={() => setCampPicking(false)}>Close</button>
          </div>
        </div>
      )}

      {/* ── delivery & schedule ── */}
      <div style={card}>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 14 }}>
          <Field label="Email recipients">
            <RecipientEditor recipients={recipients} setRecipients={setRecipients} addRecipient={addRecipient} logins={logins} />
          </Field>
          <Field label="Schedule">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <select style={input} value={cadence} onChange={(e) => setCadence(e.target.value)}>
                <option value="none">One-off (generate manually)</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
              {cadence !== 'none' && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {cadence === 'weekly' && (
                    <select style={{ ...input, width: 'auto', flex: 1 }} value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                      {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                    </select>
                  )}
                  {cadence === 'monthly' && (
                    <select style={{ ...input, width: 'auto', flex: 1 }} value={monthday} onChange={(e) => setMonthday(Number(e.target.value))}>
                      {Array.from({ length: 28 }, (_, i) => <option key={i + 1} value={i + 1}>Day {i + 1}</option>)}
                    </select>
                  )}
                  <input type="time" style={{ ...input, width: 'auto' }} value={timeOfDay} onChange={(e) => setTimeOfDay(e.target.value)} />
                  <Toggle on={status === 'active'} onClick={() => setStatus(status === 'active' ? 'paused' : 'active')}>{status === 'active' ? 'Active' : 'Paused'}</Toggle>
                </div>
              )}
              {cadence !== 'none' && <div style={hintS}>Each run regenerates the report with fresh data, emails it, and mints a new share link.</div>}
            </div>
          </Field>
        </div>
      </div>

      {/* ── past snapshots ── */}
      {savedId && snapshots && snapshots.length > 0 && (
        <div style={card}>
          <div style={hintLbl}>Generated reports (each keeps its own share link)</div>
          {snapshots.map((s) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--hairline)', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12.5, flex: 1, minWidth: 150 }}>{fmtDate(s.createdAt)}{s.sentTo.length ? ` · sent to ${s.sentTo.length}` : ''}</span>
              <a href={s.path} target="_blank" rel="noreferrer" style={link}>Open</a>
              <button style={chipBtn} onClick={() => copy(s.path)}>Copy link</button>
              <a href={`/api/public/reports/${s.token}/pdf`} target="_blank" rel="noreferrer" style={link}>PDF</a>
              <button style={chipBtn} onClick={async () => { if (confirm('Delete this snapshot? Its share link stops working immediately.')) { await A.removeSnapshot(s.id); loadSnaps(savedId); } }}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RecipientEditor({ recipients, setRecipients, addRecipient, logins }) {
  const [draft, setDraft] = useState('');
  const commit = () => { addRecipient(draft); setDraft(''); };
  const quick = (logins || []).map((u) => u.email).filter((e) => e && !recipients.includes(e)).slice(0, 6);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input style={input} type="email" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="name@company.com"
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); } }} />
        <button style={mini} onClick={commit}>Add</button>
      </div>
      {recipients.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {recipients.map((r) => (
            <span key={r} style={{ ...chipBtn, cursor: 'default', display: 'inline-flex', alignItems: 'center', gap: 6 }}>{r}
              <button style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--muted)', padding: 0, fontSize: 12 }} onClick={() => setRecipients(recipients.filter((x) => x !== r))}>✕</button>
            </span>
          ))}
        </div>
      )}
      {quick.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <span style={hintS}>Quick add:</span>
          {quick.map((e) => <button key={e} style={chipBtn} onClick={() => addRecipient(e)}>+ {e}</button>)}
        </div>
      )}
      <div style={hintS}>Recipients get the report by email; anyone with the share link (e.g. stakeholders) can view it without a Pulse login.</div>
    </div>
  );
}

const blockLabel = (b) => ({ heading: 'Heading', text: 'Text', tile: '📊 Tile', ai: '✨ AI analysis', image: '🖼 Image', button: '🔗 Link', divider: 'Divider', campaign: '📣 Campaign', app: '📱 App analytics' }[b.type] || b.type);
const scheduleSummary = (t) => t.cadence === 'daily' ? `daily ${t.timeOfDay}`
  : t.cadence === 'weekly' ? `${DAYS[t.weekday] || 'Monday'}s ${t.timeOfDay}`
  : t.cadence === 'monthly' ? `monthly (day ${t.monthday}) ${t.timeOfDay}` : 'one-off';
const fmtDate = (iso) => { try { return new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return iso; } };

function Field({ label, children }) {
  return <div><div style={hintLbl}>{label}</div>{children}</div>;
}
function Toggle({ on, onClick, children }) {
  return <button type="button" onClick={onClick} style={{ padding: '8px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: on ? '1.5px solid var(--brand)' : '1.5px solid var(--hairline)', background: on ? 'rgba(var(--brand-rgb), 0.08)' : 'transparent', color: on ? 'var(--brand)' : 'var(--text)' }}>{children}</button>;
}

const card = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: 14, marginBottom: 10 };
const input = { width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', background: 'var(--card)', color: 'var(--text)' };
const primary = { padding: '9px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const mini = { padding: '7px 12px', background: 'rgba(128,128,128,0.10)', color: 'var(--text)', border: '1px solid var(--hairline)', borderRadius: 980, fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const chipBtn = { padding: '4px 9px', background: 'rgba(128,128,128,0.10)', border: '1px solid var(--hairline)', borderRadius: 980, fontSize: 11, cursor: 'pointer', color: 'var(--text)' };
const iconBtn = { width: 26, height: 26, borderRadius: 7, border: '1px solid var(--hairline)', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 12, lineHeight: 1 };
const blockTag = { fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' };
const statusChip = { fontSize: 10, fontWeight: 700, borderRadius: 980, padding: '2px 8px' };
const activeChip = { background: 'rgba(52,199,89,0.15)', color: '#2da44e' };
const pausedChip = { background: 'rgba(128,128,128,0.16)', color: 'var(--muted)' };
const hintLbl = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', margin: '0 0 5px' };
const hintS = { fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 };
const link = { fontSize: 12, fontWeight: 600, color: 'var(--brand)', textDecoration: 'none' };
