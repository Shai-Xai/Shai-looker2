import { useState, useEffect, useRef } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
import { api } from '../lib/api.js';
import HomeButton from '../components/HomeButton.jsx';

// Inventive conversational AI analyst. We get a server-proxied, authorized URL
// (the API key never touches the browser) and open it in its OWN tab rather than
// an iframe. Embedded, app.madeinventive.com is a third-party frame, so Chrome
// partitions its cookies/storage and their app runs sluggishly (confirmed live —
// typing lagged badly only when embedded). Opened top-level it's first-party,
// i.e. the same fast experience as Inventive standalone. If their app still posts
// the documented `embed_content_ready` handshake, we reply ONCE with the tokens
// to the opened window. Each Pulse client (entity) is its own Inventive workspace.
export default function InventiveAskPage() {
  const isMobile = useIsMobile();
  const { isAdmin } = useAuth();
  const { previewEntityId } = useOutletContext() || {};
  const [state, setState] = useState({ status: 'loading' }); // loading | ready | error | unconfigured
  const [info, setInfo] = useState(null); // { url, tokens, scopeToken, hostUrl }
  const winRef = useRef(null);
  const repliedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' }); setInfo(null);
    api.inventiveEmbedUrl(previewEntityId)
      .then((r) => { if (!cancelled) { setInfo(r); setState({ status: 'ready' }); } })
      .catch((e) => { if (!cancelled) setState({ status: /not configured/i.test(e.message) ? 'unconfigured' : 'error', error: e.message }); });
    return () => { cancelled = true; };
  }, [previewEntityId]);

  // Safety net: if the popped-out analyst posts `embed_content_ready`, reply once
  // with the tokens (to the opened window). Reply-once avoids the re-init loop
  // Inventive triggers when it's replied to repeatedly.
  useEffect(() => {
    if (!info?.url) return;
    const targetOrigin = (() => { try { return new URL(info.url).origin; } catch { return null; } })();
    const onMessage = (event) => {
      if (!targetOrigin || event.origin !== targetOrigin) return; // only Inventive's origin
      if (event.data?.type !== 'embed_content_ready') return;
      if (repliedRef.current || !winRef.current) return;
      repliedRef.current = true;
      winRef.current.postMessage(
        { type: 'embed_tokens', tokens: info.tokens, scopeToken: info.scopeToken, hostUrl: info.hostUrl || window.location.href },
        targetOrigin,
      );
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [info]);

  const openAnalyst = () => {
    if (!info?.url) return;
    // Reuse the window if it's still open (focus it); otherwise launch top-level.
    if (winRef.current && !winRef.current.closed) { winRef.current.focus(); return; }
    repliedRef.current = false;
    winRef.current = window.open(info.url, 'inventive_analyst');
  };

  return (
    <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: isMobile ? '14px 12px 0' : '20px 22px 0', maxWidth: 1080, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <HomeButton />
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)' }}>Ask</div>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>Your AI analyst</h1>
        </div>
      </div>

      {state.status === 'loading' && <p style={{ color: 'var(--muted)', fontSize: 14 }}>Getting your analyst ready…</p>}
      {state.status === 'unconfigured' && (
        <p style={{ color: 'var(--muted)', fontSize: 14 }}>The AI analyst isn't connected yet{isAdmin ? ' — set the Inventive API key and embed token to enable it.' : '.'}</p>
      )}
      {state.status === 'error' && (
        <p style={{ color: 'var(--error,#ef4444)', fontSize: 14 }}>Couldn't open the analyst{isAdmin && state.error ? ` — ${state.error}` : '.'}</p>
      )}
      {state.status === 'ready' && info?.url && (
        <div style={{ border: '1px solid var(--hairline)', borderRadius: 14, background: 'var(--card)', padding: isMobile ? '22px 18px' : '30px 28px', maxWidth: 520 }}>
          <div style={{ fontSize: 30, marginBottom: 10 }}>✨</div>
          <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Chat with your AI analyst</h2>
          <p style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.5, marginBottom: 16 }}>
            Ask questions about your data in plain language. It opens in its own tab so it runs at full speed.
          </p>
          <button
            onClick={openAnalyst}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '11px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
          >
            Open your AI analyst <span aria-hidden="true">↗</span>
          </button>
        </div>
      )}
    </main>
  );
}
