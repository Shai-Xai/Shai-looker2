// Thin fetch wrappers around the backend API.

async function json(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
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
  // Looker folder import (files all its dashboards under a folder)
  lookerFolder: (id) => fetch(`/api/looker/folder/${encodeURIComponent(id)}`).then(json),
  importFolder: (folderId, folder) =>
    fetch('/api/dashboards/import-folder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId, folder }),
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
};
