// ─── Per-entity API keys — the foundation of the public surface ────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the `api_keys` + `api_audit` tables and
// the dual-surface key-management routes (admin per client + client self-service).
// See docs/API_MCP_BRIEF.md.
//
// A key is scoped to exactly ONE client (entity) and carries granular scopes
// (read | write | send — least privilege; v1 issues read-only). The secret is
// shown ONCE at creation, stored as a SHA-256 hash (keys are high-entropy random
// strings, so a fast hash is the right trade — we need lookup-by-hash), and
// reported masked thereafter (same write-only pattern as integration creds).
//
// Authentication produces a SYNTHETIC PRINCIPAL — a `req.user`-shaped object
// (same shape the segments auto-mirror already uses) — so every existing gate
// (entity ownership, organiser scope via resolveScope/applyScope, permission
// checks) applies to external callers unchanged. The key CANNOT cross entities:
// entityIds is pinned to the key's one entity. What a key may DO is enforced by
// its scopes at the surface (requireScope); tenancy is the principal's job.
// The dormant `role` column lets a later version issue role-narrowed or
// per-user agent keys without a migration (ship entity-only; schema ready).
//
// Mount: `require('./apiKeys').mount(app, { db, auth, rateLimit })`.

const crypto = require('crypto');
const { HttpError, asyncHandler } = require('./http');

// read       — aggregate reads: catalogue, KPI numbers, counts, results.
// read_rows  — ROW-LEVEL reads: the table behind a tile (customer/ticketing
//              rows, may include personal data). Explicit opt-in per key —
//              never rides along with plain `read`.
// write/send — reserved for P3 (drafts / approvals-gated sending).
const SCOPES = ['read', 'read_rows', 'write', 'send'];
const PREFIX = 'pulse_sk_';
const MAX_ACTIVE_KEYS = 20; // per entity — plenty for real integrations, bounds abuse

function mount(app, { db, auth, rateLimit }) {
  const sql = db.db;
  const now = () => new Date().toISOString();

  sql.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id           TEXT PRIMARY KEY,
      entity_id    TEXT NOT NULL,
      name         TEXT NOT NULL,
      key_hash     TEXT NOT NULL UNIQUE,
      key_hint     TEXT NOT NULL,
      scopes       TEXT NOT NULL DEFAULT 'read',  -- comma-separated, least privilege
      role         TEXT,                          -- dormant: future role-narrowed keys
      created_by   TEXT,                          -- dormant: future per-user agent keys
      created_at   TEXT NOT NULL,
      last_used_at TEXT NOT NULL DEFAULT '',
      revoked_at   TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_entity ON api_keys(entity_id);
    CREATE TABLE IF NOT EXISTS api_audit (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id    TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      surface   TEXT NOT NULL,             -- rest | mcp
      action    TEXT NOT NULL,             -- "GET /api/v1/segments" | "tool:pulse_get_metric"
      status    INTEGER NOT NULL DEFAULT 0,
      at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_api_audit_key ON api_audit(key_id, at);
  `);

  const hash = (secret) => crypto.createHash('sha256').update(secret).digest('hex');
  const maskHint = (hint) => `••••••${hint}`;
  const rowToKey = (r) => ({
    id: r.id, entityId: r.entity_id, name: r.name, hint: maskHint(r.key_hint),
    scopes: r.scopes.split(',').filter(Boolean),
    createdAt: r.created_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at,
  });

  // ── create / list / revoke (service functions shared by both surfaces) ──
  function createKey({ entityId, name, scopes }) {
    if (!db.getEntity(entityId)) throw new HttpError(404, 'Unknown client');
    const clean = [...new Set((scopes || ['read']).map(String))].filter((s) => SCOPES.includes(s));
    if (!clean.length) throw new HttpError(400, 'Pick at least one scope (read).');
    const active = sql.prepare("SELECT COUNT(*) n FROM api_keys WHERE entity_id=? AND revoked_at=''").get(entityId).n;
    if (active >= MAX_ACTIVE_KEYS) throw new HttpError(400, `This client already has ${MAX_ACTIVE_KEYS} active keys — revoke one first.`);
    const secret = PREFIX + crypto.randomBytes(24).toString('base64url');
    const id = crypto.randomUUID();
    sql.prepare('INSERT INTO api_keys (id, entity_id, name, key_hash, key_hint, scopes, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, entityId, String(name || '').trim().slice(0, 80) || 'Untitled key', hash(secret), secret.slice(-4), clean.join(','), now());
    return { key: rowToKey(sql.prepare('SELECT * FROM api_keys WHERE id=?').get(id)), secret };
  }
  const listKeys = (entityId) =>
    sql.prepare('SELECT * FROM api_keys WHERE entity_id=? ORDER BY created_at DESC').all(entityId).map(rowToKey);
  function revokeKey(entityId, keyId) {
    const r = sql.prepare('SELECT * FROM api_keys WHERE id=?').get(keyId);
    if (!r || r.entity_id !== entityId) throw new HttpError(404, 'Key not found');
    if (!r.revoked_at) sql.prepare('UPDATE api_keys SET revoked_at=? WHERE id=?').run(now(), keyId);
    return rowToKey(sql.prepare('SELECT * FROM api_keys WHERE id=?').get(keyId));
  }

  // ── authentication → synthetic principal ──
  // Same shape as a real client user (and the segments auto-mirror system user),
  // so resolveScope / audienceFor / canAccessSuite / hasPermission all apply
  // unchanged. Owner-role membership on ONE entity: capability is gated by the
  // key's scopes at the surface; tenancy is this principal (can't be widened).
  const principalFor = (r) => ({
    id: `apikey:${r.id}`, email: `apikey:${r.name}`, role: 'client',
    entityIds: [r.entity_id], memberships: [{ entityId: r.entity_id, role: 'owner' }],
  });

  function keyFromRequest(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!m || !m[1].startsWith(PREFIX)) return null;
    const r = sql.prepare("SELECT * FROM api_keys WHERE key_hash=? AND revoked_at=''").get(hash(m[1]));
    return r || null;
  }

  // Express middleware for the public surfaces (/api/v1, /mcp). 401s carry
  // WWW-Authenticate so agent platforms know Bearer auth is expected.
  function bearerAuth(req, res, next) {
    const r = keyFromRequest(req);
    if (!r) {
      res.set('WWW-Authenticate', 'Bearer realm="Pulse API"');
      return res.status(401).json({ error: 'A valid API key is required (Authorization: Bearer pulse_sk_…).' });
    }
    // last_used_at is a coarse "is this key alive?" signal — throttle the write.
    if (!r.last_used_at || Date.now() - new Date(r.last_used_at).getTime() > 60_000) {
      try { sql.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(now(), r.id); } catch { /* display only */ }
    }
    req.user = principalFor(r);
    req.apiKey = { id: r.id, entityId: r.entity_id, name: r.name, scopes: r.scopes.split(',').filter(Boolean) };
    next();
  }

  const hasScope = (req, scope) => !!req.apiKey && req.apiKey.scopes.includes(scope);
  const requireScope = (scope) => (req, res, next) => {
    if (!hasScope(req, scope)) return res.status(403).json({ error: `This API key doesn't have the '${scope}' scope.` });
    next();
  };

  // ── audit — everything an external key does, append-only ──
  function audit(req, surface, action, status = 200) {
    if (!req.apiKey) return;
    try {
      sql.prepare('INSERT INTO api_audit (key_id, entity_id, surface, action, status, at) VALUES (?,?,?,?,?,?)')
        .run(req.apiKey.id, req.apiKey.entityId, surface, String(action).slice(0, 200), status, now());
    } catch { /* audit must never break the request */ }
  }
  // Route-level auto-audit: record every REST call with its final status.
  const auditware = (surface) => (req, res, next) => {
    res.on('finish', () => audit(req, surface, `${req.method} ${req.baseUrl || ''}${req.path}`, res.statusCode));
    next();
  };
  const auditTail = (keyId, limit = 50) =>
    sql.prepare('SELECT surface, action, status, at FROM api_audit WHERE key_id=? ORDER BY id DESC LIMIT ?').all(keyId, limit);

  // ── management routes (dual-surface, same underlying functions) ──
  // Admin: manage any client's keys (Admin → client → Integrations).
  app.get('/api/admin/entities/:id/api-keys', auth.requireAdmin, (req, res) => {
    res.json({ keys: listKeys(req.params.id) });
  });
  app.post('/api/admin/entities/:id/api-keys', auth.requireAdmin, asyncHandler(async (req, res) => {
    res.status(201).json(createKey({ entityId: req.params.id, name: req.body?.name, scopes: req.body?.scopes }));
  }));
  app.post('/api/admin/entities/:id/api-keys/:keyId/revoke', auth.requireAdmin, asyncHandler(async (req, res) => {
    res.json({ key: revokeKey(req.params.id, req.params.keyId) });
  }));
  app.get('/api/admin/entities/:id/api-keys/:keyId/audit', auth.requireAdmin, (req, res) => {
    res.json({ events: auditTail(req.params.keyId) });
  });

  // Client self-service (Settings → Integrations), scoped to their own entity.
  const myEntity = (req) => {
    const entityId = req.params.entityId || req.query.entityId;
    if (!entityId) throw new HttpError(400, 'entityId required');
    if (!(req.user.entityIds || []).includes(entityId)) throw new HttpError(403, 'Not allowed');
    return entityId;
  };
  const canManage = auth.requirePermission('integrations.manage', (req) => req.params.entityId || req.query.entityId);
  app.get('/api/my/api-keys/:entityId', auth.requireAuth, canManage, asyncHandler(async (req, res) => {
    res.json({ keys: listKeys(myEntity(req)) });
  }));
  app.post('/api/my/api-keys/:entityId', auth.requireAuth, canManage,
    rateLimit({ windowMs: 60_000, max: 10, by: 'user', scope: 'apikey-create' }),
    asyncHandler(async (req, res) => {
      res.status(201).json(createKey({ entityId: myEntity(req), name: req.body?.name, scopes: req.body?.scopes }));
    }));
  app.post('/api/my/api-keys/:entityId/:keyId/revoke', auth.requireAuth, canManage, asyncHandler(async (req, res) => {
    res.json({ key: revokeKey(myEntity(req), req.params.keyId) });
  }));
  app.get('/api/my/api-keys/:entityId/:keyId/audit', auth.requireAuth, canManage, asyncHandler(async (req, res) => {
    const entityId = myEntity(req);
    const r = sql.prepare('SELECT entity_id FROM api_keys WHERE id=?').get(req.params.keyId);
    if (!r || r.entity_id !== entityId) throw new HttpError(404, 'Key not found');
    res.json({ events: auditTail(req.params.keyId) });
  }));

  console.log('[apiKeys] per-entity API keys mounted');
  return { bearerAuth, requireScope, hasScope, audit, auditware, createKey, listKeys, revokeKey };
}

module.exports = { mount, SCOPES };
