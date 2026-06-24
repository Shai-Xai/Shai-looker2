import { useState } from 'react';

// Reusable integrations editor for Looker + Anthropic credentials. Secrets are
// write-only: the form only knows whether a value is set (value.*.keySet /
// clientSecretSet); typing a new value changes it, blank leaves it unchanged.
// `onSave(payload)` receives only the fields that changed.
export default function IntegrationsForm({ value, onSave, showLooker = true, lookerActive = true, showResend = false, showInventive = false, inventiveWorkspace = null, showMeta = false, showTikTok = false, clients = [], onTestEmail, collapsible = false, canManageLock = false, locks = {}, onToggleLock, lockableKeys = [] }) {
  // Each integration is FROZEN by default — fields are read-only until an
  // admin/Owner (canManageLock) explicitly unlocks it, then re-locks. A guard
  // against accidental changes to a working connection. A section reads as locked
  // unless its lock is stored explicitly as `false`.
  // `lockableKeys` scopes which sections are freezable on THIS surface (per-client
  // vs platform), so e.g. the per-client Inventive workspace map gets no toggle.
  const lockProps = (key) => (lockableKeys.includes(key) ? { lockKey: key, locked: locks?.[key] !== false, canManageLock, onToggleLock } : {});
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
  // Per-client Inventive workspace mapping (entity fields, saved by the parent).
  const [invwName, setInvwName] = useState(inventiveWorkspace?.name || '');
  const [invwRef, setInvwRef] = useState(inventiveWorkspace?.refId || '');
  const [metaToken, setMetaToken] = useState('');
  const [clearMetaToken, setClearMetaToken] = useState(false);
  const [metaAdAccount, setMetaAdAccount] = useState(value?.meta?.adAccountId || '');
  const [metaBusiness, setMetaBusiness] = useState(value?.meta?.businessId || '');
  const [ttToken, setTtToken] = useState('');
  const [clearTtToken, setClearTtToken] = useState(false);
  const [ttAdvertiser, setTtAdvertiser] = useState(value?.tiktok?.advertiserId || '');
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
      if (inventiveWorkspace) payload.inventiveWorkspace = { name: invwName, refId: invwRef };
      if (showMeta) {
        payload.meta = { adAccountId: metaAdAccount, businessId: metaBusiness };
        if (metaToken) payload.meta.accessToken = metaToken;
        if (clearMetaToken) payload.meta.clearAccessToken = true;
      }
      if (showTikTok) {
        payload.tiktok = { advertiserId: ttAdvertiser };
        if (ttToken) payload.tiktok.accessToken = ttToken;
        if (clearTtToken) payload.tiktok.clearAccessToken = true;
      }
      await onSave(payload);
      setClientSecret(''); setAnthropicKey(''); setClearSecret(false); setClearKey(false);
      setResendKey(''); setClearResendKey(false);
      setInvKey(''); setInvToken(''); setClearInvKey(false); setClearInvToken(false);
      setMetaToken(''); setClearMetaToken(false);
      setTtToken(''); setClearTtToken(false);
      setSaved(true); setTimeout(() => setSaved(false), 1600);
    } catch (e) { alert('Save failed: ' + e.message); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Anthropic */}
      <Section title="🤖 Anthropic (AI insights)" collapsible={collapsible} {...lockProps('anthropic')}>
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

      {/* Meta (FB/IG) — per-client audience sync */}
      {showMeta && (
        <Section title="◇ Meta (Facebook / Instagram)" collapsible={collapsible} {...lockProps('meta')} guide={<>
          <div style={note}>
            Push a <b>segment</b> to a Meta <b>Custom Audience</b> for ad targeting or exclusion. Emails/phones are hashed before they leave Pulse. Use a system-user / long-lived token with <code>ads_management</code>.
          </div>
          <HowTo title="How to get your Meta access details" steps={[
            <>Open <b>Meta Business Settings</b> → <b>Users → System users</b>. Create (or pick) a system user with <b>Admin</b> access.</>,
            <>Under <b>Assigned assets</b>, add your <b>Ad account</b> and grant <b>Manage campaigns</b> (full) control.</>,
            <>Click <b>Generate new token</b>, choose your app, and tick the <code>ads_management</code> scope (add <code>business_management</code> too). Pick a long-lived / non-expiring token and copy it into <b>Access token</b> above.</>,
            <>Find your <b>Ad account ID</b> in <b>Ads Manager</b> — the <code>act_…</code> number in the account dropdown (top-left). Paste the digits as <code>act_1234567890</code>.</>,
            <><b>Business ID</b> (optional) lives in <b>Business Settings → Business info</b>.</>,
          ]} />
        </>}>
          <Lbl>Access token</Lbl>
          <input
            type="password" autoComplete="off"
            value={metaToken} onChange={(e) => setMetaToken(e.target.value)}
            placeholder={value?.meta?.tokenSet ? `Set (${value.meta.tokenHint || '••••'}) — leave blank to keep` : 'Meta access token'}
            style={input} disabled={clearMetaToken}
          />
          {value?.meta?.tokenSet && (
            <label style={clearRow}><input type="checkbox" checked={clearMetaToken} onChange={(e) => setClearMetaToken(e.target.checked)} /> Remove this token</label>
          )}
          <Lbl>Ad account ID</Lbl>
          <input value={metaAdAccount} onChange={(e) => setMetaAdAccount(e.target.value)} placeholder="act_1234567890" style={input} autoComplete="off" />
          <Lbl>Business ID <span style={{ textTransform: 'none', fontWeight: 400 }}>· optional</span></Lbl>
          <input value={metaBusiness} onChange={(e) => setMetaBusiness(e.target.value)} placeholder="Meta Business Manager ID" style={input} autoComplete="off" />
          {value?.meta?.tokenSet && value?.meta?.adAccountId && <div style={{ ...note, color: 'var(--success, #10b981)', marginTop: 8 }}>✓ Connected — sync segments from Engage → Segments.</div>}
        </Section>
      )}

      {/* TikTok — per-client audience sync */}
      {showTikTok && (
        <Section title="♪ TikTok" collapsible={collapsible} {...lockProps('tiktok')} guide={<>
          <div style={note}>
            Push a <b>segment</b> to a TikTok <b>Custom Audience</b> for ad targeting. Emails/phones are hashed before they leave Pulse. Use an access token with audience (DMP) scope and the advertiser ID the audience should live under.
          </div>
          <HowTo title="How to get your TikTok access details" steps={[
            <>In <b>TikTok Ads Manager</b>, open <b>Assets → Audiences</b> to confirm you have a Custom Audience (DMP) enabled advertiser account. If not, ask your TikTok rep to enable it.</>,
            <>Go to the <b>TikTok for Business Developers</b> portal and create an app under <b>Marketing API</b> (or use your agency's app). Add the <b>Audience / DMP</b> scope.</>,
            <>Authorise the app for your advertiser account, then generate a <b>long-lived access token</b>. Copy it into <b>Access token</b> above.</>,
            <>Find your <b>Advertiser ID</b> in Ads Manager — the account dropdown (top-right), or the <code>advertiser_id</code> in the page URL. Paste it into <b>Advertiser ID</b>.</>,
          ]} />
        </>}>
          <Lbl>Access token</Lbl>
          <input
            type="password" autoComplete="off"
            value={ttToken} onChange={(e) => setTtToken(e.target.value)}
            placeholder={value?.tiktok?.tokenSet ? `Set (${value.tiktok.tokenHint || '••••'}) — leave blank to keep` : 'TikTok access token'}
            style={input} disabled={clearTtToken}
          />
          {value?.tiktok?.tokenSet && (
            <label style={clearRow}><input type="checkbox" checked={clearTtToken} onChange={(e) => setClearTtToken(e.target.checked)} /> Remove this token</label>
          )}
          <Lbl>Advertiser ID</Lbl>
          <input value={ttAdvertiser} onChange={(e) => setTtAdvertiser(e.target.value)} placeholder="TikTok advertiser ID" style={input} autoComplete="off" />
          {value?.tiktok?.tokenSet && value?.tiktok?.advertiserId && <div style={{ ...note, color: 'var(--success, #10b981)', marginTop: 8 }}>✓ Connected — sync segments from Engage → Segments.</div>}
        </Section>
      )}

      {/* Resend (email) — platform-level only */}
      {showResend && (
        <Section title="✉️ Email (Resend)" collapsible={collapsible} {...lockProps('resend')}>
          {/* Emergency brake: instantly no-ops ALL outbound email (every client,
              every campaign/digest/notification) without touching Resend keys. */}
          <div style={{ border: `1.5px solid ${value?.resend?.enabled === false ? 'var(--error,#ef4444)' : 'var(--hairline)'}`, background: value?.resend?.enabled === false ? 'rgba(239,68,68,0.08)' : 'transparent', borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
              <input type="checkbox" checked={value?.resend?.enabled === false} onChange={(e) => onSave({ resend: { enabled: !e.target.checked } })} />
              ⏸ Pause ALL outbound email (emergency stop)
            </label>
            <div style={{ fontSize: 12, color: value?.resend?.enabled === false ? 'var(--error,#ef4444)' : 'var(--muted)', marginTop: 4 }}>
              {value?.resend?.enabled === false ? '⛔ Email is OFF — nothing is being sent. Untick to resume.' : 'Takes effect immediately, across all clients. Already-sent emails can’t be recalled.'}
            </div>
          </div>
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
      {(showInventive || inventiveWorkspace) && (
        <Section title="✨ Inventive (AI analyst)" collapsible={collapsible} {...lockProps('inventive')}>
          {inventiveWorkspace && (
            <>
              <div style={note}>How this client maps to its Inventive workspace. Blank fields inherit the client's own details.</div>
              <Lbl>Account name</Lbl>
              <input value={invwName} onChange={(e) => setInvwName(e.target.value)} placeholder="Use client name" style={input} autoComplete="off" />
              <Lbl>External reference (UUID)</Lbl>
              <div style={note}>The <code>externalRefId</code> we send Inventive. Leave blank to use this client's own ID (the default): <code style={{ userSelect: 'all' }}>{inventiveWorkspace.defaultRefId}</code>. Only set it to match a workspace provisioned under a different reference.</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input value={invwRef} onChange={(e) => setInvwRef(e.target.value)} placeholder={inventiveWorkspace.defaultRefId} style={{ ...input, fontFamily: 'monospace', fontSize: 12 }} autoComplete="off" />
                <button type="button" style={{ flexShrink: 0, padding: '8px 12px', fontSize: 12, fontWeight: 600, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 980, cursor: 'pointer' }} onClick={() => { navigator.clipboard?.writeText((invwRef || '').trim() || inventiveWorkspace.defaultRefId).catch(() => {}); }} title="Copy the externalRefId we send Inventive">Copy</button>
              </div>
            </>
          )}
          {showInventive && (<>
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
          </>)}
        </Section>
      )}

      {/* Looker */}
      {showLooker && (
        <Section title="📊 Looker" collapsible={collapsible} {...lockProps('looker')}>
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
// A card section that can optionally collapse, and optionally be FROZEN (a
// per-integration lock). When `lockKey` is set the header carries a lock toggle
// (visible to admins/owners) and, while locked, the section's fields are disabled.
function Section({ title, collapsible, children, guide, lockKey, locked = false, canManageLock = false, onToggleLock }) {
  const [open, setOpen] = useState(!collapsible);
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    if (!onToggleLock || busy) return;
    setBusy(true);
    try { await onToggleLock(lockKey, !locked); } finally { setBusy(false); }
  };
  const lockable = !!lockKey;
  return (
    <section style={{ ...card, ...(locked ? { borderColor: 'var(--hairline)', background: 'rgba(128,128,128,0.04)' } : null) }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {collapsible ? (
          <button type="button" onClick={() => setOpen((o) => !o)} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', textAlign: 'left' }}>
            <span style={{ width: 12, fontSize: 10, color: 'var(--muted)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
            <span style={secTitle}>{title}</span>
          </button>
        ) : <div style={{ ...secTitle, flex: 1, minWidth: 0 }}>{title}</div>}
        {lockable && locked && <span title="This integration is locked" style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>🔒 Locked</span>}
        {lockable && canManageLock && (
          <button type="button" onClick={toggle} disabled={busy}
            title={locked ? 'Unlock to edit this integration' : 'Lock this integration to prevent edits'}
            style={{ flexShrink: 0, border: `1px solid ${locked ? 'var(--brand)' : 'var(--hairline)'}`, background: 'var(--card)', color: locked ? 'var(--brand)' : 'var(--muted)', borderRadius: 980, fontSize: 12, fontWeight: 700, padding: '4px 11px', cursor: 'pointer' }}>
            {busy ? '…' : locked ? '🔓 Unlock' : '🔒 Lock'}
          </button>
        )}
      </div>
      {open && (
        <>
          {/* Help/guide content stays OUTSIDE the disabled fieldset so it's always
              readable and expandable, even when the integration is locked. */}
          {guide && <div style={{ marginTop: collapsible ? 10 : 8 }}>{guide}</div>}
          <fieldset disabled={lockable && locked} style={{ border: 'none', margin: 0, padding: 0, minInlineSize: 'auto', marginTop: guide ? 6 : (collapsible ? 10 : 0), opacity: lockable && locked ? 0.6 : 1 }}>
            {children}
          </fieldset>
        </>
      )}
    </section>
  );
}

function Lbl({ children }) { return <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', margin: '12px 0 5px' }}>{children}</div>; }

// Collapsible "how to get your access details" — closed by default so it never
// clutters the form, but a step-by-step is one tap away when a client is stuck.
function HowTo({ title, steps = [] }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 8, margin: '4px 0 6px', overflow: 'hidden' }}>
      <button type="button" onClick={() => setOpen((o) => !o)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '9px 11px', background: 'rgba(128,128,128,0.05)', border: 'none', cursor: 'pointer', font: 'inherit', textAlign: 'left' }}>
        <span style={{ fontSize: 13 }}>💡</span>
        <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1, color: 'var(--text)' }}>{title}</span>
        <span style={{ width: 12, fontSize: 10, color: 'var(--muted)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
      </button>
      {open && (
        <ol style={{ margin: 0, padding: '10px 12px 10px 28px', display: 'flex', flexDirection: 'column', gap: 7, fontSize: 12.5, color: 'var(--text)', lineHeight: 1.5 }}>
          {steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      )}
    </div>
  );
}

const card = { background: 'var(--card)', border: '1px solid #e6e6e6', borderRadius: 12, padding: 18 };
const secTitle = { fontSize: 14, fontWeight: 700, marginBottom: 4 };
const input = { width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none' };
const note = { fontSize: 12, color: 'var(--muted)', background: '#f7f7f8', border: '1px solid var(--hairline)', borderRadius: 8, padding: '8px 10px', margin: '4px 0 4px' };
const clearRow = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--error, #ef4444)', marginTop: 6, cursor: 'pointer' };
const saveBtn = { padding: '9px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
