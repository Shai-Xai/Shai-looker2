require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
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
const mailer = require('./mailer');
const messaging = require('./messaging');
const rateLimit = require('./ratelimit');
// Query & scope engine (shared library): the single place Looker queries run and
// the per-client organiser scope is enforced. Lifted out of this file; behaviour
// unchanged. See server/query.js.
const {
  runLookerQuery, applyScope, stripAnyValue, ANY_VALUE, currentFirstEventSort,
  cleanFilterMap, expandLockMap, effectiveFilterValues, tileQueryBody, daysBeforeOverlayFor,
  primaryTileValue,
} = require('./query')({ looker, auth });

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
  || /^\/api\/os\/threads\/[^/]+\/messages$/.test(p) || p === '/api/os/admin/announce'
  // Inbound email may carry attachment PDFs (base64) — os.js parses it with a bigger limit.
  || p === '/api/inbound/email';
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
mailer.init({ db });
// SMS (Clickatell One API) — second channel; no-ops when unconfigured.
messaging.init({ db });
// Meta (FB/IG) audience-sync — push a segment to a Custom Audience; per-client.
const meta = require('./meta');
meta.init({ db });
// TikTok audience-sync — same pattern as Meta; per-client pasted token.
const tiktok = require('./tiktok');
tiktok.init({ db });
// Web Push — installable-app notifications (disposable module, own table +
// routes under /api/push, kill switch `push_enabled`). Mounted before os so the
// comms spine can push alongside email.
const push = require('./push');
push.mount(app, { db, auth });
// Owl auto-ingest — settlements/invoices that arrive by CC-the-Owl email
// (disposable module; no tables/routes of its own). Triggered by the os inbound
// hook below. Safe by default: does nothing unless the sender is on the allowlist
// and the kill-switch is on.
const owlIngest = require('./owlIngest').mount({ db, insights, anthropicKeyForEntity });
// Experience OS comms spine — self-contained module (own tables + routes under
// /api/os). Remove this line + server/os.js to fully uninstall the feature.
let osApi;
const os = require('./os').mount(app, { db, auth, mailer, push,
  onInbound: (p) => owlIngest.handle({ ...p, getAttachmentBuffer: osApi.getAttachmentBuffer }) });
osApi = os;

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
  db.touchLastLogin(user.id); // most recent login → Admin → Users
  db.recordAction({ userId: user.id, action: 'auth.login', label: 'Logged in', method: 'POST', path: '/api/auth/login' });
  res.json({ user: meUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.user) db.recordAction({ userId: req.user.id, action: 'auth.logout', label: 'Logged out', method: 'POST', path: '/api/auth/logout' });
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
    .map((u) => ({ id: u.id, email: u.email, fullName: u.fullName, firstName: u.firstName, lastName: u.lastName, mobile: u.mobile, role: (u.memberships || []).find((m) => m.entityId === entityId)?.role || 'owner', alsoOtherClients: (u.entityIds || []).length > 1 }));
}
const ownerCount = (entityId) => teamMembers(entityId).filter((m) => m.role === 'owner').length;

app.get('/api/my/team/:entityId', auth.requireAuth, auth.requirePermission('team.manage'), (req, res) => {
  res.json({ members: teamMembers(req.params.entityId).map((m) => ({ ...m, isYou: m.id === req.user.id })), roles: roles.catalog() });
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
  res.json(auth.loadUsers().map((u) => {
    const la = lastActions[u.id] || null;
    const lastActiveAt = [u.lastLogin, la?.at, lastViews[u.id]].filter(Boolean).sort().pop() || null;
    return {
      id: u.id, email: u.email, role: u.role,
      firstName: u.firstName, lastName: u.lastName, fullName: u.fullName, mobile: u.mobile,
      entityIds: u.entityIds, memberships: u.memberships,
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
app.get('/api/admin/roles', auth.requireAdmin, (_req, res) => res.json({ roles: roles.catalog() }));

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
  const memberships = (u.memberships || []).map((m) => {
    const e = db.getEntity(m.entityId);
    const role = roles.getRole(m.role);
    return { entityId: m.entityId, entityName: e?.name || m.entityId, entityLogo: e?.logo || '', role: m.role, roleLabel: role.label, lens: role.lens, permissions: role.permissions };
  });
  const profile = db.viewProfile(u.id);
  const titleFor = (id) => db.getDashboard(id)?.title || id;
  const used = (profile.top || []).map((t) => ({ dashboardId: t.dashboardId, suiteId: t.suiteId, count: t.count, lastAt: t.lastAt, title: titleFor(t.dashboardId) }));
  // Dashboards this user can reach today: every dashboard bundled into a set in
  // one of their entities' suites (deduped). Admins see everything → flagged.
  const accSeen = new Set();
  const accessible = [];
  if (u.role !== 'admin') {
    for (const eid of u.entityIds || []) {
      for (const su of db.listSuitesForEntity(eid)) {
        for (const sid of db.suiteSetIds(su.id)) {
          for (const did of db.dashboardsInSet(sid)) {
            if (accSeen.has(did)) continue;
            accSeen.add(did);
            accessible.push({ dashboardId: did, title: titleFor(did), suiteId: su.id, suiteName: su.name });
          }
        }
      }
    }
  }
  res.json({
    user: {
      id: u.id, email: u.email, role: u.role, createdAt: u.createdAt,
      firstName: u.firstName, lastName: u.lastName, fullName: u.fullName, mobile: u.mobile,
      lastLogin: u.lastLogin || null, notifyEmail: u.notifyEmail, notifyPush: u.notifyPush,
      entityIds: u.entityIds,
    },
    memberships,
    profile: { top: used, lastVisit: profile.lastVisit },
    dashboards: { used, accessible, accessibleAll: u.role === 'admin' },
    usageByClient: db.usageByClientForUser(u.id),
    emails: mailer.recipientLog(u.email).map((m) => ({ ...m, entityName: m.entityId ? (db.getEntity(m.entityId)?.name || '') : '' })),
    activity: buildUserActivity(u.id),
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

// ─── Release notes (daily product changelog — Admin → Product) ───────────────
app.get('/api/admin/release-notes', auth.requireAdmin, (_req, res) => res.json(db.listReleaseNotes()));
app.post('/api/admin/release-notes', auth.requireAdmin, (req, res) => res.status(201).json(db.createReleaseNote(req.body || {})));
app.put('/api/admin/release-notes/:id', auth.requireAdmin, (req, res) => {
  const n = db.updateReleaseNote(req.params.id, req.body || {});
  if (!n) return res.status(404).json({ error: 'Release note not found' });
  res.json(n);
});
app.delete('/api/admin/release-notes/:id', auth.requireAdmin, (req, res) => { db.deleteReleaseNote(req.params.id); res.status(204).end(); });

// Read recent commits grouped by calendar day (most recent day first). Returns
// [{ date, sha (newest that day), commits: [subject + any how-to:/link: trailers] }].
// Skips merge commits.
const REPO_ROOT = path.join(__dirname, '..');
function recentCommitsByDay(days = 14) {
  return new Promise((resolve, reject) => {
    const since = `${Math.max(1, Math.min(90, days))} days ago`;
    // %x1e (record sep) starts each commit; %x1f (unit sep) splits fields; %b is the body,
    // mined for "how-to:" / "link:" trailers that ground the client how-to + deep link.
    const args = ['log', '--no-merges', `--since=${since}`, '--date=short', '--pretty=format:%x1e%cd%x1f%h%x1f%s%x1f%b'];
    execFile('git', args, { cwd: REPO_ROOT, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error('Could not read git history in this environment.'));
      const byDay = new Map(); // date -> { date, sha, commits[] }
      for (const rec of String(stdout || '').split('\x1e')) {
        if (!rec.trim()) continue;
        const [date, sha, subject, body = ''] = rec.split('\x1f');
        if (!date || !subject) continue;
        // Surface any "how-to:" / "link:" trailer to the model, inline under the subject.
        const trailers = body.split('\n').map((l) => l.trim()).filter((l) => /^(how-to|link)\s*:/i.test(l));
        const line = subject.trim() + trailers.map((t) => `\n  ${t}`).join('');
        if (!byDay.has(date)) byDay.set(date, { date, sha, commits: [] }); // first record of a day = newest sha
        byDay.get(date).commits.push(line);
      }
      resolve([...byDay.values()]); // git log is newest-first, so insertion order = newest day first
    });
  });
}

// Auto-populate: summarise the last N days of commits into draft release notes.
// Only fills days that don't already have a note (manual or auto) — never
// clobbers edits. New entries are drafts (three lenses) for an admin to review.
// Shared by the manual "Generate" button and the daily tick below.
async function generateReleaseNoteDrafts(days = 14) {
  const apiKey = adminAnthropicKey();
  if (!insights.isConfigured(apiKey)) return { created: 0, items: [], message: 'AI not configured.' };
  const commitDays = await recentCommitsByDay(days);
  const have = new Set(db.listReleaseNotes().map((n) => n.date));
  const todo = commitDays.filter((d) => !have.has(d.date));
  if (todo.length === 0) {
    return { created: 0, items: [], message: commitDays.length ? 'Release notes already cover every day with commits.' : 'No recent commits found.' };
  }
  const summaries = await insights.summariseReleaseNotes({ days: todo, apiKey, instructions: db.getSetting('ai_instructions'), featureMap: db.getSetting('release_feature_map') });
  const shaForDate = Object.fromEntries(todo.map((d) => [d.date, d.sha]));
  const created = [];
  for (const s of summaries) {
    if (!s?.date || have.has(s.date)) continue; // guard against the model echoing a covered day
    created.push(db.createReleaseNote({
      date: s.date,
      title: s.title || '',
      body: s.summary || s.body || '', // `summary` is the end-user lens; fall back to `body` for resilience
      howTo: s.howTo || '',
      bodyDev: s.dev || '',
      deepLink: s.deepLink || '',
      published: false, source: 'auto', lastSha: shaForDate[s.date] || '',
    }));
  }
  return { created: created.length, items: created };
}
app.post('/api/admin/release-notes/generate', auth.requireAdmin, async (req, res) => {
  if (!insights.isConfigured(adminAnthropicKey())) return res.status(400).json({ error: 'Set an Anthropic API key in Admin → Integrations to auto-generate release notes.' });
  try {
    res.json(await generateReleaseNoteDrafts(Number(req.body?.days) || 14));
  } catch (err) {
    console.error('[release-notes/generate]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// "After each day": a once-per-local-day tick that auto-drafts notes for any
// uncovered recent day, so generation no longer needs a button press. Drafts
// only — an admin still reviews + publishes (governance, see the spec). The tick
// fires hourly and self-guards via the `release_notes_last_auto` date marker.
// Kill switch: settings key `release_notes_auto` ('0' disables it).
const RELEASE_TZ = 'Africa/Johannesburg'; // GMT+2, matches the scheduler's default
const localDateStr = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
async function dailyReleaseNotesTick() {
  try {
    if (db.getSetting('release_notes_auto', '1') === '0') return;          // disabled
    if (!insights.isConfigured(adminAnthropicKey())) return;              // needs AI
    const todayLocal = localDateStr(RELEASE_TZ);
    if (db.getSetting('release_notes_last_auto', '') === todayLocal) return; // already ran today
    const r = await generateReleaseNoteDrafts(7);
    db.setSetting('release_notes_last_auto', todayLocal);
    if (r.created) console.log(`[release-notes] auto-drafted ${r.created} day(s) — awaiting review`);
  } catch (e) { console.error('[release-notes] daily tick failed:', e.message); }
}
const releaseNotesTimer = setInterval(() => dailyReleaseNotesTick().catch(() => {}), 60 * 60 * 1000); // hourly
if (releaseNotesTimer.unref) releaseNotesTimer.unref();
setTimeout(() => dailyReleaseNotesTick().catch(() => {}), 15000); // shortly after boot

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
    if (req.body?.keepImportedFilters) def.keepImportedFilters = true; // Looker defaults stay authoritative
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
  // Dashboards an admin removed from THIS suite (a subset of a shared set). Hidden
  // for everyone — including admin preview — so it matches what the client sees.
  const excluded = new Set(su.excludedDashboards || []);
  const sets = su.setIds.map((sid) => {
    const set = db.getSet(sid);
    if (!set) return null;
    // One-level tree: top-level dashboards carry their sub-dashboards (tabs)
    // in `children`. An orphaned parent reference renders top-level.
    const nodes = (set.dashboards || []).map(({ id, parentId }) => {
      const d = store.get(id);
      return d && !excluded.has(id) && visible(set.id, id) && { id: d.id, title: d.title, description: d.description || '', tileCount: (d.tiles || []).length, parentId };
    }).filter(Boolean);
    const valid = new Set(nodes.map((n) => n.id));
    const dashboards = nodes.filter((n) => !n.parentId || !valid.has(n.parentId)).map(({ parentId, ...top }) => ({
      ...top,
      children: nodes.filter((c) => c.parentId === top.id).map(({ parentId: _p, ...rest }) => rest),
    }));
    return { id: set.id, name: set.name, icon: set.icon || '', dashboards };
  }).filter((s) => s && (isAdmin || s.dashboards.length)); // drop sets fully hidden for this role
  const ent = db.getEntity(su.entityId);
  // Per-dashboard lock overrides, expanded the same way as the suite-wide locks
  // so ViewPage can layer them on top for the matching dashboard.
  const dashboardLocks = {};
  for (const [did, locks] of Object.entries(su.dashboardLocks || {})) {
    if (locks && Object.keys(locks).length) dashboardLocks[did] = expandLockMap(locks);
  }
  res.json({
    id: su.id, name: su.name, icon: su.icon || '',
    entityId: su.entityId, // the suite's client — authoritative scope for tile actions (e.g. create segment)
    entityName: ent?.name || '', entityLogo: ent?.logo || '',
    lockedFilters: expandLockMap(auth.lockedFiltersForSuite(su.id)), dashboardLocks, sets,
  });
});

// ── Saved dashboard filter views (dual-surface) ──────────────────────────────
// Per-user "save my view" (client self-service) + the client default an admin
// sets. Resolution on load is user view > entity default > the dashboard's own
// default_value (applied client-side in ViewPage). Locks always still win.

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

// ─── Dashboards → server/dashboards.js ─────────────────────────────────────────
// Extracted: dashboard CRUD, Looker import, folders, run-query and drill. The
// query routes share the one query-engine instance (functions injected), so the
// cache + scope boundary stay singular across the app.
require('./dashboards').mount(app, {
  store, db, auth, looker,
  convertDashboard, fetchDashboard, parseDrillUrl,
  runLookerQuery, applyScope, stripAnyValue, currentFirstEventSort,
});

// ─── Goals (the Results pillar) → server/goals.js ──────────────────────────────
// A tile-sourced goal reads the live number off a dashboard tile through the
// SHARED, scope-enforced query path (so the goal value == what the dashboard
// shows, and the per-tenant scope can't be bypassed). The suite's filter locks
// (which event) are applied exactly as a dashboard view would apply them.
async function resolveTileValue({ dashboardId, tileId, user, suiteId }) {
  const def = db.getDashboard(dashboardId);
  if (!def) return null;
  const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
  const tile = tiles.find((t) => t.id === tileId);
  if (!tile) return null;
  // Match the dashboard view exactly: apply its client-default saved filters (e.g.
  // a date range — which a GA4 tile needs to return anything but 0), with the
  // suite's organiser/event locks layered on top so scope still wins.
  const su = db.getSuite(suiteId);
  const entityView = su?.entityId ? (db.getFilterView('entity', su.entityId, dashboardId) || {}) : {};
  const lockMap = { ...expandLockMap(entityView), ...expandLockMap(db.lockedFiltersForSuite(suiteId, dashboardId)) };
  const body = await tileQueryBody(tile, def, user, suiteId, lockMap);
  if (!body) return null; // scope denied or non-queryable tile
  // Drop any "days before event" / days-to-go clip so a running-total KPI reads the
  // FULL to-date figure the dashboard headline shows (e.g. Total Tickets Sold 44,806),
  // not an as-of slice (43,310). Same treatment the curve resolver gives — keeps the
  // goal, the curve and the dashboard on one number. No-op for tiles without such a
  // filter (date ranges and other filters are untouched).
  body.filters = stripDaysBeforeFilters(body.filters, def, tile).filters;
  const data = await runLookerQuery('/queries/run/json_detail', body);
  // Use the number the tile actually SHOWS (honours hidden_fields, picks the
  // visible primary measure, reads the rendered value) so the goal == the dashboard.
  const value = primaryTileValue(data, tile.vis || {});
  // Diagnostic for "tile reads 0" (e.g. GA4): log the scoped query + fields + first
  // row so we can see WHY it resolved to nothing (wrong scope field? empty rows?).
  if (value == null || value === 0) {
    try {
      const names = (k) => (data?.fields?.[k] || []).map((f) => f.name);
      console.warn('[goals] tile-value', value, JSON.stringify({
        dashboardId, tileId, vis: tile.vis?.type, filters: body.filters,
        measures: names('measures'), tableCalcs: names('table_calculations'), dims: names('dimensions'),
        rowCount: (data?.data || []).length, firstRow: (data?.data || [])[0],
      }).slice(0, 1800));
    } catch { /* logging only */ }
  }
  return value;
}

// Remove "Days Before Event" / days-to-go type filters from a built query body, so a
// forecast curve reads last time's FULL sell-through to event day rather than the
// to-date slice these comparison dashboards usually clip it to. Targets the field by
// name (days_before / days_to_event / …) and by the dashboard's days-to-go sync
// mapping. Returns { filters, stripped:[keys removed] }.
function stripDaysBeforeFilters(filters, def, tile) {
  if (!filters) return { filters, stripped: [] };
  const out = { ...filters };
  const stripped = [];
  const isDays = (k) => /day[s_]*\s*(before|to|until|remaining)/i.test(String(k)) || /before[_\s]*event/i.test(String(k));
  const syncName = def && def.daysBeforeSync ? def.daysBeforeSync.filterName : null;
  const mappedField = syncName && tile && tile.listenTo ? tile.listenTo[syncName] : null;
  for (const k of Object.keys(out)) {
    if (isDays(k) || (mappedField && k === mappedField)) { delete out[k]; stripped.push(k); }
  }
  return { filters: out, stripped };
}

// Time-series version of resolveTileValue: run the SAME scoped query, but return
// the whole [{ t, v }] series (a date dimension × the primary measure) instead of
// one number. This is what powers "review last time's curve" when setting goal
// checkpoints — the goal links a chart/table tile that carries the sell-by-now
// shape, and we read its rows under the chosen event's scope. Scope is still
// enforced inside tileQueryBody, exactly like the single-value path.
async function resolveTileSeries({ dashboardId, tileId, user, suiteId }) {
  const def = db.getDashboard(dashboardId);
  if (!def) return [];
  const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
  const tile = tiles.find((t) => t.id === tileId);
  if (!tile) return [];
  const su = db.getSuite(suiteId);
  const entityView = su?.entityId ? (db.getFilterView('entity', su.entityId, dashboardId) || {}) : {};
  const lockMap = { ...expandLockMap(entityView), ...expandLockMap(db.lockedFiltersForSuite(suiteId, dashboardId)) };
  const body = await tileQueryBody(tile, def, user, suiteId, lockMap);
  if (!body) return [];
  body.filters = stripDaysBeforeFilters(body.filters, def, tile).filters; // full curve to event day
  body.limit = Math.max(Number(body.limit) || 0, 1000); // enough rows for a full curve
  const data = await runLookerQuery('/queries/run/json_detail', body);
  const fields = data?.fields || {};
  const rows = data?.data || [];
  if (!rows.length) return [];
  const hidden = new Set((tile.vis || {}).hidden_fields || []);
  const dims = (fields.dimensions || []).filter((f) => !hidden.has(f.name));
  const measures = [...(fields.measures || []), ...(fields.table_calculations || [])].filter((f) => !hidden.has(f.name));
  const isDateName = (n) => /date|day|week|month|year|created|time/i.test(n || '');
  const looksDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}/.test(v);
  const dateDim = dims.find((f) => isDateName(f.name)) || dims.find((f) => looksDate(rows[0][f.name]?.value)) || dims[0];
  const measure = measures[0] || dims.find((f) => f !== dateDim);
  if (!dateDim || !measure) return [];
  const numOf = (cell) => {
    if (!cell) return null;
    const r = cell.rendered;
    if (r != null && r !== '') { const m = String(r).replace(/[\s,]/g, '').match(/-?\d+(?:\.\d+)?/); if (m && Number.isFinite(Number(m[0]))) return Number(m[0]); }
    const v = Number(cell.value); return Number.isFinite(v) ? v : null;
  };
  // Pivoted trend (e.g. "26 vs 25 vs 24" pivots the measure by year): the measure cell
  // is keyed by pivot value. Pick the pivot column with the largest total — typically a
  // COMPLETE prior period rather than the partial current one — so we read a full curve.
  const pivots = data.pivots || [];
  let pickValue;
  if (pivots.length) {
    const totals = {};
    for (const pv of pivots) { let s = 0; for (const row of rows) { const v = numOf(row[measure.name]?.[pv.key]); if (v != null) s += v; } totals[pv.key] = s; }
    const bestKey = pivots.map((pv) => pv.key).sort((a, b) => (totals[b] || 0) - (totals[a] || 0))[0];
    pickValue = (row) => numOf(row[measure.name]?.[bestKey]);
  } else {
    pickValue = (row) => numOf(row[measure.name]);
  }
  const series = rows.map((row) => ({ t: String(row[dateDim.name]?.value ?? ''), v: pickValue(row) })).filter((p) => p.v != null);
  // Preserve the tile's own (chronological) row order; only re-sort when x is ISO dates.
  if (series.length && looksDate(series[0].t)) series.sort((a, b) => a.t.localeCompare(b.t));
  return series;
}

// Diagnostic sibling: return EVERY pivot column of a trend tile (not just one),
// so the forecast probe can read both last-year (the shape) and this-year (recent
// momentum) at once. Same scoped query path; returns { dateField, measureField,
// columns:[{ key, series:[{t,v}] }] } or null. Read-only, used by the probe route.
async function resolveTileSeriesAll({ dashboardId, tileId, user, suiteId }) {
  const def = db.getDashboard(dashboardId);
  if (!def) return null;
  const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
  const tile = tiles.find((t) => t.id === tileId);
  if (!tile) return null;
  const su = db.getSuite(suiteId);
  const entityView = su?.entityId ? (db.getFilterView('entity', su.entityId, dashboardId) || {}) : {};
  const lockMap = { ...expandLockMap(entityView), ...expandLockMap(db.lockedFiltersForSuite(suiteId, dashboardId)) };
  const body = await tileQueryBody(tile, def, user, suiteId, lockMap);
  if (!body) return null;
  const stripResult = stripDaysBeforeFilters(body.filters, def, tile);
  body.filters = stripResult.filters; // full curve to event day
  body.limit = Math.max(Number(body.limit) || 0, 1000);
  const data = await runLookerQuery('/queries/run/json_detail', body);
  const fields = data?.fields || {};
  const rows = data?.data || [];
  if (!rows.length) return null;
  const hidden = new Set((tile.vis || {}).hidden_fields || []);
  const dims = (fields.dimensions || []).filter((f) => !hidden.has(f.name));
  const measures = [...(fields.measures || []), ...(fields.table_calculations || [])].filter((f) => !hidden.has(f.name));
  const isDateName = (n) => /date|day|week|month|year|created|time/i.test(n || '');
  const looksDate2 = (v) => typeof v === 'string' && /^\d{4}-\d{2}/.test(v);
  const dateDim = dims.find((f) => isDateName(f.name)) || dims.find((f) => looksDate2(rows[0][f.name]?.value)) || dims[0];
  const measure = measures[0] || dims.find((f) => f !== dateDim);
  if (!dateDim || !measure) return null;
  const num = (cell) => { if (!cell) return null; const r = cell.rendered; if (r != null && r !== '') { const m = String(r).replace(/[\s,]/g, '').match(/-?\d+(?:\.\d+)?/); if (m && Number.isFinite(Number(m[0]))) return Number(m[0]); } const v = Number(cell.value); return Number.isFinite(v) ? v : null; };
  const x = rows.map((row) => String(row[dateDim.name]?.value ?? ''));
  const pivots = data.pivots || [];
  const columns = [];
  if (pivots.length) {
    for (const pv of pivots) columns.push({ key: pv.key, series: rows.map((row, i) => ({ t: x[i], v: num(row[measure.name]?.[pv.key]) })).filter((p) => p.v != null) });
  } else {
    columns.push({ key: measure.label || measure.name, series: rows.map((row, i) => ({ t: x[i], v: num(row[measure.name]) })).filter((p) => p.v != null) });
  }
  return { dateField: dateDim.name, measureField: measure.name, strippedFilters: stripResult.stripped, columns: columns.filter((c) => c.series.length) };
}
// The event's start date straight from Looker (core_events.start_date), scoped to
// the suite so it returns THIS event — the authoritative anchor for "days to go" so
// goals don't depend on a hand-typed deadline being entered. Runs a tiny inline
// query on an explore the suite already uses (one that exposes core_events), newest
// event first. Returns "YYYY-MM-DD" or null (callers fall back to the briefing date).
async function resolveEventDate({ suiteId, user }) {
  const DATE = 'core_events.start_date';
  // Find an explore (model+view) the suite uses that references core_events.
  const defs = db.dashboardsInSuite(suiteId).map((id) => db.getDashboard(id)).filter(Boolean);
  const candidates = [];
  for (const def of defs) {
    const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
    for (const t of tiles) {
      const q = t.query;
      if (!q?.model || !q?.view) continue;
      const refsEvents = (q.fields || []).some((f) => /^core_events\./.test(String(f)));
      candidates.push({ model: q.model, view: q.view, refsEvents });
    }
  }
  // Prefer an explore we KNOW exposes core_events; else try the rest.
  const seen = new Set();
  const ordered = [...candidates.filter((c) => c.refsEvents), ...candidates.filter((c) => !c.refsEvents)]
    .filter((c) => { const k = `${c.model}|${c.view}`; if (seen.has(k)) return false; seen.add(k); return true; });
  for (const c of ordered) {
    const q = { model: c.model, view: c.view, fields: [DATE], sorts: [`${DATE} desc`], limit: 1 };
    if (!(await applyScope(q, user, suiteId))) continue; // fail closed → try next / fall back
    try {
      const rows = await runLookerQuery('/queries/run/json', q);
      const v = rows && rows[0] && rows[0][DATE];
      if (v != null && v !== '') { const m = String(v).match(/^\d{4}-\d{2}-\d{2}/); if (m) return m[0]; }
    } catch { /* explore may not expose start_date — try the next */ }
  }
  return null;
}
const goalsApi = require('./goals').mount(app, { db, auth, resolveTileValue, resolveTileSeries, resolveTileSeriesAll, resolveEventDate });

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
async function scopedMetricBody({ model, view, fields, sorts, limit, extraOverrides, user, suiteId }) {
  const su = db.getSuite(suiteId); if (!su) return null;
  const rep = representativeTileForExplore(su.entityId, model, view);
  const lockMap = expandLockMap(db.lockedFiltersForSuite(suiteId));
  if (rep) {
    const synthetic = { ...rep.tile, id: 'metric', type: 'vis', vis: {}, query: { model, view, fields, ...(sorts ? { sorts } : {}), ...(limit ? { limit } : {}) } };
    return tileQueryBody(synthetic, rep.def, user, suiteId, lockMap, extraOverrides || {});
  }
  // No tile on this explore (shouldn't happen for catalogue explores): organiser scope only.
  const body = { model, view, fields, filters: { ...(extraOverrides || {}) }, ...(sorts ? { sorts } : {}), ...(limit ? { limit } : {}) };
  if (!(await applyScope(body, user, suiteId))) return null;
  return body;
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
async function metricFilterValues({ model, view, field, user, suiteId }) {
  const body = await scopedMetricBody({ model, view, fields: [field], sorts: [field], limit: 500, extraOverrides: {}, user, suiteId });
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

require('./alerts').mount(app, { db, auth, resolveTileValue, resolveCustomMetric, metricCatalog, metricFilterValues, os, mailer, push, messaging });

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
        await push.sendToEntity(ent.id, { title: 'Your goals this week', body, url: '/goals' });
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
    await insights.streamGoalsBrief({ eventName: su.name, goals, instructions: aiInstructionsFor(suiteId), apiKey }, (t) => res.write(t));
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
    const plan = await insights.goalGapPlan({
      goal: withProgress, progress: withProgress.progress, tiles, segments, catalogue,
      clientName: db.getEntity(entityId)?.name || '', instructions: aiInstructionsFor(suiteId), today: todayLabel(), apiKey,
    });
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
  const mt = body.meta || {};
  if (mt.accessToken) set('metaAccessToken', String(mt.accessToken));
  if (mt.clearAccessToken) set('metaAccessToken', '');
  if (mt.adAccountId !== undefined) set('metaAdAccountId', String(mt.adAccountId || ''));
  if (mt.businessId !== undefined) set('metaBusinessId', String(mt.businessId || ''));
  const tt = body.tiktok || {};
  if (tt.accessToken) set('tiktokAccessToken', String(tt.accessToken));
  if (tt.clearAccessToken) set('tiktokAccessToken', '');
  if (tt.advertiserId !== undefined) set('tiktokAdvertiserId', String(tt.advertiserId || ''));
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
    meta: { tokenSet: !!i.metaAccessToken, tokenHint: maskSecret(i.metaAccessToken), adAccountId: i.metaAdAccountId || '', businessId: i.metaBusinessId || '' },
    tiktok: { tokenSet: !!i.tiktokAccessToken, tokenHint: maskSecret(i.tiktokAccessToken), advertiserId: i.tiktokAdvertiserId || '' },
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
  // Global kill switch: '0' makes every outbound email a no-op (all clients).
  if (re.enabled !== undefined) db.setSetting('mail_enabled', re.enabled ? '1' : '0');
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
  const logo = mailer.resolveBranding(id).logo || '';
  res.json({ primary: b.brandColor, secondary: b.secondaryColor, chart3: b.chart3, chart4: b.chart4, chart5: b.chart5, logo });
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
  applyIntegrationsPatch(req.body || {}, (k, v) => { patch[k] = v; });
  db.setEntityIntegrations(req.params.id, patch);
  res.json(entityIntegrationsView(req.params.id));
});

// Audience-sync health across all clients — connection state + per-channel sync
// outcomes (ok/errors, last activity, last error). Surfaces what the connectors
// already record so failures are visible without opening each client.
app.get('/api/admin/integrations/health', auth.requireAdmin, (_req, res) => {
  const clients = [];
  for (const e of db.listEntities()) {
    const m = meta.summary(e.id); const t = tiktok.summary(e.id);
    if (!(m.configured || t.configured || m.audienceCount || t.audienceCount)) continue;
    clients.push({ entityId: e.id, name: e.name, channels: { meta: m, tiktok: t } });
  }
  // Most recently active (or failing) clients first.
  clients.sort((a, b) => String(b.channels.meta.lastAt || b.channels.tiktok.lastAt || '').localeCompare(String(a.channels.meta.lastAt || a.channels.tiktok.lastAt || '')));
  res.json({ clients });
});

// Live token check for one client's connector (makes a real API call).
app.post('/api/admin/integrations/:entityId/verify', auth.requireAdmin, async (req, res) => {
  if (!db.getEntity(req.params.entityId)) return res.status(404).json({ error: 'Not found' });
  const channel = req.body?.channel === 'tiktok' ? tiktok : (req.body?.channel === 'meta' ? meta : null);
  if (!channel) return res.status(400).json({ error: 'Unknown channel' });
  res.json(await channel.verify(req.params.entityId));
});

// Live audience size/status read-back from the platform (real API call).
app.post('/api/admin/integrations/:entityId/audience-status', auth.requireAdmin, async (req, res) => {
  if (!db.getEntity(req.params.entityId)) return res.status(404).json({ error: 'Not found' });
  const channel = req.body?.channel === 'tiktok' ? tiktok : (req.body?.channel === 'meta' ? meta : null);
  if (!channel) return res.status(400).json({ error: 'Unknown channel' });
  res.json(await channel.audienceStatus(req.params.entityId, String(req.body?.audienceId || '')));
});

// Append-only change-log timeline for a client's audience syncs.
app.get('/api/admin/integrations/:entityId/log', auth.requireAdmin, (req, res) => {
  if (!db.getEntity(req.params.entityId)) return res.status(404).json({ error: 'Not found' });
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  let rows = [];
  try { rows = db.db.prepare('SELECT entity_id, segment_id, channel, audience_id, received, added, removed, status, error, by, at FROM audience_sync_log WHERE entity_id=? ORDER BY id DESC LIMIT ?').all(req.params.entityId, limit); } catch { /* table may not exist yet */ }
  res.json({ log: rows });
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
// What every event's briefing always tries to cover, on top of the ticketing
// headline. Toggleable per reader (Tune → "What the briefing covers"); default all
// on. Each has a tile-title matcher (ga4 is matched by set/dashboard name instead).
const BRIEF_CATS = [
  { key: 'daily_sales', label: 'Daily sales pace', re: /daily\s*sales|sales\s*(by\s*)?day|sales\s*per\s*day|day(?:'s)?\s*sales/i },
  { key: 'ticket_types', label: 'Ticket-type mix', re: /ticket\s*type|type\s*of\s*ticket|tickets?\s*by\s*type|by\s*ticket\s*type/i },
  { key: 'abandoned', label: 'Abandoned carts', re: /abandon/i },
  { key: 'audience', label: 'Audience: age, gender, country/city', re: /\bage\b|gender|demographic|nationalit|\bcountr|province|\bcit(y|ies)\b|catchment|\bregion\b/i },
  { key: 'ga4', label: 'Website traffic (GA4)', re: null },
];
function briefingCats(userId, entityId) {
  const all = BRIEF_CATS.map((c) => c.key);
  let on = null;
  try { on = JSON.parse(db.getUserPref(userId, `briefing_cats:${entityId}`) || 'null'); } catch { on = null; }
  return Array.isArray(on) ? new Set(on.filter((k) => all.includes(k))) : new Set(all); // default: all on
}
async function buildFacts(user, entityId, force = false, alignDaysBefore = false, priorityDashboards = [], opts = {}) {
  const { catalogue, leads, suites: catSuites } = clientCatalogue(entityId);
  const follows = db.listMarks({ userId: user.id, entityId, kind: 'follow' });
  const dashMeta = Object.fromEntries(catalogue.map((c) => [c.dashboardId, c]));
  // Suite name by suiteId — authoritative even for SHARED dashboards (where the
  // dashboardId→meta map is last-suite-wins, so it would mislabel the event).
  const suiteNameById = Object.fromEntries((catSuites || []).map((s) => [s.id, s.name]));
  // Optional: restrict the whole fact-gather to a set of suites (multi-event
  // briefing scopes to the selected events). Null = every suite (default).
  const suiteSet = Array.isArray(opts.suiteIds) && opts.suiteIds.length ? new Set(opts.suiteIds) : null;
  // Scale the tile budget when covering multiple events so each gets a fair share
  // (≈10 tiles/event, capped) rather than all events squeezing into the single cap.
  const maxTiles = suiteSet ? Math.min(72, Math.max(FACT_MAX_TILES, suiteSet.size * 14)) : FACT_MAX_TILES;
  const enabledCats = briefingCats(user.id, entityId); // which always-include categories are on
  const picks = []; // { tile, def, suiteId, setName, dashTitle, pinned }
  const seen = new Set();
  const addTile = (def, tile, suiteId, pinned) => {
    const meta = dashMeta[def.id];
    const sid = suiteId || meta?.suiteId;
    if (suiteSet && !suiteSet.has(sid)) return; // not in the selected events
    // Dedupe per dashboard+tile — but when scoped to multiple events (suiteSet),
    // a SHARED dashboard must contribute once PER event (each resolved with that
    // event's own locks), so include the suite in the signature there.
    const sig = suiteSet ? `${sid}|${def.id}|${tile.id}` : `${def.id}|${tile.id}`;
    if (seen.has(sig)) return;
    picks.push({ tile, def, suiteId: sid, setName: meta?.setName || '', dashTitle: def.title, pinned: !!pinned });
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
    if (picks.length >= maxTiles) break;
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
    if (picks.length >= maxTiles) break;
    const def = store.get(did);
    if (!def || !dashMeta[did]) continue; // must be in this client's catalogue
    const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))]
      .filter((t) => t.type !== 'text' && t.query?.fields?.length)
      .sort((a, b) => tilePriority(a) - tilePriority(b));
    let taken = 0;
    for (const t of tiles) { if (taken >= PER_DASH || picks.length >= maxTiles) break; const before = picks.length; addTile(def, t, dashMeta[did]?.suiteId, true); if (picks.length > before) taken += 1; }
  }
  const isAnalyticsName = (name) => /\bga4\b|analytics|google/i.test(name || '');
  // 1d0) Guarantee the AUTHORITATIVE ticketing HEADLINE tiles by CONTENT, so the lead
  //      sales figures are always present even when set/dashboard naming doesn't say
  //      "ticketing/overview" (which is what let a Reps board take the lead). Match
  //      tiles like "Total Tickets Sold", "Gross Revenue", "Orders" — excluding
  //      analytics/GA4 sources (their "tickets" are funnel interest, not sales).
  const TICKET_HEADLINE = /total\s*tickets|tickets?\s*sold|gross\s*(revenue|sales)|\bnet\s*sales\b|tickets?\s*revenue|sell[-\s]?through|attendance|checked?[-\s]?in|daily\s*sales|sales\s*(by\s*)?day|ticket\s*type|tickets?\s*by\s*type/i;
  let head = 0; const HEAD_BUDGET = 4;
  for (const c of catalogue) {
    if (head >= HEAD_BUDGET || picks.length >= maxTiles) break;
    if (isAnalyticsName(c.setName) || isAnalyticsName(c.title)) continue;
    const def = store.get(c.dashboardId);
    if (!def || !dashMeta[c.dashboardId]) continue;
    const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((t) => t.tiles || []))]
      .filter((t) => t.type !== 'text' && t.query?.fields?.length && TICKET_HEADLINE.test(t.title || ''))
      .sort((a, b) => tilePriority(a) - tilePriority(b));
    for (const t of tiles) {
      if (head >= HEAD_BUDGET || picks.length >= maxTiles) break;
      const before = picks.length; addTile(def, t, c.suiteId, true);
      if (picks.length > before) head += 1;
    }
  }
  // 1d) ALWAYS lead with TICKETING. Pull the ticketing set's OVERVIEW headline tiles
  //     first (tickets sold, revenue, orders) — across the WHOLE ticketing set, not
  //     just its first-listed dashboard — so a non-overview board (e.g. a Reps
  //     dashboard that happens to be listed first) can't take the lead and make the
  //     briefing read "reps-only". Detected by set name; analytics/GA4 sets excluded.
  //     Capped (TKT_BUDGET) so the other boards still get plenty of the budget.
  const isTicketingSet = (name) => /ticket/i.test(name || '') && !/\bga4\b|analytics|google/i.test(name || '');
  const isOverviewDash = (title) => /overview|summary|headline/i.test(title || '');
  // 1c2) MULTI-EVENT BALANCE: when scoped to several events, fill EACH event with a
  //      spread across ITS dashboards — round-robin so a section isn't all
  //      ticketing: lead with ticketing/overview, then GA4, audience, then the
  //      rest (cashless/vendor last — they're empty pre-event). This both keeps the
  //      events fair (each gets its own budget) and gives them breadth.
  if (suiteSet) {
    const perEvent = Math.max(6, Math.floor(maxTiles / suiteSet.size));
    const rank = (c) => {
      const n = `${c.setName} ${c.title}`.toLowerCase();
      if (isTicketingSet(c.setName)) return isOverviewDash(c.title) ? 0 : 1;
      if (/\bga4\b|analytics|google/.test(n)) return enabledCats.has('ga4') ? 2 : 9;          // traffic / funnel
      if (/audience|fan|customer|demograph|marketing/.test(n)) return enabledCats.has('audience') ? 3 : 7;
      if (/cashless|vendor|\bbar\b|token|product/.test(n)) return 8; // empty pre-event → last
      return 5;
    };
    // Always include, per event, the reader's enabled categories (daily-sales,
    // ticket-types, abandoned carts, audience) — matched by tile title.
    const MUST = BRIEF_CATS.filter((cat) => cat.re && enabledCats.has(cat.key)).map((cat) => cat.re);
    for (const sid of suiteSet) {
      let count = 0; // tiles taken for THIS event — caps it at perEvent so later
      // events aren't starved (the global maxTiles guard alone isn't enough).
      const dashes = catalogue.filter((c) => c.suiteId === sid).map((c) => store.get(c.dashboardId)).filter(Boolean);
      for (const re of MUST) {
        for (const def of dashes) {
          const m = [...(def.tiles || []), ...((def.carousels || []).flatMap((t) => t.tiles || []))].find((t) => t.type !== 'text' && t.query?.fields?.length && re.test(t.title || ''));
          if (m) { const before = picks.length; addTile(def, m, sid, true); if (picks.length > before) count += 1; break; }
        }
      }
      const pools = catalogue.filter((c) => c.suiteId === sid)
        .map((c) => ({ c, def: store.get(c.dashboardId) }))
        .filter((x) => x.def)
        .sort((a, b) => rank(a.c) - rank(b.c))
        .map(({ def }) => ({ def, tiles: [...(def.tiles || []), ...((def.carousels || []).flatMap((t) => t.tiles || []))].filter((t) => t.type !== 'text' && t.query?.fields?.length).sort((a, b) => tilePriority(a) - tilePriority(b)), idx: 0, taken: 0 }))
        .filter((p) => p.tiles.length);
      let progressed = true;
      while (count < perEvent && progressed && picks.length < maxTiles) {
        progressed = false;
        for (const pool of pools) {
          if (count >= perEvent || picks.length >= maxTiles) break;
          if (pool.idx < pool.tiles.length && pool.taken < PER_DASH) {
            const t = pool.tiles[pool.idx++]; const before = picks.length;
            addTile(pool.def, t, sid, true);
            if (picks.length > before) { pool.taken += 1; count += 1; progressed = true; }
          }
        }
      }
    }
  }
  const ticketingDashes = catalogue
    .filter((c) => isTicketingSet(c.setName))
    .sort((a, b) => (isOverviewDash(b.title) ? 1 : 0) - (isOverviewDash(a.title) ? 1 : 0)); // overview boards first
  let tkt = 0; const TKT_BUDGET = 8;
  for (const c of ticketingDashes) {
    if (tkt >= TKT_BUDGET || picks.length >= maxTiles) break;
    const def = store.get(c.dashboardId);
    if (!def || !dashMeta[c.dashboardId]) continue;
    const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((t) => t.tiles || []))]
      .filter((t) => t.type !== 'text' && t.query?.fields?.length)
      .sort((a, b) => tilePriority(a) - tilePriority(b));
    let taken = 0;
    for (const t of tiles) {
      if (taken >= PER_DASH || tkt >= TKT_BUDGET || picks.length >= maxTiles) break;
      const before = picks.length; addTile(def, t, c.suiteId, true);
      if (picks.length > before) { taken += 1; tkt += 1; }
    }
  }
  // 1e) Guarantee a little GA4/ANALYTICS — but ONLY if the client actually has an
  //     analytics set (else this is a no-op). A small budget so the traffic/
  //     funnel headline tiles always make the cut without crowding out ticketing.
  const isAnalyticsSet = (name) => /\bga4\b|analytics|google/i.test(name || '');
  let ga = 0; const GA_BUDGET = enabledCats.has('ga4') ? 3 : 0; // off when the reader hides GA4
  for (const lead of leads) {
    if (ga >= GA_BUDGET || picks.length >= maxTiles) break;
    if (!isAnalyticsSet(lead.setName)) continue;
    for (const did of lead.dashboardIds) {
      if (ga >= GA_BUDGET || picks.length >= maxTiles) break;
      const def = store.get(did);
      if (!def || !dashMeta[did]) continue;
      const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((t) => t.tiles || []))]
        .filter((t) => t.type !== 'text' && t.query?.fields?.length)
        .sort((a, b) => tilePriority(a) - tilePriority(b));
      let taken = 0;
      for (const t of tiles) {
        if (taken >= PER_DASH || ga >= GA_BUDGET || picks.length >= maxTiles) break;
        const before = picks.length; addTile(def, t, lead.suiteId, true);
        if (picks.length > before) { taken += 1; ga += 1; }
      }
    }
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
    if (suiteSet && !suiteSet.has(c.suiteId)) continue; // only the selected events
    // One pool per dashboard — but per (suite, dashboard) when scoped to multiple
    // events, so a shared dashboard fills each event with its own scoped tiles.
    const pkey = suiteSet ? `${c.suiteId}|${c.dashboardId}` : c.dashboardId;
    if (pooled.has(pkey)) continue;
    pooled.add(pkey);
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
  while (picks.length < maxTiles && progressed) {
    progressed = false;
    for (const pool of rotated) {
      if (picks.length >= maxTiles) break;
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
  // Keyed by SUITE+dashboard — a shared dashboard's alignment differs per event
  // (each event's days-to-go), so it must not be computed once and reused.
  const dboKey = (p) => `${p.suiteId}|${p.def.id}`;
  const daysBeforeOverlays = {};
  if (alignDaysBefore) {
    // Resolve each unique suite+dashboard overlay in parallel — every one is a
    // Looker round-trip, so a sequential loop here serialised N calls before the
    // (already-parallel) tile sweep could even start.
    const uniq = []; const seenDbo = new Set();
    for (const p of picks) { const k = dboKey(p); if (!seenDbo.has(k)) { seenDbo.add(k); uniq.push(p); } }
    await Promise.all(uniq.map(async (p) => { daysBeforeOverlays[dboKey(p)] = await daysBeforeOverlayFor(p.def, user, p.suiteId, lockMaps[p.suiteId] || {}); }));
  }

  const dropped = []; // tiles excluded from the facts, with the reason (logged below)
  const tiles = (await Promise.all(picks.slice(0, maxTiles).map(async (p) => {
    const view = entityViews[p.def.id];
    const extra = {};
    if (view) for (const [fname, qfield] of Object.entries(p.tile.listenTo || {})) if (fname in view) extra[qfield] = view[fname];
    // Days-to-go overlay — but NOT for analytics/GA4 (they have no days-before-event
    // axis; forcing one can return zero, which is what broke GA4 tiles in the briefing).
    const dbo = isAnalyticsName(p.setName) ? null : daysBeforeOverlays[dboKey(p)];
    if (dbo) for (const [fname, qfield] of Object.entries(p.tile.listenTo || {})) if (fname in dbo) extra[qfield] = dbo[fname];
    // Expand the dashboard's client-default saved filters into the lock map (suite
    // locks still win), exactly like resolveTileValue — so a GA4 tile gets its saved
    // DATE RANGE (without which GA4 explores return 0) instead of dropping out.
    const lockMap = { ...expandLockMap(view || {}), ...(lockMaps[p.suiteId] || {}) };
    const body = await tileQueryBody(p.tile, p.def, user, p.suiteId, lockMap, extra);
    if (!body) { dropped.push(`${p.dashTitle} › ${p.tile.title || '?'} (scope blocked / unrunnable)`); return null; }
    try {
      const data = await runLookerQuery('/queries/run/json_detail', body, undefined, force);
      if (!data?.data?.length) { dropped.push(`${p.dashTitle} › ${p.tile.title || '?'} (no rows for the default filters)`); return null; }
      return {
        title: p.tile.title || '(untitled)', visType: p.tile.vis?.type, context: p.tile.aiContext || '',
        fields: data.fields, rows: data.data, filters: body.filters || {},
        dashboardId: p.def.id, suiteId: p.suiteId, suiteName: suiteNameById[p.suiteId] || dashMeta[p.def.id]?.suiteName || '', setName: p.setName, dashTitle: p.dashTitle, pinned: p.pinned,
      };
    } catch (e) { dropped.push(`${p.dashTitle} › ${p.tile.title || '?'} (error: ${e.message})`); return null; }
  }))).filter(Boolean);

  // Why a dashboard might be missing from a briefing/digest: tiles drop when the
  // explore can't be scoped, or the query returns no rows. Log it so it's not a
  // mystery (visible in the server logs when a digest is built/tested).
  if (dropped.length) console.warn(`[facts] entity=${entityId} kept ${tiles.length} tiles, dropped ${dropped.length}: ${dropped.slice(0, 25).join(' · ')}`);
  if (tiles.length) console.log(`[facts] entity=${entityId} dashboards in facts: ${[...new Set(tiles.map((t) => t.dashTitle))].join(' · ')}`);

  return { tiles, catalogue, dropped };
}

// In-memory caches: light snapshot (10 min) and briefing (6 h) per user+entity.
const snapCache = new Map();
const briefCache = new Map();
const cacheGet = (map, key, ttl) => { const e = map.get(key); return e && Date.now() - e.at < ttl ? e.val : null; };
const cachePut = (map, key, val) => { map.set(key, { at: Date.now(), val }); if (map.size > 500) map.delete(map.keys().next().value); };
const bustHome = (userId, entityId) => {
  const k = `${userId}:${entityId}`;
  snapCache.delete(k);
  // Clear every briefing cache entry for this user+client — single segment keys
  // AND the multi-event overall/events keys (which carry the suite selection).
  for (const key of [...briefCache.keys()]) if (key.startsWith(`${k}:`)) briefCache.delete(key);
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
// Current calendar date in the client's timezone, e.g. "Tuesday, 16 June 2026".
// Passed to the AI so the digest/briefing anchor "today/yesterday/month-to-date"
// to the SEND date — not the latest (possibly lagging) date in the data.
function todayLabel(tz = 'Africa/Johannesburg') {
  try { return new Date().toLocaleDateString('en-ZA', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }
  catch { return new Date().toISOString().slice(0, 10); }
}
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
const briefInstructions = (user, entityId, segment) => [aiInstructionsFor(null), briefingInstructionsFor(user, entityId, clientCatalogue(entityId).suites), segment ? timeDefaults()[segment] : ''].filter(Boolean).join('\n\n');
// Build briefing facts scoped to the selected events, grouped by event (in the
// selected order). Reuses buildFacts (and its Looker query cache).
async function factGroups(user, entityId, selectedIds, force) {
  const { tiles, catalogue, dropped = [] } = await buildFacts(user, entityId, force, true, [], { suiteIds: selectedIds });
  const byId = Object.fromEntries(catalogue.map((c) => [c.dashboardId, c]));
  const map = new Map();
  for (const t of tiles) {
    if (!map.has(t.suiteId)) map.set(t.suiteId, { suiteId: t.suiteId, suiteName: t.suiteName || '', tiles: [] });
    map.get(t.suiteId).tiles.push(t);
  }
  return { groups: selectedIds.map((id) => map.get(id)).filter(Boolean), byId, dropped };
}
// The portfolio OVERALL summary (fast, returned first). Includes the suite list
// so the home page can render the event picker + collapsed sections immediately.
async function generateOverall(user, entityId, segment, { force = false } = {}) {
  const apiKey = anthropicKeyForUser(user);
  const { suites, selected } = briefingSuites(user, entityId);
  const base = { available: true, multi: true, generatedAt: new Date().toISOString(), suites };
  if (!insights.isConfigured(apiKey) || !selected.length) return { ...base, headline: '', bullets: [] };
  const key = `${user.id}:${entityId}:${segment}:overall:${selected.join(',')}`;
  if (!force) { const hit = cacheGet(briefCache, key, 6 * 3600e3); if (hit) return hit; }
  if (briefInflight.has(key)) return briefInflight.get(key);
  const p = (async () => {
    const { groups, byId } = await factGroups(user, entityId, selected, force);
    if (!groups.length) return { ...base, headline: '', bullets: [] };
    const { catalogue } = clientCatalogue(entityId);
    const raw = await insights.briefHomeOverall({ groups, catalogue, capabilities: ACTION_CAPABILITIES, actions: actionsSummaryFor(entityId), today: todayLabel(), instructions: briefInstructions(user, entityId, segment), apiKey });
    const link = (id) => (id && byId[id] ? { dashboardId: id, suiteId: byId[id].suiteId, label: `${byId[id].setName} → ${byId[id].title}` } : null);
    const out = {
      ...base,
      headline: String(raw.headline || '').slice(0, 600),
      bullets: (raw.bullets || []).slice(0, 4).map((b) => ({ text: String(b.text || '').slice(0, 400) })).filter((b) => b.text),
      // Cross-event "Worth a look" suggestions (so the portfolio home keeps them).
      suggestions: (raw.suggestions || []).slice(0, 3)
        .map((s) => ({ title: String(s.title || '').slice(0, 80), reason: String(s.reason || '').slice(0, 200), link: link(s.dashboardId), action: CAPABILITY_KEYS.has(s.action) ? s.action : null }))
        .filter((s) => s.title && (s.link || s.action)),
    };
    cachePut(briefCache, key, out);
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
  if (!force) { const hit = cacheGet(briefCache, key, 6 * 3600e3); if (hit) return hit; }
  if (briefInflight.has(key)) return briefInflight.get(key);
  const p = (async () => {
    const { groups, byId } = await factGroups(user, entityId, selected, force);
    const nameById = Object.fromEntries(suites.map((s) => [s.id, s.name]));
    const raw = groups.length ? await insights.briefHomeEvents({ groups, today: todayLabel(), instructions: briefInstructions(user, entityId, segment), apiKey }) : { events: [] };
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
    const out = { events, generatedAt: new Date().toISOString() };
    cachePut(briefCache, key, out);
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
  if (!force) { const hit = cacheGet(briefCache, key, 6 * 3600e3); if (hit) return hit; }
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
    const { tiles, catalogue } = await buildFacts(user, entityId, force, true);
    if (!tiles.length) return { available: false };
    const byId = Object.fromEntries(catalogue.map((c) => [c.dashboardId, c]));
    const prof = db.viewProfile(user.id);
    const profileForAi = {
      lastVisit: prof.lastVisit,
      top: prof.top.filter((t) => byId[t.dashboardId]).map((t) => ({ title: byId[t.dashboardId].title, count: t.count })),
    };
    const instructions = [aiInstructionsFor(null), briefingInstructionsFor(user, entityId, suites), timeDefaults()[segment]].filter(Boolean).join('\n\n');
    const msgs = recentMessages(entityId, user.id);
    const goals = await goalsP;
    const raw = await insights.briefHome({ tiles, profile: profileForAi, catalogue, instructions, apiKey, actions: actionsSummaryFor(entityId), messages: msgs, capabilities: ACTION_CAPABILITIES, goals, today: todayLabel() });
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
  const entityViews = {};
  const daysBeforeOverlays = {};
  const out = [];
  const dropped = [];
  for (const { tile, def, m } of wanted.slice(0, 24)) {
    if (!(m.suiteId in lockMaps)) lockMaps[m.suiteId] = expandLockMap(db.lockedFiltersForSuite(m.suiteId));
    if (!(def.id in entityViews)) entityViews[def.id] = db.getFilterView('entity', entityId, def.id) || null;
    if (alignDaysBefore && !(def.id in daysBeforeOverlays)) daysBeforeOverlays[def.id] = await daysBeforeOverlayFor(def, user, m.suiteId, lockMaps[m.suiteId] || {});
    const view = entityViews[def.id];
    const dbo = daysBeforeOverlays[def.id];
    const extra = {};
    if (view) for (const [fname, qfield] of Object.entries(tile.listenTo || {})) if (fname in view) extra[qfield] = view[fname];
    if (dbo) for (const [fname, qfield] of Object.entries(tile.listenTo || {})) if (fname in dbo) extra[qfield] = dbo[fname];
    // Expand the dashboard's client-default saved filters into the lock map (suite locks
    // win), like resolveTileValue — so GA4 tiles get their saved DATE RANGE and don't
    // come back empty (they were missing entirely from curated digests before).
    const lockMap = { ...expandLockMap(view || {}), ...(lockMaps[m.suiteId] || {}) };
    const body = await tileQueryBody(tile, def, user, m.suiteId, lockMap, extra);
    if (!body) { dropped.push(`${def.title} › ${tile.title || '?'} (scope blocked / unrunnable)`); continue; }
    try {
      const data = await runLookerQuery('/queries/run/json_detail', body, undefined, false);
      if (!data?.data?.length) { dropped.push(`${def.title} › ${tile.title || '?'} (no rows for the default filters)`); continue; }
      out.push({ title: tile.title || '(untitled)', visType: tile.vis?.type, context: tile.aiContext || '', fields: data.fields, rows: data.data, pivots: data.pivots || [], filters: body.filters || {}, dashboardId: def.id, suiteId: m.suiteId, setName: m.setName, dashTitle: def.title, pinned: false });
    } catch (e) { dropped.push(`${def.title} › ${tile.title || '?'} (error: ${e.message})`); }
  }
  if (dropped.length) console.warn(`[facts:curated] entity=${entityId} kept ${out.length}, dropped ${dropped.length}: ${dropped.slice(0, 25).join(' · ')}`);
  return { tiles: out, catalogue, dropped };
}

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
  const instructions = [aiInstructionsFor(null), briefingInstructionsFor(user, entityId, clientCatalogue(entityId).suites)].filter(Boolean).join('\n\n');
  const href = (id) => { const c = id && byId[id]; return c ? `${mailer.baseUrl()}/suite/${c.suiteId}/d/${id}` : ''; };
  // A suggested action with an executable capability deep-links into the
  // pre-filled "Make it happen" campaign editor (recipe auto-resolves the
  // audience + copy); otherwise it links to the relevant dashboard.
  const actionHref = (a) => (CAPABILITY_KEYS.has(a.action)
    ? `${mailer.baseUrl()}/engage/campaigns?type=${encodeURIComponent(a.action)}&goal=${encodeURIComponent(String(a.text || '').slice(0, 200))}`
    : href(a.dashboardId));
  const mapKpi = (k) => ({ label: String(k.label || '').slice(0, 40), value: String(k.value || '').slice(0, 30), delta: String(k.delta || '').slice(0, 40), href: href(k.dashboardId) });
  const mapAction = (a) => ({ text: String(a.text || '').slice(0, 200), href: actionHref(a), action: CAPABILITY_KEYS.has(a.action) ? a.action : null });
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
        charts.push({ title: ft.title, imageUrl: `${base}/mail-assets/img/${token}`, href: href(ft.dashboardId) });
      } else {
        const v = factValueLabel(ft);
        if (v && v !== '—') kpis.push({ label: String(ft.title || '').slice(0, 40), value: String(v).slice(0, 30), delta: '', href: href(ft.dashboardId) });
      }
    }
    return { charts, kpis };
  };

  // The single-pass (flat) digest over all the facts — used for single-event
  // clients, and as the safety net if the multi-event pass can't be produced.
  const buildFlat = async () => {
    const raw = await insights.digestBrief({ tiles: factTilesAll, roleLabel: lens.label, roleFocus: effectiveFocus, catalogue, instructions, apiKey, actions: actionsSummaryFor(entityId), capabilities: ACTION_CAPABILITIES, goals, today: todayLabel() });
    const o = {
      subject: String(raw.subject || '').slice(0, 120),
      headline: String(raw.headline || '').slice(0, 600),
      narrative: (raw.narrative || []).slice(0, 5).map((s) => String(s).slice(0, 800)).filter(Boolean),
      kpis: (raw.kpis || []).slice(0, 6).map(mapKpi).filter((k) => k.label && k.value),
      actions: (raw.actions || []).slice(0, 3).map(mapAction).filter((a) => a.text),
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
      const [ovRaw, evRaws] = await Promise.all([
        insights.digestBriefMulti({ groups, roleLabel: lens.label, roleFocus: effectiveFocus, catalogue, instructions, apiKey, actions: acts, capabilities: ACTION_CAPABILITIES, goals, today }),
        Promise.all(groups.map((g) => insights.digestBrief({ tiles: g.tiles, roleLabel: lens.label, roleFocus: effectiveFocus, catalogue, instructions, apiKey, actions: acts, capabilities: ACTION_CAPABILITIES, goals: [], today })
          .then((r) => ({ g, r }))
          .catch((e) => { console.error(`[digest] event section failed (${g.suiteName}):`, e.message); return { g, r: null }; }))),
      ]);
      const events = evRaws.map(({ g, r }) => {
        const e = r || {};
        const sect = {
          suiteId: g.suiteId, suiteName: g.suiteName,
          headline: r ? String(e.headline || '').slice(0, 400) : 'Summary unavailable for this event right now.',
          narrative: (e.narrative || []).slice(0, 3).map((s) => String(s).slice(0, 800)).filter(Boolean),
          kpis: (e.kpis || []).slice(0, 6).map(mapKpi).filter((k) => k.label && k.value),
          actions: (e.actions || []).slice(0, 3).map(mapAction).filter((a) => a.text),
        };
        const vis = visualsBySuite[g.suiteId];
        if (vis) { if (vis.charts.length) sect.charts = vis.charts.slice(0, 6); if (vis.kpis.length) sect.kpis = [...vis.kpis, ...sect.kpis].slice(0, 9); }
        return sect;
      });
      out = {
        subject: String(ovRaw.subject || '').slice(0, 120),
        headline: String(ovRaw.headline || '').slice(0, 600),
        narrative: (ovRaw.narrative || []).slice(0, 4).map((s) => String(s).slice(0, 800)).filter(Boolean),
        kpis: (ovRaw.kpis || []).slice(0, 6).map(mapKpi).filter((k) => k.label && k.value),
        actions: (ovRaw.actions || []).slice(0, 3).map(mapAction).filter((a) => a.text),
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

// Scheduler — recurring/one-off digest jobs (own table + routes). Mounted here,
// after its content builder + role lenses exist. Remove this line + scheduler.js
// to uninstall. The 60s tick lives inside the module.
// ─── Digest history + feedback (the knowledge-base loop) ─────────────────────
const crypto = require('crypto');
function digestFbSecret() { let s = db.getSetting('digest_fb_secret', ''); if (!s) { s = crypto.randomBytes(18).toString('base64url'); db.setSetting('digest_fb_secret', s); } return s; }
function signDigestToken(o) { const p = Buffer.from(JSON.stringify(o)).toString('base64url'); const sig = crypto.createHmac('sha256', digestFbSecret()).update(p).digest('base64url').slice(0, 16); return `${p}.${sig}`; }
function parseDigestToken(tok) { const [p, sig] = String(tok || '').split('.'); if (!p || !sig) return null; const want = crypto.createHmac('sha256', digestFbSecret()).update(p).digest('base64url').slice(0, 16); if (sig !== want) return null; try { return JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; } }
const digestFeedbackUrl = (digestId, email) => `${mailer.baseUrl()}/df/${signDigestToken({ d: digestId, e: (email || '').toLowerCase() })}`;
const digestReplyTo = (entityId) => { try { return inboxView(entityId).address || null; } catch { return null; } };
function recordDigestHistory(args) { try { return db.addDigestHistory(args); } catch (e) { console.error('[digest] history save failed', e.message); return ''; } }

// Distil accumulated feedback (digest + briefing) → the per-client preferences note.
const learningEntities = new Set();
async function learnDigestPrefs(entityId) {
  if (!entityId || learningEntities.has(entityId)) return;
  learningEntities.add(entityId);
  try {
    const fb = db.listDigestFeedback(entityId, { limit: 200 });
    const briefFb = db.listBriefingFeedback().filter((f) => f.entityId === entityId && (f.comment || f.kind === 'dislike'));
    const items = [
      ...fb.map((f) => `[digest ${f.kind}] ${f.comment || (f.kind === 'up' ? '(liked)' : f.kind === 'down' ? '(disliked)' : '')}`.trim()),
      ...briefFb.map((f) => `[briefing ${f.kind}] ${(f.comment || '').trim()}`.trim()),
    ].filter((s) => s && !/^\[[a-z]+ [a-z]+\]$/i.test(s)).slice(0, 150);
    if (!items.length) return;
    const apiKey = anthropicKeyForEntity(entityId);
    if (!insights.isConfigured(apiKey)) return;
    const prev = db.getDigestPrefs(entityId).note || '';
    const note = await insights.distilPreferences({ items, previous: prev, apiKey });
    if (note) { db.setDigestPrefs(entityId, { note, fromCount: items.length }); db.markDigestFeedbackDistilled(entityId); }
  } catch (e) { console.error('[digest] learnDigestPrefs failed', e.message); }
  finally { learningEntities.delete(entityId); }
}
function maybeLearn(entityId) { try { if (db.listDigestFeedback(entityId, { onlyUndistilled: true, limit: 50 }).length >= 3) learnDigestPrefs(entityId); } catch { /* best-effort */ } }
function saveDigestFeedback({ entityId, digestId, source, email, kind, comment }) {
  const id = db.addDigestFeedback({ entityId, digestId, source, email, kind, comment });
  maybeLearn(entityId);
  return id;
}

// In-email feedback page (signed token, no login needed).
function digestFbPage(msg, token, digest) {
  const headline = digest ? String(digest.headline || digest.subject || '').replace(/</g, '&lt;') : '';
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Digest feedback</title></head>
<body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f5f5f7;color:#1d1d1f;">
<div style="max-width:520px;margin:0 auto;padding:40px 20px;">
  <div style="background:#fff;border:1px solid #e8e8ec;border-radius:16px;padding:26px;">
    <div style="font-size:18px;font-weight:800;margin-bottom:6px;">${msg}</div>
    ${headline ? `<div style="font-size:13px;color:#86868b;margin-bottom:16px;">On: ${headline}</div>` : ''}
    <label style="font-size:13px;font-weight:600;">Anything you'd add? (what you liked, what to change)</label>
    <textarea id="c" rows="5" style="width:100%;box-sizing:border-box;margin-top:8px;padding:11px;border:1.5px solid #e0e0e5;border-radius:10px;font-size:14px;font-family:inherit;"></textarea>
    <button id="b" style="margin-top:12px;background:#ff385c;color:#fff;border:none;border-radius:980px;padding:11px 22px;font-size:14px;font-weight:700;cursor:pointer;">Send feedback</button>
    <div id="d" style="font-size:13px;color:#1a8a4a;margin-top:12px;"></div>
  </div>
  <div style="font-size:12px;color:#a1a1a6;text-align:center;margin-top:14px;">Howler · Pulse — this helps tune your future digests.</div>
</div>
<script>
  var b=document.getElementById('b');
  b.onclick=function(){var c=document.getElementById('c').value.trim();if(!c){document.getElementById('d').textContent='Add a note first.';return;}b.disabled=true;
    fetch('/df/${token}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'comment',comment:c})})
    .then(function(){document.getElementById('d').textContent='Thanks — sent. You can close this tab.';document.getElementById('c').value='';})
    .catch(function(){document.getElementById('d').textContent='Could not send — please reply to the email instead.';b.disabled=false;});};
</script></body></html>`;
}
app.get('/df/:token', (req, res) => {
  const t = parseDigestToken(req.params.token);
  if (!t || !t.d) return res.status(400).type('html').send(digestFbPage('That feedback link looks invalid or expired.', req.params.token, null));
  const d = db.getDigestHistory(t.d);
  const v = req.query.v;
  if (d && (v === 'up' || v === 'down')) saveDigestFeedback({ entityId: d.entityId, digestId: t.d, source: 'email', email: t.e || '', kind: v, comment: '' });
  const msg = v === 'up' ? 'Glad it landed 👍' : v === 'down' ? 'Noted — thanks 👎' : 'Thanks for the feedback';
  res.type('html').send(digestFbPage(msg, req.params.token, d));
});
app.post('/df/:token', (req, res) => {
  const t = parseDigestToken(req.params.token);
  if (!t || !t.d) return res.status(400).json({ error: 'bad token' });
  const d = db.getDigestHistory(t.d);
  const kind = ['up', 'down'].includes(req.body?.kind) ? req.body.kind : 'comment';
  saveDigestFeedback({ entityId: d?.entityId || '', digestId: t.d, source: 'email', email: t.e || '', kind, comment: String(req.body?.comment || '') });
  res.json({ ok: true });
});

// In-app digest archive + feedback. Entity-aware (works for an admin previewing a
// client too) — distinct path so it never collides with the scheduler's
// /api/my/digests/:entityId job routes.
const canEntityReq = (req, entityId) => req.user.role === 'admin' || (req.user.entityIds || []).includes(entityId);
app.get('/api/my/digest-history/:entityId', auth.requireAuth, (req, res) => {
  if (!canEntityReq(req, req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
  res.json({ digests: db.listDigestHistory(req.params.entityId, 60).map((d) => ({ id: d.id, role: d.roleLabel || d.role, subject: d.subject, headline: d.headline, createdAt: d.createdAt })) });
});
app.get('/api/my/digest-history/:entityId/:id', auth.requireAuth, (req, res) => {
  if (!canEntityReq(req, req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
  const d = db.getDigestHistory(req.params.id);
  if (!d || d.entityId !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
  res.json({ ...d, feedback: db.feedbackForDigest(d.id) });
});
app.post('/api/my/digest-history/:entityId/:id/feedback', auth.requireAuth, (req, res) => {
  if (!canEntityReq(req, req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
  const d = db.getDigestHistory(req.params.id);
  if (!d || d.entityId !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
  const kind = ['up', 'down'].includes(req.body?.kind) ? req.body.kind : 'comment';
  saveDigestFeedback({ entityId: req.params.entityId, digestId: d.id, source: 'inapp', email: req.user.email, kind, comment: String(req.body?.comment || '') });
  res.json({ ok: true });
});
// Edit a feedback comment (own comments; admins may edit any) — re-feeds the loop.
app.put('/api/my/digest-history/:entityId/:id/feedback/:fbId', auth.requireAuth, (req, res) => {
  if (!canEntityReq(req, req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
  const row = db.getDigestFeedbackRow(req.params.fbId);
  if (!row || row.entityId !== req.params.entityId || row.digestId !== req.params.id) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && (row.email || '') !== (req.user.email || '').toLowerCase()) return res.status(403).json({ error: 'Not your comment' });
  db.updateDigestFeedback(req.params.fbId, String(req.body?.comment || ''));
  maybeLearn(req.params.entityId);
  res.json({ ok: true });
});
// Admin: review feedback + the learned preferences note (+ trigger a re-distil / edit).
app.get('/api/admin/entities/:id/digest-feedback', auth.requireAdmin, (req, res) => {
  res.json({ feedback: db.listDigestFeedback(req.params.id, { limit: 200 }), prefs: db.getDigestPrefs(req.params.id) });
});
app.post('/api/admin/entities/:id/digest-learn', auth.requireAdmin, async (req, res) => {
  await learnDigestPrefs(req.params.id);
  res.json({ prefs: db.getDigestPrefs(req.params.id) });
});
app.put('/api/admin/entities/:id/digest-prefs', auth.requireAdmin, (req, res) => {
  db.setDigestPrefs(req.params.id, { note: String((req.body || {}).note || ''), fromCount: db.getDigestPrefs(req.params.id).fromCount || 0 });
  res.json({ prefs: db.getDigestPrefs(req.params.id) });
});

require('./scheduler').mount(app, { db, auth, mailer, messaging, push, generateContent: buildDigestContent, roleLenses: ROLE_LENSES, recordDigest: recordDigestHistory, feedbackUrl: digestFeedbackUrl, replyTo: digestReplyTo });

// Onboarding checklist — light-touch "Getting started" guide (auto-detect + manual).
require('./onboarding').mount(app, { db, auth });

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
  resolveAudience: async ({ entityId, dashboardId, tileId, user, filterOverrides = {}, suiteId = '' }) => {
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
  db, auth, meta, tiktok, resolveAudience: actionsApi.audienceFor,
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
// Serve the sales product-overview as a self-rendering HTML page that fetches its
// own markdown source, so editing docs/PRODUCT_OVERVIEW_SALES.md updates the page.
// Scoped to this single doc on purpose — the rest of docs/ is internal.
const PRODUCT_OVERVIEW_HTML = path.join(__dirname, '../docs/product-overview-sales.html');
const PRODUCT_OVERVIEW_MD = path.join(__dirname, '../docs/PRODUCT_OVERVIEW_SALES.md');

app.get(['/product-overview-sales', '/product-overview-sales.html'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(PRODUCT_OVERVIEW_HTML);
});

app.get('/product-overview-sales.md', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.type('text/markdown; charset=utf-8');
  res.sendFile(PRODUCT_OVERVIEW_MD);
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

const PORT = process.env.PORT || 3045;
app.listen(PORT, () => {
  console.log(`Howler Looker Tool running on http://localhost:${PORT}`);
  console.log(`Looker instance: ${looker.lookerBaseUrl() || '(not configured — set in Admin → Integrations)'}`);
});
