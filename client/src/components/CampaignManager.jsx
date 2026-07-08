import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';
import { viaBadge, viaChipStyle } from '../lib/createdVia.js';
import UploadHint from './UploadHint.jsx';
import { languageList } from '../lib/language.js';
import EmailBuilder, { ThemePicker } from './EmailBuilder.jsx';
import JourneyTree, { countDecisions as journeyDecisions } from './JourneyTree.jsx';

// Format a money amount in the campaign's currency (ZAR → "R1,234.00").
const money = (cur, n) => `${cur === 'ZAR' || !cur ? 'R' : `${cur} `}${Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Action Engine v1 — email campaigns (e.g. abandoned cart). The lifecycle IS
// the product: draft (AI-written, editable) → preview audience + email →
// APPROVE (explicit, shows the count) → running → done with results.
// One component for both surfaces (admin + client self-service) — the server
// enforces entity access on every call.
export default function CampaignManager({ entityId, scope = 'admin', initialGoal = '', initialType = '', initialActionId = '', initialDashboardId = '', initialSuiteId = '', initialSegmentName = '' }) {
  const isAdmin = scope === 'admin';
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null); // action object | 'new'
  const [tpl, setTpl] = useState(null); // template chosen for a new campaign
  const [templates, setTemplates] = useState([]);
  const [reporting, setReporting] = useState(null); // action object
  const [masterReport, setMasterReport] = useState(null); // master campaign name
  const [journey, setJourney] = useState(null); // sequence action for the journey funnel
  const [presetMaster, setPresetMaster] = useState(''); // pre-fill master on a new campaign
  const [masters, setMasters] = useState([]);
  // Master name → expanded? (collapsed by default). Persisted per entity so the
  // expand/collapse choice survives reloads.
  const mastersKey = `pulse.openMasters.${entityId}`;
  const [openMasters, setOpenMasters] = useState(() => {
    try { return JSON.parse(localStorage.getItem(mastersKey) || '{}'); } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem(mastersKey, JSON.stringify(openMasters)); } catch { /* private mode / quota */ }
  }, [openMasters, mastersKey]);
  const [channelFilter, setChannelFilter] = useState('all'); // all | email | sms | both
  const [stateFilter, setStateFilter] = useState('all'); // all | draft | pending | scheduled | sent | automated
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  useEffect(() => { api.getActionTemplates(entityId).then((r) => setTemplates(r.templates || [])).catch(() => setTemplates([])).finally(() => setTemplatesLoaded(true)); }, [entityId]);
  const loadMasters = () => api.getMasters(entityId).then((r) => setMasters(r.masters || [])).catch(() => setMasters([]));
  useEffect(() => { loadMasters(); }, [entityId]); // eslint-disable-line react-hooks/exhaustive-deps
  // "Make it happen": arriving with a goal (from a briefing/digest suggestion)
  // opens a fresh campaign — pre-filled from the matching template if ?type names
  // one. We wait until the templates have loaded (so the recipe's resolved audience
  // is present — opening earlier would mount the editor with an empty source), and
  // when the suggestion named a dashboard/event we re-resolve the recipe scoped to
  // THAT tile/event so a multi-event client pre-fills the right audience.
  const [prefilled, setPrefilled] = useState(false);
  useEffect(() => {
    if (prefilled || (!initialGoal && !initialType) || !templatesLoaded) return;
    let cancelled = false;
    (async () => {
      let pool = templates;
      // Scope the recipe to the suggestion's event whenever we know it — a suite
      // alone is enough (a suggestion can carry an event without a dashboard), so
      // the audience never falls through to another event's abandoned-cart tile.
      if (initialType && (initialDashboardId || initialSuiteId)) {
        try {
          const r = await api.getActionTemplates(entityId, { dashboard: initialDashboardId, suite: initialSuiteId });
          if (r.templates) pool = r.templates;
        } catch { /* fall back to the unscoped templates */ }
      }
      if (cancelled) return;
      const t = pool.find((x) => x.key === initialType || x.capability === initialType);
      setTpl(t || null); setEditing('new'); setPrefilled(true);
    })();
    return () => { cancelled = true; };
  }, [initialGoal, initialType, initialDashboardId, initialSuiteId, templatesLoaded, templates, entityId, prefilled]);

  const load = () => api.listActions(entityId).then(setData).catch(() => setData({ actions: [] }));
  useEffect(() => { load(); }, [entityId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Deep link from an approval notification (?action=<id>) opens that campaign
  // for review — settings, email preview, and approve/reject in one place.
  const [deepLinked, setDeepLinked] = useState(false);
  useEffect(() => {
    if (deepLinked || !initialActionId || !data?.actions) return;
    const a = data.actions.find((x) => x.id === initialActionId);
    if (a) { setEditing(a); setDeepLinked(true); }
  }, [initialActionId, data, deepLinked]);
  const startTemplate = (t) => { setTpl(t); setPresetMaster(''); setEditing('new'); };
  const startBlank = () => { setTpl(null); setPresetMaster(''); setEditing('new'); };

  // Poll while anything is running so results tick up live.
  useEffect(() => {
    if (!data?.actions?.some((a) => a.status === 'running')) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(data?.actions?.map((a) => a.status))]);

  if (!data) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p>;

  // Existing master-campaign names (for the editor's autocomplete).
  const masterNames = [...new Set((data.actions || []).map((a) => a.config?.master).filter(Boolean))].sort();

  if (editing) {
    return <CampaignEditor entityId={entityId} isAdmin={isAdmin} action={editing === 'new' ? null : editing} initialGoal={editing === 'new' ? initialGoal : ''}
      initialSuiteId={editing === 'new' ? initialSuiteId : ''} initialSegmentName={editing === 'new' ? initialSegmentName : ''}
      initialTemplate={editing === 'new' ? tpl : null} initialMaster={editing === 'new' ? presetMaster : ''} masterNames={masterNames}
      requireApproval={!!data.requireApproval} approverCandidates={data.approverCandidates || []} howlerCandidates={data.howlerCandidates || []}
      onClose={() => { setEditing(null); setTpl(null); setPresetMaster(''); }} onSaved={() => { setEditing(null); setTpl(null); setPresetMaster(''); load(); loadMasters(); }} />;
  }
  if (reporting) {
    return <CampaignReport entityId={entityId} action={reporting} onClose={() => setReporting(null)} />;
  }
  if (journey) {
    return <JourneyReport entityId={entityId} action={journey} onClose={() => setJourney(null)} />;
  }
  if (masterReport) {
    return <MasterReport entityId={entityId} name={masterReport}
      master={masters.find((m) => m.name === masterReport)}
      campaigns={data.actions.filter((a) => (a.config?.master || '') === masterReport)}
      onOpen={(a) => { setMasterReport(null); setReporting(a); }}
      onNew={() => { setMasterReport(null); setPresetMaster(masterReport); setTpl(null); setEditing('new'); }}
      onChanged={(newName) => { setMasterReport(newName ?? null); load(); loadMasters(); }}
      onClose={() => setMasterReport(null)} />;
  }

  // One campaign row (shared by grouped + ungrouped rendering).
  const rowFor = (a) => (
    <div key={a.id} style={{ ...card, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>{a.title || a.config.subject || 'Untitled campaign'}</span>
          <ChannelChip channel={a.config?.channel} />
          {a.config?.journey?.nodes?.length > 0 && <span title="Built as a journey with the Owl — the full branching tree lives on the Journeys tab" style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 980, color: '#b45309', background: 'rgba(245,158,11,0.14)' }}>🧭 Journey</span>}
          {a.config?.category && <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 980, color: 'var(--brand)', background: 'rgba(var(--brand-rgb,255,56,92),0.10)' }}>{a.config.category}</span>}
          {a.config?.source === 'owl-whatsapp' && <span title="Drafted by the Owl from a WhatsApp chat" style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 980, color: '#1d8a4f', background: 'rgba(37,211,102,0.14)' }}>💬 via WhatsApp</span>}
          {viaBadge(a.createdVia) && a.config?.source !== 'owl-whatsapp' && <span title="Where this draft was created" style={viaChipStyle}>{viaBadge(a.createdVia).icon} via {viaBadge(a.createdVia).label}</span>}
          <StatusChip status={a.status} />
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
          {a.config?.campaignMode === 'sequence'
            ? `Sequence · ${(a.config.steps || []).length} step${(a.config.steps || []).length === 1 ? '' : 's'}${a.status === 'auto' ? ' · running automatically' : ''}${a.results?.codesEmpty ? ' · ⚠ codes exhausted — sign-ups paused' : ''}`
            : a.status === 'auto'
            ? `Automation active · checks daily${a.lastCheck ? ` · last check ${fmt(a.lastCheck)}` : ''}`
            : a.status === 'draft'
            ? (a.createdBy === 'automation' ? `⏳ Queued by automation · awaiting approval · ${fmt(a.createdAt)}` : `Draft · created ${fmt(a.createdAt)} by ${a.createdBy}`)
            : `Approved by ${a.approvedBy} · ${fmt(a.approvedAt)}`}
        </div>
        {a.config?.campaignMode === 'sequence' && a.status === 'auto' ? (
          <div style={{ display: 'flex', gap: 14, marginTop: 6, fontSize: 12.5, fontWeight: 600, flexWrap: 'wrap' }}>
            <span>👥 {a.results?.enrolled ?? 0} enrolled</span>
            <span>📤 {a.results?.sent ?? 0} sent</span>
            <span style={{ color: 'var(--success,#10b981)' }}>✓ {a.results?.converted ?? 0} converted</span>
            {a.promoCodes && <span style={{ color: 'var(--muted)' }}>🎟 {a.promoCodes.available}/{a.promoCodes.total} codes left</span>}
          </div>
        ) : a.status !== 'draft' && (
          <div style={{ display: 'flex', gap: 14, marginTop: 6, fontSize: 12.5, fontWeight: 600, flexWrap: 'wrap' }}>
            <span>📤 {a.results.sent ?? 0}/{a.results.total ?? a.audienceCount} sent</span>
            {(a.results.failed ?? 0) > 0 && <span style={{ color: 'var(--error,#ef4444)' }}>✗ {a.results.failed} failed</span>}
            {typeof a.openRate === 'number' && <span style={{ color: '#0a66c2' }}>📬 {a.openRate}% email open</span>}
            <span>🔗 {a.results.clicks ?? 0} clicks</span>
            {a.results.sent > 0 && <span style={{ color: 'var(--muted)' }}>{Math.round(((a.results.clicks || 0) / a.results.sent) * 100)}% CTR</span>}
            {(a.results.converted ?? 0) > 0 && <span style={{ color: 'var(--success,#10b981)' }}>✓ {a.results.converted} converted</span>}
          </div>
        )}
        {a.status === 'pending' && a.approval && (
          <div style={{ fontSize: 12, color: '#b45309', marginTop: 4 }}>
            {a.approval.approvers.filter((x) => x.approved).length}/{a.approval.approvers.length} approved · waiting on {a.approval.approvers.filter((x) => !x.approved).map((x) => x.label).join(', ') || '—'}
          </div>
        )}
        {a.status === 'scheduled' && a.config?.scheduledAt && (
          <div style={{ fontSize: 12, color: '#0a66c2', marginTop: 4 }}>🕒 Sends {new Date(a.config.scheduledAt).toLocaleString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
        )}
        {a.results?.lastError && a.status !== 'done' && <div style={{ fontSize: 11, color: 'var(--error,#ef4444)', marginTop: 3 }}>{a.results.lastError}</div>}
      </div>
      {(() => {
        // One primary action + a ⋯ overflow menu, to keep rows tidy.
        const sent = ['done', 'running', 'failed'].includes(a.status);
        const editable = ['draft', 'auto', 'pending', 'scheduled'].includes(a.status);
        const primary = sent
          ? { label: '📊 Report', onClick: () => setReporting(a) }
          : editable
            ? { label: a.createdBy === 'automation' || a.status === 'pending' ? 'Review' : a.status === 'scheduled' ? 'Reschedule' : 'Edit', onClick: () => setEditing(a) }
            : null;
        const items = [];
        if (a.config?.campaignMode === 'sequence' && a.status === 'auto') items.push({ label: '🪜 Journey', onClick: () => setJourney(a) });
        if (a.status === 'auto') items.push({ label: '⏸ Pause', onClick: () => api.pauseAction(entityId, a.id).then(load) });
        if (a.status === 'scheduled') items.push({ label: '✖ Cancel schedule', onClick: () => { if (confirm('Cancel the scheduled send? It moves back to draft.')) api.pauseAction(entityId, a.id).then(load); } });
        if (a.status === 'running') items.push({ label: '⛔ Stop sending', danger: true, onClick: () => { if (confirm('Stop this send now? It halts within a few seconds — already-sent emails can’t be recalled.')) api.pauseAction(entityId, a.id).then(load); } });
        items.push({ label: '⧉ Duplicate', onClick: () => api.duplicateAction(entityId, a.id).then((r) => { load(); setEditing(r.action); }).catch((e) => alert(e.message)) });
        if (a.status !== 'running') items.push({ label: '🗑 Delete', danger: true, onClick: () => { if (confirm('Delete this campaign?')) api.deleteAction(entityId, a.id).then(load); } });
        return (
          <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
            {primary && <button style={mini} onClick={primary.onClick}>{primary.label}</button>}
            <RowMenu items={items} />
          </div>
        );
      })()}
    </div>
  );
  // Filter pills: narrow by channel and by lifecycle state. 'sent' buckets
  // running + done (anything that has actually gone out); 'automated' = the
  // recurring 'auto' status.
  const stateBucket = (a) => (
    a.status === 'running' || a.status === 'done' ? 'sent'
      : a.status === 'auto' ? 'automated'
      : a.status === 'failed' ? 'sent'
      : a.status // draft | pending | scheduled
  );
  const matchesFilters = (a) => {
    if (channelFilter !== 'all' && (a.config?.channel || 'email') !== channelFilter) return false;
    if (stateFilter !== 'all' && stateBucket(a) !== stateFilter) return false;
    return true;
  };
  const filteredActions = data.actions.filter(matchesFilters);
  // Counts per pill value (computed off the un-filtered list so labels stay stable).
  const countBy = (pred) => data.actions.filter(pred).length;
  const channelPills = [
    { value: 'all', label: 'All channels' },
    { value: 'email', label: '✉️ Email', n: countBy((a) => (a.config?.channel || 'email') === 'email') },
    { value: 'sms', label: '💬 SMS', n: countBy((a) => a.config?.channel === 'sms') },
    { value: 'both', label: 'Email & SMS', n: countBy((a) => a.config?.channel === 'both') },
  ].filter((p) => p.value === 'all' || p.n > 0); // hide channels with no campaigns
  const statePills = [
    { value: 'all', label: 'All' },
    { value: 'draft', label: 'Drafts', n: countBy((a) => stateBucket(a) === 'draft') },
    { value: 'pending', label: 'Pending', n: countBy((a) => stateBucket(a) === 'pending') },
    { value: 'scheduled', label: 'Scheduled', n: countBy((a) => stateBucket(a) === 'scheduled') },
    { value: 'sent', label: 'Sent', n: countBy((a) => stateBucket(a) === 'sent') },
    { value: 'automated', label: 'Automated', n: countBy((a) => stateBucket(a) === 'automated') },
  ].filter((p) => p.value === 'all' || p.n > 0); // hide states with no campaigns

  // Group campaigns by master campaign (ungrouped last). Each group shows
  // combined stats so a master reports at a glance.
  const groups = (() => {
    const m = new Map();
    for (const a of filteredActions) { const k = a.config?.master || ''; if (!m.has(k)) m.set(k, []); m.get(k).push(a); }
    const named = [...m.entries()].filter(([k]) => k).sort((a, b) => a[0].localeCompare(b[0]));
    const ungrouped = m.get('') || [];
    return { named, ungrouped };
  })();
  const agg = (list) => list.reduce((s, a) => ({
    sent: s.sent + (a.results?.sent || 0), converted: s.converted + (a.results?.converted || 0),
    clicks: s.clicks + (a.results?.clicks || 0), enrolled: s.enrolled + (a.results?.enrolled || 0),
  }), { sent: 0, converted: 0, clicks: 0, enrolled: 0 });

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>Data-driven campaigns — e.g. nudge abandoned-cart customers. Nothing sends without an explicit approval.</p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--muted)', cursor: 'pointer' }} title="When on, campaigns must be approved before they send">
            <input type="checkbox" checked={!!data.requireApproval} onChange={async (e) => { try { await api.setApprovalSetting(entityId, e.target.checked); load(); } catch { alert('Only an account owner can change this.'); } }} />
            Require approval
          </label>
          <button style={outline} onClick={startBlank}>+ Blank campaign</button>
        </div>
      </div>
      {/* Start from a template (recipe). Grouped by category. The audience is
          pre-resolved from this client's data; they just finalize. */}
      {templates.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          {Object.entries(templates.reduce((acc, t) => { (acc[t.category] = acc[t.category] || []).push(t); return acc; }, {})).map(([cat, list]) => (
            <div key={cat} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', margin: '0 0 6px' }}>{cat}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
                {list.map((t) => (
                  <button key={t.key} onClick={() => startTemplate(t)} style={tplCard} title={t.ready ? 'Audience found in your data' : 'We couldn’t auto-find the audience — you’ll pick it'}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>{t.label}</span>
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 980, color: t.ready ? '#0a7d33' : '#b45309', background: t.ready ? 'rgba(16,185,129,0.12)' : 'rgba(245,158,11,0.14)' }}>{t.ready ? 'Ready' : 'Needs setup'}</span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 }}>{t.short}</div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {/* Filter popover — collapses channel + state into one quiet control so
          the list stays clean. Shows a count badge when filters are active. */}
      {(channelPills.length > 1 || statePills.length > 1) && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <FilterMenu
            channelPills={channelPills} channelFilter={channelFilter} setChannelFilter={setChannelFilter}
            statePills={statePills} stateFilter={stateFilter} setStateFilter={setStateFilter}
          />
        </div>
      )}
      {data.actions.length === 0 ? (
        <div style={{ ...card, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
          No campaigns yet. Try one: target customers who abandoned checkout and bring them back.
        </div>
      ) : filteredActions.length === 0 ? (
        <div style={{ ...card, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
          No campaigns match these filters. <button style={{ ...mini, marginLeft: 6 }} onClick={() => { setChannelFilter('all'); setStateFilter('all'); }}>Clear filters</button>
        </div>
      ) : (
        <>
          {groups.named.map(([name, list]) => {
            const t = agg(list);
            const mc = masters.find((mm) => mm.name === name); // server rollup (incl. cost)
            const open = !!openMasters[name];
            return (
              <div key={name} style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '0 2px 6px' }}>
                  <button onClick={() => setOpenMasters((s) => ({ ...s, [name]: !s[name] }))} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--text)' }}>
                    <span style={{ width: 12, fontSize: 10, color: 'var(--muted)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
                    <span style={{ fontSize: 13, fontWeight: 800 }}>🗂 {name}</span>
                  </button>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {list.length} campaign{list.length === 1 ? '' : 's'} · {t.sent} sent · {t.clicks} clicks{t.converted ? ` · ${t.converted} converted` : ''}{mc?.stats?.cost > 0 ? ` · ${money(mc.currency, mc.stats.cost)}` : ''}
                  </span>
                  <button style={{ ...mini, padding: '4px 10px' }} onClick={() => setMasterReport(name)}>📊 Report</button>
                </div>
                {open ? (
                  <div style={{ borderLeft: '2px solid var(--hairline)', paddingLeft: 10 }}>{list.map(rowFor)}</div>
                ) : (
                  <button onClick={() => setOpenMasters((s) => ({ ...s, [name]: true }))} style={stackedCard} title="Tap to expand">
                    <span style={{ fontSize: 13, fontWeight: 700 }}>{list.length} campaign{list.length === 1 ? '' : 's'} stacked</span>
                    <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 8 }}>{list.slice(0, 2).map((a) => a.title || a.config?.subject || 'Untitled').join(' · ')}{list.length > 2 ? ` +${list.length - 2}` : ''}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--brand)', fontWeight: 700 }}>Expand ▾</span>
                  </button>
                )}
              </div>
            );
          })}
          {groups.ungrouped.map(rowFor)}
        </>
      )}
    </div>
  );
}

function CampaignEditor({ entityId, isAdmin, action, initialGoal = '', initialSuiteId = '', initialSegmentName = '', initialTemplate = null, initialMaster = '', masterNames = [], requireApproval = false, approverCandidates = [], howlerCandidates = [], onClose, onSaved }) {
  const cfg = action?.config || {};
  const tpl = initialTemplate;           // a resolved template (recipe), when creating from one
  const tp = tpl?.preset || {};          // the template's copy/utm presets
  const ta = tpl?.audience || {};        // the template's pre-resolved audience source
  const [f, setF] = useState(() => ({
    title: action?.title || (tpl ? tpl.label : ''),
    journey: cfg.journey || null, // full branching tree when this campaign was built as a journey
    goal: cfg.goal || tp.goal || initialGoal || 'Re-engage customers who abandoned their ticket checkout and get them to complete the purchase.',
    recurring: action?.recurring || false,
    channel: cfg.channel || 'email', // email | sms
    phoneField: cfg.audience?.phoneField || '',
    audienceMode: cfg.audience?.mode || ta.mode || 'tile',
    segmentId: cfg.audience?.segmentId || '', // when audienceMode = 'segment'
    dashboardId: cfg.audience?.dashboardId || ta.dashboardId || '',
    tileId: cfg.audience?.tileId || ta.tileId || '',
    emailField: cfg.audience?.emailField || ta.emailField || '',
    nameField: cfg.audience?.nameField || ta.nameField || '',
    consentField: cfg.audience?.consentField || ta.consentField || '',
    emailConsentField: cfg.audience?.emailConsentField || cfg.audience?.consentField || ta.emailConsentField || ta.consentField || '',
    smsConsentField: cfg.audience?.smsConsentField || ta.smsConsentField || '',
    ignoreConsent: !!cfg.ignoreConsent,
    ticketField: cfg.audience?.ticketField || ta.ticketField || '',
    pasted: cfg.audience?.pasted || '',
    filters: cfg.audience?.filters || [], // [{field, op:'in'|'between', values:[], min, max}]
    attrDashboardId: cfg.audience?.attrDashboardId || '', // optional 2nd source for targeting fields
    attrTileId: cfg.audience?.attrTileId || '',
    eventSuiteId: cfg.eventSuiteId || ta.eventSuiteId || initialSuiteId || '', // deep links carry the event
    language: cfg.language || '', // per-campaign AI copy language ('' = client default)
    contentMode: cfg.contentMode || 'template',
    heroImage: cfg.heroImage || '',
    customHtml: cfg.customHtml || '',
    blocks: cfg.blocks || [], // block-builder content (contentMode 'blocks')
    theme: cfg.theme || { preset: 'clean' }, // block-builder visual theme (Tier-1 design)
    subject: cfg.subject || tp.subject || '',
    body: cfg.body || tp.body || '',
    smsBody: cfg.smsBody || '', // separate SMS copy when channel = 'both'
    ctaText: cfg.ctaText || tp.ctaText || 'Complete your order',
    ctaUrl: cfg.ctaUrl || '',
    utm: { source: cfg.utm?.source || tp.utm?.source || '', medium: cfg.utm?.medium || tp.utm?.medium || '', campaign: cfg.utm?.campaign || tp.utm?.campaign || '', term: cfg.utm?.term || '', content: cfg.utm?.content || '' },
    // Which recipe this came from — labels & groups the campaign, helps automation.
    templateKey: cfg.templateKey || tpl?.key || '',
    category: cfg.category || tpl?.category || '',
    master: cfg.master || initialMaster || '', // master-campaign group name (links segments)
    approvers: cfg.approvers || [], // required sign-off [{type,userId,email,name}]
    // Delivery: once-off (single send) or a full automated sequence (drip).
    campaignMode: cfg.campaignMode || 'once',
    anchorField: cfg.audience?.anchorField || '',
    // Drip timing: 'abandonment' = time each step from the abandonment timestamp
    // and only enrol FRESH abandoners; 'send' = run the drip forward from when the
    // person is enrolled (good for an old list). '' = legacy (anchor if mapped, all).
    dripStart: cfg.dripStart || 'abandonment',
    freshHours: cfg.freshHours || 48, // freshness window for 'abandonment' mode
    // Sequence steps. Seed step 1 from the template/campaign copy so it's pre-filled.
    steps: (cfg.steps && cfg.steps.length) ? cfg.steps : [{ delayHours: 2, subject: cfg.subject || tp.subject || '', body: cfg.body || tp.body || '', ctaText: cfg.ctaText || tp.ctaText || '' }],
    // Promo / discount code.
    promo: {
      source: cfg.promo?.source || 'none',
      type: cfg.promo?.type || 'promo',
      code: cfg.promo?.code || '',
      benefit: cfg.promo?.benefit || '',
      appendToLink: cfg.promo?.appendToLink !== false,
    },
    // Conversion tracking: 'dropout' (left the audience) or 'list' (appears in a
    // separate attendance/orders source). The source reuses the audience picker.
    conversionMode: cfg.conversion?.mode || 'dropout',
    convSourceMode: cfg.conversion?.source?.mode === 'segment' ? 'segment' : 'tile',
    convSegmentId: cfg.conversion?.source?.segmentId || '',
    convDashboardId: cfg.conversion?.source?.dashboardId || '',
    convTileId: cfg.conversion?.source?.tileId || '',
  }));
  // Uploaded unique codes (textarea). Existing pool stats come from the action.
  const [promoCodesText, setPromoCodesText] = useState('');
  const poolStats = action?.promoCodes || null;
  const isMobile = useIsMobile();
  const [events, setEvents] = useState([]);
  useEffect(() => { api.listCampaignEvents(entityId).then((r) => setEvents(r.events || [])).catch(() => {}); }, [entityId]);
  // Saved email templates — apply one as a starting point, or save current content.
  const [templates, setTemplates] = useState([]);
  const loadTemplates = () => api.listCampaignTemplates(entityId).then((r) => setTemplates(r.templates || [])).catch(() => {});
  useEffect(() => { loadTemplates(); }, [entityId]); // eslint-disable-line react-hooks/exhaustive-deps
  const applyTemplate = (id) => {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setF((s) => ({ ...s, contentMode: t.contentMode || 'template', subject: t.subject || s.subject, body: t.body || s.body, customHtml: t.customHtml || s.customHtml, blocks: (t.blocks && t.blocks.length) ? t.blocks : s.blocks, theme: (t.theme && t.theme.preset) ? t.theme : s.theme, heroImage: t.heroImage || s.heroImage, ctaText: t.ctaText || s.ctaText }));
  };
  const saveAsTemplate = async () => {
    const name = (window.prompt('Save this email as a template — name it:') || '').trim();
    if (!name) return;
    try { await api.createCampaignTemplate(entityId, { name, subject: f.subject, contentMode: f.contentMode, body: f.body, customHtml: f.customHtml, blocks: f.blocks, theme: f.theme, heroImage: f.heroImage, ctaText: f.ctaText }); await loadTemplates(); alert('Saved to Templates ✓'); }
    catch (e) { alert('Could not save template: ' + e.message); }
  };
  // Auto-select the event when there's exactly one and none is chosen yet — so
  // "Event (optional)" isn't left blank on a single-event client.
  useEffect(() => {
    if (events.length === 1 && !f.eventSuiteId) set('eventSuiteId', events[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);
  // Default the call-to-action link from the selected event's ticket/checkout
  // URL — but only when the CTA is still blank (never clobber a typed link).
  useEffect(() => {
    if (!f.eventSuiteId) return;
    const ev = events.find((e) => e.id === f.eventSuiteId);
    if (ev?.url && !f.ctaUrl) set('ctaUrl', ev.url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.eventSuiteId, events]);
  const [tiles, setTiles] = useState(null);
  const [segments, setSegments] = useState([]); // saved segments to pick as an audience
  const [aud, setAud] = useState(null); // { count, excluded, sample, fields }
  const [audBusy, setAudBusy] = useState(false);
  const [rates, setRates] = useState(null); // per-channel rate card → estimated cost before send
  useEffect(() => { api.getMyBilling(entityId).then(setRates).catch(() => setRates(null)); }, [entityId]);
  const [preview, setPreview] = useState('');
  const [previewAll, setPreviewAll] = useState(false); // sequence: render every step
  const [activeStep, setActiveStep] = useState(0); // sequence: which step the single preview shows
  const [previewSms, setPreviewSms] = useState(''); // rendered SMS text (channel = sms)
  const [stepPreviews, setStepPreviews] = useState([]); // [{label, html|sms}]
  const [drafting, setDrafting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testState, setTestState] = useState('');
  const [approveState, setApproveState] = useState('');
  const debounce = useRef(null);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  useEffect(() => { (isAdmin ? api.getDigestTiles(entityId) : api.getMyDigestTiles(entityId)).then(setTiles).catch(() => setTiles({ dashboards: [] })); }, [entityId, isAdmin]);
  useEffect(() => { api.listSegments(entityId).then((r) => setSegments(r.segments || [])).catch(() => setSegments([])); }, [entityId]);
  // A goal-gap launch names a saved segment (free text from the plan) — once the
  // segments load, match it by name and pre-select it as the audience. New campaigns
  // only (never rewires an existing one), and only until the user picks something.
  const segPrefilled = useRef(false);
  useEffect(() => {
    if (segPrefilled.current || !initialSegmentName || action || !segments.length) return;
    const lc = initialSegmentName.trim().toLowerCase();
    const seg = segments.find((sg) => sg.name.toLowerCase() === lc)
      || segments.find((sg) => sg.name.toLowerCase().includes(lc) || lc.includes(sg.name.toLowerCase()));
    if (seg) { segPrefilled.current = true; setF((s) => ({ ...s, audienceMode: 'segment', segmentId: seg.id })); }
  }, [segments, initialSegmentName, action]);

  const payload = () => ({
    // In sequence mode the top-level copy mirrors step 1 (drives the preview +
    // keeps the legacy fields coherent); each step's own copy is in `steps`.
    title: f.title, goal: f.goal,
    subject: f.campaignMode === 'sequence' ? (f.steps[0]?.subject || '') : f.subject,
    body: f.campaignMode === 'sequence' ? (f.steps[0]?.body || '') : f.body,
    smsBody: f.smsBody,
    ctaText: f.campaignMode === 'sequence' ? (f.steps[0]?.ctaText || '') : f.ctaText,
    ctaUrl: f.ctaUrl, utm: f.utm, recurring: f.recurring,
    eventSuiteId: f.eventSuiteId, language: f.language, contentMode: f.contentMode, heroImage: f.heroImage, customHtml: f.customHtml, blocks: f.blocks, theme: f.theme,
    templateKey: f.templateKey, category: f.category, master: f.master, approvers: f.approvers,
    channel: f.channel,
    campaignMode: f.campaignMode, steps: f.steps,
    journey: f.journey || undefined, // journey campaigns: keep the full branching tree through editor saves
    dripStart: f.dripStart, freshHours: f.freshHours,
    sample: aud?.sample?.[0] || null, // a real recipient for merge-field previews (ignored on save)
    ignoreConsent: f.ignoreConsent,
    promo: f.promo,
    promoCodes: promoCodesText.split(/[\s,;]+/).map((c) => c.trim()).filter(Boolean),
    audience: { mode: f.audienceMode, segmentId: f.segmentId, dashboardId: f.dashboardId, tileId: f.tileId, emailField: f.emailField, nameField: f.nameField, consentField: f.consentField, emailConsentField: f.emailConsentField, smsConsentField: f.smsConsentField, ticketField: f.ticketField, phoneField: f.phoneField, anchorField: f.anchorField, filters: f.filters, attrDashboardId: f.attrDashboardId, attrTileId: f.attrTileId, pasted: f.pasted },
    conversion: {
      mode: f.conversionMode,
      source: f.conversionMode === 'list'
        ? (f.convSourceMode === 'segment'
          ? { mode: 'segment', segmentId: f.convSegmentId }
          : { mode: 'tile', dashboardId: f.convDashboardId, tileId: f.convTileId })
        : {},
    },
  });
  // Targeting filter helpers.
  const addFilter = () => setF((s) => ({ ...s, filters: [...s.filters, { field: '', op: 'in', values: [], min: '', max: '' }] }));
  const setFilter = (i, patch) => setF((s) => ({ ...s, filters: s.filters.map((fl, j) => (j === i ? { ...fl, ...patch } : fl)) }));
  const removeFilter = (i) => setF((s) => ({ ...s, filters: s.filters.filter((_, j) => j !== i) }));
  // Step helpers (sequence mode).
  const setStep = (i, patch) => setF((s) => ({ ...s, steps: s.steps.map((st, j) => (j === i ? { ...st, ...patch } : st)) }));
  const addStep = (delayHours = 24) => setF((s) => ({ ...s, steps: [...s.steps, { delayHours, subject: '', body: '', smsBody: '', ctaText: s.steps[0]?.ctaText || '', contentMode: 'template', customHtml: '', blocks: [], heroImage: '' }] }));
  const removeStep = (i) => setF((s) => ({ ...s, steps: s.steps.filter((_, j) => j !== i) }));
  const isSequence = f.campaignMode === 'sequence';
  // Columns available to pick the abandonment-time anchor from (tile fields or a list's headers).
  const anchorOptions = (aud?.fields?.length ? aud.fields.map((fl) => ({ value: fl.name, label: fl.label })) : (aud?.columns || []).map((c) => ({ value: c, label: c })));
  const hasEmail = f.channel !== 'sms';   // email or both
  const hasSms = f.channel !== 'email';   // sms or both
  const smsOnly = f.channel === 'sms';
  // Email/SMS are independent toggles; we keep at least one on.
  const toggleChannel = (which) => setF((s) => {
    let e = s.channel !== 'sms'; let m = s.channel !== 'email';
    if (which === 'email') e = !e; else m = !m;
    if (!e && !m) { if (which === 'email') m = true; else e = true; }
    return { ...s, channel: e && m ? 'both' : m ? 'sms' : 'email' };
  });
  // Editor sections behave as an exclusive accordion — opening one collapses the rest.
  const [openSection, setOpenSection] = useState(null);
  const acc = (key) => ({ open: openSection === key, onToggle: () => setOpenSection((s) => (s === key ? null : key)) });
  const isPending = action?.status === 'pending';
  const isScheduled = action?.status === 'scheduled';
  // For Email+SMS campaigns, the two content sub-sections are collapsible — but
  // default OPEN so the separate SMS editor is obviously available (it was easy
  // to miss when collapsed behind a banner).
  const [emailOpen, setEmailOpen] = useState(true);
  const [smsOpen, setSmsOpen] = useState(true);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  // datetime-local value (local time) — prefill from an existing schedule.
  const toLocalInput = (iso) => { try { const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); } catch { return ''; } };
  const [scheduleAt, setScheduleAt] = useState(isScheduled && action?.config?.scheduledAt ? toLocalInput(action.config.scheduledAt) : '');
  const [submitMessage, setSubmitMessage] = useState(''); // optional note when sending for approval
  const [thread, setThread] = useState([]); // campaign comms/approval log
  useEffect(() => {
    if (!action?.id) return;
    api.actionThread(entityId, action.id).then((r) => setThread(r.messages || [])).catch(() => {});
  }, [action?.id, action?.status, entityId]);

  const refreshAudience = () => {
    // Snapshot children (queued by an automation) carry their audience already.
    if (f.audienceMode === 'snapshot') { setAud({ count: action?.audienceCount || 0, excluded: 0, noConsent: 0, sample: [], fields: [] }); return; }
    if (f.audienceMode === 'tile' && (!f.dashboardId || !f.tileId)) { setAud(null); return; }
    if (f.audienceMode === 'segment' && !f.segmentId) { setAud(null); return; }
    setAudBusy(true);
    api.actionAudiencePreview(entityId, payload()).then(setAud).catch((e) => setAud({ error: e.message })).finally(() => setAudBusy(false));
  };
  useEffect(() => { refreshAudience(); }, [f.audienceMode, f.segmentId, f.dashboardId, f.tileId, f.emailField, f.consentField, f.emailConsentField, f.smsConsentField, f.ignoreConsent, f.phoneField, f.channel, f.attrDashboardId, f.attrTileId, f.eventSuiteId, JSON.stringify(f.filters)]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced email preview. For a sequence, preview the step you're editing.
  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      const base = payload();
      const st = isSequence ? (f.steps[activeStep] || f.steps[0]) : null;
      const p = st ? { ...base, subject: st.subject, body: st.body, smsBody: st.smsBody || '', ctaText: st.ctaText, contentMode: st.contentMode || 'template', customHtml: st.customHtml || '', heroImage: st.heroImage || '', blocks: st.blocks || [] } : base;
      api.actionPreviewEmail(entityId, p).then((r) => { setPreview(r.html || ''); setPreviewSms(r.sms || ''); }).catch(() => {});
    }, 350);
    return () => clearTimeout(debounce.current);
  }, [f.subject, f.body, f.smsBody, f.ctaText, f.ctaUrl, f.contentMode, f.customHtml, f.heroImage, JSON.stringify(f.blocks), JSON.stringify(f.theme), f.campaignMode, f.eventSuiteId, activeStep, JSON.stringify(f.steps), JSON.stringify(f.promo), f.anchorField]); // eslint-disable-line react-hooks/exhaustive-deps

  // Preview EVERY step of a sequence together (rendered each with its own copy).
  useEffect(() => {
    if (!previewAll || !isSequence) return;
    let alive = true;
    const base = payload();
    (async () => {
      const out = [];
      for (let i = 0; i < f.steps.length; i++) {
        const st = f.steps[i];
        const p = { ...base, subject: st.subject, body: st.body, smsBody: st.smsBody || '', ctaText: st.ctaText, contentMode: st.contentMode || 'template', customHtml: st.customHtml || '', heroImage: st.heroImage || '' };
        try { const r = await api.actionPreviewEmail(entityId, p); out.push({ label: `Step ${i + 1} · +${st.delayHours % 24 === 0 && st.delayHours >= 24 ? `${st.delayHours / 24}d` : `${st.delayHours}h`}`, html: r.html || '', sms: r.sms || '' }); }
        catch { out.push({ label: `Step ${i + 1}`, html: '', sms: '' }); }
      }
      if (alive) setStepPreviews(out);
    })();
    return () => { alive = false; };
  }, [previewAll, isSequence, JSON.stringify(f.steps), JSON.stringify(f.promo), f.ctaUrl, f.heroImage]); // eslint-disable-line react-hooks/exhaustive-deps

  const draft = async () => {
    setDrafting(true);
    try {
      const d = await api.actionDraftCopy(entityId, { goal: f.goal, audienceCount: aud?.count || 0, eventSuiteId: f.eventSuiteId || '', language: f.language || '' });
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

  // AI-draft a single sequence step (sequences have no top-level copy — each
  // step is written independently). SMS steps only need the body.
  const draftStep = async (i) => {
    setDrafting(true);
    try {
      const d = await api.actionDraftCopy(entityId, { goal: f.goal, audienceCount: aud?.count || 0, language: f.language || '' });
      setStep(i, {
        subject: d.subject || f.steps[i]?.subject || '',
        body: d.body || f.steps[i]?.body || '',
        ctaText: d.ctaText || f.steps[i]?.ctaText || '',
      });
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

  const toggleApprover = (cand) => setF((s) => {
    const has = s.approvers.some((a) => (cand.type === 'howler' ? a.type === 'howler' : a.userId === cand.userId));
    return { ...s, approvers: has ? s.approvers.filter((a) => (cand.type === 'howler' ? a.type !== 'howler' : a.userId !== cand.userId)) : [...s.approvers, cand] };
  });
  async function submitForApproval() {
    if (!f.approvers.length) { alert('Pick at least one approver.'); return; }
    setApproveState('working');
    try {
      let id = action?.id;
      if (id) await api.updateAction(entityId, id, payload());
      else { const r = await api.createAction(entityId, payload()); id = r.action.id; }
      await api.submitAction(entityId, id, { approvers: f.approvers, message: submitMessage });
      setApproveState('✓ Sent for approval');
      setTimeout(onSaved, 900);
    } catch (e) { setApproveState(`✗ ${e.message}`); }
  }

  async function scheduleSend() {
    if (!scheduleAt) { alert('Pick a date & time to send.'); return; }
    setApproveState('working');
    try {
      let id = action?.id;
      if (id) await api.updateAction(entityId, id, payload());
      else { const r = await api.createAction(entityId, payload()); id = r.action.id; }
      await api.scheduleAction(entityId, id, new Date(scheduleAt).toISOString());
      setApproveState('✓ Scheduled');
      setTimeout(onSaved, 900);
    } catch (e) { setApproveState(`✗ ${e.message}`); }
  }
  async function cancelSchedule() {
    setApproveState('working');
    try { await api.scheduleAction(entityId, action.id, ''); setApproveState('✓ Schedule cancelled'); setTimeout(onSaved, 800); }
    catch (e) { setApproveState(`✗ ${e.message}`); }
  }

  // Approver acting on a pending campaign (opened via the notification link).
  async function approvePending() {
    setApproveState('working');
    try {
      const r = await api.approveAction(entityId, action.id);
      setApproveState(r.pending ? `✓ Approved — ${r.remaining} more approval(s) needed` : '✓ Approved — sending');
      setTimeout(onSaved, 1000);
    } catch (e) { setApproveState(`✗ ${e.message}`); }
  }
  async function rejectPending() {
    setApproveState('working');
    try {
      await api.rejectAction(entityId, action.id, rejectNote);
      setApproveState('✓ Sent back to draft');
      setTimeout(onSaved, 900);
    } catch (e) { setApproveState(`✗ ${e.message}`); }
  }

  async function approve() {
    if (isSequence) {
      const steps = f.steps || [];
      if (!steps[0]?.subject || !steps[0]?.body) { alert('Add at least step 1 with a subject and body.'); return; }
      const n = steps.length;
      if (!confirm(`Activate this ${n}-step sequence?\n\nEvery new abandoner is enrolled automatically and emailed on your schedule. Anyone who buys (or unsubscribes) stops getting emails. You approve this ONCE — it then runs hands-off.`)) return;
      setApproveState('working');
      try {
        let id = action?.id;
        if (id) await api.updateAction(entityId, id, payload());
        else { const r = await api.createAction(entityId, payload()); id = r.action.id; }
        await api.approveAction(entityId, id);
        setApproveState('✓ Sequence active');
        setTimeout(onSaved, 900);
      } catch (e) { setApproveState(`✗ ${e.message}`); }
      return;
    }
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
  const convDash = tiles?.dashboards?.find((d) => d.dashboardId === f.convDashboardId);

  return (
    <div>
      <button style={{ ...mini, marginBottom: 12 }} onClick={onClose}>← Back to campaigns</button>
      {/* Approver review banner — when this campaign is awaiting approval. */}
      {isPending && (
        <div style={{ border: '1px solid rgba(245,158,11,0.45)', background: 'rgba(245,158,11,0.10)', borderRadius: 12, padding: '12px 14px', marginBottom: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#b45309' }}>⏳ This campaign is awaiting approval</div>
          {action.approval && (
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3 }}>
              {action.approval.approvers.filter((x) => x.approved).length}/{action.approval.approvers.length} approved · waiting on {action.approval.approvers.filter((x) => !x.approved).map((x) => x.label).join(', ') || '—'}
            </div>
          )}
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>Review the settings and preview below, then:</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
            <button className="liquid-btn" style={{ ...primary, background: '#15803d' }} onClick={approvePending} disabled={approveState === 'working'}>✓ Approve</button>
            <button style={mini} onClick={() => setRejectOpen((o) => !o)}>Reject…</button>
            {(approveState && approveState !== 'working') && <span style={{ fontSize: 12.5, color: approveState.startsWith('✓') ? 'var(--success,#10b981)' : 'var(--error,#ef4444)' }}>{approveState}</span>}
          </div>
          {rejectOpen && (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <textarea style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} rows={3} value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} placeholder="Comment for the sender — what needs to change before this can be approved…" />
              <div><button className="liquid-btn" style={{ ...primary, background: '#dc2626' }} onClick={rejectPending} disabled={approveState === 'working'}>Send back to draft</button></div>
            </div>
          )}
        </div>
      )}
      {/* Mobile-first: controls + preview stack into one column on phones. */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0,1fr) minmax(0,1fr)', gap: 20, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Accordion title="Setup" {...acc('setup')}>
          <Field label="Campaign name"><input style={input} value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Abandoned cart — Pretoria show" /></Field>

          <Field label="Master campaign (optional · groups & reports segments together)">
            <input style={input} value={f.master} onChange={(e) => set('master', e.target.value)} placeholder="e.g. Bushfire — abandoned cart" list="master-campaign-list" />
            <datalist id="master-campaign-list">{masterNames.map((m) => <option key={m} value={m} />)}</datalist>
            <div style={hintS}>Give related segment campaigns (VIP, GA, by city…) the same master to manage and report on them together.</div>
          </Field>

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

          <Field label="AI copy language (optional)">
            <select style={input} value={f.language} onChange={(e) => set('language', e.target.value)}>
              <option value="">Client default</option>
              {languageList().filter((l) => l.code !== 'en').map((l) => <option key={l.code} value={l.code}>{l.native === l.name ? l.name : `${l.name} — ${l.native}`}</option>)}
              <option value="en">English</option>
            </select>
            <div style={hintS}>Overrides this client's default language for THIS campaign's AI-drafted copy — handy when one audience needs a different language. Re-draft (or draft a step) after changing it. The saved copy is what sends.</div>
          </Field>
          </Accordion>

          <Accordion title="Channel & campaign type" {...acc('channel')}>
          <Field label="Channel (pick one or both)">
            <div style={{ display: 'flex', gap: 8 }}>
              <Toggle on={hasEmail} onClick={() => toggleChannel('email')}>✉️ Email</Toggle>
              <Toggle on={hasSms} onClick={() => toggleChannel('sms')}>💬 SMS</Toggle>
            </div>
            {hasSms && <div style={hintS}>SMS is plain text — no subject; the tracked link + an opt-out link are added automatically. Tokens {'{{name}}'}, {'{{ticketType}}'}, {'{{promo}}'} work.{f.channel === 'both' ? ' Each recipient gets an email AND an SMS — you can write the SMS separately in the Content section.' : ''}</div>}
          </Field>

          <Field label="Campaign type">
            <div style={{ display: 'flex', gap: 8 }}>
              <Toggle on={!isSequence} onClick={() => set('campaignMode', 'once')}>Once-off</Toggle>
              <Toggle on={isSequence} onClick={() => set('campaignMode', 'sequence')}>Full sequence (drip)</Toggle>
            </div>
            <div style={hintS}>{isSequence
              ? 'A series of timed emails that runs automatically per customer — anyone who buys drops out. Approve once.'
              : 'One email to the current audience when you approve.'}</div>
          </Field>
          </Accordion>

          <Accordion title="Audience & targeting" {...acc('audience')}>
          <Field label="Audience">
            {f.audienceMode === 'snapshot' ? (
              <div style={{ fontSize: 13, background: 'rgba(124,58,237,0.07)', border: '1px solid rgba(124,58,237,0.25)', borderRadius: 8, padding: '9px 12px' }}>
                ⚙ Queued by the automation: <b>{action?.audienceCount || 0} new recipient{(action?.audienceCount || 0) === 1 ? '' : 's'}</b> since the last send. Approve to email exactly these people.
              </div>
            ) : (
            <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <Toggle on={f.audienceMode === 'segment'} onClick={() => set('audienceMode', 'segment')}>🎯 Segment</Toggle>
              <Toggle on={f.audienceMode === 'tile'} onClick={() => set('audienceMode', 'tile')}>Dashboard tile</Toggle>
              <Toggle on={f.audienceMode === 'paste'} onClick={() => set('audienceMode', 'paste')}>Paste</Toggle>
            </div>
            {f.audienceMode === 'segment' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <select style={input} value={f.segmentId} onChange={(e) => set('segmentId', e.target.value)}>
                  <option value="">Pick a saved segment…</option>
                  {/* If the campaign references a segment that's since been deleted,
                      keep a placeholder option so the picker isn't silently blank. */}
                  {f.segmentId && !segments.some((sg) => sg.id === f.segmentId) && <option value={f.segmentId}>⚠ Deleted segment</option>}
                  {segments.map((sg) => <option key={sg.id} value={sg.id}>{sg.name}{sg.count >= 0 ? ` (${sg.count})` : ''}</option>)}
                </select>
                {aud?.segmentMissing && <div style={{ fontSize: 12, color: '#b45309', fontWeight: 600 }}>⚠ This segment no longer exists — pick another, or recreate it in Segments. The campaign can't send until it resolves to people.</div>}
                <div style={hintS}>Always-live — the campaign sends to whoever's in the segment at send time. {segments.length === 0 ? 'No segments yet — create one in Segments.' : 'Manage segments in the Segments area.'}</div>
              </div>
            ) : f.audienceMode === 'tile' ? (
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
                    {hasSms && (
                      <select style={input} value={f.phoneField} onChange={(e) => set('phoneField', e.target.value)}>
                        <option value="">Mobile-number column (required for SMS)</option>
                        {aud.fields.map((fl) => <option key={fl.name} value={fl.name}>{fl.label}</option>)}
                      </select>
                    )}
                    {hasEmail && (
                      <select style={input} value={f.ignoreConsent ? '' : f.emailConsentField} disabled={f.ignoreConsent} onChange={(e) => set('emailConsentField', e.target.value)}>
                        <option value="">Email consent column — recommended (email only when = Yes)</option>
                        {aud.fields.map((fl) => <option key={fl.name} value={fl.name}>Email only if “{fl.label}” = Yes</option>)}
                      </select>
                    )}
                    {hasSms && (
                      <select style={input} value={f.ignoreConsent ? '' : f.smsConsentField} disabled={f.ignoreConsent} onChange={(e) => set('smsConsentField', e.target.value)}>
                        <option value="">SMS consent column — recommended (SMS only when = Yes)</option>
                        {aud.fields.map((fl) => <option key={fl.name} value={fl.name}>SMS only if “{fl.label}” = Yes</option>)}
                      </select>
                    )}
                    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', border: '1px solid var(--hairline)', borderRadius: 9, background: f.ignoreConsent ? 'rgba(245,158,11,0.10)' : 'transparent', cursor: 'pointer' }}>
                      <input type="checkbox" checked={!!f.ignoreConsent} onChange={(e) => set('ignoreConsent', e.target.checked)} style={{ marginTop: 2 }} />
                      <span>
                        <span style={{ fontWeight: 700, fontSize: 13 }}>Transactional / operational — ignore marketing consent</span>
                        <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>Sends to everyone with a valid {smsOnly ? 'number' : hasSms ? 'email/number' : 'email'}, bypassing the consent columns. Only for genuinely non-marketing messages (event info, settlement notices).</span>
                      </span>
                    </label>
                    {isSequence && (
                      <select style={input} value={f.anchorField} onChange={(e) => set('anchorField', e.target.value)}>
                        <option value="">Abandonment time column — drip timings count from this (else from detection)</option>
                        {aud.fields.map((fl) => <option key={fl.name} value={fl.name}>Count from “{fl.label}”</option>)}
                      </select>
                    )}
                  </>
                )}
                {aud?.fields?.length > 0 && (
                  <AudienceFilters entityId={entityId} eventSuiteId={f.eventSuiteId}
                    fields={(aud.filterFields && aud.filterFields.length) ? aud.filterFields : aud.fields.map((fl) => ({ ...fl, dashboardId: f.dashboardId, tileId: f.tileId }))}
                    filters={f.filters} addFilter={addFilter} setFilter={setFilter} removeFilter={removeFilter}
                    attr={{ dashboardId: f.attrDashboardId, tileId: f.attrTileId }}
                    tiles={tiles} onAttr={(dashboardId, tileId) => { set('attrDashboardId', dashboardId); set('attrTileId', tileId); }} />
                )}
              </div>
            ) : (
              <>
                <textarea style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} rows={3} value={f.pasted} onChange={(e) => set('pasted', e.target.value)} placeholder={hasSms ? 'one@example.com, +27821234567, two@example.com …' : 'one@example.com, two@example.com …'} onBlur={refreshAudience} />
                <div style={hintS}>{hasSms ? 'Paste emails and/or mobile numbers (any separator). Numbers get the SMS, emails get the email.' : 'Paste email addresses, separated by spaces, commas or new lines.'}</div>
              </>
            )}
            <div style={{ marginTop: 8, fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {audBusy ? <span style={{ color: 'var(--muted)' }}>Counting audience…</span>
                : aud?.error ? <span style={{ color: 'var(--error,#ef4444)' }}>✗ {aud.error}</span>
                : aud ? (
                  <span>
                    <b style={{ color: 'var(--brand)' }}>{aud.count}</b> recipient{aud.count === 1 ? '' : 's'}
                    {aud.reach && hasEmail && <span style={{ color: 'var(--muted)' }}> · {aud.reach.email} emailable</span>}
                    {aud.reach && hasSms && <span style={{ color: 'var(--muted)' }}> · {aud.reach.sms} SMS</span>}
                    {aud.smsCapped && hasSms && <span style={{ color: 'var(--warn,#d97706)' }} title={`SMS is capped at ${aud.smsCap?.toLocaleString?.() || aud.smsCap} per campaign for this client`}> (SMS capped at {aud.smsCap?.toLocaleString?.() || aud.smsCap})</span>}
                    {(() => {
                      // Estimated cost before send: reach on each active channel × its rate.
                      if (!rates?.rates || !aud.reach) return null;
                      const est = (hasEmail ? (aud.reach.email || 0) * (rates.rates.email || 0) : 0) + (hasSms ? (aud.reach.sms || 0) * (rates.rates.sms || 0) : 0);
                      return est > 0 ? <span style={{ color: 'var(--brand)', fontWeight: 700 }}> · est. {money(rates.currency, est)}</span> : null;
                    })()}
                    {aud.filteredOut > 0 && <span style={{ color: 'var(--muted)' }}> · {aud.filteredOut} filtered out</span>}
                    {!f.ignoreConsent && aud.noConsent > 0 && <span style={{ color: 'var(--muted)' }}> · {aud.noConsent} no consent</span>}
                    {aud.excluded > 0 && <span style={{ color: 'var(--muted)' }}> · {aud.excluded} unsubscribed</span>}
                    {aud.sample?.length > 0 && <span style={{ color: 'var(--muted)' }}> · e.g. {aud.sample.slice(0, 3).map((s) => s.email).join(', ')}</span>}
                  </span>
                ) : <span style={{ color: 'var(--muted)' }}>Pick an audience source to see the count.</span>}
              {/* Re-read the live source NOW (e.g. a linked Google Sheet that's been
                  edited mid-build). The actual send always re-resolves at send time. */}
              {aud && !aud.error && f.audienceMode !== 'snapshot' && (
                <button type="button" style={{ ...mini, padding: '3px 9px' }} onClick={refreshAudience} disabled={audBusy} title="Re-read the live source (e.g. a linked Google Sheet) and recount now">↻ Refresh</button>
              )}
            </div>
            {aud && !aud.error && f.audienceMode !== 'snapshot' && (
              <div style={hintS}>Counts a live snapshot now — the actual send always re-reads the latest at send time.</div>
            )}
            </>
            )}
          </Field>
          </Accordion>

          <Accordion title="Conversion tracking" {...acc('conversion')}>
          <Field label="How do we know someone converted?">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Toggle on={f.conversionMode !== 'list'} onClick={() => set('conversionMode', 'dropout')}>They leave the source list</Toggle>
              <Toggle on={f.conversionMode === 'list'} onClick={() => set('conversionMode', 'list')}>They appear in another list</Toggle>
            </div>
            <div style={hintS}>{f.conversionMode === 'list'
              ? 'Converted = the person shows up in a separate list you pick below (e.g. an attendance or completed-orders list), matched by email. Confirms real conversions instead of inferring them.'
              : `Converted = the person is no longer in the audience above (e.g. they left the abandoned-cart tile because they bought).${isSequence ? ' They drop out of the sequence automatically.' : ''} Works when the audience tile keeps itself up to date.`}</div>
          </Field>
          {f.conversionMode === 'list' && (
            <Field label="Conversion source — the attendance / orders list">
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <Toggle on={f.convSourceMode === 'segment'} onClick={() => set('convSourceMode', 'segment')}>🎯 Segment</Toggle>
                <Toggle on={f.convSourceMode !== 'segment'} onClick={() => set('convSourceMode', 'tile')}>Dashboard tile</Toggle>
              </div>
              {f.convSourceMode === 'segment' ? (
                <select style={input} value={f.convSegmentId} onChange={(e) => set('convSegmentId', e.target.value)}>
                  <option value="">Pick a saved segment…</option>
                  {f.convSegmentId && !segments.some((sg) => sg.id === f.convSegmentId) && <option value={f.convSegmentId}>⚠ Deleted segment</option>}
                  {segments.map((sg) => <option key={sg.id} value={sg.id}>{sg.name}{sg.count >= 0 ? ` (${sg.count})` : ''}</option>)}
                </select>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <select style={input} value={f.convDashboardId} onChange={(e) => { set('convDashboardId', e.target.value); set('convTileId', ''); }}>
                    <option value="">Pick a dashboard…</option>
                    {(tiles?.dashboards || []).map((d) => <option key={d.dashboardId} value={d.dashboardId}>{d.title} — {d.setName}</option>)}
                  </select>
                  {convDash && (
                    <select style={input} value={f.convTileId} onChange={(e) => set('convTileId', e.target.value)}>
                      <option value="">Pick the tile listing who converted…</option>
                      {convDash.tiles.map((t) => <option key={t.tileId} value={t.tileId}>{t.title}</option>)}
                    </select>
                  )}
                </div>
              )}
              <div style={hintS}>Matched by email address (the email column is auto-detected). Anyone in this list who's also in your audience counts as converted{isSequence ? ' and stops getting the drip' : ''}. The list is re-read automatically as it fills up.</div>
            </Field>
          )}
          </Accordion>

          <Accordion title={smsOnly ? 'Message & offer' : 'Content & offer'} {...acc('content')}>
          {/* Merge fields available from the audience — personalise the copy. */}
          {(anchorOptions.length > 0) && (
            <div style={{ ...hintS, marginBottom: 8 }}>
              Merge fields: <code>{'{{name}}'}</code>, <code>{'{{promo}}'}</code>{anchorOptions.slice(0, 8).map((o) => <span key={o.value}> · <code>{`{{${o.label}}}`}</code></span>)}. Insert any into the subject/body; blank if missing.
            </div>
          )}
          {/* Sequence steps — SMS-only steps are just delay + text. */}
          {isSequence && (
            <Field label="Drip timing">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Toggle on={f.dripStart !== 'send'} onClick={() => set('dripStart', 'abandonment')}>From abandonment · fresh only</Toggle>
                <Toggle on={f.dripStart === 'send'} onClick={() => set('dripStart', 'send')}>Forward from send · whole list</Toggle>
              </div>
              {f.dripStart !== 'send' ? (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <select style={input} value={f.anchorField} onChange={(e) => set('anchorField', e.target.value)}>
                    <option value="">Abandonment-time column (else uses enrolment time)</option>
                    {anchorOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={hintS}>Only enrol people who abandoned within</span>
                    <input type="number" min="1" style={{ ...input, width: 90 }} value={f.freshHours} onChange={(e) => set('freshHours', Number(e.target.value) || 48)} />
                    <span style={hintS}>hours</span>
                  </div>
                  <div style={hintS}>Each step is timed from the person’s abandonment moment; anyone older than the window isn’t enrolled. Real-time abandoned-cart mode.</div>
                </div>
              ) : (
                <div style={hintS}>Ignores when they abandoned — the drip runs forward from when each person is enrolled (step 1 now, then your delays: 2h, 4h…). Use this for an existing/old list.</div>
              )}
            </Field>
          )}

          {isSequence && f.journey?.nodes?.length > 0 && (
            <Field label="🧭 Journey design (the full branching tree)">
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
                Built with the Owl{journeyDecisions(f.journey.nodes) > 0 ? ` · ◆ ${journeyDecisions(f.journey.nodes)} decision point${journeyDecisions(f.journey.nodes) === 1 ? '' : 's'}` : ''}. The steps below are the opening sequence this campaign sends today; the branches route people once the journey engine ships. To change the design, ask the Owl (it appears on the Journeys tab too).
              </div>
              <JourneyTree nodes={f.journey.nodes} />
            </Field>
          )}

          {isSequence && (
            <Field label={smsOnly ? 'Texts in the sequence' : f.channel === 'both' ? 'Emails & texts in the sequence' : 'Emails in the sequence'}>
              <SequenceSteps steps={f.steps} setStep={setStep} addStep={addStep} removeStep={removeStep} activeStep={activeStep} onActive={setActiveStep} email={hasEmail} sms={hasSms} onDraft={draftStep} drafting={drafting} anchorLabel={f.dripStart === 'send' ? 'from start of campaign' : 'after abandonment'} />
            </Field>
          )}

          {/* Once-off SMS-only — a single plain-text message. */}
          {!isSequence && smsOnly && (
            <Field label="Message">
              <button type="button" style={{ ...mini, marginBottom: 8 }} onClick={draft} disabled={drafting}>{drafting ? 'Writing…' : '✨ Draft copy with AI'}</button>
              <textarea style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} rows={5} value={f.body} onChange={(e) => set('body', e.target.value)} placeholder={'Hi {{name}}, your {{ticketType}} tickets are still waiting — grab them here:'} />
              <SmsMeter body={f.body} />
              <div style={hintS}>Plain text — no subject. Tokens <b>{'{{name}}'}</b>, <b>{'{{ticketType}}'}</b>, <b>{'{{promo}}'}</b> work. The tracked link and an opt-out link are added automatically (they add to the length).</div>
            </Field>
          )}

          {/* Both channels: collapsible banners make it obvious which content is
              which (collapsed by default). */}
          {!isSequence && f.channel === 'both' && (
            <button type="button" onClick={() => setEmailOpen((v) => !v)} style={{ ...chBanner, background: 'rgba(10,132,255,0.12)', color: '#0a66c2', width: '100%', border: 'none', cursor: 'pointer' }}>
              <span style={{ width: 12, fontSize: 10, transform: emailOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>✉️ Email content
            </button>
          )}
          {/* Once-off email (or email+SMS) — built template or custom HTML. */}
          {!isSequence && hasEmail && (f.channel !== 'both' || emailOpen) && (
          <Field label="Content">
            {f.channel === 'both' && <div style={{ ...hintS, marginTop: 0, marginBottom: 6 }}>This is the email. Edit the SMS separately in the “💬 SMS content” section below (it falls back to this body if you leave it blank).</div>}
            {/* Templates: start from a saved one, or save the current content. */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
              {templates.length > 0 && (
                <select style={{ ...input, flex: '1 1 200px' }} value="" onChange={(e) => { if (e.target.value) applyTemplate(e.target.value); }}>
                  <option value="">📝 Start from a template…</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              )}
              <button type="button" style={mini} onClick={saveAsTemplate} title="Save this email as a reusable template">💾 Save as template</button>
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <Toggle on={f.contentMode === 'template'} onClick={() => set('contentMode', 'template')}>Built template</Toggle>
              <Toggle on={f.contentMode === 'blocks'} onClick={() => set('contentMode', 'blocks')}>🧱 Builder</Toggle>
              <Toggle on={f.contentMode === 'html'} onClick={() => set('contentMode', 'html')}>Custom HTML</Toggle>
            </div>

            {f.contentMode === 'blocks' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input style={{ ...input, fontWeight: 700 }} value={f.subject} onChange={(e) => set('subject', e.target.value)} placeholder="Subject line" />
                <ThemePicker value={f.theme} onChange={(v) => set('theme', v)} />
                <EmailBuilder value={f.blocks} onChange={(v) => set('blocks', v)} entityId={entityId} eventSuiteId={f.eventSuiteId} />
                <div style={hintS}>Stack blocks to build the email — it’s wrapped in the client’s branding (logo, colours, unsubscribe) automatically. Links in buttons/images are tracked; tokens <b>{'{{name}}'}</b>, <b>{'{{ticketType}}'}</b> work in text.</div>
              </div>
            ) : f.contentMode === 'template' ? (
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
          )}

          {/* Both channels, once-off: a SEPARATE SMS message (email copy ≠ SMS copy). */}
          {!isSequence && f.channel === 'both' && (
            <button type="button" onClick={() => setSmsOpen((v) => !v)} style={{ ...chBanner, background: 'rgba(21,128,61,0.12)', color: '#15803d', width: '100%', border: 'none', cursor: 'pointer' }}>
              <span style={{ width: 12, fontSize: 10, transform: smsOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>💬 SMS content
            </button>
          )}
          {!isSequence && f.channel === 'both' && smsOpen && (
            <Field label="SMS message (separate from the email)">
              <textarea style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} rows={4} value={f.smsBody} onChange={(e) => set('smsBody', e.target.value)} placeholder={'Hi {{name}}, your {{ticketType}} tickets are still waiting — grab them here:'} />
              <SmsMeter body={f.smsBody} />
              <div style={hintS}>This text is sent as the SMS. The email above is sent as the email. Tokens <b>{'{{name}}'}</b>, <b>{'{{ticketType}}'}</b>, <b>{'{{promo}}'}</b> work; the tracked link + opt-out are appended automatically.</div>
            </Field>
          )}

          {/* Tracked link — SMS-only and sequences share one buy link. (For an
              email/both once-off, the link lives in the Call-to-action below.) */}
          {(smsOnly || isSequence) && (
            <Field label={smsOnly ? 'Link (tracked · appended to the text)' : 'Buy link (shared by every step · clicks tracked)'}>
              <input style={input} value={f.ctaUrl} onChange={(e) => set('ctaUrl', e.target.value)} placeholder="https://… the checkout/buy URL" />
            </Field>
          )}

          {/* Promo / discount code */}
          <PromoEditor promo={f.promo} setPromo={(p) => set('promo', { ...f.promo, ...p })} poolStats={poolStats} promoCodesText={promoCodesText} setPromoCodesText={setPromoCodesText} />

          {!isSequence && hasEmail && f.contentMode === 'template' && (
            <Field label={f.channel === 'both' ? 'Call to action (the button link is also the SMS link)' : 'Call to action'}>
              <div style={{ display: 'flex', gap: 8 }}>
                <input style={{ ...input, flex: 1 }} value={f.ctaText} onChange={(e) => set('ctaText', e.target.value)} placeholder="Button text" />
                <input style={{ ...input, flex: 2 }} value={f.ctaUrl} onChange={(e) => set('ctaUrl', e.target.value)} placeholder="https://… (clicks are tracked)" />
              </div>
            </Field>
          )}
          {!isSequence && hasEmail && f.contentMode === 'html' && (
            <Field label="Tracked link (for {{cta}})">
              <input style={input} value={f.ctaUrl} onChange={(e) => set('ctaUrl', e.target.value)} placeholder="https://… — clicks on {{cta}} are tracked" />
            </Field>
          )}

          </Accordion>

          {!isSequence && f.audienceMode === 'tile' && (
            <Accordion title="Automation" {...acc('automation')}>
            <Field label="Automation">
              <div style={{ display: 'flex', gap: 8 }}>
                <Toggle on={!f.recurring} onClick={() => set('recurring', false)}>One-off send</Toggle>
                <Toggle on={!!f.recurring} onClick={() => set('recurring', true)}>Daily auto-check</Toggle>
              </div>
              <div style={hintS}>{f.recurring
                ? 'Checks the tile daily; anyone NEW (never emailed by this campaign, not unsubscribed) is queued as a draft for your approval. Nothing sends on its own.'
                : 'Sends once to the current audience when you approve.'}</div>
            </Field>
            </Accordion>
          )}

          <Accordion title="Tracking (UTM)" {...acc('utm')}>
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
                Lands as: {(() => { try { const u = new URL(f.ctaUrl); if (f.promo?.type === 'promo' && f.promo?.appendToLink && f.promo?.code) u.searchParams.set('promo', f.promo.code); const m = { utm_source: f.utm.source, utm_medium: f.utm.medium, utm_campaign: f.utm.campaign, utm_term: f.utm.term, utm_content: f.utm.content }; for (const [k, v] of Object.entries(m)) if (v) u.searchParams.set(k, v); return u.toString(); } catch { return '(enter a full https:// link to preview)'; } })()}
              </div>
            )}
          </Field>
          </Accordion>

          <Accordion title={`Approval${requireApproval ? ' (required for this client)' : ''}`} {...acc('approval')}>
            <div style={hintS}>Pick who must sign off before this sends. Each approver gets an inbox message + notification with a link to approve. {requireApproval ? 'This client requires approval, so a campaign can only send once everyone approves.' : 'Optional — leave empty to send directly, or add approvers to route it.'}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {/* Named approvers: the client's own approvers, then the Howler team
                  members LINKED to this account (a specific AM), then the generic
                  'Howler' slot = any of the account's Howler team. */}
              {[...approverCandidates.map((c) => ({ type: 'user', userId: c.userId, email: c.email, name: c.email, label: c.email })),
                ...howlerCandidates.map((c) => ({ type: 'user', userId: c.userId, email: c.email, name: c.name || c.email, label: `🦉 ${c.name || c.email}${c.howlerRole ? ` · ${c.howlerRole}` : ''}` })),
                { type: 'howler', name: 'Howler', label: `🦉 Howler (any${howlerCandidates.length ? ' of the account team' : ''})` }].map((c) => {
                const on = f.approvers.some((a) => (c.type === 'howler' ? a.type === 'howler' : a.userId === c.userId));
                return (
                  <button key={c.userId || 'howler'} type="button" onClick={() => toggleApprover(c)} title={c.type === 'user' ? c.email : 'Any Howler member on this account can sign this slot'}
                    style={{ fontSize: 12, fontWeight: on ? 700 : 500, padding: '4px 10px', borderRadius: 980, cursor: 'pointer', border: `1px solid ${on ? 'var(--brand)' : 'var(--hairline)'}`, color: on ? 'var(--brand)' : 'var(--text)', background: on ? 'rgba(var(--brand-rgb,255,56,92),0.08)' : 'transparent' }}>
                    {on ? '✓ ' : ''}{c.label}
                  </button>
                );
              })}
              {approverCandidates.length === 0 && howlerCandidates.length === 0 && <span style={{ fontSize: 12, color: 'var(--muted)' }}>No client approvers yet — you can still require Howler.</span>}
            </div>
            <div style={{ marginTop: 12 }}>
              <div style={hintLbl}>Message to approvers (optional)</div>
              <textarea style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} rows={2} value={submitMessage} onChange={(e) => setSubmitMessage(e.target.value)} placeholder="e.g. Please approve by Friday — sending ahead of the weekend push." />
              <div style={hintS}>Included in the approval notification (inbox + email) and kept in the campaign's activity log.</div>
            </div>
          </Accordion>

          {thread.length > 0 && (
            <Accordion title={`Activity & comms (${thread.length})`} {...acc('activity')}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {thread.map((m, i) => (
                  <div key={i} style={{ borderLeft: '2px solid var(--hairline)', paddingLeft: 10 }}>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}><b style={{ color: 'var(--text)' }}>{m.author}</b> · {(() => { try { return new Date(m.at).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } })()}</div>
                    <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', marginTop: 2 }}>{m.body}</div>
                  </div>
                ))}
              </div>
              <div style={hintS}>The full approval conversation for this campaign — submissions, approvals, rejections and comments.</div>
            </Accordion>
          )}

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
            <button style={mini} onClick={saveDraft} disabled={busy}>{busy ? 'Saving…' : 'Save draft'}</button>
            <button
              type="button" style={mini} disabled={testState === 'sending'}
              onClick={async () => {
                let testPhone = '';
                if (hasSms) { testPhone = window.prompt('Send the test SMS to which number?', ''); if (!testPhone) return; }
                setTestState('sending');
                try { const r = await api.actionTestSend(entityId, { ...payload(), testPhone }); setTestState(`✓ Test sent to ${r.to}`); } catch (e) { setTestState(`✗ ${e.message}`); }
              }}
            >{testState === 'sending' ? 'Sending…' : 'Send test to me'}</button>
            {!requireApproval && (
              <button className="liquid-btn" style={{ ...primary, background: '#15803d' }} onClick={approve} disabled={approveState === 'working' || (!f.recurring && !isSequence && !aud?.count)}>
                {approveState === 'working' ? 'Approving…' : isSequence ? '⚡ Activate sequence' : f.recurring ? '⚙ Activate automation' : `Approve & send${aud?.count ? ` to ${aud.count}` : ''}`}
              </button>
            )}
            <button className="liquid-btn" style={{ ...primary, background: requireApproval ? '#15803d' : 'var(--brand)' }} onClick={submitForApproval} disabled={approveState === 'working' || !f.approvers.length}>
              📩 Send for approval
            </button>
            {!requireApproval && !isSequence && !f.recurring && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} style={{ ...input, width: 'auto', padding: '7px 10px' }} />
                <button style={mini} onClick={scheduleSend} disabled={approveState === 'working' || !aud?.count}>🕒 {isScheduled ? 'Reschedule' : 'Schedule'}</button>
                {isScheduled && <button style={{ ...mini, color: 'var(--error,#ef4444)' }} onClick={cancelSchedule}>Cancel schedule</button>}
              </span>
            )}
            {(testState && testState !== 'sending') && <span style={{ fontSize: 12, color: testState.startsWith('✓') ? 'var(--success,#10b981)' : 'var(--error,#ef4444)' }}>{testState}</span>}
            {(approveState && approveState !== 'working') && <span style={{ fontSize: 12, color: approveState.startsWith('✓') ? 'var(--success,#10b981)' : 'var(--error,#ef4444)' }}>{approveState}</span>}
          </div>
        </div>

        {/* Preview follows you as you scroll the (long) form on desktop. */}
        <div style={isMobile ? {} : { position: 'sticky', top: 12, alignSelf: 'start' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <span style={hintLbl}>{hasEmail && hasSms ? 'Email + SMS preview' : smsOnly ? 'SMS preview' : 'Email preview'}</span>
            {isSequence && <button type="button" style={{ ...mini, padding: '4px 9px' }} onClick={() => setPreviewAll((v) => !v)}>{previewAll ? 'Show step 1 only' : 'Preview all steps'}</button>}
          </div>
          {previewAll && isSequence ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '78vh', overflowY: 'auto', paddingRight: 4 }}>
              {stepPreviews.length === 0 ? <div style={{ color: 'var(--muted)', fontSize: 13 }}>Rendering steps…</div>
                : stepPreviews.map((s, i) => (
                  <div key={i}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--brand)', margin: '0 0 4px' }}>{s.label}</div>
                    {hasEmail && <iframe title={s.label} srcDoc={s.html} style={{ width: '100%', height: 460, border: '1px solid var(--hairline)', borderRadius: 12, background: '#fff' }} />}
                    {hasSms && <div style={{ marginTop: hasEmail ? 8 : 0 }}><SmsPreview text={s.sms} /></div>}
                  </div>
                ))}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {hasEmail && <iframe title="Campaign preview" srcDoc={preview} style={{ width: '100%', height: hasSms ? 460 : 560, border: '1px solid var(--hairline)', borderRadius: 12, background: '#fff' }} />}
              {hasSms && <SmsPreview text={previewSms} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Detailed campaign report: summary stats + who clicked, how often, when.
// Journey funnel for a drip sequence: how many received each step, and where
// people convert or drop off. The bar widths are relative to the enrolled total.
function JourneyReport({ entityId, action, onClose }) {
  const [d, setD] = useState(null);
  useEffect(() => { api.actionJourney(entityId, action.id).then(setD).catch(() => setD({ error: true })); }, [entityId, action.id]);
  const unit = (h) => (h % 24 === 0 && h >= 24 ? `${h / 24}d` : `${h}h`);
  return (
    <div>
      <button style={{ ...mini, marginBottom: 12 }} onClick={onClose}>← Back to campaigns</button>
      <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 2 }}>🪜 {action.title || 'Sequence'} — journey</div>
      {!d ? <p style={{ color: 'var(--muted)' }}>Loading…</p> : d.error ? <p style={{ color: 'var(--error,#ef4444)' }}>Couldn’t load.</p> : (
        <>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>
            <b style={{ color: 'var(--text)' }}>{d.enrolled}</b> enrolled · {d.active} still active · <b style={{ color: 'var(--success,#10b981)' }}>{d.converted}</b> converted · {d.done} completed{d.unsubscribed ? ` · ${d.unsubscribed} unsubscribed` : ''}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* Enrolled baseline */}
            <FunnelBar label="Enrolled" sub="entered the journey" value={d.enrolled} total={d.enrolled} accent="var(--brand)" />
            {d.steps.map((s, i) => {
              const prev = i === 0 ? d.enrolled : d.steps[i - 1].received;
              const dropped = Math.max(0, prev - s.received);
              const dropPct = prev > 0 ? Math.round((dropped / prev) * 100) : 0;
              const rate = (n) => (s.received > 0 ? Math.min(100, Math.round((n / s.received) * 100)) : 0);
              return (
                <div key={s.index} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {dropped > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--muted)', paddingLeft: 2 }} title="Fewer people reached this step than the previous one — they converted, unsubscribed, or are still en route.">↓ {dropped} didn’t reach this step ({dropPct}%)</div>
                  )}
                  <FunnelBar label={`Step ${s.index + 1} · +${unit(s.delayHours)}`} sub={s.subject || ''} value={s.received} total={d.enrolled || 1}
                    engage={[s.opened ? `📨 ${s.opened} opened (${rate(s.opened)}%)` : '', s.clicked ? `👆 ${s.clicked} clicked (${rate(s.clicked)}%)` : ''].filter(Boolean).join(' · ')}
                    note={s.converted ? `${s.converted} converted after this step` : ''} />
                </div>
              );
            })}
          </div>
          <div style={hintS}>“Received” counts everyone who advanced past that step; opened/clicked (% of received) are tracked per step. People leave the journey the moment they buy (converted) or unsubscribe.</div>
        </>
      )}
    </div>
  );
}
function FunnelBar({ label, sub, value, total, accent, note, engage }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{label}{sub && <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 12 }}> · {sub}</span>}</span>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{value} <span style={{ color: 'var(--muted)' }}>({pct}%)</span></span>
      </div>
      <div style={{ height: 10, borderRadius: 999, background: 'rgba(128,128,128,0.15)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: accent || '#7c3aed', borderRadius: 999, transition: 'width .2s' }} />
      </div>
      {engage && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>{engage}</div>}
      {note && <div style={{ fontSize: 11, color: 'var(--success,#10b981)', marginTop: 3 }}>✓ {note}</div>}
    </div>
  );
}

// Master-campaign report: combined totals across all the segment campaigns
// sharing this master, plus a per-segment breakdown (tap a segment for its own
// report). Built from data already loaded — no extra fetch.
function MasterReport({ entityId, name, master, campaigns, onOpen, onNew, onChanged, onClose }) {
  const [rename, setRename] = useState(name);
  const [target, setTarget] = useState(master?.target || 0);
  const [saved, setSaved] = useState('');
  const t = campaigns.reduce((s, a) => ({
    sent: s.sent + (a.results?.sent || 0), clicks: s.clicks + (a.results?.clicks || 0),
    converted: s.converted + (a.results?.converted || 0), enrolled: s.enrolled + (a.results?.enrolled || 0),
    emailSent: s.emailSent + (a.results?.emailSent || 0), smsSent: s.smsSent + (a.results?.smsSent || 0),
    emailClicks: s.emailClicks + (a.results?.emailClicks || 0), smsClicks: s.smsClicks + (a.results?.smsClicks || 0),
  }), { sent: 0, clicks: 0, converted: 0, enrolled: 0, emailSent: 0, smsSent: 0, emailClicks: 0, smsClicks: 0 });
  // Per-channel rollup is only meaningful once this master mixes channels.
  const channels = new Set(campaigns.map((a) => a.config?.channel || 'email'));
  const showPerChannel = channels.has('both') || channels.size > 1;
  const anySeq = campaigns.some((a) => a.config?.campaignMode === 'sequence');
  const ctr = t.sent > 0 ? Math.round((t.clicks / t.sent) * 100) : 0;
  // Target tracks conversions for sequences, else clicks. Progress bar shows it.
  const progressMetric = anySeq ? t.converted : t.clicks;
  const pct = target > 0 ? Math.min(100, Math.round((progressMetric / target) * 100)) : 0;
  const save = async () => {
    try { const r = await api.saveMaster(entityId, { name, rename: rename.trim() || name, target: Number(target) || 0 }); setSaved('✓ Saved'); setTimeout(() => { setSaved(''); onChanged(r.name); }, 700); }
    catch { setSaved('✗ Failed'); }
  };
  const del = async () => { if (!confirm(`Delete the master “${name}”? Its ${campaigns.length} campaign(s) stay — they’re just ungrouped.`)) return; await api.deleteMaster(entityId, name).catch(() => {}); onChanged(null); };
  const Stat = ({ label, value, accent }) => (
    <div style={{ ...card, flex: '1 1 120px', margin: 0, textAlign: 'center' }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: accent || 'var(--text)' }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{label}</div>
    </div>
  );
  return (
    <div>
      <button style={{ ...mini, marginBottom: 12 }} onClick={onClose}>← Back to campaigns</button>
      <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 2 }}>🗂 {name}</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>{campaigns.length} segment campaign{campaigns.length === 1 ? '' : 's'} in this master.</div>

      {/* Manage: rename, target, add a segment, delete */}
      <div style={{ ...card, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: '1 1 200px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', marginBottom: 4 }}>Master name</div>
          <input style={input} value={rename} onChange={(e) => setRename(e.target.value)} />
        </div>
        <div style={{ width: 150 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', marginBottom: 4 }}>Target ({anySeq ? 'conversions' : 'clicks'})</div>
          <input type="number" min="0" style={input} value={target} onChange={(e) => setTarget(e.target.value)} placeholder="0 = none" />
        </div>
        <button style={mini} onClick={save}>Save</button>
        {saved && <span style={{ fontSize: 12, color: saved.startsWith('✓') ? 'var(--success,#10b981)' : 'var(--error,#ef4444)' }}>{saved}</span>}
        <span style={{ flex: 1 }} />
        <button style={mini} onClick={onNew}>＋ New segment</button>
        <button style={{ ...mini, color: 'var(--error,#ef4444)' }} onClick={del}>Delete master</button>
      </div>

      {target > 0 && (
        <div style={{ margin: '14px 2px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            <span>Target progress</span><span>{progressMetric} / {target} {anySeq ? 'conversions' : 'clicks'} · {pct}%</span>
          </div>
          <div style={{ height: 8, borderRadius: 999, background: 'rgba(128,128,128,0.2)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: 'var(--brand)', borderRadius: 999 }} />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '16px 0 18px' }}>
        {anySeq && <Stat label="Enrolled" value={t.enrolled} />}
        <Stat label="Emails sent" value={t.sent} />
        <Stat label="Clicks" value={t.clicks} />
        <Stat label="Click rate" value={`${ctr}%`} />
        {anySeq && <Stat label="Converted" value={t.converted} accent="var(--success,#10b981)" />}
        {master?.stats?.cost > 0 && <Stat label="Cost" value={money(master.currency, master.stats.cost)} />}
      </div>

      {/* Per-channel rollup across all segment campaigns in this master. */}
      {showPerChannel && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, margin: '0 0 18px' }}>
          {[
            { key: 'email', label: '✉️ Email', accent: '#0a66c2', sent: t.emailSent, clicks: t.emailClicks },
            { key: 'sms', label: '💬 SMS', accent: '#15803d', sent: t.smsSent, clicks: t.smsClicks },
          ].map((c) => (
            <div key={c.key} style={{ background: 'var(--elevated, #fafafa)', border: '1px solid var(--hairline)', borderRadius: 12, padding: '12px 16px' }}>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: c.accent, marginBottom: 8 }}>{c.label}</div>
              <div style={{ display: 'flex', gap: 18, fontSize: 13 }}>
                <div><div style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 700 }}>Sent</div><div style={{ fontSize: 19, fontWeight: 800 }}>{c.sent}</div></div>
                <div><div style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 700 }}>Clicks</div><div style={{ fontSize: 19, fontWeight: 800 }}>{c.clicks}</div></div>
                <div><div style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 700 }}>CTR</div><div style={{ fontSize: 19, fontWeight: 800, color: c.accent }}>{c.sent > 0 ? Math.min(100, Math.round((c.clicks / c.sent) * 100)) : 0}%</div></div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', margin: '0 2px 8px' }}>By segment</div>
      {campaigns.map((a) => {
        const seq = a.config?.campaignMode === 'sequence';
        const sent = a.results?.sent || 0; const clicks = a.results?.clicks || 0;
        return (
          <div key={a.id} style={{ ...card, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', cursor: 'pointer' }} onClick={() => onOpen(a)}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{a.title || a.config.subject || 'Untitled'}</span>
                <ChannelChip channel={a.config?.channel} />
                <StatusChip status={a.status} />
                {seq && <span style={{ fontSize: 11, color: 'var(--muted)' }}>· {(a.config.steps || []).length}-step sequence</span>}
              </div>
              <div style={{ display: 'flex', gap: 14, marginTop: 6, fontSize: 12.5, fontWeight: 600, flexWrap: 'wrap' }}>
                {seq && <span>👥 {a.results?.enrolled ?? 0}</span>}
                <span>📤 {sent} sent</span>
                <span>🔗 {clicks} clicks</span>
                {sent > 0 && <span style={{ color: 'var(--muted)' }}>{Math.round((clicks / sent) * 100)}% CTR</span>}
                {seq && <span style={{ color: 'var(--success,#10b981)' }}>✓ {a.results?.converted ?? 0} converted</span>}
              </div>
            </div>
            <span style={{ color: 'var(--muted)', fontSize: 18 }}>›</span>
          </div>
        );
      })}
    </div>
  );
}

function CampaignReport({ entityId, action, onClose }) {
  const isMobile = useIsMobile();
  const [r, setR] = useState(null);
  const [previews, setPreviews] = useState(null); // [{ label, html, sms }] — one per step (or one for once-off)
  useEffect(() => { api.actionReport(entityId, action.id).then(setR).catch(() => setR({ error: true })); }, [entityId, action.id]);
  useEffect(() => {
    // Sequences render every step (so the whole journey can be reviewed); a
    // once-off renders just its single message.
    const steps = action.config?.steps || [];
    const unit = (h) => (h % 24 === 0 && h >= 24 ? `${h / 24}d` : `${h}h`);
    const jobs = steps.length > 0
      ? steps.map((s, i) => ({ label: `Step ${i + 1} · +${unit(s.delayHours || 0)}`, cfg: { ...action.config, subject: s.subject || action.config.subject, body: s.body || '', smsBody: s.smsBody || s.body || action.config.smsBody } }))
      : [{ label: '', cfg: action.config }];
    Promise.all(jobs.map((j) => api.actionPreviewEmail(entityId, j.cfg).then((p) => ({ label: j.label, ...p })).catch(() => ({ label: j.label }))))
      .then(setPreviews).catch(() => setPreviews([]));
  }, [entityId, action.id]); // eslint-disable-line react-hooks/exhaustive-deps
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
        {r.hasOpens && stat('Email open rate', `${r.openRate}%`, '#0a66c2')}
        {r.hasOpens && stat('Unique opens', r.uniqueOpeners)}
        {stat('Total clicks', r.totalClicks)}
        {stat('Unique clickers', r.uniqueClickers)}
        {stat('CTR', `${r.ctr}%`, 'var(--brand)')}
        {(r.converted > 0) && stat('Converted', r.converted, 'var(--success,#10b981)')}
        {(r.converted > 0) && stat('Conv. rate', `${r.convRate}%`, 'var(--success,#10b981)')}
        {r.cost && r.cost.total > 0 && stat('Cost', money(r.cost.currency, r.cost.total))}
      </div>

      {/* Per-channel split — only meaningful when a campaign used both channels. */}
      {r.details?.channel === 'both' && r.perChannel && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12, marginBottom: 18 }}>
          {[
            { key: 'email', label: '✉️ Email', accent: '#0a66c2', d: r.perChannel.email },
            { key: 'sms', label: '💬 SMS', accent: '#15803d', d: r.perChannel.sms },
          ].map(({ key, label, accent, d }) => (
            <div key={key} style={{ background: 'var(--elevated, #fafafa)', border: '1px solid var(--hairline)', borderRadius: 12, padding: '12px 16px' }}>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: accent, marginBottom: 8 }}>{label}</div>
              <div style={{ display: 'flex', gap: 18, fontSize: 13 }}>
                <div><div style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 700 }}>Sent</div><div style={{ fontSize: 19, fontWeight: 800 }}>{d.sent}</div></div>
                <div><div style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 700 }}>Clicks</div><div style={{ fontSize: 19, fontWeight: 800 }}>{d.clicks}</div></div>
                <div><div style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 700 }}>CTR</div><div style={{ fontSize: 19, fontWeight: 800, color: accent }}>{d.ctr}%</div></div>
              </div>
            </div>
          ))}
        </div>
      )}

      {r.details && (() => {
        const d = r.details;
        const utmParts = Object.entries(d.utm || {}).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`);
        const Row = ({ k, children }) => <div style={{ display: 'flex', gap: 8 }}><span style={{ minWidth: 84, color: 'var(--muted)' }}>{k}</span><span style={{ flex: 1, minWidth: 0, color: 'var(--text)' }}>{children}</span></div>;
        const hasEmail = d.channel !== 'sms'; const hasSms = d.channel !== 'email';
        return (
        <>
          {/* Settings */}
          <ReportSection title="Settings" meta={d.channel === 'both' ? 'Email + SMS' : d.channel === 'sms' ? 'SMS' : 'Email'}>
            <div style={{ fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Row k="Channel">{d.channel === 'both' ? 'Email + SMS' : d.channel === 'sms' ? 'SMS' : 'Email'}</Row>
              <Row k="Type">{d.type}</Row>
              <Row k="Audience">{d.audience || '—'}</Row>
              {d.scheduledAt && <Row k="Scheduled">{new Date(d.scheduledAt).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</Row>}
              {d.master && <Row k="Master">{d.master}</Row>}
              {hasEmail && <Row k="Content">{d.contentMode === 'html' ? 'Custom HTML' : 'Built template'}{d.hasHero ? ' · hero image' : ''}</Row>}
              {hasEmail && d.subject && <Row k="Subject">{d.subject}</Row>}
              {d.ctaUrl && <Row k="Link"><span style={{ wordBreak: 'break-all' }}>{d.ctaUrl}</span></Row>}
              {d.promo && <Row k="Offer">{d.promo.type}{d.promo.code ? ` · ${d.promo.code}` : ''}{d.promo.benefit ? ` · ${d.promo.benefit}` : ''}{d.promo.source === 'unique' ? ' · unique codes' : ''}</Row>}
              {utmParts.length > 0 && <Row k="UTM"><span style={{ wordBreak: 'break-all' }}>{utmParts.join(' · ')}</span></Row>}
              {d.approvers?.length > 0 && <Row k="Approvers">{d.approvers.join(', ')}</Row>}
            </div>
            {/* Copy */}
            {d.steps?.length > 0 ? (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {d.steps.map((s, i) => (
                  <div key={i} style={{ borderLeft: '2px solid var(--hairline)', paddingLeft: 10 }}>
                    <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--brand)' }}>Step {i + 1} · +{s.delayHours % 24 === 0 && s.delayHours >= 24 ? `${s.delayHours / 24}d` : `${s.delayHours}h`}</div>
                    {s.subject && <div style={{ fontSize: 13, fontWeight: 600 }}>{s.subject}</div>}
                    <div style={{ fontSize: 12.5, color: 'var(--muted)', whiteSpace: 'pre-wrap' }}>{s.body}</div>
                  </div>
                ))}
              </div>
            ) : hasSms && d.smsBody ? (
              <div style={{ marginTop: 10, borderLeft: '2px solid #15803d', paddingLeft: 10 }}>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: '#15803d' }}>SMS text</div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)', whiteSpace: 'pre-wrap' }}>{d.smsBody}</div>
              </div>
            ) : null}
          </ReportSection>
          {/* Live preview — one block per step for sequences, one for once-offs. */}
          <ReportSection title="Preview" meta={(hasEmail && hasSms ? 'Email + SMS' : hasSms ? 'SMS' : 'Email') + (previews?.length > 1 ? ` · ${previews.length} steps` : '')}>
            {!previews ? <p style={{ color: 'var(--muted)', fontSize: 12.5 }}>Rendering…</p> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                {previews.map((p, i) => (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {p.label && <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--brand)' }}>{p.label}</div>}
                    {hasEmail && p.html && <iframe title={`Email preview ${i + 1}`} srcDoc={p.html} style={{ width: '100%', height: 420, border: '1px solid var(--hairline)', borderRadius: 10, background: '#fff' }} />}
                    {hasSms && <SmsPreview text={p.sms || d.smsBody || d.body} />}
                  </div>
                ))}
              </div>
            )}
          </ReportSection>
        </>
        );
      })()}

      <ReportSection title="Who clicked" meta={r.uniqueClickers > 0 ? `${r.uniqueClickers} clicker${r.uniqueClickers === 1 ? '' : 's'}` : ''}>
        {r.clickers.length === 0 ? (
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>
            {r.totalClicks > 0
              ? `${r.totalClicks} click${r.totalClicks === 1 ? '' : 's'} recorded, but not attributed to individuals — this campaign predates per-recipient tracking. New campaigns will show who clicked here.`
              : 'No clicks yet.'}
          </p>
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
          {r.uniqueClickers > 0 && r.nonClickers > 0 && <span>{r.nonClickers} recipient{r.nonClickers === 1 ? '' : 's'} haven't clicked. </span>}
          {r.anonClicks > 0 && <span>{r.anonClicks} click{r.anonClicks === 1 ? '' : 's'} couldn't be attributed to a person (older/forwarded links). </span>}
          Forwarded links count toward the original recipient.
        </div>
      </ReportSection>
    </div>
  );
}

// Hero image: upload (resized ≤1000px wide, data-URL) or paste a URL.
export function ImageField({ label, value, onChange }) {
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
      <UploadHint kind="banner" />
    </div>
  );
}

// Custom HTML: upload an .html file or paste/edit markup directly.
export function HtmlField({ value, onChange }) {
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

// Collapsible card section in the campaign report (collapsed by default).
function ReportSection({ title, meta, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ ...card, marginBottom: 14 }}>
      <button onClick={() => setOpen((o) => !o)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--text)' }}>
        <span style={{ width: 12, fontSize: 10, color: 'var(--muted)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{title}</span>
        {meta && <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 500 }}>{meta}</span>}
      </button>
      {open && <div style={{ marginTop: 12 }}>{children}</div>}
    </div>
  );
}

// Overflow menu for a campaign row — keeps the row to one primary button + ⋯.
function RowMenu({ items }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null); // fixed-position coords, computed on open
  const btnRef = useRef(null);
  if (!items || !items.length) return null;
  const toggle = () => {
    if (open) { setOpen(false); return; }
    // Anchor a fixed-position menu to the button and flip it UP when there isn't
    // room below — so a row near the bottom of the page doesn't open off-screen.
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      const estHeight = Math.min(items.length * 38 + 8, window.innerHeight * 0.7);
      const spaceBelow = window.innerHeight - r.bottom;
      const openUp = spaceBelow < estHeight + 8 && r.top > spaceBelow;
      setPos({
        right: Math.max(8, window.innerWidth - r.right),
        ...(openUp ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
      });
    }
    setOpen(true);
  };
  return (
    <div style={{ position: 'relative' }}>
      <button ref={btnRef} style={{ ...mini, padding: '7px 11px', fontWeight: 700 }} onClick={toggle} aria-label="More actions" title="More">⋯</button>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setOpen(false)} />
          <div className="modal-in" style={{ position: 'fixed', ...pos, zIndex: 41, background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 10, boxShadow: 'var(--shadow-pop, 0 8px 40px rgba(0,0,0,0.16))', minWidth: 150, maxHeight: '70vh', overflowY: 'auto', padding: 4, display: 'flex', flexDirection: 'column' }}>
            {items.map((it, i) => (
              <button key={i} className="nav-row" style={{ display: 'flex', width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', padding: '8px 10px', borderRadius: 7, fontSize: 13, fontWeight: 600, color: it.danger ? 'var(--error,#ef4444)' : 'var(--text)' }} onClick={() => { setOpen(false); it.onClick(); }}>{it.label}</button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Channel badge so the list makes the send channel obvious at a glance.
function ChannelChip({ channel }) {
  const m = channel === 'sms' ? { t: '💬 SMS', c: '#15803d', bg: 'rgba(21,128,61,0.12)' }
    : channel === 'both' ? { t: '✉️ + 💬 Email & SMS', c: '#7c3aed', bg: 'rgba(124,58,237,0.12)' }
    : { t: '✉️ Email', c: '#0a66c2', bg: 'rgba(10,132,255,0.12)' };
  return <span style={{ fontSize: 10.5, fontWeight: 700, borderRadius: 980, padding: '2px 8px', background: m.bg, color: m.c }}>{m.t}</span>;
}

// One quiet "Filter" control that opens a popover with channel + state choices.
// Keeps the list clean; a badge shows how many filters are active.
function FilterMenu({ channelPills, channelFilter, setChannelFilter, statePills, stateFilter, setStateFilter }) {
  const [open, setOpen] = useState(false);
  const activeCount = (channelFilter !== 'all' ? 1 : 0) + (stateFilter !== 'all' ? 1 : 0);
  const labelFor = (pills, value) => pills.find((p) => p.value === value)?.label || '';
  const Group = ({ title, pills, value, onPick }) => (
    <div style={{ padding: '6px 4px' }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', padding: '0 8px 4px' }}>{title}</div>
      {pills.map((p) => {
        const active = value === p.value;
        return (
          <button key={p.value} className="nav-row" onClick={() => { onPick(p.value); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', border: 'none', background: active ? 'rgba(var(--brand-rgb,255,56,92),0.10)' : 'transparent', cursor: 'pointer', padding: '7px 10px', borderRadius: 7, fontSize: 13, fontWeight: active ? 700 : 600, color: active ? 'var(--brand)' : 'var(--text)' }}>
            <span style={{ flex: 1 }}>{p.label}</span>
            {typeof p.n === 'number' && <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>{p.n}</span>}
            {active && <span style={{ color: 'var(--brand)' }}>✓</span>}
          </button>
        );
      })}
    </div>
  );
  return (
    <div style={{ position: 'relative' }}>
      <button style={{ ...outline, display: 'inline-flex', alignItems: 'center', gap: 7 }} onClick={() => setOpen((o) => !o)} title="Filter campaigns">
        <span>⚲ Filter</span>
        {activeCount > 0 && <span style={{ fontSize: 10.5, fontWeight: 800, background: 'var(--brand)', color: '#fff', borderRadius: 980, padding: '1px 7px' }}>{activeCount}</span>}
      </button>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setOpen(false)} />
          <div className="modal-in" style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 41, background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, boxShadow: 'var(--shadow-pop, 0 8px 40px rgba(0,0,0,0.16))', minWidth: 200, padding: 4 }}>
            {channelPills.length > 1 && <Group title="Channel" pills={channelPills} value={channelFilter} onPick={setChannelFilter} />}
            {channelPills.length > 1 && statePills.length > 1 && <div style={{ height: 1, background: 'var(--hairline)', margin: '2px 6px' }} />}
            {statePills.length > 1 && <Group title="State" pills={statePills} value={stateFilter} onPick={setStateFilter} />}
            {activeCount > 0 && (
              <>
                <div style={{ height: 1, background: 'var(--hairline)', margin: '2px 6px' }} />
                <button className="nav-row" onClick={() => { setChannelFilter('all'); setStateFilter('all'); setOpen(false); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', padding: '8px 10px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, color: 'var(--muted)' }}>Clear filters</button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function StatusChip({ status }) {
  const map = {
    draft: { bg: 'rgba(128,128,128,0.14)', c: 'var(--muted)', t: 'Draft' },
    auto: { bg: 'rgba(124,58,237,0.12)', c: '#7c3aed', t: '⚙ Automation' },
    running: { bg: 'rgba(10,132,255,0.13)', c: '#0a66c2', t: 'Sending…' },
    done: { bg: 'rgba(52,199,89,0.15)', c: '#2da44e', t: 'Sent' },
    scheduled: { bg: 'rgba(10,132,255,0.13)', c: '#0a66c2', t: '🕒 Scheduled' },
    pending: { bg: 'rgba(245,158,11,0.16)', c: '#b45309', t: '⏳ Awaiting approval' },
    failed: { bg: 'rgba(239,68,68,0.12)', c: '#dc2626', t: 'Failed' },
  }[status] || { bg: 'rgba(128,128,128,0.14)', c: 'var(--muted)', t: status };
  return <span style={{ fontSize: 10.5, fontWeight: 700, borderRadius: 980, padding: '2px 9px', background: map.bg, color: map.c }}>{map.t}</span>;
}

const fmt = (iso) => { try { return new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
function Field({ label, children }) { return <div><div style={hintLbl}>{label}</div>{children}</div>; }
export function Toggle({ on, onClick, children }) {
  return <button type="button" onClick={onClick} style={{ flex: 1, padding: '8px 10px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: on ? '1.5px solid var(--brand)' : '1.5px solid var(--hairline)', background: on ? 'rgba(var(--brand-rgb), 0.08)' : 'transparent', color: on ? 'var(--brand)' : 'var(--text)' }}>{children}</button>;
}
// SMS length helper — GSM-7 is 160 chars (153/segment when multipart). The
// auto-appended tracked link + opt-out add to this, so treat it as a guide.
function SmsMeter({ body }) {
  const len = (body || '').length;
  const seg = len === 0 ? 0 : len <= 160 ? 1 : Math.ceil(len / 153);
  return <div style={{ fontSize: 11.5, marginTop: 4, color: len > 160 ? '#b45309' : 'var(--muted)' }}>{len} chars{seg ? ` · ~${seg} SMS${seg > 1 ? ' segments' : ''}` : ''}{len > 160 ? ' — longer texts may cost more' : ''} · link & opt-out add length</div>;
}
// Phone-style bubble for previewing an SMS.
function SmsPreview({ text }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 18, padding: '16px 14px', minHeight: 200 }}>
      <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', marginBottom: 12 }}>Text message</div>
      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#e9e9eb', color: '#000', borderRadius: 16, padding: '10px 13px', fontSize: 14, lineHeight: 1.45, maxWidth: '88%' }}>
        {text || 'Your message preview will appear here.'}
      </div>
    </div>
  );
}
// Collapsible section to keep the long editor tidy — one dropdown per area.
function Accordion({ title, defaultOpen = false, open: controlledOpen, onToggle, children }) {
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const controlled = onToggle !== undefined;
  const open = controlled ? controlledOpen : localOpen;
  const toggle = controlled ? onToggle : () => setLocalOpen((o) => !o);
  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 10, overflow: 'hidden' }}>
      <button type="button" onClick={toggle} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: 'var(--card)', border: 'none', cursor: 'pointer', padding: '11px 12px', fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
        <span style={{ width: 12, color: '#b0b0b6', fontSize: 10, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
        {title}
      </button>
      {open && <div style={{ padding: '2px 12px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>}
    </div>
  );
}

// Optional targeting filters on the audience tile's columns (city, age, ticket
// category, new/returning…). 'is one of' picks real values from the data;
// 'between' is a numeric range (e.g. age). All filters narrow the segment (AND).
export function AudienceFilters({ entityId, fields, filters, addFilter, setFilter, removeFilter, attr, tiles, onAttr, hideAttrSource, eventSuiteId = '' }) {
  const attrDash = tiles?.dashboards?.find((d) => d.dashboardId === attr?.dashboardId);
  return (
    <div style={{ marginTop: 8, borderTop: '1px dashed var(--hairline)', paddingTop: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>🎯 Target a segment (optional)</div>
      {filters.map((fl, i) => (
        <FilterRow key={i} entityId={entityId} fields={fields} filter={fl} eventSuiteId={eventSuiteId}
          onChange={(p) => setFilter(i, p)} onRemove={() => removeFilter(i)} />
      ))}
      <button type="button" style={{ ...mini, marginTop: filters.length ? 6 : 0 }} onClick={addFilter}>＋ Add filter</button>
      {/* Optional second source of customer attributes — its columns join in by email. */}
      {!hideAttrSource && (
      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Extra attributes source (optional — adds more fields to filter on, joined by email):</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <select style={{ ...input, flex: 1, padding: '5px 8px' }} value={attr?.dashboardId || ''} onChange={(e) => onAttr(e.target.value, '')}>
            <option value="">No extra source</option>
            {(tiles?.dashboards || []).map((d) => <option key={d.dashboardId} value={d.dashboardId}>{d.title} — {d.setName}</option>)}
          </select>
          {attrDash && (
            <select style={{ ...input, flex: 1, padding: '5px 8px' }} value={attr?.tileId || ''} onChange={(e) => onAttr(attr.dashboardId, e.target.value)}>
              <option value="">Pick the attributes tile…</option>
              {attrDash.tiles.map((t) => <option key={t.tileId} value={t.tileId}>{t.title}</option>)}
            </select>
          )}
        </div>
      </div>
      )}
      {filters.length > 0 && <div style={hintS}>Filters narrow the audience to everyone matching all of them. Make a separate campaign per segment for different messaging.</div>}
    </div>
  );
}
function FilterRow({ entityId, fields, filter, onChange, onRemove, eventSuiteId = '' }) {
  const [values, setValues] = useState(null); // distinct values for the chosen field
  const [open, setOpen] = useState(false);
  const fieldDef = fields.find((fl) => fl.name === filter.field);
  useEffect(() => {
    if (filter.op !== 'in') { setValues(null); return; }
    // Pasted/Sheet columns carry their distinct values inline (no tile to query).
    if (fieldDef?.values) { setValues(fieldDef.values); return; }
    if (!fieldDef?.dashboardId || !fieldDef?.tileId) { setValues(null); return; }
    let alive = true;
    api.actionFieldValues(entityId, { dashboardId: fieldDef.dashboardId, tileId: fieldDef.tileId, field: filter.field, eventSuiteId }).then((r) => { if (alive) setValues(r.values || []); }).catch(() => { if (alive) setValues([]); });
    return () => { alive = false; };
  }, [filter.field, filter.op, fieldDef?.dashboardId, fieldDef?.tileId, fieldDef?.values, entityId, eventSuiteId]);
  const toggleVal = (v) => onChange({ values: filter.values.includes(v) ? filter.values.filter((x) => x !== v) : [...filter.values, v] });
  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 8, padding: 8, marginBottom: 6 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <select style={{ ...input, flex: 1, padding: '5px 8px' }} value={filter.field} onChange={(e) => onChange({ field: e.target.value, values: [] })}>
          <option value="">Pick a field…</option>
          {fields.map((fl) => <option key={fl.name} value={fl.name}>{fl.label}</option>)}
        </select>
        <select style={{ ...input, width: 110, padding: '5px 8px' }} value={filter.op} onChange={(e) => onChange({ op: e.target.value })}>
          <option value="in">is one of</option>
          <option value="between">between</option>
        </select>
        <button type="button" style={{ ...mini, color: 'var(--error,#ef4444)' }} onClick={onRemove}>✕</button>
      </div>
      {filter.field && filter.op === 'between' && (
        <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
          <input type="number" style={{ ...input, width: 90, padding: '5px 8px' }} value={filter.min} onChange={(e) => onChange({ min: e.target.value })} placeholder="min" />
          <span style={{ color: 'var(--muted)' }}>–</span>
          <input type="number" style={{ ...input, width: 90, padding: '5px 8px' }} value={filter.max} onChange={(e) => onChange({ max: e.target.value })} placeholder="max" />
        </div>
      )}
      {filter.field && filter.op === 'in' && (
        <div style={{ marginTop: 6 }}>
          {filter.values.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
              {filter.values.map((v) => <span key={v} onClick={() => toggleVal(v)} style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 980, background: 'rgba(var(--brand-rgb,255,56,92),0.10)', color: 'var(--brand)', cursor: 'pointer' }}>{v} ✕</span>)}
            </div>
          )}
          <button type="button" style={{ ...mini, padding: '4px 9px' }} onClick={() => setOpen((o) => !o)}>{open ? 'Done' : 'Choose values'}</button>
          {open && (
            <div style={{ marginTop: 6, maxHeight: 160, overflowY: 'auto', border: '1px solid var(--hairline)', borderRadius: 8, padding: 6 }}>
              {values == null ? <div style={hintS}>Loading values…</div>
                : values.length === 0 ? <div style={hintS}>No values found in this column.</div>
                : values.map((v) => (
                  <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, padding: '3px 4px', cursor: 'pointer' }}>
                    <input type="checkbox" checked={filter.values.includes(v)} onChange={() => toggleVal(v)} /> {v}
                  </label>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// The drip timeline: each step has a delay (number + hours/days) and its own copy.
function SequenceSteps({ steps, setStep, addStep, removeStep, activeStep = 0, onActive, email = true, sms = false, onDraft, drafting = false, anchorLabel = 'after abandonment' }) {
  const both = email && sms;       // Email + SMS → each step gets BOTH editors
  const smsOnly = sms && !email;   // SMS-only → the step's `body` IS the SMS text
  const unitOf = (h) => (h % 24 === 0 && h >= 24 ? 'days' : 'hours');
  const valOf = (h) => (unitOf(h) === 'days' ? h / 24 : h);
  const setDelay = (i, val, unit) => setStep(i, { delayHours: Math.max(0, (Number(val) || 0) * (unit === 'days' ? 24 : 1)) });
  const focus = (i) => () => onActive?.(i);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {steps.map((st, i) => {
        const unit = unitOf(st.delayHours);
        const isActive = i === activeStep;
        return (
          <div key={i} onClick={focus(i)} style={{ border: `1px solid ${isActive ? 'var(--brand)' : 'var(--hairline)'}`, borderRadius: 10, padding: 12, position: 'relative', cursor: 'pointer' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--brand)' }}>Step {i + 1}{isActive ? ' · previewing' : ''}</span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>· send</span>
              <input type="number" min="0" style={{ ...input, width: 64, padding: '5px 8px' }} value={valOf(st.delayHours)} onChange={(e) => setDelay(i, e.target.value, unit)} />
              <select style={{ ...input, width: 90, padding: '5px 8px' }} value={unit} onChange={(e) => setDelay(i, valOf(st.delayHours), e.target.value)}>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{anchorLabel}</span>
              <span style={{ flex: 1 }} />
              {steps.length > 1 && <button type="button" style={{ ...mini, color: 'var(--error,#ef4444)' }} onClick={() => removeStep(i)}>✕</button>}
            </div>
            {/* Email block — shown for email-only and Email+SMS sequences. */}
            {email && (
              <>
                {both && <div style={{ fontSize: 11.5, fontWeight: 700, color: '#0a66c2', marginBottom: 6 }}>✉️ Email</div>}
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <Toggle on={(st.contentMode || 'template') === 'template'} onClick={() => { focus(i)(); setStep(i, { contentMode: 'template' }); }}>Built template</Toggle>
                  <Toggle on={st.contentMode === 'html'} onClick={() => { focus(i)(); setStep(i, { contentMode: 'html' }); }}>Custom HTML</Toggle>
                </div>
                {onDraft && (st.contentMode || 'template') === 'template' && <button type="button" style={{ ...mini, marginBottom: 6 }} onClick={(e) => { e.stopPropagation(); focus(i)(); onDraft(i); }} disabled={drafting}>{drafting ? 'Writing…' : '✨ Draft copy with AI'}</button>}
                <input style={{ ...input, fontWeight: 700, marginBottom: 6 }} value={st.subject} onFocus={focus(i)} onChange={(e) => setStep(i, { subject: e.target.value })} placeholder={`Step ${i + 1} subject`} />
                {(st.contentMode || 'template') === 'template' ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <ImageField label="Hero image (optional)" value={st.heroImage || ''} onChange={(v) => setStep(i, { heroImage: v })} />
                    <textarea style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} rows={4} value={st.body} onFocus={focus(i)} onChange={(e) => setStep(i, { body: e.target.value })} placeholder={'Hi {{name}}, …  (tokens: {{ticketType}}, {{promo}})'} />
                    <input style={input} value={st.ctaText} onFocus={focus(i)} onChange={(e) => setStep(i, { ctaText: e.target.value })} placeholder="Button text (e.g. Complete my purchase)" />
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} onClick={focus(i)}>
                    <HtmlField value={st.customHtml || ''} onChange={(v) => setStep(i, { customHtml: v })} />
                    <div style={hintS}>Tokens work inside your HTML: <b>{'{{name}}'}</b>, <b>{'{{ticketType}}'}</b>, <b>{'{{cta}}'}</b> (the shared tracked buy link), <b>{'{{unsubscribe}}'}</b>. An unsubscribe link is added if you omit one.</div>
                  </div>
                )}
              </>
            )}
            {both && <div style={{ height: 1, background: 'var(--hairline)', margin: '12px 0 10px' }} />}
            {/* SMS block — for SMS-only the step's `body` is the text; for Email+SMS
                it's a SEPARATE per-step `smsBody`. */}
            {sms && (
              <>
                {both && <div style={{ fontSize: 11.5, fontWeight: 700, color: '#15803d', marginBottom: 6 }}>💬 SMS text (separate from the email)</div>}
                {smsOnly && onDraft && <button type="button" style={{ ...mini, marginBottom: 6 }} onClick={(e) => { e.stopPropagation(); focus(i)(); onDraft(i); }} disabled={drafting}>{drafting ? 'Writing…' : '✨ Draft copy with AI'}</button>}
                <textarea style={{ ...input, resize: 'vertical', fontFamily: 'inherit', marginBottom: 6 }} rows={4} value={smsOnly ? st.body : (st.smsBody || '')} onFocus={focus(i)} onChange={(e) => setStep(i, smsOnly ? { body: e.target.value } : { smsBody: e.target.value })} placeholder={'Hi {{name}}, your {{ticketType}} tickets are waiting…'} />
                <SmsMeter body={smsOnly ? st.body : (st.smsBody || '')} />
                {both && <div style={hintS}>Sent as the SMS for this step (the tracked link &amp; opt-out are appended). Tokens <b>{'{{name}}'}</b>, <b>{'{{ticketType}}'}</b>, <b>{'{{promo}}'}</b> work. Leave blank to fall back to the email body.</div>}
              </>
            )}
          </div>
        );
      })}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" style={mini} onClick={() => addStep(24)}>＋ Add step</button>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>Quick add:</span>
        {[['+2h', 2], ['+24h', 24], ['+72h', 72], ['+5d', 120], ['+10d', 240]].map(([lbl, h]) => (
          <button key={lbl} type="button" style={{ ...mini, padding: '5px 9px' }} onClick={() => addStep(h)}>{lbl}</button>
        ))}
      </div>
      <div style={hintS}>Steps auto-sort by delay. Tokens <b>{'{{name}}'}</b>, <b>{'{{ticketType}}'}</b>, <b>{'{{promo}}'}</b> work in every step. The preview follows the step you’re editing — or use “Preview all steps”.</div>
    </div>
  );
}

// Promo / discount code editor: source (none / generic / unique pool), kind
// (promo = appendable to link · discount = entered at checkout), benefit + codes.
function PromoEditor({ promo, setPromo, poolStats, promoCodesText, setPromoCodesText }) {
  const codeCount = promoCodesText.split(/[\s,;]+/).filter(Boolean).length;
  return (
    <Field label="Promo / discount code (optional)">
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <Toggle on={promo.source === 'none'} onClick={() => setPromo({ source: 'none' })}>None</Toggle>
        <Toggle on={promo.source === 'generic'} onClick={() => setPromo({ source: 'generic' })}>Generic code</Toggle>
        <Toggle on={promo.source === 'unique'} onClick={() => setPromo({ source: 'unique' })}>Unique codes</Toggle>
      </div>
      {promo.source !== 'none' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <Toggle on={promo.type === 'promo'} onClick={() => setPromo({ type: 'promo' })}>Promo (applies via link)</Toggle>
            <Toggle on={promo.type === 'discount'} onClick={() => setPromo({ type: 'discount', appendToLink: false })}>Discount (enter at checkout)</Toggle>
          </div>
          <input style={input} value={promo.benefit} onChange={(e) => setPromo({ benefit: e.target.value })} placeholder="What it gives — e.g. 20% off (shown in the email)" />
          {promo.source === 'generic'
            ? <input style={{ ...input, fontFamily: 'ui-monospace, monospace' }} value={promo.code} onChange={(e) => setPromo({ code: e.target.value })} placeholder="The code, e.g. FOMO20" />
            : (
              <>
                <textarea style={{ ...input, resize: 'vertical', fontFamily: 'ui-monospace, monospace' }} rows={3} value={promoCodesText} onChange={(e) => setPromoCodesText(e.target.value)} placeholder={'Paste unique codes, one per line:\nHOWL-A1B2\nHOWL-C3D4\n…'} />
                <div style={hintS}>
                  {codeCount > 0 && <span>{codeCount} new code{codeCount === 1 ? '' : 's'} to upload. </span>}
                  {poolStats && <span><b>{poolStats.available}</b> available · {poolStats.used} used (of {poolStats.total}). </span>}
                  One code per customer, kept for their whole journey. If the pool empties, new sign-ups pause until you add more.
                </div>
              </>
            )}
          {promo.type === 'promo' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--text)', cursor: 'pointer' }}>
              <input type="checkbox" checked={promo.appendToLink !== false} onChange={(e) => setPromo({ appendToLink: e.target.checked })} />
              Add the code to the buy link automatically (?promo=CODE)
            </label>
          )}
          {promo.type === 'discount' && <div style={hintS}>Discount codes are shown as “enter this code at checkout” — never attached to the link.</div>}
          <div style={hintS}>Insert <b>{'{{promo}}'}</b> (the code) and <b>{'{{promo_benefit}}'}</b> anywhere in your copy. A code box is added to the email automatically.</div>
        </div>
      )}
    </Field>
  );
}

const card = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: 14, marginBottom: 10 };
const tdR = { padding: '7px 8px', verticalAlign: 'top' };
const input = { width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', background: 'var(--card)', color: 'var(--text)' };
const primary = { padding: '9px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const outline = { padding: '9px 16px', background: 'transparent', color: 'var(--text)', border: '1.5px solid var(--hairline)', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const tplCard = { textAlign: 'left', background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: '12px 14px', cursor: 'pointer', boxShadow: 'var(--shadow-sm)' };
const mini = { padding: '7px 12px', background: 'rgba(128,128,128,0.10)', color: 'var(--text)', border: '1px solid var(--hairline)', borderRadius: 980, fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const hintLbl = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', margin: '0 0 5px' };
const hintS = { fontSize: 11, color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 };
const chBanner = { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderRadius: 8, fontWeight: 700, fontSize: 13, margin: '4px 0 2px' };
// Collapsed master group: a card with two faux cards peeking behind = "stacked".
const stackedCard = {
  display: 'flex', alignItems: 'center', gap: 4, width: 'calc(100% - 8px)', textAlign: 'left', cursor: 'pointer',
  background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: '14px 16px',
  marginLeft: 0, color: 'var(--text)',
  boxShadow: '4px 4px 0 -1px var(--bg), 4px 4px 0 0 var(--hairline), 8px 8px 0 -2px var(--bg), 8px 8px 0 -1px var(--hairline)',
};
