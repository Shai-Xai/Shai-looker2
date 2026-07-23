// Thin fetch wrappers around the backend API.

async function json(res) {
  const data = await res.json().catch(() => ({}));
  // Session expired/invalid mid-use: a 401 is otherwise indistinguishable from a
  // 500 to each page's local catch, so the user is stranded on a generic error.
  // Tell the auth layer (AuthProvider listens) to drop back to the login screen.
  // Still throw so the calling promise rejects rather than continuing with empty
  // data.
  if (res.status === 401 && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('auth:unauthorized'));
  }
  if (!res.ok) {
    // Gateway errors mean the server is briefly unavailable — almost always the
    // ~1-minute window while a deploy swaps the instance. Show a reassuring
    // "updating" message instead of a raw "Request failed (502)" — but only when
    // the body carries no message of its own: our server also returns 502s with a
    // deliberate, client-safe explanation (e.g. "Could not reach Queue-it"), and
    // masking those sends people debugging a deploy that isn't happening.
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new Error(data.error || 'Pulse is updating — this usually takes under a minute. Please wait a moment and try again.');
    }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// Tiny cache for read-mostly GETs that screens re-fire on every navigation — e.g.
// the suites sidebar + settlements list ClientLayout reloads on each client route
// change. In-flight dedup (concurrent identical GETs share one request) + a short
// self-healing TTL (a repeat within the window serves the cached result instantly).
// These resources only change via admin actions, never the browsing client, so the
// brief staleness is safe; bustCache(prefix) clears it after a relevant mutation.
const _getCache = new Map();    // url -> { at, data }
const _getInflight = new Map(); // url -> Promise
function cachedGet(url, ttl = 60000) {
  const hit = _getCache.get(url);
  if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.data);
  if (_getInflight.has(url)) return _getInflight.get(url);
  const p = fetch(url).then(json).then((data) => {
    _getCache.set(url, { at: Date.now(), data });
    _getInflight.delete(url);
    return data;
  }).catch((e) => { _getInflight.delete(url); throw e; });
  _getInflight.set(url, p);
  return p;
}
function bustCache(prefix = '') {
  for (const k of [..._getCache.keys()]) if (!prefix || k.startsWith(prefix)) _getCache.delete(k);
}

// Usage telemetry: buffer events and flush in small batches (after a short idle,
// when the buffer fills, or when the tab is hidden). Fire-and-forget — a failed
// flush is dropped silently so it can never affect the UI.
let _trackBuf = [];
let _trackEntity = null;
let _trackTimer = null;
function flushTrack() {
  clearTimeout(_trackTimer); _trackTimer = null;
  if (!_trackBuf.length || !_trackEntity) return;
  const body = JSON.stringify({ entityId: _trackEntity, events: _trackBuf });
  _trackBuf = [];
  fetch('/api/my/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
}
function queueTrack(entityId, event) {
  if (!entityId || !event || !event.kind || !event.event || !event.name) return;
  if (_trackEntity && _trackEntity !== entityId) flushTrack(); // don't mix entities in a batch
  _trackEntity = entityId;
  _trackBuf.push(event);
  if (_trackBuf.length >= 25) return flushTrack();
  clearTimeout(_trackTimer);
  _trackTimer = setTimeout(flushTrack, 1500);
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', flushTrack);

// POST to an AI-extraction endpoint that streams ndjson progress events
// ({type:'progress'|'done'|'error'}); calls onProgress per event and resolves
// with the extracted data.
async function extractStream(url, body, onProgress) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) return json(res); // pre-stream rejection (e.g. no API key) → throws
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let result = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'progress') onProgress?.(msg);
      else if (msg.type === 'done') result = msg.data;
      else if (msg.type === 'error') throw new Error(msg.error);
    }
  }
  if (!result) throw new Error('Extraction ended unexpectedly — please try again.');
  return result;
}

export const api = {
  // Auth
  me: () => fetch('/api/auth/me').then(json),

  // Agentic Owl chat: POST a question, stream the grounded answer as plain text
  // (onText per delta), resolve with { threadId } (read from the X-Owl-Thread header
  // so a new conversation can be continued).
  owlChat: async ({ suiteId, entityId, dashboardId, message, threadId, mode, signal, onThread }, onText, onStatus) => {
    // `signal` powers ⏹ Stop (paired with owlStop — a socket close alone no longer
    // stops the server; it finishes and PERSISTS the answer so a dropped stream can
    // be recovered from the thread). `onThread` fires as soon as the server names
    // the thread — before any text — so recovery knows where to look.
    const res = await fetch('/api/owl/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ suiteId, entityId, dashboardId, message, threadId, mode }), signal });
    if (!res.ok) return json(res); // pre-stream rejection (no scope / no API key) → throws
    const tid = res.headers.get('X-Owl-Thread') || threadId || null;
    try { onThread?.(tid); } catch { /* advisory only */ }
    const persona = res.headers.get('X-Owl-Persona') || mode || 'quick';
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    // The answer text streams first, then trailing records: the model's
    // "<<<FOLLOWUPS>>>[...]" (suggested questions), then the server's
    // "<<<OWL_SOURCES>>>{...}" (citations) + "<<<OWL_ACTIONS>>>[...]" (action cards).
    // Mid-stream the server also pings "<<<OWL_STATUS>>>label<<</OWL_STATUS>>>" — what
    // the Owl is doing — which we strip out live and surface via onStatus, never as text.
    // We consume buf from the front as we emit, so status spans can be spliced cleanly.
    const FU = '<<<FOLLOWUPS>>>', SRC = '<<<OWL_SOURCES>>>', ACT = '<<<OWL_ACTIONS>>>';
    const SO = '<<<OWL_STATUS>>>', SE = '<<</OWL_STATUS>>>';
    const HOLD = Math.max(FU.length, SRC.length, ACT.length, SO.length);
    let buf = '', sources = [], followups = [], actions = [];
    // Pull every COMPLETE status span out of buf (anywhere), firing onStatus for each.
    const drainStatus = () => {
      for (;;) {
        const a = buf.indexOf(SO); if (a < 0) break;
        const b = buf.indexOf(SE, a + SO.length); if (b < 0) break; // wait for the close
        const label = buf.slice(a + SO.length, b);
        buf = buf.slice(0, a) + buf.slice(b + SE.length);
        if (label) onStatus?.(label);
      }
    };
    // Earliest start of any marker — so we never emit marker bytes as answer text.
    const nextMarker = () => { const xs = [buf.indexOf(FU), buf.indexOf(SRC), buf.indexOf(ACT), buf.indexOf(SO)].filter((i) => i >= 0); return xs.length ? Math.min(...xs) : -1; };
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      if (value) buf += dec.decode(value, { stream: true });
      drainStatus();
      const mi = nextMarker();
      if (mi >= 0) { if (mi > 0) { onText?.(buf.slice(0, mi)); buf = buf.slice(mi); } } // stop at the marker; keep it buffered
      else { const safe = buf.length - HOLD; if (safe > 0) { onText?.(buf.slice(0, safe)); buf = buf.slice(safe); } }
    }
    drainStatus();
    // Anything left before the first END marker is trailing answer text.
    const endXs = [buf.indexOf(FU), buf.indexOf(SRC), buf.indexOf(ACT)].filter((i) => i >= 0);
    if (!endXs.length && buf) onText?.(buf);
    const fa = buf.indexOf(FU);
    if (fa >= 0) { const after = buf.slice(fa + FU.length); const end = after.indexOf(SRC); const blob = (end >= 0 ? after.slice(0, end) : after); const m = blob.match(/\[[\s\S]*\]/); if (m) { try { followups = JSON.parse(m[0]); } catch { followups = []; } } }
    const sa = buf.indexOf(SRC);
    if (sa >= 0) { const after = buf.slice(sa + SRC.length); const end = after.indexOf(ACT); const blob = end >= 0 ? after.slice(0, end) : after; try { sources = JSON.parse(blob); } catch { sources = []; } }
    const aa = buf.indexOf(ACT);
    if (aa >= 0) { try { actions = JSON.parse(buf.slice(aa + ACT.length)); } catch { actions = []; } }
    return { threadId: tid, sources, followups, actions, persona };
  },
  // Act layer: commit a drafted action the Owl proposed (the "Create alert" tap).
  owlCreateAlert: (body) => fetch('/api/owl/act/create-alert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  owlCreateLiveUpdate: (body) => fetch('/api/owl/act/create-live-update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  owlRemember: (body) => fetch('/api/owl/act/remember', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  // Client memory (durable per-client facts the Owl carries across chats).
  owlMemory: (entityId) => fetch(`/api/admin/entities/${entityId}/owl-memory`).then(json),
  saveOwlMemory: (entityId, items) => fetch(`/api/admin/entities/${entityId}/owl-memory`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) }).then(json),
  owlEventMemory: (suiteId) => fetch(`/api/admin/suites/${suiteId}/owl-memory`).then(json),
  saveOwlEventMemory: (suiteId, items) => fetch(`/api/admin/suites/${suiteId}/owl-memory`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) }).then(json),
  // Client self-service: own client memory (?entityId to choose which client), own
  // event memory (an event they can access), and their own personal preferences.
  myOwlMemory: (entityId) => fetch(`/api/my/owl-memory${entityId ? `?entityId=${encodeURIComponent(entityId)}` : ''}`).then(json),
  saveMyOwlMemory: (items, entityId) => fetch('/api/my/owl-memory', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items, entityId }) }).then(json),
  myOwlEventMemory: (suiteId) => fetch(`/api/my/suites/${suiteId}/owl-memory`).then(json),
  saveMyOwlEventMemory: (suiteId, items) => fetch(`/api/my/suites/${suiteId}/owl-memory`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) }).then(json),
  myOwlUserMemory: () => fetch('/api/my/owl-user-memory').then(json),
  saveMyOwlUserMemory: (items) => fetch('/api/my/owl-user-memory', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) }).then(json),
  // The "/" slash-command palette (derived from the Owl's tool registry).
  owlCapabilities: () => fetch('/api/owl/capabilities').then(json),
  // Owl access (owner-only write): who can use the native Owl.
  getOwlAccess: () => fetch('/api/admin/owl-access').then(json),
  saveOwlAccess: (b) => fetch('/api/admin/owl-access', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  // Admin: the Owl data catalogue — registered/available explores + per-explore fields.
  owlExplores: () => fetch('/api/admin/owl/explores').then(json),
  addOwlExplore: (model, view, label) => fetch('/api/admin/owl/explores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, view, label }) }).then(json),
  removeOwlExplore: (model, view) => fetch(`/api/admin/owl/explores?model=${encodeURIComponent(model)}&view=${encodeURIComponent(view)}`, { method: 'DELETE' }).then(json),
  saveOwlExploreAccess: (model, view, defaultOn, clients) => fetch('/api/admin/owl/explores/access', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, view, defaultOn, clients }) }).then(json),
  owlCatalogueFields: (model, view) => fetch(`/api/admin/owl/catalogue${model ? `?model=${encodeURIComponent(model)}&view=${encodeURIComponent(view)}` : ''}`).then(json),
  saveOwlCatalogue: (enabled, model, view) => fetch('/api/admin/owl/catalogue', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled, model, view }) }).then(json),
  owlStarters: (entityId) => fetch(`/api/owl/starters${entityId ? `?entityId=${encodeURIComponent(entityId)}` : ''}`).then(json),
  // Raw-data export for a chat answer: re-runs the citation's query live (scope-gated
  // server-side) and returns ALL rows — the chat stream itself caps previews at 50.
  owlExportRows: (body) => fetch('/api/owl/export-rows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  // Act layer: commit a drafted segment the Owl proposed (the "Create segment" tap),
  // or "Save as segment" from a chat answer's cohort. Never carries PII.
  owlCreateSegment: (body) => fetch('/api/owl/act/create-segment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  owlCreateChottuLink: (body) => fetch('/api/owl/act/create-chottu-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  owlApplyChottuTemplate: (body) => fetch('/api/owl/act/apply-chottu-template', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  // Act layer: commit a drafted campaign (the "Create draft campaign" tap). Creates a
  // DRAFT only — a human reviews/approves/sends in Engage. Never carries PII.
  owlDraftCampaign: (body) => fetch('/api/owl/act/draft-campaign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  // Act layer: file a product report (bug/idea) the Owl drafted (the "File it" tap).
  owlSubmitReport: (body) => fetch('/api/owl/act/submit-report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  owlThreads: () => fetch('/api/owl/threads').then(json),
  owlPinTargets: (entityId) => fetch(`/api/owl/pin-targets?entityId=${encodeURIComponent(entityId || '')}`).then(json),
  owlPin: (body) => fetch('/api/owl/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  owlStop: (threadId) => fetch('/api/owl/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId }) }).then(json),
  owlThreadMessages: (id) => fetch(`/api/owl/threads/${id}/messages`).then(json),
  owlRenameThread: (id, title) => fetch(`/api/owl/threads/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) }).then(json),
  owlSetThreadFolder: (id, folder) => fetch(`/api/owl/threads/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }) }).then(json),
  // Meta paid-performance (deep Meta P1) — dual-surface
  myMetaAds: (entityId, days) => fetch(`/api/my/meta-ads/${entityId}${days ? `?days=${days}` : ''}`).then(json),
  syncMyMetaAds: (entityId) => fetch(`/api/my/meta-ads/${entityId}/sync`, { method: 'POST' }).then(json),
  adminMetaAds: (entityId, days) => fetch(`/api/admin/entities/${entityId}/meta-ads${days ? `?days=${days}` : ''}`).then(json),
  syncAdminMetaAds: (entityId) => fetch(`/api/admin/entities/${entityId}/meta-ads/sync`, { method: 'POST' }).then(json),
  // 📱 App analytics — direct PostHog integration (platform connection + dual-surface reports)
  posthogSettings: () => fetch('/api/admin/posthog/settings').then(json),
  savePosthogSettings: (p) => fetch('/api/admin/posthog/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),
  testPosthog: () => fetch('/api/admin/posthog/test', { method: 'POST' }).then(json),
  posthogEventsCatalog: () => fetch('/api/admin/posthog/events-catalog').then(json),
  posthogDiagnose: () => fetch('/api/admin/posthog/diagnose').then(json),
  posthogPropertyValues: (event, key) => fetch(`/api/admin/posthog/property-values?event=${encodeURIComponent(event)}&key=${encodeURIComponent(key)}`).then(json),
  posthogSearchEvents: (q) => fetch(`/api/admin/posthog/search-events?q=${encodeURIComponent(q)}`).then(json),
  posthogCommerceScan: () => fetch('/api/admin/posthog/commerce-scan').then(json),
  feedsSettings: () => fetch('/api/admin/feeds/settings').then(json),
  saveFeedsSettings: (body) => fetch('/api/admin/feeds/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  generateFeedToken: () => fetch('/api/admin/feeds/token', { method: 'POST' }).then(json),
  previewFeed: () => fetch('/api/admin/feeds/preview').then(json),
  adminAppAnalytics: ({ days, from, to, entityId } = {}) => fetch(`/api/admin/app-analytics?days=${days || ''}&from=${from || ''}&to=${to || ''}&entityId=${encodeURIComponent(entityId || '')}`).then(json),
  adminAppPeople: ({ days, from, to, q, entityId, offset, orderBy, limit, excludeStaff, tickets } = {}) => fetch(`/api/admin/app-analytics/people?days=${days || ''}&from=${from || ''}&to=${to || ''}&q=${encodeURIComponent(q || '')}&entityId=${encodeURIComponent(entityId || '')}&offset=${offset || 0}&orderBy=${orderBy || ''}&limit=${limit || ''}&excludeStaff=${excludeStaff ? 1 : ''}&tickets=${tickets || ''}`).then(json),
  // Manual sync recounts the FULL window (the nightly tick only restates 7 days) —
  // so a mapping/property fix backfills history in one click.
  syncAppAnalytics: () => fetch('/api/admin/app-analytics/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: 90 }) }).then(json),
  myAppAnalytics: (entityId, o = {}) => { const q = typeof o === 'object' ? o : { days: o }; return fetch(`/api/my/app-analytics/${entityId}?days=${q.days || ''}&from=${q.from || ''}&to=${q.to || ''}`).then(json); },
  myAppPeople: (entityId, { days, from, to, q, offset, orderBy, limit, excludeStaff, tickets } = {}) => fetch(`/api/my/app-analytics/${entityId}/people?days=${days || ''}&from=${from || ''}&to=${to || ''}&q=${encodeURIComponent(q || '')}&offset=${offset || 0}&orderBy=${orderBy || ''}&limit=${limit || ''}&excludeStaff=${excludeStaff ? 1 : ''}&tickets=${tickets || ''}`).then(json),
  adminAppBreakdown: ({ key, days, from, to, entityId } = {}) => fetch(`/api/admin/app-analytics/breakdown?key=${encodeURIComponent(key)}&days=${days || ''}&from=${from || ''}&to=${to || ''}&entityId=${encodeURIComponent(entityId || '')}`).then(json),
  myAppBreakdown: (entityId, { key, days, from, to } = {}) => fetch(`/api/my/app-analytics/${entityId}/breakdown?key=${encodeURIComponent(key)}&days=${days || ''}&from=${from || ''}&to=${to || ''}`).then(json),
  adminAppBreakdownSeries: ({ key, days, from, to, entityId, granularity } = {}) => fetch(`/api/admin/app-analytics/breakdown-series?key=${encodeURIComponent(key)}&days=${days || ''}&from=${from || ''}&to=${to || ''}&granularity=${granularity || ''}&entityId=${encodeURIComponent(entityId || '')}`).then(json),
  myAppBreakdownSeries: (entityId, { key, days, from, to, granularity } = {}) => fetch(`/api/my/app-analytics/${entityId}/breakdown-series?key=${encodeURIComponent(key)}&days=${days || ''}&from=${from || ''}&to=${to || ''}&granularity=${granularity || ''}`).then(json),
  adminAppFunnel: ({ days, from, to, entityId } = {}) => fetch(`/api/admin/app-analytics/funnel?days=${days || ''}&from=${from || ''}&to=${to || ''}&entityId=${encodeURIComponent(entityId || '')}`).then(json),
  adminAppEventSeries: ({ days, from, to, entityId, events } = {}) => fetch(`/api/admin/app-analytics/event-series?days=${days || ''}&from=${from || ''}&to=${to || ''}&entityId=${encodeURIComponent(entityId || '')}&events=${encodeURIComponent(events || '')}`).then(json),
  myAppEventSeries: (entityId, { days, from, to, events } = {}) => fetch(`/api/my/app-analytics/${entityId}/event-series?days=${days || ''}&from=${from || ''}&to=${to || ''}&events=${encodeURIComponent(events || '')}`).then(json),
  myAppFunnel: (entityId, { days, from, to } = {}) => fetch(`/api/my/app-analytics/${entityId}/funnel?days=${days || ''}&from=${from || ''}&to=${to || ''}`).then(json),
  adminAppCtaLabels: ({ days, from, to, entityId } = {}) => fetch(`/api/admin/app-analytics/cta-labels?days=${days || ''}&from=${from || ''}&to=${to || ''}&entityId=${encodeURIComponent(entityId || '')}`).then(json),
  myAppCtaLabels: (entityId, { days, from, to } = {}) => fetch(`/api/my/app-analytics/${entityId}/cta-labels?days=${days || ''}&from=${from || ''}&to=${to || ''}`).then(json),
  adminAppToday: ({ entityId, from, to } = {}) => fetch(`/api/admin/app-analytics/today?entityId=${encodeURIComponent(entityId || '')}&from=${from || ''}&to=${to || ''}`).then(json),
  adminAppMoments: ({ entityId, from, to } = {}) => fetch(`/api/admin/app-analytics/moments?entityId=${encodeURIComponent(entityId || '')}&from=${from || ''}&to=${to || ''}`).then(json),
  myAppMoments: (entityId, { from, to } = {}) => fetch(`/api/my/app-analytics/${entityId}/moments?from=${from || ''}&to=${to || ''}`).then(json),
  myAppToday: (entityId, { from, to } = {}) => fetch(`/api/my/app-analytics/${entityId}/today?from=${from || ''}&to=${to || ''}`).then(json),
  // Google Drive sources (the Owl reads the client's shared files) — dual-surface
  myDriveView: (entityId) => fetch(`/api/my/drive/${entityId}`).then(json),
  myDriveSetKey: (entityId, body) => fetch(`/api/my/drive/${entityId}/key`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  myDriveAddSource: (entityId, body) => fetch(`/api/my/drive/${entityId}/sources`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  myDriveSyncSource: (entityId, sid) => fetch(`/api/my/drive/${entityId}/sources/${sid}/sync`, { method: 'POST' }).then(json),
  myDriveUpdateSource: (entityId, sid, body) => fetch(`/api/my/drive/${entityId}/sources/${sid}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  myDriveRemoveSource: (entityId, sid) => fetch(`/api/my/drive/${entityId}/sources/${sid}`, { method: 'DELETE' }).then(json),
  adminDriveView: (entityId) => fetch(`/api/admin/entities/${entityId}/drive`).then(json),
  adminDriveSetKey: (entityId, body) => fetch(`/api/admin/entities/${entityId}/drive/key`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  adminDriveAddSource: (entityId, body) => fetch(`/api/admin/entities/${entityId}/drive/sources`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  adminDriveSyncSource: (entityId, sid) => fetch(`/api/admin/entities/${entityId}/drive/sources/${sid}/sync`, { method: 'POST' }).then(json),
  adminDriveUpdateSource: (entityId, sid, body) => fetch(`/api/admin/entities/${entityId}/drive/sources/${sid}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  adminDriveRemoveSource: (entityId, sid) => fetch(`/api/admin/entities/${entityId}/drive/sources/${sid}`, { method: 'DELETE' }).then(json),
  myDriveOauthStart: (entityId, ret) => fetch(`/api/my/drive/${entityId}/oauth/start?ret=${encodeURIComponent(ret || '')}`).then(json),
  adminDriveOauthStart: (entityId, ret) => fetch(`/api/admin/entities/${entityId}/drive/oauth/start?ret=${encodeURIComponent(ret || '')}`).then(json),
  myDrivePickerToken: (entityId) => fetch(`/api/my/drive/${entityId}/oauth/picker-token`).then(json),
  adminDrivePickerToken: (entityId) => fetch(`/api/admin/entities/${entityId}/drive/oauth/picker-token`).then(json),
  myDriveOauthDisconnect: (entityId) => fetch(`/api/my/drive/${entityId}/oauth/disconnect`, { method: 'POST' }).then(json),
  adminDriveOauthDisconnect: (entityId) => fetch(`/api/admin/entities/${entityId}/drive/oauth/disconnect`, { method: 'POST' }).then(json),
  // Meta "Continue with Facebook" connect — dual-surface
  myMetaConnect: (entityId) => fetch(`/api/my/meta-connect/${entityId}`).then(json),
  adminMetaConnect: (entityId) => fetch(`/api/admin/entities/${entityId}/meta-connect`).then(json),
  myMetaConnectStart: (entityId, ret) => fetch(`/api/my/meta-connect/${entityId}/start?ret=${encodeURIComponent(ret || '')}`).then(json),
  adminMetaConnectStart: (entityId, ret) => fetch(`/api/admin/entities/${entityId}/meta-connect/start?ret=${encodeURIComponent(ret || '')}`).then(json),
  myMetaConnectSelect: (entityId, accountId) => fetch(`/api/my/meta-connect/${entityId}/select`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId }) }).then(json),
  adminMetaConnectSelect: (entityId, accountId) => fetch(`/api/admin/entities/${entityId}/meta-connect/select`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId }) }).then(json),
  myMetaConnectDisconnect: (entityId) => fetch(`/api/my/meta-connect/${entityId}/disconnect`, { method: 'POST' }).then(json),
  adminMetaConnectDisconnect: (entityId) => fetch(`/api/admin/entities/${entityId}/meta-connect/disconnect`, { method: 'POST' }).then(json),
  adminMetaMcpProbe: (entityId) => fetch(`/api/admin/entities/${entityId}/meta-mcp-probe`, { method: 'POST' }).then(json),
  // Queue-it waiting-room stats — dual-surface (scope 'my' | 'admin-client')
  queueitStatus: (entityId, scope) => fetch(scope === 'admin-client' ? `/api/admin/entities/${entityId}/queueit` : `/api/my/queueit/${entityId}`).then(json),
  queueitRooms: (entityId, scope) => fetch(scope === 'admin-client' ? `/api/admin/entities/${entityId}/queueit/waiting-rooms` : `/api/my/queueit/${entityId}/waiting-rooms`).then(json),
  queueitSummary: (entityId, scope, roomId) => fetch(`${scope === 'admin-client' ? `/api/admin/entities/${entityId}/queueit` : `/api/my/queueit/${entityId}`}/waiting-rooms/${encodeURIComponent(roomId)}/summary`).then(json),
  queueitDetails: (entityId, scope, roomId, { type, from, to } = {}) => fetch(`${scope === 'admin-client' ? `/api/admin/entities/${entityId}/queueit` : `/api/my/queueit/${entityId}`}/waiting-rooms/${encodeURIComponent(roomId)}/details?type=${encodeURIComponent(type || 'queueinflow')}&from=${encodeURIComponent(from || '')}&to=${encodeURIComponent(to || '')}`).then(json),
  queueitVerify: (entityId, scope) => fetch(scope === 'admin-client' ? `/api/admin/entities/${entityId}/queueit/verify` : `/api/my/queueit/${entityId}/verify`, { method: 'POST' }).then(json),
  queueitSetRooms: (entityId, scope, roomIds) => fetch(scope === 'admin-client' ? `/api/admin/entities/${entityId}/queueit/rooms` : `/api/my/queueit/${entityId}/rooms`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomIds }) }).then(json),
  owlUploads: (entityId) => fetch(`/api/owl/uploads?entityId=${encodeURIComponent(entityId || '')}`).then(json),
  owlUploadCsv: (entityId, name, csv) => fetch('/api/owl/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entityId, name, csv }) }).then(json),
  owlUploadSheet: (entityId, name, sheetUrl) => fetch('/api/owl/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entityId, name, sheetUrl }) }).then(json),
  owlRefreshUpload: (id) => fetch(`/api/owl/uploads/${id}/refresh`, { method: 'POST' }).then(json),
  owlDeleteUpload: (id) => fetch(`/api/owl/uploads/${id}`, { method: 'DELETE' }).then(json),
  owlDeleteThread: (id) => fetch(`/api/owl/threads/${id}`, { method: 'DELETE' }).then(json),
  login: (email, password) =>
    fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).then(json),
  logout: () => fetch('/api/auth/logout', { method: 'POST' }).then(json),
  forgotPassword: (email) => fetch('/api/auth/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) }).then(json),
  resetPassword: (token, password) => fetch('/api/auth/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password }) }).then(json),
  requestMagicLink: (email) => fetch('/api/auth/magic', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) }).then(json),
  consumeMagicLink: (token) => fetch('/api/auth/magic/consume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }).then(json),
  // Two-factor auth. verify2fa completes a login step-up (pending token + code).
  verify2fa: (pendingToken, code) => fetch('/api/auth/2fa', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pendingToken, code }) }).then(json),
  twoFactorStatus: () => fetch('/api/my/2fa').then(json),
  twoFactorSetup: () => fetch('/api/my/2fa/setup', { method: 'POST' }).then(json),
  twoFactorEnable: (code) => fetch('/api/my/2fa/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }).then(json),
  twoFactorDisable: (code) => fetch('/api/my/2fa/disable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }).then(json),
  twoFactorBackupCodes: (code) => fetch('/api/my/2fa/backup-codes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }).then(json),
  adminResetUser2fa: (userId) => fetch(`/api/admin/users/${userId}/2fa/reset`, { method: 'POST' }).then(json),

  // Admin — Entities (clients), Sets (reusable collections), Suites (event ctx)
  adminListInventiveWorkspaces: () => fetch('/api/admin/inventive-workspaces').then(json),
  adminCreateInventiveWorkspace: (w) => fetch('/api/admin/inventive-workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(w) }).then(json),
  adminUpdateInventiveWorkspace: (id, w) => fetch(`/api/admin/inventive-workspaces/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(w) }).then(json),
  adminDeleteInventiveWorkspace: (id) => fetch(`/api/admin/inventive-workspaces/${id}`, { method: 'DELETE' }),
  adminListEntities: () => fetch('/api/admin/entities').then(json),
  adminCreateEntity: (e) => fetch('/api/admin/entities', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(e) }).then(json),
  adminUpdateEntity: (id, e) => fetch(`/api/admin/entities/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(e) }).then(json),
  adminDeleteEntity: (id) => fetch(`/api/admin/entities/${id}`, { method: 'DELETE' }),
  // Organizer-portal Owl embed (admin config — server/owlEmbed.js).
  getOwlEmbed: () => fetch('/api/admin/owl-embed').then(json),
  saveOwlEmbed: (body) => fetch('/api/admin/owl-embed', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  owlWhatsapp: () => fetch('/api/admin/owl-whatsapp').then(json),
  saveOwlWhatsapp: (body) => fetch('/api/admin/owl-whatsapp', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  testOwlWhatsapp: (to, text) => fetch('/api/admin/owl-whatsapp/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, text }) }).then(json),
  owlWhatsappLog: () => fetch('/api/admin/owl-whatsapp/inbound-log').then(json),
  owlFieldDict: () => fetch('/api/admin/owl-fields').then(json),
  owlFieldsLookerSync: () => fetch('/api/admin/owl-fields/looker-sync').then(json),
  saveOwlFieldDict: (fields) => fetch('/api/admin/owl-fields', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) }).then(json),
  owlGuidanceGlobal: () => fetch('/api/admin/owl-guidance').then(json),
  setOwlGuidanceGlobal: (guidance) => fetch('/api/admin/owl-guidance', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ guidance }) }).then(json),
  owlGuidanceEntity: (id) => fetch(`/api/admin/entities/${id}/owl-guidance`).then(json),
  setOwlGuidanceEntity: (id, guidance) => fetch(`/api/admin/entities/${id}/owl-guidance`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ guidance }) }).then(json),
  myOwlGuidance: () => fetch('/api/my/owl-guidance').then(json),
  setMyOwlGuidance: (guidance) => fetch('/api/my/owl-guidance', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ guidance }) }).then(json),
  adminListSets: () => fetch('/api/admin/sets').then(json),
  adminCreateSet: (s) => fetch('/api/admin/sets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) }).then(json),
  adminUpdateSet: (id, s) => fetch(`/api/admin/sets/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) }).then(json),
  adminDeleteSet: (id) => fetch(`/api/admin/sets/${id}`, { method: 'DELETE' }),
  // Product feature matrix — the public catalogue (also powers the sales site and
  // the client-facing "What's in Pulse" grid). Read-mostly; safe to cache briefly.
  productSite: () => cachedGet('/api/product/site', 5 * 60000),
  // Admin — Product: the feature matrix + what the public pages get to show
  adminProductMatrix: () => fetch('/api/admin/product/matrix').then(json),
  adminSetProductVisibility: (kind, id, hidden) => fetch('/api/admin/product/visibility', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, id, hidden }) }).then(json),
  // Admin — Product: daily release notes
  adminListReleaseNotes: () => fetch('/api/admin/release-notes').then(json),
  adminCreateReleaseNote: (n) => fetch('/api/admin/release-notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(n) }).then(json),
  adminUpdateReleaseNote: (id, n) => fetch(`/api/admin/release-notes/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(n) }).then(json),
  adminDeleteReleaseNote: (id) => fetch(`/api/admin/release-notes/${id}`, { method: 'DELETE' }),
  adminGenerateReleaseNotes: (days) => fetch('/api/admin/release-notes/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days }) }).then(json),
  // Admin — Product → Help knowledge: curate + publish what the Owl may say about
  // Pulse itself (server/helpBot.js — grounds the Owl's productHelp tool). The
  // client self-service surface is the Owl chat itself; there's no separate bot.
  adminHelpArticles: () => fetch('/api/admin/help/articles').then(json),
  adminCreateHelpArticle: (a) => fetch('/api/admin/help/articles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a) }).then(json),
  adminUpdateHelpArticle: (id, a) => fetch(`/api/admin/help/articles/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a) }).then(json),
  adminDeleteHelpArticle: (id) => fetch(`/api/admin/help/articles/${id}`, { method: 'DELETE' }),
  adminDraftHelpArticles: () => fetch('/api/admin/help/draft', { method: 'POST' }).then(json),
  adminHelpSettings: () => fetch('/api/admin/help/settings').then(json),
  adminSaveHelpSettings: (s) => fetch('/api/admin/help/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) }).then(json),
  // Admin — Product → Support Owl: the customer-support knowledge spine
  // (server/supportOwl.js, P0a) — HelpDocs sync + platform-tier curation.
  adminSupportOwl: () => fetch('/api/admin/support-owl').then(json),
  adminSupportOwlSettings: (s) => fetch('/api/admin/support-owl/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) }).then(json),
  adminSupportOwlSync: () => fetch('/api/admin/support-owl/sync', { method: 'POST' }).then(json),
  adminSupportOwlSearch: (q, entityId = '') => fetch(`/api/admin/support-owl/search?${new URLSearchParams({ q, entityId })}`).then(json),
  adminCreateSupportKnowledge: (k) => fetch('/api/admin/support-owl/knowledge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(k) }).then(json),
  adminUpdateSupportKnowledge: (id, k) => fetch(`/api/admin/support-owl/knowledge/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(k) }).then(json),
  adminDeleteSupportKnowledge: (id) => fetch(`/api/admin/support-owl/knowledge/${id}`, { method: 'DELETE' }),
  // Product feedback board — report a bug/improvement/idea (staff or client),
  // track your own, and (admin) run the live board + Copy-for-Claude hand-off.
  submitTicket: (b) => fetch('/api/my/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  previewTicket: (b) => fetch('/api/my/tickets/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  myTickets: () => fetch('/api/my/tickets').then(json),
  ticketVerdict: (id, body) => fetch(`/api/my/tickets/${id}/verdict`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  adminTickets: (params = {}) => fetch(`/api/admin/tickets?${new URLSearchParams(params)}`).then(json),
  adminTicket: (id) => fetch(`/api/admin/tickets/${id}`).then(json),
  adminTicketAssignees: () => fetch('/api/admin/tickets/assignees').then(json),
  adminTicketDigest: () => fetch('/api/admin/tickets/digest').then(json),
  adminTicketDigestSave: (b) => fetch('/api/admin/tickets/digest', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  adminTicketDigestSend: () => fetch('/api/admin/tickets/digest/send', { method: 'POST' }).then(json),
  adminTicketGithubIssue: (id, mode, target) => fetch(`/api/admin/tickets/${id}/github-issue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(mode ? { mode } : {}), ...(target ? { target } : {}) }) }).then(json),
  adminPromoteTicket: (id) => fetch(`/api/admin/tickets/${id}/promote`, { method: 'POST' }).then(json),
  adminTicketRedispatch: (id, target) => fetch(`/api/admin/tickets/${id}/redispatch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(target ? { target } : {}) }).then(json),
  adminDeleteTicket: (id) => fetch(`/api/admin/tickets/${id}`, { method: 'DELETE' }).then(json),
  getGithubConfig: () => fetch('/api/admin/github').then(json),
  saveGithubConfig: (b) => fetch('/api/admin/github', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  adminUpdateTicket: (id, b) => fetch(`/api/admin/tickets/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  adminTicketComment: (id, body, visibility) => fetch(`/api/admin/tickets/${id}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body, visibility }) }).then(json),
  myTicketComment: (id, body) => fetch(`/api/my/tickets/${id}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) }).then(json),
  adminRedraftTicket: (id) => fetch(`/api/admin/tickets/${id}/redraft`, { method: 'POST' }).then(json),
  // Custom (client-owned) sets
  getRoles: () => fetch('/api/admin/roles').then(json),
  getEntityContentRoles: (entityId) => fetch(`/api/admin/entities/${entityId}/content-roles`).then(json),
  setContentRoles: (entityId, scopeType, scopeId, roles) => fetch(`/api/admin/entities/${entityId}/content-roles/${scopeType}/${encodeURIComponent(scopeId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roles }) }).then(json),
  setMembershipRole: (entityId, userId, role) => fetch(`/api/admin/entities/${entityId}/logins/${userId}/role`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) }).then(json),
  getEntitySets: (entityId) => fetch(`/api/admin/entities/${entityId}/sets`).then(json),
  createEntitySet: (entityId, s) => fetch(`/api/admin/entities/${entityId}/sets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) }).then(json),
  cloneEntitySet: (entityId, setId, name) => fetch(`/api/admin/entities/${entityId}/sets/clone`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setId, name }) }).then(json),
  importEntityDashboard: (entityId, b) => fetch(`/api/admin/entities/${entityId}/dashboards/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  adminListSuites: () => fetch('/api/admin/suites').then(json),
  adminCreateSuite: (s) => fetch('/api/admin/suites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) }).then(json),
  adminUpdateSuite: (id, s) => fetch(`/api/admin/suites/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) }).then(json),
  adminDeleteSuite: (id) => fetch(`/api/admin/suites/${id}`, { method: 'DELETE' }),
  adminDuplicateSuite: (id, payload = {}) => fetch(`/api/admin/suites/${id}/duplicate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(json),
  adminFilterFields: () => fetch('/api/admin/filter-fields').then(json),
  filterSuggest: (body) => fetch('/api/filter-suggest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),

  // Users (admin)
  adminListUsers: () => fetch('/api/admin/users').then(json),
  adminUserActivityReport: (days = 30) => fetch(`/api/admin/users/activity-report?days=${days}`).then(json),
  setEntityHowlerSupport: (id, userIds) => fetch(`/api/admin/entities/${id}/howler-support`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userIds }) }).then(json),
  adminGetUser: (id) => fetch(`/api/admin/users/${id}`).then(json),
  adminCreateUser: (u) => fetch('/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(u) }).then(json),
  adminUpdateUser: (id, u) => fetch(`/api/admin/users/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(u) }).then(json),
  adminDeleteUser: (id) => fetch(`/api/admin/users/${id}`, { method: 'DELETE' }),
  adminPromoteUser: (body) => fetch('/api/admin/users/promote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),

  // Saved dashboards
  listDashboards: () => fetch('/api/dashboards').then(json),
  getDashboard: (id) => fetch(`/api/dashboards/${id}`).then(json),
  createDashboard: (def) =>
    fetch('/api/dashboards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(def),
    }).then(json),
  updateDashboard: (id, def) =>
    fetch(`/api/dashboards/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(def),
    }).then(json),
  deleteDashboard: (id) => fetch(`/api/dashboards/${id}`, { method: 'DELETE' }),
  // Fork a shared dashboard into a client-owned version for this suite. `payload`
  // carries the (edited) def + optional { title, folder, setId, newSetName }.
  forkSuiteDashboard: (suiteId, dashboardId, payload) =>
    fetch(`/api/admin/suites/${suiteId}/dashboards/${dashboardId}/fork`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }).then(json),
  // Revert a client version back to the shared template (discards the copy).
  revertSuiteDashboard: (suiteId, dashboardId) =>
    fetch(`/api/admin/suites/${suiteId}/dashboards/${dashboardId}/revert`, { method: 'POST' }).then(json),
  // Usage telemetry — fire-and-forget, batched (see _trackBuf below). Never throws.
  // NB: distinct from `track(suiteId, dashboardId)` below, which counts dashboard views.
  trackUsage: (entityId, event) => queueTrack(entityId, event),
  // Admin: onboarding funnel + feature-usage aggregates.
  adminOnboardingStats: () => fetch('/api/admin/onboarding/stats').then(json),

  // Client setup wizard config (admin-editable steps) + per-client checklist progress
  getSetupWizard: () => fetch('/api/admin/setup-wizard').then(json),
  saveSetupWizard: (steps) => fetch('/api/admin/setup-wizard', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ steps }) }).then(json),
  resetSetupWizard: () => fetch('/api/admin/setup-wizard', { method: 'DELETE' }).then(json),
  getSetupWizardProgress: (entityId) => fetch(`/api/admin/setup-wizard/progress/${entityId}`).then(json),
  // PWA install: client self-reports when running as the installed app; admin reads the map.
  markInstalled: () => fetch('/api/my/installed', { method: 'POST' }).catch(() => {}),
  adminInstalls: () => fetch('/api/admin/installs').then(json),
  // Setup nudges — per-client reminder config (managed in the onboarding section).
  getSetupNudge: (entityId) => fetch(`/api/admin/entities/${entityId}/setup-nudge`).then(json),
  saveSetupNudge: (entityId, b) => fetch(`/api/admin/entities/${entityId}/setup-nudge`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  testSetupNudge: (entityId, audience) => fetch(`/api/admin/entities/${entityId}/setup-nudge/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audience }) }).then(json),
  getSetupNudgeSettings: () => fetch('/api/admin/setup-nudge/settings').then(json),
  saveSetupNudgeSettings: (b) => fetch('/api/admin/setup-nudge/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  testSetupNudgeSettings: () => fetch('/api/admin/setup-nudge/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(json),
  setSetupWizardProgress: (entityId, itemKey, done) => fetch(`/api/admin/setup-wizard/progress/${entityId}/${encodeURIComponent(itemKey)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done }) }).then(json),

  // Onboarding journey (client) + admin management of a client's journey & emails
  getMyOnboarding: (entityId) => fetch(`/api/my/onboarding/${entityId}`).then(json),
  getClientOnboarding: (entityId) => fetch(`/api/admin/entities/${entityId}/onboarding`).then(json),
  setClientOnboardingStep: (entityId, key, done) => fetch(`/api/admin/entities/${entityId}/onboarding/step/${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done }) }).then(json),
  setClientOnboardingMail: (entityId, on) => fetch(`/api/admin/entities/${entityId}/onboarding-mail`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on }) }).then(json),
  sendOnboardingWelcome: (entityId) => fetch(`/api/admin/entities/${entityId}/onboarding/welcome`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(json),
  // Gamification (badges + Pulse Points) & the AM cockpit/scorecard
  getMyJourney: (entityId) => fetch(`/api/my/journey/${entityId}`).then(json),
  ackMyJourney: (entityId) => fetch(`/api/my/journey/${entityId}/seen`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(json),
  getOnboardingCockpit: () => fetch('/api/admin/onboarding/cockpit').then(json),
  nudgeOnboarding: (entityId) => fetch(`/api/admin/onboarding/cockpit/${entityId}/nudge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(json),
  getOnboardingScorecard: () => fetch('/api/admin/onboarding/scorecard').then(json),
  getOnboardingMailSettings: () => fetch('/api/admin/onboarding-mail/settings').then(json),
  saveOnboardingMailSettings: (b) => fetch('/api/admin/onboarding-mail/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  testOnboardingMailSettings: () => fetch('/api/admin/onboarding-mail/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(json),
  setMyOnboardingStep: (entityId, key, done) => fetch(`/api/my/onboarding/${entityId}/${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done }) }).then(json),
  dismissMyOnboarding: (entityId) => fetch(`/api/my/onboarding/${entityId}/dismiss`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dismissed: true }) }).then(json),
  // Digest archive + feedback (the knowledge-base loop) — entity-aware
  myDigests: (entityId) => fetch(`/api/my/digest-history/${entityId}`).then(json),
  myDigest: (entityId, id) => fetch(`/api/my/digest-history/${entityId}/${id}`).then(json),
  myDigestFeedback: (entityId, id, body) => fetch(`/api/my/digest-history/${entityId}/${id}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  editDigestFeedback: (entityId, id, fbId, comment) => fetch(`/api/my/digest-history/${entityId}/${id}/feedback/${fbId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ comment }) }).then(json),
  // Campaign email templates
  listCampaignTemplates: (entityId) => fetch(`/api/campaign-templates/${entityId}`).then(json),
  createCampaignTemplate: (entityId, b) => fetch(`/api/campaign-templates/${entityId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  updateCampaignTemplate: (entityId, id, b) => fetch(`/api/campaign-templates/${entityId}/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  deleteCampaignTemplate: (entityId, id) => fetch(`/api/campaign-templates/${entityId}/${id}`, { method: 'DELETE' }).then(json),
  // Engage Links — per-client links grouped into typed categories (dual-surface)
  getFolderSettings: () => fetch('/api/dashboards/folder-settings').then(json),
  setFolderKeepImported: (folder, on) => fetch('/api/dashboards/folder/keep-imported', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder, on }) }).then(json),
  comparisonSortDesc: (scope, apply = false) => fetch('/api/admin/comparison-sort-desc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(typeof scope === 'string' ? { folder: scope } : scope), apply }) }).then(json),
  // Re-sync an imported dashboard (or a whole folder) from its Looker source.
  resyncDashboard: (id, apply = false) => fetch(`/api/admin/dashboards/${id}/resync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apply }) }).then(json),
  resyncFolder: (folder, apply = false) => fetch('/api/admin/folders/resync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder, apply }) }).then(json),
  folderDaysSyncs: () => fetch('/api/dashboards/folder/days-sync').then(json),
  setFolderDaysSync: (folder, sync) => fetch('/api/dashboards/folder/days-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder, sync }) }).then(json),
  importDashboard: (lookerDashboardId, title, folder, keepImportedFilters = false) =>
    fetch('/api/dashboards/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lookerDashboardId, title, folder, keepImportedFilters }),
    }).then(json),

  // LookML metadata
  listModels: () => fetch('/api/looker/models').then(json),
  getExploreFields: (model, explore) =>
    fetch(`/api/looker/explores/${encodeURIComponent(model)}/${encodeURIComponent(explore)}`).then(json),

  // AI insights
  insightStatus: () => fetch('/api/insight/status').then(json),
  insight: (payload) =>
    fetch('/api/insight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(json),

  // The running build's version stamp (shown in the profile footer).
  version: () => fetch('/api/version').then(json),

  // Drill-down: run a Looker drill link
  drill: (url, suiteId, combinedFilters = []) =>
    fetch('/api/drill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, suiteId, combinedFilters }),
    }).then(json),

  // Query execution (scoped to the current suite, if any)
  runQuery: (query, filterOverrides, signal, suiteId, refresh = false, combinedFilters = []) =>
    fetch('/api/run-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, filterOverrides, suiteId, refresh, combinedFilters }),
      signal,
    }).then(json),

  // Dashboard folders (organisational)
  adminFolders: () => fetch('/api/admin/folders').then(json),
  backfillFolders: () => fetch('/api/admin/backfill-folders', { method: 'POST' }).then(json),
  renameFolder: (from, to) => fetch('/api/admin/folders/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to }) }).then(json),
  // Reparent a folder (and all nested subfolders + dashboards) atomically. `parent` = '' → top level.
  moveFolder: (from, parent) => fetch('/api/admin/folders/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, parent }) }).then(json),
  deleteFolder: (path) => fetch('/api/admin/folders/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }).then(json),
  // Looker folder import (files all its dashboards under a folder)
  lookerFolder: (id, includeSubfolders = true) => fetch(`/api/looker/folder/${encodeURIComponent(id)}?subfolders=${includeSubfolders ? 1 : 0}`).then(json),
  importFolder: (folderId, folder, includeSubfolders = true) =>
    fetch('/api/dashboards/import-folder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId, folder, includeSubfolders }),
    }).then(json),

  // Client navigation: Suites
  bustCache,
  mySuites: () => cachedGet('/api/my/suites'),
  saveSuiteOrder: (entityId, order) => fetch(`/api/my/suite-order/${entityId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order }) }).then(json),
  mySuiteCategories: (entityId) => fetch(`/api/my/suite-categories/${entityId}`).then(json),
  saveMySuiteCategories: (entityId, categories) => fetch(`/api/my/suite-categories/${entityId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ categories }) }).then(json),
  adminSuiteCategories: (entityId) => fetch(`/api/admin/entities/${entityId}/suite-categories`).then(json),
  adminSaveSuiteCategories: (entityId, categories) => fetch(`/api/admin/entities/${entityId}/suite-categories`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ categories }) }).then(json),
  mySuite: (id) => fetch(`/api/my/suites/${id}`).then(json),

  // Social metrics (inbound organic stats). Admins pass the ownership check, so
  // both admin-preview and client self-service use the same /api/my/social path.
  mySocial: (entityId, { metric = 'reach', days = 30, platform, accountRef, sort } = {}) => {
    const q = new URLSearchParams({ metric, days: String(days) });
    if (platform) q.set('platform', platform);
    if (accountRef) q.set('accountRef', accountRef);
    if (sort) q.set('sort', sort);
    return fetch(`/api/my/social/${entityId}?${q}`).then(json);
  },
  syncSocial: (entityId) => fetch(`/api/my/social/${entityId}/sync`, { method: 'POST' }).then(json),
  verifySocial: (entityId) => fetch(`/api/my/social/${entityId}/verify`, { method: 'POST' }).then(json),

  // Social+ (social.plus) in-app community analytics (inbound). Dual-surface
  // like queueit: 'admin-client' hits /api/admin (ungated), 'my' the flag-gated
  // client routes. Directory/assign power the community → client linking.
  socialplusData: (entityId, scope, { metric = 'members', days = 30, sort, community } = {}) => {
    const q = new URLSearchParams({ metric, days: String(days) });
    if (sort) q.set('sort', sort);
    if (community) q.set('community', community);
    return fetch(`${scope === 'admin-client' ? `/api/admin/entities/${entityId}/socialplus` : `/api/my/socialplus/${entityId}`}?${q}`).then(json);
  },
  socialplusSync: (entityId, scope) => fetch(scope === 'admin-client' ? `/api/admin/entities/${entityId}/socialplus/sync` : `/api/my/socialplus/${entityId}/sync`, { method: 'POST' }).then(json),
  // App audience ↔ buyers (email join) + per-app-user ticket holdings.
  appAudience: (entityId, scope, { event } = {}) => fetch(`${scope === 'admin-client' ? `/api/admin/entities/${entityId}/app-audience` : `/api/my/app-audience/${entityId}`}${event ? `?event=${encodeURIComponent(event)}` : ''}`).then(json),
  appTickets: (entityId, scope, emails) => fetch(scope === 'admin-client' ? `/api/admin/entities/${entityId}/app-tickets` : `/api/my/app-tickets/${entityId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emails }) }).then(json),
  appAudienceSegment: (entityId, scope, { group, event, size } = {}) => fetch(scope === 'admin-client' ? `/api/admin/entities/${entityId}/app-audience/segment` : `/api/my/app-audience/${entityId}/segment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group, event: event || '', size: size || 0 }) }).then(json),
  appTicketSummary: (entityId, scope, { event } = {}) => fetch(`${scope === 'admin-client' ? `/api/admin/entities/${entityId}/app-audience/tickets-summary` : `/api/my/app-audience/${entityId}/tickets-summary`}${event ? `?event=${encodeURIComponent(event)}` : ''}`).then(json),
  // Fired on page open — the server skips it when data is fresh (<30 min).
  socialplusRefresh: (entityId, scope) => fetch(scope === 'admin-client' ? `/api/admin/entities/${entityId}/socialplus/refresh` : `/api/my/socialplus/${entityId}/refresh`, { method: 'POST' }).then(json),
  socialplusToday: (entityId, scope, { community } = {}) => fetch(`${scope === 'admin-client' ? `/api/admin/entities/${entityId}/socialplus/today` : `/api/my/socialplus/${entityId}/today`}${community ? `?community=${encodeURIComponent(community)}` : ''}`).then(json),
  socialplusVerify: (entityId, scope) => fetch(scope === 'admin-client' ? `/api/admin/entities/${entityId}/socialplus/verify` : `/api/my/socialplus/${entityId}/verify`, { method: 'POST' }).then(json),
  // Directory + assign are admin-only — the directory spans every organiser's
  // communities, so there is deliberately no client-surface twin.
  socialplusDirectory: (entityId) => fetch(`/api/admin/entities/${entityId}/socialplus/directory`).then(json),
  socialplusAssign: (entityId, ids) => fetch(`/api/admin/entities/${entityId}/socialplus/assign`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }).then(json),

  // Inventive embedded AI analyst (server-proxied; key stays server-side).
  inventiveStatus: () => fetch('/api/inventive/status').then(json),
  inventiveEmbedUrl: (entityId, options) => fetch('/api/inventive/embed-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entityId, options }) }).then(json),

  // Saved dashboard filter views (per-user "save my view" + admin client default)
  getDashboardFilters: (dashboardId, suiteId) => fetch(`/api/my/dashboard-filters/${dashboardId}${suiteId ? `?suiteId=${suiteId}` : ''}`).then(json),
  saveMyDashboardFilters: (dashboardId, filters) => fetch(`/api/my/dashboard-filters/${dashboardId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filters }) }).then(json),
  resetMyDashboardFilters: (dashboardId) => fetch(`/api/my/dashboard-filters/${dashboardId}`, { method: 'DELETE' }).then(json),
  setClientDashboardFilters: (entityId, dashboardId, filters) => fetch(`/api/admin/entities/${entityId}/dashboard-filters/${dashboardId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filters }) }).then(json),
  resetClientDashboardFilters: (entityId, dashboardId) => fetch(`/api/admin/entities/${entityId}/dashboard-filters/${dashboardId}`, { method: 'DELETE' }).then(json),
  // Admin: per-dashboard locked-filter overrides for a suite dashboard (writes to
  // suite.dashboardLocks). `locks` is { filterName: value } — empty clears it.
  setSuiteDashboardLocks: (suiteId, dashboardId, locks) => fetch(`/api/admin/suites/${suiteId}/dashboard-locks/${dashboardId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locks }) }).then(json),
  // Per-tile lock overrides for one tile in a suite ({ filterName: value }).
  setSuiteTileLocks: (suiteId, tileId, locks) => fetch(`/api/admin/suites/${suiteId}/tile-locks/${tileId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locks }) }).then(json),

  // Tile library
  libraryList: (params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return fetch(`/api/admin/library${qs ? `?${qs}` : ''}`).then(json);
  },
  libraryUpdate: (id, patch) => fetch(`/api/admin/library/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).then(json),
  libraryDelete: (id) => fetch(`/api/admin/library/${id}`, { method: 'DELETE' }),
  libraryDescribe: (id) => fetch(`/api/admin/library/${id}/describe`, { method: 'POST' }).then(json),
  libraryBackfill: () => fetch('/api/admin/library/backfill', { method: 'POST' }).then(json),
  libraryUse: (id) => fetch(`/api/admin/library/${id}/use`, { method: 'POST' }).then(json),

  // Global AI instructions
  getAiInstructions: () => fetch('/api/admin/ai-instructions').then(json),
  saveAiInstructions: (instructions) => fetch('/api/admin/ai-instructions', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instructions }) }).then(json),
  getAiOverview: () => fetch('/api/admin/ai-overview').then(json),
  getAiUsage: (days = 14) => fetch(`/api/admin/ai-usage?days=${days}`).then(json),

  // Custom sending domain (dual-surface: admin per client, client self-service)
  getTileZoom: (dashboardId) => fetch(`/api/my/tile-zoom/${dashboardId}`).then(json),
  saveTileZoom: (dashboardId, zoom) => fetch(`/api/my/tile-zoom/${dashboardId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zoom }) }).then(json),
  clearQueryCache: () => fetch('/api/admin/clear-query-cache', { method: 'POST' }).then(json),
  // 🚩 Feature flags (Admin → Product → Flags) + the client's own effective map.
  adminFlags: () => fetch('/api/admin/flags').then(json),
  setFlagDefault: (key, value) => fetch('/api/admin/flags/default', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }) }).then(json),
  setFlagOverride: (entityId, key, value) => fetch(`/api/admin/flags/${entityId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }) }).then(json),
  myFlags: (entityId) => fetch(`/api/my/flags/${entityId}`).then(json),
  impersonateUser: (userId) => fetch(`/api/admin/impersonate/${userId}`, { method: 'POST' }).then(json),
  impersonateExit: () => fetch('/api/impersonate/exit', { method: 'POST' }).then(json),
  getSendingDomain: (entityId, scope = 'admin') => fetch(scope === 'my' ? `/api/my/sending-domain/${entityId}` : `/api/admin/entities/${entityId}/sending-domain`).then(json),
  saveSendingDomain: (entityId, body, scope = 'admin') => fetch(scope === 'my' ? `/api/my/sending-domain/${entityId}` : `/api/admin/entities/${entityId}/sending-domain`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  verifySendingDomain: (entityId, scope = 'admin') => fetch(`${scope === 'my' ? `/api/my/sending-domain/${entityId}` : `/api/admin/entities/${entityId}/sending-domain`}/verify`, { method: 'POST' }).then(json),
  deleteSendingDomain: (entityId, scope = 'admin') => fetch(scope === 'my' ? `/api/my/sending-domain/${entityId}` : `/api/admin/entities/${entityId}/sending-domain`, { method: 'DELETE' }).then(json),
  getResolvedPrompt: ({ feature, entityId, role }) => fetch(`/api/admin/ai-resolved-prompt?feature=${encodeURIComponent(feature)}${entityId ? `&entityId=${encodeURIComponent(entityId)}` : ''}${role ? `&role=${encodeURIComponent(role)}` : ''}`).then(json),

  // Integrations
  getAdminIntegrations: () => fetch('/api/admin/integrations').then(json),
  getIntegrationsHealth: () => fetch('/api/admin/integrations/health').then(json),
  verifyConnector: (entityId, channel) => fetch(`/api/admin/integrations/${entityId}/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel }) }).then(json),
  audienceStatus: (entityId, channel, audienceId) => fetch(`/api/admin/integrations/${entityId}/audience-status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, audienceId }) }).then(json),
  getAudienceSyncLog: (entityId, limit = 50) => fetch(`/api/admin/integrations/${entityId}/log?limit=${limit}`).then(json),
  // Client self-service ad-audience hub (own entity, /api/my).
  myAudiences: (entityId) => fetch(`/api/my/audiences/${entityId}`).then(json),
  myVerifyConnector: (entityId, channel) => fetch(`/api/my/audiences/${entityId}/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel }) }).then(json),
  myAudienceStatus: (entityId, channel, audienceId) => fetch(`/api/my/audiences/${entityId}/audience-status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, audienceId }) }).then(json),
  myPlatformAudiences: (entityId, channel) => fetch(`/api/my/audiences/${entityId}/platform/${channel}`).then(json),
  myAudienceSyncLog: (entityId, limit = 50) => fetch(`/api/my/audiences/${entityId}/log?limit=${limit}`).then(json),
  saveAdminIntegrations: (p) => fetch('/api/admin/integrations', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),
  setAdminIntegrationLock: (key, locked) => fetch('/api/admin/integrations/lock', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, locked }) }).then(json),
  sendMailTest: (entityId) => fetch('/api/admin/mail/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entityId }) }).then(json),
  getMailLog: (params = {}) => fetch(`/api/admin/mail-log?${new URLSearchParams(params)}`).then(json),
  getMyMailLog: (entityId, params = {}) => fetch(`/api/my/mail-log/${entityId}?${new URLSearchParams(params)}`).then(json),
  getPixelStatus: (id) => fetch(`/api/admin/entities/${id}/pixel/status`).then(json),
  createPixelAudiences: (id, channel) => fetch(`/api/admin/entities/${id}/pixel/audiences`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel }) }).then(json),
  myPixelStatus: (entityId) => fetch(`/api/my/pixel/${entityId}/status`).then(json),
  myCreatePixelAudiences: (entityId, channel) => fetch(`/api/my/pixel/${entityId}/audiences`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel }) }).then(json),
  getEntityIntegrations: (id) => fetch(`/api/admin/entities/${id}/integrations`).then(json),
  saveEntityIntegrations: (id, p) => fetch(`/api/admin/entities/${id}/integrations`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),
  getMyIntegrations: () => fetch('/api/my/integrations').then(json),
  saveMyIntegrations: (entityId, p) => fetch(`/api/my/integrations/${entityId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),
  setMyIntegrationLock: (entityId, key, locked) => fetch(`/api/my/integrations/${entityId}/lock`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, locked }) }).then(json),
  testEntitySlack: (id) => fetch(`/api/admin/entities/${id}/slack/test`, { method: 'POST' }).then(json),
  testMySlack: (entityId) => fetch(`/api/my/slack/${entityId}/test`, { method: 'POST' }).then(json),
  slackShareStatus: () => fetch('/api/my/slack/share-status').then(json),
  slackShare: (p) => fetch('/api/my/slack/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),
  setEntityIntegrationLock: (id, key, locked) => fetch(`/api/admin/entities/${id}/integrations/lock`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, locked }) }).then(json),

  // ChottuLink deep links — dual surface (admin per client / client self-service).
  chottuLinks: (scope, entityId) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/chottu/links` : `/api/my/chottu/${entityId}/links`).then(json),
  chottuCreateLink: (scope, entityId, link) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/chottu/links` : `/api/my/chottu/${entityId}/links`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(link) }).then(json),
  chottuUpdateLink: (scope, entityId, id, patch) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/chottu/links/${id}` : `/api/my/chottu/${entityId}/links/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).then(json),
  chottuSetLinkStatus: (scope, entityId, id, enabled) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/chottu/links/${id}/status` : `/api/my/chottu/${entityId}/links/${id}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) }).then(json),
  chottuRefreshStats: (scope, entityId, body = {}) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/chottu/refresh-stats` : `/api/my/chottu/${entityId}/refresh-stats`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  chottuImportPreview: (entityId) => fetch(`/api/admin/entities/${entityId}/chottu/import/preview`).then(json),
  chottuRemoveImported: (entityId) => fetch(`/api/admin/entities/${entityId}/chottu/imported`, { method: 'DELETE' }).then(json),
  chottuImport: (entityId, body = {}) => fetch(`/api/admin/entities/${entityId}/chottu/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  chottuDeleteLink: (scope, entityId, id) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/chottu/links/${id}` : `/api/my/chottu/${entityId}/links/${id}`, { method: 'DELETE' }).then(json),
  chottuTest: (entityId) => fetch(`/api/admin/entities/${entityId}/chottu/test`, { method: 'POST' }).then(json),
  chottuSuggestMeta: (scope, entityId, body) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/chottu/suggest-meta` : `/api/my/chottu/${entityId}/suggest-meta`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  chottuStats: (scope, entityId, suiteId = '') => fetch((scope === 'admin' ? `/api/admin/entities/${entityId}/chottu/stats` : `/api/my/chottu/${entityId}/stats`) + (suiteId ? `?suiteId=${encodeURIComponent(suiteId)}` : '')).then(json),
  chottuTemplates: (scope, entityId) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/chottu/templates` : `/api/my/chottu/${entityId}/templates`).then(json),
  chottuSaveTemplate: (scope, entityId, id, t) => fetch((scope === 'admin' ? `/api/admin/entities/${entityId}/chottu/templates` : `/api/my/chottu/${entityId}/templates`) + (id ? `/${id}` : ''), { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(t) }).then(json),
  chottuDeleteTemplate: (scope, entityId, id) => fetch((scope === 'admin' ? `/api/admin/entities/${entityId}/chottu/templates` : `/api/my/chottu/${entityId}/templates`) + `/${id}`, { method: 'DELETE' }),
  chottuPreviewTemplate: (scope, entityId, id, body) => fetch((scope === 'admin' ? `/api/admin/entities/${entityId}/chottu/templates` : `/api/my/chottu/${entityId}/templates`) + `/${id}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  chottuApplyTemplate: (scope, entityId, id, body) => fetch((scope === 'admin' ? `/api/admin/entities/${entityId}/chottu/templates` : `/api/my/chottu/${entityId}/templates`) + `/${id}/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),

  // ── Surveys (Engage → Surveys · post-event fan feedback, docs/specs/SURVEY_CONTRACT.md) ──
  listSurveys: (scope, entityId) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/surveys` : '/api/my/surveys').then(json),
  createSurvey: (scope, entityId, body) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/surveys` : '/api/my/surveys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope === 'admin' ? body : { ...body, entityId }) }).then(json),
  updateSurvey: (scope, entityId, id, patch) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/surveys/${id}` : `/api/my/surveys/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).then(json),
  surveyAction: (scope, entityId, id, action) => fetch((scope === 'admin' ? `/api/admin/entities/${entityId}/surveys/${id}` : `/api/my/surveys/${id}`) + `/${action}`, { method: 'POST' }).then(json),
  deleteSurvey: (scope, entityId, id) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/surveys/${id}` : `/api/my/surveys/${id}`, { method: 'DELETE' }).then(json),
  surveyResults: (scope, entityId, id, filters = {}) => fetch((scope === 'admin' ? `/api/admin/entities/${entityId}/surveys/${id}` : `/api/my/surveys/${id}`) + '/results?' + new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, v]) => v))).toString()).then(json),
  surveyResponses: (scope, entityId, id, params = {}) => fetch((scope === 'admin' ? `/api/admin/entities/${entityId}/surveys/${id}` : `/api/my/surveys/${id}`) + '/responses?' + new URLSearchParams(params).toString()).then(json),
  surveyCsvUrl: (scope, entityId, id, filters = {}) => (scope === 'admin' ? `/api/admin/entities/${entityId}/surveys/${id}` : `/api/my/surveys/${id}`) + '/results.csv?' + new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, v]) => v))).toString(),
  surveyEventResults: (entityId, eventId, filters = {}) => fetch('/api/my/surveys/event-results?' + new URLSearchParams({ entityId, eventId, ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) }).toString()).then(json),
  surveyEventCsvUrl: (entityId, eventId, filters = {}) => '/api/my/surveys/event-results.csv?' + new URLSearchParams({ entityId, eventId, ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) }).toString(),
  surveyEventLookup: (eventId) => fetch(`/api/my/surveys/event-lookup?eventId=${encodeURIComponent(eventId)}`).then(json),
  surveyEntityEvents: (entityId) => fetch(`/api/my/surveys/events?entityId=${encodeURIComponent(entityId)}`).then(json),
  surveySendEmails: (scope, entityId, id, body) => fetch((scope === 'admin' ? `/api/admin/entities/${entityId}/surveys/${id}` : `/api/my/surveys/${id}`) + '/email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  surveyShareLink: (scope, entityId, id) => fetch((scope === 'admin' ? `/api/admin/entities/${entityId}/surveys/${id}` : `/api/my/surveys/${id}`) + '/share-link', { method: 'POST' }).then(json),
  surveyLinks: (scope, entityId, id) => fetch((scope === 'admin' ? `/api/admin/entities/${entityId}/surveys/${id}` : `/api/my/surveys/${id}`) + '/links').then(json),

  // Community feed (Social+ replacement spike) — docs/specs/SOCIAL_CONTRACT.md
  socialCommunities: (scope, entityId) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/social/communities` : `/api/my/social/communities?entityId=${encodeURIComponent(entityId)}`).then(json),
  socialCreateCommunity: (scope, entityId, body) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/social/communities` : '/api/my/social/communities', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope === 'admin' ? body : { ...body, entityId }) }).then(json),
  socialPosts: (scope, entityId) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/social/posts` : `/api/my/social/posts?entityId=${encodeURIComponent(entityId)}`).then(json),
  socialCreatePost: (scope, entityId, body) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/social/posts` : '/api/my/social/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope === 'admin' ? body : { ...body, entityId }) }).then(json),
  socialUpdatePost: (scope, entityId, id, patch) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/social/posts/${id}` : `/api/my/social/posts/${id}?entityId=${encodeURIComponent(entityId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope === 'admin' ? patch : { ...patch, entityId }) }).then(json),
  socialDeletePost: (scope, entityId, id) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/social/posts/${id}` : `/api/my/social/posts/${id}?entityId=${encodeURIComponent(entityId)}`, { method: 'DELETE' }).then(json),
  socialPinPost: (scope, entityId, id, pinned) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/social/posts/${id}/pin` : `/api/my/social/posts/${id}/pin?entityId=${encodeURIComponent(entityId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope === 'admin' ? { pinned } : { pinned, entityId }) }).then(json),
  socialPosters: (scope, entityId) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/social/posters` : `/api/my/social/posters?entityId=${encodeURIComponent(entityId)}`).then(json),
  socialAddPoster: (scope, entityId, body) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/social/posters` : `/api/my/social/posters?entityId=${encodeURIComponent(entityId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope === 'admin' ? body : { ...body, entityId }) }).then(json),
  socialRemovePoster: (scope, entityId, userId) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/social/posters/${userId}` : `/api/my/social/posters/${userId}?entityId=${encodeURIComponent(entityId)}`, { method: 'DELETE' }).then(json),
  socialPosterSuggestions: (scope, entityId) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/social/posters-suggestions` : `/api/my/social/posters-suggestions?entityId=${encodeURIComponent(entityId)}`).then(json),
  socialShareStats: (scope, entityId) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/social/share-stats` : `/api/my/social/share-stats?entityId=${encodeURIComponent(entityId)}`).then(json),
  socialCtaClicks: (scope, entityId, kind, refId) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/social/cta-clicks?kind=${encodeURIComponent(kind)}&refId=${encodeURIComponent(refId)}` : `/api/my/social/cta-clicks?kind=${encodeURIComponent(kind)}&refId=${encodeURIComponent(refId)}&entityId=${encodeURIComponent(entityId)}`).then(json),
  socialGetHouse: () => fetch('/api/admin/social/house').then(json),
  socialSetHouse: (entityId) => fetch('/api/admin/social/house', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entityId }) }).then(json),
  socialInstagramMedia: (scope, entityId) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/social/instagram/media` : `/api/my/social/instagram/media?entityId=${encodeURIComponent(entityId)}`).then(json),
  socialInstagramImport: (scope, entityId, body) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/social/instagram/import` : `/api/my/social/instagram/import?entityId=${encodeURIComponent(entityId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope === 'admin' ? body : { ...body, entityId }) }).then(json),
  socialUploadMedia: (scope, entityId, body) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/social/media` : '/api/my/social/media', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope === 'admin' ? body : { ...body, entityId }) }).then(json),
  socialMediaConfig: (scope, entityId) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/social/media/config` : `/api/my/social/media/config?entityId=${encodeURIComponent(entityId)}`).then(json),
  socialComments: (scope, entityId, postId) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/social/posts/${postId}/comments` : `/api/my/social/posts/${postId}/comments?entityId=${encodeURIComponent(entityId)}`).then(json),
  socialDeleteComment: (scope, entityId, id) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/social/comments/${id}` : `/api/my/social/comments/${id}?entityId=${encodeURIComponent(entityId)}`, { method: 'DELETE' }).then(json),
  socialAllComments: (scope, entityId) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/social/comments` : `/api/my/social/comments?entityId=${encodeURIComponent(entityId)}`).then(json),
  socialReplyComment: (scope, entityId, id, text, cta = {}) => fetch((scope === 'admin' ? `/api/admin/entities/${entityId}/social/comments/${id}` : `/api/my/social/comments/${id}`) + '/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope === 'admin' ? { text, ...cta } : { text, ...cta, entityId }) }).then(json),
  socialUpdateCommunity: (scope, entityId, id, patch) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/social/communities/${id}` : `/api/my/social/communities/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope === 'admin' ? patch : { ...patch, entityId }) }).then(json),
  socialDeleteCommunity: (scope, entityId, id) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/social/communities/${id}` : `/api/my/social/communities/${id}?entityId=${entityId}`, { method: 'DELETE' }).then(json),

  // Event chat channels (Social+ replacement phase 2) — docs/specs/SOCIAL_CONTRACT.md §chat
  chatBase: (scope, entityId) => (scope === 'admin' ? `/api/admin/entities/${entityId}/social/chat` : '/api/my/social/chat'),
  chatQ: (scope, entityId, extra = {}) => new URLSearchParams(scope === 'admin' ? extra : { entityId, ...extra }).toString(),
  chatChannels: (scope, entityId, eventId) => fetch(`${api.chatBase(scope, entityId)}/channels?${api.chatQ(scope, entityId, eventId ? { eventId } : {})}`).then(json),
  chatCreateChannel: (scope, entityId, body) => fetch(`${api.chatBase(scope, entityId)}/channels`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope === 'admin' ? body : { ...body, entityId }) }).then(json),
  chatUpdateChannel: (scope, entityId, id, patch) => fetch(`${api.chatBase(scope, entityId)}/channels/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope === 'admin' ? patch : { ...patch, entityId }) }).then(json),
  chatCloseChannel: (scope, entityId, id) => fetch(`${api.chatBase(scope, entityId)}/channels/${id}/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope === 'admin' ? {} : { entityId }) }).then(json),
  chatChannelMessages: (scope, entityId, id) => fetch(`${api.chatBase(scope, entityId)}/channels/${id}/messages?${api.chatQ(scope, entityId)}`).then(json),
  chatSendMessage: (scope, entityId, id, body) => fetch(`${api.chatBase(scope, entityId)}/channels/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope === 'admin' ? body : { ...body, entityId }) }).then(json),
  chatAddMember: (scope, entityId, id, body) => fetch(`${api.chatBase(scope, entityId)}/channels/${id}/members`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope === 'admin' ? body : { ...body, entityId }) }).then(json),
  chatSyncSegment: (scope, entityId, id) => fetch(`${api.chatBase(scope, entityId)}/channels/${id}/sync-segment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope === 'admin' ? {} : { entityId }) }).then(json),
  chatBroadcast: (scope, entityId, body) => fetch(`${api.chatBase(scope, entityId)}/broadcast`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope === 'admin' ? body : { ...body, entityId }) }).then(json),
  chatModerate: (scope, entityId, id, action) => fetch(`${api.chatBase(scope, entityId)}/messages/${id}/${action}?${api.chatQ(scope, entityId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope === 'admin' ? {} : { entityId }) }).then(json),
  socialPresignMedia: (scope, entityId, body) => fetch(scope === 'admin' ? `/api/admin/entities/${entityId}/social/media/presign` : '/api/my/social/media/presign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope === 'admin' ? body : { ...body, entityId }) }).then(json),

  // Social moderation: banned lists + review queue — docs/specs/MODERATION_CONTRACT.md §8.2.
  // scope: 'platform' (Howler-wide rules + cross-client queue) | 'admin'
  // (per-client, on behalf) | 'my' (client self-service, entityId in query/body).
  modBase: (scope, entityId) => (scope === 'platform' ? '/api/admin/moderation' : scope === 'admin' ? `/api/admin/entities/${entityId}/moderation` : '/api/my/moderation'),
  modQ: (scope, entityId, extra = {}) => new URLSearchParams(scope === 'my' ? { entityId, ...extra } : extra).toString(),
  modBody: (scope, entityId, body = {}) => JSON.stringify(scope === 'my' ? { ...body, entityId } : body),
  modRules: (scope, entityId) => fetch(`${api.modBase(scope, entityId)}/rules?${api.modQ(scope, entityId)}`).then(json),
  modCreateRule: (scope, entityId, body) => fetch(`${api.modBase(scope, entityId)}/rules`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: api.modBody(scope, entityId, body) }).then(json),
  modImportRules: (scope, entityId, entries) => fetch(`${api.modBase(scope, entityId)}/rules/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: api.modBody(scope, entityId, { entries }) }).then(json),
  modTestRules: (scope, entityId, text) => fetch(`${api.modBase(scope, entityId)}/rules/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: api.modBody(scope, entityId, { text }) }).then(json),
  modPatchRule: (scope, entityId, id, patch) => fetch(`${api.modBase(scope, entityId)}/rules/${id}?${api.modQ(scope, entityId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: api.modBody(scope, entityId, patch) }).then(json),
  modDeleteRule: (scope, entityId, id) => fetch(`${api.modBase(scope, entityId)}/rules/${id}?${api.modQ(scope, entityId)}`, { method: 'DELETE' }).then(json),
  modQueue: (scope, entityId, opts = {}) => fetch(`${api.modBase(scope, entityId)}/queue?${api.modQ(scope, entityId, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined && v !== null)))}`).then(json),
  modDecide: (scope, entityId, id, approve) => fetch(`${api.modBase(scope, entityId)}/queue/${id}/${approve ? 'approve' : 'decline'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: api.modBody(scope, entityId, {}) }).then(json),
  modAudit: (scope, entityId, opts = {}) => fetch(`${api.modBase(scope, entityId)}/audit?${api.modQ(scope, entityId, opts)}`).then(json),

  // API keys for the public surface (/api/v1 + MCP) — dual-surface management.
  listEntityApiKeys: (id) => fetch(`/api/admin/entities/${id}/api-keys`).then(json),
  createEntityApiKey: (id, p) => fetch(`/api/admin/entities/${id}/api-keys`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),
  revokeEntityApiKey: (id, keyId) => fetch(`/api/admin/entities/${id}/api-keys/${keyId}/revoke`, { method: 'POST' }).then(json),
  setEntityApiAccess: (id, enabled) => fetch(`/api/admin/entities/${id}/api-access`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) }).then(json),
  listMyApiKeys: (entityId) => fetch(`/api/my/api-keys/${entityId}`).then(json),
  createMyApiKey: (entityId, p) => fetch(`/api/my/api-keys/${entityId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),
  revokeMyApiKey: (entityId, keyId) => fetch(`/api/my/api-keys/${entityId}/${keyId}/revoke`, { method: 'POST' }).then(json),

  // Email templates / branding (platform default + per-client overrides)
  getMailTemplate: () => fetch('/api/admin/mail-template').then(json),
  saveMailTemplate: (p) => fetch('/api/admin/mail-template', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),
  getEntityMailTemplate: (id) => fetch(`/api/admin/entities/${id}/mail-template`).then(json),
  saveEntityMailTemplate: (id, p) => fetch(`/api/admin/entities/${id}/mail-template`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),
  // Vanity login slug (admin) + the PUBLIC branding lookup used by the /<slug> login.
  getClientSlug: (id) => fetch(`/api/admin/entities/${id}/slug`).then(json),
  saveClientSlug: (id, slug) => fetch(`/api/admin/entities/${id}/slug`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug }) }).then(json),
  getBrandingBySlug: (slug) => fetch(`/api/branding/${encodeURIComponent(slug)}`).then(json),
  getMyMailTemplate: (entityId) => fetch(`/api/my/mail-template/${entityId}`).then(json),
  saveMyMailTemplate: (entityId, p) => fetch(`/api/my/mail-template/${entityId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),
  previewMail: (edits, entityId, suiteId) => fetch('/api/mail/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ edits, entityId, suiteId }) }).then(json),
  // Per-event (suite) branding override — admin only.
  getSuiteMailTemplate: (suiteId) => fetch(`/api/admin/suites/${suiteId}/mail-template`).then(json),
  saveSuiteMailTemplate: (suiteId, p) => fetch(`/api/admin/suites/${suiteId}/mail-template`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),
  // Per-event branding — client self-service (a suite the client owns).
  getMySuiteMailTemplate: (suiteId) => fetch(`/api/my/suites/${suiteId}/mail-template`).then(json),
  saveMySuiteMailTemplate: (suiteId, p) => fetch(`/api/my/suites/${suiteId}/mail-template`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),

  // CC-the-Owl: inbound email addresses + config
  getInboundConfig: () => fetch('/api/os/admin/inbound').then(json),
  saveInboundConfig: (p) => fetch('/api/os/admin/inbound', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),
  // Owl auto-ingest (settlements/invoices from CC-the-Owl email): kill-switch + sender allowlist
  getOwlIngest: () => fetch('/api/admin/owl-ingest').then(json),
  saveOwlIngest: (p) => fetch('/api/admin/owl-ingest', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),
  getEntityInbox: (id) => fetch(`/api/admin/entities/${id}/inbox`).then(json),
  regenEntityInbox: (id) => fetch(`/api/admin/entities/${id}/inbox/regenerate`, { method: 'POST' }).then(json),
  getMyInbox: (entityId) => fetch(`/api/my/inbox/${entityId}`).then(json),

  // Scheduled digests — admin (any client) + client self-service (own entity)
  getDigests: (entityId) => fetch(`/api/admin/entities/${entityId}/digests`).then(json),
  createDigest: (entityId, b) => fetch(`/api/admin/entities/${entityId}/digests`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  updateDigest: (jobId, b) => fetch(`/api/admin/digests/${jobId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  deleteDigest: (jobId) => fetch(`/api/admin/digests/${jobId}`, { method: 'DELETE' }).then((r) => r.ok),
  testDigest: (jobId) => fetch(`/api/admin/digests/${jobId}/test`, { method: 'POST' }).then(json),
  runDigest: (jobId) => fetch(`/api/admin/digests/${jobId}/run`, { method: 'POST' }).then(json),
  previewDigest: (b) => fetch('/api/admin/digests/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  testSendDigest: (b) => fetch('/api/admin/digests/test-send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  testSendDigestSms: (b) => fetch('/api/admin/digests/test-send-sms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  getMyDigests: (entityId) => fetch(`/api/my/digests/${entityId}`).then(json),
  createMyDigest: (entityId, b) => fetch(`/api/my/digests/${entityId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  updateMyDigest: (entityId, jobId, b) => fetch(`/api/my/digests/${entityId}/${jobId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  deleteMyDigest: (entityId, jobId) => fetch(`/api/my/digests/${entityId}/${jobId}`, { method: 'DELETE' }).then((r) => r.ok),
  testMyDigest: (entityId, jobId) => fetch(`/api/my/digests/${entityId}/${jobId}/test`, { method: 'POST' }).then(json),
  previewMyDigest: (entityId, b) => fetch(`/api/my/digests/${entityId}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  testSendMyDigest: (entityId, b) => fetch(`/api/my/digests/${entityId}/test-send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  testSendMyDigestSms: (entityId, b) => fetch(`/api/my/digests/${entityId}/test-send-sms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  getDigestTiles: (entityId) => fetch(`/api/admin/entities/${entityId}/digest-tiles`).then(json),
  getDigestEvents: (entityId) => fetch(`/api/admin/entities/${entityId}/digest-events`).then(json),
  getFollowedTiles: (entityId) => fetch(`/api/admin/entities/${entityId}/followed-tiles`).then(json),
  getMyFollowedTiles: (entityId) => fetch(`/api/my/followed-tiles/${entityId}`).then(json),
  // Report Studio — block-based client reports (admin + client self-service surfaces).
  getReports: (entityId) => fetch(`/api/admin/entities/${entityId}/reports`).then(json),
  createReport: (entityId, b) => fetch(`/api/admin/entities/${entityId}/reports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  updateReport: (tplId, b) => fetch(`/api/admin/reports/${tplId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  deleteReport: (tplId) => fetch(`/api/admin/reports/${tplId}`, { method: 'DELETE' }).then((r) => r.ok),
  generateReport: (tplId) => fetch(`/api/admin/reports/${tplId}/generate`, { method: 'POST' }).then(json),
  sendReport: (tplId, b) => fetch(`/api/admin/reports/${tplId}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(json),
  getReportSnapshots: (tplId) => fetch(`/api/admin/reports/${tplId}/snapshots`).then(json),
  deleteReportSnapshot: (id) => fetch(`/api/admin/report-snapshots/${id}`, { method: 'DELETE' }).then((r) => r.ok),
  previewReport: (entityId, b) => fetch(`/api/admin/entities/${entityId}/reports/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  previewMyReport: (entityId, b) => fetch(`/api/my/reports/${entityId}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  getMyReports: (entityId) => fetch(`/api/my/reports/${entityId}`).then(json),
  createMyReport: (entityId, b) => fetch(`/api/my/reports/${entityId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  updateMyReport: (entityId, tplId, b) => fetch(`/api/my/reports/${entityId}/${tplId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  deleteMyReport: (entityId, tplId) => fetch(`/api/my/reports/${entityId}/${tplId}`, { method: 'DELETE' }).then((r) => r.ok),
  generateMyReport: (entityId, tplId) => fetch(`/api/my/reports/${entityId}/${tplId}/generate`, { method: 'POST' }).then(json),
  sendMyReport: (entityId, tplId, b) => fetch(`/api/my/reports/${entityId}/${tplId}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(json),
  getMyReportSnapshots: (entityId, tplId) => fetch(`/api/my/reports/${entityId}/${tplId}/snapshots`).then(json),
  deleteMyReportSnapshot: (entityId, id) => fetch(`/api/my/reports/${entityId}/snapshots/${id}`, { method: 'DELETE' }).then((r) => r.ok),
  // Campaign billing — per-channel rate card + cost rollups.
  getBillingMaster: () => fetch('/api/billing/master').then(json),
  saveBillingMaster: (b) => fetch('/api/billing/master', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  getBillingEntityRates: (entityId) => fetch(`/api/billing/admin/entities/${entityId}/rates`).then(json),
  saveBillingEntityRates: (entityId, b) => fetch(`/api/billing/admin/entities/${entityId}/rates`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  getMyBilling: (entityId) => fetch(`/api/billing/my/${entityId}`).then(json),
  getBillingRollup: () => fetch('/api/billing/rollup').then(json),
  getEntityTheme: (entityId, suiteId) => fetch(`/api/theme/${entityId}${suiteId ? `?suite=${encodeURIComponent(suiteId)}` : ''}`).then(json),

  // Action Engine — campaigns (one set of endpoints; server enforces entity access)
  getActionTemplates: (entityId, prefer = {}) => {
    const q = new URLSearchParams();
    if (prefer.dashboard) q.set('dashboard', prefer.dashboard);
    if (prefer.suite) q.set('suite', prefer.suite);
    const qs = q.toString();
    return fetch(`/api/action-templates/${entityId}${qs ? `?${qs}` : ''}`).then(json);
  },
  actionJourney: (entityId, id) => fetch(`/api/actions/${entityId}/${id}/journey`).then(json),
  getMasters: (entityId) => fetch(`/api/actions/${entityId}/masters`).then(json),
  saveMaster: (entityId, b) => fetch(`/api/actions/${entityId}/masters`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  deleteMaster: (entityId, name) => fetch(`/api/actions/${entityId}/masters/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) => (r.ok ? {} : Promise.reject(new Error('Failed')))),
  getAudienceCap: (entityId) => fetch(`/api/admin/entities/${entityId}/audience-cap`).then(json),
  saveAudienceCap: (entityId, body) => fetch(`/api/admin/entities/${entityId}/audience-cap`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(json),
  listActions: (entityId) => fetch(`/api/actions/${entityId}`).then(json),
  duplicateAction: (entityId, id) => fetch(`/api/actions/${entityId}/${id}/duplicate`, { method: 'POST' }).then(json),
  scheduleAction: (entityId, id, at) => fetch(`/api/actions/${entityId}/${id}/schedule`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ at }) }).then(json),
  submitAction: (entityId, id, body) => fetch(`/api/actions/${entityId}/${id}/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  actionThread: (entityId, id) => fetch(`/api/actions/${entityId}/${id}/thread`).then(json),
  rejectAction: (entityId, id, note) => fetch(`/api/actions/${entityId}/${id}/reject`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }) }).then(json),
  setApprovalSetting: (entityId, requireApproval) => fetch(`/api/actions/${entityId}/approval-setting`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requireApproval }) }).then(json),
  createAction: (entityId, b) => fetch(`/api/actions/${entityId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  updateAction: (entityId, id, b) => fetch(`/api/actions/${entityId}/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  deleteAction: (entityId, id) => fetch(`/api/actions/${entityId}/${id}`, { method: 'DELETE' }).then((r) => r.ok),
  approveAction: (entityId, id) => fetch(`/api/actions/${entityId}/${id}/approve`, { method: 'POST' }).then(json),
  pauseAction: (entityId, id) => fetch(`/api/actions/${entityId}/${id}/pause`, { method: 'POST' }).then(json),
  actionAudiencePreview: (entityId, b) => fetch(`/api/actions/${entityId}/audience-preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  // Segments (reusable live audiences)
  listSegments: (entityId) => fetch(`/api/segments/${entityId}`).then(json),
  createSegment: (entityId, b) => fetch(`/api/segments/${entityId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  createSegmentFromRecipe: (entityId, key) => fetch(`/api/segments/${entityId}/recipe/${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }).then(json),
  updateSegment: (entityId, id, b) => fetch(`/api/segments/${entityId}/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  deleteSegment: (entityId, id) => fetch(`/api/segments/${entityId}/${id}`, { method: 'DELETE' }).then(json),
  previewSegment: (entityId, id) => fetch(`/api/segments/${entityId}/${id}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(json),
  segmentMembers: (entityId, id) => fetch(`/api/segments/${entityId}/${id}/members`).then(json),
  syncSegmentMeta: (entityId, id) => fetch(`/api/segments/${entityId}/${id}/sync/meta`, { method: 'POST' }).then(json),
  setSegmentAuto: (entityId, id, channel, on) => fetch(`/api/segments/${entityId}/${id}/sync/${channel}/auto`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on }) }).then(json),
  syncSegmentTikTok: (entityId, id) => fetch(`/api/segments/${entityId}/${id}/sync/tiktok`, { method: 'POST' }).then(json),
  actionFieldValues: (entityId, b) => fetch(`/api/actions/${entityId}/field-values`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  actionDraftCopy: (entityId, b) => fetch(`/api/actions/${entityId}/draft-copy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  codeHealth: (refresh) => fetch(`/api/admin/code-health${refresh ? '?refresh=1' : ''}`).then(json),
  journeyRecipes: (entityId) => fetch(`/api/journeys/${entityId}/recipes`).then(json),
  journeyStats: (entityId, actionId) => fetch(`/api/journeys/${entityId}/${actionId}/stats`).then(json),
  owlDraftJourney: (body) => fetch('/api/owl/act/draft-journey', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  actionPreviewEmail: (entityId, b) => fetch(`/api/actions/${entityId}/preview-email`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  designImage: (entityId, b) => fetch(`/api/actions/${entityId}/design-image`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(json),
  actionTestSend: (entityId, b) => fetch(`/api/actions/${entityId}/test-send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  listCampaignEvents: (entityId) => fetch(`/api/actions/${entityId}/events`).then(json),
  actionReport: (entityId, id) => fetch(`/api/actions/${entityId}/${id}/report`).then(json),
  recheckConversions: (entityId, id) => fetch(`/api/actions/${entityId}/${id}/recheck-conversions`, { method: 'POST' }).then(json),
  getActionsSummary: (entityId) => fetch(`/api/actions-summary/${entityId}`).then(json),
  ackCampaignOutcome: (entityId, id) => fetch(`/api/actions/${entityId}/${id}/ack-outcome`, { method: 'POST' }).then(json),
  getNotificationSettings: () => fetch('/api/admin/notification-settings').then(json),
  getSmsConfig: () => fetch('/api/admin/sms-config').then(json),
  setSmsConfig: (b) => fetch('/api/admin/sms-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  smsTest: (to) => fetch('/api/admin/sms-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to }) }).then(json),
  setNotificationSettings: (b) => fetch('/api/admin/notification-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  getDismissedThreads: () => fetch('/api/my/dismissed-threads').then(json),
  dismissThread: (threadId) => fetch('/api/my/dismiss-thread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId }) }).then(json),
  getMyDigestTiles: (entityId) => fetch(`/api/my/digest-tiles/${entityId}`).then(json),
  getMyDigestEvents: (entityId) => fetch(`/api/my/digest-events/${entityId}`).then(json),

  // Custom categories (tags) for goals & alerts — a per-client list shared by both.
  categories: (entityId) => fetch(`/api/my/categories/${entityId}`).then(json),
  addCategory: (entityId, name) => fetch(`/api/my/categories/${entityId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).then(json),
  deleteCategory: (entityId, name) => fetch(`/api/my/categories/${entityId}/${encodeURIComponent(name)}`, { method: 'DELETE' }).then(json),

  // Backup / restore + ops alerting
  opsStatus: () => fetch('/api/admin/ops').then(json),
  opsTestAlert: () => fetch('/api/admin/ops/test', { method: 'POST' }).then(json),
  backupStatus: () => fetch('/api/admin/backups').then(json),
  runBackupNow: () => fetch('/api/admin/backups/run', { method: 'POST' }).then(json),
  exportData: () => fetch('/api/admin/export').then((r) => r.json()),
  importData: (data) => fetch('/api/admin/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(json),

  // Settlements
  mySettlements: () => cachedGet('/api/my/settlements'),
  getSettlement: (id) => fetch(`/api/settlements/${id}`).then(json),
  saveSettlementNotes: (id, notes) => fetch(`/api/settlements/${id}/notes`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes }) }).then(json),
  adminListSettlements: () => fetch('/api/admin/settlements').then(json),
  // Streams ndjson progress events; resolves with the extracted data.
  adminExtractSettlement: (fileBase64, fileType, onProgress) =>
    extractStream('/api/admin/settlements/extract', { fileBase64, fileType }, onProgress),
  adminExtractInvoice: (fileBase64, onProgress) =>
    extractStream('/api/admin/documents/extract', { fileBase64 }, onProgress),
  adminCreateSettlement: (s) => fetch('/api/admin/settlements', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) }).then(json),
  adminUpdateSettlement: (id, p) => fetch(`/api/admin/settlements/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),
  adminDeleteSettlement: (id) => fetch(`/api/admin/settlements/${id}`, { method: 'DELETE' }),
  adminLoadSettlementExample: () => fetch('/api/admin/settlements/example', { method: 'POST' }).then(json),

  // Event documents (invoices etc.)
  myDocuments: () => fetch('/api/my/documents').then(json),
  getDocument: (id) => fetch(`/api/documents/${id}`).then(json),
  adminListDocuments: (entityId) => fetch(`/api/admin/documents${entityId ? `?entityId=${encodeURIComponent(entityId)}` : ''}`).then(json),
  adminCreateDocument: (d) => fetch('/api/admin/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) }).then(json),
  adminUpdateDocument: (id, p) => fetch(`/api/admin/documents/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),
  adminDeleteDocument: (id) => fetch(`/api/admin/documents/${id}`, { method: 'DELETE' }),

  // Personalised home
  track: (suiteId, dashboardId) =>
    fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ suiteId, dashboardId }) }).catch(() => {}),
  mySnapshot: (entityId, refresh) =>
    fetch(`/api/my/snapshot?${new URLSearchParams({ ...(entityId ? { entityId } : {}), ...(refresh ? { refresh: 1 } : {}) })}`).then(json),
  myBriefing: (entityId, refresh) =>
    fetch(`/api/my/briefing?${new URLSearchParams({ hour: new Date().getHours(), ...(entityId ? { entityId } : {}), ...(refresh ? { refresh: 1 } : {}) })}`).then(json),
  myBriefingEvents: (entityId, refresh, debug) =>
    fetch(`/api/my/briefing/events?${new URLSearchParams({ hour: new Date().getHours(), ...(entityId ? { entityId } : {}), ...(refresh ? { refresh: 1 } : {}), ...(debug ? { debug: 1 } : {}) })}`).then(json),
  setBriefingSuites: (entityId, suites) =>
    fetch('/api/my/briefing/suites', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entityId, suites }) }).then(json),
  prewarm: (entityId, hour) => fetch('/api/my/prewarm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entityId, hour }) }).then(json).catch(() => {}),
  myPins: (entityId) => fetch(`/api/my/pins${entityId ? `?entityId=${encodeURIComponent(entityId)}` : ''}`).then(json),
  savePinOrder: (entityId, order) => fetch('/api/my/pin-order', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entityId, order }) }).then(json),
  togglePin: (body) => fetch('/api/my/pins', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),

  // Share links
  createShareLink: (body) => fetch('/api/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),

  // Client self-service team management (team.manage)
  myTeam: (entityId) => fetch(`/api/my/team/${entityId}`).then(json),
  myTeamAdd: (entityId, body) => fetch(`/api/my/team/${entityId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  myTeamSetRole: (entityId, userId, role) => fetch(`/api/my/team/${entityId}/${userId}/role`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) }).then(json),
  myTeamRemove: (entityId, userId) => fetch(`/api/my/team/${entityId}/${userId}`, { method: 'DELETE' }).then((r) => { if (!r.ok) return r.json().then((e) => Promise.reject(new Error(e.error || 'Failed'))); return {}; }),

  // Notification channel preferences (per user)
  getNotifPrefs: () => fetch('/api/my/notification-prefs').then(json),
  setNotifPrefs: (prefs) => fetch('/api/my/notification-prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(prefs) }).then(json),

  // Web Push (installable-app notifications)
  getPushKey: () => fetch('/api/push/key').then(json),
  pushSubscribe: (subscription) => fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription }) }).then(json),
  pushUnsubscribe: (endpoint) => fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint }) }).then(json),
  pushTest: () => fetch('/api/push/test', { method: 'POST' }).then(json),

  // Experience OS — comms spine (isolated /api/os)
  osStatus: () => fetch('/api/os/status').then(json),
  osInbox: (entityId) => fetch(`/api/os/inbox${entityId ? `?entityId=${encodeURIComponent(entityId)}` : ''}`).then(json),
  osPending: () => fetch('/api/os/pending').then(json),
  osThread: (id) => fetch(`/api/os/threads/${id}`).then(json),
  osThreadUnread: (id) => fetch(`/api/os/threads/${id}/unread`, { method: 'POST' }).then(json),
  osThreadDelete: (id) => fetch(`/api/os/threads/${id}`, { method: 'DELETE' }).then(json),
  osReply: (id, body, attachments = []) => fetch(`/api/os/threads/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body, attachments }) }).then(json),
  osAck: (id) => fetch(`/api/os/threads/${id}/ack`, { method: 'POST' }).then(json),
  osAnnounce: (body) => fetch('/api/os/admin/announce', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  osReceipts: (id) => fetch(`/api/os/admin/threads/${id}/receipts`).then(json),

  // Briefing configuration
  getBriefingSettings: () => fetch('/api/admin/briefing-settings').then(json),
  saveBriefingSettings: (p) => fetch('/api/admin/briefing-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),
  myBriefingConfig: (entityId) => fetch(`/api/my/briefing-config${entityId ? `?entityId=${encodeURIComponent(entityId)}` : ''}`).then(json),
  saveSuiteBriefing: (suiteId, cfg, entityId) =>
    fetch(`/api/my/briefing-config/suite/${suiteId}${entityId ? `?entityId=${encodeURIComponent(entityId)}` : ''}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) }).then(json),
  sendBriefingFeedback: (body, entityId) =>
    fetch(`/api/my/briefing-feedback${entityId ? `?entityId=${encodeURIComponent(entityId)}` : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  adminListBriefingFeedback: () => fetch('/api/admin/briefing-feedback').then(json),
  adminResolveBriefingFeedback: (id, status) => fetch(`/api/admin/briefing-feedback/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }).then(json),
  refineText: (body) => fetch('/api/my/refine-text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  saveBriefingTune: (tune, tiles, entityId, categories) =>
    fetch(`/api/my/briefing-tune${entityId ? `?entityId=${encodeURIComponent(entityId)}` : ''}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tune, tiles, ...(categories ? { categories } : {}) }) }).then(json),

  // Goals (the Results pillar) — one guarded route set serves admin + client.
  // Goals are per event (suite); the list returns each goal with resolved progress.
  // `bg` marks a passive/background fetch (home widget, admin overview) so the
  // audit log doesn't record it as a deliberate "Viewed goals" action.
  suiteGoals: (suiteId, bg = false) => fetch(`/api/goals/suites/${suiteId}${bg ? '?bg=1' : ''}`).then(json),
  createGoal: (suiteId, b) => fetch(`/api/goals/suites/${suiteId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  updateGoal: (id, b) => fetch(`/api/goals/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  deleteGoal: (id) => fetch(`/api/goals/${id}`, { method: 'DELETE' }).then((r) => r.ok),
  goalSnapshot: (id, value) => fetch(`/api/goals/${id}/snapshot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }) }).then(json),
  goalTileValue: (suiteId, dashboardId, tileId) => fetch(`/api/goals/suites/${suiteId}/tile-value`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dashboardId, tileId }) }).then(json),
  goalTileSeries: (suiteId, dashboardId, tileId) => fetch(`/api/goals/suites/${suiteId}/tile-series`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dashboardId, tileId }) }).then(json),
  goalCheckpointSuggestions: (suiteId, body) => fetch(`/api/goals/suites/${suiteId}/checkpoint-suggestions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  goalGapPlan: (goalId) => fetch(`/api/goals/${goalId}/gap-plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(json),
  goalForecastChart: (suiteId, goalId) => fetch(`/api/goals/suites/${suiteId}/forecast-chart?goalId=${encodeURIComponent(goalId)}`).then(json),
  goalNudgeTest: (entityId) => fetch('/api/admin/goals/nudge-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entityId }) }).then(json),
  goalTemplates: (entityId) => fetch(`/api/goals/templates/${entityId}`).then(json),
  saveGoalTemplate: (body) => fetch('/api/goals/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  deleteGoalTemplate: (id) => fetch(`/api/goals/templates/${id}`, { method: 'DELETE' }).then(json),

  // Alerts — metric watchers, per event (suite). One guarded set serves admin +
  // client self-service (the server decides who may write).
  suiteAlerts: (suiteId) => fetch(`/api/alerts/suites/${suiteId}`).then(json),
  createAlert: (suiteId, b) => fetch(`/api/alerts/suites/${suiteId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  updateAlert: (id, b) => fetch(`/api/alerts/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  deleteAlert: (id) => fetch(`/api/alerts/${id}`, { method: 'DELETE' }).then((r) => r.ok),
  setAlertStatus: (id, status) => fetch(`/api/alerts/${id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }).then(json),
  alertEvents: (id) => fetch(`/api/alerts/${id}/events`).then(json),
  // Live "pulse" feed: alert fires + tile momentum, merged for the header strip.
  entityPulse: (entityId, limit = 8) => fetch(`/api/pulse/entities/${entityId}?limit=${limit}`).then(json),
  testAlert: (id) => fetch(`/api/alerts/${id}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(json),
  alertTileValue: (suiteId, dashboardId, tileId) => fetch(`/api/alerts/suites/${suiteId}/tile-value`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dashboardId, tileId }) }).then(json),
  // Custom-metric source: alert on a raw measure + dimension filter (no tile needed).
  alertMetricCatalog: (suiteId) => fetch(`/api/alerts/suites/${suiteId}/metric-catalog`).then(json),
  alertMetricValue: (suiteId, body) => fetch(`/api/alerts/suites/${suiteId}/metric-value`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  alertMetricFilterValues: (suiteId, body) => fetch(`/api/alerts/suites/${suiteId}/metric-filter-values`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  // Reusable alert templates (a client's own + Howler's global ones).
  alertTemplates: (entityId) => fetch(`/api/alerts/templates/${entityId}`).then(json),
  saveAlertTemplate: (body) => fetch('/api/alerts/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  deleteAlertTemplate: (id) => fetch(`/api/alerts/templates/${id}`, { method: 'DELETE' }).then(json),
  // Live updates (Live Pulse) — recurring event-day multi-metric snapshots; the
  // "Live updates" tab of the Alerts page. Same suite-keyed guarded set as alerts.
  suiteLivePulses: (suiteId) => fetch(`/api/livepulse/suites/${suiteId}`).then(json),
  createLivePulse: (suiteId, b) => fetch(`/api/livepulse/suites/${suiteId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  updateLivePulse: (id, b) => fetch(`/api/livepulse/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  deleteLivePulse: (id) => fetch(`/api/livepulse/${id}`, { method: 'DELETE' }).then((r) => r.ok),
  setLivePulseStatus: (id, status) => fetch(`/api/livepulse/${id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }).then(json),
  setLivePulseLive: (id, live) => fetch(`/api/livepulse/${id}/live`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ live }) }).then(json),
  testLivePulse: (id) => fetch(`/api/livepulse/${id}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(json),
  // Live preview of a draft's numbers (no send/save) + send-to-me preview.
  previewLivePulse: (suiteId, b) => fetch(`/api/livepulse/suites/${suiteId}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  sendLivePulsePreview: (suiteId, b) => fetch(`/api/livepulse/suites/${suiteId}/preview-send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  livePulseRuns: (id) => fetch(`/api/livepulse/${id}/runs`).then(json),

  // Status notices — human-authored platform incidents. Admin authors + updates +
  // resolves; clients read the banner/feed via myNotices (scoped server-side).
  adminListNotices: () => fetch('/api/admin/notices').then(json),
  adminCreateNotice: (b) => fetch('/api/admin/notices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  adminUpdateNotice: (id, b) => fetch(`/api/admin/notices/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  adminPostNoticeUpdate: (id, b) => fetch(`/api/admin/notices/${id}/updates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  adminResolveNotice: (id, b) => fetch(`/api/admin/notices/${id}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(json),
  adminDeleteNotice: (id) => fetch(`/api/admin/notices/${id}`, { method: 'DELETE' }).then((r) => r.ok),
  myNotices: () => fetch('/api/my/notices').then(json),

  // Event Ops — live device + station logistics per event (suite). Pilot, per-client
  // opt-in. One guarded route set serves admin + client self-service (server decides who
  // may write). bustCache('/api/eventops') after mutations so the next read is fresh.
  // ── Map Studio (self-service event maps → server/mapstudio.js) ──
  mapstudioEnabled: () => fetch('/api/mapstudio/enabled').then(json), // which of my entities can use it
  mapstudioSuites: (entityId) => fetch(`/api/mapstudio/entities/${entityId}/suites`).then(json),
  mapstudioGet: (suiteId) => fetch(`/api/mapstudio/suites/${suiteId}`).then(json),
  mapstudioSaveConfig: (suiteId, b) => fetch(`/api/mapstudio/suites/${suiteId}/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  mapstudioCreatePlace: (suiteId, b) => fetch(`/api/mapstudio/suites/${suiteId}/places`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  mapstudioUpdatePlace: (suiteId, id, b) => fetch(`/api/mapstudio/suites/${suiteId}/places/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  mapstudioDeletePlace: (suiteId, id) => fetch(`/api/mapstudio/suites/${suiteId}/places/${id}`, { method: 'DELETE' }).then(json),
  mapstudioImportStations: (suiteId) => fetch(`/api/mapstudio/suites/${suiteId}/import-stations`, { method: 'POST' }).then(json),
  mapstudioPublish: (suiteId) => fetch(`/api/mapstudio/suites/${suiteId}/publish`, { method: 'POST' }).then(json),
  mapstudioUnpublish: (suiteId) => fetch(`/api/mapstudio/suites/${suiteId}/unpublish`, { method: 'POST' }).then(json),
  mapstudioAnalytics: (suiteId) => fetch(`/api/mapstudio/suites/${suiteId}/analytics`).then(json),
  mapstudioSetToken: (token) => fetch('/api/mapstudio/token', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }).then(json),

  // ── Event Media (per-event app assets → server/eventAssets.js) ──
  eventAssetsEnabled: () => fetch('/api/eventassets/enabled').then(json), // which of my entities can use it
  eventAssetsSuites: (entityId) => fetch(`/api/eventassets/entities/${entityId}/suites`).then(json),
  eventAssetsGet: (suiteId) => fetch(`/api/eventassets/suites/${suiteId}`).then(json),
  eventAssetsUpload: (suiteId, b) => fetch(`/api/eventassets/suites/${suiteId}/media`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  eventAssetsSetSlot: (suiteId, slot, b) => fetch(`/api/eventassets/suites/${suiteId}/slots/${slot}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  eventAssetsPublish: (suiteId) => fetch(`/api/eventassets/suites/${suiteId}/publish`, { method: 'POST' }).then(json),
  eventAssetsUnpublish: (suiteId) => fetch(`/api/eventassets/suites/${suiteId}/unpublish`, { method: 'POST' }).then(json),

  eventopsEnabled: () => fetch('/api/eventops/enabled').then(json), // which of my entities have it on
  eventopsSetEnabled: (entityId, enabled) => fetch(`/api/eventops/entities/${entityId}/enabled`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) }).then(json),
  eventopsGetEnabled: (entityId) => fetch(`/api/eventops/entities/${entityId}/enabled`).then(json),
  eventopsSuites: (entityId) => fetch(`/api/eventops/entities/${entityId}/suites`).then(json), // the event picker
  eventopsOverview: (suiteId) => fetch(`/api/eventops/suites/${suiteId}/overview`).then(json),
  eventopsDevices: (suiteId) => fetch(`/api/eventops/suites/${suiteId}/devices`).then(json),
  eventopsDevice: (suiteId, id) => fetch(`/api/eventops/suites/${suiteId}/devices/${id}`).then(json),
  eventopsCreateDevice: (suiteId, b) => fetch(`/api/eventops/suites/${suiteId}/devices`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  eventopsBulkDevices: (suiteId, b) => fetch(`/api/eventops/suites/${suiteId}/devices/bulk`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  eventopsUpdateDevice: (suiteId, id, b) => fetch(`/api/eventops/suites/${suiteId}/devices/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  eventopsDeleteDevice: (suiteId, id) => fetch(`/api/eventops/suites/${suiteId}/devices/${id}`, { method: 'DELETE' }).then((r) => r.ok),
  eventopsDeviceTypes: (suiteId) => fetch(`/api/eventops/suites/${suiteId}/device-types`).then(json),
  eventopsCreateDeviceType: (suiteId, label) => fetch(`/api/eventops/suites/${suiteId}/device-types`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) }).then(json),
  eventopsUpdateDeviceType: (suiteId, id, label) => fetch(`/api/eventops/suites/${suiteId}/device-types/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) }).then(json),
  eventopsDeleteDeviceType: (suiteId, id) => fetch(`/api/eventops/suites/${suiteId}/device-types/${id}`, { method: 'DELETE' }).then(json),
  eventopsIssueCategories: (suiteId) => fetch(`/api/eventops/suites/${suiteId}/issue-categories`).then(json),
  eventopsCreateIssueCategory: (suiteId, b) => fetch(`/api/eventops/suites/${suiteId}/issue-categories`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  eventopsUpdateIssueCategory: (suiteId, id, b) => fetch(`/api/eventops/suites/${suiteId}/issue-categories/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  eventopsDeleteIssueCategory: (suiteId, id) => fetch(`/api/eventops/suites/${suiteId}/issue-categories/${id}`, { method: 'DELETE' }).then(json),
  eventopsStations: (suiteId) => fetch(`/api/eventops/suites/${suiteId}/stations`).then(json),
  eventopsCreateStation: (suiteId, b) => fetch(`/api/eventops/suites/${suiteId}/stations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  eventopsUpdateStation: (suiteId, id, b) => fetch(`/api/eventops/suites/${suiteId}/stations/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  eventopsDeleteStation: (suiteId, id) => fetch(`/api/eventops/suites/${suiteId}/stations/${id}`, { method: 'DELETE' }).then((r) => r.ok),
  eventopsScan: (suiteId, code) => fetch(`/api/eventops/suites/${suiteId}/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }).then(json),
  eventopsMove: (suiteId, b) => fetch(`/api/eventops/suites/${suiteId}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  eventopsIssues: (suiteId, status = 'open') => fetch(`/api/eventops/suites/${suiteId}/issues?status=${status}`).then(json),
  eventopsLogIssue: (suiteId, b) => fetch(`/api/eventops/suites/${suiteId}/issues`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  eventopsResolveIssue: (suiteId, id, b) => fetch(`/api/eventops/suites/${suiteId}/issues/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(json),
  // Staff portal kiosk token (admin/manager) + the PUBLIC portal endpoints (no login).
  eventopsKiosk: (suiteId) => fetch(`/api/eventops/suites/${suiteId}/kiosk`).then(json),
  eventopsRotateKiosk: (suiteId) => fetch(`/api/eventops/suites/${suiteId}/kiosk/rotate`, { method: 'POST' }).then(json),
  eventopsSetKiosk: (suiteId, enabled) => fetch(`/api/eventops/suites/${suiteId}/kiosk`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) }).then(json),
  eventopsSetKioskSlug: (suiteId, slug) => fetch(`/api/eventops/suites/${suiteId}/kiosk`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug }) }).then(json),
  eopPortalInfo: (suiteId, token) => fetch(`/api/eventops/portal/${suiteId}/${token}`).then(json),
  eopPortalLogin: (suiteId, token, number) => fetch(`/api/eventops/portal/${suiteId}/${token}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number }) }).then(json),
  eopPortalMe: (suiteId, token, staffId) => fetch(`/api/eventops/portal/${suiteId}/${token}/me/${staffId}`).then(json),
  eopPortalScan: (suiteId, token, code) => fetch(`/api/eventops/portal/${suiteId}/${token}/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }).then(json),
  eopPortalMove: (suiteId, token, b) => fetch(`/api/eventops/portal/${suiteId}/${token}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  eopPortalIssue: (suiteId, token, b) => fetch(`/api/eventops/portal/${suiteId}/${token}/issue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  eopPortalCheckpoint: (suiteId, token, b) => fetch(`/api/eventops/portal/${suiteId}/${token}/checkpoint`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  eopPortalIssues: (suiteId, token, status = 'open') => fetch(`/api/eventops/portal/${suiteId}/${token}/issues?status=${status}`).then(json),
  // PUBLIC device support call — the device's PRE-BOUND link (station + device baked in).
  eopCallInfo: (suiteId, token, deviceId) => fetch(`/api/eventops/portal/${suiteId}/${token}/call/${deviceId}`).then(json),
  eopCallRaise: (suiteId, token, deviceId, b) => fetch(`/api/eventops/portal/${suiteId}/${token}/call/${deviceId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  // Console (authed): dispatch's live call queue.
  eventopsCalls: (suiteId, status = 'open') => fetch(`/api/eventops/suites/${suiteId}/calls?status=${status}`).then(json),
  eventopsAckCall: (suiteId, id, b) => fetch(`/api/eventops/suites/${suiteId}/calls/${id}/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(json),
  eventopsResolveCall: (suiteId, id, b) => fetch(`/api/eventops/suites/${suiteId}/calls/${id}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(json),
  eopPortalResolveIssue: (suiteId, token, id, b) => fetch(`/api/eventops/portal/${suiteId}/${token}/issues/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  eventopsActivity: (suiteId, { limit = 200, from = '', to = '' } = {}) => fetch(`/api/eventops/suites/${suiteId}/activity?limit=${limit}${from ? `&from=${encodeURIComponent(from)}` : ''}${to ? `&to=${encodeURIComponent(to)}` : ''}`).then(json),
  eventopsCheckpoints: (suiteId) => fetch(`/api/eventops/suites/${suiteId}/checkpoints`).then(json),
  eventopsCreateCheckpoint: (suiteId, name) => fetch(`/api/eventops/suites/${suiteId}/checkpoints`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).then(json),
  eventopsUpdateCheckpoint: (suiteId, id, name) => fetch(`/api/eventops/suites/${suiteId}/checkpoints/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).then(json),
  eventopsDeleteCheckpoint: (suiteId, id) => fetch(`/api/eventops/suites/${suiteId}/checkpoints/${id}`, { method: 'DELETE' }).then((r) => r.ok),
  eventopsCheckpointLogs: (suiteId, stationId) => fetch(`/api/eventops/suites/${suiteId}/checkpoint-logs${stationId ? `?stationId=${stationId}` : ''}`).then(json),
  eventopsStaff: (suiteId) => fetch(`/api/eventops/suites/${suiteId}/staff`).then(json),
  eventopsCreateStaff: (suiteId, b) => fetch(`/api/eventops/suites/${suiteId}/staff`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  eventopsUpdateStaff: (suiteId, id, b) => fetch(`/api/eventops/suites/${suiteId}/staff/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  eventopsDeleteStaff: (suiteId, id) => fetch(`/api/eventops/suites/${suiteId}/staff/${id}`, { method: 'DELETE' }).then((r) => r.ok),

  // Data health (Admin) — the BigQuery → Looker stream monitor.
  dataHealth: () => fetch('/api/admin/data-health').then(json),
  createDataMonitor: (b) => fetch('/api/admin/data-health/monitors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  updateDataMonitor: (id, b) => fetch(`/api/admin/data-health/monitors/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  deleteDataMonitor: (id) => fetch(`/api/admin/data-health/monitors/${id}`, { method: 'DELETE' }).then((r) => r.ok),
  setDataMonitorStatus: (id, status) => fetch(`/api/admin/data-health/monitors/${id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }).then(json),
  checkDataMonitor: (id) => fetch(`/api/admin/data-health/monitors/${id}/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(json),
  dataMonitorHistory: (id) => fetch(`/api/admin/data-health/monitors/${id}/history`).then(json),
  forgetDataStream: (id, station) => fetch(`/api/admin/data-health/monitors/${id}/streams/${encodeURIComponent(station)}`, { method: 'DELETE' }).then(json),
  dataHealthExplores: () => fetch('/api/admin/data-health/explores').then(json),
  dataHealthFields: (model, view) => fetch(`/api/admin/data-health/fields?model=${encodeURIComponent(model)}&view=${encodeURIComponent(view)}`).then(json),
};
