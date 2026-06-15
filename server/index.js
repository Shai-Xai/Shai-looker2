require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');

const looker = require('./looker');
const store = require('./store');
const auth = require('./auth');
const db = require('./db');
const migrate = require('./migrate');
const { convertDashboard } = require('./convert');
const { recreateDashboard, fetchDashboard } = require('./recreate');
const { parseDrillUrl } = require('./drill');
const insights = require('./insights');
const mailer = require('./mailer');
const messaging = require('./messaging');
const rateLimit = require('./ratelimit');

const app = express();
// Behind a reverse proxy (Caddy/Nginx) in production so Secure cookies + the
// real client IP/protocol are honoured.
if (process.env.NODE_ENV === 'production' || process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
// Global JSON parser at a modest limit, EXCEPT routes that take large bodies
// (backup import, settlement PDF uploads) — those parse themselves with a
// higher limit.
const jsonParser = express.json({ limit: '5mb' });
const parsesOwnBody = (p) => p === '/api/admin/import' || p.startsWith('/api/admin/settlements') || p.startsWith('/api/admin/documents')
  // OS messenger attachment payloads (base64) need a bigger limit — os.js parses these itself.
  || /^\/api\/os\/threads\/[^/]+\/messages$/.test(p) || p === '/api/os/admin/announce';
app.use((req, res, next) => (parsesOwnBody(req.path) ? next() : jsonParser(req, res, next)));
// API responses are personal and live (suites, branding, icons…). Without an
// explicit header some browsers (Safari especially) heuristically cache GETs,
// so edits like a suite's event logo look "stuck". Cacheable assets
// (/mail-assets, built /assets) set their own headers and live outside /api.
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(cookieParser());
app.use(auth.attachUser);

// Serve built React app (client/dist) if present, else raw client/
const clientDist = path.join(__dirname, '../client/dist');
const clientFallback = path.join(__dirname, '../client');
const staticDir = fs.existsSync(clientDist) ? clientDist : clientFallback;
// Hashed build assets (/assets/*) are immutable → cache hard. index.html must
// NEVER be cached stale, or after a redeploy the browser keeps an old index
// that references deleted asset hashes → blank screen. So always revalidate it.
app.use(express.static(staticDir, {
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    else if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  },
}));

// Bring legacy JSON data into SQLite on first boot (idempotent), then ensure an
// admin exists.
migrate.run();
auth.seedAdmin();
// Outbound email (Resend) — disposable module; senders no-op when unconfigured.
mailer.init({ db });
// SMS (Clickatell One API) — second channel; no-ops when unconfigured.
messaging.init({ db });
// Web Push — installable-app notifications (disposable module, own table +
// routes under /api/push, kill switch `push_enabled`). Mounted before os so the
// comms spine can push alongside email.
const push = require('./push');
push.mount(app, { db, auth });
// Experience OS comms spine — self-contained module (own tables + routes under
// /api/os). Remove this line + server/os.js to fully uninstall the feature.
const os = require('./os').mount(app, { db, auth, mailer, push });

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ─── Auth ───────────────────────────────────────────────────────────────────
// publicUser + the user's client(s) (name + logo) for header branding.
function meUser(user) {
  const pub = auth.publicUser(user);
  if (!pub) return null;
  // Each linked client carries the user's role + resolved permissions there, so
  // the UI can personalize/gate without extra round-trips. Server still enforces.
  const entities = (pub.entityIds || []).map((id) => {
    const e = db.getEntity(id);
    if (!e) return null;
    const { role, permissions } = auth.permissionsFor(user, id);
    return { id: e.id, name: e.name, logo: e.logo || '', role, permissions };
  }).filter(Boolean);
  return { ...pub, entities };
}
// Brute-force guard: cap login attempts per IP (fixed 15-minute window). Fails
// open if the limiter errors, so it can never lock out legitimate traffic.
app.post('/api/auth/login', rateLimit({ windowMs: 15 * 60_000, max: 10, by: 'ip', scope: 'login' }), (req, res) => {
  const { email, password } = req.body || {};
  const user = auth.verifyCredentials(email, password);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  auth.issueCookie(res, user);
  res.json({ user: meUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  auth.clearCookie(res);
  res.json({ ok: true });
});

// Current user (200 with null when not logged in, so the client can decide).
app.get('/api/auth/me', (req, res) => {
  res.json({ user: meUser(req.user) });
});

// Per-user notification channel preferences (self-service).
app.get('/api/my/notification-prefs', auth.requireAuth, (req, res) => {
  const u = auth.publicUser(db.getUser(req.user.id));
  res.json({ email: u?.notifyEmail !== false, push: u?.notifyPush !== false, pushAvailable: push.isEnabled() });
});
app.put('/api/my/notification-prefs', auth.requireAuth, (req, res) => {
  const { email, push: wantPush } = req.body || {};
  const next = db.setNotificationPrefs(req.user.id, {
    ...(email != null ? { email: !!email } : {}),
    ...(wantPush != null ? { push: !!wantPush } : {}),
  });
  res.json(next || { email: true, push: true });
});

// ─── Client self-service team management (team.manage) ─────────────────────────
// A client Owner manages their own team's logins + roles, scoped to their
// entity. Mirror of the admin Logins tab. Howler-staff logins are never exposed
// or editable here; a client can only ever touch its own members.
function teamMembers(entityId) {
  return db.listUsers()
    .filter((u) => u.role !== 'admin' && (u.entityIds || []).includes(entityId))
    .map((u) => ({ id: u.id, email: u.email, role: (u.memberships || []).find((m) => m.entityId === entityId)?.role || 'owner', alsoOtherClients: (u.entityIds || []).length > 1 }));
}
const ownerCount = (entityId) => teamMembers(entityId).filter((m) => m.role === 'owner').length;

app.get('/api/my/team/:entityId', auth.requireAuth, auth.requirePermission('team.manage'), (req, res) => {
  res.json({ members: teamMembers(req.params.entityId).map((m) => ({ ...m, isYou: m.id === req.user.id })), roles: roles.catalog() });
});
app.post('/api/my/team/:entityId', auth.requireAuth, auth.requirePermission('team.manage'), (req, res) => {
  const { email, password, role } = req.body || {};
  if (!roles.ROLE_KEYS.includes(String(role || ''))) return res.status(400).json({ error: 'Unknown role' });
  try {
    const u = auth.createUser({ email, password, role: 'client', entityIds: [req.params.entityId] });
    db.setMembershipRole(u.id, req.params.entityId, role);
    res.status(201).json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/my/team/:entityId/:userId/role', auth.requireAuth, auth.requirePermission('team.manage'), (req, res) => {
  const { entityId, userId } = req.params;
  const role = String((req.body || {}).role || '');
  if (!roles.ROLE_KEYS.includes(role)) return res.status(400).json({ error: 'Unknown role' });
  const target = teamMembers(entityId).find((m) => m.id === userId);
  if (!target) return res.status(404).json({ error: 'Not a member of this client' });
  if (target.role === 'owner' && role !== 'owner' && ownerCount(entityId) <= 1) return res.status(400).json({ error: 'This is the last Owner — promote someone else first.' });
  db.setMembershipRole(userId, entityId, role);
  res.json({ ok: true, role });
});
app.delete('/api/my/team/:entityId/:userId', auth.requireAuth, auth.requirePermission('team.manage'), (req, res) => {
  const { entityId, userId } = req.params;
  const target = teamMembers(entityId).find((m) => m.id === userId);
  if (!target) return res.status(404).json({ error: 'Not a member of this client' });
  if (target.role === 'owner' && ownerCount(entityId) <= 1) return res.status(400).json({ error: 'This is the last Owner — promote someone else first.' });
  db.removeMembership(userId, entityId);
  res.status(204).end();
});

// ─── Backup / restore (full data export & import) ──────────────────────────────
app.get('/api/admin/export', auth.requireAdmin, (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="pulse-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.send(JSON.stringify(db.exportAll()));
});
// Large limit: a full export (with logo/icon data-URLs + dashboard defs) can be big.
app.post('/api/admin/import', auth.requireAdmin, express.json({ limit: '256mb' }), (req, res) => {
  const data = req.body;
  if (!data || !Array.isArray(data.dashboards) || !Array.isArray(data.entities)) {
    return res.status(400).json({ error: 'That doesn\'t look like a Pulse backup file.' });
  }
  try {
    const counts = db.importAll(data);
    res.json({ ok: true, counts });
  } catch (err) {
    console.error('[POST /api/admin/import]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: users ──────────────────────────────────────────────────────────────
app.get('/api/admin/users', auth.requireAdmin, (_req, res) => res.json(auth.loadUsers().map(auth.publicUser)));
app.post('/api/admin/users', auth.requireAdmin, (req, res) => {
  try { res.status(201).json(auth.createUser(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/admin/users/:id', auth.requireAdmin, (req, res) => {
  const u = auth.updateUser(req.params.id, req.body || {});
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json(u);
});
app.delete('/api/admin/users/:id', auth.requireAdmin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You can't delete your own account" });
  auth.deleteUser(req.params.id); res.status(204).end();
});

// Role catalog (for the role pickers).
const roles = require('./roles');
app.get('/api/admin/roles', auth.requireAdmin, (_req, res) => res.json({ roles: roles.catalog() }));
// Set a login's role WITHIN a specific client (its membership).
app.put('/api/admin/entities/:id/logins/:userId/role', auth.requireAdmin, (req, res) => {
  const { id, userId } = req.params;
  const role = String((req.body || {}).role || '');
  if (!roles.ROLE_KEYS.includes(role)) return res.status(400).json({ error: 'Unknown role' });
  if (!db.setMembershipRole(userId, id, role)) return res.status(404).json({ error: 'Membership not found' });
  res.json({ ok: true, role });
});
// Content visibility by role for a client (set/dashboard allowlists).
app.get('/api/admin/entities/:id/content-roles', auth.requireAdmin, (req, res) => {
  if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
  res.json({ content: db.contentRolesForEntity(req.params.id), roles: roles.catalog() });
});
app.put('/api/admin/entities/:id/content-roles/:scopeType/:scopeId', auth.requireAdmin, (req, res) => {
  const { id, scopeType, scopeId } = req.params;
  if (!db.getEntity(id)) return res.status(404).json({ error: 'Not found' });
  if (!['set', 'dashboard'].includes(scopeType)) return res.status(400).json({ error: 'Bad scope' });
  const list = Array.isArray((req.body || {}).roles) ? req.body.roles.filter((r) => roles.ROLE_KEYS.includes(r)) : [];
  db.setContentRoles(id, scopeType, scopeId, list);
  res.json({ ok: true, roles: list });
});

// ─── Admin: entities / sets / suites (the model) ───────────────────────────────
app.get('/api/admin/entities', auth.requireAdmin, (_req, res) => res.json(db.listEntities()));
app.post('/api/admin/entities', auth.requireAdmin, (req, res) => res.status(201).json(db.createEntity(req.body || {})));
app.put('/api/admin/entities/:id', auth.requireAdmin, (req, res) => {
  const e = db.updateEntity(req.params.id, req.body || {});
  if (!e) return res.status(404).json({ error: 'Entity not found' });
  res.json(e);
});
app.delete('/api/admin/entities/:id', auth.requireAdmin, (req, res) => { db.deleteEntity(req.params.id); res.status(204).end(); });

// Sets = reusable dashboard collections (Ticketing, Cashless, …).
app.get('/api/admin/sets', auth.requireAdmin, (_req, res) => res.json(db.listSets()));
app.post('/api/admin/sets', auth.requireAdmin, (req, res) => res.status(201).json(db.createSet(req.body || {})));
app.put('/api/admin/sets/:id', auth.requireAdmin, (req, res) => {
  const s = db.updateSet(req.params.id, req.body || {});
  if (!s) return res.status(404).json({ error: 'Set not found' });
  res.json(s);
});
app.delete('/api/admin/sets/:id', auth.requireAdmin, (req, res) => { db.deleteSet(req.params.id); res.status(204).end(); });

// ─── Custom sets: a client's bespoke collections (hidden from the shared library) ──
// A client's custom sets + the dashboard pool available to build them with
// (shared dashboards + this client's own bespoke dashboards).
app.get('/api/admin/entities/:id/sets', auth.requireAdmin, (req, res) => {
  if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
  res.json({ sets: db.listSetsForEntity(req.params.id), pool: db.dashboardPoolFor(req.params.id), templates: db.listSets() });
});
app.post('/api/admin/entities/:id/sets', auth.requireAdmin, (req, res) => {
  if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
  res.status(201).json(db.createSet({ ...(req.body || {}), ownerEntityId: req.params.id }));
});
// Clone a shared template set into a client-owned custom copy.
app.post('/api/admin/entities/:id/sets/clone', auth.requireAdmin, (req, res) => {
  if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const { setId, name } = req.body || {};
  const copy = db.cloneSetForEntity(setId, req.params.id, name);
  if (!copy) return res.status(400).json({ error: 'Template set not found' });
  res.status(201).json(copy);
});
// Import a bespoke Looker dashboard as CLIENT-OWNED, optionally adding it to one
// of the client's custom sets.
app.post('/api/admin/entities/:id/dashboards/import', auth.requireAdmin, async (req, res) => {
  const entityId = req.params.id;
  const entity = db.getEntity(entityId);
  if (!entity) return res.status(404).json({ error: 'Not found' });
  const { lookerDashboardId, title, setId } = req.body || {};
  if (!lookerDashboardId) return res.status(400).json({ error: 'lookerDashboardId is required' });
  try {
    const source = await fetchDashboard(lookerDashboardId);
    await looker.resolveElementQueries(source.elements);
    const def = convertDashboard(source);
    if (title) def.title = title;
    // Always filed under the client's own folder so it's findable in the library.
    def.folder = `Custom/${entity.name}`;
    def.ownerEntityId = entityId; // bespoke to this client
    const created = store.create(def);
    try { db.harvestDashboardTiles(created, { sourceDashboardId: created.id }); } catch (e) { console.error('[harvest]', e.message); }
    // Add to the chosen custom set (must belong to this client).
    if (setId) {
      const set = db.getSet(setId);
      if (set && set.ownerEntityId === entityId) db.setSetDashboards(setId, [...set.dashboards, { id: created.id, parentId: null }]);
    }
    res.status(201).json({ dashboard: { id: created.id, title: created.title } });
  } catch (err) {
    console.error('[POST entity dashboards/import]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Suites = a client's event context: locks + bundled Sets.
function enrichSuite(su) {
  return { ...su, entityName: db.getEntity(su.entityId)?.name || '', dashboardCount: db.dashboardsInSuite(su.id).length };
}
app.get('/api/admin/suites', auth.requireAdmin, (_req, res) => res.json(db.listSuites().map(enrichSuite)));
app.post('/api/admin/suites', auth.requireAdmin, (req, res) => res.status(201).json(enrichSuite(db.createSuite(req.body || {}))));
app.put('/api/admin/suites/:id', auth.requireAdmin, (req, res) => {
  const su = db.updateSuite(req.params.id, req.body || {});
  if (!su) return res.status(404).json({ error: 'Suite not found' });
  res.json(enrichSuite(su));
});
app.delete('/api/admin/suites/:id', auth.requireAdmin, (req, res) => { db.deleteSuite(req.params.id); res.status(204).end(); });

// Distinct filter fields across all dashboards (for the locked-filter editor).
app.get('/api/admin/filter-fields', auth.requireAdmin, (_req, res) => {
  const byField = new Map();        // field -> option
  const namesByField = new Map();   // field -> Set(distinct filter names)
  const filters = [];               // { name, field, model, explore }
  for (const d of db.listDashboards()) {
    const full = store.get(d.id);
    for (const f of full?.filters || []) {
      const field = f.field || f.dimension;
      if (!field) continue;
      const name = f.name || f.title || field;
      filters.push({ name, field, model: f.model || null, explore: f.explore || null });
      if (!byField.has(field)) byField.set(field, { field, title: f.title || field, suggestField: field, model: f.model || null, explore: f.explore || null });
      if (!namesByField.has(field)) namesByField.set(field, new Set());
      namesByField.get(field).add(name);
    }
  }
  const sharedField = (field) => (namesByField.get(field)?.size || 0) >= 2;
  // Field-based options — but NOT for fields used by several named filters
  // (those must be locked via the named filters, never the raw field, or the
  // field lock would clobber per-tile values like current/past/comparison).
  const out = [...byField.values()].filter((f) => !sharedField(f.field));
  // Id sibling for organiser/event (ids are stable; names can change).
  for (const f of [...out]) {
    const m = f.field.match(/^(core_organisers|core_events)\.name$/);
    if (!m) continue;
    const idField = `${m[1]}.id`;
    if (!out.some((x) => x.field === idField)) out.push({ field: idField, title: `${f.title} ID`, suggestField: idField, model: f.model, explore: f.explore });
  }
  // Name-based options for fields used by 2+ distinct filter names.
  const seenName = new Set();
  for (const fl of filters) {
    if (!sharedField(fl.field) || seenName.has(fl.name)) continue;
    seenName.add(fl.name);
    out.push({ field: fl.name, title: fl.name, suggestField: fl.field, model: fl.model, explore: fl.explore, byName: true });
  }
  res.json(out);
});

// ─── Client navigation: Entity → Suite → Set → Dashboards ──────────────────────
// The suites this user can open (each carries its entity name).
app.get('/api/my/suites', auth.requireAuth, (req, res) => {
  res.json(auth.suitesForUser(req.user).map((su) => {
    const ent = db.getEntity(su.entityId);
    return {
      id: su.id, name: su.name, icon: su.icon || '', entityId: su.entityId,
      entityName: ent?.name || '', entityLogo: ent?.logo || '',
      setCount: su.setIds.length, dashboardCount: db.dashboardsInSuite(su.id).length,
    };
  }));
});

// One suite: merged locks (for pre-fill + lock) + its Sets, each with its
// dashboards. This is everything the client needs to navigate the suite.
app.get('/api/my/suites/:id', auth.requireAuth, (req, res) => {
  if (!auth.canAccessSuite(req.user, req.params.id)) return res.status(403).json({ error: 'Not allowed' });
  const su = db.getSuite(req.params.id);
  if (!su) return res.status(404).json({ error: 'Suite not found' });
  // Role-based dashboard visibility for this client (admins see everything).
  const isAdmin = req.user.role === 'admin';
  const role = auth.roleForEntity(req.user, su.entityId);
  const visible = (setId, dashId) => isAdmin || db.dashboardVisibleToRole(su.entityId, setId, dashId, role);
  const sets = su.setIds.map((sid) => {
    const set = db.getSet(sid);
    if (!set) return null;
    // One-level tree: top-level dashboards carry their sub-dashboards (tabs)
    // in `children`. An orphaned parent reference renders top-level.
    const nodes = (set.dashboards || []).map(({ id, parentId }) => {
      const d = store.get(id);
      return d && visible(set.id, id) && { id: d.id, title: d.title, description: d.description || '', tileCount: (d.tiles || []).length, parentId };
    }).filter(Boolean);
    const valid = new Set(nodes.map((n) => n.id));
    const dashboards = nodes.filter((n) => !n.parentId || !valid.has(n.parentId)).map(({ parentId, ...top }) => ({
      ...top,
      children: nodes.filter((c) => c.parentId === top.id).map(({ parentId: _p, ...rest }) => rest),
    }));
    return { id: set.id, name: set.name, icon: set.icon || '', dashboards };
  }).filter((s) => s && (isAdmin || s.dashboards.length)); // drop sets fully hidden for this role
  const ent = db.getEntity(su.entityId);
  res.json({
    id: su.id, name: su.name, icon: su.icon || '',
    entityId: su.entityId, // the suite's client — authoritative scope for tile actions (e.g. create segment)
    entityName: ent?.name || '', entityLogo: ent?.logo || '',
    lockedFilters: expandLockMap(auth.lockedFiltersForSuite(su.id)), sets,
  });
});

// ── Saved dashboard filter views (dual-surface) ──────────────────────────────
// Per-user "save my view" (client self-service) + the client default an admin
// sets. Resolution on load is user view > entity default > the dashboard's own
// default_value (applied client-side in ViewPage). Locks always still win.
const cleanFilterMap = (f) => {
  const out = {};
  if (f && typeof f === 'object' && !Array.isArray(f)) {
    for (const [k, v] of Object.entries(f).slice(0, 60)) if (typeof v === 'string') out[String(k).slice(0, 200)] = v.slice(0, 2000);
  }
  return out;
};

app.get('/api/my/dashboard-filters/:dashboardId', auth.requireAuth, (req, res) => {
  const { dashboardId } = req.params;
  // The entity whose default applies: the suite's entity (if accessible), else
  // the user's own first entity.
  let entityId = null;
  const suiteId = req.query.suiteId;
  if (suiteId && auth.canAccessSuite(req.user, suiteId)) entityId = db.getSuite(suiteId)?.entityId || null;
  if (!entityId && req.user.role !== 'admin') entityId = (req.user.entityIds || [])[0] || null;
  res.json({
    user: db.getFilterView('user', req.user.id, dashboardId),
    entityDefault: entityId ? db.getFilterView('entity', entityId, dashboardId) : null,
  });
});
app.put('/api/my/dashboard-filters/:dashboardId', auth.requireAuth, (req, res) => {
  db.setFilterView('user', req.user.id, req.params.dashboardId, cleanFilterMap(req.body?.filters));
  res.json({ ok: true });
});
app.delete('/api/my/dashboard-filters/:dashboardId', auth.requireAuth, (req, res) => {
  db.deleteFilterView('user', req.user.id, req.params.dashboardId);
  res.json({ ok: true });
});
// Admin: set/clear the CLIENT default for a dashboard (applies to everyone on
// that entity until a user saves their own view).
app.put('/api/admin/entities/:entityId/dashboard-filters/:dashboardId', auth.requireAdmin, (req, res) => {
  db.setFilterView('entity', req.params.entityId, req.params.dashboardId, cleanFilterMap(req.body?.filters));
  res.json({ ok: true });
});
app.delete('/api/admin/entities/:entityId/dashboard-filters/:dashboardId', auth.requireAdmin, (req, res) => {
  db.deleteFilterView('entity', req.params.entityId, req.params.dashboardId);
  res.json({ ok: true });
});


// Expand the map so each name-keyed lock also appears under its resolved field
// — then a dashboard whose organiser filter is named differently still locks.
// Name keys stay (and win client-side) so same-field filters (Current/Past
// Event) keep locking independently.
function expandLockMap(lockMap) {
  const out = { ...(lockMap || {}) };
  for (const [k, v] of Object.entries(lockMap || {})) {
    if (k.includes('.')) continue;
    const field = auth.filterNameToField(k);
    if (field && out[field] == null) out[field] = v;
  }
  return out;
}

// ─── Saved (editable) dashboards ───────────────────────────────────────────────

// List — scoped by access (admin sees all; client sees shared + their own).
app.get('/api/dashboards', auth.requireAuth, (req, res) => {
  res.json(store.list().filter((d) => auth.canAccessDashboard(req.user, d)));
});

app.get('/api/dashboards/:id', auth.requireAuth, (req, res) => {
  const d = store.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Dashboard not found' });
  if (!auth.canAccessDashboard(req.user, d)) return res.status(403).json({ error: 'Not allowed' });
  res.json(d);
});

// Create / edit / delete / import — admin only (Howler builds; clients view).
app.post('/api/dashboards', auth.requireAdmin, (req, res) => res.status(201).json(store.create(req.body || {})));
app.put('/api/dashboards/:id', auth.requireAdmin, (req, res) => {
  const d = store.update(req.params.id, req.body || {});
  if (!d) return res.status(404).json({ error: 'Dashboard not found' });
  res.json(d);
});
app.delete('/api/dashboards/:id', auth.requireAdmin, (req, res) => {
  res.status(store.remove(req.params.id) ? 204 : 404).end();
});

app.post('/api/dashboards/import', auth.requireAdmin, async (req, res) => {
  const { lookerDashboardId, title, folder } = req.body || {};
  if (!lookerDashboardId) return res.status(400).json({ error: 'lookerDashboardId is required' });
  try {
    const source = await fetchDashboard(lookerDashboardId);
    await looker.resolveElementQueries(source.elements);
    const def = convertDashboard(source);
    if (title) def.title = title;
    // Folder: explicit choice, else the dashboard's Looker folder.
    def.folder = (folder || source.dashboard?.folder?.name || '').trim();
    const created = store.create(def);
    try { db.harvestDashboardTiles(created, { sourceDashboardId: created.id }); } catch (e) { console.error('[harvest]', e.message); }
    res.status(201).json(created);
  } catch (err) {
    console.error('[POST /api/dashboards/import]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Preview a Looker folder as a tree of folders → dashboards (admin picks/
// confirms before importing). Honours ?subfolders=0 to show top-level only.
app.get('/api/looker/folder/:id', auth.requireAdmin, async (req, res) => {
  try {
    const includeSub = req.query.subfolders !== '0';
    const root = await looker.lookerRequest('GET', `/folders/${encodeURIComponent(req.params.id)}?fields=id,name,dashboards(id,title)`);
    let tree;
    if (includeSub) {
      try { tree = await collectFolderTree(req.params.id); }
      catch { tree = (root.dashboards || []).map((d) => ({ id: String(d.id), title: d.title, folder: root.name, folderId: String(root.id), depth: 0 })); }
    } else {
      tree = (root.dashboards || []).map((d) => ({ id: String(d.id), title: d.title, folder: root.name, folderId: String(root.id), depth: 0 }));
    }
    // Group into folders, preserving depth-first order. `path` is the nested
    // folder path (e.g. "Festivals/MTN Bushfire/Cashless") used when importing.
    const order = [];
    const byId = new Map();
    for (const d of tree) {
      if (!byId.has(d.folderId)) { byId.set(d.folderId, { id: d.folderId, name: d.folder, depth: d.depth, path: (d.path || [d.folder]).join('/'), dashboards: [] }); order.push(d.folderId); }
      byId.get(d.folderId).dashboards.push({ id: d.id, title: d.title });
    }
    res.json({ id: String(root.id), name: root.name, folders: order.map((fid) => byId.get(fid)), total: tree.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Recursively collect every dashboard in a folder and its subfolders.
// Returns [{ id, title, folder, folderId, depth, path }] where path is the array
// of folder names from the import root down to where the dashboard lives.
async function collectFolderTree(folderId, maxDepth = 6) {
  const result = [];
  const seen = new Set();
  async function walk(id, depth, pathArr) {
    if (seen.has(String(id))) return; // guard against odd cycles
    seen.add(String(id));
    const f = await looker.lookerRequest('GET', `/folders/${encodeURIComponent(id)}?fields=id,name,dashboards(id,title)`);
    const name = f.name || 'Imported folder';
    const path = [...pathArr, name];
    for (const d of f.dashboards || []) result.push({ id: String(d.id), title: d.title, folder: name, folderId: String(f.id), depth, path });
    if (depth < maxDepth) {
      let children = [];
      try { children = await looker.lookerRequest('GET', `/folders/${encodeURIComponent(id)}/children?fields=id,name`); } catch { children = []; }
      for (const c of children || []) await walk(c.id, depth + 1, path);
    }
  }
  await walk(folderId, 0, []);
  return result;
}

// Import every dashboard in a Looker folder, filing them under a folder (the
// Looker folder name by default). With includeSubfolders, the whole tree is
// imported and each dashboard is filed under its own Looker (sub)folder name.
// Sequential — can take a while for big folders.
app.post('/api/dashboards/import-folder', auth.requireAdmin, async (req, res) => {
  const { folderId, folder: folderName, includeSubfolders = true } = req.body || {};
  if (!folderId) return res.status(400).json({ error: 'folderId is required' });
  try {
    const root = await looker.lookerRequest('GET', `/folders/${encodeURIComponent(folderId)}?fields=id,name,dashboards(id,title)`);
    const rootName = (folderName || root.name || 'Imported folder').trim();
    const list = includeSubfolders
      ? await collectFolderTree(folderId)
      : (root.dashboards || []).map((d) => ({ id: String(d.id), title: d.title, path: [root.name], depth: 0 }));
    let imported = 0;
    const failed = [];
    for (const d of list) {
      try {
        const source = await fetchDashboard(String(d.id));
        await looker.resolveElementQueries(source.elements);
        const def = convertDashboard(source);
        // Nested folder path; the root segment honours the optional name override.
        const path = (d.path || [root.name]).slice();
        path[0] = rootName;
        def.folder = path.join('/');
        const created = store.create(def);
        try { db.harvestDashboardTiles(created, { sourceDashboardId: created.id }); } catch (e) { console.error('[harvest]', e.message); }
        imported++;
      } catch (e) {
        failed.push({ id: d.id, title: d.title, error: e.message });
      }
    }
    const folders = [...new Set(list.map((d) => { const p = (d.path || [root.name]).slice(); p[0] = rootName; return p.join('/'); }))];
    res.json({ folder: rootName, imported, total: list.length, failed, folders: folders.length });
  } catch (err) {
    console.error('[POST /api/dashboards/import-folder]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Backfill folders: for already-imported dashboards with no folder, look up
// their source Looker dashboard's folder name and file them under it.
app.post('/api/admin/backfill-folders', auth.requireAdmin, async (_req, res) => {
  let updated = 0;
  const errors = [];
  for (const d of db.listDashboards()) {
    if (d.folder) continue;
    const lid = db.getDashboard(d.id)?.source?.lookerDashboardId;
    if (!lid) continue;
    try {
      const ld = await looker.lookerRequest('GET', `/dashboards/${encodeURIComponent(lid)}?fields=folder`);
      const name = ld.folder?.name;
      if (name) { db.updateDashboard(d.id, { folder: name }); updated++; }
    } catch (e) { errors.push({ id: d.id, error: e.message }); }
  }
  res.json({ updated, errors });
});

// Distinct dashboard folders (for pickers/grouping).
app.get('/api/admin/folders', auth.requireAdmin, (_req, res) => {
  const set = new Set();
  for (const d of db.listDashboards()) if (d.folder) set.add(d.folder);
  res.json([...set].sort((a, b) => a.localeCompare(b)));
});

// Rename a folder (and everything nested beneath it). `from`/`to` are folder
// paths; the matched prefix is rewritten on every dashboard under it.
app.post('/api/admin/folders/rename', auth.requireAdmin, (req, res) => {
  const from = String((req.body || {}).from || '').replace(/\/+$/, '');
  const toLeaf = String((req.body || {}).to || '').trim();
  if (!from || !toLeaf) return res.status(400).json({ error: 'from and to are required' });
  const parent = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
  const newPrefix = parent + toLeaf;
  let updated = 0;
  for (const d of db.listDashboards()) {
    const f = d.folder || '';
    if (f === from || f.startsWith(from + '/')) {
      db.updateDashboard(d.id, { folder: newPrefix + f.slice(from.length) });
      updated++;
    }
  }
  res.json({ updated });
});

// Delete a folder (and subfolders): removes every dashboard filed under it.
app.post('/api/admin/folders/delete', auth.requireAdmin, (req, res) => {
  const path = String((req.body || {}).path || '').replace(/\/+$/, '');
  if (!path) return res.status(400).json({ error: 'path is required' });
  let deleted = 0;
  for (const d of db.listDashboards()) {
    const f = d.folder || '';
    if (f === path || f.startsWith(path + '/')) { store.remove(d.id); deleted++; }
  }
  res.json({ deleted });
});

// ─── LookML metadata (admin builds tiles) ──────────────────────────────────────
app.get('/api/looker/models', auth.requireAdmin, async (_req, res) => {
  try { res.json(await looker.listModels()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/looker/explores/:model/:explore', auth.requireAdmin, async (req, res) => {
  try { res.json(await looker.getExploreFields(req.params.model, req.params.explore)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Query execution (the calculation engine) — scoped per tenant ──────────────

// Slow explores (e.g. cashless) get hammered with identical queries when many
// tiles or repeat views run. Cache results briefly AND de-duplicate in-flight
// runs so the same Looker query is never launched twice at once.
// Query cache with stale-while-revalidate. Fresh hits (< TTL) return instantly.
// Stale hits (< TTL+STALE) return the cached data immediately AND kick off a
// background refresh, so users never wait on a slow Looker query for repeat
// views while data still stays reasonably current. Concurrent identical runs
// are de-duplicated into one Looker call.
// Data updates on a ~30-min Howler→Looker pipeline, so caching up to that cadence
// costs no freshness — instant within a cycle, a new run picked up within ~5 min,
// and the dashboard Refresh button force-bypasses for the latest run on demand.
const QCACHE_TTL = (Number(process.env.QUERY_CACHE_TTL) || 300) * 1000;         // fresh window (s)
const QCACHE_STALE = (Number(process.env.QUERY_CACHE_STALE) || 1800) * 1000;    // serve-stale window (s)
const QCACHE_MAX = Number(process.env.QUERY_CACHE_MAX) || 500;
const qCache = new Map();    // key -> { at, data }
const qInflight = new Map(); // key -> Promise
function stableKey(obj) {
  if (Array.isArray(obj)) return '[' + obj.map(stableKey).join(',') + ']';
  if (obj && typeof obj === 'object') return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + stableKey(obj[k])).join(',') + '}';
  return JSON.stringify(obj);
}
function refreshQuery(key, path, body) {
  if (qInflight.has(key)) return qInflight.get(key);
  const p = looker.lookerRequest('POST', path, body)
    .then((data) => {
      qInflight.delete(key);
      qCache.set(key, { at: Date.now(), data });
      if (qCache.size > QCACHE_MAX) qCache.delete(qCache.keys().next().value);
      return data;
    })
    .catch((e) => { qInflight.delete(key); throw e; });
  qInflight.set(key, p);
  return p;
}
// `ttl` optionally overrides the fresh window for this query (ms).
// `force` skips the cache entirely and waits for live Looker data — used when
// the user explicitly asks for a refresh (otherwise the serve-stale path would
// hand back up-to-10-minute-old rows instantly and "refresh" changes nothing).
async function runLookerQuery(path, body, ttl = QCACHE_TTL, force = false) {
  const key = path + '|' + stableKey(body);
  if (force) return refreshQuery(key, path, body);
  const hit = qCache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < ttl) return hit.data;                       // fresh
  if (hit && age < ttl + QCACHE_STALE) {                        // stale → serve now, refresh behind
    refreshQuery(key, path, body).catch(() => {});
    return hit.data;
  }
  return refreshQuery(key, path, body);                         // miss → wait for it
}

// Force the user's ENTITY (organiser) lock onto every query — the hard security
// boundary. Suite locks (event/cashless) are NOT forced here; they're per-tile
// presets applied client-side via listenTo, so current/past/comparison don't
// clobber each other. A suiteId only gates access + picks the right entity.
// Admins are unscoped. Returns false to deny.
// Force the organiser scope onto a query — using the organiser field that
// belongs to the query's OWN explore (so GA4 etc. don't get core_organisers.name
// injected, which Looker rejects). A suite context (client view or admin
// preview) scopes to that suite's organiser; no suite + admin is unscoped.
// "Is any value" sentinel (mirrors client/src/lib/filterConstants.js ANY_VALUE).
// A filter set to this means "no constraint" — drop the field from the query
// entirely. Sending "" instead would make Looker filter for blank values.
const ANY_VALUE = ' __ANY_VALUE__';
function stripAnyValue(filters) {
  const out = {};
  for (const [k, v] of Object.entries(filters || {})) if (v !== ANY_VALUE) out[k] = v;
  return out;
}

async function applyScope(query, user, suiteId) {
  const scope = await auth.scopeForQuery(query, user, suiteId);
  if (scope === false) return false; // fail closed
  query.filters = { ...(query.filters || {}), ...scope };
  return true;
}

app.post('/api/run-query', auth.requireAuth, async (req, res) => {
  try {
    const { query, filterOverrides = {}, suiteId, refresh = false } = req.body;
    if (!query) return res.status(400).json({ error: 'query is required' });
    const queryBody = { ...query, filters: stripAnyValue({ ...(query.filters || {}), ...filterOverrides }) };
    if (!(await applyScope(queryBody, req.user, suiteId))) {
      // Admins get the specific reason (which explore couldn't be scoped, or no
      // organiser configured) so a blocked dashboard is diagnosable; clients get
      // the generic message (don't leak scoping internals).
      let error = 'No data access is configured for your account yet.';
      if (req.user.role === 'admin') {
        const r = await auth.resolveScope(queryBody, req.user, suiteId);
        if (r.block) error = `Scope blocked: ${r.reason}`;
      }
      return res.status(403).json({ error });
    }
    const data = await runLookerQuery('/queries/run/json_detail', queryBody, undefined, !!refresh);
    res.json(data);
  } catch (err) {
    console.error('[POST /api/run-query]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/drill', auth.requireAuth, async (req, res) => {
  try {
    const query = parseDrillUrl(req.body?.url);
    if (!query) return res.status(400).json({ error: 'Could not parse drill link' });
    if (!(await applyScope(query, req.user, req.body?.suiteId))) {
      return res.status(403).json({ error: 'No data access is configured for your account yet.' });
    }
    const data = await runLookerQuery('/queries/run/json_detail', query);
    res.json({ query, data });
  } catch (err) {
    console.error('[POST /api/drill]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/filter-suggest', auth.requireAuth, async (req, res) => {
  try {
    const { model, explore, field, suiteId, q: term, pair, filters: extraFilters } = req.body;
    if (!model || !explore || !field) return res.json({ suggestions: [] });
    // Get distinct values by running an inline query for just this dimension.
    // A search term filters server-side (contains for text, exact for numeric
    // ids) so this works even with thousands of values. Scope it so clients
    // only see their own values.
    // For organiser/event, also pull the companion field (id↔name) so each
    // suggestion can show both, e.g. "Ultra South Africa  (id: 42)".
    const COMPANION = {
      'core_organisers.name': 'core_organisers.id', 'core_organisers.id': 'core_organisers.name',
      'core_events.name': 'core_events.id', 'core_events.id': 'core_events.name',
    };
    const comp = pair ? COMPANION[field] : null;
    const q = { model, view: explore, fields: comp ? [field, comp] : [field], sorts: [field], limit: 100 };
    const t = (term || '').trim();
    if (t) {
      if (/^\d+$/.test(t)) {
        q.filters = { [field]: t };
      } else {
        // Looker's `%x%` LIKE can be case-sensitive (depends on the dialect),
        // so OR a few case variants to make search effectively case-insensitive.
        const tc = t.replace(/\b\w/g, (c) => c.toUpperCase());
        const variants = [...new Set([t, t.toLowerCase(), t.toUpperCase(), tc])];
        q.filters = { [field]: variants.map((v) => `%${v}%`).join(',') };
      }
    }
    // Optional companion scoping (e.g. Event Slug suggestions limited to the
    // chosen Organiser). Merged before applyScope, so the client's own scope
    // still wins and can't be widened from the browser.
    if (extraFilters && typeof extraFilters === 'object') {
      for (const [k, v] of Object.entries(extraFilters)) if (k && v != null && String(v).trim()) q.filters = { ...(q.filters || {}), [k]: String(v) };
    }
    if (!(await applyScope(q, req.user, suiteId))) return res.json({ suggestions: [] });
    const rows = await runLookerQuery('/queries/run/json', q);
    const seen = new Set();
    const suggestions = [];
    const isId = field.endsWith('.id');
    for (const r of rows || []) {
      const v = r[field];
      if (v == null || v === '') continue;
      const s = String(v);
      if (seen.has(s)) continue;
      seen.add(s);
      if (comp) {
        const other = r[comp] == null ? '' : String(r[comp]);
        suggestions.push({ value: s, label: isId ? `${s} — ${other}` : `${s}  (id: ${other})` });
      } else {
        suggestions.push(s);
      }
    }
    res.json({ suggestions });
  } catch (err) {
    console.error('[POST /api/filter-suggest]', err.message);
    res.json({ suggestions: [] });
  }
});

// ─── Integrations: credential resolution (client overrides admin default) ──────
function adminAnthropicKey() { return (db.getSetting('anthropic_api_key') || process.env.ANTHROPIC_API_KEY || '').trim(); }
function anthropicKeyForEntity(entityId) {
  const k = entityId ? (db.getEntityIntegrations(entityId).anthropicApiKey || '') : '';
  return k.trim() ? k.trim() : adminAnthropicKey();
}
function anthropicKeyForSuite(suiteId) {
  if (!suiteId) return adminAnthropicKey();
  const su = db.getSuite(suiteId);
  return anthropicKeyForEntity(su?.entityId);
}
function anthropicKeyForUser(user) {
  for (const eid of user?.entityIds || []) {
    const k = (db.getEntityIntegrations(eid).anthropicApiKey || '').trim();
    if (k) return k;
  }
  return adminAnthropicKey();
}
const maskSecret = (v) => (v && v.length ? `••••••${String(v).slice(-4)}` : '');

// Combined AI instructions: the global standing instructions, plus the
// per-client context when the request is in a suite (client) context.
function aiInstructionsFor(suiteId) {
  const parts = [];
  const global = db.getSetting('ai_instructions');
  if (global && global.trim()) parts.push(global.trim());
  if (suiteId) {
    const su = db.getSuite(suiteId);
    const ent = su && db.getEntity(su.entityId);
    if (ent?.aiContext && ent.aiContext.trim()) parts.push(`Context for the client "${ent.name}":\n${ent.aiContext.trim()}`);
  }
  return parts.join('\n\n');
}

// ─── AI insight for a tile ─────────────────────────────────────────────────────
app.get('/api/insight/status', auth.requireAuth, (req, res) => {
  res.json({ enabled: insights.isConfigured(anthropicKeyForUser(req.user)) });
});

// Global AI instructions (admin) — appended to every AI prompt.
app.get('/api/admin/ai-instructions', auth.requireAdmin, (_req, res) => {
  res.json({ instructions: db.getSetting('ai_instructions'), aiEnabled: insights.isConfigured(adminAnthropicKey()) });
});
app.put('/api/admin/ai-instructions', auth.requireAdmin, (req, res) => {
  res.json({ instructions: db.setSetting('ai_instructions', (req.body || {}).instructions || '') });
});

// Read-only audit: EVERYTHING the AI is told across the platform, in one place —
// the hardcoded system prompts + role lenses (code), the resolved phase/time
// briefing defaults, the global instructions, and every per-client / per-event /
// per-digest / per-reader / per-tile instruction that's been configured.
app.get('/api/admin/ai-overview', auth.requireAdmin, (req, res) => {
  const savedPhase = JSON.parse(db.getSetting('briefing_phase_defaults', '{}') || '{}');
  const savedTime = JSON.parse(db.getSetting('briefing_time_defaults', '{}') || '{}');
  const pd = phaseDefaults(); const td = timeDefaults();

  // Built-in (code) layers — read-only.
  const builtins = {
    systemPrompts: insights.promptRegistry(),
    roleLenses: Object.entries(ROLE_LENSES).map(([key, v]) => ({ key, label: v.label, focus: v.focus })),
    phaseDefaults: PHASES.map((p) => ({ key: p.key, label: p.label, text: pd[p.key] || '', overridden: !!(savedPhase[p.key] || '').trim() })),
    timeDefaults: TIMES.map((t) => ({ key: t.key, label: t.label, text: td[t.key] || '', overridden: !!(savedTime[t.key] || '').trim() })),
  };

  // Global configured layers.
  const global = {
    aiInstructions: (db.getSetting('ai_instructions') || '').trim(),
    briefingInstructions: (db.getSetting('briefing_instructions') || '').trim(),
  };

  // Per-client: AI context + each event's briefing wording + digest focuses.
  let jobsByEntity = {};
  try {
    for (const j of db.db.prepare("SELECT entity_id, title, role, role_focus, focus_mode, custom_message FROM scheduled_jobs WHERE type='digest'").all()) {
      (jobsByEntity[j.entity_id] = jobsByEntity[j.entity_id] || []).push({ title: j.title || '', role: j.role, roleFocus: (j.role_focus || '').trim(), focusMode: j.focus_mode || 'override', customMessage: (j.custom_message || '').trim() });
    }
  } catch { /* scheduler table may not exist */ }
  const users = db.listUsers();
  const clients = db.listEntities().map((ent) => {
    const events = db.listSuitesForEntity(ent.id).map((su) => {
      const b = su.briefing || {};
      const overrides = Object.entries(b.phaseOverrides || {}).filter(([, v]) => (v || '').trim()).map(([k, v]) => ({ phase: k, text: v.trim() }));
      return { suiteName: su.name, eventStart: b.eventStart || '', eventEnd: b.eventEnd || '', phase: b.phase || '', instructions: (b.instructions || '').trim(), phaseOverrides: overrides };
    }).filter((e) => e.instructions || e.phaseOverrides.length || e.phase || e.eventStart);
    const tunes = users
      .filter((u) => (u.entityIds || []).includes(ent.id))
      .map((u) => ({ email: u.email, tune: (db.getUserPref(u.id, `briefing_tune:${ent.id}`) || '').trim() }))
      .filter((t) => t.tune);
    return { id: ent.id, name: ent.name, aiContext: (ent.aiContext || '').trim(), events, digests: jobsByEntity[ent.id] || [], readerTunes: tunes };
  });

  // Tiles & dashboards with custom AI context (count + list, capped).
  const tileContexts = []; const dashContexts = [];
  for (const d of store.list()) {
    const def = store.get(d.id); if (!def) continue;
    if ((def.aiContext || '').trim()) dashContexts.push({ dashboardId: d.id, dashTitle: def.title || d.title, context: def.aiContext.trim() });
    const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
    for (const t of tiles) if ((t.aiContext || '').trim()) tileContexts.push({ dashTitle: def.title || d.title, tileTitle: t.title || '(untitled)', context: t.aiContext.trim() });
  }

  res.json({ builtins, global, clients, dashContexts, tileContexts });
});

// The literal system prompt sent for one feature, with the configured layers
// resolved for a chosen client/role — exactly as composed at runtime
// (systemWith(base, instructions)). For digest/home the role lens (sent in the
// message, not the system prompt) is shown alongside. Read-only.
function resolveAiPrompt({ feature, entityId, role }) {
  const entry = insights.promptRegistry().find((p) => p.key === feature);
  if (!entry) return null;
  const ent = entityId ? db.getEntity(entityId) : null;
  const note = [];
  let extra = '';
  if (feature === 'tile' || feature === 'dashboard') {
    const suiteId = ent ? (db.listSuitesForEntity(ent.id)[0]?.id || null) : null;
    extra = aiInstructionsFor(suiteId);
    note.push('The per-request dashboard/tile context is appended at runtime and not shown here.');
    if (!ent) note.push('Pick a client to include its AI context.');
  } else if (feature === 'library' || feature === 'campaign' || feature === 'refine') {
    extra = aiInstructionsFor(null); // global instructions only
  } else if (feature === 'settlement' || feature === 'invoice') {
    note.push('Extraction prompts are sent as-is — no standing instructions are appended.');
  } else if (feature === 'home' || feature === 'digest') {
    if (!ent) { note.push('Pick a client to resolve the client / event / reader layers.'); }
    const suites = ent ? clientCatalogue(ent.id).suites : [];
    const user = { id: `audit:${entityId || 'none'}`, email: '', role: 'client', entityIds: ent ? [ent.id] : [], memberships: ent && role ? [{ entityId: ent.id, role }] : [] };
    const layers = [aiInstructionsFor(null)];
    if (ent) layers.push(briefingInstructionsFor(user, ent.id, suites));
    if (feature === 'home') { layers.push(timeDefaults().morning); note.push('Resolved for the MORNING time-of-day lens (midday/evening differ).'); }
    extra = layers.filter(Boolean).join('\n\n');
  }
  let text = `── SYSTEM PROMPT ──\n${insights.systemWith(entry.text, extra)}`;
  if (feature === 'digest' || feature === 'home') {
    const lens = ROLE_LENSES[role] || ROLE_LENSES.exec;
    text += `\n\n── ROLE LENS (sent in the message, not the system prompt) ──\nROLE: ${lens.label}. Focus: ${lens.focus}`;
  }
  return { feature, label: entry.label, text, note: note.join(' ') };
}
app.get('/api/admin/ai-resolved-prompt', auth.requireAdmin, (req, res) => {
  const out = resolveAiPrompt({ feature: String(req.query.feature || ''), entityId: req.query.entityId ? String(req.query.entityId) : null, role: req.query.role ? String(req.query.role) : null });
  if (!out) return res.status(400).json({ error: 'Unknown feature' });
  res.json(out);
});

// ─── Integrations ──────────────────────────────────────────────────────────────
// Admin sets the PRIMARY Looker + Anthropic accounts (override .env). Clients can
// set their own, which take precedence for their data. Secrets are write-only:
// responses only report whether a value is set, never the value itself.
function applyIntegrationsPatch(body, set) {
  // `set(key, value)` writes a field; called only for fields the caller changed.
  const lk = body.looker || {};
  if (lk.baseUrl !== undefined) set('lookerBaseUrl', String(lk.baseUrl || '').replace(/\/$/, ''));
  if (lk.clientId !== undefined) set('lookerClientId', String(lk.clientId || ''));
  if (lk.clientSecret) set('lookerClientSecret', String(lk.clientSecret));
  if (lk.clearClientSecret) set('lookerClientSecret', '');
  const an = body.anthropic || {};
  if (an.apiKey) set('anthropicApiKey', String(an.apiKey));
  if (an.clearApiKey) set('anthropicApiKey', '');
}
function adminIntegrationsView() {
  return {
    looker: {
      baseUrl: db.getSetting('looker_base_url') || '',
      clientId: db.getSetting('looker_client_id') || '',
      clientSecretSet: !!db.getSetting('looker_client_secret'),
      envFallback: !db.getSetting('looker_base_url') && !!process.env.LOOKER_BASE_URL,
      configured: looker.isConfigured(),
    },
    anthropic: {
      keySet: !!db.getSetting('anthropic_api_key'),
      keyHint: maskSecret(db.getSetting('anthropic_api_key')),
      envFallback: !db.getSetting('anthropic_api_key') && !!process.env.ANTHROPIC_API_KEY,
      configured: !!adminAnthropicKey(),
    },
    // Email (Resend) is platform-level only — it sends from Howler's domain.
    resend: { ...mailer.status(), recent: mailer.recent() },
    // Inventive embedded AI analyst (platform-level: one account, per-client workspaces).
    inventive: {
      keySet: !!db.getSetting('inventive_api_key'),
      keyHint: maskSecret(db.getSetting('inventive_api_key')),
      tokenSet: !!db.getSetting('inventive_embed_auth_token'),
      tokenHint: maskSecret(db.getSetting('inventive_embed_auth_token')),
      endpoint: db.getSetting('inventive_api_endpoint') || '',
      envFallback: !db.getSetting('inventive_api_key') && !!process.env.INVENTIVE_API_KEY,
      configured: !!((db.getSetting('inventive_api_key') || process.env.INVENTIVE_API_KEY) && (db.getSetting('inventive_embed_auth_token') || process.env.INVENTIVE_EMBED_AUTH_TOKEN)),
    },
  };
}
function entityIntegrationsView(entityId) {
  const i = db.getEntityIntegrations(entityId);
  return {
    looker: { baseUrl: i.lookerBaseUrl || '', clientId: i.lookerClientId || '', clientSecretSet: !!i.lookerClientSecret },
    anthropic: { keySet: !!i.anthropicApiKey, keyHint: maskSecret(i.anthropicApiKey) },
  };
}

// Admin: primary accounts.
app.get('/api/admin/integrations', auth.requireAdmin, (_req, res) => res.json(adminIntegrationsView()));
app.put('/api/admin/integrations', auth.requireAdmin, (req, res) => {
  const map = { lookerBaseUrl: 'looker_base_url', lookerClientId: 'looker_client_id', lookerClientSecret: 'looker_client_secret', anthropicApiKey: 'anthropic_api_key' };
  applyIntegrationsPatch(req.body || {}, (k, v) => db.setSetting(map[k], v));
  // Resend (email) — admin-only, so handled here rather than in the shared patch.
  const re = (req.body || {}).resend || {};
  if (re.apiKey) db.setSetting('resend_api_key', String(re.apiKey));
  if (re.clearApiKey) db.setSetting('resend_api_key', '');
  if (re.from !== undefined) db.setSetting('mail_from', String(re.from || '').trim());
  // Inventive (embedded AI analyst) — admin-only, platform-level.
  const inv = (req.body || {}).inventive || {};
  if (inv.apiKey) db.setSetting('inventive_api_key', String(inv.apiKey));
  if (inv.clearApiKey) db.setSetting('inventive_api_key', '');
  if (inv.embedToken) db.setSetting('inventive_embed_auth_token', String(inv.embedToken));
  if (inv.clearEmbedToken) db.setSetting('inventive_embed_auth_token', '');
  if (inv.endpoint !== undefined) db.setSetting('inventive_api_endpoint', String(inv.endpoint || '').trim());
  res.json(adminIntegrationsView());
});

// ─── System-wide email audit: sent log + upcoming scheduled sends ──────────────
// One place to see every email the platform sent (notifications, digests,
// campaigns, tests) and what's scheduled to go out next.
app.get('/api/admin/mail-log', auth.requireAdmin, (req, res) => {
  const { kind = '', status = '', entityId = '', limit = 100 } = req.query;
  const log = mailer.recent({ limit: Number(limit) || 100, kind: String(kind), status: String(status), entityId: String(entityId) })
    .map((r) => ({ ...r, entityName: r.entity_id ? (db.getEntity(r.entity_id)?.name || '') : '' }));
  // Upcoming = active scheduled digests with a next run. (Campaigns are
  // approve-and-send, so nothing is "scheduled" there yet.)
  let upcoming = [];
  try {
    upcoming = db.db.prepare("SELECT id, entity_id, title, role, recipients, cadence, time_of_day, next_run_at FROM scheduled_jobs WHERE status='active' AND next_run_at IS NOT NULL ORDER BY next_run_at LIMIT 50")
      .all().map((j) => ({
        id: j.id, title: j.title || `${j.role} digest`, kind: 'digest',
        entityName: db.getEntity(j.entity_id)?.name || '',
        recipients: JSON.parse(j.recipients || '[]').length,
        cadence: j.cadence, timeOfDay: j.time_of_day, nextRunAt: j.next_run_at,
      }));
  } catch { /* scheduler module removed — no upcoming */ }
  res.json({ log, upcoming });
});

// Client self-service: a client's own sent emails + their scheduled digests.
// Scoped strictly to entities the user owns (or admin preview).
app.get('/api/my/mail-log/:entityId', auth.requireAuth, (req, res) => {
  const id = req.params.entityId;
  if (req.user.role !== 'admin' && !(req.user.entityIds || []).includes(id)) return res.status(403).json({ error: 'Not allowed' });
  const { kind = '', status = '', limit = 100 } = req.query;
  const log = mailer.recent({ limit: Number(limit) || 100, kind: String(kind), status: String(status), entityId: id });
  let upcoming = [];
  try {
    upcoming = db.db.prepare("SELECT id, title, role, recipients, cadence, time_of_day, next_run_at FROM scheduled_jobs WHERE entity_id=? AND status='active' AND next_run_at IS NOT NULL ORDER BY next_run_at LIMIT 50")
      .all(id).map((j) => ({ id: j.id, title: j.title || `${j.role} digest`, kind: 'digest', recipients: JSON.parse(j.recipients || '[]').length, cadence: j.cadence, timeOfDay: j.time_of_day, nextRunAt: j.next_run_at }));
  } catch { /* scheduler removed */ }
  res.json({ log, upcoming });
});
// Optional { entityId } renders with that client's branding so you can preview
// exactly what a client's recipients will get.
app.post('/api/admin/mail/test', auth.requireAdmin, async (req, res) => {
  const entityId = (req.body || {}).entityId || null;
  const branding = entityId ? mailer.resolveBranding(entityId) : undefined;
  const { html, text } = mailer.notificationEmail({
    title: 'Pulse email is working',
    body: 'This is a test from Howler : Pulse. Outbound notifications (must-acknowledge messages, replies from Howler) will arrive like this.',
    ctaText: 'Open Pulse', ctaPath: '/', branding, assetScope: entityId || 'platform',
  });
  const r = await mailer.send({ to: req.user.email, subject: 'Howler : Pulse — test email', html, text, fromName: branding?.senderName, kind: 'test', entity: entityId || '' });
  if (r.ok) return res.json({ ok: true, to: req.user.email });
  res.status(400).json({ error: r.error || r.reason || 'Email is not configured yet' });
});

// ─── Email templates / branding ────────────────────────────────────────────────
// Platform default (admin) and per-client overrides (admin + client self-serve).
// Branding fields are plain presentation (logo / colour / sender / wording) —
// never secrets — so they ride along to the browser freely.
const MAIL_FIELDS = Object.keys(mailer.DEFAULTS);
const cleanBrandingPatch = (body) => {
  const out = {};
  // Logo can be an uploaded data-URL (resized client-side, but still big).
  for (const k of MAIL_FIELDS) if (body && k in body) out[k] = String(body[k] ?? '').slice(0, k === 'logo' ? 800000 : 4000);
  return out;
};

// Public, cacheable logo asset for emails: Gmail/Outlook strip data-URL images,
// so sends reference this URL instead. Serves the resolved logo for a client
// (or the platform template's). Logos are public-facing brand assets — no auth.
app.get('/mail-assets/logo/:scope', (req, res) => {
  const scope = req.params.scope;
  const logo = scope === 'platform'
    ? mailer.getPlatformTemplate().logo
    : (db.getEntity(scope) ? mailer.resolveBranding(scope).logo : '');
  if (!logo) return res.status(404).end();
  if (!logo.startsWith('data:')) return res.redirect(302, logo); // external URL
  const m = logo.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!m) return res.status(404).end();
  const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  res.set('Content-Type', m[1] || 'image/png');
  res.set('Cache-Control', 'public, max-age=300'); // short: re-uploads show within minutes
  res.send(buf);
});

app.get('/api/admin/mail-template', auth.requireAdmin, (_req, res) =>
  res.json({ template: mailer.getPlatformTemplate(), defaults: mailer.DEFAULTS }));
app.put('/api/admin/mail-template', auth.requireAdmin, (req, res) =>
  res.json({ template: mailer.setPlatformTemplate(cleanBrandingPatch(req.body || {})), defaults: mailer.DEFAULTS }));

// Per-client branding view: the raw overrides + the fully resolved result.
function clientMailView(entityId) {
  return { branding: db.getEntityMailBranding(entityId), resolved: mailer.resolveBranding(entityId), defaults: mailer.DEFAULTS };
}
app.get('/api/admin/entities/:id/mail-template', auth.requireAdmin, (req, res) => {
  if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
  res.json(clientMailView(req.params.id));
});
app.put('/api/admin/entities/:id/mail-template', auth.requireAdmin, (req, res) => {
  if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
  db.setEntityMailBranding(req.params.id, cleanBrandingPatch(req.body || {}));
  res.json(clientMailView(req.params.id));
});

// ── CC-the-Owl: a client's inbound address (admin + client self-service) ───────
const inboundDomain = () => db.getSetting('inbound_domain', '');
function inboxView(entityId) {
  const token = db.ensureInboxToken(entityId);
  const domain = inboundDomain();
  return { token, domain, address: domain ? `${token}@${domain}` : '', configured: !!domain };
}
app.get('/api/admin/entities/:id/inbox', auth.requireAdmin, (req, res) => {
  if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
  res.json(inboxView(req.params.id));
});
app.post('/api/admin/entities/:id/inbox/regenerate', auth.requireAdmin, (req, res) => {
  if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
  db.regenerateInboxToken(req.params.id);
  res.json(inboxView(req.params.id));
});
app.get('/api/my/inbox/:entityId', auth.requireAuth, (req, res) => {
  if (!(req.user.entityIds || []).includes(req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
  const v = inboxView(req.params.entityId);
  res.json({ address: v.address, domain: v.domain, configured: v.configured }); // no token churn surface for clients
});

// Client self-service for their own entity.
app.get('/api/my/mail-template/:entityId', auth.requireAuth, (req, res) => {
  if (!(req.user.entityIds || []).includes(req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
  res.json(clientMailView(req.params.entityId));
});
app.put('/api/my/mail-template/:entityId', auth.requireAuth, auth.requirePermission('branding.manage'), (req, res) => {
  if (!(req.user.entityIds || []).includes(req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
  db.setEntityMailBranding(req.params.entityId, cleanBrandingPatch(req.body || {}));
  res.json(clientMailView(req.params.entityId));
});

// ── White-label theme ──────────────────────────────────────────────────────────
// The client's brand pair (primary + secondary) + logo, resolved through the
// same layering as email branding (defaults ← platform ← client) — ONE brand
// source drives emails AND the platform look. Pure presentation, no secrets.
app.get('/api/theme/:entityId', auth.requireAuth, (req, res) => {
  const id = req.params.entityId;
  if (req.user.role !== 'admin' && !(req.user.entityIds || []).includes(id)) return res.status(403).json({ error: 'Not allowed' });
  if (!db.getEntity(id)) return res.status(404).json({ error: 'Not found' });
  const b = mailer.resolveBranding(id);
  res.json({ primary: b.brandColor, secondary: b.secondaryColor, chart3: b.chart3, chart4: b.chart4, chart5: b.chart5, logo: b.logo || '' });
});

// Live preview: render the email HTML with unsaved edits layered on the right
// base. Clients may only preview their own entity.
app.post('/api/mail/preview', auth.requireAuth, (req, res) => {
  const { edits, entityId } = req.body || {};
  if (entityId && req.user.role !== 'admin' && !(req.user.entityIds || []).includes(entityId)) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  const branding = mailer.previewBranding({ edits: cleanBrandingPatch(edits || {}), entityId });
  const { html } = mailer.notificationEmail({
    title: 'Sound check signoff needed',
    body: 'Hi — please review the stage plot and confirm the gate times before Friday. Tap below to acknowledge in Pulse.',
    ctaText: 'Acknowledge in Pulse', ctaPath: '/inbox', branding,
  });
  res.json({ html, resolved: branding });
});

// Admin: a specific client's overrides.
app.get('/api/admin/entities/:id/integrations', auth.requireAdmin, (req, res) => {
  if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
  res.json(entityIntegrationsView(req.params.id));
});
app.put('/api/admin/entities/:id/integrations', auth.requireAdmin, (req, res) => {
  if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const patch = {};
  applyIntegrationsPatch(req.body || {}, (k, v) => { patch[k] = v; });
  db.setEntityIntegrations(req.params.id, patch);
  res.json(entityIntegrationsView(req.params.id));
});

// Client self-service: the logged-in user's own client(s).
app.get('/api/my/integrations', auth.requireAuth, (req, res) => {
  const out = (req.user.entityIds || []).map((id) => {
    const e = db.getEntity(id);
    return e ? { entityId: id, name: e.name, ...entityIntegrationsView(id) } : null;
  }).filter(Boolean);
  res.json(out);
});
app.put('/api/my/integrations/:entityId', auth.requireAuth, auth.requirePermission('integrations.manage'), (req, res) => {
  if (!(req.user.entityIds || []).includes(req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
  const patch = {};
  applyIntegrationsPatch(req.body || {}, (k, v) => { patch[k] = v; });
  db.setEntityIntegrations(req.params.entityId, patch);
  res.json(entityIntegrationsView(req.params.entityId));
});

// Streams the insight back as plain text chunks as Claude writes it.
// Per-user rate limit guards against runaway Anthropic spend (refresh loops etc).
app.post('/api/insight', auth.requireAuth, rateLimit({ windowMs: 60_000, max: 30, by: 'user', scope: 'insight', message: 'Too many AI insight requests — please wait a moment.' }), async (req, res) => {
  const { title, visType, fields, rows, filters, userContext, history, suiteId, dashboardContext, tileContext } = req.body || {};
  if (!fields || !rows) return res.status(400).json({ error: 'fields and rows are required' });
  const apiKey = anthropicKeyForSuite(suiteId);
  if (!insights.isConfigured(apiKey)) {
    return res.status(400).json({ error: 'AI insights are not configured. Set an Anthropic API key in Admin → Integrations (or .env).' });
  }
  try {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no'); // don't let a reverse proxy buffer the stream
    res.flushHeaders?.();
    const instructions = [
      aiInstructionsFor(suiteId),
      dashboardContext && dashboardContext.trim() ? `Context for this dashboard:\n${dashboardContext.trim()}` : '',
      tileContext && tileContext.trim() ? `Context for this tile:\n${tileContext.trim()}` : '',
    ].filter(Boolean).join('\n\n');
    await insights.streamInsight({ title, visType, fields, rows, filters, userContext, history, instructions, apiKey }, (text) => res.write(text));
    res.end();
  } catch (err) {
    console.error('[POST /api/insight]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else { res.write(`\n\n[error: ${err.message}]`); res.end(); }
  }
});

// Whole-dashboard summary: runs every tile's query (same scope + filters as the
// live view), then streams an executive summary of the whole dashboard.
// Tighter per-user limit — each call can fire up to 24 Looker queries + a Claude
// call, so it's the most expensive AI endpoint.
app.post('/api/dashboard-insight', auth.requireAuth, rateLimit({ windowMs: 60_000, max: 10, by: 'user', scope: 'dashboard-insight', message: 'Too many dashboard summaries — please wait a moment.' }), async (req, res) => {
  const { dashboardId, filterValues = {}, suiteId } = req.body || {};
  if (!dashboardId) return res.status(400).json({ error: 'dashboardId is required' });
  const apiKey = anthropicKeyForSuite(suiteId);
  if (!insights.isConfigured(apiKey)) {
    return res.status(400).json({ error: 'AI insights are not configured. Set an Anthropic API key in Admin → Integrations (or .env).' });
  }
  const def = store.get(dashboardId);
  if (!def) return res.status(404).json({ error: 'Dashboard not found' });
  if (req.user.role !== 'admin' && !auth.canAccessDashboard(req.user, def)) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  // Build each runnable tile's scoped query (mirrors the client's per-tile logic).
  const MAX_TILES = 24;
  const allTiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
  const jobs = [];
  for (const tile of allTiles) {
    const q = tile.query;
    if (tile.type === 'text' || !q?.model || !q?.view || !(q.fields || []).length) continue;
    const overrides = {};
    for (const [filterName, queryField] of Object.entries(tile.listenTo || {})) {
      const v = filterValues[filterName];
      if (v === ANY_VALUE) overrides[queryField] = ANY_VALUE; // "any value" → dropped by stripAnyValue
      else if (v && String(v).trim()) overrides[queryField] = String(v).trim();
    }
    const queryBody = { ...q, filters: stripAnyValue({ ...(q.filters || {}), ...overrides }) };
    if (!(await applyScope(queryBody, req.user, suiteId))) continue; // skip blocked tiles
    jobs.push({ title: tile.title, visType: tile.vis?.type, context: tile.aiContext || '', queryBody });
    if (jobs.length >= MAX_TILES) break;
  }

  const settled = await Promise.all(jobs.map(async (j) => {
    try {
      const data = await runLookerQuery('/queries/run/json_detail', j.queryBody);
      if (!data?.data?.length) return null;
      return { title: j.title, visType: j.visType, context: j.context, fields: data.fields, rows: data.data };
    } catch { return null; }
  }));
  const tiles = settled.filter(Boolean);
  if (!tiles.length) return res.status(400).json({ error: 'No tile data available to summarize.' });

  try {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no'); // don't let a reverse proxy buffer the stream
    res.flushHeaders?.();
    const instructions = [
      aiInstructionsFor(suiteId),
      def.aiContext && def.aiContext.trim() ? `Context for this dashboard:\n${def.aiContext.trim()}` : '',
    ].filter(Boolean).join('\n\n');
    await insights.streamDashboardInsight({ title: def.title, filters: filterValues, tiles, instructions, apiKey }, (t) => res.write(t));
    res.end();
  } catch (err) {
    console.error('[POST /api/dashboard-insight]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else { res.write(`\n\n[error: ${err.message}]`); res.end(); }
  }
});

// ─── Settlements ───────────────────────────────────────────────────────────────
// Event settlement reports. Admin uploads the PDF; Claude extracts it into
// structured JSON; the client gets an interactive report scoped to their
// entity. PDF bodies can be large, so admin routes parse their own body.
const settlementJson = express.json({ limit: '40mb' });

// Can this user open this settlement? Admin: any. Client: must belong to one of
// their entities.
function canAccessSettlement(user, s) {
  if (!s) return false;
  if (user.role === 'admin') return true;
  return !!s.entityId && (user.entityIds || []).includes(s.entityId);
}

// Client list: settlements for the user's entities (admin sees all).
app.get('/api/my/settlements', auth.requireAuth, (req, res) => {
  const list = req.user.role === 'admin' ? db.listSettlements() : db.listSettlements({ entityIds: req.user.entityIds || [] });
  res.json(list);
});

app.get('/api/settlements/:id', auth.requireAuth, (req, res) => {
  const s = db.getSettlement(req.params.id);
  if (!s) return res.status(404).json({ error: 'Settlement not found' });
  if (!canAccessSettlement(req.user, s)) return res.status(403).json({ error: 'Not allowed' });
  res.json(s);
});

// Save notes (user annotations) on a settlement. Writable by anyone who can
// view it — admin or the assigned client — since notes are collaborative.
// The client sends the full notes array; we stamp author + timestamp.
app.put('/api/settlements/:id/notes', auth.requireAuth, (req, res) => {
  const s = db.getSettlement(req.params.id);
  if (!s) return res.status(404).json({ error: 'Settlement not found' });
  if (!canAccessSettlement(req.user, s)) return res.status(403).json({ error: 'Not allowed' });
  const incoming = Array.isArray(req.body?.notes) ? req.body.notes : [];
  const clean = incoming.slice(0, 500).map((n) => ({
    id: String(n.id || '').slice(0, 64) || Math.random().toString(36).slice(2),
    section: String(n.section || 'general').slice(0, 64),
    sectionLabel: String(n.sectionLabel || '').slice(0, 120),
    text: String(n.text || '').slice(0, 4000),
    author: String(n.author || req.user.email || '').slice(0, 160),
    at: n.at || new Date().toISOString(),
  })).filter((n) => n.text.trim());
  const updated = db.setSettlementNotes(req.params.id, clean);
  res.json({ notes: updated.notes });
});

// Download the original PDF.
app.get('/api/settlements/:id/file', auth.requireAuth, (req, res) => {
  const s = db.getSettlement(req.params.id);
  if (!s) return res.status(404).json({ error: 'Settlement not found' });
  if (!canAccessSettlement(req.user, s)) return res.status(403).json({ error: 'Not allowed' });
  const f = db.getSettlementFile(req.params.id);
  if (!f) return res.status(404).json({ error: 'No file attached' });
  res.setHeader('Content-Type', f.fileType || 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${(f.fileName || 'settlement.pdf').replace(/"/g, '')}"`);
  res.send(Buffer.from(f.file, 'base64'));
});

// Admin: list all (with entity names for the management table).
app.get('/api/admin/settlements', auth.requireAdmin, (_req, res) => {
  res.json(db.listSettlements().map((s) => ({ ...s, entityName: s.entityId ? (db.getEntity(s.entityId)?.name || '') : '' })));
});

// ─── Event documents (invoices etc.) ───────────────────────────────────────────
// Plain file storage per client/event — uploaded by admins, downloadable by the
// assigned client. No extraction.
app.get('/api/my/documents', auth.requireAuth, (req, res) => {
  const list = req.user.role === 'admin' ? db.listDocuments() : db.listDocuments({ entityIds: req.user.entityIds || [] });
  res.json(list);
});
app.get('/api/documents/:id', auth.requireAuth, (req, res) => {
  const doc = db.getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const allowed = req.user.role === 'admin' || (doc.entityId && (req.user.entityIds || []).includes(doc.entityId));
  if (!allowed) return res.status(403).json({ error: 'Not allowed' });
  res.json({ ...doc, entityName: doc.entityId ? (db.getEntity(doc.entityId)?.name || '') : '' });
});
app.get('/api/documents/:id/file', auth.requireAuth, (req, res) => {
  const doc = db.getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const allowed = req.user.role === 'admin' || (doc.entityId && (req.user.entityIds || []).includes(doc.entityId));
  if (!allowed) return res.status(403).json({ error: 'Not allowed' });
  const f = db.getDocumentFile(req.params.id);
  if (!f) return res.status(404).json({ error: 'No file attached' });
  res.setHeader('Content-Type', f.fileType || 'application/octet-stream');
  // inline=1 lets the browser render it in the viewer; otherwise force download.
  const disp = req.query.inline ? 'inline' : 'attachment';
  res.setHeader('Content-Disposition', `${disp}; filename="${(f.fileName || 'document').replace(/"/g, '')}"`);
  res.send(Buffer.from(f.file, 'base64'));
});
app.get('/api/admin/documents', auth.requireAdmin, (req, res) => {
  res.json(db.listDocuments(req.query.entityId ? { entityId: req.query.entityId } : {}));
});
app.post('/api/admin/documents', auth.requireAdmin, settlementJson, (req, res) => {
  const { entityId, eventName, title, category, data, fileBase64, fileName, fileType } = req.body || {};
  if (!fileBase64) return res.status(400).json({ error: 'fileBase64 is required' });
  res.status(201).json(db.createDocument({ entityId, eventName, title, category, data: data || {}, file: fileBase64, fileName: fileName || '', fileType: fileType || '' }));
});
// AI-extract an invoice PDF into structured JSON (same ndjson progress stream
// as the settlement extraction). Nothing saved — the admin reviews & publishes.
app.post('/api/admin/documents/extract', auth.requireAdmin, settlementJson, async (req, res) => {
  const { fileBase64 } = req.body || {};
  if (!fileBase64) return res.status(400).json({ error: 'fileBase64 is required' });
  const apiKey = adminAnthropicKey();
  if (!insights.isConfigured(apiKey)) return res.status(400).json({ error: 'AI extraction needs an Anthropic API key (Admin → Integrations).' });
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');
  send({ type: 'progress', stage: 'reading', chars: 0, rows: 0 });
  try {
    const data = await insights.extractInvoice({
      pdfBase64: fileBase64, apiKey,
      onProgress: (p) => send({ type: 'progress', stage: 'extracting', ...p }),
    });
    send({ type: 'done', data });
  } catch (err) {
    console.error('[POST /api/admin/documents/extract]', err.message);
    send({ type: 'error', error: err.message });
  }
  res.end();
});
app.put('/api/admin/documents/:id', auth.requireAdmin, settlementJson, (req, res) => {
  const doc = db.updateDocument(req.params.id, req.body || {});
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  res.json(doc);
});
app.delete('/api/admin/documents/:id', auth.requireAdmin, (req, res) => {
  res.status(db.deleteDocument(req.params.id) ? 204 : 404).end();
});

// Admin: AI-extract an uploaded settlement PDF into the structured JSON draft.
// Streams progress as newline-delimited JSON ({type:'progress'|'done'|'error'})
// so the admin sees live feedback — and so bytes keep flowing through any
// proxy during the long extraction. Nothing is saved; the admin reviews, then
// publishes via POST /api/admin/settlements.
app.post('/api/admin/settlements/extract', auth.requireAdmin, settlementJson, async (req, res) => {
  const { fileBase64, fileType } = req.body || {};
  if (!fileBase64) return res.status(400).json({ error: 'fileBase64 is required' });
  if (fileType && fileType !== 'application/pdf') return res.status(400).json({ error: 'Only PDF files are supported for now' });
  const apiKey = adminAnthropicKey();
  if (!insights.isConfigured(apiKey)) return res.status(400).json({ error: 'AI extraction needs an Anthropic API key (Admin → Integrations).' });
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');
  send({ type: 'progress', stage: 'reading', chars: 0, rows: 0 });
  try {
    const data = await insights.extractSettlement({
      pdfBase64: fileBase64, apiKey,
      onProgress: (p) => send({ type: 'progress', stage: 'extracting', ...p }),
    });
    send({ type: 'done', data });
  } catch (err) {
    console.error('[POST /api/admin/settlements/extract]', err.message);
    send({ type: 'error', error: err.message });
  }
  res.end();
});

// Admin: publish a settlement (extracted data + original file + assignment).
app.post('/api/admin/settlements', auth.requireAdmin, settlementJson, (req, res) => {
  const { entityId, title, status, settlementDate, data, fileBase64, fileName, fileType } = req.body || {};
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'data is required' });
  const s = db.createSettlement({ entityId, title, status, settlementDate, data, file: fileBase64 || '', fileName: fileName || '', fileType: fileType || '' });
  res.status(201).json(s);
});

// Admin: load the bundled example report (MTN Bushfire) to demo the feature.
app.post('/api/admin/settlements/example', auth.requireAdmin, (_req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'settlement-example.json'), 'utf8'));
    const s = db.createSettlement({ entityId: null, title: data.meta.eventName, status: 'final', settlementDate: data.meta.settlementDate, data });
    res.status(201).json(s);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/settlements/:id', auth.requireAdmin, settlementJson, (req, res) => {
  const s = db.updateSettlement(req.params.id, req.body || {});
  if (!s) return res.status(404).json({ error: 'Settlement not found' });
  res.json(s);
});

app.delete('/api/admin/settlements/:id', auth.requireAdmin, (req, res) => {
  res.status(db.deleteSettlement(req.params.id) ? 204 : 404).end();
});

// ─── Personalised home: tracking, snapshot, briefing ───────────────────────────

// Fire-and-forget view tracking — one row per dashboard open.
app.post('/api/track', auth.requireAuth, (req, res) => {
  const { suiteId, dashboardId } = req.body || {};
  try { db.recordView(req.user.id, suiteId || '', dashboardId); } catch { /* never block the app on telemetry */ }
  res.status(204).end();
});

// Which client (entity) the home page is for: clients get their own; admins
// (previewing) pass ?entityId.
function homeEntityFor(req) {
  if (req.user.role === 'admin') return req.query.entityId || (req.body || {}).entityId || null;
  const ids = req.user.entityIds || [];
  const want = req.query.entityId || (req.body || {}).entityId;
  return want && ids.includes(want) ? want : ids[0] || null;
}

// Build the snapshot facts: headline metric tiles auto-picked from each
// suite's lead dashboards (first top-level dashboard per set + its tabs),
// deduped and capped, run through the scoped query cache. Deterministic —
// no AI here.
// ─── Event phases (briefing steering) ───────────────────────────────────────
// Every event moves through phases; the briefing's instructions change with
// them. Defaults are global (editable in Admin → AI); each suite/event can
// override per phase, and the phase itself auto-derives from the suite's dates
// (launch + event start/end) with a manual override for things like Artist
// Drops, which are announcement-driven rather than date-driven.
const PHASES = [
  { key: 'pre_launch', label: 'Pre Launch' },
  { key: 'launch', label: 'Launch' },
  { key: 'artist_drops', label: 'Artist Drops' },
  { key: 'mid_campaign', label: 'Mid Campaign' },
  { key: 'build_up', label: 'Build Up' },
  { key: 'event_day', label: 'Event Day' },
  { key: 'day_after', label: 'Day After' },
  { key: 'post_event', label: 'Post Event' },
];
const PHASE_DEFAULTS = {
  pre_launch: 'Tickets are not on sale yet. Focus on readiness: pricing tiers set up, comparisons to the previous event at this point, and audience/marketing signals. Do not treat zero sales as a problem.',
  launch: 'Tickets just went on sale. Focus on launch velocity: first-day/first-week sales, which tiers are moving, early-bird sell-through, and how launch compares to the previous event\'s launch.',
  artist_drops: 'A lineup announcement just happened. Focus on the sales spike around the announcement: uplift vs the days before, which ticket types benefited, resale activity, and traffic/audience response.',
  mid_campaign: 'Steady campaign period. Focus on weekly pace, sell-through by tier, pricing-phase transitions, comps creep, and whether pace projects to sell-out — call out anything going quiet.',
  build_up: 'Final week before the event. Focus on daily pace, projected final numbers, door-list/comps readiness, cashless top-up uptake, and any operational flags.',
  event_day: 'The event is LIVE. Focus on today: gate/check-in numbers, on-the-day sales, cashless top-ups and spend, and anything anomalous that needs action now.',
  day_after: 'The event just ended. Focus on the headline result: final attendance vs tickets sold, total revenue vs previous event, cashless spend per head, and biggest surprises.',
  post_event: 'Wrap-up mode. Focus on final totals vs last event, what over- and under-performed, refund/resale tails, and settlement status. Frame learnings for the next event.',
};
// Resolve a suite's current phase from its briefing config.
function resolvePhase(cfg = {}, nowMs = Date.now()) {
  if (cfg.manualPhase && cfg.manualPhase !== 'auto' && PHASES.some((p) => p.key === cfg.manualPhase)) {
    return { key: cfg.manualPhase, source: 'manual' };
  }
  const day = 864e5;
  const t = (s) => (s ? new Date(`${s}T00:00:00`).getTime() : null);
  const launch = t(cfg.launchDate), start = t(cfg.eventStart), end = t(cfg.eventEnd) ?? t(cfg.eventStart);
  if (end != null && nowMs > end + 2 * day) return { key: 'post_event', source: 'auto' };
  if (end != null && nowMs > end + day) return { key: 'day_after', source: 'auto' };
  if (start != null && end != null && nowMs >= start && nowMs <= end + day) return { key: 'event_day', source: 'auto' };
  if (start != null && nowMs >= start - 7 * day) return { key: 'build_up', source: 'auto' };
  if (launch != null && nowMs < launch) return { key: 'pre_launch', source: 'auto' };
  if (launch != null && nowMs <= launch + 7 * day) return { key: 'launch', source: 'auto' };
  if (launch != null || start != null) return { key: 'mid_campaign', source: 'auto' };
  return { key: null, source: 'none' }; // no dates configured
}
function phaseDefaults() {
  const saved = JSON.parse(db.getSetting('briefing_phase_defaults', '{}') || '{}');
  return Object.fromEntries(PHASES.map((p) => [p.key, (saved[p.key] || '').trim() || PHASE_DEFAULTS[p.key]]));
}

// Time-of-day lens: a reader wants different things at 8am, 1pm and 7pm. The
// client sends its local hour; the segment shapes the briefing's angle and
// splits the cache so each part of the day gets a fresh generation.
const TIMES = [
  { key: 'morning', label: 'Morning' },
  { key: 'midday', label: 'Midday' },
  { key: 'evening', label: 'Evening' },
];
const TIME_DEFAULTS = {
  morning: 'It is MORNING for the reader. Open with what happened since yesterday/overnight — sales added, notable moves — then where the campaign stands overall, and set up the day: the one or two things to watch today.',
  midday: 'It is MIDDAY for the reader. Focus on how TODAY is tracking so far — pace versus a typical day, anything spiking or stalling — and flag anything that needs action this afternoon.',
  evening: 'It is EVENING for the reader. Wrap the day: how today closed (sales, revenue, standout performers or laggards), and what tomorrow should bring or needs attention.',
};
function timeSegment(hour) {
  const h = Number.isFinite(hour) ? hour : new Date().getHours();
  return h < 12 ? 'morning' : h < 17 ? 'midday' : 'evening';
}
function timeDefaults() {
  const saved = JSON.parse(db.getSetting('briefing_time_defaults', '{}') || '{}');
  return Object.fromEntries(TIMES.map((t) => [t.key, (saved[t.key] || '').trim() || TIME_DEFAULTS[t.key]]));
}
// Assemble the briefing instruction stack for an entity (most specific last).
function briefingInstructionsFor(user, entityId, suites) {
  const parts = [];
  const global = (db.getSetting('briefing_instructions') || '').trim();
  if (global) parts.push(`Howler briefing rules:\n${global}`);
  const ent = db.getEntity(entityId);
  if (ent?.aiContext?.trim()) parts.push(`About this client:\n${ent.aiContext.trim()}`);
  // Personalize by the reader's ROLE at this client: lead with what matters to
  // them (marketing → demand/channels; finance → revenue/settlements; …). The
  // reader's own standing requests (tune, below) still win.
  const role = auth.roleForEntity(user, entityId);
  const lens = role && ROLE_LENSES[roles.lensForRole(role)];
  if (lens) parts.push(`This reader's role is ${roles.getRole(role).label}. Frame the briefing for them — ${lens.focus}`);
  const defaults = phaseDefaults();
  for (const su of suites) {
    const cfg = su.briefing || {};
    const ph = resolvePhase(cfg);
    const lines = [];
    if (ph.key) {
      const label = PHASES.find((p) => p.key === ph.key)?.label || ph.key;
      const text = (cfg.phaseOverrides?.[ph.key] || '').trim() || defaults[ph.key];
      lines.push(`Current phase: ${label}${cfg.eventStart ? ` (event ${cfg.eventStart}${cfg.eventEnd ? ` – ${cfg.eventEnd}` : ''})` : ''}. ${text}`);
    }
    if ((cfg.instructions || '').trim()) lines.push(cfg.instructions.trim());
    if (lines.length) parts.push(`For the event "${su.name}":\n${lines.join('\n')}`);
  }
  const tune = db.getUserPref(user.id, `briefing_tune:${entityId}`).trim();
  if (tune) parts.push(`This reader's standing requests — always honour these:\n${tune}`);
  return parts.join('\n\n');
}

// Catalogue + lead dashboards for a client's suites (cheap; no Looker).
function clientCatalogue(entityId) {
  const suites = db.listSuitesForEntity(entityId);
  const catalogue = [];
  const leads = []; // first top-level dashboard (+ its tabs) per set
  for (const su of suites) {
    for (const sid of su.setIds) {
      const set = db.getSet(sid);
      if (!set) continue;
      const entries = set.dashboards || [];
      const valid = new Set(entries.map((e) => e.id));
      const tops = entries.filter((e) => !e.parentId || !valid.has(e.parentId));
      for (const e of entries) {
        const d = store.get(e.id);
        if (d) catalogue.push({ dashboardId: d.id, title: d.title, setName: set.name, suiteId: su.id, suiteName: su.name });
      }
      const lead = tops[0];
      if (lead) leads.push({ suiteId: su.id, suiteName: su.name, setName: set.name, dashboardIds: [lead.id, ...entries.filter((e) => e.parentId === lead.id).map((e) => e.id)] });
    }
  }
  return { suites, catalogue, leads };
}

// Build a scoped query body for a tile within a dashboard. Mirrors the
// dashboard view exactly: each dashboard filter resolves to its default OR the
// suite's locked value (the Current-Event / Cashless locks), those flow through
// the tile's listenTo map, then the organiser scope is forced on. Without the
// suite locks, "Current Event" measures come back empty (the zeros bug).
// `lockMap` = db.lockedFiltersForSuite(suiteId) (entity + suite locks).
// Effective value per dashboard filter (suite lock wins over default), keyed
// by filter NAME — the shape the client's listenTo plumbing expects. Matching
// is case/whitespace-insensitive, mirroring the dashboard view.
// `overlay` (filter name → value) is the client's saved DEFAULT view for this
// dashboard — applied between the built-in default_value and the suite lock, so
// it overrides the narrow defaults (e.g. a management board's event filter) but
// a hard lock still wins.
function effectiveFilterValues(def, lockMap = {}, overlay = null) {
  const norm = {};
  for (const [k, v] of Object.entries(lockMap)) norm[k.trim().toLowerCase()] = v;
  const fv = {};
  for (const f of def.filters || []) {
    const field = (f.field || f.dimension || '').trim().toLowerCase();
    const nameKey = (f.name || '').trim().toLowerCase();
    let v = f.default_value || '';
    if (overlay && typeof overlay[f.name] === 'string') v = overlay[f.name];
    const locked = norm[nameKey] != null ? norm[nameKey] : (field ? norm[field] : undefined);
    if (locked != null && locked !== '') v = locked;
    fv[f.name] = v;
  }
  return fv;
}

// `extraOverrides` (queryField → value) are dashboard filters captured into a
// saved segment; they override the per-tile defaults. applyScope runs AFTER, so
// the forced organiser/entity scope always wins — a segment can't widen scope.
async function tileQueryBody(tile, def, user, suiteId, lockMap = {}, extraOverrides = {}) {
  const q = tile.query;
  if (tile.type === 'text' || !q?.model || !q?.view || !(q.fields || []).length) return null;
  const fv = effectiveFilterValues(def, lockMap);
  const overrides = {};
  for (const [filterName, queryField] of Object.entries(tile.listenTo || {})) {
    const v = fv[filterName];
    if (v && String(v).trim()) overrides[queryField] = String(v).trim();
  }
  const body = { ...q, filters: stripAnyValue({ ...(q.filters || {}), ...overrides, ...extraOverrides }) };
  if (!(await applyScope(body, user, suiteId))) return null;
  return body;
}

// First numeric value in a json_detail result (measures → table calcs → dims) —
// the days-before-event number a single-value source tile surfaces.
function firstNumberFromDetail(res) {
  const row = res?.data?.[0];
  if (!row) return null;
  const fields = [...(res.fields?.measures || []), ...(res.fields?.table_calculations || []), ...(res.fields?.dimensions || [])];
  for (const f of fields) {
    const v = row[f.name]?.value;
    if (v != null && v !== '' && !Number.isNaN(Number(v))) return Math.round(Number(v));
  }
  return null;
}

// Server mirror of ViewPage.applyDaysToGo: for a dashboard whose days-to-go sync
// is in APPLY mode, read the live days-before-event number from its source tile
// and return a { filterName: expr } overlay (e.g. { "Days Before": ">=42" }) so
// digest facts compare like-for-like to the same point in last year's cycle —
// matching what the dashboard shows. Returns null when there's no sync to apply
// (or the number can't be read), leaving the tile queries untouched.
async function daysBeforeOverlayFor(def, user, suiteId, lockMap) {
  const sync = def.daysBeforeSync;
  if (!sync || sync.mode !== 'apply' || !sync.sourceTileId || !sync.filterName) return null;
  const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
  const src = tiles.find((t) => t.id === sync.sourceTileId);
  if (!src?.query) return null;
  const body = await tileQueryBody(src, def, user, suiteId, lockMap);
  if (!body) return null;
  try {
    const data = await runLookerQuery('/queries/run/json_detail', body, undefined, false);
    const n = firstNumberFromDetail(data);
    if (n == null) return null;
    return { [sync.filterName]: String(sync.expr || '>={n}').replace('{n}', String(n)) };
  } catch { return null; }
}

// Cheap home data (no Looker): greeting context, browsing shortcuts, settlement
// teaser, dashboard catalogue. Called on every home load.
function buildLightSnapshot(user, entityId) {
  const entity = db.getEntity(entityId);
  if (!entity) return null;
  const { catalogue } = clientCatalogue(entityId);
  const prof = db.viewProfile(user.id);
  const byId = Object.fromEntries(catalogue.map((c) => [c.dashboardId, c]));
  const shortcuts = prof.top.filter((t) => byId[t.dashboardId]).map((t) => ({ ...t, ...byId[t.dashboardId] })).slice(0, 4);
  const latest = db.listSettlements({ entityIds: [entityId] })[0] || null;
  const fresh = latest && (Date.now() - new Date(latest.settlementDate || latest.createdAt).getTime()) < 60 * 864e5;

  // Pinned tiles render as REAL tiles on the home page: ship the tile def plus
  // the dashboard's effective filter values (defaults + suite locks) so the
  // client runs them exactly like the dashboard view would.
  const pinnedTiles = [];
  const lockCache = {};
  const viewCache = {}; // dashboardId -> client-default saved filter view
  for (const m of db.listMarks({ userId: user.id, entityId, kind: 'pin' })) {
    const meta = byId[m.dashboardId];
    const def = meta && store.get(m.dashboardId);
    if (!def) continue;
    const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
    const tile = tiles.find((t) => t.id === m.tileId);
    if (!tile || tile.type === 'text') continue;
    lockCache[meta.suiteId] = lockCache[meta.suiteId] || expandLockMap(db.lockedFiltersForSuite(meta.suiteId));
    if (!(def.id in viewCache)) viewCache[def.id] = db.getFilterView('entity', entityId, def.id);
    pinnedTiles.push({
      tile, suiteId: meta.suiteId, dashboardId: def.id, dashTitle: def.title, setName: meta.setName,
      filterValues: effectiveFilterValues(def, lockCache[meta.suiteId], viewCache[def.id]), scope: m.scope,
    });
  }
  // Apply the user's chosen pin order (pins not in the list fall to the end by
  // pin time), THEN cap — so a reordered pin can't be dropped by the cap.
  let pinOrder = [];
  try { pinOrder = JSON.parse(db.getUserPref(user.id, `pin_order:${entityId}`) || '[]'); } catch { pinOrder = []; }
  if (pinOrder.length) {
    const rank = (p) => { const i = pinOrder.indexOf(`${p.dashboardId}|${p.tile.id}`); return i === -1 ? Number.MAX_SAFE_INTEGER : i; };
    pinnedTiles.sort((a, b) => rank(a) - rank(b));
  }
  pinnedTiles.splice(8); // cap at 8 after ordering

  return {
    entity: { id: entity.id, name: entity.name },
    generatedAt: new Date().toISOString(),
    lastVisit: prof.lastVisit,
    shortcuts, catalogue, settlement: fresh ? latest : null,
    pinnedTiles,
  };
}

// Heavy facts for the briefing (Looker reads): pinned tiles first (always
// covered), then the lead dashboards' value/chart/table tiles, capped, with
// row-limited data. Bounded for scale + behind the briefing cache.
const FACT_MAX_TILES = 18;
// Within a dashboard, prefer the headline/cumulative tiles (Total sold, Gross
// revenue, Orders…) over noisy time-windowed ones (last hour, per-minute) that
// are often ~0 at digest time — so the briefing/digest leads with the numbers
// that matter, not whatever happens to sit first on the board.
const NOISY_TILE = /\b(last|current|this)\s*(hour|min(ute)?s?)\b|per\s*(minute|min|hour|sec)|\/\s*(min|hour|sec)\b|minute\s*10|real[-\s]?time|\blive\b/i;
const SUMMARY_TILE = /\b(total|gross|cumulative|overall|net|sold|revenue|orders?|sell[-\s]?through|attendance|to[-\s]?date|lifetime|ytd)\b/i;
function tilePriority(t) {
  const title = t.title || '';
  let s = 0;
  if (NOISY_TILE.test(title)) s += 100;   // pick later
  if (SUMMARY_TILE.test(title)) s -= 10;  // pick first
  return s;
}
async function buildFacts(user, entityId, force = false, alignDaysBefore = false, priorityDashboards = []) {
  const { catalogue } = clientCatalogue(entityId);
  const follows = db.listMarks({ userId: user.id, entityId, kind: 'follow' });
  const dashMeta = Object.fromEntries(catalogue.map((c) => [c.dashboardId, c]));
  const picks = []; // { tile, def, suiteId, setName, dashTitle, pinned }
  const seen = new Set();
  const addTile = (def, tile, suiteId, pinned) => {
    const sig = `${def.id}|${tile.id}`;
    if (seen.has(sig)) return;
    const meta = dashMeta[def.id];
    picks.push({ tile, def, suiteId: suiteId || meta?.suiteId, setName: meta?.setName || '', dashTitle: def.title, pinned: !!pinned });
    seen.add(sig);
  };
  // 1) Followed tiles — wherever they live — always make the cut.
  for (const p of follows) {
    const def = store.get(p.dashboardId);
    if (!def) continue;
    const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
    const tile = tiles.find((t) => t.id === p.tileId);
    if (tile) addTile(def, tile, dashMeta[def.id]?.suiteId, true);
  }
  // 1b) Explicit briefing focus tiles (reader-chosen, like a digest's curated
  //     tiles). tileId '*' = the whole dashboard. Prioritised like follows.
  let focus = [];
  try { focus = JSON.parse(db.getUserPref(user.id, `briefing_tiles:${entityId}`) || '[]'); } catch { focus = []; }
  for (const fsel of Array.isArray(focus) ? focus : []) {
    if (picks.length >= FACT_MAX_TILES) break;
    const def = store.get(fsel.dashboardId);
    if (!def || !dashMeta[def.id]) continue; // must be in this client's catalogue
    const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
    const chosen = fsel.tileId === '*'
      ? tiles.filter((t) => t.type !== 'text' && t.query?.fields?.length)
      : tiles.filter((t) => t.id === fsel.tileId);
    for (const t of chosen) addTile(def, t, dashMeta[def.id]?.suiteId, true);
  }
  const PER_DASH = 4; // per-dashboard cap, shared by the priority seed + rotation fill
  // 1c) "Always include" dashboards (digest config) — their headline/cumulative
  //     tiles are guaranteed in, ahead of the rotation, so the boards that
  //     matter (e.g. ticketing, audience) are never crowded out by busier ones
  //     (e.g. GA4). Capped per dashboard like the rotation fill.
  for (const did of Array.isArray(priorityDashboards) ? priorityDashboards : []) {
    if (picks.length >= FACT_MAX_TILES) break;
    const def = store.get(did);
    if (!def || !dashMeta[did]) continue; // must be in this client's catalogue
    const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))]
      .filter((t) => t.type !== 'text' && t.query?.fields?.length)
      .sort((a, b) => tilePriority(a) - tilePriority(b));
    let taken = 0;
    for (const t of tiles) { if (taken >= PER_DASH || picks.length >= FACT_MAX_TILES) break; const before = picks.length; addTile(def, t, dashMeta[did]?.suiteId, true); if (picks.length > before) taken += 1; }
  }
  // 2) Fill from EVERY dashboard across the client's sets, round-robin so the
  //    budget spreads over the whole catalogue (Payments, Comps, Resale…)
  //    instead of the first dashboard eating it. A per-dashboard cap keeps any
  //    one dashboard from dominating, and a daily rotation offset starts the
  //    sweep at a different dashboard each day — so the briefing's coverage
  //    (and therefore its story) naturally varies day to day.
  const pools = [];
  const pooled = new Set();
  for (const c of catalogue) {
    if (pooled.has(c.dashboardId)) continue;
    pooled.add(c.dashboardId);
    const def = store.get(c.dashboardId);
    if (!def) continue;
    const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((t) => t.tiles || []))]
      .filter((t) => t.type !== 'text' && t.query?.fields?.length)
      .sort((a, b) => tilePriority(a) - tilePriority(b)); // headline/cumulative tiles first, noisy time-windowed last
    if (tiles.length) pools.push({ def, suiteId: c.suiteId, tiles, idx: 0, taken: 0 });
  }
  const offset = pools.length ? Math.floor(Date.now() / 864e5) % pools.length : 0;
  const rotated = [...pools.slice(offset), ...pools.slice(0, offset)];
  let progressed = true;
  while (picks.length < FACT_MAX_TILES && progressed) {
    progressed = false;
    for (const pool of rotated) {
      if (picks.length >= FACT_MAX_TILES) break;
      while (pool.idx < pool.tiles.length && pool.taken < PER_DASH) {
        const tile = pool.tiles[pool.idx++];
        const before = picks.length;
        addTile(pool.def, tile, pool.suiteId, false);
        if (picks.length > before) { pool.taken += 1; progressed = true; break; }
      }
    }
  }

  // Suite locked filters (Current Event / Cashless) per suite, resolved once
  // and expanded so name-keyed locks also match by field.
  const lockMaps = {};
  for (const p of picks) if (p.suiteId && !(p.suiteId in lockMaps)) lockMaps[p.suiteId] = expandLockMap(db.lockedFiltersForSuite(p.suiteId));
  // Client-default saved filters per dashboard (e.g. a management board with the
  // event filter cleared) — so briefing facts match what the dashboard shows
  // instead of dying on the narrow built-in defaults. Mapped name→query field
  // via each tile's listenTo (ANY_VALUE rides through, dropped by stripAnyValue).
  const entityViews = {};
  for (const p of picks) if (!(p.def.id in entityViews)) entityViews[p.def.id] = db.getFilterView('entity', entityId, p.def.id) || null;
  // Days-to-go alignment (opt-in): per dashboard with a days-before sync in apply
  // mode, resolve { filterName: expr } once and layer it onto each tile's query.
  const daysBeforeOverlays = {};
  if (alignDaysBefore) for (const p of picks) if (!(p.def.id in daysBeforeOverlays)) daysBeforeOverlays[p.def.id] = await daysBeforeOverlayFor(p.def, user, p.suiteId, lockMaps[p.suiteId] || {});

  const dropped = []; // tiles excluded from the facts, with the reason (logged below)
  const tiles = (await Promise.all(picks.slice(0, FACT_MAX_TILES).map(async (p) => {
    const view = entityViews[p.def.id];
    const extra = {};
    if (view) for (const [fname, qfield] of Object.entries(p.tile.listenTo || {})) if (fname in view) extra[qfield] = view[fname];
    const dbo = daysBeforeOverlays[p.def.id];
    if (dbo) for (const [fname, qfield] of Object.entries(p.tile.listenTo || {})) if (fname in dbo) extra[qfield] = dbo[fname];
    const body = await tileQueryBody(p.tile, p.def, user, p.suiteId, lockMaps[p.suiteId] || {}, extra);
    if (!body) { dropped.push(`${p.dashTitle} › ${p.tile.title || '?'} (scope blocked / unrunnable)`); return null; }
    try {
      const data = await runLookerQuery('/queries/run/json_detail', body, undefined, force);
      if (!data?.data?.length) { dropped.push(`${p.dashTitle} › ${p.tile.title || '?'} (no rows for the default filters)`); return null; }
      return {
        title: p.tile.title || '(untitled)', visType: p.tile.vis?.type, context: p.tile.aiContext || '',
        fields: data.fields, rows: data.data, filters: body.filters || {},
        dashboardId: p.def.id, suiteId: p.suiteId, setName: p.setName, dashTitle: p.dashTitle, pinned: p.pinned,
      };
    } catch (e) { dropped.push(`${p.dashTitle} › ${p.tile.title || '?'} (error: ${e.message})`); return null; }
  }))).filter(Boolean);

  // Why a dashboard might be missing from a briefing/digest: tiles drop when the
  // explore can't be scoped, or the query returns no rows. Log it so it's not a
  // mystery (visible in the server logs when a digest is built/tested).
  if (dropped.length) console.warn(`[facts] entity=${entityId} kept ${tiles.length} tiles, dropped ${dropped.length}: ${dropped.slice(0, 25).join(' · ')}`);
  if (tiles.length) console.log(`[facts] entity=${entityId} dashboards in facts: ${[...new Set(tiles.map((t) => t.dashTitle))].join(' · ')}`);

  return { tiles, catalogue };
}

// In-memory caches: light snapshot (10 min) and briefing (6 h) per user+entity.
const snapCache = new Map();
const briefCache = new Map();
const cacheGet = (map, key, ttl) => { const e = map.get(key); return e && Date.now() - e.at < ttl ? e.val : null; };
const cachePut = (map, key, val) => { map.set(key, { at: Date.now(), val }); if (map.size > 500) map.delete(map.keys().next().value); };
const bustHome = (userId, entityId) => {
  const k = `${userId}:${entityId}`;
  snapCache.delete(k);
  for (const t of TIMES) briefCache.delete(`${k}:${t.key}`);
};

app.get('/api/my/snapshot', auth.requireAuth, (req, res) => {
  const entityId = homeEntityFor(req);
  if (!entityId) return res.json({ entity: null, shortcuts: [], catalogue: [], settlement: null, lastVisit: null });
  const key = `${req.user.id}:${entityId}`;
  if (!req.query.refresh) { const hit = cacheGet(snapCache, key, 10 * 60e3); if (hit) return res.json(hit); }
  try {
    const snap = buildLightSnapshot(req.user, entityId);
    if (!snap) return res.status(404).json({ error: 'Client not found' });
    cachePut(snapCache, key, snap);
    res.json(snap);
  } catch (err) {
    console.error('[GET /api/my/snapshot]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// The Owl's home briefing: reads pinned + lead-dashboard tile data, grounds the
// Owl in it, returns strict JSON with deep links validated against the catalogue.
// Extracted from the endpoint so the login/home PRE-WARM can generate it too,
// with in-flight de-duplication so the prewarm and the real request never do the
// same generation twice. Segmented by the reader's local time of day.
const briefInflight = new Map(); // key -> Promise
async function generateBriefing(user, entityId, segment, { force = false } = {}) {
  const apiKey = anthropicKeyForUser(user);
  if (!insights.isConfigured(apiKey)) return { available: false };
  const key = `${user.id}:${entityId}:${segment}`;
  if (!force) { const hit = cacheGet(briefCache, key, 6 * 3600e3); if (hit) return hit; }
  if (briefInflight.has(key)) return briefInflight.get(key); // coalesce concurrent (prewarm + real)
  const p = (async () => {
    const { tiles, catalogue } = await buildFacts(user, entityId, force);
    if (!tiles.length) return { available: false };
    const byId = Object.fromEntries(catalogue.map((c) => [c.dashboardId, c]));
    const prof = db.viewProfile(user.id);
    const profileForAi = {
      lastVisit: prof.lastVisit,
      top: prof.top.filter((t) => byId[t.dashboardId]).map((t) => ({ title: byId[t.dashboardId].title, count: t.count })),
    };
    const { suites } = clientCatalogue(entityId);
    const instructions = [aiInstructionsFor(null), briefingInstructionsFor(user, entityId, suites), timeDefaults()[segment]].filter(Boolean).join('\n\n');
    const msgs = recentMessages(entityId, user.id);
    const raw = await insights.briefHome({ tiles, profile: profileForAi, catalogue, instructions, apiKey, actions: actionsSummaryFor(entityId), messages: msgs, capabilities: ACTION_CAPABILITIES });
    const link = (id) => (id && byId[id] ? { dashboardId: id, suiteId: byId[id].suiteId, label: `${byId[id].setName} → ${byId[id].title}` } : null);
    const msgIds = new Set(msgs.map((m) => m.id));
    const out = {
      available: true,
      generatedAt: new Date().toISOString(),
      headline: String(raw.headline || '').slice(0, 600),
      bullets: (raw.bullets || []).slice(0, 4)
        .map((b) => ({ text: String(b.text || '').slice(0, 400), link: link(b.dashboardId), threadId: msgIds.has(b.threadId) ? b.threadId : null }))
        .filter((b) => b.text),
      suggestions: (raw.suggestions || []).slice(0, 3)
        .map((s) => ({ title: String(s.title || '').slice(0, 80), reason: String(s.reason || '').slice(0, 200), link: link(s.dashboardId), action: CAPABILITY_KEYS.has(s.action) ? s.action : null }))
        .filter((s) => s.title && s.link),
    };
    cachePut(briefCache, key, out);
    return out;
  })().finally(() => briefInflight.delete(key));
  briefInflight.set(key, p);
  return p;
}

app.get('/api/my/briefing', auth.requireAuth, async (req, res) => {
  const entityId = homeEntityFor(req);
  if (!entityId) return res.json({ available: false });
  try {
    const out = await generateBriefing(req.user, entityId, timeSegment(Number(req.query.hour)), { force: !!req.query.refresh });
    res.json(out);
  } catch (err) {
    console.error('[GET /api/my/briefing]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Pre-warm on home load: generate the briefing (coalesced) and run the top
// most-visited dashboards' tiles into the query cache, so the first click and
// the briefing of the session are warm. Fire-and-forget + bounded; queries
// dedupe via qInflight and match the dashboard view (entity-default filters),
// so real loads hit the cache. Warmed entries stay hot for the 30-min window.
function prewarmHome(user, entityId, segment) {
  generateBriefing(user, entityId, segment).catch(() => {});
  (async () => {
    try {
      const { catalogue } = clientCatalogue(entityId);
      const metaById = Object.fromEntries(catalogue.map((c) => [c.dashboardId, c]));
      const prof = db.viewProfile(user.id);
      const topIds = (prof.top || []).map((t) => t.dashboardId).filter((d) => metaById[d]).slice(0, 3);
      for (const did of topIds) {
        const meta = metaById[did];
        const def = store.get(did);
        if (!def) continue;
        const lockMap = expandLockMap(db.lockedFiltersForSuite(meta.suiteId));
        const view = db.getFilterView('entity', entityId, did);
        const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))]
          .filter((t) => t.type !== 'text' && t.query?.fields?.length).slice(0, 10);
        for (const tile of tiles) {
          const extra = {};
          if (view) for (const [fn, qf] of Object.entries(tile.listenTo || {})) if (fn in view) extra[qf] = view[fn];
          const body = await tileQueryBody(tile, def, user, meta.suiteId, lockMap, extra);
          if (body) runLookerQuery('/queries/run/json_detail', body).catch(() => {});
        }
      }
    } catch (e) { console.error('[prewarm]', e.message); }
  })();
}
app.post('/api/my/prewarm', auth.requireAuth, (req, res) => {
  const entityId = homeEntityFor(req);
  if (entityId) prewarmHome(req.user, entityId, timeSegment(Number(req.body?.hour)));
  res.json({ ok: true }); // never wait — warming happens in the background
});

// ─── Inventive: embedded conversational AI analyst (per-client workspaces) ─────
// We proxy Inventive's /embed/getAuthorizedUrl server-side so the API key never
// reaches the browser (their requirement). Each Pulse client (entity) maps to one
// Inventive workspace via accountScope.externalRefId = entityId. Config via env
// (or admin settings): INVENTIVE_API_KEY, INVENTIVE_EMBED_AUTH_TOKEN, optional
// INVENTIVE_API_ENDPOINT. Read/write "actions" bridge is NOT here (Inventive
// doesn't expose it yet) — this is the embed only.
const inventiveEndpoint = () => (db.getSetting('inventive_api_endpoint') || process.env.INVENTIVE_API_ENDPOINT || 'https://app-api.madeinventive.com').replace(/\/+$/, '');
const inventiveKey = () => (db.getSetting('inventive_api_key') || process.env.INVENTIVE_API_KEY || '').trim();
const inventiveEmbedToken = () => (db.getSetting('inventive_embed_auth_token') || process.env.INVENTIVE_EMBED_AUTH_TOKEN || '').trim();
const inventiveName = (email) => {
  const local = String(email || '').split('@')[0].replace(/[._-]+/g, ' ').trim();
  const parts = local.split(/\s+/).map((s) => s.charAt(0).toUpperCase() + s.slice(1));
  return { firstname: parts[0] || 'User', lastname: parts.slice(1).join(' ') };
};
app.get('/api/inventive/status', auth.requireAuth, (req, res) => {
  res.json({ configured: !!(inventiveKey() && inventiveEmbedToken()) });
});
app.post('/api/inventive/embed-url', auth.requireAuth, async (req, res) => {
  const key = inventiveKey(); const token = inventiveEmbedToken();
  if (!key || !token) return res.status(400).json({ error: 'Inventive is not configured yet.' });
  const entityId = homeEntityFor(req);
  if (!entityId) return res.status(400).json({ error: 'No client context for the AI workspace.' });
  const entity = db.getEntity(entityId);
  if (!entity) return res.status(404).json({ error: 'Client not found.' });
  const { firstname, lastname } = inventiveName(req.user.email);
  const userInfo = {
    firstname, lastname, email: req.user.email,
    // One Inventive workspace per Pulse client (entity).
    accountScope: { externalRefId: entity.id, name: entity.name, description: `${entity.name} · Pulse` },
  };
  try {
    const r = await fetch(`${inventiveEndpoint()}/embed/getAuthorizedUrl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'INVENTIVE-API-KEY': key },
      body: JSON.stringify({ embedAuthToken: token, userInfo, options: req.body?.options || {} }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('[inventive] getAuthorizedUrl', r.status, detail.slice(0, 300));
      return res.status(502).json({ error: 'Inventive rejected the request (check the user is provisioned and the host URL matches the embed token).' });
    }
    res.json(await r.json()); // { url, tokens, scopeToken, hostUrl }
  } catch (e) {
    console.error('[inventive] embed-url', e.message);
    res.status(502).json({ error: 'Could not reach Inventive.' });
  }
});

// ─── Scheduled digests: role-lensed content builder ────────────────────────────
// Default role "lenses" — what the analyst leads with for each audience. Editable
// per client later; the job may also carry a custom focus override.
const ROLE_LENSES = {
  exec: { label: 'Executive', focus: 'Overall event health, revenue vs target and pacing, margin, and the biggest risks & opportunities. Board-level and strategic; suggested actions are strategic decisions.' },
  marketing: { label: 'Marketing', focus: 'Demand and sales pace, channel/source performance, conversion, promo and campaign ROI, and audience mix. Tactical; suggested actions are marketing moves.' },
  finance: { label: 'Finance', focus: 'Revenue, fees and costs, settlements and reconciliation, refunds and cashflow. Precise and numbers-first; suggested actions are financial/operational.' },
  ops: { label: 'Operations', focus: 'Capacity and sell-through, entry/redemption and on-the-day readiness, staffing and logistics. Suggested actions are operational prep.' },
};

// Curated mode: fetch a specific set of tiles (by dashboard+tile id) instead of
// the round-robin sweep buildFacts does.
async function buildFactsFromTiles(user, entityId, picks, alignDaysBefore = false) {
  const { catalogue } = clientCatalogue(entityId);
  const meta = Object.fromEntries(catalogue.map((c) => [c.dashboardId, c]));
  // Resolve the picks into a concrete tile list. tileId '*' = the whole
  // dashboard (all its data tiles). Capped so a "whole dashboard" pick can't
  // blow the budget.
  const wanted = [];
  const seen = new Set();
  for (const p of picks || []) {
    const def = store.get(p.dashboardId);
    const m = meta[p.dashboardId];
    if (!def || !m) continue;
    const allTiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
    const chosen = p.tileId === '*'
      ? allTiles.filter((t) => t.type !== 'text' && t.query?.fields?.length)
      : allTiles.filter((t) => t.id === p.tileId);
    for (const tile of chosen) {
      const sig = `${def.id}|${tile.id}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      wanted.push({ tile, def, m });
    }
  }
  const lockMaps = {};
  const daysBeforeOverlays = {};
  const out = [];
  for (const { tile, def, m } of wanted.slice(0, 24)) {
    if (!(m.suiteId in lockMaps)) lockMaps[m.suiteId] = expandLockMap(db.lockedFiltersForSuite(m.suiteId));
    if (alignDaysBefore && !(def.id in daysBeforeOverlays)) daysBeforeOverlays[def.id] = await daysBeforeOverlayFor(def, user, m.suiteId, lockMaps[m.suiteId] || {});
    const dbo = daysBeforeOverlays[def.id];
    const extra = {};
    if (dbo) for (const [fname, qfield] of Object.entries(tile.listenTo || {})) if (fname in dbo) extra[qfield] = dbo[fname];
    const body = await tileQueryBody(tile, def, user, m.suiteId, lockMaps[m.suiteId] || {}, extra);
    if (!body) continue;
    try {
      const data = await runLookerQuery('/queries/run/json_detail', body, undefined, false);
      if (!data?.data?.length) continue;
      out.push({ title: tile.title || '(untitled)', visType: tile.vis?.type, context: tile.aiContext || '', fields: data.fields, rows: data.data, filters: body.filters || {}, dashboardId: def.id, suiteId: m.suiteId, setName: m.setName, dashTitle: def.title, pinned: false });
    } catch { /* skip tile on error */ }
  }
  return { tiles: out, catalogue };
}

// Produce a role-lensed digest's structured content (links resolved). Throws if
// AI/Looker isn't configured or there's no data — callers decide how to surface.
async function buildDigestContent({ entityId, role, roleFocus, focusMode, contentMode, tiles, alignDaysBefore = false, priorityDashboards = [], recipientEmail, debug = false }) {
  const apiKey = anthropicKeyForEntity(entityId);
  if (!insights.isConfigured(apiKey)) throw new Error('AI is not configured for this client');
  const lens = ROLE_LENSES[role] || ROLE_LENSES.exec;
  // Custom focus either OVERRIDES the role lens or BLENDS on top of it.
  const customFocus = String(roleFocus || '').trim();
  const effectiveFocus = !customFocus ? lens.focus
    : (focusMode === 'blend' ? `${lens.focus}\n\nExtra emphasis for this digest: ${customFocus}` : customFocus);
  let user = recipientEmail ? db.getUserByEmail(recipientEmail) : null;
  if (!user || !(user.entityIds || []).includes(entityId)) user = { id: `digest:${entityId}`, email: recipientEmail || '', role: 'client', entityIds: [entityId] };
  const { tiles: factTiles, catalogue } = (contentMode === 'curated' && (tiles || []).length)
    ? await buildFactsFromTiles(user, entityId, tiles, alignDaysBefore)
    : await buildFacts(user, entityId, false, alignDaysBefore, priorityDashboards);
  if (!factTiles.length) throw new Error('No tile data available to summarise');
  const byId = Object.fromEntries(catalogue.map((c) => [c.dashboardId, c]));
  const instructions = [aiInstructionsFor(null), briefingInstructionsFor(user, entityId, clientCatalogue(entityId).suites)].filter(Boolean).join('\n\n');
  const raw = await insights.digestBrief({ tiles: factTiles, roleLabel: lens.label, roleFocus: effectiveFocus, catalogue, instructions, apiKey, actions: actionsSummaryFor(entityId), capabilities: ACTION_CAPABILITIES });
  const href = (id) => { const c = id && byId[id]; return c ? `${mailer.baseUrl()}/suite/${c.suiteId}/d/${id}` : ''; };
  // A suggested action with an executable capability deep-links into the
  // pre-filled "Make it happen" campaign editor (recipe auto-resolves the
  // audience + copy); otherwise it links to the relevant dashboard.
  const actionHref = (a) => (CAPABILITY_KEYS.has(a.action)
    ? `${mailer.baseUrl()}/engage/campaigns?type=${encodeURIComponent(a.action)}&goal=${encodeURIComponent(String(a.text || '').slice(0, 200))}`
    : href(a.dashboardId));
  const out = {
    subject: String(raw.subject || '').slice(0, 120),
    headline: String(raw.headline || '').slice(0, 600),
    narrative: (raw.narrative || []).slice(0, 5).map((s) => String(s).slice(0, 800)).filter(Boolean),
    kpis: (raw.kpis || []).slice(0, 6).map((k) => ({ label: String(k.label || '').slice(0, 40), value: String(k.value || '').slice(0, 30), delta: String(k.delta || '').slice(0, 40), href: href(k.dashboardId) })).filter((k) => k.label && k.value),
    actions: (raw.actions || []).slice(0, 3).map((a) => ({ text: String(a.text || '').slice(0, 200), href: actionHref(a), action: CAPABILITY_KEYS.has(a.action) ? a.action : null })).filter((a) => a.text),
  };
  // Diagnostic: the exact tiles the analyst read + the value each returned under
  // the digest's scope — so a mismatch with the dashboard (wrong tile / missing
  // event lock) is visible at a glance. Only attached when explicitly requested.
  if (debug) out.facts = factTiles.map((t) => ({ dashTitle: t.dashTitle, setName: t.setName, title: t.title, value: factValueLabel(t), suiteName: byId[t.dashboardId]?.suiteName || '', filters: t.filters || {} }));
  return out;
}

// Best display value for a fact tile (first measure → table calc → dimension of
// the first row), preferring Looker's rendered string. Used by the digest
// facts inspector to show what each tile resolved to.
function factValueLabel(t) {
  const row = (t.rows || [])[0];
  if (!row) return '—';
  const fields = [...(t.fields?.measures || []), ...(t.fields?.table_calculations || []), ...(t.fields?.dimensions || [])];
  for (const f of fields) {
    const cell = row[f.name];
    if (cell && (cell.rendered != null || cell.value != null)) return String(cell.rendered != null ? cell.rendered : cell.value);
  }
  return '—';
}

// Selectable tiles per client, grouped by dashboard — drives the curated
// digest picker. Only data tiles (with fields, not text) can be chosen.
function digestTileCatalogue(entityId) {
  const { catalogue } = clientCatalogue(entityId);
  const dashboards = [];
  for (const c of catalogue) {
    const def = store.get(c.dashboardId);
    if (!def) continue;
    const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((x) => x.tiles || []))]
      .filter((t) => t.type !== 'text' && t.query?.fields?.length)
      .map((t) => ({ tileId: t.id, title: t.title || '(untitled)', visType: t.vis?.type || '' }));
    if (tiles.length) dashboards.push({ dashboardId: c.dashboardId, title: c.title, setName: c.setName, suiteName: c.suiteName, tiles });
  }
  return { dashboards };
}
app.get('/api/admin/entities/:id/digest-tiles', auth.requireAdmin, (req, res) => {
  if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
  res.json(digestTileCatalogue(req.params.id));
});
app.get('/api/my/digest-tiles/:entityId', auth.requireAuth, (req, res) => {
  if (!(req.user.entityIds || []).includes(req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
  res.json(digestTileCatalogue(req.params.entityId));
});

// Home message-card dismissals: per-user, so a handled message can be cleared
// off the home page without touching the inbox record.
app.get('/api/my/dismissed-threads', auth.requireAuth, (req, res) => {
  try { res.json({ dismissed: JSON.parse(db.getUserPref(req.user.id, 'home_dismissed') || '[]') }); }
  catch { res.json({ dismissed: [] }); }
});
app.post('/api/my/dismiss-thread', auth.requireAuth, (req, res) => {
  const tid = String((req.body || {}).threadId || '');
  if (!tid) return res.status(400).json({ error: 'threadId required' });
  let list = [];
  try { list = JSON.parse(db.getUserPref(req.user.id, 'home_dismissed') || '[]'); } catch { /* fresh */ }
  if (!list.includes(tid)) list.push(tid);
  db.setUserPref(req.user.id, 'home_dismissed', JSON.stringify(list.slice(-200)));
  res.json({ ok: true });
});

// Home-page strip: a client's recent actions + how they're performing.
app.get('/api/actions-summary/:entityId', auth.requireAuth, (req, res) => {
  const id = req.params.entityId;
  if (req.user.role !== 'admin' && !(req.user.entityIds || []).includes(id)) return res.status(403).json({ error: 'Not allowed' });
  res.json({ actions: actionsSummaryFor(id, 6), pendingApproval: pendingApprovalCount(id), awaitingMyApproval: actionsApi.awaitingApprovalFor(req.user, id), myOutcomes: actionsApi.unseenOutcomesFor(req.user, id) });
});

// Campaigns waiting for a human go-ahead: automation-queued drafts AND
// campaigns submitted for approval (status 'pending'). Drives the inbox badge.
function pendingApprovalCount(entityId) {
  try { return db.db.prepare("SELECT COUNT(*) n FROM actions WHERE entity_id=? AND ((status='draft' AND created_by='automation') OR status='pending')").get(entityId)?.n || 0; }
  catch { return 0; }
}

// SMS provider (Clickatell) config — write-only key (report set + mask only).
app.get('/api/admin/sms-config', auth.requireAdmin, (_req, res) => {
  const key = db.getSetting('clickatell_api_key') || '';
  res.json({ configured: !!key, keyHint: maskSecret(key), sender: db.getSetting('sms_sender', ''), endpoint: db.getSetting('clickatell_endpoint', '') });
});
app.put('/api/admin/sms-config', auth.requireAdmin, (req, res) => {
  const b = req.body || {};
  if (typeof b.apiKey === 'string' && b.apiKey.trim()) db.setSetting('clickatell_api_key', b.apiKey.trim()); // only overwrite when provided
  if ('sender' in b) db.setSetting('sms_sender', String(b.sender || '').slice(0, 40));
  if ('endpoint' in b) db.setSetting('clickatell_endpoint', String(b.endpoint || '').slice(0, 300));
  const key = db.getSetting('clickatell_api_key') || '';
  res.json({ configured: !!key, keyHint: maskSecret(key), sender: db.getSetting('sms_sender', ''), endpoint: db.getSetting('clickatell_endpoint', '') });
});
// Send a test SMS to a number (admin) — confirms the provider end to end.
app.post('/api/admin/sms-test', auth.requireAdmin, async (req, res) => {
  const to = String((req.body || {}).to || '').trim();
  if (!to) return res.status(400).json({ error: 'A phone number is required' });
  const r = await messaging.sendSms({ to, text: 'Howler : Pulse — SMS is connected ✓' });
  res.json(r);
});

// Platform notification settings (admin). Small allowlisted key/values.
app.get('/api/admin/notification-settings', auth.requireAdmin, (_req, res) => {
  res.json({ ackReminderHours: Number(db.getSetting('ack_reminder_hours', '12')) || 12 });
});
app.put('/api/admin/notification-settings', auth.requireAdmin, (req, res) => {
  let h = Number((req.body || {}).ackReminderHours);
  if (!Number.isFinite(h)) h = 12;
  h = Math.min(168, Math.max(1, Math.round(h))); // clamp 1h..7d
  db.setSetting('ack_reminder_hours', String(h));
  res.json({ ackReminderHours: h });
});

// ─── Action capabilities ────────────────────────────────────────────────────────
// What the Action Engine can actually EXECUTE today. The briefing/digest AI may
// only mark a suggestion as actionable ("Make it happen") with one of these
// keys — so the button never appears on suggestions we can't deliver. New
// executors (meta_ads, howler_writeback…) get added here and suggestions start
// lighting up automatically.
const ACTION_CAPABILITIES = [
  {
    key: 'email_campaign',
    label: 'Email campaign',
    description: 'Send a targeted, branded email campaign to a customer audience pulled from the data — e.g. re-engage abandoned-cart customers, nudge a ticket tier, announce to past buyers.',
  },
];
const CAPABILITY_KEYS = new Set(ACTION_CAPABILITIES.map((c) => c.key));

// ─── Action templates (recipes) ───────────────────────────────────────────────
const actionTemplates = require('./actionTemplates');
// Tile catalogue WITH field names — used to auto-resolve a template's audience
// source (which dashboard/tile + email/name/ticket columns) from a client's data.
function tileCatalogueWithFields(entityId) {
  const { catalogue } = clientCatalogue(entityId);
  const dashboards = [];
  for (const c of catalogue) {
    const def = store.get(c.dashboardId);
    if (!def) continue;
    const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((x) => x.tiles || []))]
      .filter((t) => t.type !== 'text' && t.query?.fields?.length)
      .map((t) => ({ tileId: t.id, title: t.title || '', fields: (t.query.fields || []).map(String) }));
    if (tiles.length) dashboards.push({ dashboardId: c.dashboardId, title: c.title, tiles });
  }
  return dashboards;
}
// The templates a client can run, each with its audience pre-resolved + presets.
function resolveActionTemplates(entityId) {
  const dashboards = tileCatalogueWithFields(entityId);
  return actionTemplates.list().map((meta) => {
    const t = actionTemplates.get(meta.key);
    const resolved = actionTemplates.resolveAudience(t, dashboards);
    return { ...meta, preset: t.preset, ready: resolved.ready, audience: resolved.ready ? { mode: 'tile', ...resolved } : { mode: 'tile' } };
  });
}
app.get('/api/action-templates/:entityId', auth.requireAuth, auth.requirePermission('campaigns.view'), (req, res) => {
  res.json({ templates: resolveActionTemplates(req.params.entityId) });
});

// Compact summary of a client's recent marketing actions (non-draft campaigns
// + results) — shown on the home page and fed to the briefing/digest AI so the
// analyst can comment on performance.
function actionsSummaryFor(entityId, limit = 5) {
  try {
    return db.db.prepare("SELECT id, title, status, config, results, approved_at FROM actions WHERE entity_id=? AND status != 'draft' ORDER BY approved_at DESC LIMIT ?")
      .all(entityId, limit).map((r) => {
        const results = JSON.parse(r.results || '{}');
        const cfg = JSON.parse(r.config || '{}');
        const clickers = db.db.prepare('SELECT COUNT(DISTINCT email) n FROM action_clicks WHERE action_id=? AND email != \'\'').get(r.id)?.n || 0;
        return {
          id: r.id, title: r.title || cfg.subject || 'Campaign', status: r.status, approvedAt: r.approved_at,
          sent: results.sent || 0, failed: results.failed || 0, total: results.total || 0,
          clicks: results.clicks || 0, uniqueClickers: clickers,
          ctr: (results.sent || 0) > 0 ? Math.round((clickers / results.sent) * 100) : 0,
        };
      });
  } catch { return []; }
}

// Recent Howler→client messages for an entity, with this user's read/ack state.
// Read-only peek into the OS spine; guarded so removing that module is safe.
function recentMessages(entityId, userId, limit = 6) {
  try {
    const threads = db.db.prepare('SELECT * FROM os_threads WHERE entity_id=? ORDER BY updated_at DESC LIMIT ?').all(entityId, limit);
    return threads.map((t) => {
      const last = db.db.prepare('SELECT * FROM os_messages WHERE thread_id=? ORDER BY created_at DESC LIMIT 1').get(t.id);
      const acked = !!db.db.prepare("SELECT 1 FROM os_receipts WHERE thread_id=? AND user_id=? AND kind='ack'").get(t.id, userId);
      const readRow = db.db.prepare("SELECT at FROM os_receipts WHERE thread_id=? AND user_id=? AND kind='read'").get(t.id, userId);
      const unread = !readRow || (last && readRow.at < last.created_at);
      return { id: t.id, title: t.title || '(no subject)', priority: t.priority, status: t.status, preview: (last?.body || '').slice(0, 180), fromHowler: last?.author_type === 'howler', unread, acked, at: t.updated_at };
    });
  } catch { return []; }
}

// Scheduler — recurring/one-off digest jobs (own table + routes). Mounted here,
// after its content builder + role lenses exist. Remove this line + scheduler.js
// to uninstall. The 60s tick lives inside the module.
require('./scheduler').mount(app, { db, auth, mailer, messaging, push, generateContent: buildDigestContent, roleLenses: ROLE_LENSES });

// Action Engine — suggested actions → executed automations (v1: email campaigns,
// e.g. abandoned cart). Audience = a dashboard tile's query, run with the SAME
// organiser scoping as the dashboards themselves. Remove this line + actions.js
// to uninstall.
const actionsApi = require('./actions').mount(app, {
  db, auth, mailer, push, messaging, os,
  // Run a tile's query (scoped + suite-locked) and return its rows + fields —
  // the campaign audience source.
  resolveAudience: async ({ entityId, dashboardId, tileId, user, filterOverrides = {} }) => {
    const { catalogue } = clientCatalogue(entityId);
    const meta = catalogue.find((c) => c.dashboardId === dashboardId);
    const def = store.get(dashboardId);
    if (!meta || !def) throw new Error('That dashboard is not available for this client');
    const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
    const tile = tiles.find((t) => t.id === tileId);
    if (!tile) throw new Error('Tile not found on that dashboard');
    const lockMap = expandLockMap(db.lockedFiltersForSuite(meta.suiteId));
    const qBody = await tileQueryBody(tile, def, user, meta.suiteId, lockMap, filterOverrides);
    if (!qBody) throw new Error('No data access for that tile');
    const data = await runLookerQuery('/queries/run/json_detail', { ...qBody, limit: '5000' }, undefined, true);
    const fields = [...(data.fields?.dimensions || []), ...(data.fields?.measures || []), ...(data.fields?.table_calculations || [])]
      .map((f) => ({ name: f.name, label: f.label_short || f.label }));
    return { rows: data.data || [], fields };
  },
  // The client's events (suites) — for optionally linking a campaign to one.
  listEvents: (entityId) => db.listSuitesForEntity(entityId).map((s) => ({ id: s.id, name: s.name, url: s.eventUrl || '' })),
  // AI-draft campaign copy, grounded in the client's context.
  draftCopy: async ({ entityId, goal, audienceCount }) => {
    const apiKey = anthropicKeyForEntity(entityId);
    if (!insights.isConfigured(apiKey)) throw new Error('AI is not configured for this client');
    const ent = db.getEntity(entityId);
    return insights.draftCampaign({ goal, clientName: ent?.name, clientContext: ent?.aiContext || '', audienceCount, instructions: aiInstructionsFor(null), apiKey });
  },
});

// Segments — reusable live audiences. Reuses the campaign engine's audience
// resolver (audienceFor) so resolution logic + the org-scope boundary are shared.
const segmentsApi = require('./segments').mount(app, {
  db, auth, resolveAudience: actionsApi.audienceFor,
  // Materialise a built-in recipe (e.g. abandoned cart) as a real segment by
  // auto-resolving its audience source from this client's data.
  resolveRecipe: (entityId, key) => {
    const t = actionTemplates.get(key);
    if (!t) return null;
    const resolved = actionTemplates.resolveAudience(t, tileCatalogueWithFields(entityId));
    if (!resolved.ready) return null;
    return {
      name: t.category || t.label,
      definition: {
        mode: 'tile', dashboardId: resolved.dashboardId, tileId: resolved.tileId,
        emailField: resolved.emailField, nameField: resolved.nameField || '',
        ticketField: resolved.ticketField || '', emailConsentField: resolved.consentField || '',
      },
    };
  },
});

// ─── Briefing configuration ─────────────────────────────────────────────────────
// Admin: global briefing rules + editable phase defaults.
app.get('/api/admin/briefing-settings', auth.requireAdmin, (_req, res) => {
  res.json({
    instructions: db.getSetting('briefing_instructions'),
    phases: PHASES, phaseDefaults: phaseDefaults(), builtIn: PHASE_DEFAULTS,
    times: TIMES, timeDefaults: timeDefaults(), builtInTimes: TIME_DEFAULTS,
  });
});
app.put('/api/admin/briefing-settings', auth.requireAdmin, (req, res) => {
  const { instructions, phaseDefaults: pd, timeDefaults: td } = req.body || {};
  if (instructions !== undefined) db.setSetting('briefing_instructions', instructions || '');
  if (pd && typeof pd === 'object') {
    const clean = {};
    for (const p of PHASES) if (typeof pd[p.key] === 'string') clean[p.key] = pd[p.key].slice(0, 2000);
    db.setSetting('briefing_phase_defaults', JSON.stringify(clean));
  }
  if (td && typeof td === 'object') {
    const clean = {};
    for (const t of TIMES) if (typeof td[t.key] === 'string') clean[t.key] = td[t.key].slice(0, 2000);
    db.setSetting('briefing_time_defaults', JSON.stringify(clean));
  }
  briefCache.clear();
  res.json({ instructions: db.getSetting('briefing_instructions'), phases: PHASES, phaseDefaults: phaseDefaults(), times: TIMES, timeDefaults: timeDefaults() });
});

// Client (and admin): per-event briefing config — dates, phase override,
// event instructions, per-phase overrides — plus their personal tune text.
app.get('/api/my/briefing-config', auth.requireAuth, (req, res) => {
  const entityId = homeEntityFor(req);
  if (!entityId) return res.json({ suites: [], phases: PHASES, phaseDefaults: phaseDefaults(), tune: '' });
  const suites = db.listSuitesForEntity(entityId).map((su) => ({
    id: su.id, name: su.name, briefing: su.briefing || {}, phase: resolvePhase(su.briefing || {}),
  }));
  let tiles = [];
  try { tiles = JSON.parse(db.getUserPref(req.user.id, `briefing_tiles:${entityId}`) || '[]'); } catch { tiles = []; }
  res.json({ suites, phases: PHASES, phaseDefaults: phaseDefaults(), tune: db.getUserPref(req.user.id, `briefing_tune:${entityId}`), tiles });
});
app.put('/api/my/briefing-config/suite/:id', auth.requireAuth, (req, res) => {
  if (!auth.canAccessSuite(req.user, req.params.id)) return res.status(403).json({ error: 'Not allowed' });
  const su = db.getSuite(req.params.id);
  if (!su) return res.status(404).json({ error: 'Suite not found' });
  const b = req.body || {};
  const cfg = {
    launchDate: String(b.launchDate || '').slice(0, 10),
    eventStart: String(b.eventStart || '').slice(0, 10),
    eventEnd: String(b.eventEnd || '').slice(0, 10),
    manualPhase: PHASES.some((p) => p.key === b.manualPhase) ? b.manualPhase : 'auto',
    instructions: String(b.instructions || '').slice(0, 2000),
    phaseOverrides: {},
  };
  if (b.phaseOverrides && typeof b.phaseOverrides === 'object') {
    for (const p of PHASES) if (typeof b.phaseOverrides[p.key] === 'string' && b.phaseOverrides[p.key].trim()) cfg.phaseOverrides[p.key] = b.phaseOverrides[p.key].slice(0, 2000);
  }
  const updated = db.updateSuite(su.id, { briefing: cfg });
  briefCache.clear(); // next briefing for anyone on this client reflects it
  res.json({ id: updated.id, briefing: updated.briefing, phase: resolvePhase(updated.briefing) });
});
// Sharpen a short instruction note (briefing focus, digest intro) with AI —
// shared by the briefing tuner and the digest editor. Returns improved text.
app.post('/api/my/refine-text', auth.requireAuth, async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Nothing to refine yet — write a note first.' });
  if (text.length > 4000) return res.status(400).json({ error: 'That note is too long to refine.' });
  const entityId = req.body?.entityId || homeEntityFor(req);
  if (entityId && req.user.role !== 'admin' && !(req.user.entityIds || []).includes(entityId)) return res.status(403).json({ error: 'Not allowed' });
  const apiKey = anthropicKeyForEntity(entityId);
  if (!insights.isConfigured(apiKey)) return res.status(400).json({ error: 'AI is not configured for this client.' });
  try {
    const refined = await insights.refineText({ text, purpose: String(req.body?.purpose || '').slice(0, 120), instructions: aiInstructionsFor(null), apiKey });
    res.json({ text: refined });
  } catch (e) { console.error('[POST /api/my/refine-text]', e.message); res.status(500).json({ error: e.message }); }
});
app.put('/api/my/briefing-tune', auth.requireAuth, (req, res) => {
  const entityId = homeEntityFor(req);
  if (!entityId) return res.status(400).json({ error: 'No client context' });
  const body = req.body || {};
  db.setUserPref(req.user.id, `briefing_tune:${entityId}`, String(body.tune || '').slice(0, 1500));
  // Focus tiles (reader-chosen dashboards/tiles to always feed the briefing).
  if (Array.isArray(body.tiles)) {
    const tiles = body.tiles.slice(0, 40)
      .filter((t) => t && t.dashboardId && t.tileId)
      .map((t) => ({ dashboardId: String(t.dashboardId), tileId: String(t.tileId) }));
    db.setUserPref(req.user.id, `briefing_tiles:${entityId}`, JSON.stringify(tiles));
  }
  bustHome(req.user.id, entityId);
  let tiles = [];
  try { tiles = JSON.parse(db.getUserPref(req.user.id, `briefing_tiles:${entityId}`) || '[]'); } catch { tiles = []; }
  res.json({ tune: db.getUserPref(req.user.id, `briefing_tune:${entityId}`), tiles });
});

// ─── Share links ─────────────────────────────────────────────────────────────
// Mint a short link to a dashboard + the sender's current filters. Never an
// auth bypass: /s/:token just redirects; the dashboard route still requires
// login and applies organiser scoping to the recipient.
app.post('/api/share', auth.requireAuth, (req, res) => {
  const { suiteId, dashboardId, filters } = req.body || {};
  const def = store.get(dashboardId);
  if (!def) return res.status(404).json({ error: 'Dashboard not found' });
  if (!auth.canAccessDashboard(req.user, def)) return res.status(403).json({ error: 'Not allowed' });
  if (suiteId && !auth.canAccessSuite(req.user, suiteId)) return res.status(403).json({ error: 'Not allowed' });
  const clean = {};
  for (const [k, v] of Object.entries(filters || {})) {
    if (typeof v === 'string' && v.trim() !== '') clean[String(k).slice(0, 120)] = v.slice(0, 300);
  }
  const token = db.createShareLink({ suiteId: suiteId || '', dashboardId, filters: clean, createdBy: req.user.email });
  res.status(201).json({ token, path: `/s/${token}` });
});
// Resolve a share token → redirect to the dashboard with filters in the URL.
// No auth needed for the translation; if the visitor isn't logged in, the SPA
// shows login and (URL preserved) lands them on the dashboard afterwards.
app.get('/s/:token', (req, res) => {
  const link = db.getShareLink(req.params.token);
  if (!link) return res.redirect('/');
  const qs = Object.keys(link.filters || {}).length ? `?f=${encodeURIComponent(JSON.stringify(link.filters))}` : '';
  const target = link.suiteId ? `/suite/${link.suiteId}/d/${link.dashboardId}${qs}` : `/d/${link.dashboardId}${qs}`;
  res.redirect(target);
});

// ─── Briefing feedback ───────────────────────────────────────────────────────
// like / dislike (+comment) / investigate (asks Howler to dig into the data).
// The client snapshots the briefing it reacted to.
app.post('/api/my/briefing-feedback', auth.requireAuth, (req, res) => {
  const { kind, comment, briefing } = req.body || {};
  const entityId = homeEntityFor(req);
  const id = db.addBriefingFeedback({
    userId: req.user.id, userEmail: req.user.email, entityId: entityId || '',
    kind, comment,
    briefing: {
      headline: String(briefing?.headline || '').slice(0, 600),
      bullets: (briefing?.bullets || []).slice(0, 6).map((b) => String(b).slice(0, 400)),
      generatedAt: briefing?.generatedAt || null,
    },
  });
  res.status(201).json({ id });
});
app.get('/api/admin/briefing-feedback', auth.requireAdmin, (_req, res) => {
  res.json(db.listBriefingFeedback().map((f) => ({ ...f, entityName: f.entityId ? (db.getEntity(f.entityId)?.name || '') : '' })));
});
app.put('/api/admin/briefing-feedback/:id', auth.requireAdmin, (req, res) => {
  db.setBriefingFeedbackStatus(req.params.id, (req.body || {}).status);
  res.json({ ok: true });
});

// ─── Tile marks: 📌 pin (show on home) & follow (briefing steering) ─────────────
// Promoters mark for themselves ('user' scope); admins in client preview set
// entity-wide defaults. A user sees the union of both.
function marksFor(req, entityId) {
  if (!entityId) return { pins: [], follows: [] };
  return {
    pins: db.listMarks({ userId: req.user.id, entityId, kind: 'pin' }),
    follows: db.listMarks({ userId: req.user.id, entityId, kind: 'follow' }),
  };
}
app.get('/api/my/pins', auth.requireAuth, (req, res) => {
  res.json(marksFor(req, homeEntityFor(req)));
});
// Persist the user's preferred pinned-tile order (keys "dashboardId|tileId").
app.put('/api/my/pin-order', auth.requireAuth, (req, res) => {
  const entityId = req.body?.entityId || homeEntityFor(req);
  if (!entityId) return res.status(400).json({ error: 'No client context' });
  const order = Array.isArray(req.body?.order) ? req.body.order.slice(0, 50).map(String) : [];
  db.setUserPref(req.user.id, `pin_order:${entityId}`, JSON.stringify(order));
  bustHome(req.user.id, entityId);
  res.json({ ok: true });
});
app.post('/api/my/pins', auth.requireAuth, (req, res) => {
  const { dashboardId, tileId, kind, scope } = req.body || {};
  const on = req.body?.on ?? req.body?.pinned;
  if (!dashboardId || !tileId) return res.status(400).json({ error: 'dashboardId and tileId required' });
  const def = store.get(dashboardId);
  if (!def || !auth.canAccessDashboard(req.user, def)) return res.status(403).json({ error: 'Not allowed' });
  const useEntity = scope === 'entity' && req.user.role === 'admin';
  const entityId = homeEntityFor(req);
  if (useEntity) {
    if (!entityId) return res.status(400).json({ error: 'entityId required for an entity mark' });
    db.setMark('entity', entityId, dashboardId, tileId, kind, !!on);
  } else {
    db.setMark('user', req.user.id, dashboardId, tileId, kind, !!on);
  }
  if (entityId) bustHome(req.user.id, entityId); // next home load reflects it
  res.json(marksFor(req, entityId));
});

// ─── Tile library (admin) ──────────────────────────────────────────────────────
// A catalogue of reusable tiles harvested from imported dashboards. Admins
// curate the labels; the editor stamps copies into new dashboards.
app.get('/api/admin/library', auth.requireAdmin, (req, res) => {
  res.json({
    tiles: db.listLibraryTiles({ search: req.query.search, category: req.query.category }),
    categories: db.listLibraryCategories(),
    aiEnabled: insights.isConfigured(adminAnthropicKey()),
  });
});
app.get('/api/admin/library/:id', auth.requireAdmin, (req, res) => {
  const t = db.getLibraryTile(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  res.json(t);
});
app.put('/api/admin/library/:id', auth.requireAdmin, (req, res) => {
  const t = db.updateLibraryTile(req.params.id, req.body || {});
  if (!t) return res.status(404).json({ error: 'Not found' });
  res.json(t);
});
app.delete('/api/admin/library/:id', auth.requireAdmin, (req, res) => {
  res.status(db.deleteLibraryTile(req.params.id) ? 204 : 404).end();
});
// Record that a library tile was used (stamped into a dashboard).
app.post('/api/admin/library/:id/use', auth.requireAdmin, (req, res) => {
  db.bumpLibraryUsage(req.params.id); res.json({ ok: true });
});
// Backfill: harvest tiles from every existing dashboard into the library.
app.post('/api/admin/library/backfill', auth.requireAdmin, (_req, res) => {
  let added = 0, scanned = 0;
  for (const d of store.list()) {
    const def = store.get(d.id);
    if (!def) continue;
    scanned++;
    try { added += db.harvestDashboardTiles(def, { sourceDashboardId: d.id }); } catch (e) { console.error('[backfill]', e.message); }
  }
  res.json({ scanned, added });
});
// AI-describe one library tile (label + description + category).
app.post('/api/admin/library/:id/describe', auth.requireAdmin, async (req, res) => {
  const t = db.getLibraryTile(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (!insights.isConfigured(adminAnthropicKey())) return res.status(400).json({ error: 'AI is not configured (set an Anthropic key in Admin → Integrations).' });
  try {
    const out = await insights.describeTile({
      title: t.name, visType: t.visType, fields: (t.def.query?.fields || []),
      model: t.model, explore: t.explore, instructions: db.getSetting('ai_instructions'), apiKey: adminAnthropicKey(),
    });
    const saved = db.updateLibraryTile(t.id, {
      name: out.name || t.name,
      description: out.description || t.description,
      category: out.category || t.category,
    });
    res.json(saved);
  } catch (err) {
    console.error('[POST /api/admin/library/:id/describe]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Live Looker dashboard ops (admin) ─────────────────────────────────────────
app.get('/api/looker-dashboard/:id', auth.requireAdmin, async (req, res) => {
  try {
    const data = await fetchDashboard(req.params.id);
    res.json({
      id: data.dashboard.id, title: data.dashboard.title,
      folder: data.dashboard.folder?.name || null,
      tileCount: data.elements.length, filterCount: data.filters.length,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/recreate', auth.requireAdmin, async (req, res) => {
  const { sourceDashboardId, newTitle, targetFolderId } = req.body;
  if (!sourceDashboardId || !newTitle || !targetFolderId) {
    return res.status(400).json({ error: 'sourceDashboardId, newTitle, and targetFolderId are required' });
  }
  try {
    const source = await fetchDashboard(sourceDashboardId);
    res.json(await recreateDashboard(source, newTitle, targetFolderId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SPA fallback ───────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(staticDir, 'index.html'));
});

const PORT = process.env.PORT || 3045;
app.listen(PORT, () => {
  console.log(`Howler Looker Tool running on http://localhost:${PORT}`);
  console.log(`Looker instance: ${looker.lookerBaseUrl() || '(not configured — set in Admin → Integrations)'}`);
});
