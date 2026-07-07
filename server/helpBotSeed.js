// ─── Product-help knowledge seed (authored at source) ─────────────────────────
// The starter corpus for the Owl's product help (server/helpBot.js). Authored
// here as part of the change that ships it — version-controlled and reviewed in
// the PR — then applied once on boot. Each article's stable `slug` is recorded in
// the `help_seed_applied` setting, so re-deploys never duplicate an article nor
// resurrect one an admin has since edited or deleted. Admins can add/edit/remove
// articles at runtime (Admin → Product → Help knowledge) with no deploy — this is
// only the out-of-the-box baseline.
//
// `roles` (csv of role keys: owner/manager/marketing/finance/viewer/ops) boosts
// relevance for that role. `features` (csv) gates an article to accounts that
// HAVE the feature — e.g. `cashless` articles never surface for a non-cashless
// event. `deepLink` is the in-app screen path the Owl can point the user to.

const SEED = [
  {
    slug: 'getting-started',
    title: 'Getting started — a quick tour of Pulse',
    tags: 'overview getting-started tour navigation home basics intro',
    body: 'Pulse is your Experience OS — it turns your event data into insight, action and results. The left sidebar is how you move around: Home (your briefing + dashboards), Engage (email/SMS campaigns & audiences), Goals, Alerts, Inbox (messages with Howler), Digests, Settlements & Documents, and Settings. Your home page opens with an AI briefing of what matters right now, followed by your dashboards. Everything is scoped to your account and events automatically. Pulse is a mobile app too — tap "Add to Home Screen" to install it.',
    deepLink: '/',
  },
  {
    slug: 'dashboards',
    title: 'Reading your dashboards',
    tags: 'dashboards charts tiles kpis reports metrics data view drill',
    roles: 'owner,manager,marketing,finance,viewer',
    body: 'Dashboards show your KPIs, tables and charts, built from your live ticketing data. Open one from the left sidebar (Suites → Sets → Dashboards). Tap any tile for a per-tile AI insight ("Explain this") that reads the numbers for you. Many tiles let you drill through to the detail behind a number. Use the event/filter picker at the top to switch which event or period you\'re looking at. Dashboards are read-only for you — Howler builds and maintains them; ask your account manager for a change.',
    deepLink: '/',
  },
  {
    slug: 'ai-insights-owl',
    title: 'AI insights & asking the Owl',
    tags: 'ai owl insight ask question analyst chat data explain numbers',
    body: 'Pulse has AI woven throughout. Each dashboard tile has an "Explain this" insight, and your home briefing is AI-written. The Owl — your AI analyst in the chat — answers BOTH kinds of question in one place: your live DATA ("how are sales tracking?", "top ticket types?") and how to USE Pulse itself ("how do I set up a campaign?", "what\'s new?"). Just ask; the Owl works out which it is.',
    deepLink: '/ask',
  },
  {
    slug: 'engage-campaigns',
    title: 'Email & SMS campaigns (Engage)',
    tags: 'campaign email sms engage marketing send audience segment promo drip blast',
    roles: 'owner,manager,marketing',
    features: 'campaigns',
    body: 'Engage is the campaign engine. Go to Engage → Campaigns to build a data-driven email and/or SMS campaign: choose an audience (a saved segment or a dashboard tile), write the copy (AI can draft it and design an email banner), add a promo code and tracking, and send it through the approval workflow. Build reusable audiences under Engage → Segments. Campaigns track opens, clicks and conversions so you can see results.',
    deepLink: '/engage/campaigns',
  },
  {
    slug: 'abandoned-cart',
    title: 'Abandoned cart & win-back campaigns',
    tags: 'abandoned cart win-back drip sequence remarketing lapsed recover checkout automation',
    roles: 'owner,manager,marketing',
    features: 'campaigns',
    body: 'To win back people who started but didn\'t finish a purchase, set up a campaign in Engage → Campaigns. Build (or pick) an audience segment for that cohort under Engage → Segments, then create a campaign — you can add a drip sequence (a timed series of follow-ups) and a promo code as the incentive. Write the copy or have AI draft it, then send it through approval. Conversions are tracked so you can measure recovered sales.',
    deepLink: '/engage/campaigns',
  },
  {
    slug: 'goals',
    title: 'Goals & targets',
    tags: 'goals target north star pace forecast track progress objective',
    roles: 'owner,manager,marketing,finance',
    features: 'goals',
    body: 'Goals let you set a target (e.g. tickets sold or revenue) and track pace toward it, with a forecast of where you\'ll land. Open Goals from the sidebar, add a goal, pick the metric and target. The Owl can summarise how your goals are tracking. Goal types include simple targets, composition (mix/share) goals and "healthy range" bands.',
    deepLink: '/goals',
  },
  {
    slug: 'alerts',
    title: 'Alerts & notifications',
    tags: 'alert alarm threshold notify notification watch trigger monitor',
    roles: 'owner,manager,marketing,finance',
    features: 'alerts',
    body: 'Alerts watch a metric and notify you the moment it crosses a threshold you set (e.g. "tickets hit 1,000" or "revenue passes R1m"). Open Alerts from the sidebar to create one — pick the metric, the condition and how you want to be told (in-app/push by default, or email/SMS). You can also ask the Owl to draft an alert for you.',
    deepLink: '/alerts',
  },
  {
    slug: 'inbox-messaging',
    title: 'Inbox — messaging with Howler',
    tags: 'inbox message chat thread howler support notification reply announcement',
    body: 'The Inbox is your direct line to Howler — threaded messages with read/unread, replies and attachments, plus programmatic announcements. Open Inbox from the sidebar. You\'ll get in-app and push nudges for new messages (manage push in Settings).',
    deepLink: '/inbox',
  },
  {
    slug: 'digests',
    title: 'Scheduled digests',
    tags: 'digest email schedule recurring summary report subscribe weekly daily',
    roles: 'owner,manager,marketing,finance',
    features: 'digests',
    body: 'Digests are scheduled email summaries of your performance, written by AI and lensed to your role. Open Digests from the sidebar to set up a recurring (or one-off) digest — choose the cadence, who receives it, and the focus. Give feedback on a digest and Pulse learns your preferences over time.',
    deepLink: '/digests',
  },
  {
    slug: 'settlements-documents',
    title: 'Settlements & documents',
    tags: 'settlement document invoice pdf finance payout statement download',
    roles: 'owner,manager,finance',
    features: 'settlements',
    body: 'Settlements holds your event settlement reports — the original PDF plus a clean, readable breakdown. Open Settlements from the sidebar to view or download them. Related documents (invoices and other files Howler shares) live alongside them.',
    deepLink: '/settlements',
  },
  {
    slug: 'settings-branding',
    title: 'Settings, branding & integrations (self-service)',
    tags: 'settings branding logo colours integrations self-service manage account team profile notifications connect',
    roles: 'owner',
    features: 'settings',
    body: 'Under Settings you manage your own account: branding (logo, colours, email sender display name), integrations (e.g. connect Google Drive, Meta ads, Slack), notification preferences, and — if you\'re an Owner — your team and their roles. Many settings layer a client default with per-event overrides; a blank event field inherits your account default.',
    deepLink: '/settings',
  },
  {
    slug: 'roles-permissions',
    title: 'Roles & what you can do',
    tags: 'role permission access team member owner manager marketing finance viewer ops cant allowed',
    body: 'What you can do depends on your role. Owner: full access including branding, integrations and team. Manager: dashboards, digests and campaigns (no settings/team). Marketing: marketing dashboards and campaigns. Finance: revenue and settlement dashboards (no campaigns). Viewer: read-only dashboards. Event Ops: on-the-ground event operations only. If something is greyed out or missing, it\'s usually outside your role — an Owner can adjust access under Settings → Team.',
    deepLink: '/settings',
  },
  {
    slug: 'event-ops',
    title: 'Event Ops (on-the-day operations)',
    tags: 'event ops operations devices stations staff checkpoints gates entry logistics on-the-ground',
    roles: 'ops,owner,manager',
    body: 'Event Ops covers on-the-ground operations for event day — devices, stations, staff, checkpoints and issues. If it\'s enabled for your account, open Event Ops from the sidebar. It\'s a per-account opt-in; ask your Howler contact to turn it on if you don\'t see it.',
    deepLink: '/event-ops',
  },
  {
    slug: 'cashless',
    title: 'Cashless insights',
    tags: 'cashless spend top-up wallet rfid bar payments cashless-data',
    features: 'cashless',
    body: 'If your event runs cashless, Pulse can surface cashless spend and top-up data alongside your ticketing figures — in dashboards and when you ask the Owl. Ask the Owl about cashless spend, top-ups or bar performance to dig in.',
    deepLink: '/',
  },
  {
    slug: 'install-pwa',
    title: 'Install Pulse on your phone',
    tags: 'install pwa phone mobile home screen app notifications push add',
    body: 'Pulse is an installable app. On your phone, open Pulse in the browser and choose "Add to Home Screen" (Share menu on iPhone; the browser menu on Android). It then behaves like a native app and can send you push notifications for messages and alerts. Manage push under Settings.',
    deepLink: '/settings',
  },
  {
    slug: 'report-issue',
    title: 'Report a bug or suggest an idea',
    tags: 'report bug issue problem broken feedback idea suggestion feature request help contact',
    body: 'Found something broken or have an idea? Use "Report an issue" in the left sidebar to send a bug report or feature suggestion straight to the Howler product team — you can attach a screenshot. For anything else, your Howler account manager is your direct contact (and the Inbox is a quick way to reach them).',
    deepLink: '',
  },
];

// Apply the seed once per article slug. `helpApi.upsertArticle` is the mount()
// return; `db` records which slugs have been planted so we never duplicate,
// resurrect a deleted one, or clobber an admin edit.
function applySeed(db, helpApi) {
  if (!helpApi || !helpApi.upsertArticle) return;
  let applied;
  try { applied = new Set(JSON.parse(db.getSetting('help_seed_applied', '[]') || '[]')); } catch { applied = new Set(); }
  let added = 0;
  for (const a of SEED) {
    if (applied.has(a.slug)) continue;
    try { helpApi.upsertArticle({ ...a, source: 'seed', published: true }); applied.add(a.slug); added++; } catch { /* skip a bad seed row */ }
  }
  if (added) db.setSetting('help_seed_applied', JSON.stringify([...applied]));
  return added;
}

module.exports = { SEED, applySeed };
