import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';

// Social+ (social.plus) in-app community analytics — the SAME component on both
// surfaces via the scope prop ('my' | 'admin-client'), like QueueItCard:
//   • the client's App page → Community tab (scope 'my'),
//   • Admin → client → Integrations (scope 'admin-client'), where it ADDS the
//     community → client linking picker (the guardrail that makes Howler's
//     shared Social+ key safe to reuse across clients).
// Data comes from the socialplus_* tables synced by server/socialplus.js.

const fmt = (n) => (n == null ? '—' : Intl.NumberFormat('en-ZA', { notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n));
const METRICS = [
  ['members', 'Members'],
  ['messages', 'Messages'],
  ['posts', 'Posts'],
  ['comments', 'Comments'],
];

export default function SocialPlusPanel({ entityId, scope = 'my' }) {
  const isMobile = useIsMobile();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [metric, setMetric] = useState('members');

  const load = useCallback(() => {
    api.socialplusData(entityId, scope, { metric }).then(setData).catch((e) => { setData(null); setErr(e.message); });
  }, [entityId, scope, metric]);
  useEffect(() => { setData(null); setErr(''); load(); }, [load]);

  if (!data) {
    if (err && scope === 'admin-client') return <div style={card}><div style={muted}>{err}</div></div>;
    return err ? null : <div style={muted}>Loading…</div>;
  }
  const s = data.summary || {};
  if (!s.configured) {
    // A client with no Social+ anywhere sees nothing; admins get the pointer.
    if (scope !== 'admin-client') return <div style={card}><div style={muted}>In-app community stats aren't connected yet — ask Howler to link your app communities.</div></div>;
    return (
      <div style={card}>
        <div style={title}>👥 Social+ — in-app communities</div>
        <div style={muted}>Add the Social+ <b>API key</b> in Admin → Integrations (the shared Howler network) or in this client's Integrations above, then link their communities here.</div>
      </div>
    );
  }

  const t = s.totals || {};
  const sync = async () => {
    setBusy(true); setErr('');
    try { await api.socialplusSync(entityId, scope); load(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

  return (
    <div style={scope === 'admin-client' ? card : undefined}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {scope === 'admin-client'
          ? <div style={{ ...title, flex: 1, minWidth: 0, marginBottom: 0 }}>👥 Social+ — in-app communities</div>
          : <div style={{ flex: 1 }} />}
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{s.source === 'client' ? 'own Social+ account' : 'via Howler\'s app network'}</span>
        <button onClick={sync} disabled={busy} style={btn}>{busy ? 'Syncing…' : '↻ Sync'}</button>
      </div>
      {err && <div style={errBox}>{err}</div>}
      {s.lastStatus === 'error' && <div style={errBox}>⚠ Last sync failed: {s.lastError}</div>}

      {!s.assigned ? (
        <div style={muted}>
          {scope === 'admin-client'
            ? 'No communities linked to this client yet — tick theirs below and save.'
            : 'Your app communities haven\'t been linked yet — ask Howler to link them to your account.'}
        </div>
      ) : !s.lastAt ? (
        <div style={muted}>Connected — tap “Sync” to pull the linked communities, chats and posts for the first time (it also refreshes automatically once a day).</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: isMobile ? 14 : 22, flexWrap: 'wrap', marginBottom: 14 }}>
            <Stat label="Communities" value={fmt(t.communities)} />
            <Stat label="Members" value={fmt(t.members)} />
            <Stat label="Posts" value={fmt(t.posts)} />
            <Stat label="Comments" value={fmt(t.comments)} />
            <Stat label="Reactions" value={fmt(t.reactions)} />
            <Stat label="Chat messages" value={fmt(t.messages)} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '4px 0 8px' }}>
            <div style={{ fontWeight: 700, fontSize: 13.5, flex: 1 }}>30-day trend</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {METRICS.map(([k, label]) => (
                <button key={k} onClick={() => setMetric(k)} style={{ ...chip, ...(metric === k ? chipOn : null) }}>{label}</button>
              ))}
            </div>
          </div>
          <Sparkline series={data.series || []} />

          {(data.communities || []).length > 0 && (
            <>
              <div style={{ fontWeight: 700, fontSize: 13.5, margin: '16px 0 4px' }}>Communities</div>
              {(data.communities || []).slice(0, 8).map((c) => (
                <div key={c.communityId} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '8px 0', borderTop: '1px solid var(--hairline)' }}>
                  <div style={{ minWidth: 0, flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.displayName || c.communityId}</div>
                  <div style={{ flexShrink: 0, fontSize: 12, color: 'var(--muted)' }}>👥 {fmt(c.members)}{c.posts ? <> · ✍️ {fmt(c.posts)}</> : null}</div>
                </div>
              ))}
            </>
          )}

          {(data.channels || []).length > 0 && (
            <>
              <div style={{ fontWeight: 700, fontSize: 13.5, margin: '16px 0 4px' }}>Busiest chats</div>
              {(data.channels || []).slice(0, 6).map((ch) => (
                <div key={ch.channelId} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '8px 0', borderTop: '1px solid var(--hairline)' }}>
                  <div style={{ minWidth: 0, flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ch.displayName || ch.channelId}</div>
                  <div style={{ flexShrink: 0, fontSize: 12, color: 'var(--muted)' }}>💬 {fmt(ch.messages)} · 👥 {fmt(ch.members)}</div>
                </div>
              ))}
            </>
          )}

          {(data.topPosts || []).length > 0 && (
            <>
              <div style={{ fontWeight: 700, fontSize: 13.5, margin: '16px 0 4px' }}>Top posts</div>
              {(data.topPosts || []).slice(0, 6).map((p) => (
                <div key={p.postId} style={{ display: 'flex', gap: 10, padding: '8px 0', borderTop: '1px solid var(--hairline)' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.text || '(no text)'}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      {p.communityName && <span>{p.communityName}</span>}
                      {p.reactions != null && <span>❤️ {fmt(p.reactions)}</span>}
                      {p.comments != null && <span>💬 {fmt(p.comments)}</span>}
                      {p.reach != null && <span>👁 {fmt(p.reach)} reach</span>}
                      {p.postedAt && <span>{new Date(p.postedAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </>
          )}
        </>
      )}

      {/* Admin (or a client on their OWN key): the community → client linking. */}
      {(scope === 'admin-client' || s.source === 'client') && (
        <CommunityLinking entityId={entityId} scope={scope} assigned={s.communityIds || []} onSaved={load} />
      )}
    </div>
  );
}

// The linking picker: everything on the Social+ network (communities + chat
// groups) with ticks for what belongs to THIS client. Loads lazily — 40+
// communities and hundreds of channels only fetch when an admin opens it.
function CommunityLinking({ entityId, scope, assigned, onSaved }) {
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState(null);
  const [dirErr, setDirErr] = useState('');
  const [picked, setPicked] = useState(() => new Set(assigned));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setPicked(new Set(assigned)); }, [assigned.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open || dir) return;
    api.socialplusDirectory(entityId, scope).then(setDir).catch((e) => setDirErr(e.message));
  }, [open, dir, entityId, scope]);
  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const save = async () => {
    setBusy(true); setDirErr('');
    try { await api.socialplusAssign(entityId, scope, [...picked]); setSaved(true); setTimeout(() => setSaved(false), 1600); onSaved?.(); }
    catch (e) { setDirErr(e.message); }
    setBusy(false);
  };
  return (
    <div style={{ border: '1px dashed var(--hairline)', borderRadius: 10, padding: 12, marginTop: 14 }}>
      <button type="button" onClick={() => setOpen((o) => !o)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 36, background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', textAlign: 'left', color: 'var(--text)' }}>
        <span style={{ width: 12, fontSize: 9, color: 'var(--muted)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
        <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1 }}>Communities linked to this client {assigned.length ? `· ${assigned.length}` : ''}</span>
      </button>
      {open && (
        <>
          <div style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0 8px' }}>
            On the shared Howler network, tick only THIS client's communities and event chats — unticked ones stay invisible to them. Saving re-syncs their data immediately. (On a client's own Social+ account, no ticks = they see everything.)
          </div>
          {dirErr && <div style={errBox}>{dirErr}</div>}
          {!dir && !dirErr && <div style={muted}>Loading the Social+ directory…</div>}
          {dir && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 380, overflowY: 'auto' }}>
              {(dir.communities || []).length > 0 && <div style={groupLbl}>Communities</div>}
              {(dir.communities || []).map((c) => (
                <label key={c.id} style={pickRow}>
                  <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                  <span style={{ flexShrink: 0, fontSize: 11.5, color: 'var(--muted)' }}>👥 {fmt(c.members)}</span>
                </label>
              ))}
              {(dir.channelGroups || []).length > 0 && <div style={groupLbl}>Event chats</div>}
              {(dir.channelGroups || []).map((g) => (
                <label key={g.id} style={pickRow}>
                  <input type="checkbox" checked={picked.has(g.id)} onChange={() => toggle(g.id)} />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name || g.id} <span style={{ color: 'var(--muted)' }}>· {g.channels} chat{g.channels === 1 ? '' : 's'}</span></span>
                  <span style={{ flexShrink: 0, fontSize: 11.5, color: 'var(--muted)' }}>💬 {fmt(g.messages)}</span>
                </label>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
            <button type="button" style={btn} disabled={busy || !dir} onClick={save}>{busy ? 'Saving…' : 'Save linked communities'}</button>
            {saved && <span style={{ color: 'var(--success, #10b981)', fontSize: 12.5, fontWeight: 600 }}>✓ Saved & re-synced</span>}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
    </div>
  );
}

// Minimal dependency-free sparkline (SVG) — same shape as the Social page's.
function Sparkline({ series }) {
  if (!series || series.length < 2) return <div style={muted}>Not enough data yet — trends build up over the first few daily syncs.</div>;
  const vals = series.map((s) => s.value ?? 0);
  const max = Math.max(...vals, 1); const min = Math.min(...vals, 0);
  const W = 600, H = 90, pad = 4;
  const x = (i) => pad + (i * (W - 2 * pad)) / (series.length - 1);
  const y = (v) => H - pad - ((v - min) / (max - min || 1)) * (H - 2 * pad);
  const d = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = series[series.length - 1];
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 90, display: 'block' }}>
        <path d={`${d} L${x(series.length - 1)},${H - pad} L${x(0)},${H - pad} Z`} fill="var(--brand)" opacity="0.08" />
        <path d={d} fill="none" stroke="var(--brand)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
        <span>{series[0].date}</span>
        <span style={{ fontWeight: 700, color: 'var(--text)' }}>{fmt(last.value)} latest</span>
        <span>{last.date}</span>
      </div>
    </div>
  );
}

const card = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: 16, marginTop: 16 };
const title = { fontSize: 14, fontWeight: 700, marginBottom: 6 };
const btn = { padding: '8px 14px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 36 };
const chip = { padding: '5px 11px', borderRadius: 980, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--muted)', fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const chipOn = { background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' };
const muted = { color: 'var(--muted)', fontSize: 13.5 };
const errBox = { background: 'rgba(239,68,68,0.08)', border: '1px solid var(--error,#ef4444)', color: 'var(--error,#ef4444)', borderRadius: 10, padding: '10px 12px', fontSize: 13, marginBottom: 12 };
const groupLbl = { fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', margin: '8px 0 2px' };
const pickRow = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, minHeight: 32, cursor: 'pointer' };
