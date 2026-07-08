import { useState, useEffect } from 'react';
import { useProfile } from '../lib/profile.jsx';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import PageHeader from '../components/PageHeader.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';

// "Your journey" — the gamification shelf: Pulse Points ⚡, one sticker per
// completed onboarding phase, and activity badges earned from real outcomes.
// Earning-only for now: the reward catalogue arrives once it's decided, so the
// spend section reads as a teaser, not a promise. Mobile-first single column.
export default function JourneyPage() {
  const { activeEntityId } = useProfile();
  const { user } = useAuth();
  const entityId = activeEntityId || (user?.entityIds || [])[0] || '';
  const isMobile = useIsMobile();
  const [data, setData] = useState(null);
  useEffect(() => {
    if (!entityId) { setData(null); return; }
    api.getMyJourney(entityId).then((d) => {
      setData(d);
      if ((d.unseen || []).length) api.ackMyJourney(entityId).catch(() => {});
    }).catch(() => setData(null));
  }, [entityId]);

  if (!entityId) return null;
  return (
    <main style={{ flex: 1, padding: isMobile ? '20px 14px' : '32px 24px', maxWidth: 720, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
      <PageHeader title="Your journey" />
      {!data ? <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Points */}
          <section style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 16, borderRadius: 16, background: 'linear-gradient(120deg, rgba(var(--brand-rgb),0.14), rgba(var(--brand-rgb),0.03) 65%)', border: '1px solid rgba(var(--brand-rgb),0.25)' }}>
            <span style={{ width: 40, height: 40, borderRadius: 12, background: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0 }}>⚡</span>
            <div>
              <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>{(data.points?.total || 0).toLocaleString()}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Pulse Points</div>
            </div>
            <div style={{ marginLeft: 'auto', textAlign: 'right', fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 }}>
              Earned by your whole team,<br />step by step. 🎁 Rewards soon.
            </div>
          </section>

          {/* Sticker shelf */}
          <section style={cardS}>
            <h2 style={h2S}>Journey stickers</h2>
            <p style={hintS}>One for each phase of getting set up — finish the row!</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', flexWrap: isMobile ? 'nowrap' : 'wrap', overflowX: 'auto', paddingBottom: 4 }}>
              {(data.stickers || []).map((s) => {
                const [emoji, ...nameParts] = (s.sticker || '').split(' ');
                return (
                  <div key={s.key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, minWidth: 64, textAlign: 'center' }}>
                    <div style={{
                      width: 56, height: 56, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26,
                      background: s.earned ? 'radial-gradient(circle at 32% 28%, rgba(255,255,255,0.55), rgba(255,255,255,0) 55%), linear-gradient(150deg, #ff5d7c, #d81b4b)' : 'var(--bg)',
                      border: s.earned ? '2px solid #fff' : '2px dashed var(--hairline)',
                      boxShadow: s.earned ? 'var(--shadow-sm)' : 'none',
                      filter: s.earned ? 'none' : 'grayscale(1)', opacity: s.earned ? 1 : 0.55,
                    }} title={s.earned ? `${s.sticker} · +${s.pts} ⚡` : `Complete Phase ${s.phase} · ${s.title}`}>{emoji}</div>
                    <span style={{ fontSize: 10, fontWeight: 700, color: s.earned ? 'var(--text)' : 'var(--muted)', lineHeight: 1.25 }}>{nameParts.join(' ')}</span>
                  </div>
                );
              })}
            </div>
            {data.activated?.earned && <div style={{ marginTop: 10, fontSize: 12.5, fontWeight: 700, color: 'var(--brand)' }}>🏆 Fully activated — every phase complete. +{data.activated.pts} ⚡</div>}
          </section>

          {/* Activity badges */}
          <section style={cardS}>
            <h2 style={h2S}>Activity badges</h2>
            <p style={hintS}>Earned by what you actually achieve in Pulse — they keep coming long after setup.</p>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 8 }}>
              {(data.badges || []).map((b) => (
                <div key={b.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 12, background: 'var(--bg)', border: '1px solid var(--hairline)', opacity: b.earned ? 1 : 0.55, filter: b.earned ? 'none' : 'grayscale(0.9)' }}>
                  <span style={{ fontSize: 20 }}>{b.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700 }}>{b.title}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>{b.desc}</div>
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 800, color: b.earned ? 'var(--brand)' : 'var(--muted)', whiteSpace: 'nowrap' }}>{b.earned ? `✓ +${b.pts} ⚡` : `+${b.pts} ⚡`}</span>
                </div>
              ))}
            </div>
          </section>

          <p style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', margin: '2px 0 8px' }}>
            Points and badges are earned once per milestone, automatically — no ticking boxes. Rewards to spend them on are on the way.
          </p>
        </div>
      )}
    </main>
  );
}

const cardS = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 16, padding: 16, boxShadow: 'var(--shadow-sm)' };
const h2S = { fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', margin: '0 0 2px' };
const hintS = { fontSize: 12.5, color: 'var(--muted)', margin: '0 0 12px' };
