import { createPortal } from 'react-dom';
import { useOutletContext } from 'react-router-dom';
import HomeButton from './HomeButton.jsx';

// A section page's title bar (Alerts, Goals, Event Ops, Digests…). When the
// compact top menu bar is on screen — mobile, or the sidebar collapsed — the
// kicker + title PORTAL into it (next to ☰ ‹ ⌂), so there's no second Home
// button and no tall header block eating vertical space. When the full sidebar
// is expanded (no menu bar) it renders the normal inline header with a Home
// button, exactly as before. Dashboard pages keep their own live-tile title and
// don't use this.
export default function PageHeader({ kicker, title }) {
  const ctx = useOutletContext() || {};
  const slot = ctx.titleSlot;

  if (slot) {
    return createPortal(
      <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8, overflow: 'hidden' }}>
        {kicker && <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--muted)', flexShrink: 0 }}>{kicker}</span>}
        <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
      </span>,
      slot,
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '2px 0 12px' }}>
      <HomeButton />
      <div style={{ minWidth: 0 }}>
        {kicker && <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 2 }}>{kicker}</div>}
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>{title}</h1>
      </div>
    </div>
  );
}
