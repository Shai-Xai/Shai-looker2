import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';

// Client-facing ad-audience hub: every audience Pulse mirrors out to Meta /
// TikTok for THIS client, in one place — connection health, live size/status,
// and links out. Self-service mirror of the admin connector-health view, scoped
// to the client's own entity (/api/my). Mobile-first single column.
const CHANNELS = [
  { key: 'meta', label: 'Meta', icon: '◇', hint: 'Facebook & Instagram Custom Audiences' },
  { key: 'tiktok', label: 'TikTok', icon: '♪', hint: 'TikTok Custom Audiences' },
];

const when = (iso) => {
  if (!iso) return 'never';
  try { return new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return iso; }
};

export default function AudienceHub({ entityId }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [verify, setVerify] = useState({}); // channel -> result | 'checking'
  const [sizes, setSizes] = useState({});   // `${channel}:${audienceId}` -> result | 'checking'
  const [syncing, setSyncing] = useState({}); // segmentId -> bool
  const [syncMsg, setSyncMsg] = useState({}); // segmentId -> message
  const [busy, setBusy] = useState(false);

  const load = () => {
    setBusy(true);
    api.myAudiences(entityId)
      .then((r) => { setData(r.channels || {}); setErr(''); })
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(() => { if (entityId) load(); /* eslint-disable-next-line */ }, [entityId]);

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
  // Re-push a segment's current members to the platform (reuses the segment sync
  // route the Segments tab uses; needs campaigns.approve — surfaces an error if not).
  const doSync = async (channel, segmentId) => {
    setSyncing((s) => ({ ...s, [segmentId]: true }));
    setSyncMsg((m) => ({ ...m, [segmentId]: '' }));
    try {
      const fn = channel === 'tiktok' ? api.syncSegmentTikTok : api.syncSegmentMeta;
      const r = await fn(entityId, segmentId);
      const label = channel === 'tiktok' ? 'TikTok' : 'Meta';
      setSyncMsg((m) => ({ ...m, [segmentId]: `✓ ${r.received ?? r.pushed ?? 0} synced${r.added != null ? ` (+${r.added} −${r.removed ?? 0})` : ''} to ${label}` }));
      load();
    } catch (e) {
      setSyncMsg((m) => ({ ...m, [segmentId]: `✗ ${e.message}` }));
    } finally {
      setSyncing((s) => ({ ...s, [segmentId]: false }));
    }
  };

  if (err) return <p style={muted}>Couldn’t load your audiences: {err}</p>;
  if (!data) return <p style={muted}>Loading…</p>;

  const anyConnected = CHANNELS.some((c) => data[c.key]?.configured);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <p style={{ ...muted, margin: 0, flex: 1, minWidth: 200 }}>
          Every audience Pulse keeps in sync with your ad platforms. Emails &amp; phone numbers are <b>hashed</b> before they leave Pulse — the platform only ever sees the hash, never the raw contact.
        </p>
        <button onClick={load} disabled={busy} style={refreshBtn}>{busy ? '…' : '↻ Refresh'}</button>
      </div>

      {!anyConnected && (
        <div style={card}>
          <p style={{ ...muted, margin: 0 }}>
            No ad platform is connected yet. Add a <b>Meta</b> or <b>TikTok</b> connection under
            {' '}<b>Settings → Integrations</b> (or ask your Howler contact), then sync a segment from the
            {' '}<b>Segments</b> tab to see it here.
          </p>
        </div>
      )}

      {CHANNELS.map((c) => {
        const ch = data[c.key];
        if (!ch || (!ch.configured && !ch.audienceCount)) return null;
        const vr = verify[c.key];
        const audiences = [...(ch.audiences || [])].sort((a, b) => String(b.at).localeCompare(String(a.at)));
        return (
          <div key={c.key} style={card}>
            {/* Channel header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 18 }}>{c.icon}</span>
              <span style={{ fontWeight: 700, fontSize: 16 }}>{c.label}</span>
              <StatusPill ch={ch} />
              <span style={{ flex: 1 }} />
              {ch.configured && <button onClick={() => doVerify(c.key)} disabled={vr === 'checking'} style={chip}>{vr === 'checking' ? 'Checking…' : 'Verify connection'}</button>}
              {ch.audiencesUrl && <a href={ch.audiencesUrl} target="_blank" rel="noreferrer" style={link}>Open in {c.label} ↗</a>}
            </div>
            <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>{c.hint}{ch.lastAt ? ` · last activity ${when(ch.lastAt)}` : ''}</div>

            {/* Live verify result */}
            {vr && vr !== 'checking' && (
              <div style={{ fontSize: 12.5, marginTop: 8, color: vr.ok ? 'var(--success,#10b981)' : 'var(--error,#ef4444)' }}>
                {vr.ok
                  ? `✓ Connection healthy — ${vr.account || 'connected'}${vr.accountStatus != null ? ` (account status: ${vr.accountStatus})` : ''}`
                  : `✗ ${vr.status === 'token_invalid' ? 'Access token is no longer valid — reconnect under Integrations' : (vr.detail || vr.status)}`}
              </div>
            )}
            {ch.lastError && (
              <div style={{ fontSize: 12, marginTop: 6, color: 'var(--error,#ef4444)' }}>Last error ({when(ch.lastError.at)}): {ch.lastError.error}</div>
            )}

            {/* Audience list */}
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {audiences.length === 0
                ? <p style={{ ...muted, margin: 0, fontSize: 13 }}>{ch.configured ? 'No audiences synced yet — push a segment from the Segments tab.' : 'Not connected.'}</p>
                : audiences.map((a) => {
                  const sk = `${c.key}:${a.audienceId}`; const sr = sizes[sk];
                  const failed = a.status === 'error';
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
                          : <>{a.received} contact{a.received === 1 ? '' : 's'} synced{a.audienceId ? ` · audience ${a.audienceId}` : ''}</>}
                      </div>
                      <div style={{ paddingLeft: 20, marginTop: 6, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <button onClick={() => doSync(c.key, a.segmentId)} disabled={!!syncing[a.segmentId]} style={chip} title="Re-push this segment's current members to the platform">{syncing[a.segmentId] ? 'Syncing…' : '↻ Sync now'}</button>
                        {!failed && a.audienceId && <button onClick={() => doSize(c.key, a.audienceId)} disabled={sr === 'checking'} style={chip}>{sr === 'checking' ? 'Checking…' : 'Check live size'}</button>}
                        {sr && sr !== 'checking' && (
                          <span style={{ fontSize: 12, color: sr.ok ? 'var(--muted)' : 'var(--error,#ef4444)' }}>
                            {sr.ok
                              ? (sr.size == null || sr.size < 0
                                ? `↳ still processing on ${c.label}${sr.operation ? ` · ${sr.operation}` : ''}`
                                : `↳ ~${sr.size} matched on ${c.label}${sr.operation ? ` · ${sr.operation}` : ''}`)
                              : `↳ ${sr.error}`}
                          </span>
                        )}
                      </div>
                      {syncMsg[a.segmentId] && <div style={{ paddingLeft: 20, marginTop: 4, fontSize: 12, color: syncMsg[a.segmentId].startsWith('✗') ? 'var(--error,#ef4444)' : 'var(--success,#10b981)' }}>{syncMsg[a.segmentId]}</div>}
                    </div>
                  );
                })}
            </div>
          </div>
        );
      })}

      <p style={{ ...muted, fontSize: 11.5, marginTop: 2 }}>
        Audience match counts and availability are reported by the ad platform and can take a few hours to update. Platforms only let an audience be <i>used</i> for targeting once it’s large enough (typically ~1,000 matched people).
      </p>
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
