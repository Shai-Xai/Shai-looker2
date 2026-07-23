import { useState } from 'react';
import { api } from '../lib/api.js';
import Logo from '../components/Logo.jsx';

// Landing for a password-reset link (/reset?token=…). Set a new password, then
// the server signs you in and we drop you into the app.
export default function ResetPasswordPage() {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (password !== confirm) { setError('Passwords don’t match.'); return; }
    if (password.length < 8) { setError('Use at least 8 characters.'); return; }
    setBusy(true); setError(null);
    try {
      await api.resetPassword(token, password);
      window.location.replace('/'); // signed in — reload into the app
    } catch (err) {
      setError(err.message || 'Could not reset your password.');
      setBusy(false);
    }
  }

  return (
    <Frame>
      <form onSubmit={submit}>
        <Head title="Set a new password" />
        {!token ? (
          <p style={{ color: 'var(--error)', fontSize: 13.5 }}>This link is missing its token. Request a new reset email from the sign-in page.</p>
        ) : (
          <>
            <label style={label}>New password</label>
            <input style={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="new-password" placeholder="At least 8 characters" />
            <label style={label}>Confirm password</label>
            <input style={input} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
            {error && <div style={{ color: 'var(--error)', fontSize: 13, marginTop: 10 }}>{error}</div>}
            <button type="submit" disabled={busy || !password || !confirm} className="btn-key liquid-btn" style={btn}>{busy ? 'Saving…' : 'Set password & sign in'}</button>
          </>
        )}
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <a href="/" style={linkBtn}>← Back to sign in</a>
        </div>
      </form>
    </Frame>
  );
}

function Frame({ children }) {
  return <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', padding: 16, boxSizing: 'border-box' }}><div style={card}>{children}</div></div>;
}
function Head({ title }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
      <Logo size={40} radius={11} />
      <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.3px' }}>{title}</div>
    </div>
  );
}

const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: '0 4px 24px rgba(0,0,0,0.08)', padding: '32px 36px', width: 'min(380px, 92vw)' };
const label = { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '14px 0 5px' };
const input = { width: '100%', padding: '10px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box' };
const btn = { width: '100%', marginTop: 22, padding: 12, background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 700, cursor: 'pointer' };
const linkBtn = { color: 'var(--brand)', fontSize: 13, fontWeight: 600, textDecoration: 'none' };
