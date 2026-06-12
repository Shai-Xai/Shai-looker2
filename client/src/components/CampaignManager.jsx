import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';

// Action Engine v1 — email campaigns (e.g. abandoned cart). The lifecycle IS
// the product: draft (AI-written, editable) → preview audience + email →
// APPROVE (explicit, shows the count) → running → done with results.
// One component for both surfaces (admin + client self-service) — the server
// enforces entity access on every call.
export default function CampaignManager({ entityId, scope = 'admin', initialGoal = '' }) {
  const isAdmin = scope === 'admin';
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null); // action object | 'new'
  const [reporting, setReporting] = useState(null); // action object
  // "Make it happen": arriving with a goal (from a briefing/digest suggestion)
  // opens a fresh campaign pre-filled with it.
  useEffect(() => { if (initialGoal) setEditing('new'); }, [initialGoal]);

  const load = () => api.listActions(entityId).then(setData).catch(() => setData({ actions: [] }));
  useEffect(() => { load(); }, [entityId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll while anything is running so results tick up live.
  useEffect(() => {
    if (!data?.actions?.some((a) => a.status === 'running')) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(data?.actions?.map((a) => a.status))]);

  if (!data) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p>;

  if (editing) {
    return <CampaignEditor entityId={entityId} isAdmin={isAdmin} action={editing === 'new' ? null : editing} initialGoal={editing === 'new' ? initialGoal : ''}
      onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />;
  }
  if (reporting) {
    return <CampaignReport entityId={entityId} action={reporting} onClose={() => setReporting(null)} />;
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>Data-driven email campaigns — e.g. nudge abandoned-cart customers. Nothing sends without an explicit approval.</p>
        <button style={primary} onClick={() => setEditing('new')}>+ New campaign</button>
      </div>
      {data.actions.length === 0 ? (
        <div style={{ ...card, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
          No campaigns yet. Try one: target customers who abandoned checkout and bring them back.
        </div>
      ) : data.actions.map((a) => (
        <div key={a.id} style={{ ...card, display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, fontSize: 14 }}>{a.title || a.config.subject || 'Untitled campaign'}</span>
              <StatusChip status={a.status} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
              {a.status === 'auto'
                ? `Automation active · checks daily${a.lastCheck ? ` · last check ${fmt(a.lastCheck)}` : ''}`
                : a.status === 'draft'
                ? (a.createdBy === 'automation' ? `⏳ Queued by automation · awaiting approval · ${fmt(a.createdAt)}` : `Draft · created ${fmt(a.createdAt)} by ${a.createdBy}`)
                : `Approved by ${a.approvedBy} · ${fmt(a.approvedAt)}`}
            </div>
            {a.status !== 'draft' && (
              <div style={{ display: 'flex', gap: 14, marginTop: 6, fontSize: 12.5, fontWeight: 600 }}>
                <span>📤 {a.results.sent ?? 0}/{a.results.total ?? a.audienceCount} sent</span>
                {(a.results.failed ?? 0) > 0 && <span style={{ color: 'var(--error,#ef4444)' }}>✗ {a.results.failed} failed</span>}
                <span>🔗 {a.results.clicks ?? 0} clicks</span>
                {a.results.sent > 0 && <span style={{ color: 'var(--muted)' }}>{Math.round(((a.results.clicks || 0) / a.results.sent) * 100)}% CTR</span>}
              </div>
            )}
            {a.results?.lastError && a.status !== 'done' && <div style={{ fontSize: 11, color: 'var(--error,#ef4444)', marginTop: 3 }}>{a.results.lastError}</div>}
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            {(a.status === 'done' || a.status === 'running' || a.status === 'failed') && <button style={mini} onClick={() => setReporting(a)}>📊 Report</button>}
            {(a.status === 'draft' || a.status === 'auto') && <button style={mini} onClick={() => setEditing(a)}>{a.createdBy === 'automation' ? 'Review & approve' : 'Edit'}</button>}
            {a.status === 'auto' && <button style={mini} onClick={() => api.pauseAction(entityId, a.id).then(load)}>⏸ Pause</button>}
            {a.status !== 'running' && <button style={{ ...mini, color: 'var(--error,#ef4444)' }} onClick={() => { if (confirm('Delete this campaign?')) api.deleteAction(entityId, a.id).then(load); }}>Delete</button>}
          </div>
        </div>
      ))}
    </div>
  );
}

function CampaignEditor({ entityId, isAdmin, action, initialGoal = '', onClose, onSaved }) {
  const cfg = action?.config || {};
  const [f, setF] = useState(() => ({
    title: action?.title || '',
    goal: cfg.goal || initialGoal || 'Re-engage customers who abandoned their ticket checkout and get them to complete the purchase.',
    recurring: action?.recurring || false,
    audienceMode: cfg.audience?.mode || 'tile',
    dashboardId: cfg.audience?.dashboardId || '',
    tileId: cfg.audience?.tileId || '',
    emailField: cfg.audience?.emailField || '',
    nameField: cfg.audience?.nameField || '',
    consentField: cfg.audience?.consentField || '',
    ticketField: cfg.audience?.ticketField || '',
    pasted: cfg.audience?.pasted || '',
    eventSuiteId: cfg.eventSuiteId || '',
    contentMode: cfg.contentMode || 'template',
    heroImage: cfg.heroImage || '',
    customHtml: cfg.customHtml || '',
    subject: cfg.subject || '',
    body: cfg.body || '',
    ctaText: cfg.ctaText || 'Complete your order',
    ctaUrl: cfg.ctaUrl || '',
    utm: { source: cfg.utm?.source || '', medium: cfg.utm?.medium || '', campaign: cfg.utm?.campaign || '', term: cfg.utm?.term || '', content: cfg.utm?.content || '' },
  }));
  const [events, setEvents] = useState([]);
  useEffect(() => { api.listCampaignEvents(entityId).then((r) => setEvents(r.events || [])).catch(() => {}); }, [entityId]);
  const [tiles, setTiles] = useState(null);
  const [aud, setAud] = useState(null); // { count, excluded, sample, fields }
  const [audBusy, setAudBusy] = useState(false);
  const [preview, setPreview] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testState, setTestState] = useState('');
  const [approveState, setApproveState] = useState('');
  const debounce = useRef(null);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  useEffect(() => { (isAdmin ? api.getDigestTiles(entityId) : api.getMyDigestTiles(entityId)).then(setTiles).catch(() => setTiles({ dashboards: [] })); }, [entityId, isAdmin]);

  const payload = () => ({
    title: f.title, goal: f.goal, subject: f.subject, body: f.body, ctaText: f.ctaText, ctaUrl: f.ctaUrl, utm: f.utm, recurring: f.recurring,
    eventSuiteId: f.eventSuiteId, contentMode: f.contentMode, heroImage: f.heroImage, customHtml: f.customHtml,
    audience: { mode: f.audienceMode, dashboardId: f.dashboardId, tileId: f.tileId, emailField: f.emailField, nameField: f.nameField, consentField: f.consentField, ticketField: f.ticketField, pasted: f.pasted },
  });

  const refreshAudience = () => {
    // Snapshot children (queued by an automation) carry their audience already.
    if (f.audienceMode === 'snapshot') { setAud({ count: action?.audienceCount || 0, excluded: 0, noConsent: 0, sample: [], fields: [] }); return; }
    if (f.audienceMode === 'tile' && (!f.dashboardId || !f.tileId)) { setAud(null); return; }
    setAudBusy(true);
    api.actionAudiencePreview(entityId, payload()).then(setAud).catch((e) => setAud({ error: e.message })).finally(() => setAudBusy(false));
  };
  useEffect(() => { refreshAudience(); }, [f.audienceMode, f.dashboardId, f.tileId, f.emailField, f.consentField]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced email preview.
  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      api.actionPreviewEmail(entityId, payload()).then((r) => setPreview(r.html)).catch(() => {});
    }, 350);
    return () => clearTimeout(debounce.current);
  }, [f.subject, f.body, f.ctaText, f.ctaUrl, f.contentMode, f.customHtml, f.heroImage]); // eslint-disable-line react-hooks/exhaustive-deps

  const draft = async () => {
    setDrafting(true);
    try {
      const d = await api.actionDraftCopy(entityId, { goal: f.goal, audienceCount: aud?.count || 0 });
      setF((s) => ({
        ...s,
        subject: d.subject || s.subject, body: d.body || s.body, ctaText: d.ctaText || s.ctaText,
        // Magic-fill UTMs from the AI when the user hasn't set them.
        utm: {
          source: s.utm.source || d.utm?.source || '',
          medium: s.utm.medium || d.utm?.medium || '',
          campaign: s.utm.campaign || d.utm?.campaign || '',
          term: s.utm.term || d.utm?.term || '',
          content: s.utm.content || d.utm?.content || '',
        },
      }));
    } catch (e) { alert('AI draft failed: ' + e.message); }
    finally { setDrafting(false); }
  };

  // Deterministic UTM auto-fill (no AI needed): sensible defaults from the
  // campaign's own naming. Only fills blanks.
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  const autoUtm = () => setF((s) => ({
    ...s,
    utm: {
      source: s.utm.source || 'howler-pulse',
      medium: s.utm.medium || 'email',
      campaign: s.utm.campaign || slug(s.title || s.goal) || 'campaign',
      term: s.utm.term,
      content: s.utm.content || (slug(s.title || 'email') + '_emailer'),
    },
  }));

  async function saveDraft() {
    setBusy(true);
    try {
      if (action) await api.updateAction(entityId, action.id, payload());
      else await api.createAction(entityId, payload());
      onSaved();
    } catch (e) { alert('Save failed: ' + e.message); }
    finally { setBusy(false); }
  }

  async function approve() {
    if (f.recurring) {
      if (!confirm('Activate this automation?\n\nIt will check the tile daily and queue any NEW recipients as a draft for your approval. Nothing sends without you approving each batch.')) return;
      setApproveState('working');
      try {
        let id = action?.id;
        if (id) await api.updateAction(entityId, id, payload());
        else { const r = await api.createAction(entityId, payload()); id = r.action.id; }
        await api.approveAction(entityId, id);
        setApproveState('✓ Automation active');
        setTimeout(onSaved, 900);
      } catch (e) { setApproveState(`✗ ${e.message}`); }
      return;
    }
    if (!aud?.count) { alert('Audience is empty.'); return; }
    // Show the actual recipients (not just a count) so the sender sees exactly
    // who this goes to before it's irreversible.
    const who = (aud.sample || []).map((s) => s.email);
    const recipientList = who.length
      ? `\n\nRecipients:\n• ${who.join('\n• ')}${aud.count > who.length ? `\n• …and ${aud.count - who.length} more` : ''}`
      : '';
    const src = f.audienceMode === 'tile' ? `the “${dash?.tiles?.find((t) => t.tileId === f.tileId)?.title || 'selected'}” tile` : 'your pasted list';
    if (!confirm(`Send this campaign to ${aud.count} recipient${aud.count === 1 ? '' : 's'} from ${src}?${recipientList}\n\nThis sends real emails now and cannot be undone.`)) return;
    setApproveState('working');
    try {
      let id = action?.id;
      if (id) await api.updateAction(entityId, id, payload());
      else { const r = await api.createAction(entityId, payload()); id = r.action.id; }
      const r = await api.approveAction(entityId, id);
      setApproveState(`✓ Sending to ${r.sendingTo}`);
      setTimeout(onSaved, 900);
    } catch (e) { setApproveState(`✗ ${e.message}`); }
  }

  const dash = tiles?.dashboards?.find((d) => d.dashboardId === f.dashboardId);

  return (
    <div>
      <button style={{ ...mini, marginBottom: 12 }} onClick={onClose}>← Back to campaigns</button>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 20, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Campaign name"><input style={input} value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Abandoned cart — Pretoria show" /></Field>

          {events.length > 0 && (
            <Field label="Event (optional)">
              <select style={input} value={f.eventSuiteId} onChange={(e) => set('eventSuiteId', e.target.value)}>
                <option value="">Not linked to an event</option>
                {events.map((ev) => <option key={ev.id} value={ev.id}>{ev.name}</option>)}
              </select>
            </Field>
          )}

          <Field label="Goal (steers the AI copy)">
            <textarea style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} rows={2} value={f.goal} onChange={(e) => set('goal', e.target.value)} />
          </Field>

          <Field label="Audience">
            {f.audienceMode === 'snapshot' ? (
              <div style={{ fontSize: 13, background: 'rgba(124,58,237,0.07)', border: '1px solid rgba(124,58,237,0.25)', borderRadius: 8, padding: '9px 12px' }}>
                ⚙ Queued by the automation: <b>{action?.audienceCount || 0} new recipient{(action?.audienceCount || 0) === 1 ? '' : 's'}</b> since the last send. Approve to email exactly these people.
              </div>
            ) : (
            <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <Toggle on={f.audienceMode === 'tile'} onClick={() => set('audienceMode', 'tile')}>From a dashboard tile</Toggle>
              <Toggle on={f.audienceMode === 'paste'} onClick={() => set('audienceMode', 'paste')}>Paste emails</Toggle>
            </div>
            {f.audienceMode === 'tile' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <select style={input} value={f.dashboardId} onChange={(e) => { set('dashboardId', e.target.value); set('tileId', ''); set('emailField', ''); }}>
                  <option value="">Pick a dashboard…</option>
                  {(tiles?.dashboards || []).map((d) => <option key={d.dashboardId} value={d.dashboardId}>{d.title} — {d.setName}</option>)}
                </select>
                {dash && (
                  <select style={input} value={f.tileId} onChange={(e) => { set('tileId', e.target.value); set('emailField', ''); }}>
                    <option value="">Pick the tile listing the audience…</option>
                    {dash.tiles.map((t) => <option key={t.tileId} value={t.tileId}>{t.title}</option>)}
                  </select>
                )}
                {aud?.fields?.length > 0 && (
                  <>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <select style={{ ...input, flex: 1 }} value={f.emailField} onChange={(e) => set('emailField', e.target.value)}>
                        <option value="">Email column (auto-detect)</option>
                        {aud.fields.map((fl) => <option key={fl.name} value={fl.name}>{fl.label}</option>)}
                      </select>
                      <select style={{ ...input, flex: 1 }} value={f.nameField} onChange={(e) => set('nameField', e.target.value)}>
                        <option value="">Name column (optional)</option>
                        {aud.fields.map((fl) => <option key={fl.name} value={fl.name}>{fl.label}</option>)}
                      </select>
                    </div>
                    <select style={input} value={f.ticketField} onChange={(e) => set('ticketField', e.target.value)}>
                      <option value="">Ticket-type column (optional — enables {'{{ticketType}}'})</option>
                      {aud.fields.map((fl) => <option key={fl.name} value={fl.name}>{fl.label}</option>)}
                    </select>
                    <select style={input} value={f.consentField} onChange={(e) => set('consentField', e.target.value)}>
                      <option value="">Consent column — recommended (only email when = Yes)</option>
                      {aud.fields.map((fl) => <option key={fl.name} value={fl.name}>Only if “{fl.label}” = Yes</option>)}
                    </select>
                  </>
                )}
              </div>
            ) : (
              <textarea style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} rows={3} value={f.pasted} onChange={(e) => set('pasted', e.target.value)} placeholder="one@example.com, two@example.com …" onBlur={refreshAudience} />
            )}
            <div style={{ marginTop: 8, fontSize: 12.5 }}>
              {audBusy ? <span style={{ color: 'var(--muted)' }}>Counting audience…</span>
                : aud?.error ? <span style={{ color: 'var(--error,#ef4444)' }}>✗ {aud.error}</span>
                : aud ? (
                  <span>
                    <b style={{ color: 'var(--brand)' }}>{aud.count}</b> recipient{aud.count === 1 ? '' : 's'}
                    {aud.noConsent > 0 && <span style={{ color: 'var(--muted)' }}> · {aud.noConsent} excluded (no consent)</span>}
                    {aud.excluded > 0 && <span style={{ color: 'var(--muted)' }}> · {aud.excluded} unsubscribed</span>}
                    {aud.sample?.length > 0 && <span style={{ color: 'var(--muted)' }}> · e.g. {aud.sample.slice(0, 3).map((s) => s.email).join(', ')}</span>}
                  </span>
                ) : <span style={{ color: 'var(--muted)' }}>Pick an audience source to see the count.</span>}
            </div>
            </>
            )}
          </Field>

          <Field label="Content">
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <Toggle on={f.contentMode === 'template'} onClick={() => set('contentMode', 'template')}>Built template</Toggle>
              <Toggle on={f.contentMode === 'html'} onClick={() => set('contentMode', 'html')}>Custom HTML</Toggle>
            </div>

            {f.contentMode === 'template' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <ImageField label="Hero image (optional)" value={f.heroImage} onChange={(v) => set('heroImage', v)} />
                <button type="button" style={mini} onClick={draft} disabled={drafting}>{drafting ? 'Writing…' : '✨ Draft copy with AI'}</button>
                <input style={{ ...input, fontWeight: 700 }} value={f.subject} onChange={(e) => set('subject', e.target.value)} placeholder="Subject line" />
                <textarea style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} rows={6} value={f.body} onChange={(e) => set('body', e.target.value)} placeholder={'Hi {{name}},\n\nYour {{ticketType}} tickets are still waiting…'} />
                <div style={hintS}>Tokens: <b>{'{{name}}'}</b> (first name) · <b>{'{{ticketType}}'}</b> (their ticket) — filled when the audience has those columns.</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input style={{ ...input, fontWeight: 700 }} value={f.subject} onChange={(e) => set('subject', e.target.value)} placeholder="Subject line" />
                <HtmlField value={f.customHtml} onChange={(v) => set('customHtml', v)} />
                <div style={hintS}>Upload or paste your own HTML email. Tokens work inside it: <b>{'{{name}}'}</b>, <b>{'{{ticketType}}'}</b>, <b>{'{{cta}}'}</b> (tracked link), <b>{'{{unsubscribe}}'}</b>. An unsubscribe link is added automatically if you omit one.</div>
              </div>
            )}
          </Field>

          {f.contentMode === 'template' && (
            <Field label="Call to action">
              <div style={{ display: 'flex', gap: 8 }}>
                <input style={{ ...input, flex: 1 }} value={f.ctaText} onChange={(e) => set('ctaText', e.target.value)} placeholder="Button text" />
                <input style={{ ...input, flex: 2 }} value={f.ctaUrl} onChange={(e) => set('ctaUrl', e.target.value)} placeholder="https://… (clicks are tracked)" />
              </div>
            </Field>
          )}
          {f.contentMode === 'html' && (
            <Field label="Tracked link (for {{cta}})">
              <input style={input} value={f.ctaUrl} onChange={(e) => set('ctaUrl', e.target.value)} placeholder="https://… — clicks on {{cta}} are tracked" />
            </Field>
          )}

          {f.audienceMode === 'tile' && (
            <Field label="Automation">
              <div style={{ display: 'flex', gap: 8 }}>
                <Toggle on={!f.recurring} onClick={() => set('recurring', false)}>One-off send</Toggle>
                <Toggle on={!!f.recurring} onClick={() => set('recurring', true)}>Daily auto-check</Toggle>
              </div>
              <div style={hintS}>{f.recurring
                ? 'Checks the tile daily; anyone NEW (never emailed by this campaign, not unsubscribed) is queued as a draft for your approval. Nothing sends on its own.'
                : 'Sends once to the current audience when you approve.'}</div>
            </Field>
          )}

          <Field label="UTM tracking (appended to the link on every click)">
            <button type="button" style={{ ...mini, marginBottom: 8 }} onClick={autoUtm}>✨ Auto-fill</button>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <input style={input} value={f.utm.source} onChange={(e) => set('utm', { ...f.utm, source: e.target.value })} placeholder="utm_source — e.g. howler-pulse" />
              <input style={input} value={f.utm.medium} onChange={(e) => set('utm', { ...f.utm, medium: e.target.value })} placeholder="utm_medium — e.g. email" />
              <input style={input} value={f.utm.campaign} onChange={(e) => set('utm', { ...f.utm, campaign: e.target.value })} placeholder="utm_campaign — e.g. kunye_abandoned_cart" />
              <input style={input} value={f.utm.term} onChange={(e) => set('utm', { ...f.utm, term: e.target.value })} placeholder="utm_term (optional)" />
            </div>
            <input style={{ ...input, marginTop: 8 }} value={f.utm.content} onChange={(e) => set('utm', { ...f.utm, content: e.target.value })} placeholder="utm_content — e.g. abandoned_cart_emailer" />
            {f.ctaUrl && (f.utm.source || f.utm.campaign) && (
              <div style={{ ...hintS, wordBreak: 'break-all' }}>
                Lands as: {(() => { try { const u = new URL(f.ctaUrl); const m = { utm_source: f.utm.source, utm_medium: f.utm.medium, utm_campaign: f.utm.campaign, utm_term: f.utm.term, utm_content: f.utm.content }; for (const [k, v] of Object.entries(m)) if (v) u.searchParams.set(k, v); return u.toString(); } catch { return '(enter a full https:// link to preview)'; } })()}
              </div>
            )}
          </Field>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
            <button style={mini} onClick={saveDraft} disabled={busy}>{busy ? 'Saving…' : 'Save draft'}</button>
            <button
              type="button" style={mini} disabled={testState === 'sending'}
              onClick={async () => { setTestState('sending'); try { const r = await api.actionTestSend(entityId, payload()); setTestState(`✓ Test sent to ${r.to}`); } catch (e) { setTestState(`✗ ${e.message}`); } }}
            >{testState === 'sending' ? 'Sending…' : 'Send test to me'}</button>
            <button style={{ ...primary, background: '#15803d' }} onClick={approve} disabled={approveState === 'working' || (!f.recurring && !aud?.count)}>
              {approveState === 'working' ? 'Approving…' : f.recurring ? '⚙ Activate automation' : `Approve & send${aud?.count ? ` to ${aud.count}` : ''}`}
            </button>
            {(testState && testState !== 'sending') && <span style={{ fontSize: 12, color: testState.startsWith('✓') ? 'var(--success,#10b981)' : 'var(--error,#ef4444)' }}>{testState}</span>}
            {(approveState && approveState !== 'working') && <span style={{ fontSize: 12, color: approveState.startsWith('✓') ? 'var(--success,#10b981)' : 'var(--error,#ef4444)' }}>{approveState}</span>}
          </div>
        </div>

        <div>
          <div style={hintLbl}>Email preview</div>
          <iframe title="Campaign preview" srcDoc={preview} style={{ width: '100%', height: 560, border: '1px solid var(--hairline)', borderRadius: 12, background: '#fff' }} />
        </div>
      </div>
    </div>
  );
}

// Detailed campaign report: summary stats + who clicked, how often, when.
function CampaignReport({ entityId, action, onClose }) {
  const [r, setR] = useState(null);
  useEffect(() => { api.actionReport(entityId, action.id).then(setR).catch(() => setR({ error: true })); }, [entityId, action.id]);
  if (!r) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading report…</p>;
  if (r.error) return <div><button style={mini} onClick={onClose}>← Back</button><p style={{ color: 'var(--error,#ef4444)', fontSize: 13, marginTop: 10 }}>Could not load the report.</p></div>;
  const stat = (label, value, color) => (
    <div style={{ background: 'var(--elevated, #fafafa)', border: '1px solid var(--hairline)', borderRadius: 12, padding: '12px 16px', minWidth: 110 }}>
      <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', color: color || 'var(--text)' }}>{value}</div>
    </div>
  );
  return (
    <div>
      <button style={{ ...mini, marginBottom: 12 }} onClick={onClose}>← Back to campaigns</button>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.01em' }}>{r.title || 'Campaign report'}</h2>
        <StatusChip status={r.status} />
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>Approved by {r.approvedBy} · {fmt(r.approvedAt)}</div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 }}>
        {stat('Sent', `${r.sent}/${r.total}`)}
        {r.failed > 0 && stat('Failed', r.failed, 'var(--error,#ef4444)')}
        {stat('Total clicks', r.totalClicks)}
        {stat('Unique clickers', r.uniqueClickers)}
        {stat('CTR', `${r.ctr}%`, 'var(--brand)')}
      </div>

      <div style={{ ...card }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Who clicked</div>
        {r.clickers.length === 0 ? (
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>No clicks yet.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <th style={tdR}>Recipient</th><th style={tdR}>Clicks</th><th style={tdR}>First click</th><th style={tdR}>Last click</th>
              </tr>
            </thead>
            <tbody>
              {r.clickers.map((c) => (
                <tr key={c.email} style={{ borderTop: '1px solid var(--hairline)' }}>
                  <td style={tdR}>{c.name ? <span><b>{c.name}</b> · </span> : null}{c.email}</td>
                  <td style={{ ...tdR, fontWeight: 700 }}>{c.clicks}</td>
                  <td style={{ ...tdR, color: 'var(--muted)' }}>{fmt(c.firstAt)}</td>
                  <td style={{ ...tdR, color: 'var(--muted)' }}>{fmt(c.lastAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 10 }}>
          {r.nonClickers > 0 && <span>{r.nonClickers} recipient{r.nonClickers === 1 ? '' : 's'} haven't clicked. </span>}
          {r.anonClicks > 0 && <span>{r.anonClicks} click{r.anonClicks === 1 ? '' : 's'} couldn't be attributed (e.g. older links). </span>}
          Forwarded links count toward the original recipient.
        </div>
      </div>
    </div>
  );
}

// Hero image: upload (resized ≤1000px wide, data-URL) or paste a URL.
function ImageField({ label, value, onChange }) {
  const ref = useRef(null);
  const onFile = (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1000, scale = Math.min(1, max / img.width);
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        onChange(c.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };
  return (
    <div>
      <div style={hintLbl}>{label}</div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <div style={{ width: 120, height: 56, border: '1px dashed var(--hairline)', borderRadius: 8, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff', flexShrink: 0 }}>
          {value ? <img src={value} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'cover' }} /> : <span style={{ fontSize: 11, color: 'var(--muted)' }}>None</span>}
        </div>
        <button type="button" style={mini} onClick={() => ref.current?.click()}>Upload</button>
        {value && <button type="button" style={{ ...mini, color: 'var(--error,#ef4444)' }} onClick={() => onChange('')}>Remove</button>}
        <input ref={ref} type="file" accept="image/*" style={{ display: 'none' }} onChange={onFile} />
      </div>
      {!value?.startsWith('data:') && <input value={value || ''} onChange={(e) => onChange(e.target.value)} placeholder="or paste an image URL" style={{ ...input, marginTop: 6 }} />}
    </div>
  );
}

// Custom HTML: upload an .html file or paste/edit markup directly.
function HtmlField({ value, onChange }) {
  const ref = useRef(null);
  const onFile = (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onChange(String(reader.result || '').slice(0, 500000));
    reader.readAsText(file);
    e.target.value = '';
  };
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
        <button type="button" style={mini} onClick={() => ref.current?.click()}>Upload .html file</button>
        {value && <button type="button" style={{ ...mini, color: 'var(--error,#ef4444)' }} onClick={() => onChange('')}>Clear</button>}
        <input ref={ref} type="file" accept=".html,text/html" style={{ display: 'none' }} onChange={onFile} />
      </div>
      <textarea style={{ ...input, resize: 'vertical', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }} rows={8} value={value} onChange={(e) => onChange(e.target.value)} placeholder="<html>…</html> — or upload a file above" />
    </div>
  );
}

function StatusChip({ status }) {
  const map = {
    draft: { bg: 'rgba(128,128,128,0.14)', c: 'var(--muted)', t: 'Draft' },
    auto: { bg: 'rgba(124,58,237,0.12)', c: '#7c3aed', t: '⚙ Automation' },
    running: { bg: 'rgba(10,132,255,0.13)', c: '#0a66c2', t: 'Sending…' },
    done: { bg: 'rgba(52,199,89,0.15)', c: '#2da44e', t: 'Sent' },
    failed: { bg: 'rgba(239,68,68,0.12)', c: '#dc2626', t: 'Failed' },
  }[status] || { bg: 'rgba(128,128,128,0.14)', c: 'var(--muted)', t: status };
  return <span style={{ fontSize: 10.5, fontWeight: 700, borderRadius: 980, padding: '2px 9px', background: map.bg, color: map.c }}>{map.t}</span>;
}

const fmt = (iso) => { try { return new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
function Field({ label, children }) { return <div><div style={hintLbl}>{label}</div>{children}</div>; }
function Toggle({ on, onClick, children }) {
  return <button type="button" onClick={onClick} style={{ flex: 1, padding: '8px 10px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: on ? '1.5px solid var(--brand)' : '1.5px solid var(--hairline)', background: on ? 'rgba(var(--brand-rgb), 0.08)' : 'transparent', color: on ? 'var(--brand)' : 'var(--text)' }}>{children}</button>;
}

const card = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: 14, marginBottom: 10 };
const tdR = { padding: '7px 8px', verticalAlign: 'top' };
const input = { width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', background: 'var(--card)', color: 'var(--text)' };
const primary = { padding: '9px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const mini = { padding: '7px 12px', background: 'rgba(128,128,128,0.10)', color: 'var(--text)', border: '1px solid var(--hairline)', borderRadius: 980, fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const hintLbl = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', margin: '0 0 5px' };
const hintS = { fontSize: 11, color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 };
