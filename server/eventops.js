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

function mount(app, { db, auth, push = require('./push'), messaging = null, mailer = null }) {
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

    -- Editable per-event catalogue of device types (drives the Type dropdown). Lazy-seeded
    -- with sensible defaults the first time an event's list is read.
    CREATE TABLE IF NOT EXISTS eventops_device_types (
      id         TEXT PRIMARY KEY,
      entity_id  TEXT NOT NULL,
      suite_id   TEXT NOT NULL,
      label      TEXT NOT NULL DEFAULT '',
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eventops_device_types_suite ON eventops_device_types(suite_id);

    -- Editable per-event catalogue of issue categories (drives the Log-issue picker). One
    -- may be flagged the default (pre-selected). Lazy-seeded the first time it's read.
    CREATE TABLE IF NOT EXISTS eventops_issue_categories (
      id         TEXT PRIMARY KEY,
      entity_id  TEXT NOT NULL,
      suite_id   TEXT NOT NULL,
      label      TEXT NOT NULL DEFAULT '',
      is_default INTEGER NOT NULL DEFAULT 0,
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eventops_issue_categories_suite ON eventops_issue_categories(suite_id);

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

    -- Web-push subscriptions for portal staff (no Pulse account — keyed by staff id).
    -- Powers staff alerts phase 2: a dark station pings the person standing at it.
    CREATE TABLE IF NOT EXISTS eventops_staff_push (
      staff_id   TEXT NOT NULL,
      suite_id   TEXT NOT NULL,
      endpoint   TEXT NOT NULL PRIMARY KEY,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eventops_staff_push ON eventops_staff_push(staff_id);

    -- Device support calls: a barman/vendor taps a reason on the device's PRE-BOUND
    -- link (station + device baked into the URL, nothing to pick) and it lands with
    -- dispatch as a live call with an ack loop. Distinct from eventops_issues (a
    -- maintenance log) — a call is a live "come to me now". Station + device labels
    -- are denormalised so the call survives a later device/station delete.
    CREATE TABLE IF NOT EXISTS eventops_calls (
      id            TEXT PRIMARY KEY,
      entity_id     TEXT NOT NULL,
      suite_id      TEXT NOT NULL,
      device_id     TEXT NOT NULL DEFAULT '',
      device_label  TEXT NOT NULL DEFAULT '',
      station_id    TEXT NOT NULL DEFAULT '',
      station_label TEXT NOT NULL DEFAULT '',
      reason        TEXT NOT NULL DEFAULT 'help',
      caller_name   TEXT NOT NULL DEFAULT '',
      comment       TEXT NOT NULL DEFAULT '',
      tried         TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'open',
      created_at    TEXT NOT NULL,
      acked_by      TEXT NOT NULL DEFAULT '',
      acked_at      TEXT NOT NULL DEFAULT '',
      eta           TEXT NOT NULL DEFAULT '',
      resolved_by   TEXT NOT NULL DEFAULT '',
      resolved_at   TEXT NOT NULL DEFAULT '',
      resolution    TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_eventops_calls_suite ON eventops_calls(suite_id, status);
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
  // Per-staff capabilities in the portal: move devices (default ON), do checkpoints (default OFF).
  try { sql.exec('ALTER TABLE eventops_staff ADD COLUMN can_move INTEGER NOT NULL DEFAULT 1'); } catch { /* already there */ }
  try { sql.exec('ALTER TABLE eventops_staff ADD COLUMN can_checkpoint INTEGER NOT NULL DEFAULT 0'); } catch { /* already there */ }
  // Station alerts for this staffer (default ON): a dark station pages them.
  try { sql.exec('ALTER TABLE eventops_staff ADD COLUMN alerts_on INTEGER NOT NULL DEFAULT 1'); } catch { /* already there */ }
  // A device can be handed to a staff member (custody) instead of a station; the event log
  // records the recipient's label so past hand-offs survive a later staff delete.
  try { sql.exec("ALTER TABLE eventops_devices ADD COLUMN holder_staff_id TEXT NOT NULL DEFAULT ''"); } catch { /* already there */ }
  try { sql.exec("ALTER TABLE eventops_device_events ADD COLUMN to_holder TEXT NOT NULL DEFAULT ''"); } catch { /* already there */ }

  // ── per-client toggle ──────────────────────────────────────────────────────────
  // Backed by the 🚩 eventops feature flag (the old eventops_settings pilot rows
  // were seeded into it below) — the Admin → Product → Flags matrix and this
  // module's own toggle are ONE switch.
  const flags = require('./flags');
  flags.init(db);
  try {
    if (db.getSetting('flags_seeded_eventops', '') !== '1') {
      const rows = sql.prepare('SELECT entity_id FROM eventops_settings WHERE enabled=1').all();
      const ins = sql.prepare('INSERT OR IGNORE INTO feature_flags (entity_id, flag, value, updated_by, updated_at) VALUES (?,?,?,?,?)');
      for (const r of rows) ins.run(r.entity_id, 'eventops', 'on', 'seed', now());
      db.setSetting('flags_seeded_eventops', '1');
    }
  } catch (e) { console.error('[eventops] flag seed failed', e.message); }
  const entityEnabled = (entityId) => flags.enabled(entityId, 'eventops');
  const setEntityEnabled = (entityId, on) => {
    sql.prepare(`INSERT INTO feature_flags (entity_id, flag, value, updated_by, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(entity_id, flag) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .run(entityId, 'eventops', on ? 'on' : 'off', 'eventops-toggle', now());
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
  const staffName = (id) => {
    if (!id) return '';
    const s = sql.prepare('SELECT name, number FROM eventops_staff WHERE id=?').get(id);
    if (!s) return '';
    return [s.number ? `#${s.number}` : '', s.name].filter(Boolean).join(' ').trim() || s.number || s.name || '';
  };
  const deviceRow = (d) => d && ({
    id: d.id, entityId: d.entity_id, suiteId: d.suite_id, label: d.label, type: d.type,
    qrCode: d.qr_code, serialNumber: d.serial_number, state: d.state,
    stationId: d.station_id || null, stationName: stationName(d.station_id),
    holderStaffId: d.holder_staff_id || null, holderName: staffName(d.holder_staff_id),
    location: d.station_id ? stationName(d.station_id) : (d.holder_staff_id ? `With ${staffName(d.holder_staff_id) || 'staff'}` : 'Hive'),
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
    fromStation: stationName(e.from_station_id), toStation: stationName(e.to_station_id), toHolder: e.to_holder || '',
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
      canMove: s.can_move == null ? true : !!s.can_move, canCheckpoint: !!s.can_checkpoint,
      alertsOn: s.alerts_on == null ? true : !!s.alerts_on,
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

  function logEvent(d, { kind, toState, toStation, toHolder, note, actor, unusual, staff }) {
    sql.prepare(`INSERT INTO eventops_device_events
      (id, device_id, entity_id, suite_id, kind, from_state, to_state, from_station_id, to_station_id, actor, note, unusual, at, staff_id, staff_label, to_holder)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(uuid(), d.id, d.entity_id, d.suite_id, kind, d.state, toState ?? d.state,
        d.station_id || '', toStation ?? (d.station_id || ''), actor || '', String(note || '').slice(0, 2000),
        unusual ? 1 : 0, now(), staff?.id || '', staff?.label || '', str(toHolder, 120));
  }
  const str = (v, max = 200) => String(v == null ? '' : v).slice(0, max);

  // ── shared engine (used by BOTH the authed console routes and the public staff portal,
  //    so the two surfaces can never drift apart) ──────────────────────────────────────
  // Resolve a scanned/typed code → device (prefer QR/serial, fall back to label; case-insensitive).
  const findDeviceByCode = (suiteId, code) =>
    sql.prepare('SELECT * FROM eventops_devices WHERE suite_id=? AND (qr_code=? COLLATE NOCASE OR serial_number=? COLLATE NOCASE)').get(suiteId, code, code)
    || sql.prepare('SELECT * FROM eventops_devices WHERE suite_id=? AND label=? COLLATE NOCASE').get(suiteId, code);

  // Apply a move/status change + write the audit row. Returns { device, unusual } or { error }.
  // A move can target a station, the Hive, a status (lost/damaged), or a staff member's custody
  // (holderStaffId) — the last clears the station and records who now holds the device.
  function applyMove(su, d, { stationId, state, holderStaffId, staffId, actor, note }) {
    let toState; let toStation = ''; let toHolderId = ''; let toHolderLabel = '';
    if (holderStaffId) {
      const holder = resolveStaff(su.id, holderStaffId);
      if (!holder) return { error: 'Unknown staff member.' };
      toState = 'deployed'; toHolderId = holder.id; toHolderLabel = holder.label;
      // A hand-off can ALSO place the device at a station (staff working that post).
      const raw = stationId == null ? '' : String(stationId);
      if (raw && raw !== 'hive') {
        const st = sql.prepare('SELECT id FROM eventops_stations WHERE id=? AND suite_id=?').get(raw, su.id);
        if (!st) return { error: 'Unknown station.' };
        toStation = st.id;
      }
    } else if (state && STATES.includes(state)) {
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
    logEvent(d, { kind: state ? 'status' : 'move', toState, toStation, toHolder: toHolderLabel, actor, note, unusual, staff: resolveStaff(su.id, staffId) });
    sql.prepare('UPDATE eventops_devices SET state=?, station_id=?, holder_staff_id=?, updated_at=? WHERE id=?').run(toState, toStation, toHolderId, now(), d.id);
    return { device: deviceRow(getDevice(d.id)), unusual };
  }

  // Log an issue / liaison check + its audit row. Returns the issue row.
  function applyIssue(su, d, { category, note, resolution, resolved, staffId, actor }) {
    const cat = str(category, 40).trim() || defaultCategory(su);
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
    // Devices held by a staff member but NOT placed at a station → a "With staff" grouping.
    const heldByStaff = sql.prepare(`SELECT holder_staff_id AS sid, COUNT(*) AS c FROM eventops_devices
        WHERE suite_id=? AND holder_staff_id<>'' AND (station_id IS NULL OR station_id='')
        GROUP BY holder_staff_id`).all(su.id)
      .map((h) => ({ staffId: h.sid, staffLabel: staffName(h.sid) || 'Staff member', count: h.c }))
      .sort((a, b) => b.count - a.count);
    res.json({
      suite: { id: su.id, name: su.name },
      totals: { devices: devices.length, atHive: byState.in_stock + byState.returned, deployed: byState.deployed, openIssues },
      byState, stations, recent, heldByStaff,
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
      // Type is a free label chosen from the event's editable catalogue (see device-types
      // routes below); we accept whatever the UI sends and default to a sensible fallback.
      type: str(b.type, 40).trim() || 'handheld',
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
      const type = str(b.type, 40).trim() || 'handheld';
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

  // ── Device types: an editable per-event catalogue that drives the Type dropdown ──
  const deviceTypeRow = (t) => ({ id: t.id, label: t.label });
  const listTypes = (su) => sql.prepare('SELECT * FROM eventops_device_types WHERE suite_id=? ORDER BY position, created_at').all(su.id);
  function deviceTypes(su) {
    let rows = listTypes(su);
    if (rows.length === 0) { // lazy-seed defaults the first time an event's list is read
      const ts = now();
      const ins = sql.prepare('INSERT INTO eventops_device_types (id, entity_id, suite_id, label, position, created_at) VALUES (?,?,?,?,?,?)');
      sql.transaction(() => DEVICE_TYPES.forEach((label, i) => ins.run(uuid(), su.entityId, su.id, label, i, ts)))();
      rows = listTypes(su);
    }
    return rows;
  }

  app.get('/api/eventops/suites/:suiteId/device-types', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res); if (!su) return;
    res.json({ types: deviceTypes(su).map(deviceTypeRow) });
  });
  app.post('/api/eventops/suites/:suiteId/device-types', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const label = str(req.body?.label, 40).trim();
    if (!label) return res.status(400).json({ error: 'Give the type a name.' });
    deviceTypes(su); // ensure seeded so positions stay contiguous
    if (sql.prepare('SELECT id FROM eventops_device_types WHERE suite_id=? AND label=? COLLATE NOCASE').get(su.id, label)) return res.status(409).json({ error: 'That type already exists.' });
    const pos = (sql.prepare('SELECT MAX(position) m FROM eventops_device_types WHERE suite_id=?').get(su.id).m ?? -1) + 1;
    sql.prepare('INSERT INTO eventops_device_types (id, entity_id, suite_id, label, position, created_at) VALUES (?,?,?,?,?,?)').run(uuid(), su.entityId, su.id, label, pos, now());
    res.status(201).json({ types: deviceTypes(su).map(deviceTypeRow) });
  });
  app.put('/api/eventops/suites/:suiteId/device-types/:id', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const t = sql.prepare('SELECT * FROM eventops_device_types WHERE id=? AND suite_id=?').get(req.params.id, su.id);
    if (!t) return res.status(404).json({ error: 'Type not found' });
    const label = str(req.body?.label, 40).trim();
    if (!label) return res.status(400).json({ error: 'Give the type a name.' });
    if (sql.prepare('SELECT id FROM eventops_device_types WHERE suite_id=? AND label=? COLLATE NOCASE AND id<>?').get(su.id, label, t.id)) return res.status(409).json({ error: 'That type already exists.' });
    // Re-tag existing devices so a rename carries their type across.
    sql.prepare('UPDATE eventops_devices SET type=? WHERE suite_id=? AND type=? COLLATE NOCASE').run(label, su.id, t.label);
    sql.prepare('UPDATE eventops_device_types SET label=? WHERE id=?').run(label, t.id);
    res.json({ types: deviceTypes(su).map(deviceTypeRow) });
  });
  app.delete('/api/eventops/suites/:suiteId/device-types/:id', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const t = sql.prepare('SELECT * FROM eventops_device_types WHERE id=? AND suite_id=?').get(req.params.id, su.id);
    if (!t) return res.status(404).json({ error: 'Type not found' });
    sql.prepare('DELETE FROM eventops_device_types WHERE id=?').run(t.id);
    res.json({ types: deviceTypes(su).map(deviceTypeRow) });
  });

  // ── Issue categories: an editable per-event catalogue with one flagged as default ──
  const issueCategoryRow = (c) => ({ id: c.id, label: c.label, isDefault: !!c.is_default });
  const listCategories = (su) => sql.prepare('SELECT * FROM eventops_issue_categories WHERE suite_id=? ORDER BY position, created_at').all(su.id);
  function issueCategories(su) {
    let rows = listCategories(su);
    if (rows.length === 0) { // lazy-seed the built-in categories; the first is the default
      const ts = now();
      const ins = sql.prepare('INSERT INTO eventops_issue_categories (id, entity_id, suite_id, label, is_default, position, created_at) VALUES (?,?,?,?,?,?,?)');
      sql.transaction(() => ISSUE_CATEGORIES.forEach((label, i) => ins.run(uuid(), su.entityId, su.id, label, i === 0 ? 1 : 0, i, ts)))();
      rows = listCategories(su);
    }
    return rows;
  }
  const defaultCategory = (su) => { const rows = issueCategories(su); return (rows.find((c) => c.is_default) || rows[0])?.label || 'other'; };

  app.get('/api/eventops/suites/:suiteId/issue-categories', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res); if (!su) return;
    res.json({ categories: issueCategories(su).map(issueCategoryRow) });
  });
  app.post('/api/eventops/suites/:suiteId/issue-categories', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const label = str(req.body?.label, 40).trim();
    if (!label) return res.status(400).json({ error: 'Give the category a name.' });
    issueCategories(su); // ensure seeded
    if (sql.prepare('SELECT id FROM eventops_issue_categories WHERE suite_id=? AND label=? COLLATE NOCASE').get(su.id, label)) return res.status(409).json({ error: 'That category already exists.' });
    const pos = (sql.prepare('SELECT MAX(position) m FROM eventops_issue_categories WHERE suite_id=?').get(su.id).m ?? -1) + 1;
    sql.prepare('INSERT INTO eventops_issue_categories (id, entity_id, suite_id, label, is_default, position, created_at) VALUES (?,?,?,?,?,?,?)').run(uuid(), su.entityId, su.id, label, req.body?.isDefault ? 1 : 0, pos, now());
    res.status(201).json({ categories: issueCategories(su).map(issueCategoryRow) });
  });
  app.put('/api/eventops/suites/:suiteId/issue-categories/:id', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const c = sql.prepare('SELECT * FROM eventops_issue_categories WHERE id=? AND suite_id=?').get(req.params.id, su.id);
    if (!c) return res.status(404).json({ error: 'Category not found' });
    const label = req.body?.label != null ? str(req.body.label, 40).trim() : c.label;
    if (!label) return res.status(400).json({ error: 'Give the category a name.' });
    if (sql.prepare('SELECT id FROM eventops_issue_categories WHERE suite_id=? AND label=? COLLATE NOCASE AND id<>?').get(su.id, label, c.id)) return res.status(409).json({ error: 'That category already exists.' });
    if (label !== c.label) sql.prepare('UPDATE eventops_issues SET category=? WHERE suite_id=? AND category=? COLLATE NOCASE').run(label, su.id, c.label); // re-tag existing issues
    // Default is an independent flag — more than one category can be a default.
    const isDefault = req.body?.isDefault === true ? 1 : req.body?.isDefault === false ? 0 : c.is_default;
    sql.prepare('UPDATE eventops_issue_categories SET label=?, is_default=? WHERE id=?').run(label, isDefault, c.id);
    res.json({ categories: issueCategories(su).map(issueCategoryRow) });
  });
  app.delete('/api/eventops/suites/:suiteId/issue-categories/:id', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const c = sql.prepare('SELECT * FROM eventops_issue_categories WHERE id=? AND suite_id=?').get(req.params.id, su.id);
    if (!c) return res.status(404).json({ error: 'Category not found' });
    sql.prepare('DELETE FROM eventops_issue_categories WHERE id=?').run(c.id);
    // Keep at least one default alive: if none remain, promote the first.
    const rest = listCategories(su);
    if (rest.length && !rest.some((x) => x.is_default)) sql.prepare('UPDATE eventops_issue_categories SET is_default=1 WHERE id=?').run(rest[0].id);
    res.json({ categories: issueCategories(su).map(issueCategoryRow) });
  });

  app.put('/api/eventops/suites/:suiteId/devices/:id', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const d = getDevice(req.params.id);
    if (!d || d.suite_id !== su.id) return res.status(404).json({ error: 'Device not found' });
    const c = cleanDevice({ label: req.body?.label ?? d.label, type: req.body?.type ?? d.type, qrCode: req.body?.qrCode ?? d.qr_code, serialNumber: req.body?.serialNumber ?? d.serial_number });
    // A QR pairs one device per event — reject if another device already carries this code.
    if (c.qrCode) {
      const clash = sql.prepare('SELECT id FROM eventops_devices WHERE suite_id=? AND qr_code=? COLLATE NOCASE AND id<>?').get(su.id, c.qrCode, d.id);
      if (clash) return res.status(409).json({ error: 'That QR is already paired to another device.' });
    }
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
    const out = applyMove(su, d, { stationId: b.stationId, state: b.state, holderStaffId: b.holderStaffId, staffId: b.staffId, actor: req.user.email, note: b.note });
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
    const bool = (v, dflt) => (v == null ? dflt : v ? 1 : 0);
    return { name: str(b.name, 120).trim(), number: str(b.number, 40).trim(), role: str(b.role, 60).trim(), stationIds,
      canMove: bool(b.canMove, 1), canCheckpoint: bool(b.canCheckpoint, 0), alertsOn: bool(b.alertsOn, 1) };
  }

  app.post('/api/eventops/suites/:suiteId/staff', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const c = cleanStaff(req.body || {}, su);
    if (!c.name && !c.number) return res.status(400).json({ error: 'Give the staff member a name or number.' });
    const id = uuid();
    sql.prepare('INSERT INTO eventops_staff (id, entity_id, suite_id, name, number, role, station_id, station_ids, can_move, can_checkpoint, alerts_on, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, su.entityId, su.id, c.name, c.number, c.role, c.stationIds[0] || '', JSON.stringify(c.stationIds), c.canMove, c.canCheckpoint, c.alertsOn, now());
    res.status(201).json({ staff: staffRow(sql.prepare('SELECT * FROM eventops_staff WHERE id=?').get(id)) });
  });

  app.put('/api/eventops/suites/:suiteId/staff/:id', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const s = sql.prepare('SELECT * FROM eventops_staff WHERE id=?').get(req.params.id);
    if (!s || s.suite_id !== su.id) return res.status(404).json({ error: 'Staff member not found' });
    const cur = staffRow(s);
    const c = cleanStaff({ name: req.body?.name ?? s.name, number: req.body?.number ?? s.number, role: req.body?.role ?? s.role, stationIds: req.body?.stationIds ?? cur.stationIds,
      canMove: req.body?.canMove ?? cur.canMove, canCheckpoint: req.body?.canCheckpoint ?? cur.canCheckpoint, alertsOn: req.body?.alertsOn ?? cur.alertsOn }, su);
    sql.prepare('UPDATE eventops_staff SET name=?, number=?, role=?, station_id=?, station_ids=?, can_move=?, can_checkpoint=?, alerts_on=? WHERE id=?')
      .run(c.name, c.number, c.role, c.stationIds[0] || '', JSON.stringify(c.stationIds), c.canMove, c.canCheckpoint, c.alertsOn, s.id);
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
    kioskFor(su.id, { create: true });
    const b = req.body || {};
    // Optional friendly slug for the link (…/portal/:suiteId/<slug>). URL-safe, ≥3 chars.
    if (b.slug != null) {
      const slug = String(b.slug).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
      if (slug.length < 3) return res.status(400).json({ error: 'Use at least 3 letters, numbers or hyphens for the link.' });
      sql.prepare('UPDATE eventops_kiosk SET token=?, updated_at=? WHERE suite_id=?').run(slug, now(), su.id);
    }
    if (b.enabled != null) sql.prepare('UPDATE eventops_kiosk SET enabled=?, updated_at=? WHERE suite_id=?').run(b.enabled ? 1 : 0, now(), su.id);
    res.json(kioskView(su.id, kioskFor(su.id)));
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
  const portalStaffRow = (s) => { const r = staffRow(s); return { id: r.id, name: r.name, number: r.number, role: r.role, stations: r.stations, canMove: r.canMove, canCheckpoint: r.canCheckpoint }; };
  const findStaff = (suiteId, staffId) => sql.prepare('SELECT * FROM eventops_staff WHERE id=? AND suite_id=?').get(staffId, suiteId);

  // Event basics (name + stations) so the portal can show context before login.
  app.get('/api/eventops/portal/:suiteId/:token', (req, res) => {
    const su = portalSuite(req, res); if (!su) return;
    res.json({
      suite: { id: su.id, name: su.name },
      stations: sql.prepare('SELECT * FROM eventops_stations WHERE suite_id=? ORDER BY position, name').all(su.id).map(stationRow),
      checkpoints: listCheckpoints(su.id),
      issueCategories: issueCategories(su).map(issueCategoryRow),
      // Roster (name + number only) so a staffer can hand a device to a colleague.
      staff: sql.prepare('SELECT id, name, number FROM eventops_staff WHERE suite_id=? ORDER BY number, name').all(su.id),
      // Howler WhatsApp number (if configured) so staff can open the alert channel.
      whatsappFrom: (messaging && messaging.waFrom && messaging.waConfigured && messaging.waConfigured()) ? messaging.waFrom() : '',
    });
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

  // Push (staff alerts phase 2): the VAPID key + this staffer's subscription,
  // so a dark station can ping the person on the ground. Token-gated, no account.
  app.get('/api/eventops/portal/:suiteId/:token/push-key', (req, res) => {
    const su = portalSuite(req, res); if (!su) return;
    res.json({ enabled: push.isEnabled(), publicKey: push.isEnabled() ? push.vapidPublicKey() : '' });
  });
  app.post('/api/eventops/portal/:suiteId/:token/push', (req, res) => {
    const su = portalSuite(req, res); if (!su) return;
    const s = findStaff(su.id, str(req.body?.staffId, 64));
    if (!s) return res.status(404).json({ error: 'Staff member not found' });
    const sub = req.body?.subscription || {};
    const endpoint = str(sub.endpoint, 800); const keys = sub.keys || {};
    if (!endpoint || !keys.p256dh || !keys.auth) return res.status(400).json({ error: 'Bad subscription' });
    sql.prepare(`INSERT INTO eventops_staff_push (staff_id, suite_id, endpoint, p256dh, auth, created_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET staff_id=excluded.staff_id, suite_id=excluded.suite_id, p256dh=excluded.p256dh, auth=excluded.auth`)
      .run(s.id, su.id, endpoint, str(keys.p256dh, 300), str(keys.auth, 300), now());
    res.json({ ok: true });
  });
  app.post('/api/eventops/portal/:suiteId/:token/push-off', (req, res) => {
    const su = portalSuite(req, res); if (!su) return;
    const endpoint = str(req.body?.endpoint, 800);
    if (endpoint) sql.prepare('DELETE FROM eventops_staff_push WHERE endpoint=? AND suite_id=?').run(endpoint, su.id);
    res.json({ ok: true });
  });

  // This staffer's own station alerts (the eventops_staff_alert feed, written by
  // server/staffAlerts.js) + an acknowledge action. Token-gated, no account.
  const hasStaffAlert = () => { try { return !!sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='eventops_staff_alert'").get(); } catch { return false; } };
  app.get('/api/eventops/portal/:suiteId/:token/my-alerts/:staffId', (req, res) => {
    const su = portalSuite(req, res); if (!su) return;
    const s = findStaff(su.id, req.params.staffId);
    if (!s) return res.status(404).json({ error: 'Staff member not found' });
    if (!hasStaffAlert()) return res.json({ alerts: [] });
    const alerts = sql.prepare('SELECT id, station, message, at, acked_at FROM eventops_staff_alert WHERE staff_id=? AND suite_id=? ORDER BY at DESC LIMIT 20')
      .all(s.id, su.id).map((a) => ({ id: a.id, station: a.station, message: a.message, at: a.at, acked: !!a.acked_at }));
    res.json({ alerts });
  });
  app.post('/api/eventops/portal/:suiteId/:token/my-alerts/:staffId/ack', (req, res) => {
    const su = portalSuite(req, res); if (!su) return;
    const s = findStaff(su.id, req.params.staffId);
    if (!s) return res.status(404).json({ error: 'Staff member not found' });
    if (!hasStaffAlert()) return res.json({ ok: true });
    const id = str(req.body?.alertId, 64);
    // Ack one, or all of this staffer's unacked alerts when no id is given.
    if (id) sql.prepare("UPDATE eventops_staff_alert SET acked_at=? WHERE id=? AND staff_id=? AND acked_at=''").run(now(), id, s.id);
    else sql.prepare("UPDATE eventops_staff_alert SET acked_at=? WHERE staff_id=? AND suite_id=? AND acked_at=''").run(now(), s.id, su.id);
    res.json({ ok: true });
  });

  // Scan a code → resolve the device (same matching as the console).
  app.post('/api/eventops/portal/:suiteId/:token/scan', (req, res) => {
    const su = portalSuite(req, res); if (!su) return;
    const code = str(req.body?.code, 120).trim();
    if (!code) return res.status(400).json({ error: 'No code scanned.' });
    const d = findDeviceByCode(su.id, code);
    if (!d) return res.status(404).json({ error: `No device matches “${code}” at this event.`, code });
    const openIssues = sql.prepare("SELECT COUNT(*) c FROM eventops_issues WHERE device_id=? AND status='open'").get(d.id).c;
    const events = sql.prepare('SELECT * FROM eventops_device_events WHERE device_id=? ORDER BY at DESC LIMIT 20').all(d.id).map(eventRow);
    res.json({ device: deviceRow(d), openIssues, events });
  });

  // A staff member moves a device (attributed to them). Requires their staffId.
  app.post('/api/eventops/portal/:suiteId/:token/move', (req, res) => {
    const su = portalSuite(req, res); if (!su) return;
    const b = req.body || {};
    const s = findStaff(su.id, b.staffId);
    if (!s) return res.status(403).json({ error: 'Log in with your staff number first.' });
    if (s.can_move != null && !s.can_move) return res.status(403).json({ error: 'You don’t have permission to move devices.' });
    const d = getDevice(b.deviceId);
    if (!d || d.suite_id !== su.id) return res.status(404).json({ error: 'Device not found' });
    const out = applyMove(su, d, { stationId: b.stationId, holderStaffId: b.holderStaffId, staffId: s.id, actor: `portal:${s.number || s.name}`, note: b.note });
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

  // ════════════════════════════ device support calls ═══════════════════════════════
  // A barman/vendor taps a reason on the device's PRE-BOUND link (station + device in
  // the URL, so nothing to pick) and it lands with dispatch as a live call. The link
  // works from any phone too, so a frozen device never blocks a call for help.
  const CALL_REASONS = [
    { key: 'stock', label: 'Stock', icon: '📦' },
    { key: 'manager', label: 'Manager', icon: '🧑‍💼' },
    { key: 'help', label: 'Help', icon: '🆘' },
    { key: 'security', label: 'Security', icon: '🛡️' },
    { key: 'medical', label: 'Medical', icon: '🚑' },
  ];
  // 'cat:<label>' keys are the event's device ISSUE CATEGORIES (mainly operators calling
  // about the device itself) — same catalogue the Log-issue picker uses.
  const callReason = (k) => {
    const s = String(k || '');
    if (s.startsWith('cat:')) { const lbl = s.slice(4, 44).trim(); if (lbl) return { key: `cat:${lbl}`, label: `Device · ${lbl.replace(/_/g, ' ')}`, icon: '🔧' }; }
    return CALL_REASONS.find((r) => r.key === s) || CALL_REASONS[2];
  };
  const callTestMode = () => db.getSetting('data_health_test_mode', '1') !== '0';
  const callTestEmail = () => db.getSetting('data_health_test_email', 'shai.evian@howler.co.za');
  const callRow = (c) => ({
    id: c.id, suiteId: c.suite_id, deviceId: c.device_id || null, deviceLabel: c.device_label,
    stationId: c.station_id || null, stationLabel: c.station_label, reason: c.reason,
    reasonLabel: callReason(c.reason).label, reasonIcon: callReason(c.reason).icon,
    callerName: c.caller_name, comment: c.comment, tried: c.tried, status: c.status,
    createdAt: c.created_at, ackedBy: c.acked_by, ackedAt: c.acked_at || null, eta: c.eta,
    resolvedBy: c.resolved_by, resolvedAt: c.resolved_at || null, resolution: c.resolution,
  });
  // Dispatch for a station's calls: alert-enabled staff posted to that station.
  const callCrew = (suiteId, stationId) => sql.prepare('SELECT * FROM eventops_staff WHERE suite_id=?').all(suiteId)
    .map(staffRow).filter((s) => s.alertsOn && (!stationId || s.stationIds.includes(stationId)));

  function deliverCall(su, c) {
    const rz = callReason(c.reason);
    const where = [c.station_label || 'Hive', c.device_label].filter(Boolean).join(' · ');
    const title = `${rz.icon} ${rz.label} — ${where}`;
    const body = [
      `${c.caller_name ? c.caller_name + ' at ' : ''}${where} needs ${rz.label}.`,
      c.comment ? `Note: ${c.comment}` : '', c.tried ? `Already tried: ${c.tried}` : '',
    ].filter(Boolean).join('\n');
    // Test mode (default while trialling): only the test inbox hears it — never staff.
    if (callTestMode()) {
      const to = callTestEmail();
      if (to && mailer?.send) mailer.send({ to, subject: `[TEST] ${title}`,
        text: `${body}\n\n🧪 TEST MODE — dispatch (push/WhatsApp) was NOT contacted. Go live in Admin → Data health.`,
        kind: 'notification' }).catch((e) => console.error('[eventops] call test mail failed', e.message));
      return;
    }
    // Live: web-push the station's dispatch crew on the portal now.
    const crew = callCrew(su.id, c.station_id).map((s) => s.id);
    if (crew.length && push.isEnabled && push.isEnabled() && push.sendRaw) {
      const rows = sql.prepare(`SELECT endpoint, p256dh, auth FROM eventops_staff_push WHERE staff_id IN (${crew.map(() => '?').join(',')})`).all(...crew);
      if (rows.length) Promise.resolve(push.sendRaw(rows, { title, body, tag: `call-${c.id}`, url: '/event-ops' })).catch(() => {});
    }
  }

  // PUBLIC: the pre-bound call page reads its station + device from the link (no login).
  app.get('/api/eventops/portal/:suiteId/:token/call/:deviceId', (req, res) => {
    const su = portalSuite(req, res); if (!su) return;
    const d = getDevice(req.params.deviceId);
    if (!d || d.suite_id !== su.id) return res.status(404).json({ error: 'Device not found' });
    res.json({ suite: { id: su.id, name: su.name }, device: deviceRow(d),
      station: d.station_id ? { id: d.station_id, name: stationName(d.station_id) } : null, reasons: CALL_REASONS,
      deviceIssues: issueCategories(su).map((c2) => ({ key: 'cat:' + c2.label, label: c2.label.replace(/_/g, ' '), icon: '🔧' })) });
  });
  // PUBLIC: raise a call. Station + device come from the link; the caller adds a reason
  // (+ their name, an optional note and what they've already tried).
  app.post('/api/eventops/portal/:suiteId/:token/call/:deviceId', (req, res) => {
    const su = portalSuite(req, res); if (!su) return;
    const d = getDevice(req.params.deviceId);
    if (!d || d.suite_id !== su.id) return res.status(404).json({ error: 'Device not found' });
    const b = req.body || {};
    const id = uuid(); const ts = now();
    const stationLabel = d.station_id ? stationName(d.station_id) : 'Hive';
    sql.prepare(`INSERT INTO eventops_calls
      (id, entity_id, suite_id, device_id, device_label, station_id, station_label, reason, caller_name, comment, tried, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, 'open', ?)`)
      .run(id, su.entityId, su.id, d.id, d.label || '', d.station_id || '', stationLabel, callReason(b.reason).key,
        str(b.name, 80).trim(), str(b.comment, 2000).trim(), str(b.tried, 2000).trim(), ts);
    const c = sql.prepare('SELECT * FROM eventops_calls WHERE id=?').get(id);
    try { deliverCall(su, c); } catch (e) { console.error('[eventops] deliverCall failed', e.message); }
    res.status(201).json({ call: callRow(c) });
  });

  // ── console (authed): dispatch sees open calls, acknowledges (with ETA) + resolves ──
  const actorFor = (req) => (req.user && (req.user.name || req.user.email)) || 'staff';
  app.get('/api/eventops/suites/:suiteId/calls', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res); if (!su) return;
    const status = req.query.status === 'all' ? null
      : ['open', 'acked', 'resolved'].includes(req.query.status) ? req.query.status : 'open';
    const rows = status
      ? sql.prepare('SELECT * FROM eventops_calls WHERE suite_id=? AND status=? ORDER BY created_at DESC').all(su.id, status)
      : sql.prepare('SELECT * FROM eventops_calls WHERE suite_id=? ORDER BY created_at DESC').all(su.id);
    res.json({ calls: rows.map(callRow), testMode: callTestMode() });
  });
  app.post('/api/eventops/suites/:suiteId/calls/:id/ack', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const c = sql.prepare('SELECT * FROM eventops_calls WHERE id=? AND suite_id=?').get(req.params.id, su.id);
    if (!c) return res.status(404).json({ error: 'Call not found' });
    if (c.status === 'resolved') return res.status(409).json({ error: 'Call already resolved' });
    sql.prepare("UPDATE eventops_calls SET status='acked', acked_by=?, acked_at=?, eta=? WHERE id=?")
      .run(actorFor(req), now(), str((req.body || {}).eta, 40).trim(), c.id);
    res.json({ call: callRow(sql.prepare('SELECT * FROM eventops_calls WHERE id=?').get(c.id)) });
  });
  app.post('/api/eventops/suites/:suiteId/calls/:id/resolve', auth.requireAuth, (req, res) => {
    const su = gateSuite(req, res, { manage: true }); if (!su) return;
    const c = sql.prepare('SELECT * FROM eventops_calls WHERE id=? AND suite_id=?').get(req.params.id, su.id);
    if (!c) return res.status(404).json({ error: 'Call not found' });
    sql.prepare("UPDATE eventops_calls SET status='resolved', resolved_by=?, resolved_at=?, resolution=? WHERE id=?")
      .run(actorFor(req), now(), str((req.body || {}).resolution, 2000).trim(), c.id);
    res.json({ call: callRow(sql.prepare('SELECT * FROM eventops_calls WHERE id=?').get(c.id)) });
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
    if (!s.can_checkpoint) return res.status(403).json({ error: 'You don’t have permission to submit checkpoints.' });
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
    // Device support calls: an operator/barman tapped a reason on the device's pre-bound link asking for help.
    listCalls(suiteId, status = 'open', { stationName } = {}) {
      const st = ['open', 'acked', 'resolved'].includes(status) ? status : status === 'all' ? null : 'open';
      const rows = st
        ? sql.prepare('SELECT * FROM eventops_calls WHERE suite_id=? AND status=? ORDER BY created_at DESC').all(suiteId, st)
        : sql.prepare('SELECT * FROM eventops_calls WHERE suite_id=? ORDER BY created_at DESC').all(suiteId);
      let out = rows.map(callRow);
      if (stationName) { const n = String(stationName).toLowerCase(); out = out.filter((c) => (c.stationLabel || '').toLowerCase().includes(n)); }
      return out.map((c) => ({ station: c.stationLabel, device: c.deviceLabel, reason: c.reasonLabel, caller: c.callerName, comment: c.comment, tried: c.tried, status: c.status, calledAt: c.createdAt, ackedBy: c.ackedBy, eta: c.eta, resolvedBy: c.resolvedBy, resolvedAt: c.resolvedAt }));
    },
  };
  const STATE_LABEL_ = (s) => ({ in_stock: 'Hive', deployed: 'deployed', returned: 'Hive', lost: 'lost', damaged: 'damaged' }[s] || s);

  console.log('[eventops] mounted', enabled() ? '(enabled)' : '(disabled — set eventops_enabled=1)');
  return { entityEnabled, setEntityEnabled, ...ownApi };
}

module.exports = { mount, STATES, STATION_KINDS, DEVICE_TYPES, ISSUE_CATEGORIES, isUnusual };
