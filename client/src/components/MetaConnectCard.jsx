import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';

// "Continue with Facebook" for the Meta connection (audience-sync + paid ads).
// Same component on both surfaces via the scope prop. Writes the same fields as
// the pasted-token path in IntegrationsForm — either works; this is the easy one.
// Renders nothing until the platform Meta app (id/secret) is configured.
export default function MetaConnectCard({ entityId, scope = 'my' }) {
  const get = () => (scope === 'admin-client' ? api.adminMetaConnect(entityId) : api.myMetaConnect(entityId));
  const startFn = () => (scope === 'admin-client' ? api.adminMetaConnectStart(entityId, retPath()) : api.myMetaConnectStart(entityId, retPath()));
  const selectFn = (id) => (scope === 'admin-client' ? api.adminMetaConnectSelect(entityId, id) : api.myMetaConnectSelect(entityId, id));
  const discFn = () => (scope === 'admin-client' ? api.adminMetaConnectDisconnect(entityId) : api.myMetaConnectDisconnect(entityId));
  const retPath = () => window.location.pathname + window.location.search;

  const [v, setV] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { get().then(setV).catch(() => setV(null)); }, [entityId, scope]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!v || !v.appConfigured) return null;

  const connect = async () => {
    setBusy(true); setErr('');
    try { const r = await startFn(); window.location.href = r.url; }
    catch (e) { setErr(e.message); setBusy(false); }
  };
  const act = async (fn) => {
    setBusy(true); setErr('');
    try { setV(await fn()); } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  return (
    <div style={card}>
      <div style={title}>📘 Meta — connect with Facebook</div>
      <p style={sub}>
        One login connects this client's ad account for <b>audience sync</b> and <b>paid-ads reporting</b> —
        no tokens to paste. (The manual token fields above still work as the advanced path.)
      </p>
      {err && <p style={{ ...sub, color: 'var(--danger, #dc2626)' }}>{err}</p>}

      {v.pendingAccounts?.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Which ad account is this client's?</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {v.pendingAccounts.map((a) => (
              <button key={a.id} disabled={busy} onClick={() => act(() => selectFn(a.id))}
                style={{ ...ghostBtn, justifyContent: 'flex-start', textAlign: 'left', width: '100%' }}>
                {a.name} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· {a.id}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {v.connected && !v.pendingAccounts?.length ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 220px', minWidth: 0, fontSize: 13 }}>
            <b>Connected{v.connectedAs ? ` as ${v.connectedAs}` : ''}</b>
            <span style={{ color: 'var(--muted)' }}> · {v.adAccountId}</span>
            {v.daysLeft != null && (
              <div style={{ fontSize: 12, marginTop: 2, color: v.needsReconnect ? 'var(--danger, #dc2626)' : 'var(--muted)' }}>
                {v.needsReconnect ? `⚠ Access expires in ${Math.max(v.daysLeft, 0)} day(s) — reconnect below` : `Access renews ${new Date(v.expiresAt).toLocaleDateString()}`}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button style={v.needsReconnect ? btn : ghostBtn} disabled={busy} onClick={connect}>{v.needsReconnect ? 'Reconnect' : 'Reconnect / switch'}</button>
            <button style={dangerBtn} disabled={busy} onClick={() => window.confirm('Disconnect Meta? Audience sync and paid-ads reporting stop until reconnected.') && act(discFn)}>Disconnect</button>
          </div>
        </div>
      ) : !v.pendingAccounts?.length && (
        <button style={{ ...btn, background: '#1877f2', borderColor: '#1877f2' }} disabled={busy} onClick={connect}>
          {busy ? 'Opening…' : 'Continue with Facebook'}
        </button>
      )}
    </div>
  );
}

const card = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: 16, marginTop: 16 };
const title = { fontSize: 14, fontWeight: 700, marginBottom: 6 };
const sub = { fontSize: 13, color: 'var(--muted)', margin: '0 0 12px' };
const btn = { border: '1px solid var(--hairline)', background: 'var(--brand)', color: '#fff', borderRadius: 980, padding: '9px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', minHeight: 40 };
const ghostBtn = { ...btn, background: 'transparent', color: 'inherit', display: 'flex', alignItems: 'center', gap: 6 };
const dangerBtn = { ...ghostBtn, color: 'var(--danger, #dc2626)', flexShrink: 0 };
