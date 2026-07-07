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

  // ── Backfill: the platform to date (authored from docs/PRODUCT_OVERVIEW_SALES.md) ──
  {
    slug: 'home-briefing',
    title: 'Your home briefing — the Owl reads your account for you',
    tags: 'briefing home summary what changed since last visit worth a look morning tune phases event dates',
    body: 'Your home page opens with the Owl\'s briefing: what changed since your last visit, the headline story, and "Worth a look" cards that deep-link to the right dashboard. It knows your event\'s phase (pre-launch → launch → build-up → event day → post event) once the key dates are set, and adapts to the time of day. Tap the ⚙ Tune button on the briefing to set your event dates, current phase, and your personal focus (e.g. "always mention resale"). React with ♥ or 👎 (with a note), or tap 🔍 Investigate to ask Howler to dig into something — your note arrives with the exact briefing attached.',
    deepLink: '/',
  },
  {
    slug: 'pin-follow-tiles',
    title: 'Pin tiles to your home page & make the briefing cover them',
    tags: 'pin follow tiles home shortcut favourite watch briefing cover',
    body: 'Hover any dashboard tile (tap ⋯ on mobile): 📌 Pin puts the live tile on your home page in a swipeable strip — your vital signs at a glance. 👁 Follow tells the Owl it must cover that tile in every briefing, so the numbers you care about are never skipped.',
    deepLink: '/',
  },
  {
    slug: 'owl-depth-modes',
    title: 'Owl depth modes — Quick answers or Analyst deep-dives',
    tags: 'owl depth quick analyst operator deep dive dig deeper modes chat',
    body: 'The Owl chat has a Quick / Analyst toggle: Quick gives you the number fast; Analyst runs a proper multi-cut deep-dive and ends with a recommendation. Under any answer, tap "Dig deeper" to escalate it. Operator mode goes further — it analyses AND proactively drafts the single best next action (an alert, a segment, a campaign draft) for you to confirm.',
    deepLink: '/ask',
  },
  {
    slug: 'owl-actions',
    title: 'The Owl can set things up for you (always with your confirmation)',
    tags: 'owl actions create alert segment campaign draft link live update confirm button do things',
    body: 'Beyond answering questions, the Owl can DO things: set up an alert ("tell me when tickets hit 1000"), save a segment, draft an email/SMS campaign, create a branded short link, or set up an event-day live update. It asks the setup questions it needs, drafts the thing, and shows a ✅ Confirm button — nothing is created until you tap it, and a drafted campaign is still reviewed and sent by you in Engage. The Owl never sends anything to your buyers.',
    deepLink: '/ask',
  },
  {
    slug: 'owl-attachments-memory',
    title: 'Attach files to the Owl & what it remembers',
    tags: 'owl attach upload file sheet csv memory remember facts preferences',
    body: 'Use the 📎 attach button in the Owl chat to add a spreadsheet or CSV (e.g. your targets) — the Owl can then combine it with your live data ("uploaded target vs actual sold by event"). The Owl also remembers durable facts you confirm (your flagship event, how you define revenue, "keep answers short") and carries them into future chats. You can review and edit what it remembers in your settings.',
    deepLink: '/ask',
  },
  {
    slug: 'owl-whatsapp',
    title: 'Chat to the Owl on WhatsApp',
    tags: 'whatsapp owl phone chat message charts daily update team broadcast',
    body: 'The same Owl is reachable from your own WhatsApp: message Howler\'s WhatsApp number and ask in plain language — it recognises your number and answers only your client\'s data. Ask for a trend and it sends the chart as an image; every answer offers tappable follow-up buttons. You can get a daily WhatsApp update (your digest, condensed), subscribe a team broadcast list, and even set up alerts, segments or campaign drafts by reply button — always confirm-first, and campaign drafts are still sent from Engage in the app. Ask your Howler contact to link your phone number.',
    deepLink: '',
  },
  {
    slug: 'segments',
    title: 'Segments — build reusable audiences',
    tags: 'segments audience cohort buyers list target group vip city age guest list',
    body: 'Segments are saved audiences you can reuse across campaigns: build one from curated traits (ticket type, category, buyer city/country, age, gender, complimentary = guest list) under Engage → Segments, or just ask the Owl ("make a segment of VIP buyers in Cape Town"). Each segment shows its live size and per-channel reach (who can be emailed vs SMSed), can be linked to an event or folder, and refreshes against live data when used.',
    deepLink: '/engage/segments',
  },
  {
    slug: 'email-builder',
    title: 'Design campaign emails with the block builder',
    tags: 'email builder blocks design template columns banner theme layout drag drop',
    body: 'Campaign emails are built from blocks — text, image, button, divider, and multi-column layouts — with drag-to-reorder. Pick a visual theme for a consistent look, or let AI design a banner (or a whole themed email: ask the Owl to draft the campaign and it can design the full layout). Everything sends with your branding (logo, colour, sender display name) set up in Settings.',
    deepLink: '/engage/campaigns',
  },
  {
    slug: 'drip-sequences',
    title: 'Drip sequences — automated campaign series',
    tags: 'drip sequence automation series scheduled flow nurture follow up',
    body: 'Sequences send a series of messages automatically (e.g. announce → reminder → last-chance) to a segment, with per-step timing. Set one up under Engage, pick the audience and steps, and Pulse handles the sends — you can pause or adjust at any time. Every send respects the same consent and audience caps as one-off campaigns.',
    deepLink: '/engage',
  },
  {
    slug: 'deep-links',
    title: 'Branded short links into the Howler app',
    tags: 'links deep link short url tracking utm qr share bio chottulink click trends',
    body: 'Create branded short links (e.g. for an Instagram bio, poster QR or WhatsApp blast) under Engage → Links — tied to your event, with UTM tags, app-vs-browser behaviour and click tracking (clicks per day + by source on the 📈 view). Apply a link template to create the whole standard set for an event in one go (main page, ticket wallet, lineup, map…). You can also just ask the Owl ("make me a link for the bio tagged instagram"). Needs the ChottuLink connection — ask Howler if the Links tab says it isn\'t set up.',
    deepLink: '/engage/links',
  },
  {
    slug: 'live-updates',
    title: 'Live updates — an event-day pulse to your phone',
    tags: 'live update event day snapshot gates bar revenue pace whatsapp sms push recurring mini report',
    body: 'While your event runs, Pulse can send the team a compact multi-metric snapshot every 15–120 minutes: gates in (with change + pace/hour), bar revenue, top bars/vendors, device health, and optionally "% of last event by this point". Set it up under Alerts → Live updates (or ask the Owl to set one up): flip Go live manually or schedule a window, and pick channels — inbox, push, email, SMS, WhatsApp. There\'s a live preview and send-to-me while you set it up.',
    deepLink: '/alerts',
  },
  {
    slug: 'data-health',
    title: 'Data health — is your event\'s data flowing?',
    tags: 'data health devices offline stations stream monitor signal flow connectivity coverage',
    body: 'Data health watches whether your stations and devices are actually sending data during the event — per-station streams, a device roster with last-seen times, offline percentages, and a day timeline you can filter to one station. Find it in Event Ops (Data health tab). If a station goes dark, the assigned crew can be alerted automatically (push or WhatsApp) — ask Howler to set staff alerts up for your event.',
    deepLink: '/event-ops',
  },
  {
    slug: 'event-ops-staff',
    title: 'Event Ops for your crew — staff portal, checkpoints & custody',
    tags: 'event ops staff portal crew checkpoint custody hand device scan qr assign move issues',
    body: 'Every device at your event is trackable: pair it to a QR code, place it on the venue map, and hand it to a staff member (custody) so you always know where it is. Crew use the staff portal on their phones — scan a device to log a checkpoint (with photo), report or resolve issues, and move devices between stations. Staff with station alerts on get told the moment their station goes dark.',
    deepLink: '/event-ops',
  },
  {
    slug: 'google-drive',
    title: 'Let the Owl read your Drive files',
    tags: 'google drive files documents budget plan contract sheet integration connect share',
    body: 'Share the files your event runs on — budgets, marketing plans, contracts, sponsor decks — and the Owl answers from them alongside your live data ("what does the budget allow for stage hire, and what have we sold?"). Connect it under Settings → Integrations → Google Drive: you share specific files or folders (never your whole Drive) with Pulse\'s dedicated account, or use one-click Connect with Google. Sheets/CSVs become live tables the Owl can total; Docs and PDFs become searchable text it quotes exactly.',
    deepLink: '/settings',
  },
  {
    slug: 'paid-ads-meta',
    title: 'See your Meta ad performance inside Pulse',
    tags: 'meta facebook instagram ads paid spend roas clicks purchases performance advertising',
    body: 'Connect your Meta ad account (Settings → Integrations, or one-click Continue with Facebook) and Pulse shows your paid performance — spend, clicks, purchases, cost-per-click and ROAS, per campaign. Ask the Owl "how are my ads doing?" for the numbers in chat. Note: purchases are Meta-attributed pixel conversions, which won\'t match Howler ticket sales exactly.',
    deepLink: '/settings',
  },
  {
    slug: 'connect-ai-assistants',
    title: 'Connect Pulse to Claude, ChatGPT or Gemini',
    tags: 'claude chatgpt gemini grok connector mcp ai assistant connect integration external',
    body: 'You can plug Pulse into your own AI assistant: add Pulse as a connector in Claude, ChatGPT, Gemini or Grok (one-click OAuth connect) and the Owl answers there — same data, same scope: it only ever sees your own client\'s data, read-only, and anything it drafts still needs approval in Pulse. Ask your Howler contact for the connection guide for your assistant.',
    deepLink: '/settings',
  },
  {
    slug: 'api-access',
    title: 'Pulse API access for your developers',
    tags: 'api key developer integrate read data endpoint programmatic access token',
    body: 'Your developers can read your Pulse data programmatically via the read-only API (per-client API keys, scoped exactly like the app — only your own data). API access is off by default; ask Howler to enable it for your account, and they\'ll share the developer guide with your team. Keys are managed per entity and can be revoked any time.',
    deepLink: '/settings',
  },
  {
    slug: 'two-factor-auth',
    title: 'Protect your account with two-factor authentication',
    tags: '2fa two factor authentication security totp authenticator code backup login',
    body: 'Add a second factor to your login: in Settings, enrol with any authenticator app (scan the QR code), save your backup codes, and from then on logins ask for your 6-digit code. If you lose your device, a backup code gets you in — or your Howler contact can help reset it.',
    deepLink: '/settings',
  },
  {
    slug: 'whats-new',
    title: 'See what\'s new in Pulse',
    tags: 'whats new latest updates release notes changes features recent shipped',
    body: 'Ask the Owl "What\'s new in Pulse?" (there\'s a ✨ starter pill on the chat) and it summarises the latest published release notes, dated, tailored to your role — with pointers to the right screen to try each thing.',
    deepLink: '/ask',
  },
  {
    slug: 'dark-mode',
    title: 'Dark mode & display preferences',
    tags: 'dark mode theme light display appearance toggle night',
    body: 'Pulse has full dark mode, end to end — dashboards, tables, charts, settlements. Toggle it from your profile menu in the bottom-left of the sidebar. Your choice is remembered per device.',
    deepLink: '/',
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
