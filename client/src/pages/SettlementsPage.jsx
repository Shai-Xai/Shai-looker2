import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
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
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.mySettlements().then(setList).catch((e) => setError(e.message));
  }, []);

  if (error) return <Centered error>Error: {error}</Centered>;
  if (!list) return <Centered>Loading settlements…</Centered>;

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? 14 : 26 }}>
      <h1 style={{ fontSize: isMobile ? 20 : 26, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 4 }}>Settlements</h1>
      <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 20 }}>Your event settlement reports — every payout, fee and advance, in one interactive view.</p>
      {list.length === 0 ? (
        <Centered>No settlement reports yet. They'll appear here once Howler publishes one for you.</Centered>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(330px, 1fr))', gap: 16 }}>
          {list.map((s, i) => <SettlementCard key={s.id} s={s} delay={i * 60} onOpen={() => vtNavigate(navigate, `/settlements/${s.id}`)} />)}
        </div>
      )}
    </div>
  );
}

function SettlementCard({ s, delay, onOpen }) {
  const due = useCountUp(s.valueDue != null ? fmtR(s.valueDue) : '—');
  return (
    <button
      onClick={onOpen}
      className="tile-enter howler-tile"
      style={{
        animationDelay: `${delay}ms`, textAlign: 'left', cursor: 'pointer',
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

export function StatusBadge({ status }) {
  const final = status !== 'interim';
  return (
    <span style={{
      flexShrink: 0, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
      padding: '3px 9px', borderRadius: 980,
      background: final ? 'rgba(52,199,89,0.15)' : 'rgba(245,158,11,0.15)',
      color: final ? '#2da44e' : '#b45309',
    }}>{final ? 'Final' : 'Interim'}</span>
  );
}

function Centered({ children, error }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48 }}>
      <p style={{ fontSize: 15, color: error ? 'var(--error)' : 'var(--muted)', textAlign: 'center' }}>{children}</p>
    </div>
  );
}
