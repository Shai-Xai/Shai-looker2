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
const CHANNELS = ['push', 'email', 'sms', 'slack']; // inbox is always-on (the canonical record)
const FREQUENCIES = ['once', 'repeat'];
const PRIORITIES = ['normal', 'important'];

function mount(app, { db, auth, resolveTileValue, resolveCustomMetric, metricCatalog, metricFilterValues, os, mailer, push, messaging, slack }) {
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
      source        TEXT NOT NULL DEFAULT 'tile',        -- tile | metric (raw measure + filter, no tile needed)
      dashboard_id  TEXT NOT NULL DEFAULT '',
      tile_id       TEXT NOT NULL DEFAULT '',
      dashboard_name TEXT NOT NULL DEFAULT '',           -- remembered for display + portability
      tile_name     TEXT NOT NULL DEFAULT '',
      model         TEXT NOT NULL DEFAULT '',            -- (metric source) Looker model
      view          TEXT NOT NULL DEFAULT '',            -- (metric source) explore
      measure       TEXT NOT NULL DEFAULT '',            -- (metric source) measure field
      measure_label TEXT NOT NULL DEFAULT '',            -- (metric source) human measure label
      metric_filters TEXT NOT NULL DEFAULT '{}',          -- (metric source) {field: value} dimension filters
      metric_label  TEXT NOT NULL DEFAULT '',            -- (metric source) "Tickets sold · Ticket Type = VIP"
      operator      TEXT NOT NULL DEFAULT 'gte',         -- gte | lte | gt | lt
      threshold     REAL NOT NULL DEFAULT 0,
      unit          TEXT NOT NULL DEFAULT '',
      tag           TEXT NOT NULL DEFAULT '',            -- operational area (Ticketing, Cashless…); groups the list one row per tag
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

    -- Reusable alert setups. scope 'entity' = one client's; 'global' = a platform
    -- template Howler publishes to every client (re-links tiles by name; metric
    -- refs port directly on the shared LookML model). Mirrors goal_templates.
    CREATE TABLE IF NOT EXISTS alert_templates (
      id         TEXT PRIMARY KEY,
      entity_id  TEXT NOT NULL DEFAULT '',
      scope      TEXT NOT NULL DEFAULT 'entity',  -- entity | global
      name       TEXT NOT NULL,
      payload    TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alert_templates ON alert_templates(entity_id);
  `);

  // Additive migrations for DBs created before the "metric" (tile-less) source.
  try {
    const cols = sql.prepare('PRAGMA table_info(alerts)').all().map((c) => c.name);
    const add = (name, ddl) => { if (!cols.includes(name)) sql.exec(`ALTER TABLE alerts ADD COLUMN ${ddl}`); };
    add('source', "source TEXT NOT NULL DEFAULT 'tile'");
    add('model', "model TEXT NOT NULL DEFAULT ''");
    add('view', "view TEXT NOT NULL DEFAULT ''");
    add('measure', "measure TEXT NOT NULL DEFAULT ''");
    add('measure_label', "measure_label TEXT NOT NULL DEFAULT ''");
    add('metric_filters', "metric_filters TEXT NOT NULL DEFAULT '{}'");
    add('metric_label', "metric_label TEXT NOT NULL DEFAULT ''");
    add('tag', "tag TEXT NOT NULL DEFAULT ''");
  } catch (e) { console.error('[alerts] column migration skipped:', e.message); }

  const parseJson = (s, fb) => { try { const v = JSON.parse(s); return v == null ? fb : v; } catch { return fb; } };
  const isAdmin = (u) => u && u.role === 'admin';

  function rowToAlert(r) {
    if (!r) return null;
    return {
      id: r.id, entityId: r.entity_id, suiteId: r.suite_id, name: r.name, ruleType: r.rule_type,
      source: r.source || 'tile',
      dashboardId: r.dashboard_id, tileId: r.tile_id, dashboardName: r.dashboard_name, tileName: r.tile_name,
      model: r.model || '', view: r.view || '', measure: r.measure || '', measureLabel: r.measure_label || '',
      metricFilters: parseJson(r.metric_filters, {}), metricLabel: r.metric_label || '',
      operator: r.operator, threshold: r.threshold, unit: r.unit, tag: r.tag || '',
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
    const source = b.source === 'metric' ? 'metric' : 'tile';
    // Metric-source filters: { dimensionField: value }. Both keyed + value are strings;
    // applied to the raw measure query (scope is still forced on server-side).
    const mf = {};
    if (b.metricFilters && typeof b.metricFilters === 'object' && !Array.isArray(b.metricFilters)) {
      for (const [k, v] of Object.entries(b.metricFilters).slice(0, 10)) {
        if (k && v != null && String(v).trim()) mf[String(k).slice(0, 200)] = String(v).slice(0, 500);
      }
    }
    return {
      entityId, suiteId,
      name: String(b.name || '').slice(0, 120),
      ruleType, source,
      dashboardId: String(b.dashboardId || '').slice(0, 64),
      tileId: String(b.tileId || '').slice(0, 64),
      dashboardName: String(b.dashboardName || '').slice(0, 200),
      tileName: String(b.tileName || '').slice(0, 200),
      model: String(b.model || '').slice(0, 120),
      view: String(b.view || '').slice(0, 120),
      measure: String(b.measure || '').slice(0, 200),
      measureLabel: String(b.measureLabel || '').slice(0, 200),
      metricFilters: mf,
      metricLabel: String(b.metricLabel || '').slice(0, 240),
      operator, threshold,
      unit: String(b.unit || '').slice(0, 16),
      tag: String(b.tag || '').trim().slice(0, 40),
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
      sql.prepare(`UPDATE alerts SET name=?, rule_type=?, source=?, dashboard_id=?, tile_id=?, dashboard_name=?, tile_name=?,
        model=?, view=?, measure=?, measure_label=?, metric_filters=?, metric_label=?,
        operator=?, threshold=?, unit=?, tag=?, channels=?, sms_recipients=?, priority=?, frequency=?, cooldown_min=?,
        quiet_start=?, quiet_end=?, timezone=?, status=?, state='armed', updated_by=?, updated_at=? WHERE id=?`)
        .run(c.name, c.ruleType, c.source, c.dashboardId, c.tileId, c.dashboardName, c.tileName,
          c.model, c.view, c.measure, c.measureLabel, JSON.stringify(c.metricFilters), c.metricLabel,
          c.operator, c.threshold, c.unit, c.tag, JSON.stringify(c.channels), JSON.stringify(c.smsRecipients), c.priority, c.frequency, c.cooldownMin,
          c.quietStart, c.quietEnd, c.timezone, c.status, who || '', ts, id);
      return alertById(id);
    }
    const nid = uuid();
    sql.prepare(`INSERT INTO alerts (id, entity_id, suite_id, name, rule_type, source, dashboard_id, tile_id, dashboard_name, tile_name,
      model, view, measure, measure_label, metric_filters, metric_label,
      operator, threshold, unit, tag, channels, sms_recipients, priority, frequency, cooldown_min, quiet_start, quiet_end, timezone,
      status, state, created_by, created_at, updated_by, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'armed',?,?,?,?)`)
      .run(nid, c.entityId, c.suiteId, c.name, c.ruleType, c.source, c.dashboardId, c.tileId, c.dashboardName, c.tileName,
        c.model, c.view, c.measure, c.measureLabel, JSON.stringify(c.metricFilters), c.metricLabel,
        c.operator, c.threshold, c.unit, c.tag, JSON.stringify(c.channels), JSON.stringify(c.smsRecipients), c.priority, c.frequency,
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
  function fmtNum(v, unit, moneySym = 'R') {
    if (v == null) return '—';
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    const s = Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-ZA') : String(n);
    if (unit === 'ZAR') return `${moneySym}${s}`; // 'ZAR' is the generic money unit; symbol follows the client's reporting currency
    if (unit === '%') return `${s}%`;
    return unit && unit !== 'count' ? `${s} ${unit}` : s;
  }
  // The client's reporting-currency symbol for a money alert (defaults to R / ZAR).
  function moneySymFor(a) {
    try { return require('./currency').symbolFor(mailer.resolveBranding(a.entityId, a.suiteId).currency); }
    catch { return 'R'; }
  }
  // A plain-English line for the notification body. Kept template-driven for Wave 1
  // (the AI-written version is a later wave). The metric label is the tile's title.
  function buildMessage(a, value) {
    const metric = (a.source === 'metric' ? (a.metricLabel || a.measureLabel) : a.tileName) || a.name || 'A metric';
    const sym = moneySymFor(a);
    const val = fmtNum(value, a.unit, sym);
    if (a.ruleType === 'sold_out') return `🎉 Sold out — ${metric} reached ${val}.`;
    if (a.ruleType === 'depletion') return `⚠️ Low stock — only ${val} left on ${metric} (alert set below ${fmtNum(a.threshold, a.unit, sym)}).`;
    // threshold
    const dir = (a.operator === 'lte' || a.operator === 'lt') ? 'dropped to' : 'reached';
    return `📈 ${metric} ${dir} ${val} (alert at ${fmtNum(a.threshold, a.unit, sym)}).`;
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
    if (!a.suiteId) return null;
    try {
      if (a.source === 'metric') {
        if (typeof resolveCustomMetric !== 'function' || !a.model || !a.view || !a.measure) return null;
        const v = await resolveCustomMetric({ model: a.model, view: a.view, measure: a.measure, filters: a.metricFilters || {}, user: evalUser(a), suiteId: a.suiteId });
        return v == null ? null : Number(v);
      }
      if (typeof resolveTileValue !== 'function' || !a.dashboardId || !a.tileId) return null;
      const v = await resolveTileValue({ dashboardId: a.dashboardId, tileId: a.tileId, user: evalUser(a), suiteId: a.suiteId });
      return v == null ? null : Number(v);
    } catch (e) { console.error('[alerts] value read failed', a.id, e.message); return null; }
  }

  // ── deliver: inbox (always) + email/push (via the OS spine) + SMS (direct) ──
  function deliver(a, value, message) {
    const delivered = ['inbox'];
    // email/push/slack all fan out through the OS spine; Slack fires only when the
    // alert explicitly opted into it (it's a ticked channel, not an auto-mirror).
    const osChannels = (a.channels || []).filter((c) => c === 'email' || c === 'push' || c === 'slack');
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
          channels: osChannels,           // [] => inbox only (no email/push/slack fan-out)
          subjectType: 'alert', subjectId: a.id,
        });
        for (const c of osChannels) delivered.push(c);
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
          // Claim BEFORE delivering (mark-before-send): if the process dies
          // mid-delivery the cooldown stops the next tick re-firing this alert —
          // a crash can drop one notification, never spam repeats. The final
          // UPDATE below re-writes the same values, so this stays idempotent.
          sql.prepare('UPDATE alerts SET state=?, last_fired_at=?, fire_count=? WHERE id=?')
            .run('triggered', ts, a.fireCount + 1, a.id);
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
      const due = sql.prepare(`SELECT * FROM alerts WHERE status='active'
        AND ((source='tile' AND dashboard_id<>'' AND tile_id<>'') OR (source='metric' AND measure<>''))`).all().map(rowToAlert);
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
    res.json({ alerts, canManage: canManage(req.user, req.params.suiteId), smsAvailable: !!(messaging?.status?.() || {}).configured, slackAvailable: !!(slack?.isConfigured?.(su.entityId)) });
  });

  app.post('/api/alerts/suites/:suiteId', auth.requireAuth, (req, res) => {
    if (!enabled()) return off(res);
    const su = db.getSuite(req.params.suiteId);
    if (!su) return res.status(404).json({ error: 'Event not found' });
    if (!canManage(req.user, req.params.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    const c = clean(req.body || {}, su.entityId, su.id);
    if (!c.name) return res.status(400).json({ error: 'Give the alert a name.' });
    if (c.source === 'metric') { if (!c.model || !c.view || !c.measure) return res.status(400).json({ error: 'Pick the metric to watch.' }); }
    else if (!c.dashboardId || !c.tileId) return res.status(400).json({ error: 'Pick the dashboard tile to watch.' });
    res.status(201).json({ alert: upsert(null, c, req.user.email) });
  });

  app.put('/api/alerts/:id', auth.requireAuth, (req, res) => {
    if (!enabled()) return off(res);
    const a = alertById(req.params.id);
    if (!a) return res.status(404).json({ error: 'Alert not found' });
    if (!canManage(req.user, a.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    const c = clean({ ...a, ...req.body }, a.entityId, a.suiteId);
    if (!c.name) return res.status(400).json({ error: 'Give the alert a name.' });
    if (c.source === 'metric') { if (!c.model || !c.view || !c.measure) return res.status(400).json({ error: 'Pick the metric to watch.' }); }
    else if (!c.dashboardId || !c.tileId) return res.status(400).json({ error: 'Pick the dashboard tile to watch.' });
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

  // ── Custom-metric source (alert on a raw measure + dimension filter, no tile) ──
  // The catalogue is constrained to the explores the client's dashboards already
  // use, which is exactly the set where the per-tenant scope boundary resolves —
  // so a metric alert can never reach an unscoped explore.
  app.get('/api/alerts/suites/:suiteId/metric-catalog', auth.requireAuth, async (req, res) => {
    if (!enabled()) return off(res);
    const su = db.getSuite(req.params.suiteId);
    if (!su) return res.status(404).json({ error: 'Event not found' });
    if (!canView(req.user, req.params.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    if (typeof metricCatalog !== 'function') return res.json({ explores: [] });
    try { res.json(await metricCatalog(su.entityId)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Live value of a built metric (for the editor preview), scope enforced server-side.
  app.post('/api/alerts/suites/:suiteId/metric-value', auth.requireAuth, async (req, res) => {
    if (!enabled()) return off(res);
    if (!db.getSuite(req.params.suiteId)) return res.status(404).json({ error: 'Event not found' });
    if (!canView(req.user, req.params.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    const { model, view, measure, filters } = req.body || {};
    if (!model || !view || !measure) return res.status(400).json({ error: 'model, view and measure required' });
    try {
      const value = await resolveCustomMetric({ model, view, measure, filters: filters || {}, user: req.user, suiteId: req.params.suiteId });
      res.json({ value: value == null ? null : Number(value) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Distinct values of a dimension (e.g. the Ticket Type values for this event),
  // scoped — drives the filter-value dropdown so users pick "VIP", not type it.
  app.post('/api/alerts/suites/:suiteId/metric-filter-values', auth.requireAuth, async (req, res) => {
    if (!enabled()) return off(res);
    if (!db.getSuite(req.params.suiteId)) return res.status(404).json({ error: 'Event not found' });
    if (!canView(req.user, req.params.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    const { model, view, field } = req.body || {};
    if (!model || !view || !field) return res.status(400).json({ error: 'model, view and field required' });
    if (typeof metricFilterValues !== 'function') return res.json({ values: [] });
    try { res.json({ values: await metricFilterValues({ model, view, field, user: req.user, suiteId: req.params.suiteId, entityScope: !!(req.body && req.body.allEvents) }) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Reusable templates (a client's own + Howler's global ones) ───────────────
  // The reusable subset of an alert: the rule + how-you're-told, plus the metric/
  // tile reference. Instance-only bits (live state, SMS numbers) are dropped. Tile
  // refs keep the dashboard + tile NAMES so a global template re-resolves to each
  // client's matching tile by name; metric refs (LookML field names) port directly.
  const tmplCanEntity = (user, eid) => isAdmin(user) || (user.entityIds || []).includes(eid);
  function templatePayloadFromAlert(a) {
    return {
      name: a.name, ruleType: a.ruleType, source: a.source,
      tileRef: a.source === 'tile' && a.dashboardId && a.tileId
        ? { dashboardId: a.dashboardId, tileId: a.tileId, dashboardName: a.dashboardName, tileName: a.tileName } : null,
      metricRef: a.source === 'metric' && a.measure
        ? { model: a.model, view: a.view, measure: a.measure, measureLabel: a.measureLabel, metricFilters: a.metricFilters, metricLabel: a.metricLabel } : null,
      operator: a.operator, threshold: a.threshold, unit: a.unit, tag: a.tag,
      channels: a.channels, priority: a.priority, frequency: a.frequency, cooldownMin: a.cooldownMin,
      quietStart: a.quietStart, quietEnd: a.quietEnd,
    };
  }

  app.get('/api/alerts/templates/:entityId', auth.requireAuth, (req, res) => {
    if (!enabled()) return off(res);
    if (!tmplCanEntity(req.user, req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
    // This client's own templates PLUS every global (platform) template.
    const rows = sql.prepare("SELECT id, name, payload, scope, created_at FROM alert_templates WHERE (scope='entity' AND entity_id=?) OR scope='global' ORDER BY scope DESC, created_at DESC").all(req.params.entityId);
    res.json({ templates: rows.map((r) => ({ id: r.id, name: r.name, payload: parseJson(r.payload, {}), scope: r.scope, global: r.scope === 'global', createdAt: r.created_at })) });
  });

  app.post('/api/alerts/templates', auth.requireAuth, (req, res) => {
    if (!enabled()) return off(res);
    let { entityId, name, payload } = req.body || {};
    const fromAlertId = req.body?.fromAlertId;
    const wantGlobal = !!req.body?.global;
    if (wantGlobal && !isAdmin(req.user)) return res.status(403).json({ error: 'Only admins can create global templates' });
    if (fromAlertId) {
      const a = alertById(fromAlertId);
      if (!a) return res.status(404).json({ error: 'Alert not found' });
      if (!canView(req.user, a.suiteId)) return res.status(403).json({ error: 'Not allowed' });
      entityId = a.entityId; name = name || a.name; payload = templatePayloadFromAlert(a);
    }
    if (!name || !payload || typeof payload !== 'object') return res.status(400).json({ error: 'name and payload are required' });
    const scope = wantGlobal ? 'global' : 'entity';
    const eid = wantGlobal ? '' : entityId;
    if (!wantGlobal && (!eid || !tmplCanEntity(req.user, eid))) return res.status(403).json({ error: 'Not allowed' });
    const id = uuid(); const ts = now();
    sql.prepare('INSERT INTO alert_templates (id, entity_id, scope, name, payload, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, eid, scope, String(name).slice(0, 120), JSON.stringify(payload).slice(0, 8000), req.user.email, ts);
    res.status(201).json({ template: { id, name: String(name).slice(0, 120), payload, scope, global: wantGlobal, createdAt: ts } });
  });

  app.delete('/api/alerts/templates/:id', auth.requireAuth, (req, res) => {
    if (!enabled()) return off(res);
    const row = sql.prepare('SELECT entity_id, scope FROM alert_templates WHERE id=?').get(req.params.id);
    if (!row) return res.json({ ok: true });
    const allowed = row.scope === 'global' ? isAdmin(req.user) : tmplCanEntity(req.user, row.entity_id);
    if (!allowed) return res.status(403).json({ error: 'Not allowed' });
    sql.prepare('DELETE FROM alert_templates WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });

  // ── Recent alert FIRES as Pulse "beats" ──────────────────────────────────────
  // Exposed (returned from mount) so server/pulse.js can MERGE these with momentum +
  // future sources into the header strip's feed — keeping this module decoupled (it
  // owns alerts; pulse owns the strip). Entity-scoped via alert_events.entity_id,
  // newest first, last 48h by default. Returns [] when alerts are disabled.
  function pulseTier(ruleType, operator) {
    if (ruleType === 'sold_out') return 'success';                 // celebrate
    if (ruleType === 'depletion') return 'warning';                // low stock
    if (operator === 'lte' || operator === 'lt') return 'warning'; // dropped below a floor
    return 'info';                                                 // reached
  }
  function recentBeats(entityId, { limit = 8, sinceMs = 48 * 3600 * 1000 } = {}) {
    if (!enabled() || !entityId) return [];
    const since = new Date(Date.now() - sinceMs).toISOString();
    const rows = sql.prepare(`SELECT e.id, e.at, e.value, e.message, a.name AS name, a.rule_type AS rule_type, a.operator AS operator
       FROM alert_events e LEFT JOIN alerts a ON a.id = e.alert_id
       WHERE e.entity_id=? AND e.status='fired' AND e.at>=? ORDER BY e.at DESC LIMIT ?`).all(entityId, since, Math.max(1, limit));
    return rows.map((r) => ({
      id: r.id, kind: 'alert', at: r.at, tier: pulseTier(r.rule_type, r.operator),
      message: r.message, name: r.name || '', value: r.value,
    }));
  }

  // Status (client uses it to decide whether to show the feature).
  app.get('/api/alerts/status', auth.requireAuth, (req, res) => res.json({ enabled: enabled() }));

  // ── Programmatic create (the Owl's createAlert act-tool commit path) ──────────
  // Runs the SAME clean + permission (canManage) + upsert the POST route uses, so an
  // alert the Owl proposes-then-confirms is identical to a hand-made one and obeys
  // alerts.manage (the Owl can never create an alert the user couldn't make by hand).
  // Returns { ok, alert } or { ok:false, error }. No throwing — the caller is a route.
  function createAlertFor({ suiteId, draft, user }) {
    if (!enabled()) return { ok: false, error: 'Alerts are disabled' };
    const su = db.getSuite(suiteId);
    if (!su) return { ok: false, error: 'Event not found' };
    if (!canManage(user, suiteId)) return { ok: false, error: 'You don\'t have permission to create alerts for this event.' };
    const c = clean({ ...(draft || {}), source: 'metric' }, su.entityId, su.id);
    if (!c.name) return { ok: false, error: 'Give the alert a name.' };
    if (!c.model || !c.view || !c.measure) return { ok: false, error: 'Pick the metric to watch.' };
    return { ok: true, alert: upsert(null, c, (user && user.email) || 'owl') };
  }

  console.log('[alerts] mounted', enabled() ? '(enabled)' : '(disabled — set alerts_enabled=1)');
  return { evaluate, tick, recentBeats, listForSuite, alertById, eventsFor, createAlert: createAlertFor };
}

// Export the option lists so other modules (e.g. the Owl's createAlert act-tool)
// build their schema + validation FROM these — one source of truth, so adding an
// operator/channel/priority here automatically widens what the Owl can set + ask for.
module.exports = { mount, RULE_TYPES, OPERATORS, CHANNELS, PRIORITIES, FREQUENCIES };
