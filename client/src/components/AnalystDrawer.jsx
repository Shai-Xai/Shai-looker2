import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';

// Inventive AI analyst as an in-app slide-in drawer (opened from the Ask nav).
// It's an iframe, so app.madeinventive.com runs as a third-party frame — Chrome
// partitions its cookies/storage, which makes it slower than the top-level
// pop-out. We reply ONCE to the documented `embed_content_ready` handshake
// (replying repeatedly makes their app re-initialise in a loop → sluggish).
// Mounted only while open so the iframe (and its work) stops when closed.
export default function AnalystDrawer({ open, onClose, previewEntityId }) {
  const isMobile = useIsMobile();
  const [state, setState] = useState({ status: 'loading' }); // loading | ready | error | unconfigured
  const [info, setInfo] = useState(null); // { url, tokens, scopeToken, hostUrl }
  const iframeRef = useRef(null);
  const repliedRef = useRef(false);

  // Fetch a fresh authorized URL each time the drawer opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ status: 'loading' }); setInfo(null); repliedRef.current = false;
    api.inventiveEmbedUrl(previewEntityId)
      .then((r) => { if (!cancelled) { setInfo(r); setState({ status: 'ready' }); } })
      .catch((e) => { if (!cancelled) setState({ status: /not configured/i.test(e.message) ? 'unconfigured' : 'error', error: e.message }); });
    return () => { cancelled = true; };
  }, [open, previewEntityId]);

  // Reply ONCE to `embed_content_ready` (replying again restarts Inventive's loop).
  useEffect(() => {
    if (!open || !info?.url) return;
    repliedRef.current = false;
    const targetOrigin = (() => { try { return new URL(info.url).origin; } catch { return null; } })();
    const onMessage = (event) => {
      if (!targetOrigin || event.origin !== targetOrigin) return; // only Inventive's origin
      if (event.data?.type !== 'embed_content_ready') return;
      if (repliedRef.current) return;
      repliedRef.current = true;
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'embed_tokens', tokens: info.tokens, scopeToken: info.scopeToken, hostUrl: info.hostUrl || window.location.href },
        targetOrigin,
      );
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [open, info]);

  // Esc closes the drawer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const width = isMobile ? '100%' : 'min(560px, 94vw)';
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 80 }}>
      <div className="ai-overlay" style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.42)' }} onClick={onClose} />
      <div className="analyst-drawer" style={{ position: 'absolute', top: 0, right: 0, height: '100%', width, background: 'var(--card)', boxShadow: '-10px 0 30px rgba(0,0,0,0.28)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: '1px solid var(--hairline)', flexShrink: 0 }}>
          <span style={{ fontSize: 16 }}>✨</span>
          <strong style={{ fontSize: 14.5 }}>Your AI analyst</strong>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} aria-label="Close analyst" style={{ border: 'none', background: 'transparent', color: 'var(--muted)', fontSize: 20, lineHeight: 1, cursor: 'pointer', padding: '2px 6px' }}>✕</button>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          {state.status === 'loading' && <p style={{ padding: 16, color: 'var(--muted)', fontSize: 14 }}>Opening your analyst…</p>}
          {state.status === 'unconfigured' && <p style={{ padding: 16, color: 'var(--muted)', fontSize: 14 }}>The AI analyst isn't connected yet.</p>}
          {state.status === 'error' && <p style={{ padding: 16, color: 'var(--error,#ef4444)', fontSize: 14 }}>Couldn't open the analyst.</p>}
          {state.status === 'ready' && info?.url && (
            <iframe ref={iframeRef} title="AI analyst" src={info.url} allow="clipboard-write" style={{ width: '100%', height: '100%', border: 'none', background: 'var(--card)' }} />
          )}
        </div>
      </div>
    </div>
  );
}
