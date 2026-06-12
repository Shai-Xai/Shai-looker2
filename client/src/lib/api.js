// Thin fetch wrappers around the backend API.

async function json(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

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
  login: (email, password) =>
    fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).then(json),
  logout: () => fetch('/api/auth/logout', { method: 'POST' }).then(json),

  // Admin — Entities (clients), Sets (reusable collections), Suites (event ctx)
  adminListEntities: () => fetch('/api/admin/entities').then(json),
  adminCreateEntity: (e) => fetch('/api/admin/entities', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(e) }).then(json),
  adminUpdateEntity: (id, e) => fetch(`/api/admin/entities/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(e) }).then(json),
  adminDeleteEntity: (id) => fetch(`/api/admin/entities/${id}`, { method: 'DELETE' }),
  adminListSets: () => fetch('/api/admin/sets').then(json),
  adminCreateSet: (s) => fetch('/api/admin/sets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) }).then(json),
  adminUpdateSet: (id, s) => fetch(`/api/admin/sets/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) }).then(json),
  adminDeleteSet: (id) => fetch(`/api/admin/sets/${id}`, { method: 'DELETE' }),
  adminListSuites: () => fetch('/api/admin/suites').then(json),
  adminCreateSuite: (s) => fetch('/api/admin/suites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) }).then(json),
  adminUpdateSuite: (id, s) => fetch(`/api/admin/suites/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) }).then(json),
  adminDeleteSuite: (id) => fetch(`/api/admin/suites/${id}`, { method: 'DELETE' }),
  adminFilterFields: () => fetch('/api/admin/filter-fields').then(json),
  filterSuggest: (body) => fetch('/api/filter-suggest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),

  // Users (admin)
  adminListUsers: () => fetch('/api/admin/users').then(json),
  adminCreateUser: (u) => fetch('/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(u) }).then(json),
  adminUpdateUser: (id, u) => fetch(`/api/admin/users/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(u) }).then(json),
  adminDeleteUser: (id) => fetch(`/api/admin/users/${id}`, { method: 'DELETE' }),

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
  importDashboard: (lookerDashboardId, title, folder) =>
    fetch('/api/dashboards/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lookerDashboardId, title, folder }),
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
  runQuery: (query, filterOverrides, signal, suiteId) =>
    fetch('/api/run-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, filterOverrides, suiteId }),
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
  mySuites: () => fetch('/api/my/suites').then(json),
  mySuite: (id) => fetch(`/api/my/suites/${id}`).then(json),

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

  // Integrations
  getAdminIntegrations: () => fetch('/api/admin/integrations').then(json),
  saveAdminIntegrations: (p) => fetch('/api/admin/integrations', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),
  sendMailTest: (entityId) => fetch('/api/admin/mail/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entityId }) }).then(json),
  getEntityIntegrations: (id) => fetch(`/api/admin/entities/${id}/integrations`).then(json),
  saveEntityIntegrations: (id, p) => fetch(`/api/admin/entities/${id}/integrations`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),
  getMyIntegrations: () => fetch('/api/my/integrations').then(json),
  saveMyIntegrations: (entityId, p) => fetch(`/api/my/integrations/${entityId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),

  // Email templates / branding (platform default + per-client overrides)
  getMailTemplate: () => fetch('/api/admin/mail-template').then(json),
  saveMailTemplate: (p) => fetch('/api/admin/mail-template', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),
  getEntityMailTemplate: (id) => fetch(`/api/admin/entities/${id}/mail-template`).then(json),
  saveEntityMailTemplate: (id, p) => fetch(`/api/admin/entities/${id}/mail-template`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),
  getMyMailTemplate: (entityId) => fetch(`/api/my/mail-template/${entityId}`).then(json),
  saveMyMailTemplate: (entityId, p) => fetch(`/api/my/mail-template/${entityId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),
  previewMail: (edits, entityId) => fetch('/api/mail/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ edits, entityId }) }).then(json),

  // CC-the-Owl: inbound email addresses + config
  getInboundConfig: () => fetch('/api/os/admin/inbound').then(json),
  saveInboundConfig: (p) => fetch('/api/os/admin/inbound', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(json),
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
  getMyDigests: (entityId) => fetch(`/api/my/digests/${entityId}`).then(json),
  createMyDigest: (entityId, b) => fetch(`/api/my/digests/${entityId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  updateMyDigest: (entityId, jobId, b) => fetch(`/api/my/digests/${entityId}/${jobId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  deleteMyDigest: (entityId, jobId) => fetch(`/api/my/digests/${entityId}/${jobId}`, { method: 'DELETE' }).then((r) => r.ok),
  testMyDigest: (entityId, jobId) => fetch(`/api/my/digests/${entityId}/${jobId}/test`, { method: 'POST' }).then(json),
  previewMyDigest: (entityId, b) => fetch(`/api/my/digests/${entityId}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  testSendMyDigest: (entityId, b) => fetch(`/api/my/digests/${entityId}/test-send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json),
  getDigestTiles: (entityId) => fetch(`/api/admin/entities/${entityId}/digest-tiles`).then(json),
  getEntityTheme: (entityId) => fetch(`/api/theme/${entityId}`).then(json),
  getMyDigestTiles: (entityId) => fetch(`/api/my/digest-tiles/${entityId}`).then(json),

  // Backup / restore
  exportData: () => fetch('/api/admin/export').then((r) => r.json()),
  importData: (data) => fetch('/api/admin/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(json),

  // Settlements
  mySettlements: () => fetch('/api/my/settlements').then(json),
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
  myPins: (entityId) => fetch(`/api/my/pins${entityId ? `?entityId=${encodeURIComponent(entityId)}` : ''}`).then(json),
  togglePin: (body) => fetch('/api/my/pins', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),

  // Share links
  createShareLink: (body) => fetch('/api/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),

  // Experience OS — comms spine (isolated /api/os)
  osStatus: () => fetch('/api/os/status').then(json),
  osInbox: (entityId) => fetch(`/api/os/inbox${entityId ? `?entityId=${encodeURIComponent(entityId)}` : ''}`).then(json),
  osPending: () => fetch('/api/os/pending').then(json),
  osThread: (id) => fetch(`/api/os/threads/${id}`).then(json),
  osReply: (id, body) => fetch(`/api/os/threads/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) }).then(json),
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
  saveBriefingTune: (tune, entityId) =>
    fetch(`/api/my/briefing-tune${entityId ? `?entityId=${encodeURIComponent(entityId)}` : ''}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tune }) }).then(json),
};
