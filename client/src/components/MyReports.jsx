// Client self-service: "My reports" — the bugs, improvements and ideas this user
// has submitted (via the floating Report widget), with their live status. When the
// team ships one, the client reviews the overview + test link here and either
// approves it or sends it back with a reason (which reopens it for the team).
import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import ReportForm from './ReportForm.jsx';

const TYPE_ICON = { bug: '🐞', improvement: '✨', idea: '💡' };
const STATUS_STYLE = {
  shipped: { color: '#fff', background: 'var(--brand)' },
  approved: { color: '#fff', background: '#16a34a' },
  rejected: { color: 'var(--brand)', background: 'rgba(var(--brand-rgb), 0.14)' },
  declined: { color: 'var(--muted)', background: 'rgba(128,128,128,0.14)' },
};
const statusStyle = (s) => STATUS_STYLE[s] || { color: 'var(--text)', background: 'rgba(var(--brand-rgb), 0.12)' };

// The client-facing journey a report moves through (internal statuses mapped to
// plain language). 'rejected' loops back to Building; 'declined' is off-path.
const JOURNEY = [
  ['inbox', 'Submitted'],
  ['triaged', 'Reviewing'],
  ['accepted', 'Accepted'],
  ['in_progress', 'Building'],
  ['shipped', 'Ready for you'],
  ['approved', 'Done'],
];

export default function MyReports() {
  const [tickets, setTickets] = useState(null);
  const [open, setOpen] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.myTickets().then((r) => setTickets(r.tickets || [])).catch((e) => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 4 }}>
        <h2 style={{ fontSize: 17, fontWeight: 700 }}>My reports</h2>
        <button onClick={() => setFormOpen(true)} style={newBtn}>＋ New report</button>
      </div>
      <p style={{ color: 'var(--muted)', fontSize: 14, marginBottom: 10 }}>
        Bugs, improvements and ideas you've sent us — and where they are.
      </p>
      {/* Status legend: the journey every report follows. */}
      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6, background: 'rgba(128,128,128,0.06)', borderRadius: 10, padding: '10px 12px', marginBottom: 18 }}>
        <strong style={{ color: 'var(--text)' }}>How your reports move:</strong>{' '}
        {JOURNEY.map(([, label]) => label).join(' → ')}. When something's ready, you'll be asked to <b>approve</b> it or <b>send it back</b>.
      </div>

      {error && <p style={{ color: 'var(--brand)', fontSize: 13 }}>{error}</p>}
      {!tickets ? <p style={{ color: 'var(--muted)' }}>Loading…</p> : tickets.length === 0 ? (
        <p style={{ color: 'var(--muted)', fontSize: 14 }}>You haven't reported anything yet — tap <b>＋ New report</b> to send us your first.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {tickets.map((t) => (
            <ReportCard key={t.id} t={t} open={open === t.id} onToggle={() => setOpen(open === t.id ? null : t.id)} onChange={load} />
          ))}
        </div>
      )}

      <ReportForm open={formOpen} onClose={() => setFormOpen(false)} screen="Product" onSubmitted={load} />
    </div>
  );
}

// A compact progress bar showing where a report is in its journey.
function StatusTrack({ status }) {
  if (status === 'declined') return null;
  const rejected = status === 'rejected';
  const effective = rejected ? 'in_progress' : status;
  const curIdx = Math.max(0, JOURNEY.findIndex(([k]) => k === effective));
  const curLabel = (JOURNEY[curIdx] || [])[1] || '';
  return (
    <div style={{ margin: '2px 0 10px' }}>
      <div style={{ display: 'flex', gap: 3, marginBottom: 5 }}>
        {JOURNEY.map(([key], i) => (
          <div key={key} title={JOURNEY[i][1]} style={{ flex: 1, height: 5, borderRadius: 3, background: i <= curIdx ? 'var(--brand)' : 'rgba(128,128,128,0.2)' }} />
        ))}
      </div>
      <div style={{ fontSize: 11, fontWeight: 600, color: rejected ? 'var(--brand)' : 'var(--muted)' }}>
        {rejected ? `Sent back — back to “${curLabel}”` : `Now: ${curLabel}`}{status === 'shipped' ? ' — please review below' : ''}
      </div>
    </div>
  );
}

function ReportCard({ t, open, onToggle, onChange }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  async function verdict(v, note) {
    setBusy(v); setErr('');
    try { await api.ticketVerdict(t.id, { verdict: v, note }); setRejecting(false); setReason(''); onChange?.(); }
    catch (e) { setErr(e.message); } finally { setBusy(''); }
  }
  async function sendReply() {
    if (!reply.trim()) return;
    setBusy('reply'); setErr('');
    try { await api.myTicketComment(t.id, reply.trim()); setReply(''); onChange?.(); }
    catch (e) { setErr(e.message); } finally { setBusy(''); }
  }

  const awaitingReview = t.status === 'shipped';

  return (
    <div style={{ border: `1px solid ${awaitingReview ? 'var(--brand)' : 'var(--hairline)'}`, borderRadius: 12, padding: 14, background: 'var(--card)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>
          {TYPE_ICON[t.type] || '📝'} {t.aiTitle || t.title || '(untitled)'}
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 7, whiteSpace: 'nowrap', ...statusStyle(t.status) }}>{t.statusLabel}</span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
        {t.screen || 'unknown screen'}{t.tileName ? ` · ▦ ${t.tileName}` : ''} · {new Date(t.createdAt).toLocaleDateString()}
        {(t.attachments || []).length > 0 ? ` · 📎 ${t.attachments.length}` : ''}
        {(t.comments || []).length > 0 ? ` · 💬 ${t.comments.length}` : ''}
      </div>

      <StatusTrack status={t.status} />

      {/* Ship review: the payoff — overview, test link, approve / reject */}
      {awaitingReview && (
        <div style={{ background: 'rgba(var(--brand-rgb), 0.06)', border: '1px solid rgba(var(--brand-rgb), 0.2)', borderRadius: 10, padding: 12, marginBottom: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>🎉 This shipped — does it work for you?</div>
          {(t.shipNote || t.aiSummary) && <p style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.5, marginBottom: 8 }}>{t.shipNote || t.aiSummary}</p>}
          {t.testUrl && <a href={t.testUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-block', fontSize: 13, fontWeight: 600, color: 'var(--brand)', marginBottom: 10 }}>🔗 Open it to test →</a>}
          {err && <p style={{ color: 'var(--brand)', fontSize: 13, marginBottom: 8 }}>{err}</p>}
          {!rejecting ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => verdict('approved')} disabled={!!busy} style={approveBtn}>{busy === 'approved' ? 'Saving…' : '✓ Approve'}</button>
              <button onClick={() => setRejecting(true)} disabled={!!busy} style={rejectBtn}>Send back</button>
            </div>
          ) : (
            <div>
              <textarea className="fld" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} autoFocus
                placeholder="What still needs fixing? Be as specific as you can — this goes straight to the team."
                style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, resize: 'vertical', marginBottom: 8 }} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => verdict('rejected', reason.trim())} disabled={busy === 'rejected' || !reason.trim()} style={rejectBtn}>{busy === 'rejected' ? 'Sending…' : 'Send back to the team'}</button>
                <button onClick={() => { setRejecting(false); setReason(''); }} style={ghostBtn}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {t.status === 'approved' && <p style={{ fontSize: 12.5, color: '#16a34a', marginBottom: 8 }}>✓ You approved this{t.clientVerdictAt ? ` on ${new Date(t.clientVerdictAt).toLocaleDateString()}` : ''}.</p>}
      {t.status === 'rejected' && <p style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 8 }}>↩️ Sent back to the team{t.clientVerdictNote ? `: “${t.clientVerdictNote}”` : ''}.</p>}
      {t.status === 'declined' && <p style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 8 }}>🚫 Not going forward{t.declineReason ? `: “${t.declineReason}”` : '.'}</p>}

      {/* Conversation with the team — the team's replies + yours, with a reply box. */}
      {(t.comments || []).length > 0 && (
        <div style={{ marginBottom: 8 }}>
          {t.comments.map((c) => (
            <div key={c.id} style={{ marginBottom: 6, padding: '8px 10px', borderRadius: 10, fontSize: 13, lineHeight: 1.45, background: c.authorRole === 'reporter' ? 'rgba(var(--brand-rgb), 0.07)' : 'rgba(128,128,128,0.08)' }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>{c.authorRole === 'reporter' ? 'You' : 'Howler team'} · {new Date(c.createdAt).toLocaleString()}</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
            </div>
          ))}
        </div>
      )}
      {!['approved', 'declined'].includes(t.status) && (
        <div style={{ marginBottom: 8 }}>
          {err && !awaitingReview && <p style={{ color: 'var(--brand)', fontSize: 12.5, marginBottom: 6 }}>{err}</p>}
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="fld" value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Message the team about this report…" style={{ flex: 1, fontSize: 13 }}
              onKeyDown={(e) => e.key === 'Enter' && sendReply()} />
            <button onClick={sendReply} disabled={busy === 'reply' || !reply.trim()} style={{ ...ghostBtn, padding: '8px 14px', fontSize: 13 }}>{busy === 'reply' ? '…' : 'Send'}</button>
          </div>
        </div>
      )}

      {(t.body || t.aiSummary || (t.attachments || []).length > 0) && (
        <button onClick={onToggle} style={{ background: 'none', border: 'none', color: 'var(--brand)', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: 0 }}>
          {open ? 'Hide details' : 'View details'}
        </button>
      )}
      {open && (
        <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.5 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>What you reported</div>
          <p style={{ whiteSpace: 'pre-wrap', marginBottom: 10 }}>{t.body || '(no description)'}</p>
          {(t.attachments || []).length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              {t.attachments.map((a) => (
                a.mime?.startsWith('video/')
                  ? <video key={a.id} src={a.url} controls style={{ width: 180, borderRadius: 8, border: '1px solid var(--hairline)' }} />
                  : <a key={a.id} href={a.url} target="_blank" rel="noreferrer"><img src={a.url} alt={a.name} style={{ width: 90, height: 90, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--hairline)' }} /></a>
              ))}
            </div>
          )}
          {t.aiStatus === 'ready' && t.aiSummary && (
            <>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>How we've framed it</div>
              <p style={{ whiteSpace: 'pre-wrap', color: 'var(--muted)' }}>{t.aiSummary}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const newBtn = { padding: '8px 14px', borderRadius: 10, border: 'none', background: 'var(--brand)', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' };
const approveBtn = { padding: '9px 16px', borderRadius: 10, border: 'none', background: '#16a34a', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' };
const rejectBtn = { padding: '9px 16px', borderRadius: 10, border: '1px solid var(--brand)', background: 'transparent', color: 'var(--brand)', fontWeight: 600, fontSize: 14, cursor: 'pointer' };
const ghostBtn = { padding: '9px 16px', borderRadius: 10, border: '1px solid var(--hairline)', background: 'transparent', color: 'var(--text)', fontWeight: 600, fontSize: 14, cursor: 'pointer' };
