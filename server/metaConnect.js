// ─── Meta connect — "Continue with Facebook" OAuth for the Meta connection ──────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the /api/*/meta-connect routes + the
// /api/meta/oauth/callback. Remove the mount line in index.js + this file (and
// MetaConnectCard.jsx) to uninstall.
//
// Replaces token-pasting with a login flow: the user clicks Connect, approves
// ads_read + ads_management in Meta's dialog, picks the ad account (auto-picked
// when there's exactly one), and we store the result into the SAME per-client
// fields the pasted path uses (metaAccessToken / metaAdAccountId) — so
// audience-sync (meta.js) and paid-performance (metaAds.js) work unchanged.
//
// INTERIM TOKENS: without Meta Advanced Access (Business Verification + App
// Review, a one-time Meta-side process), the exchanged long-lived token lasts
// ~60 days. We store the expiry (metaTokenExpiresAt) and surface a "reconnect"
// state as it nears; once Advanced Access lands, the same flow can mint
// never-expiring business tokens with zero changes here for clients.
//
// Platform app config: settings meta_app_id / meta_app_secret (or env
// META_APP_ID / META_APP_SECRET). Register the redirect URI
// <base>/api/meta/oauth/callback under Facebook Login → Valid OAuth Redirect URIs.

const GRAPH = 'https://graph.facebook.com/v19.0';
const DIALOG = 'https://www.facebook.com/v19.0/dialog/oauth';
const SCOPES = 'ads_read,ads_management,business_management';

function mount(app, { db, auth, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const oauthState = require('./oauthState');
  oauthState.init({ db });

  const appConfig = () => ({
    appId: (db.getSetting ? db.getSetting('meta_app_id', '') : '') || process.env.META_APP_ID || '',
    appSecret: (db.getSetting ? db.getSetting('meta_app_secret', '') : '') || process.env.META_APP_SECRET || '',
  });
  const baseUrl = (req) => (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const redirectUri = (req) => `${baseUrl(req)}/api/meta/oauth/callback`;
  const safeReturn = (p) => (typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') ? p : '/settings?section=integrations');

  async function graph(path, token) {
    const res = await doFetch(`${GRAPH}/${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(20000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data?.error?.message || `Meta HTTP ${res.status}`);
    return data;
  }

  // ── status view (never returns the token) ──
  function view(entityId) {
    const i = db.getEntityIntegrations(entityId);
    const cfg = appConfig();
    const expiresAt = i.metaTokenExpiresAt || '';
    const daysLeft = expiresAt ? Math.floor((new Date(expiresAt).getTime() - Date.now()) / 86400_000) : null;
    let pending = [];
    try { pending = JSON.parse(i.metaOauthAccounts || '[]'); } catch { pending = []; }
    return {
      appConfigured: !!(cfg.appId && cfg.appSecret),
      connected: !!(i.metaAccessToken || '').trim() && !!(i.metaAdAccountId || '').trim(),
      adAccountId: i.metaAdAccountId || '',
      connectedAs: i.metaConnectedAs || '',
      viaOauth: !!(i.metaConnectedAs || '').trim(), // pasted tokens have no connected-as
      expiresAt, daysLeft,
      needsReconnect: daysLeft != null && daysLeft <= 7,
      pendingAccounts: (i.metaOauthPendingToken || '') ? pending : [],
    };
  }

  // ── routes ──
  const myEntity = (req, res, next) => {
    const eid = req.params.entityId;
    if (req.user && (req.user.role === 'admin' || (req.user.entityIds || []).includes(eid))) return next();
    return res.status(403).json({ error: 'Not your client.' });
  };
  const manage = (req, res, next) => auth.requirePermission('integrations.manage')(req, res, next);
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { console.error('[meta-connect]', e.message); if (!res.headersSent) res.status(500).json({ error: 'Something went wrong.' }); });

  function start(entityId, req, res) {
    const cfg = appConfig();
    if (!cfg.appId || !cfg.appSecret) return res.status(400).json({ error: 'Meta connect isn\'t configured on the platform yet (app id/secret).' });
    const u = new URL(DIALOG);
    u.searchParams.set('client_id', cfg.appId);
    u.searchParams.set('redirect_uri', redirectUri(req));
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', SCOPES);
    u.searchParams.set('state', oauthState.sign({ t: 'meta', entityId, userId: req.user.id, ret: safeReturn(req.query.ret) }));
    res.json({ url: u.toString() });
  }

  app.get('/api/meta/oauth/callback', auth.requireAuth, wrap(async (req, res) => {
    const st = oauthState.verify(req.query.state);
    if (!st || st.t !== 'meta' || st.userId !== req.user.id) return res.status(400).send('This connect link expired — go back to Settings and try again.');
    if (!(req.user.role === 'admin' || (req.user.entityIds || []).includes(st.entityId))) return res.status(403).send('Not your client.');
    const back = (flag) => res.redirect(302, `${safeReturn(st.ret)}${st.ret.includes('?') ? '&' : '?'}meta=${flag}`);
    if (req.query.error) return back('denied');
    const cfg = appConfig();
    // code → short-lived token → long-lived (~60 days without Advanced Access)
    const shortTok = (await graph(`oauth/access_token?client_id=${cfg.appId}&client_secret=${cfg.appSecret}&redirect_uri=${encodeURIComponent(redirectUri(req))}&code=${encodeURIComponent(String(req.query.code || ''))}`)).access_token;
    const long = await graph(`oauth/access_token?grant_type=fb_exchange_token&client_id=${cfg.appId}&client_secret=${cfg.appSecret}&fb_exchange_token=${encodeURIComponent(shortTok)}`);
    const token = long.access_token;
    const expiresAt = new Date(Date.now() + (Number(long.expires_in) || 60 * 86400) * 1000).toISOString();
    const me = await graph('me?fields=name', token).catch(() => ({ name: '' }));
    const accts = (await graph('me/adaccounts?fields=id,name,account_status&limit=100', token).catch(() => ({ data: [] }))).data || [];
    if (accts.length === 1) {
      db.setEntityIntegrations(st.entityId, { metaAccessToken: token, metaAdAccountId: accts[0].id, metaConnectedAs: me.name || 'Meta user', metaTokenExpiresAt: expiresAt, metaOauthPendingToken: '', metaOauthAccounts: '' });
      return back('connected');
    }
    if (!accts.length) return back('noaccounts');
    // several ad accounts → park the token and let the card offer a picker
    db.setEntityIntegrations(st.entityId, { metaOauthPendingToken: token, metaOauthAccounts: JSON.stringify(accts.map((a) => ({ id: a.id, name: a.name || a.id, status: a.account_status }))), metaConnectedAs: me.name || 'Meta user', metaTokenExpiresAt: expiresAt });
    return back('pick');
  }));

  function select(entityId, body, res) {
    const i = db.getEntityIntegrations(entityId);
    const token = i.metaOauthPendingToken || '';
    let accts = [];
    try { accts = JSON.parse(i.metaOauthAccounts || '[]'); } catch { accts = []; }
    const pick = accts.find((a) => a.id === body.accountId);
    if (!token || !pick) return res.status(400).json({ error: 'That connect session expired — hit Connect with Facebook again.' });
    db.setEntityIntegrations(entityId, { metaAccessToken: token, metaAdAccountId: pick.id, metaOauthPendingToken: '', metaOauthAccounts: '' });
    res.json({ ok: true, ...view(entityId) });
  }
  function disconnect(entityId, res) {
    db.setEntityIntegrations(entityId, { metaAccessToken: '', metaAdAccountId: '', metaConnectedAs: '', metaTokenExpiresAt: '', metaOauthPendingToken: '', metaOauthAccounts: '' });
    res.json({ ok: true, ...view(entityId) });
  }

  app.get('/api/my/meta-connect/:entityId', auth.requireAuth, myEntity, (req, res) => res.json(view(req.params.entityId)));
  app.get('/api/my/meta-connect/:entityId/start', auth.requireAuth, myEntity, manage, (req, res) => start(req.params.entityId, req, res));
  app.post('/api/my/meta-connect/:entityId/select', auth.requireAuth, myEntity, manage, (req, res) => select(req.params.entityId, req.body || {}, res));
  app.post('/api/my/meta-connect/:entityId/disconnect', auth.requireAuth, myEntity, manage, (req, res) => disconnect(req.params.entityId, res));
  app.get('/api/admin/entities/:entityId/meta-connect', auth.requireAdmin, (req, res) => res.json(view(req.params.entityId)));
  app.get('/api/admin/entities/:entityId/meta-connect/start', auth.requireAdmin, (req, res) => start(req.params.entityId, req, res));
  app.post('/api/admin/entities/:entityId/meta-connect/select', auth.requireAdmin, (req, res) => select(req.params.entityId, req.body || {}, res));
  app.post('/api/admin/entities/:entityId/meta-connect/disconnect', auth.requireAdmin, (req, res) => disconnect(req.params.entityId, res));

  console.log('[metaConnect] Meta OAuth connect mounted');
  return { view };
}

module.exports = { mount };
