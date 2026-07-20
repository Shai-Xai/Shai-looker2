// ─── Shareable post page: GET /p/:id ─────────────────────────────────────────
// Extracted from server/social.js (line-budget split — the page is a
// self-contained HTML renderer with no coupling back into the feed logic).
// Mounted BY social.js at the end of its own mount with the closures the page
// needs; it owns no tables and no other routes. Contract:
// docs/specs/SOCIAL_CONTRACT.md §14 (share page) + §16c (CTA + attribution).
//
// The page: Open Graph tags so the link unfurls with a thumbnail + caption in
// WhatsApp/iMessage; renders a PUBLIC post for anyone (no app needed) with a
// Howler watermark overlay per media tile; device-aware store buttons; the
// post's own CTA when it has one. Private posts (members-only /
// ticket-targeted) and held/removed posts never leak content — they fall back
// to a generic get-the-app gate. Every hit is logged for share attribution
// (?s=<sharer howlerUserId>; unfurl crawlers tagged 'preview-bot').

const { asyncHandler } = require('./http');

const APP_STORE_IOS = 'https://apps.apple.com/za/app/id6742250654';
const APP_STORE_ANDROID = 'https://play.google.com/store/apps/details?id=co.za.howler.app';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

function mount(app, { sql, now, enabled, flagOn, getCommunity, mediaList, communityAvatar, communityBrand }) {
  app.get('/p/:id', asyncHandler(async (req, res) => {
    const host = typeof req.get === 'function' ? req.get('host') : '';
    const base = (process.env.PUBLIC_BASE_URL || (req.protocol && host ? `${req.protocol}://${host}` : '')).replace(/\/$/, '');
    const abs = (u) => (/^https?:\/\//.test(u) ? u : `${base}${u}`);
    const p = enabled() ? sql.prepare("SELECT * FROM social_feed_posts WHERE id=? AND status='published'").get(String(req.params.id)) : null;
    const c = p && getCommunity(p.community_id);
    const open = !!(p && c && c.status === 'active' && flagOn(p.entity_id) && c.visibility !== 'members' && !p.audience && p.moderation_status === 'visible');
    const media = open ? mediaList(p.media) : [];
    const firstImg = media.find((m) => m.kind !== 'video');
    const brand = open ? (c.name || 'Howler') : 'Howler';
    const caption = open ? String(p.body || '').slice(0, 200) : 'Open this post in the Howler app.';
    const ogImg = firstImg ? abs(firstImg.url) : '';
    const avatar = open && communityAvatar(c) ? abs(communityAvatar(c)) : '';
    // Howler watermark on every shared image/video (on the share page) — the
    // REAL Howler mark (same asset the branded emails use), not an emoji.
    // NOTE: this is an overlay on THIS page — burning it into the media pixels
    // (survives screenshots / re-shares) is a separate media-processing step.
    const logo = `${base}/email-howler.png`;
    const wm = `<div class="wm"><img class="wlogo" src="${esc(logo)}" alt=""/> <b>Howler</b></div>`;
    // The post's CTA rides the share page too: a web URL links straight out;
    // an in-app destination (explore_tickets:… etc.) routes to the store for
    // the visitor's device — the intent carries either way.
    const ctaDest = open ? String(p.cta_destination || '') : '';
    const ctaHref = ctaDest.startsWith('open_url:') ? ctaDest.slice('open_url:'.length) : '';
    const mediaHtml = !open ? ''
      : media.map((m) => (m.kind === 'video'
        ? `<div class="mw"><video src="${esc(abs(m.url))}" controls playsinline></video>${wm}</div>`
        : `<div class="mw"><img src="${esc(abs(m.url))}" alt=""/>${wm}</div>`)).join('');
    // Device-aware store button — show only the store for the visitor's OS.
    const ua = String(req.headers['user-agent'] || '');
    const isIOS = /iPhone|iPad|iPod/i.test(ua);
    const isAndroid = /Android/i.test(ua);
    // Share attribution: log every hit with WHO shared the link (?s= appended
    // by the app). Link-unfurl crawlers are tagged so click counts stay human.
    if (p) {
      const isBot = /WhatsApp|facebookexternalhit|Twitterbot|Slackbot|TelegramBot|LinkedInBot|Discordbot|bot|crawler|spider/i.test(ua);
      const sharer = /^\d+$/.test(String(req.query?.s || '')) ? String(req.query.s) : '';
      const device = isBot ? 'preview-bot' : isIOS ? 'ios' : isAndroid ? 'android' : 'other';
      try {
        sql.prepare('INSERT INTO social_feed_share_clicks (post_id, entity_id, sharer_howler_user_id, device, created_at) VALUES (?,?,?,?,?)')
          .run(p.id, p.entity_id, sharer, device, now());
      } catch { /* analytics must never break the page */ }
    }
    // Accent = the organiser's Pulse brand colour (sanitised to a hex literal
    // before it goes into the <style> tag), falling back to Howler's brand red.
    const HOWLER_RED = '#EC0B62';
    const brandHex = communityBrand(c).brandColor || '';
    const accent = /^#[0-9a-fA-F]{3,8}$/.test(brandHex) ? brandHex : HOWLER_RED;
    const storeHref = isIOS ? APP_STORE_IOS : isAndroid ? APP_STORE_ANDROID : APP_STORE_IOS;
    const ctaBtn = open && p.cta_label
      ? `<a class="btn brand" href="${esc(ctaHref || storeHref)}">${esc(p.cta_label)}</a>`
      : '';
    // Store buttons drop to the quieter style when the post's own CTA leads.
    const storeStyle = ctaBtn ? 'ghost' : 'brand';
    const iosBtn = `<a class="btn ${storeStyle}" href="${esc(APP_STORE_IOS)}">Open in the Howler app</a>`;
    const androidBtn = `<a class="btn ${storeStyle}" href="${esc(APP_STORE_ANDROID)}">Open in the Howler app</a>`;
    const bothBtns = `<a class="btn ${storeStyle}" href="${esc(APP_STORE_IOS)}">Get it on iPhone</a>\n    <a class="btn ghost" href="${esc(APP_STORE_ANDROID)}">Get it on Android</a>`;
    const btns = ctaBtn + (isIOS ? iosBtn : isAndroid ? androidBtn : bothBtns);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(brand)} on Howler</title>
<meta property="og:type" content="article"/>
<meta property="og:title" content="${esc(brand)} on Howler"/>
<meta property="og:description" content="${esc(caption)}"/>
${ogImg ? `<meta property="og:image" content="${esc(ogImg)}"/>` : ''}
<meta name="twitter:card" content="${ogImg ? 'summary_large_image' : 'summary'}"/>
<style>
  body{margin:0;background:#0e0f12;color:#ECEBE7;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;justify-content:center}
  .wrap{max-width:520px;width:100%;padding:22px 18px 44px}
  .head{display:flex;align-items:center;gap:10px;margin-bottom:4px}
  .ava{width:38px;height:38px;border-radius:50%;object-fit:cover;background:radial-gradient(circle at 30% 30%,#c9a7ff,#5a2f8a);display:flex;align-items:center;justify-content:center;font-weight:800;color:#1d0b2b;box-shadow:0 0 0 2px #0e0f12,0 0 0 4px ${accent}}
  .name{font-weight:800}
  .cap{font-size:15px;line-height:1.45;margin:14px 2px 0}
  .mw{position:relative;margin-top:12px}
  .mw img,.mw video{width:100%;border-radius:14px;display:block}
  .wm{position:absolute;right:10px;bottom:10px;display:flex;align-items:center;gap:6px;background:rgba(0,0,0,.5);border-radius:999px;padding:4px 11px;font-size:12px;font-weight:800;color:#fff;backdrop-filter:blur(2px)}
  .wm b{color:${accent}}
  .wlogo{width:16px;height:16px;border-radius:4px;display:block}
  .flogo{width:18px;height:18px;border-radius:5px;vertical-align:middle;margin-right:6px}
  .btns{display:flex;flex-direction:column;gap:10px;margin-top:22px}
  .btn{display:block;text-align:center;text-decoration:none;font-weight:800;border-radius:12px;padding:13px}
  .brand{background:${accent};color:#fff}
  .ghost{background:#1b1d22;color:#ECEBE7;border:1px solid #2a2d34}
  .muted{color:#9A9DA5;font-size:12.5px;text-align:center;margin-top:16px}
</style></head><body><div class="wrap">
  <div class="head">${avatar ? `<img class="ava" src="${esc(avatar)}" alt=""/>` : `<div class="ava">${esc(brand.charAt(0).toUpperCase() || 'H')}</div>`}<div class="name">${esc(brand)}</div></div>
  ${open ? `<div class="cap">${esc(p.body || '')}</div>` : `<div class="cap">This post lives in the Howler app.</div>`}
  ${mediaHtml}
  <div class="btns">
    ${btns}
  </div>
  <div class="muted"><img class="flogo" src="${esc(logo)}" alt=""/>Shared from Howler</div>
</div></body></html>`);
  }));
}

module.exports = { mount };
