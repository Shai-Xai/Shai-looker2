import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';

// LivePulse — the ambient "heartbeat" strip that lives in the centre of the top
// header (Pulse, beating). It streams the client's recent BEATS from the merged
// /api/pulse feed (server/pulse.js) — alert fires + live tile momentum ("+142
// Tickets sold in the last hour"), newest first — as a glanceable, tappable beat,
// rotating one at a time. Tap → the Alerts page (insight → action).
//
// Desktop-only by design: the 56px mobile header has no room (and urgent alerts
// already reach the phone via push). On mobile, or with nothing to show, it renders
// the empty flex spacer it replaced, so the header layout is unchanged.
//
// Read-only: it reflects alerts, which own their admin + client config surfaces, so
// it needs none of its own. Disposable: delete this file, its mount in App.jsx, and
// the /pulse route in server/alerts.js — nothing else depends on it.

const TIER_COLOR = { info: '#3b82f6', success: 'var(--success, #1d8a3b)', warning: '#f59e0b', danger: '#ef4444' };
const POLL_MS = 60000;   // alerts tick every ~5 min; this keeps the strip fresh-ish
const ROTATE_MS = 4200;  // dwell per beat

function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export default function LivePulse({ entityId }) {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [beats, setBeats] = useState([]);
  const [i, setI] = useState(0);

  // Poll the entity's recent fires (skipped on mobile / outside a client view).
  useEffect(() => {
    if (!entityId || isMobile) { setBeats([]); return; }
    let alive = true;
    const load = () => api.entityPulse(entityId).then((d) => { if (alive) setBeats(d.beats || []); }).catch(() => {});
    load();
    const t = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [entityId, isMobile]);

  // Rotate, but only restart when the SET of beats actually changes (a same-content
  // refetch shouldn't reset the carousel). Never auto-advance a single beat.
  const sig = beats.map((b) => b.id).join(',');
  useEffect(() => {
    setI(0);
    if (beats.length <= 1) return;
    const t = setInterval(() => setI((x) => (x + 1) % beats.length), ROTATE_MS);
    return () => clearInterval(t);
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  const spacer = <div style={{ flex: 1, minWidth: 0 }} />;
  if (!entityId || isMobile || !beats.length) return spacer;

  const beat = beats[i % beats.length];
  const color = TIER_COLOR[beat.tier] || TIER_COLOR.info;

  return (
    <div style={{ flex: 1, display: 'flex', justifyContent: 'center', minWidth: 0, padding: '0 8px' }}>
      <button
        onClick={() => navigate('/alerts')}
        title="Live — your latest alerts. Tap to open Alerts."
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 9, maxWidth: 'min(48vw, 540px)',
          border: '1px solid var(--hairline)', background: 'var(--glass-bg, transparent)',
          borderRadius: 999, padding: '5px 13px 5px 11px', cursor: 'pointer', overflow: 'hidden',
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0, animation: 'lp-beat 1.5s ease-in-out infinite' }} />
        <span key={beat.id} style={{ minWidth: 0, display: 'inline-flex', alignItems: 'baseline', gap: 8, animation: 'fade-up .35s ease' }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{beat.message}</span>
          <span style={{ fontSize: 11.5, color: 'var(--muted)', flexShrink: 0 }}>{ago(beat.at)}</span>
        </span>
      </button>
      <style>{'@keyframes lp-beat{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.6)}}'}</style>
    </div>
  );
}
