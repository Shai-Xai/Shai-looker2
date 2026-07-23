// One-click OAuth connect flows — the signed state helper, the Google Drive
// "Connect with Google" flow (drive.file + refresh token, sealed storage,
// connection() preference, invalid_grant → reconnect), and the Meta
// "Continue with Facebook" flow (short→long token exchange, ad-account
// auto-pick vs picker, expiry surfacing). All provider traffic stubbed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const oauthState = require('../server/oauthState');
const drive = require('../server/googleDrive');
const metaConnect = require('../server/metaConnect');

function makeDb() {
  const sqlite = new Database(':memory:');
  const settings = {};
  const integrations = {};
  return {
    db: sqlite,
    getSetting: (k, d) => (k in settings ? settings[k] : d),
    setSetting: (k, v) => { settings[k] = v; },
    getEntityIntegrations: (id) => integrations[id] || {},
    setEntityIntegrations: (id, patch) => { integrations[id] = { ...(integrations[id] || {}), ...patch }; return integrations[id]; },
    _settings: settings, _integrations: integrations,
  };
}

function router() {
  const routes = {};
  const capture = (m) => (path, ...handlers) => { routes[`${m} ${path}`] = handlers; };
  const app = { get: capture('GET'), post: capture('POST'), put: capture('PUT'), delete: capture('DELETE') };
  async function invoke(key, { params = {}, body = {}, query = {}, user = { id: 'u1', role: 'member', entityIds: ['e1'] } } = {}) {
    const handlers = routes[key];
    assert.ok(handlers, `route ${key} exists`);
    const req = { params, body, query, user, protocol: 'https', get: () => 'pulse.test' };
    const out = { status: 200, body: null, redirect: '' };
    const res = {
      status(c) { out.status = c; return this; },
      json(b) { out.body = b; return this; },
      send(b) { out.body = b; return this; },
      redirect(code, url) { out.status = code; out.redirect = url; return this; },
      headersSent: false,
    };
    for (const h of handlers) { let nexted = false; await h(req, res, () => { nexted = true; }); if (!nexted) break; }
    return out;
  }
  return { app, invoke };
}

const auth = {
  requireAuth: (q, s, n) => n(),
  requireAdmin: (q, s, n) => (q.user?.role === 'admin' ? n() : s.status(403).json({ error: 'admin' })),
  requirePermission: () => (q, s, n) => n(),
};

test('oauthState signs, verifies, rejects tampering and expiry', () => {
  oauthState.init({ db: makeDb() });
  const tok = oauthState.sign({ t: 'x', entityId: 'e1' });
  const back = oauthState.verify(tok);
  assert.equal(back.entityId, 'e1');
  assert.equal(oauthState.verify(tok.slice(0, -2) + 'zz'), null, 'tampered mac rejected');
  const [body] = tok.split('.');
  const forged = `${Buffer.from(JSON.stringify({ t: 'x', entityId: 'e2', exp: Date.now() + 9999 })).toString('base64url')}.${tok.split('.')[1]}`;
  assert.equal(oauthState.verify(forged), null, 'swapped body rejected');
  const expired = oauthState.sign({ t: 'x' }, -1000);
  assert.equal(oauthState.verify(expired), null, 'expired rejected');
  assert.equal(oauthState.verify(''), null);
  assert.ok(body.length > 10);
});

// ── Google Drive OAuth ──────────────────────────────────────────────────────────

function driveHarness({ grants = {} } = {}) {
  const db = makeDb();
  db._settings.google_oauth_client_id = 'gcid';
  db._settings.google_oauth_client_secret = 'gsec';
  db._settings.google_api_key = 'gkey';
  const calls = { grants: [] };
  const fetchImpl = async (url, opts) => {
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const params = Object.fromEntries(new URLSearchParams(opts.body));
      calls.grants.push(params.grant_type);
      const r = grants[params.grant_type];
      if (r && r.error) return { ok: false, status: 400, json: async () => r };
      return { ok: true, status: 200, json: async () => (r || { access_token: 'at', expires_in: 3600, refresh_token: 'rt-1', id_token: `x.${Buffer.from(JSON.stringify({ email: 'promoter@gmail.com' })).toString('base64url')}.y` }) };
    }
    throw new Error(`unexpected ${url}`);
  };
  const { app, invoke } = router();
  const api = drive.mount(app, { db, auth, fetchImpl, startTimer: false });
  return { db, api, invoke, calls };
}

test('Google connect: start URL asks for drive.file offline consent; callback stores the grant', async () => {
  const h = driveHarness();
  const start = await h.invoke('GET /api/my/drive/:entityId/oauth/start', { params: { entityId: 'e1' }, query: { ret: '/settings?section=integrations' } });
  assert.equal(start.status, 200);
  const u = new URL(start.body.url);
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.match(u.searchParams.get('scope'), /drive\.file/);
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.match(u.searchParams.get('redirect_uri'), /\/api\/drive\/oauth\/callback$/);
  const cb = await h.invoke('GET /api/drive/oauth/callback', { query: { code: 'c0de', state: u.searchParams.get('state') } });
  assert.equal(cb.status, 302);
  assert.match(cb.redirect, /drive=connected/);
  const i = h.db.getEntityIntegrations('e1');
  assert.equal(i.googleOauthRefreshToken, 'rt-1');
  assert.equal(i.googleOauthEmail, 'promoter@gmail.com');
  // connection now prefers OAuth over any SA key
  const conn = h.api.connection('e1');
  assert.equal(conn.mode, 'oauth');
  const view = h.api.view('e1');
  assert.equal(view.configured, true);
  assert.equal(view.oauth.connected, true);
  assert.ok(!JSON.stringify(view).includes('rt-1'), 'refresh token never leaves the server');
});

test('Google callback rejects a state minted for another user; invalid_grant flags a reconnect', async () => {
  const h = driveHarness({ grants: { refresh_token: { error: 'invalid_grant', error_description: 'revoked' } } });
  const start = await h.invoke('GET /api/my/drive/:entityId/oauth/start', { params: { entityId: 'e1' } });
  const state = new URL(start.body.url).searchParams.get('state');
  const wrongUser = await h.invoke('GET /api/drive/oauth/callback', { query: { code: 'c', state }, user: { id: 'someone-else', role: 'member', entityIds: ['e1'] } });
  assert.equal(wrongUser.status, 400);
  // wire a connected entity, then make refresh fail → reconnect surfaced
  h.db.setEntityIntegrations('e1', { googleOauthRefreshToken: 'rt-dead', googleOauthEmail: 'x@y.z' });
  await assert.rejects(() => h.api._internals.accessToken(h.api.connection('e1')), /reconnect/i);
  assert.match(h.api.view('e1').oauth.error, /reconnect/i);
});

// ── Meta connect ────────────────────────────────────────────────────────────────

function metaHarness({ accounts, longExpiresIn = 5184000 } = {}) {
  const db = makeDb();
  db._settings.meta_app_id = 'mid';
  db._settings.meta_app_secret = 'msec';
  const fetchImpl = async (url) => {
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url.includes('oauth/access_token?grant_type=fb_exchange_token')) return ok({ access_token: 'LONG-TOK', expires_in: longExpiresIn });
    if (url.includes('oauth/access_token?client_id=')) return ok({ access_token: 'short-tok' });
    if (url.includes('me?fields=name')) return ok({ name: 'Shai E' });
    if (url.includes('me/adaccounts')) return ok({ data: accounts ?? [{ id: 'act_1', name: 'Main', account_status: 1 }] });
    throw new Error(`unexpected ${url}`);
  };
  const { app, invoke } = router();
  metaConnect.mount(app, { db, auth, fetchImpl });
  return { db, invoke };
}

test('Meta connect: single ad account auto-connects with a long-lived token + expiry', async () => {
  const h = metaHarness({});
  const start = await h.invoke('GET /api/my/meta-connect/:entityId/start', { params: { entityId: 'e1' } });
  const u = new URL(start.body.url);
  assert.match(u.searchParams.get('scope'), /ads_read,ads_management/);
  const cb = await h.invoke('GET /api/meta/oauth/callback', { query: { code: 'c', state: u.searchParams.get('state') } });
  assert.equal(cb.status, 302);
  assert.match(cb.redirect, /meta=connected/);
  const i = h.db.getEntityIntegrations('e1');
  assert.equal(i.metaAccessToken, 'LONG-TOK', 'long-lived token stored in the SAME field the pasted path uses');
  assert.equal(i.metaAdAccountId, 'act_1');
  assert.equal(i.metaConnectedAs, 'Shai E');
  const status = await h.invoke('GET /api/my/meta-connect/:entityId', { params: { entityId: 'e1' } });
  assert.equal(status.body.connected, true);
  assert.ok(status.body.daysLeft >= 59, `~60 days, got ${status.body.daysLeft}`);
  assert.ok(!JSON.stringify(status.body).includes('LONG-TOK'), 'token never returned');
});

test('Meta connect: several ad accounts → picker, select stores the choice; near-expiry flags reconnect', async () => {
  const h = metaHarness({ accounts: [{ id: 'act_1', name: 'Brand A' }, { id: 'act_2', name: 'Brand B' }] });
  const start = await h.invoke('GET /api/my/meta-connect/:entityId/start', { params: { entityId: 'e1' } });
  const cb = await h.invoke('GET /api/meta/oauth/callback', { query: { code: 'c', state: new URL(start.body.url).searchParams.get('state') } });
  assert.match(cb.redirect, /meta=pick/);
  let status = await h.invoke('GET /api/my/meta-connect/:entityId', { params: { entityId: 'e1' } });
  assert.equal(status.body.connected, false);
  assert.equal(status.body.pendingAccounts.length, 2);
  const sel = await h.invoke('POST /api/my/meta-connect/:entityId/select', { params: { entityId: 'e1' }, body: { accountId: 'act_2' } });
  assert.equal(sel.body.connected, true);
  assert.equal(sel.body.adAccountId, 'act_2');
  assert.equal(h.db.getEntityIntegrations('e1').metaOauthPendingToken, '');
  // near-expiry → needsReconnect
  h.db.setEntityIntegrations('e1', { metaTokenExpiresAt: new Date(Date.now() + 3 * 86400_000).toISOString() });
  status = await h.invoke('GET /api/my/meta-connect/:entityId', { params: { entityId: 'e1' } });
  assert.equal(status.body.needsReconnect, true);
  // scope: a stranger can't read the connect status
  const stranger = await h.invoke('GET /api/my/meta-connect/:entityId', { params: { entityId: 'e1' }, user: { id: 'x', role: 'member', entityIds: ['e9'] } });
  assert.equal(stranger.status, 403);
});
