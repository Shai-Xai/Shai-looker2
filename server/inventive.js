// ─── Inventive: embedded conversational AI analyst (per-client workspaces) ─────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the /api/inventive/* routes. Mounted
// from index.js with injected deps. Remove that one line + this file to uninstall.
//
// We proxy Inventive's /embed/getAuthorizedUrl server-side so the API key never
// reaches the browser (their requirement). Each Pulse client (entity) maps to one
// Inventive workspace via accountScope.externalRefId = entityId. Config via env
// (or admin settings): INVENTIVE_API_KEY, INVENTIVE_EMBED_AUTH_TOKEN, optional
// INVENTIVE_API_ENDPOINT. Read/write "actions" bridge is NOT here (Inventive
// doesn't expose it yet) — this is the embed only. The admin config UI for these
// keys lives with the integrations routes in index.js, not here.

const fetch = require('node-fetch');

function mount(app, { db, auth, homeEntityFor }) {
  const inventiveEndpoint = () => (db.getSetting('inventive_api_endpoint') || process.env.INVENTIVE_API_ENDPOINT || 'https://app-api.madeinventive.com').replace(/\/+$/, '');
  const inventiveKey = () => (db.getSetting('inventive_api_key') || process.env.INVENTIVE_API_KEY || '').trim();
  const inventiveEmbedToken = () => (db.getSetting('inventive_embed_auth_token') || process.env.INVENTIVE_EMBED_AUTH_TOKEN || '').trim();
  const inventiveName = (email) => {
    const local = String(email || '').split('@')[0].replace(/[._-]+/g, ' ').trim();
    const parts = local.split(/\s+/).map((s) => s.charAt(0).toUpperCase() + s.slice(1));
    return { firstname: parts[0] || 'User', lastname: parts.slice(1).join(' ') };
  };
  app.get('/api/inventive/status', auth.requireAuth, (req, res) => {
    res.json({ configured: !!(inventiveKey() && inventiveEmbedToken()) });
  });
  app.post('/api/inventive/embed-url', auth.requireAuth, async (req, res) => {
    const key = inventiveKey(); const token = inventiveEmbedToken();
    if (!key || !token) return res.status(400).json({ error: 'Inventive is not configured yet.' });
    const entityId = homeEntityFor(req);
    if (!entityId) return res.status(400).json({ error: 'No client context for the AI workspace.' });
    const entity = db.getEntity(entityId);
    if (!entity) return res.status(404).json({ error: 'Client not found.' });
    const { firstname, lastname } = inventiveName(req.user.email);
    const userInfo = {
      firstname, lastname, email: req.user.email,
      // One Inventive workspace per Pulse client (entity).
      accountScope: { externalRefId: entity.id, name: entity.name, description: `${entity.name} · Pulse` },
    };
    try {
      const r = await fetch(`${inventiveEndpoint()}/embed/getAuthorizedUrl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'INVENTIVE-API-KEY': key },
        body: JSON.stringify({ embedAuthToken: token, userInfo, options: req.body?.options || {} }),
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        console.error('[inventive] getAuthorizedUrl', r.status, detail.slice(0, 300));
        return res.status(502).json({ error: 'Inventive rejected the request (check the user is provisioned and the host URL matches the embed token).' });
      }
      res.json(await r.json()); // { url, tokens, scopeToken, hostUrl }
    } catch (e) {
      console.error('[inventive] embed-url', e.message);
      res.status(502).json({ error: 'Could not reach Inventive.' });
    }
  });

  console.log('[inventive] AI analyst embed module mounted');
}

module.exports = { mount };
