// ─── One-time migration: flat JSON files → SQLite ────────────────────────────
// Reads the legacy data/ files (tenants.json, users.json, dashboards/*.json)
// and populates the relational schema in db.js. Idempotent: it no-ops if the DB
// already has data unless run with --force. The JSON files are never modified.
//
//   tenant            → entity (organiser locks)   + a default Dashboard Set
//                       (event locks) pointing at a per-entity Template
//   user.tenantId     → user + user_entities row
//   dashboard         → dashboards row; shared + that tenant's boards land in
//                       the entity's Template

const fs = require('fs');
const path = require('path');
const D = require('./db');
const raw = D.db;

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const DASH_DIR = path.join(DATA_DIR, 'dashboards');
const read = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

function alreadyMigrated() {
  const c = raw.prepare(
    'SELECT (SELECT COUNT(*) FROM users)+(SELECT COUNT(*) FROM dashboards)+(SELECT COUNT(*) FROM entities) AS c'
  ).get().c;
  return c > 0;
}

function loadDashboards() {
  try {
    return fs.readdirSync(DASH_DIR).filter((f) => f.endsWith('.json')).map((f) => read(path.join(DASH_DIR, f), null)).filter(Boolean);
  } catch { return []; }
}

const run = raw.transaction(({ force = false } = {}) => {
  if (alreadyMigrated() && !force) { console.log('[migrate] DB already populated — skipping (use --force to override).'); return; }

  const tenants = read(path.join(DATA_DIR, 'tenants.json'), []);
  const users = read(path.join(DATA_DIR, 'users.json'), []);
  const dashboards = loadDashboards();

  // ── Dashboards (preserve ids + timestamps; content as JSON blob) ────────────
  const insDash = raw.prepare('INSERT OR IGNORE INTO dashboards (id,title,def,created_at,updated_at) VALUES (?,?,?,?,?)');
  for (const d of dashboards) {
    const { id, title, createdAt, updatedAt, tenantId, ...rest } = d;
    insDash.run(id, title || 'Untitled dashboard', JSON.stringify(rest), createdAt || new Date().toISOString(), updatedAt || createdAt || new Date().toISOString());
  }
  const sharedIds = dashboards.filter((d) => !d.tenantId).map((d) => d.id);
  const ownIds = (tid) => dashboards.filter((d) => d.tenantId === tid).map((d) => d.id);

  // ── Entities (organiser) + a Set (dashboards) + a Suite (event locks) ───────
  const tenantToEntity = {};
  for (const t of tenants) {
    const orgField = t.scopeFields?.organiser || 'core_organisers.name';
    const evField = t.scopeFields?.event || 'core_events.name';
    const entLocks = {};
    if ((t.organiserNames || []).length) entLocks[orgField] = t.organiserNames.join(',');

    const entity = D.createEntity({ name: t.name || 'Untitled entity', lockedFilters: entLocks, scopeFields: t.scopeFields || {} });
    tenantToEntity[t.id] = entity.id;

    const dashIds = [...new Set([...sharedIds, ...ownIds(t.id)])];
    const set = D.createSet({ name: `${entity.name} dashboards`, dashboardIds: dashIds });

    const suiteLocks = {};
    if ((t.eventNames || []).length) suiteLocks[evField] = t.eventNames.join(',');
    D.createSuite({ entityId: entity.id, name: entity.name, lockedFilters: suiteLocks, setIds: [set.id], position: 0 });
  }

  // A "Shared dashboards" set for admin reference / future assignment.
  if (sharedIds.length) D.createSet({ name: 'Shared dashboards', dashboardIds: sharedIds });

  // ── Users (preserve password hashes) + entity membership ────────────────────
  const insUser = raw.prepare('INSERT OR IGNORE INTO users (id,email,password_hash,role,created_at) VALUES (?,?,?,?,?)');
  for (const u of users) {
    const id = u.id || require('crypto').randomUUID();
    const role = u.role === 'admin' ? 'admin' : 'client';
    insUser.run(id, (u.email || '').trim().toLowerCase(), u.passwordHash, role, u.createdAt || new Date().toISOString());
    if (role !== 'admin' && u.tenantId && tenantToEntity[u.tenantId]) {
      D.setUserEntities(id, [tenantToEntity[u.tenantId]]);
    }
  }

  const orphans = dashboards.filter((d) => d.tenantId && !tenantToEntity[d.tenantId]).length;
  console.log(`[migrate] done: ${tenants.length} entities, ${users.length} users, ${dashboards.length} dashboards` +
    (orphans ? `, ${orphans} orphan dashboard(s) left unassigned (admin-only)` : ''));
});

if (require.main === module) {
  run({ force: process.argv.includes('--force') });
}
module.exports = { run };
