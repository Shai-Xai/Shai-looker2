// ─── Event Ops: live device + station logistics for an event ─────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the `eventops_devices`, `eventops_stations`,
// `eventops_device_events`, `eventops_issues` and `eventops_settings` tables and every
// /api/eventops/... route. Mounted from index.js with one line + injected deps
// ({ db, auth }). Nothing else imports it and no other module reads its tables.
//
// WHAT IT DOES (the pilot's purpose): track where every device is at an event — moved
// between the Hive (warehouse / in-stock) and Stations (bars, gates, booths…) by scanning,
// with an append-only audit trail — and let liaisons log check-points & issues on a device.
// A "Project (Event)" maps onto a Pulse SUITE (suite_id); a "Project owner" onto the
// suite's client (entity_id). No parallel auth — scope is enforced with Pulse's own
// canAccessSuite + the eventops.manage permission (roles.js).
//
// TWO TOGGLES:
//   • Per-client pilot opt-in — `eventops_settings.enabled` (DEFAULT OFF). An admin turns
//     Event Ops on for a specific client; until then it's invisible to that client (nav +
//     page hidden, routes return the disabled shape). PUT /api/eventops/entities/:id/enabled.
//   • Global kill switch — settings key `eventops_enabled` ('0' 404s the whole module).
//
// TO REMOVE THE WHOLE FEATURE (clean teardown — nothing depends on it):
//   1. delete this file + its one-line mount in server/index.js;
//   2. delete the frontend pieces: client/src/components/EventOpsConsole.jsx,
//      EventOpsScanner.jsx, client/src/pages/EventOpsPage.jsx, the /event-ops routes in
//      App.jsx, the 'eventops' tab line in AdminPage.jsx, the Event Ops nav block in
//      ClientLayout.jsx, and the eventops* helpers in client/src/lib/api.js;
//   3. drop the 5 eventops_* tables and remove EVENTOPS_MANAGE from server/roles.js.

const crypto = require('crypto');

// Device lifecycle states. The order is the "normal" forward lifecycle; the UI lets staff
// set any state ("change stages as needed"), and a transition is only FLAGGED (never blocked).
const STATES = ['in_stock', 'deployed', 'returned', 'lost', 'damaged'];
// Re-activating a device that was written off (lost/damaged) is the noteworthy case worth
// flagging in the audit trail — a "missing" unit reappearing. Normal hive↔station moves are not.
const TERMINAL = new Set(['lost', 'damaged']);
const isUnusual = (from, to) => TERMINAL.has(from) && !TERMINAL.has(to);

const STATION_KINDS = ['bar', 'gate', 'booth', 'topup', 'vendor', 'other'];
const DEVICE_TYPES = ['handheld', 'kiosk', 'radio', 'printer', 'tablet', 'other'];
// Suggested issue categories (free-text is allowed too — the UI offers these as quick picks).
const ISSUE_CATEGORIES = ['damaged', 'battery', 'connectivity', 'missing_parts', 'frozen', 'wrong_config', 'other'];

function mount(app, { db, auth }) {
  const sql = db.db;
  const now = () => new Date().toISOString();
  const uuid = () => crypto.randomUUID();
  const isAdmin = (u) => !!u && u.role === 'admin';
  const enabled = () => db.getSetting('eventops_enabled', '1') !== '0'; // global kill switch
  const off = (res) => res.status(404).json({ error: 'Event Ops is disabled' });

  sql.exec(`
    CREATE TABLE IF NOT EXISTS eventops_devices (
      id            TEXT PRIMARY KEY,
      entity_id     TEXT NOT NULL,
      suite_id      TEXT NOT NULL,
      label         TEXT NOT NULL DEFAULT '',
      type          TEXT NOT NULL DEFAULT 'handheld',
      qr_code       TEXT NOT NULL DEFAULT '',
      serial_number TEXT NOT NULL DEFAULT '',
      state         TEXT NOT NULL DEFAULT 'in_stock',
      station_id    TEXT NOT NULL DEFAULT '',
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eventops_devices_suite ON eventops_devices(suite_id);
    CREATE INDEX IF NOT EXISTS idx_eventops_devices_station ON eventops_devices(station_id);

    CREATE TABLE IF NOT EXISTS eventops_stations (
      id          TEXT PRIMARY KEY,
      entity_id   TEXT NOT NULL,
      suite_id    TEXT NOT NULL,
      name        TEXT NOT NULL DEFAULT '',
      kind        TEXT NOT NULL DEFAULT 'other',
      x           REAL NOT NULL DEFAULT 0,
      y           REAL NOT NULL DEFAULT 0,
      position    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eventops_stations_suite ON eventops_stations(suite_id);

    -- Append-only audit log. Never UPDATE/DELETE a row here (except device cascade-delete).
    CREATE TABLE IF NOT EXISTS eventops_device_events (
      id              TEXT PRIMARY KEY,
      device_id       TEXT NOT NULL,
      entity_id       TEXT NOT NULL,
      suite_id        TEXT NOT NULL,
      kind            TEXT NOT NULL DEFAULT 'move',   -- create | move | status | check | delete
      from_state      TEXT NOT NULL DEFAULT '',
      to_state        TEXT NOT NULL DEFAULT '',
      from_station_id TEXT NOT NULL DEFAULT '',
      to_station_id   TEXT NOT NULL DEFAULT '',
      actor           TEXT NOT NULL DEFAULT '',
      note            TEXT NOT NULL DEFAULT '',
      unusual         INTEGER NOT NULL DEFAULT 0,
      at              TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eventops_events_device ON eventops_device_events(device_id, at);
    CREATE INDEX IF NOT EXISTS idx_eventops_events_suite ON eventops_device_events(suite_id, at);

    CREATE TABLE IF NOT EXISTS eventops_issues (
      id           TEXT PRIMARY KEY,
      device_id    TEXT NOT NULL,
      entity_id    TEXT NOT NULL,
      suite_id     TEXT NOT NULL,
      category     TEXT NOT NULL DEFAULT 'other',
      note         TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'open',      -- open | resolved
      resolution   TEXT NOT NULL DEFAULT '',
      reported_by  TEXT NOT NULL DEFAULT '',
      reported_at  TEXT NOT NULL,
      resolved_by  TEXT NOT NULL DEFAULT '',
      resolved_at  TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_eventops_issues_suite ON eventops_issues(suite_id, status);
    CREATE INDEX IF NOT EXISTS idx_eventops_issues_device ON eventops_issues(device_id);

    -- The per-client pilot toggle (default OFF — a row exists only once an admin touches it).
    CREATE TABLE IF NOT EXISTS eventops_settings (
      entity_id   TEXT PRIMARY KEY,
      enabled     INTEGER NOT NULL DEFAULT 0,
      updated_at  TEXT NOT NULL
    );

    -- Staff working the event. 'number' is a badge/staff ID you assign; station_id is an
    -- optional posting. When scanning, you can tag a move/issue with who did it.
    CREATE TABLE IF NOT EXISTS eventops_staff (
      id          TEXT PRIMARY KEY,
      entity_id   TEXT NOT NULL,
      suite_id    TEXT NOT NULL,
      name        TEXT NOT NULL DEFAULT '',
      number      TEXT NOT NULL DEFAULT '',
      role        TEXT NOT NULL DEFAULT '',
      station_id  TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eventops_staff_suite ON eventops_staff(suite_id);

    -- Per-event kiosk token: gates the PUBLIC staff portal URL (no Pulse account needed).
    -- Rotating the token instantly revokes every shared link. enabled=0 closes the portal.
    CREATE TABLE IF NOT EXISTS eventops_kiosk (
      suite_id    TEXT PRIMARY KEY,
      token       TEXT NOT NULL DEFAULT '',
      enabled     INTEGER NOT NULL DEFAULT 1,
      updated_at  TEXT NOT NULL
    );

    -- Checkpoint DEFINITIONS (named checks set up in advance, e.g. "Opening", "Closing").
    CREATE TABLE IF NOT EXISTS eventops_checkpoints (
      id          TEXT PRIMARY KEY,
      entity_id   TEXT NOT NULL,
      suite_id    TEXT NOT NULL,
      name        TEXT NOT NULL DEFAULT '',
      position    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eventops_checkpoints_suite ON eventops_checkpoints(suite_id);

    -- Checkpoint SUBMISSIONS — a staff member completing a check at a station (with a photo).
    CREATE TABLE IF NOT EXISTS eventops_checkpoint_logs (
      id              TEXT PRIMARY KEY,
      entity_id       TEXT NOT NULL,
      suite_id        TEXT NOT NULL,
      station_id      TEXT NOT NULL DEFAULT '',
      station_label   TEXT NOT NULL DEFAULT '',
      checkpoint_id   TEXT NOT NULL DEFAULT '',
      checkpoint_name TEXT NOT NULL DEFAULT '',
      staff_id        TEXT NOT NULL DEFAULT '',
      staff_label     TEXT NOT NULL DEFAULT '',
      comment         TEXT NOT NULL DEFAULT '',
      photo           TEXT NOT NULL DEFAULT '',
      at              TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eventops_cplogs_suite ON eventops_checkpoint_logs(suite_id, at);
  `);

  // Additive migrations for already-deployed DBs: attribute moves/issues to a staff member.
  // staff_label is denormalised (e.g. "#101 Jane") so history survives a staff delete.
  for (const [t, col] of [
    ['eventops_device_events', 'staff_id'], ['eventops_device_events', 'staff_label'],
    ['eventops_issues', 'staff_id'], ['eventops_issues', 'staff_label'],
    // Where the device was when the issue was raised (denormalised so it survives a station delete).
    ['eventops_issues', 'station_id'], ['eventops_issues', 'station_label'],
  ]) { try { sql.exec(`ALTER TABLE ${t} ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`); } catch { /* already there */ } }
  // Staff can be posted to MULTIPLE stations — JSON array. (station_id stays as the legacy
  // single, kept in sync to the first for back-compat; station_ids is authoritative.)
  try { sql.exec("ALTER TABLE eventops_staff ADD COLUMN station_ids TEXT NOT NULL DEFAULT '[]'"); } catch { /* already there */ }
  // Map markers can be resized + rotated (scale 1 = default, rotation in degrees).
  try { sql.exec('ALTER TABLE eventops_stations ADD COLUMN scale REAL NOT NULL DEFAULT 1'); } catch { /* already there */ }
  try { sql.exec('ALTER TABLE eventops_stations ADD COLUMN rotation REAL NOT NULL DEFAULT 0'); } catch { /* already there */ }

  // ── per-client toggle ──────────────────────────────────────────────────────────
  const entityEnabled = (entityId) => {
    const r = sql.prepare('SELECT enabled FROM eventops_settings WHERE entity_id=?').get(entityId);
    return !!(r && r.enabled);
  };
  const setEntityEnabled = (entityId, on) => {
    sql.prepare(`INSERT INTO eventops_settings (entity_id, enabled, updated_at) VALUES (?,?,?)
      ON CONFLICT(entity_id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at`)
      .run(entityId, on ? 1 : 0, now());
  };
  // The entities this user may see Event Ops for AND that are switched on (gates the nav/page).
  const enabledEntitiesFor = (user) => {
    const ids = isAdmin(user)
      ? db.listEntities().map((e) => e.id)
      : (user.entityIds || []);
    return ids.filter((eid) => entityEnabled(eid));
  };

  // ── access guards (admin OR a suite member with eventops.manage) ─────────────────
  const canView = (user, suiteId) => isAdmin(user) || auth.canAccessSuite(user, suiteId);
  const canManage = (user, suiteId) => {
    if (isAdmin(user)) return true;
    const su = db.getSuite(suiteId);
    return !!su && auth.canAccessSuite(user, suiteId) && auth.hasPermission(user, su.entityId, 'eventops.manage');
  };
  // Resolve the suite, enforce it exists + is enabled for its client + the user may view it.
  // Returns the suite on success, or null after sending the right error response.
  function gateSuite(req, res, { manage = false } = {}) {
    if (!enabled()) { off(res); return null; }
    const su = db.getSuite(req.params.suiteId);
    if (!su) { res.status(404).json({ error: 'Event not found' }); return null; }
    if (!entityEnabled(su.entityId)) { off(res); return null; }
    if (manage ? !canManage(req.user, su.id) : !canView(req.user, su.id)) {
      res.status(403).json({ error: 'Not allowed' }); return null;
    }
    return su;
  }

  // ── shapers ──────────────────────────────────────────────────────────────────
  const stationName = (id) => (id ? (sql.prepare('SELECT name FROM eventops_stations WHERE id=?').get(id) || {}).name || '' : '');
  const deviceRow = (d) => d && ({
    id: d.id, entityId: d.entity_id, suiteId: d.suite_id, label: d.label, type: d.type,
    qrCode: d.qr_code, serialNumber: d.serial_number, state: d.state,
    stationId: d.station_id || null, stationName: stationName(d.station_id),
    location: d.station_id ? stationName(d.station_id) : 'Hive',
    createdAt: d.created_at, updatedAt: d.updated_at,
  });
  const stationRow = (s) => s && ({
    id: s.id, entityId: s.entity_id, suiteId: s.suite_id, name: s.name, kind: s.kind,
    x: s.x, y: s.y, scale: s.scale == null ? 1 : s.scale, rotation: s.rotation || 0, position: s.position, createdAt: s.created_at,
    deviceCount: sql.prepare("SELECT COUNT(*) c FROM eventops_devices WHERE station_id=? AND state='deployed'").get(s.id).c,
    openIssues: sql.prepare(`SELECT COUNT(*) c FROM eventops_issues i JOIN eventops_devices d ON d.id=i.device_id
      WHERE i.status='open' AND d.station_id=?`).get(s.id).c,
  });
  const eventRow = (e) => ({
    id: e.id, deviceId: e.device_id, kind: e.kind, fromState: e.from_state, toState: e.to_state,
    fromStation: stationName(e.from_station_id), toStation: stationName(e.to_station_id),
    actor: e.actor, staffLabel: e.staff_label || '', note: e.note, unusual: !!e.unusual, at: e.at,
  });
  const issueRow = (i) => ({
    id: i.id, deviceId: i.device_id, category: i.category, note: i.note, status: i.status,
    resolution: i.resolution, reportedBy: i.reported_by, reportedAt: i.reported_at,
    resolvedBy: i.resolved_by, resolvedAt: i.resolved_at, staffLabel: i.staff_label || '',
    stationId: i.station_id || null, stationLabel: i.station_label || (i.station_id ? stationName(i.station_id) : ''),
  });
  const parseIds = (json, fallback) => { try { const a = JSON.parse(json || '[]'); return Array.isArray(a) && a.length ? a : fallback; } catch { return fallback; } };
  const staffRow = (s) => {
    if (!s) return s;
    const ids = parseIds(s.station_ids, s.station_id ? [s.station_id] : []); // back-compat with legacy single
    const stations = ids.map((id) => ({ id, name: stationName(id) })).filter((x) => x.name);
    return {
      id: s.id, entityId: s.entity_id, suiteId: s.suite_id, name: s.name, number: s.number, role: s.role,
      stationIds: stations.map((x) => x.id), stations,
      stationId: stations[0]?.id || null, stationName: stations[0]?.name || '', // legacy single fields
      createdAt: s.created_at,
    };
  };
  const getDevice = (id) => sql.prepare('SELECT * FROM eventops_devices WHERE id=?').get(id);
  // Resolve a staffId (within the suite) → { id, label } for attribution. Label is denormalised
  // onto the event/issue so the trail survives a later staff delete. Returns null if not found.
  function resolveStaff(suiteId, staffId) {
    if (!staffId) return null;
    const s = sql.prepare('SELECT * FROM eventops_staff WHERE id=? AND suite_id=?').get(staffId, suiteId);
    if (!s) return null;
    const label = [s.number ? `#${s.number}` : '', s.name].filter(Boolean).join(' ').trim() || s.number || s.name;
    return { id: s.id, label };
  }

  function logEvent(d, { kind, toState, toStation, note, actor, unusual, staff }) {
    sql.prepare(`INSERT INTO eventops_device_events
      (id, device_id, entity_id, suite_id, kind, from_state, to_state, from_station_id, to_station_id, actor, note, unusual, at, staff_id, staff_label)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(uuid(), d.id, d.entity_id, d.suite_id, kind, d.state, toState ?? d.state,
        d.station_id || '', toStation ?? (d.station_id || ''), actor || '', String(note || '').slice(0, 2000),
        unusual ? 1 : 0, now(), staff?.id || '', staff?.label || '');
  }
  const str = (v, max = 200) => String(v == null ? '' : v).slice(0, max);

  // ── shared engine (used by BOTH the authed console routes and the public staff portal,
  //    so the two surfaces can never drift apart) ──────────────────────────────────────
  // Resolve a scanned/typed code → device (prefer QR/serial, fall back to label; case-insensitive).
  const findDeviceByCode = (suiteId, code) =>
    sql.prepare('SELECT * FROM eventops_devices WHERE suite_id=? AND (qr_code=? COLLATE NOCASE OR serial_number=? COLLATE NOCASE)').get(suiteId, code, code)
    || sql.prepare('SELECT * FROM eventops_devices WHERE suite_id=? AND label=? COLLATE NOCASE').get(suiteId, code);

  // Apply a move/status change + write the audit row. Returns { device, unusual } or { error }.
  function applyMove(su, d, { stationId, state, staffId, actor, note }) {
    let toState; let toStation = '';
    if (state && STATES.includes(state)) {
      toState = state;
      toStation = state === 'deployed' ? str(stationId, 60) : '';
    } else {
      const raw = stationId == null ? '' : String(stationId);
      if (raw === '' || raw === 'hive') { toState = 'in_stock'; toStation = ''; }
      else {
        const st = sql.prepare('SELECT id FROM eventops_stations WHERE id=? AND suite_id=?').get(raw, su.id);
        if (!st) return { error: 'Unknown station.' };
        toState = 'deployed'; toStation = st.id;
      }
    }
    const unusual = isUnusual(d.state, toState);
    logEvent(d, { kind: state ? 'status' : 'move', toState, toStation, actor, note, unusual, staff: resolveStaff(su.id, staffId) });
    sql.prepare('UPDATE eventops_devices SET state=?, station_id=?, updated_at=? WHERE id=?').run(toState, toStation, now(), d.id);
    return { device: deviceRow(getDevice(d.id)), unusual };
  }

  // Log an issue / liaison check + its audit row. Returns the issue row.
  function applyIssue(su, d, { category, note, resolution, resolved, staffId, actor }) {
    const cat = ISSUE_CATEGORIES.includes(category) ? category : (str(category, 40).trim() || 'other');
    const n = str(note, 2000).trim();
    const res = str(resolution, 2000).trim();
    const resolvedNow = !!resolved || !!res;
    const staff = resolveStaff(su.id, staffId);
    // Where the device is right now — captured onto the issue so you can see where it happened.
    const stationLabel = d.station_id ? stationName(d.station_id) : 'Hive';
    const id = uuid(); const ts = now();
    sql.prepare(`INSERT INTO eventops_issues
      (id, device_id, entity_id, suite_id, category, note, status, resolution, reported_by, reported_at, resolved_by, resolved_at, staff_id, staff_label, station_id, station_label)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, d.id, su.entityId, su.id, cat, n, resolvedNow ? 'resolved' : 'open', res,
        actor, ts, resolvedNow ? actor : '', resolvedNow ? ts : '', staff?.id || '', staff?.label || '', d.station_id || '', stationLabel);
    logEvent(d, { kind: 'check', actor, note: `Issue: ${cat}${n ? ' — ' + n : ''}`, staff });
    return issueRow(sql.prepare('SELECT * FROM eventops_issues WHERE id=?').get(id));
  }

  // ════════════════════════════ per-client toggle routes ═══════════════════════════
  // Which of MY entities have Event Ops switched on — the client shell calls this to decide
  // whether to show the nav item / page at all. Admins get every enabled entity.
  app.get('/api/eventops/enabled', auth.requireAuth, (req, res) => {
    if (!enabled()) return res.json({ entities: [] });
    res.json({ entities: enabledEntitiesFor(req.user) });
  });

  // Admin-only: flip the pilot on/off for one client.
  app.put('/api/eventops/entities/:entityId/enabled', auth.requireAdmin, (req, res) => {
    if (!enabled()) return off(res);
    const e = db.getEntity(req.params.entityId);
    if (!e) return res.status(404).json({ error: 'Client not found' });
    setEntityEnabled(e.id, !!(req.body || {}).enabled);
    res.json({ entityId: e.id, enabled: entityEnabled(e.id) });
  });

  // Admin reads the current toggle state for the admin tab.
  app.get('/api/eventops/entities/:entityId/enabled', auth.requireAdmin, (req, res) => {
    if (!enabled()) return off(res);
    res.json({ entityId: req.params.entityId, enabled: entityEnabled(req.params.entityId) });
  });

  // The events (suites) for a client that Event Ops can run on — the console's event picker.
  // Admin: any entity. Client: only their own. Requires the client to be enabled.
  app.get('/api/eventops/entities/:entityId/suites', auth.requireAuth, (req, res) => {
    if (!enabled()) return off(res);
    const entityId = req.params.entityId;
    if (!isAdmin(req.user) && !(req.user.entityIds || []).includes(entityId)) return res.status(403).json({ error: 'Not allowed' });
    if (!entityEnabled(entityId)) return off(res);
    const suites = db.listSuitesForEntity(entityId).map((s) => ({ id: s.id, name: s.name }));
    res.json({ suites, canManage: isAdmin(req.user) || auth.hasPermission(req.user, entityId, 'eventops.manage') });
  });

  // ════════════════════════════ overview ═══════════════════════════════════════════
  app.get('/api/eventops/suites/:suiteId/overview', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res); if (!su) return;
    const devices = sql.prepare('SELECT * FROM eventops_devices WHERE suite_id=?').all(su.id);
    const byState = Object.fromEntries(STATES.map((s) => [s, 0]));
    for (const d of devices) byState[d.state] = (byState[d.state] || 0) + 1;
    const stations = sql.prepare('SELECT * FROM eventops_stations WHERE suite_id=? ORDER BY position, name').all(su.id).map(stationRow);
    const openIssues = sql.prepare("SELECT COUNT(*) c FROM eventops_issues WHERE suite_id=? AND status='open'").get(su.id).c;
    const recent = sql.prepare('SELECT * FROM eventops_device_events WHERE suite_id=? ORDER BY at DESC LIMIT 25').all(su.id).map(eventRow);
    res.json({
      suite: { id: su.id, name: su.name },
      totals: { devices: devices.length, atHive: byState.in_stock + byState.returned, deployed: byState.deployed, openIssues },
      byState, stations, recent,
      canManage: canManage(req.user, su.id),
    });
  });

  // Full activity log — the feed + a date-range report. Optional ?from & ?to (ISO or date).
  app.get('/api/eventops/suites/:suiteId/activity', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res); if (!su) return;
    const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const from = req.query.from ? String(req.query.from) : '';
    const to = req.query.to ? String(req.query.to) : '';
    let q = 'SELECT * FROM eventops_device_events WHERE suite_id=?'; const args = [su.id];
    if (from) { q += ' AND at>=?'; args.push(from); }
    if (to) { q += ' AND at<=?'; args.push(to.length <= 10 ? to + 'T23:59:59.999Z' : to); }
    q += ' ORDER BY at DESC LIMIT ?'; args.push(limit);
    const rows = sql.prepare(q).all(...args).map((e) => ({ ...eventRow(e), device: deviceRow(getDevice(e.device_id)) }));
    const summary = { total: rows.length, create: 0, move: 0, status: 0, check: 0 };
    for (const r of rows) summary[r.kind] = (summary[r.kind] || 0) + 1;
    res.json({ activity: rows, summary });
  });

  // ════════════════════════════ devices ════════════════════════════════════════════
  app.get('/api/eventops/suites/:suiteId/devices', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res); if (!su) return;
    const rows = sql.prepare('SELECT * FROM eventops_devices WHERE suite_id=? ORDER BY created_at DESC').all(su.id);
    res.json({ devices: rows.map(deviceRow), canManage: canManage(req.user, su.id) });
  });

  function cleanDevice(b) {
    return {
      label: str(b.label, 120),
      type: DEVICE_TYPES.includes(b.type) ? b.type : 'handheld',
      qrCode: str(b.qrCode, 120).trim(),
      serialNumber: str(b.serialNumber, 120).trim(),
    };
  }
  function insertDevice(su, c, actor) {
    const id = uuid(); const ts = now();
    sql.prepare(`INSERT INTO eventops_devices
      (id, entity_id, suite_id, label, type, qr_code, serial_number, state, station_id, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?, 'in_stock', '', ?, ?)`)
      .run(id, su.entityId, su.id, c.label, c.type, c.qrCode, c.serialNumber, ts, ts);
    logEvent(getDevice(id), { kind: 'create', toState: 'in_stock', actor, note: 'Added to inventory' });
    return getDevice(id);
  }

  app.post('/api/eventops/suites/:suiteId/devices', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const c = cleanDevice(req.body || {});
    if (!c.label && !c.qrCode && !c.serialNumber) return res.status(400).json({ error: 'Give the device a label, QR code or serial.' });
    res.status(201).json({ device: deviceRow(insertDevice(su, c, req.user.email)) });
  });

  // Bulk create: a list of devices, or a count + prefix to auto-number (e.g. SL001..SL050).
  app.post('/api/eventops/suites/:suiteId/devices/bulk', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const b = req.body || {};
    let items = [];
    if (Array.isArray(b.devices)) {
      items = b.devices.slice(0, 500).map(cleanDevice);
    } else {
      const count = Math.max(0, Math.min(500, parseInt(b.count, 10) || 0));
      const prefix = str(b.prefix, 40).trim();
      const start = Math.max(0, parseInt(b.start, 10) || 1);
      const pad = Math.max(0, Math.min(8, parseInt(b.pad, 10) || 3));
      const type = DEVICE_TYPES.includes(b.type) ? b.type : 'handheld';
      for (let i = 0; i < count; i++) {
        const code = `${prefix}${String(start + i).padStart(pad, '0')}`;
        items.push({ label: code, type, qrCode: code, serialNumber: '' });
      }
    }
    items = items.filter((c) => c.label || c.qrCode || c.serialNumber);
    if (!items.length) return res.status(400).json({ error: 'Nothing to create — give a list, or a count + prefix.' });
    const made = sql.transaction(() => items.map((c) => insertDevice(su, c, req.user.email)))();
    res.status(201).json({ created: made.length, devices: made.map(deviceRow) });
  });

  app.put('/api/eventops/suites/:suiteId/devices/:id', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const d = getDevice(req.params.id);
    if (!d || d.suite_id !== su.id) return res.status(404).json({ error: 'Device not found' });
    const c = cleanDevice({ label: req.body?.label ?? d.label, type: req.body?.type ?? d.type, qrCode: req.body?.qrCode ?? d.qr_code, serialNumber: req.body?.serialNumber ?? d.serial_number });
    sql.prepare('UPDATE eventops_devices SET label=?, type=?, qr_code=?, serial_number=?, updated_at=? WHERE id=?')
      .run(c.label, c.type, c.qrCode, c.serialNumber, now(), d.id);
    res.json({ device: deviceRow(getDevice(d.id)) });
  });

  app.delete('/api/eventops/suites/:suiteId/devices/:id', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const d = getDevice(req.params.id);
    if (!d || d.suite_id !== su.id) return res.status(404).json({ error: 'Device not found' });
    sql.transaction(() => {
      sql.prepare('DELETE FROM eventops_device_events WHERE device_id=?').run(d.id);
      sql.prepare('DELETE FROM eventops_issues WHERE device_id=?').run(d.id);
      sql.prepare('DELETE FROM eventops_devices WHERE id=?').run(d.id);
    })();
    res.status(204).end();
  });

  // Device detail: current state + full event history + its issues.
  app.get('/api/eventops/suites/:suiteId/devices/:id', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res); if (!su) return;
    const d = getDevice(req.params.id);
    if (!d || d.suite_id !== su.id) return res.status(404).json({ error: 'Device not found' });
    const events = sql.prepare('SELECT * FROM eventops_device_events WHERE device_id=? ORDER BY at DESC').all(d.id).map(eventRow);
    const issues = sql.prepare('SELECT * FROM eventops_issues WHERE device_id=? ORDER BY reported_at DESC').all(d.id).map(issueRow);
    res.json({ device: deviceRow(d), events, issues, canManage: canManage(req.user, su.id) });
  });

  // ════════════════════════════ stations ═══════════════════════════════════════════
  app.get('/api/eventops/suites/:suiteId/stations', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res); if (!su) return;
    const rows = sql.prepare('SELECT * FROM eventops_stations WHERE suite_id=? ORDER BY position, name').all(su.id);
    res.json({ stations: rows.map(stationRow), canManage: canManage(req.user, su.id) });
  });

  app.post('/api/eventops/suites/:suiteId/stations', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const name = str(req.body?.name, 80).trim();
    if (!name) return res.status(400).json({ error: 'Give the station a name.' });
    const kind = STATION_KINDS.includes(req.body?.kind) ? req.body.kind : 'other';
    const max = sql.prepare('SELECT MAX(position) m FROM eventops_stations WHERE suite_id=?').get(su.id).m || 0;
    const id = uuid();
    sql.prepare('INSERT INTO eventops_stations (id, entity_id, suite_id, name, kind, x, y, position, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, su.entityId, su.id, name, kind, Number(req.body?.x) || 0, Number(req.body?.y) || 0, max + 1, now());
    res.status(201).json({ station: stationRow(sql.prepare('SELECT * FROM eventops_stations WHERE id=?').get(id)) });
  });

  app.put('/api/eventops/suites/:suiteId/stations/:id', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const s = sql.prepare('SELECT * FROM eventops_stations WHERE id=?').get(req.params.id);
    if (!s || s.suite_id !== su.id) return res.status(404).json({ error: 'Station not found' });
    const name = str(req.body?.name ?? s.name, 80).trim() || s.name;
    const kind = STATION_KINDS.includes(req.body?.kind) ? req.body.kind : s.kind;
    const x = req.body?.x != null ? Number(req.body.x) || 0 : s.x;
    const y = req.body?.y != null ? Number(req.body.y) || 0 : s.y;
    const clamp = (v, lo, hi, dflt) => (v == null ? dflt : Math.min(hi, Math.max(lo, Number(v) || dflt)));
    const scale = clamp(req.body?.scale, 0.4, 3, s.scale == null ? 1 : s.scale);
    const rotation = req.body?.rotation == null ? (s.rotation || 0) : (((Number(req.body.rotation) || 0) % 360) + 360) % 360;
    sql.prepare('UPDATE eventops_stations SET name=?, kind=?, x=?, y=?, scale=?, rotation=? WHERE id=?').run(name, kind, x, y, scale, rotation, s.id);
    res.json({ station: stationRow(sql.prepare('SELECT * FROM eventops_stations WHERE id=?').get(s.id)) });
  });

  // Delete a station — any devices currently there fall back to the Hive (in_stock), logged.
  app.delete('/api/eventops/suites/:suiteId/stations/:id', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const s = sql.prepare('SELECT * FROM eventops_stations WHERE id=?').get(req.params.id);
    if (!s || s.suite_id !== su.id) return res.status(404).json({ error: 'Station not found' });
    sql.transaction(() => {
      const here = sql.prepare('SELECT * FROM eventops_devices WHERE station_id=?').all(s.id);
      for (const d of here) {
        logEvent(d, { kind: 'move', toState: 'in_stock', toStation: '', actor: req.user.email, note: `Station "${s.name}" removed` });
        sql.prepare("UPDATE eventops_devices SET state='in_stock', station_id='', updated_at=? WHERE id=?").run(now(), d.id);
      }
      sql.prepare('DELETE FROM eventops_stations WHERE id=?').run(s.id);
    })();
    res.status(204).end();
  });

  // ════════════════════════════ scan + move ════════════════════════════════════════
  // Resolve a scanned/typed code → the device (by qr_code OR serial_number) + its current
  // location and a little history. The scanner page calls this first to confirm the unit.
  app.post('/api/eventops/suites/:suiteId/scan', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res); if (!su) return;
    const code = str(req.body?.code, 120).trim();
    if (!code) return res.status(400).json({ error: 'No code scanned.' });
    const d = findDeviceByCode(su.id, code);
    if (!d) return res.status(404).json({ error: `No device matches “${code}” at this event.`, code });
    const events = sql.prepare('SELECT * FROM eventops_device_events WHERE device_id=? ORDER BY at DESC LIMIT 8').all(d.id).map(eventRow);
    const openIssues = sql.prepare("SELECT COUNT(*) c FROM eventops_issues WHERE device_id=? AND status='open'").get(d.id).c;
    res.json({ device: deviceRow(d), events, openIssues, canManage: canManage(req.user, su.id) });
  });

  // Apply a move/status change to a device + write the append-only audit row.
  // Body: { deviceId, stationId? , state? , note? }
  //   • stationId set (and no terminal state)  → deploy to that station.
  //   • stationId '' / 'hive' / null           → return to the Hive (in_stock).
  //   • state set (lost/damaged/returned/…)     → set that lifecycle state (clears station).
  app.post('/api/eventops/suites/:suiteId/move', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const b = req.body || {};
    const d = getDevice(b.deviceId);
    if (!d || d.suite_id !== su.id) return res.status(404).json({ error: 'Device not found' });
    const out = applyMove(su, d, { stationId: b.stationId, state: b.state, staffId: b.staffId, actor: req.user.email, note: b.note });
    if (out.error) return res.status(400).json({ error: out.error });
    res.json(out);
  });

  // ════════════════════════════ issues (liaison checks) ════════════════════════════
  app.get('/api/eventops/suites/:suiteId/issues', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res); if (!su) return;
    const status = req.query.status === 'resolved' ? 'resolved' : req.query.status === 'all' ? null : 'open';
    const rows = status
      ? sql.prepare('SELECT * FROM eventops_issues WHERE suite_id=? AND status=? ORDER BY reported_at DESC').all(su.id, status)
      : sql.prepare('SELECT * FROM eventops_issues WHERE suite_id=? ORDER BY reported_at DESC').all(su.id);
    // Decorate with the device label for the list view.
    const out = rows.map((i) => ({ ...issueRow(i), device: deviceRow(getDevice(i.device_id)) }));
    res.json({ issues: out, canManage: canManage(req.user, su.id) });
  });

  // Log an issue / liaison check-point on a device.
  app.post('/api/eventops/suites/:suiteId/issues', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const b = req.body || {};
    const d = getDevice(b.deviceId);
    if (!d || d.suite_id !== su.id) return res.status(404).json({ error: 'Device not found' });
    res.status(201).json({ issue: applyIssue(su, d, { category: b.category, note: b.note, resolution: b.resolution, resolved: b.resolved, staffId: b.staffId, actor: req.user.email }) });
  });

  // Resolve (or reopen) an issue.
  app.patch('/api/eventops/suites/:suiteId/issues/:id', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const i = sql.prepare('SELECT * FROM eventops_issues WHERE id=?').get(req.params.id);
    if (!i || i.suite_id !== su.id) return res.status(404).json({ error: 'Issue not found' });
    const reopen = (req.body || {}).status === 'open';
    if (reopen) {
      sql.prepare("UPDATE eventops_issues SET status='open', resolved_by='', resolved_at='' WHERE id=?").run(i.id);
    } else {
      const resolution = str(req.body?.resolution ?? i.resolution, 2000).trim();
      sql.prepare("UPDATE eventops_issues SET status='resolved', resolution=?, resolved_by=?, resolved_at=? WHERE id=?")
        .run(resolution, req.user.email, now(), i.id);
    }
    res.json({ issue: issueRow(sql.prepare('SELECT * FROM eventops_issues WHERE id=?').get(i.id)) });
  });

  // ════════════════════════════ staff ══════════════════════════════════════════════
  app.get('/api/eventops/suites/:suiteId/staff', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res); if (!su) return;
    const rows = sql.prepare('SELECT * FROM eventops_staff WHERE suite_id=? ORDER BY number, name').all(su.id);
    res.json({ staff: rows.map(staffRow), canManage: canManage(req.user, su.id) });
  });

  function cleanStaff(b, su) {
    // Accept stationIds[] (preferred) or a single stationId (legacy); keep only stations in this suite.
    const raw = Array.isArray(b.stationIds) ? b.stationIds : (b.stationId ? [b.stationId] : []);
    const valid = sql.prepare('SELECT id FROM eventops_stations WHERE suite_id=?').all(su.id).map((r) => r.id);
    const stationIds = [...new Set(raw.map(String).filter((id) => valid.includes(id)))];
    return { name: str(b.name, 120).trim(), number: str(b.number, 40).trim(), role: str(b.role, 60).trim(), stationIds };
  }

  app.post('/api/eventops/suites/:suiteId/staff', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const c = cleanStaff(req.body || {}, su);
    if (!c.name && !c.number) return res.status(400).json({ error: 'Give the staff member a name or number.' });
    const id = uuid();
    sql.prepare('INSERT INTO eventops_staff (id, entity_id, suite_id, name, number, role, station_id, station_ids, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, su.entityId, su.id, c.name, c.number, c.role, c.stationIds[0] || '', JSON.stringify(c.stationIds), now());
    res.status(201).json({ staff: staffRow(sql.prepare('SELECT * FROM eventops_staff WHERE id=?').get(id)) });
  });

  app.put('/api/eventops/suites/:suiteId/staff/:id', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const s = sql.prepare('SELECT * FROM eventops_staff WHERE id=?').get(req.params.id);
    if (!s || s.suite_id !== su.id) return res.status(404).json({ error: 'Staff member not found' });
    const cur = staffRow(s);
    const c = cleanStaff({ name: req.body?.name ?? s.name, number: req.body?.number ?? s.number, role: req.body?.role ?? s.role, stationIds: req.body?.stationIds ?? cur.stationIds }, su);
    sql.prepare('UPDATE eventops_staff SET name=?, number=?, role=?, station_id=?, station_ids=? WHERE id=?')
      .run(c.name, c.number, c.role, c.stationIds[0] || '', JSON.stringify(c.stationIds), s.id);
    res.json({ staff: staffRow(sql.prepare('SELECT * FROM eventops_staff WHERE id=?').get(s.id)) });
  });

  app.delete('/api/eventops/suites/:suiteId/staff/:id', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const s = sql.prepare('SELECT * FROM eventops_staff WHERE id=?').get(req.params.id);
    if (!s || s.suite_id !== su.id) return res.status(404).json({ error: 'Staff member not found' });
    sql.prepare('DELETE FROM eventops_staff WHERE id=?').run(s.id); // history keeps the denormalised label
    res.status(204).end();
  });

  // ════════════════════════════ kiosk token (authed: manage the portal link) ════════
  const newToken = () => crypto.randomBytes(12).toString('hex');
  function kioskFor(suiteId, { create = false } = {}) {
    let k = sql.prepare('SELECT * FROM eventops_kiosk WHERE suite_id=?').get(suiteId);
    if (!k && create) {
      sql.prepare('INSERT INTO eventops_kiosk (suite_id, token, enabled, updated_at) VALUES (?,?,1,?)').run(suiteId, newToken(), now());
      k = sql.prepare('SELECT * FROM eventops_kiosk WHERE suite_id=?').get(suiteId);
    }
    return k;
  }
  const kioskView = (suiteId, k) => ({ token: k.token, enabled: !!k.enabled, path: `/eventops/portal/${suiteId}/${k.token}` });

  app.get('/api/eventops/suites/:suiteId/kiosk', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    res.json(kioskView(su.id, kioskFor(su.id, { create: true })));
  });
  app.post('/api/eventops/suites/:suiteId/kiosk/rotate', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    sql.prepare('INSERT INTO eventops_kiosk (suite_id, token, enabled, updated_at) VALUES (?,?,1,?) ON CONFLICT(suite_id) DO UPDATE SET token=excluded.token, updated_at=excluded.updated_at')
      .run(su.id, newToken(), now());
    res.json(kioskView(su.id, kioskFor(su.id)));
  });
  app.put('/api/eventops/suites/:suiteId/kiosk', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const k = kioskFor(su.id, { create: true });
    sql.prepare('UPDATE eventops_kiosk SET enabled=?, updated_at=? WHERE suite_id=?').run((req.body || {}).enabled ? 1 : 0, now(), su.id);
    res.json(kioskView(su.id, kioskFor(su.id) || k));
  });

  // ════════════════════════════ PUBLIC staff portal (token-gated, NO Pulse login) ═══
  // Staff have no accounts — the unguessable per-event token gates the whole portal, then
  // they identify by their staff number. Kiosk-grade: anyone with the link can operate, so
  // rotating the token is the revoke. Every action is attributed to the chosen staff member.
  function portalSuite(req, res) {
    if (!enabled()) { off(res); return null; }
    const su = db.getSuite(req.params.suiteId);
    if (!su || !entityEnabled(su.entityId)) { res.status(404).json({ error: 'Portal not found' }); return null; }
    const k = kioskFor(su.id);
    if (!k || !k.enabled || !k.token || k.token !== req.params.token) { res.status(403).json({ error: 'This staff link is invalid or has been turned off.' }); return null; }
    return su;
  }
  const portalStaffRow = (s) => { const r = staffRow(s); return { id: r.id, name: r.name, number: r.number, role: r.role, stations: r.stations }; };
  const findStaff = (suiteId, staffId) => sql.prepare('SELECT * FROM eventops_staff WHERE id=? AND suite_id=?').get(staffId, suiteId);

  // Event basics (name + stations) so the portal can show context before login.
  app.get('/api/eventops/portal/:suiteId/:token', (req, res) => {
    const su = portalSuite(req, res); if (!su) return;
    res.json({ suite: { id: su.id, name: su.name }, stations: sql.prepare('SELECT * FROM eventops_stations WHERE suite_id=? ORDER BY position, name').all(su.id).map(stationRow), checkpoints: listCheckpoints(su.id) });
  });

  // Log in by staff number → the staff record (used to attribute their actions).
  app.post('/api/eventops/portal/:suiteId/:token/login', (req, res) => {
    const su = portalSuite(req, res); if (!su) return;
    const number = str(req.body?.number, 40).trim();
    if (!number) return res.status(400).json({ error: 'Enter your staff number.' });
    const s = sql.prepare('SELECT * FROM eventops_staff WHERE suite_id=? AND number=? COLLATE NOCASE').get(su.id, number);
    if (!s) return res.status(404).json({ error: 'No staff member with that number for this event.' });
    res.json({ staff: portalStaffRow(s) });
  });

  // A staff member's view: their assigned station's devices + open issues (and event totals).
  app.get('/api/eventops/portal/:suiteId/:token/me/:staffId', (req, res) => {
    const su = portalSuite(req, res); if (!su) return;
    const s = findStaff(su.id, req.params.staffId);
    if (!s) return res.status(404).json({ error: 'Staff member not found' });
    const me = staffRow(s);
    const ids = me.stationIds;
    // Each of the staff member's posted stations: its deployed devices + open issues.
    const stations = ids.map((sid) => {
      const st = stationRow(sql.prepare('SELECT * FROM eventops_stations WHERE id=?').get(sid));
      const devices = sql.prepare("SELECT * FROM eventops_devices WHERE station_id=? AND state='deployed'").all(sid).map(deviceRow);
      const issues = sql.prepare(`SELECT i.* FROM eventops_issues i JOIN eventops_devices d ON d.id=i.device_id
          WHERE i.suite_id=? AND i.status='open' AND d.station_id=? ORDER BY i.reported_at DESC`).all(su.id, sid)
        .map((i) => ({ ...issueRow(i), device: deviceRow(getDevice(i.device_id)) }));
      return st ? { ...st, devices, issues } : null;
    }).filter(Boolean);
    const total = sql.prepare('SELECT COUNT(*) c FROM eventops_devices WHERE suite_id=?').get(su.id).c;
    res.json({ staff: portalStaffRow(s), stations, eventTotals: { devices: total } });
  });

  // Scan a code → resolve the device (same matching as the console).
  app.post('/api/eventops/portal/:suiteId/:token/scan', (req, res) => {
    const su = portalSuite(req, res); if (!su) return;
    const code = str(req.body?.code, 120).trim();
    if (!code) return res.status(400).json({ error: 'No code scanned.' });
    const d = findDeviceByCode(su.id, code);
    if (!d) return res.status(404).json({ error: `No device matches “${code}” at this event.`, code });
    const openIssues = sql.prepare("SELECT COUNT(*) c FROM eventops_issues WHERE device_id=? AND status='open'").get(d.id).c;
    res.json({ device: deviceRow(d), openIssues });
  });

  // A staff member moves a device (attributed to them). Requires their staffId.
  app.post('/api/eventops/portal/:suiteId/:token/move', (req, res) => {
    const su = portalSuite(req, res); if (!su) return;
    const b = req.body || {};
    const s = findStaff(su.id, b.staffId);
    if (!s) return res.status(403).json({ error: 'Log in with your staff number first.' });
    const d = getDevice(b.deviceId);
    if (!d || d.suite_id !== su.id) return res.status(404).json({ error: 'Device not found' });
    const out = applyMove(su, d, { stationId: b.stationId, staffId: s.id, actor: `portal:${s.number || s.name}`, note: b.note });
    if (out.error) return res.status(400).json({ error: out.error });
    res.json(out);
  });

  // A staff member logs an issue (attributed to them).
  app.post('/api/eventops/portal/:suiteId/:token/issue', (req, res) => {
    const su = portalSuite(req, res); if (!su) return;
    const b = req.body || {};
    const s = findStaff(su.id, b.staffId);
    if (!s) return res.status(403).json({ error: 'Log in with your staff number first.' });
    const d = getDevice(b.deviceId);
    if (!d || d.suite_id !== su.id) return res.status(404).json({ error: 'Device not found' });
    res.status(201).json({ issue: applyIssue(su, d, { category: b.category, note: b.note, resolution: b.resolution, resolved: b.resolved, staffId: s.id, actor: `portal:${s.number || s.name}` }) });
  });

  // PUBLIC: all issues for the event (staff can browse + filter open/resolved).
  app.get('/api/eventops/portal/:suiteId/:token/issues', (req, res) => {
    const su = portalSuite(req, res); if (!su) return;
    const status = req.query.status === 'resolved' ? 'resolved' : req.query.status === 'all' ? null : 'open';
    const rows = status
      ? sql.prepare('SELECT * FROM eventops_issues WHERE suite_id=? AND status=? ORDER BY reported_at DESC').all(su.id, status)
      : sql.prepare('SELECT * FROM eventops_issues WHERE suite_id=? ORDER BY reported_at DESC').all(su.id);
    res.json({ issues: rows.map((i) => ({ ...issueRow(i), device: deviceRow(getDevice(i.device_id)) })) });
  });

  // PUBLIC: a staff member resolves an open issue.
  app.patch('/api/eventops/portal/:suiteId/:token/issues/:id', (req, res) => {
    const su = portalSuite(req, res); if (!su) return;
    const s = findStaff(su.id, (req.body || {}).staffId);
    if (!s) return res.status(403).json({ error: 'Log in with your staff number first.' });
    const i = sql.prepare('SELECT * FROM eventops_issues WHERE id=?').get(req.params.id);
    if (!i || i.suite_id !== su.id) return res.status(404).json({ error: 'Issue not found' });
    const resolution = str(req.body?.resolution ?? i.resolution, 2000).trim();
    sql.prepare("UPDATE eventops_issues SET status='resolved', resolution=?, resolved_by=?, resolved_at=? WHERE id=?")
      .run(resolution, `portal:${s.number || s.name}`, now(), i.id);
    res.json({ issue: issueRow(sql.prepare('SELECT * FROM eventops_issues WHERE id=?').get(i.id)) });
  });

  // ════════════════════════════ checkpoints (station inspections) ═══════════════════
  const checkpointRow = (c) => ({ id: c.id, suiteId: c.suite_id, name: c.name, position: c.position });
  const cpLogRow = (l) => ({ id: l.id, stationId: l.station_id || null, stationLabel: l.station_label,
    checkpointId: l.checkpoint_id || null, checkpointName: l.checkpoint_name, staffLabel: l.staff_label,
    comment: l.comment, photo: l.photo, at: l.at });
  const listCheckpoints = (suiteId) => sql.prepare('SELECT * FROM eventops_checkpoints WHERE suite_id=? ORDER BY position, created_at').all(suiteId).map(checkpointRow);
  const PHOTO_MAX = 3_000_000; // ~3MB data-URL cap (client downscales before sending)

  function recordCheckpoint(su, { stationId, checkpointId, comment, photo, staffId }) {
    const st = stationId ? sql.prepare('SELECT * FROM eventops_stations WHERE id=? AND suite_id=?').get(stationId, su.id) : null;
    const cp = checkpointId ? sql.prepare('SELECT * FROM eventops_checkpoints WHERE id=? AND suite_id=?').get(checkpointId, su.id) : null;
    const staff = resolveStaff(su.id, staffId);
    const id = uuid();
    sql.prepare(`INSERT INTO eventops_checkpoint_logs
      (id, entity_id, suite_id, station_id, station_label, checkpoint_id, checkpoint_name, staff_id, staff_label, comment, photo, at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, su.entityId, su.id, st?.id || '', st?.name || '', cp?.id || '', cp?.name || '', staff?.id || '', staff?.label || '',
        str(comment, 2000), String(photo || ''), now());
    return cpLogRow(sql.prepare('SELECT * FROM eventops_checkpoint_logs WHERE id=?').get(id));
  }

  // Definitions (setup): create the named checkpoints.
  app.get('/api/eventops/suites/:suiteId/checkpoints', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res); if (!su) return;
    res.json({ checkpoints: listCheckpoints(su.id), canManage: canManage(req.user, su.id) });
  });
  app.post('/api/eventops/suites/:suiteId/checkpoints', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const name = str(req.body?.name, 80).trim();
    if (!name) return res.status(400).json({ error: 'Give the checkpoint a name.' });
    const max = sql.prepare('SELECT MAX(position) m FROM eventops_checkpoints WHERE suite_id=?').get(su.id).m || 0;
    const id = uuid();
    sql.prepare('INSERT INTO eventops_checkpoints (id, entity_id, suite_id, name, position, created_at) VALUES (?,?,?,?,?,?)').run(id, su.entityId, su.id, name, max + 1, now());
    res.status(201).json({ checkpoint: checkpointRow(sql.prepare('SELECT * FROM eventops_checkpoints WHERE id=?').get(id)) });
  });
  app.put('/api/eventops/suites/:suiteId/checkpoints/:id', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const c = sql.prepare('SELECT * FROM eventops_checkpoints WHERE id=?').get(req.params.id);
    if (!c || c.suite_id !== su.id) return res.status(404).json({ error: 'Checkpoint not found' });
    const name = str(req.body?.name ?? c.name, 80).trim() || c.name;
    sql.prepare('UPDATE eventops_checkpoints SET name=? WHERE id=?').run(name, c.id);
    res.json({ checkpoint: checkpointRow(sql.prepare('SELECT * FROM eventops_checkpoints WHERE id=?').get(c.id)) });
  });
  app.delete('/api/eventops/suites/:suiteId/checkpoints/:id', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const c = sql.prepare('SELECT * FROM eventops_checkpoints WHERE id=?').get(req.params.id);
    if (!c || c.suite_id !== su.id) return res.status(404).json({ error: 'Checkpoint not found' });
    sql.prepare('DELETE FROM eventops_checkpoints WHERE id=?').run(c.id); // logs keep the denormalised name
    res.status(204).end();
  });

  // Submitted checkpoint logs (newest first; optional ?stationId filter).
  app.get('/api/eventops/suites/:suiteId/checkpoint-logs', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res); if (!su) return;
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 60));
    const rows = req.query.stationId
      ? sql.prepare('SELECT * FROM eventops_checkpoint_logs WHERE suite_id=? AND station_id=? ORDER BY at DESC LIMIT ?').all(su.id, req.query.stationId, limit)
      : sql.prepare('SELECT * FROM eventops_checkpoint_logs WHERE suite_id=? ORDER BY at DESC LIMIT ?').all(su.id, limit);
    res.json({ logs: rows.map(cpLogRow), canManage: canManage(req.user, su.id) });
  });

  // PUBLIC: a staff member submits a checkpoint from the portal (with an optional photo).
  app.post('/api/eventops/portal/:suiteId/:token/checkpoint', (req, res) => {
    const su = portalSuite(req, res); if (!su) return;
    const b = req.body || {};
    const s = findStaff(su.id, b.staffId);
    if (!s) return res.status(403).json({ error: 'Log in with your staff number first.' });
    if (!b.stationId) return res.status(400).json({ error: 'Pick a station.' });
    if (!b.photo) return res.status(400).json({ error: 'A photo is required for a checkpoint.' });
    if (String(b.photo).length > PHOTO_MAX) return res.status(413).json({ error: 'Photo too large — please retake it.' });
    res.status(201).json({ checkpoint: recordCheckpoint(su, { stationId: b.stationId, checkpointId: b.checkpointId, comment: b.comment, photo: b.photo, staffId: s.id }) });
  });

  // ── Read-only query API (for the Owl + any internal caller). All suite-scoped, no PII. ──
  const ownApi = {
    suiteSummary(suiteId) {
      const su = db.getSuite(suiteId); if (!su) return null;
      const devices = sql.prepare('SELECT * FROM eventops_devices WHERE suite_id=?').all(suiteId);
      const byState = Object.fromEntries(STATES.map((s) => [s, 0]));
      for (const d of devices) byState[d.state] = (byState[d.state] || 0) + 1;
      const stations = sql.prepare('SELECT * FROM eventops_stations WHERE suite_id=? ORDER BY position, name').all(suiteId).map(stationRow);
      const openIssues = sql.prepare("SELECT COUNT(*) c FROM eventops_issues WHERE suite_id=? AND status='open'").get(suiteId).c;
      const staffCount = sql.prepare('SELECT COUNT(*) c FROM eventops_staff WHERE suite_id=?').get(suiteId).c;
      const recent = sql.prepare('SELECT * FROM eventops_checkpoint_logs WHERE suite_id=? ORDER BY at DESC LIMIT 8').all(suiteId).map(cpLogRow);
      return {
        event: su.name,
        devices: { total: devices.length, atHive: byState.in_stock + byState.returned, deployed: byState.deployed, lost: byState.lost, damaged: byState.damaged },
        stations: stations.map((s) => ({ name: s.name, kind: s.kind, devices: s.deviceCount, openIssues: s.openIssues })),
        openIssues, staffCount,
        recentCheckpoints: recent.map((c) => ({ checkpoint: c.checkpointName, station: c.stationLabel, by: c.staffLabel, comment: c.comment, hasPhoto: !!c.photo, at: c.at })),
      };
    },
    locateDevice(suiteId, code) {
      const d = findDeviceByCode(suiteId, String(code || '').trim());
      if (!d) return null;
      const r = deviceRow(d);
      const history = sql.prepare('SELECT * FROM eventops_device_events WHERE device_id=? ORDER BY at DESC LIMIT 6').all(d.id).map(eventRow)
        .map((e) => ({ at: e.at, what: e.kind, to: e.toStation || STATE_LABEL_(e.toState), by: e.staffLabel || '', note: e.note }));
      const openIssues = sql.prepare("SELECT COUNT(*) c FROM eventops_issues WHERE device_id=? AND status='open'").get(d.id).c;
      return { label: r.label, code: r.qrCode || r.serialNumber, type: r.type, state: r.state, location: r.location, openIssues, history };
    },
    listDevices(suiteId, { state, stationName } = {}) {
      let rows = sql.prepare('SELECT * FROM eventops_devices WHERE suite_id=?').all(suiteId).map(deviceRow);
      if (state && STATES.includes(state)) rows = rows.filter((d) => d.state === state);
      if (stationName) { const n = String(stationName).toLowerCase(); rows = rows.filter((d) => (n.includes('hive') ? !d.stationId : (d.stationName || '').toLowerCase().includes(n))); }
      return rows.map((d) => ({ label: d.label, code: d.qrCode || d.serialNumber, type: d.type, state: d.state, location: d.location }));
    },
    listStations(suiteId) {
      return sql.prepare('SELECT * FROM eventops_stations WHERE suite_id=? ORDER BY position, name').all(suiteId).map(stationRow)
        .map((s) => ({ name: s.name, kind: s.kind, devices: s.deviceCount, openIssues: s.openIssues }));
    },
    listIssues(suiteId, status = 'open') {
      const st = status === 'resolved' ? 'resolved' : status === 'all' ? null : 'open';
      const rows = st
        ? sql.prepare('SELECT * FROM eventops_issues WHERE suite_id=? AND status=? ORDER BY reported_at DESC').all(suiteId, st)
        : sql.prepare('SELECT * FROM eventops_issues WHERE suite_id=? ORDER BY reported_at DESC').all(suiteId);
      return rows.map((i) => { const r = issueRow(i); const d = deviceRow(getDevice(i.device_id)); return { device: d?.label || d?.qrCode || 'device', category: r.category, status: r.status, station: r.stationLabel, note: r.note, resolution: r.resolution, by: r.staffLabel, reportedAt: r.reportedAt, resolvedAt: r.resolvedAt }; });
    },
    listStaff(suiteId, { stationName } = {}) {
      let rows = sql.prepare('SELECT * FROM eventops_staff WHERE suite_id=? ORDER BY number, name').all(suiteId).map(staffRow);
      if (stationName) { const n = String(stationName).toLowerCase(); rows = rows.filter((s) => s.stations.some((x) => x.name.toLowerCase().includes(n))); }
      return rows.map((s) => ({ number: s.number, name: s.name, role: s.role, stations: s.stations.map((x) => x.name) }));
    },
    listCheckpoints(suiteId, { limit = 20, stationName } = {}) {
      let rows = sql.prepare('SELECT * FROM eventops_checkpoint_logs WHERE suite_id=? ORDER BY at DESC LIMIT ?').all(suiteId, Math.min(100, limit)).map(cpLogRow);
      if (stationName) { const n = String(stationName).toLowerCase(); rows = rows.filter((c) => (c.stationLabel || '').toLowerCase().includes(n)); }
      return rows.map((c) => ({ checkpoint: c.checkpointName, station: c.stationLabel, by: c.staffLabel, comment: c.comment, hasPhoto: !!c.photo, at: c.at }));
    },
  };
  const STATE_LABEL_ = (s) => ({ in_stock: 'Hive', deployed: 'deployed', returned: 'Hive', lost: 'lost', damaged: 'damaged' }[s] || s);

  console.log('[eventops] mounted', enabled() ? '(enabled)' : '(disabled — set eventops_enabled=1)');
  return { entityEnabled, setEntityEnabled, ...ownApi };
}

module.exports = { mount, STATES, STATION_KINDS, DEVICE_TYPES, ISSUE_CATEGORIES, isUnusual };
