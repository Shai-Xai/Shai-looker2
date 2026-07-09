// ─── Integrations config — patch / view / freeze-locks (factory library) ───────
// Shared, non-routes logic extracted from server/index.js (same idea as
// server/query.js): the write-only secrets patch, the masked read views and the
// freeze-lock guards for BOTH tiers — Howler's platform accounts and per-client
// overrides. The routes stay thin in index.js; this owns the field mapping.
//
// Secrets policy: a secret is only written when a new value is typed (or an
// explicit clearXxx flag blanks it); reads report { keySet, keyHint } — never the
// value. Freeze-locks default to LOCKED: a section is editable only when its lock
// is stored explicitly as `false`, and locked sections are dropped server-side so
// a freeze can't be bypassed by a hand-crafted request.
//
// Usage: `require('./integrationsConfig').build({ db, looker, mailer, slack, adminAnthropicKey, maskSecret })`.

const pixel = require('./pixel'); // stateless applyPatch/view for the Pulse Pixel slice
const queueit = require('./queueit'); // stateless applyPatch/view for the Queue-it slice

function build({ db, looker, mailer, slack, adminAnthropicKey, maskSecret }) {
  function applyIntegrationsPatch(body, set) {
    // `set(key, value)` writes a field; called only for fields the caller changed.
    const lk = body.looker || {};
    if (lk.baseUrl !== undefined) set('lookerBaseUrl', String(lk.baseUrl || '').replace(/\/$/, ''));
    if (lk.clientId !== undefined) set('lookerClientId', String(lk.clientId || ''));
    if (lk.clientSecret) set('lookerClientSecret', String(lk.clientSecret));
    if (lk.clearClientSecret) set('lookerClientSecret', '');
    const an = body.anthropic || {};
    if (an.apiKey) set('anthropicApiKey', String(an.apiKey));
    if (an.clearApiKey) set('anthropicApiKey', '');
    const mt = body.meta || {};
    if (mt.accessToken) set('metaAccessToken', String(mt.accessToken));
    if (mt.clearAccessToken) set('metaAccessToken', '');
    if (mt.adAccountId !== undefined) set('metaAdAccountId', String(mt.adAccountId || ''));
    if (mt.businessId !== undefined) set('metaBusinessId', String(mt.businessId || ''));
    // Organic-insights assets (inbound social metrics) — non-secret ids.
    if (mt.pageId !== undefined) set('metaPageId', String(mt.pageId || ''));
    if (mt.igUserId !== undefined) set('metaIgUserId', String(mt.igUserId || ''));
    const tt = body.tiktok || {};
    if (tt.accessToken) set('tiktokAccessToken', String(tt.accessToken));
    if (tt.clearAccessToken) set('tiktokAccessToken', '');
    if (tt.advertiserId !== undefined) set('tiktokAdvertiserId', String(tt.advertiserId || ''));
    slack.applyPatch(body, set); // Slack: webhook / bot token / channel
    pixel.applyPatch(body, set); // Pulse Pixel: pixel/tag ids + consent mode (server/pixel.js)
    const ch = body.chottu || {}; // ChottuLink deep links (server/chottuLink.js)
    if (ch.apiKey) set('chottuApiKey', String(ch.apiKey));
    if (ch.clearApiKey) set('chottuApiKey', '');
    if (ch.domain !== undefined) set('chottuDomain', String(ch.domain || '').trim());
    queueit.applyPatch(body, set); // Queue-it: customer id + api key (server/queueit.js)
  }

  function adminIntegrationsView() {
    return {
      looker: {
        baseUrl: db.getSetting('looker_base_url') || '',
        clientId: db.getSetting('looker_client_id') || '',
        clientSecretSet: !!db.getSetting('looker_client_secret'),
        envFallback: !db.getSetting('looker_base_url') && !!process.env.LOOKER_BASE_URL,
        configured: looker.isConfigured(),
      },
      anthropic: {
        keySet: !!db.getSetting('anthropic_api_key'),
        keyHint: maskSecret(db.getSetting('anthropic_api_key')),
        envFallback: !db.getSetting('anthropic_api_key') && !!process.env.ANTHROPIC_API_KEY,
        configured: !!adminAnthropicKey(),
      },
      // Email (Resend) is platform-level only — it sends from Howler's domain.
      resend: { ...mailer.status(), recent: mailer.recent() },
      // ChottuLink deep links — platform account (client overrides live per entity).
      chottu: {
        keySet: !!db.getSetting('chottu_api_key'),
        keyHint: maskSecret(db.getSetting('chottu_api_key')),
        domain: db.getSetting('chottu_domain') || '',
        configured: !!(db.getSetting('chottu_api_key') && db.getSetting('chottu_domain')),
      },
      // Inventive embedded AI analyst (platform-level: one account, per-client workspaces).
      inventive: {
        keySet: !!db.getSetting('inventive_api_key'),
        keyHint: maskSecret(db.getSetting('inventive_api_key')),
        tokenSet: !!db.getSetting('inventive_embed_auth_token'),
        tokenHint: maskSecret(db.getSetting('inventive_embed_auth_token')),
        endpoint: db.getSetting('inventive_api_endpoint') || '',
        envFallback: !db.getSetting('inventive_api_key') && !!process.env.INVENTIVE_API_KEY,
        configured: !!((db.getSetting('inventive_api_key') || process.env.INVENTIVE_API_KEY) && (db.getSetting('inventive_embed_auth_token') || process.env.INVENTIVE_EMBED_AUTH_TOKEN)),
      },
      // Queue-it — platform account (per-client overrides live on the entity).
      queueit: {
        customerId: db.getSetting('queueit_customer_id') || '',
        keySet: !!db.getSetting('queueit_api_key'),
        keyHint: maskSecret(db.getSetting('queueit_api_key')),
        configured: !!(db.getSetting('queueit_customer_id') && db.getSetting('queueit_api_key')),
      },
      locks: getPlatformIntegrationLocks(), // { key: true } — frozen platform integrations
    };
  }

  function entityIntegrationsView(entityId) {
    const i = db.getEntityIntegrations(entityId);
    return {
      looker: { baseUrl: i.lookerBaseUrl || '', clientId: i.lookerClientId || '', clientSecretSet: !!i.lookerClientSecret },
      anthropic: { keySet: !!i.anthropicApiKey, keyHint: maskSecret(i.anthropicApiKey) },
      meta: { tokenSet: !!i.metaAccessToken, tokenHint: maskSecret(i.metaAccessToken), adAccountId: i.metaAdAccountId || '', businessId: i.metaBusinessId || '', pageId: i.metaPageId || '', igUserId: i.metaIgUserId || '' },
      tiktok: { tokenSet: !!i.tiktokAccessToken, tokenHint: maskSecret(i.tiktokAccessToken), advertiserId: i.tiktokAdvertiserId || '' },
      slack: slack.view(i),
      pixel: pixel.view(i),
      chottu: { keySet: !!i.chottuApiKey, keyHint: maskSecret(i.chottuApiKey), domain: i.chottuDomain || '' },
      queueit: queueit.view(i, maskSecret),
      locks: db.getEntityIntegrationLocks(entityId), // { key: true } — frozen integrations
    };
  }

  // Per-entity integration keys that can be frozen. A frozen section's changes are
  // dropped server-side (defence in depth — the UI also disables it).
  const ENTITY_INTEGRATION_KEYS = ['looker', 'anthropic', 'meta', 'tiktok', 'slack', 'chottu', 'pixel', 'queueit'];
  function dropFrozenSections(entityId, body) {
    const locks = db.getEntityIntegrationLocks(entityId);
    const b = { ...(body || {}) };
    // Locked by default: a section is editable only when explicitly unlocked (false).
    for (const k of ENTITY_INTEGRATION_KEYS) if (locks[k] !== false) delete b[k];
    return b;
  }

  // Platform-level integration freeze locks — same idea as per-client, but for
  // Howler's own accounts, kept in a single setting.
  const PLATFORM_INTEGRATION_KEYS = ['looker', 'anthropic', 'resend', 'inventive', 'chottu', 'queueit'];
  function getPlatformIntegrationLocks() { try { return JSON.parse(db.getSetting('integration_locks') || '{}') || {}; } catch { return {}; } }
  function setPlatformIntegrationLock(key, locked) {
    const cur = getPlatformIntegrationLocks();
    cur[key] = !!locked; // store explicit state — absent reads as locked (default)
    db.setSetting('integration_locks', JSON.stringify(cur));
    return cur;
  }

  return {
    applyIntegrationsPatch, adminIntegrationsView, entityIntegrationsView,
    dropFrozenSections, getPlatformIntegrationLocks, setPlatformIntegrationLock,
    ENTITY_INTEGRATION_KEYS, PLATFORM_INTEGRATION_KEYS,
  };
}

module.exports = { build };
