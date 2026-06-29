import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// ─── WhatsApp Owl (beta) admin ────────────────────────────────────────────────
// Wire the Owl to WhatsApp via Clickatell: the webhook URL to paste into Clickatell,
// the WhatsApp 'from' number, an optional shared secret, and the number→client links
// that let a phone number reach (only) its own org's data.
export default function WhatsAppOwl() {
  const [cfg, setCfg] = useState(null);
  const [ents, setEnts] = useState([]);
  const [secret, setSecret] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testMsg, setTestMsg] = useState('');
  const test = async () => {
    setTestMsg('Sending…');
    try {
      const r = await api.testOwlWhatsapp(testTo);
      if (r.ok) { setTestMsg('✓ Sent — check WhatsApp on that number.'); return; }
      const e = r.error ?? r.reason;
      setTestMsg(`⚠ ${typeof e === 'string' ? e : JSON.stringify(e ?? r)}`);
    } catch (e) { setTestMsg(`⚠ ${(e && e.message) || 'failed'}`); }
  };

  useEffect(() => {
    api.owlWhatsapp().then((r) => { setCfg({ from: r.from || '', webhookPath: r.webhookPath, hasSecret: r.hasSecret, hasApiKey: r.hasApiKey, numbers: r.numbers || [] }); }).catch(() => setCfg({ numbers: [] }));
    api.adminListEntities().then((r) => setEnts(Array.isArray(r) ? r : (r.entities || []))).catch(() => setEnts([]));
  }, []);
  if (!cfg) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p>;

  const setNum = (i, patch) => setCfg((c) => ({ ...c, numbers: c.numbers.map((n, j) => (j === i ? { ...n, ...patch } : n)) }));
  const addNum = () => setCfg((c) => ({ ...c, numbers: [...c.numbers, { msisdn: '', email: '', entityId: '' }] }));
  const delNum = (i) => setCfg((c) => ({ ...c, numbers: c.numbers.filter((_, j) => j !== i) }));
  const save = async () => {
    setBusy(true);
    try { await api.saveOwlWhatsapp({ from: cfg.from, numbers: cfg.numbers.filter((n) => n.msisdn && n.email), ...(secret.trim() ? { secret: secret.trim() } : {}), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }); setSaved(true); setSecret(''); setApiKey(''); setTimeout(() => setSaved(false), 1800); } catch { /* ignore */ }
    setBusy(false);
  };

  const fld = { padding: '6px 9px', borderRadius: 7, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 13, fontFamily: 'inherit' };
  const lbl = { display: 'block', fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted)', margin: '8px 0 2px' };
  const webhookUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}${cfg.webhookPath || '/api/whatsapp/inbound'}`;

  return (
    <div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 8px' }}>Customers message your Clickatell WhatsApp number and chat with the Owl. It recognises the phone number → its client, and answers only that client’s data. Replies are free-form (inside WhatsApp’s 24-hour window) — no template approval needed.</p>

      <span style={lbl}>1 · Webhook URL (paste into Clickatell’s inbound callback)</span>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <code style={{ ...fld, flex: 1, overflow: 'auto', whiteSpace: 'nowrap' }}>{webhookUrl}</code>
        <button onClick={() => navigator.clipboard && navigator.clipboard.writeText(webhookUrl)} style={{ ...fld, cursor: 'pointer' }}>Copy</button>
      </div>

      <span style={lbl}>2 · WhatsApp API key {cfg.hasApiKey ? '(set — leave blank to keep)' : '(the Authorization value from this Clickatell integration)'}</span>
      <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={cfg.hasApiKey ? '•••••• (unchanged)' : 'paste the Authorization key'} style={{ ...fld, width: 320 }} />
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>WhatsApp can use a different Clickatell integration than SMS — set its key here. If left blank, it falls back to the SMS Clickatell key.</div>

      <span style={lbl}>3 · WhatsApp ‘from’ number (optional — One API usually infers it; digits only)</span>
      <input value={cfg.from} onChange={(e) => setCfg((c) => ({ ...c, from: e.target.value }))} placeholder="e.g. 27XXXXXXXXX (or leave blank)" style={{ ...fld, width: 220 }} />

      <span style={lbl}>4 · Optional webhook secret {cfg.hasSecret ? '(set — leave blank to keep)' : ''}</span>
      <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={cfg.hasSecret ? '•••••• (unchanged)' : 'add ?key=… to the webhook URL'} style={{ ...fld, width: 260 }} />

      <span style={lbl}>5 · Linked numbers (which phone → which client)</span>
      {cfg.numbers.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--muted)', margin: '2px 0' }}>No numbers linked yet — add one below.</div>}
      {cfg.numbers.map((n, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
          <input value={n.msisdn} onChange={(e) => setNum(i, { msisdn: e.target.value })} placeholder="phone (27…)" style={{ ...fld, width: 130 }} />
          <input value={n.email} onChange={(e) => setNum(i, { email: e.target.value })} placeholder="Pulse user email" style={{ ...fld, width: 190 }} />
          <select value={n.entityId} onChange={(e) => setNum(i, { entityId: e.target.value })} style={{ ...fld, width: 190 }}>
            <option value="">(user’s default client)</option>
            {ents.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
          </select>
          <button onClick={() => delNum(i)} title="Remove" style={{ border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 13 }}>🗑</button>
        </div>
      ))}
      <button onClick={addNum} style={{ ...fld, cursor: 'pointer', marginTop: 2 }}>＋ Add number</button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
        <button onClick={save} disabled={busy} style={{ border: 'none', background: 'var(--brand)', color: '#fff', borderRadius: 8, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>{busy ? 'Saving…' : 'Save WhatsApp setup'}</button>
        {saved && <span style={{ fontSize: 12.5, color: '#34c759', fontWeight: 600 }}>Saved ✓</span>}
      </div>

      <div style={{ borderTop: '1px solid var(--hairline)', marginTop: 14, paddingTop: 12 }}>
        <span style={lbl}>Test connection (sends a WhatsApp now — confirms outbound before you wire the callback)</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="your number, e.g. 27XXXXXXXXX" style={{ ...fld, width: 230 }} />
          <button onClick={test} disabled={!testTo.trim()} style={{ ...fld, cursor: testTo.trim() ? 'pointer' : 'default' }}>Send test</button>
          {testMsg && <span style={{ fontSize: 12.5, color: testMsg.startsWith('✓') ? '#34c759' : 'var(--muted)' }}>{testMsg}</span>}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>Note: WhatsApp only allows a business-initiated message like this if that number has messaged you in the last 24h (or via an approved template). If it fails with a window/template error, that’s expected — the real flow is the customer messaging first.</div>
      </div>
    </div>
  );
}
