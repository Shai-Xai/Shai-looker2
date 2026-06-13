import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { pushSupported, pushPermission, isSubscribed, enablePush } from '../lib/push.js';

// App-wide notifier (mounted for admins AND clients): a transient toast when a
// new inbox message/approval arrives, plus a one-time nudge to turn on browser
// notifications. Scope: a client (or admin acting as one) watches their entity;
// an admin in the console watches everything (entityId undefined).
export default function InboxNotifier({ entityId }) {
  const navigate = useNavigate();
  const [toast, setToast] = useState(null);
  const [nudge, setNudge] = useState(false);
  const prev = useRef(null);

  useEffect(() => {
    prev.current = null; // re-baseline when the watched scope changes
    let alive = true;
    const poll = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const r = await api.osInbox(entityId || undefined);
        if (!alive) return;
        if (prev.current != null && r.unread > prev.current) setToast({ msg: '💬 New message in your inbox', to: '/inbox' });
        prev.current = r.unread;
      } catch { /* ignore */ }
    };
    poll();
    const t = setInterval(poll, 20000);
    const onVis = () => { if (document.visibilityState === 'visible') poll(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    window.addEventListener('os-refresh', poll);
    return () => { alive = false; clearInterval(t); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('focus', onVis); window.removeEventListener('os-refresh', poll); };
  }, [entityId]);

  useEffect(() => { if (!toast) return; const x = setTimeout(() => setToast(null), 6000); return () => clearTimeout(x); }, [toast]);

  useEffect(() => {
    if (!pushSupported() || pushPermission() !== 'default') return;
    if (localStorage.getItem('howler_push_nudge_dismissed') === '1') return;
    let alive = true;
    isSubscribed().then((s) => { if (alive && !s) setNudge(true); });
    return () => { alive = false; };
  }, []);
  const dismissNudge = () => { localStorage.setItem('howler_push_nudge_dismissed', '1'); setNudge(false); };
  const turnOn = async () => {
    try { await enablePush(); setNudge(false); setToast({ msg: '🔔 Notifications on for this device', to: '' }); }
    catch (e) { alert(e.message || 'Could not enable notifications.'); }
  };

  return (
    <>
      {nudge && (
        <div style={nudgeBar} className="modal-in">
          <span style={{ fontSize: 15 }}>🔔</span>
          <span style={{ flex: 1, minWidth: 0 }}>Turn on notifications to be alerted about messages and campaign approvals — even when Pulse is closed.</span>
          <button onClick={turnOn} style={nudgeBtn}>Turn on</button>
          <button onClick={dismissNudge} aria-label="Dismiss" style={nudgeX}>✕</button>
        </div>
      )}
      {toast && (
        <button onClick={() => { const to = toast.to; setToast(null); if (to) navigate(to); }} className="modal-in" style={{ ...toastStyle, cursor: toast.to ? 'pointer' : 'default' }}>
          <span style={{ flex: 1 }}>{toast.msg}</span>
          {toast.to && <span style={{ opacity: 0.8, flexShrink: 0 }}>Open →</span>}
        </button>
      )}
    </>
  );
}

const nudgeBar = { position: 'fixed', top: 64, left: '50%', transform: 'translateX(-50%)', zIndex: 60, display: 'flex', alignItems: 'center', gap: 10, width: 'min(94vw, 560px)', padding: '9px 14px', borderRadius: 12, background: 'var(--card)', border: '1px solid var(--hairline)', boxShadow: '0 8px 30px rgba(0,0,0,0.18)', fontSize: 13, color: 'var(--text)' };
const nudgeBtn = { flexShrink: 0, border: 'none', background: 'var(--brand)', color: '#fff', borderRadius: 980, padding: '6px 14px', fontWeight: 700, fontSize: 12.5, cursor: 'pointer' };
const nudgeX = { flexShrink: 0, border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 16 };
const toastStyle = { position: 'fixed', left: '50%', bottom: 'calc(20px + env(safe-area-inset-bottom))', transform: 'translateX(-50%)', zIndex: 60, display: 'flex', alignItems: 'center', gap: 8, maxWidth: 'min(92vw, 420px)', border: 'none', textAlign: 'left', padding: '11px 16px', borderRadius: 12, background: 'var(--text)', color: 'var(--bg)', fontSize: 13.5, fontWeight: 600, boxShadow: '0 8px 30px rgba(0,0,0,0.28)' };
