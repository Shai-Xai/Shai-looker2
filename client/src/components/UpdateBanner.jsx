import { useState, useEffect } from 'react';
import { onAppUpdate, startUpdateWatch } from '../lib/appUpdate.js';

// A calm "a new version is ready" toast. Fires when a new build is deployed while
// the app is open (most useful for an installed desktop/PWA window that stays
// open). Reload applies it; dismiss hides it until the next detected version.
export default function UpdateBanner() {
  const [show, setShow] = useState(false);
  useEffect(() => { startUpdateWatch(); return onAppUpdate(() => setShow(true)); }, []);
  if (!show) return null;
  return (
    <div style={bar} role="status">
      <span style={{ fontSize: 17, flexShrink: 0 }}>🎉</span>
      <span style={{ flex: 1, minWidth: 0 }}>A new version of Pulse is ready.</span>
      <button style={reloadBtn} onClick={() => window.location.reload()}>Reload</button>
      <button style={xBtn} onClick={() => setShow(false)} aria-label="Dismiss">✕</button>
    </div>
  );
}

const bar = {
  position: 'fixed', top: 'calc(64px + env(safe-area-inset-top))', left: 0, right: 0, marginLeft: 'auto', marginRight: 'auto',
  zIndex: 80, display: 'flex', alignItems: 'center', gap: 10, width: 'min(94vw, 480px)', boxSizing: 'border-box',
  padding: '9px 12px 9px 14px', borderRadius: 14, background: 'var(--glass-bg)',
  backdropFilter: 'blur(var(--glass-blur)) saturate(180%)', WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(180%)',
  border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow), inset 0 1px 0 var(--glass-hi)', fontSize: 13.5, color: 'var(--text)',
};
const reloadBtn = { flexShrink: 0, padding: '6px 14px', borderRadius: 980, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' };
const xBtn = { flexShrink: 0, border: 'none', background: 'transparent', color: 'var(--muted)', fontSize: 15, cursor: 'pointer', lineHeight: 1 };
