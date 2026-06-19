import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';
import { pushSupported, isSubscribed, enablePush, disablePush } from '../lib/push.js';

// iOS-style on/off pill.
function Switch({ on, busy }) {
  return (
    <span style={{ width: 36, height: 21, borderRadius: 999, background: on ? 'var(--brand)' : 'rgba(128,128,128,0.35)', position: 'relative', flexShrink: 0, transition: 'background 0.15s', opacity: busy ? 0.5 : 1 }}>
      <span style={{ position: 'absolute', top: 2, left: on ? 17 : 2, width: 17, height: 17, borderRadius: '50%', background: '#fff', transition: 'left 0.15s', boxShadow: '0 1px 2px rgba(0,0,0,0.3)' }} />
    </span>
  );
}

// Shared notification channel preferences (email + push), used in BOTH the
// sidebar profile menu (compact) and the client Settings page (card). Per-user,
// device-aware. On iOS Safari, push can't be delivered (only the installed app
// can), so we guide instead of showing a toggle that lies.
export default function NotificationPrefs({ compact = false }) {
  const [n, setN] = useState({ loaded: false, supported: false, pushAvailable: false, email: true, push: false, deviceOn: false, busy: '', testing: false });

  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  const iosNeedsInstall = isIOS && !standalone;

  const load = async () => {
    const supported = pushSupported();
    const [prefs, deviceOn] = await Promise.all([
      api.getNotifPrefs().catch(() => ({ email: true, push: true, pushAvailable: false })),
      supported ? isSubscribed() : Promise.resolve(false),
    ]);
    setN((s) => ({ ...s, loaded: true, supported, pushAvailable: !!prefs.pushAvailable, email: prefs.email !== false, push: prefs.push !== false, deviceOn }));
  };
  useEffect(() => { load(); }, []);

  const toggleEmail = async () => {
    const next = !n.email;
    setN((s) => ({ ...s, busy: 'email', email: next }));
    try { await api.setNotifPrefs({ email: next }); } catch { setN((s) => ({ ...s, email: !next })); }
    setN((s) => ({ ...s, busy: '' }));
  };
  const togglePush = async () => {
    const turningOn = !(n.push && n.deviceOn);
    setN((s) => ({ ...s, busy: 'push' }));
    try {
      if (turningOn) { await enablePush(); await api.setNotifPrefs({ push: true }); setN((s) => ({ ...s, push: true, deviceOn: true, busy: '' })); }
      else { await disablePush(); await api.setNotifPrefs({ push: false }); setN((s) => ({ ...s, push: false, deviceOn: false, busy: '' })); }
    } catch (e) {
      setN((s) => ({ ...s, busy: '' }));
      alert(iosNeedsInstall
        ? 'On iPhone/iPad, first tap the Share button and "Add to Home Screen", then open Pulse from your home screen to enable push.'
        : (e.message || 'Could not enable push.'));
    }
  };
  const test = async () => {
    setN((s) => ({ ...s, testing: true }));
    try {
      const r = await api.pushTest();
      alert(r.sent
        ? `Sent to ${r.sent} device${r.sent === 1 ? '' : 's'} ✓\n\nIf you don't see it, lock your phone or switch apps — iOS hides the banner while Pulse is open.`
        : 'No devices are registered yet. Turn Push off and on again on the installed app.');
    } catch { alert('Test failed — try turning Push off and on again.'); }
    setN((s) => ({ ...s, testing: false }));
  };

  if (!n.loaded) return <div style={{ color: 'var(--muted)', fontSize: 13, padding: compact ? '8px 10px' : 12 }}>Loading…</div>;

  const Row = ({ icon, label, sub, right, onClick, disabled }) => (
    <button className="nav-row" onClick={onClick} disabled={disabled}
      style={{ display: 'flex', alignItems: sub ? 'flex-start' : 'center', gap: 10, width: '100%', textAlign: 'left', border: 'none', cursor: disabled ? 'default' : 'pointer',
        background: 'transparent', color: 'var(--text)', padding: compact ? '9px 10px' : '11px 12px', borderRadius: compact ? 8 : 10, fontSize: 13, fontWeight: 600,
        borderBottom: compact ? 'none' : '1px solid var(--hairline)' }}>
      <span style={{ width: 20, textAlign: 'center', fontSize: 15, flexShrink: 0 }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}{sub && <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400, marginTop: 1 }}>{sub}</div>}</span>
      {right}
    </button>
  );

  const pushRow = !n.pushAvailable ? null
    : iosNeedsInstall ? (
        <Row icon="🔔" label="Push" sub="Add Pulse to your Home Screen to enable"
          right={<span style={{ fontSize: 13, color: 'var(--muted)' }}>ⓘ</span>}
          onClick={() => alert('To get push notifications on iPhone/iPad:\n\n1. Tap the Share button\n2. Choose “Add to Home Screen”\n3. Open Pulse from the new icon\n\nThen turn on Push from here.')} />
      ) : n.supported ? (
        <Row icon="🔔" label="Push (this device)" onClick={togglePush} disabled={n.busy === 'push'}
          right={<Switch on={n.push && n.deviceOn} busy={n.busy === 'push'} />} />
      ) : (
        <Row icon="🔔" label="Push" sub="Not supported in this browser" right={null} disabled />
      );

  return (
    <div style={compact ? {} : { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', maxWidth: 520 }}>
      <Row icon="✉️" label="Email" onClick={toggleEmail} disabled={n.busy === 'email'} right={<Switch on={n.email} busy={n.busy === 'email'} />} />
      {pushRow}
      {n.supported && n.pushAvailable && n.push && n.deviceOn && !iosNeedsInstall && (
        <Row icon="📨" label={n.testing ? 'Sending…' : 'Send a test notification'} onClick={test} disabled={n.testing} right={null} />
      )}
    </div>
  );
}
