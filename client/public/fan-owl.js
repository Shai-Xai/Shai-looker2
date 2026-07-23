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
  var SS_HERO = 'howler_fan_hero_' + siteKey.slice(-8); // per-tab: home-page hero shown/dismissed
  var SS_LAYOUT = 'howler_fan_layout_' + siteKey.slice(-8); // per-tab: desktop chat layout (main | side | dock)
  var SS_REOPEN = 'howler_fan_reopen_' + siteKey.slice(-8); // per-tab: keep the side/docked chat open across an in-chat navigation
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

  var bar, barMenu, barInput, drawer; // the persistent ask bar (widgetStyle 'bar') + its half drawer
  // The bar's page-aware placeholder (same strings as the chat composer).
  var BAR_LOC = {
    en: { ask: 'Ask about tickets…', on: 'Ask about {t}…', hi: 'Hey! I’m {name} — where should we begin?', sub: 'Tickets, line-up, getting there — ask me anything.', t: { home: 'the event', tickets: 'tickets', lineup: 'the line-up', artist: 'the artists', venue: 'the venue', accommodation: 'where to stay', attraction: 'what to do', sponsors: 'our partners', faq: 'the details', other: 'this page' } },
    af: { ask: 'Vra oor kaartjies…', on: 'Vra oor {t}…', hi: 'Haai! Ek is {name} — waar begin ons?', sub: 'Kaartjies, program, aanwysings — vra my enigiets.', t: { home: 'die geleentheid', tickets: 'kaartjies', lineup: 'die program', artist: 'die kunstenaars', venue: 'die venue', accommodation: 'verblyf', attraction: 'wat om te doen', sponsors: 'ons vennote', faq: 'die besonderhede', other: 'hierdie bladsy' } },
    it: { ask: 'Chiedi sui biglietti…', on: 'Domande su {t}…', hi: 'Ciao! Sono {name} — da dove iniziamo?', sub: 'Biglietti, line-up, come arrivare — chiedimi qualsiasi cosa.', t: { home: 'l’evento', tickets: 'i biglietti', lineup: 'la line-up', artist: 'gli artisti', venue: 'la location', accommodation: 'l’alloggio', attraction: 'cosa fare', sponsors: 'i partner', faq: 'i dettagli', other: 'questa pagina' } },
    es: { ask: 'Pregunta sobre entradas…', on: 'Pregunta sobre {t}…', hi: '¡Hola! Soy {name} — ¿por dónde empezamos?', sub: 'Entradas, cartel, cómo llegar — pregúntame lo que sea.', t: { home: 'el evento', tickets: 'las entradas', lineup: 'el cartel', artist: 'los artistas', venue: 'el recinto', accommodation: 'dónde alojarte', attraction: 'qué hacer', sponsors: 'nuestros partners', faq: 'los detalles', other: 'esta página' } },
    fr: { ask: 'Une question billets ?…', on: 'Une question sur {t} ?…', hi: 'Salut ! Je suis {name} — on commence par quoi ?', sub: 'Billets, programmation, accès — demandez-moi tout.', t: { home: 'l’événement', tickets: 'les billets', lineup: 'la programmation', artist: 'les artistes', venue: 'le lieu', accommodation: 'où loger', attraction: 'quoi faire', sponsors: 'nos partenaires', faq: 'les détails', other: 'cette page' } },
    de: { ask: 'Frag zu Tickets…', on: 'Frag zu {t}…', hi: 'Hey! Ich bin {name} — womit fangen wir an?', sub: 'Tickets, Line-up, Anfahrt — frag mich alles.', t: { home: 'dem Event', tickets: 'Tickets', lineup: 'dem Line-up', artist: 'den Artists', venue: 'dem Gelände', accommodation: 'Unterkünften', attraction: 'Aktivitäten', sponsors: 'unseren Partnern', faq: 'den Details', other: 'dieser Seite' } },
    pt: { ask: 'Pergunte sobre bilhetes…', on: 'Pergunte sobre {t}…', hi: 'Olá! Sou {name} — por onde começamos?', sub: 'Bilhetes, cartaz, como chegar — pergunte-me qualquer coisa.', t: { home: 'o evento', tickets: 'bilhetes', lineup: 'o cartaz', artist: 'os artistas', venue: 'o recinto', accommodation: 'onde ficar', attraction: 'o que fazer', sponsors: 'os parceiros', faq: 'os detalhes', other: 'esta página' } },
    nl: { ask: 'Vraag over tickets…', on: 'Vraag over {t}…', hi: 'Hoi! Ik ben {name} — waar beginnen we?', sub: 'Tickets, line-up, bereikbaarheid — vraag me alles.', t: { home: 'het evenement', tickets: 'tickets', lineup: 'de line-up', artist: 'de artiesten', venue: 'de locatie', accommodation: 'overnachten', attraction: 'wat te doen', sponsors: 'onze partners', faq: 'de details', other: 'deze pagina' } },
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
  // Desktop chat layouts: 'main' (wide, centred — bar-mode default), 'side'
  // (the classic floating overlay panel — launcher default) and 'dock' (a true
  // right-hand panel: full height, and the PAGE shifts left so the assistant
  // never covers content). Header toggles switch; remembered per tab session.
  var chatLayout = 'side';
  var DOCK_W = 'min(420px, 38vw)';
  function isBarMode() { return !!(ctx && ctx.site && ctx.site.widgetStyle === 'bar'); }
  function initLayout() {
    var saved = sstore(true, SS_LAYOUT);
    chatLayout = (saved === 'main' || saved === 'side' || saved === 'dock') ? saved : (isBarMode() ? 'main' : 'side');
  }
  // Dock shifts the whole page left with an animated margin on <html>. Fixed
  // site elements don't move — the honest limit of docking from the outside.
  function pushPage(on) {
    var de = document.documentElement;
    if (on) {
      if (!de.getAttribute('data-howler-pushed')) { de.setAttribute('data-howler-pushed', '1'); de.style.transition = 'margin-right .25s ease'; }
      de.style.marginRight = DOCK_W;
    } else if (de.getAttribute('data-howler-pushed')) {
      de.style.marginRight = '';
    }
  }
  function applyLayout() {
    if (!frameWrap || MOBILE()) return;
    if (chatLayout === 'dock') {
      frameWrap.style.left = 'auto'; frameWrap.style.right = '0'; frameWrap.style.margin = '0';
      frameWrap.style.top = '0'; frameWrap.style.bottom = '0';
      frameWrap.style.width = DOCK_W; frameWrap.style.height = '100%';
      frameWrap.style.borderRadius = '0';
      frameWrap.style.boxShadow = '-12px 0 40px rgba(0,0,0,.22)';
      pushPage(true);
      return;
    }
    pushPage(false);
    frameWrap.style.borderRadius = '18px';
    frameWrap.style.boxShadow = '0 18px 60px rgba(0,0,0,.35)';
    if (chatLayout === 'main') {
      frameWrap.style.left = '0'; frameWrap.style.right = '0'; frameWrap.style.margin = '0 auto';
      frameWrap.style.top = 'auto'; frameWrap.style.bottom = '10px';
      frameWrap.style.width = 'min(860px, calc(100vw - 20px))';
      frameWrap.style.height = 'min(680px, calc(100vh - 60px))';
    } else {
      frameWrap.style.left = 'auto'; frameWrap.style.right = '20px'; frameWrap.style.margin = '0';
      frameWrap.style.top = 'auto'; frameWrap.style.bottom = '20px';
      frameWrap.style.width = '380px'; frameWrap.style.height = 'min(640px, calc(100vh - 40px))';
    }
  }
  function frameSrc(afterNav, ask) {
    frameSeq += 1;
    // &m=1 marks the mobile fullscreen frame (the embed hides its expand button
    // there); &ask= carries a question typed into the persistent bar.
    return base + '/embed/fan?r=' + frameSeq + '#sid=' + encodeURIComponent(ctx.sessionId) + (afterNav === true ? '&nav=1' : '') + (MOBILE() ? '&m=1' : '') + (!MOBILE() ? '&lay=' + chatLayout : '') + (ask ? '&ask=' + encodeURIComponent(String(ask).slice(0, 300)) : '');
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
      if (ask || window.location.href !== frameHref) { frameHref = window.location.href; applyLayout(); frame.src = frameSrc(afterNav, ask); }
      frameWrap.style.display = 'block';
      applyLayout();
      if (launcher) launcher.style.display = 'none';
      if (bar) bar.style.display = 'none';
      if (teaser) teaser.style.display = 'none';
      beacon('widget_open');
      return;
    }
    initLayout();
    frameWrap = el('div', MOBILE() ? {
      position: 'fixed', inset: '0', zIndex: '2147483000', background: '#0008',
    } : {
      position: 'fixed', zIndex: '2147483000', borderRadius: '18px', overflow: 'hidden', boxShadow: '0 18px 60px rgba(0,0,0,.35)',
    }, root);
    applyLayout();
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
    pushPage(false);
    if (frameWrap) frameWrap.style.display = 'none';
    if (bar) bar.style.display = 'block';
    else if (launcher) launcher.style.display = 'flex';
    beacon('widget_close');
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== base) return;
    if (e.data === 'howler-fan-owl:close') { closePanel(); return; }
    if (e.data && e.data.t === 'howler-fan-owl:expand') { applyExpand(e.data.on === true); return; }
    if (e.data && e.data.t === 'howler-fan-owl:layout' && (e.data.mode === 'main' || e.data.mode === 'side' || e.data.mode === 'dock')) {
      chatLayout = e.data.mode;
      sstore(false, SS_LAYOUT, chatLayout);
      applyLayout();
      return;
    }
    // The Owl's "Take me there" button: navigate WITHIN the host site (the path
    // is resolved against this page's own origin — never off-site).
    if (e.data && e.data.t === 'howler-fan-owl:nav' && typeof e.data.path === 'string') {
      // Side/docked desktop views don't cover the page — keep the chat open in
      // the same view across the hop. Mobile and main view close instead, so the
      // fan actually SEES the page they asked for.
      var chatOpen = frameWrap && frameWrap.style.display !== 'none';
      if (chatOpen && !MOBILE() && (chatLayout === 'side' || chatLayout === 'dock')) {
        try { window.sessionStorage.setItem(SS_REOPEN, '1'); } catch (err) { /* just won't auto-reopen */ }
      }
      navTo(e.data.path);
    }
  });

  // ── The persistent ask bar (widgetStyle 'bar') + the homepage hero: the live
  // composer as always-on surfaces. Shared builders keep the pill + nav menu
  // identical everywhere.
  function barDark() {
    return (ctx.site && ctx.site.theme === 'dark') ||
      ((!ctx.site || ctx.site.theme !== 'light') && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  var NAV_SVG = {
    home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/>',
    tickets: '<path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4Z"/>',
    lineup: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
    artist: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1.2-3.4 3.8-5 7-5s5.8 1.6 7 5"/>',
    venue: '<path d="M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11Z"/><circle cx="12" cy="10" r="2.5"/>',
    accommodation: '<path d="M12 4 3 18h18L12 4Z"/><path d="M12 10 8.5 18h7L12 10Z"/>',
    attraction: '<path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2L12 3Z"/>',
    sponsors: '<circle cx="12" cy="12" r="8"/><path d="M8.5 12h7M12 8.5v7"/>',
    faq: '<circle cx="12" cy="12" r="8"/><path d="M9.5 9.5c.4-1.2 1.3-2 2.5-2 1.4 0 2.5 1 2.5 2.3 0 1.6-2 1.9-2 3.2"/><circle cx="12" cy="16.6" r=".4" fill="currentColor"/>',
    other: '<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>',
  };
  var NAV_TYPE_LABELS = { home: 'Home', tickets: 'Tickets', lineup: 'Line-up', artist: 'Artists', venue: 'Venue', accommodation: 'Stay', attraction: 'Explore', sponsors: 'Partners', faq: 'FAQs', other: 'More' };
  function navIconHtml(n, size) {
    if (n.emoji) return '<span style="font-size:' + (size - 3) + 'px;line-height:1" aria-hidden="true">' + String(n.emoji).replace(/[<>&"]/g, '') + '</span>';
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (NAV_SVG[n.pageType] || NAV_SVG.other) + '</svg>';
  }
  function navLabelOf(n) { return n.label || NAV_TYPE_LABELS[n.pageType] || NAV_TYPE_LABELS.other; }
  function navPick(n) {
    beacon('nav_click', { path: n.path, pageType: n.pageType });
    navTo(n.path);
  }
  // The spark-in-pill ask input with the round send — the live composer.
  function makeAskPill(parent, dark, color, onSubmit) {
    var pill = el('div', {
      flex: '1', minWidth: '0', display: 'flex', alignItems: 'center', gap: '8px',
      border: '1.5px solid ' + color, borderRadius: '999px', padding: '4px 4px 4px 13px',
      minHeight: '46px', background: dark ? 'rgba(255,255,255,.06)' : '#fff', boxSizing: 'border-box',
    }, parent);
    pill.insertAdjacentHTML('beforeend', '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="opacity:.55;flex:0 0 auto" aria-hidden="true"><path d="M12 3v3m0 12v3M3 12h3m12 0h3M6 6l2 2m8 8 2 2m0-12-2 2M8 16l-2 2"/></svg>');
    var input = el('input', { flex: '1', minWidth: '0', border: '0', outline: 'none', background: 'transparent', color: 'inherit', fontSize: '15px', padding: '8px 0', fontFamily: 'inherit' }, pill);
    input.placeholder = askPlaceholder();
    input.setAttribute('aria-label', 'Ask a question');
    var send = el('button', {
      width: '36px', height: '36px', borderRadius: '50%', border: '0', flex: '0 0 auto',
      background: color, color: '#fff', fontSize: '15px', fontWeight: '700', cursor: 'pointer', padding: '0',
    }, pill);
    send.type = 'button'; send.textContent = '↑'; send.setAttribute('aria-label', 'Ask');
    var submit = function () { var q = input.value.trim(); input.value = ''; onSubmit(q); };
    send.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    return input;
  }
  // The nav menu (for ＋ buttons) — anchored above `anchor` inside a positioned parent.
  function makeNavMenu(parent, dark, onPick) {
    var menu = el('div', {
      position: 'absolute', bottom: 'calc(100% + 10px)', left: '0', width: 'min(320px, 92vw)',
      background: dark ? 'rgba(24,24,30,.98)' : '#fff', color: 'inherit', zIndex: '5',
      border: '1px solid ' + (dark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)'),
      borderRadius: '14px', padding: '6px', boxShadow: '0 14px 40px rgba(0,0,0,.35)', textAlign: 'left',
    }, parent);
    (ctx.nav || []).forEach(function (n) {
      var r = el('button', {
        display: 'flex', alignItems: 'center', gap: '10px', width: '100%', textAlign: 'left', border: '0',
        background: 'transparent', color: 'inherit', borderRadius: '10px', padding: '10px 10px',
        cursor: 'pointer', fontSize: '14px', fontWeight: '600', fontFamily: 'inherit',
      }, menu);
      r.type = 'button';
      r.insertAdjacentHTML('beforeend', navIconHtml(n, 16));
      var lbl = el('span', { marginLeft: '2px' }, r);
      lbl.textContent = navLabelOf(n);
      r.addEventListener('mouseenter', function () { r.style.background = dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.05)'; });
      r.addEventListener('mouseleave', function () { r.style.background = 'transparent'; });
      r.addEventListener('click', function () { menu.style.display = 'none'; onPick(n); });
    });
    return menu;
  }
  // ── The half drawer: two phases in one surface. FOCUS (nothing typed) shows
  // THIS page's suggested topics + its lead offer; TYPING switches to live
  // substring-filtered matches across all starters, FAQ/tip questions and pages
  // (current page ranks first). Tap = ask (opens the chat with it sent) or
  // navigate. Deterministic, instant, zero AI.
  function drawerRows(needle) {
    var sug = ctx.suggest || { topics: [], pool: [] };
    var rows = [];
    if (!needle) {
      (sug.topics.length ? sug.topics : (sug.pool || []).slice(0, 3).map(function (e) { return e.q; })).slice(0, 4)
        .forEach(function (q) { rows.push({ kind: 'ask', q: q }); });
      if (ctx.offer) rows.push({ kind: 'offer', offer: ctx.offer });
      return rows;
    }
    var n = needle.toLowerCase();
    var hits = (sug.pool || []).filter(function (e) { return e.q.toLowerCase().indexOf(n) !== -1; });
    hits.sort(function (a, b) { return (b.here ? 1 : 0) - (a.here ? 1 : 0); });
    hits.slice(0, 5).forEach(function (e) { rows.push({ kind: 'ask', q: e.q, faq: e.faq }); });
    (ctx.nav || []).forEach(function (nv) {
      if (rows.length >= 7) return;
      var label = navLabelOf(nv);
      if (label.toLowerCase().indexOf(n) !== -1 || nv.pageType.indexOf(n) !== -1 || nv.path.toLowerCase().indexOf(n) !== -1) {
        rows.push({ kind: 'page', nav: nv });
      }
    });
    return rows;
  }
  function highlightInto(parent, text, needle, accent) {
    var i = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
    if (i === -1) { parent.appendChild(document.createTextNode(text)); return; }
    parent.appendChild(document.createTextNode(text.slice(0, i)));
    var m = el('span', { color: accent, fontWeight: '700' }, parent);
    m.textContent = text.slice(i, i + needle.length);
    parent.appendChild(document.createTextNode(text.slice(i + needle.length)));
  }
  function hideDrawer() { if (drawer) drawer.style.display = 'none'; }
  function renderDrawer() {
    if (!bar || !barInput) return;
    var dark = barDark();
    var color = (ctx.site && ctx.site.brandColor) || '#111';
    var needle = barInput.value.trim();
    var rows = drawerRows(needle);
    if (!rows.length) { hideDrawer(); return; }
    if (!drawer) {
      drawer = el('div', {
        position: 'absolute', bottom: 'calc(100% + 8px)', left: '0', right: '0',
        background: dark ? 'rgba(17,17,21,.96)' : 'rgba(255,255,255,.98)',
        color: dark ? '#f2f2f4' : '#141414',
        border: '1px solid ' + (dark ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.08)'),
        borderRadius: '18px', padding: '8px', boxShadow: '0 14px 44px rgba(0,0,0,.35)',
        maxHeight: 'min(340px, 46vh)', overflowY: 'auto',
        backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
      }, bar);
    }
    drawer.innerHTML = '';
    var head = el('div', { display: 'flex', alignItems: 'center', gap: '7px', fontSize: '10.5px', fontWeight: '700', letterSpacing: '.06em', textTransform: 'uppercase', opacity: '.55', padding: '4px 8px 7px' }, drawer);
    head.textContent = needle ? '💡 Matching “' + needle.slice(0, 30) + '”' : '📍 On this page — tap to ask';
    rows.forEach(function (row) {
      var r = el('button', {
        display: 'flex', alignItems: 'center', gap: '11px', width: '100%', textAlign: 'left', border: '0',
        background: 'transparent', color: 'inherit', borderRadius: '11px', padding: '11px 10px',
        cursor: 'pointer', fontSize: '14px', fontWeight: '600', fontFamily: 'inherit', lineHeight: '1.35',
      }, drawer);
      r.type = 'button';
      var icon = el('span', { width: '30px', height: '30px', borderRadius: '50%', background: dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.06)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto', fontSize: '14px' }, r);
      var textWrap = el('span', { flex: '1', minWidth: '0' }, r);
      if (row.kind === 'ask') {
        icon.textContent = row.faq ? '❓' : '💬';
        highlightInto(textWrap, row.q, needle, color);
        r.addEventListener('pointerdown', function (e) { e.preventDefault(); hideDrawer(); openPanel(false, row.q); });
      } else if (row.kind === 'offer') {
        icon.textContent = '🎟️';
        textWrap.textContent = row.offer.label + (row.offer.price ? ' · ' + row.offer.currency + ' ' + row.offer.price : '');
        var go = el('span', { color: 'inherit', opacity: '.4', fontWeight: '400', fontSize: '12px', flex: '0 0 auto' }, r);
        go.textContent = 'tell me more →';
        r.addEventListener('pointerdown', function (e) { e.preventDefault(); hideDrawer(); openPanel(false, 'Tell me about ' + row.offer.label); });
      } else {
        icon.innerHTML = navIconHtml(row.nav, 15);
        highlightInto(textWrap, navLabelOf(row.nav), needle, color);
        var go2 = el('span', { color: 'inherit', opacity: '.4', fontWeight: '400', fontSize: '12px', flex: '0 0 auto' }, r);
        go2.textContent = 'open page →';
        r.addEventListener('pointerdown', function (e) { e.preventDefault(); hideDrawer(); navPick(row.nav); });
      }
      r.addEventListener('mouseenter', function () { r.style.background = dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.05)'; });
      r.addEventListener('mouseleave', function () { r.style.background = 'transparent'; });
    });
    if (barMenu) barMenu.style.display = 'none';
    drawer.style.display = 'block';
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
    // The bar wears the site's nav style: 'plus' → the ＋ menu; 'top' → inline
    // icon circles (mobile falls back to ＋ for width); 'pills'/'below' → a
    // labelled pill row above/below the input; 'off' → chat only.
    var navStyle = (ctx.site && ctx.site.navStyle) || 'top';
    var showNav = (ctx.nav || []).length > 0 && navStyle !== 'off';
    var usePlus = showNav && (navStyle === 'plus' || (navStyle === 'top' && MOBILE()));
    var inlineIcons = showNav && navStyle === 'top' && !MOBILE();
    function barPills(pad) {
      var scroller = el('div', { overflowX: 'auto', WebkitOverflowScrolling: 'touch', padding: pad }, bar);
      var inner = el('div', { display: 'flex', gap: '8px', width: 'max-content', margin: '0 auto' }, scroller);
      (ctx.nav || []).forEach(function (n) {
        var b = el('button', {
          display: 'inline-flex', alignItems: 'center', gap: '7px', flex: '0 0 auto', cursor: 'pointer', minHeight: '36px',
          border: '1px solid ' + (n.active ? color : (dark ? 'rgba(255,255,255,.22)' : 'rgba(0,0,0,.18)')),
          background: n.active ? color : (dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.04)'),
          color: n.active ? '#fff' : 'inherit',
          borderRadius: '999px', padding: '7px 13px', fontSize: '12.5px', fontWeight: '600', fontFamily: 'inherit',
        }, inner);
        b.type = 'button'; b.title = n.note || navLabelOf(n);
        b.insertAdjacentHTML('beforeend', navIconHtml(n, 14));
        var sp = el('span', {}, b); sp.textContent = navLabelOf(n);
        b.addEventListener('click', function () { navPick(n); });
      });
    }
    if (showNav && navStyle === 'pills') barPills('0 2px 8px');
    var row = el('div', { display: 'flex', gap: '9px', alignItems: 'center', position: 'relative' }, bar);
    if (usePlus) {
      var plus = el('button', {
        width: '44px', height: '44px', borderRadius: '50%', flex: '0 0 auto', cursor: 'pointer',
        border: '1.5px solid ' + (dark ? 'rgba(255,255,255,.28)' : 'rgba(0,0,0,.22)'),
        background: 'transparent', color: 'inherit', fontSize: '21px', fontWeight: '300', lineHeight: '1', padding: '0',
      }, row);
      plus.type = 'button'; plus.textContent = '+'; plus.setAttribute('aria-label', 'Site navigation');
      plus.addEventListener('click', function () {
        hideDrawer();
        if (barMenu && barMenu.style.display !== 'none') { barMenu.style.display = 'none'; return; }
        if (!barMenu) barMenu = makeNavMenu(row, dark, navPick);
        barMenu.style.display = 'block';
      });
    }
    if (inlineIcons) {
      var icons = el('div', { display: 'flex', gap: '7px', flex: '0 1 auto', overflowX: 'auto', scrollbarWidth: 'none' }, row);
      (ctx.nav || []).forEach(function (n) {
        var ib = el('button', {
          width: '40px', height: '40px', borderRadius: '50%', border: '0', flex: '0 0 auto', cursor: 'pointer', padding: '0',
          background: n.active ? color : (dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.06)'), color: n.active ? '#fff' : 'inherit',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }, icons);
        ib.type = 'button'; ib.title = n.note || navLabelOf(n); ib.setAttribute('aria-label', navLabelOf(n));
        ib.insertAdjacentHTML('beforeend', navIconHtml(n, 18));
        ib.addEventListener('click', function () { navPick(n); });
      });
    }
    barInput = makeAskPill(row, dark, color, function (q) {
      if (barMenu) barMenu.style.display = 'none';
      hideDrawer();
      openPanel(false, q || undefined);
    });
    // The half drawer: focus (empty) = this page's topics; typing = live filter.
    barInput.addEventListener('focus', renderDrawer);
    barInput.addEventListener('input', renderDrawer);
    barInput.addEventListener('blur', function () { setTimeout(hideDrawer, 150); });
    barInput.addEventListener('keydown', function (e) { if (e.key === 'Escape') { hideDrawer(); barInput.blur(); } });
    if (showNav && navStyle === 'below') barPills('8px 2px 0');
    var foot = el('div', { textAlign: 'center', fontSize: '10.5px', opacity: '.55', padding: '3px 0 2px' }, bar);
    foot.insertAdjacentHTML('beforeend', 'Powered by Howler <img src="' + base + '/email-howler.png" alt="" style="height:11px;width:11px;border-radius:50%;vertical-align:-1.5px">');
  }

  // ── The homepage hero: the ask box opens centred when a fan lands on the home
  // page (per-site toggle). Scroll, ✕ or a click outside folds it back into the
  // bar/launcher for the rest of the tab session; asking or navigating counts too.
  var heroWrap;
  function shouldHero() {
    if (!(ctx.site && ctx.site.heroHome)) return false;
    if (sstore(true, SS_HERO) === '1') return false;
    return ctx.pageType === 'home' || window.location.pathname === '/';
  }
  function dismissHero() {
    sstore(false, SS_HERO, '1');
    if (heroWrap) heroWrap.style.display = 'none';
    if (bar) bar.style.display = 'block';
    else if (launcher) launcher.style.display = 'flex';
    if (!bar) updateTeaser();
  }
  function renderHero() {
    var color = (ctx.site && ctx.site.brandColor) || '#111';
    if (bar) bar.style.display = 'none';
    if (launcher) launcher.style.display = 'none';
    heroWrap = el('div', {
      position: 'fixed', inset: '0', zIndex: '2147483001', background: 'rgba(8,6,14,.42)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '18px',
      fontFamily: '-apple-system, system-ui, sans-serif',
    }, root);
    heroWrap.addEventListener('click', function (e) { if (e.target === heroWrap) dismissHero(); });
    var card = el('div', {
      position: 'relative', width: 'min(540px, 100%)', textAlign: 'center', color: '#f4f3f1',
      background: 'rgba(16,16,20,.9)', border: '1px solid rgba(255,255,255,.09)',
      borderRadius: '26px', padding: '26px 22px 20px', boxShadow: '0 22px 70px rgba(0,0,0,.45)',
      backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', boxSizing: 'border-box',
    }, heroWrap);
    var x = el('button', { position: 'absolute', top: '10px', right: '10px', width: '32px', height: '32px', border: '0', borderRadius: '10px', background: 'rgba(255,255,255,.12)', color: '#fff', fontSize: '14px', cursor: 'pointer' }, card);
    x.type = 'button'; x.textContent = '✕'; x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', dismissHero);
    if (ctx.site && ctx.site.owlAvatar) {
      var av = el('img', { width: '54px', height: '54px', borderRadius: '50%', objectFit: 'cover', marginBottom: '10px' }, card);
      av.src = ctx.site.owlAvatar; av.alt = '';
    } else {
      var face = el('div', { width: '54px', height: '54px', borderRadius: '50%', background: 'linear-gradient(135deg,' + color + ', #8b2ae7)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '26px', marginBottom: '10px' }, card);
      face.textContent = '🦉';
    }
    var L = BAR_LOC[(navigator.language || '').slice(0, 2).toLowerCase()] || BAR_LOC[String((ctx.site && ctx.site.defaultLang) || '').slice(0, 2)] || BAR_LOC.en;
    var h = el('div', { fontSize: '21px', fontWeight: '800', letterSpacing: '-.01em', margin: '0 0 4px' }, card);
    h.textContent = (ctx.site && ctx.site.owlIntro) || L.hi.replace('{name}', (ctx.site && ctx.site.owlName) || (ctx.event && ctx.event.name) || (ctx.site && ctx.site.name) || 'the Owl');
    var sub = el('div', { fontSize: '13.5px', color: 'rgba(255,255,255,.65)', margin: '0 0 14px' }, card);
    sub.textContent = L.sub;
    // Nav in the site's chosen style (off → none; plus → ＋ beside the ask box).
    var navStyle = (ctx.site && ctx.site.navStyle) || 'top';
    var hasNav = (ctx.nav || []).length > 0 && navStyle !== 'off';
    if (hasNav && navStyle !== 'plus') {
      var navRow = el('div', { display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap', margin: '0 0 14px' }, card);
      (ctx.nav || []).forEach(function (n) {
        var isIcon = navStyle === 'top';
        var b = el('button', isIcon ? {
          width: '44px', height: '44px', borderRadius: '50%', border: '0', cursor: 'pointer',
          background: 'rgba(255,255,255,.14)', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0',
        } : {
          display: 'inline-flex', alignItems: 'center', gap: '7px', cursor: 'pointer', minHeight: '38px',
          border: '1px solid rgba(255,255,255,.22)', background: 'rgba(255,255,255,.08)', color: '#fff',
          borderRadius: '999px', padding: '8px 14px', fontSize: '12.5px', fontWeight: '600', fontFamily: 'inherit',
        }, navRow);
        b.type = 'button';
        b.title = navLabelOf(n);
        b.setAttribute('aria-label', navLabelOf(n));
        b.insertAdjacentHTML('beforeend', navIconHtml(n, isIcon ? 19 : 15));
        if (!isIcon) { var hlbl = el('span', {}, b); hlbl.textContent = navLabelOf(n); }
        b.addEventListener('click', function () { dismissHero(); navPick(n); });
      });
    }
    var askRow = el('div', { display: 'flex', gap: '9px', alignItems: 'center', position: 'relative' }, card);
    if (hasNav && navStyle === 'plus') {
      var hplus = el('button', {
        width: '44px', height: '44px', borderRadius: '50%', flex: '0 0 auto', cursor: 'pointer',
        border: '1.5px solid rgba(255,255,255,.28)', background: 'transparent', color: 'inherit',
        fontSize: '21px', fontWeight: '300', lineHeight: '1', padding: '0',
      }, askRow);
      hplus.type = 'button'; hplus.textContent = '+'; hplus.setAttribute('aria-label', 'Site navigation');
      var heroMenu = null;
      hplus.addEventListener('click', function () {
        if (heroMenu && heroMenu.style.display !== 'none') { heroMenu.style.display = 'none'; return; }
        if (!heroMenu) heroMenu = makeNavMenu(askRow, true, function (n) { dismissHero(); navPick(n); });
        heroMenu.style.display = 'block';
      });
    }
    makeAskPill(askRow, true, color, function (q) {
      dismissHero();
      openPanel(false, q || undefined);
    });
    // Scrolling away folds the hero into the bar/launcher.
    var startY = window.scrollY || 0;
    var onScroll = function () {
      if (Math.abs((window.scrollY || 0) - startY) > 60) {
        window.removeEventListener('scroll', onScroll);
        dismissHero();
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
  }


  function render() {
    var color = (ctx.site && ctx.site.brandColor) || '#111';
    root = el('div', {}, document.body);
    root.setAttribute('data-howler-fan-owl', '');
    var reopen = null;
    try { reopen = window.sessionStorage.getItem(SS_REOPEN); if (reopen) window.sessionStorage.removeItem(SS_REOPEN); } catch (e) { /* ignore */ }
    if (ctx.site && ctx.site.widgetStyle === 'bar') {
      renderBar();
      if (reopen === '1' && !MOBILE()) { openPanel(true); return; }
      if (shouldHero()) renderHero();
      return;
    }
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

    if (reopen === '1' && !MOBILE()) { openPanel(true); return; }
    if (shouldHero()) { renderHero(); return; }
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
          // The bar follows the page: refresh the placeholder + rebuild menu/drawer.
          if (barInput) barInput.placeholder = askPlaceholder();
          if (barMenu) { try { barMenu.parentNode.removeChild(barMenu); } catch (e2) { /* gone */ } barMenu = null; }
          if (drawer) { try { drawer.parentNode.removeChild(drawer); } catch (e3) { /* gone */ } drawer = null; }
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
