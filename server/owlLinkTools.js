// ─── Owl act-tools for ChottuLink deep links (factory library) ──────────────────
// Extracted from server/owlTools.js (line-budget discipline): the two DRAFT-only
// chat tools that let the Owl set up short links — one link (createLink) or a
// whole template set (applyLinkTemplate) — for the CURRENT event. Same
// self-confirm contract as every act-tool: the tool returns {confirm:true,
// action} and NOTHING touches ChottuLink until the user taps the card's button
// (commits: /api/owl/act/create-chottu-link, /api/owl/act/apply-chottu-template
// in server/owlChat.js, which re-check campaigns.approve).
//
// Usage: `...require('./owlLinkTools')({ db, getChottuApi })` spread into the
// owlTools return map.

module.exports = function createOwlLinkTools({ db, getChottuApi }) {
  const refuse = (reason, message) => ({ ok: false, reason, message });
  const entityFor = (ctx) => ctx.entityId || (ctx.suiteId && db && db.getSuite ? (db.getSuite(ctx.suiteId) || {}).entityId : null);
  const connected = (entityId) => {
    const chottu = typeof getChottuApi === 'function' ? getChottuApi() : null;
    if (!chottu) return { err: refuse('unavailable', 'Links aren\'t available right now.') };
    const cfg = chottu.configFor(entityId);
    if (!cfg.key || !cfg.domain) return { err: refuse('not_connected', 'ChottuLink isn\'t connected for this client yet — the key + domain live under Settings → Integrations.') };
    return { chottu, cfg };
  };

  // ── createLink (ACT) — DRAFT one deep link tied to the current event ──
  async function runCreateLink(args = {}, ctx = {}) {
    const { user, suiteId } = ctx;
    if (!user) return refuse('no_user', 'No authenticated user in context.');
    const entityId = entityFor(ctx);
    if (!entityId) return refuse('no_client', 'Open or pick a client first — a link belongs to a client.');
    const { chottu, cfg, err } = connected(entityId);
    if (err) return err;
    void chottu;
    const linkName = String(args.name || '').trim().slice(0, 120);
    const destinationUrl = String(args.destinationUrl || '').trim();
    if (!linkName) return refuse('no_name', 'Give the link a name (e.g. "Tickets — Instagram bio").');
    if (!/^https?:\/\/\S+$/i.test(destinationUrl)) return refuse('bad_destination', 'The destination must be a full URL (https://…).');
    const path = String(args.path || '').trim().replace(/^\//, '').slice(0, 80);
    if (path && !/^[\w-]+$/.test(path)) return refuse('bad_path', 'The short-URL path can only use letters, numbers and dashes.');
    const utm = {};
    for (const k of ['source', 'medium', 'campaign']) {
      const v = String(args[`utm${k[0].toUpperCase()}${k.slice(1)}`] || '').trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-');
      if (v) utm[k] = v;
    }
    const social = {};
    if (String(args.previewTitle || '').trim()) social.title = String(args.previewTitle).trim().slice(0, 120);
    if (String(args.previewDescription || '').trim()) social.description = String(args.previewDescription).trim().slice(0, 200);
    return {
      ok: true,
      confirm: true,
      action: {
        kind: 'createChottuLink', entityId, suiteId: suiteId || '',
        draft: { linkName, destinationUrl, path, utm, social },
        domain: cfg.domain,
        summary: `${cfg.domain}/${path || '(auto code)'} → ${destinationUrl}`,
      },
    };
  }
  const createLinkSchema = {
    name: 'createLink',
    description:
      'DRAFT one short deep link into the Howler app (a branded ChottuLink URL like howler.chottu.link/my-event-ig), for the user to confirm — you do NOT create it; they tap "Create link". Use when the user wants a short/tracking/deep link for a post, bio, email, SMS or QR code ("make me a link for the Instagram bio", "short link to the ticket page tagged as whatsapp"). The link is tied to the CURRENT event and can carry UTM tags (lowercase, url-safe) and a social share preview (title + one-line description). Requires ChottuLink to be connected for the client. After calling it, state the short URL shape + tags and tell the user to tap "Create link".',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Internal link name, e.g. "Tickets — Instagram bio".' },
        destinationUrl: { type: 'string', description: 'Full destination URL (https://…), e.g. the event\'s Howler page.' },
        path: { type: 'string', description: 'Optional custom short-URL path (letters/numbers/dashes), e.g. "summerfest-ig". Omit for an auto-generated code.' },
        utmSource: { type: 'string', description: 'Optional UTM source, e.g. instagram, whatsapp, email.' },
        utmMedium: { type: 'string', description: 'Optional UTM medium, e.g. social, bio, sms.' },
        utmCampaign: { type: 'string', description: 'Optional UTM campaign, e.g. the event slug.' },
        previewTitle: { type: 'string', description: 'Optional social share preview title (what WhatsApp/Facebook show), ≤ 60 chars.' },
        previewDescription: { type: 'string', description: 'Optional one-line share preview description, ≤ 100 chars.' },
      },
      required: ['name', 'destinationUrl'],
    },
  };

  // ── applyLinkTemplate (ACT) — DRAFT the one-click link set for the event ──
  async function runApplyLinkTemplate(args = {}, ctx = {}) {
    const { user, suiteId } = ctx;
    if (!user) return refuse('no_user', 'No authenticated user in context.');
    const entityId = entityFor(ctx);
    if (!entityId) return refuse('no_client', 'Open or pick a client first.');
    if (!suiteId) return refuse('no_event', 'Open an event first — the template creates that event\'s links.');
    const { chottu, cfg, err } = connected(entityId);
    if (err) return err;
    const templates = chottu.listTemplates(entityId);
    if (!templates.length) return refuse('no_templates', 'There are no link templates yet — create one under Engage → Links → Templates.');
    const wanted = String(args.templateName || '').trim().toLowerCase();
    const t = wanted
      ? templates.find((x) => x.name.toLowerCase() === wanted) || templates.find((x) => x.name.toLowerCase().includes(wanted))
      : (templates.length === 1 ? templates[0] : null);
    if (!t) return refuse('which_template', `Which template? Available: ${templates.map((x) => `"${x.name}"`).join(', ')}.`);
    // A bare Howler event id works too — the base URL is composed from it.
    const rawBase = String(args.baseUrl || '').trim();
    const digits = (rawBase.match(/event\/(\d+)/) || [])[1] || (rawBase.match(/^(\d+)$/) || [])[1];
    const base = digits ? `https://www.howler.co.za/event/${digits}` : rawBase;
    let resolved;
    try { resolved = chottu.resolveTemplate(entityId, t.id, { suiteId, base }); }
    catch (e) { return refuse('resolve_failed', e.expose ? e.message : 'Could not resolve the template.'); }
    const items = resolved.items.map((i) => ({ key: i.key, name: i.name, path: i.path, destination: i.destination, warnings: i.warnings }));
    const needsBase = !base && items.some((i) => i.warnings.some((w) => w.includes('{{base}}')));
    if (needsBase) return refuse('no_base', 'I need the event\'s page URL (e.g. https://www.howler.co.za/event/40848) — the template builds every destination from it.');
    return {
      ok: true,
      confirm: true,
      action: {
        kind: 'applyChottuTemplate', entityId, suiteId,
        templateId: t.id, templateName: t.name, base,
        domain: cfg.domain, items,
        summary: `${items.length} links from "${t.name}"`,
      },
    };
  }
  const applyLinkTemplateSchema = {
    name: 'applyLinkTemplate',
    description:
      'DRAFT the full deep-link set for the CURRENT event from a saved link template (e.g. "Standard event set" creates the main link + ticket wallet + lineup + map + event feed + chat in one go), for the user to confirm — you do NOT create them; they tap the button. Use when the user wants "all the links" / "the standard links" / "the link set" for an event. Needs the event\'s public page URL (baseUrl) when the template builds destinations from it — ask for it if you don\'t have it. After calling it, list the links it will create (paths + any warnings) and tell the user to confirm.',
    input_schema: {
      type: 'object',
      properties: {
        templateName: { type: 'string', description: 'Which template to apply (fuzzy-matched). Omit if there is only one.' },
        baseUrl: { type: 'string', description: 'The event\'s public page URL (https://www.howler.co.za/event/40848) or just its Howler event id (40848) — fills every {{base}} destination in the template.' },
      },
    },
  };

  return {
    createLink: { schema: createLinkSchema, run: runCreateLink, menu: { cmd: 'link', label: 'Create a deep link', icon: '🔗', example: 'Make me a tickets link for the Instagram bio' } },
    applyLinkTemplate: { schema: applyLinkTemplateSchema, run: runApplyLinkTemplate },
  };
};
