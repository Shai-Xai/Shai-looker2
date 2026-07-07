import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// Custom sending domain — the SAME card serves both surfaces (dual-surface
// rule): Admin → client detail (scope 'admin') and the client's own Settings
// (scope 'my'). Set a domain → hand the DNS records to IT → Verify → campaigns
// and digests send from you@yourdomain instead of the platform address.
export default function SendingDomainCard({ entityId, scope = 'admin' }) {
  const [d, setD] = useState(null);
  const [domain, setDomain] = useState('');
  const [local, setLocal] = useState('events');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState('');
  const hydrate = (v) => { setD(v); setDomain(v.domain || ''); setLocal(v.fromLocal || 'events'); };
  useEffect(() => { setD(null); setErr(''); api.getSendingDomain(entityId, scope).then(hydrate).catch((e) => setErr(e.message)); }, [entityId, scope]);
  if (err && !d) return <div style={{ fontSize: 12.5, color: 'var(--error,#ef4444)' }}>{err}</div>;
  if (!d) return <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Loading…</div>;

  const run = (fn) => { setBusy(true); setErr(''); fn().then(hydrate).catch((e) => setErr(e.message)).finally(() => setBusy(false)); };
  const save = () => { if (!domain.trim()) return; run(() => api.saveSendingDomain(entityId, { domain: domain.trim(), fromLocal: local.trim() || 'events' }, scope)); };
  const verify = () => run(() => api.verifySendingDomain(entityId, scope));
  const remove = () => { if (window.confirm('Remove the custom sending domain? Sends fall back to the platform address.')) run(() => api.deleteSendingDomain(entityId, scope)); };
  const copy = async (v, k) => { try { await navigator.clipboard.writeText(v); setCopied(k); setTimeout(() => setCopied(''), 1500); } catch { /* ignore */ } };

  const chip = d.status === 'verified'
    ? { label: '✓ Verified — sending live', color: '#15803d', bg: 'rgba(21,128,61,0.1)' }
    : d.status === 'unset' ? null
    : { label: d.status === 'failed' ? '✗ Verification failed — check the DNS records' : '⏳ Waiting for DNS — add the records below, then Verify', color: '#b45309', bg: 'rgba(180,83,9,0.1)' };
  const input = { padding: '7px 10px', borderRadius: 8, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 13 };
  const btn = { ...input, cursor: 'pointer', fontWeight: 600 };
  const mono = { fontFamily: 'ui-monospace, monospace', fontSize: 11, wordBreak: 'break-all' };

  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 8 }}>
        Send campaigns and digests from <b>your own domain</b> instead of {d.platformFrom}. Use a subdomain (e.g. <code>mail.yourbrand.com</code>) so your main domain's email reputation is untouched. Until it's verified, sends keep using the platform address — nothing breaks.
      </div>
      {chip && <div style={{ display: 'inline-block', fontSize: 11.5, fontWeight: 700, color: chip.color, background: chip.bg, borderRadius: 980, padding: '3px 11px', marginBottom: 8 }}>{chip.label}</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={local} onChange={(e) => setLocal(e.target.value)} placeholder="events" style={{ ...input, width: 110 }} aria-label="From address (before the @)" />
        <span style={{ color: 'var(--muted)' }}>@</span>
        <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="mail.yourbrand.com" style={{ ...input, width: 220 }} aria-label="Sending domain" />
        <button onClick={save} disabled={busy || !domain.trim()} style={btn}>{busy ? '…' : (d.status === 'unset' ? 'Set up' : 'Save')}</button>
        {d.status !== 'unset' && <button onClick={verify} disabled={busy} style={btn}>↻ Verify</button>}
        {d.status !== 'unset' && <button onClick={remove} disabled={busy} style={{ ...btn, color: 'var(--error,#ef4444)' }}>Remove</button>}
      </div>
      {err && <div style={{ fontSize: 12, color: 'var(--error,#ef4444)', marginTop: 6 }}>{err}</div>}
      {d.status !== 'unset' && d.records.length > 0 && (
        <div style={{ marginTop: 10, border: '1px solid var(--hairline)', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', padding: '7px 10px', borderBottom: '1px solid var(--hairline)' }}>
            Add these records at your DNS host (copy each value), then hit <b>Verify</b>. DNS can take a few minutes to a few hours to propagate.
          </div>
          <div style={{ overflowX: 'auto' }}>
            {d.records.map((r, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 10px', borderTop: i ? '1px solid var(--hairline)' : 'none', fontSize: 12 }}>
                <span style={{ fontWeight: 700, width: 44, flexShrink: 0 }}>{r.type}</span>
                <span style={{ ...mono, flex: '0 1 220px', minWidth: 120 }}>{r.name}</span>
                <span style={{ ...mono, flex: 1, minWidth: 0, color: 'var(--muted)' }}>{String(r.value).slice(0, 80)}{String(r.value).length > 80 ? '…' : ''}</span>
                {r.priority !== '' && r.priority != null && <span style={{ flexShrink: 0, color: 'var(--muted)' }}>prio {r.priority}</span>}
                <span style={{ flexShrink: 0, fontSize: 11, color: r.status === 'verified' ? '#15803d' : 'var(--muted)' }}>{r.status === 'verified' ? '✓' : r.status || 'pending'}</span>
                <button onClick={() => copy(r.value, `${i}`)} style={{ ...btn, padding: '3px 9px', fontSize: 11, flexShrink: 0 }}>{copied === `${i}` ? '✓ Copied' : 'Copy'}</button>
              </div>
            ))}
          </div>
        </div>
      )}
      {d.active && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>Emails now send as <b>{d.from}</b> (display name still follows your branding).</div>}
    </div>
  );
}
