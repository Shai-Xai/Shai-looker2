import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';

// Inventive AI analyst as an in-app slide-in drawer (opened from the Ask nav /
// the floating owl). It's an iframe, so app.madeinventive.com runs as a
// third-party frame — Chrome partitions its cookies/storage, which makes it
// slower than the top-level pop-out. Mitigations from our side:
//  • `allow="storage-access"` so their app *can* request first-party storage,
//  • keep the iframe warm (mounted on first open, hidden — not torn down — on
//    close) so re-opens are instant and the conversation persists,
//  • a "pop out" button to launch it top-level (first-party = full speed).
// We reply ONCE to the documented `embed_content_ready` handshake (replying
// repeatedly makes their app re-initialise in a loop → sluggish).
export default function AnalystDrawer({ open, onClose, previewEntityId }) {
  const isMobile = useIsMobile();
  const [state, setState] = useState({ status: 'loading' }); // loading | ready | error | unconfigured
  const [info, setInfo] = useState(null); // { url, tokens, scopeToken, hostUrl }
  const [mounted, setMounted] = useState(false); // mount on first open, then keep warm
  const [expanded, setExpanded] = useState(false); // full-screen drawer toggle
  const iframeRef = useRef(null);
  const repliedRef = useRef(false);

  useEffect(() => { if (open) setMounted(true); }, [open]);

  // Fetch the authorized URL on first open and when the previewed client changes.
  useEffect(() => {
    if (!mounted) return;
    let cancelled = false;
    setState({ status: 'loading' }); setInfo(null); repliedRef.current = false;
    api.inventiveEmbedUrl(previewEntityId)
      .then((r) => { if (!cancelled) { setInfo(r); setState({ status: 'ready' }); } })
      .catch((e) => { if (!cancelled) setState({ status: /not configured/i.test(e.message) ? 'unconfigured' : 'error', error: e.message }); });
    return () => { cancelled = true; };
  }, [mounted, previewEntityId]);

  // Reply ONCE to `embed_content_ready` (replying again restarts Inventive's loop).
  useEffect(() => {
    if (!info?.url) return;
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
  }, [info]);

  // Esc closes the drawer (only while open).
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!mounted) return null;

  const popOut = () => {
    if (!info?.url) return;
    window.open(info.url, 'inventive_analyst'); // top-level = first-party = full speed
    setMounted(false); // tear down the in-app iframe; the window takes over
    onClose();
  };
  const width = (expanded || isMobile) ? '100%' : 'min(560px, 94vw)';
  const hdrBtn = { border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', lineHeight: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' };
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 80, pointerEvents: open ? 'auto' : 'none' }} aria-hidden={!open}>
      <div
        onClick={onClose}
        style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.42)', opacity: open ? 1 : 0, transition: 'opacity .26s ease', backdropFilter: open ? 'blur(2px)' : 'none', WebkitBackdropFilter: open ? 'blur(2px)' : 'none' }}
      />
      <div style={{ position: 'absolute', top: 0, right: 0, height: '100%', width, background: 'var(--card)', boxShadow: '-10px 0 30px rgba(0,0,0,0.28)', display: 'flex', flexDirection: 'column', transform: open ? 'translateX(0)' : 'translateX(100%)', transition: 'transform .26s var(--ease-spring, ease)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 10px 11px 14px', borderBottom: '1px solid var(--hairline)', flexShrink: 0 }}>
          <span style={{ fontSize: 16 }}>✨</span>
          <strong style={{ fontSize: 14.5 }}>Your AI analyst</strong>
          <span style={{ flex: 1 }} />
          {!isMobile && (
            <button onClick={() => setExpanded((e) => !e)} title={expanded ? 'Exit full screen' : 'Full screen'} aria-label={expanded ? 'Exit full screen' : 'Full screen'} style={{ ...hdrBtn, fontSize: 15, padding: '4px 8px' }}>{expanded ? '⤡' : '⛶'}</button>
          )}
          <button onClick={popOut} title="Pop out to a faster window" aria-label="Pop out to a window" style={{ ...hdrBtn, fontSize: 17, padding: '4px 8px' }}>⤢</button>
          <button onClick={onClose} title="Close" aria-label="Close analyst" style={{ ...hdrBtn, fontSize: 20, padding: '2px 6px' }}>✕</button>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          {state.status === 'loading' && <p style={{ padding: 16, color: 'var(--muted)', fontSize: 14 }}>Opening your analyst…</p>}
          {state.status === 'unconfigured' && <p style={{ padding: 16, color: 'var(--muted)', fontSize: 14 }}>The AI analyst isn't connected yet.</p>}
          {state.status === 'error' && <p style={{ padding: 16, color: 'var(--error,#ef4444)', fontSize: 14 }}>Couldn't open the analyst.</p>}
          {state.status === 'ready' && info?.url && (
            <iframe ref={iframeRef} title="AI analyst" src={info.url} allow="storage-access; clipboard-write" style={{ width: '100%', height: '100%', border: 'none', background: 'var(--card)' }} />
          )}
        </div>
      </div>
    </div>
  );
}
