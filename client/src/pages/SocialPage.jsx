import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api.js';
import { useProfile } from '../lib/profile.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';

// Social — organic social metrics pulled INTO Pulse (followers, reach, post
// engagement) for the active client's connected Facebook / Instagram / TikTok
// accounts. Mobile-first single column. Reads the dual-surface endpoints:
//   client  → /api/my/social/:entityId
//   admin   → /api/admin/entities/:id/social  (when admin previews a client)
// Connection itself is managed in Settings → Integrations (the Meta/TikTok cards).

const PLATFORMS = {
  facebook: { label: 'Facebook', icon: '◇', color: '#1877f2' },
  instagram: { label: 'Instagram', icon: '◎', color: '#e1306c' },
  tiktok: { label: 'TikTok', icon: '♪', color: '#000' },
};
const METRICS = [
  { key: 'reach', label: 'Reach' },
  { key: 'impressions', label: 'Impressions' },
  { key: 'followers', label: 'Followers' },
  { key: 'engagement', label: 'Engagement' },
];
const fmt = (n) => (n == null ? '—' : Intl.NumberFormat('en-ZA', { notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n));

export default function SocialPage() {
  const { activeEntityId } = useProfile();
  const isMobile = useIsMobile();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [metric, setMetric] = useState('reach');

  const load = useCallback(async () => {
    if (!activeEntityId) { setLoading(false); return; }
    setLoading(true); setError('');
    try { setData(await api.mySocial(activeEntityId, { metric, days: 30 })); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [activeEntityId, metric]);
  useEffect(() => { load(); }, [load]);

  async function sync() {
    if (!activeEntityId) return;
    setSyncing(true);
    try { await api.syncSocial(activeEntityId); await load(); }
    catch (e) { setError(e.message); }
    finally { setSyncing(false); }
  }

  const accounts = data?.accounts || [];
  const series = data?.series || [];
  const topPosts = data?.topPosts || [];
  const connected = (data?.summary?.platforms || []).length > 0;

  return (
    <div style={{ maxWidth: 880, margin: '0 auto', padding: isMobile ? '16px 14px 40px' : '24px 24px 56px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <h1 style={{ fontSize: isMobile ? 22 : 26, fontWeight: 800, margin: 0, flex: 1 }}>Social</h1>
        {connected && (
          <button onClick={sync} disabled={syncing} style={btn}>{syncing ? 'Syncing…' : '↻ Refresh now'}</button>
        )}
      </div>

      {loading && !data && <div style={muted}>Loading…</div>}
      {error && <div style={errBox}>{error}</div>}

      {!activeEntityId && !loading && (
        <div style={card}><div style={muted}>Pick a client (top-left) to see their connected social accounts and trends.</div></div>
      )}

      {activeEntityId && !loading && !connected && (
        <div style={card}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>No social accounts connected yet</div>
          <div style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.5 }}>
            Connect a Facebook Page, Instagram account, or TikTok in <b>Settings → Integrations</b> to pull organic
            followers, reach and post engagement into Pulse. Once connected, stats refresh here daily.
          </div>
        </div>
      )}

      {connected && (
        <>
          {/* Connected accounts — one card each (single column on phones). */}
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12, marginBottom: 22 }}>
            {accounts.map((a) => {
              const p = PLATFORMS[a.platform] || { label: a.platform, icon: '•', color: 'var(--muted)' };
              return (
                <div key={`${a.platform}:${a.accountRef}`} style={card}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 18, color: p.color }}>{p.icon}</span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name || a.username || p.label}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{p.label}{a.username ? ` · @${a.username}` : ''}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 18 }}>
                    <Stat label="Followers" value={fmt(a.followers)} />
                    {a.postsCount != null && <Stat label="Posts" value={fmt(a.postsCount)} />}
                  </div>
                  {a.lastStatus === 'error'
                    ? <div style={{ ...pill, color: 'var(--error,#ef4444)' }}>⚠ {a.lastError || 'sync error'}</div>
                    : a.lastSynced ? <div style={pill}>Synced {new Date(a.lastSynced).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}</div> : null}
                </div>
              );
            })}
          </div>

          {/* Trend — pick a metric, see the 30-day account series. */}
          <div style={{ ...card, marginBottom: 22 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              <div style={{ fontWeight: 700, fontSize: 15, flex: 1 }}>30-day trend</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {METRICS.map((m) => (
                  <button key={m.key} onClick={() => setMetric(m.key)} style={{ ...chip, ...(metric === m.key ? chipOn : null) }}>{m.label}</button>
                ))}
              </div>
            </div>
            <Sparkline series={series} />
          </div>

          {/* Top posts by engagement. */}
          <div style={card}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>Top posts</div>
            {topPosts.length === 0 && <div style={muted}>No posts pulled yet — they appear after the next sync.</div>}
            {topPosts.map((post) => {
              const p = PLATFORMS[post.platform] || { icon: '•', color: 'var(--muted)' };
              return (
                <a key={`${post.platform}:${post.postId}`} href={post.permalink || undefined} target="_blank" rel="noreferrer"
                   style={{ display: 'flex', gap: 10, padding: '10px 0', borderTop: '1px solid var(--hairline)', textDecoration: 'none', color: 'inherit' }}>
                  <span style={{ fontSize: 16, color: p.color, flexShrink: 0 }}>{p.icon}</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{post.caption || '(no caption)'}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      {post.engagement != null && <span>💬 {fmt(post.engagement)} eng.</span>}
                      {post.reach != null && <span>👁 {fmt(post.reach)} reach</span>}
                      {post.videoViews != null && <span>▶ {fmt(post.videoViews)} views</span>}
                      {post.postedAt && <span>{new Date(post.postedAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}</span>}
                    </div>
                  </div>
                </a>
              );
            })}
          </div>
        </>
      )}

      {activeEntityId && !loading && <PaidPerformance entityId={activeEntityId} isMobile={isMobile} />}
    </div>
  );
}

// Paid Meta ads performance (deep Meta P1): spend, clicks, purchases, ROAS —
// totals + per-campaign, pulled daily from the ad account already connected for
// audience-sync. Renders nothing until Meta is connected for this client.
function PaidPerformance({ entityId, isMobile }) {
  const [rep, setRep] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api.myMetaAds(entityId).then(setRep).catch(() => setRep(null)); }, [entityId]);
  if (!rep || !rep.configured) return null;
  const money = (v) => (v == null ? '—' : `${rep.currency ? `${rep.currency} ` : ''}${Intl.NumberFormat('en-ZA', { maximumFractionDigits: 2 }).format(v)}`);
  const sync = async () => {
    setBusy(true); setErr('');
    try { setRep(await api.syncMyMetaAds(entityId)); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const t = rep.totals || {};
  return (
    <div style={{ ...card, marginTop: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 15, flex: 1 }}>💸 Paid ads — Meta (last {rep.days} days)</div>
        <button onClick={sync} disabled={busy} style={btn}>{busy ? 'Syncing…' : '↻ Sync ads'}</button>
      </div>
      {err && <div style={errBox}>{err}</div>}
      {!rep.campaigns?.length ? (
        <div style={muted}>No paid activity pulled yet — tap “Sync ads” (it also refreshes automatically once a day).</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: isMobile ? 14 : 22, flexWrap: 'wrap', marginBottom: 14 }}>
            <Stat label="Spend" value={money(t.spend)} />
            <Stat label="Clicks" value={fmt(t.clicks)} />
            <Stat label="Purchases" value={fmt(t.purchases)} />
            <Stat label="Purchase value" value={money(t.purchaseValue)} />
            <Stat label="ROAS" value={t.roas != null ? `${t.roas}×` : '—'} />
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 520 }}>
              <thead>
                <tr style={{ color: 'var(--muted)', textAlign: 'right' }}>
                  <th style={{ textAlign: 'left', padding: '6px 8px 6px 0', fontWeight: 600 }}>Campaign</th>
                  <th style={th}>Spend</th><th style={th}>Clicks</th><th style={th}>CPC</th>
                  <th style={th}>Purch.</th><th style={th}>Cost/purch.</th><th style={th}>ROAS</th>
                </tr>
              </thead>
              <tbody>
                {rep.campaigns.slice(0, 12).map((c) => (
                  <tr key={c.campaignId} style={{ borderTop: '1px solid var(--hairline)', textAlign: 'right' }}>
                    <td style={{ textAlign: 'left', padding: '7px 8px 7px 0', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name || c.campaignId}</td>
                    <td style={td}>{money(c.spend)}</td><td style={td}>{fmt(c.clicks)}</td><td style={td}>{c.cpc != null ? money(c.cpc) : '—'}</td>
                    <td style={td}>{fmt(c.purchases)}</td><td style={td}>{c.costPerPurchase != null ? money(c.costPerPurchase) : '—'}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{c.roas != null ? `${c.roas}×` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
            Purchases &amp; values are Meta-attributed pixel conversions (not Howler ticket sales). ROAS = purchase value ÷ spend.
            {rep.lastSync && <> · Last synced {new Date(rep.lastSync).toLocaleString()}</>}
          </div>
        </>
      )}
    </div>
  );
}
const th = { padding: '6px 8px', fontWeight: 600 };
const td = { padding: '7px 8px', whiteSpace: 'nowrap' };

function Stat({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
    </div>
  );
}

// Minimal dependency-free sparkline (SVG) so the page stays light on mobile.
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

const card = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: 16 };
const btn = { padding: '8px 14px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const chip = { padding: '5px 11px', borderRadius: 980, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--muted)', fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const chipOn = { background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' };
const pill = { marginTop: 10, fontSize: 11, color: 'var(--muted)' };
const muted = { color: 'var(--muted)', fontSize: 13.5 };
const errBox = { background: 'rgba(239,68,68,0.08)', border: '1px solid var(--error,#ef4444)', color: 'var(--error,#ef4444)', borderRadius: 10, padding: '10px 12px', fontSize: 13, marginBottom: 16 };
