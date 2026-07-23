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
  const [n, setN] = useState({ loaded: false, supported: false, pushAvailable: false, email: true, push: false, deviceOn: false, busy: '', testing: false, types: {}, typeCatalog: [], matrix: { email: {}, push: {} }, pausedUntil: '' });
  const [pausePick, setPausePick] = useState(false); // the "pause for how long?" chooser

  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  const iosNeedsInstall = isIOS && !standalone;

  const load = async () => {
    const supported = pushSupported();
    const [prefs, deviceOn] = await Promise.all([
      api.getNotifPrefs().catch(() => ({ email: true, push: true, pushAvailable: false })),
      supported ? isSubscribed() : Promise.resolve(false),
    ]);
    setN((s) => ({ ...s, loaded: true, supported, pushAvailable: !!prefs.pushAvailable, email: prefs.email !== false, push: prefs.push !== false, deviceOn, types: prefs.types || {}, typeCatalog: prefs.typeCatalog || [], matrix: prefs.matrix || { email: {}, push: {} }, pausedUntil: prefs.pausedUntil || '' }));
  };
  useEffect(() => { load(); }, []);

  // Per-channel, per-category switch — e.g. mute goal emails but keep goal push.
  const toggleMatrix = async (channel, key) => {
    const next = !(n.matrix?.[channel]?.[key] !== false);
    const busyId = `m:${channel}:${key}`;
    setN((s) => ({ ...s, busy: busyId, matrix: { ...s.matrix, [channel]: { ...s.matrix[channel], [key]: next } } }));
    try { await api.setNotifPrefs({ matrix: { [channel]: { [key]: next } } }); }
    catch { setN((s) => ({ ...s, matrix: { ...s.matrix, [channel]: { ...s.matrix[channel], [key]: !next } } })); }
    setN((s) => ({ ...s, busy: '' }));
  };

  // Pause EVERYTHING (email + push, every category) until a date — the "on
  // leave" switch. days=0 ⇒ until they resume (far-future sentinel).
  const pauseFor = async (days) => {
    const until = days ? new Date(Date.now() + days * 86400_000).toISOString() : '9999-12-31T00:00:00.000Z';
    setN((s) => ({ ...s, busy: 'pause', pausedUntil: until }));
    try { await api.setNotifPrefs({ pausedUntil: until }); } catch { setN((s) => ({ ...s, pausedUntil: '' })); }
    setN((s) => ({ ...s, busy: '' })); setPausePick(false);
  };
  const resume = async () => {
    setN((s) => ({ ...s, busy: 'pause', pausedUntil: '' }));
    try { await api.setNotifPrefs({ pausedUntil: '' }); } catch { /* reload will correct */ }
    setN((s) => ({ ...s, busy: '' }));
  };
  const pauseLabel = () => {
    if (!n.pausedUntil) return '';
    const d = new Date(n.pausedUntil);
    return d.getFullYear() > 9000 ? 'until you resume' : `until ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
  };

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

  const cardStyle = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', maxWidth: 520 };
  const TYPE_ICON = { digest: '🗞️', goals: '🎯', alerts: '🚨', messages: '💬', reports: '🐞' };

  return (
    <>
      {/* Going away? One switch silences every email + push (the inbox still
          collects) until the chosen date — or until you switch it back on. */}
      <div style={{ marginBottom: compact ? 8 : 16, ...(compact ? {} : cardStyle) }}>
        <Row icon="⏸️" label={n.pausedUntil ? `Notifications paused ${pauseLabel()}` : 'Pause all notifications'}
          sub={n.pausedUntil ? 'Tap to resume — everything switches back on' : 'Going away? Silence every email & push for a while'}
          onClick={() => (n.pausedUntil ? resume() : setPausePick((v) => !v))} disabled={n.busy === 'pause'}
          right={<Switch on={!!n.pausedUntil} busy={n.busy === 'pause'} />} />
        {pausePick && !n.pausedUntil && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: compact ? '2px 10px 10px' : '2px 12px 12px' }}>
            {[['1 week', 7], ['2 weeks', 14], ['1 month', 30], ['Until I resume', 0]].map(([lbl, days]) => (
              <button key={lbl} onClick={() => pauseFor(days)} disabled={n.busy === 'pause'}
                style={{ padding: '8px 12px', borderRadius: 999, border: '1px solid var(--hairline)', background: 'transparent', color: 'var(--text)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                {lbl}
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={{ ...(compact ? {} : cardStyle), opacity: n.pausedUntil ? 0.5 : 1 }}>
        <Row icon="✉️" label="Email" onClick={toggleEmail} disabled={n.busy === 'email'} right={<Switch on={n.email} busy={n.busy === 'email'} />} />
        {pushRow}
        {n.supported && n.pushAvailable && n.push && n.deviceOn && !iosNeedsInstall && (
          <Row icon="📨" label={n.testing ? 'Sending…' : 'Send a test notification'} onClick={test} disabled={n.testing} right={null} />
        )}
      </div>

      {/* Per-channel category switches — turn a type (digests, goals, alerts,
          messages) off for ONE channel while keeping it on for the other, e.g.
          no goal emails but still goal push. The in-app inbox always receives. */}
      {n.typeCatalog.length > 0 && (
        <div style={{ marginTop: compact ? 8 : 16, ...(compact ? {} : cardStyle), opacity: n.pausedUntil ? 0.5 : 1 }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, padding: compact ? '6px 10px 4px' : '12px 12px 6px' }}>
            <div style={{ flex: 1, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>What you’re notified about</div>
            <div style={{ width: 40, textAlign: 'center', fontSize: 11, color: 'var(--muted)' }} title="Email">✉️</div>
            {n.pushAvailable && <div style={{ width: 40, textAlign: 'center', fontSize: 11, color: 'var(--muted)' }} title="Push">🔔</div>}
          </div>
          {n.typeCatalog.map((t) => {
            const emailOff = n.email === false; // master channel off greys the column
            const pushOff = !(n.push && n.deviceOn);
            return (
              <div key={t.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: compact ? '9px 10px' : '11px 12px', borderBottom: compact ? 'none' : '1px solid var(--hairline)' }}>
                <span style={{ width: 20, textAlign: 'center', fontSize: 15, flexShrink: 0 }}>{TYPE_ICON[t.key] || '🔔'}</span>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{t.label}<div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400, marginTop: 1 }}>{t.desc}</div></span>
                <MiniToggle on={n.matrix?.email?.[t.key] !== false} dimmed={emailOff} busy={n.busy === `m:email:${t.key}`} onClick={() => toggleMatrix('email', t.key)} />
                {n.pushAvailable && <MiniToggle on={n.matrix?.push?.[t.key] !== false} dimmed={pushOff} busy={n.busy === `m:push:${t.key}`} onClick={() => toggleMatrix('push', t.key)} />}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// A tappable on/off pill for one channel/type cell. `dimmed` shows the column's
// master channel is off (the cell value is kept, just visually de-emphasised).
function MiniToggle({ on, busy, dimmed, onClick }) {
  return (
    <button onClick={onClick} disabled={busy}
      style={{ width: 40, display: 'flex', justifyContent: 'center', background: 'none', border: 'none', padding: 0, cursor: busy ? 'default' : 'pointer', opacity: dimmed ? 0.4 : 1 }}>
      <Switch on={on} busy={busy} />
    </button>
  );
}
