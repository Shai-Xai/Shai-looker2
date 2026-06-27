// ─── Status notices: platform incidents (human-authored) ─────────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the `status_notices`, `notice_targets`
// and `status_notice_updates` tables and all /api/.../notices routes. Mounted from
// index.js with one line + injected deps. Kill switch: settings key
// `notices_enabled` ('0' disables + 404s the routes). To remove the whole feature:
// delete this file + that line, then drop the three tables. Nothing else depends on it.
//
// NOT to be confused with server/alerts.js — that watches DATA (a metric crossing a
// threshold, fired by a background tick). THIS is the opposite: Howler staff post a
// platform issue ("we're investigating a login problem"), update it as it develops,
// and mark it resolved. It's a status-page-style incident timeline, broadcast to all
// clients (scope 'global') or to specific ones (scope 'targeted').
//
// The shape (mirrors a real status page):
//   • a notice = the incident (title · severity · current status · who it affects);
//   • updates  = the timeline — posting, updating and resolving are all update rows;
//   • Resolve  = a final update + a resolved_at stamp (the banner drops, the feed keeps it).
//
// How clients are told is keyed to SEVERITY so "plan for full fan-out" is a one-line
// edit (SEVERITY_CHANNELS). The in-app banner is always-on (the /my/notices poll);
// email/push fan out through the OS spine (one inbox thread per notice, per entity);
// SMS goes direct to any numbers the admin attaches for a critical incident.

const crypto = require('crypto');

const SEVERITIES = ['info', 'maintenance', 'degraded', 'outage'];
const STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'];
const SCOPES = ['global', 'targeted'];
const CHANNELS = ['email', 'push', 'sms']; // inbox + in-app banner are always-on

// Default fan-out per severity (inbox + banner are implicit, always-on). Editing this
// map is the whole "louder for worse incidents" lever. An admin can override per-notice.
const SEVERITY_CHANNELS = {
  info: ['email'],
  maintenance: ['email'],
  degraded: ['email', 'push'],
  outage: ['email', 'push', 'sms'],
};
// Resolved notices linger in the client feed (but off the banner) for this long.
const RESOLVED_WINDOW_MS = 48 * 3600 * 1000;

function mount(app, { db, auth, os, mailer, messaging }) {
  const sql = db.db;
  const now = () => new Date().toISOString();
  const uuid = () => crypto.randomUUID();
  const enabled = () => db.getSetting('notices_enabled', '1') !== '0'; // on by default; kill switch
  const isAdmin = (u) => u && u.role === 'admin';

  sql.exec(`
    CREATE TABLE IF NOT EXISTS status_notices (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL DEFAULT '',
      severity     TEXT NOT NULL DEFAULT 'degraded',  -- info | maintenance | degraded | outage
      status       TEXT NOT NULL DEFAULT 'investigating', -- investigating | identified | monitoring | resolved
      scope        TEXT NOT NULL DEFAULT 'global',     -- global (all clients) | targeted (notice_targets)
      channels     TEXT NOT NULL DEFAULT '',           -- '' = use the severity default; else JSON subset of email|push|sms
      sms_recipients TEXT NOT NULL DEFAULT '[]',        -- phone numbers for the sms channel (critical incidents)
      started_at   TEXT NOT NULL DEFAULT '',
      resolved_at  TEXT NOT NULL DEFAULT '',
      created_by   TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notices_status ON status_notices(status);

    -- One row per targeted client (none for scope='global').
    CREATE TABLE IF NOT EXISTS notice_targets (
      notice_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      PRIMARY KEY (notice_id, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_notice_targets_entity ON notice_targets(entity_id);

    -- The incident timeline. The opening post, every progress update and the
    -- resolution are all rows here; the newest row's status is the notice's status.
    CREATE TABLE IF NOT EXISTS status_notice_updates (
      id         TEXT PRIMARY KEY,
      notice_id  TEXT NOT NULL,
      body       TEXT NOT NULL DEFAULT '',
      status     TEXT NOT NULL DEFAULT 'investigating',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notice_updates ON status_notice_updates(notice_id, created_at);
  `);

  const parseJson = (s, fb) => { try { const v = JSON.parse(s); return v == null ? fb : v; } catch { return fb; } };
  const off = (res) => res.status(404).json({ error: 'Status notices are disabled' });

  // ── shape helpers ──
  const targetsFor = (id) => sql.prepare('SELECT entity_id FROM notice_targets WHERE notice_id=?').all(id).map((r) => r.entity_id);
  const updatesFor = (id) => sql.prepare('SELECT * FROM status_notice_updates WHERE notice_id=? ORDER BY created_at ASC').all(id)
    .map((u) => ({ id: u.id, body: u.body, status: u.status, createdBy: u.created_by, createdAt: u.created_at }));

  function noticeRow(r, { withUpdates = true } = {}) {
    if (!r) return null;
    const entityIds = r.scope === 'targeted' ? targetsFor(r.id) : [];
    const updates = withUpdates ? updatesFor(r.id) : [];
    return {
      id: r.id, title: r.title, severity: r.severity, status: r.status, scope: r.scope,
      channels: r.channels ? parseJson(r.channels, []) : null, // null = severity default
      smsRecipients: parseJson(r.sms_recipients, []),
      entityIds, audience: r.scope === 'global' ? 'All clients' : `${entityIds.length} client${entityIds.length === 1 ? '' : 's'}`,
      startedAt: r.started_at, resolvedAt: r.resolved_at,
      createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
      latest: updates.length ? updates[updates.length - 1] : null,
      updates,
    };
  }
  const noticeById = (id, opts) => noticeRow(sql.prepare('SELECT * FROM status_notices WHERE id=?').get(id), opts);

  // ── sanitise an incoming notice from the admin form ──
  function clean(b) {
    const severity = SEVERITIES.includes(b.severity) ? b.severity : 'degraded';
    const scope = SCOPES.includes(b.scope) ? b.scope : 'global';
    // An explicit channel override (subset of CHANNELS); '' / absent → severity default.
    const channels = Array.isArray(b.channels) ? [...new Set(b.channels.filter((c) => CHANNELS.includes(c)))] : null;
    const entityIds = Array.isArray(b.entityIds)
      ? [...new Set(b.entityIds.map((e) => String(e)).filter((e) => e && db.getEntity(e)))].slice(0, 500) : [];
    const smsRecipients = Array.isArray(b.smsRecipients)
      ? [...new Set(b.smsRecipients.map((p) => String(p).replace(/[^\d+]/g, '')).filter((p) => p.replace(/\D/g, '').length >= 7))].slice(0, 50) : [];
    return { title: String(b.title || '').slice(0, 200), severity, scope, channels, entityIds, smsRecipients };
  }

  // The entities a notice reaches: every client for 'global', else its targets.
  function audienceEntityIds(n) {
    if (n.scope === 'global') return db.listEntities().map((e) => e.id);
    return targetsFor(n.id);
  }
  // Channels actually used = the admin override if set, else the severity default.
  const resolveChannels = (n) => (n.channels && n.channels.length ? n.channels : (SEVERITY_CHANNELS[n.severity] || []));

  const SEV_EMOJI = { info: 'ℹ️', maintenance: '🛠️', degraded: '🟠', outage: '🔴' };
  const STATUS_LABEL = { investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', resolved: 'Resolved' };

  // ── deliver: in-app banner (always, via the /my/notices poll) + email/push (OS
  // spine, one thread per notice per entity) + SMS (direct to attached numbers) ──
  function notify(n, update) {
    if (!enabled() || !os?.announce) return;
    const channels = resolveChannels(n);
    const emailPush = channels.filter((c) => c === 'email' || c === 'push');
    // Notices mirror to a connected Slack whenever they also email/push (matches
    // the pre-channel behaviour). Inbox-only notices stay inbox-only.
    const osChannels = emailPush.length ? [...emailPush, 'slack'] : emailPush;
    const resolved = n.status === 'resolved';
    const title = `${resolved ? '✅' : (SEV_EMOJI[n.severity] || '📣')} ${resolved ? 'Resolved' : STATUS_LABEL[n.status] || ''} — ${n.title}`.slice(0, 200);
    const body = String(update?.body || '').slice(0, 8000);
    for (const entityId of audienceEntityIds(n)) {
      try {
        os.announce({
          entityId,
          title,
          body,
          priority: n.severity === 'outage' ? 'normal' : 'fyi',
          createdBy: 'status', authorType: 'system',
          channels: osChannels,                  // [] => inbox only (banner still shows)
          subjectType: 'notice', subjectId: n.id, // one thread per notice, re-raised each update
        });
      } catch (e) { console.error('[notices] announce failed', n.id, entityId, e.message); }
    }
    // SMS goes direct to the numbers an admin attached (the OS spine doesn't do SMS).
    if (channels.includes('sms') && messaging?.sendSms && (n.smsRecipients || []).length) {
      const link = mailer?.baseUrl ? mailer.baseUrl() : '';
      const text = `${title}\n${body}${link ? `\n${link}` : ''}`.slice(0, 600);
      for (const to of n.smsRecipients) messaging.sendSms({ to, text }).catch(() => {});
    }
  }

  function setTargets(id, entityIds) {
    sql.prepare('DELETE FROM notice_targets WHERE notice_id=?').run(id);
    const ins = sql.prepare('INSERT OR IGNORE INTO notice_targets (notice_id, entity_id) VALUES (?,?)');
    for (const eid of entityIds) ins.run(id, eid);
  }
  function addUpdate(id, { body, status, by }) {
    sql.prepare('INSERT INTO status_notice_updates (id, notice_id, body, status, created_by, created_at) VALUES (?,?,?,?,?,?)')
      .run(uuid(), id, String(body || '').slice(0, 8000), status, by || '', now());
  }

  // ─────────────────────────────── Admin routes ───────────────────────────────
  // Create a notice + its opening update, then fan out per the severity policy.
  app.post('/api/admin/notices', auth.requireAdmin, (req, res) => {
    if (!enabled()) return off(res);
    const c = clean(req.body || {});
    if (!c.title) return res.status(400).json({ error: 'Give the notice a title.' });
    const body = String((req.body || {}).body || '').trim();
    if (!body) return res.status(400).json({ error: 'Describe the issue.' });
    if (c.scope === 'targeted' && !c.entityIds.length) return res.status(400).json({ error: 'Pick at least one client, or make it global.' });
    const status = STATUSES.includes((req.body || {}).status) && req.body.status !== 'resolved' ? req.body.status : 'investigating';
    const id = uuid(); const ts = now();
    sql.prepare(`INSERT INTO status_notices (id, title, severity, status, scope, channels, sms_recipients, started_at, resolved_at, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,'',?,?,?)`)
      .run(id, c.title, c.severity, status, c.scope, c.channels ? JSON.stringify(c.channels) : '', JSON.stringify(c.smsRecipients), ts, req.user.email, ts, ts);
    if (c.scope === 'targeted') setTargets(id, c.entityIds);
    addUpdate(id, { body, status, by: req.user.email });
    const n = noticeById(id);
    notify(n, n.latest);
    res.status(201).json({ notice: n });
  });

  // List every notice (newest first) — the admin console table.
  app.get('/api/admin/notices', auth.requireAdmin, (_req, res) => {
    if (!enabled()) return off(res);
    const rows = sql.prepare('SELECT * FROM status_notices ORDER BY (status=\'resolved\') ASC, created_at DESC').all();
    res.json({ notices: rows.map((r) => noticeRow(r)) });
  });

  // Edit the framing (title · severity · scope · targets · channels · sms). Does NOT
  // notify — that's what posting an update is for.
  app.put('/api/admin/notices/:id', auth.requireAdmin, (req, res) => {
    if (!enabled()) return off(res);
    const existing = sql.prepare('SELECT * FROM status_notices WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Notice not found' });
    const c = clean({ ...noticeRow(existing, { withUpdates: false }), ...req.body });
    if (!c.title) return res.status(400).json({ error: 'Give the notice a title.' });
    if (c.scope === 'targeted' && !c.entityIds.length) return res.status(400).json({ error: 'Pick at least one client, or make it global.' });
    sql.prepare('UPDATE status_notices SET title=?, severity=?, scope=?, channels=?, sms_recipients=?, updated_at=? WHERE id=?')
      .run(c.title, c.severity, c.scope, c.channels ? JSON.stringify(c.channels) : '', JSON.stringify(c.smsRecipients), now(), req.params.id);
    if (c.scope === 'targeted') setTargets(req.params.id, c.entityIds); else setTargets(req.params.id, []);
    res.json({ notice: noticeById(req.params.id) });
  });

  // Post a progress update (optionally advancing the status) + re-notify.
  app.post('/api/admin/notices/:id/updates', auth.requireAdmin, (req, res) => {
    if (!enabled()) return off(res);
    const existing = sql.prepare('SELECT * FROM status_notices WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Notice not found' });
    const body = String((req.body || {}).body || '').trim();
    if (!body) return res.status(400).json({ error: 'Write the update.' });
    // An update can advance the status (e.g. investigating → monitoring). 'resolved'
    // is handled by the resolve route so the resolved_at stamp can't be missed.
    const status = STATUSES.includes((req.body || {}).status) && req.body.status !== 'resolved' ? req.body.status : existing.status;
    const ts = now();
    sql.prepare('UPDATE status_notices SET status=?, resolved_at=\'\', updated_at=? WHERE id=?').run(status, ts, req.params.id);
    addUpdate(req.params.id, { body, status, by: req.user.email });
    const n = noticeById(req.params.id);
    notify(n, n.latest);
    res.status(201).json({ notice: n });
  });

  // Mark resolved — a closing update + the resolved_at stamp, then a final "resolved"
  // broadcast. The banner drops; the feed keeps it for RESOLVED_WINDOW_MS.
  app.post('/api/admin/notices/:id/resolve', auth.requireAdmin, (req, res) => {
    if (!enabled()) return off(res);
    const existing = sql.prepare('SELECT * FROM status_notices WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Notice not found' });
    const body = String((req.body || {}).body || '').trim() || 'This issue has been resolved.';
    const ts = now();
    sql.prepare('UPDATE status_notices SET status=\'resolved\', resolved_at=?, updated_at=? WHERE id=?').run(ts, ts, req.params.id);
    addUpdate(req.params.id, { body, status: 'resolved', by: req.user.email });
    const n = noticeById(req.params.id);
    notify(n, n.latest);
    res.json({ notice: n });
  });

  app.delete('/api/admin/notices/:id', auth.requireAdmin, (req, res) => {
    if (!enabled()) return off(res);
    sql.prepare('DELETE FROM status_notice_updates WHERE notice_id=?').run(req.params.id);
    sql.prepare('DELETE FROM notice_targets WHERE notice_id=?').run(req.params.id);
    sql.prepare('DELETE FROM status_notices WHERE id=?').run(req.params.id);
    res.status(204).end();
  });

  // ─────────────────────────────── Client route ───────────────────────────────
  // Notices affecting THIS user's clients — active ones (drive the banner) plus any
  // resolved in the last 48h (kept in the feed). Force-scoped to the user's entities:
  // global notices reach everyone; targeted ones only their members. No entityId param
  // is trusted from the browser — it's derived from the authenticated user.
  app.get('/api/my/notices', auth.requireAuth, (req, res) => {
    if (!enabled()) return res.json({ notices: [] });
    const mine = isAdmin(req.user) ? null : (req.user.entityIds || []);
    if (mine !== null && !mine.length) return res.json({ notices: [] });
    const cutoff = new Date(Date.now() - RESOLVED_WINDOW_MS).toISOString();
    const rows = sql.prepare(`SELECT * FROM status_notices
      WHERE (status<>'resolved' OR resolved_at>=?) ORDER BY created_at DESC`).all(cutoff);
    const visible = rows.filter((r) => {
      if (r.scope === 'global') return true;
      if (mine === null) return true; // admin preview sees targeted too
      return targetsFor(r.id).some((eid) => mine.includes(eid));
    }).map((r) => noticeRow(r));
    res.json({ notices: visible });
  });

  // Status (client uses it to decide whether to poll the feature).
  app.get('/api/notices/status', auth.requireAuth, (_req, res) => res.json({ enabled: enabled() }));

  console.log('[notices] mounted', enabled() ? '(enabled)' : '(disabled — set notices_enabled=1)');
  return { notify };
}

module.exports = { mount };
