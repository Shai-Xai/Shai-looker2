// ─── Action templates (recipes) ──────────────────────────────────────────────
// Pre-configured action blueprints. A client picks one ("Abandoned carts →
// Recover checkouts"), Pulse resolves the right dashboard/tile + field mappings
// from THEIR data, and the editor opens pre-filled so they just finalize. The
// abandoned-cart template is the first; more drop in here. Each carries a
// category (for grouping/labelling) and matching hints so the audience source
// is found automatically per client.
//
// Code-defined for now (like roles); can become data-driven later. The catalog
// also feeds automation: a template marked recurringSuggested powers the daily
// auto-check.

const TEMPLATES = [
  {
    key: 'abandoned_cart',
    category: 'Abandoned carts',
    label: 'Recover abandoned checkouts',
    short: 'Email customers who started a ticket purchase but didn’t finish, and nudge them to complete it.',
    type: 'email_campaign',
    capability: 'email_campaign',
    recurringSuggested: true,
    // Find the audience source by TILE title — the "abandoned" people-list tile
    // usually lives on a broader dashboard (e.g. "Ticketing Overview"), so we
    // don't require the dashboard title to match too (an email column is still
    // required, so only the right tile resolves).
    match: { tile: /abandon|incomplete|unfinished|drop.?off|didn.?t.*(finish|complet)|started.*(checkout|purchase)|pending.*(order|checkout|payment)/i },
    // Pick the email / name / ticket / consent columns by field-name hints
    // (first match wins). Resolved against the matched tile's query fields.
    fieldHints: {
      emailField: [/e-?mail/i],
      nameField: [/(^|[._])name/i, /customer/i],
      ticketField: [/ticket.?type/i, /ticket.?name/i, /product/i],
      consentField: [/allow.*e-?mail/i, /e-?mail.*(consent|opt|allow|subscrib)/i, /consent/i, /opt.?in/i, /marketing/i, /subscrib/i],
    },
    preset: {
      goal: 'Re-engage customers who abandoned their ticket checkout and get them to complete the purchase.',
      subject: 'You left something behind 🎟️',
      body: 'Hi {{name}},\n\nYou were so close! Your {{ticketType}} is still waiting, so complete your checkout before it’s gone.\n\nSee you there.',
      ctaText: 'Complete my purchase',
      utm: { source: 'pulse', medium: 'email', campaign: 'abandoned-cart' },
    },
  },
];

const byKey = Object.fromEntries(TEMPLATES.map((t) => [t.key, t]));
function get(key) { return byKey[key] || null; }
// Public list (no internals) for the gallery.
function list() {
  return TEMPLATES.map((t) => ({ key: t.key, category: t.category, label: t.label, short: t.short, type: t.type, capability: t.capability, recurringSuggested: !!t.recurringSuggested }));
}

// Resolve a template's audience source for one client, given a tile catalogue
// [{ dashboardId, suiteId, title, tiles:[{tileId, title, fields:[fieldName] }] }].
// Dashboards are tried in order, so pass the event the suggestion pointed at
// first to scope a multi-event client to the right one. Returns the matched
// dashboard/tile/event + suggested field mappings, and `ready` (whether a usable
// source was found). The client can still adjust everything.
function resolveAudience(t, dashboards) {
  const pickField = (fields, hints) => {
    for (const h of hints) { const f = (fields || []).find((name) => h.test(name)); if (f) return f; }
    return '';
  };
  for (const d of dashboards || []) {
    if (t.match?.dashboard && !t.match.dashboard.test(d.title || '')) continue;
    for (const tile of d.tiles || []) {
      if (t.match?.tile && !t.match.tile.test(tile.title || '')) continue;
      const fields = tile.fields || [];
      const emailField = pickField(fields, t.fieldHints?.emailField || []);
      if (!emailField) continue; // an email column is the minimum for an email campaign
      return {
        ready: true,
        dashboardId: d.dashboardId,
        // The event (suite) the matched tile belongs to — so a multi-event
        // campaign scopes its audience to the right event automatically.
        suiteId: d.suiteId || '',
        tileId: tile.tileId,
        emailField,
        nameField: pickField(fields, t.fieldHints?.nameField || []),
        ticketField: pickField(fields, t.fieldHints?.ticketField || []),
        consentField: pickField(fields, t.fieldHints?.consentField || []),
      };
    }
  }
  return { ready: false };
}

module.exports = { TEMPLATES, get, list, resolveAudience };
