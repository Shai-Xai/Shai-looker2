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

  var bar, barMenu, barInput; // the persistent ask bar (widgetStyle 'bar')
  // The bar's page-aware placeholder (same strings as the chat composer).
  var BAR_LOC = {
    en: { ask: 'Ask about tickets…', on: 'Ask about {t}…', t: { home: 'the event', tickets: 'tickets', lineup: 'the line-up', artist: 'the artists', venue: 'the venue', accommodation: 'where to stay', attraction: 'what to do', sponsors: 'our partners', faq: 'the details', other: 'this page' } },
    af: { ask: 'Vra oor kaartjies…', on: 'Vra oor {t}…', t: { home: 'die geleentheid', tickets: 'kaartjies', lineup: 'die program', artist: 'die kunstenaars', venue: 'die venue', accommodation: 'verblyf', attraction: 'wat om te doen', sponsors: 'ons vennote', faq: 'die besonderhede', other: 'hierdie bladsy' } },
    it: { ask: 'Chiedi sui biglietti…', on: 'Domande su {t}…', t: { home: 'l’evento', tickets: 'i biglietti', lineup: 'la line-up', artist: 'gli artisti', venue: 'la location', accommodation: 'l’alloggio', attraction: 'cosa fare', sponsors: 'i partner', faq: 'i dettagli', other: 'questa pagina' } },
    es: { ask: 'Pregunta sobre entradas…', on: 'Pregunta sobre {t}…', t: { home: 'el evento', tickets: 'las entradas', lineup: 'el cartel', artist: 'los artistas', venue: 'el recinto', accommodation: 'dónde alojarte', attraction: 'qué hacer', sponsors: 'nuestros partners', faq: 'los detalles', other: 'esta página' } },
    fr: { ask: 'Une question billets ?…', on: 'Une question sur {t} ?…', t: { home: 'l’événement', tickets: 'les billets', lineup: 'la programmation', artist: 'les artistes', venue: 'le lieu', accommodation: 'où loger', attraction: 'quoi faire', sponsors: 'nos partenaires', faq: 'les détails', other: 'cette page' } },
    de: { ask: 'Frag zu Tickets…', on: 'Frag zu {t}…', t: { home: 'dem Event', tickets: 'Tickets', lineup: 'dem Line-up', artist: 'den Artists', venue: 'dem Gelände', accommodation: 'Unterkünften', attraction: 'Aktivitäten', sponsors: 'unseren Partnern', faq: 'den Details', other: 'dieser Seite' } },
    pt: { ask: 'Pergunte sobre bilhetes…', on: 'Pergunte sobre {t}…', t: { home: 'o evento', tickets: 'bilhetes', lineup: 'o cartaz', artist: 'os artistas', venue: 'o recinto', accommodation: 'onde ficar', attraction: 'o que fazer', sponsors: 'os parceiros', faq: 'os detalhes', other: 'esta página' } },
    nl: { ask: 'Vraag over tickets…', on: 'Vraag over {t}…', t: { home: 'het evenement', tickets: 'tickets', lineup: 'de line-up', artist: 'de artiesten', venue: 'de locatie', accommodation: 'overnachten', attraction: 'wat te doen', sponsors: 'onze partners', faq: 'de details', other: 'deze pagina' } },
  };
  function askPlaceholder() {
    var L = BAR_LOC[(navigator.language || '').slice(0, 2).toLowerCase()] || BAR_LOC[String((ctx.site && ctx.site.defaultLang) || '').slice(0, 2)] || BAR_LOC.en;
    var pt = ctx && ctx.pageType && ctx.pageType !== 'default' ? ctx.pageType : '';
    return pt ? L.on.replace('{t}', L.t[pt] || L.t.other) : L.ask;
  }
  // Navigate WITHIN the host site (preview page simulates via ?path=…).
  function navTo(path) {
    var dest;
    try {
      if (window.location.origin === base && window.location.pathname === '/fan-owl-test') {
        dest = new URL('/fan-owl-test?k=' + encodeURIComponent(siteKey) + '&path=' + encodeURIComponent(path), base);
      } else {
        dest = new URL(path, window.location.origin);
      }
    } catch (err) { return; }
    if (dest.origin !== window.location.origin) return; // same-site only
    window.location.href = dest.toString();
  }

  var frameHref = ''; // the host page the iframe was last (re)built on
  var frameSeq = 0;   // cache-buster so re-setting src forces a fresh boot
  function frameSrc(afterNav, ask) {
    frameSeq += 1;
    // &m=1 marks the mobile fullscreen frame (the embed hides its expand button
    // there); &ask= carries a question typed into the persistent bar.
    return base + '/embed/fan?r=' + frameSeq + '#sid=' + encodeURIComponent(ctx.sessionId) + (afterNav === true ? '&nav=1' : '') + (MOBILE() ? '&m=1' : '') + (ask ? '&ask=' + encodeURIComponent(String(ask).slice(0, 300)) : '');
  }
  // Desktop wide view: the embed's ⤢ button asks us to grow the panel (the
  // iframe can't resize itself). No-op on mobile — it's already fullscreen.
  function applyExpand(on) {
    if (!frameWrap || MOBILE()) return;
    if (on) { frameWrap.style.top = '20px'; frameWrap.style.height = 'auto'; frameWrap.style.width = 'min(760px, calc(100vw - 40px))'; }
    else { frameWrap.style.top = 'auto'; frameWrap.style.height = 'min(640px, calc(100vh - 40px))'; frameWrap.style.width = '380px'; }
  }
  function openPanel(afterNav, ask) {
    if (frameWrap) {
      // Reopening on a DIFFERENT page (SPA navigations keep this iframe alive):
      // reload it so the chat boots with THIS page's context, not the stale one.
      // A typed question always reloads so the embed sends it.
      if (ask || window.location.href !== frameHref) { frameHref = window.location.href; applyExpand(false); frame.src = frameSrc(afterNav, ask); }
      frameWrap.style.display = 'block';
      if (launcher) launcher.style.display = 'none';
      if (bar) bar.style.display = 'none';
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
    var frameDark = (ctx.site && ctx.site.theme === 'dark') ||
      ((!ctx.site || ctx.site.theme !== 'light') && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    frame = el('iframe', {
      width: '100%', height: '100%', border: '0', display: 'block',
      background: frameDark ? '#141417' : '#fff', // match the embed's theme so opening doesn't flash
      borderRadius: MOBILE() ? '0' : '18px',
    }, frameWrap);
    frame.setAttribute('title', 'Event assistant');
    frame.setAttribute('allow', 'clipboard-write');
    frameHref = window.location.href;
    frame.src = frameSrc(afterNav, ask);
    if (launcher) launcher.style.display = 'none';
    if (bar) bar.style.display = 'none';
    if (teaser) teaser.style.display = 'none';
    beacon('widget_open');
  }
  function closePanel() {
    if (frameWrap) frameWrap.style.display = 'none';
    if (bar) bar.style.display = 'block';
    else if (launcher) launcher.style.display = 'flex';
    beacon('widget_close');
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== base) return;
    if (e.data === 'howler-fan-owl:close') { closePanel(); return; }
    if (e.data && e.data.t === 'howler-fan-owl:expand') { applyExpand(e.data.on === true); return; }
    // The Owl's "Take me there" button: navigate WITHIN the host site (the path
    // is resolved against this page's own origin — never off-site).
    if (e.data && e.data.t === 'howler-fan-owl:nav' && typeof e.data.path === 'string') {
      // Just show the page: the chat stays closed so the fan actually SEES where
      // they asked to go. The ribbon/bar carries the new page's context.
      navTo(e.data.path);
    }
  });

  // ── The persistent ask bar (widgetStyle 'bar'): the live composer, docked to
  // the bottom of every page — ＋ nav menu, page-aware input, round send. Typing
  // opens the chat with the question already sent; nav rows navigate directly.
  function barDark() {
    return (ctx.site && ctx.site.theme === 'dark') ||
      ((!ctx.site || ctx.site.theme !== 'light') && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function renderBar() {
    var color = (ctx.site && ctx.site.brandColor) || '#111';
    var dark = barDark();
    bar = el('div', {
      position: 'fixed', left: '0', right: '0', bottom: '10px', zIndex: '2147483000',
      width: 'min(860px, calc(100vw - 20px))', margin: '0 auto', boxSizing: 'border-box',
      background: dark ? 'rgba(17,17,21,.92)' : 'rgba(255,255,255,.96)',
      color: dark ? '#f2f2f4' : '#141414',
      border: '1px solid ' + (dark ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.08)'),
      borderRadius: '22px', padding: '10px 10px 4px',
      boxShadow: '0 12px 40px rgba(0,0,0,.32)',
      backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
      fontFamily: '-apple-system, system-ui, sans-serif',
    }, root);
    var row = el('div', { display: 'flex', gap: '9px', alignItems: 'center', position: 'relative' }, bar);
    if ((ctx.nav || []).length) {
      var plus = el('button', {
        width: '44px', height: '44px', borderRadius: '50%', flex: '0 0 auto', cursor: 'pointer',
        border: '1.5px solid ' + (dark ? 'rgba(255,255,255,.28)' : 'rgba(0,0,0,.22)'),
        background: 'transparent', color: 'inherit', fontSize: '21px', fontWeight: '300', lineHeight: '1', padding: '0',
      }, row);
      plus.type = 'button'; plus.textContent = '+'; plus.setAttribute('aria-label', 'Site navigation');
      plus.addEventListener('click', function () {
        if (barMenu && barMenu.style.display !== 'none') { barMenu.style.display = 'none'; return; }
        if (!barMenu) {
          barMenu = el('div', {
            position: 'absolute', bottom: 'calc(100% + 10px)', left: '0', width: 'min(320px, 92vw)',
            background: dark ? 'rgba(24,24,30,.98)' : '#fff', color: 'inherit',
            border: '1px solid ' + (dark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)'),
            borderRadius: '14px', padding: '6px', boxShadow: '0 14px 40px rgba(0,0,0,.35)',
          }, bar);
          var TYPE_LABELS = { home: 'Home', tickets: 'Tickets', lineup: 'Line-up', artist: 'Artists', venue: 'Venue', accommodation: 'Stay', attraction: 'Explore', sponsors: 'Partners', faq: 'FAQs', other: 'More' };
          (ctx.nav || []).forEach(function (n) {
            var r = el('button', {
              display: 'flex', alignItems: 'center', gap: '10px', width: '100%', textAlign: 'left', border: '0',
              background: 'transparent', color: 'inherit', borderRadius: '10px', padding: '10px 10px',
              cursor: 'pointer', fontSize: '14px', fontWeight: '600', fontFamily: 'inherit',
            }, barMenu);
            r.type = 'button';
            r.textContent = (n.emoji ? n.emoji + '  ' : '›  ') + (n.label || TYPE_LABELS[n.pageType] || TYPE_LABELS.other);
            r.addEventListener('mouseenter', function () { r.style.background = dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.05)'; });
            r.addEventListener('mouseleave', function () { r.style.background = 'transparent'; });
            r.addEventListener('click', function () {
              barMenu.style.display = 'none';
              beacon('nav_click', { path: n.path, pageType: n.pageType });
              navTo(n.path);
            });
          });
        }
        barMenu.style.display = 'block';
      });
    }
    var pill = el('div', {
      flex: '1', minWidth: '0', display: 'flex', alignItems: 'center', gap: '8px',
      border: '1.5px solid ' + color, borderRadius: '999px', padding: '4px 4px 4px 13px',
      minHeight: '46px', background: dark ? 'rgba(255,255,255,.06)' : '#fff', boxSizing: 'border-box',
    }, row);
    pill.insertAdjacentHTML('beforeend', '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="opacity:.55;flex:0 0 auto" aria-hidden="true"><path d="M12 3v3m0 12v3M3 12h3m12 0h3M6 6l2 2m8 8 2 2m0-12-2 2M8 16l-2 2"/></svg>');
    barInput = el('input', { flex: '1', minWidth: '0', border: '0', outline: 'none', background: 'transparent', color: 'inherit', fontSize: '15px', padding: '8px 0', fontFamily: 'inherit' }, pill);
    barInput.placeholder = askPlaceholder();
    barInput.setAttribute('aria-label', 'Ask a question');
    var send = el('button', {
      width: '36px', height: '36px', borderRadius: '50%', border: '0', flex: '0 0 auto',
      background: color, color: '#fff', fontSize: '15px', fontWeight: '700', cursor: 'pointer', padding: '0',
    }, pill);
    send.type = 'button'; send.textContent = '↑'; send.setAttribute('aria-label', 'Ask');
    var submit = function () {
      var q = barInput.value.trim();
      barInput.value = '';
      if (barMenu) barMenu.style.display = 'none';
      openPanel(false, q || undefined);
    };
    send.addEventListener('click', submit);
    barInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    var foot = el('div', { textAlign: 'center', fontSize: '10.5px', opacity: '.55', padding: '3px 0 2px' }, bar);
    foot.insertAdjacentHTML('beforeend', 'Powered by Howler <img src="' + base + '/email-howler.png" alt="" style="height:11px;width:11px;border-radius:50%;vertical-align:-1.5px">');
  }

  function render() {
    var color = (ctx.site && ctx.site.brandColor) || '#111';
    root = el('div', {}, document.body);
    root.setAttribute('data-howler-fan-owl', '');
    if (ctx.site && ctx.site.widgetStyle === 'bar') { renderBar(); return; }
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

    updateTeaser();
  }

  // The teaser: the deterministic ribbon — the page's mapped offer (or the site's
  // configured teaser line). Pure data, no AI. It follows the fan between pages:
  // it re-shows whenever the page's offer CHANGES (a different offer key), but a
  // page with the same offer never re-nags, and a dismissal holds until the
  // offer changes. Called on first render and after every navigation.
  var teaserTitle, teaserBody;
  function updateTeaser() {
    if (bar) return; // bar mode has no teaser — the bar IS the resting surface
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
    // Theme: the site's explicit choice, else the fan's device preference.
    var dark = (ctx.site && ctx.site.theme === 'dark') ||
      ((!ctx.site || ctx.site.theme !== 'light') && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    teaser.style.background = dark ? '#1d1d22' : '#fff';
    teaser.style.color = dark ? '#f1f1f3' : '#111';
    teaser.style.display = 'block';
  }

  // Follow the fan between pages: full reloads re-run the loader naturally, but
  // SPA navigations (history API) don't — hook them, re-fetch the page context
  // (same session), and refresh the ribbon. The chat follows automatically: the
  // server tracks the session's current page per context call.
  function onNavigate() {
    post('/api/fan/context', { siteKey: siteKey, url: window.location.href, anonId: anonId, sessionId: ctx && ctx.sessionId, lang: navigator.language || '' })
      .then(function (r) {
        ctx = r; sstore(false, SS_SESSION, r.sessionId);
        if (!root) return;
        if (bar) {
          // The bar follows the page: refresh the placeholder + rebuild the ＋ menu.
          if (barInput) barInput.placeholder = askPlaceholder();
          if (barMenu) { try { barMenu.parentNode.removeChild(barMenu); } catch (e2) { /* gone */ } barMenu = null; }
        } else updateTeaser();
      })
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
    lang: navigator.language || '', // the fan's device language — the Owl opens in it

    sessionId: sstore(true, SS_SESSION) || undefined,
  }).then(function (r) {
    ctx = r;
    sstore(false, SS_SESSION, r.sessionId);
    if (document.body) render();
    else document.addEventListener('DOMContentLoaded', render);
  }).catch(function () { /* disabled / not allowed → the page just has no widget */ });
})();
