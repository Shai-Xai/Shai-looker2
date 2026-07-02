import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';

// Personal two-factor-auth (TOTP) enrollment — self-service, mobile-first.
// Flow: setup (server mints a secret) → user adds it to an authenticator (scan
// the otpauth link or type the key) → confirm with a live code → we show the
// one-time backup codes → enabled. Disable requires a current code. No QR image
// dependency: we surface the secret to type + the otpauth:// link most apps open.
export default function TwoFactorCard() {
  const [status, setStatus] = useState(null); // { enabled } | null (loading)
  const [stage, setStage] = useState('idle'); // idle | enrolling | codes
  const [setup, setSetup] = useState(null);    // { secret, otpauthUri }
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState(null);
  const [qr, setQr] = useState(null); // data-URL of the otpauth QR (lazy-generated)
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.twoFactorStatus().then(setStatus).catch(() => setStatus({ enabled: false }));
  useEffect(() => { load(); }, []);

  // Render the QR from the otpauth URI once we're enrolling. The QR library is
  // dynamically imported so it never weighs down the main app bundle.
  useEffect(() => {
    if (stage !== 'enrolling' || !setup?.otpauthUri) return;
    let alive = true;
    import('qrcode')
      .then((m) => m.toDataURL(setup.otpauthUri, { margin: 1, width: 200 }))
      .then((url) => { if (alive) setQr(url); })
      .catch(() => { if (alive) setQr(null); }); // fall back to the manual key
    return () => { alive = false; };
  }, [stage, setup]);

  async function begin() {
    setBusy(true); setError(null);
    try { const s = await api.twoFactorSetup(); setSetup(s); setStage('enrolling'); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function confirm(e) {
    e.preventDefault(); setBusy(true); setError(null);
    try { const r = await api.twoFactorEnable(code.trim()); setBackupCodes(r.backupCodes); setStage('codes'); setCode(''); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function disable() {
    const c = prompt('Enter a current 2FA code (or a backup code) to turn off two-factor auth:');
    if (!c) return;
    setBusy(true); setError(null);
    try { await api.twoFactorDisable(c.trim()); setStage('idle'); setSetup(null); await load(); }
    catch (e) { setError(e.message || 'Could not disable — check the code.'); } finally { setBusy(false); }
  }
  function done() { setStage('idle'); setSetup(null); setBackupCodes(null); load(); }

  if (!status) return <p style={{ color: 'var(--muted)' }}>Loading…</p>;

  return (
    <div style={{ maxWidth: 520 }}>
      <h3 style={{ fontSize: 15, fontWeight: 800, margin: '0 0 4px' }}>Two-factor authentication</h3>
      <p style={hint}>Add a second step at sign-in using an authenticator app (Google Authenticator, 1Password, Authy…). Strongly recommended for staff and account owners.</p>

      {error && <div style={errBox}>{error}</div>}

      {/* Enabled state */}
      {status.enabled && stage !== 'codes' && (
        <div style={box}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, color: 'var(--ok, #1a8a4a)' }}>✅ Two-factor auth is on</div>
          <p style={{ ...hint, marginTop: 6 }}>You’ll be asked for a code from your authenticator each time you sign in.</p>
          <button type="button" style={dangerBtn} onClick={disable} disabled={busy}>Turn off 2FA</button>
        </div>
      )}

      {/* Not enabled, not yet enrolling */}
      {!status.enabled && stage === 'idle' && (
        <button type="button" style={primaryBtn} onClick={begin} disabled={busy}>{busy ? 'Starting…' : 'Set up two-factor auth'}</button>
      )}

      {/* Enrolling: show the secret + otpauth link, confirm with a code */}
      {stage === 'enrolling' && setup && (
        <form onSubmit={confirm} style={box}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>1. Add Pulse to your authenticator</div>
          <p style={hint}>Scan this QR with your authenticator app, or open <a href={setup.otpauthUri} style={{ color: 'var(--brand)' }}>this link</a> on this device.</p>
          {qr && <div style={{ textAlign: 'center', margin: '10px 0' }}><img src={qr} alt="2FA QR code" width={200} height={200} style={{ borderRadius: 8, background: '#fff', padding: 6 }} /></div>}
          <p style={{ ...hint, marginBottom: 4 }}>Can’t scan? Add an account manually and paste this key:</p>
          <code style={secretBox}>{setup.secret}</code>
          <div style={{ fontWeight: 700, margin: '14px 0 6px' }}>2. Enter the 6-digit code it shows</div>
          <input style={{ ...input, textAlign: 'center', letterSpacing: '0.3em', fontSize: 18 }} inputMode="numeric" autoComplete="one-time-code"
            value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" autoFocus />
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button type="submit" style={primaryBtn} disabled={busy || !code.trim()}>{busy ? 'Verifying…' : 'Turn on 2FA'}</button>
            <button type="button" style={ghostBtn} onClick={() => { setStage('idle'); setSetup(null); setError(null); }}>Cancel</button>
          </div>
        </form>
      )}

      {/* Backup codes — shown once */}
      {stage === 'codes' && backupCodes && (
        <div style={box}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>🎉 2FA is on — save your backup codes</div>
          <p style={hint}>Each code works once, if you ever lose your authenticator. Store them somewhere safe — you won’t see them again.</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, margin: '10px 0' }}>
            {backupCodes.map((c) => <code key={c} style={{ ...secretBox, fontSize: 13, textAlign: 'center' }}>{c}</code>)}
          </div>
          <button type="button" style={primaryBtn} onClick={done}>I’ve saved them</button>
        </div>
      )}
    </div>
  );
}

const hint = { fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, margin: '0 0 10px' };
const box = { border: '1px solid var(--hairline)', borderRadius: 12, padding: 16, marginTop: 6 };
const input = { width: '100%', padding: '10px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box' };
const secretBox = { display: 'block', background: 'var(--bg)', border: '1px solid var(--hairline)', borderRadius: 8, padding: '10px 12px', fontFamily: 'monospace', fontSize: 15, letterSpacing: '0.06em', wordBreak: 'break-all' };
const primaryBtn = { minHeight: 42, padding: '10px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 14, fontWeight: 700, cursor: 'pointer' };
const ghostBtn = { minHeight: 42, padding: '10px 18px', background: 'rgba(128,128,128,0.12)', color: 'var(--text)', border: 'none', borderRadius: 980, fontSize: 14, fontWeight: 600, cursor: 'pointer' };
const dangerBtn = { minHeight: 42, marginTop: 12, padding: '10px 18px', background: 'transparent', color: 'var(--error, #c0392b)', border: '1px solid var(--error, #c0392b)', borderRadius: 980, fontSize: 13, fontWeight: 700, cursor: 'pointer' };
const errBox = { color: 'var(--error)', fontSize: 13, margin: '8px 0', padding: '8px 10px', background: 'rgba(192,57,43,0.08)', borderRadius: 8 };
