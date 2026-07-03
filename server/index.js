require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
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
const { asyncHandler, errorMiddleware } = require('./http'); const mailer = require('./mailer');
const currency = require('./currency'); const language = require('./language'); const messaging = require('./messaging');
const rateLimit = require('./ratelimit');
// Query & scope engine (shared library): the single place Looker queries run and
// the per-client organiser scope is enforced. Lifted out of this file; behaviour
// unchanged. See server/query.js.
const query = require('./query')({ looker, auth });
const {
  runLookerQuery, applyScope, stripAnyValue, ANY_VALUE, currentFirstEventSort,
  cleanFilterMap, expandLockMap, effectiveFilterValues, tileQueryBody, daysBeforeOverlayFor,
  primaryTileValue,
} = query;
// Shared scoped tile readers ("the number a tile shows") — lifted out of this
// file into server/tileValues.js; used by goals, alerts, pulse, the Owl and the
// public API surface. Must sit above the first consumer (the Owl tools provider).
const { resolveTileValue, resolveTileRows, resolveTileSeries, resolveTileSeriesAll, resolveEventDate } = require('./tileValues')({ db, query });
// Briefing/digest fact + phase engine (deterministic, AI-free) — lifted out of
// this file into server/briefing.js; behaviour unchanged. Needs db, store and
// the query engine. The AI-generation layer that sits on top stays here.
const {
  PHASES, PHASE_DEFAULTS, resolvePhase, phaseDefaults, TIMES, TIME_DEFAULTS, timeSegment, timeDefaults,
  clientCatalogue, buildLightSnapshot, FACT_MAX_TILES, NOISY_TILE, SUMMARY_TILE, tilePriority,
  BRIEF_CATS, briefingCats, buildFacts, todayLabel, buildFactsFromTiles,
} = require('./briefing')({ db, store, query });

const app = express();

// Safety net: a rejected promise that nothing awaited (the "never throws"
// convention in the integration modules is load-bearing but not guaranteed) is
// logged instead of crashing this single instance. We do NOT add an
// uncaughtException handler — Node's default crash-on-uncaught is the safe
// behaviour there (the platform restarts; SQLite is on a persistent disk).
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', (reason && reason.stack) || reason);
  // Raise ops (throttled) — these used to die invisibly in the log stream.
  try { require('./ops').alert('process', `unhandledRejection: ${(reason && reason.message) || reason}`); } catch { /* never crash the net */ }
});

// Behind a reverse proxy (Caddy/Nginx) in production so Secure cookies + the
// real client IP/protocol are honoured.
if (process.env.NODE_ENV === 'production' || process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
// Security headers (dependency-free, helmet essentials): frame-ancestors 'self' — cross-origin framing (clickjacking) stays blocked,
// SELF-framing allowed for the admin /split view's two same-origin panes. Plus nosniff, Referrer-Policy, HSTS in prod. Full CSP deferred.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Content-Security-Policy', "frame-ancestors 'self'");
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
// Global JSON parser at a modest limit, EXCEPT routes that take large bodies
// (backup import, settlement PDF uploads) — those parse themselves with a
// higher limit.
const jsonParser = express.json({ limit: '5mb' });
const parsesOwnBody = (p) => p === '/api/admin/import' || p.startsWith('/api/admin/settlements') || p.startsWith('/api/admin/documents')
  // OS messenger attachment payloads (base64) need a bigger limit — os.js parses these itself.
  || /^\/api\/os\/threads\/[^/]+\/messages$/.test(p) || p === '/api/os/admin/announce'
  // Inbound email may carry attachment PDFs (base64) — os.js parses it with a bigger limit.
  // Bug reports can carry a screenshot/image/video (base64) — tickets.js parses that too.
  || p === '/api/inbound/email' || p === '/api/my/tickets' || p === '/api/github/webhook';
app.use((req, res, next) => (parsesOwnBody(req.path) ? next() : jsonParser(req, res, next)));
// API responses are personal and live (suites, branding, icons…). Without an
// explicit header some browsers (Safari especially) heuristically cache GETs,
// so edits like a suite's event logo look "stuck". Cacheable assets
// (/mail-assets, built /assets) set their own headers and live outside /api.
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(cookieParser());
app.use(auth.attachUser);
// User action audit — logs every meaningful state-changing request (+ a few
// deliberate views) for Admin → Users. Mounted here so it sees req.user and wraps
// every route registered below. Disposable: remove this line + server/audit.js.
require('./audit').mount(app, { db });
// Internal ops alerts (Howler Slack) — background failures raise a human instead
// of dying in the log stream. Disposable: remove these lines + server/ops.js.
const ops = require('./ops'); ops.init({ db });
// Nightly DB snapshots + off-box copy (R2/S3) — DR floor → server/backup.js.
require('./backup').mount(app, { db, auth, notifyOps: (msg) => ops.alert('backup', msg) });

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
// Apply any version-controlled release-notes seed (authored at source; prod has no
// git history to summarise). Idempotent — each entry is applied exactly once.
require('./releaseNotesSeed').applySeed(db);
// Outbound email (Resend) — disposable module; senders no-op when unconfigured.
mailer.init({ db, notifyOps: (m) => ops.alert('mailer', m) });
// SMS (Clickatell One API) — second channel; no-ops when unconfigured.
messaging.init({ db });
// Meta (FB/IG) audience-sync — push a segment to a Custom Audience; per-client.
const meta = require('./meta');
meta.init({ db });
// TikTok audience-sync — same pattern as Meta; per-client pasted token.
const tiktok = require('./tiktok');
tiktok.init({ db });
const slack = require('./slack').mount(app, { db, auth, mailer }); // OUTBOUND — mirror inbox notifications into a client's Slack (+ test/share routes)
// Social metrics INBOUND — pull organic FB/IG/TikTok stats into Pulse (the read
// direction; reuses the meta/tiktok tokens + extra asset ids). Daily sync started
// after the app is up (see startDailySync below).
const socialMetrics = require('./socialMetrics');
socialMetrics.init({ db }); const metaAds = require('./metaAds').mount(app, { db, auth, meta }); require('./metaConnect').mount(app, { db, auth }); // Meta PAID performance inbound (deep Meta P1) + "Continue with Facebook" OAuth connect (writes the same metaAccessToken/metaAdAccountId fields)
// Web Push — installable-app notifications (disposable module, own table +
// routes under /api/push, kill switch `push_enabled`). Mounted before os so the
// comms spine can push alongside email.
const push = require('./push');
push.mount(app, { db, auth }); require('./reportingTz').mount(app, { db, auth }); // per-client reporting timezone (dual-surface) — makes relative date filters ("today") resolve on the client's local day
// Owl auto-ingest — settlements/invoices that arrive by CC-the-Owl email
// (disposable module; no tables/routes of its own). Triggered by the os inbound
// hook below. Safe by default: does nothing unless the sender is on the allowlist
// and the kill-switch is on.
const owlIngest = require('./owlIngest').mount({ db, insights, anthropicKeyForEntity });
// Experience OS comms spine — self-contained module (own tables + routes under
// /api/os). Remove this line + server/os.js to fully uninstall the feature.
let osApi, waDigestFor; // waDigestFor set when digests mount (used lazily by the WhatsApp Owl scheduler)
const os = require('./os').mount(app, { db, auth, mailer, push, slack, onInbound: (p) => owlIngest.handle({ ...p, getAttachmentBuffer: osApi.getAttachmentBuffer }) });
osApi = os;
const owlUploads = require('./owlUploads').mount(app, { db, auth }); const driveApi = require('./googleDrive').mount(app, { db, auth, insights, anthropicKeyForEntity }); const owlCatalogue = require('./owlCatalogue'); owlCatalogue.mount(app, { db, auth, getExploreFields: (m, v) => getExploreFieldsCached(m, v), listModels: () => looker.listModels() }); const getOwlTools = owlCatalogue.provider(db, () => require('./owlTools')({ query, auth, db, getGoalsApi: () => goalsApi, getAlertsApi: () => alerts, getCampaignsApi: () => actionsApi, getUploadsApi: () => owlUploads, getDriveApi: () => driveApi, getMetaAdsApi: () => metaAds, resolveTileValue, getExploreFields: (m, v) => getExploreFieldsCached(m, v), getFieldOverrides: () => require('./owlFields').build(db).read(), draftCampaignCopy: (a) => actionsApi.draftCopy(a), designEmailFn: (a) => require('./aiUsage').run({ entityId: a.entityId, kind: 'email_design' }, () => require('./emailDesign').designEmail({ ...a, apiKey: anthropicKeyForEntity(a.entityId), brandColor: mailer.resolveBranding(a.entityId, a.eventSuiteId || '').brandColor, instructions: aiInstructionsFor(a.eventSuiteId || null, a.entityId) })), getSegmentsApi: () => segmentsApi, getEventOpsApi: () => eventopsApi, getDataHealthApi: () => dataHealthApi, catalogue: owlCatalogue.effective(db) })); // Owl data: uploads + admin-editable catalogue (getOwlTools rebuilds live on field-selection change)
require('./owlChat').mount(app, { db, auth, insights, uploads: owlUploads, getDriveApi: () => driveApi, messaging, getAlertsApi: () => alerts, getLivePulseApi: () => livepulseApi, getSegmentsApi: () => segmentsApi, getActionsApi: () => actionsApi, getTicketsApi: () => ticketsApi, getExploreFields: (m, v) => getExploreFieldsCached(m, v), getOwlTools, anthropicKeyForSuite, anthropicKeyForEntity, currencyNote: (entityId, suiteId) => currency.aiNote(mailer.resolveBranding(entityId, suiteId).currency), languageNote: (entityId, suiteId) => language.aiNote(mailer.resolveBranding(entityId, suiteId).aiLanguage), whatsappDigestFor: (eid, em) => (waDigestFor ? waDigestFor(eid, em) : Promise.resolve(null)) }); // agentic Owl (disposable; askData rides the scope gate)
require('./owlEmbed').mount(app, { db, auth, rateLimit }); require('./fanOwl').mount(app, { db, auth, insights, rateLimit, anthropicKeyForEntity }); // Owl embeds: the organizer-portal Owl (docs/OWL_EMBED.md) + the fan-facing booking guide on promoters' public sites (docs/specs/FAN_OWL_SPEC.md)
// ─── Health ───────────────────────────────────────────────────────────────────
// Health touches SQLite so a wedged DB/disk fails the check (→ Render restarts).
app.get('/health', (_req, res) => {
  try { db.db.prepare('SELECT 1').get(); res.json({ status: 'ok' }); }
  catch (e) { res.status(500).json({ status: 'db_error', error: e.message }); }
});

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
  return { ...pub, entities, owlEnabled: require('./owlChat').owlAllowed(user), owlOwner: require('./owlChat').owlOwner(user) };
}
// Auth routes (login/logout/me/forgot/reset/magic + brute-force guard + 2FA
// step-up) → server/authRoutes.js. Owns loginGuard + mounts twofactor.
require('./authRoutes').mount(app, { auth, db, mailer, rateLimit, ops, meUser });

// Per-user notification channel preferences (self-service).
app.get('/api/my/notification-prefs', auth.requireAuth, (req, res) => {
  const u = auth.publicUser(db.getUser(req.user.id));
  res.json({
    email: u?.notifyEmail !== false, push: u?.notifyPush !== false, pushAvailable: push.isEnabled(),
    types: db.getNotifyTypes(req.user.id), typeCatalog: db.NOTIFY_TYPES,
    matrix: db.getNotifyMatrix(req.user.id), channels: db.NOTIFY_CHANNELS,
  });
});
app.put('/api/my/notification-prefs', auth.requireAuth, (req, res) => {
  const { email, push: wantPush, types, matrix } = req.body || {};
  const next = db.setNotificationPrefs(req.user.id, {
    ...(email != null ? { email: !!email } : {}),
    ...(wantPush != null ? { push: !!wantPush } : {}),
  });
  // `matrix` is the per-channel layer; `types` kept for older clients (applied to
  // every channel via the matrix's legacy seed).
  if (types && typeof types === 'object') db.setNotifyTypes(req.user.id, types);
  if (matrix && typeof matrix === 'object') db.setNotifyMatrix(req.user.id, matrix);
  res.json({ ...(next || { email: true, push: true }), types: db.getNotifyTypes(req.user.id), matrix: db.getNotifyMatrix(req.user.id) });
});

// ─── Client self-service team management (team.manage) ─────────────────────────
// A client Owner manages their own team's logins + roles, scoped to their
// entity. Mirror of the admin Logins tab. Howler-staff logins are never exposed
// or editable here; a client can only ever touch its own members.
function teamMembers(entityId) {
  return db.listUsers()
    .filter((u) => u.role !== 'admin' && (u.entityIds || []).includes(entityId))
    .map((u) => ({ id: u.id, email: u.email, fullName: u.fullName, firstName: u.firstName, lastName: u.lastName, mobile: u.mobile, role: (u.memberships || []).find((m) => m.entityId === entityId)?.role || 'owner', alsoOtherClients: (u.entityIds || []).length > 1 }));
}
const ownerCount = (entityId) => teamMembers(entityId).filter((m) => m.role === 'owner').length;

// The client's Howler support contacts — the admins assigned to the account,
// shown to the client as "Your Howler Support" with each one's job title + email.
function howlerSupportFor(entityId) {
  const ent = db.getEntity(entityId);
  return (ent?.howlerSupportIds || [])
    .map((id) => db.getUser(id))
    .filter((u) => u && u.role === 'admin')
    .map((u) => ({ id: u.id, name: u.fullName || u.email, email: u.email, mobile: u.mobile || '', roleLabel: roles.howlerRoleLabel(u.howlerRole) || 'Account Manager' }));
}

app.get('/api/my/team/:entityId', auth.requireAuth, auth.requirePermission('team.manage'), (req, res) => {
  res.json({ members: teamMembers(req.params.entityId).map((m) => ({ ...m, isYou: m.id === req.user.id })), roles: roles.catalog(), support: howlerSupportFor(req.params.entityId) });
});
app.post('/api/my/team/:entityId', auth.requireAuth, auth.requirePermission('team.manage'), (req, res) => {
  const { email, password, role, firstName, lastName, mobile } = req.body || {};
  if (!roles.ROLE_KEYS.includes(String(role || ''))) return res.status(400).json({ error: 'Unknown role' });
  try {
    const u = auth.createUser({ email, password, role: 'client', entityIds: [req.params.entityId], firstName, lastName, mobile });
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
// List every user with a directory-style summary: role, client memberships, when
// they last logged in, and when they were last active (most recent of login /
// action / dashboard view). Enriched in two batch queries — no per-user N+1.
app.get('/api/admin/users', auth.requireAdmin, (_req, res) => {
  const lastActions = db.lastActionsForUsers();
  const lastViews = db.lastViewForUsers();
  const wsName = Object.fromEntries(db.listInventiveWorkspaces().map((w) => [w.id, w.name]));
  res.json(auth.loadUsers().map((u) => {
    const la = lastActions[u.id] || null;
    const lastActiveAt = [u.lastLogin, la?.at, lastViews[u.id]].filter(Boolean).sort().pop() || null;
    return {
      id: u.id, email: u.email, role: u.role,
      firstName: u.firstName, lastName: u.lastName, fullName: u.fullName, mobile: u.mobile,
      entityIds: u.entityIds, memberships: u.memberships,
      inventiveWorkspaceId: u.inventiveWorkspaceId, inventiveWorkspaceName: wsName[u.inventiveWorkspaceId] || '',
      howlerRole: u.howlerRole, howlerRoleLabel: roles.howlerRoleLabel(u.howlerRole),
      roles: u.roles || [],
      notifyEmail: u.notifyEmail, notifyPush: u.notifyPush,
      createdAt: u.createdAt, lastLogin: u.lastLogin || null, lastActiveAt,
      lastAction: la ? { action: la.action, label: la.label, at: la.at } : null,
    };
  }));
});
app.post('/api/admin/users', auth.requireAdmin, (req, res) => {
  try { res.status(201).json(auth.createUser(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/admin/users/:id', auth.requireAdmin, (req, res) => {
  try {
    const u = auth.updateUser(req.params.id, req.body || {});
    if (!u) return res.status(404).json({ error: 'User not found' });
    res.json(u);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete('/api/admin/users/:id', auth.requireAdmin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You can't delete your own account" });
  auth.deleteUser(req.params.id); res.status(204).end();
});
// Promote an EXISTING login (e.g. a client/team member) to an admin, instead of
// erroring on a duplicate email when "adding" them. Keeps their current client
// access and adds any newly-ticked memberships.
app.post('/api/admin/users/promote', auth.requireAdmin, (req, res) => {
  try {
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email required' });
    const existing = db.getUserByEmail(email);
    if (!existing) return res.status(404).json({ error: 'No login with that email exists yet — use “Add admin” to create one.' });
    const want = Array.isArray(b.entityIds) ? b.entityIds.map(String) : [];
    const merged = [...new Set([...(existing.entityIds || []), ...want])];
    const u = auth.updateUser(existing.id, { role: 'admin', entityIds: merged });
    res.json(u);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Role catalog (for the role pickers).
const roles = require('./roles');
app.get('/api/admin/roles', auth.requireAdmin, (_req, res) => res.json({ roles: roles.catalog(), howlerRoles: roles.HOWLER_ROLES }));
// Platform-wide user activity summary (active users, top users / dashboards /
// features) for the admin Users console.
app.get('/api/admin/users/activity-report', auth.requireAdmin, (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const inact = db.inactivity(days);
  res.json({ ...db.adminActivityReport({ days }), daily: db.dailyEngagement(Math.min(90, days)), inactiveClients: inact.clients, inactiveUsers: inact.users });
});

// Friendly labels for the merged activity feed's non-audit sources.
function usageLabel(r) {
  const name = r.name || 'a feature';
  if (r.kind === 'guide') {
    if (r.event === 'complete') return `Completed the “${name}” guide`;
    if (r.event === 'skip') return `Skipped the “${name}” guide`;
    if (r.event === 'open') return `Opened the “${name}” guide`;
    return `Used the “${name}” guide`;
  }
  return `Used ${name}`;
}
// One user's recent activity, merging three sources into a single time-ordered
// feed: audited actions (what they did), dashboard opens (what they use), and
// onboarding/feature telemetry (what they engaged with).
function buildUserActivity(userId, limit = 120) {
  const entityName = (id) => (id ? (db.getEntity(id)?.name || '') : '');
  const actions = db.listActionsForUser(userId, 150).map((a) => ({
    at: a.at, kind: 'action', action: a.action, label: a.label,
    entityId: a.entityId, entityName: entityName(a.entityId),
    targetType: a.targetType, targetId: a.targetId, detail: a.detail,
  }));
  const views = db.recentViewsForUser(userId, 80).map((v) => ({
    at: v.at, kind: 'view', action: 'dashboard.open',
    label: `Opened ${v.title || 'a dashboard'}`, dashboardId: v.dashboardId, suiteId: v.suiteId,
  }));
  const usage = db.recentUsageForUser(userId, 80).map((u) => ({
    at: u.at, kind: 'usage', action: `${u.kind}.${u.event}`,
    label: usageLabel(u), entityId: u.entityId, entityName: entityName(u.entityId),
  }));
  return [...actions, ...views, ...usage]
    .filter((e) => e.at)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, limit);
}

// Full per-user detail for the Admin → Users drill-in: identity, client
// memberships (with role + lens), usage profile, dashboards (used + accessible)
// and the merged activity timeline. Never leaks the password hash.
app.get('/api/admin/users/:id', auth.requireAdmin, (req, res) => {
  const u = db.getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  // Each enrichment is independent — a failure in one (stale ref, odd data) must
  // NOT 500 the whole user view; degrade and log the real culprit.
  const safe = (fn, fallback, label) => { try { return fn(); } catch (e) { console.error(`[admin user ${u.id}] ${label} failed:`, e?.message || e); return fallback; } };
  const titleFor = (id) => { try { return db.getDashboard(id)?.title || id; } catch { return id; } };
  const memberships = safe(() => (u.memberships || []).map((m) => {
    const e = db.getEntity(m.entityId); const role = roles.getRole(m.role);
    return { entityId: m.entityId, entityName: e?.name || m.entityId, entityLogo: e?.logo || '', role: m.role, roleLabel: role?.label || m.role, lens: role?.lens || 'exec', permissions: role?.permissions || [] };
  }), [], 'memberships');
  const profile = safe(() => db.viewProfile(u.id), { top: [], lastVisit: null }, 'profile');
  const used = safe(() => (profile.top || []).map((t) => ({ dashboardId: t.dashboardId, suiteId: t.suiteId, count: t.count, lastAt: t.lastAt, title: titleFor(t.dashboardId) })), [], 'used');
  // Dashboards this user can reach: every dashboard in a set in one of their
  // entities' suites (deduped). Admins see everything → flagged below.
  const accessible = safe(() => {
    const seen = new Set(); const acc = [];
    if (u.role !== 'admin') for (const eid of u.entityIds || []) for (const su of db.listSuitesForEntity(eid)) for (const sid of db.suiteSetIds(su.id)) for (const did of db.dashboardsInSet(sid)) {
      if (seen.has(did)) continue; seen.add(did); acc.push({ dashboardId: did, title: titleFor(did), suiteId: su.id, suiteName: su.name });
    }
    return acc;
  }, [], 'accessible');
  res.json({
    user: {
      id: u.id, email: u.email, role: u.role, createdAt: u.createdAt,
      firstName: u.firstName, lastName: u.lastName, fullName: u.fullName, mobile: u.mobile,
      inventiveWorkspaceId: u.inventiveWorkspaceId || '',
      inventiveWorkspace: safe(() => (u.inventiveWorkspaceId ? (db.getInventiveWorkspace(u.inventiveWorkspaceId) || null) : null), null, 'inventiveWorkspace'),
      lastLogin: u.lastLogin || null, notifyEmail: u.notifyEmail, notifyPush: u.notifyPush,
      entityIds: u.entityIds,
    },
    memberships,
    profile: { top: used, lastVisit: profile.lastVisit },
    dashboards: { used, accessible, accessibleAll: u.role === 'admin' },
    usageByClient: safe(() => db.usageByClientForUser(u.id), [], 'usageByClient'),
    emails: safe(() => mailer.recipientLog(u.email).map((m) => ({ ...m, entityName: m.entityId ? (db.getEntity(m.entityId)?.name || '') : '' })), [], 'emails'),
    activity: safe(() => buildUserActivity(u.id), [], 'activity'),
  });
});
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
// The admin who creates a client becomes its default Howler support contact
// (shown to the client under Settings → Team). Reassignable later via the entity.
app.post('/api/admin/entities', auth.requireAdmin, (req, res) => res.status(201).json(db.createEntity({ ...(req.body || {}), howlerOwnerUserId: (req.body || {}).howlerOwnerUserId || req.user.id })));
// Manage a client's Howler support contacts (a list of admin user ids). Only
// admins can be assigned; non-admin ids are dropped.
app.put('/api/admin/entities/:id/howler-support', auth.requireAdmin, (req, res) => {
  if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const ids = (Array.isArray(req.body?.userIds) ? req.body.userIds : []).filter((id) => db.getUser(id)?.role === 'admin');
  res.json(db.setEntityHowlerSupport(req.params.id, ids));
});
app.put('/api/admin/entities/:id', auth.requireAdmin, (req, res) => {
  const e = db.updateEntity(req.params.id, req.body || {});
  if (!e) return res.status(404).json({ error: 'Entity not found' });
  res.json(e);
});
app.delete('/api/admin/entities/:id', auth.requireAdmin, (req, res) => { db.deleteEntity(req.params.id); res.status(204).end(); });

// Reusable Inventive workspaces — create (name + reference), then link users to them.
app.get('/api/admin/inventive-workspaces', auth.requireAdmin, (_req, res) => res.json(db.listInventiveWorkspaces()));
app.post('/api/admin/inventive-workspaces', auth.requireAdmin, (req, res) => res.status(201).json(db.createInventiveWorkspace(req.body || {})));
app.put('/api/admin/inventive-workspaces/:id', auth.requireAdmin, (req, res) => {
  const w = db.updateInventiveWorkspace(req.params.id, req.body || {});
  if (!w) return res.status(404).json({ error: 'Workspace not found' });
  res.json(w);
});
app.delete('/api/admin/inventive-workspaces/:id', auth.requireAdmin, (req, res) => { db.deleteInventiveWorkspace(req.params.id); res.status(204).end(); });

// Sets = reusable dashboard collections (Ticketing, Cashless, …).
app.get('/api/admin/sets', auth.requireAdmin, (_req, res) => res.json(db.listSets()));
app.post('/api/admin/sets', auth.requireAdmin, (req, res) => res.status(201).json(db.createSet(req.body || {})));
app.put('/api/admin/sets/:id', auth.requireAdmin, (req, res) => {
  const s = db.updateSet(req.params.id, req.body || {});
  if (!s) return res.status(404).json({ error: 'Set not found' });
  res.json(s);
});
app.delete('/api/admin/sets/:id', auth.requireAdmin, (req, res) => { db.deleteSet(req.params.id); res.status(204).end(); });

// ─── Release notes (daily product changelog — Admin → Product) ───────────────
// Disposable module: own routes + the daily auto-draft tick (kill switch:
// settings key 'release_notes_auto'). Remove this line + server/releaseNotes.js.
require('./releaseNotes').mount(app, { db, auth, insights, adminAnthropicKey });
require('./version').mount(app, { auth }); // build stamp for the profile footer → server/version.js
const github = require('./github').mount(app, { db, auth }); // GitHub issue bridge → server/github.js
const ticketsApi = require('./tickets').mount(app, { db, auth, insights, adminAnthropicKey, os, github, push }); // product board → server/tickets.js (kill switch: tickets_enabled)

// ─── Client content model & navigation → server/clientModel.js ─────────────────
// Disposable module: suite/set/dashboard model, /api/my/suites navigation, saved
// filter views + lock overrides. Remove this line + server/clientModel.js.
require('./clientModel').mount(app, { db, auth, store, looker, fetchDashboard, convertDashboard, expandLockMap, cleanFilterMap, resolvePhase, suiteHasGoals: (sid) => { try { return (goalsApi.listGoals(sid) || []).length > 0; } catch { return false; } } });

// ─── Dashboards → server/dashboards.js ─────────────────────────────────────────
// Extracted: dashboard CRUD, Looker import, folders, run-query and drill. The
// query routes share the one query-engine instance (functions injected), so the
// cache + scope boundary stay singular across the app.
require('./dashboards').mount(app, {
  store, db, auth, looker,
  convertDashboard, fetchDashboard, parseDrillUrl,
  runLookerQuery, applyScope, stripAnyValue, currentFirstEventSort, clearCache: query.clearCache,
});

// ─── Goals (the Results pillar) → server/goals.js ──────────────────────────────
// A tile-sourced goal reads the live number off a dashboard tile through the
// SHARED, scope-enforced query path (so the goal value == what the dashboard
// shows, and the per-tenant scope can't be bypassed). The suite's filter locks
// (which event) apply exactly as a dashboard view would; the tile readers live in server/tileValues.js.
const goalsApi = require('./goals').mount(app, { db, auth, resolveTileValue, resolveTileSeries, resolveTileSeriesAll, resolveEventDate });
require('./skills').mount(app, { db, auth, insights, getOwlTools, getGoalsApi: () => goalsApi, anthropicKeyForSuite, aiInstructionsFor, resolveEventDate }); // Skills: autonomous specialists (SKILLS_BRIEF P1) — the Owl's scheduled "push" door (advise-only, backtest + AM feedback); disposable → server/skills.js

// ── Alerts: metric watchers → server/alerts.js ───────────────────────────────
// A self-contained module that watches a number (a dashboard tile via the SAME
// scope-enforced resolveTileValue goals use, OR a raw measure + dimension filter
// built in the editor) and fires through the inbox/push/email/SMS when it crosses
// a threshold. Background tick evaluates the rules.
//
// The "custom metric" source lets a client alert on a slice that has no tile (e.g.
// "tickets sold where Ticket Type = VIP"). To keep the per-tenant boundary intact,
// the catalogue is built ONLY from explores the client's dashboards already use —
// the exact set where applyScope can resolve the organiser lock — and every read
// still runs through applyScope (fail-closed) with the suite's event lock applied.

// Looker metadata, cached (explore field lists + model/explore labels).
const _exFieldCache = new Map(); // `${model}::${view}` -> { at, data:{ dimensions, measures } }
const METRIC_META_TTL = 10 * 60000;
async function getExploreFieldsCached(model, view) {
  const key = `${model}::${view}`;
  const hit = _exFieldCache.get(key);
  if (hit && Date.now() - hit.at < METRIC_META_TTL) return hit.data;
  const data = await looker.getExploreFields(model, view);
  _exFieldCache.set(key, { at: Date.now(), data });
  return data;
}
let _exLabels = null, _exLabelsAt = 0;
async function exploreLabelMap() {
  if (!_exLabels || Date.now() - _exLabelsAt > METRIC_META_TTL) {
    try { const models = await looker.listModels(); _exLabels = new Map(); _exLabelsAt = Date.now();
      for (const m of models || []) for (const e of m.explores || []) _exLabels.set(`${m.name}::${e.name}`, e.label || e.name);
    } catch { _exLabels = _exLabels || new Map(); }
  }
  return _exLabels;
}
const prettifyName = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());

// A representative tile on a given explore from the client's dashboards. We borrow
// its filter WIRING (listenTo) + its dashboard's filter defs so a raw metric query
// scopes to the event/organiser EXACTLY as the dashboards do — no guessing which
// field is "the event" on this explore. Every catalogue explore has ≥1 such tile
// (the catalogue is built from them), so this is normally present.
function representativeTileForExplore(entityId, model, view) {
  const { catalogue } = clientCatalogue(entityId);
  let fallback = null;
  for (const c of catalogue) {
    const def = store.get(c.dashboardId);
    if (!def) continue;
    const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((x) => x.tiles || []))];
    for (const t of tiles) {
      const q = t.query; if (q?.model !== model || q?.view !== view) continue;
      if (t.listenTo && Object.keys(t.listenTo).length) return { def, tile: t }; // prefer a wired one
      if (!fallback) fallback = { def, tile: t };
    }
  }
  return fallback;
}

// Build a scoped query body for a raw measure/dimension on an explore, reusing the
// EXACT dashboard path: a synthetic tile that borrows a real tile's listenTo wiring,
// run through tileQueryBody (which applies the event/organiser locks via that wiring
// + effectiveFilterValues, then forces the organiser scope). `extraOverrides` are the
// user's metric filters (queryField -> value). Returns a body or null (fail closed).
async function scopedMetricBody({ model, view, fields, sorts, limit, extraOverrides, user, suiteId, entityScope }) {
  const su = db.getSuite(suiteId); if (!su) return null;
  const orgOnly = async () => { const body = { model, view, fields, filters: { ...(extraOverrides || {}) }, ...(sorts ? { sorts } : {}), ...(limit ? { limit } : {}) }; return (await applyScope(body, user, suiteId)) ? body : null; };
  // entityScope = client-wide: the Event picker lists EVERY event, so query organiser-only.
  // Borrowing a tile here would re-pin to a dashboard filter's default event (emptying the
  // list, since effectiveFilterValues falls back to it). It's also the no-tile fallback.
  if (entityScope) return orgOnly();
  const rep = representativeTileForExplore(su.entityId, model, view);
  if (!rep) return orgOnly();
  const lockMap = expandLockMap(db.lockedFiltersForSuite(suiteId));
  const synthetic = { ...rep.tile, id: 'metric', type: 'vis', vis: {}, query: { model, view, fields, ...(sorts ? { sorts } : {}), ...(limit ? { limit } : {}) } };
  return tileQueryBody(synthetic, rep.def, user, suiteId, lockMap, extraOverrides || {});
}

// The catalogue of explores a client can build a metric from — derived from the
// dashboards they already have, so scope is guaranteed to resolve. Each carries its
// measures + filterable dimensions (with friendly labels) for the editor's pickers.
async function metricCatalog(entityId) {
  const { catalogue } = clientCatalogue(entityId);
  const seen = new Map(); // `${model}::${view}` -> { model, view }
  for (const c of catalogue) {
    const def = store.get(c.dashboardId);
    if (!def) continue;
    const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((x) => x.tiles || []))];
    for (const t of tiles) { const q = t.query; if (q?.model && q?.view) seen.set(`${q.model}::${q.view}`, { model: q.model, view: q.view }); }
  }
  const labels = await exploreLabelMap();
  const explores = [];
  for (const { model, view } of seen.values()) {
    try {
      const f = await getExploreFieldsCached(model, view);
      if (!f.measures.length) continue; // nothing to alert on
      const shape = (arr) => arr.map((x) => ({ name: x.name, label: x.label, type: x.type, group: x.group_label || '' }));
      explores.push({ model, view, label: labels.get(`${model}::${view}`) || prettifyName(view), measures: shape(f.measures), dimensions: shape(f.dimensions) });
    } catch { /* skip explores Looker won't describe */ }
  }
  explores.sort((a, b) => String(a.label).localeCompare(String(b.label)));
  return { explores };
}

// Read a built metric's live number — one measure, the user's dimension filters,
// scoped to THIS event + client exactly like the dashboards. Fail-closed.
async function resolveCustomMetric({ model, view, measure, filters, user, suiteId }) {
  if (!model || !view || !measure) return null;
  const body = await scopedMetricBody({ model, view, fields: [measure], limit: 1, extraOverrides: filters || {}, user, suiteId });
  if (!body) return null;
  const data = await runLookerQuery('/queries/run/json_detail', body);
  return primaryTileValue(data, {});
}

// Distinct values of a dimension under this event's scope — the choices for a filter
// (e.g. the Ticket Type values that exist for this event).
async function metricFilterValues({ model, view, field, user, suiteId, entityScope }) {
  const body = await scopedMetricBody({ model, view, fields: [field], sorts: [field], limit: 500, extraOverrides: {}, user, suiteId, entityScope });
  if (!body) return [];
  const data = await runLookerQuery('/queries/run/json_detail', body);
  const out = [];
  for (const r of (data?.data || [])) {
    const cell = r[field];
    const v = cell ? (cell.rendered != null && cell.rendered !== '' ? cell.rendered : cell.value) : null;
    if (v != null && v !== '' && !out.includes(String(v))) out.push(String(v));
    if (out.length >= 200) break;
  }
  return out;
}

const alerts = require('./alerts').mount(app, { db, auth, resolveTileValue, resolveCustomMetric, metricCatalog, metricFilterValues, os, mailer, push, messaging, slack });

// ── Status notices: human-authored platform incidents (vs alerts, which watch data) → server/notices.js
require('./notices').mount(app, { db, auth, os, mailer, messaging });
require('./vanity').mount(app, { db, auth, mailer }); // white-labelled /<slug> login per client → server/vanity.js
const eventopsApi = require('./eventops').mount(app, { db, auth }); // pilot: device/station logistics, per-client opt-in → server/eventops.js
const livepulseApi = require('./livepulse').mount(app, { db, auth, resolveTileValue, resolveTileRows, resolveCustomMetric, os, mailer, messaging, eventops: eventopsApi }); // Live Pulse: recurring event-day multi-metric updates (the Alerts page's "Live updates" tab) → server/livepulse.js

// ── Pulse: the header "heartbeat" strip's merged feed (alert fires + live tile momentum) → server/pulse.js
require('./pulse').mount(app, { db, auth, resolveTileValue, alertBeats: alerts.recentBeats });
const dataHealthApi = require('./dataHealth').mount(app, { db, auth, looker, runLookerQuery, applyScope, os, ops, ai: { keyFor: (eid) => anthropicKeyForEntity(eid), instructionsFor: (sid, eid) => aiInstructionsFor(sid || null, eid), meter: (kind, eid, fn) => require('./aiUsage').run({ entityId: eid || null, kind }, fn) } }); // BigQuery→Looker stream monitor (Admin → 📡 Data health; client tab in Event Ops; Owl/MCP tool) → server/dataHealth.js

// ── Weekly goal nudge (push) ─────────────────────────────────────────────────
// One calm "your goals this week" push per entity (not per-event): goals needing
// attention (behind pace · forecast short · checkpoint missed) plus wins (reached).
// Deduped per ISO week via a setting; respects each user's push pref (sendToEntity
// filters by notifyPush). Global kill-switch: setting goal_nudges_enabled = '0'.
function isoWeekKey(tz = 'Africa/Johannesburg') {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const dt = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
  dt.setUTCDate(dt.getUTCDate() + 4 - (dt.getUTCDay() || 7)); // nearest Thursday
  const yStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const wk = Math.ceil((((dt - yStart) / 86400000) + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
}
// Resolve one entity's goals into a nudge summary { wins[], attention[], body }.
async function buildGoalNudge(entityId) {
  const user = { id: `goal-nudge:${entityId}`, role: 'client', entityIds: [entityId], email: '' };
  const wins = [], attention = []; let resolved = 0;
  for (const su of db.listSuitesForEntity(entityId)) {
    const caches = goalsApi.makeGoalCaches();
    for (const g of goalsApi.listGoals(su.id)) {
      if (resolved >= 24) break;
      const p = (await goalsApi.attachProgress(g, user, caches)).progress || {}; resolved += 1;
      const dir = g.direction || 'at_least';
      if (dir === 'composition') { if (p.balanced === false) attention.push(g.name); else if (p.balanced === true) wins.push(g.name); continue; }
      if (dir === 'range' && p.over) { attention.push(g.name); continue; } // drifted above the healthy band
      const reached = dir === 'range' ? !!p.inRange : (p.value != null && g.targetValue != null && (dir === 'at_most' ? p.value <= g.targetValue : (p.pct != null ? p.pct >= 100 : p.value >= g.targetValue)));
      if (reached) { wins.push(g.name); continue; }
      const missed = Array.isArray(p.milestones) && p.milestones.some((m) => { const t = Date.parse(m.byDate); return !Number.isNaN(t) && t < Date.now() && p.value != null && (dir === 'at_most' ? p.value > m.targetValue : p.value < m.targetValue); });
      if (p.status === 'behind' || (p.forecast && p.forecast.status === 'short') || missed) attention.push(g.name);
    }
  }
  const bits = [];
  if (attention.length) bits.push(`${attention.length} goal${attention.length > 1 ? 's' : ''} need attention: ${attention.slice(0, 3).join(', ')}${attention.length > 3 ? '…' : ''}`);
  if (wins.length) bits.push(`🎉 ${wins.length} reached: ${wins.slice(0, 2).join(', ')}${wins.length > 2 ? '…' : ''}`);
  return { wins, attention, body: bits.join(' · ') };
}
async function goalNudgeSweep() {
  try {
    if (!push.isEnabled || !push.isEnabled()) return;
    if (db.getSetting('goal_nudges_enabled', '1') !== '1') return;
    const tz = 'Africa/Johannesburg';
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date()));
    if (hour < 8) return; // morning+ only; ISO-week dedupe makes it ~Monday 08:00
    const week = isoWeekKey(tz);
    for (const ent of db.listEntities()) {
      if (db.getSetting(`goal_nudge_week:${ent.id}`, '') === week) continue;
      try {
        const { wins, attention, body } = await buildGoalNudge(ent.id);
        db.setSetting(`goal_nudge_week:${ent.id}`, week); // mark done even if nothing to say
        if (!attention.length && !wins.length) continue;
        await push.sendToEntity(ent.id, { title: 'Your goals this week', body, url: '/goals' }, 'goals');
      } catch (e) { console.error('[goal-nudge]', ent.id, e.message); }
    }
  } catch (e) { console.error('[goal-nudge] sweep', e.message); }
}

// Admin: fire a goal nudge on demand for testing. Sends the real summary push to
// the CALLER's own devices (not the whole client team), so staff can preview it
// without spamming the client. Does NOT touch the weekly dedupe marker.
//   POST /api/admin/goals/nudge-test  { entityId }
app.post('/api/admin/goals/nudge-test', auth.requireAdmin, async (req, res) => {
  const entityId = req.body?.entityId;
  if (!entityId || !db.getEntity(entityId)) return res.status(400).json({ error: 'Valid entityId required' });
  if (!push.isEnabled || !push.isEnabled()) return res.status(400).json({ error: 'Push is not enabled (set push_enabled=1)' });
  try {
    const { wins, attention, body } = await buildGoalNudge(entityId);
    const text = body || 'No goals need attention right now — nothing would be sent this week.';
    const sent = (attention.length || wins.length)
      ? await push.sendToUser(req.user.id, { title: 'Your goals this week (test)', body: text, url: '/goals' })
      : 0;
    res.json({ sent, wouldSend: !!(attention.length || wins.length), body: text, wins: wins.length, attention: attention.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
setInterval(() => goalNudgeSweep(), 60 * 60 * 1000); // hourly; fires the first morning of each ISO week
setTimeout(() => goalNudgeSweep(), 30000); // shortly after boot, in case it's the window

// Owl summary of an event's goals — a short narrative over the RESOLVED goal values
// (computed here by the goals resolver; the AI only phrases them). Streams plain text
// like the other Owl surfaces; per-event (the Goals page "Owl summary" button).
app.post('/api/goals/suites/:suiteId/brief', auth.requireAuth, rateLimit({ windowMs: 60_000, max: 12, by: 'user', scope: 'goals-brief', message: 'Too many goal summaries — please wait a moment.' }), async (req, res) => {
  const suiteId = req.params.suiteId;
  const su = db.getSuite(suiteId);
  if (!su) return res.status(404).json({ error: 'Event not found' });
  if (req.user.role !== 'admin' && !auth.canAccessSuite(req.user, suiteId)) return res.status(403).json({ error: 'Not allowed' });
  const apiKey = anthropicKeyForSuite(suiteId);
  if (!insights.isConfigured(apiKey)) return res.status(400).json({ error: 'AI insights are not configured. Set an Anthropic API key in Admin → Integrations (or .env).' });
  // Resolve the SAME rich progress the Goals page card detail shows (curve current,
  // vs-last-time, baseline total, pace, forecast) so the Owl can speak to all of it,
  // not just the bare value/percent.
  const caches = goalsApi.makeGoalCaches();
  const goals = [];
  for (const g of goalsApi.listGoals(suiteId)) {
    goals.push(await goalsApi.attachProgress(g, req.user, caches));
  }
  if (!goals.length) return res.status(400).json({ error: 'No goals set for this event yet.' });
  try {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no'); // don't let a reverse proxy buffer the stream
    res.flushHeaders?.();
    await aiUsage.run({ entityId: su.entityId, kind: 'goals' }, () => insights.streamGoalsBrief({ eventName: su.name, goals, instructions: aiInstructionsFor(suiteId), apiKey }, (t) => res.write(t)));
    res.end();
  } catch (err) {
    console.error('[POST /api/goals/:suiteId/brief]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else { res.write(`\n\n[error: ${err.message}]`); res.end(); }
  }
});

// "Close the gap" — act as the client's marketing & insights manager: mine the event's
// data (ticket types, demographics, segments, channels) for the nuggets that can push a
// behind/short goal to target, and return a plan that pre-fills a targeted campaign.
app.post('/api/goals/:id/gap-plan', auth.requireAuth, rateLimit({ windowMs: 60_000, max: 8, by: 'user', scope: 'goal-gap', message: 'Too many gap plans — please wait a moment.' }), async (req, res) => {
  const goal = goalsApi.goalById(req.params.id);
  if (!goal) return res.status(404).json({ error: 'Goal not found' });
  const suiteId = goal.suiteId;
  if (req.user.role !== 'admin' && !auth.canAccessSuite(req.user, suiteId)) return res.status(403).json({ error: 'Not allowed' });
  const su = db.getSuite(suiteId); const entityId = su?.entityId;
  const apiKey = anthropicKeyForSuite(suiteId);
  if (!insights.isConfigured(apiKey)) return res.status(400).json({ error: 'AI insights are not configured. Set an Anthropic API key in Admin → Integrations (or .env).' });
  try {
    const withProgress = await goalsApi.attachProgress(goal, req.user);
    const { tiles, catalogue } = await buildFacts(req.user, entityId, false, true);
    let segments = [];
    try { segments = db.db.prepare('SELECT name, last_count FROM segments WHERE entity_id=? ORDER BY updated_at DESC LIMIT 50').all(entityId).map((s) => ({ name: s.name, count: s.last_count })); } catch { /* segments table may be empty */ }
    const plan = await aiUsage.run({ entityId, kind: 'goals' }, () => insights.goalGapPlan({
      goal: withProgress, progress: withProgress.progress, tiles, segments, catalogue,
      clientName: db.getEntity(entityId)?.name || '', instructions: aiInstructionsFor(suiteId), today: todayLabel(), apiKey,
    }));
    res.json({ plan });
  } catch (err) {
    console.error('[POST /api/goals/:id/gap-plan]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Admin diagnostic: show EXACTLY what filters the briefing resolves for each tile on a
// dashboard (and whether rows come back) — so we can see why a GA4 tile reads zero
// (e.g. no date range applied). Mirrors buildFacts' resolution (entity view expanded
// into the lock map + suite locks). Read-only. /api/admin/tile-filter-debug?suiteId=&dashboardId=
app.get('/api/admin/tile-filter-debug', auth.requireAdmin, async (req, res) => {
  try {
    const { suiteId, dashboardId } = req.query;
    const su = db.getSuite(suiteId);
    const def = store.get(dashboardId);
    if (!su || !def) return res.status(404).json({ error: 'suite or dashboard not found' });
    const entityId = su.entityId;
    const user = { id: `debug:${entityId}`, email: req.user.email, role: 'client', entityIds: [entityId] };
    const view = db.getFilterView('entity', entityId, dashboardId) || null;
    const lockMap = { ...expandLockMap(view || {}), ...expandLockMap(db.lockedFiltersForSuite(suiteId, dashboardId)) };
    const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))]
      .filter((t) => t.type !== 'text' && t.query?.fields?.length);
    const out = [];
    for (const t of tiles.slice(0, 14)) {
      const body = await tileQueryBody(t, def, user, suiteId, lockMap, {});
      let rows = null, err = null;
      if (body) { try { const d = await runLookerQuery('/queries/run/json_detail', body, undefined, true); rows = d?.data?.length || 0; } catch (e) { err = e.message; } }
      out.push({ title: t.title, model: t.query.model, view: t.query.view, listenTo: t.listenTo || {}, resolvedFilters: body ? body.filters : '(no body — scope blocked/unrunnable)', rows, err });
    }
    res.json({
      dashboard: def.title, suiteId, entityId,
      dashboardFilters: (def.filters || []).map((f) => ({ name: f.name, field: f.field || f.dimension, default: f.default_value })),
      hasEntityView: !!view, entityView: view || null,
      suiteLocks: db.lockedFiltersForSuite(suiteId, dashboardId),
      tiles: out,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Format a Looker date value ("2026-05-29" / ISO) as "29 May 2026" for the
// event dropdowns. Falls back to the raw string if it isn't a parseable date.
function fmtEventDate(v) {
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return isNaN(d) ? `${m[3]}/${m[2]}/${m[1]}` : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

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
    // Event names also show the event's start date in the dropdown, e.g.
    // "Ultra South Africa  —  29 May 2026", pulled from the same explore.
    const dateField = field === 'core_events.name' ? 'core_events.start_date' : null;
    const q = { model, view: explore, fields: [field, comp, dateField].filter(Boolean), sorts: [field], limit: 100 };
    const t = (term || '').trim();
    if (t) {
      if (/^\d+$/.test(t)) {
        q.filters = { [/^core_ticket_(categories|types)\.name$/.test(field) ? field.replace(/\.name$/, '.id') : field]: t }; // a number finds a ticket by id; the shown/stored value stays the name
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
    let rows;
    try {
      rows = await runLookerQuery('/queries/run/json', q);
    } catch (err) {
      // Some explores expose the event name but not core_events.start_date —
      // drop the date field and retry so suggestions still work everywhere.
      if (!dateField) throw err;
      q.fields = q.fields.filter((f) => f !== dateField);
      rows = await runLookerQuery('/queries/run/json', q);
    }
    const seen = new Set();
    const suggestions = [];
    const isId = field.endsWith('.id');
    for (const r of rows || []) {
      const v = r[field];
      if (v == null || v === '') continue;
      const s = String(v);
      if (seen.has(s)) continue;
      seen.add(s);
      const date = dateField && r[dateField] != null && r[dateField] !== '' ? fmtEventDate(r[dateField]) : '';
      if (comp) {
        const other = r[comp] == null ? '' : String(r[comp]);
        let label = isId ? `${s} — ${other}` : `${s}  (id: ${other})`;
        if (date) label += `  ·  ${date}`;
        suggestions.push({ value: s, label });
      } else if (date) {
        suggestions.push({ value: s, label: `${s}  —  ${date}` });
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
// Clip AI copy at a word boundary + ellipsis — a hard .slice() cuts mid-word ("…cheaper phases c"), reading as a bug on the briefing cards.
const clipWords = (s, n) => { const t = String(s || ''); if (t.length <= n) return t; const cut = t.slice(0, n); const i = cut.lastIndexOf(' '); return `${(i > n * 0.6 ? cut.slice(0, i) : cut).trimEnd()}…`; };

function aiInstructionsFor(suiteId, entityId, langOverride) {
  const parts = [];
  const global = db.getSetting('ai_instructions');
  if (global && global.trim()) parts.push(global.trim());
  const su = suiteId ? db.getSuite(suiteId) : null;
  const eid = entityId || su?.entityId;
  const ent = eid && db.getEntity(eid);
  if (su && ent?.aiContext && ent.aiContext.trim()) parts.push(`Context for the client "${ent.name}":\n${ent.aiContext.trim()}`);
  if (eid) { const br = mailer.resolveBranding(eid, suiteId); parts.push(currency.aiNote(br.currency)); parts.push(language.aiNote(langOverride && String(langOverride).trim() ? langOverride : br.aiLanguage)); } // langOverride (per-campaign language) wins over the client default
  return parts.filter(Boolean).join('\n\n');
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
    systemPrompts: insights.promptRegistry(), skillDefaults: require('./skills').defaultsAudit(db), // per-skill platform playbooks (override || built-in seed)
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
  const skillsByEntity = require('./skills').playbookLayersByEntity(db.db); // per-client skill playbook additions (the trainable layer — server/skills.js)
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
    return { id: ent.id, name: ent.name, aiContext: (ent.aiContext || '').trim(), owlGuidance: (db.getSetting(`owl_guidance:${ent.id}`, '') || '').trim(), owlMemory: require('./owlMemory').build(db).read('client', ent.id).map((m) => m.text), events, digests: jobsByEntity[ent.id] || [], readerTunes: tunes, skills: skillsByEntity[ent.id] || [] };
  });

  // Tiles & dashboards with custom AI context (count + list, capped).
  const tileContexts = []; const dashContexts = [];
  for (const d of store.list()) {
    const def = store.get(d.id); if (!def) continue;
    if ((def.aiContext || '').trim()) dashContexts.push({ dashboardId: d.id, dashTitle: def.title || d.title, context: def.aiContext.trim() });
    const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
    for (const t of tiles) if ((t.aiContext || '').trim()) tileContexts.push({ dashTitle: def.title || d.title, tileTitle: t.title || '(untitled)', context: t.aiContext.trim() });
  }

  res.json({ builtins, global, clients, dashContexts, tileContexts, owlGuidanceGlobal: (db.getSetting('owl_guidance', '') || '').trim() });
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
  const mt = body.meta || {};
  if (mt.accessToken) set('metaAccessToken', String(mt.accessToken));
  if (mt.clearAccessToken) set('metaAccessToken', '');
  if (mt.adAccountId !== undefined) set('metaAdAccountId', String(mt.adAccountId || ''));
  if (mt.businessId !== undefined) set('metaBusinessId', String(mt.businessId || ''));
  // Organic-insights assets (inbound social metrics) — non-secret ids.
  if (mt.pageId !== undefined) set('metaPageId', String(mt.pageId || ''));
  if (mt.igUserId !== undefined) set('metaIgUserId', String(mt.igUserId || ''));
  const tt = body.tiktok || {};
  if (tt.accessToken) set('tiktokAccessToken', String(tt.accessToken));
  if (tt.clearAccessToken) set('tiktokAccessToken', '');
  if (tt.advertiserId !== undefined) set('tiktokAdvertiserId', String(tt.advertiserId || '')); slack.applyPatch(body, set); // Slack: webhook / bot token / channel
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
    locks: getPlatformIntegrationLocks(), // { key: true } — frozen platform integrations
  };
}
function entityIntegrationsView(entityId) {
  const i = db.getEntityIntegrations(entityId);
  return {
    looker: { baseUrl: i.lookerBaseUrl || '', clientId: i.lookerClientId || '', clientSecretSet: !!i.lookerClientSecret },
    anthropic: { keySet: !!i.anthropicApiKey, keyHint: maskSecret(i.anthropicApiKey) },
    meta: { tokenSet: !!i.metaAccessToken, tokenHint: maskSecret(i.metaAccessToken), adAccountId: i.metaAdAccountId || '', businessId: i.metaBusinessId || '', pageId: i.metaPageId || '', igUserId: i.metaIgUserId || '' },
    tiktok: { tokenSet: !!i.tiktokAccessToken, tokenHint: maskSecret(i.tiktokAccessToken), advertiserId: i.tiktokAdvertiserId || '' }, slack: slack.view(i),
    locks: db.getEntityIntegrationLocks(entityId), // { key: true } — frozen integrations
  };
}
// Per-entity integration keys that can be frozen. A frozen section's changes are
// dropped server-side (defence in depth — the UI also disables it), so a freeze
// can't be bypassed by a hand-crafted request.
const ENTITY_INTEGRATION_KEYS = ['looker', 'anthropic', 'meta', 'tiktok', 'slack'];
function dropFrozenSections(entityId, body) {
  const locks = db.getEntityIntegrationLocks(entityId);
  const b = { ...(body || {}) };
  // Locked by default: a section is editable only when explicitly unlocked (false).
  for (const k of ENTITY_INTEGRATION_KEYS) if (locks[k] !== false) delete b[k];
  return b;
}

// Platform-level integration freeze locks — same idea as per-client, but for
// Howler's own accounts, kept in a single setting. Frozen sections are dropped
// from any save (defence in depth) so a freeze can't be bypassed.
const PLATFORM_INTEGRATION_KEYS = ['looker', 'anthropic', 'resend', 'inventive'];
function getPlatformIntegrationLocks() { try { return JSON.parse(db.getSetting('integration_locks') || '{}') || {}; } catch { return {}; } }
function setPlatformIntegrationLock(key, locked) {
  const cur = getPlatformIntegrationLocks();
  cur[key] = !!locked; // store explicit state — absent reads as locked (default)
  db.setSetting('integration_locks', JSON.stringify(cur));
  return cur;
}

// Admin: primary accounts.
app.get('/api/admin/integrations', auth.requireAdmin, (_req, res) => res.json(adminIntegrationsView()));
app.put('/api/admin/integrations', auth.requireAdmin, (req, res) => {
  const locks = getPlatformIntegrationLocks();
  const body = { ...(req.body || {}) };
  // Locked by default: a section is editable only when explicitly unlocked (false).
  if (locks.looker !== false) delete body.looker;
  if (locks.anthropic !== false) delete body.anthropic;
  const map = { lookerBaseUrl: 'looker_base_url', lookerClientId: 'looker_client_id', lookerClientSecret: 'looker_client_secret', anthropicApiKey: 'anthropic_api_key' };
  applyIntegrationsPatch(body, (k, v) => db.setSetting(map[k], v));
  // Resend (email) — admin-only, so handled here rather than in the shared patch.
  const re = (locks.resend !== false ? {} : (req.body || {}).resend) || {};
  if (re.apiKey) db.setSetting('resend_api_key', String(re.apiKey));
  if (re.clearApiKey) db.setSetting('resend_api_key', '');
  if (re.from !== undefined) db.setSetting('mail_from', String(re.from || '').trim());
  // Global kill switch: '0' makes every outbound email a no-op (all clients).
  if (re.enabled !== undefined) db.setSetting('mail_enabled', re.enabled ? '1' : '0');
  // Inventive (embedded AI analyst) — admin-only, platform-level.
  const inv = (locks.inventive !== false ? {} : (req.body || {}).inventive) || {};
  if (inv.apiKey) db.setSetting('inventive_api_key', String(inv.apiKey));
  if (inv.clearApiKey) db.setSetting('inventive_api_key', '');
  if (inv.embedToken) db.setSetting('inventive_embed_auth_token', String(inv.embedToken));
  if (inv.clearEmbedToken) db.setSetting('inventive_embed_auth_token', '');
  if (inv.endpoint !== undefined) db.setSetting('inventive_api_endpoint', String(inv.endpoint || '').trim());
  res.json(adminIntegrationsView());
});
// Freeze / unfreeze a platform integration.
app.put('/api/admin/integrations/lock', auth.requireAdmin, (req, res) => {
  const { key, locked } = req.body || {};
  if (!PLATFORM_INTEGRATION_KEYS.includes(key)) return res.status(400).json({ error: 'Unknown integration' });
  setPlatformIntegrationLock(key, !!locked);
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
app.post('/api/admin/mail/test', auth.requireAdmin, asyncHandler(async (req, res) => {
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
}));

// ─── Email templates / branding ────────────────────────────────────────────────
// Platform default (admin) and per-client overrides (admin + client self-serve).
// Branding fields are plain presentation (logo / colour / sender / wording) —
// never secrets — so they ride along to the browser freely.
const MAIL_FIELDS = Object.keys(mailer.DEFAULTS);
const cleanBrandingPatch = (body) => {
  const out = {};
  // Logo can be an uploaded data-URL (resized client-side, but still big).
  for (const k of MAIL_FIELDS) if (body && k in body) out[k] = String(body[k] ?? '').slice(0, (k === 'logo' || k === 'logoDark' || k === 'loginBackground') ? 1500000 : 4000);
  return out;
};

// Public, cacheable logo asset for emails: Gmail/Outlook strip data-URL images,
// so sends reference this URL instead. Serves the resolved logo for a client
// (or the platform template's). Logos are public-facing brand assets — no auth.
app.get('/mail-assets/logo/:scope', (req, res) => {
  const scope = req.params.scope;
  // scope is 'platform', an entity id, or a SUITE id (event-branded emails carry
  // the suite as their asset scope so this serves the event's resolved logo).
  const suite = scope !== 'platform' && !db.getEntity(scope) ? db.getSuite(scope) : null;
  const logo = scope === 'platform'
    ? mailer.getPlatformTemplate().logo
    : (db.getEntity(scope) ? mailer.resolveBranding(scope).logo
      : (suite ? mailer.resolveBranding(suite.entityId, scope).logo : ''));
  if (!logo) return res.status(404).end();
  if (!logo.startsWith('data:')) return res.redirect(302, logo); // external URL
  const m = logo.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!m) return res.status(404).end();
  const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  res.set('Content-Type', m[1] || 'image/png');
  res.set('Cache-Control', 'public, max-age=300'); // short: re-uploads show within minutes
  res.send(buf);
});

// Email-embedded images (e.g. digest tile charts) — served by unguessable token
// so a sent digest's <img> keeps resolving. Public (it's an email asset); the
// token is the capability. Cached long since the bytes never change.
app.get('/mail-assets/img/:token', (req, res) => {
  const a = db.getMailAsset(String(req.params.token || ''));
  if (!a) return res.status(404).end();
  res.set('Content-Type', a.mime || 'image/png');
  res.set('Cache-Control', 'public, max-age=2592000, immutable');
  res.send(Buffer.isBuffer(a.bytes) ? a.bytes : Buffer.from(a.bytes));
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

// Per-EVENT (suite) branding override (admin). Same shape; blank fields inherit
// the client. `resolved` shows the fully-layered result (defaults ← platform ←
// client ← event) so the editor's placeholders show what's inherited.
function suiteMailView(suite) {
  return { branding: db.getSuiteMailBranding(suite.id), resolved: mailer.resolveBranding(suite.entityId, suite.id), defaults: mailer.DEFAULTS };
}
app.get('/api/admin/suites/:id/mail-template', auth.requireAdmin, (req, res) => {
  const suite = db.getSuite(req.params.id);
  if (!suite) return res.status(404).json({ error: 'Not found' });
  res.json(suiteMailView(suite));
});
app.put('/api/admin/suites/:id/mail-template', auth.requireAdmin, (req, res) => {
  const suite = db.getSuite(req.params.id);
  if (!suite) return res.status(404).json({ error: 'Not found' });
  db.setSuiteMailBranding(req.params.id, cleanBrandingPatch(req.body || {}));
  res.json(suiteMailView(suite));
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

// Client self-service for a single EVENT (suite) they own — same per-event
// branding override as the admin surface, gated by suite access + branding.manage.
app.get('/api/my/suites/:id/mail-template', auth.requireAuth, (req, res) => {
  const suite = db.getSuite(req.params.id);
  if (!suite || !auth.canAccessSuite(req.user, suite.id)) return res.status(403).json({ error: 'Not allowed' });
  res.json(suiteMailView(suite));
});
app.put('/api/my/suites/:id/mail-template', auth.requireAuth, auth.requirePermission('branding.manage'), (req, res) => {
  const suite = db.getSuite(req.params.id);
  if (!suite || !auth.canAccessSuite(req.user, suite.id)) return res.status(403).json({ error: 'Not allowed' });
  db.setSuiteMailBranding(suite.id, cleanBrandingPatch(req.body || {}));
  res.json(suiteMailView(suite));
});

// ── White-label theme ──────────────────────────────────────────────────────────
// The client's brand pair (primary + secondary) + logo, resolved through the
// same layering as email branding (defaults ← platform ← client) — ONE brand
// source drives emails AND the platform look. Pure presentation, no secrets.
app.get('/api/theme/:entityId', auth.requireAuth, (req, res) => {
  const id = req.params.entityId;
  if (req.user.role !== 'admin' && !(req.user.entityIds || []).includes(id)) return res.status(403).json({ error: 'Not allowed' });
  if (!db.getEntity(id)) return res.status(404).json({ error: 'Not found' });
  // Optional ?suite= layers that event's branding on top (in-app theme follows
  // the event you're viewing); only honoured when the suite belongs to this client.
  const suiteId = String(req.query.suite || '');
  const suite = suiteId ? db.getSuite(suiteId) : null;
  const b = mailer.resolveBranding(id, suite && suite.entityId === id ? suiteId : '');
  // The app-shell logo (top-left identity) is ALWAYS the client's logo — the
  // per-event theme only swaps the colours in-app, never the main profile logo.
  // logoDark is the optional dark-mode variant (blank → shell uses `logo`).
  const shell = mailer.resolveBranding(id);
  res.json({ primary: b.brandColor, secondary: b.secondaryColor, chart3: b.chart3, chart4: b.chart4, chart5: b.chart5, logo: shell.logo || '', logoDark: shell.logoDark || '', metricScale: b.metricScale, currency: currency.normalize(b.currency) });
});

// Live preview: render the email HTML with unsaved edits layered on the right
// base. Clients may only preview their own entity.
app.post('/api/mail/preview', auth.requireAuth, (req, res) => {
  const { edits, entityId, suiteId } = req.body || {};
  if (entityId && req.user.role !== 'admin' && !(req.user.entityIds || []).includes(entityId)) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  // Event-branding editors preview on top of the event's resolved base — admins,
  // or a client previewing an event they own.
  const suite = suiteId ? db.getSuite(suiteId) : null;
  const canSuite = suite && (req.user.role === 'admin' || auth.canAccessSuite(req.user, suite.id));
  const branding = mailer.previewBranding({ edits: cleanBrandingPatch(edits || {}), entityId, suiteId: canSuite ? suiteId : '' });
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
  applyIntegrationsPatch(dropFrozenSections(req.params.id, req.body || {}), (k, v) => { patch[k] = v; });
  db.setEntityIntegrations(req.params.id, patch);
  res.json(entityIntegrationsView(req.params.id));
});
app.put('/api/admin/entities/:id/integrations/lock', auth.requireAdmin, (req, res) => {
  if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const { key, locked } = req.body || {};
  if (!ENTITY_INTEGRATION_KEYS.includes(key)) return res.status(400).json({ error: 'Unknown integration' });
  db.setEntityIntegrationLock(req.params.id, key, !!locked);
  res.json(entityIntegrationsView(req.params.id));
});

// Audience-sync health across all clients — connection state + per-channel sync
// outcomes (ok/errors, last activity, last error). Surfaces what the connectors
// already record so failures are visible without opening each client.
app.get('/api/admin/integrations/health', auth.requireAdmin, (_req, res) => {
  const clients = [];
  for (const e of db.listEntities()) {
    const m = meta.summary(e.id); const t = tiktok.summary(e.id); const s = socialMetrics.summary(e.id);
    if (!(m.configured || t.configured || m.audienceCount || t.audienceCount || s.configured || s.accountCount)) continue;
    clients.push({ entityId: e.id, name: e.name, channels: { meta: m, tiktok: t, social: s } });
  }
  // Most recently active (or failing) clients first.
  clients.sort((a, b) => String(b.channels.meta.lastAt || b.channels.tiktok.lastAt || '').localeCompare(String(a.channels.meta.lastAt || a.channels.tiktok.lastAt || '')));
  res.json({ clients });
});

// Live token check for one client's connector (makes a real API call).
app.post('/api/admin/integrations/:entityId/verify', auth.requireAdmin, asyncHandler(async (req, res) => {
  if (!db.getEntity(req.params.entityId)) return res.status(404).json({ error: 'Not found' });
  const channel = req.body?.channel === 'tiktok' ? tiktok : (req.body?.channel === 'meta' ? meta : (req.body?.channel === 'slack' ? slack : null));
  if (!channel) return res.status(400).json({ error: 'Unknown channel' });
  res.json(await channel.verify(req.params.entityId));
}));

// Live audience size/status read-back from the platform (real API call).
app.post('/api/admin/integrations/:entityId/audience-status', auth.requireAdmin, asyncHandler(async (req, res) => {
  if (!db.getEntity(req.params.entityId)) return res.status(404).json({ error: 'Not found' });
  const channel = req.body?.channel === 'tiktok' ? tiktok : (req.body?.channel === 'meta' ? meta : (req.body?.channel === 'slack' ? slack : null));
  if (!channel) return res.status(400).json({ error: 'Unknown channel' });
  res.json(await channel.audienceStatus(req.params.entityId, String(req.body?.audienceId || '')));
}));

// Append-only change-log timeline for a client's audience syncs.
app.get('/api/admin/integrations/:entityId/log', auth.requireAdmin, (req, res) => {
  if (!db.getEntity(req.params.entityId)) return res.status(404).json({ error: 'Not found' });
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  let rows = [];
  try { rows = db.db.prepare('SELECT entity_id, segment_id, channel, audience_id, received, added, removed, status, error, by, at FROM audience_sync_log WHERE entity_id=? ORDER BY id DESC LIMIT ?').all(req.params.entityId, limit); } catch { /* table may not exist yet */ }
  res.json({ log: rows });
});

// ── Client self-service: ad-audience hub (Meta/TikTok) scoped to one entity ──
// Mirrors the admin connector-health view but for the client's OWN entity, so
// they can see every audience Pulse mirrors out, its live size/status, and act.
// Ownership: admins pass; clients must own the entity.
function ownsEntity(req, id) { return req.user.role === 'admin' || (req.user.entityIds || []).includes(id); }
function audienceChannel(name) { return name === 'tiktok' ? tiktok : (name === 'meta' ? meta : null); }
app.get('/api/my/audiences/:entityId', auth.requireAuth, (req, res) => {
  const id = req.params.entityId;
  if (!ownsEntity(req, id)) return res.status(403).json({ error: 'Not allowed' });
  if (!db.getEntity(id)) return res.status(404).json({ error: 'Not found' });
  res.json({ channels: { meta: meta.summary(id), tiktok: tiktok.summary(id) } });
});
app.post('/api/my/audiences/:entityId/verify', auth.requireAuth, asyncHandler(async (req, res) => {
  const id = req.params.entityId;
  if (!ownsEntity(req, id)) return res.status(403).json({ error: 'Not allowed' });
  const channel = audienceChannel(req.body?.channel);
  if (!channel) return res.status(400).json({ error: 'Unknown channel' });
  res.json(await channel.verify(id));
}));
app.post('/api/my/audiences/:entityId/audience-status', auth.requireAuth, asyncHandler(async (req, res) => {
  const id = req.params.entityId;
  if (!ownsEntity(req, id)) return res.status(403).json({ error: 'Not allowed' });
  const channel = audienceChannel(req.body?.channel);
  if (!channel) return res.status(400).json({ error: 'Unknown channel' });
  res.json(await channel.audienceStatus(id, String(req.body?.audienceId || '')));
}));
// Live list of EVERY audience on the platform (Pulse-made or external). The hub
// reconciles these against Pulse's own records to flag what it manages.
app.get('/api/my/audiences/:entityId/platform/:channel', auth.requireAuth, asyncHandler(async (req, res) => {
  const id = req.params.entityId;
  if (!ownsEntity(req, id)) return res.status(403).json({ error: 'Not allowed' });
  const channel = audienceChannel(req.params.channel);
  if (!channel) return res.status(400).json({ error: 'Unknown channel' });
  if (typeof channel.listAudiences !== 'function') return res.json({ ok: false, error: 'Listing isn’t supported for this channel yet.' });
  res.json(await channel.listAudiences(id));
}));
app.get('/api/my/audiences/:entityId/log', auth.requireAuth, (req, res) => {
  const id = req.params.entityId;
  if (!ownsEntity(req, id)) return res.status(403).json({ error: 'Not allowed' });
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  let rows = [];
  try { rows = db.db.prepare('SELECT entity_id, segment_id, channel, audience_id, received, added, removed, status, error, by, at FROM audience_sync_log WHERE entity_id=? ORDER BY id DESC LIMIT ?').all(id, limit); } catch { /* table may not exist yet */ }
  res.json({ log: rows });
});

// ── Social metrics (INBOUND) — organic FB/IG/TikTok stats pulled into Pulse ──
// Dual-surface: admins read/refresh any client; clients read/refresh their OWN.
// `socialView` is the shared payload (summary + accounts + a default series +
// top posts); the caller can narrow with ?platform=&accountRef=&metric=&days=.
function socialView(id, q = {}) {
  const platform = q.platform ? String(q.platform) : undefined;
  const accountRef = q.accountRef ? String(q.accountRef) : undefined;
  const metric = q.metric ? String(q.metric) : 'reach';
  const sort = q.sort ? String(q.sort) : 'engagement';
  const days = Math.min(Math.max(Number(q.days) || 30, 1), 365);
  return {
    summary: socialMetrics.summary(id),
    accounts: socialMetrics.accounts(id),
    series: socialMetrics.accountSeries(id, { platform, accountRef, metric, days }),
    topPosts: socialMetrics.topPosts(id, { platform, sort, limit: 12 }),
  };
}
// Admin: any client.
app.get('/api/admin/entities/:id/social', auth.requireAdmin, (req, res) => {
  if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
  res.json(socialView(req.params.id, req.query));
});
app.post('/api/admin/entities/:id/social/sync', auth.requireAdmin, asyncHandler(async (req, res) => {
  if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
  res.json(await socialMetrics.syncEntity(req.params.id));
}));
app.post('/api/admin/entities/:id/social/verify', auth.requireAdmin, asyncHandler(async (req, res) => {
  if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
  res.json(await socialMetrics.verify(req.params.id));
}));
// Client self-service: the caller's OWN entity (ownership enforced).
app.get('/api/my/social/:entityId', auth.requireAuth, (req, res) => {
  const id = req.params.entityId;
  if (!ownsEntity(req, id)) return res.status(403).json({ error: 'Not allowed' });
  if (!db.getEntity(id)) return res.status(404).json({ error: 'Not found' });
  res.json(socialView(id, req.query));
});
app.post('/api/my/social/:entityId/sync', auth.requireAuth, auth.requirePermission('integrations.manage'), asyncHandler(async (req, res) => {
  const id = req.params.entityId;
  if (!ownsEntity(req, id)) return res.status(403).json({ error: 'Not allowed' });
  res.json(await socialMetrics.syncEntity(id));
}));
app.post('/api/my/social/:entityId/verify', auth.requireAuth, asyncHandler(async (req, res) => {
  const id = req.params.entityId;
  if (!ownsEntity(req, id)) return res.status(403).json({ error: 'Not allowed' });
  res.json(await socialMetrics.verify(id));
}));

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
  applyIntegrationsPatch(dropFrozenSections(req.params.entityId, req.body || {}), (k, v) => { patch[k] = v; });
  db.setEntityIntegrations(req.params.entityId, patch);
  res.json(entityIntegrationsView(req.params.entityId));
});
// Freeze / unfreeze a single integration for this client (admin or Owner).
app.put('/api/my/integrations/:entityId/lock', auth.requireAuth, auth.requirePermission('integrations.manage'), (req, res) => {
  if (!(req.user.entityIds || []).includes(req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
  const { key, locked } = req.body || {};
  if (!ENTITY_INTEGRATION_KEYS.includes(key)) return res.status(400).json({ error: 'Unknown integration' });
  db.setEntityIntegrationLock(req.params.entityId, key, !!locked);
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
    await aiUsage.run({ entityId: db.getSuite(suiteId)?.entityId || '', kind: 'tile_insight' }, () => insights.streamInsight({ title, visType, fields, rows, filters, userContext, history, instructions, apiKey }, (text) => res.write(text)));
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
    await aiUsage.run({ entityId: db.getSuite(suiteId)?.entityId || '', kind: 'tile_insight' }, () => insights.streamDashboardInsight({ title: def.title, filters: filterValues, tiles, instructions, apiKey }, (t) => res.write(t)));
    res.end();
  } catch (err) {
    console.error('[POST /api/dashboard-insight]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else { res.write(`\n\n[error: ${err.message}]`); res.end(); }
  }
});

// ─── Settlements & documents → server/settlements.js ───────────────────────────
// Extracted, self-contained module (own routes; behaviour unchanged). The global
// json parser still skips /api/admin/settlements* and /api/admin/documents* via
// `parsesOwnBody` above, so the module's own 40mb parser handles those uploads.
require('./settlements').mount(app, { db, auth, insights, anthropicKey: adminAnthropicKey });

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
    // Always surface the event's start/end dates so the briefing can anchor
    // timing (days to go, windows, comparisons) — independent of the phase.
    if (cfg.eventStart || cfg.eventEnd) {
      const range = cfg.eventStart && cfg.eventEnd && cfg.eventEnd !== cfg.eventStart
        ? `${cfg.eventStart} to ${cfg.eventEnd}`
        : (cfg.eventStart || cfg.eventEnd);
      lines.push(`Event dates: ${range}.`);
    }
    if (ph.key) {
      const label = PHASES.find((p) => p.key === ph.key)?.label || ph.key;
      const text = (cfg.phaseOverrides?.[ph.key] || '').trim() || defaults[ph.key];
      lines.push(`Current phase: ${label}. ${text}`);
    }
    if ((cfg.instructions || '').trim()) lines.push(cfg.instructions.trim());
    if (lines.length) parts.push(`For the event "${su.name}":\n${lines.join('\n')}`);
  }
  // Knowledge base: preferences distilled from past digest/briefing feedback for
  // this client. Applies to both the digest and the home briefing.
  const prefs = db.getDigestPrefs(entityId);
  if ((prefs.note || '').trim()) parts.push(`Preferences learned from this client's feedback on past digests/briefings — honour these:\n${prefs.note.trim()}`);
  const tune = db.getUserPref(user.id, `briefing_tune:${entityId}`).trim();
  if (tune) parts.push(`This reader's standing requests — always honour these:\n${tune}`);
  return parts.join('\n\n');
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

// In-memory snapshot cache (10 min). The briefing cache (memory + persisted disk +
// the 15-min warmer) lives in server/briefingCache.js so it survives redeploys.
const snapCache = new Map();
const cacheGet = (map, key, ttl) => { const e = map.get(key); return e && Date.now() - e.at < ttl ? e.val : null; };
const cachePut = (map, key, val) => { map.set(key, { at: Date.now(), val }); if (map.size > 500) map.delete(map.keys().next().value); };
const briefStore = require('./briefingCache')({
  sql: db.db,
  getUser: (id) => db.getUser(id),
  regenerate: async (user, entityId, segment) => {
    await generateBriefing(user, entityId, segment, { force: true });
    if (clientCatalogue(entityId).suites.length > 1) await generateEvents(user, entityId, segment, { force: true });
  },
});
const bustHome = (userId, entityId) => { snapCache.delete(`${userId}:${entityId}`); briefStore.bust(userId, entityId); };

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
// ── Multi-event briefing (portfolio overall + per-event sections) ─────────────
// The selected events for a client's briefing: default = ACTIVE events (phase not
// post_event); a user pref `briefing_suites:{entityId}` overrides. Returns the
// full suite list (with active+selected flags) and the resolved selection.
function briefingSuites(user, entityId) {
  const raw = clientCatalogue(entityId).suites;
  const list = raw.map((su) => ({ id: su.id, name: su.name, active: resolvePhase(su.briefing || {}).key !== 'post_event' }));
  const ids = new Set(list.map((s) => s.id));
  let selected = null;
  try { selected = JSON.parse(db.getUserPref(user.id, `briefing_suites:${entityId}`) || 'null'); } catch { selected = null; }
  if (Array.isArray(selected)) selected = selected.map(String).filter((id) => ids.has(id));
  if (!Array.isArray(selected) || !selected.length) {
    const active = list.filter((s) => s.active).map((s) => s.id);
    selected = active.length ? active : list.map((s) => s.id);
  }
  const sel = new Set(selected);
  return { suites: list.map((s) => ({ ...s, selected: sel.has(s.id) })), selected, raw };
}
const briefInstructions = (user, entityId, segment) => [aiInstructionsFor(null, entityId), briefingInstructionsFor(user, entityId, clientCatalogue(entityId).suites), segment ? timeDefaults()[segment] : ''].filter(Boolean).join('\n\n');
// Build briefing facts scoped to the selected events, grouped by event (in the
// selected order). Reuses buildFacts (and its Looker query cache).
async function factGroups(user, entityId, selectedIds, force) {
  const { tiles, catalogue, dropped = [], timing: factTiming } = await buildFacts(user, entityId, force, true, [], { suiteIds: selectedIds });
  const byId = Object.fromEntries(catalogue.map((c) => [c.dashboardId, c]));
  const map = new Map();
  for (const t of tiles) {
    if (!map.has(t.suiteId)) map.set(t.suiteId, { suiteId: t.suiteId, suiteName: t.suiteName || '', tiles: [] });
    map.get(t.suiteId).tiles.push(t);
  }
  return { groups: selectedIds.map((id) => map.get(id)).filter(Boolean), byId, dropped, factTiming };
}
// The portfolio OVERALL summary (fast, returned first). Includes the suite list
// so the home page can render the event picker + collapsed sections immediately.
async function generateOverall(user, entityId, segment, { force = false } = {}) {
  const apiKey = anthropicKeyForUser(user);
  const { suites, selected } = briefingSuites(user, entityId);
  const base = { available: true, multi: true, generatedAt: new Date().toISOString(), suites };
  if (!insights.isConfigured(apiKey) || !selected.length) return { ...base, headline: '', bullets: [] };
  const key = `${user.id}:${entityId}:${segment}:overall:${selected.join(',')}`;
  if (!force) { const hit = briefStore.serve(key, () => generateOverall(user, entityId, segment, { force: true })); if (hit) return hit; }
  if (briefInflight.has(key)) return briefInflight.get(key);
  const p = (async () => {
    const tStart = Date.now();
    const { groups, byId, factTiming } = await factGroups(user, entityId, selected, force);
    const factsMs = Date.now() - tStart;
    if (!groups.length) return { ...base, headline: '', bullets: [] };
    const { catalogue } = clientCatalogue(entityId);
    const tLlm = Date.now();
    const raw = await aiUsage.run({ entityId, kind: 'briefing' }, () => insights.briefHomeOverall({ groups, catalogue, capabilities: ACTION_CAPABILITIES, actions: actionsSummaryFor(entityId), today: todayLabel(), instructions: briefInstructions(user, entityId, segment), apiKey }));
    const llmMs = Date.now() - tLlm;
    const totalMs = Date.now() - tStart;
    console.log(`[briefing-timing] overall entity=${entityId} force=${!!force} events=${selected.length} total=${totalMs}ms facts=${factsMs}ms llm=${llmMs}ms`);
    const link = (id) => (id && byId[id] ? { dashboardId: id, suiteId: byId[id].suiteId, label: `${byId[id].setName} → ${byId[id].title}` } : null);
    // Each portfolio suggestion targets ONE event, which the AI returns as suiteId
    // (a shared dashboard can't identify the event on its own — byId is last-wins).
    // Trust the AI's suiteId only when it's one of the selected events.
    const selSet = new Set(selected);
    const out = {
      ...base,
      headline: String(raw.headline || '').slice(0, 600),
      bullets: (raw.bullets || []).slice(0, 4).map((b) => ({ text: clipWords(b.text, 400) })).filter((b) => b.text),
      // Cross-event "Worth a look" suggestions (so the portfolio home keeps them).
      suggestions: (raw.suggestions || []).slice(0, 3)
        .map((s) => {
          const lk = link(s.dashboardId);
          const evSuite = selSet.has(s.suiteId) ? s.suiteId : '';
          // The event the campaign should open against: the AI's, else the link's.
          const linkOut = lk ? { ...lk, suiteId: evSuite || lk.suiteId } : (evSuite ? { suiteId: evSuite } : null);
          return { title: clipWords(s.title, 80), reason: clipWords(s.reason, 200), link: linkOut, action: CAPABILITY_KEYS.has(s.action) ? s.action : null };
        })
        .filter((s) => s.title && (s.link || s.action)),
      _timing: { totalMs, factsMs, llmMs, facts: factTiming },
    };
    briefStore.put(key, out);
    return out;
  })().finally(() => briefInflight.delete(key));
  briefInflight.set(key, p);
  return p;
}
// The per-event sections (loaded after the overall — the slower pass).
// `debug` returns the raw resolved facts per event (no AI) — what FILTERS each
// tile actually ran with (so a wrong event lock is visible) + its headline value.
async function generateEvents(user, entityId, segment, { force = false, debug = false } = {}) {
  const apiKey = anthropicKeyForUser(user);
  const { suites, selected } = briefingSuites(user, entityId);
  if (suites.length <= 1 || !selected.length) return debug ? { diag: [] } : { events: [] };
  if (debug) {
    const { groups, dropped } = await factGroups(user, entityId, selected, true);
    const nameById = Object.fromEntries(suites.map((s) => [s.id, s.name]));
    const gById = Object.fromEntries(groups.map((g) => [g.suiteId, g]));
    // One entry per SELECTED event (even those with no facts), so an empty event's
    // cause is visible alongside the dropped-tile reasons below.
    return {
      diag: selected.map((id) => {
        const g = gById[id];
        return { suiteId: id, suiteName: nameById[id] || '', tiles: (g ? g.tiles : []).slice(0, 12).map((t) => ({ dashTitle: t.dashTitle, setName: t.setName, title: t.title, value: factValueLabel(t), filters: t.filters || {} })) };
      }),
      dropped: (dropped || []).slice(0, 50),
    };
  }
  if (!insights.isConfigured(apiKey)) return { events: [] };
  const key = `${user.id}:${entityId}:events:${selected.join(',')}`;
  if (!force) { const hit = briefStore.serve(key, () => generateEvents(user, entityId, segment, { force: true })); if (hit) return hit; }
  if (briefInflight.has(key)) return briefInflight.get(key);
  const p = (async () => {
    const tStart = Date.now();
    const { groups, byId } = await factGroups(user, entityId, selected, force);
    const factsMs = Date.now() - tStart;
    const nameById = Object.fromEntries(suites.map((s) => [s.id, s.name]));
    const tLlm = Date.now();
    const raw = groups.length ? await aiUsage.run({ entityId, kind: 'briefing' }, () => insights.briefHomeEvents({ groups, today: todayLabel(), instructions: briefInstructions(user, entityId, segment), apiKey })) : { events: [] };
    console.log(`[briefing-timing] events entity=${entityId} force=${!!force} events=${selected.length} total=${Date.now() - tStart}ms facts=${factsMs}ms llm=${Date.now() - tLlm}ms`);
    const link = (id) => (id && byId[id] ? { dashboardId: id, suiteId: byId[id].suiteId, label: `${byId[id].setName} → ${byId[id].title}` } : null);
    const aiById = Object.fromEntries((raw.events || []).filter((e) => nameById[e.suiteId]).map((e) => [e.suiteId, e]));
    const haveFacts = new Set(groups.map((g) => g.suiteId));
    // One section per SELECTED event, in order. Events that returned no data still
    // get a section (so all the chosen events are visible) with a clear note.
    const events = selected.map((id) => {
      const e = aiById[id];
      if (e) return {
        suiteId: id, suiteName: nameById[id] || '',
        headline: String(e.headline || '').slice(0, 400),
        bullets: (e.bullets || []).slice(0, 3).map((b) => ({ text: String(b.text || '').slice(0, 400), link: link(b.dashboardId) })).filter((b) => b.text),
      };
      return { suiteId: id, suiteName: nameById[id] || '', headline: haveFacts.has(id) ? 'No headline available for this event right now.' : 'No sales/activity recorded for this event yet.', bullets: [], empty: true };
    });
    const out = { events, generatedAt: new Date().toISOString(), _timing: { totalMs: Date.now() - tStart, factsMs } };
    briefStore.put(key, out);
    return out;
  })().finally(() => briefInflight.delete(key));
  briefInflight.set(key, p);
  return p;
}

async function generateBriefing(user, entityId, segment, { force = false } = {}) {
  const apiKey = anthropicKeyForUser(user);
  if (!insights.isConfigured(apiKey)) return { available: false };
  // Multi-event client → portfolio overall (per-event sections load separately).
  if (clientCatalogue(entityId).suites.length > 1) return generateOverall(user, entityId, segment, { force });
  const key = `${user.id}:${entityId}:${segment}`;
  if (!force) { const hit = briefStore.serve(key, () => generateBriefing(user, entityId, segment, { force: true })); if (hit) return hit; }
  if (briefInflight.has(key)) return briefInflight.get(key); // coalesce concurrent (prewarm + real)
  const p = (async () => {
    const { suites } = clientCatalogue(entityId);
    // Resolve the event goals (North Star first) with the SAME rich progress the
    // Goals page shows. Kick this off CONCURRENTLY with the fact sweep below —
    // both make Looker round-trips, so overlapping them cuts cold-load latency —
    // and resolve the goals themselves in parallel (not one await at a time).
    const goalsP = (async () => {
      try {
        const gcaches = goalsApi.makeGoalCaches();
        const picked = [];
        for (const su of suites) {
          for (const g of goalsApi.listGoals(su.id)) { picked.push({ g, suiteName: su.name }); if (picked.length >= 6) break; }
          if (picked.length >= 6) break;
        }
        const resolved = await Promise.all(picked.map(async ({ g, suiteName }) => ({ ...(await goalsApi.attachProgress(g, user, gcaches)), suiteName })));
        return resolved.sort((a, b) => (b.isNorthStar ? 1 : 0) - (a.isNorthStar ? 1 : 0)); // North Star first
      } catch (e) { console.error('[briefing] goals failed', e.message); return []; }
    })();
    // Read facts days-before-aligned (like-for-like to the same point in the
    // past event's cycle) wherever a dashboard has that sync configured — so the
    // briefing's comparisons match what the aligned dashboard shows.
    const tStart = Date.now();
    const { tiles, catalogue, timing: factTiming, dropped = [], focusDiag = [] } = await buildFacts(user, entityId, force, true);
    const factsMs = Date.now() - tStart;
    if (!tiles.length) return { available: false };
    const byId = Object.fromEntries(catalogue.map((c) => [c.dashboardId, c]));
    const prof = db.viewProfile(user.id);
    const profileForAi = {
      lastVisit: prof.lastVisit,
      top: prof.top.filter((t) => byId[t.dashboardId]).map((t) => ({ title: byId[t.dashboardId].title, count: t.count })),
    };
    const instructions = [aiInstructionsFor(null, entityId), briefingInstructionsFor(user, entityId, suites), timeDefaults()[segment]].filter(Boolean).join('\n\n');
    const msgs = recentMessages(entityId, user.id);
    const tGoals = Date.now();
    const goals = await goalsP;
    const goalsWaitMs = Date.now() - tGoals;
    const tLlm = Date.now();
    const raw = await aiUsage.run({ entityId, kind: 'briefing' }, () => insights.briefHome({ tiles, profile: profileForAi, catalogue, instructions, apiKey, actions: actionsSummaryFor(entityId), messages: msgs, capabilities: ACTION_CAPABILITIES, goals, today: todayLabel() }));
    const llmMs = Date.now() - tLlm;
    const totalMs = Date.now() - tStart;
    const _timing = { totalMs, factsMs, goalsWaitMs, llmMs, facts: factTiming };
    console.log(`[briefing-timing] single entity=${entityId} force=${!!force} total=${totalMs}ms facts=${factsMs}ms goalsWait=${goalsWaitMs}ms llm=${llmMs}ms`);
    const link = (id) => (id && byId[id] ? { dashboardId: id, suiteId: byId[id].suiteId, label: `${byId[id].setName} → ${byId[id].title}` } : null);
    const msgIds = new Set(msgs.map((m) => m.id));
    const out = { // _focus/_dropped: admin-only diagnose — why each focus pick did/didn't feed (see ClientHome)
      available: true, ...(user.role === 'admin' ? { _focus: focusDiag, _dropped: dropped } : {}),
      generatedAt: new Date().toISOString(),
      headline: String(raw.headline || '').slice(0, 600),
      bullets: (raw.bullets || []).slice(0, 4)
        .map((b) => ({ text: clipWords(b.text, 400), link: link(b.dashboardId), threadId: msgIds.has(b.threadId) ? b.threadId : null }))
        .filter((b) => b.text),
      suggestions: (raw.suggestions || []).slice(0, 3)
        .map((s) => ({ title: clipWords(s.title, 80), reason: clipWords(s.reason, 200), link: link(s.dashboardId), action: CAPABILITY_KEYS.has(s.action) ? s.action : null }))
        .filter((s) => s.title && s.link),
      _timing,
    };
    briefStore.put(key, out);
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

// Per-event sections of a multi-event briefing — loaded AFTER the overall so the
// summary shows immediately while these (the slower pass) fill in.
app.get('/api/my/briefing/events', auth.requireAuth, async (req, res) => {
  const entityId = homeEntityFor(req);
  if (!entityId) return res.json({ events: [] });
  try {
    const debug = req.query.debug === '1' && req.user.role === 'admin'; // resolved-filters view (admin only)
    const out = await generateEvents(req.user, entityId, timeSegment(Number(req.query.hour)), { force: !!req.query.refresh || debug, debug });
    res.json(out);
  } catch (err) {
    console.error('[GET /api/my/briefing/events]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Which events the briefing covers (per-user). Empty/absent → default (active events).
app.put('/api/my/briefing/suites', auth.requireAuth, (req, res) => {
  const entityId = req.body?.entityId || homeEntityFor(req);
  if (!entityId) return res.status(400).json({ error: 'No client context' });
  const ids = new Set(clientCatalogue(entityId).suites.map((s) => s.id));
  const want = Array.isArray(req.body?.suites) ? [...new Set(req.body.suites.map(String).filter((id) => ids.has(id)))] : [];
  db.setUserPref(req.user.id, `briefing_suites:${entityId}`, JSON.stringify(want));
  bustHome(req.user.id, entityId);
  res.json(briefingSuites(req.user, entityId));
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

// ─── Inventive ("Ask" analyst) → server/inventive.js ───────────────────────────
// Extracted, self-contained module (own routes; behaviour unchanged). homeEntityFor
// stays here (shared helper) and is injected. The admin config UI for the Inventive
// keys lives with the integrations routes above.
require('./inventive').mount(app, { db, auth, homeEntityFor });

// ─── Scheduled digests: role-lensed content builder ────────────────────────────
// Default role "lenses" — what the analyst leads with for each audience. Editable
// per client later; the job may also carry a custom focus override.
const ROLE_LENSES = {
  exec: { label: 'Executive', focus: 'Overall event health, revenue vs target and pacing, margin, and the biggest risks & opportunities. Board-level and strategic; suggested actions are strategic decisions.' },
  marketing: { label: 'Marketing', focus: 'Demand and sales pace, channel/source performance, conversion, promo and campaign ROI, and audience mix. Tactical; suggested actions are marketing moves.' },
  finance: { label: 'Finance', focus: 'Revenue, fees and costs, settlements and reconciliation, refunds and cashflow. Precise and numbers-first; suggested actions are financial/operational.' },
  ops: { label: 'Operations', focus: 'Capacity and sell-through, entry/redemption and on-the-day readiness, staffing and logistics. Suggested actions are operational prep.' },
};

// Produce a role-lensed digest's structured content (links resolved). Throws if
// AI/Looker isn't configured or there's no data — callers decide how to surface.
async function buildDigestContent({ entityId, role, roleFocus, focusMode, contentMode, tiles, alignDaysBefore = false, priorityDashboards = [], includeFollowed = false, followedVisual = false, followedTiles = [], includeGoals = false, suiteIds = [], creatorEmail = '', recipientEmail, debug = false }) {
  const apiKey = anthropicKeyForEntity(entityId);
  if (!insights.isConfigured(apiKey)) throw new Error('AI is not configured for this client');
  const lens = ROLE_LENSES[role] || ROLE_LENSES.exec;
  // Custom focus either OVERRIDES the role lens or BLENDS on top of it.
  const customFocus = String(roleFocus || '').trim();
  const effectiveFocus = !customFocus ? lens.focus
    : (focusMode === 'blend' ? `${lens.focus}\n\nExtra emphasis for this digest: ${customFocus}` : customFocus);
  let user = recipientEmail ? db.getUserByEmail(recipientEmail) : null;
  if (!user || !(user.entityIds || []).includes(entityId)) user = { id: `digest:${entityId}`, email: recipientEmail || '', role: 'client', entityIds: [entityId] };
  // Which events this digest covers. A multi-event client can scope the digest to
  // a subset of its events (suiteIds); empty = all events. Below one event we keep
  // the single-event layout exactly as before.
  const allSuites = clientCatalogue(entityId).suites;
  const validSuite = new Set(allSuites.map((s) => s.id));
  let selSuiteIds = Array.isArray(suiteIds) ? [...new Set(suiteIds.map(String).filter((id) => validSuite.has(id)))] : [];
  if (!selSuiteIds.length) selSuiteIds = allSuites.map((s) => s.id);
  const selSet = new Set(selSuiteIds);
  const multiClient = allSuites.length > 1;
  const multi = multiClient && selSuiteIds.length > 1;
  // Brand the email with the EVENT's branding when the digest covers exactly one
  // event; a multi-event (portfolio) digest keeps the client-level branding.
  const brandingSuiteId = selSuiteIds.length === 1 ? selSuiteIds[0] : '';

  // Curated picks scoped to the selected events (each pick resolves under its
  // dashboard's event); AI mode scopes the fact sweep via suiteIds.
  let curatedPicks = tiles || [];
  if (contentMode === 'curated' && multiClient && selSuiteIds.length < allSuites.length) {
    const cMeta = Object.fromEntries(clientCatalogue(entityId).catalogue.map((c) => [c.dashboardId, c]));
    curatedPicks = curatedPicks.filter((p) => { const m = cMeta[String(p.dashboardId)]; return m && selSet.has(m.suiteId); });
  }
  const { tiles: factTiles, catalogue, dropped = [] } = (contentMode === 'curated' && (tiles || []).length)
    ? await buildFactsFromTiles(user, entityId, curatedPicks, alignDaysBefore)
    : await buildFacts(user, entityId, false, alignDaysBefore, priorityDashboards, multiClient ? { suiteIds: selSuiteIds } : {});

  // Saved tiles: the 📌 pinned + ⭐ followed tiles marked as mattering. Pulled in
  // on top of whatever the mode produced, so they ride along in BOTH AI-led and
  // curated digests — added to the facts the analyst reads, and (when
  // followedVisual) rendered as charts/metric chips. When the digest names an
  // explicit subset (`followedTiles`) we use those tiles DIRECTLY (no re-resolving
  // marks, so the editor's checklist and the send never disagree — buildFacts
  // still validates each against the client's catalogue + scope). Empty subset =
  // all of the creator's saved tiles for this client.
  let followedFacts = [];
  if (includeFollowed) {
    let followPicks;
    if (Array.isArray(followedTiles) && followedTiles.length) {
      followPicks = followedTiles.map((t) => ({ dashboardId: String(t.dashboardId), tileId: String(t.tileId) }));
    } else {
      const creatorId = creatorEmail ? (db.getUserByEmail(creatorEmail)?.id || '') : '';
      followPicks = savedTileMarks(entityId, creatorId).map((m) => ({ dashboardId: m.dashboardId, tileId: m.tileId }));
    }
    if (followPicks.length) {
      try { followedFacts = (await buildFactsFromTiles(user, entityId, followPicks, alignDaysBefore)).tiles || []; }
      catch (e) { console.error('[digest] followed facts failed', e.message); }
    }
  }
  const factTilesAll = [...factTiles];
  const seenSig = new Set(factTiles.map((t) => `${t.dashboardId}|${t.title}`));
  for (const t of followedFacts) { const s = `${t.dashboardId}|${t.title}`; if (!seenSig.has(s)) { factTilesAll.push(t); seenSig.add(s); } }
  if (!factTilesAll.length) throw new Error('No tile data available to summarise');

  // Goals summary (opt-in) — resolve the entity's event goals with the SAME rich
  // progress the Goals page shows (curve current, vs-last-time, pace, forecast), so the
  // digest can carry a goals bullet. Capped to bound the per-goal Looker reads.
  let goals = [];
  if (includeGoals) {
    try {
      const caches = goalsApi.makeGoalCaches();
      for (const su of (db.listSuitesForEntity(entityId) || [])) {
        for (const g of goalsApi.listGoals(su.id)) {
          goals.push({ ...(await goalsApi.attachProgress(g, user, caches)), suiteName: su.name });
          if (goals.length >= 8) break;
        }
        if (goals.length >= 8) break;
      }
    } catch (e) { console.error('[digest] goals summary failed', e.message); }
  }

  const byId = Object.fromEntries(catalogue.map((c) => [c.dashboardId, c]));
  const instructions = [aiInstructionsFor(null, entityId), briefingInstructionsFor(user, entityId, clientCatalogue(entityId).suites)].filter(Boolean).join('\n\n');
  // Deep links carry the EVENT the content is about (`evSuite`), not byId's
  // last-wins suite — a dashboard shared across events would otherwise link to
  // the wrong one. Per-event sections pass their own suite; the cross-event
  // overview passes the AI-identified suite; a single-event digest its one suite.
  const href = (id, evSuite) => { const c = id && byId[id]; return c ? `${mailer.baseUrl()}/suite/${evSuite || c.suiteId}/d/${id}` : ''; };
  // A suggested action with an executable capability deep-links into the
  // pre-filled "Make it happen" campaign editor (recipe auto-resolves the
  // audience + copy), scoped to its event; otherwise it links to the dashboard.
  const actionHref = (a, evSuite) => (CAPABILITY_KEYS.has(a.action)
    ? `${mailer.baseUrl()}/engage/campaigns?type=${encodeURIComponent(a.action)}&goal=${encodeURIComponent(clipWords(a.text, 200))}${evSuite ? `&suite=${encodeURIComponent(evSuite)}` : ''}${a.dashboardId && byId[a.dashboardId] ? `&dashboard=${encodeURIComponent(a.dashboardId)}` : ''}`
    : href(a.dashboardId, evSuite));
  const mapKpi = (k, evSuite) => ({ label: String(k.label || '').slice(0, 40), value: String(k.value || '').slice(0, 30), delta: String(k.delta || '').slice(0, 40), href: href(k.dashboardId, evSuite) });
  const mapAction = (a, evSuite) => ({ text: clipWords(a.text, 200), href: actionHref(a, evSuite), action: CAPABILITY_KEYS.has(a.action) ? a.action : null });
  // Render a set of followed-tile facts as email visuals — chart tiles become a
  // PNG mail asset, single-value/table tiles become a metric chip. Best-effort.
  const renderFollowed = (facts) => {
    const branding = mailer.resolveBranding(entityId, brandingSuiteId);
    const base = mailer.baseUrl();
    let tileimg = null;
    try { tileimg = require('./tileimg'); } catch (e) { console.error('[digest] tileimg load failed', e.message); }
    const charts = []; const kpis = [];
    for (const ft of facts) {
      const tileShim = { title: ft.title, vis: { type: ft.visType } };
      const png = tileimg ? tileimg.renderTilePng(tileShim, ft, branding) : null;
      if (png) {
        const token = crypto.randomUUID();
        db.putMailAsset(token, 'image/png', png);
        charts.push({ title: ft.title, imageUrl: `${base}/mail-assets/img/${token}`, href: href(ft.dashboardId, ft.suiteId) });
      } else {
        const v = factValueLabel(ft);
        if (v && v !== '—') kpis.push({ label: String(ft.title || '').slice(0, 40), value: String(v).slice(0, 30), delta: '', href: href(ft.dashboardId, ft.suiteId) });
      }
    }
    return { charts, kpis };
  };

  // The single-pass (flat) digest over all the facts — used for single-event
  // clients, and as the safety net if the multi-event pass can't be produced.
  const buildFlat = async () => {
    const raw = await aiUsage.run({ entityId, kind: 'digest' }, () => insights.digestBrief({ tiles: factTilesAll, roleLabel: lens.label, roleFocus: effectiveFocus, catalogue, instructions, apiKey, actions: actionsSummaryFor(entityId), capabilities: ACTION_CAPABILITIES, goals, today: todayLabel() }));
    // A single-event digest scopes all its links/actions to that one event; the
    // multi-event fallback (flat over several) has no single event to assert.
    const flatSuite = selSuiteIds.length === 1 ? selSuiteIds[0] : '';
    const o = {
      subject: String(raw.subject || '').slice(0, 120),
      headline: String(raw.headline || '').slice(0, 600),
      narrative: (raw.narrative || []).slice(0, 5).map((s) => String(s).slice(0, 800)).filter(Boolean),
      kpis: (raw.kpis || []).slice(0, 6).map((k) => mapKpi(k, flatSuite)).filter((k) => k.label && k.value),
      actions: (raw.actions || []).slice(0, 3).map((a) => mapAction(a, flatSuite)).filter((a) => a.text),
    };
    // Followed-tile visuals lead the single-event KPI strip / add chart blocks.
    if (followedVisual && followedFacts.length) {
      const { charts, kpis } = renderFollowed(followedFacts);
      if (charts.length) o.charts = charts.slice(0, 6);
      if (kpis.length) o.kpis = [...kpis, ...o.kpis].slice(0, 9);
    }
    return o;
  };

  let out;
  if (multi) {
    // Multi-event: a short cross-event OVERVIEW, then a clearly-separated section
    // per event. Each event's section is written by the SAME proven single-event
    // digest call, scoped to that event's tiles — so every model response stays
    // small and reliable (no one giant JSON to truncate). Overview + per-event all
    // run in parallel. If the whole thing fails, fall back to a flat digest.
    try {
      const nameById = Object.fromEntries(allSuites.map((s) => [s.id, s.name]));
      const bySuite = new Map();
      for (const t of factTilesAll) { if (!bySuite.has(t.suiteId)) bySuite.set(t.suiteId, []); bySuite.get(t.suiteId).push(t); }
      const groups = selSuiteIds.map((id) => ({ suiteId: id, suiteName: nameById[id] || '', tiles: bySuite.get(id) || [] })).filter((g) => g.tiles.length);
      const today = todayLabel();
      const acts = actionsSummaryFor(entityId);
      // Followed-tile visuals, grouped into the event each tile belongs to.
      const visualsBySuite = {};
      if (followedVisual && followedFacts.length) {
        for (const ft of followedFacts) { (visualsBySuite[ft.suiteId] = visualsBySuite[ft.suiteId] || []).push(ft); }
        for (const id of Object.keys(visualsBySuite)) visualsBySuite[id] = renderFollowed(visualsBySuite[id]);
      }
      const [ovRaw, evRaws] = await aiUsage.run({ entityId, kind: 'digest' }, () => Promise.all([
        insights.digestBriefMulti({ groups, roleLabel: lens.label, roleFocus: effectiveFocus, catalogue, instructions, apiKey, actions: acts, capabilities: ACTION_CAPABILITIES, goals, today }),
        Promise.all(groups.map((g) => insights.digestBrief({ tiles: g.tiles, roleLabel: lens.label, roleFocus: effectiveFocus, catalogue, instructions, apiKey, actions: acts, capabilities: ACTION_CAPABILITIES, goals: [], today })
          .then((r) => ({ g, r }))
          .catch((e) => { console.error(`[digest] event section failed (${g.suiteName}):`, e.message); return { g, r: null }; }))),
      ]));
      const events = evRaws.map(({ g, r }) => {
        const e = r || {};
        const sect = {
          suiteId: g.suiteId, suiteName: g.suiteName,
          headline: r ? String(e.headline || '').slice(0, 400) : 'Summary unavailable for this event right now.',
          narrative: (e.narrative || []).slice(0, 3).map((s) => String(s).slice(0, 800)).filter(Boolean),
          kpis: (e.kpis || []).slice(0, 6).map((k) => mapKpi(k, g.suiteId)).filter((k) => k.label && k.value),
          actions: (e.actions || []).slice(0, 3).map((a) => mapAction(a, g.suiteId)).filter((a) => a.text),
        };
        const vis = visualsBySuite[g.suiteId];
        if (vis) { if (vis.charts.length) sect.charts = vis.charts.slice(0, 6); if (vis.kpis.length) sect.kpis = [...vis.kpis, ...sect.kpis].slice(0, 9); }
        return sect;
      });
      // The overview's executable actions target one event, which the AI returns
      // as suiteId; trust it only when it's one of the events this digest covers.
      const selSet = new Set(selSuiteIds);
      out = {
        subject: String(ovRaw.subject || '').slice(0, 120),
        headline: String(ovRaw.headline || '').slice(0, 600),
        narrative: (ovRaw.narrative || []).slice(0, 4).map((s) => String(s).slice(0, 800)).filter(Boolean),
        kpis: (ovRaw.kpis || []).slice(0, 6).map((k) => mapKpi(k)).filter((k) => k.label && k.value),
        actions: (ovRaw.actions || []).slice(0, 3).map((a) => mapAction(a, selSet.has(a.suiteId) ? a.suiteId : '')).filter((a) => a.text),
        events,
        eventCount: events.length,
      };
    } catch (e) {
      console.error('[digest] multi-event generation failed, falling back to a single combined digest:', e.message);
      out = await buildFlat();
    }
  } else {
    out = await buildFlat();
  }
  // The event whose branding the email should use ('' = client-level / portfolio).
  out.brandingSuiteId = brandingSuiteId;

  // Diagnostic: the exact tiles the analyst read + the value each returned under
  // the digest's scope — so a mismatch with the dashboard (wrong tile / missing
  // event lock) is visible at a glance. `dropped` lists the tiles that were
  // EXCLUDED and why (scope blocked vs no rows vs error) — so a missing source
  // (e.g. GA4) isn't a black box. Only attached when explicitly requested.
  if (debug) {
    out.facts = factTilesAll.map((t) => ({ dashTitle: t.dashTitle, setName: t.setName, title: t.title, value: factValueLabel(t), suiteName: byId[t.dashboardId]?.suiteName || '', filters: t.filters || {} }));
    out.dropped = dropped;
  }
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
// People-data heuristic: does a tile's query expose an email or phone/mobile
// column? Used to offer ONLY tiles with usable contact data when building a
// segment (a segment needs an email or mobile per person). Name-based, mirroring
// how CreateSegmentModal guesses the email/phone columns.
const CONTACT_FIELD_RE = /(e-?mail|phone|mobile|cell|msisdn|contact.?number)/i;
function tileHasContact(t) {
  return (t.query?.fields || []).some((f) => CONTACT_FIELD_RE.test(String(f)));
}
function digestTileCatalogue(entityId) {
  const { catalogue } = clientCatalogue(entityId);
  const dashboards = [];
  for (const c of catalogue) {
    const def = store.get(c.dashboardId);
    if (!def) continue;
    const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((x) => x.tiles || []))]
      .filter((t) => t.type !== 'text' && t.query?.fields?.length)
      .map((t) => ({ tileId: t.id, title: t.title || '(untitled)', visType: t.vis?.type || '', hasContact: tileHasContact(t) }));
    if (tiles.length) dashboards.push({ dashboardId: c.dashboardId, title: c.title, setName: c.setName, suiteId: c.suiteId, suiteName: c.suiteName, tiles });
  }
  return { dashboards };
}
app.get('/api/admin/entities/:id/digest-tiles', auth.requireAdmin, (req, res) => {
  if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
  res.json(digestTileCatalogue(req.params.id));
});
app.get('/api/my/digest-tiles/:entityId', auth.requireAuth, (req, res) => {
  // Admins can act as any client (preview), so they pass the ownership check.
  if (req.user.role !== 'admin' && !(req.user.entityIds || []).includes(req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
  res.json(digestTileCatalogue(req.params.entityId));
});

// The client's events (suites) a digest can be scoped to — id, name, and whether
// the event is still active (on sale). Drives the digest editor's event picker;
// only shown there for multi-event clients.
function digestEventList(entityId) {
  return { events: clientCatalogue(entityId).suites.map((su) => ({ id: su.id, name: su.name, active: resolvePhase(su.briefing || {}).key !== 'post_event' })) };
}
app.get('/api/admin/entities/:id/digest-events', auth.requireAdmin, (req, res) => {
  if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
  res.json(digestEventList(req.params.id));
});
app.get('/api/my/digest-events/:entityId', auth.requireAuth, (req, res) => {
  if (req.user.role !== 'admin' && !(req.user.entityIds || []).includes(req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
  res.json(digestEventList(req.params.entityId));
});
require('./categories').mount(app, { db, auth }); // custom categories (tags) shared by goals + alerts
// The SAVED tiles for a viewer — the ones marked as mattering, whether 📌 pinned
// (shown on home) or ⭐ followed (always read by the briefing). `userId` returns
// that viewer's own ('user') marks PLUS the client's ('entity') marks — exactly
// what the home Pinned/briefing sees — so the digest checklist matches what you
// actually see pinned. Deduped across kinds.
function savedTileMarks(entityId, userId = '') {
  const marks = [...db.listMarks({ userId, entityId, kind: 'pin' }), ...db.listMarks({ userId, entityId, kind: 'follow' })];
  const byKey = new Map();
  for (const m of marks) {
    const key = `${m.dashboardId}|${m.tileId}`;
    if (!byKey.has(key)) byKey.set(key, { dashboardId: m.dashboardId, tileId: m.tileId, kinds: new Set() });
    byKey.get(key).kinds.add(m.kind === 'follow' ? 'follow' : 'pin');
  }
  return [...byKey.values()];
}
function followedTilesFor(entityId, userId = '') {
  const { catalogue } = clientCatalogue(entityId);
  const meta = Object.fromEntries(catalogue.map((c) => [c.dashboardId, c]));
  const out = [];
  for (const m of savedTileMarks(entityId, userId)) {
    const def = store.get(m.dashboardId);
    const c = meta[m.dashboardId];
    if (!def || !c) continue; // only tiles still in this client's catalogue
    const tile = [...(def.tiles || []), ...((def.carousels || []).flatMap((x) => x.tiles || []))].find((t) => t.id === m.tileId);
    if (!tile || tile.type === 'text') continue;
    out.push({ dashboardId: m.dashboardId, tileId: m.tileId, title: tile.title || '(untitled)', visType: tile.vis?.type || '', dashTitle: c.title, setName: c.setName, suiteName: c.suiteName, kinds: [...m.kinds] });
  }
  return { tiles: out };
}
app.get('/api/admin/entities/:id/followed-tiles', auth.requireAdmin, (req, res) => {
  if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
  res.json(followedTilesFor(req.params.id, req.user.id));
});
app.get('/api/my/followed-tiles/:entityId', auth.requireAuth, (req, res) => {
  if (req.user.role !== 'admin' && !(req.user.entityIds || []).includes(req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
  res.json(followedTilesFor(req.params.entityId, req.user.id));
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
app.post('/api/admin/sms-test', auth.requireAdmin, asyncHandler(async (req, res) => {
  const to = String((req.body || {}).to || '').trim();
  if (!to) return res.status(400).json({ error: 'A phone number is required' });
  const r = await messaging.sendSms({ to, text: 'Howler : Pulse — SMS is connected ✓' });
  res.json(r);
}));

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
    // One entry per (suite, dashboard) — a dashboard shared across events appears
    // once per event, carrying its suiteId so the audience can scope to that event.
    if (tiles.length) dashboards.push({ dashboardId: c.dashboardId, suiteId: c.suiteId, title: c.title, tiles });
  }
  return dashboards;
}
// The templates a client can run, each with its audience pre-resolved + presets.
// `prefer` ({ dashboardId, suiteId }) — when a suggestion pointed at a specific
// dashboard/event (e.g. "Worth a look" → abandoned carts), try that one FIRST so
// the audience resolves to exactly that event for a multi-event client.
function resolveActionTemplates(entityId, prefer = {}) {
  let dashboards = tileCatalogueWithFields(entityId);
  const { dashboardId, suiteId } = prefer;
  if (dashboardId) {
    const isPref = (d) => d.dashboardId === dashboardId && (!suiteId || d.suiteId === suiteId);
    dashboards = [...dashboards.filter(isPref), ...dashboards.filter((d) => !isPref(d))];
  }
  return actionTemplates.list().map((meta) => {
    const t = actionTemplates.get(meta.key);
    const resolved = actionTemplates.resolveAudience(t, dashboards);
    const eventSuiteId = resolved.ready ? (resolved.suiteId || '') : '';
    return { ...meta, preset: t.preset, ready: resolved.ready, audience: resolved.ready ? { mode: 'tile', ...resolved, eventSuiteId } : { mode: 'tile' } };
  });
}
app.get('/api/action-templates/:entityId', auth.requireAuth, auth.requirePermission('campaigns.view'), (req, res) => {
  res.json({ templates: resolveActionTemplates(req.params.entityId, { dashboardId: String(req.query.dashboard || ''), suiteId: String(req.query.suite || '') }) });
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

// ─── Digests: delivery + history + feedback → server/digests.js ────────────────
// Disposable module: /df feedback pages, in-app digest archive, the preference-
// learning loop, and the scheduler mount (recurring digest delivery). Mounted
// here, after its content builder (buildDigestContent) + role lenses exist.
waDigestFor = (require('./digests').mount(app, { db, auth, mailer, messaging, push, insights, buildDigestContent, ROLE_LENSES, anthropicKeyForEntity, inboxView, notifyOps: (m) => ops.alert('digest', m) }) || {}).whatsappDigestFor;

// Onboarding checklist — light-touch "Getting started" guide (auto-detect + manual).
require('./onboarding').mount(app, { db, auth });

// Client setup wizard config — lets AMs edit the back-end setup wizard (step
// wording, order, and their own custom guidance steps) from the admin UI.
require('./setupWizard').mount(app, { db, auth });

// PWA install tracking — records when a user opens Pulse as an installed app.
require('./installs').mount(app, { db, auth });

// Onboarding & feature telemetry — usage signals to refine the wizard from real behaviour.
require('./telemetry').mount(app, { db, auth, rateLimit });

// Campaign email templates — reusable email content, applied when building a campaign.
require('./campaignTemplates').mount(app, { db, auth });

// Campaign billing — per-channel rate card (master + per-client) + cost math.
// Mounted before the action engine so its cost helpers can be passed in.
const billing = require('./billing').mount(app, { db, auth });

// Action Engine — suggested actions → executed automations (v1: email campaigns,
// e.g. abandoned cart). Audience = a dashboard tile's query, run with the SAME
// organiser scoping as the dashboards themselves. Remove this line + actions.js
// to uninstall.
const actionsApi = require('./actions').mount(app, {
  db, auth, mailer, push, messaging, os, billing,
  // Run a tile's query (scoped + suite-locked) and return its rows + fields —
  // the campaign audience source.
  resolveAudience: async ({ entityId, dashboardId, tileId, user, filterOverrides = {}, suiteId = '', limit }) => {
    const { catalogue } = clientCatalogue(entityId);
    // A dashboard shared across events appears once per event — scope to the
    // campaign's chosen event (suiteId) so its locks resolve the right cohort;
    // fall back to the first event if none was specified.
    const meta = (suiteId && catalogue.find((c) => c.dashboardId === dashboardId && c.suiteId === suiteId))
      || catalogue.find((c) => c.dashboardId === dashboardId);
    const def = store.get(dashboardId);
    if (!meta || !def) throw new Error('That dashboard is not available for this client');
    const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
    const tile = tiles.find((t) => t.id === tileId);
    if (!tile) throw new Error('Tile not found on that dashboard');
    const lockMap = expandLockMap(db.lockedFiltersForSuite(meta.suiteId));
    const qBody = await tileQueryBody(tile, def, user, meta.suiteId, lockMap, filterOverrides);
    if (!qBody) throw new Error('No data access for that tile');
    // Fields via a cached 1-row json_detail probe; bulk rows via the compact `json` format (same field-name keys, plain values — cellVal copes) because json_detail's per-cell metadata at 50k+ rows can exceed Node's max string length.
    const probe = await runLookerQuery('/queries/run/json_detail', { ...qBody, limit: '1' });
    const fields = [...(probe.fields?.dimensions || []), ...(probe.fields?.measures || []), ...(probe.fields?.table_calculations || [])].map((f) => ({ name: f.name, label: f.label_short || f.label }));
    const rows = await runLookerQuery('/queries/run/json', { ...qBody, limit: String(Math.min(Math.max(Number(limit) || 50000, 1000), 500000)) }, undefined, true);
    return { rows: Array.isArray(rows) ? rows : [], fields };
  },
  // The client's events (suites) — for optionally linking a campaign to one.
  listEvents: (entityId) => db.listSuitesForEntity(entityId).map((s) => ({ id: s.id, name: s.name, url: s.eventUrl || '' })),
  // AI-draft campaign copy, grounded in the client's context AND the event it's for (name + briefing + event-resolved currency) so the copy is on-event.
  draftCopy: async ({ entityId, goal, audienceCount, eventSuiteId, language: langOverride }) => {
    const apiKey = anthropicKeyForEntity(entityId);
    if (!insights.isConfigured(apiKey)) throw new Error('AI is not configured for this client');
    const ent = db.getEntity(entityId); const su = eventSuiteId ? db.getSuite(eventSuiteId) : null;
    return aiUsage.run({ entityId, kind: 'campaign_draft' }, () => insights.draftCampaign({ goal, clientName: ent?.name, clientContext: ent?.aiContext || '', audienceCount, apiKey, instructions: [aiInstructionsFor(eventSuiteId || null, entityId, langOverride), su ? `This campaign is for the event "${su.name}"${su.briefing?.instructions ? ` — ${String(su.briefing.instructions).trim()}` : ''}. Write for THIS event specifically.` : ''].filter(Boolean).join('\n\n') }));
  },
});
require('./emailBanner').mount(app, { auth, insights, anthropicKeyForEntity, aiInstructionsFor, resolveBranding: mailer.resolveBranding }); // AI email-banner designer (SVG → PNG)
const aiUsage = require('./aiUsage'); aiUsage.mount(app, { auth, db: db.db }); require('./sendingDomain').mount(app, { db, auth, mailer }); // AI token metering (Admin → AI → Usage) + per-client custom sending domains
// Materialise a built-in recipe (e.g. 'abandoned_cart') as a real audience source
// by auto-resolving its tile from this client's data. Shared by segments + the
// setup-nudge personalisation (the live abandoned-cart count).
const resolveRecipe = (entityId, key) => {
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
};
// Segments — reusable live audiences. Reuses the campaign engine's audience
// resolver (audienceFor) so resolution logic + the org-scope boundary are shared.
const segmentsApi = require('./segments').mount(app, {
  db, auth, meta, tiktok, resolveAudience: actionsApi.audienceFor, resolveRecipe,
});

// Setup nudges — daily reminders to clients + the account team about outstanding
// setup, bulked per recipient. Managed per client in the onboarding section. Mounted
// here (after the action engine + resolveRecipe) so its personalised live metric
// (the abandoned-cart count) can reuse the campaign audience resolver.
require('./setupNudge').mount(app, { db, auth, mailer, os, insights, resolveRecipe, audienceFor: actionsApi.audienceFor, anthropicKeyForEntity, aiInstructionsFor });

// ─── Public platform surface → server/publicSurface.js ─────────────────────────
// API keys + /api/v1 (read + drafts) + remote MCP server + OAuth connect flow —
// thin adapters over the SAME service core; the app's scope gates apply.
require('./publicSurface').mount(app, {
  db, auth, rateLimit, mailer, currency, language, clientCatalogue,
  resolveTileValue, resolveTileRows, segmentsApi, actionsApi, goalsApi, getOwlTools, owlCatalogue,
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
  briefStore.clearMem();
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
  const on = briefingCats(req.user.id, entityId);
  const categories = BRIEF_CATS.map((c) => ({ key: c.key, label: c.label, enabled: on.has(c.key) }));
  res.json({ suites, phases: PHASES, phaseDefaults: phaseDefaults(), tune: db.getUserPref(req.user.id, `briefing_tune:${entityId}`), tiles, categories });
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
  briefStore.clearMem(); // next briefing for anyone on this client reflects it
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
    const refined = await aiUsage.run({ entityId, kind: 'refine' }, () => insights.refineText({ text, purpose: String(req.body?.purpose || '').slice(0, 120), instructions: aiInstructionsFor(null), apiKey }));
    res.json({ text: refined });
  } catch (e) { console.error('[POST /api/my/refine-text]', e.message); res.status(500).json({ error: e.message }); }
});
app.put('/api/my/briefing-tune', auth.requireAuth, (req, res) => {
  const entityId = homeEntityFor(req);
  if (!entityId) return res.status(400).json({ error: 'No client context' });
  const body = req.body || {};
  db.setUserPref(req.user.id, `briefing_tune:${entityId}`, String(body.tune || '').slice(0, 1500));
  // Focus tiles (reader-chosen dashboards/tiles to always feed the briefing). Each
  // pick may carry a lifecycle-phase scope — it then feeds the briefing only while
  // its event is in that phase (blank/invalid → all phases).
  if (Array.isArray(body.tiles)) {
    const tiles = body.tiles.slice(0, 40)
      .filter((t) => t && t.dashboardId && t.tileId)
      .map((t) => ({ dashboardId: String(t.dashboardId), tileId: String(t.tileId), ...(PHASES.some((p) => p.key === t.phase) ? { phase: t.phase } : {}) }));
    db.setUserPref(req.user.id, `briefing_tiles:${entityId}`, JSON.stringify(tiles));
  }
  // Always-include categories the reader has enabled (Tune → "What the briefing covers").
  if (Array.isArray(body.categories)) {
    const allowed = new Set(BRIEF_CATS.map((c) => c.key));
    db.setUserPref(req.user.id, `briefing_cats:${entityId}`, JSON.stringify([...new Set(body.categories.map(String).filter((k) => allowed.has(k)))]));
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

// ─── Living docs ──────────────────────────────────────────────────────────────
// The sales product-overview page (+ admin-filtered markdown), the curated
// feature matrix with admin include/exclude, and the public /sales site all
// live in server/productSite.js.
require('./productSite').mount(app, { db, auth });

// The client/developer API guide — same living-doc pattern, shareable at
// /api-guide (editing docs/CLIENT_API_GUIDE.md updates the page).
const API_GUIDE_HTML = path.join(__dirname, '../docs/client-api-guide.html');
const API_GUIDE_MD = path.join(__dirname, '../docs/CLIENT_API_GUIDE.md');
app.get(['/api-guide', '/client-api-guide', '/client-api-guide.html'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(API_GUIDE_HTML);
});
app.get('/client-api-guide.md', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.type('text/markdown; charset=utf-8');
  res.sendFile(API_GUIDE_MD);
});

// The Experience OS pitch — a self-contained HTML deck. Served at a clean URL so
// it's shareable. (Scoped to this one doc; the rest of docs/ stays internal.)
const PITCH_HTML = path.join(__dirname, '../docs/experience-os-pitch.html');
app.get(['/pitch', '/experience-os-pitch', '/experience-os-pitch.html'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(PITCH_HTML);
});

// Session handoff doc — so a new Claude Code workspace (or person) can read the
// project context/decisions at a URL when it can't see the repo directly.
const HANDOFF_MD = path.join(__dirname, '../docs/SESSION_HANDOFF.md');
app.get(['/handoff', '/handoff.md', '/session-handoff'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.type('text/markdown; charset=utf-8');
  res.sendFile(HANDOFF_MD);
});

// ─── SPA fallback ───────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(staticDir, 'index.html'));
});

// Single error-handling middleware (mounted last). Catches sync throws from any
// route + async rejections forwarded by asyncHandler; logs full 5xx server-side
// and returns a sanitized message (never leaks internal error text). See http.js.
app.use(errorMiddleware);

const PORT = process.env.PORT || 3045;
const server = app.listen(PORT, () => {
  console.log(`Howler Looker Tool running on http://localhost:${PORT}`);
  console.log(`Looker instance: ${looker.lookerBaseUrl() || '(not configured — set in Admin → Integrations)'}`);
  // Pull organic social stats once a day for every connected client (best-effort).
  socialMetrics.startDailySync({ listEntities: () => db.listEntities() });
});

// Graceful shutdown — Render sends SIGTERM on EVERY deploy. Stop accepting new
// connections and give in-flight requests a moment to drain, then exit. Work
// interrupted anyway is designed to survive the kill: campaign blasts resume
// from the action_sends ledger on next boot, and digest/alert run-slots are
// claimed before sending, so a killed send is missed (and visible), never
// double-delivered.
process.on('SIGTERM', () => {
  console.log('[shutdown] SIGTERM received — draining connections');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
});
