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
  var SS_SESSION = 'howler_fan_session_' + siteKey.slice(-8);
  var SS_TEASED = 'howler_fan_teased_' + siteKey.slice(-8);
  function store(get, key, val) {
    try { return get ? window.localStorage.getItem(key) : window.localStorage.setItem(key, val); } catch (e) { return null; }
  }
  function sstore(get, key, val) {
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

  function openPanel() {
    if (frameWrap) { frameWrap.style.display = 'block'; launcher.style.display = 'none'; beacon('widget_open'); return; }
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
    frame.src = base + '/embed/fan#sid=' + encodeURIComponent(ctx.sessionId);
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
    if (e.origin === base && e.data === 'howler-fan-owl:close') closePanel();
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
    launcher.textContent = '🦉';
    launcher.addEventListener('click', openPanel);

    // The teaser: the deterministic ribbon — the page's mapped offer (or the site's
    // configured teaser line), shown once per browser session. Pure data, no AI.
    var line = '';
    if (ctx.offer) line = ctx.offer.label + (ctx.offer.price ? ' · ' + ctx.offer.currency + ' ' + ctx.offer.price : '') + (ctx.offer.availability ? ' · ' + ctx.offer.availability : '');
    else if (ctx.site && ctx.site.teaser) line = ctx.site.teaser;
    if (line && !sstore(true, SS_TEASED)) {
      sstore(false, SS_TEASED, '1');
      teaser = el('div', {
        position: 'fixed', right: '18px', bottom: '84px', zIndex: '2147483000',
        maxWidth: MOBILE() ? 'calc(100vw - 36px)' : '300px', background: '#fff', color: '#111',
        borderRadius: '14px', padding: '12px 36px 12px 14px', fontSize: '14px', lineHeight: '1.45',
        fontFamily: '-apple-system, system-ui, sans-serif', boxShadow: '0 10px 34px rgba(0,0,0,.22)', cursor: 'pointer',
      }, root);
      var strong = el('div', { fontWeight: '700', marginBottom: '2px' }, teaser);
      strong.textContent = (ctx.event && ctx.event.name) || ctx.site.name || 'Tickets';
      var body = el('div', {}, teaser);
      body.textContent = line;
      var x = el('button', {
        position: 'absolute', top: '6px', right: '6px', width: '24px', height: '24px', border: '0',
        background: 'transparent', color: '#999', fontSize: '16px', cursor: 'pointer',
      }, teaser);
      x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Dismiss');
      x.addEventListener('click', function (e) { e.stopPropagation(); teaser.style.display = 'none'; });
      teaser.addEventListener('click', openPanel);
    }
  }

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
