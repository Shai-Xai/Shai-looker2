// ─── Alerts: metric watchers (insight → action) ─────────────────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the `alerts` + `alert_events` tables and
// all /api/alerts routes. Mounted from index.js with one line + injected deps. A
// background tick (default 5 min) evaluates every active rule against the live
// number off a dashboard tile (the SAME scope-enforced path goals use), and fires
// — once, on the transition — through the inbox, push, email and SMS. Kill switch:
// settings key `alerts_enabled` ('0' disables the tick + 404s the routes). To
// remove the whole feature: delete this file + that line, then drop the alert_*
// tables. Nothing else depends on it.
//
// Why a tile is the source: a client already looks at "Total tickets sold", "GA
// remaining", "Revenue" as single-value tiles. Pointing an alert at that tile
// reuses the entire per-tenant scope boundary (applyScope) — an alert can never
// read another client's data, and the number it watches == the number on screen.
//
// The hard parts (the real deliverable) live here:
//   • edge-detection — fire on the cross (armed → triggered), never every tick;
//   • cooldown — a flapping metric can't spam a phone during an on-sale;
//   • quiet hours — non-critical alerts hold until morning (important ones break through);
//   • per-event scope — every evaluation runs as a synthetic user locked to the
//     alert's entity, so the background job is scoped exactly like a client request.

const crypto = require('crypto');

const DEFAULT_TZ = 'Africa/Johannesburg'; // GMT+2
const RULE_TYPES = ['threshold', 'depletion', 'sold_out'];
const OPERATORS = ['gte', 'lte', 'gt', 'lt'];
const CHANNELS = ['push', 'email', 'sms'];        // inbox is always-on (the canonical record)
const FREQUENCIES = ['once', 'repeat'];
const PRIORITIES = ['normal', 'important'];

function mount(app, { db, auth, resolveTileValue, os, mailer, push, messaging }) {
  const sql = db.db;
  const now = () => new Date().toISOString();
  const uuid = () => crypto.randomUUID();
  const enabled = () => db.getSetting('alerts_enabled', '1') !== '0'; // on by default; kill switch

  sql.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id            TEXT PRIMARY KEY,
      entity_id     TEXT NOT NULL,
      suite_id      TEXT NOT NULL,
      name          TEXT NOT NULL DEFAULT '',
      rule_type     TEXT NOT NULL DEFAULT 'threshold',  -- threshold | depletion | sold_out
      dashboard_id  TEXT NOT NULL DEFAULT '',
      tile_id       TEXT NOT NULL DEFAULT '',
      dashboard_name TEXT NOT NULL DEFAULT '',           -- remembered for display + portability
      tile_name     TEXT NOT NULL DEFAULT '',
      operator      TEXT NOT NULL DEFAULT 'gte',         -- gte | lte | gt | lt
      threshold     REAL NOT NULL DEFAULT 0,
      unit          TEXT NOT NULL DEFAULT '',
      channels      TEXT NOT NULL DEFAULT '["push"]',    -- subset of push|email|sms
      sms_recipients TEXT NOT NULL DEFAULT '[]',          -- phone numbers (E.164-ish) for the sms channel
      priority      TEXT NOT NULL DEFAULT 'normal',       -- normal | important (important breaks quiet hours)
      frequency     TEXT NOT NULL DEFAULT 'once',         -- once (fire then rest) | repeat (re-arm on clear)
      cooldown_min  INTEGER NOT NULL DEFAULT 60,          -- min minutes between re-fires (repeat)
      quiet_start   TEXT NOT NULL DEFAULT '',             -- 'HH:MM' local; '' = no quiet window
      quiet_end     TEXT NOT NULL DEFAULT '',
      timezone      TEXT NOT NULL DEFAULT '${DEFAULT_TZ}',
      status        TEXT NOT NULL DEFAULT 'active',       -- active | paused
      state         TEXT NOT NULL DEFAULT 'armed',        -- armed | triggered (edge-detection)
      last_value    REAL,
      last_checked_at TEXT NOT NULL DEFAULT '',
      last_fired_at TEXT NOT NULL DEFAULT '',
      fire_count    INTEGER NOT NULL DEFAULT 0,
      created_by    TEXT NOT NULL DEFAULT '',
      created_at    TEXT NOT NULL,
      updated_by    TEXT NOT NULL DEFAULT '',
      updated_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_suite ON alerts(suite_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts(status);

    CREATE TABLE IF NOT EXISTS alert_events (
      id         TEXT PRIMARY KEY,
      alert_id   TEXT NOT NULL,
      entity_id  TEXT NOT NULL,
      at         TEXT NOT NULL,
      value      REAL,
      threshold  REAL,
      message    TEXT NOT NULL DEFAULT '',
      channels   TEXT NOT NULL DEFAULT '[]',  -- what we actually fanned out to
      status     TEXT NOT NULL DEFAULT 'fired' -- fired | suppressed (cooldown) | error
    );
    CREATE INDEX IF NOT EXISTS idx_alert_events ON alert_events(alert_id, at);
  `);

  const parseJson = (s, fb) => { try { const v = JSON.parse(s); return v == null ? fb : v; } catch { return fb; } };
  const isAdmin = (u) => u && u.role === 'admin';

  function rowToAlert(r) {
    if (!r) return null;
    return {
      id: r.id, entityId: r.entity_id, suiteId: r.suite_id, name: r.name, ruleType: r.rule_type,
      dashboardId: r.dashboard_id, tileId: r.tile_id, dashboardName: r.dashboard_name, tileName: r.tile_name,
      operator: r.operator, threshold: r.threshold, unit: r.unit,
      channels: parseJson(r.channels, ['push']), smsRecipients: parseJson(r.sms_recipients, []),
      priority: r.priority, frequency: r.frequency, cooldownMin: r.cooldown_min,
      quietStart: r.quiet_start, quietEnd: r.quiet_end, timezone: r.timezone,
      status: r.status, state: r.state, lastValue: r.last_value,
      lastCheckedAt: r.last_checked_at, lastFiredAt: r.last_fired_at, fireCount: r.fire_count,
      createdBy: r.created_by, createdAt: r.created_at, updatedBy: r.updated_by, updatedAt: r.updated_at,
    };
  }
  const alertById = (id) => rowToAlert(sql.prepare('SELECT * FROM alerts WHERE id=?').get(id));
  const listForSuite = (suiteId) => sql.prepare('SELECT * FROM alerts WHERE suite_id=? ORDER BY created_at DESC').all(suiteId).map(rowToAlert);
  const eventsFor = (alertId, limit = 30) => sql.prepare('SELECT * FROM alert_events WHERE alert_id=? ORDER BY at DESC LIMIT ?').all(alertId, limit)
    .map((e) => ({ id: e.id, at: e.at, value: e.value, threshold: e.threshold, message: e.message, channels: parseJson(e.channels, []), status: e.status }));

  // ── sanitise an incoming rule from the client ──
  function clean(b, entityId, suiteId) {
    const ruleType = RULE_TYPES.includes(b.ruleType) ? b.ruleType : 'threshold';
    // Each archetype implies how it compares; sold-out is "at or below zero".
    let operator = OPERATORS.includes(b.operator) ? b.operator : 'gte';
    let threshold = Number(b.threshold);
    if (ruleType === 'depletion') operator = 'lte';
    if (ruleType === 'sold_out') { operator = 'lte'; if (!Number.isFinite(threshold)) threshold = 0; }
    if (!Number.isFinite(threshold)) threshold = 0;
    const channels = Array.isArray(b.channels) ? [...new Set(b.channels.filter((c) => CHANNELS.includes(c)))] : [];
    return {
      entityId, suiteId,
      name: String(b.name || '').slice(0, 120),
      ruleType,
      dashboardId: String(b.dashboardId || '').slice(0, 64),
      tileId: String(b.tileId || '').slice(0, 64),
      dashboardName: String(b.dashboardName || '').slice(0, 200),
      tileName: String(b.tileName || '').slice(0, 200),
      operator, threshold,
      unit: String(b.unit || '').slice(0, 16),
      channels: channels.length ? channels : ['push'],
      smsRecipients: Array.isArray(b.smsRecipients)
        ? [...new Set(b.smsRecipients.map((p) => String(p).replace(/[^\d+]/g, '')).filter((p) => p.replace(/\D/g, '').length >= 7))].slice(0, 25) : [],
      priority: PRIORITIES.includes(b.priority) ? b.priority : 'normal',
      frequency: FREQUENCIES.includes(b.frequency) ? b.frequency : 'once',
      cooldownMin: Number.isFinite(Number(b.cooldownMin)) ? Math.max(0, Math.min(10080, Math.round(Number(b.cooldownMin)))) : 60,
      quietStart: /^\d{1,2}:\d{2}$/.test(b.quietStart || '') ? b.quietStart : '',
      quietEnd: /^\d{1,2}:\d{2}$/.test(b.quietEnd || '') ? b.quietEnd : '',
      timezone: String(b.timezone || DEFAULT_TZ).slice(0, 64),
      status: b.status === 'paused' ? 'paused' : 'active',
    };
  }

  // Editing a rule re-arms it: the threshold/tile/condition may have changed, so a
  // stale "triggered" state shouldn't suppress the next genuine cross.
  function upsert(id, c, who) {
    const ts = now();
    if (id) {
      sql.prepare(`UPDATE alerts SET name=?, rule_type=?, dashboard_id=?, tile_id=?, dashboard_name=?, tile_name=?,
        operator=?, threshold=?, unit=?, channels=?, sms_recipients=?, priority=?, frequency=?, cooldown_min=?,
        quiet_start=?, quiet_end=?, timezone=?, status=?, state='armed', updated_by=?, updated_at=? WHERE id=?`)
        .run(c.name, c.ruleType, c.dashboardId, c.tileId, c.dashboardName, c.tileName, c.operator, c.threshold, c.unit,
          JSON.stringify(c.channels), JSON.stringify(c.smsRecipients), c.priority, c.frequency, c.cooldownMin,
          c.quietStart, c.quietEnd, c.timezone, c.status, who || '', ts, id);
      return alertById(id);
    }
    const nid = uuid();
    sql.prepare(`INSERT INTO alerts (id, entity_id, suite_id, name, rule_type, dashboard_id, tile_id, dashboard_name, tile_name,
      operator, threshold, unit, channels, sms_recipients, priority, frequency, cooldown_min, quiet_start, quiet_end, timezone,
      status, state, created_by, created_at, updated_by, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'armed',?,?,?,?)`)
      .run(nid, c.entityId, c.suiteId, c.name, c.ruleType, c.dashboardId, c.tileId, c.dashboardName, c.tileName,
        c.operator, c.threshold, c.unit, JSON.stringify(c.channels), JSON.stringify(c.smsRecipients), c.priority, c.frequency,
        c.cooldownMin, c.quietStart, c.quietEnd, c.timezone, c.status, who || '', ts, who || '', ts);
    return alertById(nid);
  }

  // ── the condition + the wording ──
  function conditionMet(operator, value, threshold) {
    if (value == null || !Number.isFinite(Number(value))) return false;
    const v = Number(value);
    if (operator === 'gte') return v >= threshold;
    if (operator === 'lte') return v <= threshold;
    if (operator === 'gt') return v > threshold;
    if (operator === 'lt') return v < threshold;
    return false;
  }
  function fmtNum(v, unit) {
    if (v == null) return '—';
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    const s = Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-ZA') : String(n);
    if (unit === 'ZAR') return `R${s}`;
    if (unit === '%') return `${s}%`;
    return unit && unit !== 'count' ? `${s} ${unit}` : s;
  }
  // A plain-English line for the notification body. Kept template-driven for Wave 1
  // (the AI-written version is a later wave). The metric label is the tile's title.
  function buildMessage(a, value) {
    const metric = a.tileName || a.name || 'A metric';
    const val = fmtNum(value, a.unit);
    if (a.ruleType === 'sold_out') return `🎉 Sold out — ${metric} reached ${val}.`;
    if (a.ruleType === 'depletion') return `⚠️ Low stock — only ${val} left on ${metric} (alert set below ${fmtNum(a.threshold, a.unit)}).`;
    // threshold
    const dir = (a.operator === 'lte' || a.operator === 'lt') ? 'dropped to' : 'reached';
    return `📈 ${metric} ${dir} ${val} (alert at ${fmtNum(a.threshold, a.unit)}).`;
  }
  function emoji(a) { return a.ruleType === 'sold_out' ? '🎉' : a.ruleType === 'depletion' ? '⚠️' : '📈'; }

  // ── quiet hours (timezone-aware) ──
  // Local HH:MM in the alert's timezone, compared against [quietStart, quietEnd).
  // Supports windows that wrap midnight (e.g. 22:00 → 07:00).
  function localHHMM(tz, date = new Date()) {
    try {
      const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(date);
      const hh = p.find((x) => x.type === 'hour')?.value || '00';
      const mm = p.find((x) => x.type === 'minute')?.value || '00';
      return `${hh}:${mm}`;
    } catch { return null; }
  }
  function inQuietHours(a, date = new Date()) {
    if (!a.quietStart || !a.quietEnd) return false;
    const t = localHHMM(a.timezone || DEFAULT_TZ, date);
    if (t == null) return false;
    const s = a.quietStart, e = a.quietEnd;
    if (s === e) return false;
    return s < e ? (t >= s && t < e) : (t >= s || t < e); // wraps midnight
  }

  // ── evaluation as a scoped, synthetic user ──
  // Background ticks have no request user. We synthesise a CLIENT user locked to the
  // alert's entity so applyScope (inside resolveTileValue) enforces the very same
  // per-tenant boundary a real client request gets — never admin (admin is unscoped).
  function evalUser(a) {
    return { id: `alert:${a.entityId}`, email: a.createdBy || 'alerts@howler', role: 'client', entityIds: [a.entityId] };
  }
  async function readValue(a) {
    if (typeof resolveTileValue !== 'function' || !a.dashboardId || !a.tileId || !a.suiteId) return null;
    try {
      const v = await resolveTileValue({ dashboardId: a.dashboardId, tileId: a.tileId, user: evalUser(a), suiteId: a.suiteId });
      return v == null ? null : Number(v);
    } catch (e) { console.error('[alerts] tile read failed', a.id, e.message); return null; }
  }

  // ── deliver: inbox (always) + email/push (via the OS spine) + SMS (direct) ──
  function deliver(a, value, message) {
    const delivered = ['inbox'];
    const emailPush = (a.channels || []).filter((c) => c === 'email' || c === 'push');
    // The OS spine posts ONE thread per alert (subjectType/subjectId), re-raising it
    // each fire, and fans out to the entity team honouring each user's notify prefs.
    try {
      if (os?.announce) {
        os.announce({
          entityId: a.entityId,
          title: `${emoji(a)} ${a.name || 'Alert'}`,
          body: message,
          priority: a.priority === 'important' ? 'normal' : 'fyi',
          createdBy: 'alerts', authorType: 'system',
          channels: emailPush,            // [] => inbox only (no email/push fan-out)
          subjectType: 'alert', subjectId: a.id,
        });
        for (const c of emailPush) delivered.push(c);
      }
    } catch (e) { console.error('[alerts] inbox/announce failed', a.id, e.message); }
    // SMS goes direct to the alert's configured numbers (the OS spine doesn't do SMS).
    if ((a.channels || []).includes('sms') && messaging?.sendSms && (a.smsRecipients || []).length) {
      const link = mailer?.baseUrl ? mailer.baseUrl() : '';
      const text = `${message}${link ? `\n${link}` : ''}`.slice(0, 600);
      for (const to of a.smsRecipients) messaging.sendSms({ to, text }).catch(() => {});
      delivered.push('sms');
    }
    return [...new Set(delivered)];
  }

  function recordEvent(a, value, message, channels, status) {
    sql.prepare('INSERT INTO alert_events (id, alert_id, entity_id, at, value, threshold, message, channels, status) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(uuid(), a.id, a.entityId, now(), value, a.threshold, message, JSON.stringify(channels || []), status);
  }

  // Evaluate ONE alert: read the live value, run the edge-detection state machine,
  // and fire/suppress/hold accordingly. `manual` (a test from the editor) ignores
  // quiet hours + cooldown and always delivers, without disturbing the live state.
  async function evaluate(a, { manual = false } = {}) {
    const value = await readValue(a);
    const ts = now();
    const met = conditionMet(a.operator, value, a.threshold);

    if (manual) {
      const message = buildMessage(a, value == null ? a.threshold : value);
      const channels = deliver(a, value, message);
      recordEvent(a, value, message, channels, 'fired');
      return { value, met, message, channels, fired: true, manual: true };
    }

    let { state } = a;
    let fired = false, suppressed = false, held = false, message = '';
    if (met && state === 'armed') {
      if (inQuietHours(a) && a.priority !== 'important') {
        held = true; // hold until the quiet window passes; leave state armed so it fires later
      } else {
        state = 'triggered';
        const cooled = !a.lastFiredAt || (Date.now() - new Date(a.lastFiredAt).getTime()) >= a.cooldownMin * 60000;
        message = buildMessage(a, value);
        if (cooled) {
          const channels = deliver(a, value, message);
          recordEvent(a, value, message, channels, 'fired');
          fired = true;
        } else {
          recordEvent(a, value, message, [], 'suppressed'); // crossed again inside cooldown — logged, not sent
          suppressed = true;
        }
      }
    } else if (!met && state === 'triggered') {
      // Cleared. Repeat alerts re-arm so the next cross fires again; once-alerts rest.
      if (a.frequency === 'repeat') state = 'armed';
    }

    sql.prepare('UPDATE alerts SET last_value=?, last_checked_at=?, state=?, last_fired_at=?, fire_count=? WHERE id=?')
      .run(value, ts, state, fired ? ts : a.lastFiredAt, a.fireCount + (fired ? 1 : 0), a.id);
    return { value, met, state, fired, suppressed, held, message };
  }

  // ── the tick ──
  // Own cadence (default 5 min), aligned to the ~30-min Looker pipeline + the query
  // cache so we read fresh-ish numbers without hammering Looker. Re-entrancy guard:
  // a sweep does live Looker reads, so an overlapping tick is a no-op until it drains.
  const TICK_MS = Number(process.env.ALERTS_TICK_MS) || 5 * 60000;
  let ticking = false;
  async function tick() {
    if (!enabled() || ticking) return;
    ticking = true;
    try {
      const due = sql.prepare("SELECT * FROM alerts WHERE status='active' AND dashboard_id<>'' AND tile_id<>''").all().map(rowToAlert);
      for (const a of due) { try { await evaluate(a); } catch (e) { console.error('[alerts] evaluate failed', a.id, e.message); } }
    } finally { ticking = false; }
  }
  const timer = setInterval(() => tick().catch(() => {}), TICK_MS);
  if (timer.unref) timer.unref();
  setTimeout(() => tick().catch(() => {}), 15000); // shortly after boot

  // ── access guards (mirror goals: admin OR an entity member with alerts.manage) ──
  const canView = (user, suiteId) => isAdmin(user) || auth.canAccessSuite(user, suiteId);
  function canManage(user, suiteId) {
    if (isAdmin(user)) return true;
    const su = db.getSuite(suiteId);
    return !!su && auth.canAccessSuite(user, suiteId) && auth.hasPermission(user, su.entityId, 'alerts.manage');
  }
  const off = (res) => res.status(404).json({ error: 'Alerts are disabled' });

  // ── routes (one guarded set serves admin + client self-service, keyed by suite) ──
  // List a suite's alerts (with recent fires inline for the history view).
  app.get('/api/alerts/suites/:suiteId', auth.requireAuth, (req, res) => {
    if (!enabled()) return off(res);
    const su = db.getSuite(req.params.suiteId);
    if (!su) return res.status(404).json({ error: 'Event not found' });
    if (!canView(req.user, req.params.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    const alerts = listForSuite(req.params.suiteId).map((a) => ({ ...a, recent: eventsFor(a.id, 5) }));
    res.json({ alerts, canManage: canManage(req.user, req.params.suiteId), smsAvailable: !!(messaging?.status?.() || {}).configured });
  });

  app.post('/api/alerts/suites/:suiteId', auth.requireAuth, (req, res) => {
    if (!enabled()) return off(res);
    const su = db.getSuite(req.params.suiteId);
    if (!su) return res.status(404).json({ error: 'Event not found' });
    if (!canManage(req.user, req.params.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    const c = clean(req.body || {}, su.entityId, su.id);
    if (!c.name) return res.status(400).json({ error: 'Give the alert a name.' });
    if (!c.dashboardId || !c.tileId) return res.status(400).json({ error: 'Pick the dashboard tile to watch.' });
    res.status(201).json({ alert: upsert(null, c, req.user.email) });
  });

  app.put('/api/alerts/:id', auth.requireAuth, (req, res) => {
    if (!enabled()) return off(res);
    const a = alertById(req.params.id);
    if (!a) return res.status(404).json({ error: 'Alert not found' });
    if (!canManage(req.user, a.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    const c = clean({ ...a, ...req.body }, a.entityId, a.suiteId);
    if (!c.name) return res.status(400).json({ error: 'Give the alert a name.' });
    if (!c.dashboardId || !c.tileId) return res.status(400).json({ error: 'Pick the dashboard tile to watch.' });
    res.json({ alert: upsert(a.id, c, req.user.email) });
  });

  app.delete('/api/alerts/:id', auth.requireAuth, (req, res) => {
    if (!enabled()) return off(res);
    const a = alertById(req.params.id);
    if (!a) return res.status(404).json({ error: 'Alert not found' });
    if (!canManage(req.user, a.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    sql.prepare('DELETE FROM alerts WHERE id=?').run(a.id);
    sql.prepare('DELETE FROM alert_events WHERE alert_id=?').run(a.id);
    res.status(204).end();
  });

  // Pause / resume without losing the rule (re-arms on resume).
  app.post('/api/alerts/:id/status', auth.requireAuth, (req, res) => {
    if (!enabled()) return off(res);
    const a = alertById(req.params.id);
    if (!a) return res.status(404).json({ error: 'Alert not found' });
    if (!canManage(req.user, a.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    const status = (req.body || {}).status === 'paused' ? 'paused' : 'active';
    sql.prepare("UPDATE alerts SET status=?, state='armed', updated_at=? WHERE id=?").run(status, now(), a.id);
    res.json({ alert: alertById(a.id) });
  });

  // Full history for one alert.
  app.get('/api/alerts/:id/events', auth.requireAuth, (req, res) => {
    if (!enabled()) return off(res);
    const a = alertById(req.params.id);
    if (!a) return res.status(404).json({ error: 'Alert not found' });
    if (!canView(req.user, a.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    res.json({ events: eventsFor(a.id, 100) });
  });

  // Send a test fire now (real delivery, current value) so you can see exactly what
  // lands — without touching the live armed/triggered state.
  app.post('/api/alerts/:id/test', auth.requireAuth, async (req, res) => {
    if (!enabled()) return off(res);
    const a = alertById(req.params.id);
    if (!a) return res.status(404).json({ error: 'Alert not found' });
    if (!canManage(req.user, a.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    try { const r = await evaluate(a, { manual: true }); res.json({ ok: true, value: r.value, message: r.message, channels: r.channels }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Live value of a chosen tile (for the editor preview) — read-only, scope enforced
  // inside resolveTileValue. Mirrors the goals tile-value endpoint.
  app.post('/api/alerts/suites/:suiteId/tile-value', auth.requireAuth, async (req, res) => {
    if (!enabled()) return off(res);
    if (!db.getSuite(req.params.suiteId)) return res.status(404).json({ error: 'Event not found' });
    if (!canView(req.user, req.params.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    const { dashboardId, tileId } = req.body || {};
    if (!dashboardId || !tileId) return res.status(400).json({ error: 'dashboardId and tileId required' });
    try {
      const value = await resolveTileValue({ dashboardId, tileId, user: req.user, suiteId: req.params.suiteId });
      res.json({ value: value == null ? null : Number(value) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Status (client uses it to decide whether to show the feature).
  app.get('/api/alerts/status', auth.requireAuth, (req, res) => res.json({ enabled: enabled() }));

  console.log('[alerts] mounted', enabled() ? '(enabled)' : '(disabled — set alerts_enabled=1)');
  return { evaluate, tick };
}

module.exports = { mount };
