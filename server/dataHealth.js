// ─── Data health: the BigQuery → Looker stream monitor ──────────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the `data_monitors`, `data_monitor_streams`,
// `data_monitor_checks` and `data_monitor_events` tables and all /api/admin/data-health
// routes. Mounted from index.js with one line + injected deps. Kill switch: settings
// key `data_health_enabled` ('0' disables the tick + 404s the routes). To remove the
// feature: delete this file + that line, then drop the data_monitor* tables.
//
// WHAT it measures: Pulse reads everything through Looker, which reflects BigQuery,
// which reflects Howler's stations on the ground (check-in scanners, bars, vendors).
// A monitor asks Looker for max(timestamp) on an explore — optionally split by a
// station dimension — on a cadence, ALWAYS bypassing the query cache (measuring
// freshness through a cache would lie). The lag between that max timestamp and now
// is the end-to-end health of the whole pipe: station → Howler → BigQuery → Looker.
//
// The hard parts (the real deliverable):
//   • per-station memory — a station that DISAPPEARS from the query result (rows
//     age out of the filter window, device dies mid-event) keeps being evaluated
//     from the last timestamp we ever saw for it, so silence is what raises the
//     alarm — exactly the failure this exists to catch;
//   • edge-detection — alert on the fresh→stale TRANSITION, never every tick, with
//     a per-monitor cooldown so a flapping feed can't spam phones during an event;
//   • recovery notice — one "data is flowing again" message when the last stale
//     stream comes back, closing the loop;
//   • scoped reads — a monitor pinned to a client runs as a synthetic CLIENT user
//     so applyScope enforces the per-tenant boundary; an unpinned (platform)
//     monitor runs unscoped as a synthetic admin. Fail closed either way.

const crypto = require('crypto');
const { asyncHandler } = require('./http');

const MAX_FIELD = 'data_health_latest'; // the dynamic max(timestamp) measure's name
const AREAS = ['Check-in', 'Bar', 'Vendors', 'Cashless', 'Ticketing', 'Other'];
const CHANNELS = ['push', 'email', 'slack']; // entity fan-out via the OS spine; ops Slack is always-on

// `mailer` is injectable for tests but defaults to the real module so the
// index.js mount line stays unchanged (it's only used by test mode below).
function mount(app, { db, auth, looker, runLookerQuery, applyScope, os, ops, mailer = require('./mailer') }) {
  const sql = db.db;
  const now = () => new Date().toISOString();
  const uuid = () => crypto.randomUUID();
  const enabled = () => db.getSetting('data_health_enabled', '1') !== '0';
  // ── test mode (ON by default while the feature is being trialled) ──
  // While on, EVERY alert goes only to the test address — the internal ops Slack
  // and the client-team fan-out are muted, so a mis-tuned threshold can't page
  // the team or a client. Toggle + address live in Admin → Data health.
  const testMode = () => db.getSetting('data_health_test_mode', '1') !== '0';
  const testEmail = () => String(db.getSetting('data_health_test_email', 'shai.evian@howler.co.za') || '').trim();

  sql.exec(`
    CREATE TABLE IF NOT EXISTS data_monitors (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL DEFAULT '',
      area            TEXT NOT NULL DEFAULT '',            -- Check-in | Bar | Vendors | … (grouping label)
      entity_id       TEXT NOT NULL DEFAULT '',            -- optional: pin to a client (scoped read + inbox fan-out)
      suite_id        TEXT NOT NULL DEFAULT '',            -- optional: pin to that client's event (its filter locks apply via scope)
      model           TEXT NOT NULL DEFAULT '',            -- Looker model
      view            TEXT NOT NULL DEFAULT '',            -- explore
      time_field      TEXT NOT NULL DEFAULT '',            -- the record timestamp dimension (what "new data" means)
      station_field   TEXT NOT NULL DEFAULT '',            -- optional dimension to split by (station / device / vendor)
      filters         TEXT NOT NULL DEFAULT '{}',          -- extra {dimension: value} filters (e.g. one event)
      warn_min        INTEGER NOT NULL DEFAULT 30,         -- lag → amber
      stale_min       INTEGER NOT NULL DEFAULT 60,         -- lag → red + alert
      check_every_min INTEGER NOT NULL DEFAULT 5,          -- per-monitor cadence (the global tick is the floor)
      channels        TEXT NOT NULL DEFAULT '["push"]',    -- entity fan-out (needs entity_id); ops Slack always fires
      notify_recovery INTEGER NOT NULL DEFAULT 1,
      cooldown_min    INTEGER NOT NULL DEFAULT 60,         -- min minutes between stale alerts per monitor
      status          TEXT NOT NULL DEFAULT 'active',      -- active | paused
      state           TEXT NOT NULL DEFAULT 'ok',          -- ok | alerting (drives the recovery notice)
      last_checked_at TEXT NOT NULL DEFAULT '',
      last_alerted_at TEXT NOT NULL DEFAULT '',
      last_error      TEXT NOT NULL DEFAULT '',
      created_by      TEXT NOT NULL DEFAULT '',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    -- Per-station live state. A row persists after the station stops appearing in
    -- results — that persistence IS the detector (silence = growing lag = stale).
    CREATE TABLE IF NOT EXISTS data_monitor_streams (
      monitor_id    TEXT NOT NULL,
      station       TEXT NOT NULL DEFAULT '',   -- '' = the whole feed (no station split)
      last_event_at TEXT NOT NULL,              -- max record timestamp ever seen (UTC ISO)
      last_seen_at  TEXT NOT NULL,              -- last check where the station appeared in results
      lag_min       REAL NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'fresh',  -- fresh | warn | stale
      stale_since   TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (monitor_id, station)
    );

    -- The pull log: one row per check per monitor (the "when did we last look,
    -- and what did we see" trail the page renders).
    CREATE TABLE IF NOT EXISTS data_monitor_checks (
      id              TEXT PRIMARY KEY,
      monitor_id      TEXT NOT NULL,
      at              TEXT NOT NULL,
      ok              INTEGER NOT NULL DEFAULT 1,
      stations        INTEGER NOT NULL DEFAULT 0,
      fresh           INTEGER NOT NULL DEFAULT 0,
      warn            INTEGER NOT NULL DEFAULT 0,
      stale           INTEGER NOT NULL DEFAULT 0,
      max_lag_min     REAL,
      latest_event_at TEXT NOT NULL DEFAULT '',
      error           TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_dmc ON data_monitor_checks(monitor_id, at);

    -- Transitions + alert deliveries (the human-readable history).
    CREATE TABLE IF NOT EXISTS data_monitor_events (
      id         TEXT PRIMARY KEY,
      monitor_id TEXT NOT NULL,
      station    TEXT NOT NULL DEFAULT '',
      at         TEXT NOT NULL,
      kind       TEXT NOT NULL,                 -- stale | recovered | alert | recovery_alert | error
      lag_min    REAL,
      message    TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_dme ON data_monitor_events(monitor_id, at);
  `);

  const parseJson = (s, fb) => { try { const v = JSON.parse(s); return v == null ? fb : v; } catch { return fb; } };

  function rowToMonitor(r) {
    if (!r) return null;
    return {
      id: r.id, name: r.name, area: r.area, entityId: r.entity_id, suiteId: r.suite_id,
      model: r.model, view: r.view, timeField: r.time_field, stationField: r.station_field,
      filters: parseJson(r.filters, {}), warnMin: r.warn_min, staleMin: r.stale_min,
      checkEveryMin: r.check_every_min, channels: parseJson(r.channels, ['push']),
      notifyRecovery: !!r.notify_recovery, cooldownMin: r.cooldown_min,
      status: r.status, state: r.state, lastCheckedAt: r.last_checked_at,
      lastAlertedAt: r.last_alerted_at, lastError: r.last_error,
      createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }
  const monitorById = (id) => rowToMonitor(sql.prepare('SELECT * FROM data_monitors WHERE id=?').get(id));
  const streamsFor = (id) => sql.prepare('SELECT * FROM data_monitor_streams WHERE monitor_id=? ORDER BY status DESC, station').all(id)
    .map((s) => ({ station: s.station, lastEventAt: s.last_event_at, lastSeenAt: s.last_seen_at, lagMin: s.lag_min, status: s.status, staleSince: s.stale_since }));

  // ── sanitise an incoming monitor from the editor ──
  function clean(b) {
    const filters = {};
    if (b.filters && typeof b.filters === 'object' && !Array.isArray(b.filters)) {
      for (const [k, v] of Object.entries(b.filters).slice(0, 10)) {
        if (k && v != null && String(v).trim()) filters[String(k).slice(0, 200)] = String(v).slice(0, 500);
      }
    }
    const channels = Array.isArray(b.channels) ? [...new Set(b.channels.filter((c) => CHANNELS.includes(c)))] : ['push'];
    const num = (v, fb, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fb; };
    return {
      name: String(b.name || '').slice(0, 120),
      area: String(b.area || '').slice(0, 40),
      entityId: String(b.entityId || '').slice(0, 64),
      suiteId: String(b.suiteId || '').slice(0, 64),
      model: String(b.model || '').slice(0, 120),
      view: String(b.view || '').slice(0, 120),
      timeField: String(b.timeField || '').slice(0, 200),
      stationField: String(b.stationField || '').slice(0, 200),
      filters,
      warnMin: num(b.warnMin, 30, 1, 10080),
      staleMin: num(b.staleMin, 60, 2, 10080),
      checkEveryMin: num(b.checkEveryMin, 5, 1, 1440),
      channels,
      notifyRecovery: b.notifyRecovery === false ? 0 : 1,
      cooldownMin: num(b.cooldownMin, 60, 0, 10080),
      status: b.status === 'paused' ? 'paused' : 'active',
    };
  }

  function upsert(id, c, who) {
    const ts = now();
    if (id) {
      sql.prepare(`UPDATE data_monitors SET name=?, area=?, entity_id=?, suite_id=?, model=?, view=?, time_field=?, station_field=?,
        filters=?, warn_min=?, stale_min=?, check_every_min=?, channels=?, notify_recovery=?, cooldown_min=?, status=?, updated_at=? WHERE id=?`)
        .run(c.name, c.area, c.entityId, c.suiteId, c.model, c.view, c.timeField, c.stationField,
          JSON.stringify(c.filters), c.warnMin, c.staleMin, c.checkEveryMin, JSON.stringify(c.channels), c.notifyRecovery, c.cooldownMin, c.status, ts, id);
      return monitorById(id);
    }
    const nid = uuid();
    sql.prepare(`INSERT INTO data_monitors (id, name, area, entity_id, suite_id, model, view, time_field, station_field, filters,
      warn_min, stale_min, check_every_min, channels, notify_recovery, cooldown_min, status, state, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ok',?,?,?)`)
      .run(nid, c.name, c.area, c.entityId, c.suiteId, c.model, c.view, c.timeField, c.stationField, JSON.stringify(c.filters),
        c.warnMin, c.staleMin, c.checkEveryMin, JSON.stringify(c.channels), c.notifyRecovery, c.cooldownMin, c.status, who || '', now(), now());
    return monitorById(nid);
  }

  // ── the Looker read ──
  // Looker time-dimension values arrive as "YYYY-MM-DD HH:MM:SS" strings in the
  // query timezone — we force UTC so lag math is deterministic.
  function parseTs(v) {
    if (v == null || v === '') return null;
    let s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += ' 00:00:00';
    const d = new Date(s.replace(' ', 'T') + (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? '' : 'Z'));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // Scoped reads: pinned-to-client monitors run as a synthetic CLIENT locked to that
  // entity (applyScope forces the organiser boundary, exactly like alerts/goals);
  // platform monitors run as a synthetic admin (unscoped by design — internal ops).
  function evalUser(m) {
    if (m.entityId) return { id: `datahealth:${m.id}`, email: 'datahealth@howler', role: 'client', entityIds: [m.entityId] };
    return { id: 'datahealth', email: 'datahealth@howler', role: 'admin' };
  }

  async function readLatest(m) {
    const fields = m.stationField ? [m.stationField, MAX_FIELD] : [MAX_FIELD];
    const body = {
      model: m.model, view: m.view, fields,
      // A dynamic custom measure — max(time_field) — so Looker aggregates server-side
      // and one small query covers every station, however busy the raw table is.
      dynamic_fields: JSON.stringify([{ measure: MAX_FIELD, based_on: m.timeField, type: 'max' }]),
      filters: { ...(m.filters || {}) },
      limit: m.stationField ? '500' : '1',
      query_timezone: 'UTC',
    };
    if (!(await applyScope(body, evalUser(m), m.suiteId || null))) throw new Error('scope failed (fail closed)');
    // force=true: bypass the shared query cache — a cached row would make the pipe
    // look exactly as stale as our own cache, defeating the measurement.
    const rows = await runLookerQuery('/queries/run/json', body, 0, true);
    if (!Array.isArray(rows)) throw new Error('unexpected Looker response shape');
    const seen = new Map(); // station -> latest Date
    for (const r of rows) {
      const ts = parseTs(r[MAX_FIELD]);
      if (!ts) continue;
      const station = m.stationField ? String(r[m.stationField] ?? '').trim() || '—' : '';
      const prev = seen.get(station);
      if (!prev || ts > prev) seen.set(station, ts);
    }
    return seen;
  }

  const fmtLag = (min) => {
    if (min == null || !Number.isFinite(min)) return '—';
    const m2 = Math.round(min);
    if (m2 < 60) return `${m2}m`;
    if (m2 < 48 * 60) return `${Math.floor(m2 / 60)}h ${m2 % 60}m`;
    return `${Math.floor(m2 / 1440)}d ${Math.floor((m2 % 1440) / 60)}h`;
  };

  function recordEvent(monitorId, station, kind, lagMin, message) {
    sql.prepare('INSERT INTO data_monitor_events (id, monitor_id, station, at, kind, lag_min, message) VALUES (?,?,?,?,?,?,?)')
      .run(uuid(), monitorId, station || '', now(), kind, lagMin == null ? null : Math.round(lagMin * 10) / 10, String(message || '').slice(0, 500));
  }

  // Fan out: internal ops Slack ALWAYS (this is first and foremost a Howler health
  // tool); plus the client's inbox/push/email/Slack via the OS spine when the
  // monitor is pinned to an entity and has channels ticked. In TEST MODE both are
  // muted and the alert is emailed only to the test address. Returns where the
  // alert actually went, so the event history stays truthful.
  function deliver(m, title, body) {
    if (testMode()) {
      const to = testEmail();
      if (to && mailer?.send) {
        const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        mailer.send({
          to,
          subject: `[TEST] ${title}`,
          text: `${body}\n\nData health is in TEST MODE — only you receive these alerts (ops Slack + client notifications are muted). Go live in Admin → Data health.`,
          html: `<p><strong>${esc(title)}</strong></p><p>${esc(body)}</p><p style="color:#888;font-size:12px">Data health is in <strong>test mode</strong> — only you receive these alerts (ops Slack + client notifications are muted). Go live in Admin → Data health.</p>`,
          kind: 'notification',
        }).catch((e) => console.error('[data-health] test email failed', m.id, e.message));
      }
      return to ? [`test-email:${to}`] : [];
    }
    const sent = [];
    try { ops?.alert?.(`datahealth-${m.id}`, `${title}\n${body}`); sent.push('ops-slack'); } catch { /* best-effort */ }
    if (m.entityId && os?.announce) {
      try {
        os.announce({
          entityId: m.entityId, title, body, priority: 'normal',
          createdBy: 'data-health', authorType: 'system',
          channels: (m.channels || []).filter((c) => CHANNELS.includes(c)),
          subjectType: 'data-monitor', subjectId: m.id,
        });
        sent.push('client-team');
      } catch (e) { console.error('[data-health] announce failed', m.id, e.message); }
    }
    return sent;
  }

  // ── one check: pull → update stream memory → evaluate → alert on transitions ──
  async function check(m) {
    const ts = now();
    let seen;
    try {
      seen = await readLatest(m);
    } catch (e) {
      // A failed pull is itself a health signal — log it, surface it, don't guess.
      sql.prepare('INSERT INTO data_monitor_checks (id, monitor_id, at, ok, error) VALUES (?,?,?,0,?)')
        .run(uuid(), m.id, ts, String(e.message || e).slice(0, 300));
      if (!m.lastError) recordEvent(m.id, '', 'error', null, String(e.message || e).slice(0, 300));
      sql.prepare('UPDATE data_monitors SET last_checked_at=?, last_error=? WHERE id=?').run(ts, String(e.message || e).slice(0, 300), m.id);
      return { ok: false, error: String(e.message || e) };
    }

    // Merge what we saw into the per-station memory (last_event_at only moves forward).
    const upStream = sql.prepare(`INSERT INTO data_monitor_streams (monitor_id, station, last_event_at, last_seen_at)
      VALUES (?,?,?,?) ON CONFLICT(monitor_id, station) DO UPDATE SET
      last_event_at = MAX(last_event_at, excluded.last_event_at), last_seen_at = excluded.last_seen_at`);
    for (const [station, latest] of seen) upStream.run(m.id, station, latest.toISOString(), ts);

    // Evaluate EVERY remembered stream — including ones absent from this pull.
    const streams = sql.prepare('SELECT * FROM data_monitor_streams WHERE monitor_id=?').all(m.id);
    const nowMs = Date.now();
    const upd = sql.prepare('UPDATE data_monitor_streams SET lag_min=?, status=?, stale_since=? WHERE monitor_id=? AND station=?');
    let fresh = 0, warn = 0, stale = 0, maxLag = null, latestOverall = '';
    const newlyStale = [], recoveredNow = [];
    for (const s of streams) {
      const lagMin = Math.max(0, (nowMs - Date.parse(s.last_event_at)) / 60000);
      const status = lagMin >= m.staleMin ? 'stale' : lagMin >= m.warnMin ? 'warn' : 'fresh';
      if (status === 'stale') stale += 1; else if (status === 'warn') warn += 1; else fresh += 1;
      if (maxLag == null || lagMin > maxLag) maxLag = lagMin;
      if (!latestOverall || s.last_event_at > latestOverall) latestOverall = s.last_event_at;
      if (status === 'stale' && s.status !== 'stale') {
        newlyStale.push({ station: s.station, lagMin });
        recordEvent(m.id, s.station, 'stale', lagMin, `No new data for ${fmtLag(lagMin)} (threshold ${m.staleMin}m).`);
      } else if (status !== 'stale' && s.status === 'stale') {
        recoveredNow.push({ station: s.station, lagMin });
        recordEvent(m.id, s.station, 'recovered', lagMin, `Data flowing again — latest record ${fmtLag(lagMin)} ago.`);
      }
      upd.run(Math.round(lagMin * 10) / 10, status,
        status === 'stale' ? (s.status === 'stale' ? s.stale_since : ts) : '', m.id, s.station);
    }

    sql.prepare(`INSERT INTO data_monitor_checks (id, monitor_id, at, ok, stations, fresh, warn, stale, max_lag_min, latest_event_at)
      VALUES (?,?,?,1,?,?,?,?,?,?)`)
      .run(uuid(), m.id, ts, streams.length, fresh, warn, stale, maxLag == null ? null : Math.round(maxLag * 10) / 10, latestOverall);

    // ── alerting: on the transition, one message per monitor, cooldown-gated ──
    let state = m.state;
    if (newlyStale.length) {
      state = 'alerting';
      const cooled = !m.lastAlertedAt || (nowMs - new Date(m.lastAlertedAt).getTime()) >= m.cooldownMin * 60000;
      if (cooled) {
        const names = newlyStale.map((x) => x.station).filter(Boolean);
        const worst = Math.max(...newlyStale.map((x) => x.lagMin));
        const bodyMsg = names.length
          ? `${names.length} of ${streams.length} station${streams.length === 1 ? '' : 's'} stopped sending data: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ` +${names.length - 8} more` : ''}. Longest silence ${fmtLag(worst)} (threshold ${m.staleMin}m).`
          : `No new data for ${fmtLag(worst)} (threshold ${m.staleMin}m).`;
        const title = `⛔ Data stream stale — ${m.name || m.area || m.view}`;
        const via = deliver(m, title, bodyMsg);
        recordEvent(m.id, '', 'alert', worst, `${bodyMsg}${via.length ? ` → ${via.join(', ')}` : ' → no channel delivered'}`);
        sql.prepare('UPDATE data_monitors SET last_alerted_at=? WHERE id=?').run(ts, m.id);
      }
    } else if (stale === 0 && m.state === 'alerting') {
      state = 'ok';
      if (m.notifyRecovery) {
        const bodyMsg = streams.length > 1
          ? `All ${streams.length} stations are sending data again.`
          : 'Data is flowing again.';
        const via = deliver(m, `✅ Data stream recovered — ${m.name || m.area || m.view}`, bodyMsg);
        recordEvent(m.id, '', 'recovery_alert', maxLag, `${bodyMsg}${via.length ? ` → ${via.join(', ')}` : ''}`);
      }
    } else if (stale > 0) {
      state = 'alerting'; // still stale (e.g. went stale while paused) — no re-fire, just truthful state
    }

    sql.prepare("UPDATE data_monitors SET last_checked_at=?, last_error='', state=? WHERE id=?").run(ts, state, m.id);
    return { ok: true, stations: streams.length, fresh, warn, stale, maxLagMin: maxLag, latestEventAt: latestOverall, newlyStale, recovered: recoveredNow };
  }

  // ── the tick ──
  const TICK_MS = Number(process.env.DATA_HEALTH_TICK_MS) || 5 * 60000;
  let ticking = false;
  async function tick() {
    if (!enabled() || ticking) return;
    ticking = true;
    try {
      const rows = sql.prepare("SELECT * FROM data_monitors WHERE status='active' AND model<>'' AND view<>'' AND time_field<>''").all().map(rowToMonitor);
      const nowMs = Date.now();
      for (const m of rows) {
        // Per-monitor cadence: skip until its own interval has elapsed.
        if (m.lastCheckedAt && nowMs - new Date(m.lastCheckedAt).getTime() < m.checkEveryMin * 60000 - 5000) continue;
        try { await check(m); } catch (e) { console.error('[data-health] check failed', m.id, e.message); }
      }
      // Keep the logs bounded: pulls are noisy (14d), transitions are history (60d).
      sql.prepare('DELETE FROM data_monitor_checks WHERE at < ?').run(new Date(nowMs - 14 * 86400000).toISOString());
      sql.prepare('DELETE FROM data_monitor_events WHERE at < ?').run(new Date(nowMs - 60 * 86400000).toISOString());
    } finally { ticking = false; }
  }
  const timer = setInterval(() => tick().catch(() => {}), TICK_MS);
  if (timer.unref) timer.unref();
  setTimeout(() => tick().catch(() => {}), 20000); // shortly after boot

  // ── routes (admin-only: this is the internal pipe-health console) ──
  const off = (res) => res.status(404).json({ error: 'Data health monitoring is disabled' });

  app.get('/api/admin/data-health', auth.requireAdmin, (_req, res) => {
    if (!enabled()) return off(res);
    const monitors = sql.prepare('SELECT * FROM data_monitors ORDER BY area, name').all().map(rowToMonitor)
      .map((m) => ({
        ...m,
        streams: streamsFor(m.id),
        lastCheck: sql.prepare('SELECT * FROM data_monitor_checks WHERE monitor_id=? ORDER BY at DESC LIMIT 1').get(m.id) || null,
        recentEvents: sql.prepare('SELECT station, at, kind, lag_min, message FROM data_monitor_events WHERE monitor_id=? ORDER BY at DESC LIMIT 5').all(m.id),
      }));
    res.json({ enabled: true, tickMin: Math.round(TICK_MS / 60000), testMode: testMode(), testEmail: testEmail(), monitors });
  });

  // Test-mode switch: while on, alerts email ONLY the test address (ops Slack +
  // client fan-out muted) — so thresholds can be tuned without paging anyone.
  app.put('/api/admin/data-health/settings', auth.requireAdmin, (req, res) => {
    if (!enabled()) return off(res);
    const b = req.body || {};
    if (typeof b.testMode === 'boolean') db.setSetting('data_health_test_mode', b.testMode ? '1' : '0');
    if (typeof b.testEmail === 'string') {
      const email = b.testEmail.trim().slice(0, 200);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'That test email doesn’t look valid.' });
      db.setSetting('data_health_test_email', email);
    }
    res.json({ testMode: testMode(), testEmail: testEmail() });
  });

  app.post('/api/admin/data-health/monitors', auth.requireAdmin, (req, res) => {
    if (!enabled()) return off(res);
    const c = clean(req.body || {});
    if (!c.name) return res.status(400).json({ error: 'Give the monitor a name.' });
    if (!c.model || !c.view || !c.timeField) return res.status(400).json({ error: 'Pick the explore and its timestamp field.' });
    if (c.staleMin <= c.warnMin) c.warnMin = Math.max(1, Math.floor(c.staleMin / 2));
    res.status(201).json({ monitor: upsert(null, c, req.user.email) });
  });

  app.put('/api/admin/data-health/monitors/:id', auth.requireAdmin, (req, res) => {
    if (!enabled()) return off(res);
    const m = monitorById(req.params.id);
    if (!m) return res.status(404).json({ error: 'Monitor not found' });
    const c = clean({ ...m, ...req.body });
    if (!c.name) return res.status(400).json({ error: 'Give the monitor a name.' });
    if (!c.model || !c.view || !c.timeField) return res.status(400).json({ error: 'Pick the explore and its timestamp field.' });
    if (c.staleMin <= c.warnMin) c.warnMin = Math.max(1, Math.floor(c.staleMin / 2));
    // The explore/split changed → the remembered stations belong to the old feed.
    if (c.model !== m.model || c.view !== m.view || c.timeField !== m.timeField || c.stationField !== m.stationField) {
      sql.prepare('DELETE FROM data_monitor_streams WHERE monitor_id=?').run(m.id);
    }
    res.json({ monitor: upsert(m.id, c, req.user.email) });
  });

  app.delete('/api/admin/data-health/monitors/:id', auth.requireAdmin, (req, res) => {
    if (!enabled()) return off(res);
    sql.prepare('DELETE FROM data_monitors WHERE id=?').run(req.params.id);
    sql.prepare('DELETE FROM data_monitor_streams WHERE monitor_id=?').run(req.params.id);
    sql.prepare('DELETE FROM data_monitor_checks WHERE monitor_id=?').run(req.params.id);
    sql.prepare('DELETE FROM data_monitor_events WHERE monitor_id=?').run(req.params.id);
    res.status(204).end();
  });

  app.post('/api/admin/data-health/monitors/:id/status', auth.requireAdmin, (req, res) => {
    if (!enabled()) return off(res);
    const m = monitorById(req.params.id);
    if (!m) return res.status(404).json({ error: 'Monitor not found' });
    const status = (req.body || {}).status === 'paused' ? 'paused' : 'active';
    sql.prepare('UPDATE data_monitors SET status=?, updated_at=? WHERE id=?').run(status, now(), m.id);
    res.json({ monitor: monitorById(m.id) });
  });

  // Run one pull right now (the editor's "check now" / on-site sanity poke).
  app.post('/api/admin/data-health/monitors/:id/check', auth.requireAdmin, asyncHandler(async (req, res) => {
    if (!enabled()) return off(res);
    const m = monitorById(req.params.id);
    if (!m) return res.status(404).json({ error: 'Monitor not found' });
    const r = await check(m);
    res.json({ ...r, monitor: monitorById(m.id), streams: streamsFor(m.id) });
  }));

  app.get('/api/admin/data-health/monitors/:id/history', auth.requireAdmin, (req, res) => {
    if (!enabled()) return off(res);
    if (!monitorById(req.params.id)) return res.status(404).json({ error: 'Monitor not found' });
    res.json({
      checks: sql.prepare('SELECT at, ok, stations, fresh, warn, stale, max_lag_min, latest_event_at, error FROM data_monitor_checks WHERE monitor_id=? ORDER BY at DESC LIMIT 200').all(req.params.id),
      events: sql.prepare('SELECT station, at, kind, lag_min, message FROM data_monitor_events WHERE monitor_id=? ORDER BY at DESC LIMIT 200').all(req.params.id),
    });
  });

  // Forget one remembered station (device retired / renamed — stop watching it).
  app.delete('/api/admin/data-health/monitors/:id/streams/:station', auth.requireAdmin, (req, res) => {
    if (!enabled()) return off(res);
    sql.prepare('DELETE FROM data_monitor_streams WHERE monitor_id=? AND station=?').run(req.params.id, req.params.station);
    res.json({ ok: true });
  });

  // ── editor metadata: the explore + field pickers (cached, admin-only) ──
  let _models = null, _modelsAt = 0;
  app.get('/api/admin/data-health/explores', auth.requireAdmin, asyncHandler(async (_req, res) => {
    if (!enabled()) return off(res);
    if (!_models || Date.now() - _modelsAt > 10 * 60000) { _models = await looker.listModels(); _modelsAt = Date.now(); }
    res.json({ models: _models });
  }));

  const _fieldCache = new Map();
  app.get('/api/admin/data-health/fields', auth.requireAdmin, asyncHandler(async (req, res) => {
    if (!enabled()) return off(res);
    const { model, view } = req.query || {};
    if (!model || !view) return res.status(400).json({ error: 'model and view required' });
    const key = `${model}::${view}`;
    let hit = _fieldCache.get(key);
    if (!hit || Date.now() - hit.at > 10 * 60000) {
      hit = { at: Date.now(), data: await looker.getExploreFields(String(model), String(view)) };
      _fieldCache.set(key, hit);
    }
    const dims = hit.data.dimensions || [];
    res.json({
      timeFields: dims.filter((d) => /date|time/i.test(d.type || '')),
      dimensions: dims,
    });
  }));

  console.log('[data-health] mounted', enabled() ? '(enabled)' : '(disabled — set data_health_enabled=1)');
  return { check, tick, monitorById, upsert, clean, streamsFor };
}

module.exports = { mount, AREAS, CHANNELS };
