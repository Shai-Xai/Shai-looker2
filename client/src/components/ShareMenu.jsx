import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

// Reusable "Share" affordance — a one-tap hand-off to the reader's OWN email,
// WhatsApp or Slack. No backend: email opens a mailto: link, WhatsApp a
// wa.me/?text= link, and Slack copies a ready-to-paste message (Slack has no
// public "share text" URL). The reader can add a custom note; we attach the
// heading, the insight/value text and a link back to this view.
//
// Trigger is rendered here so we can anchor the popover to it. Callers pass a
// `variant` to match the surrounding visual language:
//   'tile'   — bordered card icon, sits in a tile's header button cluster
//   'header' — prominent outlined "↗ Share" pill, in an insight panel's header
//   'footer' — full-width solid "↗ Share" button, at the bottom of a panel
//
// On phones the menu is a bottom sheet (big tap targets); on desktop it's a
// popover anchored to the trigger (flips above it when near the bottom edge).
export default function ShareMenu({
  heading = '',
  text = '',
  url,
  isMobile = false,
  variant = 'tile',
  label = 'Share',
  title = 'Share',
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [note, setNote] = useState('');
  const [slackDone, setSlackDone] = useState(false);
  const btnRef = useRef(null);

  const link = url || (typeof window !== 'undefined' ? window.location.href : '');
  const clean = plainify(text);

  // Email keeps the heading as the subject; the body is note + content + link.
  const subject = heading || 'Shared from Howler : Pulse';
  const body = [note.trim(), clean, link].filter(Boolean).join('\n\n');
  // WhatsApp / Slack are a single text blob (no subject line), so fold the
  // heading in.
  const blob = [note.trim(), heading, clean, link].filter(Boolean).join('\n\n');

  function openMenu() {
    if (!isMobile && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const width = Math.min(300, window.innerWidth - 16);
      const left = Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8);
      // Open below the trigger, but flip above it when there isn't room (the
      // footer button sits near the bottom of the panel/viewport).
      const estH = 300;
      const below = r.bottom + 8;
      const top = below + estH > window.innerHeight - 8 ? Math.max(8, r.top - estH - 8) : below;
      setPos({ top, left, width });
    }
    setSlackDone(false);
    setOpen(true);
  }
  const close = () => setOpen(false);

  // Close on Escape while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  function shareEmail() {
    window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    close();
  }
  function shareWhatsApp() {
    window.open(`https://wa.me/?text=${encodeURIComponent(blob)}`, '_blank', 'noopener');
    close();
  }
  async function shareSlack() {
    try { await navigator.clipboard.writeText(blob); } catch { /* clipboard blocked — fall back to manual copy */ }
    setSlackDone(true);
    // No public "share text to Slack" URL exists, so we copy the message and
    // open Slack for them to paste into any channel/DM.
    window.open('https://app.slack.com/client', '_blank', 'noopener');
    setTimeout(close, 1500);
  }

  const panelStyle = isMobile
    ? { position: 'fixed', left: 0, right: 0, bottom: 0, width: '100%', borderRadius: '18px 18px 0 0', paddingBottom: 'calc(12px + env(safe-area-inset-bottom))', ...panelBase }
    : { position: 'fixed', top: pos?.top, left: pos?.left, width: pos?.width, borderRadius: 14, ...panelBase };

  // The trigger varies by surface: an icon on dense tiles, a prominent labelled
  // pill in an insight panel's header, a full-width solid button in its footer.
  const commonProps = {
    ref: btnRef,
    className: 'no-print',
    title,
    'aria-label': title,
    onClick: openMenu,
    onMouseDown: (e) => e.stopPropagation(),
  };
  const trigger = variant === 'footer' ? (
    <button {...commonProps} style={footerBtn}><span style={{ fontSize: 16 }}>↗</span>{label}</button>
  ) : variant === 'header' ? (
    <button {...commonProps} style={{ ...headerPill, padding: isMobile ? '7px 13px' : '6px 12px' }}><span style={{ fontSize: 15 }}>↗</span>{label}</button>
  ) : (
    <button {...commonProps} style={{ ...tileIcon, width: isMobile ? 28 : 24, height: isMobile ? 28 : 24, fontSize: isMobile ? 14 : 12 }}>↗</button>
  );

  return (
    <>
      {trigger}

      {open && (pos || isMobile) && createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 498, background: isMobile ? 'rgba(0,0,0,0.35)' : 'transparent' }} onClick={close} />
          <div className="modal-in" style={panelStyle} onClick={(e) => e.stopPropagation()}>
            {isMobile && <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--hairline)', margin: '8px auto 4px' }} />}

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 4px 10px' }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', flex: 1 }}>Share</span>
              {heading && <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 500, maxWidth: '60%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{heading}</span>}
            </div>

            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a message (optional)…"
              rows={2}
              autoFocus={!isMobile}
              style={noteArea}
            />

            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 8 }}>
              <ChannelRow icon="✉️" label="Email" sub="Opens your mail app" accent="var(--brand)" onClick={shareEmail} />
              <ChannelRow icon="💬" label="WhatsApp" sub="Opens WhatsApp with your message" accent="#25D366" onClick={shareWhatsApp} />
              <ChannelRow
                icon="#"
                label="Slack"
                sub={slackDone ? '✓ Copied — paste into Slack' : 'Copies a ready-to-paste message'}
                accent="#611f69"
                onClick={shareSlack}
              />
            </div>

            <div style={{ fontSize: 10.5, color: 'var(--muted)', padding: '8px 4px 2px', lineHeight: 1.45 }}>
              We attach a link back to this view. Slack has no direct share link, so we copy a ready-to-paste message.
            </div>
          </div>
        </>,
        document.body
      )}
    </>
  );
}

function ChannelRow({ icon, label, sub, accent, onClick }) {
  return (
    <button
      style={channelItem}
      onClick={onClick}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--elevated)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <span style={{ ...channelIco, color: accent }}>{icon}</span>
      <span style={{ flex: 1, textAlign: 'left' }}>
        {label}
        <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', fontWeight: 500 }}>{sub}</span>
      </span>
    </button>
  );
}

// Strip light markdown so the shared text reads cleanly in a plain mail/chat
// body: drop "# " headings and unwrap **bold**.
function plainify(s = '') {
  return String(s)
    .split('\n')
    .map((l) => l.replace(/^#{1,6}\s+/, '').replace(/\*\*([^*]+)\*\*/g, '$1'))
    .join('\n')
    .trim();
}

const tileIcon = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--muted)', borderRadius: 7, lineHeight: 1, flexShrink: 0 };
// Prominent outlined pill — stands out next to the plain ↻ / ✕ header icons.
const headerPill = { display: 'inline-flex', alignItems: 'center', gap: 6, border: '1.5px solid var(--brand)', background: 'transparent', color: 'var(--brand)', borderRadius: 980, fontSize: 13, fontWeight: 700, cursor: 'pointer', lineHeight: 1, flexShrink: 0, whiteSpace: 'nowrap' };
// Full-width solid call-to-action for the bottom of a panel.
const footerBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', boxSizing: 'border-box', border: 'none', background: 'var(--brand)', color: '#fff', borderRadius: 12, padding: '12px 16px', fontSize: 14.5, fontWeight: 700, cursor: 'pointer', lineHeight: 1, minHeight: 44 };
const panelBase = { zIndex: 499, boxSizing: 'border-box', background: 'var(--card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-pop)', padding: 10, display: 'flex', flexDirection: 'column' };
const noteArea = { width: '100%', border: '1px solid var(--hairline)', borderRadius: 10, padding: '9px 11px', fontSize: 14, outline: 'none', resize: 'none', boxSizing: 'border-box', fontFamily: 'inherit', background: 'var(--input-bg, var(--card))', color: 'var(--text)' };
const channelItem = { display: 'flex', alignItems: 'center', gap: 12, width: '100%', border: 'none', background: 'transparent', cursor: 'pointer', padding: '11px 10px', borderRadius: 10, fontSize: 14, fontWeight: 600, color: 'var(--text)', minHeight: 44 };
const channelIco = { flexShrink: 0, width: 26, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, fontWeight: 800 };
