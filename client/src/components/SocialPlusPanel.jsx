import { useState, useEffect, useMemo, useCallback } from 'react';
import ReactECharts from 'echarts-for-react/lib/core';
import echarts from '../lib/echarts.js';
import { brandPrimary } from '../lib/brand.js';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';

// Social+ (social.plus) in-app community analytics — the SAME component on both
// surfaces via the scope prop ('my' | 'admin-client'), like QueueItCard:
//   • the client's App page → Community tab (scope 'my'),
//   • Admin → client → Integrations (scope 'admin-client'), where it ADDS the
//     community → client linking picker (the guardrail that makes Howler's
//     shared Social+ key safe to reuse across clients).
// Visual language mirrors AppAnalytics.jsx (stat tiles, one recessive brand-hue
// line with metric chips, tables with inline bars) so the two App tabs read as
// one surface. Data comes from the socialplus_* tables (server/socialplus.js).

const fmt = (n) => (n == null ? '—' : Intl.NumberFormat('en-ZA', { notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n));
const DAY_CHOICES = [7, 30, 90];
const METRICS = [
  ['members', 'Members'],
  ['messages', 'Messages'],
  ['posts', 'Posts'],
  ['comments', 'Comments'],
  ['reactions', 'Reactions'],
];

export default function SocialPlusPanel({ entityId, scope = 'my' }) {
  const isMobile = useIsMobile();
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState('members');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    api.socialplusData(entityId, scope, { metric, days }).then(setData).catch((e) => { setData(null); setErr(e.message); });
  }, [entityId, scope, metric, days]);
  useEffect(() => { setData(null); setErr(''); load(); }, [load]);

  if (!data) {
    if (err && scope === 'admin-client') return <div style={card}><p style={sub}>{err}</p></div>;
    return err ? null : <div style={mutedTxt}>Loading…</div>;
  }
  const s = data.summary || {};
  if (!s.configured) {
    // A client with no Social+ anywhere sees nothing; admins get the pointer.
    if (scope !== 'admin-client') return <div style={card}><p style={sub}>In-app community stats aren't connected yet — ask Howler to link your app communities.</p></div>;
    return (
      <div style={card}>
        <div style={title}>👥 Social+ — in-app communities</div>
        <p style={sub}>Add the Social+ <b>API key</b> in Admin → Integrations (the shared Howler network) or in this client's Integrations above, then link their communities here.</p>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {scope === 'admin-client'
          ? <div style={{ ...title, flex: 1, minWidth: 0, marginBottom: 0 }}>👥 Social+ — in-app communities</div>
          : <span style={{ flex: 1, fontSize: 12.5, color: 'var(--muted)' }}>Your fan communities and chats inside the Howler app{s.source === 'client' ? ' · own Social+ account' : ''}.</span>}
        {DAY_CHOICES.map((d) => <Chip key={d} on={days === d} onClick={() => setDays(d)}>{d}d</Chip>)}
        <button type="button" onClick={sync} disabled={busy} style={ghostBtn}>{busy ? 'Syncing…' : '↻ Sync'}</button>
      </div>
      {err && <div style={errBox}>{err}</div>}
      {s.lastStatus === 'error' && <div style={errBox}>⚠ Last sync failed: {s.lastError}</div>}

      {!s.assigned ? (
        <div style={card}>
          <p style={{ ...sub, marginBottom: 0 }}>
            {scope === 'admin-client'
              ? 'No communities linked to this client yet — tick theirs below and save.'
              : 'Your app communities haven\'t been linked yet — ask Howler to link them to your account.'}
          </p>
        </div>
      ) : !s.lastAt ? (
        <div style={card}>
          <p style={{ ...sub, marginBottom: 0 }}>Connected — tap <b>↻ Sync</b> to pull the linked communities, chats and posts for the first time (it also refreshes automatically once a day).</p>
        </div>
      ) : (
        <>
          <StatRow isMobile={isMobile} stats={[
            ['Members', t.members],
            ['Communities', t.communities],
            ['Posts', t.posts],
            ['Comments', t.comments],
            ['Reactions', t.reactions],
            ['Chat messages', t.messages],
          ]} />
          <SeriesCard series={data.series || []} metric={metric} setMetric={setMetric} days={days} isMobile={isMobile} />
          <CommunitiesTable rows={data.communities || []} />
          <ChatsTable rows={data.channels || []} />
          <TopPosts rows={data.topPosts || []} />
        </>
      )}

      {/* Admin (or a client on their OWN key): the community → client linking. */}
      {(scope === 'admin-client' || s.source === 'client') && (
        <CommunityLinking entityId={entityId} scope={scope} assigned={s.communityIds || []} onSaved={load} />
      )}
    </div>
  );
}

// ── pieces (mirroring AppAnalytics.jsx so the two App tabs read as one) ─────────
function StatRow({ stats, isMobile }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${isMobile ? 130 : 150}px, 1fr))`, gap: 8, marginBottom: 12 }}>
      {stats.map(([label, v]) => (
        <div key={label} style={{ background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: '11px 13px' }}>
          <div style={{ fontSize: 22, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{fmt(v)}</div>
          <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginTop: 2 }}>{label}</div>
        </div>
      ))}
    </div>
  );
}

// One recessive line chart; chips pick WHICH single series shows (one axis).
function SeriesCard({ series, metric, setMetric, days, isMobile }) {
  const option = useMemo(() => {
    const brand = brandPrimary();
    return {
      animationDuration: 300,
      grid: { left: 8, right: 12, top: 12, bottom: 8, containLabel: true },
      tooltip: { trigger: 'axis', valueFormatter: (v) => (v == null ? '—' : Number(v).toLocaleString('en-ZA')) },
      xAxis: { type: 'time', axisLine: { lineStyle: { color: 'rgba(128,128,128,0.25)' } }, axisLabel: { color: 'var(--muted, #888)', fontSize: 10.5, hideOverlap: true }, splitLine: { show: false } },
      yAxis: { type: 'value', axisLabel: { color: 'var(--muted, #888)', fontSize: 10.5, formatter: (v) => fmt(v) }, splitLine: { lineStyle: { color: 'rgba(128,128,128,0.12)' } } },
      series: [{
        type: 'line', showSymbol: false, smooth: 0.15,
        lineStyle: { width: 2, color: brand },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: `${brand}45` }, { offset: 1, color: `${brand}05` }]) },
        data: series.map((r) => [r.date, r.value == null ? 0 : r.value]),
      }],
    };
  }, [series]);
  return (
    <div style={{ ...card, marginTop: 0 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {METRICS.map(([k, label]) => <Chip key={k} on={metric === k} onClick={() => setMetric(k)}>{label}</Chip>)}
      </div>
      {series.length < 2
        ? <p style={{ ...sub, marginBottom: 0 }}>Not enough data for a {days}-day trend yet — it builds up over the first few daily syncs.</p>
        : <ReactECharts echarts={echarts} option={option} notMerge style={{ height: isMobile ? 200 : 260, width: '100%' }} opts={{ renderer: 'canvas' }} />}
    </div>
  );
}

// Communities ranked by members, with an inline bar so relative size reads at a
// glance (same device as the App tab's "What's driving it" table).
function CommunitiesTable({ rows }) {
  if (!rows.length) return null;
  const max = Math.max(1, ...rows.map((r) => r.members || 0));
  return (
    <div style={{ ...card, marginTop: 12, overflowX: 'auto' }}>
      <div style={title}>🏟 Communities</div>
      <p style={sub}>Sorted by members</p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 460 }}>
        <thead><tr>{['Community', '', 'Members', 'Posts'].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.slice(0, 12).map((c) => (
            <tr key={c.communityId}>
              <td style={{ ...td, fontWeight: 600, whiteSpace: 'normal' }}>{c.displayName || c.communityId}</td>
              <td style={{ ...td, width: '28%', minWidth: 90 }}><span style={{ display: 'inline-block', height: 8, borderRadius: 4, background: 'var(--brand)', opacity: 0.75, width: `${Math.max(3, Math.round(((c.members || 0) / max) * 100))}%` }} /></td>
              <td style={td}>{fmt(c.members)}</td>
              <td style={td}>{fmt(c.posts)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChatsTable({ rows }) {
  const active = rows.filter((r) => (r.messages || 0) > 0 || (r.members || 0) > 0);
  if (!active.length) return null;
  const max = Math.max(1, ...active.map((r) => r.messages || 0));
  return (
    <div style={{ ...card, marginTop: 12, overflowX: 'auto' }}>
      <div style={title}>💬 Busiest chats</div>
      <p style={sub}>Announcements, line-up, FAQ and event chats — sorted by messages</p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 520 }}>
        <thead><tr>{['Chat', '', 'Messages', 'Members', 'Last active'].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead>
        <tbody>
          {active.slice(0, 10).map((ch) => (
            <tr key={ch.channelId}>
              <td style={{ ...td, fontWeight: 600, whiteSpace: 'normal' }}>{ch.displayName || ch.channelId}</td>
              <td style={{ ...td, width: '22%', minWidth: 80 }}><span style={{ display: 'inline-block', height: 8, borderRadius: 4, background: 'var(--brand)', opacity: 0.75, width: `${Math.max(3, Math.round(((ch.messages || 0) / max) * 100))}%` }} /></td>
              <td style={td}>{fmt(ch.messages)}</td>
              <td style={td}>{fmt(ch.members)}</td>
              <td style={td}>{ch.lastActivity ? new Date(ch.lastActivity).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Top posts by reactions — engagement figures as compact labelled stats per row.
function TopPosts({ rows }) {
  if (!rows.length) return null;
  return (
    <div style={{ ...card, marginTop: 12 }}>
      <div style={title}>🔥 Top posts</div>
      <p style={sub}>Ranked by reactions over all synced posts</p>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {rows.slice(0, 6).map((p, i) => (
          <div key={p.postId} style={{ display: 'flex', gap: 12, padding: '10px 0', borderTop: i ? '1px solid var(--hairline)' : 'none' }}>
            <div style={{ flexShrink: 0, width: 22, fontSize: 13, fontWeight: 800, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', paddingTop: 1 }}>{i + 1}</div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{p.text || '(no text)'}</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4, display: 'flex', gap: 12, flexWrap: 'wrap', fontVariantNumeric: 'tabular-nums' }}>
                {p.communityName && <span style={{ fontWeight: 600 }}>{p.communityName}</span>}
                <span>❤️ {fmt(p.reactions)}</span>
                <span>💬 {fmt(p.comments)}</span>
                {p.reach != null && <span>👁 {fmt(p.reach)} reach</span>}
                {p.impressions != null && <span>{fmt(p.impressions)} impressions</span>}
                {p.postedAt && <span>{new Date(p.postedAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// The linking picker: everything on the Social+ network (communities + chat
// groups) with ticks for what belongs to THIS client. Loads lazily — 40+
// communities and hundreds of channels only fetch when someone opens it.
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
          {!dir && !dirErr && <div style={mutedTxt}>Loading the Social+ directory…</div>}
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
            {saved && <span style={okTxt}>✓ Saved & re-synced</span>}
          </div>
        </>
      )}
    </div>
  );
}

function Chip({ on, onClick, children }) {
  return (
    <button type="button" onClick={onClick}
      style={{ minHeight: 32, padding: '5px 12px', borderRadius: 980, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: `1px solid ${on ? 'var(--brand)' : 'var(--hairline)'}`, background: on ? 'var(--brand)' : 'transparent', color: on ? '#fff' : 'var(--muted)' }}>
      {children}
    </button>
  );
}

const card = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: 16, marginTop: 16 };
const title = { fontSize: 14, fontWeight: 700, marginBottom: 6 };
const sub = { fontSize: 13, color: 'var(--muted)', margin: '0 0 12px' };
const mutedTxt = { fontSize: 13, color: 'var(--muted)' };
const errBox = { background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.25)', color: 'var(--danger, #dc2626)', borderRadius: 10, padding: '10px 12px', fontSize: 12.5, marginBottom: 10 };
const okTxt = { color: 'var(--success, #10b981)', fontSize: 12.5, fontWeight: 600 };
const btn = { border: 'none', background: 'var(--brand)', color: '#fff', borderRadius: 980, padding: '9px 16px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', minHeight: 40 };
const ghostBtn = { border: '1px solid var(--hairline)', background: 'transparent', color: 'var(--text)', borderRadius: 980, padding: '9px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', minHeight: 40 };
const th = { textAlign: 'left', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', fontWeight: 700, padding: '6px 8px', borderBottom: '1px solid var(--hairline)', whiteSpace: 'nowrap' };
const td = { padding: '8px', borderBottom: '1px solid var(--hairline)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const groupLbl = { fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', margin: '8px 0 2px' };
const pickRow = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, minHeight: 32, cursor: 'pointer' };
