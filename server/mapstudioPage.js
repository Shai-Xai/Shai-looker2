// ─── Map Studio: standalone map page renderer ───────────────────────────────────
// Factory library (no routes, no tables) used by server/mapstudio.js. Renders the
// self-contained HTML page for a published event map (mode 'live' — what the Howler
// app WebView + any browser loads) and for the editor preview (mode 'edit' — an
// iframe inside MapStudio.jsx that talks to the editor via postMessage).
//
// Design constraints:
//   • Mobile-first: the Howler app WebView on a phone at a festival IS the primary
//     surface. Filter chips, bottom sheet, big tap targets, hard caching.
//   • Degrades without a Mapbox token: renders the place list + filters + sheets
//     (no basemap) instead of failing — the page must never be a dead end.
//   • Live mode sends anonymous beacons (open / poi_tap / cta_click / filter) to
//     /maps/:slug/e — aggregate analytics only, no identity, no location.
//   • Edit mode: draggable markers, click-to-place, camera capture — all via
//     postMessage with the parent editor; no beacons, draft data injected inline.

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Mapbox style presets the studio offers. Dark is the default (matches the app).
const STYLES = {
  dark: 'mapbox://styles/mapbox/dark-v11',
  streets: 'mapbox://styles/mapbox/streets-v12',
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
  outdoors: 'mapbox://styles/mapbox/outdoors-v12',
};
const styleUrl = (key) => STYLES[key] || STYLES.dark;

// { mode: 'live'|'edit', title, token, config: published-or-draft snapshot, beaconPath }
// config = { name, style, camera:{lat,lng,zoom,pitch,bearing}, categories:[{key,label,color,icon}], places:[...] }
function renderMapPage({ mode, title, token, config, beaconPath }) {
  const live = mode === 'live';
  const boot = JSON.stringify({ mode, token: token || '', config, beaconPath: beaconPath || '' })
    .replace(/</g, '\\u003c'); // never let place text close the script tag
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="theme-color" content="#101418">
<title>${esc(title)}</title>
${token ? '<link href="https://api.mapbox.com/mapbox-gl-js/v3.9.0/mapbox-gl.css" rel="stylesheet">' : ''}
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  html, body { height: 100%; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #101418; color: #eef1f5; overflow: hidden; }
  #map { position: absolute; inset: 0; }
  .mapboxgl-ctrl-logo { opacity: .6; }
  /* top chrome: title + filter chips over the map */
  .top { position: absolute; top: 0; left: 0; right: 0; z-index: 20; padding: 12px 12px 18px;
    background: linear-gradient(180deg, rgba(10,12,15,.85) 30%, rgba(10,12,15,0)); pointer-events: none; }
  .ttl { font-size: 14px; font-weight: 700; letter-spacing: -.01em; margin: 0 2px 8px; }
  .ttl small { display: block; font-weight: 400; font-size: 11px; color: #9aa4af; margin-top: 1px; }
  .chips { display: flex; gap: 7px; overflow-x: auto; padding-bottom: 4px; scrollbar-width: none; pointer-events: auto; }
  .chips::-webkit-scrollbar { display: none; }
  .chip { flex: none; display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; color: #dfe4ea;
    background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.14); border-radius: 999px;
    padding: 8px 13px; cursor: pointer; font-family: inherit; min-height: 36px; }
  .chip .sw { width: 8px; height: 8px; border-radius: 50%; }
  .chip.on { background: #fff; color: #16181c; border-color: #fff; }
  /* markers */
  .pmark { display: flex; flex-direction: column; align-items: center; gap: 3px; cursor: pointer; }
  .pmark .bub { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; font-size: 16px;
    border: 2px solid rgba(255,255,255,.9); box-shadow: 0 4px 10px rgba(0,0,0,.45); background: #666; overflow: hidden; }
  .pmark .bub img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; background: #fff; }
  .pmark .lbl { font-size: 10px; font-weight: 600; color: #eef1f5; background: rgba(10,13,16,.72);
    padding: 2px 8px; border-radius: 999px; white-space: nowrap; max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
  .pmark.sel .bub { outline: 3px solid #ff385c; outline-offset: 2px; }
  /* bottom sheet */
  .sheet { position: absolute; left: 0; right: 0; bottom: 0; z-index: 30; background: #1c1f24; color: #eef1f5;
    border-radius: 20px 20px 0 0; padding: 10px 18px calc(20px + env(safe-area-inset-bottom));
    box-shadow: 0 -12px 40px rgba(0,0,0,.5); transform: translateY(110%); transition: transform .28s cubic-bezier(.22,1,.36,1); }
  .sheet.open { transform: none; }
  @media (prefers-reduced-motion: reduce) { .sheet { transition: none; } }
  .grab { width: 38px; height: 4px; border-radius: 999px; background: rgba(255,255,255,.2); margin: 0 auto 12px; }
  .sh-head { display: flex; align-items: center; gap: 12px; }
  .sh-logo { width: 44px; height: 44px; border-radius: 50%; flex: none; display: grid; place-items: center; font-size: 19px;
    border: 2px solid rgba(255,255,255,.15); overflow: hidden; background: #666; }
  .sh-logo img { width: 100%; height: 100%; object-fit: cover; background: #fff; }
  .sh-title { font-size: 16px; font-weight: 700; letter-spacing: -.01em; }
  .sh-cat { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: #9aa4af; margin-top: 2px; }
  .sh-cat .sw { width: 7px; height: 7px; border-radius: 50%; }
  .sh-close { margin-left: auto; width: 30px; height: 30px; border-radius: 50%; border: none; background: rgba(255,255,255,.1);
    color: #9aa4af; font-size: 14px; cursor: pointer; flex: none; }
  .sh-desc { font-size: 13.5px; line-height: 1.5; color: #c6ccd4; margin: 10px 0 14px; white-space: pre-wrap; }
  .sh-ctas { display: flex; gap: 9px; }
  .cta { flex: 1; font-family: inherit; font-size: 14px; font-weight: 600; border-radius: 999px; padding: 13px 0;
    text-align: center; cursor: pointer; border: none; min-height: 44px; }
  .cta.p { background: linear-gradient(135deg, #ff385c, #ff6b35); color: #fff; }
  .cta.s { background: none; border: 1px solid rgba(255,255,255,.18); color: #eef1f5; }
  /* no-token fallback list */
  .fallback { position: absolute; inset: 0; overflow: auto; padding: 86px 14px 30px; z-index: 5; }
  .fb-note { font-size: 12px; color: #9aa4af; margin: 0 2px 12px; }
  .fb-row { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; font-family: inherit;
    background: #1c1f24; border: 1px solid rgba(255,255,255,.08); border-radius: 14px; padding: 12px; margin-bottom: 8px;
    color: #eef1f5; cursor: pointer; }
  .fb-row .bub { width: 38px; height: 38px; border-radius: 50%; display: grid; place-items: center; font-size: 16px; flex: none; overflow: hidden; }
  .fb-row .bub img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; background: #fff; }
  .fb-row .nm { font-size: 14px; font-weight: 600; }
  .fb-row .ct { font-size: 11.5px; color: #9aa4af; }
  .powered { position: absolute; right: 10px; bottom: 8px; z-index: 15; font-size: 9.5px; color: #7d8794;
    background: rgba(10,13,16,.55); padding: 3px 9px; border-radius: 999px; }
  .errbar { position: absolute; left: 12px; right: 12px; top: 50%; transform: translateY(-50%); z-index: 18;
    background: rgba(74,16,13,.92); color: #ffd7d4; border: 1px solid rgba(255,84,73,.4); border-radius: 12px;
    padding: 12px 16px; font-size: 13px; line-height: 1.5; text-align: center; }
  .editbar { position: absolute; left: 10px; bottom: 10px; z-index: 25; font-size: 11px; color: #c8d0d9;
    background: rgba(10,13,16,.7); padding: 6px 12px; border-radius: 999px; }
</style>
</head>
<body>
<div id="map"></div>
<div class="top">
  <h1 class="ttl">${esc(config.name || 'Event map')}<small id="sub">${live ? 'Tap a pin for details' : 'Editor preview — click the map to add a place, drag pins to move them'}</small></h1>
  <div class="chips" id="chips"></div>
</div>
<div class="fallback" id="fallback" hidden></div>
<div class="sheet" id="sheet">
  <div class="grab"></div>
  <div class="sh-head">
    <div class="sh-logo" id="shLogo"></div>
    <div style="min-width:0">
      <div class="sh-title" id="shTitle"></div>
      <div class="sh-cat" id="shCat"></div>
    </div>
    <button class="sh-close" id="shClose" aria-label="Close">✕</button>
  </div>
  <p class="sh-desc" id="shDesc"></p>
  <div class="sh-ctas" id="shCtas"></div>
</div>
${live ? '<div class="powered">Powered by Howler Pulse</div>' : '<div class="editbar">Editor preview · changes save from the panel</div>'}
${token ? '<script src="https://api.mapbox.com/mapbox-gl-js/v3.9.0/mapbox-gl.js"></script>' : ''}
<script>
const BOOT = ${boot};
let cfg = BOOT.config;
const LIVE = BOOT.mode === 'live';
let filter = 'all';
let selectedId = '';
let map = null;
const markers = new Map(); // placeId -> mapboxgl.Marker

const catOf = (key) => (cfg.categories || []).find((c) => c.key === key) || { key, label: key, color: '#8899aa', icon: '📍' };

function beacon(kind, placeId) {
  if (!LIVE || !BOOT.beaconPath) return;
  try {
    const body = JSON.stringify({ kind, placeId: placeId || '' });
    if (navigator.sendBeacon) navigator.sendBeacon(BOOT.beaconPath, new Blob([body], { type: 'application/json' }));
    else fetch(BOOT.beaconPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true });
  } catch {}
}

// ── filter chips ──────────────────────────────────────────────────────────────
function renderChips() {
  const el = document.getElementById('chips');
  const cats = (cfg.categories || []).filter((c) => (cfg.places || []).some((p) => p.kind === c.key && p.showInFilters !== false));
  el.innerHTML = '';
  const mk = (key, label, color) => {
    const b = document.createElement('button');
    b.className = 'chip' + (filter === key ? ' on' : '');
    b.innerHTML = (color ? '<span class="sw" style="background:' + color + '"></span>' : '') + label;
    b.onclick = () => { filter = key; beacon('filter', key); renderChips(); renderPlaces(); };
    el.appendChild(b);
  };
  mk('all', 'All');
  cats.forEach((c) => mk(c.key, c.label, c.color));
}

const visiblePlaces = () => (cfg.places || []).filter((p) => (filter === 'all' || p.kind === filter) && (LIVE ? p.showInFilters !== false || filter !== 'all' : true));

// ── markers / fallback list ───────────────────────────────────────────────────
function markerEl(p) {
  const cat = catOf(p.kind);
  const el = document.createElement('div');
  el.className = 'pmark' + (p.id === selectedId ? ' sel' : '');
  el.innerHTML = '<span class="bub" style="background:' + cat.color + '">' +
    (p.logo ? '<img alt="" src="' + p.logo + '">' : (p.icon || cat.icon || '📍')) +
    '</span><span class="lbl"></span>';
  el.querySelector('.lbl').textContent = p.name;
  el.addEventListener('click', (e) => { e.stopPropagation(); select(p.id); });
  return el;
}

function renderPlaces() {
  const vis = visiblePlaces();
  if (map) {
    const keep = new Set(vis.map((p) => p.id));
    for (const [id, m] of markers) if (!keep.has(id)) { m.remove(); markers.delete(id); }
    vis.forEach((p) => {
      let m = markers.get(p.id);
      if (!m) {
        m = new mapboxgl.Marker({ element: markerEl(p), anchor: 'bottom', draggable: !LIVE });
        m.setLngLat([p.lng, p.lat]).addTo(map);
        if (!LIVE) m.on('dragend', () => { const ll = m.getLngLat(); post({ type: 'poi:moved', id: p.id, lat: ll.lat, lng: ll.lng }); });
        markers.set(p.id, m);
      } else {
        m.setLngLat([p.lng, p.lat]);
        const el = markerEl(p); m.getElement().replaceChildren(...el.childNodes); m.getElement().className = el.className;
      }
    });
  }
  // fallback list (also shown under the map when no token)
  const fb = document.getElementById('fallback');
  if (!map) {
    fb.hidden = false;
    fb.innerHTML = '<p class="fb-note">' + (LIVE ? 'Map view is warming up — here is everything at the event:' : 'Add a Mapbox token in the studio to see the basemap. Places still work:') + '</p>';
    vis.forEach((p) => {
      const cat = catOf(p.kind);
      const b = document.createElement('button');
      b.className = 'fb-row';
      b.innerHTML = '<span class="bub" style="background:' + cat.color + '">' + (p.logo ? '<img alt="" src="' + p.logo + '">' : (p.icon || cat.icon)) + '</span>' +
        '<span style="min-width:0"><span class="nm"></span><br><span class="ct"></span></span>';
      b.querySelector('.nm').textContent = p.name;
      b.querySelector('.ct').textContent = cat.label;
      b.onclick = () => select(p.id);
      fb.appendChild(b);
    });
  } else fb.hidden = true;
}

// ── bottom sheet ─────────────────────────────────────────────────────────────
function select(id) {
  selectedId = id;
  const p = (cfg.places || []).find((x) => x.id === id);
  if (!p) return closeSheet();
  const cat = catOf(p.kind);
  beacon('poi_tap', p.id);
  if (!LIVE) post({ type: 'poi:selected', id });
  document.getElementById('shLogo').innerHTML = p.logo ? '<img alt="" src="' + p.logo + '">' : (p.icon || cat.icon);
  document.getElementById('shLogo').style.background = cat.color;
  document.getElementById('shTitle').textContent = p.name;
  document.getElementById('shCat').innerHTML = '<span class="sw" style="background:' + cat.color + '"></span>' + cat.label;
  document.getElementById('shDesc').textContent = p.description || '';
  document.getElementById('shDesc').style.display = p.description ? '' : 'none';
  const ctas = document.getElementById('shCtas');
  ctas.innerHTML = '';
  if (p.ctaUrl) {
    const b = document.createElement('button');
    b.className = 'cta p';
    b.textContent = p.ctaLabel || 'More info';
    b.onclick = () => { beacon('cta_click', p.id); if (LIVE) window.location.href = p.ctaUrl; };
    ctas.appendChild(b);
  }
  const d = document.createElement('button');
  d.className = 'cta s';
  d.textContent = 'Directions';
  d.onclick = () => { beacon('cta_click', p.id + ':directions'); if (LIVE) window.location.href = 'https://www.google.com/maps/dir/?api=1&destination=' + p.lat + ',' + p.lng; };
  ctas.appendChild(d);
  document.getElementById('sheet').classList.add('open');
  if (map) map.easeTo({ center: [p.lng, p.lat], padding: { bottom: 220 }, duration: 450 });
  renderPlaces();
}
function closeSheet() {
  selectedId = '';
  document.getElementById('sheet').classList.remove('open');
  renderPlaces();
}
document.getElementById('shClose').onclick = closeSheet;

// ── map boot ─────────────────────────────────────────────────────────────────
function bootMap() {
  if (!BOOT.token || typeof mapboxgl === 'undefined') { renderChips(); renderPlaces(); return; }
  mapboxgl.accessToken = BOOT.token;
  const cam = cfg.camera || {};
  map = new mapboxgl.Map({
    container: 'map',
    style: ${JSON.stringify(styleUrl(config.style))},
    center: [cam.lng ?? 18.42, cam.lat ?? -33.92],
    zoom: cam.zoom ?? 15, pitch: cam.pitch ?? 0, bearing: cam.bearing ?? 0,
    attributionControl: true,
  });
  map.addControl(new mapboxgl.NavigationControl({ showCompass: true }), 'bottom-right');
  map.addControl(new mapboxgl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showUserHeading: true }), 'bottom-right');
  map.on('click', (e) => {
    if (!LIVE) post({ type: 'map:click', lat: e.lngLat.lat, lng: e.lngLat.lng });
    else closeSheet();
  });
  map.on('load', () => { renderChips(); renderPlaces(); });
  // Never fail black: surface token/tile problems visibly (first hard error only).
  let errShown = false;
  map.on('error', (e) => {
    const status = e && e.error && (e.error.status || e.error.statusCode);
    if (errShown || !(status === 401 || status === 403)) return;
    errShown = true;
    const bar = document.createElement('div');
    bar.className = 'errbar';
    bar.textContent = 'The map tiles were rejected (HTTP ' + status + ') — the Mapbox token is invalid or its URL restrictions don\\'t include this domain. Fix the token in the studio; places and filters still work.';
    document.body.appendChild(bar);
  });
}

// ── editor bridge (edit mode only) ───────────────────────────────────────────
function post(msg) { if (!LIVE && window.parent !== window) window.parent.postMessage({ src: 'mapstudio-preview', ...msg }, window.location.origin); }
window.addEventListener('message', (e) => {
  if (LIVE || e.origin !== window.location.origin || !e.data || e.data.src !== 'mapstudio-editor') return;
  if (e.data.type === 'state') {
    cfg = e.data.config;
    if (typeof e.data.selectedId === 'string') selectedId = e.data.selectedId;
    renderChips(); renderPlaces();
    if (selectedId && e.data.openSheet) select(selectedId);
    if (!selectedId) closeSheet();
  }
  if (e.data.type === 'camera:get' && map) {
    const c = map.getCenter();
    post({ type: 'camera', lat: c.lat, lng: c.lng, zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() });
  }
  if (e.data.type === 'camera:set' && map && e.data.camera) {
    const c = e.data.camera;
    map.easeTo({ center: [c.lng, c.lat], zoom: c.zoom, pitch: c.pitch || 0, bearing: c.bearing || 0 });
  }
  if (e.data.type === 'fly' && map) map.easeTo({ center: [e.data.lng, e.data.lat], duration: 400 });
});

bootMap();
renderChips(); renderPlaces();
beacon('open');
if (!LIVE) post({ type: 'ready' });
</script>
</body>
</html>`;
}

module.exports = { renderMapPage, styleUrl, STYLES };
