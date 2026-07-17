import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';

// Engage → Surveys: post-event fan surveys designed here, answered in the Howler
// app, results back in Pulse. Dual-surface (scope: 'my' | 'admin'), same component.
// Contract: docs/specs/SURVEY_CONTRACT.md — four question types, published surveys
// immutable (close & duplicate to change), publish requires the event to be listed
// in the Howler app (server-enforced; the editor verifies as you type).

const QTYPES = {
  rating: { label: '★ Rating', hint: '1–5 stars', bg: 'rgba(255,159,10,0.16)', fg: '#b25000' },
  single_choice: { label: '◉ Pick one', hint: 'radio', bg: 'rgba(11,107,203,0.14)', fg: '#0b6bcb' },
  multiple_choice: { label: '☑ Pick any', hint: 'checkboxes', bg: 'rgba(109,40,217,0.14)', fg: '#7c3aed' },
  text: { label: '✎ Free text', hint: 'typed answer', bg: 'rgba(29,138,59,0.13)', fg: '#1d8a3b' },
};
const newQuestion = (type) => ({ id: `q_${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`, type, text: '', required: false, ...(type === 'single_choice' || type === 'multiple_choice' ? { options: ['', ''] } : {}) });
const isChoice = (t) => t === 'single_choice' || t === 'multiple_choice';
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }) : '');

export default function SurveyManager({ entityId, scope = 'my' }) {
  const [list, setList] = useState(null);
  const [view, setView] = useState({ mode: 'list' }); // | {mode:'edit', survey|null} | {mode:'results', survey}
  const load = () => api.listSurveys(scope, entityId)
    .then((r) => setList((r.surveys || []).filter((s) => s.entityId === entityId)))
    .catch(() => setList([]));
  useEffect(() => { setView({ mode: 'list' }); load(); }, [entityId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (view.mode === 'edit') {
    return <SurveyEditor entityId={entityId} scope={scope} survey={view.survey} onClose={(changed) => { setView({ mode: 'list' }); if (changed) load(); }} onResults={(s) => setView({ mode: 'results', survey: s })} />;
  }
  if (view.mode === 'results') {
    return <SurveyResults entityId={entityId} scope={scope} survey={view.survey} onClose={() => { setView({ mode: 'list' }); load(); }} />;
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>Ask fans how it went — designed here, answered in the Howler app, results land right back in Pulse.</p>
        <button style={primary} onClick={() => setView({ mode: 'edit', survey: null })}>+ New survey</button>
      </div>
      {list === null ? null : list.length === 0 ? (
        <p style={{ color: 'var(--muted)', fontSize: 13, padding: '18px 0' }}>No surveys yet — create one for an upcoming (or just-finished) event.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {list.map((s) => <SurveyRow key={s.id} s={s} onEdit={() => setView({ mode: 'edit', survey: s })} onResults={() => setView({ mode: 'results', survey: s })} />)}
        </div>
      )}
    </div>
  );
}

function StatusPill({ s }) {
  const eff = s.effectiveState || s.status;
  const map = {
    draft: { t: '● Draft', bg: 'rgba(178,80,0,0.12)', fg: 'var(--warn, #b25000)' },
    live: { t: '● Live', bg: 'rgba(29,138,59,0.12)', fg: 'var(--success, #1d8a3b)' },
    scheduled: { t: '● Scheduled', bg: 'rgba(11,107,203,0.12)', fg: '#0b6bcb' },
    closed: { t: '● Closed', bg: 'rgba(128,128,128,0.15)', fg: 'var(--muted)' },
  };
  const m = map[eff] || map.draft;
  return <span style={{ fontSize: 11, fontWeight: 700, borderRadius: 980, padding: '3px 10px', background: m.bg, color: m.fg, whiteSpace: 'nowrap' }}>{m.t}</span>;
}

function SurveyRow({ s, onEdit, onResults }) {
  const audience = s.audienceTicketTypes || [];
  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 14, padding: '13px 16px', background: 'var(--card)', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>{s.title || 'Untitled survey'}</span>
          <StatusPill s={s} />
          <span style={{ fontSize: 10.5, fontWeight: 700, borderRadius: 980, padding: '2px 9px', background: 'rgba(128,128,128,0.12)', color: 'var(--muted)' }}>{s.layout === 'cards' ? '▦ Cards' : '▤ Form'}</span>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          🎫 {s.eventName || `Event #${s.eventId}`} · {(s.questions || []).length} question{(s.questions || []).length === 1 ? '' : 's'}
          {audience.length ? ` · 🎯 ${audience.join(', ')}` : ' · everyone'}
          {s.closesAt ? ` · closes ${fmtDate(s.closesAt)}` : ''}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
        {s.responseCount > 0 && <button style={{ ...mini, fontWeight: 700 }} onClick={onResults}>📊 {s.responseCount.toLocaleString()} response{s.responseCount === 1 ? '' : 's'}</button>}
        {s.responseCount === 0 && s.status !== 'draft' && <button style={mini} onClick={onResults}>📊 Results</button>}
        <button style={mini} onClick={onEdit}>{s.status === 'draft' ? 'Edit' : 'View'}</button>
      </div>
    </div>
  );
}

// ── Editor with live phone preview ─────────────────────────────────────────────

function SurveyEditor({ entityId, scope, survey, onClose, onResults }) {
  const isMobile = useIsMobile();
  const draft = !survey || survey.status === 'draft';
  const [f, setF] = useState({
    title: survey?.title || '',
    description: survey?.description || '',
    eventId: survey?.eventId || '',
    eventName: survey?.eventName || '',
    layout: survey?.layout || 'form',
    closesAt: survey?.closesAt ? survey.closesAt.slice(0, 10) : '',
    audienceTicketTypes: survey?.audienceTicketTypes || [],
    questions: (survey?.questions || []).map((q) => ({ ...q, options: q.options ? [...q.options] : undefined })),
  });
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [ev, setEv] = useState(null); // event lookup: null | {checking} | {ok, eventName, ticketTypes} | {ok:false}
  const [showPreview, setShowPreview] = useState(false);
  const lookupSeq = useRef(0);
  // The client's own events (from the App-analytics/PostHog mapping) drive a
  // dropdown; manual id entry stays as the fallback (or via "Other…").
  const [myEvents, setMyEvents] = useState(null);
  const [manualEvent, setManualEvent] = useState(false);
  useEffect(() => {
    if (!draft) { setMyEvents([]); return; }
    api.surveyEntityEvents(entityId)
      .then((r) => {
        const events = r.events || [];
        setMyEvents(events);
        if (survey?.eventId && !events.some((e) => e.eventId === String(survey.eventId))) setManualEvent(true);
      })
      .catch(() => setMyEvents([]));
  }, [entityId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Verify the event against the Howler app as the id changes (publish requires it).
  useEffect(() => {
    const id = String(f.eventId || '').trim();
    if (!/^[0-9]{1,32}$/.test(id)) { setEv(null); return; }
    const seq = ++lookupSeq.current;
    setEv({ checking: true });
    const t = setTimeout(() => {
      api.surveyEventLookup(id)
        .then((r) => { if (lookupSeq.current === seq) { setEv(r); if (r.ok && r.eventName) set('eventName', r.eventName); } })
        .catch(() => { if (lookupSeq.current === seq) setEv({ ok: false, error: true }); });
    }, 450);
    return () => clearTimeout(t);
  }, [f.eventId]); // eslint-disable-line react-hooks/exhaustive-deps

  const setQ = (i, patch) => set('questions', f.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const moveQ = (i, d) => { const qs = [...f.questions]; const j = i + d; if (j < 0 || j >= qs.length) return; [qs[i], qs[j]] = [qs[j], qs[i]]; set('questions', qs); };
  const payload = () => ({
    title: f.title, description: f.description, eventId: String(f.eventId).trim(), eventName: f.eventName,
    layout: f.layout, closesAt: f.closesAt ? new Date(f.closesAt + 'T23:59:59Z').toISOString() : null,
    audienceTicketTypes: f.audienceTicketTypes,
    questions: f.questions.map((q) => ({ id: q.id, type: q.type, text: q.text, required: !!q.required, ...(isChoice(q.type) ? { options: (q.options || []).filter((o) => o.trim()) } : {}) })),
  });

  const save = async (thenPublish = false) => {
    setErr(''); setBusy(thenPublish ? 'publish' : 'save');
    try {
      let s = survey;
      if (draft) s = s ? await api.updateSurvey(scope, entityId, s.id, payload()) : await api.createSurvey(scope, entityId, payload());
      if (s.error) throw new Error(s.error);
      if (thenPublish) {
        const p = await api.surveyAction(scope, entityId, s.id, 'publish');
        if (p.error) throw new Error(p.error);
      }
      onClose(true);
    } catch (e) { setErr(e.message || 'Something went wrong'); } finally { setBusy(''); }
  };
  const act = async (action, confirmMsg) => {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setErr(''); setBusy(action);
    try {
      const r = action === 'delete' ? await api.deleteSurvey(scope, entityId, survey.id) : await api.surveyAction(scope, entityId, survey.id, action);
      if (r.error) throw new Error(r.error);
      onClose(true);
    } catch (e) { setErr(e.message || 'Something went wrong'); } finally { setBusy(''); }
  };
  // A live survey may still move its close date (server allows closesAt only).
  const saveCloseDate = async () => {
    setErr(''); setBusy('save');
    try {
      const r = await api.updateSurvey(scope, entityId, survey.id, { closesAt: f.closesAt ? new Date(f.closesAt + 'T23:59:59Z').toISOString() : null });
      if (r.error) throw new Error(r.error);
      onClose(true);
    } catch (e) { setErr(e.message || 'Something went wrong'); } finally { setBusy(''); }
  };

  const canPublish = draft && f.title.trim() && f.questions.length > 0 && ev?.ok;
  const knownTypes = ev?.ticketTypes || [];
  const preview = <PhonePreview f={f} />;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <button style={mini} onClick={() => onClose(false)}>← Back</button>
        <span style={{ fontWeight: 750, fontSize: 15 }}>{survey ? (draft ? 'Edit survey' : survey.title) : 'New survey'}</span>
        {survey && <StatusPill s={survey} />}
        <span style={{ flex: 1 }} />
        {isMobile && <button style={mini} onClick={() => setShowPreview((v) => !v)}>{showPreview ? '✏️ Edit' : '📱 Preview'}</button>}
        {survey && survey.status !== 'draft' && <button style={mini} onClick={() => onResults(survey)}>📊 Results</button>}
        {draft && <button style={mini} disabled={!!busy} onClick={() => save(false)}>{busy === 'save' ? 'Saving…' : 'Save draft'}</button>}
        {draft && <button style={{ ...primary, opacity: canPublish ? 1 : 0.5 }} disabled={!canPublish || !!busy} title={canPublish ? '' : 'Needs a title, at least one question, and an event that is listed in the Howler app'} onClick={() => confirm('Publish this survey?\n\nOnce live, questions and options are LOCKED (answers reference them). To change a live survey you close it and publish a duplicate.') && save(true)}>{busy === 'publish' ? 'Publishing…' : 'Publish →'}</button>}
        {survey && survey.status === 'live' && <button style={mini} disabled={!!busy} onClick={() => act('close', 'Close this survey? Fans will no longer be able to answer. Results are kept.')}>Close survey</button>}
        {survey && survey.status !== 'draft' && <button style={mini} disabled={!!busy} onClick={() => act('duplicate')}>⧉ Duplicate as draft</button>}
        {survey && draft && <button style={{ ...mini, color: 'var(--error, #d70015)' }} disabled={!!busy} onClick={() => act('delete', 'Delete this draft?')}>Delete</button>}
      </div>
      {err && <p style={{ color: 'var(--error, #d70015)', fontSize: 13, fontWeight: 600, margin: '0 0 12px' }}>{err}</p>}
      {!draft && <p style={{ fontSize: 12.5, color: 'var(--muted)', background: 'rgba(128,128,128,0.09)', borderRadius: 10, padding: '9px 12px', margin: '0 0 14px' }}>🔒 This survey is published, so its content is locked — answers reference these exact questions. You can still move the close date, close it, or duplicate it as an editable draft.</p>}
      {survey && survey.status === 'live' && <DistributionPanel entityId={entityId} scope={scope} survey={survey} />}

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        {(!isMobile || !showPreview) && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 220px' }}>
                <label style={label}>Event</label>
                {myEvents === null ? (
                  <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '6px 0' }}>Loading your events…</p>
                ) : myEvents.length > 0 && !manualEvent ? (
                  <select style={input} value={f.eventId} disabled={!draft}
                    onChange={(e) => { if (e.target.value === '__manual') { setManualEvent(true); set('eventId', ''); } else set('eventId', e.target.value); }}>
                    <option value="">— pick one of your events —</option>
                    {myEvents.map((e) => <option key={e.eventId} value={e.eventId}>{e.name} · #{e.eventId}</option>)}
                    <option value="__manual">Other — enter an event ID…</option>
                  </select>
                ) : (
                  <>
                    <input style={input} value={f.eventId} disabled={!draft} placeholder="Howler event ID, e.g. 19203" onChange={(e) => set('eventId', e.target.value)} />
                    {myEvents.length > 0 && draft && <button style={{ ...tiny, marginTop: 6 }} onClick={() => setManualEvent(false)}>← pick from your events instead</button>}
                  </>
                )}
                {ev?.checking ? <p style={evHint('var(--muted)')}>Checking the Howler app…</p>
                  : ev?.ok ? <p style={evHint('var(--success, #1d8a3b)')}>✓ Listed in the app{ev.eventName ? `: ${ev.eventName}` : ''}{ev.source === 'staging' ? ' · staging backend' : ''}{ev.unverified ? ' (check skipped in this environment)' : ''}</p>
                  : ev ? <p style={evHint('var(--error, #d70015)')}>✗ Not listed in the Howler app — surveys can only be published for listed events</p>
                  : myEvents !== null && myEvents.length === 0 ? <p style={evHint('var(--muted)')}>No mapped events found for this client — enter the numeric Howler event ID; it's checked live against the app.</p> : null}
              </div>
              <div style={{ flex: '0 0 auto' }}>
                <label style={label}>Fan layout</label>
                <div style={{ display: 'inline-flex', background: 'var(--bg)', border: '1px solid var(--hairline)', borderRadius: 10, padding: 3, gap: 2 }}>
                  {[['form', '▤ Single form'], ['cards', '▦ One per card']].map(([k, l]) => (
                    <button key={k} disabled={!draft} onClick={() => set('layout', k)} style={{ border: 'none', cursor: draft ? 'pointer' : 'default', borderRadius: 7, padding: '7px 12px', fontSize: 12.5, fontWeight: 650, background: f.layout === k ? 'var(--card)' : 'transparent', color: f.layout === k ? 'var(--text)' : 'var(--muted)', boxShadow: f.layout === k ? 'var(--shadow-sm, 0 1px 3px rgba(0,0,0,0.1))' : 'none' }}>{l}</button>
                  ))}
                </div>
              </div>
              <div style={{ flex: '0 0 150px' }}>
                <label style={label}>Closes on</label>
                <input type="date" style={input} value={f.closesAt} disabled={!!survey && survey.status === 'closed'} onChange={(e) => set('closesAt', e.target.value)} />
                {!draft && survey?.status === 'live' && <button style={{ ...mini, marginTop: 6 }} disabled={!!busy} onClick={saveCloseDate}>Save close date</button>}
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <label style={label}>Who gets it</label>
              {knownTypes.length || f.audienceTicketTypes.length ? (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Chip on={!f.audienceTicketTypes.length} disabled={!draft} onClick={() => set('audienceTicketTypes', [])} label="Everyone with a ticket" />
                  {[...new Set([...knownTypes.map((t) => t.name), ...f.audienceTicketTypes])].map((name) => (
                    <Chip key={name} on={f.audienceTicketTypes.includes(name)} disabled={!draft}
                      onClick={() => set('audienceTicketTypes', f.audienceTicketTypes.includes(name) ? f.audienceTicketTypes.filter((x) => x !== name) : [...f.audienceTicketTypes, name])}
                      label={`🎫 ${name}`} />
                  ))}
                </div>
              ) : <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: 0 }}>Everyone with a ticket. Enter a listed event ID above to target specific ticket types.</p>}
              {f.audienceTicketTypes.length > 0 && <p style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0 0' }}>🎯 Only fans holding {f.audienceTicketTypes.join(' / ')} will see this survey in the app.</p>}
            </div>

            <div style={{ marginTop: 14 }}>
              <label style={label}>Title</label>
              <input style={input} value={f.title} disabled={!draft} placeholder="How was the event?" onChange={(e) => set('title', e.target.value)} />
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={label}>Intro line</label>
              <input style={input} value={f.description} disabled={!draft} placeholder="2 minutes — help us make next year better." onChange={(e) => set('description', e.target.value)} />
            </div>

            <label style={{ ...label, marginTop: 18 }}>Questions</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {f.questions.map((q, i) => (
                <QuestionCard key={q.id} q={q} i={i} n={f.questions.length} disabled={!draft}
                  onChange={(patch) => setQ(i, patch)} onMove={(d) => moveQ(i, d)}
                  onDelete={() => set('questions', f.questions.filter((_, j) => j !== i))} />
              ))}
              {f.questions.length === 0 && <p style={{ fontSize: 13, color: 'var(--muted)', margin: '4px 0' }}>No questions yet — add your first below.</p>}
            </div>
            {draft && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12, paddingTop: 12, borderTop: '1px dashed var(--hairline)' }}>
                {Object.entries(QTYPES).map(([type, t]) => (
                  <button key={type} style={mini} title={t.hint} onClick={() => set('questions', [...f.questions, newQuestion(type)])}>+ {t.label}</button>
                ))}
              </div>
            )}
          </div>
        )}
        {(!isMobile || showPreview) && (
          <div style={{ flex: isMobile ? 1 : '0 0 300px', position: isMobile ? 'static' : 'sticky', top: 60 }}>
            <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 8px', textAlign: 'center' }}>What fans see · {f.layout === 'cards' ? 'card per question' : 'single form'}</p>
            {preview}
          </div>
        )}
      </div>
    </div>
  );
}

// Email & links for a LIVE survey: paste recipients → personal links + branded
// emails via the mail engine; plus one public share link (QR/socials/WhatsApp).
function DistributionPanel({ entityId, scope, survey }) {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState(null);
  const [recipients, setRecipients] = useState('');
  const [subject, setSubject] = useState(`How was ${survey.eventName || 'the event'}?`);
  const [message, setMessage] = useState(survey.description || 'It only takes 2 minutes — tell us how it went.');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const [share, setShare] = useState('');
  const loadStats = () => api.surveyLinks(scope, entityId, survey.id).then(setStats).catch(() => {});
  useEffect(() => { loadStats(); }, [survey.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const parse = () => recipients.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [email, displayName, ticketType] = l.split(',').map((x) => (x || '').trim());
    return { email, displayName, ticketType };
  });

  const sendEmails = async () => {
    const list = parse();
    if (!list.length) { setOutcome({ error: 'Paste at least one recipient first.' }); return; }
    if (!confirm(`Send the survey email to ${list.length} recipient${list.length === 1 ? '' : 's'} now?`)) return;
    setBusy(true); setOutcome(null);
    try {
      const r = await api.surveySendEmails(scope, entityId, survey.id, { recipients: list, subject, message });
      if (r.error) throw new Error(r.error);
      setOutcome(r); setRecipients(''); loadStats();
    } catch (e) { setOutcome({ error: e.message }); } finally { setBusy(false); }
  };
  const makeShare = async () => {
    const r = await api.surveyShareLink(scope, entityId, survey.id).catch(() => null);
    if (r && r.url) {
      setShare(r.url);
      try { await navigator.clipboard.writeText(r.url); } catch { /* show it instead */ }
    }
  };

  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)', padding: '12px 14px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 13.5 }}>📧 Email & links</span>
        {stats && stats.total > 0 && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{stats.total} link{stats.total === 1 ? '' : 's'} · {stats.opened} opened · {stats.responded} responded</span>}
        <span style={{ flex: 1 }} />
        <button style={tiny} onClick={makeShare}>🔗 {share ? 'Copied!' : 'Copy public link'}</button>
        <button style={tiny} onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : '✉️ Email it out'}</button>
      </div>
      {share && <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '6px 0 0', wordBreak: 'break-all' }}>{share} — anyone with this link can answer (QR codes, socials, WhatsApp).</p>}
      {open && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label style={label}>Recipients — one per line: email, name, ticket type</label>
            <textarea style={{ ...input, minHeight: 90, fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }} placeholder={'thandi@example.com, Thandi, VIP\nsipho@example.com'} value={recipients} onChange={(e) => setRecipients(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 220px' }}><label style={label}>Subject</label><input style={input} value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
            <div style={{ flex: '2 1 280px' }}><label style={label}>Message</label><input style={input} value={message} onChange={(e) => setMessage(e.target.value)} /></div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button style={primary} disabled={busy} onClick={sendEmails}>{busy ? 'Sending…' : `Send to ${parse().length || '…'} recipient${parse().length === 1 ? '' : 's'}`}</button>
            <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Each fan gets their own private link — their answers arrive already tagged with name & ticket type. Suppressed/unsubscribed addresses are skipped automatically.</span>
          </div>
          {outcome && (outcome.error
            ? <p style={{ color: 'var(--error, #d70015)', fontSize: 12.5, fontWeight: 600, margin: 0 }}>{outcome.error}</p>
            : <p style={{ fontSize: 12.5, color: 'var(--success, #1d8a3b)', fontWeight: 600, margin: 0 }}>
                ✓ Sent {outcome.sent} of {outcome.total}{outcome.skipped?.length ? ` — skipped: ${outcome.skipped.map((s) => `${s.email} (${s.reason})`).join(', ')}` : ''}
              </p>)}
        </div>
      )}
    </div>
  );
}

function Chip({ on, label, onClick, disabled }) {
  return (
    <button disabled={disabled} onClick={onClick} style={{ border: on ? '1px solid transparent' : '1px solid var(--hairline)', background: on ? 'var(--brand)' : 'var(--card)', color: on ? '#fff' : 'var(--muted-2, var(--muted))', borderRadius: 980, padding: '6px 13px', fontSize: 12.5, fontWeight: 650, cursor: disabled ? 'default' : 'pointer' }}>{label}</button>
  );
}

function QuestionCard({ q, i, n, disabled, onChange, onMove, onDelete }) {
  const t = QTYPES[q.type] || QTYPES.text;
  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)', padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 7, background: t.bg, color: t.fg }}>{t.label}</span>
        <span style={{ flex: 1 }} />
        <label style={{ fontSize: 12, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5, cursor: disabled ? 'default' : 'pointer' }}>
          <input type="checkbox" checked={!!q.required} disabled={disabled} onChange={(e) => onChange({ required: e.target.checked })} /> Required
        </label>
        {!disabled && (
          <span style={{ display: 'inline-flex', gap: 4 }}>
            <button style={tiny} disabled={i === 0} onClick={() => onMove(-1)} title="Move up">↑</button>
            <button style={tiny} disabled={i === n - 1} onClick={() => onMove(1)} title="Move down">↓</button>
            <button style={{ ...tiny, color: 'var(--error, #d70015)' }} onClick={onDelete} title="Remove">✕</button>
          </span>
        )}
      </div>
      <input style={input} value={q.text} disabled={disabled} placeholder={q.type === 'rating' ? 'e.g. How would you rate the event overall?' : 'Question text'} onChange={(e) => onChange({ text: e.target.value })} />
      {isChoice(q.type) && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(q.options || []).map((o, oi) => (
            <div key={oi} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>{q.type === 'single_choice' ? '◯' : '☐'}</span>
              <input style={{ ...input, padding: '7px 10px', fontSize: 13 }} value={o} disabled={disabled} placeholder={`Option ${oi + 1}`} onChange={(e) => onChange({ options: q.options.map((x, j) => (j === oi ? e.target.value : x)) })} />
              {!disabled && q.options.length > 2 && <button style={tiny} onClick={() => onChange({ options: q.options.filter((_, j) => j !== oi) })}>✕</button>}
            </div>
          ))}
          {!disabled && (q.options || []).length < 10 && <button style={{ ...tiny, alignSelf: 'flex-start' }} onClick={() => onChange({ options: [...(q.options || []), ''] })}>+ option</button>}
        </div>
      )}
      {q.type === 'rating' && <div style={{ marginTop: 8, color: '#ffb340', letterSpacing: 3, fontSize: 16 }}>★★★★★</div>}
    </div>
  );
}

// Compact in-app render of the survey being built — mirrors the app's two layouts.
function PhonePreview({ f }) {
  const qs = f.questions.filter((q) => q.text.trim() || true);
  const first = qs[0];
  return (
    <div style={{ margin: '0 auto', maxWidth: 280, border: '8px solid #101013', borderRadius: 32, background: '#101013', boxShadow: '0 18px 44px -18px rgba(0,0,0,0.5)' }}>
      <div style={{ background: 'var(--bg)', borderRadius: 24, overflow: 'hidden', height: 470, overflowY: 'auto' }}>
        <div style={{ padding: '15px 15px 12px', background: 'linear-gradient(135deg, var(--brand), var(--brand-2, #ff6b35))', color: '#fff' }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.92 }}>{f.eventName || 'Your event'}{f.layout === 'cards' && qs.length ? ` · 1 of ${qs.length}` : ''}</div>
          <div style={{ fontSize: 17, fontWeight: 800, margin: '4px 0 2px' }}>{f.title || 'Survey title'}</div>
          {f.description && <div style={{ fontSize: 12, opacity: 0.92 }}>{f.description}</div>}
          {f.layout === 'cards' && qs.length > 0 && <div style={{ height: 4, background: 'rgba(255,255,255,0.35)', borderRadius: 3, marginTop: 9 }}><div style={{ height: '100%', width: `${Math.round(100 / qs.length)}%`, background: '#fff', borderRadius: 3 }} /></div>}
        </div>
        <div style={{ padding: 13 }}>
          {(f.layout === 'cards' ? (first ? [first] : []) : qs).map((q) => (
            <div key={q.id} style={{ marginBottom: 15 }}>
              <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 7 }}>{q.text || <span style={{ color: 'var(--muted)' }}>Question text…</span>}{q.required && <span style={{ color: 'var(--brand)' }}> ★</span>}</div>
              {q.type === 'rating' && <div style={{ fontSize: 24, letterSpacing: 4 }}><span style={{ color: '#ffb340' }}>★★★★</span><span style={{ color: 'var(--hairline)' }}>★</span></div>}
              {isChoice(q.type) && (q.options || []).filter((o) => o.trim()).slice(0, 5).map((o, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${i === 1 ? 'var(--brand)' : 'var(--hairline)'}`, background: i === 1 ? 'rgba(255,56,92,0.06)' : 'var(--card)', borderRadius: 9, padding: '8px 10px', marginBottom: 6, fontSize: 12.5 }}>
                  <span style={{ width: 14, height: 14, flex: 'none', borderRadius: q.type === 'single_choice' ? '50%' : 4, border: `2px solid ${i === 1 ? 'var(--brand)' : 'var(--hairline)'}`, background: i === 1 && q.type === 'multiple_choice' ? 'var(--brand)' : 'transparent', boxShadow: i === 1 && q.type === 'single_choice' ? 'inset 0 0 0 3px var(--brand)' : 'none' }} />
                  {o}
                </div>
              ))}
              {q.type === 'text' && <div style={{ border: '1px solid var(--hairline)', borderRadius: 9, padding: '9px 10px', fontSize: 12, color: 'var(--muted)', minHeight: 40, background: 'var(--card)' }}>Type here…</div>}
            </div>
          ))}
          {qs.length === 0 && <p style={{ fontSize: 12.5, color: 'var(--muted)', textAlign: 'center', marginTop: 40 }}>Add questions to see them here</p>}
        </div>
        {qs.length > 0 && <div style={{ margin: '0 13px 14px', padding: 11, textAlign: 'center', borderRadius: 11, background: 'linear-gradient(135deg, var(--brand), var(--brand-2, #ff6b35))', color: '#fff', fontWeight: 700, fontSize: 13 }}>{f.layout === 'cards' ? 'Continue' : 'Send feedback'}</div>}
      </div>
    </div>
  );
}

// ── Results: filter by ticket type · by-day · breakdowns · drill-down ─────────

function SurveyResults({ entityId, scope, survey, onClose }) {
  const [res, setRes] = useState(null);
  const [tt, setTt] = useState('');
  const [drill, setDrill] = useState(null); // {questionId, optionIndex, label, data}
  const load = (ticketType) => api.surveyResults(scope, entityId, survey.id, ticketType)
    .then(setRes).catch(() => setRes({ error: true }));
  useEffect(() => { setDrill(null); load(tt); }, [tt]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!res) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading results…</p>;
  if (res.error) return <p style={{ color: 'var(--error, #d70015)', fontSize: 13 }}>Couldn’t load results — try again.</p>;

  const ratingQ = res.questions.find((q) => q.type === 'rating');
  const comments = res.questions.filter((q) => q.type === 'text').reduce((n, q) => n + (q.answered || 0), 0);
  const maxDay = Math.max(1, ...res.byDay.map((d) => d.count));

  const openDrill = async (q, opt) => {
    if (drill && drill.questionId === q.id && drill.optionIndex === opt.index) { setDrill(null); return; }
    const data = await api.surveyResponses(scope, entityId, survey.id, { questionId: q.id, optionIndex: opt.index, ...(tt ? { ticketType: tt } : {}), limit: 8 }).catch(() => null);
    setDrill({ questionId: q.id, optionIndex: opt.index, label: opt.text, data });
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <button style={mini} onClick={onClose}>← Back</button>
        <span style={{ fontWeight: 750, fontSize: 15 }}>{survey.title}</span>
        <StatusPill s={survey} />
        <span style={{ flex: 1 }} />
        <a style={{ ...mini, textDecoration: 'none', display: 'inline-block' }} href={api.surveyCsvUrl(scope, entityId, survey.id, tt)} download>⬇ Export CSV{tt ? ` (${tt})` : ''}</a>
      </div>

      {res.ticketTypes.length > 1 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>🎫 Ticket type</span>
          <Chip on={!tt} onClick={() => setTt('')} label={`All · ${res.totalResponseCount.toLocaleString()}`} />
          {res.byTicketType.map((t) => <Chip key={t.ticketType} on={tt === t.ticketType} onClick={() => setTt(t.ticketType)} label={`${t.ticketType} · ${t.count.toLocaleString()}`} />)}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginBottom: 8 }}>
        <Stat v={res.responseCount.toLocaleString()} k={`Responses${tt ? ` · ${tt}` : ''}`} />
        <Stat v={ratingQ && ratingQ.average != null ? `${ratingQ.average}/5` : '—'} k="Overall rating" />
        <Stat v={comments.toLocaleString()} k="Comments" />
        <Stat v={res.byDay.length ? `${fmtDate(res.byDay[0].date)} –` : '—'} k="Collecting since" />
      </div>
      {(res.byChannel || []).length > 1 && (
        <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 14px' }}>
          Answered via {res.byChannel.map((c) => `${{ app: '📱 app', email: '✉️ email', web: '🔗 web' }[c.channel] || c.channel} ${c.count.toLocaleString()}`).join(' · ')}
        </p>
      )}
      {(res.byChannel || []).length <= 1 && <div style={{ marginBottom: 6 }} />}

      {res.byDay.length > 1 && (
        <div style={card}>
          <h4 style={h4}>Responses by day</h4>
          <p style={meta}>Hover a day for its average rating</p>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 90 }}>
            {res.byDay.map((d) => (
              <div key={d.date} title={`${fmtDate(d.date)} · ${d.count} response${d.count === 1 ? '' : 's'}${d.avgRating != null ? ` · avg ${d.avgRating}★` : ''}`}
                style={{ flex: 1, height: `${Math.max(4, Math.round((d.count / maxDay) * 100))}%`, background: 'linear-gradient(180deg, var(--brand-2, #ff6b35), var(--brand))', borderRadius: '3px 3px 0 0', minWidth: 4 }} />
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>
            <span>{fmtDate(res.byDay[0].date)}</span><span>{fmtDate(res.byDay[res.byDay.length - 1].date)}</span>
          </div>
        </div>
      )}

      {res.byTicketType.length > 1 && !tt && (
        <div style={card}>
          <h4 style={h4}>Who responded</h4>
          <p style={meta}>By ticket type — tap a chip above to focus the whole report</p>
          {res.byTicketType.map((t) => (
            <BarRow key={t.ticketType} label={t.ticketType} value={t.count} max={res.byTicketType[0].count} suffix={t.avgRating != null ? ` · ${t.avgRating}★` : ''} />
          ))}
        </div>
      )}

      {res.questions.map((q) => (
        <div key={q.id} style={card}>
          <h4 style={h4}>{q.text}</h4>
          <p style={meta}>{QTYPES[q.type]?.label || q.type} · {q.answered.toLocaleString()} answered{tt ? ` · ${tt}` : ''}</p>
          {q.type === 'rating' && (
            <div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 30, fontWeight: 800 }}>{q.average != null ? q.average : '—'}</span>
                <span style={{ color: 'var(--muted)', fontWeight: 600 }}>/ 5 average</span>
              </div>
              {[5, 4, 3, 2, 1].map((n) => <BarRow key={n} label={`${n} ★`} value={q.counts[n] || 0} max={Math.max(1, ...Object.values(q.counts))} />)}
            </div>
          )}
          {q.options && q.options.map((o) => (
            <div key={o.index}>
              <BarRow label={o.text} value={o.count} max={Math.max(1, ...q.options.map((x) => x.count))} clickable onClick={() => openDrill(q, o)} />
              {drill && drill.questionId === q.id && drill.optionIndex === o.index && (
                <div style={{ border: '1px solid var(--hairline)', borderLeft: '3px solid var(--brand)', borderRadius: 10, background: 'rgba(128,128,128,0.06)', padding: 11, margin: '2px 0 10px' }}>
                  {!drill.data ? <p style={{ ...meta, margin: 0 }}>Couldn’t load the drill-down.</p> : (
                    <>
                      <p style={{ fontSize: 12.5, fontWeight: 700, margin: '0 0 6px' }}>{drill.data.total.toLocaleString()} fan{drill.data.total === 1 ? '' : 's'} picked “{drill.label}”{tt ? ` (${tt})` : ''}</p>
                      {drill.data.responses.map((r) => {
                        const textAns = (r.answers || []).find((a) => a.type === 'text' && a.text);
                        return (
                          <div key={r.id} style={{ fontSize: 12, color: 'var(--muted-2, var(--text))', padding: '5px 0', borderTop: '1px solid var(--hairline)' }}>
                            <span style={{ fontWeight: 650 }}>{r.ticketType}</span> · fan {r.howlerUserId} · {fmtDate(r.submittedAt)}
                            {textAns && <div style={{ marginTop: 2, fontStyle: 'italic' }}>“{textAns.text}”</div>}
                          </div>
                        );
                      })}
                      {drill.data.total > drill.data.responses.length && <p style={{ ...meta, margin: '6px 0 0' }}>Showing {drill.data.responses.length} of {drill.data.total} — export the CSV for all.</p>}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
          {q.type === 'text' && (
            (q.answers || []).length === 0 ? <p style={{ ...meta, margin: 0 }}>No comments yet.</p> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {(q.answers || []).slice(0, 30).map((a, i) => (
                  <div key={i} style={{ fontSize: 12.5, padding: '8px 11px', borderLeft: '3px solid var(--brand)', background: 'rgba(128,128,128,0.07)', borderRadius: '0 8px 8px 0' }}>
                    {a.text}
                    <span style={{ display: 'block', fontSize: 10.5, color: 'var(--muted)', marginTop: 3 }}>{fmtDate(a.at)}</span>
                  </div>
                ))}
                {(q.answers || []).length > 30 && <p style={{ ...meta, margin: 0 }}>Showing 30 of {(q.answers || []).length} — export the CSV for all.</p>}
              </div>
            )
          )}
        </div>
      ))}
    </div>
  );
}

function Stat({ v, k }) {
  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)', padding: '11px 14px' }}>
      <div style={{ fontSize: 21, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{v}</div>
      <div style={{ fontSize: 10.5, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 1 }}>{k}</div>
    </div>
  );
}

function BarRow({ label, value, max, suffix = '', clickable, onClick }) {
  return (
    <div onClick={onClick} title={clickable ? 'Tap to drill into who said this' : undefined}
      style={{ display: 'grid', gridTemplateColumns: 'minmax(70px, 130px) 1fr 52px', alignItems: 'center', gap: 9, marginBottom: 7, fontSize: 12.5, cursor: clickable ? 'pointer' : 'default' }}>
      <span style={{ color: 'var(--muted-2, var(--muted))', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}{clickable ? ' ›' : ''}</span>
      <div style={{ height: 9, background: 'rgba(128,128,128,0.12)', borderRadius: 5, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.round((value / max) * 100)}%`, background: 'linear-gradient(90deg, var(--brand), var(--brand-2, #ff6b35))', borderRadius: 5 }} />
      </div>
      <span style={{ textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{value.toLocaleString()}{suffix}</span>
    </div>
  );
}

const label = { display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 };
const input = { width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 14, color: 'var(--text)', background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 10, padding: '9px 12px' };
const mini = { padding: '7px 12px', borderRadius: 8, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
const tiny = { padding: '4px 8px', borderRadius: 7, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 12, cursor: 'pointer' };
const primary = { padding: '9px 18px', borderRadius: 980, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const card = { border: '1px solid var(--hairline)', borderRadius: 14, background: 'var(--card)', padding: '14px 16px', marginBottom: 12 };
const h4 = { margin: '0 0 2px', fontSize: 14, fontWeight: 750 };
const meta = { fontSize: 11.5, color: 'var(--muted)', margin: '0 0 12px' };
const evHint = (color) => ({ fontSize: 12, color, margin: '5px 0 0', fontWeight: 600 });
