import { useState } from 'react';

// Reusable integrations editor for Looker + Anthropic credentials. Secrets are
// write-only: the form only knows whether a value is set (value.*.keySet /
// clientSecretSet); typing a new value changes it, blank leaves it unchanged.
// `onSave(payload)` receives only the fields that changed.
export default function IntegrationsForm({ value, onSave, showLooker = true, lookerActive = true, showResend = false, onTestEmail }) {
  const [baseUrl, setBaseUrl] = useState(value?.looker?.baseUrl || '');
  const [clientId, setClientId] = useState(value?.looker?.clientId || '');
  const [clientSecret, setClientSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [anthropicKey, setAnthropicKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [resendKey, setResendKey] = useState('');
  const [clearResendKey, setClearResendKey] = useState(false);
  const [mailFrom, setMailFrom] = useState(value?.resend?.from || '');
  const [testState, setTestState] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const secretSet = value?.looker?.clientSecretSet;
  const keySet = value?.anthropic?.keySet;
  const envLooker = value?.looker?.envFallback;
  const envKey = value?.anthropic?.envFallback;
  const resendSet = value?.resend?.keySet;
  const envResend = value?.resend?.envFallback;

  async function save() {
    setBusy(true);
    try {
      const payload = { looker: {}, anthropic: {} };
      if (showLooker) {
        payload.looker.baseUrl = baseUrl;
        payload.looker.clientId = clientId;
        if (clientSecret) payload.looker.clientSecret = clientSecret;
        if (clearSecret) payload.looker.clearClientSecret = true;
      }
      if (anthropicKey) payload.anthropic.apiKey = anthropicKey;
      if (clearKey) payload.anthropic.clearApiKey = true;
      if (showResend) {
        payload.resend = { from: mailFrom };
        if (resendKey) payload.resend.apiKey = resendKey;
        if (clearResendKey) payload.resend.clearApiKey = true;
      }
      await onSave(payload);
      setClientSecret(''); setAnthropicKey(''); setClearSecret(false); setClearKey(false);
      setResendKey(''); setClearResendKey(false);
      setSaved(true); setTimeout(() => setSaved(false), 1600);
    } catch (e) { alert('Save failed: ' + e.message); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Anthropic */}
      <section style={card}>
        <div style={secTitle}>🤖 Anthropic (AI insights)</div>
        <Lbl>API key</Lbl>
        <input
          type="password"
          autoComplete="off"
          value={anthropicKey}
          onChange={(e) => setAnthropicKey(e.target.value)}
          placeholder={keySet ? `Set (${value.anthropic.keyHint || '••••'}) — leave blank to keep` : (envKey ? 'Using .env key — type to override' : 'sk-ant-…')}
          style={input}
          disabled={clearKey}
        />
        {keySet && (
          <label style={clearRow}>
            <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} /> Remove this key
          </label>
        )}
      </section>

      {/* Resend (email) — platform-level only */}
      {showResend && (
        <section style={card}>
          <div style={secTitle}>✉️ Email (Resend)</div>
          <div style={note}>
            Powers outbound notifications — must-acknowledge messages and Howler replies email the client's logins with a link back into Pulse.
            Until your domain is verified in Resend, the default sender <code>onboarding@resend.dev</code> can only deliver to your own Resend account email.
          </div>
          <Lbl>API key</Lbl>
          <input
            type="password"
            autoComplete="off"
            value={resendKey}
            onChange={(e) => setResendKey(e.target.value)}
            placeholder={resendSet ? `Set (${value.resend.keyHint || '••••'}) — leave blank to keep` : (envResend ? 'Using .env key — type to override' : 're_…')}
            style={input}
            disabled={clearResendKey}
          />
          {resendSet && (
            <label style={clearRow}>
              <input type="checkbox" checked={clearResendKey} onChange={(e) => setClearResendKey(e.target.checked)} /> Remove this key
            </label>
          )}
          <Lbl>From address</Lbl>
          <input
            value={mailFrom}
            onChange={(e) => setMailFrom(e.target.value)}
            placeholder="Howler Pulse <pulse@updates.howler.co.za>"
            style={input}
            autoComplete="off"
          />
          {value?.resend?.lastError && <div style={{ ...note, color: 'var(--error, #ef4444)', marginTop: 8 }}>Last send failed: {value.resend.lastError}</div>}
          {onTestEmail && value?.resend?.configured && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
              <button
                type="button"
                style={{ ...saveBtn, background: 'rgba(128,128,128,0.14)', color: 'var(--text)' }}
                disabled={testState === 'sending'}
                onClick={async () => {
                  setTestState('sending');
                  try { const r = await onTestEmail(); setTestState(`✓ Sent to ${r.to}`); }
                  catch (e) { setTestState(`✗ ${e.message}`); }
                }}
              >{testState === 'sending' ? 'Sending…' : 'Send me a test email'}</button>
              {testState && testState !== 'sending' && <span style={{ fontSize: 12.5, color: testState.startsWith('✓') ? 'var(--success, #10b981)' : 'var(--error, #ef4444)' }}>{testState}</span>}
            </div>
          )}
        </section>
      )}

      {/* Looker */}
      {showLooker && (
        <section style={card}>
          <div style={secTitle}>📊 Looker</div>
          {!lookerActive && (
            <div style={note}>Per-client Looker isn't active yet — the primary (admin) Looker account is used for now. Your settings here are saved for when it's enabled.</div>
          )}
          <Lbl>Base URL</Lbl>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={envLooker ? 'Using .env — type to override' : 'https://yourco.cloud.looker.com'} style={input} />
          <Lbl>Client ID</Lbl>
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Looker API3 client id" style={input} autoComplete="off" />
          <Lbl>Client secret</Lbl>
          <input
            type="password"
            autoComplete="off"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={secretSet ? 'Set — leave blank to keep' : 'Looker API3 client secret'}
            style={input}
            disabled={clearSecret}
          />
          {secretSet && (
            <label style={clearRow}>
              <input type="checkbox" checked={clearSecret} onChange={(e) => setClearSecret(e.target.checked)} /> Remove this secret
            </label>
          )}
        </section>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button style={saveBtn} onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        {saved && (
          <span className="saved-chip" style={{ color: 'var(--success, #10b981)', fontSize: 13, fontWeight: 600 }}>
            <svg className="check-anim" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
            Saved
          </span>
        )}
      </div>
    </div>
  );
}

function Lbl({ children }) { return <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', margin: '12px 0 5px' }}>{children}</div>; }

const card = { background: 'var(--card)', border: '1px solid #e6e6e6', borderRadius: 12, padding: 18 };
const secTitle = { fontSize: 14, fontWeight: 700, marginBottom: 4 };
const input = { width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none' };
const note = { fontSize: 12, color: 'var(--muted)', background: '#f7f7f8', border: '1px solid var(--hairline)', borderRadius: 8, padding: '8px 10px', margin: '4px 0 4px' };
const clearRow = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--error, #ef4444)', marginTop: 6, cursor: 'pointer' };
const saveBtn = { padding: '9px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
