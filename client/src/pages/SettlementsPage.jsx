import { useState, useEffect } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { useCountUp } from '../lib/useCountUp.js';
import { useIsMobile } from '../lib/useIsMobile.js';
import { vtNavigate } from '../lib/viewTransition.js';
import { fmtR } from '../lib/money.js';

// Settlement reports index: one card per report, newest first, leading with the
// number the client actually cares about — what's due to them.
export default function SettlementsPage() {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  // In an admin client-preview the layout passes the previewed entity — scope
  // both lists to it so the preview never leaks other clients' reports.
  const { previewEntityId } = useOutletContext() || {};
  const { isAdmin } = useAuth();
  const [rawList, setRawList] = useState(null);
  const [rawDocs, setRawDocs] = useState([]);
  const [error, setError] = useState(null);

  const reload = () => api.mySettlements().then(setRawList).catch((e) => setError(e.message));
  useEffect(() => {
    reload();
    api.myDocuments().then(setRawDocs).catch(() => {});
  }, []);

  if (error) return <Centered error>Error: {error}</Centered>;
  if (!rawList) return <Centered>Loading settlements…</Centered>;

  const list = previewEntityId ? rawList.filter((s) => s.entityId === previewEntityId) : rawList;
  const docs = previewEntityId ? rawDocs.filter((d) => d.entityId === previewEntityId) : rawDocs;

  // Categorise everything BY EVENT. Each event holds its settlement cards (split
  // by product — ticketing / cashless, each a hero "final" + weekly history) AND
  // its invoices/documents. Settlements & documents link to an event by name.
  const events = [];
  const eventOf = (name) => {
    const key = (name || '').trim() || 'Other';
    let e = events.find((x) => x.key === key);
    if (!e) { e = { key, settlements: [], docs: [] }; events.push(e); }
    return e;
  };
  for (const s of list) eventOf(s.eventName || s.title).settlements.push(s);
  for (const d of docs) eventOf(d.eventName).docs.push(d);

  const dateOf = (x) => String(x.settlementDate || x.invoiceDate || x.createdAt || '');
  for (const e of events) {
    // Within an event, split settlements by product; hero = final (else newest).
    const byKind = [];
    for (const s of e.settlements) {
      const k = s.kind || 'ticketing';
      let g = byKind.find((x) => x.kind === k);
      if (!g) { g = { kind: k, items: [] }; byKind.push(g); }
      g.items.push(s);
    }
    for (const g of byKind) {
      g.items.sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
      g.hero = g.items.find((x) => x.status === 'final') || g.items[0];
      g.rest = g.items.filter((x) => x !== g.hero);
    }
    e.byKind = byKind;
    e.meta = e.settlements[0] || null;                                   // venue/dates for the heading
    e.latest = [...e.settlements, ...e.docs].map(dateOf).sort().pop() || '';
  }
  events.sort((a, b) => b.latest.localeCompare(a.latest));               // most recent event first

  const open = (s) => vtNavigate(navigate, `/settlements/${s.id}`);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? 14 : 26 }}>
      <PageHeader title="Settlements" />
      <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 20 }}>Your settlements and invoices, grouped by event — every payout, fee and advance in one interactive view.</p>
      {events.length === 0 ? (
        <Centered>No settlements or invoices yet. They'll appear here, grouped by event, once Howler publishes one for you.</Centered>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          {events.map((e, i) => (
            <section key={e.key} className="tile-enter" style={{ animationDelay: `${i * 50}ms` }}>
              <div style={{ marginBottom: 12 }}>
                <h2 style={{ fontSize: isMobile ? 17 : 20, fontWeight: 700, letterSpacing: '-0.02em' }}>{e.key}</h2>
                {e.meta && [e.meta.venue, e.meta.eventDates].filter(Boolean).length > 0 && (
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{[e.meta.venue, e.meta.eventDates].filter(Boolean).join(' · ')}</div>
                )}
              </div>
              {e.byKind.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(360px, 1fr))', gap: 16, alignItems: 'start' }}>
                  {e.byKind.map((g) => (
                    <div key={g.kind} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {isAdmin && g.hero.needsReview && <DraftBanner s={g.hero} onOpen={() => open(g.hero)} onPublished={reload} />}
                      <SettlementCard s={g.hero} onOpen={() => open(g.hero)} isAdmin={isAdmin} />
                      {g.rest.length > 0 && <HistoryList items={g.rest} onOpen={open} isAdmin={isAdmin} />}
                    </div>
                  ))}
                </div>
              )}
              {e.docs.length > 0 && <EventDocuments docs={e.docs} isMobile={isMobile} hasSettlements={e.byKind.length > 0} />}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

// Invoices & documents for ONE event (the page already groups by event, so this
// is just the list of that event's paperwork under its settlement cards).
function EventDocuments({ docs, isMobile, hasSettlements }) {
  const navigate = useNavigate();
  return (
    <div style={{ marginTop: hasSettlements ? 14 : 0 }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginBottom: 8 }}>Invoices & documents</div>
      <div style={{ background: 'var(--tile-bg, var(--card))', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-sm)', padding: '6px 8px', maxWidth: isMobile ? 'none' : 560 }}>
        {docs.map((doc) => (
          <div key={doc.id} className="nav-row" style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 8px', borderRadius: 8, color: 'var(--text)' }}>
            <button onClick={() => vtNavigate(navigate, `/documents/${doc.id}`)} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 9, border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', padding: 0, color: 'var(--text)' }}>
              <span style={{ fontSize: 15, flexShrink: 0 }}>🧾</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.title}</span>
                <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)' }}>{[doc.invoiceDate || new Date(doc.createdAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }), doc.total != null && fmtR(doc.total)].filter(Boolean).join(' · ')}</span>
              </span>
              <span style={{ color: 'var(--brand)', fontSize: 13, fontWeight: 600, flexShrink: 0 }}>View →</span>
            </button>
            <a href={`/api/documents/${doc.id}/file`} title="Download" style={{ flexShrink: 0, color: 'var(--muted)', textDecoration: 'none', fontSize: 14, padding: '0 4px' }}>⤓</a>
          </div>
        ))}
      </div>
    </div>
  );
}

// Compact history under an event's hero card — typically the weekly
// settlements leading up to the final.
function HistoryList({ items, onOpen, isAdmin }) {
  const [open, setOpen] = useState(items.length <= 3);
  const weeklies = items.filter((s) => s.status === 'weekly').length;
  const label = weeklies === items.length
    ? `${items.length} weekly settlement${items.length === 1 ? '' : 's'}`
    : `${items.length} earlier settlement${items.length === 1 ? '' : 's'}`;
  return (
    <div style={{ background: 'var(--tile-bg, var(--card))', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
      <button onClick={() => setOpen((v) => !v)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--muted-2)', fontSize: 12, fontWeight: 600 }}>
        <span className="nav-caret" style={{ fontSize: 9, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .2s' }}>▶</span>
        {label}
      </button>
      <div className={`collapsey${open ? ' open' : ''}`}>
        <div className="collapsey-inner">
          <div style={{ padding: '0 6px 6px' }}>
            {items.map((s) => (
              <button key={s.id} className="nav-row" onClick={() => onOpen(s)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', padding: '7px 8px', borderRadius: 8, fontSize: 12.5, color: 'var(--text)' }}>
                {isAdmin && s.needsReview && <span title="Needs review — hidden from the client">⚠️</span>}
                {isAdmin && s.source === 'email' && <span title="Auto-ingested from email">📥</span>}
                <StatusBadge status={s.status} />
                <span style={{ color: 'var(--muted)' }}>{s.settlementDate || ''}</span>
                <span style={{ flex: 1 }} />
                {s.valueDue != null && <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: s.valueDue >= 0 ? 'var(--text)' : 'var(--error)' }}>{fmtR(s.valueDue)}</span>}
                <span style={{ color: 'var(--muted)' }}>›</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function SettlementCard({ s, onOpen, isAdmin }) {
  const due = useCountUp(s.valueDue != null ? fmtR(s.valueDue) : '—');
  return (
    <button
      onClick={onOpen}
      className="howler-tile"
      style={{
        textAlign: 'left', cursor: 'pointer',
        background: 'var(--tile-bg, var(--card))', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-sm)', padding: '18px 20px',
        display: 'flex', flexDirection: 'column', gap: 10, color: 'var(--text)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em' }}>{s.eventName || s.title}</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
            {[s.venue, s.eventDates].filter(Boolean).join(' · ')}
          </div>
        </div>
        {isAdmin && s.source === 'email' && <SourceBadge />}
        <KindBadge kind={s.kind} />
        <StatusBadge status={s.status} />
      </div>
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>Value due to you</div>
        <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em', color: s.valueDue >= 0 ? 'var(--positive, #34c759)' : 'var(--error)', fontVariantNumeric: 'tabular-nums' }}>{due}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--muted)' }}>
        {s.settlementDate && <span>Settled {s.settlementDate}</span>}
        {s.turnover != null && <span>· Turnover {fmtR(s.turnover, { compact: true })}</span>}
        <span style={{ flex: 1 }} />
        <span style={{ color: 'var(--brand)', fontWeight: 600 }}>View →</span>
      </div>
    </button>
  );
}

// Admin-only banner on an Owl-drafted settlement (auto-ingested from email, but
// the totals didn't reconcile). Hidden from the client until an admin publishes.
// Rendered as a sibling of the card (not inside it) to avoid a nested button.
function DraftBanner({ s, onOpen, onPublished }) {
  const [busy, setBusy] = useState(false);
  const publish = async () => {
    if (!window.confirm(`Publish "${s.eventName || s.title}" to the client? They'll see it immediately.`)) return;
    setBusy(true);
    try { await api.adminUpdateSettlement(s.id, { needsReview: 0 }); await onPublished(); }
    catch (err) { window.alert('Could not publish: ' + err.message); } finally { setBusy(false); }
  };
  return (
    <div style={{ background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.4)', borderRadius: 'var(--radius-md)', padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12.5, fontWeight: 600, color: '#b45309', flex: 1, minWidth: 150 }}>📥 Auto-ingested from email — the totals didn't reconcile, so it's <b>hidden from the client</b>. Review, then publish.</span>
      <button onClick={onOpen} style={{ ...miniBtn, background: 'transparent', color: '#b45309', border: '1px solid rgba(245,158,11,0.5)' }}>Review</button>
      <button onClick={publish} disabled={busy} style={{ ...miniBtn, background: '#b45309', color: '#fff', border: 'none' }}>{busy ? 'Publishing…' : 'Publish to client'}</button>
    </div>
  );
}
const miniBtn = { fontSize: 12, fontWeight: 700, padding: '6px 12px', borderRadius: 980, cursor: 'pointer' };

// Provenance chip: this report was auto-ingested from a CC-the-Owl email. Admin-only.
function SourceBadge() {
  return (
    <span title="Auto-ingested from a CC-the-Owl email" style={{
      flexShrink: 0, fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 980,
      background: 'rgba(10,132,255,0.13)', color: '#0a66c2',
    }}>📥 Email</span>
  );
}

export function KindBadge({ kind }) {
  const cashless = kind === 'cashless';
  return (
    <span title={cashless ? 'Cashless settlement' : 'Ticketing settlement'} style={{
      flexShrink: 0, fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 980,
      background: 'rgba(128,128,128,0.13)', color: 'var(--muted-2)',
    }}>{cashless ? '💳 Cashless' : '🎟 Ticketing'}</span>
  );
}

export function StatusBadge({ status }) {
  const cfg = status === 'weekly'
    ? { label: 'Weekly', bg: 'rgba(10,132,255,0.15)', color: '#0a66c2' }
    : status === 'interim'
      ? { label: 'Interim', bg: 'rgba(245,158,11,0.15)', color: '#b45309' }
      : { label: 'Final', bg: 'rgba(52,199,89,0.15)', color: '#2da44e' };
  return (
    <span style={{
      flexShrink: 0, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
      padding: '3px 9px', borderRadius: 980, background: cfg.bg, color: cfg.color,
    }}>{cfg.label}</span>
  );
}

function Centered({ children, error }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48 }}>
      <p style={{ fontSize: 15, color: error ? 'var(--error)' : 'var(--muted)', textAlign: 'center' }}>{children}</p>
    </div>
  );
}
