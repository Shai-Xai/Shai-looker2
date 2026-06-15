import { useState } from 'react';

// Reusable integrations editor for Looker + Anthropic credentials. Secrets are
// write-only: the form only knows whether a value is set (value.*.keySet /
// clientSecretSet); typing a new value changes it, blank leaves it unchanged.
// `onSave(payload)` receives only the fields that changed.
export default function IntegrationsForm({ value, onSave, showLooker = true, lookerActive = true, showResend = false, showInventive = false, onTestEmail, collapsible = false }) {
  const [baseUrl, setBaseUrl] = useState(value?.looker?.baseUrl || '');
  const [clientId, setClientId] = useState(value?.looker?.clientId || '');
  const [clientSecret, setClientSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [anthropicKey, setAnthropicKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [resendKey, setResendKey] = useState('');
  const [clearResendKey, setClearResendKey] = useState(false);
  const [mailFrom, setMailFrom] = useState(value?.resend?.from || '');
  const [invKey, setInvKey] = useState('');
  const [clearInvKey, setClearInvKey] = useState(false);
  const [invToken, setInvToken] = useState('');
  const [clearInvToken, setClearInvToken] = useState(false);
  const [invEndpoint, setInvEndpoint] = useState(value?.inventive?.endpoint || '');
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
      if (showInventive) {
        payload.inventive = { endpoint: invEndpoint };
        if (invKey) payload.inventive.apiKey = invKey;
        if (clearInvKey) payload.inventive.clearApiKey = true;
        if (invToken) payload.inventive.embedToken = invToken;
        if (clearInvToken) payload.inventive.clearEmbedToken = true;
      }
      await onSave(payload);
      setClientSecret(''); setAnthropicKey(''); setClearSecret(false); setClearKey(false);
      setResendKey(''); setClearResendKey(false);
      setInvKey(''); setInvToken(''); setClearInvKey(false); setClearInvToken(false);
      setSaved(true); setTimeout(() => setSaved(false), 1600);
    } catch (e) { alert('Save failed: ' + e.message); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Anthropic */}
      <Section title="🤖 Anthropic (AI insights)" collapsible={collapsible}>
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
      </Section>

      {/* Resend (email) — platform-level only */}
      {showResend && (
        <Section title="✉️ Email (Resend)" collapsible={collapsible}>
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
          {(value?.resend?.recent || []).length > 0 && (
            <>
              <Lbl>Recent sends</Lbl>
              <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {value.resend.recent.map((r, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span style={{ flexShrink: 0, fontWeight: 700, color: r.status === 'sent' ? 'var(--success, #10b981)' : r.status === 'failed' ? 'var(--error, #ef4444)' : 'var(--muted)' }}>
                      {r.status === 'sent' ? '✓ Sent' : r.status === 'failed' ? '✗ Failed' : '— Skipped'}
                    </span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <b>{r.recipient}</b> · {r.subject}
                      {r.status !== 'sent' && r.detail ? <span style={{ color: 'var(--error, #ef4444)' }}> — {r.detail}</span> : null}
                    </span>
                    <span style={{ flexShrink: 0, color: 'var(--muted)', fontSize: 11 }}>{new Date(r.at).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                ))}
              </div>
            </>
          )}
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
        </Section>
      )}

      {/* Inventive (embedded AI analyst) — platform-level, one account → per-client workspaces */}
      {showInventive && (
        <Section title="✨ Inventive (AI analyst)" collapsible={collapsible}>
          <div style={note}>
            Powers the <b>Ask</b> conversational analyst embedded per client. Set the API key + the embed auth token you generated for the host URL <code>{`${typeof window !== 'undefined' ? window.location.origin : ''}/ask`}</code>.
          </div>
          <Lbl>API key</Lbl>
          <input
            type="password" autoComplete="off"
            value={invKey} onChange={(e) => setInvKey(e.target.value)}
            placeholder={value?.inventive?.keySet ? `Set (${value.inventive.keyHint || '••••'}) — leave blank to keep` : (value?.inventive?.envFallback ? 'Using .env key — type to override' : 'Inventive API key')}
            style={input} disabled={clearInvKey}
          />
          {value?.inventive?.keySet && (
            <label style={clearRow}><input type="checkbox" checked={clearInvKey} onChange={(e) => setClearInvKey(e.target.checked)} /> Remove this key</label>
          )}
          <Lbl>Embed auth token</Lbl>
          <input
            type="password" autoComplete="off"
            value={invToken} onChange={(e) => setInvToken(e.target.value)}
            placeholder={value?.inventive?.tokenSet ? `Set (${value.inventive.tokenHint || '••••'}) — leave blank to keep` : 'Embed auth token (per host URL)'}
            style={input} disabled={clearInvToken}
          />
          {value?.inventive?.tokenSet && (
            <label style={clearRow}><input type="checkbox" checked={clearInvToken} onChange={(e) => setClearInvToken(e.target.checked)} /> Remove this token</label>
          )}
          <Lbl>API endpoint <span style={{ textTransform: 'none', fontWeight: 400 }}>· optional</span></Lbl>
          <input value={invEndpoint} onChange={(e) => setInvEndpoint(e.target.value)} placeholder="https://app-api.madeinventive.com" style={input} autoComplete="off" />
          {value?.inventive?.configured && <div style={{ ...note, color: 'var(--success, #10b981)', marginTop: 8 }}>✓ Connected — the Ask analyst is live.</div>}
        </Section>
      )}

      {/* Looker */}
      {showLooker && (
        <Section title="📊 Looker" collapsible={collapsible}>
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
        </Section>
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

// A card section that can optionally collapse (admin integrations starts each
// section collapsed so the long page is scannable).
function Section({ title, collapsible, children }) {
  const [open, setOpen] = useState(!collapsible);
  return (
    <section style={card}>
      {collapsible ? (
        <button type="button" onClick={() => setOpen((o) => !o)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', textAlign: 'left' }}>
          <span style={{ width: 12, fontSize: 10, color: 'var(--muted)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
          <span style={secTitle}>{title}</span>
        </button>
      ) : <div style={secTitle}>{title}</div>}
      {open && <div style={collapsible ? { marginTop: 10 } : undefined}>{children}</div>}
    </section>
  );
}

function Lbl({ children }) { return <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', margin: '12px 0 5px' }}>{children}</div>; }

const card = { background: 'var(--card)', border: '1px solid #e6e6e6', borderRadius: 12, padding: 18 };
const secTitle = { fontSize: 14, fontWeight: 700, marginBottom: 4 };
const input = { width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none' };
const note = { fontSize: 12, color: 'var(--muted)', background: '#f7f7f8', border: '1px solid var(--hairline)', borderRadius: 8, padding: '8px 10px', margin: '4px 0 4px' };
const clearRow = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--error, #ef4444)', marginTop: 6, cursor: 'pointer' };
const saveBtn = { padding: '9px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
