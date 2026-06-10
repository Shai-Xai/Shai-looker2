import { useState, useEffect } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
import { useCountUp } from '../lib/useCountUp.js';
import { vtNavigate } from '../lib/viewTransition.js';
import AiMark from '../components/AiMark.jsx';
import { fmtR } from '../lib/money.js';

// Personalised landing page (briefing-led): the Owl opens with what changed
// since the user's last visit, grounded in live KPI facts; below it the KPI
// strip, the user's most-visited shortcuts, a settlement teaser, and the
// suites grid. Facts are deterministic (server-side queries); the Owl only
// phrases them, and every deep link is validated server-side.
export default function ClientHome() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { user } = useAuth();
  const { previewEntityId } = useOutletContext() || {};
  const [suites, setSuites] = useState([]);
  const [snap, setSnap] = useState(null);
  const [brief, setBrief] = useState(null); // null=loading, {available:false}=hidden
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErr, setRefreshErr] = useState(false);

  useEffect(() => { api.mySuites().then(setSuites).catch(() => {}); }, []);
  useEffect(() => {
    setSnap(null); setBrief(null);
    api.mySnapshot(previewEntityId).then(setSnap).catch(() => setSnap({ kpis: [], shortcuts: [], settlement: null, lastVisit: null }));
    api.myBriefing(previewEntityId).then(setBrief).catch(() => setBrief({ available: false }));
  }, [previewEntityId]);

  // Refresh re-pulls the live numbers AND regenerates the briefing — otherwise
  // the Owl just re-phrases the same cached facts and looks unchanged.
  const refreshBrief = () => {
    setRefreshing(true);
    setRefreshErr(false);
    api.mySnapshot(previewEntityId, true).then(setSnap).catch(() => {});
    api.myBriefing(previewEntityId, true)
      .then((b) => setBrief(b))
      .catch(() => setRefreshErr(true))
      .finally(() => setRefreshing(false));
  };

  const go = (suiteId, dashboardId) => vtNavigate(navigate, `/suite/${suiteId}/d/${dashboardId}`);
  async function openSuite(su) {
    try {
      const d = await api.mySuite(su.id);
      const first = d.sets.flatMap((s) => s.dashboards)[0];
      if (first) go(su.id, first.id);
    } catch { /* ignore */ }
  }

  const firstName = deriveFirstName(user?.email);
  const visibleSuites = previewEntityId ? suites.filter((s) => s.entityId === previewEntityId) : suites;
  const kpis = snap?.kpis || [];
  const shortcuts = snap?.shortcuts || [];

  return (
    <main style={{ flex: 1, padding: isMobile ? '18px 14px' : '30px 30px 40px', maxWidth: 1060, margin: '0 auto', width: '100%' }}>
      {/* Greeting */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h1 style={{ fontSize: isMobile ? 21 : 25, fontWeight: 800, letterSpacing: '-0.02em' }}>
            {timeGreeting()}{firstName ? `, ${firstName}` : ''} 👋
          </h1>
          <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 2 }}>
            {todayLine()}{snap?.lastVisit ? ` · Here's what changed since your last visit ${relDay(snap.lastVisit)}.` : ''}
          </p>
        </div>
      </div>

      {/* The Owl's briefing */}
      {brief?.available !== false && (
        <div className="ai-glow" style={{ ...briefCard, marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <AiMark size={26} />
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' }}>Your briefing</span>
            <span style={{ flex: 1 }} />
            {brief?.generatedAt && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{new Date(brief.generatedAt).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}</span>}
            {refreshErr && <span style={{ fontSize: 11, color: 'var(--error)' }} title="Couldn't refresh — try again">⚠</span>}
            <button onClick={refreshBrief} disabled={refreshing} title="Regenerate briefing" style={refreshBtn}>{refreshing ? '…' : '↻ Refresh'}</button>
          </div>
          {brief == null || refreshing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9, padding: '2px 0 4px' }}>
              <div className="skel" style={{ width: '88%', height: 13 }} />
              <div className="skel" style={{ width: '70%', height: 13 }} />
              <div className="skel" style={{ width: '78%', height: 13 }} />
            </div>
          ) : (
            <>
              <p style={{ fontSize: isMobile ? 14 : 14.5, lineHeight: 1.65 }}>{bold(brief.headline)}</p>
              {(brief.bullets || []).length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 10 }}>
                  {brief.bullets.map((b, i) => (
                    <div key={i} className="msg-in" style={{ display: 'flex', gap: 8, fontSize: 13.5, lineHeight: 1.55, animationDelay: `${i * 70}ms` }}>
                      <span style={{ color: 'var(--brand)', flexShrink: 0 }}>●</span>
                      <span>
                        {bold(b.text)}{' '}
                        {b.link && (
                          <button onClick={() => go(b.link.suiteId, b.link.dashboardId)} style={inlineLink}>{b.link.label} →</button>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* KPI strip */}
      {kpis.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : `repeat(${Math.min(kpis.length, 4)}, 1fr)`, gap: 12, marginTop: 16 }}>
          {kpis.slice(0, isMobile ? 4 : 8).map((k, i) => <Kpi key={k.title} k={k} delay={i * 60} onOpen={() => go(k.suiteId, k.dashboardId)} />)}
        </div>
      )}
      {snap == null && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: 12, marginTop: 16 }}>
          {[0, 1, 2, 3].map((i) => <div key={i} className="skel" style={{ height: 86, borderRadius: 14 }} />)}
        </div>
      )}

      {/* Suggestions from the Owl */}
      {(brief?.suggestions || []).length > 0 && (
        <>
          <SectionHead icon="✨">Worth a look</SectionHead>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : `repeat(${Math.min(brief.suggestions.length, 3)}, 1fr)`, gap: 12 }}>
            {brief.suggestions.map((s, i) => (
              <button key={i} className="lift" style={cardBtn} onClick={() => go(s.link.suiteId, s.link.dashboardId)}>
                <div style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.4 }}>{s.title}</div>
                {s.reason && <div style={{ fontSize: 12, color: 'var(--muted-2)', lineHeight: 1.5, marginTop: 4 }}>{s.reason}</div>}
                <div style={{ marginTop: 9, fontSize: 12, fontWeight: 700, color: 'var(--brand)' }}>{s.link.label} →</div>
              </button>
            ))}
          </div>
        </>
      )}

      {/* Personal shortcuts (browsing-based) */}
      {shortcuts.length > 0 && (
        <>
          <SectionHead icon="⚡">Your shortcuts <Faint>based on what you check most</Faint></SectionHead>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : `repeat(${Math.min(shortcuts.length, 4)}, 1fr)`, gap: 12 }}>
            {shortcuts.map((s) => (
              <button key={s.dashboardId} className="lift" style={cardBtn} onClick={() => go(s.suiteId || s.link?.suiteId, s.dashboardId)}>
                <div style={{ fontSize: 13.5, fontWeight: 700 }}>{s.title}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>{s.setName} · viewed {s.count}×</div>
                <div style={{ marginTop: 9, fontSize: 12, fontWeight: 700, color: 'var(--brand)' }}>Jump back in →</div>
              </button>
            ))}
          </div>
        </>
      )}

      {/* Settlement teaser */}
      {snap?.settlement && (
        <button className="lift" style={settleCard} onClick={() => vtNavigate(navigate, `/settlements/${snap.settlement.id}`)}>
          <span style={{ fontSize: 20, flexShrink: 0 }}>🧾</span>
          <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
            <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700 }}>
              {snap.settlement.status === 'final' ? 'Final settlement published' : 'New settlement'} — {snap.settlement.eventName || snap.settlement.title}
            </span>
            <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>
              {[snap.settlement.kind === 'cashless' ? 'Cashless' : 'Ticketing', snap.settlement.settlementDate && `settled ${snap.settlement.settlementDate}`].filter(Boolean).join(' · ')}
            </span>
          </span>
          {snap.settlement.valueDue != null && <span style={{ fontSize: 17, fontWeight: 800, color: '#2da44e', flexShrink: 0 }}>{fmtR(snap.settlement.valueDue)}</span>}
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--brand)', flexShrink: 0 }}>View →</span>
        </button>
      )}

      {/* Suites */}
      <SectionHead>Your suites</SectionHead>
      {visibleSuites.length === 0 ? (
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>No suites have been assigned to your account yet.</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
          {visibleSuites.map((su) => (
            <button key={su.id} className="lift" style={cardBtn} onClick={() => openSuite(su)}>
              {su.icon && (su.icon.startsWith('data:')
                ? <img src={su.icon} alt="" style={{ width: 30, height: 30, objectFit: 'contain', marginBottom: 8 }} />
                : <div style={{ fontSize: 26, marginBottom: 4 }}>{su.icon}</div>)}
              <div style={{ fontSize: 15, fontWeight: 700 }}>{su.name}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>{su.dashboardCount} dashboard{su.dashboardCount === 1 ? '' : 's'}</div>
              <div style={{ marginTop: 10, fontSize: 12, fontWeight: 700, color: 'var(--brand)' }}>Open →</div>
            </button>
          ))}
        </div>
      )}
    </main>
  );
}

function Kpi({ k, delay, onOpen }) {
  const value = useCountUp(k.value);
  return (
    <button className="tile-enter lift" style={{ ...cardBtn, animationDelay: `${delay}ms` }} onClick={onOpen}>
      <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>{k.title}</div>
      <div style={{ fontSize: 'clamp(17px, 2vw, 22px)', fontWeight: 800, letterSpacing: '-0.02em', marginTop: 3, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
      {k.sub && <div style={{ fontSize: 11, fontWeight: 700, marginTop: 2, color: deltaColor(k.sub) }}>{k.sub}</div>}
      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k.setName} · {k.dashTitle}</div>
    </button>
  );
}

function SectionHead({ icon, children }) {
  return <h2 style={{ fontSize: 14, fontWeight: 800, letterSpacing: '-0.01em', margin: '22px 0 10px', display: 'flex', alignItems: 'center', gap: 7 }}>{icon && <span>{icon}</span>}{children}</h2>;
}
function Faint({ children }) { return <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--muted)' }}>{children}</span>; }

// "shai.evian@howler.co.za" → "Shai"
function deriveFirstName(email) {
  const head = String(email || '').split('@')[0].split(/[._\-+]/)[0];
  return head ? head.charAt(0).toUpperCase() + head.slice(1) : '';
}
function timeGreeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}
function todayLine() {
  return new Date().toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long' });
}
function relDay(iso) {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 864e5);
  if (days <= 0) return 'earlier today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `on ${d.toLocaleDateString('en-ZA', { weekday: 'long' })}`;
  return `on ${d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}`;
}
// **bold** → <b>
function bold(text) {
  return String(text || '').split(/(\*\*[^*]+\*\*)/g).map((p, i) =>
    p.startsWith('**') && p.endsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : p);
}
function deltaColor(sub) {
  const s = String(sub);
  if (/^[▼\-−]|(-\d)/.test(s.trim())) return 'var(--error)';
  if (/[▲+]|up /i.test(s)) return '#2da44e';
  return 'var(--muted-2)';
}

const briefCard = { background: 'var(--tile-bg, var(--card))', border: '1px solid var(--border)', borderRadius: 16, boxShadow: 'var(--shadow-sm)', padding: '16px 18px' };
const cardBtn = { textAlign: 'left', background: 'var(--tile-bg, var(--card))', border: '1px solid var(--border)', borderRadius: 14, padding: '13px 15px', cursor: 'pointer', boxShadow: 'var(--shadow-sm)', color: 'var(--text)', width: '100%' };
const settleCard = { display: 'flex', alignItems: 'center', gap: 12, width: '100%', marginTop: 16, background: 'linear-gradient(90deg, rgba(52,199,89,0.10), transparent 60%) var(--tile-bg, var(--card))', border: '1px solid rgba(52,199,89,0.35)', borderRadius: 14, padding: '13px 16px', cursor: 'pointer', color: 'var(--text)' };
const refreshBtn = { border: 'none', background: 'var(--ai-bg, rgba(124,58,237,0.08))', color: 'var(--ai, #7c3aed)', borderRadius: 980, padding: '4px 11px', fontSize: 11, fontWeight: 700, cursor: 'pointer', flexShrink: 0 };
const inlineLink = { border: 'none', background: 'transparent', color: 'var(--ai, #7c3aed)', fontWeight: 700, fontSize: 12.5, cursor: 'pointer', padding: 0, fontFamily: 'inherit' };
