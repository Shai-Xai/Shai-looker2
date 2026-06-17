import { useState, useEffect, useRef } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
import { vtNavigate } from '../lib/viewTransition.js';
import AiMark from '../components/AiMark.jsx';
import BriefingTuneModal from '../components/BriefingTuneModal.jsx';
import OnboardingCard from '../components/OnboardingCard.jsx';
import DigestHistory from '../components/DigestHistory.jsx';
import { useProfile } from '../lib/profile.jsx';
import OwlQuips from '../components/OwlQuips.jsx';
import TileFrame from '../components/TileFrame.jsx';
import { ScopeProvider } from '../lib/ScopeContext.jsx';
import { useAccess, PERMS } from '../lib/access.js';
import { fmtR } from '../lib/money.js';

// Personalised landing page (briefing-led): the Owl opens with what changed
// since the user's last visit, grounded in live KPI facts; below it the KPI
// strip, the user's most-visited shortcuts, a settlement teaser, and the
// suites grid. Facts are deterministic (server-side queries); the Owl only
// phrases them, and every deep link is validated server-side.
export default function ClientHome() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { user, isAdmin } = useAuth();
  const { can } = useAccess(); // role gates the campaign affordances on home
  const { activeEntityId } = useProfile();
  const { previewEntityId } = useOutletContext() || {};
  const homeEntityId = previewEntityId || activeEntityId || (user?.entityIds || [])[0] || '';
  const [suites, setSuites] = useState([]);
  const [snap, setSnap] = useState(null);
  const [brief, setBrief] = useState(null); // null=loading, {available:false}=hidden
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErr, setRefreshErr] = useState(false);
  const [tuneOpen, setTuneOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [dismissed, setDismissed] = useState([]);

  useEffect(() => { api.mySuites().then(setSuites).catch(() => {}); }, []);
  useEffect(() => {
    // Guard against a stale profile's responses landing after the active profile
    // changed: a multi-profile login (e.g. an admin previewing several clients)
    // otherwise shows the WRONG client's briefing/snapshot when an older, slower
    // fetch resolves last. Only the current entity's responses are applied.
    let alive = true;
    setSnap(null); setBrief(null); setMessages([]);
    // Pre-warm in the background: top dashboards' tiles into the query cache +
    // the briefing (coalesced with our own fetch below), so the first click and
    // briefing of the session are warm. Same hour as the briefing so it hits.
    api.prewarm(homeEntityId, new Date().getHours());
    api.mySnapshot(homeEntityId).then((s) => { if (alive) setSnap(s); }).catch(() => { if (alive) setSnap({ kpis: [], shortcuts: [], settlement: null, lastVisit: null }); });
    api.myBriefing(homeEntityId).then((b) => { if (alive) setBrief(b); }).catch(() => { if (alive) setBrief({ available: false }); });
    api.osInbox(homeEntityId).then((r) => { if (alive) setMessages(r.threads || []); }).catch(() => {});
    api.getDismissedThreads().then((r) => { if (alive) setDismissed(r.dismissed || []); }).catch(() => {});
    return () => { alive = false; };
  }, [homeEntityId]);
  const dismissMessage = (id) => {
    setDismissed((d) => [...d, id]); // optimistic
    api.dismissThread(id).catch(() => {});
  };
  // Reorder pinned tiles (←/→). Optimistic local swap + persist the new order.
  const movePin = (index, dir) => {
    setSnap((s) => {
      const list = [...(s?.pinnedTiles || [])];
      const j = index + dir;
      if (j < 0 || j >= list.length) return s;
      [list[index], list[j]] = [list[j], list[index]];
      api.savePinOrder(homeEntityId, list.map((p) => `${p.dashboardId}|${p.tile.id}`)).catch(() => {});
      return { ...s, pinnedTiles: list };
    });
  };

  // Refresh re-pulls the live numbers AND regenerates the briefing — otherwise
  // the Owl just re-phrases the same cached facts and looks unchanged.
  const refreshBrief = () => {
    setRefreshing(true);
    setRefreshErr(false);
    api.mySnapshot(homeEntityId, true).then(setSnap).catch(() => {});
    api.myBriefing(homeEntityId, true)
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
  const visibleSuites = homeEntityId ? suites.filter((s) => s.entityId === homeEntityId) : suites;
  const shortcuts = snap?.shortcuts || [];

  return (
    <main style={{ flex: 1, padding: isMobile ? '18px 14px' : '30px 30px 40px', maxWidth: 1060, margin: '0 auto', width: '100%' }}>
      {/* Greeting */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h1 style={{ fontSize: isMobile ? 21 : 25, fontWeight: 800, letterSpacing: '-0.02em' }}>
            Howzat{firstName ? `, ${firstName}` : ''} 👋
          </h1>
          <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 2 }}>
            {todayLine()}{snap?.lastVisit ? ` · Here's what changed since your last visit ${relDay(snap.lastVisit)}.` : ''}
          </p>
        </div>
      </div>

      {/* Getting-started checklist — hides once complete or dismissed */}
      <div style={{ marginTop: 16 }}><OnboardingCard entityId={homeEntityId} /></div>

      {/* The Owl's briefing */}
      {brief?.available !== false && (
        <div className="ai-glow" style={{ ...briefCard, marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <AiMark size={26} />
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' }}>Your briefing</span>
            <span style={{ flex: 1 }} />
            {brief?.generatedAt && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{new Date(brief.generatedAt).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}</span>}
            {refreshErr && <span style={{ fontSize: 11, color: 'var(--error)' }} title="Couldn't refresh — try again">⚠</span>}
            <button onClick={() => setTuneOpen(true)} title="Tune your briefing — focus, event dates, phases" style={refreshBtn}>⚙ Tune</button>
            <button onClick={refreshBrief} disabled={refreshing} title="Regenerate briefing" style={refreshBtn}>{refreshing ? '…' : '↻ Refresh'}</button>
          </div>
          {brief == null || refreshing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9, padding: '2px 0 4px' }}>
              <div className="skel" style={{ width: '88%', height: 13 }} />
              <div className="skel" style={{ width: '70%', height: 13 }} />
              <div className="skel" style={{ width: '78%', height: 13 }} />
              <OwlQuips style={{ marginTop: 4 }} />
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
                        {b.threadId ? (
                          <button onClick={() => vtNavigate(navigate, `/inbox?thread=${b.threadId}`)} style={inlineLink}>Open message →</button>
                        ) : b.link && (
                          <button onClick={() => go(b.link.suiteId, b.link.dashboardId)} style={inlineLink}>{b.link.label} →</button>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <FeedbackRow brief={brief} entityId={homeEntityId} />
            </>
          )}
        </div>
      )}

      {/* Past digests — react/comment to tune future ones. Hidden until any exist. */}
      <DigestHistory entityId={homeEntityId} compact />

      {/* Messages from Howler — recent threads, surfaced on home. Handled ones
          can be dismissed (per-user; the inbox record is untouched). */}
      <MessagesFromHowler
        messages={messages.filter((m) => !dismissed.includes(m.id))}
        isMobile={isMobile}
        onOpen={(id) => vtNavigate(navigate, id ? `/inbox?thread=${id}` : '/inbox')}
        onDismiss={dismissMessage}
      />

      {/* Pinned tiles — live tiles the user chose to keep on home. Uniform
          cards in a horizontal snap carousel (one row, scroll for more). */}
      {(snap?.pinnedTiles || []).length > 0 && (
        <>
          <SectionHead icon="📌">Pinned</SectionHead>
          <PinStrip isMobile={isMobile}>
            {snap.pinnedTiles.map((p, i) => (
              <PinnedTile
                key={`${p.dashboardId}|${p.tile.id}`}
                p={p}
                isMobile={isMobile}
                index={i}
                count={snap.pinnedTiles.length}
                onMove={(dir) => movePin(i, dir)}
                onOpen={() => go(p.suiteId, p.dashboardId)}
                onUnpin={() => {
                  api.togglePin({ dashboardId: p.dashboardId, tileId: p.tile.id, kind: 'pin', on: false, scope: isAdmin ? 'entity' : 'user', entityId: homeEntityId })
                    .then(() => api.mySnapshot(homeEntityId, true).then(setSnap))
                    .catch(() => {});
                }}
              />
            ))}
          </PinStrip>
        </>
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
                <div style={{ marginTop: 9, display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--brand)' }}>{s.link.label} →</span>
                  {/* Only when the suggestion maps to an EXECUTABLE capability
                      (validated server-side) — never a button we can't deliver. */}
                  {s.action && can(PERMS.CAMPAIGNS_APPROVE) && (
                    <span
                      role="button" tabIndex={0}
                      title="Turn this suggestion into a campaign"
                      onClick={(e) => { e.stopPropagation(); vtNavigate(navigate, `/actions?goal=${encodeURIComponent(`${s.title}${s.reason ? ` — ${s.reason}` : ''}`)}&type=${s.action}`); }}
                      style={{ fontSize: 11.5, fontWeight: 700, color: '#7c3aed', background: 'rgba(124,58,237,0.10)', borderRadius: 980, padding: '3px 10px' }}
                    >⚡ Make it happen</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {/* Your actions — campaigns taken + how they're performing (campaigns role only) */}
      {can(PERMS.CAMPAIGNS_VIEW) && (
        <YourActions entityId={homeEntityId || (isAdmin ? null : ((user?.entities || [])[0]?.id || (user?.entityIds || [])[0]))} isMobile={isMobile} onOpen={() => vtNavigate(navigate, '/engage/campaigns')} />
      )}

      {/* Personal shortcuts (browsing-based) */}
      {shortcuts.length > 0 && (
        <>
          <SectionHead icon="⚡">Your shortcuts <Faint>based on what you check most</Faint></SectionHead>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : `repeat(${Math.min(shortcuts.length, 4)}, 1fr)`, gap: 12 }}>
            {shortcuts.map((s) => (
              <button key={s.dashboardId} className="lift" style={{ ...cardBtn, position: 'relative' }} onClick={() => go(s.suiteId || s.link?.suiteId, s.dashboardId)}>
                <div style={{ fontSize: 13.5, fontWeight: 700, paddingRight: 22 }}>{s.title}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>{s.setName} · viewed {s.count}×</div>
                <span style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', fontSize: 15, fontWeight: 700, color: 'var(--brand)' }}>→</span>
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

      {tuneOpen && (
        <BriefingTuneModal entityId={homeEntityId} onClose={() => setTuneOpen(false)} onSaved={refreshBrief} />
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

// Reactions on the briefing: ♥ like, 👎 what's-off (comment), 🔍 investigate
// (files a request for Howler to dig into the data). The briefing text is
// snapshotted with the feedback so the team sees exactly what was reacted to.
function FeedbackRow({ brief, entityId }) {
  const [mode, setMode] = useState(null);   // 'dislike' | 'investigate' | null
  const [text, setText] = useState('');
  const [sent, setSent] = useState(null);   // kind that was sent
  const [busy, setBusy] = useState(false);

  const snapshot = () => ({
    headline: brief?.headline || '',
    bullets: (brief?.bullets || []).map((b) => b.text),
    generatedAt: brief?.generatedAt || null,
  });
  const send = (kind, comment = '') => {
    setBusy(true);
    api.sendBriefingFeedback({ kind, comment, briefing: snapshot() }, entityId)
      .then(() => { setSent(kind); setMode(null); setText(''); })
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  if (sent === 'like') return <FbNote>♥ Glad it's useful — noted.</FbNote>;
  if (sent === 'dislike') return <FbNote>Thanks — your note helps tune the Owl.</FbNote>;
  if (sent === 'investigate') return <FbNote>🔍 Sent to Howler — the team will take a look at the data.</FbNote>;

  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--hairline)' }}>
      {!mode ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--muted)', marginRight: 2 }}>Was this useful?</span>
          <button style={fbBtn} title="Love it" onClick={() => send('like')} disabled={busy}>♥</button>
          <button style={fbBtn} title="Something's off" onClick={() => setMode('dislike')} disabled={busy}>👎</button>
          <span style={{ flex: 1 }} />
          <button style={{ ...fbBtn, width: 'auto', padding: '0 12px', fontSize: 12, fontWeight: 700 }} title="Ask Howler to dig into the data behind this" onClick={() => setMode('investigate')} disabled={busy}>
            🔍 Investigate
          </button>
        </div>
      ) : (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 5 }}>
            {mode === 'dislike' ? "What's off about this briefing?" : 'What should Howler dig into?'}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <textarea
              value={text} onChange={(e) => setText(e.target.value)} rows={2} autoFocus
              placeholder={mode === 'dislike' ? 'e.g. The resale numbers don’t match what I see on the dashboard…' : 'e.g. Why did Golden Lounge sales stop on the 8th?'}
              style={{ flex: 1, boxSizing: 'border-box', padding: '8px 10px', border: '1.5px solid var(--hairline)', borderRadius: 9, fontSize: 13, outline: 'none', resize: 'vertical', fontFamily: 'inherit', background: 'var(--card)', color: 'var(--text)' }}
            />
            <button style={{ ...fbBtn, width: 'auto', padding: '0 14px', height: 32, fontSize: 12, fontWeight: 700 }} onClick={() => setMode(null)} disabled={busy}>Cancel</button>
            <button
              style={{ ...fbBtn, width: 'auto', padding: '0 14px', height: 32, fontSize: 12, fontWeight: 700, background: 'var(--brand)', color: '#fff' }}
              onClick={() => send(mode, text)} disabled={busy || !text.trim()}
            >{busy ? '…' : 'Send'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
function FbNote({ children }) {
  return <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--hairline)', fontSize: 12, fontWeight: 600, color: 'var(--muted-2)' }}>{children}</div>;
}
const fbBtn = { width: 30, height: 30, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 980, fontSize: 14, cursor: 'pointer', lineHeight: 1 };

// Horizontal snap strip for pinned tiles: one row, uniform cards, scroll (or
// chevrons on desktop) when there are more than fit.
function PinStrip({ isMobile, children }) {
  const ref = useRef(null);
  const [canScroll, setCanScroll] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setCanScroll(el.scrollWidth > el.clientWidth + 8);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [children]);
  const nudge = (dir) => ref.current?.scrollBy({ left: dir * (ref.current.clientWidth - 80), behavior: 'smooth' });
  return (
    <div style={{ position: 'relative' }}>
      <div ref={ref} style={{ display: 'flex', gap: 12, overflowX: 'auto', scrollSnapType: 'x mandatory', paddingBottom: 6, scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>
        {children}
      </div>
      {!isMobile && canScroll && (
        <>
          <button onClick={() => nudge(-1)} aria-label="Scroll left" style={{ ...stripArrow, left: -12 }}>‹</button>
          <button onClick={() => nudge(1)} aria-label="Scroll right" style={{ ...stripArrow, right: -12 }}>›</button>
        </>
      )}
    </div>
  );
}

// A pinned tile: uniform card (same size whatever the vis), source bar on top,
// the REAL tile inside, scoped to its suite like the dashboard view.
function PinnedTile({ p, isMobile, onOpen, onUnpin, onMove, index = 0, count = 1 }) {
  return (
    <div style={{ flex: `0 0 ${isMobile ? 'min(86vw, 320px)' : '320px'}`, scrollSnapAlign: 'start' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 2px 5px' }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {p.setName} · {p.dashTitle}
        </span>
        {onMove && count > 1 && (
          <>
            <button onClick={() => onMove(-1)} disabled={index === 0} title="Move left" style={{ ...pinAct, opacity: index === 0 ? 0.35 : 1 }}>←</button>
            <button onClick={() => onMove(1)} disabled={index === count - 1} title="Move right" style={{ ...pinAct, opacity: index === count - 1 ? 0.35 : 1 }}>→</button>
          </>
        )}
        <button onClick={onOpen} title="Open dashboard" style={pinAct}>↗</button>
        <button onClick={onUnpin} title="Unpin from home" style={pinAct}>✕</button>
      </div>
      <div style={{ height: 230 }}>
        <ScopeProvider suiteId={p.suiteId} dashboardContext="">
          <TileFrame tile={p.tile} filterValues={p.filterValues || {}} editable={false} />
        </ScopeProvider>
      </div>
    </div>
  );
}
const pinAct = { flexShrink: 0, border: 'none', background: 'rgba(128,128,128,0.12)', color: 'var(--muted-2)', borderRadius: 980, width: 22, height: 22, fontSize: 12, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 };
const stripArrow = { position: 'absolute', top: '50%', transform: 'translateY(-50%)', zIndex: 5, width: 30, height: 30, borderRadius: '50%', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text)', fontSize: 17, fontWeight: 700, cursor: 'pointer', boxShadow: 'var(--shadow-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 };

// Messages from the Howler team, surfaced on home (the inbox lives in the nav).
// Shows the few most recent threads with an unread dot + priority chip; hidden
// when there are none.
function MessagesFromHowler({ messages, isMobile, onOpen, onDismiss }) {
  const recent = (messages || []).slice(0, 3);
  if (!recent.length) return null;
  const unreadCount = (messages || []).filter((m) => m.unread).length;
  const chip = (m) => m.priority === 'must_ack'
    ? (m.acked ? { t: '✓ Acknowledged', c: '#2da44e', bg: 'rgba(52,199,89,0.15)' } : { t: 'Needs ack', c: '#b45309', bg: 'rgba(245,158,11,0.16)' })
    : m.priority === 'needs_reply' ? { t: 'Needs reply', c: '#0a66c2', bg: 'rgba(10,132,255,0.13)' }
    : null;
  return (
    <>
      <SectionHead icon="📥">Messages from Howler {unreadCount > 0 && <Faint>{unreadCount} unread</Faint>}</SectionHead>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : `repeat(${Math.min(recent.length, 3)}, 1fr)`, gap: 12 }}>
        {recent.map((m) => {
          const c = chip(m);
          // A pending must-ack can't be cleared off home — acknowledge it first.
          const dismissible = !(m.priority === 'must_ack' && !m.acked);
          return (
            <div key={m.id} className="lift" role="button" tabIndex={0} style={{ ...cardBtn, position: 'relative', textAlign: 'left', cursor: 'pointer' }}
              onClick={() => onOpen(m.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(m.id); } }}>
              {dismissible && (
                <button
                  type="button" title="Clear from home (stays in your inbox)" aria-label="Clear from home"
                  onClick={(e) => { e.stopPropagation(); onDismiss(m.id); }}
                  style={{ position: 'absolute', top: 4, right: 4, width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: 'var(--muted)', lineHeight: 1, border: 'none', background: 'transparent', borderRadius: 8, cursor: 'pointer' }}
                >✕</button>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, paddingRight: 16 }}>
                {m.unread && <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--brand)', flexShrink: 0 }} />}
                <span style={{ fontSize: 13.5, fontWeight: m.unread ? 800 : 700, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title || '(no subject)'}</span>
                {c && <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 980, padding: '2px 8px', background: c.bg, color: c.c, flexShrink: 0 }}>{c.t}</span>}
              </div>
              {m.preview?.body && <div style={{ fontSize: 12, color: 'var(--muted-2)', lineHeight: 1.5, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.preview.body}</div>}
              <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: 'var(--brand)' }}>Open message →</div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// "Your actions" — recent campaigns and their live performance, linking to the
// Actions page. Hidden entirely until the client has taken at least one action.
function YourActions({ entityId, isMobile, onOpen }) {
  const [actions, setActions] = useState([]);
  useEffect(() => {
    if (!entityId) return;
    api.getActionsSummary(entityId).then((r) => setActions(r.actions || [])).catch(() => {});
  }, [entityId]);
  if (!actions.length) return null;
  const chip = (s) => s === 'done' ? { t: 'Sent', c: '#2da44e', bg: 'rgba(52,199,89,0.15)' }
    : s === 'running' ? { t: 'Sending…', c: '#0a66c2', bg: 'rgba(10,132,255,0.13)' }
    : { t: 'Failed', c: '#dc2626', bg: 'rgba(239,68,68,0.12)' };
  return (
    <>
      <SectionHead icon="📣">Your campaigns <Faint>campaigns you've sent and how they're performing</Faint></SectionHead>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : `repeat(${Math.min(actions.length, 3)}, 1fr)`, gap: 12 }}>
        {actions.slice(0, 3).map((a) => {
          const c = chip(a.status);
          return (
            <button key={a.id} className="lift" style={cardBtn} onClick={onOpen}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.title}</span>
                <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 980, padding: '2px 8px', background: c.bg, color: c.c, flexShrink: 0 }}>{c.t}</span>
              </div>
              <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 12.5, fontWeight: 600 }}>
                <span>📤 {a.sent}/{a.total}</span>
                <span>🔗 {a.clicks}</span>
                <span style={{ color: 'var(--brand)' }}>{a.ctr}% CTR</span>
              </div>
              <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: 'var(--brand)' }}>View report →</div>
            </button>
          );
        })}
      </div>
    </>
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
const briefCard = { background: 'var(--tile-bg, var(--card))', border: '1px solid var(--border)', borderRadius: 16, boxShadow: 'var(--shadow-sm)', padding: '16px 18px' };
const cardBtn = { textAlign: 'left', background: 'var(--tile-bg, var(--card))', border: '1px solid var(--border)', borderRadius: 14, padding: '13px 15px', cursor: 'pointer', boxShadow: 'var(--shadow-sm)', color: 'var(--text)', width: '100%' };
const settleCard = { display: 'flex', alignItems: 'center', gap: 12, width: '100%', marginTop: 16, background: 'linear-gradient(90deg, rgba(52,199,89,0.10), transparent 60%) var(--tile-bg, var(--card))', border: '1px solid rgba(52,199,89,0.35)', borderRadius: 14, padding: '13px 16px', cursor: 'pointer', color: 'var(--text)' };
const refreshBtn = { border: 'none', background: 'var(--ai-bg, rgba(124,58,237,0.08))', color: 'var(--ai, #7c3aed)', borderRadius: 980, padding: '4px 11px', fontSize: 11, fontWeight: 700, cursor: 'pointer', flexShrink: 0 };
const inlineLink = { border: 'none', background: 'transparent', color: 'var(--ai, #7c3aed)', fontWeight: 700, fontSize: 12.5, cursor: 'pointer', padding: 0, fontFamily: 'inherit' };
