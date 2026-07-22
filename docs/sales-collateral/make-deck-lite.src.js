const pptxgen = require('pptxgenjs');
const p = new pptxgen();
p.defineLayout({ name: 'W', width: 13.33, height: 7.5 });
p.layout = 'W';

const NAVY = '1A1A2E', NAVY2 = '2D2B55', RED = 'FF385C', ORANGE = 'FF6B35', PURPLE = '7C3AED', CYAN = '06B6D4', GREY = '55556D', LIGHT = 'FBFAFF';
const F = 'Segoe UI';

function gradBar(s, x, y, w, h) {
  s.addShape('rect', { x, y, w: w / 3, h, fill: { color: RED } });
  s.addShape('rect', { x: x + w / 3, y, w: w / 3, h, fill: { color: ORANGE } });
  s.addShape('rect', { x: x + (2 * w) / 3, y, w: w / 3, h, fill: { color: PURPLE } });
}
function footer(s, n) {
  s.addText([{ text: 'Pulse', options: { bold: true } }, { text: '  ·  flagship of the Howler Experience OS', options: {} }], { x: 0.5, y: 7.05, w: 5, h: 0.3, fontSize: 9, color: '9A97AD', fontFace: F });
  s.addText('howler-pulse-v2.onrender.com', { x: 5.5, y: 7.05, w: 3, h: 0.3, fontSize: 9, color: '9A97AD', align: 'center', fontFace: F });
  s.addText(String(n), { x: 12.3, y: 7.05, w: 0.6, h: 0.3, fontSize: 9, color: '9A97AD', align: 'right', fontFace: F });
}
function contentSlide(title, sub, color, n) {
  const s = p.addSlide();
  s.background = { color: 'FFFFFF' };
  s.addShape('rect', { x: 0, y: 0, w: 13.33, h: 1.15, fill: { color } });
  s.addText(title, { x: 0.5, y: 0.08, w: 11.5, h: 0.65, fontSize: 26, bold: true, color: 'FFFFFF', fontFace: F });
  s.addText(sub, { x: 0.52, y: 0.62, w: 12, h: 0.4, fontSize: 12, italic: true, color: 'FFFFFF', transparency: 12, fontFace: F });
  gradBar(s, 0, 1.15, 13.33, 0.045);
  footer(s, n);
  return s;
}

/* ---------- 1 · TITLE ---------- */
let s = p.addSlide();
s.background = { color: NAVY };
gradBar(s, 0, 0, 13.33, 0.12);
s.addImage({ path: 'howler-logo.png', x: 0.9, y: 0.55, w: 0.85, h: 0.85, rounding: true });
s.addText('HOWLER PRESENTS · PREPARED FOR MILK & COOKIES', { x: 0.9, y: 1.5, w: 10, h: 0.4, fontSize: 13, bold: true, charSpacing: 3, color: RED, fontFace: F });
s.addText([{ text: 'Pulse', options: { color: 'FFFFFF' } }, { text: '.', options: { color: RED } }], { x: 0.82, y: 1.9, w: 11, h: 1.5, fontSize: 80, bold: true, fontFace: F });
s.addText('Your event’s data, finally working for you.', { x: 0.9, y: 3.45, w: 11.5, h: 0.8, fontSize: 30, bold: true, color: 'D8D4F0', fontFace: F });
s.addText('Howler is the Experience Operating System for live events, and Pulse is our new flagship product: one white-label platform that turns your ticketing, cashless and web data into insight, action and results, in your brand, on your phone.', { x: 0.9, y: 4.5, w: 10.8, h: 1.1, fontSize: 15, color: 'A9A5C6', fontFace: F, lineSpacing: 22 });
gradBar(s, 0.9, 5.9, 3.2, 0.07);
s.addText('In brief · July 2026', { x: 0.9, y: 6.5, w: 5, h: 0.4, fontSize: 11, color: '6E6A8F', fontFace: F });

/* ---------- 2 · THE LOOP + DASHBOARD ---------- */
s = contentSlide('One living loop, not five disconnected tools', 'your data flows in, gets read for you, and turns into action and results', RED, 2);
const chips = ['📡 Your data flows in live', '🦉 The Owl reads it for you', '⚡ You act in one tap', '📈 Results come back measured'];
chips.forEach((c, i) => {
  const x = 0.55 + i * 3.22;
  s.addShape('roundRect', { x, y: 1.5, w: 2.85, h: 0.62, rectRadius: 0.31, fill: { color: LIGHT }, line: { color: 'ECE9F5', width: 1 } });
  s.addText(c, { x, y: 1.5, w: 2.85, h: 0.62, fontSize: 11.5, bold: true, color: NAVY, align: 'center', valign: 'middle', fontFace: F });
  if (i < 3) s.addText('→', { x: x + 2.82, y: 1.5, w: 0.45, h: 0.62, fontSize: 16, bold: true, color: 'A89DDD', align: 'center', valign: 'middle', fontFace: F });
});
s.addImage({ path: 'dash.png', x: 1.67, y: 2.5, w: 10.0, h: 2.82 });
s.addText('Live dashboards with the Owl one tap away. Screens are illustrative; the numbers are Milk & Cookies’ real Pulse data, pulled live on 9 July 2026.', { x: 1.67, y: 5.42, w: 10.0, h: 0.35, fontSize: 10, italic: true, color: GREY, align: 'center', fontFace: F });
s.addShape('roundRect', { x: 0.5, y: 6.05, w: 12.4, h: 0.7, rectRadius: 0.1, fill: { color: 'F6F1FF' } });
s.addText('“See what’s happening, act on it, and prove the results. The longer you use Pulse, the better it gets.”', { x: 0.8, y: 6.05, w: 11.8, h: 0.7, fontSize: 13.5, bold: true, italic: true, color: PURPLE, align: 'center', valign: 'middle', fontFace: F });

/* ---------- 3 · SIX THINGS ---------- */
s = contentSlide('Six things you’ll feel in the first month', 'what Pulse does for you, in plain terms', ORANGE, 3);
const six = [
  ['🌅', 'Wake up already knowing', 'A personal morning briefing and scheduled digests tell you what changed overnight and what’s worth doing about it.'],
  ['🦉', 'Ask your data anything', 'Your own AI analyst: in the app, on WhatsApp, even from ChatGPT or Claude. Grounded answers, only from your own data.'],
  ['⚡', 'Act in one tap', 'Reach exactly the right people with on-brand email and SMS, drafted for you, approved by you. Cohort to campaign in minutes.'],
  ['📣', 'Make your ads work harder', 'Send Pulse audiences to Meta and TikTok, keep them fresh automatically, and see what the spend actually returned.'],
  ['🎯', 'Prove the results', 'Set the target that matters, like your 18 000-ticket North Star, and every screen shows how you’re tracking.'],
  ['🎪', 'Own event night', 'A live command centre for gates, bars and devices, with a report to the team’s phones through the night.'],
];
six.forEach((c, i) => {
  const x = 0.5 + (i % 3) * 4.2, y = 1.5 + Math.floor(i / 3) * 2.55;
  s.addShape('roundRect', { x, y, w: 3.95, h: 2.35, rectRadius: 0.12, fill: { color: LIGHT }, line: { color: 'ECE9F5', width: 1 } });
  s.addText(c[0] + '  ' + c[1], { x: x + 0.2, y: y + 0.12, w: 3.55, h: 0.5, fontSize: 14.5, bold: true, color: NAVY, fontFace: F });
  s.addText(c[2], { x: x + 0.2, y: y + 0.68, w: 3.55, h: 1.55, fontSize: 11, color: GREY, fontFace: F, lineSpacing: 15, valign: 'top' });
});
s.addText('No exports. No stale lists. No tab-switching. One login.', { x: 0.5, y: 6.55, w: 12.4, h: 0.4, fontSize: 13, bold: true, italic: true, color: ORANGE, align: 'center', fontFace: F });

/* ---------- 4 · THE OWL, EVERYWHERE ---------- */
s = contentSlide('Meet the Owl: your analyst, everywhere', 'the same brain, whichever door your team walks through', PURPLE, 4);
s.addImage({ path: 'visrow.png', x: 1.77, y: 1.45, w: 9.8, h: 4.5 });
s.addText('Left to right: the morning briefing in the app, the Owl on WhatsApp, and the Pulse connector answering in ChatGPT and Claude, with Milk & Cookies’ real numbers.', { x: 1.77, y: 6.0, w: 9.8, h: 0.35, fontSize: 10, italic: true, color: GREY, align: 'center', fontFace: F });
s.addShape('roundRect', { x: 0.5, y: 6.45, w: 12.4, h: 0.5, rectRadius: 0.08, fill: { color: NAVY } });
s.addText('Only ever your data, and it quotes, it never invents.', { x: 0.8, y: 6.45, w: 11.8, h: 0.5, fontSize: 12, bold: true, color: 'D8D4F0', align: 'center', valign: 'middle', fontFace: F });

/* ---------- 5 · HOWLER ONE STACK ---------- */
s = contentSlide('The Howler One stack', 'one experience, one dataset, one partner, and Pulse is the brain of it', NAVY, 5);
const stack = [
  ['🎟', 'Ticketing', 'Ticket sales, access control and scanning: every buyer and every entry, captured from minute one.'],
  ['💳', 'Cashless Payments', 'Tap-to-pay across bars and vendors: faster queues, higher spend, zero cash risk.'],
  ['📱', 'SuperApp', 'The fan’s companion: tickets, top-ups, line-ups and offers, an ownable channel to every attendee.'],
  ['⭐', 'VIP Tables', 'Premium done properly: bookings, minimum spends and hosted service, managed and measured.'],
];
stack.forEach((c, i) => {
  const x = 0.5 + i * 3.15;
  s.addShape('roundRect', { x, y: 1.55, w: 2.95, h: 2.1, rectRadius: 0.1, fill: { color: LIGHT }, line: { color: 'ECE9F5', width: 1 } });
  s.addText(c[0] + ' ' + c[1], { x: x + 0.15, y: 1.65, w: 2.65, h: 0.5, fontSize: 13, bold: true, color: NAVY, fontFace: F });
  s.addText(c[2], { x: x + 0.15, y: 2.2, w: 2.65, h: 1.35, fontSize: 10.5, color: GREY, fontFace: F, lineSpacing: 14, valign: 'top' });
  s.addText('↓', { x: x + 1.18, y: 3.7, w: 0.6, h: 0.4, fontSize: 18, bold: true, color: 'A89DDD', align: 'center', fontFace: F });
});
s.addShape('roundRect', { x: 0.5, y: 4.2, w: 12.4, h: 1.3, rectRadius: 0.12, fill: { color: NAVY } });
s.addImage({ path: 'owl-mark.png', x: 0.8, y: 4.42, w: 0.86, h: 0.86 });
s.addText([
  { text: 'Pulse: the brain of the stack.  ', options: { bold: true, fontSize: 15, color: 'FFFFFF' } },
  { text: 'Every ticket, every tap at a bar, every SuperApp session and every VIP booking feeds one dataset, and Pulse turns that dataset into decisions.', options: { fontSize: 12, color: 'D8D4F0' } },
], { x: 1.9, y: 4.3, w: 10.7, h: 1.1, fontFace: F, valign: 'middle', lineSpacing: 17 });
s.addText('ONE STACK  ·  ONE DATASET  ·  ONE BRAND EXPERIENCE  ·  ONE PARTNER', { x: 0.5, y: 5.85, w: 12.4, h: 0.4, fontSize: 13, bold: true, color: NAVY2, align: 'center', charSpacing: 2, fontFace: F });

/* ---------- 6 · EVENT NIGHT ---------- */
s = contentSlide('Own event night', 'your whole operation, live, on your own venue plan', CYAN, 6);
s.addImage({ path: 'sitemap.png', x: 2.06, y: 1.5, w: 9.2, h: 3.11 });
s.addText('Every station pinned, heat showing where the crowd is spending right now, and a dark station flagged the moment its data stops flowing.', { x: 2.06, y: 4.66, w: 9.2, h: 0.35, fontSize: 10, italic: true, color: GREY, align: 'center', fontFace: F });
s.addShape('roundRect', { x: 0.5, y: 5.3, w: 12.4, h: 1.15, rectRadius: 0.1, fill: { color: 'F0FBFD' }, line: { color: CYAN, width: 1 } });
s.addText('“You’ll know a hotspot is forming, or a scanner has died, before anyone on the ground has to tell you. And through the night, a compact report lands on the team’s phones.”', { x: 0.9, y: 5.38, w: 11.6, h: 1.0, fontSize: 13.5, bold: true, italic: true, color: '0E7490', align: 'center', valign: 'middle', fontFace: F });

/* ---------- 7 · CTA ---------- */
s = p.addSlide();
s.background = { color: NAVY };
gradBar(s, 0, 0, 13.33, 0.12);
s.addImage({ path: 'howler-logo.png', x: 0.9, y: 0.55, w: 0.85, h: 0.85, rounding: true });
s.addText('Where to from here', { x: 0.9, y: 1.6, w: 11.5, h: 0.7, fontSize: 34, bold: true, color: 'FFFFFF', fontFace: F });
s.addText('You’re 188 tickets from the 18 000 North Star, and there are 3 396 abandoned carts sitting in Pulse waiting to be asked nicely.', { x: 0.9, y: 2.7, w: 11.2, h: 1.0, fontSize: 20, color: 'D8D4F0', fontFace: F, lineSpacing: 28 });
s.addText('Let’s close the goal together, live on your data.', { x: 0.9, y: 3.9, w: 11.2, h: 0.6, fontSize: 20, bold: true, color: ORANGE, fontFace: F });
s.addShape('roundRect', { x: 0.9, y: 5.0, w: 7.5, h: 0.75, rectRadius: 0.37, fill: { color: RED } });
s.addText('Book a live walkthrough with your Howler team  →', { x: 0.9, y: 5.0, w: 7.5, h: 0.75, fontSize: 16, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: F });
s.addText('howler-pulse-v2.onrender.com', { x: 0.9, y: 6.3, w: 6, h: 0.4, fontSize: 12, color: '6E6A8F', fontFace: F });

p.writeFile({ fileName: 'pulse-deck-lite.pptx' }).then(() => console.log('lite deck written'));
