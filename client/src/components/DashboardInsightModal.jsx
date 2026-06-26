import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useIsMobile } from '../lib/useIsMobile.js';
import { useSheetDrag } from '../lib/useSheetDrag.js';
import AiMark from './AiMark.jsx';
import OwlQuips from './OwlQuips.jsx';
import ShareMenu from './ShareMenu.jsx';

// Whole-dashboard AI summary. Streams an executive summary built from every
// tile's data (scoped + filtered exactly like the live view).
export default function DashboardInsightModal({ dashboardId, title, filterValues, suiteId, onClose }) {
  const isMobile = useIsMobile();
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  // Desktop: dock the panel as a full-height column on the right and SHIFT THE
  // WHOLE APP left by the panel width (via `body.owl-docked` → padding-right on
  // #root) so the nav, header and dashboard all reflow — nothing is overlaid.
  // Mobile keeps the bottom sheet.
  useEffect(() => {
    if (isMobile) return undefined;
    document.body.style.setProperty('--owl-width', `${SIDEBAR_W}px`);
    document.body.classList.add('owl-docked');
    return () => { document.body.classList.remove('owl-docked'); document.body.style.removeProperty('--owl-width'); };
  }, [isMobile]);

  const run = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setText(''); setLoading(true); setError(null);
    (async () => {
      try {
        const res = await fetch('/api/dashboard-insight', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dashboardId, filterValues, suiteId }),
          signal: controller.signal,
        });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `Request failed (${res.status})`); }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let acc = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          acc += dec.decode(value, { stream: true });
          setText(acc);
          setLoading(false);
        }
      } catch (e) {
        if (e.name !== 'AbortError') setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  };

  useEffect(() => {
    run();
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardId, JSON.stringify(filterValues), suiteId]);

  const drag = useSheetDrag(onClose);
  const panelStyle = isMobile ? { ...panel, width: '100%', maxHeight: '92dvh', borderRadius: '18px 18px 0 0' } : panel;
  // Desktop: a true side-docked sidebar — no dimming/blur backdrop (we drop the
  // `ai-overlay` class, which carries backdrop-filter: blur), and the overlay lets
  // clicks pass through (pointer-events:none) so the dashboard stays fully visible
  // and live beside it. Mobile keeps the dimmed bottom sheet (no room for side-by-side).
  // Desktop: full-height right column. The app is shifted left (owl-docked), so the
  // panel fills the cleared space with no overlap. Click-through elsewhere.
  const node = (
    <div className={isMobile ? 'ai-overlay' : ''} style={isMobile ? { ...overlay, alignItems: 'flex-end', justifyContent: 'center' } : desktopOverlay} onClick={isMobile ? onClose : undefined}>
      <div className={(isMobile ? 'ai-sheet' : 'ai-panel') + ' ai-glow'} style={isMobile ? { ...panelStyle, ...drag.style } : panelStyle} onClick={(e) => e.stopPropagation()}>
        <style>{`@keyframes blink { 50% { opacity: 0; } } @keyframes spin { to { transform: rotate(360deg); } }`}</style>
        {isMobile && <div className="sheet-grip" {...drag.handlers} style={{ marginTop: 8 }} />}
        <div style={header}>
          <AiMark size={28} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>Dashboard summary</div>
            <div style={{ fontSize: 15, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title || 'This dashboard'}</div>
          </div>
          {text.trim() && !loading && (
            <ShareMenu
              variant="header"
              isMobile={isMobile}
              heading={`Dashboard summary · ${title || 'This dashboard'}`}
              text={text}
            />
          )}
          <button style={btn} onClick={run} disabled={loading} title="Regenerate">↻</button>
          <button style={{ ...btn, fontSize: isMobile ? 22 : 17 }} onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div style={body}>
          {error ? (
            <div style={{ color: 'var(--error)', fontSize: 14, lineHeight: 1.5 }}>⚠ {error}</div>
          ) : loading && !text ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ color: 'var(--muted)', fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⏳</span>
                Reading every tile and summarising…
              </div>
              <OwlQuips prefix="" style={{ paddingLeft: 26 }} />
            </div>
          ) : (
            <div className={loading ? 'streaming' : ''} style={{ fontSize: 14, lineHeight: 1.65, color: 'var(--text)' }}>
              {renderMarkdownish(text)}
              {loading && <span style={cursor} />}
            </div>
          )}
        </div>
        <div style={{ padding: '10px 18px', borderTop: '1px solid var(--hairline)', fontSize: 11, color: 'var(--muted)' }}>
          Generated by Claude from this dashboard's data. Verify important figures.
        </div>
      </div>
    </div>
  );
  return createPortal(node, document.body);
}

function renderMarkdownish(text) {
  if (!text) return null;
  return text.split('\n').filter((l) => l.trim()).map((line, i) => {
    const t = line.trim();
    const bulleted = /^[-*]\s+/.test(t);
    const heading = /^#{1,6}\s+/.test(t);
    const content = t.replace(/^[-*]\s+/, '').replace(/^#{1,6}\s+/, '');
    const parts = content.split(/(\*\*[^*]+\*\*)/g).map((p, j) =>
      p.startsWith('**') && p.endsWith('**') ? <strong key={j}>{p.slice(2, -2)}</strong> : p
    );
    if (heading) return <div key={i} style={{ fontWeight: 700, margin: '12px 0 6px' }}>{parts}</div>;
    return (
      <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        {bulleted && <span style={{ color: 'var(--brand)' }}>•</span>}
        <span>{parts}</span>
      </div>
    );
  });
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', justifyContent: 'flex-end', zIndex: 400 };
// Desktop sidebar: transparent, click-through overlay so the dashboard stays
// usable; only the panel itself captures clicks.
// Explicit edges (not `inset`) so the caller can override `top` cleanly to dock
// the panel below the global header. `bottom:0` keeps the panel full-height down.
const desktopOverlay = { position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, background: 'transparent', pointerEvents: 'none', display: 'flex', justifyContent: 'flex-end', zIndex: 400 };
const SIDEBAR_W = 420; // keep in sync with ViewPage's reflow padding
const panel = { width: `min(${SIDEBAR_W}px, 94vw)`, height: '100%', background: 'var(--card)', boxShadow: '-4px 0 24px rgba(0,0,0,0.15)', borderLeft: '1px solid var(--border)', pointerEvents: 'auto', display: 'flex', flexDirection: 'column' };
const header = { display: 'flex', alignItems: 'center', gap: 10, padding: '16px 18px', borderBottom: '1px solid var(--border)' };
const body = { flex: 1, minHeight: 0, overflowY: 'auto', padding: 18 };
const btn = { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 17, color: '#888' };
const cursor = { display: 'inline-block', width: 7, height: 15, background: 'var(--brand)', marginLeft: 2, verticalAlign: 'text-bottom', animation: 'blink 1s step-end infinite' };
