import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import Logo from '../components/Logo.jsx';

// Landing for a magic sign-in link (/magic?token=…). Consumes the token on load
// and, on success, drops you straight into the app.
export default function MagicLinkPage() {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const [error, setError] = useState(token ? null : 'This link is missing its token.');
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current || !token) return;
    ran.current = true; // links are one-time — never fire the consume twice
    api.consumeMagicLink(token)
      .then(() => window.location.replace('/'))
      .catch((e) => setError(e.message || 'This sign-in link is invalid or has expired.'));
  }, [token]);

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', padding: 16, boxSizing: 'border-box' }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <Logo size={40} radius={11} />
          <div style={{ fontSize: 16, fontWeight: 700 }}>Howler : Pulse</div>
        </div>
        {error ? (
          <>
            <p style={{ color: 'var(--error)', fontSize: 13.5, lineHeight: 1.5 }}>⚠ {error}</p>
            <a href="/" style={{ color: 'var(--brand)', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>← Back to sign in</a>
          </>
        ) : (
          <p style={{ color: 'var(--muted)', fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="spin" style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⏳</span>
            Signing you in…
          </p>
        )}
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  );
}

const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: '0 4px 24px rgba(0,0,0,0.08)', padding: '32px 36px', width: 'min(380px, 92vw)' };
