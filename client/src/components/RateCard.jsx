import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';

// Per-channel campaign rate card. One component, three surfaces (dual-surface rule):
//   scope='master'        → platform default rates (Admin → Settings)
//   scope='admin-client'  → per-client overrides (Admin → client → Fees); blank inherits master
//   scope='my'            → client self-service: read-only effective rates + spend rollup
// Costs are per MESSAGE sent. Currency is set on the master card.
const money = (cur, n) => `${cur === 'ZAR' ? 'R' : `${cur || 'R'} `}${Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function RateCard({ scope = 'my', entityId, canEdit = true }) {
  // 'my' is always read-only (client self-service); an admin scope is read-only
  // when the viewer lacks permission (canEdit=false) — the server enforces the same.
  const readOnly = scope === 'my' || !canEdit;
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null); // editable copy (rate inputs as strings)
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = () => {
    const p = scope === 'master' ? api.getBillingMaster()
      : scope === 'admin-client' ? api.getBillingEntityRates(entityId)
        : api.getMyBilling(entityId);
    p.then((r) => { setData(r); setDraft(buildDraft(scope, r)); }).catch(() => setData({ error: true }));
  };
  useEffect(() => { load(); }, [scope, entityId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p>;
  if (data.error) return <p style={{ color: 'var(--error,#ef4444)', fontSize: 13 }}>Couldn’t load billing.</p>;

  const channels = data.channels || ['email', 'sms', 'whatsapp'];
  const labels = data.labels || { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' };
  const currency = data.currency || data.rates?.currency || 'ZAR';
  const master = data.master || {}; // for admin-client placeholders

  const save = () => {
    setBusy(true); setSaved(false);
    const body = {};
    for (const ch of channels) body[ch] = draft[ch]; // '' clears an override (admin-client) / keeps master
    if (scope === 'master') body.currency = draft.currency || currency;
    const p = scope === 'master' ? api.saveBillingMaster(body) : api.saveBillingEntityRates(entityId, body);
    p.then((r) => { setData(r); setDraft(buildDraft(scope, r)); setSaved(true); setTimeout(() => setSaved(false), 2000); })
      .catch((e) => alert('Save failed: ' + (e.message || e))).finally(() => setBusy(false));
  };

  // Read-only view: 'my' is the client's self-service (rates + spend rollup); an
  // admin scope shown read-only (no permission) shows just the effective rates.
  if (readOnly) {
    const spend = data.spend || { total: 0, campaigns: [] };
    const clientView = scope === 'my';
    return (
      <div style={{ maxWidth: 640 }}>
        <h3 style={h3}>{clientView ? 'Your rates' : 'Rates'}</h3>
        <p style={hint}>{clientView
          ? 'What you’re charged per message sent. Campaign costs use these rates.'
          : 'Effective per-message fees. You don’t have permission to change these.'}</p>
        <table style={table}>
          <tbody>
            {channels.map((ch) => (
              <tr key={ch}>
                <td style={tdLabel}>{labels[ch]}</td>
                <td style={tdVal}>{money(currency, data.rates[ch])} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>/ message</span>
                  {scope === 'admin-client' && data.inherited?.[ch] ? <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}> · inherited</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {clientView && (
          <>
            <h3 style={{ ...h3, marginTop: 22 }}>Campaign spend</h3>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>{money(currency, spend.total)}<span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600, marginLeft: 8 }}>across {spend.campaigns?.length || 0} campaign{spend.campaigns?.length === 1 ? '' : 's'}</span></div>
            {(spend.campaigns || []).length > 0 && (
              <div style={{ marginTop: 12, border: '1px solid var(--hairline)', borderRadius: 10, overflow: 'hidden' }}>
                {spend.campaigns.map((c) => (
                  <div key={c.id} style={spendRow}>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title || 'Campaign'}</span>
                    <span style={{ color: 'var(--muted)', fontSize: 12, flexShrink: 0 }}>{c.sent} sent</span>
                    <span style={{ fontWeight: 700, flexShrink: 0, minWidth: 80, textAlign: 'right' }}>{money(currency, c.cost)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  // Editable: master or per-client overrides.
  return (
    <div style={{ maxWidth: 560 }}>
      <p style={hint}>
        {scope === 'master'
          ? 'Platform-default price per message. Each client inherits these unless you set a client-specific fee.'
          : 'Per-message fees for this client. Leave a field blank to inherit the platform master rate.'}
      </p>
      {scope === 'master' && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, fontSize: 13 }}>
          <span style={{ width: 90, color: 'var(--muted)', fontWeight: 600 }}>Currency</span>
          <input value={draft.currency || ''} onChange={(e) => setDraft((d) => ({ ...d, currency: e.target.value }))} style={{ ...input, width: 90 }} placeholder="ZAR" />
        </label>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {channels.map((ch) => (
          <label key={ch} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 90, fontSize: 13, fontWeight: 600 }}>{labels[ch]}</span>
            <span style={{ color: 'var(--muted)', fontSize: 13 }}>{currency === 'ZAR' ? 'R' : currency}</span>
            <input
              type="number" min="0" step="0.01"
              value={draft[ch]}
              onChange={(e) => { const v = e.target.value; setDraft((d) => ({ ...d, [ch]: v })); }}
              placeholder={scope === 'admin-client' ? `master: ${Number(master[ch] || 0).toFixed(2)}` : '0.00'}
              style={{ ...input, width: 130 }}
            />
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>/ message
              {scope === 'admin-client' && data.inherited?.[ch] ? ' · inherited' : ''}</span>
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
        <button onClick={save} disabled={busy} style={saveBtn}>{busy ? 'Saving…' : 'Save rates'}</button>
        {saved && <span style={{ color: 'var(--success,#10b981)', fontSize: 12, fontWeight: 700 }}>Saved ✓</span>}
      </div>
    </div>
  );
}

function buildDraft(scope, r) {
  const channels = r.channels || ['email', 'sms', 'whatsapp'];
  const d = {};
  if (scope === 'master') {
    for (const ch of channels) d[ch] = r.rates?.[ch] != null ? String(r.rates[ch]) : '';
    d.currency = r.rates?.currency || 'ZAR';
  } else if (scope === 'admin-client') {
    // Only show a value when explicitly overridden; blank = inherit.
    for (const ch of channels) d[ch] = r.overrides?.[ch] != null ? String(r.overrides[ch]) : '';
  }
  return d;
}

const h3 = { fontSize: 14, fontWeight: 800, margin: '0 0 4px' };
const hint = { color: 'var(--muted)', fontSize: 13, marginBottom: 14, lineHeight: 1.5 };
const input = { padding: '8px 10px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, background: 'var(--card)', color: 'var(--text)', fontFamily: 'inherit' };
const saveBtn = { padding: '9px 18px', borderRadius: 980, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' };
const table = { width: '100%', borderCollapse: 'collapse', maxWidth: 360 };
const tdLabel = { padding: '8px 10px', fontSize: 13, fontWeight: 600, borderBottom: '1px solid var(--hairline)' };
const tdVal = { padding: '8px 10px', fontSize: 13, fontWeight: 700, textAlign: 'right', borderBottom: '1px solid var(--hairline)' };
const spendRow = { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderBottom: '1px solid var(--hairline)', fontSize: 13 };
