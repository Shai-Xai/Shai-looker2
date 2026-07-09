const pptxgen = require('pptxgenjs');
const p = new pptxgen();
p.defineLayout({ name: 'W', width: 13.33, height: 7.5 });
p.layout = 'W';

const NAVY = '1A1A2E', NAVY2 = '2D2B55', RED = 'FF385C', ORANGE = 'FF6B35', PURPLE = '7C3AED', CYAN = '06B6D4', GREY = '55556D', LIGHT = 'FBFAFF', GREEN = '059669', AMBER = 'B45309';
const F = 'Segoe UI';

// gradient accent bar simulated with 3 blocks
function gradBar(s, x, y, w, h) {
  s.addShape('rect', { x, y, w: w / 3, h, fill: { color: RED } });
  s.addShape('rect', { x: x + w / 3, y, w: w / 3, h, fill: { color: ORANGE } });
  s.addShape('rect', { x: x + (2 * w) / 3, y, w: w / 3, h, fill: { color: PURPLE } });
}

function footer(s, n) {
  s.addText([{ text: 'Pulse', options: { bold: true } }, { text: '  ·  The Experience OS by Howler', options: {} }], { x: 0.5, y: 7.05, w: 5, h: 0.3, fontSize: 9, color: '9A97AD', fontFace: F });
  s.addText('howler-pulse-v2.onrender.com', { x: 5.5, y: 7.05, w: 3, h: 0.3, fontSize: 9, color: '9A97AD', align: 'center', fontFace: F });
  s.addText(String(n), { x: 12.3, y: 7.05, w: 0.6, h: 0.3, fontSize: 9, color: '9A97AD', align: 'right', fontFace: F });
}

// content slide scaffold: colored header band + title
function contentSlide(title, sub, color, n) {
  const s = p.addSlide();
  s.background = { color: 'FFFFFF' };
  s.addShape('rect', { x: 0, y: 0, w: 13.33, h: 1.15, fill: { color } });
  s.addText(title, { x: 0.5, y: 0.08, w: 9.5, h: 0.65, fontSize: 26, bold: true, color: 'FFFFFF', fontFace: F });
  s.addText(sub, { x: 0.52, y: 0.62, w: 12, h: 0.4, fontSize: 12, italic: true, color: 'FFFFFF', transparency: 12, fontFace: F });
  gradBar(s, 0, 1.15, 13.33, 0.045);
  footer(s, n);
  return s;
}

// feature bullet: bold lead + status chip + body
function feat(s, x, y, w, lead, status, body, statusColor) {
  const runs = [{ text: lead + '  ', options: { bold: true, color: NAVY } }];
  if (status) runs.push({ text: '[' + status + ']  ', options: { bold: true, fontSize: 9, color: statusColor || GREEN } });
  runs.push({ text: body, options: { color: GREY } });
  s.addText(runs, { x, y, w, h: 1.0, fontSize: 12, fontFace: F, valign: 'top', lineSpacing: 16 });
}

/* ---------- 1 · TITLE ---------- */
let s = p.addSlide();
s.background = { color: NAVY };
gradBar(s, 0, 0, 13.33, 0.12);
s.addText('HOWLER PRESENTS', { x: 0.9, y: 1.5, w: 8, h: 0.4, fontSize: 14, bold: true, charSpacing: 4, color: RED, fontFace: F });
s.addText([
  { text: 'Pulse', options: { color: 'FFFFFF' } },
  { text: '.', options: { color: RED } },
], { x: 0.82, y: 1.9, w: 11, h: 1.5, fontSize: 80, bold: true, fontFace: F });
s.addText('Your event’s data, finally working for you.', { x: 0.9, y: 3.45, w: 11.5, h: 0.8, fontSize: 30, bold: true, color: 'D8D4F0', fontFace: F });
s.addText('The Experience OS for event organisers — live dashboards, an AI analyst, and a full email/SMS campaign engine, all powered by the same governed data. Insight → action → results, in your brand, on your phone.', { x: 0.9, y: 4.5, w: 10.8, h: 1.1, fontSize: 15, color: 'A9A5C6', fontFace: F, lineSpacing: 22 });
gradBar(s, 0.9, 5.9, 3.2, 0.07);
s.addText('Sales deck · 2026', { x: 0.9, y: 6.5, w: 5, h: 0.4, fontSize: 11, color: '6E6A8F', fontFace: F });

/* ---------- 2 · THE PROBLEM ---------- */
s = contentSlide('The problem: five tools, zero loop', 'how event teams work today', NAVY, 2);
const probs = [
  ['📊', 'The BI tool', 'Shows you the problem, then leaves. Acting on it means exporting a CSV and switching apps.'],
  ['📧', 'The email tool', 'Audiences go stale the moment you upload them. No connection to live ticket sales.'],
  ['💬', 'The WhatsApp threads', 'Approvals, settlements and "did you see this?" scattered and lost across chats.'],
  ['🌙', 'Event night', 'You find out about the problem when the queue does — or the morning after.'],
];
probs.forEach((pr, i) => {
  const x = 0.5 + (i % 2) * 6.25, y = 1.6 + Math.floor(i / 2) * 2.3;
  s.addShape('roundRect', { x, y, w: 5.9, h: 2.0, rectRadius: 0.12, fill: { color: LIGHT }, line: { color: 'ECE9F5', width: 1 } });
  s.addText(pr[0] + '  ' + pr[1], { x: x + 0.25, y: y + 0.15, w: 5.4, h: 0.45, fontSize: 16, bold: true, color: NAVY, fontFace: F });
  s.addText(pr[2], { x: x + 0.25, y: y + 0.65, w: 5.4, h: 1.2, fontSize: 12.5, color: GREY, fontFace: F, lineSpacing: 18, valign: 'top' });
});
s.addText('Every tool sees a slice. Nobody sees the loop — and the data never learns.', { x: 0.5, y: 6.25, w: 12.3, h: 0.5, fontSize: 15, bold: true, italic: true, color: RED, align: 'center', fontFace: F });

/* ---------- 3 · THE LOOP ---------- */
s = contentSlide('Pulse is one loop that never stops turning', 'insight → action → results → improvement, on repeat', RED, 3);
const loop = [
  ['📡', 'Live data lands', 'Ticketing, cashless and GA4 flow in continuously. No exports, no spreadsheets.'],
  ['🦉', 'The Owl reads it', 'AI briefings and digests tell you what changed — and what to do about it.'],
  ['⚡', 'You act', 'Turn a suggestion into a branded email/SMS campaign to the exact segment, in a click.'],
  ['📈', 'Results come back', 'Opens, clicks, conversions and revenue tracked per recipient, straight into your dashboards.'],
  ['🔁', 'The loop tightens', 'Results shape the next briefing and the next suggested action. Every cycle is sharper.'],
];
loop.forEach((st, i) => {
  const x = 0.4 + i * 2.55;
  s.addShape('roundRect', { x, y: 1.9, w: 2.35, h: 3.3, rectRadius: 0.12, fill: { color: LIGHT }, line: { color: 'ECE9F5', width: 1 } });
  s.addText(st[0], { x, y: 2.1, w: 2.35, h: 0.6, fontSize: 28, align: 'center', fontFace: F });
  s.addText(st[1], { x: x + 0.12, y: 2.75, w: 2.11, h: 0.6, fontSize: 13.5, bold: true, color: NAVY, align: 'center', fontFace: F });
  s.addText(st[2], { x: x + 0.15, y: 3.35, w: 2.05, h: 1.7, fontSize: 10.5, color: GREY, align: 'center', fontFace: F, lineSpacing: 14, valign: 'top' });
});
s.addText('“It’s not dashboards and email and reports — it’s one living loop. The longer you use Pulse, the better it gets.”', { x: 1.2, y: 5.7, w: 10.9, h: 0.8, fontSize: 16, bold: true, italic: true, color: NAVY2, align: 'center', fontFace: F });

/* ---------- 4 · SEE ---------- */
s = contentSlide('👁  SEE — dashboards & AI insight', 'know what’s happening, without digging', RED, 4);
feat(s, 0.5, 1.55, 6.0, 'Live dashboards', 'LIVE', '— KPIs, tables and charts on your real ticketing & GA4 data, with drill-through. Mobile-first, installable as an app.');
feat(s, 0.5, 2.65, 6.0, 'Per-tile AI insight', 'LIVE', '— tap any tile and the Owl explains the numbers in plain English, grounded in that data.');
feat(s, 0.5, 3.75, 6.0, 'Personalised AI briefing', 'LIVE', '— land on a summary of what matters right now, tailored to what you follow and view.');
feat(s, 6.9, 1.55, 6.0, 'Scheduled digests', 'LIVE', '— role-specific email briefings (exec / marketing / finance / ops) on your cadence, with charts rendered in the email.');
feat(s, 6.9, 2.65, 6.0, 'Share any insight', 'LIVE', '— hand a finding to email, WhatsApp or Slack in one tap, with a link back to the view.');
feat(s, 6.9, 3.75, 6.0, 'Goals with pace & forecast', 'BETA', '— a North Star target on every screen: ahead / on-track / behind vs last event’s real sell-curve, with a projected landing.', PURPLE);
s.addShape('roundRect', { x: 0.5, y: 5.35, w: 12.4, h: 1.0, rectRadius: 0.1, fill: { color: 'F6F1FF' } });
s.addText('“Your data, read for you — open the app and you already know what changed and what to do.”', { x: 0.8, y: 5.45, w: 11.8, h: 0.8, fontSize: 15, bold: true, italic: true, color: PURPLE, align: 'center', valign: 'middle', fontFace: F });

/* ---------- 5 · ASK ---------- */
s = contentSlide('🦉  ASK — your AI Data Analyst, everywhere', 'plain-language answers, only ever from your own data', ORANGE, 5);
feat(s, 0.5, 1.55, 6.0, 'Ask the Owl in-app', 'BETA', '— “what’s on sale right now?”, “how does this compare to last year?” — conversational answers, scoped to your data.', PURPLE);
feat(s, 0.5, 2.75, 6.0, 'The Owl on WhatsApp', 'BETA', '— message it from your own WhatsApp: answers, charts as images, tappable follow-ups, daily updates — even draft a campaign by reply button.', PURPLE);
feat(s, 6.9, 1.55, 6.0, 'Reads your Google Drive', 'NEEDS SETUP', '— share budgets, marketing plans or sponsor decks; the Owl answers from them alongside live sales data.', AMBER);
feat(s, 6.9, 2.75, 6.0, 'Fan Owl on your website', 'BETA', '— a booking guide on your public event site: answers FAQs from your knowledge base, recommends the right ticket, links to your checkout, captures opted-in fans.', PURPLE);
s.addShape('roundRect', { x: 0.5, y: 4.4, w: 12.4, h: 1.6, rectRadius: 0.1, fill: { color: NAVY } });
s.addText('Grounded, always: the Owl quotes your data — it never invents. And it answers only your own events; the scope gate is enforced server-side and cannot be bypassed.', { x: 0.9, y: 4.55, w: 11.6, h: 1.3, fontSize: 14, color: 'D8D4F0', align: 'center', valign: 'middle', fontFace: F, lineSpacing: 20 });
s.addText('“Ask your data anything, in plain language — your own analyst, in your pocket.”', { x: 0.5, y: 6.25, w: 12.4, h: 0.5, fontSize: 15, bold: true, italic: true, color: ORANGE, align: 'center', fontFace: F });

/* ---------- 6 · ACT ---------- */
s = contentSlide('⚡  ACT — Engage, the campaign engine', 'from seeing a cohort to reaching it, in one click', PURPLE, 6);
feat(s, 0.5, 1.55, 6.0, 'Live segments', 'LIVE', '— audiences from a dashboard tile, CSV or linked Google Sheet; union / intersect / exclude (abandoned carts minus already-called). Always current at send time.');
feat(s, 0.5, 2.75, 6.0, 'Email & SMS campaigns', 'LIVE', '— AI-drafted copy, drag-and-drop block builder, AI-designed layouts & banners, merge fields, promo codes, full open/click tracking.');
feat(s, 0.5, 3.95, 6.0, 'Drip automations', 'LIVE', '— abandoned-cart journeys that catch new abandoners in real time, stop when someone buys, and show a per-step conversion waterfall.');
feat(s, 6.9, 1.55, 6.0, 'Owl auto-pilot', 'LIVE', '— one tap turns an AI suggestion into a drafted campaign; it still rides the normal review + approval gates.');
feat(s, 6.9, 2.75, 6.0, 'Approvals & consent built in', 'LIVE', '— nothing sends without explicit approval; POPIA-aware consent enforced per channel; send caps stop costly mistakes.');
feat(s, 6.9, 3.95, 6.0, 'Ad-platform sync', 'NEEDS CONNECTION', '— push a segment to Meta or TikTok as a Custom Audience (hashed, privacy-safe), auto-synced daily; see spend & ROAS next to ticket sales.', AMBER);
s.addShape('roundRect', { x: 0.5, y: 5.35, w: 12.4, h: 1.0, rectRadius: 0.1, fill: { color: 'F6F1FF' } });
s.addText('“Personalised, on-brand email + SMS to a precise audience — approval gates and real tracking, all from the same data.”', { x: 0.8, y: 5.45, w: 11.8, h: 0.8, fontSize: 15, bold: true, italic: true, color: PURPLE, align: 'center', valign: 'middle', fontFace: F });

/* ---------- 7 · RUN ---------- */
s = contentSlide('🎪  RUN — event day & operations', 'your control room, in your pocket', CYAN, 7);
feat(s, 0.5, 1.55, 6.0, 'Alerts', 'BETA', '— “tell me when VIP drops below 100”: Pulse watches the number and pings you via push, email or SMS the moment it crosses. Cooldowns and quiet hours — no spam.', PURPLE);
feat(s, 0.5, 2.85, 6.0, 'Live updates', 'BETA', '— while the event runs: a compact multi-metric report every 15–120 min — gates pace, bar revenue, top vendors, device health, % of last year — to inbox, push, SMS and WhatsApp.', PURPLE);
feat(s, 0.5, 4.15, 6.0, 'Messaging inbox', 'LIVE', '— a two-way client↔Howler inbox with read/acknowledge trails. Approvals stop living in scattered WhatsApps.');
feat(s, 6.9, 1.55, 6.0, 'Settlements that file themselves', 'LIVE', '— settlement PDFs become clean interactive statements; CC the Owl on the email and it checks the totals and publishes automatically.');
feat(s, 6.9, 2.85, 6.0, 'Event Ops', 'BETA', '— track every scanner, payment device and station live: scan to move, log issues, full audit trail. Every device accounted for at event close.', PURPLE);
feat(s, 6.9, 4.15, 6.0, 'Data health', 'BETA', '— know a scanner has stopped sending data before the queue does, with an AI diagnostics report you can forward to the network provider.', PURPLE);
s.addText('“On event night, Pulse becomes your control room in your pocket — a mini report every half hour.”', { x: 0.5, y: 5.9, w: 12.4, h: 0.5, fontSize: 15, bold: true, italic: true, color: CYAN, align: 'center', fontFace: F });

/* ---------- 8 · OWN ---------- */
s = contentSlide('🔒  OWN — white-label, security & openness', 'your brand, your accounts, your data', NAVY, 8);
feat(s, 0.5, 1.55, 6.0, 'Fully white-label', 'LIVE', '— your logo, colours and sender name everywhere; emails from your own domain once verified; even a vanity login page that feels like your product.');
feat(s, 0.5, 2.75, 6.0, 'Your language & currency', 'LIVE', '— AI insights, briefings, digests and campaign copy in your reporting currency and your choice of language.');
feat(s, 0.5, 3.95, 6.0, 'Open by design (API + AI agents)', 'BETA', '— read-only, per-client API keys; point Claude or ChatGPT at your data via MCP. Your data is never locked in.', PURPLE);
feat(s, 6.9, 1.55, 6.0, 'Watertight data scoping', 'LIVE', '— every query is force-filtered to your events server-side; it cannot be bypassed and fails closed. One client can never see another’s data.');
feat(s, 6.9, 2.75, 6.0, 'POPIA-minded by design', 'LIVE', '— per-channel consent, one-click unsubscribe, hashed identities for ad sync, no cross-client data pooling.');
feat(s, 6.9, 3.95, 6.0, 'Self-service, with backup', 'LIVE', '— manage everything yourself in Settings, or your Howler team does it for you. Your named contacts are one tap away.');
s.addShape('roundRect', { x: 0.5, y: 5.35, w: 12.4, h: 1.0, rectRadius: 0.1, fill: { color: 'F6F1FF' } });
s.addText('“It’s their brand, their accounts, their data — Howler just powers it.”', { x: 0.8, y: 5.45, w: 11.8, h: 0.8, fontSize: 15, bold: true, italic: true, color: NAVY2, align: 'center', valign: 'middle', fontFace: F });

/* ---------- 9 · WHY PULSE (comparison) ---------- */
s = contentSlide('Why Pulse — and not another tool', 'the honest comparison', RED, 9);
const rows = [
  [{ text: 'If you’re using…', options: { bold: true, color: NAVY2 } }, { text: 'The gap', options: { bold: true, color: NAVY2 } }, { text: 'What Pulse changes', options: { bold: true, color: NAVY2 } }],
  ['Looker / Tableau', 'You see the problem, then export a CSV and switch tools to act on it.', 'See it and act on it in the same governed place — campaign, approval, result.'],
  ['Mailchimp / Klaviyo', 'Audiences go stale the moment you upload them.', 'Audiences built from live ticketing data that re-resolve at send time.'],
  ['Email + WhatsApp threads', 'Approvals, settlements and “did you see this?” get lost.', 'One inbox with read/ack trails; settlements that file themselves.'],
  ['Gut feel on event night', 'You find out about problems when the queue does.', 'Alerts + live mini-reports every 30 minutes, on your phone.'],
];
s.addTable(rows.map(r => r.map(c => (typeof c === 'string' ? { text: c, options: { color: GREY } } : c))), {
  x: 0.5, y: 1.6, w: 12.4, colW: [2.9, 4.75, 4.75], fontSize: 13, fontFace: F,
  border: { type: 'solid', color: 'EFECF8', pt: 1 }, fill: { color: 'FFFFFF' },
  rowH: 0.8, valign: 'middle', margin: 0.12, autoPage: false,
});
s.addShape('rect', { x: 0.5, y: 1.6, w: 12.4, h: 0.5, fill: { color: 'F6F1FF', transparency: 40 }, line: { color: PURPLE, width: 1.5 } });
s.addText('Pulse isn’t another tool on the pile — it replaces the pile with a loop.', { x: 0.5, y: 6.15, w: 12.4, h: 0.5, fontSize: 16, bold: true, italic: true, color: RED, align: 'center', fontFace: F });

/* ---------- 10 · CTA ---------- */
s = p.addSlide();
s.background = { color: NAVY };
gradBar(s, 0, 0, 13.33, 0.12);
s.addText('The pitch, in one line', { x: 0.9, y: 1.5, w: 11.5, h: 0.7, fontSize: 34, bold: true, color: 'FFFFFF', fontFace: F });
s.addText('See what’s happening, act on it, and prove the results — on your phone, in your brand, without exporting to five tools.', { x: 0.9, y: 2.5, w: 11.2, h: 1.0, fontSize: 20, color: 'D8D4F0', fontFace: F, lineSpacing: 28 });
s.addText('Insight → action → results → improvement, on a loop, in one governed place.', { x: 0.9, y: 3.7, w: 11.2, h: 0.6, fontSize: 20, bold: true, color: ORANGE, fontFace: F });
s.addShape('roundRect', { x: 0.9, y: 4.9, w: 5.6, h: 0.75, rectRadius: 0.37, fill: { color: RED } });
s.addText('Ask your Howler AM for a live demo  →', { x: 0.9, y: 4.9, w: 5.6, h: 0.75, fontSize: 16, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: F });
s.addText('howler-pulse-v2.onrender.com', { x: 0.9, y: 6.3, w: 6, h: 0.4, fontSize: 12, color: '6E6A8F', fontFace: F });

p.writeFile({ fileName: 'pulse-pitch-deck.pptx' }).then(() => console.log('deck written'));
