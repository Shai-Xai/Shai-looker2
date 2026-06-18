import { useState, useEffect } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import HomeButton from '../components/HomeButton.jsx';
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

  // Group by event + product: an event accrues many weekly settlements per
  // product (ticketing / cashless), then one final each. The hero card is the
  // final (else the most recent report); the rest sit in a compact history
  // list under it.
  const groups = [];
  for (const s of list) {
    const key = `${s.eventName || s.title}|${s.kind || 'ticketing'}`;
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, items: [] }; groups.push(g); }
    g.items.push(s);
  }
  for (const g of groups) {
    g.items.sort((a, b) => String(b.settlementDate || b.createdAt).localeCompare(String(a.settlementDate || a.createdAt)));
    g.hero = g.items.find((x) => x.status === 'final') || g.items[0];
    g.rest = g.items.filter((x) => x !== g.hero);
  }

  const open = (s) => vtNavigate(navigate, `/settlements/${s.id}`);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? 14 : 26 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <HomeButton />
        <h1 style={{ fontSize: isMobile ? 20 : 26, fontWeight: 700, letterSpacing: '-0.02em' }}>Settlements</h1>
      </div>
      <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 20 }}>Your event settlement reports — every payout, fee and advance, in one interactive view.</p>
      {list.length === 0 ? (
        <Centered>No settlement reports yet. They'll appear here once Howler publishes one for you.</Centered>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(360px, 1fr))', gap: 16, alignItems: 'start' }}>
          {groups.map((g, i) => (
            <div key={g.key} className="tile-enter" style={{ animationDelay: `${i * 60}ms`, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {isAdmin && g.hero.needsReview && <DraftBanner s={g.hero} onOpen={() => open(g.hero)} onPublished={reload} />}
              <SettlementCard s={g.hero} onOpen={() => open(g.hero)} isAdmin={isAdmin} />
              {g.rest.length > 0 && <HistoryList items={g.rest} onOpen={open} isAdmin={isAdmin} />}
            </div>
          ))}
        </div>
      )}
      {docs.length > 0 && <DocumentsSection docs={docs} isMobile={isMobile} />}
    </div>
  );
}

// Invoices & other paperwork uploaded for this client's events.
function DocumentsSection({ docs, isMobile }) {
  const navigate = useNavigate();
  const groups = [];
  for (const doc of docs) {
    const key = doc.eventName || 'Other documents';
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, items: [] }; groups.push(g); }
    g.items.push(doc);
  }
  return (
    <div style={{ marginTop: 28 }}>
      <h2 style={{ fontSize: isMobile ? 16 : 19, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 12 }}>Invoices & documents</h2>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(360px, 1fr))', gap: 16, alignItems: 'start' }}>
        {groups.map((g) => (
          <div key={g.key} style={{ background: 'var(--tile-bg, var(--card))', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-sm)', padding: '12px 14px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginBottom: 8 }}>{g.key}</div>
            {g.items.map((doc) => (
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
