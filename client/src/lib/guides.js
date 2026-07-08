// ─── Guided-learning content — SELF-CONTAINED, DISPOSABLE DATA ────────────────
// All the in-app walkthroughs live here as plain data so the copy can be edited
// without touching any logic. Three kinds, all rendered by <GuideModal>:
//   • the first-run "essentials" wizard (welcome → quick wins),
//   • a short walkthrough per onboarding task (keyed to the step `key`), and
//   • feature explainers for the things customers don't get at a glance
//     (the home page, tuning the briefing, pin vs follow, Owl insights).
//
// Each guide: { id, title, steps: [{ icon?, title, body, cta?: {label,to}, action? }] }.
// A `cta` is a "do it now" button that navigates (`to` is an in-app route); an
// `action` ('notifications' | 'install') is a one-touch button that does the
// thing in place. `skipIfDone: <onboarding step key>` drops the step from the
// welcome wizard when that task is already done. Keep copy short — read on a phone.

export const GUIDES = {
  // ── First-run welcome: the active essentials wizard ────────────────────────
  essentials: {
    id: 'essentials',
    title: 'Welcome to Pulse',
    steps: [
      {
        icon: '👋',
        title: "Let's get you set up",
        body: "Pulse turns your data into a daily read on what's happening — and lets you act on it. Three quick steps and you're going. You can skip any of them and finish later.",
      },
      {
        icon: '🎨',
        title: 'Make it yours',
        body: 'Add your logo and brand colour so your emails and the whole app look like you, not like us.',
        cta: { label: 'Add branding', to: '/settings?section=email' },
        skipIfDone: 'branding',
      },
      {
        icon: '👥',
        title: 'Bring your team',
        body: 'Invite the people who should have access and get your briefings. You choose what each person can see.',
        cta: { label: 'Invite team', to: '/settings?section=team' },
        skipIfDone: 'team',
      },
      {
        icon: '🔔',
        title: 'Stay in the loop',
        body: "Turn on notifications and we'll nudge your phone when something needs you — a new message, an approval, an alert — even when Pulse is closed.",
        action: 'notifications',
        skipIfDone: 'notifications',
      },
      {
        icon: '📲',
        title: 'Add Pulse to your phone',
        body: 'Install Pulse like an app — a home-screen icon, full screen, no browser bar. One tap below. (On iPhone, use Share → Add to Home Screen.)',
        action: 'install',
      },
      {
        icon: '⭐',
        title: 'Set a goal',
        body: 'Tell Pulse what success looks like — a ticket or revenue target for your event — and it shows how you’re tracking against it, everywhere you look.',
        cta: { label: 'Set a goal', to: '/?goals=new' },
        skipIfDone: 'goals',
      },
      {
        icon: '🚀',
        title: "You're set",
        body: "That's the essentials. The “Getting started” card on your home page tracks the rest, and the Owl will start briefing you on your data. Have a look around.",
        cta: { label: 'Go to home', to: '/' },
      },
    ],
  },

  // ── Per-task walkthroughs (keyed to onboarding step keys) ──────────────────
  branding: {
    id: 'branding',
    title: 'Add your branding',
    steps: [
      { icon: '🎨', title: 'Open Settings', body: 'Head to Settings, then the branding area.', cta: { label: 'Open branding', to: '/settings?section=email' } },
      { icon: '🖼', title: 'Upload your logo', body: 'Drop in your logo and pick your brand colour. Leave a field blank to inherit the default.' },
      { icon: '✨', title: 'See it everywhere', body: 'Your logo and colour then flow through the app and every email Pulse sends on your behalf.', cta: { label: 'Open branding', to: '/settings?section=email' } },
    ],
  },
  team: {
    id: 'team',
    title: 'Invite your team',
    steps: [
      { icon: '👥', title: 'Open Settings', body: 'Go to Settings to manage your team.', cta: { label: 'Open team', to: '/settings?section=team' } },
      { icon: '✉️', title: 'Invite by email', body: "Add a teammate's email and they'll get an invite to join your workspace." },
      { icon: '🔐', title: 'Choose what they see', body: 'Roles control access — give each person only what they need. They can receive briefings too.', cta: { label: 'Invite team', to: '/settings?section=team' } },
    ],
  },
  notifications: {
    id: 'notifications',
    title: 'Turn on notifications',
    steps: [
      { icon: '🔔', title: 'Allow notifications', body: "One tap and we'll ask your browser for permission — that's the only step.", action: 'notifications' },
      { icon: '📱', title: 'Why it helps', body: "We'll nudge your phone when something needs you — a new message, an approval, an alert — even when Pulse is closed." },
      { icon: '📲', title: 'Add it to your phone', body: 'Install Pulse to your home screen so it opens like a normal app and notifications land reliably. One tap below.', action: 'install' },
      { icon: '⚙️', title: 'Change your mind later', body: 'You can adjust or turn notifications off anytime in your browser or device settings.' },
    ],
  },
  digest: {
    id: 'digest',
    title: 'Set up your weekly briefing',
    steps: [
      { icon: '🗓', title: 'Open Digests', body: 'Go to Digests to schedule an automated briefing.', cta: { label: 'Open Digests', to: '/digests' } },
      { icon: '⏰', title: 'Pick a schedule', body: 'Choose how often and when it sends — say every Monday at 8am.' },
      { icon: '📧', title: 'It emails your team', body: "The Owl writes a briefing on your numbers and emails it to whoever you choose, on time, without you lifting a finger.", cta: { label: 'Open Digests', to: '/digests' } },
    ],
  },
  alerts: {
    id: 'alerts',
    title: 'Set up an alert',
    steps: [
      { icon: '🚨', title: 'Open Alerts', body: 'Go to Alerts to put a watcher on any number that matters to you.', cta: { label: 'Open Alerts', to: '/alerts' } },
      { icon: '🎯', title: 'Pick what to watch', body: 'Choose a dashboard tile or a raw metric — tickets sold, revenue, remaining stock — and set the threshold that should trigger you.' },
      { icon: '📲', title: 'Get told the moment it happens', body: 'When your number crosses the line, Pulse pings you — in-app and on your phone — so you can act while it still matters.', cta: { label: 'Open Alerts', to: '/alerts' } },
    ],
  },
  explore: {
    id: 'explore',
    title: 'Take a tour of your dashboards',
    steps: [
      { icon: '📊', title: 'Open a suite', body: 'Everything is organised as Suites → Sets → Dashboards in the sidebar. Tap below to jump straight into one.', cta: { label: 'Open a dashboard', to: 'first-dashboard' } },
      { icon: '👆', title: 'Get a feel', body: 'Explore the live tiles — charts, tables and headline numbers, all on your real data.' },
      { owl: true, title: 'Ask the Owl', body: 'Spot the 🦉 on a tile? Tap it for a plain-English read of what the numbers are saying.', cta: { label: 'Open a dashboard', to: 'first-dashboard' } },
    ],
  },
  segment: {
    id: 'segment',
    title: 'Create your first audience',
    steps: [
      { icon: '🎯', title: 'Open Segments', body: 'Go to Segments to build a reusable audience.', cta: { label: 'Open Segments', to: '/engage/segments' } },
      { icon: '📋', title: 'Pick your source', body: 'Build an audience from a dashboard tile (e.g. everyone who abandoned a cart) or paste a list.' },
      { icon: '♻️', title: 'Reuse it', body: 'Save it once and target it again and again in campaigns — it stays up to date with your data.', cta: { label: 'Open Segments', to: '/engage/segments' } },
    ],
  },
  campaign: {
    id: 'campaign',
    title: 'Launch your first campaign',
    steps: [
      { icon: '📣', title: 'Open Campaigns', body: 'Go to Campaigns to set one up.', cta: { label: 'Open Campaigns', to: '/engage/campaigns' } },
      { icon: '🎯', title: 'Choose an audience', body: 'Point it at a segment you built, then write your email or SMS.' },
      { icon: '📈', title: 'Send & track', body: "It runs through an approval step, then sends. You'll see opens, clicks and conversions roll in.", cta: { label: 'Open Campaigns', to: '/engage/campaigns' } },
    ],
  },
  channels: {
    id: 'channels',
    title: 'Connect Meta & TikTok',
    steps: [
      { icon: '🔗', title: 'Open Integrations', body: 'In Settings → Integrations, add your Meta and/or TikTok access token and account ID. You only need the platforms you actually use.', cta: { label: 'Open Integrations', to: '/settings?section=integrations' } },
      { icon: '🎯', title: 'Push your audiences', body: 'Once connected, any segment you build can sync to a Meta or TikTok Custom Audience — for ad targeting, or to exclude people who already converted.' },
      { icon: '🔒', title: 'Privacy built in', body: 'Emails and phone numbers are hashed before they ever leave Pulse. Sync a segment from Engage → Segments whenever you’re ready.', cta: { label: 'Open Integrations', to: '/settings?section=integrations' } },
    ],
  },

  owlchat: {
    id: 'owlchat',
    title: 'Ask the Owl a question',
    steps: [
      { owl: true, title: 'Meet your analyst', body: 'The Owl 🦉 is your on-demand data analyst. Ask it anything about your numbers in plain language — “how are ticket sales pacing?”, “which price type sells best?”' },
      { icon: '💬', title: 'Start anywhere', body: 'Tap the 🦉 on any tile or dashboard, or open a chat from your home page. It answers from your live data, never from guesswork.' },
      { icon: '🔁', title: 'Keep digging', body: 'It’s a conversation — ask “why?”, “compare to last month”, “and by gender?” and it keeps going.' },
    ],
  },
  whatsapp: {
    id: 'whatsapp',
    title: 'Chat to the Owl on WhatsApp',
    steps: [
      { icon: '💬', title: 'Your numbers, in your pocket', body: 'The same Owl that answers in Pulse can chat to you on WhatsApp — ask a question from anywhere and get the live answer back.' },
      { icon: '🔗', title: 'Get your number linked', body: 'Linking is done by your Howler team for security. Send them a message with the WhatsApp number you want connected.', cta: { label: 'Message the team', to: '/inbox' } },
      { icon: '🌅', title: 'Morning digests too', body: 'Once linked, you can also get your daily briefing dropped straight into WhatsApp.' },
    ],
  },
  connector: {
    id: 'connector',
    title: 'Connect Claude or ChatGPT',
    steps: [
      { icon: '🔌', title: 'Pulse inside your AI assistant', body: 'Connect Pulse to Claude or ChatGPT and your assistant can answer with your live event data — dashboards, campaigns, segments, goals.' },
      { icon: '🔑', title: 'Create a connector key', body: 'In Settings → Integrations, create an API key. That key is what you paste into Claude or ChatGPT as a connector.', cta: { label: 'Open Integrations', to: '/settings?section=integrations' } },
      { icon: '🤖', title: 'Add it in your assistant', body: 'In Claude: Settings → Connectors → Add custom connector. In ChatGPT: Settings → Connectors. Full step-by-steps live in the API guide linked next to your keys.' },
    ],
  },
  journey: {
    id: 'journey',
    title: 'Build your first journey',
    steps: [
      { icon: '🧭', title: 'What a journey is', body: 'A journey is a multi-step automation that reacts to what people do — e.g. email an abandoned cart, wait two days, then follow up differently for those who opened vs. those who didn’t.' },
      { owl: true, title: 'Ask the Owl to draft it', body: 'The fastest way: tell the Owl what you want (“win back abandoned carts with a 3-step journey”) and it drafts the whole tree — audience, copy and branches.', cta: { label: 'Open Journeys', to: '/engage/journeys' } },
      { icon: '✅', title: 'You stay in control', body: 'A journey is always a draft until you review and approve it. Nothing sends without your say-so.' },
    ],
  },

  goals: {
    id: 'goals',
    title: 'Set your event goals',
    steps: [
      { icon: '🎯', title: 'Open “Your goals”', body: 'On your home page, find the “Your goals” strip and tap “Set a goal.”', cta: { label: 'Set a goal', to: '/?goals=new' } },
      { icon: '📊', title: 'Track a live number', body: 'Pick a number you already watch on a dashboard — tickets sold, revenue — and the goal tracks it live, always matching the dashboard. Or enter a number yourself for things like sponsorship.' },
      { icon: '🏁', title: 'Set the target', body: 'Type what you’re aiming for and a deadline (event day by default), and choose how it shows — a bar, circle or dial.' },
      { owl: true, title: 'The North Star leads', body: 'Mark your headline goal as the North Star. Pulse then shows how you’re pacing — ahead, on track or behind — wherever you look.', cta: { label: 'Set a goal', to: '/?goals=new' } },
    ],
  },

  // ── Feature explainers (the "Learn" menu) ──────────────────────────────────
  home: {
    id: 'home',
    title: 'How your home page works',
    steps: [
      { owl: true, title: 'Your briefing', body: "At the top, the Owl writes a short read on what changed since your last visit. Tap ⚙ Tune to steer it, ↻ Refresh to regenerate, or ♥ / 👎 to tell it how it's doing." },
      { icon: '📌', title: 'Pinned & shortcuts', body: 'Tiles you pin appear in the Pinned row. Below, “Your shortcuts” surfaces the dashboards you open most often.' },
      { icon: '✨', title: 'Worth a look', body: 'The Owl suggests dashboards worth checking — and if you run campaigns, it can turn a suggestion straight into one.' },
      { icon: '🗂', title: 'Your suites', body: 'Everything lives in the sidebar as Suites → Sets → Dashboards. Tap a suite to dive in.' },
    ],
  },
  briefing: {
    id: 'briefing',
    title: 'Tune your briefing',
    steps: [
      { icon: '⚙️', title: 'Open Tune', body: 'On the briefing card, tap ⚙ Tune to open the controls.' },
      { icon: '🎯', title: 'Set your focus', body: "Add a standing note — e.g. “Always compare to last year” or “I care most about cashless spend per head.” The 🦉 Refine button sharpens your wording." },
      { icon: '👁', title: 'Followed tiles', body: 'Tiles you follow are always covered. You can also point the briefing at specific dashboards or tiles.' },
      { icon: '🗓', title: 'Event dates & phases', body: 'Set each event’s key dates so the Owl knows the phase — pre-sale, live, post-event — and words things accordingly.' },
      { icon: '💾', title: 'Save & regenerate', body: 'Hit “Save & regenerate” and your next briefing reflects every change.' },
    ],
  },
  pins: {
    id: 'pins',
    title: 'Pinning & following tiles',
    steps: [
      { icon: '⋯', title: 'Two little buttons', body: 'On any tile, hover it (or tap ⋯ on mobile) to reveal 📌 Pin and 👁 Follow.' },
      { icon: '📌', title: 'Pin = keep it on home', body: 'Pinning puts a live copy of that tile in the Pinned row on your home page, so it’s always a glance away.' },
      { icon: '👁', title: 'Follow = narrate it', body: 'Following tells the Owl to always cover that tile in your briefing, even when you’re not looking at it.' },
      { icon: '🤝', title: 'Use both', body: 'Pin what you want to see; follow what you want explained. They work independently.' },
    ],
  },
  install: {
    id: 'install',
    title: 'Install Pulse on your phone',
    steps: [
      { icon: '📲', title: 'Add it to your home screen', body: 'Install Pulse like a normal app — a home-screen icon, full screen, no browser bar. One tap below. (On iPhone, tap Share → Add to Home Screen.)', action: 'install' },
      { icon: '🔔', title: 'Turn on notifications', body: "While you're here — switch on notifications so we can nudge you when something needs you, even when Pulse is closed.", action: 'notifications' },
      { icon: '⚡', title: 'Why it’s better', body: 'The installed app opens instantly, runs full screen, and keeps you one tap from your data and your briefing.' },
    ],
  },
  insights: {
    id: 'insights',
    title: 'How Owl insights work',
    steps: [
      { owl: true, title: 'The Owl on a tile', body: 'Tap the 🦉 on any tile for a short, plain-English read of what its numbers are saying.' },
      { icon: '💬', title: 'Ask follow-ups', body: "It's a conversation — ask “why?”, “compare to last week”, or add your own context, and it answers." },
      { icon: '📋', title: 'Whole-dashboard summary', body: 'Tap the 🦉 at the top of a dashboard for a summary that reads across all its tiles at once.' },
      { icon: '✍️', title: 'Refine your writing', body: 'Anywhere you see the 🦉 Refine button, it sharpens wording you’ve written — like your briefing focus.' },
      { icon: '✅', title: 'Always grounded', body: 'Insights are generated by Claude from your live data. Verify important figures — the Owl phrases the numbers, it never invents them.' },
    ],
  },
};

// The feature explainers shown in the home "Learn" launcher (order matters).
export const FEATURE_GUIDES = [
  { id: 'home', icon: '🏠', label: 'How your home page works' },
  { id: 'briefing', owl: true, label: 'Tune your briefing' },
  { id: 'pins', icon: '📌', label: 'Pinning & following tiles' },
  { id: 'insights', owl: true, label: 'How Owl insights work' },
  { id: 'goals', icon: '🎯', label: 'Setting goals' },
  { id: 'install', icon: '📲', label: 'Install Pulse on your phone' },
];

export const getGuide = (id) => GUIDES[id] || null;
