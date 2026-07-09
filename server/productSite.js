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
const { allowInlineScripts } = require('./http'); // per-page CSP relax: these static docs carry their own inline <script>

// ── The curated catalogue ──────────────────────────────────────────────────────
// Keep in step with docs/PRODUCT_OVERVIEW_SALES.md (statuses mirror its key:
// live ✅ · setup 🟡 · beta 🧪 · soon 🔜). Ids are stable handles the visibility
// settings point at — change a label/desc freely, but keep the id.
// Each feature is [id, label, status, desc]: the label is the terse index line,
// the desc is the plain-language "what it does for you" shown on client surfaces
// (the in-app What's in Pulse grid and the /sales/features expandable rows).
const CATALOGUE = [
  { id: 'dashboards', emoji: '📊', title: 'Dashboards & insight', blurb: 'Your data, read for you - open the app and you already know what changed and what to do.', features: [
    ['dash.live', 'Live dashboards - KPIs, tables & charts on real ticketing/GA4 data', 'live',
      'Your ticket sales, revenue and web traffic in one place, updating live - no more waiting for a weekly report.'],
    ['dash.insight', 'Per-tile AI insight + follow-up questions', 'live',
      'Tap any chart and Pulse explains what it means in plain language - then ask follow-up questions right there.'],
    ['dash.share', 'Share an insight or tile to email / WhatsApp / Slack', 'live',
      'Send any chart or insight to your team on email, WhatsApp or Slack in two taps.'],
    ['dash.briefing', 'Personalised home briefing', 'live',
      'The first thing you see when you open Pulse: a short briefing on what moved overnight and what deserves attention.'],
    ['dash.pwa', 'Mobile-first, installable PWA with push notifications', 'live',
      'Install Pulse on your phone like an app and get push notifications - it’s built for the phone first.'],
    ['dash.templates', 'Shared dashboard templates + per-client bespoke versions', 'live',
      'Proven dashboard layouts shared across events, plus bespoke versions built for the way you work.'],
  ] },
  { id: 'owl', emoji: '🦉', title: 'The Owl - your AI analyst, everywhere', blurb: 'Two analysts, many doors: Pulse’s own native Owl - in the app, on WhatsApp, in the organizer portal, in Claude & ChatGPT - plus the embedded Inventive “Ask” analyst.', features: [
    // Pulse's own, home-built Owl (server/owlChat.js + friends) - not Inventive.
    ['owl.native', 'Native Pulse Owl - in-app chat analyst: charts, follow-up chips, “/” actions, prompt starters', 'beta',
      'Ask anything about your event in plain language - “how did VIP sell this weekend?” - and get an answer with a chart.'],
    ['owl.actions', 'Native Owl actions - set an alert, save a segment, draft a campaign from chat', 'beta',
      'The Owl doesn’t just answer - from the same chat it can set an alert, save an audience or draft a campaign for you.'],
    ['owl.memory', 'Native Owl memory - client / event / personal layers, client self-service', 'beta',
      'The Owl remembers your event context and preferences, so answers get sharper over time - and you control what it remembers.'],
    ['owl.catalogue', 'Owl data catalogue - admin-curated fields + extra Looker explores (e.g. Cashless)', 'beta',
      'We curate exactly which data the Owl can see, so its answers stay accurate and on-topic - and can add extra sources like cashless.'],
    ['owl.whatsapp', 'Native Owl on WhatsApp - charts as images, reply buttons, scheduled updates', 'beta',
      'The same analyst in WhatsApp - ask questions, get charts back as images, and schedule regular updates.'],
    ['owl.portal', 'Native Owl inside the Howler organizer portal (one-iframe embed)', 'beta',
      'Ask the Owl without leaving the Howler organizer portal - it lives right inside it.'],
    ['owl.fan', 'Fan Owl - a booking guide on the event’s own website', 'beta',
      'A friendly booking guide on your event’s own website that helps fans pick and buy the right ticket.'],
    ['owl.autopilot', 'Agentic Owl auto-pilot - one-tap insight → campaign', 'live',
      'The Owl spots an opportunity in your numbers and turns it into a ready-to-review campaign in one tap.'],
    // The same native Owl reached through a connected AI assistant (MCP).
    ['owl.claude', 'The Owl in Claude - one-click MCP connect; answers + drafts, never sends', 'beta',
      'Connect Pulse to Claude with one click and ask about your data there - it answers and drafts, but never sends anything.'],
    ['owl.chatgpt', 'The Owl in ChatGPT / OpenAI - custom connector, works with Deep Research', 'beta',
      'The same connection for ChatGPT - ask about your event data in the assistant you already use, Deep Research included.'],
    // A different product entirely: the embedded third-party Inventive analyst.
    ['owl.inventive', 'Inventive Owl (“Ask”) - separate embedded third-party analyst (needs Inventive key + per-client workspace)', 'beta',
      'An additional embedded analyst (“Ask”) for deep ad-hoc analysis, available on request.'],
  ] },
  { id: 'digests', emoji: '✉️', title: 'Scheduled digests', blurb: 'A sharp, role-specific briefing in their inbox on schedule - they stay on top of the event without logging in.', features: [
    ['digest.roles', 'Role-written email digests (exec / marketing / finance / ops)', 'live',
      'A short email briefing written for your role - exec, marketing, finance or ops - so everyone gets their version of the story.'],
    ['digest.cadence', 'Configurable cadence & focus - AI-led or curated', 'live',
      'You choose how often it lands and what it focuses on - AI-led or hand-curated.'],
    ['digest.tiles', 'Pinned/followed tiles rendered in the email (chart images & metric chips)', 'live',
      'The charts and numbers you follow, rendered right inside the email - stay on top of the event without logging in.'],
    ['digest.dual', 'Admin-managed + client self-service', 'live',
      'We can set your digests up for you, or you manage them yourself in Settings - your choice.'],
    ['digest.whatsapp', 'Daily WhatsApp update (digest / goals / alerts) + team broadcast lists', 'beta',
      'Your key numbers in WhatsApp every morning, with team broadcast lists so everyone stays in the loop.'],
  ] },
  { id: 'inbox', emoji: '💬', title: 'Messaging inbox', blurb: 'Important notes, approvals and receipts in one place with a clear read/ack trail - no more chasing over WhatsApp and email.', features: [
    ['inbox.threads', 'Two-way client ↔ Howler threads (read/unread, attachments)', 'live',
      'A direct line between your team and Howler - threads with attachments and a clear read trail, instead of scattered emails.'],
    ['inbox.ack', 'Must-acknowledge messages', 'live',
      'For the messages that really matter, ask for an acknowledgement - and see exactly who has confirmed.'],
    ['inbox.notify', 'In-app, web-push & email notifications', 'live',
      'New messages reach you in the app, as a push notification and by email - nothing slips past.'],
  ] },
  { id: 'settlements', emoji: '📄', title: 'Settlements & documents', blurb: 'Settlements clients can actually read - and now they file themselves: just CC the Owl.', features: [
    ['settle.pdf', 'Settlement PDF → interactive statement', 'live',
      'Your settlement PDF becomes an interactive statement you can actually read and drill into.'],
    ['settle.docs', 'Event documents area', 'live',
      'All your event documents in one tidy place, filed per event.'],
    ['settle.ingest', 'Owl auto-ingest - CC the Owl on the settlement email and it files itself', 'beta',
      'CC the Owl on the settlement email and it files itself into Pulse - no uploading, no chasing.'],
  ] },
  { id: 'goals', emoji: '🎯', title: 'Goals - track the results that matter', blurb: 'Tell Pulse what success looks like and every screen shows how you’re tracking, how it compares to last time, and where you’ll land.', features: [
    ['goals.northstar', 'North Star + secondary goals with progress bars and a pace read', 'beta',
      'Tell Pulse what success looks like - one North Star plus supporting goals - and every screen shows how you’re tracking.'],
    ['goals.forecast', 'Sell-curve pace, vs-last-time and a forecast landing on every card', 'beta',
      'Every goal card shows your sales pace, how it compares to last time, and where you’ll land at this rate.'],
    ['goals.types', 'Goal types: hit a target / stay under a cap / healthy range / mix & split', 'beta',
      'Goals that fit how you actually work: hit a target, stay under a cap, keep a healthy range, or manage a mix.'],
    ['goals.templates', 'Reusable goal templates (+ global templates published to every client)', 'beta',
      'Set goals up once and reuse them for every event - including proven templates we publish for everyone.'],
    ['goals.nudge', 'Weekly “your goals this week” push', 'beta',
      'A short “your goals this week” nudge so targets stay top of mind.'],
    ['goals.tags', 'Tag & group goals by operational area', 'beta',
      'Group goals by area - marketing, bar, gate - so each owner sees theirs.'],
  ] },
  { id: 'alerts', emoji: '🔔', title: 'Alerts - told the moment a number matters', blurb: 'Stop watching dashboards - Pulse taps you on the shoulder the second a sell-out, milestone or low-stock moment happens.', features: [
    ['alerts.tile', 'Watch any KPI tile live - sold out / low stock / crosses a number', 'beta',
      'Watch any number live - sold out, low stock, crossing a milestone - and get pinged the second it happens.'],
    ['alerts.metric', 'Build a metric with filters (e.g. VIP tickets) - no tile needed', 'beta',
      'Alert on exactly what you care about - e.g. just VIP tickets - even if no dashboard tile shows it.'],
    ['alerts.channels', 'Inbox + push / email / SMS, with cooldowns & quiet hours', 'beta',
      'Alerts arrive where you want them - inbox, push, email or SMS - with quiet hours and cooldowns so they never spam.'],
    ['alerts.strip', 'Live Pulse strip - alert fires + live momentum in the header', 'beta',
      'A live strip in the app header showing fresh alerts and sales momentum at a glance.'],
  ] },
  { id: 'notices', emoji: '🚨', title: 'Status notices', blurb: 'If anything ever goes wrong, clients know before they have to ask - and see exactly when it’s fixed.', features: [
    ['notices.post', 'Status-page-style incidents - all clients or specific ones', 'live',
      'If anything goes wrong, you hear it from us first - status updates posted straight into Pulse.'],
    ['notices.timeline', 'A living timeline: updates + resolution', 'live',
      'Every incident keeps a living timeline from first update to resolution - you always know where things stand.'],
    ['notices.severity', 'Severity-driven notify (email / push / SMS + in-app banner)', 'live',
      'Serious issues notify you immediately by email, push or SMS, plus a banner in the app.'],
  ] },
  { id: 'eventops', emoji: '🎪', title: 'Event Ops - live device logistics', blurb: 'Every device accounted for at event close - no spreadsheet, no “missing” unknowns, a full history of where each one went.', features: [
    ['ops.devices', 'Device & station inventory (bulk auto-numbering, scannable codes)', 'beta',
      'Every scanner and card machine in a live inventory - bulk-numbered and scannable.'],
    ['ops.scan', 'Scan to move - Hive ↔ stations, append-only audit trail', 'beta',
      'Move devices between the Hive and stations with a scan - every move logged, so nothing goes missing quietly.'],
    ['ops.issues', 'Liaison checks & issue log with resolutions', 'beta',
      'Liaison checks and issues logged with resolutions, so problems get closed, not forgotten.'],
    ['ops.live', 'Live overview - counts by state, open issues, recent activity', 'beta',
      'A live overview during the event: where every device is, open issues and recent activity.'],
  ] },
  { id: 'segments', emoji: '👥', title: 'Engage · Segments', blurb: 'Build the exact audience from your own data or a spreadsheet - combine lists, subtract a suppression list, and it stays live.', features: [
    ['seg.sources', 'Always-live audiences (tile / CSV / paste / Google Sheet)', 'live',
      'Build audiences from your own data, a CSV, a paste or a Google Sheet - and they stay live as new people qualify.'],
    ['seg.matching', 'Column matching (email / name / mobile)', 'live',
      'Pulse matches your columns (email, name, mobile) automatically - messy spreadsheets welcome.'],
    ['seg.filters', 'Target on any column', 'live',
      'Target on any column - ticket type, spend, city, anything in your data.'],
    ['seg.combine', 'Multi-source combine (Union / Intersect / Exclude)', 'live',
      'Combine audiences like sets: union, intersect or exclude - perfect for suppression lists.'],
    ['seg.organise', 'Organise - link to an event, file in folders', 'live',
      'Keep audiences tidy - link each to its event and file them in folders.'],
  ] },
  { id: 'campaigns', emoji: '📣', title: 'Engage · Campaigns', blurb: 'Personalised, on-brand email + SMS to a precise audience - with approval gates and real tracking, all from the same data.', features: [
    ['camp.channels', 'Email, SMS or both to a segment / tile / list', 'live',
      'Send email, SMS or both to exactly the audience you built - no exports, no list uploads to a third-party tool.'],
    ['camp.copy', 'AI-drafted copy, branded templates, hero image', 'live',
      'AI drafts the copy in your voice, on your branded template, hero image included.'],
    ['camp.blocks', 'Email block builder - drag-to-order blocks, multi-column, saved templates', 'live',
      'Build emails from drag-to-order blocks - multi-column layouts you can save as reusable templates.'],
    ['camp.design', 'AI email design - full themed layouts, one-tap themes, AI banners', 'live',
      'One tap re-themes the whole email - and AI can design full layouts and banners for you.'],
    ['camp.merge', 'Merge fields from any column', 'live',
      'Personalise with any column from your data - names, ticket types, order details.'],
    ['camp.promo', 'Promo / discount codes', 'live',
      'Drop promo or discount codes into any send.'],
    ['camp.tracking', 'UTM + per-recipient open & click tracking', 'live',
      'See exactly who opened and clicked, per recipient, with UTM tracking through to your analytics.'],
    ['camp.consent', 'Consent-aware (POPIA), one-click unsubscribe', 'live',
      'Consent-aware sending (POPIA) with one-click unsubscribe handled for you.'],
    ['camp.approval', 'Approval workflow', 'live',
      'Nothing sends without a sign-off - a clear approval step before every campaign goes out.'],
    ['camp.caps', 'Send caps - per-client audience cap + a tighter SMS sub-cap', 'live',
      'Guard rails on volume: a per-audience cap and a tighter SMS cap, so a mistake can’t become a mass send.'],
  ] },
  { id: 'drips', emoji: '🔁', title: 'Engage · Drip sequences', blurb: 'Set up an automated recovery sequence once - it catches new abandoners in real time, stops when they buy, and shows where people convert.', features: [
    ['drip.journeys', 'Multi-step journeys with delays', 'live',
      'Set up a sequence once - e.g. cart recovery - and it runs itself, step by step, on delays you choose.'],
    ['drip.timing', 'Timing modes (fresh-abandonment / forward-from-send)', 'live',
      'Choose how timing works: react to fresh abandonment in real time, or run forward from a send.'],
    ['drip.stop', 'Auto-stop on purchase or unsubscribe', 'live',
      'The moment someone buys or unsubscribes, the sequence stops for them automatically.'],
    ['drip.waterfall', 'Journey waterfall (open / click / convert + drop-off)', 'live',
      'See the journey as a waterfall - opens, clicks, conversions and where people drop off.'],
  ] },
  { id: 'adsync', emoji: '📢', title: 'Engage · Ad audience sync', blurb: 'Turn a Pulse audience into a Meta/TikTok ad audience in a click - auto-synced, privacy-safe, visible without leaving Pulse.', features: [
    ['ads.push', 'Push a segment to Meta / TikTok Custom Audiences', 'setup',
      'Turn any Pulse audience into a Meta or TikTok ad audience in a click. Connect your ad accounts once and it’s on.'],
    ['ads.mirror', 'Mirror membership + daily auto-sync', 'setup',
      'Audiences stay mirrored automatically - new buyers drop out of your “abandoned cart” ads on their own.'],
    ['ads.hash', 'Hashed identities before they leave Pulse', 'setup',
      'Identities are hashed before they leave Pulse - privacy-safe by design.'],
    ['ads.hub', 'Ad audiences hub - connection health + live match sizes', 'live',
      'One place to see connection health and live match sizes for every synced audience.'],
  ] },
  { id: 'social', emoji: '📱', title: 'Social metrics', blurb: 'See how a client’s Facebook, Instagram and TikTok are really doing - next to their ticketing numbers, updating itself daily.', features: [
    ['social.accounts', 'Facebook / Instagram / TikTok organic stats in Pulse', 'setup',
      'Your Facebook, Instagram and TikTok numbers next to your ticket sales - one story, one place.'],
    ['social.grains', 'Account-level daily trends + per-post performance', 'setup',
      'Daily account trends plus per-post performance, so you can see what content actually sells tickets.'],
    ['social.page', 'Self-service Social page - 30-day trend, top posts, daily sync', 'setup',
      'A Social page of your own: 30-day trend, top posts, refreshed daily.'],
  ] },
  { id: 'api', emoji: '🔌', title: 'Pulse API & AI-agent access (MCP)', blurb: 'Your Pulse data isn’t locked in - read it from your own tools, or point an AI agent like Claude at it and ask in plain language.', features: [
    ['api.keys', 'Per-client, read-only API keys - named, revocable, self-service', 'beta',
      'Create read-only API keys yourself - named, revocable, and scoped to your data only.'],
    ['api.rest', 'REST API /api/v1 - dashboards, live metrics, segments, campaigns, goals', 'beta',
      'Read your dashboards, live metrics, audiences, campaigns and goals from your own tools.'],
    ['api.query', 'Direct data queries - any curated measure × dimension, with filters', 'beta',
      'Query your data directly - any curated measure by any dimension, with filters.'],
    ['api.mcp', 'MCP server - works with Claude AND ChatGPT / OpenAI', 'beta',
      'Point Claude or ChatGPT at your Pulse data and ask questions in plain language.'],
    ['api.oauth', 'One-click Connect (OAuth 2.1 + PKCE) - no key copying', 'beta',
      'Connect your AI assistant with one click - no copying keys around.'],
    ['api.rows', 'Row-level tile data - explicit per-key opt-in, fully audited', 'beta',
      'Row-level data access is opt-in per key and fully audited - you stay in control.'],
    ['api.drafts', 'Connected Owl can draft segments & campaigns (drafts only - never sends)', 'beta',
      'A connected assistant can draft audiences and campaigns for you - drafts only; a person always approves and sends.'],
  ] },
  { id: 'branding', emoji: '🎨', title: 'White-label branding & integrations', blurb: 'It’s their brand, their accounts, their data - Howler just powers it.', features: [
    ['brand.look', 'Per-client branding - logo / colours / sender (+ dark-mode logo)', 'live',
      'Pulse wears your brand - logo (light and dark), colours and sender name on everything your team and fans see.'],
    ['brand.vanity', 'Vanity login page - the client’s own white-labelled sign-in URL', 'live',
      'Your own white-labelled sign-in page on your own URL.'],
    ['brand.currency', 'Reporting currency per client (flows to every AI touch point)', 'live',
      'Report in your currency - it flows through every screen, email and AI answer.'],
    ['brand.language', 'AI copy language per client + per-campaign override', 'live',
      'AI-written copy in your language, with a per-campaign override when you need it.'],
    ['brand.integrations', 'Looker / Anthropic keys · Email (Resend) · SMS (Clickatell)', 'live',
      'Your accounts under the hood - analytics, email and SMS - connected once and managed in Settings.'],
    ['brand.ads', 'Meta / TikTok ad accounts', 'setup',
      'Connect your Meta and TikTok ad accounts to unlock ad audience sync.'],
    ['brand.slack', 'Slack - mirror inbox notifications into a client channel', 'setup',
      'Mirror your Pulse inbox notifications into your team’s Slack channel.'],
    ['brand.lock', 'Integration lock guard 🔒 + one-tap connect', 'live',
      'Integrations lock once verified, with one-tap connect - no accidental breakage.'],
    ['brand.support', 'Your Howler Support - assigned contacts under Settings → Team', 'live',
      'Your assigned Howler contacts, right in Settings - you always know who to call.'],
  ] },
  { id: 'admin', emoji: '🛠️', title: 'Admin console (Howler internal)', blurb: 'One console to run every client - and a product board that turns feedback into shipped features.', features: [
    ['admin.core', 'Manage clients, sets/suites, tile library, AI, settlements, logins/roles', 'live',
      'Howler runs your whole setup from one console - events, dashboards, AI, settlements and logins.'],
    ['admin.wizard', 'Client setup wizard - guided, step-by-step onboarding', 'live',
      'A guided, step-by-step wizard so new clients are stood up consistently and fast.'],
    ['admin.preview', 'Preview as a client', 'live',
      'The team can see Pulse exactly as you see it, for faster support.'],
    ['admin.audit', 'AI audit - “Everything the AI is told”', 'live',
      'Every instruction the AI receives is auditable - nothing hidden in a black box.'],
    ['admin.tickets', 'Product board - 💬 Report from any screen, AI-structured tickets', 'live',
      'Report from any screen - a person and the AI turn it into a tracked ticket you can follow all the way to shipped.'],
    ['admin.releases', 'Daily release notes, auto-drafted from commits', 'live',
      'Daily release notes drafted automatically from the day’s work - you can always see what changed.'],
  ] },
  { id: 'trust', emoji: '🔐', title: 'Trust, security & scope', blurb: 'Every query is force-scoped to the client on the server - it can’t be bypassed and fails closed.', features: [
    ['trust.scope', 'Server-side multi-tenant scoping (fails closed)', 'live',
      'You only ever see your own data - enforced on the server, on every query, with no way around it.'],
    ['trust.popia', 'POPIA-minded consent + hashed ad sync', 'live',
      'Consent-aware messaging and hashed ad sync keep you on the right side of POPIA.'],
    ['trust.roles', 'Roles & permissions', 'live',
      'Fine-grained roles decide who on your team can see and do what.'],
    ['trust.secrets', 'Write-only secrets - Pulse never shows a stored value', 'live',
      'Keys and passwords are write-only - once saved, Pulse never displays them again.'],
  ] },
  { id: 'horizon', emoji: '🔭', title: 'On the horizon', blurb: 'Where Pulse goes next - for roadmap conversations, not promises.', features: [
    ['soon.conditional', 'Campaigns - conditional sequencing (branch a journey on open / click / purchase)', 'soon',
      'Branch a journey on behaviour - different follow-ups for openers, clickers and buyers.'],
    ['soon.portfolio', 'Portfolio / “all events” view', 'soon',
      'One view across every event you run - compare, spot patterns, plan the season.'],
    ['soon.tasks', 'Event tasks + AM cockpit', 'soon',
      'Event to-dos and an account-manager cockpit, so the work around the data lives here too.'],
    ['soon.channels', 'WhatsApp & Howler app-push message channels', 'soon',
      'Send campaigns by WhatsApp and app push, not just email and SMS.'],
    ['soon.tiers', 'Packages / tiers with feature gating', 'soon',
      'Clear packages so you can see what’s in your plan and what an upgrade unlocks.'],
  ] },
];

const OVERVIEW_MD = path.join(__dirname, '../docs/PRODUCT_OVERVIEW_SALES.md');
const OVERVIEW_HTML = path.join(__dirname, '../docs/product-overview-sales.html');
// v2 (2026-07) is the live site; the v1 pages (pulse-sales.html /
// pulse-sales-features.html) stay in docs/ as an instant rollback: point
// these two paths back at them and redeploy.
const SALES_HTML = path.join(__dirname, '../docs/pulse-sales-v2.html');
const SALES_FEATURES_HTML = path.join(__dirname, '../docs/pulse-sales-features-v2.html');
const MOCKUPS_DIR = path.join(__dirname, '../docs/mockups'); // "see it in motion" concept pages

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
        features: s.features.filter(([fid]) => !hidden.features.has(fid)).map(([fid, label, status, desc]) => ({ id: fid, label, status, desc: desc || '' })),
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
    allowInlineScripts(res); // static doc with its own inline script
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
    allowInlineScripts(res);
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(SALES_HTML);
  });
  app.get(['/sales/features', '/sales/features.html', '/pulse-sales-features'], (_req, res) => {
    allowInlineScripts(res);
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(SALES_FEATURES_HTML);
  });

  // "See it in motion" — the animated Experience OS concept pages (docs/mockups):
  // a switchable gallery at /sales/experience, each concept also standalone
  // (e.g. /sales/experience/pulse-data-flow.html). Public, like the rest of /sales.
  // The concept pages carry their own inline <script> (the animations), so they
  // need the same per-page CSP relax as the other static doc pages above.
  app.use('/sales/experience',
    (_req, res, next) => { allowInlineScripts(res); next(); },
    require('express').static(MOCKUPS_DIR, { index: 'index.html' }));

  // ── Admin: the full picture + include/exclude toggles ────────────────────────
  app.get('/api/admin/product/matrix', auth.requireAdmin, (_req, res) => {
    const hidden = readHidden();
    let md = '';
    try { md = fs.readFileSync(OVERVIEW_MD, 'utf8'); } catch { md = ''; }
    res.json({
      sections: CATALOGUE.map((s) => ({
        id: s.id, emoji: s.emoji, title: s.title, blurb: s.blurb, hidden: hidden.sections.has(s.id),
        features: s.features.map(([fid, label, status, desc]) => ({ id: fid, label, status, desc: desc || '', hidden: hidden.features.has(fid) })),
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
