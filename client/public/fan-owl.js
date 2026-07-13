/* Howler Fan Owl — the one-tag widget loader promoters drop on their event site.
 *
 *   <script async src="https://<pulse-host>/fan-owl.js" data-site-key="fw_…"></script>
 *
 * What it does (docs/specs/FAN_OWL_SPEC.md §4): boots against /api/fan/context
 * from the HOST page (so the browser's Origin header proves which site this is —
 * checked against the site's domain allowlist), renders the deterministic ribbon
 * (launcher + teaser, no AI), and opens the chat as an iframe of Pulse's
 * /embed/fan page. Everything visual is inline-styled inside our own container so
 * the promoter's CSS and ours can't fight. No cookies, no fingerprinting: one
 * random anon id in localStorage threads a returning fan's sessions together.
 */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script) return;
  var siteKey = script.getAttribute('data-site-key');
  if (!siteKey) return;
  var base;
  try { base = new URL(script.src).origin; } catch (e) { return; }

  var LS_ANON = 'howler_fan_anon';
  // The session lives in LOCAL storage (not per-tab): a returning fan continues
  // the SAME conversation — the Owl remembers what you talked about last visit.
  var SS_SESSION = 'howler_fan_session_' + siteKey.slice(-8);
  var SS_TEASED = 'howler_fan_teased_' + siteKey.slice(-8);
  var SS_REOPEN = 'howler_fan_reopen_' + siteKey.slice(-8); // per-tab: reopen the chat after an Owl-driven page hop
  function store(get, key, val) {
    try { return get ? window.localStorage.getItem(key) : window.localStorage.setItem(key, val); } catch (e) { return null; }
  }
  function sstore(get, key, val) {
    // Session id → localStorage (persists across visits); teaser flag stays
    // per-tab so a new visit gets its teaser again.
    if (key === SS_SESSION) return store(get, key, val);
    try { return get ? window.sessionStorage.getItem(key) : window.sessionStorage.setItem(key, val); } catch (e) { return null; }
  }
  var anonId = store(true, LS_ANON);
  if (!anonId) { anonId = 'a' + Math.random().toString(36).slice(2) + Date.now().toString(36); store(false, LS_ANON, anonId); }

  var ctx = null; // {sessionId, site, event, offer, pageType}
  var root, frameWrap, frame, launcher, teaser;

  function post(path, body) {
    return fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); });
  }
  function beacon(kind, payload) {
    if (!ctx) return;
    try { post('/api/fan/event', { sessionId: ctx.sessionId, kind: kind, payload: payload || {} }).catch(function () {}); } catch (e) { /* best-effort */ }
  }

  var MOBILE = function () { return window.innerWidth < 640; };

  function el(tag, styles, parent) {
    var n = document.createElement(tag);
    for (var k in styles) n.style[k] = styles[k];
    if (parent) parent.appendChild(n);
    return n;
  }

  var frameHref = ''; // the host page the iframe was last (re)built on
  var frameSeq = 0;   // cache-buster so re-setting src forces a fresh boot
  function frameSrc(afterNav) {
    frameSeq += 1;
    return base + '/embed/fan?r=' + frameSeq + '#sid=' + encodeURIComponent(ctx.sessionId) + (afterNav === true ? '&nav=1' : '');
  }
  function openPanel(afterNav) {
    if (frameWrap) {
      // Reopening on a DIFFERENT page (SPA navigations keep this iframe alive):
      // reload it so the chat boots with THIS page's context, not the stale one.
      if (window.location.href !== frameHref) { frameHref = window.location.href; frame.src = frameSrc(afterNav); }
      frameWrap.style.display = 'block'; launcher.style.display = 'none';
      if (teaser) teaser.style.display = 'none';
      beacon('widget_open');
      return;
    }
    frameWrap = el('div', MOBILE() ? {
      position: 'fixed', inset: '0', zIndex: '2147483000', background: '#0008',
    } : {
      position: 'fixed', right: '20px', bottom: '20px', width: '380px', height: 'min(640px, calc(100vh - 40px))',
      zIndex: '2147483000', borderRadius: '18px', overflow: 'hidden', boxShadow: '0 18px 60px rgba(0,0,0,.35)',
    }, root);
    frame = el('iframe', {
      width: '100%', height: '100%', border: '0', display: 'block', background: '#fff',
      borderRadius: MOBILE() ? '0' : '18px',
    }, frameWrap);
    frame.setAttribute('title', 'Event assistant');
    frame.setAttribute('allow', 'clipboard-write');
    frameHref = window.location.href;
    frame.src = frameSrc(afterNav);
    launcher.style.display = 'none';
    if (teaser) teaser.style.display = 'none';
    beacon('widget_open');
  }
  function closePanel() {
    if (frameWrap) frameWrap.style.display = 'none';
    launcher.style.display = 'flex';
    beacon('widget_close');
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== base) return;
    if (e.data === 'howler-fan-owl:close') { closePanel(); return; }
    // The Owl's "Take me there" button: navigate WITHIN the host site (the path is
    // resolved against this page's own origin — never off-site), flagging the tab
    // so the chat reopens on the new page with its context.
    if (e.data && e.data.t === 'howler-fan-owl:nav' && typeof e.data.path === 'string') {
      var dest;
      try {
        if (window.location.origin === base && window.location.pathname === '/fan-owl-test') {
          // The hosted PREVIEW page has no real event pages — simulate the hop the
          // same way its nav links do (?path=…), instead of landing in the Pulse app.
          dest = new URL('/fan-owl-test?k=' + encodeURIComponent(siteKey) + '&path=' + encodeURIComponent(e.data.path), base);
        } else {
          dest = new URL(e.data.path, window.location.origin);
        }
      } catch (err) { return; }
      if (dest.origin !== window.location.origin) return; // same-site only
      try { window.sessionStorage.setItem(SS_REOPEN, '1'); } catch (err) { /* still navigates; just won't auto-reopen */ }
      window.location.href = dest.toString();
    }
  });

  function render() {
    var color = (ctx.site && ctx.site.brandColor) || '#111';
    root = el('div', {}, document.body);
    root.setAttribute('data-howler-fan-owl', '');
    // The launcher: a round Owl button, thumb-reachable, ≥48px tap target.
    launcher = el('button', {
      position: 'fixed', right: '18px', bottom: '18px', zIndex: '2147483000',
      width: '56px', height: '56px', borderRadius: '50%', border: '0', cursor: 'pointer',
      background: color, color: '#fff', fontSize: '26px', lineHeight: '56px',
      boxShadow: '0 8px 28px rgba(0,0,0,.3)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }, root);
    launcher.type = 'button';
    launcher.setAttribute('aria-label', 'Ask about tickets');
    if (ctx.site && ctx.site.owlAvatar) {
      // The client's own face for their Owl (uploaded in Pulse → Fan Owl → Personality).
      launcher.style.padding = '0'; launcher.style.overflow = 'hidden';
      var avatar = el('img', { width: '100%', height: '100%', objectFit: 'cover', display: 'block', borderRadius: '50%' }, launcher);
      avatar.src = ctx.site.owlAvatar; avatar.alt = '';
    } else launcher.textContent = '🦉';
    launcher.addEventListener('click', function () { openPanel(); });

    // Arriving from an Owl-driven page hop? Reopen the chat straight away so the
    // conversation continues on this page's context; otherwise show the teaser.
    var reopen = null;
    try { reopen = window.sessionStorage.getItem(SS_REOPEN); if (reopen) window.sessionStorage.removeItem(SS_REOPEN); } catch (e) { /* ignore */ }
    if (reopen === '1') openPanel(true);
    else updateTeaser();
  }

  // The teaser: the deterministic ribbon — the page's mapped offer (or the site's
  // configured teaser line). Pure data, no AI. It follows the fan between pages:
  // it re-shows whenever the page's offer CHANGES (a different offer key), but a
  // page with the same offer never re-nags, and a dismissal holds until the
  // offer changes. Called on first render and after every navigation.
  var teaserTitle, teaserBody;
  function updateTeaser() {
    // Priority: the page's approved AI sales pitch → the offer shelf-tag → the
    // site's generic teaser. All served pre-written; no AI at view time.
    var line = '';
    if (ctx.pitch) line = ctx.pitch;
    else if (ctx.offer) line = ctx.offer.label + (ctx.offer.price ? ' · ' + ctx.offer.currency + ' ' + ctx.offer.price : '') + (ctx.offer.availability ? ' · ' + ctx.offer.availability : '');
    else if (ctx.site && ctx.site.teaser) line = ctx.site.teaser;
    var key = (ctx.offer ? ctx.offer.id : 'site') + '|' + (ctx.pageType || '') + '|' + line;
    if (!line || (frameWrap && frameWrap.style.display !== 'none')) return; // nothing to say, or chat already open
    if (sstore(true, SS_TEASED) === key) return; // this exact offer was already teased/dismissed
    sstore(false, SS_TEASED, key);
    if (!teaser) {
      teaser = el('div', {
        position: 'fixed', right: '18px', bottom: '84px', zIndex: '2147483000',
        maxWidth: MOBILE() ? 'calc(100vw - 36px)' : '300px', background: '#fff', color: '#111',
        borderRadius: '14px', padding: '12px 36px 12px 14px', fontSize: '14px', lineHeight: '1.45',
        fontFamily: '-apple-system, system-ui, sans-serif', boxShadow: '0 10px 34px rgba(0,0,0,.22)', cursor: 'pointer',
      }, root);
      teaserTitle = el('div', { fontWeight: '700', marginBottom: '2px' }, teaser);
      teaserBody = el('div', {}, teaser);
      var x = el('button', {
        position: 'absolute', top: '6px', right: '6px', width: '24px', height: '24px', border: '0',
        background: 'transparent', color: '#999', fontSize: '16px', cursor: 'pointer',
      }, teaser);
      x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Dismiss');
      x.addEventListener('click', function (e) { e.stopPropagation(); teaser.style.display = 'none'; });
      teaser.addEventListener('click', openPanel);
    }
    teaserTitle.textContent = (ctx.event && ctx.event.name) || (ctx.site && ctx.site.name) || 'Tickets';
    teaserBody.textContent = line;
    teaser.style.display = 'block';
  }

  // Follow the fan between pages: full reloads re-run the loader naturally, but
  // SPA navigations (history API) don't — hook them, re-fetch the page context
  // (same session), and refresh the ribbon. The chat follows automatically: the
  // server tracks the session's current page per context call.
  function onNavigate() {
    post('/api/fan/context', { siteKey: siteKey, url: window.location.href, anonId: anonId, sessionId: ctx && ctx.sessionId })
      .then(function (r) { ctx = r; sstore(false, SS_SESSION, r.sessionId); if (root) updateTeaser(); })
      .catch(function () { /* keep the old ribbon */ });
  }
  var lastHref = window.location.href;
  function navCheck() { if (window.location.href !== lastHref) { lastHref = window.location.href; onNavigate(); } }
  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = window.history[m];
    if (!orig) return;
    window.history[m] = function () { var r = orig.apply(this, arguments); setTimeout(navCheck, 0); return r; };
  });
  window.addEventListener('popstate', navCheck);
  window.addEventListener('hashchange', navCheck);

  post('/api/fan/context', {
    siteKey: siteKey,
    url: window.location.href,
    anonId: anonId,
    sessionId: sstore(true, SS_SESSION) || undefined,
  }).then(function (r) {
    ctx = r;
    sstore(false, SS_SESSION, r.sessionId);
    if (document.body) render();
    else document.addEventListener('DOMContentLoaded', render);
  }).catch(function () { /* disabled / not allowed → the page just has no widget */ });
})();
