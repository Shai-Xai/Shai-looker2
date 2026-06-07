import { useState } from 'react';
import { useAuth } from '../lib/auth.jsx';

export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f6f8', padding: 16, boxSizing: 'border-box' }}>
      <form onSubmit={submit} style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 22 }}>
          <div style={logo}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
              <path d="M9 3v11.5a3.5 3.5 0 1 0 2 3.13V8h7V3H9zm-1.5 16a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM11 6V5h5v1h-5z" />
            </svg>
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.3px' }}>Howler</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>Analytics Studio</div>
          </div>
        </div>

        <label style={label}>Email</label>
        <input style={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus autoComplete="username" />

        <label style={label}>Password</label>
        <input style={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />

        {error && <div style={{ color: 'var(--error)', fontSize: 13, marginTop: 10 }}>{error}</div>}

        <button type="submit" disabled={busy} style={btn}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}

const card = { background: '#fff', border: '1px solid #e0e0e0', borderRadius: 14, boxShadow: '0 4px 24px rgba(0,0,0,0.08)', padding: '32px 36px', width: 'min(380px, 92vw)' };
const logo = { width: 34, height: 34, background: 'var(--brand)', borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 };
const label = { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '14px 0 5px' };
const input = { width: '100%', padding: '10px 12px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box' };
const btn = { width: '100%', marginTop: 22, padding: 12, background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 700, cursor: 'pointer' };
