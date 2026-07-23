import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';

// Client-facing status banner — the read side of the Status Notices feature (Howler
// staff author them in Admin → Status). Polls /api/my/notices (scoped server-side to
// this user's clients), shows active incidents as a persistent severity-coloured bar
// and recently-resolved ones as a dismissible green confirmation. Tapping a row
// expands its latest update. "Just see it" — no acknowledgement is tracked; a client
// can dismiss a row locally, and a NEW update re-surfaces it (dismissal is keyed to
// the notice's updatedAt).

const SEV = {
  info: { emoji: 'ℹ️', from: '#2563eb', to: '#1d4ed8' },
  maintenance: { emoji: '🛠️', from: '#7c3aed', to: '#6d28d9' },
  degraded: { emoji: '🟠', from: '#ea580c', to: '#c2410c' },
  outage: { emoji: '🔴', from: '#dc2626', to: '#b91c1c' },
};
const STATUS_LABEL = { investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', resolved: 'Resolved' };
const DISMISS_KEY = 'howler_dismissed_notices';

const readDismissed = () => { try { return JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}'); } catch { return {}; } };
const writeDismissed = (m) => { try { localStorage.setItem(DISMISS_KEY, JSON.stringify(m)); } catch { /* private mode */ } };

export default function StatusNoticeBanner() {
  const [notices, setNotices] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [dismissed, setDismissed] = useState(readDismissed);

  const poll = useCallback(async () => {
    try { const r = await api.myNotices(); setNotices(r.notices || []); }
    catch { /* ignore — banner is best-effort */ }
  }, []);

  useEffect(() => {
    poll();
    const t = setInterval(poll, 60000);
    const onVis = () => { if (document.visibilityState === 'visible') poll(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [poll]);

  const dismiss = (n) => {
    const next = { ...dismissed, [n.id]: n.updatedAt }; // re-shows if updatedAt changes
    setDismissed(next); writeDismissed(next);
  };
  const isDismissed = (n) => dismissed[n.id] === n.updatedAt;

  const visible = notices.filter((n) => !isDismissed(n));
  if (!visible.length) return null;

  return (
    <div>
      {visible.map((n) => {
        const resolved = n.status === 'resolved';
        const sev = SEV[n.severity] || SEV.degraded;
        const grad = resolved ? 'linear-gradient(90deg, #16a34a, #15803d)' : `linear-gradient(90deg, ${sev.from}, ${sev.to})`;
        const open = expanded === n.id;
        const latest = n.latest?.body || '';
        return (
          <div key={n.id} style={{ background: grad, color: '#fff' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px' }}>
              <span style={{ fontSize: 15, flexShrink: 0 }}>{resolved ? '✅' : sev.emoji}</span>
              <button
                onClick={() => setExpanded(open ? null : n.id)}
                style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', color: '#fff', cursor: 'pointer', padding: 0, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
              >
                <span style={{ fontWeight: 700 }}>{n.title}</span>
                <span style={{ background: 'rgba(255,255,255,0.22)', borderRadius: 980, padding: '1px 9px', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
                  {resolved ? 'Resolved' : (STATUS_LABEL[n.status] || n.status)}
                </span>
                {!open && latest && (
                  <span style={{ opacity: 0.9, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>— {latest}</span>
                )}
              </button>
              <button onClick={() => setExpanded(open ? null : n.id)} title={open ? 'Hide' : 'Details'}
                style={{ background: 'rgba(255,255,255,0.22)', border: 'none', color: '#fff', borderRadius: 980, padding: '4px 11px', fontWeight: 700, fontSize: 12, cursor: 'pointer', flexShrink: 0 }}>
                {open ? 'Hide' : 'Details'}
              </button>
              {resolved && (
                <button onClick={() => dismiss(n)} title="Dismiss" style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 18, lineHeight: 1, flexShrink: 0, opacity: 0.85 }}>×</button>
              )}
            </div>
            {open && (
              <div style={{ padding: '0 16px 12px 42px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(n.updates || []).slice().reverse().map((u) => (
                  <div key={u.id} style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                    <span style={{ fontWeight: 700, opacity: 0.92 }}>{STATUS_LABEL[u.status] || u.status}</span>
                    <span style={{ opacity: 0.75 }}> · {fmtTime(u.createdAt)}</span>
                    <div style={{ opacity: 0.95, whiteSpace: 'pre-wrap' }}>{u.body}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function fmtTime(d) { const dt = new Date(d); return isNaN(dt) ? d : dt.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
