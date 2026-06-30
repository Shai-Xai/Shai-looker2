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
  `);

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
    x: s.x, y: s.y, position: s.position, createdAt: s.created_at,
    deviceCount: sql.prepare("SELECT COUNT(*) c FROM eventops_devices WHERE station_id=? AND state='deployed'").get(s.id).c,
  });
  const eventRow = (e) => ({
    id: e.id, deviceId: e.device_id, kind: e.kind, fromState: e.from_state, toState: e.to_state,
    fromStation: stationName(e.from_station_id), toStation: stationName(e.to_station_id),
    actor: e.actor, note: e.note, unusual: !!e.unusual, at: e.at,
  });
  const issueRow = (i) => ({
    id: i.id, deviceId: i.device_id, category: i.category, note: i.note, status: i.status,
    resolution: i.resolution, reportedBy: i.reported_by, reportedAt: i.reported_at,
    resolvedBy: i.resolved_by, resolvedAt: i.resolved_at,
  });
  const getDevice = (id) => sql.prepare('SELECT * FROM eventops_devices WHERE id=?').get(id);

  function logEvent(d, { kind, toState, toStation, note, actor, unusual }) {
    sql.prepare(`INSERT INTO eventops_device_events
      (id, device_id, entity_id, suite_id, kind, from_state, to_state, from_station_id, to_station_id, actor, note, unusual, at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(uuid(), d.id, d.entity_id, d.suite_id, kind, d.state, toState ?? d.state,
        d.station_id || '', toStation ?? (d.station_id || ''), actor || '', String(note || '').slice(0, 2000),
        unusual ? 1 : 0, now());
  }
  const str = (v, max = 200) => String(v == null ? '' : v).slice(0, max);

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
    sql.prepare('UPDATE eventops_stations SET name=?, kind=?, x=?, y=? WHERE id=?').run(name, kind, x, y, s.id);
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
    const d = sql.prepare('SELECT * FROM eventops_devices WHERE suite_id=? AND (qr_code=? OR serial_number=?)').get(su.id, code, code);
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

    let toState; let toStation = '';
    if (b.state && STATES.includes(b.state)) {
      toState = b.state;
      // A status change to a station-bound state keeps a station only if it's "deployed".
      toStation = b.state === 'deployed' ? str(b.stationId, 60) : '';
    } else {
      const raw = b.stationId == null ? '' : String(b.stationId);
      const toHive = raw === '' || raw === 'hive';
      if (toHive) { toState = 'in_stock'; toStation = ''; }
      else {
        const st = sql.prepare('SELECT id FROM eventops_stations WHERE id=? AND suite_id=?').get(raw, su.id);
        if (!st) return res.status(400).json({ error: 'Unknown station.' });
        toState = 'deployed'; toStation = st.id;
      }
    }
    const unusual = isUnusual(d.state, toState);
    logEvent(d, { kind: b.state ? 'status' : 'move', toState, toStation, actor: req.user.email, note: b.note, unusual });
    sql.prepare('UPDATE eventops_devices SET state=?, station_id=?, updated_at=? WHERE id=?').run(toState, toStation, now(), d.id);
    res.json({ device: deviceRow(getDevice(d.id)), unusual });
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
    const category = ISSUE_CATEGORIES.includes(b.category) ? b.category : (str(b.category, 40).trim() || 'other');
    const note = str(b.note, 2000).trim();
    const resolution = str(b.resolution, 2000).trim();
    const resolvedNow = !!b.resolved || !!resolution;
    const id = uuid(); const ts = now();
    sql.prepare(`INSERT INTO eventops_issues
      (id, device_id, entity_id, suite_id, category, note, status, resolution, reported_by, reported_at, resolved_by, resolved_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, d.id, su.entityId, su.id, category, note, resolvedNow ? 'resolved' : 'open', resolution,
        req.user.email, ts, resolvedNow ? req.user.email : '', resolvedNow ? ts : '');
    logEvent(d, { kind: 'check', actor: req.user.email, note: `Issue: ${category}${note ? ' — ' + note : ''}` });
    res.status(201).json({ issue: issueRow(sql.prepare('SELECT * FROM eventops_issues WHERE id=?').get(id)) });
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

  console.log('[eventops] mounted', enabled() ? '(enabled)' : '(disabled — set eventops_enabled=1)');
  return { entityEnabled, setEntityEnabled };
}

module.exports = { mount, STATES, STATION_KINDS, DEVICE_TYPES, ISSUE_CATEGORIES, isUnusual };
