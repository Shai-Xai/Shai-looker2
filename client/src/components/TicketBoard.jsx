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
const BOARD_LANES = ['inbox', 'triaged', 'accepted', 'in_progress', 'shipped', 'rejected'];
const ALL_STATUSES = ['inbox', 'triaged', 'accepted', 'in_progress', 'shipped', 'approved', 'rejected', 'declined'];
const STATUS_LABEL = { inbox: 'New', triaged: 'Triaged', accepted: 'Accepted', in_progress: 'In progress', shipped: 'Shipped — awaiting review', approved: 'Approved', rejected: 'Rejected — reopen', declined: 'Declined' };

export default function TicketBoard() {
  const isMobile = useIsMobile();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [lane, setLane] = useState('inbox'); // mobile: which lane is shown
  const [openId, setOpenId] = useState(null);

  const load = useCallback(() => {
    api.adminTickets(typeFilter ? { type: typeFilter } : {})
      .then(setData).catch((e) => setError(e.message));
  }, [typeFilter]);
  useEffect(() => { load(); }, [load]);

  const labels = data?.labels || {};
  const counts = data?.counts || {};
  const byLane = (l) => (data?.tickets || []).filter((t) => t.status === l);
  const terminal = [];
  if (counts.approved) terminal.push(`${counts.approved} approved ✅`);
  if (counts.declined) terminal.push(`${counts.declined} declined`);

  function afterChange() { load(); }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em' }}>🎟️ Tickets</h2>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>Bugs, improvements and ideas from the team and clients — triage, build, ship.</p>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {['', 'bug', 'improvement', 'idea'].map((t) => (
            <button key={t || 'all'} onClick={() => setTypeFilter(t)} style={pill(typeFilter === t)}>
              {t ? `${TYPE_ICON[t]} ${t}` : 'All'}
            </button>
          ))}
        </div>
      </div>

      <GithubConfig />

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
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const refresh = () => api.getGithubConfig().then((c) => { setCfg(c); setRepo(c.repo || ''); }).catch(() => {});
  useEffect(() => { refresh(); }, []);
  async function save() {
    setBusy(true); setMsg('');
    try { const c = await api.saveGithubConfig({ repo, ...(token ? { token } : {}) }); setCfg(c); setToken(''); setMsg('Saved'); setTimeout(() => setMsg(''), 1500); }
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
          <label style={ctlLbl}>Access token {cfg.tokenSet ? `(set: ${cfg.tokenMask} — blank keeps it)` : '(fine-grained PAT · Issues: write)'}</label>
          <input className="fld" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={cfg.tokenSet ? '•••• leave blank to keep' : 'github_pat_…'} autoComplete="off" />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={save} disabled={busy} style={primaryBtn}>{busy ? 'Saving…' : 'Save'}</button>
            {cfg.tokenSet && <button onClick={async () => { await api.saveGithubConfig({ clearToken: true }); refresh(); }} style={miniBtn}>Remove token</button>}
            {msg && <span style={{ color: 'var(--muted)' }}>{msg}</span>}
          </div>
          <p style={{ color: 'var(--muted)', fontSize: 11.5, margin: 0 }}>No token → "Send to GitHub" opens a prefilled new-issue page in your browser. With a token → the app creates + links the issue automatically.</p>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span>{TYPE_ICON[t.type] || '📝'}</span>
        {t.type === 'bug' && <span style={{ ...chip, ...u }}>{t.urgency}</span>}
        {t.aiStatus === 'ready' && <span style={{ ...chip, color: 'var(--muted)', background: 'rgba(128,128,128,0.1)' }}>AI ✓</span>}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, lineHeight: 1.3 }}>
        {t.aiTitle || t.title || '(untitled)'}
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)' }}>
        {t.screen || 'unknown'}{t.entityName ? ` · ${t.entityName}` : ''}
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
        {t.reporterName || t.reporterEmail}{t.assignee ? ` → ${t.assignee}` : ''}
      </div>
    </button>
  );
}

function TicketDetail({ id, onClose, onChange }) {
  const isMobile = useIsMobile();
  const [d, setD] = useState(null);
  const [aiEdit, setAiEdit] = useState('');
  const [shipNote, setShipNote] = useState('');
  const [testUrl, setTestUrl] = useState('');
  const [note, setNote] = useState('');
  const [assignees, setAssignees] = useState([]);
  const [copied, setCopied] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    api.adminTicket(id).then((r) => {
      setD(r); setAiEdit(r.ticket.aiSummary || ''); setShipNote(r.ticket.shipNote || ''); setTestUrl(r.ticket.testUrl || '');
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
    try { await api.adminTicketComment(id, note.trim()); setNote(''); await load(); }
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
  async function sendToGithub() {
    setBusy('gh'); setErr('');
    try {
      const r = await api.adminTicketGithubIssue(id);
      if (r.needsConfig) {
        if (r.prefillUrl) window.open(r.prefillUrl, '_blank', 'noopener');
        else setErr('Set a GitHub repo in the GitHub panel (top of the board) to link issues.');
      } else { await load(); onChange?.(); }
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
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
              {t.screen || 'unknown screen'} · {t.type} · {t.urgency} urgency · by {t.reporterName || t.reporterEmail}
              {t.entityName ? ` (${t.entityName})` : ''}
            </p>

            {t.clientVerdict === 'rejected' && (
              <div style={{ ...banner, background: 'rgba(var(--brand-rgb), 0.1)', border: '1px solid var(--brand)' }}>
                <strong>↩️ Sent back by the reporter.</strong> They said: “{t.clientVerdictNote}”. Fix it and move it back through the board — the Copy-for-Claude brief leads with this.
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
                <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--muted)' }}>
                  {t.aiStatus === 'ready' ? 'drafted' : t.aiStatus === 'pending' ? 'drafting…' : t.aiStatus === 'error' ? 'failed' : 'not drafted'}
                </span>
                <button onClick={redraft} disabled={busy === 'redraft'} style={miniBtn}>{busy === 'redraft' ? '…' : '↻ Redraft'}</button>
              </span>
            }>
              <textarea className="fld" value={aiEdit} onChange={(e) => setAiEdit(e.target.value)} rows={10}
                placeholder="The AI draft of this ticket will appear here."
                style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, resize: 'vertical', fontFamily: 'ui-monospace, monospace' }} />
              {aiEdit !== (t.aiSummary || '') && (
                <button onClick={() => patch({ aiSummary: aiEdit }, 'ai')} disabled={busy === 'ai'} style={{ ...miniBtn, marginTop: 6 }}>Save edits</button>
              )}
            </Section>

            {/* Hand-off: copy the brief, or file it as a GitHub issue */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '4px 0 16px' }}>
              <button onClick={copyBrief} style={primaryBtn}>{copied ? '✓ Copied build brief' : '📋 Copy for Claude'}</button>
              {t.githubUrl ? (
                <a href={t.githubUrl} target="_blank" rel="noreferrer" style={{ ...ghBtn, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>🐙 Issue #{t.githubIssue} ↗</a>
              ) : (
                <button onClick={sendToGithub} disabled={busy === 'gh'} style={ghBtn}>{busy === 'gh' ? 'Creating…' : '🐙 Send to GitHub'}</button>
              )}
            </div>

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

            {/* Activity */}
            <Section title="Activity">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
                {(d.comments || []).length === 0 && <p style={{ color: 'var(--muted)', fontSize: 12 }}>No activity yet.</p>}
                {(d.comments || []).map((c) => (
                  <div key={c.id} style={{ fontSize: 12 }}>
                    <span style={{ color: 'var(--muted)' }}>{c.kind === 'status' ? '↪' : '💬'} {c.authorEmail} · {new Date(c.createdAt).toLocaleString()}</span>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input className="fld" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note…" style={{ flex: 1 }}
                  onKeyDown={(e) => e.key === 'Enter' && addNote()} />
                <button onClick={addNote} disabled={busy === 'note' || !note.trim()} style={miniBtn}>Add</button>
              </div>
            </Section>

            {err && <p style={{ color: 'var(--brand)', fontSize: 13, marginTop: 10 }}>{err}</p>}
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
