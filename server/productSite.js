// ─── Product site: feature matrix + overview visibility + /sales ──────────────
// Disposable module owning the curated product catalogue (the feature matrix),
// the admin include/exclude controls over what the outside world sees, and the
// public sales website. An admin can hide any matrix section/feature or any
// `##` section of docs/PRODUCT_OVERVIEW_SALES.md — e.g. work still in flight or
// not ready for internal announcement — and every public surface (the /sales
// site, the rendered overview page, the public matrix API) respects it.
// Admin surfaces always see everything, with hidden items flagged.
// Remove the mount() line in index.js + this file (+ docs/pulse-sales*.html)
// to uninstall.

const fs = require('fs');
const path = require('path');

// ── The curated catalogue ──────────────────────────────────────────────────────
// Keep in step with docs/PRODUCT_OVERVIEW_SALES.md (statuses mirror its key:
// live ✅ · setup 🟡 · beta 🧪 · soon 🔜). Ids are stable handles the visibility
// settings point at — change a label freely, but keep the id.
const CATALOGUE = [
  { id: 'dashboards', emoji: '📊', title: 'Dashboards & insight', blurb: 'Your data, read for you — open the app and you already know what changed and what to do.', features: [
    ['dash.live', 'Live dashboards — KPIs, tables & charts on real ticketing/GA4 data', 'live'],
    ['dash.insight', 'Per-tile AI insight + follow-up questions', 'live'],
    ['dash.share', 'Share an insight or tile to email / WhatsApp / Slack', 'live'],
    ['dash.briefing', 'Personalised home briefing', 'live'],
    ['dash.pwa', 'Mobile-first, installable PWA with push notifications', 'live'],
    ['dash.templates', 'Shared dashboard templates + per-client bespoke versions', 'live'],
  ] },
  { id: 'owl', emoji: '🦉', title: 'The Owl — your AI analyst, everywhere', blurb: 'Two analysts, many doors: Pulse’s own native Owl — in the app, on WhatsApp, in the organizer portal, in Claude & ChatGPT — plus the embedded Inventive “Ask” analyst.', features: [
    // Pulse's own, home-built Owl (server/owlChat.js + friends) — not Inventive.
    ['owl.native', 'Native Pulse Owl — in-app chat analyst: charts, follow-up chips, “/” actions, prompt starters', 'beta'],
    ['owl.actions', 'Native Owl actions — set an alert, save a segment, draft a campaign from chat', 'beta'],
    ['owl.memory', 'Native Owl memory — client / event / personal layers, client self-service', 'beta'],
    ['owl.catalogue', 'Owl data catalogue — admin-curated fields + extra Looker explores (e.g. Cashless)', 'beta'],
    ['owl.whatsapp', 'Native Owl on WhatsApp — charts as images, reply buttons, scheduled updates', 'beta'],
    ['owl.portal', 'Native Owl inside the Howler organizer portal (one-iframe embed)', 'beta'],
    ['owl.fan', 'Fan Owl — a booking guide on the event’s own website', 'beta'],
    ['owl.autopilot', 'Agentic Owl auto-pilot — one-tap insight → campaign', 'live'],
    // The same native Owl reached through a connected AI assistant (MCP).
    ['owl.claude', 'The Owl in Claude — one-click MCP connect; answers + drafts, never sends', 'beta'],
    ['owl.chatgpt', 'The Owl in ChatGPT / OpenAI — custom connector, works with Deep Research', 'beta'],
    // A different product entirely: the embedded third-party Inventive analyst.
    ['owl.inventive', 'Inventive Owl (“Ask”) — separate embedded third-party analyst (needs Inventive key + per-client workspace)', 'beta'],
  ] },
  { id: 'digests', emoji: '✉️', title: 'Scheduled digests', blurb: 'A sharp, role-specific briefing in their inbox on schedule — they stay on top of the event without logging in.', features: [
    ['digest.roles', 'Role-written email digests (exec / marketing / finance / ops)', 'live'],
    ['digest.cadence', 'Configurable cadence & focus — AI-led or curated', 'live'],
    ['digest.tiles', 'Pinned/followed tiles rendered in the email (chart images & metric chips)', 'live'],
    ['digest.dual', 'Admin-managed + client self-service', 'live'],
    ['digest.whatsapp', 'Daily WhatsApp update (digest / goals / alerts) + team broadcast lists', 'beta'],
  ] },
  { id: 'inbox', emoji: '💬', title: 'Messaging inbox', blurb: 'Important notes, approvals and receipts in one place with a clear read/ack trail — no more chasing over WhatsApp and email.', features: [
    ['inbox.threads', 'Two-way client ↔ Howler threads (read/unread, attachments)', 'live'],
    ['inbox.ack', 'Must-acknowledge messages', 'live'],
    ['inbox.notify', 'In-app, web-push & email notifications', 'live'],
  ] },
  { id: 'settlements', emoji: '📄', title: 'Settlements & documents', blurb: 'Settlements clients can actually read — and now they file themselves: just CC the Owl.', features: [
    ['settle.pdf', 'Settlement PDF → interactive statement', 'live'],
    ['settle.docs', 'Event documents area', 'live'],
    ['settle.ingest', 'Owl auto-ingest — CC the Owl on the settlement email and it files itself', 'beta'],
  ] },
  { id: 'goals', emoji: '🎯', title: 'Goals — track the results that matter', blurb: 'Tell Pulse what success looks like and every screen shows how you’re tracking, how it compares to last time, and where you’ll land.', features: [
    ['goals.northstar', 'North Star + secondary goals with progress bars and a pace read', 'beta'],
    ['goals.forecast', 'Sell-curve pace, vs-last-time and a forecast landing on every card', 'beta'],
    ['goals.types', 'Goal types: hit a target / stay under a cap / healthy range / mix & split', 'beta'],
    ['goals.templates', 'Reusable goal templates (+ global templates published to every client)', 'beta'],
    ['goals.nudge', 'Weekly “your goals this week” push', 'beta'],
    ['goals.tags', 'Tag & group goals by operational area', 'beta'],
  ] },
  { id: 'alerts', emoji: '🔔', title: 'Alerts — told the moment a number matters', blurb: 'Stop watching dashboards — Pulse taps you on the shoulder the second a sell-out, milestone or low-stock moment happens.', features: [
    ['alerts.tile', 'Watch any KPI tile live — sold out / low stock / crosses a number', 'beta'],
    ['alerts.metric', 'Build a metric with filters (e.g. VIP tickets) — no tile needed', 'beta'],
    ['alerts.channels', 'Inbox + push / email / SMS, with cooldowns & quiet hours', 'beta'],
    ['alerts.strip', 'Live Pulse strip — alert fires + live momentum in the header', 'beta'],
  ] },
  { id: 'notices', emoji: '🚨', title: 'Status notices', blurb: 'If anything ever goes wrong, clients know before they have to ask — and see exactly when it’s fixed.', features: [
    ['notices.post', 'Status-page-style incidents — all clients or specific ones', 'live'],
    ['notices.timeline', 'A living timeline: updates + resolution', 'live'],
    ['notices.severity', 'Severity-driven notify (email / push / SMS + in-app banner)', 'live'],
  ] },
  { id: 'eventops', emoji: '🎪', title: 'Event Ops — live device logistics', blurb: 'Every device accounted for at event close — no spreadsheet, no “missing” unknowns, a full history of where each one went.', features: [
    ['ops.devices', 'Device & station inventory (bulk auto-numbering, scannable codes)', 'beta'],
    ['ops.scan', 'Scan to move — Hive ↔ stations, append-only audit trail', 'beta'],
    ['ops.issues', 'Liaison checks & issue log with resolutions', 'beta'],
    ['ops.live', 'Live overview — counts by state, open issues, recent activity', 'beta'],
  ] },
  { id: 'segments', emoji: '👥', title: 'Engage · Segments', blurb: 'Build the exact audience from your own data or a spreadsheet — combine lists, subtract a suppression list, and it stays live.', features: [
    ['seg.sources', 'Always-live audiences (tile / CSV / paste / Google Sheet)', 'live'],
    ['seg.matching', 'Column matching (email / name / mobile)', 'live'],
    ['seg.filters', 'Target on any column', 'live'],
    ['seg.combine', 'Multi-source combine (Union / Intersect / Exclude)', 'live'],
    ['seg.organise', 'Organise — link to an event, file in folders', 'live'],
  ] },
  { id: 'campaigns', emoji: '📣', title: 'Engage · Campaigns', blurb: 'Personalised, on-brand email + SMS to a precise audience — with approval gates and real tracking, all from the same data.', features: [
    ['camp.channels', 'Email, SMS or both to a segment / tile / list', 'live'],
    ['camp.copy', 'AI-drafted copy, branded templates, hero image', 'live'],
    ['camp.blocks', 'Email block builder — drag-to-order blocks, multi-column, saved templates', 'live'],
    ['camp.design', 'AI email design — full themed layouts, one-tap themes, AI banners', 'live'],
    ['camp.merge', 'Merge fields from any column', 'live'],
    ['camp.promo', 'Promo / discount codes', 'live'],
    ['camp.tracking', 'UTM + per-recipient open & click tracking', 'live'],
    ['camp.consent', 'Consent-aware (POPIA), one-click unsubscribe', 'live'],
    ['camp.approval', 'Approval workflow', 'live'],
    ['camp.caps', 'Send caps — per-client audience cap + a tighter SMS sub-cap', 'live'],
  ] },
  { id: 'drips', emoji: '🔁', title: 'Engage · Drip sequences', blurb: 'Set up an automated recovery sequence once — it catches new abandoners in real time, stops when they buy, and shows where people convert.', features: [
    ['drip.journeys', 'Multi-step journeys with delays', 'live'],
    ['drip.timing', 'Timing modes (fresh-abandonment / forward-from-send)', 'live'],
    ['drip.stop', 'Auto-stop on purchase or unsubscribe', 'live'],
    ['drip.waterfall', 'Journey waterfall (open / click / convert + drop-off)', 'live'],
  ] },
  { id: 'adsync', emoji: '📢', title: 'Engage · Ad audience sync', blurb: 'Turn a Pulse audience into a Meta/TikTok ad audience in a click — auto-synced, privacy-safe, visible without leaving Pulse.', features: [
    ['ads.push', 'Push a segment to Meta / TikTok Custom Audiences', 'setup'],
    ['ads.mirror', 'Mirror membership + daily auto-sync', 'setup'],
    ['ads.hash', 'Hashed identities before they leave Pulse', 'setup'],
    ['ads.hub', 'Ad audiences hub — connection health + live match sizes', 'live'],
  ] },
  { id: 'social', emoji: '📱', title: 'Social metrics', blurb: 'See how a client’s Facebook, Instagram and TikTok are really doing — next to their ticketing numbers, updating itself daily.', features: [
    ['social.accounts', 'Facebook / Instagram / TikTok organic stats in Pulse', 'setup'],
    ['social.grains', 'Account-level daily trends + per-post performance', 'setup'],
    ['social.page', 'Self-service Social page — 30-day trend, top posts, daily sync', 'setup'],
  ] },
  { id: 'api', emoji: '🔌', title: 'Pulse API & AI-agent access (MCP)', blurb: 'Your Pulse data isn’t locked in — read it from your own tools, or point an AI agent like Claude at it and ask in plain language.', features: [
    ['api.keys', 'Per-client, read-only API keys — named, revocable, self-service', 'beta'],
    ['api.rest', 'REST API /api/v1 — dashboards, live metrics, segments, campaigns, goals', 'beta'],
    ['api.query', 'Direct data queries — any curated measure × dimension, with filters', 'beta'],
    ['api.mcp', 'MCP server — works with Claude AND ChatGPT / OpenAI', 'beta'],
    ['api.oauth', 'One-click Connect (OAuth 2.1 + PKCE) — no key copying', 'beta'],
    ['api.rows', 'Row-level tile data — explicit per-key opt-in, fully audited', 'beta'],
    ['api.drafts', 'Connected Owl can draft segments & campaigns (drafts only — never sends)', 'beta'],
  ] },
  { id: 'branding', emoji: '🎨', title: 'White-label branding & integrations', blurb: 'It’s their brand, their accounts, their data — Howler just powers it.', features: [
    ['brand.look', 'Per-client branding — logo / colours / sender (+ dark-mode logo)', 'live'],
    ['brand.vanity', 'Vanity login page — the client’s own white-labelled sign-in URL', 'live'],
    ['brand.currency', 'Reporting currency per client (flows to every AI touch point)', 'live'],
    ['brand.language', 'AI copy language per client + per-campaign override', 'live'],
    ['brand.integrations', 'Looker / Anthropic keys · Email (Resend) · SMS (Clickatell)', 'live'],
    ['brand.ads', 'Meta / TikTok ad accounts', 'setup'],
    ['brand.slack', 'Slack — mirror inbox notifications into a client channel', 'setup'],
    ['brand.lock', 'Integration lock guard 🔒 + one-tap connect', 'live'],
    ['brand.support', 'Your Howler Support — assigned contacts under Settings → Team', 'live'],
  ] },
  { id: 'admin', emoji: '🛠️', title: 'Admin console (Howler internal)', blurb: 'One console to run every client — and a product board that turns feedback into shipped features.', features: [
    ['admin.core', 'Manage clients, sets/suites, tile library, AI, settlements, logins/roles', 'live'],
    ['admin.wizard', 'Client setup wizard — guided, step-by-step onboarding', 'live'],
    ['admin.preview', 'Preview as a client', 'live'],
    ['admin.audit', 'AI audit — “Everything the AI is told”', 'live'],
    ['admin.tickets', 'Product board — 💬 Report from any screen, AI-structured tickets', 'live'],
    ['admin.releases', 'Daily release notes, auto-drafted from commits', 'live'],
  ] },
  { id: 'trust', emoji: '🔐', title: 'Trust, security & scope', blurb: 'Every query is force-scoped to the client on the server — it can’t be bypassed and fails closed.', features: [
    ['trust.scope', 'Server-side multi-tenant scoping (fails closed)', 'live'],
    ['trust.popia', 'POPIA-minded consent + hashed ad sync', 'live'],
    ['trust.roles', 'Roles & permissions', 'live'],
    ['trust.secrets', 'Write-only secrets — Pulse never shows a stored value', 'live'],
  ] },
  { id: 'horizon', emoji: '🔭', title: 'On the horizon', blurb: 'Where Pulse goes next — for roadmap conversations, not promises.', features: [
    ['soon.conditional', 'Campaigns — conditional sequencing (branch a journey on open / click / purchase)', 'soon'],
    ['soon.portfolio', 'Portfolio / “all events” view', 'soon'],
    ['soon.tasks', 'Event tasks + AM cockpit', 'soon'],
    ['soon.channels', 'WhatsApp & Howler app-push message channels', 'soon'],
    ['soon.tiers', 'Packages / tiers with feature gating', 'soon'],
  ] },
];

const OVERVIEW_MD = path.join(__dirname, '../docs/PRODUCT_OVERVIEW_SALES.md');
const OVERVIEW_HTML = path.join(__dirname, '../docs/product-overview-sales.html');
const SALES_HTML = path.join(__dirname, '../docs/pulse-sales.html');
const SALES_FEATURES_HTML = path.join(__dirname, '../docs/pulse-sales-features.html');

// Stable slug for a `##` heading — survives status-emoji / punctuation edits.
function slugify(heading) {
  return String(heading)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[-0-9]+|-+$/g, '') || 'section';
}

// The doc's `##` sections, in order: [{ slug, title }].
function overviewSections(md) {
  const seen = new Set();
  const out = [];
  for (const line of String(md).split('\n')) {
    const m = /^## +(.+)$/.exec(line);
    if (!m) continue;
    let slug = slugify(m[1]);
    while (seen.has(slug)) slug += '-2'; // duplicate headings stay individually addressable
    seen.add(slug);
    out.push({ slug, title: m[1].trim() });
  }
  return out;
}

// Drop every hidden `##` section (heading through to the next `##`), then tidy
// any doubled-up `---` separators the removal leaves behind.
function filterOverviewMd(md, hiddenSlugs) {
  if (!hiddenSlugs.size) return md;
  const seen = new Set();
  let skipping = false;
  const kept = String(md).split('\n').filter((line) => {
    const m = /^## +(.+)$/.exec(line);
    if (m) {
      let slug = slugify(m[1]);
      while (seen.has(slug)) slug += '-2';
      seen.add(slug);
      skipping = hiddenSlugs.has(slug);
    }
    return !skipping;
  });
  return kept.join('\n').replace(/(\n---\n)(\s*\n)*(?=---\n)/g, '');
}

module.exports.mount = function mountProductSite(app, { db, auth }) {
  // Hidden ids live in one JSON setting: { sections: [], features: [], overview: [] }.
  const KEY = 'product_visibility';
  function readHidden() {
    let v = {};
    try { v = JSON.parse(db.getSetting(KEY, '') || '{}'); } catch { v = {}; }
    return {
      sections: new Set(Array.isArray(v.sections) ? v.sections : []),
      features: new Set(Array.isArray(v.features) ? v.features : []),
      overview: new Set(Array.isArray(v.overview) ? v.overview : []),
    };
  }
  function writeHidden(h) {
    db.setSetting(KEY, JSON.stringify({ sections: [...h.sections], features: [...h.features], overview: [...h.overview] }));
  }

  // The matrix as the public sees it: hidden sections/features simply don't exist.
  function publicMatrix() {
    const hidden = readHidden();
    return CATALOGUE
      .filter((s) => !hidden.sections.has(s.id))
      .map((s) => ({
        id: s.id, emoji: s.emoji, title: s.title, blurb: s.blurb,
        features: s.features.filter(([fid]) => !hidden.features.has(fid)).map(([fid, label, status]) => ({ id: fid, label, status })),
      }))
      .filter((s) => s.features.length > 0);
  }

  // ── Public surfaces ──────────────────────────────────────────────────────────
  // JSON that powers the sales site (and any other public rendering of the matrix).
  app.get('/api/product/site', (_req, res) => {
    let updatedAt = null;
    try { updatedAt = fs.statSync(OVERVIEW_MD).mtime.toISOString(); } catch { /* doc missing — omit */ }
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.json({ name: 'Pulse', tagline: 'The Experience OS for live events', updatedAt, sections: publicMatrix() });
  });

  // The living sales-overview page + its markdown source, with admin-hidden `##`
  // sections stripped before they reach the browser. (Moved here from index.js.)
  app.get(['/product-overview-sales', '/product-overview-sales.html'], (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(OVERVIEW_HTML);
  });
  app.get('/product-overview-sales.md', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.type('text/markdown; charset=utf-8');
    fs.readFile(OVERVIEW_MD, 'utf8', (err, md) => {
      if (err) return res.status(404).send('# Overview unavailable');
      res.send(filterOverviewMd(md, readHidden().overview));
    });
  });

  // The public Pulse sales website: a value-led story page at /sales (its Owl
  // channel cards + sections still honour the admin's Shown/Hidden choices),
  // and the full matrix on its own page at /sales/features.
  app.get(['/sales', '/sales.html', '/pulse-sales'], (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(SALES_HTML);
  });
  app.get(['/sales/features', '/sales/features.html', '/pulse-sales-features'], (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(SALES_FEATURES_HTML);
  });

  // ── Admin: the full picture + include/exclude toggles ────────────────────────
  app.get('/api/admin/product/matrix', auth.requireAdmin, (_req, res) => {
    const hidden = readHidden();
    let md = '';
    try { md = fs.readFileSync(OVERVIEW_MD, 'utf8'); } catch { md = ''; }
    res.json({
      sections: CATALOGUE.map((s) => ({
        id: s.id, emoji: s.emoji, title: s.title, blurb: s.blurb, hidden: hidden.sections.has(s.id),
        features: s.features.map(([fid, label, status]) => ({ id: fid, label, status, hidden: hidden.features.has(fid) })),
      })),
      overview: overviewSections(md).map((o) => ({ ...o, hidden: hidden.overview.has(o.slug) })),
    });
  });

  // Toggle one thing: { kind: 'section' | 'feature' | 'overview', id, hidden }.
  app.put('/api/admin/product/visibility', auth.requireAdmin, (req, res) => {
    const { kind, id, hidden } = req.body || {};
    const key = { section: 'sections', feature: 'features', overview: 'overview' }[kind];
    if (!key || !id) return res.status(400).json({ error: 'kind (section|feature|overview) and id are required' });
    if (kind === 'section' && !CATALOGUE.some((s) => s.id === id)) return res.status(404).json({ error: 'Unknown section' });
    if (kind === 'feature' && !CATALOGUE.some((s) => s.features.some(([fid]) => fid === id))) return res.status(404).json({ error: 'Unknown feature' });
    const h = readHidden();
    if (hidden) h[key].add(String(id)); else h[key].delete(String(id));
    writeHidden(h);
    res.json({ ok: true, hidden: { sections: [...h.sections], features: [...h.features], overview: [...h.overview] } });
  });

  return { publicMatrix, filterOverviewMd, overviewSections };
};

// Exposed for tests.
module.exports.CATALOGUE = CATALOGUE;
module.exports.slugify = slugify;
module.exports.overviewSections = overviewSections;
module.exports.filterOverviewMd = filterOverviewMd;
