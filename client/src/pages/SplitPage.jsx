import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProfile } from '../lib/profile.jsx';

// Split view (admin, desktop): the CLIENT portal and the HOWLER ADMIN console
// side by side in two same-origin iframes, so you can change a setting on the
// right and watch the client experience on the left without switching profiles.
// Each pane is pinned to its side via the iframe's `name` (see lib/profile.jsx
// PANE) so navigating inside one pane never flips the other — or your login.
export default function SplitPage() {
  const navigate = useNavigate();
  const { activeEntityId, entities } = useProfile();
  const [ratio, setRatio] = useState(0.5);
  const [dragging, setDragging] = useState(false);
  const wrapRef = useRef(null);
  // Never nest: a pane navigating to /split would recurse forever.
  if (window.self !== window.top) {
    return <div style={{ padding: 40, color: 'var(--muted)', fontSize: 13 }}>You’re already in split view — use the other pane for the admin console.</div>;
  }
  const eid = activeEntityId || entities[0]?.id || '';
  const move = (clientX) => {
    const el = wrapRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    setRatio(Math.min(0.75, Math.max(0.25, (clientX - r.left) / r.width)));
  };
  const paneLabel = { fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' };
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 14px', borderBottom: '1px solid var(--hairline)', flexShrink: 0 }}>
        <span style={{ ...paneLabel, width: `calc(${ratio * 100}% - 14px)` }}>👤 Client portal</span>
        <span style={paneLabel}>🛠 Howler Admin</span>
        <span style={{ flex: 1 }} />
        <button onClick={() => navigate('/admin')} style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 8, fontSize: 12, fontWeight: 600, padding: '4px 10px', cursor: 'pointer' }}>✕ Exit split</button>
      </div>
      <div
        ref={wrapRef}
        style={{ flex: 1, display: 'flex', minHeight: 0, userSelect: dragging ? 'none' : 'auto' }}
        onMouseMove={(e) => dragging && move(e.clientX)}
        onMouseUp={() => setDragging(false)}
        onMouseLeave={() => setDragging(false)}
      >
        {/* pointerEvents off while dragging — iframes would swallow the mousemove. */}
        <iframe name="pulse-pane-client" title="Client portal" src={`/${eid ? `?entity=${encodeURIComponent(eid)}` : ''}`}
          style={{ width: `${ratio * 100}%`, height: '100%', border: 'none', pointerEvents: dragging ? 'none' : 'auto', background: 'var(--bg, #fff)' }} />
        <div role="separator" aria-orientation="vertical" title="Drag to resize"
          onMouseDown={(e) => { e.preventDefault(); setDragging(true); }}
          style={{ width: 7, cursor: 'col-resize', flexShrink: 0, background: dragging ? 'var(--brand)' : 'var(--hairline)', transition: 'background .15s' }} />
        <iframe name="pulse-pane-console" title="Howler Admin" src="/admin"
          style={{ flex: 1, height: '100%', border: 'none', pointerEvents: dragging ? 'none' : 'auto', background: 'var(--bg, #fff)' }} />
      </div>
    </div>
  );
}
