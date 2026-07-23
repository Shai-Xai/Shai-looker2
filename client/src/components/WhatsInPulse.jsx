// Client-facing "What's in Pulse" — the product feature matrix as a grid of
// section tiles (app-launcher style). Tapping a tile opens a bottom sheet with
// that section's features; tapping a feature reveals its plain-language
// explanation, and non-live features carry a CTA that pre-fills a request in the
// Product board. Content comes from the same public catalogue as the sales site
// (GET /api/product/site), so the admin's show/hide choices apply here too.
import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';
import ReportForm from './ReportForm.jsx';

// Status wording for clients (the sales site keeps the blunter ✅🟡🧪🔜 key).
const STATUS = {
  live: { label: '✓ Live', short: '✓', color: 'var(--success)', bg: 'rgba(52,160,90,0.14)' },
  setup: { label: 'Ask us', short: '🟡', color: 'var(--warn)', bg: 'rgba(214,158,46,0.16)' },
  beta: { label: 'Early access', short: 'β', color: 'var(--ai)', bg: 'var(--ai-bg)' },
  soon: { label: 'On the way', short: '…', color: 'var(--muted)', bg: 'rgba(128,128,128,0.14)' },
};
const statusMeta = (s) => STATUS[s] || STATUS.live;

// The CTA a non-live feature offers, per status: button text + the pre-typed
// request it seeds in the report form.
function ctaFor(status, name, sectionTitle) {
  const from = `(from What's in Pulse · ${sectionTitle})`;
  if (status === 'setup') return { text: 'Ask us to switch it on →', prefill: { type: 'improvement', title: `Switch on: ${name}`, body: `We'd like "${name}" switched on for us. ${from}` } };
  if (status === 'beta') return { text: 'Interested? Try it early →', prefill: { type: 'idea', title: `Early access: ${name}`, body: `We'd like early access to "${name}". ${from}` } };
  if (status === 'soon') return { text: 'Keep me posted →', prefill: { type: 'idea', title: `Keep me posted: ${name}`, body: `Please keep us posted when "${name}" lands. ${from}` } };
  return null;
}

// Sections that describe Howler-internal tooling — real (and shown on the public
// sales site), but noise inside a client's own app.
const INTERNAL_SECTIONS = new Set(['admin']);

const shortTitle = (t) => String(t).split(' — ')[0];
const featureName = (label) => String(label).split(' — ')[0];

export default function WhatsInPulse() {
  const isMobile = useIsMobile();
  const [sections, setSections] = useState(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);      // section whose sheet is open
  const [prefill, setPrefill] = useState(null);    // ReportForm prefill (form open while set)

  useEffect(() => {
    api.productSite()
      .then((r) => setSections((r.sections || []).filter((s) => !INTERNAL_SECTIONS.has(s.id))))
      .catch((e) => setError(e.message));
  }, []);

  const open = sections?.find((s) => s.id === openId) || null;

  return (
    <div>
      <p style={{ color: 'var(--muted)', fontSize: 14, marginBottom: 10 }}>
        Everything included in your Pulse — and what we can switch on next. Tap a tile to explore.
      </p>
      {/* Status legend */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
        {Object.entries(STATUS).map(([k, s]) => (
          <span key={k} style={{ ...pillStyle(s), fontSize: 12, padding: '4px 10px' }}>{s.label}</span>
        ))}
      </div>

      {error && <p style={{ color: 'var(--brand)', fontSize: 13 }}>{error}</p>}
      {!sections ? (
        <p style={{ color: 'var(--muted)' }}>Loading…</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
          {sections.map((s) => <SectionTile key={s.id} section={s} onOpen={() => setOpenId(s.id)} />)}
        </div>
      )}

      {open && (
        <SectionSheet
          section={open}
          isMobile={isMobile}
          onClose={() => setOpenId(null)}
          onAsk={(p) => setPrefill(p)}
        />
      )}

      <ReportForm
        open={!!prefill}
        onClose={() => setPrefill(null)}
        screen="What's in Pulse"
        prefill={prefill || undefined}
      />
    </div>
  );
}

function SectionTile({ section, onOpen }) {
  // Status counts, in a fixed order so tiles read consistently.
  const counts = {};
  for (const f of section.features) counts[f.status] = (counts[f.status] || 0) + 1;
  return (
    <button
      onClick={onOpen}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8, textAlign: 'left',
        background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius, 16px)',
        boxShadow: 'var(--shadow-sm)', padding: '14px 13px 12px', minHeight: 122, cursor: 'pointer',
        color: 'var(--text)', fontFamily: 'inherit', letterSpacing: 'inherit',
      }}
    >
      <span style={{ width: 40, height: 40, borderRadius: 12, background: 'rgba(var(--brand-rgb), 0.08)', display: 'grid', placeItems: 'center', fontSize: 19 }}>{section.emoji}</span>
      <span style={{ fontSize: 14, fontWeight: 650, letterSpacing: '-0.01em', lineHeight: 1.25 }}>{shortTitle(section.title)}</span>
      <span style={{ marginTop: 'auto', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {['live', 'setup', 'beta', 'soon'].filter((k) => counts[k]).map((k) => {
          const s = statusMeta(k);
          return <span key={k} title={`${counts[k]} × ${s.label}`} style={{ ...pillStyle(s), fontSize: 10, padding: '2.5px 7px' }}>{counts[k]} {s.short}</span>;
        })}
      </span>
    </button>
  );
}

// The drill-in: a bottom sheet on mobile, a centred modal on desktop. One
// feature's explanation open at a time; the "tooltip" is a tap, not a hover.
function SectionSheet({ section, isMobile, onClose, onAsk }) {
  const [expanded, setExpanded] = useState(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 150, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: isMobile ? 'flex-end' : 'center', justifyContent: 'center',
        padding: isMobile ? 0 : 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label={section.title}
        style={{
          width: '100%', maxWidth: isMobile ? 'none' : 520, background: 'var(--card)',
          borderRadius: isMobile ? '18px 18px 0 0' : 16, border: '1px solid var(--hairline)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.35)', maxHeight: isMobile ? '88dvh' : '84vh',
          display: 'flex', flexDirection: 'column', overflow: 'hidden', paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        {isMobile && <div style={{ width: 36, height: 5, borderRadius: 3, background: 'rgba(128,128,128,0.35)', margin: '8px auto 0', flex: '0 0 auto' }} />}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--hairline)', flex: '0 0 auto' }}>
          <span style={{ width: 40, height: 40, borderRadius: 12, background: 'rgba(var(--brand-rgb), 0.08)', display: 'grid', placeItems: 'center', fontSize: 19, flex: '0 0 auto' }}>{section.emoji}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em' }}>{shortTitle(section.title)}</div>
            {section.blurb && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 1 }}>{section.blurb}</div>}
          </div>
          <button onClick={onClose} aria-label="Close" style={{ width: 40, height: 40, borderRadius: '50%', border: 'none', background: 'rgba(128,128,128,0.14)', color: 'var(--muted-2)', fontSize: 15, fontWeight: 700, cursor: 'pointer', flex: '0 0 auto' }}>✕</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '2px 0 20px' }}>
          {section.features.map((f) => (
            <FeatureRow
              key={f.id} feature={f} sectionTitle={shortTitle(section.title)}
              open={expanded === f.id}
              onToggle={() => setExpanded(expanded === f.id ? null : f.id)}
              onAsk={onAsk}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function FeatureRow({ feature, sectionTitle, open, onToggle, onAsk }) {
  const s = statusMeta(feature.status);
  const name = featureName(feature.label);
  // Explanation: the curated desc; if a feature ships without one, fall back to
  // the label's own detail tail so the row is never a dead end.
  const desc = feature.desc || (feature.label.includes(' — ') ? feature.label.slice(name.length + 3) : '');
  const cta = ctaFor(feature.status, name, sectionTitle);
  return (
    <div style={{ borderBottom: '1px solid var(--hairline)', background: open ? 'var(--row-stripe, rgba(128,128,128,0.05))' : 'transparent' }}>
      <button
        onClick={onToggle} aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 44, padding: '10px 16px',
          background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
          color: 'var(--text)', fontSize: 13.5, fontWeight: 550, fontFamily: 'inherit', letterSpacing: 'inherit',
        }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>{name}</span>
        <span style={{ ...pillStyle(s), fontSize: 10.5, padding: '3px 8px' }}>{s.label}</span>
        <span aria-hidden style={{
          width: 17, height: 17, borderRadius: '50%', flex: '0 0 auto',
          border: `1.4px solid ${open ? 'var(--brand)' : 'var(--muted)'}`, color: open ? 'var(--brand)' : 'var(--muted)',
          fontSize: 10.5, fontWeight: 700, display: 'grid', placeItems: 'center', fontStyle: 'normal',
        }}>i</span>
      </button>
      {open && (desc || cta) && (
        <div style={{ padding: '0 16px 13px', fontSize: 13, lineHeight: 1.5, color: 'var(--muted-2, var(--muted))' }}>
          {desc}
          {cta && (
            <div style={{ marginTop: 9 }}>
              <button
                onClick={() => onAsk(cta.prefill)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 36, padding: '8px 13px',
                  borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 650, fontFamily: 'inherit',
                  color: feature.status === 'setup' ? '#fff' : 'var(--brand)',
                  background: feature.status === 'setup' ? 'var(--brand)' : 'rgba(var(--brand-rgb), 0.10)',
                }}
              >{cta.text}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const pillStyle = (s) => ({
  display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 999,
  fontWeight: 650, whiteSpace: 'nowrap', color: s.color, background: s.bg,
});
