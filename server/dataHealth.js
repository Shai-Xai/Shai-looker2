// ─── Data health: the BigQuery → Looker stream monitor ──────────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the `data_monitors`, `data_monitor_streams`,
// `data_monitor_checks` and `data_monitor_events` tables and all /api/admin/data-health
// routes. Mounted from index.js with one line + injected deps. Kill switch: settings
// key `data_health_enabled` ('0' disables the tick + 404s the routes). To remove the
// feature: delete this file + that line, then drop the data_monitor* tables.
//
// WHAT it measures: Pulse reads everything through Looker, which reflects BigQuery,
// which reflects Howler's stations on the ground (check-in scanners, bars, vendors).
// A monitor asks Looker for the latest record timestamp on an explore — optionally
// split by a station dimension — on a cadence, ALWAYS bypassing the query cache
// (measuring freshness through a cache would lie). The lag between that timestamp and
// now is the end-to-end health of the whole pipe: station → Howler → BigQuery → Looker.
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
const CNT_FIELD = 'data_health_scans';  // the dynamic scan-count measure's name (timeline fallback)
const AREAS = ['Check-in', 'Bar', 'Vendors', 'Cashless', 'Ticketing', 'Other'];
// Bars & vendors sell — their per-record activity is "transactions"; gates scan.
const unitFor = (m) => (m.area === 'Bar' || m.area === 'Vendors' ? 'transactions' : 'scans');

// ── AI prompts (registered in server/insights.js promptRegistry — the audit) ──
// 🩺 Diagnose: one station's live picture → a plain-language verdict.
const DATA_HEALTH_DIAG_SYSTEM = `You are Pulse's data-stream diagnostician for live events. You receive one monitored station's live picture as JSON: the monitor's thresholds, per-stream lag, the device roster (linked/online/offline devices since the start time), a per-device activity timeline (activeBlocks is a 0/1 string, one char per time block, oldest→newest), per-device scan counts, and recent alert history.

Write a SHORT diagnostics verdict an ops person can act on mid-event:
1. First line: an overall verdict — healthy / mostly healthy with N concerns / degraded / down — with the single most important fact.
2. "Flow:" the pipe numbers — minutes since the latest record vs the warn/stale thresholds, and total scans.
3. "Timeline:" THE CORE ANALYSIS — where the problems were through the day. Walk timeline.coverage (per block: how many devices sent data) chronologically and name EVERY window where a meaningful share of devices was simultaneously silent, as "HH:MM–HH:MM SA: only X of N devices sending". For each window say what it was: a shared outage (devices that were active BEFORE the window went dark TOGETHER — this station's connectivity degrading, list the affected devices) vs a slow ramp-up (devices had not yet sent their FIRST data — late start, not a fault, but say how long the ramp took and when coverage became full). Use each device's activeBlocks (one char per block, oldest→newest) to tell those apart. Then name when coverage was at its best.
4. "Devices:" online vs linked now, scans-per-device spread, and the individual laggards.
5. "Concerns:" a numbered list, worst first — shared-window incidents FIRST, then single-device drops/flappers. For each: what, the evidence (times, counts, gap lengths), and ONE concrete action (→ send a runner / swap / reboot / check battery or signal / raise with the network provider).
6. End with what you RULED OUT: single-device faults vs this station's connectivity — justify from whether silent blocks were shared or isolated. Remember each station has its own coverage area: simultaneous drops HERE are a connectivity signal for THIS station even if other stations ran clean.

Rules: plain text (no markdown headings/tables), ≤ 260 words, every number from the JSON — never invent. observedOfflineWindows (when present) are what Pulse ITSELF saw at check time — the authoritative connectivity record a late-syncing device cannot repaint; where the transaction timeline looks green inside an observed window, the device kept trading offline and synced late — say so. Call the per-record activity by monitor.unit — "transactions" for bars/vendors, "scans" for gates. Times in the data are UTC (coverage.atUTC is UTC HH:MM); ALWAYS present them as South Africa time (UTC+2). If data is missing (rosterError/timelineError), say what you couldn't see. No greetings, no fluff.`;

// 📝 Event report: every station of one event → a shareable ops report.
const DATA_HEALTH_REPORT_SYSTEM = `You write Pulse's DATA HEALTH & DIAGNOSTICS REPORT for one event — used by the ops team and shared externally with network/connectivity providers. You receive JSON: the event & client name, and per station: thresholds, stream lags, device roster, per-device scan counts, a per-device activity timeline (activeBlocks: 0/1 string, oldest→newest) and the alert history.

Write the report in clean Markdown:
# Data health report — {event} ({client})
*Generated {date/time} SAST · Howler Pulse*

## 1. Executive summary — 3-5 bullet verdict of the whole event's data flow: stations healthy vs affected, device totals (linked/online/offline across all stations), total scans, and the headline incidents.
## 2. Station-by-station — one short block per station: status, latest-record lag vs thresholds, devices online/linked, scans, notable gaps (with times and durations).
## 3. Device incidents — a Markdown table: Device | Station | What happened | When (SAST) | Duration | Likely cause. Include offline devices, flappers (active-silent-active), and unusually low scanners.
## 4. Connectivity & offline trends — PER STATION. Each station has its OWN connectivity (its own area of the venue, its own coverage), so analyse every station separately — NEVER require a cross-station signature before flagging connectivity, and never conclude "no connectivity issue" just because stations dropped at different times. For each station, read its devices' activeBlocks and the coverage series and describe its offline TREND through the day: the exact SAST windows where several of ITS devices were silent at the same time, how deep each dip was (X of N devices), whether dips recur around particular times of day, and which devices were affected. Classify each window: previously-active devices at one station going dark TOGETHER = that station's connectivity likely degraded in that window — say so plainly and list the window for the provider; staggered/isolated silences = device-level; devices that had not yet sent their first data = ramp-up, not a fault. If several stations share a window, escalate that to a venue-wide note. Be precise and neutral — this section may be forwarded verbatim.
## 5. Recommendations — numbered, concrete, ordered by impact (hardware swaps, spares, placement, network follow-ups).

Rules: every number and time from the JSON — never invent; convert UTC → SAST (UTC+2). Prefer each station's observedOfflineWindows (what Pulse itself saw at check time — never repainted by late syncs) as the connectivity record in §4; a green transaction timeline inside an observed window means the device traded offline and synced late. Each station carries a unit ("scans" or "transactions") — use that word for its activity (bars/vendors transact, gates scan). Professional and factual — no internal jargon, no hedging filler. If a station has no roster/timeline data, note it in one line rather than guessing. Keep it under ~700 words.`;
const CHANNELS = ['push', 'email', 'slack']; // entity fan-out via the OS spine; ops Slack is always-on

// `mailer` is injectable for tests but defaults to the real module so the
// index.js mount line stays unchanged (it's only used by test mode below).
function mount(app, { db, auth, looker, runLookerQuery, applyScope, os, ops, mailer = require('./mailer'), ai = null }) {
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
  // Master auto-check cadence (minutes). Monitors with check_every_min = 0
  // follow this; a monitor with its own value keeps it. Editable in the UI.
  const masterMin = () => { const n = Math.round(Number(db.getSetting('data_health_tick_min', '5'))); return Number.isFinite(n) ? Math.max(1, Math.min(120, n)) : 5; };

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
    CREATE TABLE IF NOT EXISTS data_monitor_obs (
      monitor_id    TEXT NOT NULL,
      at            TEXT NOT NULL,               -- when Pulse looked
      total         INTEGER NOT NULL,
      online        INTEGER NOT NULL,
      offline_names TEXT NOT NULL DEFAULT '[]'   -- devices offline AT THAT MOMENT
    );
    CREATE INDEX IF NOT EXISTS idx_dmo ON data_monitor_obs(monitor_id, at);
  `);

  // Additive migrations for DBs created before detail columns / the device roster.
  try {
    const cols = sql.prepare('PRAGMA table_info(data_monitors)').all().map((c) => c.name);
    const add = (name, ddl) => { if (!cols.includes(name)) sql.exec(`ALTER TABLE data_monitors ADD COLUMN ${ddl}`); };
    add('detail_fields', "detail_fields TEXT NOT NULL DEFAULT '[]'");
    add('roster_field', "roster_field TEXT NOT NULL DEFAULT ''");           // device/operator dimension for the roster view
    add('roster_baseline_min', 'roster_baseline_min INTEGER NOT NULL DEFAULT 1440'); // seen within this window = "linked"
    add('roster_online_min', 'roster_online_min INTEGER NOT NULL DEFAULT 30');       // synced within this window = "online"
    add('roster_start', "roster_start TEXT NOT NULL DEFAULT ''");                    // fixed "linked since" start (UTC ISO) — overrides the rolling window
    add('roster_daily', "roster_daily TEXT NOT NULL DEFAULT ''");                    // recurring daily anchor 'HH:MM' (SAST) — beats roster_start; multi-day events
    add('roster_snapshot', "roster_snapshot TEXT NOT NULL DEFAULT ''");              // last roster counts JSON, refreshed by check() — collapsed cards read this, no live query
    add('roster_alert_pct', 'roster_alert_pct INTEGER NOT NULL DEFAULT 0');          // alert when ≥ this % of linked devices are offline (0 = off)
  } catch (e) { console.error('[data-health] column migration skipped:', e.message); }

  const parseJson = (s, fb) => { try { const v = JSON.parse(s); return v == null ? fb : v; } catch { return fb; } };

  function rowToMonitor(r) {
    if (!r) return null;
    return {
      id: r.id, name: r.name, area: r.area, entityId: r.entity_id, suiteId: r.suite_id,
      model: r.model, view: r.view, timeField: r.time_field, stationField: r.station_field,
      detailFields: parseJson(r.detail_fields, []),
      rosterField: r.roster_field || '', rosterBaselineMin: r.roster_baseline_min, rosterOnlineMin: r.roster_online_min, rosterStart: r.roster_start || '', rosterDaily: r.roster_daily || '',
      rosterSnapshot: parseJson(r.roster_snapshot, null),
      rosterAlertPct: r.roster_alert_pct || 0,
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
        // A blank value is kept: an "open" filter the admin is still deciding on
        // (the dimension survives a save). Blanks are stripped from queries.
        if (k) filters[String(k).slice(0, 200)] = v == null ? '' : String(v).trim().slice(0, 500);
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
      // Extra dimensions shown as columns in the 🧾 Latest-20 peek (e.g. station
      // name, action/record type). Display-only — no effect on health evaluation.
      detailFields: Array.isArray(b.detailFields)
        ? [...new Set(b.detailFields.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().slice(0, 200)))].slice(0, 4)
        : [],
      // Device roster: dimension identifying a device/operator, plus the "linked"
      // baseline window and the "online" recency window (minutes).
      rosterField: String(b.rosterField || '').slice(0, 200),
      rosterBaselineMin: num(b.rosterBaselineMin, 1440, 10, 20160),
      rosterOnlineMin: num(b.rosterOnlineMin, 30, 1, 1440),
      // Fixed "linked since" anchor (UTC ISO). When set it beats the rolling window
      // — the event-day shape: "every device seen since doors opened".
      rosterStart: (b.rosterStart && !Number.isNaN(Date.parse(b.rosterStart))) ? new Date(b.rosterStart).toISOString() : '',
      // Recurring daily anchor (multi-day events): 'HH:MM' South-Africa time —
      // the roster restarts from that time each day. Beats rosterStart when set.
      rosterDaily: /^\d{1,2}:\d{2}$/.test(b.rosterDaily || '') ? b.rosterDaily : '',
      // Fleet alert: fire when ≥ this % of linked devices are offline (0 = off).
      rosterAlertPct: num(b.rosterAlertPct, 0, 0, 100),
      filters,
      warnMin: num(b.warnMin, 30, 1, 10080),
      staleMin: num(b.staleMin, 60, 2, 10080),
      checkEveryMin: num(b.checkEveryMin, 0, 0, 1440), // 0 = follow the master cadence
      channels,
      notifyRecovery: b.notifyRecovery === false ? 0 : 1,
      cooldownMin: num(b.cooldownMin, 60, 0, 10080),
      status: b.status === 'paused' ? 'paused' : b.status === 'closed' ? 'closed' : 'active',
    };
  }

  function upsert(id, c, who) {
    const ts = now();
    if (id) {
      sql.prepare(`UPDATE data_monitors SET name=?, area=?, entity_id=?, suite_id=?, model=?, view=?, time_field=?, station_field=?, detail_fields=?,
        roster_field=?, roster_baseline_min=?, roster_online_min=?, roster_start=?, roster_daily=?, roster_alert_pct=?,
        filters=?, warn_min=?, stale_min=?, check_every_min=?, channels=?, notify_recovery=?, cooldown_min=?, status=?, updated_at=? WHERE id=?`)
        .run(c.name, c.area, c.entityId, c.suiteId, c.model, c.view, c.timeField, c.stationField, JSON.stringify(c.detailFields),
          c.rosterField, c.rosterBaselineMin, c.rosterOnlineMin, c.rosterStart, c.rosterDaily, c.rosterAlertPct,
          JSON.stringify(c.filters), c.warnMin, c.staleMin, c.checkEveryMin, JSON.stringify(c.channels), c.notifyRecovery, c.cooldownMin, c.status, ts, id);
      return monitorById(id);
    }
    const nid = uuid();
    sql.prepare(`INSERT INTO data_monitors (id, name, area, entity_id, suite_id, model, view, time_field, station_field, detail_fields,
      roster_field, roster_baseline_min, roster_online_min, roster_start, roster_daily, roster_alert_pct, filters,
      warn_min, stale_min, check_every_min, channels, notify_recovery, cooldown_min, status, state, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ok',?,?,?)`)
      .run(nid, c.name, c.area, c.entityId, c.suiteId, c.model, c.view, c.timeField, c.stationField, JSON.stringify(c.detailFields),
        c.rosterField, c.rosterBaselineMin, c.rosterOnlineMin, c.rosterStart, c.rosterDaily, c.rosterAlertPct, JSON.stringify(c.filters),
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
    if (/^\d{4}-\d{2}-\d{2} \d{1,2}$/.test(s)) s += ':00'; // hour-granularity dims ("YYYY-MM-DD HH")
    const d = new Date(s.replace(' ', 'T') + (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? '' : 'Z'));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // The roster's "linked since" anchor, in precedence order: the recurring daily
  // time (today at HH:MM SAST — yesterday's if that moment is still ahead), then
  // the fixed start, else null (rolling window). SAST is fixed UTC+2 (no DST).
  function rosterAnchor(m, nowMs = Date.now()) {
    if (/^\d{1,2}:\d{2}$/.test(m.rosterDaily || '')) {
      const [hh, mm] = m.rosterDaily.split(':').map(Number);
      const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date(nowMs)).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
      let d = new Date(`${p.year}-${p.month}-${p.day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+02:00`);
      if (d.getTime() > nowMs) d = new Date(d.getTime() - 86400000); // today's anchor still ahead → since yesterday's
      return d;
    }
    if (m.rosterStart && !Number.isNaN(Date.parse(m.rosterStart))) return new Date(m.rosterStart);
    return null;
  }

  // Scoped reads: pinned-to-client monitors run as a synthetic CLIENT locked to that
  // entity (applyScope forces the organiser boundary, exactly like alerts/goals);
  // platform monitors run as a synthetic admin (unscoped by design — internal ops).
  function evalUser(m) {
    if (m.entityId) return { id: `datahealth:${m.id}`, email: 'datahealth@howler', role: 'client', entityIds: [m.entityId] };
    return { id: 'datahealth', email: 'datahealth@howler', role: 'admin' };
  }

  // Run one scoped, cache-bypassed Looker query. force=true matters: a cached row
  // would make the pipe look exactly as stale as our own cache, defeating the point.
  async function runScoped(m, body) {
    if (!(await applyScope(body, evalUser(m), m.suiteId || null))) throw new Error('scope failed (fail closed)');
    const rows = await runLookerQuery('/queries/run/json', body, 0, true);
    if (!Array.isArray(rows)) throw new Error('unexpected Looker response shape');
    return rows;
  }
  // Blank-valued ("open") filters are config-only — sending "" to Looker would
  // filter for blank values, so they never reach the query.
  const baseBody = (m) => ({
    model: m.model, view: m.view,
    filters: Object.fromEntries(Object.entries(m.filters || {}).filter(([, v]) => String(v).trim())),
    query_timezone: 'UTC',
  });

  // Some Looker versions reject a custom max() measure on a DATE/TIME dimension
  // ("Expressions for fields of type \"max\" must evaluate to \"number\""). Once a
  // monitor hits that, remember it and go straight to the sorted-scan path.
  const maxMeasureUnsupported = new Set();

  async function readLatest(m) {
    // Whole feed: the single newest row IS the answer — no aggregation needed.
    if (!m.stationField) {
      const rows = await runScoped(m, { ...baseBody(m), fields: [m.timeField], sorts: [`${m.timeField} desc`], limit: '1' });
      const ts = rows.length ? parseTs(rows[0][m.timeField]) : null;
      return ts ? new Map([['', ts]]) : new Map();
    }

    // Station split, preferred path: a dynamic max(time) measure — one tiny row per
    // station regardless of how busy the raw table is.
    if (!maxMeasureUnsupported.has(m.id)) {
      try {
        const rows = await runScoped(m, {
          ...baseBody(m),
          fields: [m.stationField, MAX_FIELD],
          dynamic_fields: JSON.stringify([{ measure: MAX_FIELD, based_on: m.timeField, type: 'max' }]),
          limit: '500',
        });
        return reduceRows(m, rows, MAX_FIELD);
      } catch (e) {
        // Custom-measure rejection is permanent for this field — memoise and fall
        // through to the scan. Any other failure also gets one scan attempt (it
        // may still work); if the scan fails too, THAT error surfaces.
        if (/must evaluate to/i.test(String(e.message || ''))) maxMeasureUnsupported.add(m.id);
        console.warn('[data-health] max-measure read failed, trying sorted scan', m.id, e.message);
      }
    }

    // Fallback: newest rows first, reduced to max-per-station in JS. Sorted desc,
    // so the FIRST time a station appears is its latest record. Stations idle for
    // longer than the window won't appear — the per-station memory keeps evaluating
    // them from their remembered last_event_at, which is exactly the stale signal.
    const rows = await runScoped(m, {
      ...baseBody(m),
      fields: [m.stationField, m.timeField],
      sorts: [`${m.timeField} desc`],
      limit: '5000',
    });
    return reduceRows(m, rows, m.timeField);
  }

  // The raw tail of the feed: the N most recent (station, timestamp) records,
  // newest first — a live, cache-bypassed peek so an admin can SEE what the pipe
  // last delivered rather than trusting the lag number. Note Looker groups
  // identical rows, so same-station-same-second records collapse into one.
  async function latestRecords(m, limit = 20) {
    const n = Math.max(1, Math.min(100, Math.round(Number(limit) || 20)));
    // Detail columns ride along in the same query (station/action/whatever the
    // monitor configured) — display-only extras, deduped against the core fields.
    const extras = (m.detailFields || []).filter((f) => f && f !== m.timeField && f !== m.stationField);
    const fields = [...(m.stationField ? [m.stationField] : []), m.timeField, ...extras];
    const rows = await runScoped(m, { ...baseBody(m), fields, sorts: [`${m.timeField} desc`], limit: String(n) });
    const nowMs = Date.now();
    return rows.map((r) => {
      const ts = parseTs(r[m.timeField]);
      return {
        at: ts ? ts.toISOString() : '',
        raw: String(r[m.timeField] ?? ''),
        station: m.stationField ? String(r[m.stationField] ?? '').trim() : '',
        extra: Object.fromEntries(extras.map((f) => [f, r[f] == null ? '' : String(r[f])])),
        agoMin: ts ? Math.round(((nowMs - ts.getTime()) / 60000) * 10) / 10 : null,
      };
    });
  }

  // The device roster: "expected vs actual". Every device/operator seen within
  // the BASELINE window counts as linked; any of those not seen within the
  // ONLINE window is offline — named, with how long it's been silent. This
  // learns the expected set from the data itself (no manual device register):
  // one scoped query over the baseline window, reduced to last-seen per device.
  // Looker dimension groups name every timeframe `${group}_${timeframe}`.
  const SUFFIX = /_(raw|time|date|hour|minute\d*|second|week|month|quarter|year|time_of_day|hour_of_day|day_of_week|day_of_month|day_of_year)$/;

  const LAST_FIELD = 'data_health_last';

  // Last-seen read shared by the roster and the labels lookup: ONE aggregated
  // row per device (+extras) via a dynamic MAX measure — based on the _raw
  // timeframe first (custom max measures want a raw date), then the picked
  // timeframe — else plain rows, newest first, at a high cap. What worked is
  // remembered per monitor.
  const lastReadModeByMonitor = new Map(); // m.id -> 'raw' | 'time' | 'rows'
  async function latestRows(m, timeFilter, ex = [], stationExpr = '') {
    const group = SUFFIX.test(m.timeField) ? m.timeField.replace(SUFFIX, '') : m.timeField;
    const cands = lastReadModeByMonitor.has(m.id) ? [lastReadModeByMonitor.get(m.id)] : ['raw', 'time', 'rows'];
    let lastErr = null;
    for (const cand of cands) {
      try {
        const b = { ...baseBody(m), limit: cand === 'rows' ? '20000' : '5000' };
        b.filters[m.timeField] = timeFilter;
        if (stationExpr && m.stationField) b.filters[m.stationField] = stationExpr;
        if (cand === 'rows') {
          b.fields = [m.rosterField, ...ex, m.timeField];
          b.sorts = [`${m.timeField} desc`];
        } else {
          b.fields = [m.rosterField, ...ex, LAST_FIELD];
          b.sorts = [`${LAST_FIELD} desc`];
          b.dynamic_fields = JSON.stringify([{ measure: LAST_FIELD, based_on: cand === 'raw' ? `${group}_raw` : m.timeField, type: 'max' }]);
        }
        const rows = await runScoped(m, b);
        const tKey = cand === 'rows' ? m.timeField : LAST_FIELD;
        if (rows.length && !rows.some((r) => parseTs(r[tKey]))) { lastErr = new Error(`${tKey} unreadable`); continue; }
        lastReadModeByMonitor.set(m.id, cand);
        return { rows, tKey, aggregated: cand !== 'rows' };
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  async function deviceRoster(m, withInfo = false) {
    if (!m.rosterField) return { configured: false };
    // Constrain the roster in Looker itself: the daily/fixed "since doors opened"
    // anchor when set (queries run in UTC), else the rolling baseline window.
    const startAt = rosterAnchor(m);
    const timeFilter = startAt
      ? `after ${startAt.toISOString().slice(0, 16).replace('T', ' ')}`
      : `last ${m.rosterBaselineMin} minutes`;
    // Aggregated last-seen per device where Looker allows it: a raw read of a
    // busy sales day truncates at the row cap, silently dropping idle devices
    // — the linked/offline counts then JITTER between pulls.
    const { rows, tKey, aggregated } = await latestRows(m, timeFilter);
    const seen = new Map(); // device -> latest Date
    for (const r of rows) {
      const d = String(r[m.rosterField] ?? '').trim();
      const ts = parseTs(r[tKey]);
      if (!d || !ts) continue;
      const prev = seen.get(d);
      if (!prev || ts > prev) seen.set(d, ts);
    }
    const nowMs = Date.now();
    const devices = [...seen.entries()]
      .map(([device, ts]) => ({ device, lagMin: Math.round(((nowMs - ts.getTime()) / 60000) * 10) / 10 }))
      .sort((a, b) => b.lagMin - a.lagMin);
    const offline = devices.filter((d) => d.lagMin > m.rosterOnlineMin);
    if (withInfo) {
      labelDevices(offline, await deviceDetails(m, timeFilter));
      const missing = offline.filter((d) => !d.station);
      if (m.stationField && missing.length) labelDevices(missing, await deviceDetailsLite(m, timeFilter));
    }
    return {
      configured: true,
      baselineMin: m.rosterBaselineMin, onlineMin: m.rosterOnlineMin, startAt: startAt ? startAt.toISOString() : '',
      total: devices.length, online: devices.length - offline.length,
      offline: offline.slice(0, 100),
      truncated: !aggregated && rows.length >= 20000, // raw fallback on a very busy window — idle devices may be under-counted
    };
  }

  // Which detail field names an operator/staff member (for device labelling).
  const OPERATOR_RE = /(handler|operator|staff|cashier)/i;

  // device → its latest station / operator, in one aggregated read. Kept as a
  // SEPARATE query on purpose: joining the extra views must never distort the
  // count reads, so a failure here only costs labels (returns null).
  async function deviceDetails(m, timeFilter, stationExpr = '') {
    const ex = [];
    if (m.stationField) ex.push(m.stationField);
    const opField = (m.detailFields || []).find((f) => f && OPERATOR_RE.test(f) && f !== m.rosterField && f !== m.timeField && f !== m.stationField);
    if (opField) ex.push(opField);
    if (!m.rosterField || !ex.length) return null;
    try {
      const { rows, tKey } = await latestRows(m, timeFilter, ex, stationExpr);
      const map = new Map();
      for (const r of rows) {
        const d = String(r[m.rosterField] ?? '').trim();
        const ts = parseTs(r[tKey]);
        if (!d || !ts) continue;
        const prev = map.get(d);
        if (!prev || ts > prev.ts) map.set(d, { ts, station: m.stationField ? String(r[m.stationField] ?? '').trim() : '', operator: opField ? String(r[opField] ?? '').trim() : '' });
      }
      return map;
    } catch (e) { void e; return null; }
  }

  // Labels WITHOUT timestamps: distinct (device, station, operator) combos in
  // the window — no measures, no time dim, so it works on the strictest Looker
  // and can't lose long-quiet devices to a newest-first row cap. Fills the
  // devices the timed read missed (they'd otherwise land under "No station").
  async function deviceDetailsLite(m, timeFilter) {
    const ex = [];
    if (m.stationField) ex.push(m.stationField);
    const opField = (m.detailFields || []).find((f) => f && OPERATOR_RE.test(f) && f !== m.rosterField && f !== m.timeField && f !== m.stationField);
    if (opField) ex.push(opField);
    if (!m.rosterField || !ex.length) return null;
    try {
      const b = { ...baseBody(m), fields: [m.rosterField, ...ex], sorts: [m.rosterField], limit: '20000' };
      b.filters[m.timeField] = timeFilter;
      const rows = await runScoped(m, b);
      const map = new Map();
      for (const r of rows) {
        const d = String(r[m.rosterField] ?? '').trim();
        if (!d || map.has(d)) continue;
        map.set(d, { station: m.stationField ? String(r[m.stationField] ?? '').trim() : '', operator: opField ? String(r[opField] ?? '').trim() : '' });
      }
      return map;
    } catch (e) { void e; return null; }
  }

  // Merge station/operator labels onto device entries (mutates in place).
  // Also carries last-seen lag so the timeline can say online vs offline —
  // never overwrites a lag the roster already computed.
  const labelDevices = (list, info) => {
    if (!info) return;
    const nowMs = Date.now();
    for (const d of list) {
      const i = info.get(d.device);
      if (!i) continue;
      if (i.station) d.station = i.station;
      if (i.operator) d.operator = i.operator;
      if (d.lagMin == null && i.ts) d.lagMin = Math.round(((nowMs - i.ts.getTime()) / 60000) * 10) / 10;
    }
  };

  // ── the OBSERVED offline log ─────────────────────────────────────────────
  // Every check writes down what Pulse SAW: who was offline at that moment.
  // Unlike the transaction timeline, a device that kept trading offline and
  // synced late can NEVER repaint this — it is the connectivity record.
  function recordObservation(m, r, at) {
    try {
      sql.prepare('INSERT INTO data_monitor_obs (monitor_id, at, total, online, offline_names) VALUES (?,?,?,?,?)')
        .run(m.id, at, r.total, r.online, JSON.stringify(r.offline.map((d) => d.device)));
      sql.prepare('DELETE FROM data_monitor_obs WHERE monitor_id=? AND at<?').run(m.id, new Date(Date.now() - 14 * 86400000).toISOString());
    } catch (e) { console.warn('[data-health] observation write failed', m.id, e.message); }
  }

  // The log since a moment: per-check online counts, which ticks each device
  // was offline at, and per-device contiguous offline WINDOWS (worst first).
  function observedLog(m, sinceIso) {
    const rows = sql.prepare('SELECT at, total, online, offline_names FROM data_monitor_obs WHERE monitor_id=? AND at>=? ORDER BY at').all(m.id, sinceIso);
    const ticks = rows.map((r) => ({ at: r.at, total: r.total, online: r.online, offline: parseJson(r.offline_names, []) })).slice(-288);
    const byDevice = new Map(); // device -> tick indexes it was offline at
    ticks.forEach((tk, i) => { for (const d of tk.offline) { if (!byDevice.has(d)) byDevice.set(d, []); byDevice.get(d).push(i); } });
    const windows = [];
    for (const [device, idx] of byDevice) {
      let s0 = idx[0];
      for (let j = 1; j <= idx.length; j++) {
        if (j === idx.length || idx[j] !== idx[j - 1] + 1) {
          const last = idx[j - 1];
          windows.push({ device, fromUTC: ticks[s0].at.slice(11, 16), toUTC: last === ticks.length - 1 ? 'now' : ticks[last].at.slice(11, 16), checks: last - s0 + 1 });
          if (j < idx.length) s0 = idx[j];
        }
      }
    }
    windows.sort((a, b) => b.checks - a.checks);
    return {
      configured: ticks.length > 0,
      ticks: ticks.map((t) => ({ at: t.at, online: t.online, total: t.total })),
      devices: [...byDevice.entries()].map(([device, idx]) => ({ device, offAt: idx })).sort((a, b) => b.offAt.length - a.offAt.length).slice(0, 200),
      windows: windows.slice(0, 150),
    };
  }
  const obsSinceFor = (m, hours) => {
    const a = String(hours || 'start') === 'start' ? rosterAnchor(m) : null;
    if (a) return a.toISOString();
    const h = Math.max(1, Math.min(72, Math.round(Number(hours) || 12)));
    return new Date(Date.now() - h * 3600000).toISOString();
  };

  // Block sizes the timeline can bucket by, in minutes.
  const TIMELINE_INTERVALS = [5, 10, 20, 30, 60];

  // How each monitor's timeline counts scans, learned on first success: the
  // explore's native row-count measure (`view.count`), else a dynamic
  // count_distinct on the time dim, else plain row presence (counts of 1).
  const countModeByMonitor = new Map();

  // Which bucket dimension worked per monitor+interval (minuteN vs raw time).
  const bucketFieldByMonitor = new Map();

  // The day timeline: per device, which time blocks of the window it produced
  // data AND how many scans landed in each — rows × buckets the UI renders as a
  // green/grey activity grid or a per-block counts report. At 60-min blocks it
  // uses the timestamp's hour-granularity sibling dimension (created_at_time →
  // created_at_hour) so Looker aggregates to one row per (device, hour) — a
  // whole busy day fits. Finer blocks read the raw time dimension and bucket
  // here (5000-row cap → `truncated` warns when a very busy window overflows).
  async function deviceTimeline(m, hours = 24, interval = 60, station = '', withInfo = false) {
    if (!m.rosterField) return { configured: false };
    // Swap the picked timeframe for a sibling (or append when the picked field
    // is the bare group name). If the guess is wrong Looker 400s and the panel
    // shows the error rather than silently lying.
    const group = SUFFIX.test(m.timeField) ? m.timeField.replace(SUFFIX, '') : m.timeField;
    const hourField = `${group}_hour`;
    const iv = TIMELINE_INTERVALS.includes(Number(interval)) ? Number(interval) : 60;
    const ivMs = iv * 60000;
    // hours === 'start' anchors the window to the roster's start time (daily
    // HH:MM / once-off start) — the event-day view: no dead grey hours before
    // doors. Falls back to a rolling 24h when the monitor has no anchor.
    const anchor = String(hours) === 'start' ? rosterAnchor(m) : null;
    let h = anchor
      ? Math.max(1, Math.ceil((Date.now() - anchor.getTime()) / 3600000))
      : Math.max(3, Math.min(72, Math.round(Number(hours) || 24)));
    h = Math.min(h, Math.floor((288 * iv) / 60)); // cap the grid at 288 blocks (5-min blocks top out at 24h)
    // Sub-hour blocks first try the matching minuteN sibling dimension so
    // Looker aggregates to one row per (device, block) — a busy bar day stops
    // overflowing the row cap instead of returning one row per scan. LookML
    // without that timeframe 400s → raw-time fallback; whichever works is
    // remembered per monitor+interval.
    const bKey = `${m.id}:${iv}`;
    const bucketCands = iv === 60 ? [hourField]
      : bucketFieldByMonitor.has(bKey) ? [bucketFieldByMonitor.get(bKey)]
        : [`${group}_minute${iv}`, m.timeField];
    const timeFilter = anchor
      ? `after ${anchor.toISOString().slice(0, 16).replace('T', ' ')}`
      : `last ${h} hours`;
    // Optional station narrowing — the per-station view of a monitor that
    // spans many bars/gates. Plain value (the form every other filter in this
    // module uses); quoted only when the value carries filter-syntax chars
    // (comma = OR, % and _ = wildcards, leading - = NOT).
    const st = String(station || '').trim();
    const stExpr = /[,%_^"]|^-/.test(st) ? `"${st.replace(/"/g, '')}"` : st;
    // Count-measure candidates, in order: the TIME FIELD's own view's count
    // (right on combined explores, where m.view is the explore name and the
    // real measure is e.g. cashless_check_ins.count), then the explore-name
    // guess, then a dynamic count_distinct, then plain row presence. The
    // working mode is remembered — but 'none' never is, so a transient Looker
    // error can't poison a monitor into inflating/deflating counts forever.
    const nativeField = `${String(m.timeField).split('.')[0]}.count`;
    const viewField = `${m.view}.count`;
    // When nothing is memoized yet, also ask the explore for ITS OWN count-ish
    // measures on the time field's view — the guessed names can exist yet count
    // another view's rows, and custom (dynamic) measures may be disallowed for
    // the API user entirely. A real measure from the catalogue beats both.
    let probed = [];
    if (!countModeByMonitor.has(m.id)) {
      try {
        const ef = await looker.getExploreFields(m.model, m.view);
        const tv = String(m.timeField).split('.')[0];
        // Rank the candidates: transaction_count IS the per-sale counter the
        // dashboards use; cumulative/topup/tip/customer counters count other
        // things entirely and must never win just by sorting first.
        const score = (n) => {
          const f = String(n).split('.')[1] || '';
          if (/^transaction_count$/i.test(f)) return 0;
          if (/transaction/i.test(f)) return 1;
          if (/cumulative|topup|tip|customer|operator|distinct|tab/i.test(f)) return 9;
          return 5;
        };
        probed = (ef.measures || [])
          .map((x) => (x && x.name) || x)
          .filter((n) => typeof n === 'string' && n.split('.')[0] === tv && n !== nativeField && /count/i.test(n))
          .filter((n) => score(n) < 9)
          .sort((a, b) => score(a) - score(b))
          .slice(0, 3);
      } catch (e) { void e; }
    }
    // Catalogue measures FIRST: the explore-name guess can be a measure like
    // "Cashless Events Count" that returns 1 per group — non-zero, so the
    // zero-check can't catch it, and it must never outrank transaction_count.
    const allModes = [...probed, 'native', ...(viewField !== nativeField ? ['native2'] : []), 'distinct', 'distinct2', 'none'];
    const modes = countModeByMonitor.has(m.id) ? [countModeByMonitor.get(m.id)] : allModes;
    // A cand containing '.' IS the measure field (a probed catalogue measure).
    const fieldFor = (cand) => (cand === 'native' ? nativeField : cand === 'native2' ? viewField : cand.includes('.') ? cand : CNT_FIELD);
    let rows = null; let mode = 'none'; let bucketField = bucketCands[0]; let lastErr = null;
    for (const bf of bucketCands) {
      for (const cand of modes) {
        const body = { ...baseBody(m), sorts: [`${bf} desc`], limit: '20000', fields: [m.rosterField, bf] };
        body.filters[m.timeField] = timeFilter;
        if (st && m.stationField) body.filters[m.stationField] = stExpr;
        if (cand === 'native' || cand === 'native2' || cand.includes('.')) body.fields = [...body.fields, fieldFor(cand)];
        if (cand === 'distinct' || cand === 'distinct2') {
          // Like the MAX read: custom measures want the _raw timeframe first —
          // based_on the picked timeframe errors on some explores.
          body.fields = [...body.fields, CNT_FIELD];
          body.dynamic_fields = JSON.stringify([{ measure: CNT_FIELD, based_on: cand === 'distinct' ? `${group}_raw` : m.timeField, type: 'count_distinct' }]);
        }
        try {
          const got = await runScoped(m, body);
          // Combined-explore trap: a count measure can exist yet count ANOTHER
          // view's rows — every returned row then reads 0. Rows prove activity,
          // so a zero-only count is a soft failure: try the next counting mode.
          const cTry = fieldFor(cand);
          if (cand !== 'none' && got.length && !got.some((r) => Number(r[cTry]) > 0)) {
            lastErr = new Error(`${cTry} returned 0 for every row`); continue;
          }
          rows = got; mode = cand; bucketField = bf; break;
        } catch (e) {
          lastErr = e;
          if (String(e.message || e).includes(bf)) break; // the bucket dim itself is unknown — next candidate
        }
      }
      if (rows) break;
    }
    if (!rows) throw lastErr;
    if (iv !== 60) bucketFieldByMonitor.set(bKey, bucketField);
    if (mode !== 'none') countModeByMonitor.set(m.id, mode); else countModeByMonitor.delete(m.id);
    const cKey = mode === 'none' ? CNT_FIELD : fieldFor(mode);
    const nowMs = Date.now();
    const lastBucket = Math.floor(nowMs / ivMs) * ivMs; // current block start (UTC)
    // Anchored: first block is the one containing the start time; rolling: n
    // blocks back from now. Either way the grid stays capped at 288 blocks
    // (anchored windows longer than that keep the most recent blocks).
    let n = anchor
      ? Math.floor((lastBucket - Math.floor(anchor.getTime() / ivMs) * ivMs) / ivMs) + 1
      : Math.round((h * 60) / iv);
    const trimmedStart = n > 288;
    if (trimmedStart) n = 288;
    const firstBucket = lastBucket - (n - 1) * ivMs;
    const byDevice = new Map(); // device -> scan count per bucket
    for (const r of rows) {
      const d = String(r[m.rosterField] ?? '').trim();
      const ts = parseTs(r[bucketField]);
      if (!d || !ts) continue;
      const idx = Math.floor((ts.getTime() - firstBucket) / ivMs);
      if (idx < 0 || idx >= n) continue;
      const cRaw = Number(r[cKey]);
      if (!byDevice.has(d)) byDevice.set(d, Array(n).fill(0));
      byDevice.get(d)[idx] += mode !== 'none' && Number.isFinite(cRaw) ? cRaw : 1;
    }
    const bucketTotals = Array(n).fill(0);
    const devices = [...byDevice.entries()].map(([device, counts]) => {
      counts.forEach((c, i) => { bucketTotals[i] += c; });
      return { device, counts, total: counts.reduce((a, b) => a + b, 0), active: counts.map((c) => (c ? 1 : 0)) };
    }).sort((a, b) => a.device.localeCompare(b.device)).slice(0, 200);
    // Some explore join paths return NOTHING when the station filter rides the
    // count read (the join that resolves the station drops the sales rows).
    // Fall back: read the whole feed and keep the devices whose latest station
    // — from the labels lookup, which joins the same pair successfully — is
    // the one asked for.
    if (st && !devices.length) {
      const info = await deviceDetails(m, timeFilter);
      if (info && [...info.values()].some((v) => v.station === st)) {
        const whole = await deviceTimeline(m, hours, interval, '', false);
        const keep = whole.devices.filter((d) => (info.get(d.device) || {}).station === st);
        if (keep.length) {
          labelDevices(keep, info);
          const totals = Array(whole.buckets.length).fill(0);
          for (const d of keep) d.counts.forEach((c, i) => { totals[i] += c; });
          return { ...whole, station: st, devices: keep, devicesTotal: keep.length, bucketTotals: totals, grandTotal: totals.reduce((a, b) => a + b, 0) };
        }
      }
    }
    if (withInfo && devices.length) {
      labelDevices(devices, await deviceDetails(m, timeFilter, st ? stExpr : ''));
      const missing = devices.filter((d) => !d.station);
      if (m.stationField && missing.length) labelDevices(missing, await deviceDetailsLite(m, timeFilter));
    }
    return {
      configured: true, hours: Math.round((n * iv) / 60), intervalMin: iv, hourField, bucketField, countBasis: mode === 'native2' || mode.includes('.') ? 'native' : mode === 'distinct2' ? 'distinct' : mode,
      countField: mode !== 'none' && fieldFor(mode).includes('.') ? fieldFor(mode) : null,
      anchored: !!anchor, startAt: anchor ? anchor.toISOString() : null, trimmedStart,
      station: st, devicesTotal: byDevice.size, onlineMin: m.rosterOnlineMin,
      buckets: Array.from({ length: n }, (_, i) => new Date(firstBucket + i * ivMs).toISOString()),
      devices, bucketTotals, grandTotal: bucketTotals.reduce((a, b) => a + b, 0),
      truncated: rows.length >= 20000,
    };
  }

  // Distinct values of a dimension (scoped) — feeds the editor's linked filter
  // dropdowns so users pick a real station/event/type instead of typing blind.
  async function fieldValues({ model, view, field, entityId, suiteId, filters }) {
    const mLike = { id: 'editor', model: String(model), view: String(view), entityId: String(entityId || ''), suiteId: String(suiteId || '') };
    // The editor's OTHER filters constrain the value list — with an event
    // filter set, the station dropdown offers only THAT event's stations.
    const extra = {};
    if (filters && typeof filters === 'object' && !Array.isArray(filters)) {
      for (const [k, v] of Object.entries(filters).slice(0, 10)) {
        if (k && k !== String(field) && String(v ?? '').trim()) extra[String(k).slice(0, 200)] = String(v).trim().slice(0, 500);
      }
    }
    const rows = await runScoped(mLike, { model: mLike.model, view: mLike.view, fields: [String(field)], filters: extra, sorts: [String(field)], limit: '500', query_timezone: 'UTC' });
    const out = [];
    for (const r of rows) {
      const v = r[String(field)];
      if (v != null && v !== '' && !out.includes(String(v))) { out.push(String(v)); if (out.length >= 200) break; }
    }
    return out;
  }

  function reduceRows(m, rows, timeKey) {
    const seen = new Map(); // station -> latest Date
    for (const r of rows) {
      const ts = parseTs(r[timeKey]);
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

    // Refresh the roster snapshot alongside the pull so collapsed cards can show
    // linked/online/offline counts without a live Looker query per render. A
    // roster failure never fails the check — the stream reading already landed.
    // The same read powers the FLEET alert: when ≥ rosterAlertPct % of linked
    // devices are offline, alert once on the crossing (edge-detected via the
    // breach flag remembered in the snapshot), sharing the monitor's cooldown.
    if (m.rosterField) {
      try {
        const r = await deviceRoster(m);
        recordObservation(m, r, ts); // the connectivity record — see observedLog()
        const offlineN = r.total - r.online;
        const offlinePct = r.total ? Math.round((offlineN / r.total) * 100) : 0;
        const wasBreach = !!(m.rosterSnapshot && m.rosterSnapshot.breach);
        // Needs a real fleet (3+ linked) so 1-of-2 offline doesn't page anyone.
        const breach = m.rosterAlertPct >= 1 && r.total >= 3 && offlinePct >= m.rosterAlertPct;
        // Scan volume for the tile: total + average per hour over the roster
        // window (hour-level timeline read — tiny aggregated result).
        let totalScans = null, scansPerHour = null, lastHourScans = null, scansApprox = false, coverage = null, countField = null;
        const hourlyN = []; // devices seen per HOUR — keeps the flow score stable at fine blocks
        try {
          // 10-min blocks: the tile graph shows the day at the same resolution
          // as the live timeline (hour bars hid the short dropouts).
          const t = await deviceTimeline(m, rosterAnchor(m) ? 'start' : 12, 10);
          if (t.configured) {
            totalScans = t.grandTotal;
            countField = t.countField || null;
            scansApprox = t.countBasis === 'none' || !!t.truncated;
            scansPerHour = Math.round(t.grandTotal / Math.max(0.25, (Date.now() - Date.parse(t.buckets[0])) / 3600000));
            const perHour = Math.max(1, Math.round(60 / t.intervalMin));
            lastHourScans = t.bucketTotals.slice(-perHour).reduce((a, b) => a + b, 0); // rolling last ~60 min
            // Compact sparkline series for the tile: {t: 'HH:MM' UTC, n: devices sending}.
            coverage = t.buckets.map((b, i) => ({ t: b.slice(11, 16), n: t.devices.reduce((a, d) => a + (d.active[i] ? 1 : 0), 0) })).slice(-288);
            // A device counts as "on" for an hour if ANY of its blocks in that
            // hour sent data — a bar selling hourly isn't down five blocks of six.
            const perH = Math.max(1, Math.round(60 / t.intervalMin));
            for (let i = 0; i < t.buckets.length; i += perH) {
              const end = Math.min(i + perH, t.buckets.length);
              hourlyN.push(t.devices.reduce((a, d) => a + (d.active.slice(i, end).some((x) => x) ? 1 : 0), 0));
            }
          }
        } catch (e) { console.warn('[data-health] scan-rate read failed', m.id, e.message); }
        // The WHOLE FEED's day total: same explore and event scope, but the
        // station/category narrowing dropped — the headline can then show the
        // DAY'S transactions, not just the slice this monitor watches.
        let feedTotal = null;
        try {
          if (countField) {
            const b = { ...baseBody(m), fields: [countField], limit: '1' };
            for (const k of Object.keys(b.filters)) if (k === m.stationField || /station/i.test(k)) delete b.filters[k];
            const a2 = rosterAnchor(m);
            b.filters[m.timeField] = a2 ? `after ${a2.toISOString().slice(0, 16).replace('T', ' ')}` : 'last 12 hours';
            const rows2 = await runScoped(m, b);
            const v = rows2.length ? Number(rows2[0][countField]) : NaN;
            if (Number.isFinite(v)) feedTotal = v;
          }
        } catch (e) { console.warn('[data-health] feed total read failed', m.id, e.message); }
        // The tile day-graph reads the OBSERVED log once it has any history —
        // what Pulse saw at each check, which a late sync can never repaint.
        // The transaction-based series above stays as the fallback (fresh DB).
        try {
          const obs = sql.prepare('SELECT at, online FROM data_monitor_obs WHERE monitor_id=? AND at>=? ORDER BY at').all(m.id, r.startAt || new Date(nowMs - 12 * 3600000).toISOString());
          if (obs.length >= 3) coverage = obs.map((o) => ({ t: o.at.slice(11, 16), n: o.online })).slice(-288);
        } catch (e) { console.warn('[data-health] observed coverage failed', m.id, e.message); }
        // FLOW SCORE (0-100): one number for "is this station's device fleet
        // flowing" across the whole day. 60% uptime (mean share of LINKED
        // devices sending per block), 20% continuity (share of blocks with ANY
        // data — the connectivity dimension), 20% throughput (last-hour scan
        // rate holding up vs the day's average, capped at 1).
        let flowScore = null, flow = null;
        if (hourlyN.length && r.total) {
          const uptime = hourlyN.reduce((a, n) => a + Math.min(1, n / r.total), 0) / hourlyN.length;
          const continuity = hourlyN.filter((n) => n > 0).length / hourlyN.length;
          const throughput = scansPerHour ? Math.min(1, (lastHourScans || 0) / Math.max(1, scansPerHour)) : (continuity ? 1 : 0);
          flowScore = Math.round(100 * (0.6 * uptime + 0.2 * continuity + 0.2 * throughput));
          flow = { uptimePct: Math.round(uptime * 100), continuityPct: Math.round(continuity * 100), throughputPct: Math.round(throughput * 100) };
        }
        sql.prepare('UPDATE data_monitors SET roster_snapshot=? WHERE id=?').run(JSON.stringify({
          at: ts, total: r.total, online: r.online, offline: offlineN, offlinePct, breach,
          startAt: r.startAt || '', baselineMin: r.baselineMin, onlineMin: r.onlineMin,
          totalScans, scansPerHour, lastHourScans, scansApprox, feedTotal, coverage, flowScore, flow,
          // WHICH devices are offline (worst first, capped) — shown on the tile
          // and in the dashboard breakdown without opening the Devices tab.
          offlineDevices: r.offline.slice(0, 15).map((d) => ({ device: d.device, lagMin: d.lagMin })),
        }), m.id);
        if (breach && !wasBreach) {
          const names = r.offline.slice(0, 8).map((d) => `${d.device} (${fmtLag(d.lagMin)})`).join(', ');
          const bodyMsg = `${offlineN} of ${r.total} devices (${offlinePct}%) haven't synced in ${r.onlineMin}m — threshold ${m.rosterAlertPct}%. Offline: ${names}${offlineN > 8 ? ` +${offlineN - 8} more` : ''}.`;
          const cooled = !m.lastAlertedAt || (nowMs - new Date(m.lastAlertedAt).getTime()) >= m.cooldownMin * 60000;
          if (cooled) {
            const via = deliver(m, `📟 Devices offline — ${m.name || m.area || m.view}`, bodyMsg);
            recordEvent(m.id, '', 'device_alert', null, `${bodyMsg}${via.length ? ` → ${via.join(', ')}` : ' → no channel delivered'}`);
            sql.prepare('UPDATE data_monitors SET last_alerted_at=? WHERE id=?').run(ts, m.id);
          } else {
            recordEvent(m.id, '', 'device_alert', null, `${bodyMsg} (in cooldown — not re-sent)`);
          }
        } else if (!breach && wasBreach) {
          const bodyMsg = `Device fleet recovered — ${r.online} of ${r.total} online (${offlinePct}% offline, below the ${m.rosterAlertPct}% threshold).`;
          recordEvent(m.id, '', 'device_recovered', null, bodyMsg);
          if (m.notifyRecovery) deliver(m, `✅ Devices back online — ${m.name || m.area || m.view}`, bodyMsg);
        }
      } catch (e) { console.warn('[data-health] roster snapshot failed', m.id, e.message); }
    }
    return { ok: true, stations: streams.length, fresh, warn, stale, maxLagMin: maxLag, latestEventAt: latestOverall, newlyStale, recovered: recoveredNow };
  }

  // ── the tick ──
  // A 60s heartbeat; each monitor is actually checked when its cadence elapses —
  // its own check_every_min if set, else the master setting. Changing the master
  // in the UI therefore takes effect within a minute, no restart.
  const TICK_MS = Number(process.env.DATA_HEALTH_TICK_MS) || 60000;
  let ticking = false;
  async function tick() {
    if (!enabled() || ticking) return;
    ticking = true;
    try {
      const rows = sql.prepare("SELECT * FROM data_monitors WHERE status='active' AND model<>'' AND view<>'' AND time_field<>''").all().map(rowToMonitor);
      const nowMs = Date.now();
      const master = masterMin();
      for (const m of rows) {
        const cadence = m.checkEveryMin >= 1 ? m.checkEveryMin : master;
        if (m.lastCheckedAt && nowMs - new Date(m.lastCheckedAt).getTime() < cadence * 60000 - 5000) continue;
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
    res.json({ enabled: true, tickMin: masterMin(), testMode: testMode(), testEmail: testEmail(), monitors });
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
    if (b.tickMin != null) {
      const n = Math.round(Number(b.tickMin));
      if (!Number.isFinite(n) || n < 1 || n > 120) return res.status(400).json({ error: 'Auto-check must be between 1 and 120 minutes.' });
      db.setSetting('data_health_tick_min', String(n));
    }
    res.json({ testMode: testMode(), testEmail: testEmail(), tickMin: masterMin() });
  });

  // Saving takes a fresh reading right away (when active): an edited setting —
  // e.g. a changed online window — must show on the tile immediately, not
  // whenever the next scheduled check happens to run.
  async function checkAfterSave(monitor) {
    if (monitor.status !== 'active' || !monitor.model || !monitor.view || !monitor.timeField) return monitor;
    try { await check(monitor); } catch (e) { console.warn('[data-health] post-save check failed', monitor.id, e.message); }
    return monitorById(monitor.id);
  }

  app.post('/api/admin/data-health/monitors', auth.requireAdmin, asyncHandler(async (req, res) => {
    if (!enabled()) return off(res);
    const c = clean(req.body || {});
    if (!c.name) return res.status(400).json({ error: 'Give the monitor a name.' });
    if (!c.model || !c.view || !c.timeField) return res.status(400).json({ error: 'Pick the explore and its timestamp field.' });
    if (c.staleMin <= c.warnMin) c.warnMin = Math.max(1, Math.floor(c.staleMin / 2));
    res.status(201).json({ monitor: await checkAfterSave(upsert(null, c, req.user.email)) });
  }));

  app.put('/api/admin/data-health/monitors/:id', auth.requireAdmin, asyncHandler(async (req, res) => {
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
      maxMeasureUnsupported.delete(m.id);
      countModeByMonitor.delete(m.id); // re-learn the scan-count measure on the new explore
    }
    // The stored roster counts belong to the old roster setup — drop them; the
    // next check rebuilds the snapshot.
    if (c.rosterField !== m.rosterField || c.model !== m.model || c.view !== m.view) {
      sql.prepare("UPDATE data_monitors SET roster_snapshot='' WHERE id=?").run(m.id);
    }
    res.json({ monitor: await checkAfterSave(upsert(m.id, c, req.user.email)) });
  }));

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
    // 'closed' = the station is intentionally shut (gate closed for the night)
    // — no checks, no alerts; its devices leave the fleet numbers, but its
    // frozen day totals still count (the sales it made DID happen).
    const want = (req.body || {}).status;
    const status = want === 'paused' ? 'paused' : want === 'closed' ? 'closed' : 'active';
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

  // The last N raw records off the feed (live Looker read — a deliberate click,
  // not something the page polls).
  app.get('/api/admin/data-health/monitors/:id/latest', auth.requireAdmin, asyncHandler(async (req, res) => {
    if (!enabled()) return off(res);
    const m = monitorById(req.params.id);
    if (!m) return res.status(404).json({ error: 'Monitor not found' });
    res.json({ records: await latestRecords(m, req.query.limit), stationField: m.stationField, timeField: m.timeField, detailFields: (m.detailFields || []).filter((f) => f && f !== m.timeField && f !== m.stationField) });
  }));

  // The device roster (live Looker read — opened on demand from the log panel).
  app.get('/api/admin/data-health/monitors/:id/roster', auth.requireAdmin, asyncHandler(async (req, res) => {
    if (!enabled()) return off(res);
    const m = monitorById(req.params.id);
    if (!m) return res.status(404).json({ error: 'Monitor not found' });
    res.json(await deviceRoster(m, true));
  }));

  // The per-device day timeline (live Looker read, opened on demand).
  app.get('/api/admin/data-health/monitors/:id/timeline', auth.requireAdmin, asyncHandler(async (req, res) => {
    if (!enabled()) return off(res);
    const m = monitorById(req.params.id);
    if (!m) return res.status(404).json({ error: 'Monitor not found' });
    res.json(await deviceTimeline(m, req.query.hours, Number(req.query.interval) || 60, req.query.station || '', true));
  }));

  // The OBSERVED offline log (no live query — Pulse's own check history).
  app.get('/api/admin/data-health/monitors/:id/observed', auth.requireAdmin, (req, res) => {
    if (!enabled()) return off(res);
    const m = monitorById(req.params.id);
    if (!m) return res.status(404).json({ error: 'Monitor not found' });
    res.json(observedLog(m, obsSinceFor(m, req.query.hours)));
  });

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

  // ── shared read model: one monitor's full health picture, no live queries ──
  // Powers the client surface, the Owl tool and the report. Filters: entityIds
  // (a caller's allowed set), one entityId, one suiteId (suite-pinned monitors
  // plus the client's event-wide ones).
  function healthSummary({ entityIds = null, entityId = '', suiteId = '' } = {}) {
    let ms = sql.prepare('SELECT * FROM data_monitors ORDER BY name').all().map(rowToMonitor);
    if (entityIds) ms = ms.filter((m) => m.entityId && entityIds.includes(m.entityId));
    if (entityId) ms = ms.filter((m) => m.entityId === entityId);
    if (suiteId) ms = ms.filter((m) => !m.suiteId || m.suiteId === suiteId);
    return ms.map((m) => ({
      id: m.id, name: m.name, area: m.area, unit: unitFor(m), entityId: m.entityId, suiteId: m.suiteId,
      status: m.status, state: m.state, lastCheckedAt: m.lastCheckedAt, lastError: m.lastError,
      warnMin: m.warnMin, staleMin: m.staleMin, checkEveryMin: m.checkEveryMin,
      stationField: m.stationField, detailFields: m.detailFields,
      rosterField: m.rosterField, rosterAlertPct: m.rosterAlertPct, rosterSnapshot: m.rosterSnapshot,
      streams: streamsFor(m.id),
    }));
  }

  // Everything the AI needs about one station, gathered live (roster + timeline
  // are fresh Looker reads; activeBlocks is a compact 0/1 string per device).
  async function diagnosticsPayload(m) {
    const p = {
      monitor: { name: m.name, area: m.area, unit: unitFor(m), warnMin: m.warnMin, staleMin: m.staleMin, lastCheckedAt: m.lastCheckedAt, lastError: m.lastError || undefined },
      streams: streamsFor(m.id),
      recentEvents: sql.prepare('SELECT station, at, kind, lag_min, message FROM data_monitor_events WHERE monitor_id=? ORDER BY at DESC LIMIT 20').all(m.id),
    };
    if (m.rosterField) {
      try { const r = await deviceRoster(m, true); p.roster = { ...r, offline: r.offline.slice(0, 40) }; }
      catch (e) { p.rosterError = String(e.message || e).slice(0, 200); }
      try {
        const t = await deviceTimeline(m, rosterAnchor(m) ? 'start' : 12, 10, '', true);
        if (t.configured) {
          p.timeline = {
            intervalMin: t.intervalMin, startAt: t.startAt || '', countBasis: t.countBasis,
            window: { from: t.buckets[0], to: t.buckets[t.buckets.length - 1], blocks: t.buckets.length },
            totalScans: t.grandTotal, scansPerBlockAllDevices: t.bucketTotals,
            // Per-block coverage — the "where were the problems" series: for each
            // time block, how many devices sent data. Times are UTC HH:MM.
            coverage: t.buckets.map((b, i) => ({ atUTC: b.slice(11, 16), activeDevices: t.devices.reduce((n, d) => n + (d.active[i] ? 1 : 0), 0) })),
            devicesSeen: t.devices.length,
            devices: t.devices.slice(0, 80).map((d) => ({ device: d.device, station: d.station || undefined, operator: d.operator || undefined, totalScans: d.total, activeBlocks: d.active.join('') })),
          };
        }
      } catch (e) { p.timelineError = String(e.message || e).slice(0, 200); }
      // What Pulse ITSELF saw at check time — never repainted by late syncs.
      const ob = observedLog(m, obsSinceFor(m, 'start'));
      if (ob.configured) p.observedOfflineWindows = ob.windows.slice(0, 100);
    }
    return p;
  }

  // One bounded AI completion (key + standing instructions + metering come from
  // index.js via `ai`; insights is required lazily — its promptRegistry points
  // back at this module's prompts).
  const aiReady = () => !!(ai && ai.keyFor);
  const meter = (kind, entityId, fn) => (ai && ai.meter ? ai.meter(kind, entityId || null, fn) : fn());
  async function aiComplete(system, payload, { entityId = '', suiteId = '' }, maxTokens) {
    const lib = require('./insights');
    const c = lib.requireClient(ai.keyFor(entityId || ''));
    const resp = await c.messages.create({
      model: lib.MODEL, max_tokens: maxTokens, thinking: { type: 'adaptive' }, output_config: { effort: 'low' },
      system: lib.systemWith(system, ai.instructionsFor ? ai.instructionsFor(suiteId || null, entityId || '') : ''),
      messages: [{ role: 'user', content: JSON.stringify(payload).slice(0, 180000) }],
    });
    return (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  }

  // 🩺 one station's verdict · 📝 one event's report across all its stations.
  async function diagnose(m) {
    const payload = { now: now(), ...(await diagnosticsPayload(m)) };
    const text = await meter('data_health_diag', m.entityId, () => aiComplete(DATA_HEALTH_DIAG_SYSTEM, payload, m, 1200));
    return { text, at: now() };
  }
  async function eventReport({ entityId = '', suiteId = '' }) {
    const list = healthSummary({ entityId, suiteId }).filter((s) => s.entityId).slice(0, 12);
    const stations = [];
    for (const s of list) stations.push({ station: s.name, area: s.area, unit: s.unit, detail: await diagnosticsPayload(monitorById(s.id)) });
    const suite = suiteId && db.getSuite ? db.getSuite(suiteId) : null;
    const entity = entityId && db.getEntity ? db.getEntity(entityId) : null;
    const payload = { generatedAt: now(), event: suite ? suite.name : '', client: entity ? entity.name : '', stations };
    const eid = entityId || (suite ? suite.entityId : '');
    const markdown = await meter('data_health_report', eid, () => aiComplete(DATA_HEALTH_REPORT_SYSTEM, payload, { entityId: eid, suiteId }, 3500));
    // Chart-ready companion data: the UI draws the per-station coverage strips
    // and metric tiles from this, so the visuals are computed, never AI-guessed.
    const charts = stations.map((st) => {
      const t = st.detail.timeline || null;
      const r = st.detail.roster || null;
      const hrs = t ? Math.max(0.25, (Date.parse(t.window.to) + t.intervalMin * 60000 - Date.parse(t.window.from)) / 3600000) : 0;
      return {
        station: st.station, area: st.area, unit: st.unit,
        linked: r ? r.total : null, online: r ? r.online : null, offline: r ? r.total - r.online : null,
        totalScans: t ? t.totalScans : null, scansPerHour: t ? Math.round(t.totalScans / hrs) : null,
        intervalMin: t ? t.intervalMin : null, coverage: t ? t.coverage : [], devicesSeen: t ? t.devicesSeen : 0,
      };
    });
    return { markdown, charts, at: now(), monitors: list.length };
  }

  app.post('/api/admin/data-health/monitors/:id/diagnose', auth.requireAdmin, asyncHandler(async (req, res) => {
    if (!enabled()) return off(res);
    if (!aiReady()) return res.status(503).json({ error: 'AI is not configured.' });
    const m = monitorById(req.params.id);
    if (!m) return res.status(404).json({ error: 'Monitor not found' });
    res.json(await diagnose(m));
  }));
  app.post('/api/admin/data-health/report', auth.requireAdmin, asyncHandler(async (req, res) => {
    if (!enabled()) return off(res);
    if (!aiReady()) return res.status(503).json({ error: 'AI is not configured.' });
    const { entityId, suiteId } = req.body || {};
    if (!entityId && !suiteId) return res.status(400).json({ error: 'entityId or suiteId required' });
    res.json(await eventReport({ entityId: String(entityId || ''), suiteId: String(suiteId || '') }));
  }));

  // ── client self-service surface (read-only — the dual-surface rule) ──
  // Clients see monitors pinned to THEIR entity (optionally narrowed to one
  // event) with the same live tabs; setup stays in Admin.
  const requireAuth = auth.requireAuth || auth.requireAdmin;
  function myMonitor(req, res) {
    const m = monitorById(req.params.id);
    if (!m) { res.status(404).json({ error: 'Monitor not found' }); return null; }
    if (req.user && req.user.role === 'admin') return m;
    if (!m.entityId || !((req.user && req.user.entityIds) || []).includes(m.entityId)) {
      res.status(403).json({ error: 'Not your monitor' }); return null;
    }
    return m;
  }
  app.get('/api/my/data-health', requireAuth, (req, res) => {
    if (!enabled()) return off(res);
    const isAdmin = req.user && req.user.role === 'admin';
    const mine = (req.user && req.user.entityIds) || [];
    const entityId = String(req.query.entityId || '');
    if (entityId && !isAdmin && !mine.includes(entityId)) return res.status(403).json({ error: 'Not your client' });
    const monitors = healthSummary({ entityIds: isAdmin ? null : mine, entityId, suiteId: String(req.query.suiteId || '') })
      .filter((m) => m.entityId); // entity-pinned only — platform monitors are internal
    res.json({ monitors });
  });
  const MY_READS = {
    latest: async (req, m) => ({ records: await latestRecords(m, req.query.limit), stationField: m.stationField, timeField: m.timeField, detailFields: (m.detailFields || []).filter((f) => f && f !== m.timeField && f !== m.stationField) }),
    roster: async (_req, m) => deviceRoster(m, true),
    observed: async (req, m) => observedLog(m, obsSinceFor(m, req.query.hours)),
    timeline: async (req, m) => deviceTimeline(m, req.query.hours, Number(req.query.interval) || 60, req.query.station || '', true),
    history: async (_req, m) => ({
      checks: sql.prepare('SELECT at, ok, stations, fresh, warn, stale, max_lag_min, latest_event_at, error FROM data_monitor_checks WHERE monitor_id=? ORDER BY at DESC LIMIT 200').all(m.id),
      events: sql.prepare('SELECT station, at, kind, lag_min, message FROM data_monitor_events WHERE monitor_id=? ORDER BY at DESC LIMIT 200').all(m.id),
    }),
  };
  for (const [path, fn] of Object.entries(MY_READS)) {
    app.get(`/api/my/data-health/monitors/:id/${path}`, requireAuth, asyncHandler(async (req, res) => {
      if (!enabled()) return off(res);
      const m = myMonitor(req, res); if (!m) return;
      res.json(await fn(req, m));
    }));
  }
  app.post('/api/my/data-health/monitors/:id/diagnose', requireAuth, asyncHandler(async (req, res) => {
    if (!enabled()) return off(res);
    if (!aiReady()) return res.status(503).json({ error: 'AI is not configured.' });
    const m = myMonitor(req, res); if (!m) return;
    res.json(await diagnose(m));
  }));
  app.post('/api/my/data-health/report', requireAuth, asyncHandler(async (req, res) => {
    if (!enabled()) return off(res);
    if (!aiReady()) return res.status(503).json({ error: 'AI is not configured.' });
    const isAdmin = req.user && req.user.role === 'admin';
    const mine = (req.user && req.user.entityIds) || [];
    const entityId = String((req.body || {}).entityId || '') || (isAdmin ? '' : mine[0] || '');
    if (!isAdmin && !mine.includes(entityId)) return res.status(403).json({ error: 'Not your client' });
    res.json(await eventReport({ entityId, suiteId: String((req.body || {}).suiteId || '') }));
  }));

  // ── editor metadata: the explore + field pickers (cached, admin-only) ──
  let _models = null, _modelsAt = 0;
  app.get('/api/admin/data-health/explores', auth.requireAdmin, asyncHandler(async (_req, res) => {
    if (!enabled()) return off(res);
    if (!_models || Date.now() - _modelsAt > 10 * 60000) { _models = await looker.listModels(); _modelsAt = Date.now(); }
    res.json({ models: _models });
  }));

  // Distinct values of one dimension, scoped like the monitor would be — powers
  // the editor's linked value dropdowns (e.g. pick a real station name).
  app.post('/api/admin/data-health/field-values', auth.requireAdmin, asyncHandler(async (req, res) => {
    if (!enabled()) return off(res);
    const { model, view, field, entityId, suiteId, filters } = req.body || {};
    if (!model || !view || !field) return res.status(400).json({ error: 'model, view and field required' });
    res.json({ values: await fieldValues({ model, view, field, entityId, suiteId, filters }) });
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
  return { check, tick, monitorById, upsert, clean, streamsFor, latestRecords, fieldValues, deviceRoster, deviceTimeline, rosterAnchor, observedLog, obsSinceFor, healthSummary, diagnosticsPayload, diagnose, eventReport };
}

module.exports = { mount, AREAS, CHANNELS, DATA_HEALTH_DIAG_SYSTEM, DATA_HEALTH_REPORT_SYSTEM };
