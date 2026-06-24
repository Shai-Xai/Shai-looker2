import { useState, useEffect, useRef } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
import { api } from '../lib/api.js';
import HomeButton from '../components/HomeButton.jsx';

// Inventive conversational AI analyst. We get a server-proxied, authorized URL
// (the API key never touches the browser). Three display modes — switchable for
// A/B testing via the toggle (admins only): `tab` and `sidebar` open it TOP-LEVEL
// (first-party, fast — Chrome doesn't partition its cookies/storage like it does
// in our cross-origin iframe), `embed` keeps the in-app iframe (full-width, slower
// because of that storage partitioning). If their app posts the documented
// `embed_content_ready` handshake we reply ONCE with the tokens to the active
// target (replying repeatedly makes their app re-init in a loop → sluggish).
const MODES = [
  { key: 'tab', label: 'New tab' },
  { key: 'sidebar', label: 'Sidebar' },
  { key: 'embed', label: 'Embedded' },
];

export default function InventiveAskPage() {
  const isMobile = useIsMobile();
  const { isAdmin } = useAuth();
  const { previewEntityId } = useOutletContext() || {};
  const [state, setState] = useState({ status: 'loading' }); // loading | ready | error | unconfigured
  const [info, setInfo] = useState(null); // { url, tokens, scopeToken, hostUrl }
  const [mode, setMode] = useState(() => localStorage.getItem('howler_ask_mode') || 'tab');
  const winRef = useRef(null);
  const iframeRef = useRef(null);
  const repliedRef = useRef(false);
  const pickMode = (m) => { localStorage.setItem('howler_ask_mode', m); setMode(m); };

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' }); setInfo(null);
    api.inventiveEmbedUrl(previewEntityId)
      .then((r) => { if (!cancelled) { setInfo(r); setState({ status: 'ready' }); } })
      .catch((e) => { if (!cancelled) setState({ status: /not configured/i.test(e.message) ? 'unconfigured' : 'error', error: e.message }); });
    return () => { cancelled = true; };
  }, [previewEntityId]);

  // Reply ONCE to `embed_content_ready` — to the iframe (embed) or the opened
  // window (tab/sidebar). Re-binds + resets on mode/info change (new session).
  useEffect(() => {
    if (!info?.url) return;
    repliedRef.current = false;
    const targetOrigin = (() => { try { return new URL(info.url).origin; } catch { return null; } })();
    const onMessage = (event) => {
      if (!targetOrigin || event.origin !== targetOrigin) return; // only Inventive's origin
      if (event.data?.type !== 'embed_content_ready') return;
      if (repliedRef.current) return; // replying again restarts Inventive's re-init loop
      const target = mode === 'embed' ? iframeRef.current?.contentWindow : winRef.current;
      if (!target) return;
      repliedRef.current = true;
      target.postMessage(
        { type: 'embed_tokens', tokens: info.tokens, scopeToken: info.scopeToken, hostUrl: info.hostUrl || window.location.href },
        targetOrigin,
      );
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [info, mode]);

  const launch = () => {
    if (!info?.url) return;
    if (winRef.current && !winRef.current.closed) { winRef.current.focus(); return; }
    repliedRef.current = false;
    if (mode === 'sidebar') {
      const w = 460;
      const h = Math.min((window.screen && window.screen.availHeight) || 1000, 1000);
      const left = ((window.screen && window.screen.availWidth) || 1440) - w - 16;
      winRef.current = window.open(info.url, 'inventive_analyst', `popup=yes,width=${w},height=${h},left=${left},top=24`);
    } else {
      winRef.current = window.open(info.url, 'inventive_analyst');
    }
  };

  const embed = mode === 'embed';
  return (
    <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, width: '100%', boxSizing: 'border-box', ...(embed ? { padding: isMobile ? '10px 10px 0' : '14px 16px 0' } : { padding: isMobile ? '14px 12px 0' : '20px 22px 0', maxWidth: 1080, margin: '0 auto' }) }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <HomeButton />
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)' }}>Ask</div>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>Your AI analyst</h1>
        </div>
      </div>
      {isAdmin && (
        // Admin-only A/B toggle. On its own row so it's never clipped on narrow widths.
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' }}>Display · testing</span>
          <div style={{ display: 'inline-flex', gap: 2, padding: 3, background: 'var(--elevated, rgba(128,128,128,0.12))', borderRadius: 980 }}>
            {MODES.map((m) => (
              <button
                key={m.key}
                onClick={() => pickMode(m.key)}
                style={{ padding: '6px 14px', fontSize: 12.5, fontWeight: 600, borderRadius: 980, border: 'none', cursor: 'pointer', background: mode === m.key ? 'var(--brand)' : 'transparent', color: mode === m.key ? '#fff' : 'var(--text)' }}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {state.status === 'loading' && <p style={{ color: 'var(--muted)', fontSize: 14 }}>Getting your analyst ready…</p>}
      {state.status === 'unconfigured' && (
        <p style={{ color: 'var(--muted)', fontSize: 14 }}>The AI analyst isn't connected yet{isAdmin ? ' — set the Inventive API key and embed token to enable it.' : '.'}</p>
      )}
      {state.status === 'error' && (
        <p style={{ color: 'var(--error,#ef4444)', fontSize: 14 }}>Couldn't open the analyst{isAdmin && state.error ? ` — ${state.error}` : '.'}</p>
      )}

      {state.status === 'ready' && info?.url && embed && (
        <div style={{ flex: 1, minHeight: 0, paddingBottom: isMobile ? 0 : 14 }}>
          <iframe
            ref={iframeRef}
            title="AI analyst"
            src={info.url}
            allow="clipboard-write"
            style={{ width: '100%', height: '100%', minHeight: isMobile ? '74dvh' : 540, border: '1px solid var(--hairline)', borderRadius: 14, background: 'var(--card)' }}
          />
        </div>
      )}

      {state.status === 'ready' && info?.url && !embed && (
        <div style={{ border: '1px solid var(--hairline)', borderRadius: 14, background: 'var(--card)', padding: isMobile ? '22px 18px' : '30px 28px', maxWidth: 520 }}>
          <div style={{ fontSize: 30, marginBottom: 10 }}>✨</div>
          <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Chat with your AI analyst</h2>
          <p style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.5, marginBottom: 16 }}>
            Ask questions about your data in plain language. It opens {mode === 'sidebar' ? 'in a side window' : 'in its own tab'} so it runs at full speed.
          </p>
          <button
            onClick={launch}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '11px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
          >
            Open your AI analyst <span aria-hidden="true">↗</span>
          </button>
        </div>
      )}
    </main>
  );
}
