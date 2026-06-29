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
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
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
  owlChat: async ({ suiteId, entityId, dashboardId, message, threadId }, onText) => {
    const res = await fetch('/api/owl/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ suiteId, entityId, dashboardId, message, threadId }) });
    if (!res.ok) return json(res); // pre-stream rejection (no scope / no API key) → throws
    const tid = res.headers.get('X-Owl-Thread') || threadId || null;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    // The answer text streams first, then two trailing records: the model's
    // "<<<FOLLOWUPS>>>[...]" (suggested next questions) and the server's
    // "<<<OWL_SOURCES>>>{...}" (citation chips). Emit only the text before the first
    // marker (holding back a possible partial-marker tail), then parse both records.
    const FU = '<<<FOLLOWUPS>>>', SRC = '<<<OWL_SOURCES>>>';
    const HOLD = Math.max(FU.length, SRC.length);
    const firstMarker = () => { const a = buf.indexOf(FU), b = buf.indexOf(SRC); const xs = [a, b].filter((i) => i >= 0); return xs.length ? Math.min(...xs) : -1; };
    let buf = '', emitted = 0, sources = [], followups = [];
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      if (value) buf += dec.decode(value, { stream: true });
      const mi = firstMarker();
      if (mi >= 0) { if (mi > emitted) { onText?.(buf.slice(emitted, mi)); emitted = mi; } }
      else { const safe = buf.length - HOLD; if (safe > emitted) { onText?.(buf.slice(emitted, safe)); emitted = safe; } }
    }
    const mi = firstMarker();
    if (mi < 0 && buf.length > emitted) onText?.(buf.slice(emitted));
    const fa = buf.indexOf(FU);
    if (fa >= 0) { const after = buf.slice(fa + FU.length); const end = after.indexOf(SRC); const blob = (end >= 0 ? after.slice(0, end) : after); const m = blob.match(/\[[\s\S]*\]/); if (m) { try { followups = JSON.parse(m[0]); } catch { followups = []; } } }
    const sa = buf.indexOf(SRC);
    if (sa >= 0) { try { sources = JSON.parse(buf.slice(sa + SRC.length)); } catch { sources = []; } }
    return { threadId: tid, sources, followups };
  },
  owlThreads: () => fetch('/api/owl/threads').then(json),
  owlPinTargets: (entityId) => fetch(`/api/owl/pin-targets?entityId=${encodeURIComponent(entityId || '')}`).then(json),
  owlPin: (body) => fetch('/api/owl/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  owlThreadMessages: (id) => fetch(`/api/owl/threads/${id}/messages`).then(json),
  owlRenameThread: (id, title) => fetch(`/api/owl/threads/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) }).then(json),
  owlSetThreadFolder: (id, folder) => fetch(`/api/owl/threads/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }) }).then(json),
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

  // Admin — Entities (clients), Sets (reusable collections), Suites (event ctx)
  adminListInventiveWorkspaces: () => fetch('/api/admin/inventive-workspaces').then(json),
  adminCreateInventiveWorkspace: (w) => fetch('/api/admin/inventive-workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(w) }).then(json),
  adminUpdateInventiveWorkspace: (id, w) => fetch(`/api/admin/inventive-workspaces/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(w) }).then(json),
  adminDeleteInventiveWorkspace: (id) => fetch(`/api/admin/inventive-workspaces/${id}`, { method: 'DELETE' }),
  adminListEntities: () => fetch('/api/admin/entities').then(json),
  adminCreateEntity: (e) => fetch('/api/admin/entities', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(e) }).then(json),
  adminUpdateEntity: (id, e) => fetch(`/api/admin/entities/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(e) }).then(json),
  adminDeleteEntity: (id) => fetch(`/api/admin/entities/${id}`, { method: 'DELETE' }),
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
  // Admin — Product: daily release notes
  adminListReleaseNotes: () => fetch('/api/admin/release-notes').then(json),
  adminCreateReleaseNote: (n) => fetch('/api/admin/release-notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(n) }).then(json),
  adminUpdateReleaseNote: (id, n) => fetch(`/api/admin/release-notes/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(n) }).then(json),
  adminDeleteReleaseNote: (id) => fetch(`/api/admin/release-notes/${id}`, { method: 'DELETE' }),
  adminGenerateReleaseNotes: (days) => fetch('/api/admin/release-notes/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days }) }).then(json),
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

  // Onboarding checklist
  getMyOnboarding: (entityId) => fetch(`/api/my/onboarding/${entityId}`).then(json),
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
  getFolderSettings: () => fetch('/api/dashboards/folder-settings').then(json),
  setFolderKeepImported: (folder, on) => fetch('/api/dashboards/folder/keep-imported', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder, on }) }).then(json),
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

  // Drill-down: run a Looker drill link
  drill: (url, suiteId) =>
    fetch('/api/drill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, suiteId }),
    }).then(json),

  // Query execution (scoped to the current suite, if any)
  runQuery: (query, filterOverrides, signal, suiteId, refresh = false) =>
    fetch('/api/run-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, filterOverrides, suiteId, refresh }),
      signal,
    }).then(json),

  // Dashboard folders (organisational)
  adminFolders: () => fetch('/api/admin/folders').then(json),
  backfillFolders: () => fetch('/api/admin/backfill-folders', { method: 'POST' }).then(json),
  renameFolder: (from, to) => fetch('/api/admin/folders/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to }) }).then(json),
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

  // Email templates / branding (platform default + per-client overrides)
  getMailTemplate: () => fetch('/api/admin/mail-template').then(json),
  saveMailTemplate: (p) => fetch('/api/admin/mail-template', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),
  getEntityMailTemplate: (id) => fetch(`/api/admin/entities/${id}/mail-template`).then(json),
  saveEntityMailTemplate: (id, p) => fetch(`/api/admin/entities/${id}/mail-template`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),
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
  actionPreviewEmail: (entityId, b) => fetch(`/api/actions/${entityId}/preview-email`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  actionTestSend: (entityId, b) => fetch(`/api/actions/${entityId}/test-send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  listCampaignEvents: (entityId) => fetch(`/api/actions/${entityId}/events`).then(json),
  actionReport: (entityId, id) => fetch(`/api/actions/${entityId}/${id}/report`).then(json),
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

  // Backup / restore
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
  suiteGoals: (suiteId) => fetch(`/api/goals/suites/${suiteId}`).then(json),
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

  // Status notices — human-authored platform incidents. Admin authors + updates +
  // resolves; clients read the banner/feed via myNotices (scoped server-side).
  adminListNotices: () => fetch('/api/admin/notices').then(json),
  adminCreateNotice: (b) => fetch('/api/admin/notices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  adminUpdateNotice: (id, b) => fetch(`/api/admin/notices/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  adminPostNoticeUpdate: (id, b) => fetch(`/api/admin/notices/${id}/updates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  adminResolveNotice: (id, b) => fetch(`/api/admin/notices/${id}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(json),
  adminDeleteNotice: (id) => fetch(`/api/admin/notices/${id}`, { method: 'DELETE' }).then((r) => r.ok),
  myNotices: () => fetch('/api/my/notices').then(json),
};
