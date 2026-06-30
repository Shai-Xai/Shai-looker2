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
  const [testText, setTestText] = useState('');
  const [testMsg, setTestMsg] = useState('');
  const [log, setLog] = useState(null);
  const [logBusy, setLogBusy] = useState(false);
  const loadLog = async () => {
    setLogBusy(true);
    try { const r = await api.owlWhatsappLog(); setLog(r.events || []); } catch { setLog([]); }
    setLogBusy(false);
  };
  // Send a test WhatsApp to `to` (with the optional custom message). Shared by the
  // bottom Test-connection box and the per-number Test buttons.
  const sendTest = async (to) => {
    if (!to || !to.trim()) return;
    setTestMsg(`Sending to ${to.trim()}…`);
    try {
      const r = await api.testOwlWhatsapp(to.trim(), testText.trim());
      if (r.ok) { setTestMsg(`✓ Sent to ${to.trim()} — check WhatsApp.`); return; }
      const e = r.error ?? r.reason;
      setTestMsg(`⚠ ${typeof e === 'string' ? e : JSON.stringify(e ?? r)}`);
    } catch (e) { setTestMsg(`⚠ ${(e && e.message) || 'failed'}`); }
  };
  const test = () => sendTest(testTo);

  useEffect(() => {
    api.owlWhatsapp().then((r) => { setCfg({ from: r.from || '', webhookPath: r.webhookPath, hasSecret: r.hasSecret, hasApiKey: r.hasApiKey, mediaEnabled: !!r.mediaEnabled, pushEnabled: !!r.pushEnabled, numbers: r.numbers || [] }); if (r.testMessage) setTestText(r.testMessage); }).catch(() => setCfg({ numbers: [] }));
    api.adminListEntities().then((r) => setEnts(Array.isArray(r) ? r : (r.entities || []))).catch(() => setEnts([]));
    loadLog();
  }, []);
  if (!cfg) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p>;

  const setNum = (i, patch) => setCfg((c) => ({ ...c, numbers: c.numbers.map((n, j) => (j === i ? { ...n, ...patch } : n)) }));
  const addNum = () => setCfg((c) => ({ ...c, numbers: [...c.numbers, { msisdn: '', email: '', entityId: '' }] }));
  const delNum = (i) => setCfg((c) => ({ ...c, numbers: c.numbers.filter((_, j) => j !== i) }));
  const save = async () => {
    setBusy(true);
    try { await api.saveOwlWhatsapp({ from: cfg.from, mediaEnabled: !!cfg.mediaEnabled, pushEnabled: !!cfg.pushEnabled, testMessage: testText, numbers: cfg.numbers.filter((n) => n.msisdn && n.email), ...(secret.trim() ? { secret: secret.trim() } : {}), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }); setSaved(true); setSecret(''); setApiKey(''); setTimeout(() => setSaved(false), 1800); } catch { /* ignore */ }
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

      <span style={lbl}>4 · Optional webhook secret {cfg.hasSecret ? '(SET — the webhook URL above already includes it)' : ''}</span>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={cfg.hasSecret ? '•••••• (unchanged)' : 'leave blank for no auth'} style={{ ...fld, width: 260 }} />
        {cfg.hasSecret && <button onClick={async () => { await api.saveOwlWhatsapp({ secret: '' }); const r = await api.owlWhatsapp(); setCfg((c) => ({ ...c, hasSecret: r.hasSecret, webhookPath: r.webhookPath })); }} style={{ ...fld, cursor: 'pointer' }}>Remove secret</button>}
      </div>
      {cfg.hasSecret && <div style={{ fontSize: 11.5, color: 'var(--warn, #b45309)', marginTop: 2 }}>A secret is set, so Clickatell must call the URL above (with <code>?key=…</code>). Re-copy the webhook URL into Clickatell, or remove the secret for the pilot.</div>}

      <span style={lbl}>5 · Linked numbers (which phone → which client)</span>
      {cfg.numbers.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--muted)', margin: '2px 0' }}>No numbers linked yet — add one below.</div>}
      {cfg.numbers.map((n, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
          <input value={n.msisdn} onChange={(e) => setNum(i, { msisdn: e.target.value })} placeholder="phone (27…)" style={{ ...fld, width: 130 }} />
          <input value={n.email} onChange={(e) => setNum(i, { email: e.target.value })} placeholder="Pulse user email" style={{ ...fld, width: 190 }} />
          <select value={n.entityId} onChange={(e) => setNum(i, { entityId: e.target.value })} style={{ ...fld, width: 190 }}>
            <option value="">(user’s default client)</option>
            {ents.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
          </select>
          <button onClick={() => delNum(i)} title="Remove" style={{ border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 13 }}>🗑</button>
          {/* Scheduled updates this number is subscribed to (only sent inside their 24h window). */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexBasis: '100%', paddingLeft: 4, marginTop: 1, marginBottom: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>scheduled:</span>
            {['digest', 'goals', 'alerts'].map((t) => (
              <label key={t} style={{ display: 'inline-flex', gap: 3, alignItems: 'center', fontSize: 12, cursor: 'pointer' }}>
                <input type="checkbox" checked={(n.subs || []).includes(t)} onChange={(e) => setNum(i, { subs: e.target.checked ? [...new Set([...(n.subs || []), t])] : (n.subs || []).filter((x) => x !== t) })} />
                {t}
              </label>
            ))}
            <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 4 }}>at</span>
            <select value={Number.isInteger(n.hour) ? n.hour : 8} onChange={(e) => setNum(i, { hour: Number(e.target.value) })} style={{ ...fld, padding: '3px 6px', fontSize: 12 }}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
            </select>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>SAST</span>
            <button onClick={() => sendTest(n.msisdn)} disabled={!n.msisdn} title="Send a test WhatsApp to this number (uses the custom message below if set)" style={{ ...fld, padding: '3px 9px', fontSize: 12, cursor: n.msisdn ? 'pointer' : 'default', marginLeft: 'auto' }}>✈ Test</button>
          </div>
        </div>
      ))}
      <button onClick={addNum} style={{ ...fld, cursor: 'pointer', marginTop: 2 }}>＋ Add number</button>

      <span style={lbl}>7 · Scheduled updates (digest / goals / alerts)</span>
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
        <input type="checkbox" checked={!!cfg.pushEnabled} onChange={(e) => setCfg((c) => ({ ...c, pushEnabled: e.target.checked }))} style={{ marginTop: 2 }} />
        <span>Send the scheduled updates ticked per number above. To stay within WhatsApp’s rules, an update is only sent if that customer messaged the Owl in the <strong>last 24 hours</strong> (their free-form window). Numbers outside the window are skipped that day — reaching everyone on a fixed schedule needs an approved WhatsApp template.</span>
      </label>

      <span style={lbl}>6 · Chart images</span>
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
        <input type="checkbox" checked={!!cfg.mediaEnabled} onChange={(e) => setCfg((c) => ({ ...c, mediaEnabled: e.target.checked }))} style={{ marginTop: 2 }} />
        <span>Send charts as <strong>inline images</strong> (instead of a link). Only turn this on <strong>after Clickatell enables media upload</strong> on this WhatsApp integration — otherwise it 404s and falls back to a link anyway. Default off = customers get a tappable chart link.</span>
      </label>

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
        <input value={testText} onChange={(e) => setTestText(e.target.value)} placeholder="Optional custom message — used by Send test + the ✈ Test buttons; saved with “Save WhatsApp setup”." style={{ ...fld, width: '100%', maxWidth: 480, marginTop: 6 }} />
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>Note: WhatsApp only allows a business-initiated message like this if that number has messaged you in the last 24h (or via an approved template). If it fails with a window/template error, that’s expected — the real flow is the customer messaging first.</div>
      </div>

      <div style={{ borderTop: '1px solid var(--hairline)', marginTop: 14, paddingTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ ...lbl, margin: 0 }}>Recent inbound (last 40 webhook hits)</span>
          <button onClick={loadLog} disabled={logBusy} style={{ ...fld, cursor: logBusy ? 'default' : 'pointer', padding: '3px 9px', fontSize: 12 }}>{logBusy ? '…' : '↻ Refresh'}</button>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', margin: '4px 0 8px' }}>If your real WhatsApp messages don’t appear here at all, Clickatell isn’t delivering them — re-check the <strong>Reply Callbacks</strong> URL (step 1) is saved. If they appear but stop at <em>unparsed</em>, <em>no-account</em> or <em>rejected</em>, that tells us exactly what to fix.</div>
        {log === null ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Loading…</div>
        ) : log.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No webhook activity recorded yet. Send a WhatsApp to the number, then hit Refresh.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {log.map((e, i) => (
              <div key={i} style={{ fontSize: 12, padding: '5px 7px', borderRadius: 6, background: 'var(--card)', border: '1px solid var(--hairline)' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span style={{ ...stageBadge(e.stage) }}>{e.stage}</span>
                  <span style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{(e.created_at || '').slice(5, 16).replace('T', ' ')}</span>
                  {e.msisdn && <span style={{ color: 'var(--text)', whiteSpace: 'nowrap' }}>{e.msisdn}</span>}
                </div>
                {e.detail && <div style={{ color: 'var(--muted)', marginTop: 3, wordBreak: 'break-word', fontFamily: e.stage === 'unparsed' ? 'ui-monospace, monospace' : 'inherit', fontSize: e.stage === 'unparsed' ? 11 : 12 }}>{e.detail}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Colour the stage chip so the happy path (received → identified → replied) reads green
// and the stop-points (rejected / unparsed / no-account / send-failed) read amber/red.
function stageBadge(stage) {
  const ok = stage === 'received' || stage === 'identified' || stage === 'replied' || stage === 'image-sent' || stage === 'image-link' || stage === 'followups-buttons' || stage === 'push-sent';
  const bad = stage === 'rejected' || stage === 'send-failed' || stage === 'error' || stage === 'no-ai-key' || stage === 'image-failed' || stage === 'push-failed';
  const c = ok ? '#34c759' : bad ? '#ef4444' : '#b45309';
  return { fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: c, background: `${c}1a`, padding: '2px 6px', borderRadius: 5, whiteSpace: 'nowrap', minWidth: 64, textAlign: 'center' };
}
