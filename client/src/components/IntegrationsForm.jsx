import { useState } from 'react';

// Reusable integrations editor for Looker + Anthropic credentials. Secrets are
// write-only: the form only knows whether a value is set (value.*.keySet /
// clientSecretSet); typing a new value changes it, blank leaves it unchanged.
// `onSave(payload)` receives only the fields that changed.
export default function IntegrationsForm({ value, onSave, showLooker = true, lookerActive = true }) {
  const [baseUrl, setBaseUrl] = useState(value?.looker?.baseUrl || '');
  const [clientId, setClientId] = useState(value?.looker?.clientId || '');
  const [clientSecret, setClientSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [anthropicKey, setAnthropicKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const secretSet = value?.looker?.clientSecretSet;
  const keySet = value?.anthropic?.keySet;
  const envLooker = value?.looker?.envFallback;
  const envKey = value?.anthropic?.envFallback;

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
      await onSave(payload);
      setClientSecret(''); setAnthropicKey(''); setClearSecret(false); setClearKey(false);
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

const card = { background: '#fff', border: '1px solid #e6e6e6', borderRadius: 12, padding: 18 };
const secTitle = { fontSize: 14, fontWeight: 700, marginBottom: 4 };
const input = { width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 13, outline: 'none' };
const note = { fontSize: 12, color: 'var(--muted)', background: '#f7f7f8', border: '1px solid #ececec', borderRadius: 8, padding: '8px 10px', margin: '4px 0 4px' };
const clearRow = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--error, #ef4444)', marginTop: 6, cursor: 'pointer' };
const saveBtn = { padding: '9px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
