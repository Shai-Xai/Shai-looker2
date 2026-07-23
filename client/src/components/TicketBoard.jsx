// Admin → Tickets: the live product board. Bug/improvement/idea reports (from the
// global widget, staff + clients) land here as cards on a Kanban of lanes. A dev
// triages, accepts, assigns, edits the AI-drafted ticket, copies a self-contained
// build brief for Claude, and moves it to shipped — which notifies the reporter.
// Mobile-first: lanes become a single selectable column on a phone.
import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';

const TYPE_ICON = { bug: '🐞', improvement: '✨', idea: '💡' };
const URGENCY_STYLE = {
  urgent: { color: '#fff', background: 'var(--brand)' },
  high: { color: 'var(--brand)', background: 'rgba(var(--brand-rgb), 0.14)' },
  normal: { color: 'var(--muted)', background: 'rgba(128,128,128,0.12)' },
  low: { color: 'var(--muted)', background: 'rgba(128,128,128,0.08)' },
};
const BOARD_LANES = ['inbox', 'triaged', 'accepted', 'in_progress', 'staging', 'shipped', 'rejected', 'approved'];
const ALL_STATUSES = ['inbox', 'triaged', 'accepted', 'in_progress', 'staging', 'shipped', 'approved', 'rejected', 'declined'];
const STATUS_LABEL = { inbox: 'New', triaged: 'Triaged', accepted: 'Accepted', in_progress: 'In progress', staging: 'On staging — verify', shipped: 'Shipped — awaiting review', approved: 'Live 🚀', rejected: 'Rejected — reopen', declined: 'Declined' };

export default function TicketBoard() {
  const isMobile = useIsMobile();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [envFilter, setEnvFilter] = useState(''); // '' | staging | production — where a sent ticket is building/built
  const [lane, setLane] = useState('inbox'); // mobile: which lane is shown
  const [openId, setOpenId] = useState(null);

  const load = useCallback(() => {
    api.adminTickets(typeFilter ? { type: typeFilter } : {})
      .then(setData).catch((e) => setError(e.message));
  }, [typeFilter]);
  useEffect(() => { load(); }, [load]);

  const labels = data?.labels || {};
  const counts = data?.counts || {};
  // A ticket only HAS an environment once it's been sent to GitHub (the target is
  // chosen at send time), so the env filter only matches dispatched tickets.
  const inEnv = (t) => !envFilter || (t.githubIssue > 0 && t.target === envFilter);
  const byLane = (l) => (data?.tickets || []).filter((t) => t.status === l && inEnv(t));
  const terminal = [];
  if (counts.declined) terminal.push(`${counts.declined} declined`);

  function afterChange() { load(); }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em' }}>🎟️ Tickets</h2>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>Bugs, improvements and ideas from the team and clients — triage, build, ship.</p>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {['', 'bug', 'improvement', 'idea'].map((t) => (
            <button key={t || 'all'} onClick={() => setTypeFilter(t)} style={pill(typeFilter === t)}>
              {t ? `${TYPE_ICON[t]} ${t}` : 'All'}
            </button>
          ))}
          <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--hairline)', margin: '0 2px' }} />
          {/* Environment filter — only tickets already sent to GitHub carry one. */}
          {[['', 'All envs'], ['staging', '🧪 Staging'], ['production', '🚀 Production']].map(([v, lbl]) => (
            <button key={v || 'allenv'} onClick={() => setEnvFilter(v)} style={pill(envFilter === v)} title={v ? 'Tickets sent to GitHub with this build target' : undefined}>
              {lbl}
            </button>
          ))}
        </div>
      </div>

      <GithubConfig />
      <DigestConfig />

      {error && <p style={{ color: 'var(--brand)', fontSize: 13 }}>{error}</p>}
      {!data ? <p style={{ color: 'var(--muted)' }}>Loading…</p> : (
        isMobile ? (
          <div>
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 14, paddingBottom: 4 }}>
              {BOARD_LANES.map((l) => (
                <button key={l} onClick={() => setLane(l)} style={pill(lane === l)}>
                  {labels[l] || l} <span style={{ opacity: 0.6 }}>{byLane(l).length}</span>
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {byLane(lane).map((t) => <Card key={t.id} t={t} onOpen={() => setOpenId(t.id)} />)}
              {byLane(lane).length === 0 && <p style={{ color: 'var(--muted)', fontSize: 13 }}>Nothing here.</p>}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8, alignItems: 'flex-start' }}>
            {BOARD_LANES.map((l) => (
              <div key={l} style={{ minWidth: 250, width: 250, flexShrink: 0, background: 'rgba(128,128,128,0.05)', borderRadius: 12, padding: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, padding: '0 2px' }}>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>{labels[l] || l}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>{byLane(l).length}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {byLane(l).map((t) => <Card key={t.id} t={t} onOpen={() => setOpenId(t.id)} />)}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {terminal.length > 0 && (
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 12 }}>
          {terminal.join(' · ')} — terminal, not shown on the board.
        </p>
      )}

      {openId && <TicketDetail id={openId} onClose={() => setOpenId(null)} onChange={afterChange} />}
    </div>
  );
}

// Admin GitHub connection: shows status + a form to set the repo and a write-only
// token. Without a token, "Send to GitHub" opens a prefilled new-issue page; with
// one, the app creates + links the issue directly.
function GithubConfig() {
  const [cfg, setCfg] = useState(null);
  const [openForm, setOpenForm] = useState(false);
  const [repo, setRepo] = useState('');
  const [token, setToken] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [stagingBranch, setStagingBranch] = useState('');
  const [stagingUrl, setStagingUrl] = useState('');
  const [prodBranch, setProdBranch] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const refresh = () => api.getGithubConfig().then((c) => { setCfg(c); setRepo(c.repo || ''); setStagingBranch(c.stagingBranch || 'staging'); setStagingUrl(c.stagingUrl || ''); setProdBranch(c.prodBranch || 'main'); }).catch(() => {});
  useEffect(() => { refresh(); }, []);
  async function save() {
    setBusy(true); setMsg('');
    try { const c = await api.saveGithubConfig({ repo, stagingBranch, stagingUrl, prodBranch, ...(token ? { token } : {}) }); setCfg(c); setToken(''); setMsg('Saved'); setTimeout(() => setMsg(''), 1500); }
    catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }
  if (!cfg) return null;
  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 10, padding: '8px 12px', marginBottom: 12, fontSize: 12.5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700 }}>🐙 GitHub</span>
        {cfg.configured
          ? <span style={{ color: '#16a34a', fontWeight: 600 }}>Connected · {cfg.repo}</span>
          : <span style={{ color: 'var(--muted)' }}>{cfg.repo ? `${cfg.repo} · no token (issues open a prefilled page)` : 'not configured — issues open a prefilled page'}</span>}
        <span style={{ flex: 1 }} />
        <button onClick={() => setOpenForm((o) => !o)} style={miniBtn}>{openForm ? 'Close' : 'Configure'}</button>
      </div>
      {openForm && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 7, maxWidth: 460 }}>
          <label style={ctlLbl}>Repository (owner/name)</label>
          <input className="fld" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" />
          <label style={ctlLbl}>Access token {cfg.tokenSet ? `(set: ${cfg.tokenMask} — blank keeps it)` : '(fine-grained PAT · Issues + Pull requests: write)'}</label>
          <input className="fld" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={cfg.tokenSet ? '•••• leave blank to keep' : 'github_pat_…'} autoComplete="off" />
          {/* Two-environment deploy: staging branch → staging server; production branch → live. */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 150 }}>
              <label style={ctlLbl}>Staging branch (→ staging server)</label>
              <input className="fld" value={stagingBranch} onChange={(e) => setStagingBranch(e.target.value)} placeholder="staging" style={{ width: '100%', boxSizing: 'border-box' }} />
            </div>
            <div style={{ flex: 1, minWidth: 150 }}>
              <label style={ctlLbl}>Production branch (→ live)</label>
              <input className="fld" value={prodBranch} onChange={(e) => setProdBranch(e.target.value)} placeholder="main" style={{ width: '100%', boxSizing: 'border-box' }} />
            </div>
          </div>
          <label style={ctlLbl}>Staging site URL (reporters get this link to test)</label>
          <input className="fld" value={stagingUrl} onChange={(e) => setStagingUrl(e.target.value)} placeholder="https://howler-pulse-staging.onrender.com" />
          <p style={{ color: 'var(--muted)', fontSize: 11.5, margin: 0 }}>Tickets sent to <b>staging</b> get a PR against the staging branch (it deploys to the staging server). When it lands there, the <b>reporter is asked to test and approve</b> (they get the staging URL); only once every staged ticket is approved can <b>Promote to production</b> open the release PR.</p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={save} disabled={busy} style={primaryBtn}>{busy ? 'Saving…' : 'Save'}</button>
            {cfg.tokenSet && <button onClick={async () => { await api.saveGithubConfig({ clearToken: true }); refresh(); }} style={miniBtn}>Remove token</button>}
            {msg && <span style={{ color: 'var(--muted)' }}>{msg}</span>}
          </div>
          <p style={{ color: 'var(--muted)', fontSize: 11.5, margin: 0 }}>No token → "Send to GitHub" opens a prefilled new-issue page in your browser. With a token → the app creates + links the issue automatically.</p>
          {/* Auto-dispatch to Claude — needs the Claude GitHub App + ANTHROPIC_API_KEY + the claude.yml workflow. */}
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: busy ? 'default' : 'pointer', marginTop: 4 }}>
            <input type="checkbox" checked={!!cfg.dispatchClaude} disabled={busy} onChange={async (e) => { setBusy(true); try { const c = await api.saveGithubConfig({ dispatchClaude: e.target.checked }); setCfg(c); } finally { setBusy(false); } }} style={{ marginTop: 2 }} />
            <span>
              <span style={{ fontWeight: 600 }}>Ask Claude to build it</span>
              <span style={{ color: 'var(--muted)', display: 'block', fontSize: 11.5 }}>Adds an @claude mention to each issue so the Claude Code GitHub Action opens a PR. Requires the Claude GitHub App + ANTHROPIC_API_KEY secret + .github/workflows/claude.yml.</span>
            </span>
          </label>

          {/* Webhook — so a merged PR auto-ships the ticket + notifies the reporter. */}
          <div style={{ borderTop: '1px solid var(--hairline)', paddingTop: 10, marginTop: 4 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Auto-ship on merge {cfg.webhookSecretSet ? <span style={{ color: '#16a34a', fontWeight: 400 }}>· webhook connected</span> : <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· not set up</span>}</div>
            <p style={{ color: 'var(--muted)', fontSize: 11.5, margin: '0 0 6px' }}>
              Add a GitHub webhook (repo Settings → Webhooks) for <b>Pull requests</b>, then paste its secret here. A merged PR then moves the ticket to Shipped and notifies the reporter.
            </p>
            <label style={ctlLbl}>Payload URL (into GitHub)</label>
            <input className="fld" readOnly value={`${typeof window !== 'undefined' ? window.location.origin : ''}/api/github/webhook`} onFocus={(e) => e.target.select()} style={{ marginBottom: 6 }} />
            <label style={ctlLbl}>Webhook secret {cfg.webhookSecretSet ? '(set — blank keeps it)' : ''}</label>
            <input className="fld" type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder={cfg.webhookSecretSet ? '•••• leave blank to keep' : 'a long random string'} autoComplete="off" style={{ marginBottom: 6 }} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button onClick={async () => { setBusy(true); try { const c = await api.saveGithubConfig(webhookSecret ? { webhookSecret } : {}); setCfg(c); setWebhookSecret(''); setMsg('Saved'); setTimeout(() => setMsg(''), 1500); } finally { setBusy(false); } }} disabled={busy || !webhookSecret} style={miniBtn}>Save secret</button>
              {cfg.webhookSecretSet && <button onClick={async () => { await api.saveGithubConfig({ clearWebhookSecret: true }); refresh(); }} style={miniBtn}>Remove</button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Card({ t, onOpen }) {
  const u = URGENCY_STYLE[t.urgency] || URGENCY_STYLE.normal;
  return (
    <button onClick={onOpen} style={{
      textAlign: 'left', width: '100%', background: 'var(--card)', border: '1px solid var(--hairline)',
      borderRadius: 10, padding: 10, cursor: 'pointer', display: 'block',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
        <span>{TYPE_ICON[t.type] || '📝'}</span>
        {t.type === 'bug' && <span style={{ ...chip, ...u }}>{t.urgency}</span>}
        {t.aiStatus === 'ready' && <span style={{ ...chip, color: 'var(--muted)', background: 'rgba(128,128,128,0.1)' }}>AI ✓</span>}
        {/* Environment: only meaningful once the ticket has been sent to GitHub.
            A Live ticket shows where it IS (production) — not where it was built. */}
        {t.status === 'approved'
          ? <span style={{ ...chip, color: '#fff', background: '#16a34a', textTransform: 'none' }}>🚀 live</span>
          : t.githubIssue > 0 && (t.target === 'production'
            ? <span style={{ ...chip, color: '#fff', background: '#16a34a', textTransform: 'none' }}>🚀 prod</span>
            : <span style={{ ...chip, color: 'var(--brand)', background: 'rgba(var(--brand-rgb), 0.12)', textTransform: 'none' }}>🧪 staging</span>)}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, lineHeight: 1.3 }}>
        {t.aiTitle || t.title || '(untitled)'}
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)' }}>
        {t.screen || 'unknown'}{t.entityName ? ` · ${t.entityName}` : ''}
      </div>
      {t.tileName && (
        <div style={{ fontSize: 11, color: 'var(--brand)', marginTop: 2, fontWeight: 600 }}>▦ {t.tileName}</div>
      )}
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
        {t.reporterName || t.reporterEmail}{t.assignee ? ` → ${t.assignee}` : ''}
      </div>
    </button>
  );
}

// 🗞️ Daily board summary: who gets the once-a-day digest (what's new, what
// moved, what's waiting for review) and at which hour. Subscribers are picked
// from the same admin/dev list as assignees — add anyone who should keep an
// eye on the board without living in it.
function DigestConfig() {
  const [cfg, setCfg] = useState(null);
  const [people, setPeople] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    api.adminTicketDigest().then(setCfg).catch(() => setCfg({ subscribers: [], hourUtc: 5 }));
    api.adminTicketAssignees().then((r) => setPeople(r.assignees || [])).catch(() => setPeople([]));
  }, []);
  if (!cfg) return null;
  const subs = cfg.subscribers || [];
  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 1800); };
  const save = async (patch) => {
    setBusy(true);
    try { setCfg(await api.adminTicketDigestSave(patch)); } catch { /* keep old */ }
    setBusy(false);
  };
  const toggle = (email) => save({ subscribers: subs.includes(email) ? subs.filter((x) => x !== email) : [...subs, email] });
  const localHour = (h) => { const d = new Date(); d.setUTCHours(h, 0, 0, 0); return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 10, padding: '8px 12px', marginBottom: 12, fontSize: 12.5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700 }}>🗞️ Daily summary</span>
        <span style={{ color: 'var(--muted)' }}>
          {subs.length
            ? `${subs.length} subscriber${subs.length === 1 ? '' : 's'} · daily at ${localHour(cfg.hourUtc)}`
            : 'off — add a subscriber to get a daily board recap'}
        </span>
        {msg && <span style={{ color: '#16a34a', fontWeight: 600 }}>{msg}</span>}
        <span style={{ flex: 1 }} />
        <button onClick={() => setOpen((o) => !o)} style={miniBtn}>{open ? 'Close' : 'Manage'}</button>
      </div>
      {open && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 460 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>Who receives it</div>
          {people.map((p2) => (
            <label key={p2.email} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', minHeight: 40 }}>
              <input type="checkbox" checked={subs.includes(p2.email)} disabled={busy} onChange={() => toggle(p2.email)} />
              <span style={{ fontWeight: 600 }}>{p2.name || p2.email}</span>
              <span style={{ color: 'var(--muted)' }}>{p2.name ? p2.email : ''}</span>
            </label>
          ))}
          {people.length === 0 && <p style={{ color: 'var(--muted)' }}>No admins/devs found.</p>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600 }}>Send at</span>
            <select className="fld" value={cfg.hourUtc} disabled={busy} onChange={(e) => save({ hourUtc: Number(e.target.value) })}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{String(h).padStart(2, '0')}:00 UTC ({localHour(h)} local)</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={miniBtn} disabled={busy || !subs.length}
              onClick={async () => { setBusy(true); try { const r = await api.adminTicketDigestSend(); flash(`Sent to ${r.sent}`); } catch { flash('Send failed'); } setBusy(false); }}>
              Send now
            </button>
            {cfg.lastSent && <span style={{ color: 'var(--muted)', alignSelf: 'center' }}>Last sent {cfg.lastSent}</span>}
          </div>
          <p style={{ color: 'var(--muted)', fontSize: 11.5, margin: 0 }}>
            What's new, what moved, and what's waiting for review — email + push, honouring each person's notification settings (including pause).
          </p>
        </div>
      )}
    </div>
  );
}


function TicketDetail({ id, onClose, onChange }) {
  const isMobile = useIsMobile();
  const [d, setD] = useState(null);
  const [aiEdit, setAiEdit] = useState('');
  const [shipNote, setShipNote] = useState('');
  const [testUrl, setTestUrl] = useState('');
  const [note, setNote] = useState('');
  const [noteToReporter, setNoteToReporter] = useState(false);
  const [assignees, setAssignees] = useState([]);
  const [copied, setCopied] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [target, setTarget] = useState('staging'); // where "Send to GitHub" builds it
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    api.adminTicket(id).then((r) => {
      setD(r); setAiEdit(r.ticket.aiSummary || ''); setShipNote(r.ticket.shipNote || ''); setTestUrl(r.ticket.testUrl || '');
      // A dispatched ticket keeps its chosen environment (re-sends reuse it);
      // an un-sent one stays on the safe default (staging).
      if (r.ticket.githubIssue > 0) setTarget(r.ticket.target === 'production' ? 'production' : 'staging');
    }).catch((e) => setErr(e.message));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.adminTicketAssignees().then((r) => setAssignees(r.assignees || [])).catch(() => setAssignees([])); }, []);

  const t = d?.ticket;

  async function patch(body, tag) {
    setBusy(tag); setErr('');
    try { await api.adminUpdateTicket(id, body); await load(); onChange?.(); }
    catch (e) { setErr(e.message); } finally { setBusy(''); }
  }
  async function addNote() {
    if (!note.trim()) return;
    setBusy('note');
    try { await api.adminTicketComment(id, note.trim(), noteToReporter ? 'public' : 'internal'); setNote(''); await load(); }
    catch (e) { setErr(e.message); } finally { setBusy(''); }
  }
  async function redraft() {
    setBusy('redraft'); setErr('');
    try { await api.adminRedraftTicket(id); await load(); onChange?.(); }
    catch (e) { setErr(e.message); } finally { setBusy(''); }
  }
  function copyBrief() {
    if (!d?.claudeBrief) return;
    navigator.clipboard?.writeText(d.claudeBrief).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    }).catch(() => setErr('Could not copy — select and copy manually.'));
  }
  async function sendToGithub(mode) {
    setBusy(mode === 'plan' ? 'plan' : 'gh'); setErr('');
    try {
      const r = await api.adminTicketGithubIssue(id, mode, target);
      if (r.needsConfig) {
        if (r.prefillUrl) window.open(r.prefillUrl, '_blank', 'noopener');
        else setErr('Set a GitHub repo in the GitHub panel (top of the board) to link issues.');
      } else { await load(); onChange?.(); }
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  }
  async function redispatch() {
    setBusy('redis'); setErr('');
    try { await api.adminTicketRedispatch(id, target); await load(); onChange?.(); }
    catch (e) { setErr(e.message); } finally { setBusy(''); }
  }
  async function promote() {
    if (!window.confirm('Promote to production?\n\nThis opens a release PR that merges the staging branch into production. Merging it ships EVERY ticket currently on staging — not just this one. (It only opens if every staged ticket has been approved by its reporter.)')) return;
    setBusy('promote'); setErr('');
    try {
      const r = await api.adminPromoteTicket(id);
      if (r.nothingToPromote) setErr('Nothing to promote — staging matches production already.');
      else if (r.releasePr?.url) { window.open(r.releasePr.url, '_blank', 'noopener'); await load(); onChange?.(); }
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  }
  async function del() {
    if (!window.confirm('Delete this ticket permanently? This can’t be undone.')) return;
    setBusy('del'); setErr('');
    try { await api.adminDeleteTicket(id); onChange?.(); onClose(); }
    catch (e) { setErr(e.message); setBusy(''); }
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: isMobile ? 'flex-end' : 'center', justifyContent: 'center', padding: isMobile ? 0 : 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: '100%', maxWidth: isMobile ? 'none' : 640, background: 'var(--card)',
        borderRadius: isMobile ? '18px 18px 0 0' : 16, border: '1px solid var(--hairline)',
        maxHeight: isMobile ? '94dvh' : '90vh', overflowY: 'auto', paddingBottom: 'env(safe-area-inset-bottom)',
      }}>
        {!t ? <div style={{ padding: 24, color: 'var(--muted)' }}>Loading…</div> : (
          <div style={{ padding: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 6 }}>
              <h3 style={{ fontSize: 17, fontWeight: 700, lineHeight: 1.3 }}>
                {TYPE_ICON[t.type]} {t.aiTitle || t.title || '(untitled)'}
              </h3>
              <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', fontSize: 24, color: 'var(--muted)', cursor: 'pointer', lineHeight: 1 }}>×</button>
            </div>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
              {t.screen || 'unknown screen'} · {t.type} · {t.urgency} urgency{t.status === 'approved' ? ' · 🚀 live in production' : t.githubIssue > 0 ? ` · ${t.target === 'production' ? '🚀 production' : '🧪 staging'}` : ''} · by {t.reporterName || t.reporterEmail}
              {t.entityName ? ` (${t.entityName})` : ''}
            </p>
            {t.tileName && (
              <p style={{ fontSize: 12.5, marginBottom: 14, marginTop: -8 }}>
                <span style={{ fontWeight: 700 }}>▦ Affected tile:</span> {t.tileName}
              </p>
            )}

            {t.clientVerdict === 'rejected' && (
              <div style={{ ...banner, background: 'rgba(var(--brand-rgb), 0.1)', border: '1px solid var(--brand)' }}>
                <strong>↩️ Sent back by the reporter.</strong> They said: “{t.clientVerdictNote}”. Fix it and move it back through the board — the Copy-for-Claude brief leads with this.
                {/* One-tap rework: the refreshed brief (leading with their notes) rides
                    an @claude comment on the SAME issue — no duplicate issue. */}
                {t.status === 'rejected' && t.githubIssue > 0 && (
                  <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button onClick={redispatch} disabled={!!busy} style={primaryBtn}>{busy === 'redis' ? 'Re-sending…' : '🔁 Re-send to Claude'}</button>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>Posts the updated brief on issue #{t.githubIssue} → {t.target === 'production' ? '🚀 production' : '🧪 staging'}</span>
                  </div>
                )}
              </div>
            )}
            {t.clientVerdict === 'approved' && (
              <div style={{ ...banner, background: 'rgba(128,128,128,0.1)', border: '1px solid var(--hairline)' }}>
                ✅ <strong>Approved by the reporter</strong>{t.clientVerdictAt ? ` on ${new Date(t.clientVerdictAt).toLocaleDateString()}` : ''}.
              </div>
            )}
            {t.status === 'declined' && (
              <div style={{ ...banner, background: 'rgba(128,128,128,0.1)', border: '1px solid var(--hairline)' }}>
                🚫 <strong>Declined.</strong>{t.declineReason ? ` ${t.declineReason}` : ''}
              </div>
            )}

            {/* Status + assignee controls */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
              <label style={ctl}>
                <span style={ctlLbl}>Status</span>
                <select className="fld" value={t.status} disabled={busy === 'status'}
                  onChange={(e) => { const v = e.target.value; if (v === 'declined') { setDeclineReason(t.declineReason || ''); setDeclining(true); } else patch({ status: v }, 'status'); }} style={{ minWidth: 130 }}>
                  {ALL_STATUSES.map((s) => (
                    <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                  ))}
                </select>
              </label>
              <label style={ctl}>
                <span style={ctlLbl}>Assignee</span>
                <select className="fld" value={t.assignee || ''} disabled={busy === 'assignee'}
                  onChange={(e) => patch({ assignee: e.target.value }, 'assignee')} style={{ minWidth: 170 }}>
                  <option value="">Unassigned</option>
                  {/* A previously-set assignee who is no longer a dev/admin still shows. */}
                  {t.assignee && !assignees.some((a) => a.email === t.assignee) && <option value={t.assignee}>{t.assignee}</option>}
                  {assignees.map((a) => (
                    <option key={a.email} value={a.email}>{a.name || a.email}{a.isDev && !a.isAdmin ? ' (dev)' : ''}</option>
                  ))}
                </select>
              </label>
              {t.type === 'bug' && (
                <label style={ctl}>
                  <span style={ctlLbl}>Urgency</span>
                  <select className="fld" value={t.urgency} onChange={(e) => patch({ urgency: e.target.value }, 'urgency')}>
                    {['low', 'normal', 'high', 'urgent'].map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </label>
              )}
            </div>

            {/* Decline needs a reason — the reporter is told why. */}
            {declining && (
              <div style={{ ...banner, background: 'rgba(var(--brand-rgb), 0.06)', border: '1px solid var(--hairline)' }}>
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>Decline this report — add a reason</div>
                <textarea className="fld" value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} rows={2} autoFocus
                  placeholder="Why isn't this going forward? The reporter is notified with this." style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, resize: 'vertical', marginBottom: 8 }} />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => { patch({ status: 'declined', declineReason: declineReason.trim() }, 'status'); setDeclining(false); }} disabled={busy === 'status' || !declineReason.trim()} style={primaryBtn}>Decline & notify</button>
                  <button onClick={() => setDeclining(false)} style={miniBtn}>Cancel</button>
                </div>
              </div>
            )}

            {/* What the reporter wrote */}
            <Section title="Reported">
              <p style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.5 }}>{t.body || '(no description)'}</p>
            </Section>

            {/* Attachments the reporter added (screenshot / image / video) */}
            {(t.attachments || []).length > 0 && (
              <Section title={`Attachments (${t.attachments.length})`}>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {t.attachments.map((a) => (
                    a.mime?.startsWith('video/') ? (
                      <video key={a.id} src={a.url} controls style={{ width: 200, borderRadius: 8, border: '1px solid var(--hairline)' }} />
                    ) : (
                      <a key={a.id} href={a.url} target="_blank" rel="noreferrer" title={a.name}>
                        <img src={a.url} alt={a.name} style={{ width: 100, height: 100, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--hairline)' }} />
                      </a>
                    )
                  ))}
                </div>
              </Section>
            )}

            {/* AI-structured ticket (editable) */}
            <Section title={
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                AI ticket
                <span style={{ fontSize: 11, fontWeight: 400, color: t.aiStatus === 'error' ? 'var(--error,#ef4444)' : 'var(--muted)' }}
                  title={t.aiStatus === 'error' && t.aiError ? t.aiError : undefined}>
                  {t.aiStatus === 'ready' ? 'drafted' : t.aiStatus === 'pending' ? 'drafting…' : t.aiStatus === 'error' ? 'failed' : 'not drafted'}
                </span>
                <button onClick={redraft} disabled={busy === 'redraft'} style={miniBtn}>{busy === 'redraft' ? '…' : '↻ Redraft'}</button>
              </span>
            }>
              {t.aiStatus === 'error' && t.aiError && (
                <div style={{ fontSize: 12, color: 'var(--error,#ef4444)', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 8, padding: '7px 10px', marginBottom: 8 }}>
                  <b>Draft failed:</b> {t.aiError}
                </div>
              )}
              <textarea className="fld" value={aiEdit} onChange={(e) => setAiEdit(e.target.value)} rows={10}
                placeholder="The AI draft of this ticket will appear here."
                style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, resize: 'vertical', fontFamily: 'ui-monospace, monospace' }} />
              {aiEdit !== (t.aiSummary || '') && (
                <button onClick={() => patch({ aiSummary: aiEdit }, 'ai')} disabled={busy === 'ai'} style={{ ...miniBtn, marginTop: 6 }}>Save edits</button>
              )}
            </Section>

            {/* Hand-off: pick where it builds (staging vs production), then copy the
                brief or file it as a GitHub issue. Once on staging + verified, promote. */}
            {!t.githubUrl && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '4px 0 8px' }}>
                <span style={ctlLbl}>Build into</span>
                <div style={{ display: 'inline-flex', border: '1px solid var(--hairline)', borderRadius: 8, overflow: 'hidden' }}>
                  {[['staging', '🧪 Staging (test first)'], ['production', '🚀 Production (live)']].map(([v, lbl]) => (
                    <button key={v} onClick={() => setTarget(v)} style={{
                      padding: '5px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none',
                      background: target === v ? 'var(--brand)' : 'transparent', color: target === v ? '#fff' : 'var(--text)',
                    }}>{lbl}</button>
                  ))}
                </div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '0 0 16px' }}>
              <button onClick={copyBrief} style={primaryBtn}>{copied ? '✓ Copied build brief' : '📋 Copy for Claude'}</button>
              {t.githubUrl ? (
                <a href={t.githubUrl} target="_blank" rel="noreferrer" style={{ ...ghBtn, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>🐙 Issue #{t.githubIssue} · {t.target === 'production' ? '🚀 prod' : '🧪 staging'} ↗</a>
              ) : (
                <>
                  <button onClick={() => sendToGithub()} disabled={!!busy} style={ghBtn}>{busy === 'gh' ? 'Creating…' : `🐙 Send to ${target === 'production' ? 'production' : 'staging'}`}</button>
                  <button onClick={() => sendToGithub('plan')} disabled={!!busy} style={ghBtn} title="Claude posts an implementation plan + questions first and waits for your go-ahead — good for big/fuzzy tickets">{busy === 'plan' ? 'Creating…' : '🧭 Plan with Claude first'}</button>
                </>
              )}
              {t.prUrl && <a href={t.prUrl} target="_blank" rel="noreferrer" style={{ ...ghBtn, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>🔀 PR #{t.prNumber} ↗</a>}
            </div>

            {/* On staging → the REPORTER verifies (approve in My reports) → promote.
                Release-train: ships everything on staging, so promotion is blocked
                (here and server-side) until every staged ticket is approved. */}
            {t.status === 'staging' && (
              <div style={{ ...banner, background: 'rgba(var(--brand-rgb), 0.06)', border: '1px solid var(--hairline)' }}>
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>🧪 On staging{t.clientVerdict === 'approved' ? ' — verified by the reporter ✅' : ' — waiting for the reporter to verify'}</div>
                <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 8px' }}>
                  {t.clientVerdict === 'approved'
                    ? <>The reporter tested it on staging and approved. Promote when ready — the release PR ships <b>everything</b> currently on staging (each ticket must be approved).</>
                    : <>The reporter has been asked to test it on the staging site and approve it. Promotion unlocks once they do — unverified work can't ship to production.</>}
                </p>
                <button onClick={promote} disabled={busy === 'promote' || t.clientVerdict !== 'approved'} title={t.clientVerdict !== 'approved' ? 'Blocked until the reporter approves it on staging' : undefined}
                  style={{ ...primaryBtn, ...(t.clientVerdict !== 'approved' ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}>
                  {busy === 'promote' ? 'Opening release…' : t.clientVerdict === 'approved' ? '🚀 Promote to production' : '🔒 Promote (awaiting reporter approval)'}
                </button>
              </div>
            )}

            {/* Ship to the reporter: the overview + test link that ride the "Shipped"
                notification. Fill these, then set Status → Shipped to send it. */}
            <Section title="Ship to the reporter">
              <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: -2, marginBottom: 8 }}>
                Once built, fill this in and set <strong>Status → Shipped</strong>. The reporter is notified with this overview and can approve it or send it back.
              </p>
              <label style={ctlLbl}>What was built (overview)</label>
              <textarea className="fld" value={shipNote} onChange={(e) => setShipNote(e.target.value)} rows={3}
                placeholder="Plain-language summary of what you changed, for the reporter to check."
                style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, resize: 'vertical', marginBottom: 8 }} />
              <label style={ctlLbl}>Test link</label>
              <input className="fld" value={testUrl} onChange={(e) => setTestUrl(e.target.value)} placeholder="https://…"
                style={{ width: '100%', boxSizing: 'border-box', marginBottom: 8 }} />
              {(shipNote !== (t.shipNote || '') || testUrl !== (t.testUrl || '')) && (
                <button onClick={() => patch({ shipNote, testUrl }, 'ship')} disabled={busy === 'ship'} style={miniBtn}>Save</button>
              )}
            </Section>

            {/* Activity: full trail. Comments are internal notes by default; ticking
                "reply to reporter" makes it public — it lands in their conversation
                (Product → My reports) and notifies them (push + inbox mirror). */}
            <Section title="Activity">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
                {(d.comments || []).length === 0 && <p style={{ color: 'var(--muted)', fontSize: 12 }}>No activity yet.</p>}
                {(d.comments || []).map((c) => (
                  <div key={c.id} style={{ fontSize: 12 }}>
                    <span style={{ color: 'var(--muted)' }}>
                      {c.kind === 'status' ? '↪' : '💬'} {c.authorRole === 'reporter' ? `${c.authorEmail} (reporter)` : c.authorEmail} · {new Date(c.createdAt).toLocaleString()}
                      {c.kind === 'comment' && (
                        <span style={{ ...chip, marginLeft: 6, ...(c.visibility === 'public' ? { color: 'var(--brand)', background: 'rgba(var(--brand-rgb), 0.12)' } : { color: 'var(--muted)', background: 'rgba(128,128,128,0.12)' }) }}>
                          {c.visibility === 'public' ? '👁 reporter sees this' : 'internal'}
                        </span>
                      )}
                    </span>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input className="fld" value={note} onChange={(e) => setNote(e.target.value)} placeholder={noteToReporter ? 'Reply to the reporter…' : 'Add an internal note…'} style={{ flex: 1 }}
                  onKeyDown={(e) => e.key === 'Enter' && addNote()} />
                <button onClick={addNote} disabled={busy === 'note' || !note.trim()} style={miniBtn}>{noteToReporter ? 'Send' : 'Add'}</button>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 12, color: 'var(--muted)', cursor: 'pointer' }}>
                <input type="checkbox" checked={noteToReporter} onChange={(e) => setNoteToReporter(e.target.checked)} />
                Reply to the reporter (they'll see it and get notified) — unticked = internal note
              </label>
            </Section>

            {err && <p style={{ color: 'var(--brand)', fontSize: 13, marginTop: 10 }}>{err}</p>}

            <div style={{ borderTop: '1px solid var(--hairline)', marginTop: 16, paddingTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={del} disabled={busy === 'del'} style={{ ...miniBtn, color: 'var(--brand)', borderColor: 'var(--brand)' }}>{busy === 'del' ? 'Deleting…' : '🗑 Delete ticket'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

const chip = { fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 6, textTransform: 'capitalize' };
const banner = { fontSize: 13, lineHeight: 1.45, padding: '10px 12px', borderRadius: 10, marginBottom: 14 };
const ctl = { display: 'flex', flexDirection: 'column', gap: 3 };
const ctlLbl = { fontSize: 11, color: 'var(--muted)', fontWeight: 600 };
const miniBtn = { padding: '5px 10px', borderRadius: 8, border: '1px solid var(--hairline)', background: 'transparent', color: 'var(--text)', fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const primaryBtn = { padding: '9px 14px', borderRadius: 10, border: 'none', background: 'var(--brand)', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer' };
const ghBtn = { padding: '9px 14px', borderRadius: 10, border: '1px solid var(--hairline)', background: 'transparent', color: 'var(--text)', fontWeight: 600, fontSize: 14, cursor: 'pointer' };
function pill(active) {
  return {
    padding: '6px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
    textTransform: 'capitalize', border: `1px solid ${active ? 'var(--brand)' : 'var(--hairline)'}`,
    background: active ? 'rgba(var(--brand-rgb), 0.12)' : 'transparent', color: active ? 'var(--brand)' : 'var(--text)',
  };
}
