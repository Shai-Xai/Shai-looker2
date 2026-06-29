import { useState, useEffect } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { applyBrand } from '../lib/brand.js';
import Logo from '../components/Logo.jsx';

export default function LoginPage({ slug = '' }) {
  const { login } = useAuth();
  const [mode, setMode] = useState('password'); // 'password' | 'forgot' | 'magic'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  // Vanity login: a /<slug> URL paints the client's brand (logo, colours,
  // background) before sign-in. Unknown slug → the standard Howler login.
  const [brand, setBrand] = useState(null);
  useEffect(() => {
    if (!slug) return;
    let alive = true;
    api.getBrandingBySlug(slug)
      .then((b) => { if (!alive) return; setBrand(b); applyBrand({ primary: b.primary, secondary: b.secondary, logo: b.logo }); })
      .catch(() => {}); // unknown/typo slug → leave the default Howler branding
    return () => { alive = false; };
  }, [slug]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'password') {
        await login(email.trim(), password);
      } else if (mode === 'forgot') {
        await api.forgotPassword(email.trim());
        setSent(true);
      } else {
        await api.requestMagicLink(email.trim());
        setSent(true);
      }
    } catch (err) {
      setError(err.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const go = (m) => { setMode(m); setError(null); setSent(false); };

  // After requesting a reset / magic link we always show the same neutral
  // confirmation (the server never reveals whether the email has a login).
  if (sent) {
    return (
      <Frame bg={brand?.loginBackground} poweredBy={!!brand}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 34, marginBottom: 8 }}>📧</div>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Check your email</div>
          <p style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.5, margin: '0 0 18px' }}>
            If <strong>{email.trim()}</strong> has a Howler : Pulse login, we’ve sent a{' '}
            {mode === 'forgot' ? 'password-reset' : 'sign-in'} link. It expires shortly and can be used once.
          </p>
          <button type="button" style={ghost} onClick={() => go('password')}>← Back to sign in</button>
        </div>
      </Frame>
    );
  }

  const title = mode === 'forgot' ? 'Reset your password' : mode === 'magic' ? 'Email me a sign-in link' : null;
  const cta = busy ? 'Sending…' : mode === 'forgot' ? 'Send reset link' : mode === 'magic' ? 'Send sign-in link' : (busy ? 'Signing in…' : 'Sign in');

  return (
    <Frame bg={brand?.loginBackground} poweredBy={!!brand}>
      <form onSubmit={submit}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 22 }}>
          {brand?.logo
            ? <img src={brand.logo} alt="" style={{ height: 40, maxWidth: 160, objectFit: 'contain', borderRadius: 8 }} />
            : <Logo size={40} radius={11} />}
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.3px' }}>{brand?.name || 'Howler : Pulse'}</div>
            {/* Branded pages keep the top clean — the Howler attribution moves to a
                subtle footer at the bottom of the card (see Frame). */}
            {!brand && <div style={{ fontSize: 12, color: 'var(--muted)' }}>Intelligent OS</div>}
          </div>
        </div>

        {title && <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>{title}</div>}
        {mode !== 'password' && (
          <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, margin: '0 0 6px' }}>
            {mode === 'forgot' ? 'Enter your email and we’ll send a link to set a new password.' : 'Enter your email and we’ll send a one-tap sign-in link — no password needed.'}
          </p>
        )}

        <label style={label}>Email</label>
        <input style={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus autoComplete="username" />

        {mode === 'password' && (
          <>
            <label style={label}>Password</label>
            <input style={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </>
        )}

        {error && <div style={{ color: 'var(--error)', fontSize: 13, marginTop: 10 }}>{error}</div>}

        <button type="submit" disabled={busy || !email.trim() || (mode === 'password' && !password)} className="btn-key liquid-btn" style={btn}>{cta}</button>

        {/* Recovery / passwordless options. */}
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
          {mode === 'password' ? (
            <>
              <button type="button" style={linkBtn} onClick={() => go('magic')}>✨ Email me a sign-in link</button>
              <button type="button" style={linkBtn} onClick={() => go('forgot')}>Forgot your password?</button>
            </>
          ) : (
            <button type="button" style={linkBtn} onClick={() => go('password')}>← Back to password sign in</button>
          )}
        </div>
      </form>
    </Frame>
  );
}

function Frame({ children, bg, poweredBy }) {
  // A vanity client's background image fills the page (with a soft scrim so the
  // card stays legible on any photo); otherwise the plain app background.
  const outer = bg
    ? { backgroundImage: `linear-gradient(rgba(0,0,0,0.32), rgba(0,0,0,0.46)), url(${JSON.stringify(bg)})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : { background: 'var(--bg)' };
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, boxSizing: 'border-box', ...outer }}>
      <div style={card}>
        {children}
        {/* White-label attribution: a subtle, centred footer on a client's vanity
            page. The default Howler login carries its own identity, so skips it. */}
        {poweredBy && (
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--hairline)', textAlign: 'center', fontSize: 11.5, color: 'var(--muted)' }}>
            Powered by <strong style={{ fontWeight: 700 }}>Howler : Pulse</strong>
          </div>
        )}
      </div>
    </div>
  );
}

const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: '0 4px 24px rgba(0,0,0,0.08)', padding: '32px 36px', width: 'min(380px, 92vw)' };
const label = { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '14px 0 5px' };
const input = { width: '100%', padding: '10px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box' };
const btn = { width: '100%', marginTop: 22, padding: 12, background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 700, cursor: 'pointer' };
const linkBtn = { background: 'none', border: 'none', color: 'var(--brand)', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: 2 };
const ghost = { background: 'rgba(128,128,128,0.12)', border: 'none', color: 'var(--text)', borderRadius: 980, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
