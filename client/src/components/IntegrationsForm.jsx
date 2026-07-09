import { useEffect, useState } from 'react';

// Reusable integrations editor for Looker + Anthropic credentials. Secrets are
// write-only: the form only knows whether a value is set (value.*.keySet /
// clientSecretSet); typing a new value changes it, blank leaves it unchanged.
// `onSave(payload)` receives only the fields that changed.
export default function IntegrationsForm({ value, onSave, showLooker = true, lookerActive = true, showResend = false, showInventive = false, inventiveWorkspace = null, showMeta = false, showTikTok = false, showSlack = false, showChottu = false, showQueueit = false, showPixel = false, pixelEntityId = '', onPixelStatus, onCreatePixelAudiences, clients = [], onTestEmail, onTestSlack, collapsible = false, canManageLock = false, locks = {}, onToggleLock, lockableKeys = [] }) {
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
  const [resendWebhookSecret, setResendWebhookSecret] = useState('');
  const [clearResendWebhookSecret, setClearResendWebhookSecret] = useState(false);
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
  // Organic-insights assets (inbound social metrics): the Page / IG account we read.
  const [metaPageId, setMetaPageId] = useState(value?.meta?.pageId || '');
  const [metaIgUserId, setMetaIgUserId] = useState(value?.meta?.igUserId || '');
  const [pxMeta, setPxMeta] = useState(value?.pixel?.metaPixelId || '');
  const [pxGoogle, setPxGoogle] = useState(value?.pixel?.googleTagId || '');
  const [pxTiktok, setPxTiktok] = useState(value?.pixel?.tiktokPixelId || '');
  const [pxConsent, setPxConsent] = useState(value?.pixel?.consentMode || 'auto');
  const [ttToken, setTtToken] = useState('');
  const [clearTtToken, setClearTtToken] = useState(false);
  const [ttAdvertiser, setTtAdvertiser] = useState(value?.tiktok?.advertiserId || '');
  const [slackWebhook, setSlackWebhook] = useState('');
  const [clearSlackWebhook, setClearSlackWebhook] = useState(false);
  const [slackBotToken, setSlackBotToken] = useState('');
  const [clearSlackBot, setClearSlackBot] = useState(false);
  const [slackChannel, setSlackChannel] = useState(value?.slack?.channel || '');
  const [chottuKey, setChottuKey] = useState('');
  const [clearChottuKey, setClearChottuKey] = useState(false);
  const [chottuDomain, setChottuDomain] = useState(value?.chottu?.domain || '');
  const [qitCustomerId, setQitCustomerId] = useState(value?.queueit?.customerId || '');
  const [qitKey, setQitKey] = useState('');
  const [clearQitKey, setClearQitKey] = useState(false);
  const [pxStatus, setPxStatus] = useState(null);   // install check result (GET pixel/status)
  const [pxCopied, setPxCopied] = useState(false);
  const [pxPack, setPxPack] = useState({});         // channel -> result message
  const [testState, setTestState] = useState('');
  const [slackTestState, setSlackTestState] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [savedKey, setSavedKey] = useState('');

  const secretSet = value?.looker?.clientSecretSet;
  const keySet = value?.anthropic?.keySet;
  const envLooker = value?.looker?.envFallback;
  const envKey = value?.anthropic?.envFallback;
  const resendSet = value?.resend?.keySet;
  const envResend = value?.resend?.envFallback;

  // Build just the slice for one section (or all if `only` is falsy). The backend
  // merges partial payloads, so a per-card save only sends its own integration.
  function buildPayload(only) {
    const want = (k) => !only || only === k;
    const p = {};
    if (showLooker && want('looker')) {
      p.looker = { baseUrl, clientId };
      if (clientSecret) p.looker.clientSecret = clientSecret;
      if (clearSecret) p.looker.clearClientSecret = true;
    }
    if (want('anthropic')) {
      p.anthropic = {};
      if (anthropicKey) p.anthropic.apiKey = anthropicKey;
      if (clearKey) p.anthropic.clearApiKey = true;
    }
    if (showResend && want('resend')) {
      p.resend = { from: mailFrom };
      if (resendKey) p.resend.apiKey = resendKey;
      if (clearResendKey) p.resend.clearApiKey = true;
      if (resendWebhookSecret) p.resend.webhookSecret = resendWebhookSecret;
      if (clearResendWebhookSecret) p.resend.clearWebhookSecret = true;
    }
    if (showInventive && want('inventive')) {
      p.inventive = { endpoint: invEndpoint };
      if (invKey) p.inventive.apiKey = invKey;
      if (clearInvKey) p.inventive.clearApiKey = true;
      if (invToken) p.inventive.embedToken = invToken;
      if (clearInvToken) p.inventive.clearEmbedToken = true;
    }
    if (inventiveWorkspace && want('inventive')) p.inventiveWorkspace = { name: invwName, refId: invwRef };
    if (showMeta && want('meta')) {
      p.meta = { adAccountId: metaAdAccount, businessId: metaBusiness, pageId: metaPageId, igUserId: metaIgUserId };
      if (metaToken) p.meta.accessToken = metaToken;
      if (clearMetaToken) p.meta.clearAccessToken = true;
    }
    if (showTikTok && want('tiktok')) {
      p.tiktok = { advertiserId: ttAdvertiser };
      if (ttToken) p.tiktok.accessToken = ttToken;
      if (clearTtToken) p.tiktok.clearAccessToken = true;
    }
    if (showPixel && want('pixel')) {
      p.pixel = { metaPixelId: pxMeta, googleTagId: pxGoogle, tiktokPixelId: pxTiktok, consentMode: pxConsent };
    }
    if (showSlack && want('slack')) {
      p.slack = { channel: slackChannel };
      if (slackWebhook) p.slack.webhookUrl = slackWebhook;
      if (clearSlackWebhook) p.slack.clearWebhookUrl = true;
      if (slackBotToken) p.slack.botToken = slackBotToken;
      if (clearSlackBot) p.slack.clearBotToken = true;
    }
    if (showChottu && want('chottu')) {
      p.chottu = { domain: chottuDomain };
      if (chottuKey) p.chottu.apiKey = chottuKey;
      if (clearChottuKey) p.chottu.clearApiKey = true;
    }
    if (showQueueit && want('queueit')) {
      p.queueit = { customerId: qitCustomerId };
      if (qitKey) p.queueit.apiKey = qitKey;
      if (clearQitKey) p.queueit.clearApiKey = true;
    }
    return p;
  }

  async function save(only) {
    setBusyKey(only || 'all');
    try {
      await onSave(buildPayload(only));
      // Clear the transient (write-only) inputs for whatever we just saved.
      if (!only || only === 'looker') { setClientSecret(''); setClearSecret(false); }
      if (!only || only === 'anthropic') { setAnthropicKey(''); setClearKey(false); }
      if (!only || only === 'resend') { setResendKey(''); setClearResendKey(false); setResendWebhookSecret(''); setClearResendWebhookSecret(false); }
      if (!only || only === 'inventive') { setInvKey(''); setInvToken(''); setClearInvKey(false); setClearInvToken(false); }
      if (!only || only === 'meta') { setMetaToken(''); setClearMetaToken(false); }
      if (!only || only === 'tiktok') { setTtToken(''); setClearTtToken(false); }
      if (!only || only === 'slack') { setSlackWebhook(''); setSlackBotToken(''); setClearSlackWebhook(false); setClearSlackBot(false); }
      if (!only || only === 'chottu') { setChottuKey(''); setClearChottuKey(false); }
      if (!only || only === 'queueit') { setQitKey(''); setClearQitKey(false); }
      setSavedKey(only || 'all'); setTimeout(() => setSavedKey(''), 1600);
    } catch (e) { alert('Save failed: ' + e.message); }
    finally { setBusyKey(''); }
  }

  // Per-card save row — lives at the bottom of each integration card.
  const SaveRow = ({ k }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
      <button type="button" style={saveBtn} onClick={() => save(k)} disabled={busyKey === k}>{busyKey === k ? 'Saving…' : 'Save'}</button>
      {savedKey === k && (
        <span className="saved-chip" style={{ color: 'var(--success, #10b981)', fontSize: 13, fontWeight: 600 }}>
          <svg className="check-anim" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
          Saved
        </span>
      )}
    </div>
  );

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
        <SaveRow k="anthropic" />
      </Section>

      {/* Meta (FB/IG) — per-client audience sync */}
      {showMeta && (
        <Section title="◇ Meta (Facebook / Instagram)" collapsible={collapsible} {...lockProps('meta')} guide={<>
          <div style={note}>
            Connect Meta once and Pulse can push <b>segments</b> to Meta <b>Custom Audiences</b> (ad targeting/exclusion) and pull in your <b>paid-ads performance</b>. Emails/phones are hashed before they leave Pulse.
            {' '}<b>Easiest way:</b> if a <b>📘 Continue with Facebook</b> button appears below this card, use that — one login, nothing to copy. The fields here are the manual (fallback) path.
          </div>
          <HowTo title="Manual setup, step by step — no tech skills needed (±10 min)" steps={[
            <>Sign in to <ExtLink href="https://business.facebook.com/settings">Meta Business settings</ExtLink> with the Facebook login that manages your ads. You need <b>Admin</b> access to the business portfolio (if you don't have it, ask whoever set up your Facebook ads).</>,
            <><b>One-time check — your business needs an “app”.</b> In the left menu open <b>Accounts → Apps</b>. If the list is empty, create one (it's just a container Meta requires — you're not building anything): open <ExtLink href="https://developers.facebook.com/apps">developers.facebook.com/apps</ExtLink> → <b>Create app</b> → pick the <b>Business</b> type → name it e.g. “Pulse” → link it to your business portfolio when asked → Create. <i>This is the fix when Meta blocks the token button with “an app must be part of this business portfolio. Please add an app.”</i></>,
            <>Back in <b>Business settings</b>, go to <b>Users → System users</b> → <b>Add</b> → name it <code>pulse</code>, role <b>Admin</b>. (A system user is a “robot” login the token belongs to — it keeps working even if a staff member leaves.)</>,
            <>Still on that system user: <b>Add assets → Ad accounts</b> → tick your ad account → switch on <b>Manage campaigns</b> → Save.</>,
            <>Click <b>Generate new token</b> → choose the app from step 2 → expiration <b>Never</b> → tick <code>ads_read</code> and <code>ads_management</code> (plus <code>business_management</code> if listed) → <b>Generate</b>. <b>Copy the token straight away</b> — Meta shows it only once — and paste it into <b>Access token</b> above.</>,
            <><b>Ad account ID:</b> open <ExtLink href="https://adsmanager.facebook.com">Ads Manager</ExtLink> and copy the number after <code>act=</code> in the address bar (it's also in the account dropdown, top-left). Paste it as <code>act_1234567890</code> — bare digits work too.</>,
            <><b>Business ID</b> (optional): Business settings → <b>Business info</b> — the ID shown at the top.</>,
            <>Press <b>Save</b> below. Once the token and ad account are in, a green <b>✓ Connected</b> appears — you're done.</>,
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

          {/* Organic social metrics (INBOUND) — read Page/IG stats into Pulse. */}
          <div style={{ ...note, marginTop: 14 }}>
            <b>Social metrics (read-only):</b> to pull <b>organic</b> followers, reach &amp; post engagement into Pulse, add the Page / Instagram account below. The same token is reused — it needs <code>pages_read_engagement</code>, <code>read_insights</code> and (for IG) <code>instagram_basic</code> + <code>instagram_manage_insights</code>.
          </div>
          <Lbl>Facebook Page ID <span style={{ textTransform: 'none', fontWeight: 400 }}>· optional</span></Lbl>
          <input value={metaPageId} onChange={(e) => setMetaPageId(e.target.value)} placeholder="e.g. 1029384756" style={input} autoComplete="off" />
          <Lbl>Instagram account ID <span style={{ textTransform: 'none', fontWeight: 400 }}>· optional</span></Lbl>
          <input value={metaIgUserId} onChange={(e) => setMetaIgUserId(e.target.value)} placeholder="IG Business/Creator user id" style={input} autoComplete="off" />
          {value?.meta?.tokenSet && (value?.meta?.pageId || value?.meta?.igUserId) && <div style={{ ...note, color: 'var(--success, #10b981)', marginTop: 8 }}>✓ Social metrics on — view trends in <b>Social</b>.</div>}
          <SaveRow k="meta" />
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
          <div style={{ ...note, marginTop: 14 }}>
            <b>Social metrics (read-only):</b> if this token also carries the user scopes <code>user.info.stats</code> + <code>video.list</code>, Pulse pulls your <b>organic</b> follower count and recent video stats into <b>Social</b> automatically — no extra field needed.
          </div>
          <SaveRow k="tiktok" />
        </Section>
      )}

      {/* Pulse Pixel — one snippet on the client's site/ticket shop, all ad pixels */}
      {showPixel && (
        <PulsePixelSection
          collapsible={collapsible} lockProps={lockProps('pixel')} value={value} pixelEntityId={pixelEntityId}
          pxMeta={pxMeta} setPxMeta={setPxMeta} pxGoogle={pxGoogle} setPxGoogle={setPxGoogle}
          pxTiktok={pxTiktok} setPxTiktok={setPxTiktok} pxConsent={pxConsent} setPxConsent={setPxConsent}
          pxStatus={pxStatus} setPxStatus={setPxStatus} pxCopied={pxCopied} setPxCopied={setPxCopied}
          pxPack={pxPack} setPxPack={setPxPack} onPixelStatus={onPixelStatus} onCreatePixelAudiences={onCreatePixelAudiences}
          SaveRow={SaveRow}
        />
      )}

      {/* Slack — per-client outbound notifications */}
      {showSlack && (
        <Section title="💬 Slack" collapsible={collapsible} {...lockProps('slack')} guide={<>
          <div style={note}>
            Mirror Pulse inbox notifications into your <b>Slack</b> — when Howler messages you (or an automation nudges you), it also posts to your Slack channel. <b>Outbound only.</b> Use <b>either</b> an Incoming Webhook (simplest) <b>or</b> a bot token + channel (richer).
          </div>
          <HowTo title="How to connect Slack" steps={[
            <><b>Easiest — Incoming Webhook:</b> in Slack, open <b>Apps → Incoming Webhooks</b> (or create an app at <code>api.slack.com/apps</code> → <b>Incoming Webhooks</b> → <b>Add New Webhook</b>), pick the channel to post to, and copy the <code>https://hooks.slack.com/services/…</code> URL into <b>Webhook URL</b> above.</>,
            <><b>Or — Bot token:</b> create a Slack app, add the <code>chat:write</code> scope under <b>OAuth &amp; Permissions</b>, install it to your workspace, copy the <b>Bot User OAuth Token</b> (<code>xoxb-…</code>) into <b>Bot token</b>, and <b>/invite</b> the bot to the target channel.</>,
            <>For a bot token, set <b>Channel</b> to the channel id (e.g. <code>C0123456789</code>) or name (e.g. <code>#client-updates</code>). The webhook already knows its channel, so leave Channel blank when using a webhook.</>,
          ]} />
        </>}>
          <Lbl>Webhook URL</Lbl>
          <input
            type="password" autoComplete="off"
            value={slackWebhook} onChange={(e) => setSlackWebhook(e.target.value)}
            placeholder={value?.slack?.webhookSet ? `Set (${value.slack.webhookHint || '••••'}) — leave blank to keep` : 'https://hooks.slack.com/services/…'}
            style={input} disabled={clearSlackWebhook}
          />
          {value?.slack?.webhookSet && (
            <label style={clearRow}><input type="checkbox" checked={clearSlackWebhook} onChange={(e) => setClearSlackWebhook(e.target.checked)} /> Remove this webhook</label>
          )}
          <Lbl>Bot token <span style={{ textTransform: 'none', fontWeight: 400 }}>· alternative to a webhook</span></Lbl>
          <input
            type="password" autoComplete="off"
            value={slackBotToken} onChange={(e) => setSlackBotToken(e.target.value)}
            placeholder={value?.slack?.botTokenSet ? `Set (${value.slack.botHint || '••••'}) — leave blank to keep` : 'xoxb-…'}
            style={input} disabled={clearSlackBot}
          />
          {value?.slack?.botTokenSet && (
            <label style={clearRow}><input type="checkbox" checked={clearSlackBot} onChange={(e) => setClearSlackBot(e.target.checked)} /> Remove this token</label>
          )}
          <Lbl>Channel <span style={{ textTransform: 'none', fontWeight: 400 }}>· required with a bot token</span></Lbl>
          <input value={slackChannel} onChange={(e) => setSlackChannel(e.target.value)} placeholder="#client-updates or C0123456789" style={input} autoComplete="off" />
          {value?.slack?.configured && <div style={{ ...note, color: 'var(--success, #10b981)', marginTop: 8 }}>✓ Connected — Howler messages will also post to Slack.</div>}
          {onTestSlack && value?.slack?.configured && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
              <button
                type="button"
                style={{ ...saveBtn, background: 'rgba(128,128,128,0.14)', color: 'var(--text)' }}
                disabled={slackTestState === 'sending'}
                onClick={async () => {
                  setSlackTestState('sending');
                  try { const r = await onTestSlack(); setSlackTestState(r?.ok ? '✓ Sent — check your Slack channel' : `✗ ${r?.error || 'Failed'}`); }
                  catch (e) { setSlackTestState(`✗ ${e.message}`); }
                }}
              >{slackTestState === 'sending' ? 'Sending…' : 'Send a test to Slack'}</button>
              {slackTestState && slackTestState !== 'sending' && <span style={{ fontSize: 12.5, color: slackTestState.startsWith('✓') ? 'var(--success, #10b981)' : 'var(--error, #ef4444)' }}>{slackTestState}</span>}
            </div>
          )}
          <SaveRow k="slack" />
        </Section>
      )}

      {/* ChottuLink — deep links (howler.chottu.link short links) */}
      {showChottu && (
        <Section title="🔗 ChottuLink (deep links)" collapsible={collapsible} {...lockProps('chottu')} guide={<>
          <div style={note}>
            Powers the <b>Links</b> area (Engage → Links): short <code>chottu.link</code> URLs into the Howler app, created from Pulse and tracked per event. Blank fields inherit the platform account.
          </div>
          <HowTo title="How to get a ChottuLink API key" steps={[
            <>Sign in at <b>app.chottulink.com</b> and open <b>Dashboard → Keys</b>.</>,
            <>Create a <b>REST API integration key</b> (it starts with <code>c_api_</code>) and paste it into <b>API key</b> above.</>,
            <>Set <b>Domain</b> to the link domain configured in ChottuLink (e.g. <code>howler.chottu.link</code>).</>,
          ]} />
        </>}>
          <Lbl>API key</Lbl>
          <input
            type="password" autoComplete="off"
            value={chottuKey} onChange={(e) => setChottuKey(e.target.value)}
            placeholder={value?.chottu?.keySet ? `Set (${value.chottu.keyHint || '••••'}) — leave blank to keep` : 'c_api_…'}
            style={input} disabled={clearChottuKey}
          />
          {value?.chottu?.keySet && (
            <label style={clearRow}><input type="checkbox" checked={clearChottuKey} onChange={(e) => setClearChottuKey(e.target.checked)} /> Remove this key</label>
          )}
          <Lbl>Domain</Lbl>
          <input value={chottuDomain} onChange={(e) => setChottuDomain(e.target.value)} placeholder="howler.chottu.link" style={input} autoComplete="off" />
          {value?.chottu?.keySet && value?.chottu?.domain && <div style={{ ...note, color: 'var(--success, #10b981)', marginTop: 8 }}>✓ Connected — manage links in Engage → Links.</div>}
          <SaveRow k="chottu" />
        </Section>
      )}

      {/* Queue-it — live waiting-room stats (read-only) */}
      {showQueueit && (
        <Section title="🚦 Queue-it (waiting rooms)" collapsible={collapsible} {...lockProps('queueit')} guide={<>
          <div style={note}>
            Pulls live <b>waiting-room stats</b> (people in queue, redirects per minute, inflow over time) from <b>Queue-it</b> into Pulse — read-only, the queue itself is never touched. Blank fields inherit the platform account; stats then show only the waiting rooms Howler assigns to this client.
          </div>
          <HowTo title="How to get your Queue-it access details" steps={[
            <>Sign in to the <b>GO Queue-it Platform</b> at <code>go.queue-it.net</code> and open <b>Account → API Keys</b>.</>,
            <>Create (or copy) an API key and paste it into <b>API key</b> above. A read-only/stats key is enough — Pulse only reads statistics.</>,
            <><b>Customer ID</b> is your short Queue-it account name — the subdomain in your queue URLs (e.g. <code>howler</code> in <code>howler.queue-it.net</code>).</>,
          ]} />
        </>}>
          <Lbl>Customer ID</Lbl>
          <input value={qitCustomerId} onChange={(e) => setQitCustomerId(e.target.value)} placeholder="e.g. howler" style={input} autoComplete="off" />
          <Lbl>API key</Lbl>
          <input
            type="password" autoComplete="off"
            value={qitKey} onChange={(e) => setQitKey(e.target.value)}
            placeholder={value?.queueit?.keySet ? `Set (${value.queueit.keyHint || '••••'}) — leave blank to keep` : 'Queue-it API key'}
            style={input} disabled={clearQitKey}
          />
          {value?.queueit?.keySet && (
            <label style={clearRow}><input type="checkbox" checked={clearQitKey} onChange={(e) => setClearQitKey(e.target.checked)} /> Remove this key</label>
          )}
          {value?.queueit?.keySet && value?.queueit?.customerId && <div style={{ ...note, color: 'var(--success, #10b981)', marginTop: 8 }}>✓ Connected — live queue stats appear on the client's Queue-it card (Integrations).</div>}
          <SaveRow k="queueit" />
        </Section>
      )}

      {/* Resend (email) — platform-level only */}
      {showResend && (
        <Section title="✉️ Email (Resend)" collapsible={collapsible} {...lockProps('resend')}>
          {/* Environment brake (OUTBOUND_DISABLED, e.g. a staging server): can't be
              changed from the app — call it out plainly so no one fights the toggle. */}
          {value?.resend?.envOutboundOff && (
            <div style={{ border: '1.5px solid var(--brand)', background: 'rgba(var(--brand-rgb,10,132,255),0.08)', borderRadius: 10, padding: '10px 12px', marginBottom: 12, fontSize: 12.5, lineHeight: 1.45 }}>
              🌐 <b>Email is disabled for this environment</b> (<code>OUTBOUND_DISABLED</code>). This is normally a <b>staging</b> server, blocked so it can never email real clients. The pause toggle below can’t override it — real sends happen on <b>production</b>. To change it, edit the environment’s config in Render.
            </div>
          )}
          {/* Emergency brake: instantly no-ops ALL outbound email (every client,
              every campaign/digest/notification) without touching Resend keys.
              Reflects ONLY the in-app pause setting, so it never snaps back when the
              env brake above is what's really off. */}
          <div style={{ border: `1.5px solid ${value?.resend?.paused ? 'var(--error,#ef4444)' : 'var(--hairline)'}`, background: value?.resend?.paused ? 'rgba(239,68,68,0.08)' : 'transparent', borderRadius: 10, padding: '10px 12px', marginBottom: 12, opacity: value?.resend?.envOutboundOff ? 0.6 : 1 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: value?.resend?.envOutboundOff ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700 }}>
              <input type="checkbox" checked={!!value?.resend?.paused} disabled={value?.resend?.envOutboundOff} onChange={(e) => onSave({ resend: { enabled: !e.target.checked } })} />
              ⏸ Pause ALL outbound email (emergency stop)
            </label>
            <div style={{ fontSize: 12, color: value?.resend?.paused ? 'var(--error,#ef4444)' : 'var(--muted)', marginTop: 4 }}>
              {value?.resend?.envOutboundOff ? 'Overridden by the environment block above — this toggle has no effect here.'
                : value?.resend?.paused ? '⛔ Email is paused — nothing is being sent. Untick to resume.'
                  : 'Takes effect immediately, across all clients. Already-sent emails can’t be recalled.'}
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
          <Lbl>Webhook signing secret <span style={{ textTransform: 'none', fontWeight: 400 }}>· bounces &amp; spam complaints</span></Lbl>
          <div style={note}>
            Protects the shared sending domain: in <b>Resend → Webhooks</b>, add the endpoint <code>{`${typeof window !== 'undefined' ? window.location.origin : ''}/api/webhooks/resend`}</code> with the events <code>email.bounced</code> + <code>email.complained</code>, then paste its signing secret here. Dead/complaining addresses are auto-suppressed from all future campaign sends{typeof value?.resend?.suppressedCount === 'number' ? <> — <b>{value.resend.suppressedCount}</b> suppressed so far</> : null}.
          </div>
          <input
            type="password" autoComplete="off"
            value={resendWebhookSecret} onChange={(e) => setResendWebhookSecret(e.target.value)}
            placeholder={value?.resend?.webhookSecretSet ? 'Set — leave blank to keep' : 'whsec_…'}
            style={input} disabled={clearResendWebhookSecret}
          />
          {value?.resend?.webhookSecretSet && (
            <label style={clearRow}><input type="checkbox" checked={clearResendWebhookSecret} onChange={(e) => setClearResendWebhookSecret(e.target.checked)} /> Remove this secret</label>
          )}
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
          <SaveRow k="resend" />
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
          <SaveRow k="inventive" />
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
          <SaveRow k="looker" />
        </Section>
      )}

    </div>
  );
}

// ── Pulse Pixel card ──────────────────────────────────────────────────────────
// One snippet on the client's website / ticket shop carries ALL their ad pixels
// (Meta / Google / TikTok) — configured here, changeable without ever touching
// the site again. Shows the copy-paste snippet, a live "receiving events" check,
// and the one-click standard retargeting audience packs (Meta / TikTok APIs;
// Google is a guided manual step — no self-serve API for audience lists).
function PulsePixelSection({ collapsible, lockProps, value, pixelEntityId, pxMeta, setPxMeta, pxGoogle, setPxGoogle, pxTiktok, setPxTiktok, pxConsent, setPxConsent, pxStatus, setPxStatus, pxCopied, setPxCopied, pxPack, setPxPack, onPixelStatus, onCreatePixelAudiences, SaveRow }) {
  const snippet = `<script async src="${typeof window !== 'undefined' ? window.location.origin : ''}/px.js?e=${pixelEntityId}"></script>`;
  const anySaved = !!(value?.pixel?.metaPixelId || value?.pixel?.googleTagId || value?.pixel?.tiktokPixelId);
  const checkInstall = async () => {
    if (!onPixelStatus) return;
    setPxStatus('checking');
    try { setPxStatus(await onPixelStatus()); } catch (e) { setPxStatus({ error: e.message }); }
  };
  useEffect(() => { if (anySaved && onPixelStatus && pxStatus === null) checkInstall(); }, [anySaved]); // eslint-disable-line react-hooks/exhaustive-deps
  const runPack = async (channel) => {
    if (!onCreatePixelAudiences) return;
    setPxPack((s) => ({ ...s, [channel]: '…' }));
    try {
      const r = await onCreatePixelAudiences(channel);
      setPxPack((s) => ({ ...s, [channel]: r.error ? `✗ ${r.error}` : `✓ ${r.created} created · ${r.existed} already existed${r.errors ? ` · ${r.errors} failed` : ''}` }));
    } catch (e) { setPxPack((s) => ({ ...s, [channel]: `✗ ${e.message}` })); }
  };
  const packBtn = { padding: '8px 14px', fontSize: 12.5, fontWeight: 700, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 980, cursor: 'pointer' };
  const live = pxStatus && pxStatus !== 'checking' && !pxStatus.error && pxStatus.lastEventAt;
  return (
    <Section title="🎯 Pulse Pixel (website retargeting)" collapsible={collapsible} {...lockProps} guide={<>
      <div style={note}>
        <b>Install once, manage forever.</b> One snippet on the website / ticket shop loads all the ad pixels configured below and fires the standard events — so <b>remarketing lists build automatically</b> in Meta, Google and TikTok. Adding or changing a pixel later is a Pulse setting; the site never needs touching again.
      </div>
      <HowTo title="How to find each pixel / tag ID" steps={[
        <><b>Meta Pixel ID:</b> <a href="https://business.facebook.com/events_manager" target="_blank" rel="noreferrer">Meta Events Manager</a> → Data sources → your pixel — the numeric ID under the pixel name. (No pixel yet? Create one there in two clicks.)</>,
        <><b>Google tag ID:</b> <a href="https://ads.google.com" target="_blank" rel="noreferrer">Google Ads</a> → Tools → Data manager → Google tag — the <code>AW-…</code> (or <code>G-…</code>) ID.</>,
        <><b>TikTok Pixel ID:</b> <a href="https://ads.tiktok.com" target="_blank" rel="noreferrer">TikTok Ads Manager</a> → Tools → Events → Web events — the pixel code (e.g. <code>C4A7…</code>).</>,
      ]} />
      <HowTo title="Google: create the remarketing audiences (one-time, manual)" steps={[
        <>Google has no simple API for this, so it's a one-time manual step: in <a href="https://ads.google.com" target="_blank" rel="noreferrer">Google Ads</a> open <b>Tools → Shared library → Audience manager → Segments</b>.</>,
        <>Create <b>Website visitors</b> segments: “All visitors · 180d”, “All visitors · 30d” (membership duration 180/30 days).</>,
        <>Add event-based segments if you fire them: “begin_checkout · 14d” excluding “purchase · 14d” (abandoners) and “purchase · 180d” (buyers).</>,
        <>They fill automatically from the Google tag this pixel serves — nothing else to install.</>,
      ]} />
    </>}>
      <Lbl>Install snippet <span style={{ textTransform: 'none', fontWeight: 400 }}>· paste before <code>&lt;/head&gt;</code> on every page</span></Lbl>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input readOnly value={snippet} onFocus={(e) => e.target.select()} style={{ ...input, fontFamily: 'monospace', fontSize: 11.5 }} />
        <button type="button" style={{ ...packBtn, flexShrink: 0 }} onClick={() => { navigator.clipboard?.writeText(snippet).then(() => { setPxCopied(true); setTimeout(() => setPxCopied(false), 1600); }).catch(() => {}); }}>{pxCopied ? '✓ Copied' : 'Copy'}</button>
      </div>
      {onPixelStatus && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
          <button type="button" style={packBtn} onClick={checkInstall} disabled={pxStatus === 'checking'}>{pxStatus === 'checking' ? 'Checking…' : 'Check install'}</button>
          <a href={`${typeof window !== 'undefined' ? window.location.origin : ''}/px-test?e=${pixelEntityId}`} target="_blank" rel="noreferrer" style={{ ...packBtn, textDecoration: 'none', display: 'inline-block' }} title="A hosted page with this client's snippet already installed — fire test events and watch the diagnostics">🧪 Open test page ↗</a>
          {live && <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--success, #10b981)' }}>✓ Receiving events — last {new Date(pxStatus.lastEventAt).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {pxStatus.events24h} in 24h</span>}
          {pxStatus && pxStatus !== 'checking' && !pxStatus.error && !pxStatus.lastEventAt && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>No events received yet — install the snippet, then open the site once.</span>}
          {pxStatus?.error && <span style={{ fontSize: 12.5, color: 'var(--error, #ef4444)' }}>✗ {pxStatus.error}</span>}
        </div>
      )}
      <Lbl>Meta Pixel ID</Lbl>
      <input value={pxMeta} onChange={(e) => setPxMeta(e.target.value)} placeholder="e.g. 123456789012345" style={input} autoComplete="off" />
      <Lbl>Google tag ID</Lbl>
      <input value={pxGoogle} onChange={(e) => setPxGoogle(e.target.value)} placeholder="AW-… or G-…" style={input} autoComplete="off" />
      <Lbl>TikTok Pixel ID</Lbl>
      <input value={pxTiktok} onChange={(e) => setPxTiktok(e.target.value)} placeholder="e.g. C4A7…" style={input} autoComplete="off" />
      <Lbl>Consent handling</Lbl>
      <select value={pxConsent} onChange={(e) => setPxConsent(e.target.value)} style={{ ...input, cursor: 'pointer' }}>
        <option value="auto">Fire immediately (default)</option>
        <option value="gated">Wait for consent — GDPR sites (fire after window.pulseGrantConsent())</option>
      </select>
      {pxConsent === 'gated' && <div style={note}>Pixels stay OFF until the site's cookie banner calls <code>window.pulseGrantConsent()</code> (or dispatches a <code>pulse-consent</code> event). Wire that into the “accept” button of the consent tool.</div>}

      {onCreatePixelAudiences && (
        <>
          <Lbl>Standard retargeting audiences <span style={{ textTransform: 'none', fontWeight: 400 }}>· one click, created in the ad account</span></Lbl>
          <div style={note}>Creates the standard pack — all visitors (180d/30d) · viewed tickets (30d) · checkout abandoners (14d) · purchasers (180d) — directly in the connected ad account. Safe to re-click: existing ones are kept, only missing ones are created.</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
            <button type="button" style={packBtn} disabled={!(value?.pixel?.metaPixelId && value?.meta?.tokenSet && value?.meta?.adAccountId) || pxPack.meta === '…'} title={!(value?.pixel?.metaPixelId && value?.meta?.tokenSet && value?.meta?.adAccountId) ? 'Needs the Meta Pixel ID saved + the Meta connection (token & ad account) above' : ''} onClick={() => runPack('meta')}>{pxPack.meta === '…' ? 'Creating…' : '◇ Create in Meta'}</button>
            <button type="button" style={packBtn} disabled={!(value?.pixel?.tiktokPixelId && value?.tiktok?.tokenSet && value?.tiktok?.advertiserId) || pxPack.tiktok === '…'} title={!(value?.pixel?.tiktokPixelId && value?.tiktok?.tokenSet && value?.tiktok?.advertiserId) ? 'Needs the TikTok Pixel ID saved + the TikTok connection (token & advertiser id) above' : ''} onClick={() => runPack('tiktok')}>{pxPack.tiktok === '…' ? 'Creating…' : '♪ Create in TikTok'}</button>
          </div>
          {['meta', 'tiktok'].map((ch) => (pxPack[ch] && pxPack[ch] !== '…' ? <div key={ch} style={{ fontSize: 12.5, marginTop: 6, fontWeight: 600, color: pxPack[ch].startsWith('✓') ? 'var(--success, #10b981)' : 'var(--error, #ef4444)' }}>{ch === 'meta' ? '◇' : '♪'} {pxPack[ch]}</div> : null))}
        </>
      )}
      <SaveRow k="pixel" />
    </Section>
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

// External link for HowTo steps — opens in a new tab so the client keeps their
// place in the Pulse form while following along on the other site.
function ExtLink({ href, children }) {
  return <a href={href} target="_blank" rel="noreferrer" style={{ color: 'var(--brand)', fontWeight: 600 }}>{children}</a>;
}

// Flatten a HowTo step's JSX down to plain text so the steps can be copied or
// shared as a message. Links become "label (url)" unless the label already IS
// the url; everything else keeps just its text.
function stepText(node) {
  if (node == null || node === true || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(stepText).join('');
  if (node.props) {
    const inner = stepText(node.props.children);
    const href = node.props.href;
    if (href && href !== inner && href.replace(/^https?:\/\//, '') !== inner) return `${inner} (${href})`;
    return inner;
  }
  return '';
}

// Collapsible "how to get your access details" — closed by default so it never
// clutters the form, but a step-by-step is one tap away when a client is stuck.
// Copy/Share turn the steps into a plain-text message, so a non-technical client
// can hand the requirements to their agency / IT person instead of doing it
// themselves (Share uses the native sheet on phones → WhatsApp, email, …).
function HowTo({ title, steps = [] }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const shareText = () =>
    `Howler Pulse — ${title}\n\n` +
    steps.map((s, i) => `${i + 1}. ${stepText(s)}`).join('\n\n') +
    `\n\nOnce you have the details, they get entered in Howler Pulse (${window.location.origin}) under Settings → Integrations.`;
  const copy = async () => {
    const text = shareText();
    try { await navigator.clipboard.writeText(text); }
    catch {
      // Clipboard API needs a secure context / permission — textarea fallback.
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } finally { ta.remove(); }
    }
    setCopied(true); setTimeout(() => setCopied(false), 1800);
  };
  const share = async () => {
    try { await navigator.share({ title: `Howler Pulse — ${title}`, text: shareText() }); }
    catch { /* user closed the share sheet */ }
  };
  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 8, margin: '4px 0 6px', overflow: 'hidden' }}>
      <button type="button" onClick={() => setOpen((o) => !o)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '9px 11px', background: 'rgba(128,128,128,0.05)', border: 'none', cursor: 'pointer', font: 'inherit', textAlign: 'left' }}>
        <span style={{ fontSize: 13 }}>💡</span>
        <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1, color: 'var(--text)' }}>{title}</span>
        <span style={{ width: 12, fontSize: 10, color: 'var(--muted)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
      </button>
      {open && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '10px 11px 2px' }}>
            <button type="button" onClick={copy} style={{ ...shareBtn, ...(copied ? { color: 'var(--success, #10b981)', borderColor: 'var(--success, #10b981)' } : null) }}>
              {copied ? '✓ Copied' : '⧉ Copy steps'}
            </button>
            {typeof navigator !== 'undefined' && !!navigator.share && (
              <button type="button" onClick={share} style={shareBtn}>📤 Share</button>
            )}
            <span style={{ fontSize: 11.5, color: 'var(--muted)', flex: '1 1 160px' }}>Not your department? Send these steps to whoever manages this for you.</span>
          </div>
          <ol style={{ margin: 0, padding: '10px 12px 10px 28px', display: 'flex', flexDirection: 'column', gap: 7, fontSize: 12.5, color: 'var(--text)', lineHeight: 1.5 }}>
            {steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
        </>
      )}
    </div>
  );
}

const card = { background: 'var(--card)', border: '1px solid #e6e6e6', borderRadius: 12, padding: 18 };
const secTitle = { fontSize: 14, fontWeight: 700, marginBottom: 4 };
const input = { width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none' };
const note = { fontSize: 12, color: 'var(--muted)', background: '#f7f7f8', border: '1px solid var(--hairline)', borderRadius: 8, padding: '8px 10px', margin: '4px 0 4px' };
const clearRow = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--error, #ef4444)', marginTop: 6, cursor: 'pointer' };
const shareBtn = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 980, padding: '8px 14px', minHeight: 40, fontSize: 12, fontWeight: 600, cursor: 'pointer', flexShrink: 0 };
const saveBtn = { padding: '9px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
