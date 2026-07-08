// ─── Pulse Pixel — tag container + retargeting audiences — DISPOSABLE MODULE ──
// ONE snippet a client (or Howler, on the ticket shop) installs once:
//
//   <script async src="https://<pulse-host>/px.js?e=<entityId>"></script>
//
// The loader injects the client's OFFICIAL ad pixels (Meta `fbq`, Google `gtag`,
// TikTok `ttq`) from per-client config, fires the standard events (PageView,
// ViewContent, InitiateCheckout, Purchase, …) and ALSO beacons every event back
// to Pulse (`POST /px`) — so admin can verify the install is live and Pulse owns
// a first-party behaviour log for future segments. Swapping/adding a platform
// pixel is then a Pulse setting, never a change on the client's website.
// Remarketing lists build natively in each platform from its own pixel (full
// match rates); the "audience pack" routes below create the standard list
// definitions via the Marketing APIs so nobody has to click through Ads Manager.
//
// Per-client config (non-secret — pixel ids are publishable by design) lives in
// entity integrations, edited on BOTH surfaces via IntegrationsForm (dual-surface
// rule): pixelMetaId · pixelGoogleId · pixelTiktokId · pixelConsent
// ('auto' fire immediately | 'gated' wait for a consent signal — GDPR mode).
//
// Site events the loader understands (window.pulse('track', <event>, {value,
// currency}) or a data-pulse-event="…" attribute on any clickable element):
//   PageView · ViewContent · AddToCart · InitiateCheckout · Purchase · Lead ·
//   CompleteRegistration · Search
//
// Audience packs (idempotent — remembered per (entity, channel, pack key) in
// `pixel_audiences`, re-clicking only creates what's missing):
//   • Meta: rule-based WEBSITE Custom Audiences on the configured pixel.
//   • TikTok: rule-based website-traffic audiences. ⚠ Endpoint/field names of the
//     TikTok Marketing API drift between versions and are UNTESTED here (no creds
//     in this environment) — VERIFY against current docs before going live, same
//     caveat as server/tiktok.js.
//   • Google: no API path (Google Ads API needs a developer-token approval) —
//     the UI ships a guided how-to instead; audiences are defined once in the
//     Google Ads UI and fill from the tag we serve.
//
// Mount: require('./pixel').mount(app, { db, auth, rateLimit, meta, fetchImpl })

const META_GRAPH = 'https://graph.facebook.com/v19.0';
const TIKTOK_BASE = 'https://business-api.tiktok.com/open_api/v1.3';

// Events the collector accepts (also the loader's tracking vocabulary).
const EVENTS = ['PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout', 'Purchase', 'Lead', 'CompleteRegistration', 'Search'];

// The standard retargeting pack — one definition drives both channels.
const PACK = [
  { key: 'visitors_180', name: 'Website visitors · 180d', event: 'PageView', days: 180 },
  { key: 'visitors_30', name: 'Website visitors · 30d', event: 'PageView', days: 30 },
  { key: 'viewed_30', name: 'Viewed tickets · 30d', event: 'ViewContent', days: 30 },
  { key: 'abandoners_14', name: 'Started checkout, no purchase · 14d', event: 'InitiateCheckout', days: 14, excludeEvent: 'Purchase' },
  { key: 'purchasers_180', name: 'Purchasers · 180d', event: 'Purchase', days: 180 },
];

// ── integrations slice (index.js delegates here, like slack.applyPatch/view) ──
function applyPatch(body, set) {
  const p = body.pixel || {};
  if (p.metaPixelId !== undefined) set('pixelMetaId', String(p.metaPixelId || '').trim());
  if (p.googleTagId !== undefined) set('pixelGoogleId', String(p.googleTagId || '').trim());
  if (p.tiktokPixelId !== undefined) set('pixelTiktokId', String(p.tiktokPixelId || '').trim());
  if (p.consentMode !== undefined) set('pixelConsent', p.consentMode === 'gated' ? 'gated' : 'auto');
}
function view(i) {
  const metaPixelId = i.pixelMetaId || '', googleTagId = i.pixelGoogleId || '', tiktokPixelId = i.pixelTiktokId || '';
  return { metaPixelId, googleTagId, tiktokPixelId, consentMode: i.pixelConsent === 'gated' ? 'gated' : 'auto', configured: !!(metaPixelId || googleTagId || tiktokPixelId) };
}

function mount(app, { db, auth, rateLimit, meta, tiktok, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const sql = db.db;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS pixel_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id TEXT NOT NULL,
      event     TEXT NOT NULL,
      url       TEXT NOT NULL DEFAULT '',
      referrer  TEXT NOT NULL DEFAULT '',
      visitor   TEXT NOT NULL DEFAULT '',
      value     REAL,
      currency  TEXT NOT NULL DEFAULT '',
      at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pixel_events_entity ON pixel_events(entity_id, at);
    CREATE TABLE IF NOT EXISTS pixel_audiences (
      entity_id   TEXT NOT NULL,
      channel     TEXT NOT NULL,              -- 'meta' | 'tiktok'
      pack_key    TEXT NOT NULL,              -- PACK[].key
      audience_id TEXT NOT NULL DEFAULT '',
      name        TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT '',   -- 'ok' | 'error'
      error       TEXT NOT NULL DEFAULT '',
      at          TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (entity_id, channel, pack_key)
    );
  `);

  const config = (entityId) => view(db.getEntityIntegrations(entityId) || {});
  const ownsEntity = (req, id) => req.user.role === 'admin' || (req.user.entityIds || []).includes(id);

  // ── the loader ───────────────────────────────────────────────────────────────
  // Public + cross-origin by design (it runs on client websites). Always answers
  // 200 JS — a stale snippet on a live site must never surface an error. Short
  // cache so config changes (new pixel id, consent mode) propagate in minutes.
  app.get('/px.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300');
    const entityId = String(req.query.e || '').trim();
    if (!entityId || !db.getEntity(entityId)) return res.send('/* Pulse Pixel: unknown client — check the ?e= id in your snippet */');
    const c = config(entityId);
    const origin = `${req.protocol}://${req.get('host')}`;
    res.send(loaderJs({ entityId, origin, metaId: c.metaPixelId, googleId: c.googleTagId, tiktokId: c.tiktokPixelId, consent: c.consentMode }));
  });

  // ── hosted test page ─────────────────────────────────────────────────────────
  // A ready-made page with the snippet already installed, so an install can be
  // verified end-to-end without touching any real website: open it, watch the
  // diagnostics go green, fire the standard events with the buttons, then confirm
  // with "Check install" in Pulse + each platform's event tester. Public like the
  // loader (pixel ids are publishable; the page can do nothing an installed
  // snippet couldn't).
  app.get('/px-test', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    const entityId = String(req.query.e || '').trim();
    const ent = entityId ? db.getEntity(entityId) : null;
    if (!ent) return res.send('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px"><h2>Pulse Pixel test page</h2><p>Unknown client — open this page with your client id: <code>/px-test?e=&lt;clientId&gt;</code> (copy the link from the 🎯 Pulse Pixel section in Pulse).</p>');
    const origin = `${req.protocol}://${req.get('host')}`;
    res.send(testPageHtml({ entityId, name: ent.name || entityId, origin, cfg: config(entityId) }));
  });

  // ── event collection ─────────────────────────────────────────────────────────
  // Beacons arrive as text/plain (a CORS "simple request" — no preflight from
  // foreign websites) so the global JSON body parser skips them; read raw here.
  // Cheap hot path: one prepared INSERT; occasional probabilistic prune.
  const insertEvent = sql.prepare('INSERT INTO pixel_events (entity_id, event, url, referrer, visitor, value, currency, at) VALUES (?,?,?,?,?,?,?,?)');
  app.post('/px', rateLimit({ windowMs: 60_000, max: 300, by: 'ip' }), (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return readBody(req).then((b) => {
      const entityId = String(b.e || '').trim();
      const event = String(b.ev || '').trim();
      if (!entityId || !EVENTS.includes(event) || !db.getEntity(entityId)) return res.status(204).end();
      const value = Number.isFinite(Number(b.v)) && b.v !== '' && b.v != null ? Number(b.v) : null;
      insertEvent.run(entityId, event, String(b.url || '').slice(0, 500), String(b.r || '').slice(0, 300), String(b.vid || '').slice(0, 64), value, String(b.c || '').slice(0, 8), new Date().toISOString());
      // Keep the log bounded: ~1-in-500 hits sweeps rows older than 90 days.
      if (Math.random() < 0.002) {
        try { sql.prepare('DELETE FROM pixel_events WHERE at < ?').run(new Date(Date.now() - 90 * 86400_000).toISOString()); } catch { /* best-effort */ }
      }
      res.status(204).end();
    }).catch(() => res.status(204).end()); // collection must never error a client site
  });

  // ── install status (drives the "✓ receiving events" check in the UI) ─────────
  function status(entityId) {
    const c = config(entityId);
    const dayAgo = new Date(Date.now() - 86400_000).toISOString();
    const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
    const last = sql.prepare('SELECT at FROM pixel_events WHERE entity_id=? ORDER BY id DESC LIMIT 1').get(entityId);
    const events24h = sql.prepare('SELECT COUNT(*) n FROM pixel_events WHERE entity_id=? AND at>=?').get(entityId, dayAgo).n;
    const byEvent = sql.prepare('SELECT event, COUNT(*) n FROM pixel_events WHERE entity_id=? AND at>=? GROUP BY event').all(entityId, weekAgo);
    const audiences = sql.prepare('SELECT channel, pack_key, audience_id, name, status, error, at FROM pixel_audiences WHERE entity_id=?').all(entityId);
    return { ...c, lastEventAt: last?.at || '', events24h, events7d: Object.fromEntries(byEvent.map((r) => [r.event, r.n])), audiences };
  }
  app.get('/api/admin/entities/:id/pixel/status', auth.requireAdmin, (req, res) => {
    if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
    res.json(status(req.params.id));
  });
  app.get('/api/my/pixel/:entityId/status', auth.requireAuth, (req, res) => {
    const id = req.params.entityId;
    if (!ownsEntity(req, id)) return res.status(403).json({ error: 'Not allowed' });
    if (!db.getEntity(id)) return res.status(404).json({ error: 'Not found' });
    res.json(status(id));
  });

  // ── audience packs ───────────────────────────────────────────────────────────
  const remember = sql.prepare(`INSERT INTO pixel_audiences (entity_id, channel, pack_key, audience_id, name, status, error, at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(entity_id, channel, pack_key) DO UPDATE SET audience_id=excluded.audience_id, name=excluded.name, status=excluded.status, error=excluded.error, at=excluded.at`);
  const existing = sql.prepare('SELECT pack_key, audience_id, status FROM pixel_audiences WHERE entity_id=? AND channel=?');

  // Meta: rule-based WEBSITE Custom Audiences on the configured pixel. One call
  // per missing pack entry; already-created entries are skipped (idempotent).
  async function createMetaPack(entityId) {
    const { metaPixelId } = config(entityId);
    if (!metaPixelId) return { ok: false, error: 'Set the Meta Pixel ID first (Pulse Pixel section).' };
    const conn = meta.connection(entityId);
    if (!conn.accessToken || !conn.adAccountId) return { ok: false, error: 'Meta is not connected for this client (token + ad account).' };
    const done = new Map(existing.all(entityId, 'meta').filter((r) => r.status === 'ok' && r.audience_id).map((r) => [r.pack_key, r]));
    const results = [];
    for (const p of PACK) {
      if (done.has(p.key)) { results.push({ key: p.key, name: `${p.name} (Pulse)`, audienceId: done.get(p.key).audience_id, status: 'exists' }); continue; }
      const name = `${p.name} (Pulse)`;
      try {
        const body = {
          name, subtype: 'WEBSITE', prefill: true, description: 'Standard retargeting audience created by Howler Pulse',
          rule: JSON.stringify(metaRule(metaPixelId, p)), access_token: conn.accessToken,
        };
        const r = await doFetch(`${META_GRAPH}/${conn.adAccountId}/customaudiences`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.error) throw new Error(d.error?.message || `Meta HTTP ${r.status}`);
        remember.run(entityId, 'meta', p.key, String(d.id || ''), name, 'ok', '', new Date().toISOString());
        results.push({ key: p.key, name, audienceId: String(d.id || ''), status: 'created' });
      } catch (e) {
        remember.run(entityId, 'meta', p.key, '', name, 'error', e.message, new Date().toISOString());
        results.push({ key: p.key, name, status: 'error', error: e.message });
      }
    }
    const errors = results.filter((r) => r.status === 'error').length;
    return { ok: errors === 0, created: results.filter((r) => r.status === 'created').length, existed: results.filter((r) => r.status === 'exists').length, errors, results };
  }

  // Meta website-audience rule: include <event> in the last <days>; optionally
  // exclude people who fired <excludeEvent> in the same window (abandoners).
  function metaRule(pixelId, p) {
    const clause = (event, days) => ({
      event_sources: [{ id: pixelId, type: 'pixel' }],
      retention_seconds: days * 86400,
      filter: { operator: 'and', filters: [{ field: 'event', operator: 'eq', value: event }] },
    });
    const rule = { inclusions: { operator: 'or', rules: [clause(p.event, p.days)] } };
    if (p.excludeEvent) rule.exclusions = { operator: 'or', rules: [clause(p.excludeEvent, p.days)] };
    return rule;
  }

  // TikTok: rule-based website-traffic audiences from the pixel. ⚠ UNTESTED
  // against a live advertiser account — the v1.3 rule endpoint/field names below
  // follow the docs but MUST be verified before first live use (see header note).
  const TIKTOK_EVENT = { PageView: 'Pageview', ViewContent: 'ViewContent', AddToCart: 'AddToCart', InitiateCheckout: 'InitiateCheckout', Purchase: 'CompletePayment' };
  async function createTiktokPack(entityId) {
    const { tiktokPixelId } = config(entityId);
    if (!tiktokPixelId) return { ok: false, error: 'Set the TikTok Pixel ID first (Pulse Pixel section).' };
    const conn = tiktok.connection(entityId);
    if (!conn.accessToken || !conn.advertiserId) return { ok: false, error: 'TikTok is not connected for this client (token + advertiser id).' };
    const done = new Map(existing.all(entityId, 'tiktok').filter((r) => r.status === 'ok' && r.audience_id).map((r) => [r.pack_key, r]));
    const results = [];
    for (const p of PACK) {
      if (done.has(p.key)) { results.push({ key: p.key, name: `${p.name} (Pulse)`, audienceId: done.get(p.key).audience_id, status: 'exists' }); continue; }
      const name = `${p.name} (Pulse)`;
      try {
        const ruleSet = (event, days) => ({
          operation: 'AND',
          rules: [{ event_source_ids: [tiktokPixelId], retention_days: days, filter_set: { operation: 'AND', filters: [{ field: 'EVENT', operator: 'EQ', values: [TIKTOK_EVENT[event] || event] }] } }],
        });
        const body = {
          advertiser_id: conn.advertiserId, custom_audience_name: name, audience_sub_type: 'NORMAL',
          rule_spec: { inclusion_rule_set: { operation: 'OR', rule_sets: [ruleSet(p.event, p.days)] }, ...(p.excludeEvent ? { exclusion_rule_set: { operation: 'OR', rule_sets: [ruleSet(p.excludeEvent, p.days)] } } : {}) },
        };
        const r = await doFetch(`${TIKTOK_BASE}/dmp/custom_audience/rule/create/`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Access-Token': conn.accessToken }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.code !== 0) throw new Error(d.message || `TikTok HTTP ${r.status}`);
        const audienceId = String(d.data?.custom_audience_id || '');
        remember.run(entityId, 'tiktok', p.key, audienceId, name, 'ok', '', new Date().toISOString());
        results.push({ key: p.key, name, audienceId, status: 'created' });
      } catch (e) {
        remember.run(entityId, 'tiktok', p.key, '', name, 'error', e.message, new Date().toISOString());
        results.push({ key: p.key, name, status: 'error', error: e.message });
      }
    }
    const errors = results.filter((r) => r.status === 'error').length;
    return { ok: errors === 0, created: results.filter((r) => r.status === 'created').length, existed: results.filter((r) => r.status === 'exists').length, errors, results };
  }

  const createPack = (channel, entityId) => (channel === 'tiktok' ? createTiktokPack(entityId) : channel === 'meta' ? createMetaPack(entityId) : Promise.resolve({ ok: false, error: 'Unknown channel' }));
  app.post('/api/admin/entities/:id/pixel/audiences', auth.requireAdmin, (req, res, next) => {
    if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
    return createPack(String(req.body?.channel || ''), req.params.id).then((r) => res.json(r)).catch(next);
  });
  app.post('/api/my/pixel/:entityId/audiences', auth.requireAuth, (req, res, next) => {
    const id = req.params.entityId;
    if (!ownsEntity(req, id)) return res.status(403).json({ error: 'Not allowed' });
    if (!db.getEntity(id)) return res.status(404).json({ error: 'Not found' });
    return createPack(String(req.body?.channel || ''), id).then((r) => res.json(r)).catch(next);
  });

  return { config, status, createMetaPack, createTiktokPack, isConfigured: (id) => config(id).configured };
}

// Read a small request body regardless of content type: tests/json-parsed
// requests already carry req.body; text/plain beacons are read raw (4 KB cap).
function readBody(req) {
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) return Promise.resolve(req.body);
  if (typeof req.body === 'string' && req.body) { try { return Promise.resolve(JSON.parse(req.body)); } catch { return Promise.resolve({}); } }
  return new Promise((resolve) => {
    let raw = ''; let over = false;
    req.on('data', (ch) => { raw += ch; if (raw.length > 4096) { over = true; resolve({}); req.destroy?.(); } });
    req.on('end', () => { if (over) return; try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// The loader itself — plain ES5, no dependencies, safe on any site. Everything
// is wrapped so a partial ad-blocker (fbq blocked, gtag fine) never breaks the
// page or the other pixels. Config is inlined per entity at serve time.
function loaderJs({ entityId, origin, metaId, googleId, tiktokId, consent }) {
  const cfg = JSON.stringify({ e: entityId, o: origin, m: metaId || '', g: googleId || '', t: tiktokId || '', consent: consent || 'auto' });
  return `(function(){
if(window.__pulsePixel)return;window.__pulsePixel=1;
var C=${cfg};
function vid(){try{var k='_pulse_vid',v=localStorage.getItem(k);if(!v){v=Math.random().toString(36).slice(2)+Date.now().toString(36);localStorage.setItem(k,v);}return v;}catch(e){return '';}}
function beacon(ev,p){try{var b=JSON.stringify({e:C.e,ev:ev,url:String(location.href).slice(0,500),r:String(document.referrer||'').slice(0,300),vid:vid(),v:p&&p.value,c:p&&p.currency});
if(navigator.sendBeacon){navigator.sendBeacon(C.o+'/px',new Blob([b],{type:'text/plain'}));}else{fetch(C.o+'/px',{method:'POST',headers:{'Content-Type':'text/plain'},body:b,keepalive:true});}}catch(e){}}
var GMAP={ViewContent:'view_item',AddToCart:'add_to_cart',InitiateCheckout:'begin_checkout',Purchase:'purchase',Lead:'generate_lead',CompleteRegistration:'sign_up',Search:'search'};
var TMAP={ViewContent:'ViewContent',AddToCart:'AddToCart',InitiateCheckout:'InitiateCheckout',Purchase:'CompletePayment',Lead:'SubmitForm',CompleteRegistration:'CompleteRegistration',Search:'Search'};
function track(ev,p){p=p||{};var m=p.value!=null?{value:p.value,currency:p.currency||'ZAR'}:{};
try{if(C.m&&window.fbq)fbq('track',ev,m);}catch(e){}
try{if(C.g&&window.gtag&&GMAP[ev])gtag('event',GMAP[ev],m);}catch(e){}
try{if(C.t&&window.ttq&&TMAP[ev])ttq.track(TMAP[ev],p.value!=null?{value:p.value,currency:p.currency||'ZAR'}:{});}catch(e){}
beacon(ev,p);}
function page(){try{if(C.m&&window.fbq)fbq('track','PageView');}catch(e){}
try{if(C.t&&window.ttq)ttq.page();}catch(e){}
try{if(C.g&&window.gtag)gtag('event','page_view');}catch(e){}
beacon('PageView');}
function inject(){
if(C.m){!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init',C.m);}
if(C.g){window.dataLayer=window.dataLayer||[];window.gtag=window.gtag||function(){dataLayer.push(arguments);};gtag('js',new Date());gtag('config',C.g,{send_page_view:false});var gs=document.createElement('script');gs.async=1;gs.src='https://www.googletagmanager.com/gtag/js?id='+encodeURIComponent(C.g);document.head.appendChild(gs);}
if(C.t){!function(w,d,t){w.TiktokAnalyticsObject=t;var q=w[t]=w[t]||[];q.methods=['page','track','identify','instances','debug','on','off','once','ready','alias','group','enableCookie','disableCookie'];q.setAndDefer=function(o,e){o[e]=function(){o.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<q.methods.length;i++)q.setAndDefer(q,q.methods[i]);q.instance=function(e){for(var o=q._i[e]||[],n=0;n<q.methods.length;n++)q.setAndDefer(o,q.methods[n]);return o};q.load=function(e,o){var n='https://analytics.tiktok.com/i18n/pixel/events.js';q._i=q._i||{};q._i[e]=[];q._i[e]._u=n;q._t=q._t||{};q._t[e]=+new Date;q._o=q._o||{};q._o[e]=o||{};var a=d.createElement('script');a.type='text/javascript';a.async=!0;a.src=n+'?sdkid='+e+'&lib='+t;var s=d.getElementsByTagName('script')[0];s.parentNode.insertBefore(a,s)}}(window,document,'ttq');ttq.load(C.t);}
page();
var ps=history.pushState;history.pushState=function(){ps.apply(this,arguments);setTimeout(page,60);};
window.addEventListener('popstate',function(){setTimeout(page,60);});
document.addEventListener('click',function(ev){var el=ev.target&&ev.target.closest&&ev.target.closest('[data-pulse-event]');if(!el)return;var v=parseFloat(el.getAttribute('data-pulse-value'));track(el.getAttribute('data-pulse-event')||'Lead',{value:isNaN(v)?undefined:v,currency:el.getAttribute('data-pulse-currency')||undefined});},true);
var q=(window.pulse&&window.pulse.q)||[];
window.pulse=function(cmd,ev,p){if(cmd==='track'&&ev)track(String(ev),p);};
for(var i=0;i<q.length;i++){try{window.pulse.apply(null,q[i]);}catch(e){}}
}
if(!window.pulse){window.pulse=function(){(window.pulse.q=window.pulse.q||[]).push(Array.prototype.slice.call(arguments));};}
if(C.consent==='gated'){
var armed=false;function grant(){if(armed)return;armed=true;inject();}
window.pulseGrantConsent=grant;
window.addEventListener('pulse-consent',grant);
if(window.pulseConsent===true)grant();
}else{inject();}
})();
`;
}

// The hosted test page (GET /px-test?e=…). Mobile-first, no dependencies. It
// installs the real snippet, then: shows which pixel globals actually appeared
// (an ad-blocker check), pings the Pulse collector, and offers buttons that fire
// each standard event — one via data-pulse-event to exercise that binding too.
function testPageHtml({ entityId, name, origin, cfg }) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const row = (label, id) => `<div class="chk" id="${id}"><span class="dot">…</span> ${label}</div>`;
  const platforms = [
    cfg.metaPixelId ? `◇ Meta Pixel <code>${esc(cfg.metaPixelId)}</code>` : '',
    cfg.googleTagId ? `G Google tag <code>${esc(cfg.googleTagId)}</code>` : '',
    cfg.tiktokPixelId ? `♪ TikTok Pixel <code>${esc(cfg.tiktokPixelId)}</code>` : '',
  ].filter(Boolean).join(' · ') || '<b>No pixel ids configured yet</b> — save at least one in Pulse first (the beacon to Pulse still works, so "Check install" can go green).';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pulse Pixel test — ${esc(name)}</title>
<style>
  body{font-family:-apple-system,system-ui,sans-serif;margin:0;background:#f5f5f7;color:#1c1c1e}
  .wrap{max-width:640px;margin:0 auto;padding:22px 16px 60px}
  .card{background:#fff;border:1px solid #e3e3e6;border-radius:14px;padding:16px 16px;margin-bottom:14px}
  h1{font-size:19px;margin:0 0 4px}h2{font-size:14px;margin:0 0 10px}
  .muted{color:#6e6e73;font-size:12.5px;line-height:1.5}
  .chk{font-size:13.5px;margin:7px 0;font-weight:600}
  .dot{display:inline-block;width:18px}
  .ok .dot::before{content:"✓";color:#10b981}.ok .dot{color:transparent}
  .bad .dot::before{content:"✗";color:#ef4444}.bad .dot{color:transparent}
  button{display:block;width:100%;box-sizing:border-box;margin:8px 0;padding:13px;font-size:14px;font-weight:700;border:1px solid #d8d8dc;border-radius:12px;background:#fff;cursor:pointer;min-height:44px}
  button:active{background:#f0f0f2}
  .buy{background:#10b981;border-color:#10b981;color:#fff}
  #log{font-family:ui-monospace,monospace;font-size:11.5px;line-height:1.7;color:#3a3a3c;max-height:220px;overflow:auto;white-space:pre-wrap}
  code{background:#f0f0f2;padding:1px 5px;border-radius:5px;font-size:11.5px}
  .consent{background:#b45309;border-color:#b45309;color:#fff}
</style></head><body><div class="wrap">
<div class="card"><h1>🎯 Pulse Pixel test page</h1>
  <div class="muted">Client: <b>${esc(name)}</b> · the snippet below is live on THIS page — loading it already fired a <b>PageView</b>.</div>
  <div class="muted" style="margin-top:6px">${platforms}</div>
</div>
<div class="card"><h2>1 · Did the pixels load?</h2>
  ${cfg.consentMode === 'gated' ? '<button class="consent" id="grant">🔓 Grant consent (this client is in GDPR mode — pixels wait for this)</button>' : ''}
  ${cfg.metaPixelId ? row('Meta Pixel (fbq) present', 'chk-fbq') : ''}
  ${cfg.googleTagId ? row('Google tag (gtag) present', 'chk-gtag') : ''}
  ${cfg.tiktokPixelId ? row('TikTok Pixel (ttq) present', 'chk-ttq') : ''}
  ${row('Pulse collector reachable', 'chk-beacon')}
  <div class="muted">A ✗ on a pixel usually means an ad-blocker on this device. Final confirmation always comes from the platform's own tester — Meta <b>Events Manager → Test events</b>, TikTok <b>Events → Test</b>, Google <b>Tag Assistant</b> — and from <b>Check install</b> in Pulse.</div>
</div>
<div class="card"><h2>2 · Fire test events</h2>
  <button onclick="fire('ViewContent')">👀 View tickets (ViewContent)</button>
  <button onclick="fire('AddToCart')">🛒 Add to cart (AddToCart)</button>
  <button onclick="fire('InitiateCheckout')">💳 Start checkout (InitiateCheckout)</button>
  <button class="buy" onclick="fire('Purchase',{value:150,currency:'ZAR'})">✅ Purchase — R150 (Purchase)</button>
  <button data-pulse-event="Lead" data-pulse-value="0" onclick="log('Lead — fired via the data-pulse-event attribute binding')">⭐ Lead (via data-pulse-event attribute)</button>
  <div class="muted">Fire a few, wait ~a minute, then hit <b>Check install</b> in Pulse — the 24h counts should tick up. In Meta/TikTok test tools you should see the same events arrive.</div>
</div>
<div class="card"><h2>3 · What happened on this page</h2><div id="log">waiting…</div></div>
</div>
<script async src="${origin}/px.js?e=${encodeURIComponent(entityId)}"></script>
<script>
var L=document.getElementById('log');L.textContent='';
function log(m){L.textContent+=new Date().toTimeString().slice(0,8)+'  '+m+'\\n';L.scrollTop=L.scrollHeight;}
function fire(ev,p){try{window.pulse('track',ev,p);log(ev+(p&&p.value?' (value '+p.value+' '+(p.currency||'')+')':'')+' — sent to every loaded pixel + Pulse');}catch(e){log('✗ '+ev+' failed: '+e.message);}}
function mark(id,ok){var el=document.getElementById(id);if(el)el.className='chk '+(ok?'ok':'bad');}
var g=document.getElementById('grant');if(g)g.onclick=function(){try{window.pulseGrantConsent&&window.pulseGrantConsent();log('consent granted — pixels injecting now');g.disabled=true;g.textContent='✓ Consent granted';setTimeout(checks,2500);}catch(e){log('✗ consent grant failed: '+e.message);}};
function checks(){
  ${cfg.metaPixelId ? "mark('chk-fbq',!!window.fbq);log((window.fbq?'✓':'✗')+' fbq '+(window.fbq?'present':'missing — ad-blocker?'));" : ''}
  ${cfg.googleTagId ? "mark('chk-gtag',!!window.gtag);log((window.gtag?'✓':'✗')+' gtag '+(window.gtag?'present':'missing — ad-blocker?'));" : ''}
  ${cfg.tiktokPixelId ? "mark('chk-ttq',!!window.ttq);log((window.ttq?'✓':'✗')+' ttq '+(window.ttq?'present':'missing — ad-blocker?'));" : ''}
}
// The collector answers 204 to a valid-entity ping — proves Pulse can hear this page.
fetch('${origin}/px',{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({e:'${entityId}',ev:'PageView',url:location.href,vid:'px-test'})})
  .then(function(r){mark('chk-beacon',r.status===204);log((r.status===204?'✓':'✗')+' Pulse collector answered '+r.status);})
  .catch(function(e){mark('chk-beacon',false);log('✗ Pulse collector unreachable: '+e.message);});
log('page loaded — PageView fired by the snippet${cfg.consentMode === 'gated' ? ' (WAITING for consent — tap the orange button)' : ''}');
setTimeout(checks,2500);
</script></body></html>`;
}

module.exports = { mount, applyPatch, view, PACK, EVENTS };
