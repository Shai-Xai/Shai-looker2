import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';
import PlatformIcon, { PLATFORMS } from './PlatformIcon.jsx';

// Client-facing ad-audience hub. One sub-tab per ad platform (TikTok, Meta, and
// reserved X / YouTube). Each live channel shows BOTH the audiences Pulse manages
// (synced from a segment) and any OTHER audiences that exist on the platform —
// reconciled by audience id — plus connection health and live match size.
// Mobile-first single column. Scoped to the client's own entity via /api/my.
const CHANNEL_ORDER = ['tiktok', 'meta', 'google', 'x', 'youtube'];

const when = (iso) => {
  if (!iso) return 'never';
  try { return new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return iso; }
};
const fmtSize = (n, label) => (n == null || n < 0 ? `still processing on ${label}` : `~${n} matched on ${label}`);

export default function AudienceHub({ entityId }) {
  const [data, setData] = useState(null);       // { meta, tiktok } Pulse summaries
  const [err, setErr] = useState('');
  const [active, setActive] = useState('tiktok');
  const [platform, setPlatform] = useState({}); // channel -> { loading, ok, audiences, error }
  const [verify, setVerify] = useState({});     // channel -> result | 'checking'
  const [sizes, setSizes] = useState({});       // `${channel}:${audienceId}` -> result | 'checking'
  const [syncing, setSyncing] = useState({});   // segmentId -> bool
  const [syncMsg, setSyncMsg] = useState({});   // segmentId -> message
  const [busy, setBusy] = useState(false);

  const loadSummaries = () => {
    setBusy(true);
    return api.myAudiences(entityId)
      .then((r) => { setData(r.channels || {}); setErr(''); return r.channels || {}; })
      .catch((e) => { setErr(e.message); return {}; })
      .finally(() => setBusy(false));
  };
  // First load: pick the first connected live channel as the default tab.
  useEffect(() => {
    if (!entityId) return;
    loadSummaries().then((ch) => {
      const firstConnected = CHANNEL_ORDER.find((k) => PLATFORMS[k]?.live && ch[k]?.configured);
      if (firstConnected) setActive(firstConnected);
    });
    // eslint-disable-next-line
  }, [entityId]);

  const loadPlatform = (channel, force = false) => {
    if (!PLATFORMS[channel]?.live) return;
    if (!force && platform[channel] && !platform[channel].loading) return;
    setPlatform((p) => ({ ...p, [channel]: { loading: true } }));
    api.myPlatformAudiences(entityId, channel)
      .then((r) => setPlatform((p) => ({ ...p, [channel]: { loading: false, ok: r.ok, audiences: r.audiences || [], error: r.error } })))
      .catch((e) => setPlatform((p) => ({ ...p, [channel]: { loading: false, ok: false, error: e.message } })));
  };
  // Load the active channel's live platform list when it's connected.
  useEffect(() => {
    if (data && data[active]?.configured) {
      loadPlatform(active);
      if (verify[active] === undefined) doVerify(active); // surface the account profile name without a click
    }
    // eslint-disable-next-line
  }, [active, data]);

  const doVerify = async (channel) => {
    setVerify((v) => ({ ...v, [channel]: 'checking' }));
    try { const r = await api.myVerifyConnector(entityId, channel); setVerify((v) => ({ ...v, [channel]: r })); }
    catch (e) { setVerify((v) => ({ ...v, [channel]: { ok: false, status: 'error', detail: e.message } })); }
  };
  const doSize = async (channel, audienceId) => {
    const k = `${channel}:${audienceId}`;
    setSizes((s) => ({ ...s, [k]: 'checking' }));
    try { const r = await api.myAudienceStatus(entityId, channel, audienceId); setSizes((s) => ({ ...s, [k]: r })); }
    catch (e) { setSizes((s) => ({ ...s, [k]: { ok: false, error: e.message } })); }
  };
  const doSync = async (channel, segmentId) => {
    setSyncing((s) => ({ ...s, [segmentId]: true }));
    setSyncMsg((m) => ({ ...m, [segmentId]: '' }));
    try {
      const fn = channel === 'tiktok' ? api.syncSegmentTikTok : api.syncSegmentMeta;
      const r = await fn(entityId, segmentId);
      const label = PLATFORMS[channel]?.label || channel;
      setSyncMsg((m) => ({ ...m, [segmentId]: `✓ ${r.received ?? r.pushed ?? 0} synced${r.added != null ? ` (+${r.added} −${r.removed ?? 0})` : ''} to ${label}` }));
      loadSummaries(); loadPlatform(channel, true);
    } catch (e) {
      setSyncMsg((m) => ({ ...m, [segmentId]: `✗ ${e.message}` }));
    } finally {
      setSyncing((s) => ({ ...s, [segmentId]: false }));
    }
  };

  if (err) return <p style={muted}>Couldn’t load your audiences: {err}</p>;
  if (!data) return <p style={muted}>Loading…</p>;

  const meta = PLATFORMS[active];
  const ch = data[active];
  const plat = platform[active];
  const pulseAudiences = [...((ch && ch.audiences) || [])].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const pulseIds = new Set(pulseAudiences.map((a) => a.audienceId).filter(Boolean));
  const platById = {}; for (const a of (plat?.audiences || [])) platById[a.audienceId] = a;
  const external = (plat?.audiences || []).filter((a) => a.audienceId && !pulseIds.has(a.audienceId));
  const vr = verify[active];
  const accountId = (ch && (ch.advertiserId || ch.adAccountId)) || '';
  const accountName = (vr && vr !== 'checking' && vr.ok && vr.account) ? vr.account : '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Channel sub-tabs */}
      <div className="no-scrollbar" style={subTabBar}>
        {CHANNEL_ORDER.map((key) => {
          const p = PLATFORMS[key]; const cch = data[key]; const on = key === active;
          return (
            <button key={key} onClick={() => setActive(key)} style={{ ...subTab, color: on ? 'var(--brand)' : 'var(--text)', borderBottomColor: on ? 'var(--brand)' : 'transparent', fontWeight: on ? 700 : 600 }}>
              <PlatformIcon channel={key} size={15} color={on ? 'var(--brand)' : undefined} />
              {p.label}
              {!p.live
                ? <span style={soonTag}>soon</span>
                : cch?.configured
                  ? <span style={{ ...dot, background: cch.errors > 0 ? 'var(--error,#ef4444)' : 'var(--success,#10b981)' }} />
                  : <span style={{ ...dot, background: '#9ca3af' }} />}
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <p style={{ ...muted, margin: 0, flex: 1, minWidth: 200 }}>
          Audiences on <b>{meta.label}</b>. Emails &amp; phone numbers are <b>hashed</b> before they leave Pulse — {meta.label} only ever sees the hash.
        </p>
        {meta.live && ch?.configured && <button onClick={() => { loadSummaries(); loadPlatform(active, true); }} disabled={busy} style={refreshBtn}>{busy ? '…' : '↻ Refresh'}</button>}
      </div>

      {/* Reserved channels */}
      {!meta.live && (
        <div style={card}>
          <p style={{ ...muted, margin: 0 }}><b>{meta.label}</b> audience sync is on the roadmap — not connectable yet. TikTok and Meta are live today.</p>
        </div>
      )}

      {/* Live channel, not connected */}
      {meta.live && !ch?.configured && (
        <div style={card}>
          <p style={{ ...muted, margin: 0 }}>
            {meta.label} isn’t connected yet. Add it under <b>Settings → Integrations</b> (or ask your Howler contact), then sync a segment from the <b>Segments</b> tab to manage it here.
          </p>
        </div>
      )}

      {/* Live + connected */}
      {meta.live && ch?.configured && (
        <>
          {/* Connection header */}
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <PlatformIcon channel={active} size={20} />
              <span style={{ fontWeight: 700, fontSize: 16 }}>{meta.label}</span>
              <StatusPill ch={ch} />
              <span style={{ flex: 1 }} />
              <button onClick={() => doVerify(active)} disabled={vr === 'checking'} style={chip}>{vr === 'checking' ? 'Checking…' : 'Verify connection'}</button>
              {ch.audiencesUrl && <a href={ch.audiencesUrl} target="_blank" rel="noreferrer" style={link}>Open in {meta.label} ↗</a>}
            </div>
            {(accountName || accountId) && <div style={{ ...muted, fontSize: 12.5, marginTop: 4 }}>Account: <b style={{ color: 'var(--text)' }}>{accountName || accountId}</b>{accountName && accountId ? ` · ${accountId}` : ''}</div>}
            {ch.lastAt && <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>Last activity {when(ch.lastAt)}</div>}
            {vr && vr !== 'checking' && (
              <div style={{ fontSize: 12.5, marginTop: 8, color: vr.ok ? 'var(--success,#10b981)' : 'var(--error,#ef4444)' }}>
                {vr.ok
                  ? `✓ Connection healthy — ${vr.account || 'connected'}${vr.accountStatus != null ? ` (account status: ${vr.accountStatus})` : ''}`
                  : `✗ ${vr.status === 'token_invalid' ? 'Access token is no longer valid — reconnect under Integrations' : (vr.detail || vr.status)}`}
              </div>
            )}
            {ch.lastError && <div style={{ fontSize: 12, marginTop: 6, color: 'var(--error,#ef4444)' }}>Last error ({when(ch.lastError.at)}): {ch.lastError.error}</div>}
          </div>

          {/* Managed by Pulse */}
          <Group title="Managed by Pulse" count={pulseAudiences.length}>
            {pulseAudiences.length === 0
              ? <p style={{ ...muted, margin: 0, fontSize: 13 }}>No audiences synced yet — push a segment from the Segments tab.</p>
              : pulseAudiences.map((a) => {
                const sk = `${active}:${a.audienceId}`; const sr = sizes[sk];
                const failed = a.status === 'error';
                const liveMatch = a.audienceId ? platById[a.audienceId] : null;
                return (
                  <div key={a.segmentId} style={audienceRow}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <span style={{ flexShrink: 0, fontWeight: 700, color: failed ? 'var(--error,#ef4444)' : 'var(--success,#10b981)' }}>{failed ? '✗' : '✓'}</span>
                      <span style={{ flex: 1, minWidth: 0, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name || a.segmentId}</span>
                      <span style={{ flexShrink: 0, ...muted, fontSize: 11 }}>{when(a.at)}</span>
                    </div>
                    <div style={{ ...muted, fontSize: 12, marginTop: 3, paddingLeft: 20 }}>
                      {failed
                        ? <span style={{ color: 'var(--error,#ef4444)' }}>{a.error}</span>
                        : <>{a.received} contact{a.received === 1 ? '' : 's'} synced{liveMatch ? ` · ${fmtSize(liveMatch.size, meta.label)}` : ''}{a.audienceId ? ` · audience ${a.audienceId}` : ''}</>}
                    </div>
                    <div style={{ paddingLeft: 20, marginTop: 6, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <button onClick={() => doSync(active, a.segmentId)} disabled={!!syncing[a.segmentId]} style={chip} title="Re-push this segment's current members to the platform">{syncing[a.segmentId] ? 'Syncing…' : '↻ Sync now'}</button>
                      {!failed && a.audienceId && <button onClick={() => doSize(active, a.audienceId)} disabled={sr === 'checking'} style={chip}>{sr === 'checking' ? 'Checking…' : 'Check live size'}</button>}
                      {sr && sr !== 'checking' && (
                        <span style={{ fontSize: 12, color: sr.ok ? 'var(--muted)' : 'var(--error,#ef4444)' }}>
                          {sr.ok ? `↳ ${fmtSize(sr.size, meta.label)}${sr.operation ? ` · ${sr.operation}` : ''}` : `↳ ${sr.error}`}
                        </span>
                      )}
                    </div>
                    {syncMsg[a.segmentId] && <div style={{ paddingLeft: 20, marginTop: 4, fontSize: 12, color: syncMsg[a.segmentId].startsWith('✗') ? 'var(--error,#ef4444)' : 'var(--success,#10b981)' }}>{syncMsg[a.segmentId]}</div>}
                  </div>
                );
              })}
          </Group>

          {/* Other audiences that exist on the platform */}
          <Group title={`Also on ${meta.label}`} count={plat?.ok ? external.length : null} subtitle="Created directly in the ad account — Pulse shows them for visibility but doesn’t manage them.">
            {plat?.loading ? <p style={{ ...muted, margin: 0, fontSize: 13 }}>Loading from {meta.label}…</p>
              : !plat ? <p style={{ ...muted, margin: 0, fontSize: 13 }}>—</p>
              : !plat.ok ? <p style={{ margin: 0, fontSize: 13, color: 'var(--error,#ef4444)' }}>Couldn’t read {meta.label}: {plat.error}</p>
              : external.length === 0 ? <p style={{ ...muted, margin: 0, fontSize: 13 }}>Nothing else — every audience on {meta.label} is managed by Pulse.</p>
              : external.map((a) => (
                <div key={a.audienceId} style={audienceRow}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ flex: 1, minWidth: 0, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name || a.audienceId}</span>
                    <span style={extPill}>external</span>
                  </div>
                  <div style={{ ...muted, fontSize: 12, marginTop: 3 }}>
                    {fmtSize(a.size, meta.label)}{a.type ? ` · ${a.type}` : ''}{a.createdAt ? ` · created ${a.createdAt}` : ''}{a.valid ? '' : ' · not ready'}
                  </div>
                </div>
              ))}
          </Group>
        </>
      )}

      <p style={{ ...muted, fontSize: 11.5, marginTop: 2 }}>
        Match counts &amp; availability are reported by the ad platform and can take a few hours to update. A platform only lets an audience be <i>used</i> for targeting once it’s large enough (typically ~1,000 matched people).
      </p>
    </div>
  );
}

function Group({ title, count, subtitle, children }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' }}>{title}</span>
        {count != null && <span style={{ fontSize: 11, color: 'var(--muted)' }}>({count})</span>}
      </div>
      {subtitle && <p style={{ ...muted, fontSize: 12, margin: '0 0 8px' }}>{subtitle}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
    </div>
  );
}

function StatusPill({ ch }) {
  const [color, text] = !ch.configured ? ['#9ca3af', 'not connected']
    : ch.errors > 0 ? ['var(--error,#ef4444)', `${ch.errors} need attention`]
      : ch.audienceCount > 0 ? ['var(--success,#10b981)', `${ch.audienceCount} live`]
        : ['var(--brand)', 'connected'];
  return <span style={{ fontSize: 11, fontWeight: 700, color, border: `1px solid ${color}`, borderRadius: 980, padding: '2px 9px', whiteSpace: 'nowrap' }}>{text}</span>;
}

const muted = { color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.5 };
const card = { border: '1px solid var(--hairline)', borderRadius: 14, padding: 16, background: 'var(--card)' };
const audienceRow = { border: '1px solid var(--hairline)', borderRadius: 10, padding: '10px 12px', background: 'var(--bg)' };
const chip = { padding: '5px 11px', borderRadius: 8, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' };
const refreshBtn = { ...chip, padding: '7px 12px' };
const link = { fontSize: 12, fontWeight: 600, color: 'var(--brand)', textDecoration: 'none', whiteSpace: 'nowrap' };
const subTabBar = { display: 'flex', gap: 4, overflowX: 'auto', borderBottom: '1px solid var(--hairline)', WebkitOverflowScrolling: 'touch' };
const subTab = { display: 'inline-flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap', minHeight: 40, padding: '8px 14px', border: 'none', borderBottom: '2px solid transparent', background: 'none', fontSize: 13.5, cursor: 'pointer', marginBottom: -1 };
const soonTag = { fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', background: 'rgba(128,128,128,0.16)', color: 'var(--muted)', borderRadius: 980, padding: '1px 6px' };
const dot = { width: 7, height: 7, borderRadius: '50%', display: 'inline-block' };
const extPill = { fontSize: 10, fontWeight: 700, color: 'var(--muted)', border: '1px solid var(--hairline)', borderRadius: 980, padding: '1px 7px', whiteSpace: 'nowrap' };
