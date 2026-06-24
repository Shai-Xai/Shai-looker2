import { useState, useEffect, useRef } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
import { api } from '../lib/api.js';
import HomeButton from '../components/HomeButton.jsx';

// Embedded Inventive conversational AI analyst. We get a server-proxied,
// authorized embed URL (the API key never touches the browser), drop it in an
// iframe, and complete Inventive's documented postMessage handshake: wait for
// `embed_content_ready` from the iframe, then send `embed_tokens`. Each Pulse
// client (entity) is its own Inventive workspace, so the AI is scoped to that
// client's data. Read/write "actions" bridge is not wired yet (Inventive doesn't
// expose it) — this is the conversational embed only.
export default function InventiveAskPage() {
  const isMobile = useIsMobile();
  const { isAdmin } = useAuth();
  const { previewEntityId } = useOutletContext() || {};
  const [state, setState] = useState({ status: 'loading' }); // loading | ready | error | unconfigured
  const [info, setInfo] = useState(null); // { url, tokens, scopeToken, hostUrl }
  const iframeRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' }); setInfo(null);
    api.inventiveEmbedUrl(previewEntityId)
      .then((r) => { if (!cancelled) { setInfo(r); setState({ status: 'ready' }); } })
      .catch((e) => { if (!cancelled) setState({ status: /not configured/i.test(e.message) ? 'unconfigured' : 'error', error: e.message }); });
    return () => { cancelled = true; };
  }, [previewEntityId]);

  // Handshake: the iframe posts `embed_content_ready`; we reply with the tokens.
  // Inventive re-broadcasts `embed_content_ready` continuously (~1/sec). Replying
  // every time makes its app re-initialise in a loop — confirmed live: it keeps
  // re-emitting `ready` only while we keep replying — which makes the embed
  // sluggish (input lags). So reply exactly once per embed session.
  useEffect(() => {
    if (!info?.url) return;
    const targetOrigin = (() => { try { return new URL(info.url).origin; } catch { return null; } })();
    let replied = false;
    const onMessage = (event) => {
      if (!targetOrigin || event.origin !== targetOrigin) return; // only Inventive's origin
      if (event.data?.type !== 'embed_content_ready') return;
      if (replied) return; // ignore the repeat `ready` pings — replying again restarts the loop
      replied = true;
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'embed_tokens', tokens: info.tokens, scopeToken: info.scopeToken, hostUrl: info.hostUrl || window.location.href },
        targetOrigin,
      );
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [info]);

  return (
    <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: isMobile ? '14px 12px 0' : '20px 22px 0', maxWidth: 1080, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <HomeButton />
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)' }}>Ask</div>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>Your AI analyst</h1>
        </div>
      </div>

      {state.status === 'loading' && <p style={{ color: 'var(--muted)', fontSize: 14 }}>Opening your analyst…</p>}
      {state.status === 'unconfigured' && (
        <p style={{ color: 'var(--muted)', fontSize: 14 }}>The AI analyst isn't connected yet{isAdmin ? ' — set the Inventive API key and embed token to enable it.' : '.'}</p>
      )}
      {state.status === 'error' && (
        <p style={{ color: 'var(--error,#ef4444)', fontSize: 14 }}>Couldn't open the analyst{isAdmin && state.error ? ` — ${state.error}` : '.'}</p>
      )}
      {state.status === 'ready' && info?.url && (
        <div style={{ flex: 1, minHeight: 0, paddingBottom: isMobile ? 0 : 16 }}>
          <iframe
            ref={iframeRef}
            title="AI analyst"
            src={info.url}
            allow="clipboard-write"
            style={{ width: '100%', height: '100%', minHeight: isMobile ? '70dvh' : 520, border: '1px solid var(--hairline)', borderRadius: 14, background: 'var(--card)' }}
          />
        </div>
      )}
    </main>
  );
}
