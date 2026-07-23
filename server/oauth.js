// ─── OAuth for the MCP server — "click Connect in Claude and approve" ─────────
// SELF-CONTAINED, DISPOSABLE MODULE. Remote MCP clients (Claude.ai connectors
// and friends) don't paste bearer keys — they run the standard MCP auth flow:
// OAuth 2.1 with discovery (RFC 8414 + RFC 9728), dynamic client registration
// (RFC 7591) and PKCE (S256). This module implements the minimal, spec-shaped
// version of that flow ON TOP of the existing per-entity API keys:
//
//   Claude → discovery docs → registers itself → sends the user to
//   /oauth/authorize → the user (already logged into Pulse) picks which client
//   to connect + approves → Pulse MINTS a normal API key for that client →
//   the token endpoint hands that key back as the access token. From there the
//   connection is indistinguishable from a hand-made key: same scopes, same
//   audit trail, same kill-switch, revocable from the same key card.
//
// No refresh tokens in v1 — the access token is an API key, which lives until
// it's revoked (revoking it disconnects the agent; so does the per-client
// API-access switch). Codes are short-lived, single-use, PKCE-bound.
//
// Mount: `require('./oauth').mount(app, { db, auth, apiKeys, rateLimit })`.

const crypto = require('crypto');
const express = require('express');
const { asyncHandler } = require('./http');

const CODE_TTL_MS = 10 * 60_000;

function mount(app, { db, auth, apiKeys, rateLimit }) {
  const sql = db.db;
  const now = () => Date.now();

  sql.exec(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL DEFAULT '',
      redirect_uris TEXT NOT NULL DEFAULT '[]',
      created_at    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code           TEXT PRIMARY KEY,
      client_id      TEXT NOT NULL,
      redirect_uri   TEXT NOT NULL,
      key_secret     TEXT NOT NULL,   -- the minted API key; deleted on exchange
      scope          TEXT NOT NULL DEFAULT 'read',
      code_challenge TEXT NOT NULL,
      expires_at     INTEGER NOT NULL,
      used           INTEGER NOT NULL DEFAULT 0
    );
  `);
  // Codes are secrets-at-rest for up to 10 minutes — sweep expired ones.
  const sweep = setInterval(() => { try { sql.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(now()); } catch { /* best effort */ } }, 10 * 60_000);
  if (sweep.unref) sweep.unref();

  const base = (req) => `${req.protocol}://${req.get('host')}`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const s256 = (v) => crypto.createHash('sha256').update(v).digest('base64url');

  // Public OAuth/MCP endpoints get permissive CORS — web-based MCP clients call
  // them cross-origin. (The data endpoints stay key-authed; CORS hides nothing.)
  const cors = (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, mcp-protocol-version, mcp-session-id');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
  app.use(['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server', '/oauth', '/mcp'], cors);

  // ── discovery (RFC 9728 + RFC 8414; both bare and /mcp-suffixed paths) ──
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (req, res) => {
    res.json({
      resource: `${base(req)}/mcp`,
      authorization_servers: [base(req)],
      scopes_supported: ['read', 'read_rows'],
      bearer_methods_supported: ['header'],
    });
  });
  app.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp'], (req, res) => {
    res.json({
      issuer: base(req),
      authorization_endpoint: `${base(req)}/oauth/authorize`,
      token_endpoint: `${base(req)}/oauth/token`,
      registration_endpoint: `${base(req)}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['read', 'read_rows'],
    });
  });

  // ── dynamic client registration (RFC 7591) — open, as the MCP spec expects ──
  app.post('/oauth/register', rateLimit({ windowMs: 60_000, max: 20, by: 'ip', scope: 'oauth-register' }), (req, res) => {
    const uris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.map(String).slice(0, 10) : [];
    const valid = uris.filter((u) => /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(u));
    if (!valid.length) return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris must contain at least one https:// (or localhost) URL' });
    const id = crypto.randomUUID();
    const name = String(req.body?.client_name || 'MCP client').slice(0, 120);
    sql.prepare('INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?,?,?,?)')
      .run(id, name, JSON.stringify(valid), new Date().toISOString());
    res.status(201).json({ client_id: id, client_name: name, redirect_uris: valid, token_endpoint_auth_method: 'none' });
  });

  const getClient = (id) => {
    const r = sql.prepare('SELECT * FROM oauth_clients WHERE id=?').get(String(id || ''));
    return r ? { ...r, redirect_uris: JSON.parse(r.redirect_uris) } : null;
  };

  // Trust-on-first-use for hand-typed client ids. Some connector UIs force the
  // user to fill in a manual Client ID (which skips dynamic registration and
  // arrives here unknown). If — and only if — the redirect target is a known
  // agent platform's own official callback, accept the id as a first-use
  // registration pinned to that redirect. Safe because: the redirect can't go
  // anywhere an attacker controls (allowlist), the user still explicitly
  // approves on our page, and PKCE binds the code to the requesting app.
  const TRUSTED_REDIRECTS = [
    /^https:\/\/claude\.ai\//, /^https:\/\/claude\.com\//, /^https:\/\/api\.anthropic\.com\//,
    // Gemini Enterprise custom-MCP connectors (no dynamic registration — the
    // admin types a client id/secret; Google's fixed OAuth callback):
    /^https:\/\/vertexaisearch\.cloud\.google\.com\//,
    // Grok custom connectors (grok.com/connectors) — normally self-registers
    // via DCR; these cover a hand-typed client id, same as Claude/Gemini:
    /^https:\/\/grok\.com\//, /^https:\/\/x\.ai\//, /^https:\/\/api\.x\.ai\//,
  ];
  const registerFirstUse = (clientId, redirectUri) => {
    if (!clientId || String(clientId).length > 120) return null;
    if (!TRUSTED_REDIRECTS.some((re) => re.test(String(redirectUri || '')))) return null;
    sql.prepare('INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?,?,?,?)')
      .run(String(clientId), 'Claude', JSON.stringify([String(redirectUri)]), new Date().toISOString());
    return getClient(clientId);
  };

  // ── the approval page ──
  // The user is normally already logged into Pulse in this browser (cookie —
  // attachUser runs globally). They pick which of their clients to connect and
  // whether to allow row-level data; Approve mints the key and redirects back.
  const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f7f7f9;color:#1d1d1f;display:flex;justify-content:center;padding:24px}
.card{background:#fff;border:1px solid #ececef;border-radius:16px;padding:28px;max-width:440px;width:100%;margin-top:6vh;box-shadow:0 10px 30px -18px rgba(0,0,0,.25)}
h1{font-size:19px;margin:0 0 6px}p{font-size:14px;color:#6e6e73;line-height:1.5;margin:8px 0}
label{display:block;font-size:13px;font-weight:600;margin:16px 0 6px}select{width:100%;padding:10px;border:1px solid #ddd;border-radius:9px;font-size:14px}
.chk{display:flex;gap:8px;align-items:flex-start;margin:14px 0;font-weight:400;font-size:13px;color:#6e6e73}
button,a.btn{display:inline-block;background:#FF385C;color:#fff;border:none;border-radius:980px;padding:11px 22px;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none;min-height:40px}
.muted{background:transparent;color:#6e6e73;border:1px solid #ddd}</style></head><body><div class="card">${body}</div></body></html>`;

  const validAuthzParams = (req, res) => {
    const { client_id, redirect_uri, response_type, code_challenge, code_challenge_method } = req.method === 'GET' ? req.query : req.body || {};
    const client = getClient(client_id) || registerFirstUse(client_id, redirect_uri);
    if (!client) {
      res.status(400).send(page('Connection error', `<h1>Unknown app</h1>
        <p>This connection request used a client ID Pulse doesn’t recognise. This usually means a Client ID/Secret was typed into the app’s <b>Advanced settings</b> by hand.</p>
        <p><b>To fix:</b> delete the connector in the app, add it again with the same URL, and leave the OAuth Client ID and Client Secret fields <b>blank</b> — the app then registers with Pulse automatically and this page will show an Approve button instead.</p>`));
      return null;
    }
    if (!client.redirect_uris.includes(String(redirect_uri || ''))) {
      // A known client presenting a new redirect: allow it only if it's a
      // trusted platform callback (same rule as first-use), and pin it.
      if (TRUSTED_REDIRECTS.some((re) => re.test(String(redirect_uri || '')))) {
        client.redirect_uris.push(String(redirect_uri));
        sql.prepare('UPDATE oauth_clients SET redirect_uris=? WHERE id=?').run(JSON.stringify(client.redirect_uris), client.id);
      } else {
        res.status(400).send(page('Connection error', '<h1>Bad redirect address</h1><p>The app asked us to send the connection somewhere it didn’t register. Refusing, to be safe.</p>'));
        return null;
      }
    }
    if (String(response_type || 'code') !== 'code' || !code_challenge || String(code_challenge_method || 'S256') !== 'S256') {
      res.status(400).send(page('Connection error', '<h1>Unsupported request</h1><p>This app used an authorisation style Pulse doesn’t support (code + PKCE S256 only).</p>')); return null;
    }
    return { client, redirect_uri: String(redirect_uri), code_challenge: String(code_challenge) };
  };

  // Entities this user may connect: needs integrations.manage (owner has it);
  // admins may connect any client. API access must be switched ON for the pick
  // to actually work — flag that honestly in the list.
  const connectableEntities = (user) => {
    const all = user.role === 'admin' ? db.listEntities() : (user.entityIds || []).map((id) => db.getEntity(id)).filter(Boolean);
    return all
      .filter((e) => user.role === 'admin' || auth.hasPermission(user, e.id, 'integrations.manage'))
      .map((e) => ({ id: e.id, name: e.name, enabled: apiKeys.apiEnabled(e.id) }));
  };

  app.get('/oauth/authorize', (req, res) => {
    const v = validAuthzParams(req, res);
    if (!v) return;
    if (!req.user) {
      return res.send(page('Log in to Pulse', `<h1>Log in to Pulse first</h1>
        <p>To connect <b>${esc(v.client.name)}</b> to your Pulse data, log into Pulse in this browser, then come back and refresh this page.</p>
        <p><a class="btn" href="/" target="_blank" rel="noreferrer">Open Pulse</a> &nbsp; <button class="muted" onclick="location.reload()">I’ve logged in — refresh</button></p>`));
    }
    const entities = connectableEntities(req.user);
    if (!entities.length) {
      return res.send(page('No access', '<h1>Nothing to connect</h1><p>Your Pulse login doesn’t manage integrations for any client. Ask your account Owner (or Howler) to connect this instead.</p>'));
    }
    const anyEnabled = entities.some((e) => e.enabled);
    const options = entities.map((e) => `<option value="${esc(e.id)}" ${e.enabled ? '' : 'disabled'}>${esc(e.name)}${e.enabled ? '' : ' — API access off (ask Howler)'}</option>`).join('');
    const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope']
      .map((k) => `<input type="hidden" name="${k}" value="${esc(req.query[k] || '')}">`).join('');
    res.send(page('Meet your Owl', `<h1>🦉 Connect “${esc(v.client.name)}” to your Owl?</h1>
      <p>Your AI assistant becomes <b>the Owl</b> for the chosen client — it can <b>read</b> that client’s Pulse data (dashboards, live metrics, audience sizes, campaign results and goals) and answer questions about it. It can’t send campaigns or change anything.</p>
      ${anyEnabled ? '' : '<p><b>API access is switched off for all your clients</b> — ask your Howler contact to enable it, then try again.</p>'}
      <form method="POST" action="/oauth/approve">${hidden}
        <label>Which client?</label><select name="entityId">${options}</select>
        <label class="chk"><input type="checkbox" name="rows" value="1" style="margin-top:2px">
          Also allow <b>row-level data</b> — the tables behind tiles (may include personal data). Leave off unless this tool truly needs it.</label>
        <label class="chk"><input type="checkbox" name="drafts" value="1" style="margin-top:2px">
          Also allow <b>creating drafts</b> — the Owl can build audience segments and draft campaigns for you. Drafts always await your review &amp; approval in Pulse; it can never send.</label>
        <p><button type="submit" ${anyEnabled ? '' : 'disabled'}>Approve &amp; connect</button></p>
      </form>
      <p style="font-size:12px">This creates a named API key you can see and revoke any time in Settings → Integrations.</p>`));
  });

  app.post('/oauth/approve', express.urlencoded({ extended: false }),
    rateLimit({ windowMs: 60_000, max: 10, by: 'user', scope: 'oauth-approve' }),
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).send(page('Log in', '<h1>Session expired</h1><p>Log into Pulse and start the connection again from the app you’re connecting.</p>'));
      const v = validAuthzParams(req, res);
      if (!v) return;
      const entityId = String(req.body.entityId || '');
      const allowed = connectableEntities(req.user).find((e) => e.id === entityId);
      if (!allowed) return res.status(403).send(page('Not allowed', '<h1>Not allowed</h1><p>You can’t connect that client.</p>'));
      if (!allowed.enabled) return res.status(403).send(page('Switched off', '<h1>API access is off</h1><p>Ask your Howler contact to enable API access for this client, then try again.</p>'));
      const scopes = ['read', ...(req.body.rows === '1' ? ['read_rows'] : []), ...(req.body.drafts === '1' ? ['write'] : [])];
      const { secret } = apiKeys.createKey({ entityId, name: `${v.client.name} (connected ${new Date().toISOString().slice(0, 10)})`, scopes });
      const code = crypto.randomBytes(32).toString('base64url');
      sql.prepare('INSERT INTO oauth_codes (code, client_id, redirect_uri, key_secret, scope, code_challenge, expires_at) VALUES (?,?,?,?,?,?,?)')
        .run(code, v.client.id, v.redirect_uri, secret, scopes.join(' '), v.code_challenge, now() + CODE_TTL_MS);
      const u = new URL(v.redirect_uri);
      u.searchParams.set('code', code);
      if (req.body.state) u.searchParams.set('state', String(req.body.state));
      res.redirect(302, u.toString());
    }));

  // ── token exchange (PKCE-verified, single-use, short-lived codes) ──
  app.post('/oauth/token', express.urlencoded({ extended: false }),
    rateLimit({ windowMs: 60_000, max: 30, by: 'ip', scope: 'oauth-token' }),
    (req, res) => {
      const b = req.body || {};
      const fail = (error, description) => res.status(400).json({ error, error_description: description });
      if (String(b.grant_type) !== 'authorization_code') return fail('unsupported_grant_type', 'Only authorization_code is supported.');
      const row = sql.prepare('SELECT * FROM oauth_codes WHERE code=?').get(String(b.code || ''));
      if (!row || row.used || row.expires_at < now()) return fail('invalid_grant', 'Unknown, used or expired code.');
      if (b.client_id && String(b.client_id) !== row.client_id) return fail('invalid_grant', 'Code was issued to a different client.');
      if (b.redirect_uri && String(b.redirect_uri) !== row.redirect_uri) return fail('invalid_grant', 'redirect_uri does not match.');
      if (!b.code_verifier || s256(String(b.code_verifier)) !== row.code_challenge) return fail('invalid_grant', 'PKCE verification failed.');
      // Single-use: burn the code (and its embedded secret) immediately.
      sql.prepare('DELETE FROM oauth_codes WHERE code=?').run(row.code);
      res.json({ access_token: row.key_secret, token_type: 'Bearer', scope: row.scope });
    });

  console.log('[oauth] MCP OAuth flow mounted (discovery + register + authorize + token)');
}

module.exports = { mount };
