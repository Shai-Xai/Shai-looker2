// ─── Public platform surface — composition (docs/API_MCP_BRIEF.md) ────────────
// One mount for the four disposable modules that make Pulse a platform:
// per-entity API keys (the security foundation), the /api/v1 read+draft API,
// the remote MCP server for AI agents, and the OAuth "Connect" flow. All thin
// adapters over the SAME service core — external callers ride the app's own
// scope gates unchanged. Remove this line + these modules to uninstall.

function mount(app, deps) {
  const { db, auth, rateLimit, mailer, currency, language } = deps;
  const apiKeys = require('./apiKeys').mount(app, { db, auth, rateLimit });
  const apiV1 = require('./api').mount(app, { ...deps, apiKeys });
  require('./mcp').mount(app, {
    apiKeys, core: apiV1.core, rateLimit,
    // The same client grounding the in-app Owl gets: name + admin-written AI
    // context + currency/language notes — fed into the connect-time instructions.
    clientContextFor: (entityId) => {
      const ent = db.getEntity(entityId);
      const b = mailer.resolveBranding(entityId, '');
      return [
        ent ? `Client: ${ent.name}.` : '',
        ent?.aiContext ? `Background: ${String(ent.aiContext).slice(0, 1500)}` : '',
        currency.aiNote(b.currency) || '', language.aiNote(b.aiLanguage) || '',
      ].filter(Boolean).join('\n');
    },
  });
  require('./oauth').mount(app, { db, auth, apiKeys, rateLimit });
  return { apiKeys, core: apiV1.core };
}

module.exports = { mount };
