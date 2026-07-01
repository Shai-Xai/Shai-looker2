// Client self-service: "My reports" — the bugs, improvements and ideas this user
// has submitted (via the floating Report widget), with their live status so they
// can see what happened. Read-only tracking; new reports are filed from the widget.
import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';

const TYPE_ICON = { bug: '🐞', improvement: '✨', idea: '💡' };
const STATUS_STYLE = {
  shipped: { color: '#fff', background: 'var(--brand)' },
  declined: { color: 'var(--muted)', background: 'rgba(128,128,128,0.14)' },
};
const statusStyle = (s) => STATUS_STYLE[s] || { color: 'var(--text)', background: 'rgba(var(--brand-rgb), 0.12)' };

export default function MyReports() {
  const [tickets, setTickets] = useState(null);
  const [open, setOpen] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.myTickets().then((r) => setTickets(r.tickets || [])).catch((e) => setError(e.message));
  }, []);

  return (
    <div style={{ maxWidth: 720 }}>
      <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>My reports</h2>
      <p style={{ color: 'var(--muted)', fontSize: 14, marginBottom: 16 }}>
        Bugs, improvements and ideas you've sent us — and where they are. Use the 💬 button
        (bottom-left of any screen) to report something new.
      </p>

      {error && <p style={{ color: 'var(--brand)', fontSize: 13 }}>{error}</p>}
      {!tickets ? <p style={{ color: 'var(--muted)' }}>Loading…</p> : tickets.length === 0 ? (
        <p style={{ color: 'var(--muted)', fontSize: 14 }}>You haven't reported anything yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {tickets.map((t) => (
            <div key={t.id} style={{ border: '1px solid var(--hairline)', borderRadius: 12, padding: 14, background: 'var(--card)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>
                  {TYPE_ICON[t.type] || '📝'} {t.aiTitle || t.title || '(untitled)'}
                </span>
                <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 7, ...statusStyle(t.status) }}>{t.statusLabel}</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
                {t.screen || 'unknown screen'} · {new Date(t.createdAt).toLocaleDateString()}
              </div>
              {(t.body || t.aiSummary) && (
                <button onClick={() => setOpen(open === t.id ? null : t.id)} style={{ background: 'none', border: 'none', color: 'var(--brand)', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: 0 }}>
                  {open === t.id ? 'Hide details' : 'View details'}
                </button>
              )}
              {open === t.id && (
                <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.5 }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>What you reported</div>
                  <p style={{ whiteSpace: 'pre-wrap', marginBottom: t.aiSummary ? 10 : 0 }}>{t.body || '(no description)'}</p>
                  {t.aiStatus === 'ready' && t.aiSummary && (
                    <>
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>How we've framed it</div>
                      <p style={{ whiteSpace: 'pre-wrap', color: 'var(--muted)' }}>{t.aiSummary}</p>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
