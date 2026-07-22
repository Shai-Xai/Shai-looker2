import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';

// Inventive AI analyst as an in-app drawer. Two layouts (A/B toggle in the header):
//  • overlay — slides in over the page with a backdrop,
//  • docked  — opens *in* the layout, pushing the page content aside (no backdrop).
// It's an iframe (third-party → storage-partitioned, so slower than top-level); we
// keep it warm (mounted on first open, hidden on close) for instant re-opens,
// allow="storage-access", and reply ONCE to `embed_content_ready` (replying every
// time makes their app re-initialise in a loop). An animated AI border (.ai-glow)
// rings the panel.
export default function AnalystDrawer({ open, prewarm = false, onClose, previewEntityId }) {
  const isMobile = useIsMobile();
  const [state, setState] = useState({ status: 'loading' }); // loading | ready | error | unconfigured
  const [info, setInfo] = useState(null); // { url, tokens, scopeToken, hostUrl }
  const [mounted, setMounted] = useState(false); // mount on first open, then keep warm
  const [expanded, setExpanded] = useState(false); // overlay full-screen toggle
  const [dock, setDock] = useState(() => localStorage.getItem('howler_ask_dock') || 'docked'); // default in-app; toggle to 'overlay'
  const [zoom, setZoom] = useState(() => parseFloat(localStorage.getItem('howler_ask_zoom')) || 1); // scale the whole embed (text + UI)
  const iframeRef = useRef(null);
  const repliedRef = useRef(false);
  const pickDock = (m) => { localStorage.setItem('howler_ask_dock', m); setDock(m); };
  const bumpZoom = (d) => setZoom((z) => { const n = Math.min(1.3, Math.max(0.7, Math.round((z + d) * 100) / 100)); localStorage.setItem('howler_ask_zoom', String(n)); return n; });

  // Mount on first open OR when pre-warmed (owl hover) so it's loaded by open time.
  useEffect(() => { if (open || prewarm) setMounted(true); }, [open, prewarm]);

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

  // Esc closes (only while open).
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!mounted) return null;

  const docked = dock === 'docked' && !isMobile;
  const hdrBtn = { border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', lineHeight: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' };
  const segBtn = (active) => ({ padding: '4px 10px', fontSize: 11.5, fontWeight: 600, border: 'none', borderRadius: 980, cursor: 'pointer', background: active ? 'var(--brand)' : 'transparent', color: active ? '#fff' : 'var(--text)' });
  const msg = { padding: 16, fontSize: 14, color: 'var(--muted)' };

  // Shared panel chrome (animated AI border via .ai-glow), used by both layouts.
  const panel = (
    <div className="ai-glow" style={{ height: '100%', width: '100%', background: 'var(--card)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 10px 11px 14px', borderBottom: '1px solid var(--hairline)', flexShrink: 0 }}>
        <span style={{ fontSize: 16 }}>✨</span>
        <strong style={{ fontSize: 14.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Your Data Analyst</strong>
        <span style={{ flex: 1 }} />
        <div style={{ display: 'inline-flex', gap: 2, marginRight: 2 }} title="Text size">
          <button onClick={() => bumpZoom(-0.1)} aria-label="Smaller" style={{ ...hdrBtn, fontSize: 11.5, fontWeight: 700, padding: '4px 6px' }}>A−</button>
          <button onClick={() => bumpZoom(0.1)} aria-label="Larger" style={{ ...hdrBtn, fontSize: 14.5, fontWeight: 700, padding: '4px 6px' }}>A+</button>
        </div>
        {!isMobile && (
          <div style={{ display: 'inline-flex', gap: 2, padding: 2, background: 'var(--elevated, rgba(128,128,128,0.12))', borderRadius: 980, marginRight: 2 }} title="A/B: how the analyst opens">
            <button onClick={() => pickDock('overlay')} style={segBtn(!docked)}>Overlay</button>
            <button onClick={() => pickDock('docked')} style={segBtn(docked)}>In-app</button>
          </div>
        )}
        {!isMobile && !docked && (
          <button onClick={() => setExpanded((e) => !e)} title={expanded ? 'Exit full screen' : 'Full screen'} aria-label={expanded ? 'Exit full screen' : 'Full screen'} style={{ ...hdrBtn, fontSize: 15, padding: '4px 8px' }}>{expanded ? '⤡' : '⛶'}</button>
        )}
        <button onClick={onClose} title="Close" aria-label="Close analyst" style={{ ...hdrBtn, fontSize: 20, padding: '2px 6px' }}>✕</button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {state.status === 'loading' && <p style={msg}>Opening your analyst…</p>}
        {state.status === 'unconfigured' && <p style={msg}>The Data Analyst isn't connected yet.</p>}
        {state.status === 'error' && <p style={{ ...msg, color: 'var(--error,#ef4444)' }}>Couldn't open the analyst.</p>}
        {state.status === 'ready' && info?.url && (
          <iframe ref={iframeRef} title="Data analyst" src={info.url} allow="storage-access; clipboard-write" style={{ zoom, width: `${100 / zoom}%`, height: `${100 / zoom}%`, border: 'none', background: 'var(--card)' }} />
        )}
      </div>
    </div>
  );

  // Docked: a flex item that pushes the page content aside (no backdrop). The inner
  // panel keeps a fixed width while the wrapper animates 0 → width to slide it in.
  // Inventive renders a full desktop-width layout (wide analytical tables), so a
  // narrow drawer CLIPS its right side — give it real room (still leaves the dashboard
  // usable behind it); the ⛶ full-screen / Overlay handle the very widest content.
  if (docked) {
    const w = 'min(880px, 60vw)';
    return (
      <div style={{ position: 'relative', flexShrink: 0, height: '100%', width: open ? w : 0, transition: 'width .28s var(--ease-spring, ease)', overflow: 'hidden' }} aria-hidden={!open}>
        <div style={{ position: 'absolute', top: 0, right: 0, height: '100%', width: w }}>{panel}</div>
      </div>
    );
  }

  // Overlay: slides in over the page with a dimmed backdrop.
  const w = (expanded || isMobile) ? '100%' : 'min(880px, 96vw)';
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 80, pointerEvents: open ? 'auto' : 'none' }} aria-hidden={!open}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.42)', opacity: open ? 1 : 0, transition: 'opacity .26s ease', backdropFilter: open ? 'blur(2px)' : 'none', WebkitBackdropFilter: open ? 'blur(2px)' : 'none' }} />
      <div style={{ position: 'absolute', top: 0, right: 0, height: '100%', width: w, boxShadow: '-10px 0 30px rgba(0,0,0,0.28)', transform: open ? 'translateX(0)' : 'translateX(100%)', transition: 'transform .26s var(--ease-spring, ease)' }}>{panel}</div>
    </div>
  );
}
