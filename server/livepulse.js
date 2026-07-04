// ─── Live Pulse: recurring multi-metric event-day updates ────────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the `live_pulses` + `live_pulse_runs`
// tables and all /api/livepulse routes. Mounted from index.js with one line +
// injected deps. Where an ALERT watches ONE number for a threshold cross, a live
// pulse sends the organiser a compact MULTI-metric snapshot on a cadence while the
// event runs — "20:00: 4,213 through the gates (+612 · ~1,220/hr), bar revenue
// R38,400, top bars …, devices 94/102". Surfaced as the "Live updates" tab of the
// Alerts page (same alerts.manage permission — it's a subsection of Alerts, not a
// new nav item). Kill switch: settings key `livepulse_enabled` ('0' disables the
// tick + 404s the routes). To remove: delete this file + the mount line, drop the
// live_pulse_* tables. Nothing else depends on it.
//
// The parts that make it more than several alerts stapled together:
//   • snapshots — every send stores its values, so the NEXT send can say
//     "+612 since 19:30" and derive a per-hour rate from consecutive runs;
//   • blocks — an update is a list of blocks (single value / top-N list / EventOps
//     device summary), each reading through the SAME scope-enforced paths the
//     dashboards use (resolveTileValue / resolveTileRows / resolveCustomMetric);
//   • last-event comparison — a value block can also read the SAME metric under a
//     previous event's suite and show "78% of <last event>";
//   • event window — it only sends while the event is live: a manual Go-live
//     switch and/or a scheduled window; claim-before-send so a redeploy mid-send
//     can drop one update, never double-send;
//   • WhatsApp — free-form WhatsApp is only allowed inside the 24h customer-care
//     window, so WhatsApp recipients only get the update if they've messaged the
//     Owl in the last 24h (checked against owl_wa_msgs); others are skipped.

const crypto = require('crypto');

const DEFAULT_TZ = 'Africa/Johannesburg'; // GMT+2
const CHANNELS = ['push', 'email', 'sms', 'whatsapp']; // inbox is always-on (the canonical record)
const BLOCK_TYPES = ['value', 'top_list', 'eventops', 'signal'];
const MAX_BLOCKS = 8;

function mount(app, { db, auth, resolveTileValue, resolveTileRows, resolveCustomMetric, resolveEventDate, os, mailer, messaging, eventops, push, signalFlow }) {
  const sql = db.db;
  const now = () => new Date().toISOString();
  const uuid = () => crypto.randomUUID();
  const enabled = () => db.getSetting('livepulse_enabled', '1') !== '0'; // on by default; kill switch

  sql.exec(`
    CREATE TABLE IF NOT EXISTS live_pulses (
      id              TEXT PRIMARY KEY,
      entity_id       TEXT NOT NULL,
      suite_id        TEXT NOT NULL,
      name            TEXT NOT NULL DEFAULT '',
      cadence_min     INTEGER NOT NULL DEFAULT 30,      -- minutes between updates (10..240)
      window_start    TEXT NOT NULL DEFAULT '',         -- ISO; '' = manual go-live only
      window_end      TEXT NOT NULL DEFAULT '',
      live            INTEGER NOT NULL DEFAULT 0,       -- manual Go-live switch (doors opened early / overran)
      blocks          TEXT NOT NULL DEFAULT '[]',       -- [{type:'value'|'top_list'|'eventops', ...}]
      channels        TEXT NOT NULL DEFAULT '["push"]', -- subset of push|email|sms|whatsapp
      sms_recipients  TEXT NOT NULL DEFAULT '[]',       -- E.164-ish phone list
      wa_recipients   TEXT NOT NULL DEFAULT '[]',       -- WhatsApp numbers (24h-window gated at send time)
      compare_suite_id TEXT NOT NULL DEFAULT '',        -- previous event to compare against ('' = off)
      compare_label   TEXT NOT NULL DEFAULT '',         -- how the comparison is named ("last year")
      timezone        TEXT NOT NULL DEFAULT '${DEFAULT_TZ}',
      status          TEXT NOT NULL DEFAULT 'active',   -- active | paused
      last_sent_at    TEXT NOT NULL DEFAULT '',
      send_count      INTEGER NOT NULL DEFAULT 0,
      created_via     TEXT NOT NULL DEFAULT '',         -- provenance: owl | api | ''
      created_by      TEXT NOT NULL DEFAULT '',
      created_at      TEXT NOT NULL,
      updated_by      TEXT NOT NULL DEFAULT '',
      updated_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_live_pulses_suite ON live_pulses(suite_id);
    CREATE INDEX IF NOT EXISTS idx_live_pulses_active ON live_pulses(status);

    CREATE TABLE IF NOT EXISTS live_pulse_runs (
      id        TEXT PRIMARY KEY,
      pulse_id  TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      at        TEXT NOT NULL,
      message   TEXT NOT NULL DEFAULT '',
      values_json TEXT NOT NULL DEFAULT '{}',  -- {blockId: {value|rows|ops}} — the snapshot deltas read from
      channels  TEXT NOT NULL DEFAULT '[]',    -- what we actually fanned out to
      status    TEXT NOT NULL DEFAULT 'sent'   -- sent | error
    );
    CREATE INDEX IF NOT EXISTS idx_live_pulse_runs ON live_pulse_runs(pulse_id, at);
  `);

  const parseJson = (s, fb) => { try { const v = JSON.parse(s); return v == null ? fb : v; } catch { return fb; } };
  const isAdmin = (u) => u && u.role === 'admin';

  function rowToPulse(r) {
    if (!r) return null;
    return {
      id: r.id, entityId: r.entity_id, suiteId: r.suite_id, name: r.name,
      cadenceMin: r.cadence_min, windowStart: r.window_start, windowEnd: r.window_end, live: !!r.live,
      blocks: parseJson(r.blocks, []), channels: parseJson(r.channels, ['push']),
      smsRecipients: parseJson(r.sms_recipients, []), waRecipients: parseJson(r.wa_recipients, []),
      compareSuiteId: r.compare_suite_id, compareLabel: r.compare_label, timezone: r.timezone,
      status: r.status, lastSentAt: r.last_sent_at, sendCount: r.send_count,
      createdVia: r.created_via || '', createdBy: r.created_by, createdAt: r.created_at,
      updatedBy: r.updated_by, updatedAt: r.updated_at,
    };
  }
  const pulseById = (id) => rowToPulse(sql.prepare('SELECT * FROM live_pulses WHERE id=?').get(id));
  const listForSuite = (suiteId) => sql.prepare('SELECT * FROM live_pulses WHERE suite_id=? ORDER BY created_at DESC').all(suiteId).map(rowToPulse);
  const runsFor = (pulseId, limit = 20) => sql.prepare('SELECT * FROM live_pulse_runs WHERE pulse_id=? ORDER BY at DESC LIMIT ?').all(pulseId, limit)
    .map((r) => ({ id: r.id, at: r.at, message: r.message, channels: parseJson(r.channels, []), status: r.status }));
  const lastSentRun = (pulseId) => sql.prepare("SELECT * FROM live_pulse_runs WHERE pulse_id=? AND status='sent' ORDER BY at DESC LIMIT 1").get(pulseId);

  // ── sanitise an incoming config from the client ──
  const phoneList = (a) => (Array.isArray(a)
    ? [...new Set(a.map((p) => String(p).replace(/[^\d+]/g, '')).filter((p) => p.replace(/\D/g, '').length >= 7))].slice(0, 25) : []);
  function cleanBlock(b) {
    if (!b || typeof b !== 'object') return null;
    const type = BLOCK_TYPES.includes(b.type) ? b.type : 'value';
    const out = {
      id: String(b.id || '').slice(0, 40) || crypto.randomUUID().slice(0, 8),
      type, label: String(b.label || '').slice(0, 80), icon: String(b.icon || '').slice(0, 8),
    };
    if (type === 'eventops') return out; // reads the EventOps suite summary; nothing else to configure
    if (type === 'signal') { // scope: '' = whole event · category = one zone · station = one station
      out.station = String(b.station || '').slice(0, 120);
      out.category = String(b.category || '').slice(0, 120);
      out.metric = ['flow', 'online', 'offline', 'both'].includes(b.metric) ? b.metric : 'flow';
      return out;
    }
    out.unit = String(b.unit || '').slice(0, 16);
    if (type === 'top_list') {
      // A top-N list reads the TABLE behind a breakdown tile (e.g. "Revenue by bar").
      out.dashboardId = String(b.dashboardId || '').slice(0, 64);
      out.tileId = String(b.tileId || '').slice(0, 64);
      out.tileName = String(b.tileName || '').slice(0, 200);
      out.topN = Math.max(1, Math.min(5, Math.round(Number(b.topN)) || 3));
      return out.dashboardId && out.tileId ? out : null;
    }
    // value block: a KPI tile or a raw measure, same two sources alerts use.
    out.source = b.source === 'metric' ? 'metric' : 'tile';
    out.showDelta = b.showDelta !== false;          // "+612 since 19:30" (on by default)
    out.showRate = !!b.showRate;                    // "~1,220/hr" derived from consecutive snapshots
    out.compare = !!b.compare;                      // "% of <last event>"
    // How the comparison is cut: 'final' = the past event's end number; 'same_point' =
    // LIKE-FOR-LIKE — the past event clipped to the same day-of-event + clock time
    // (needs a date dimension to clip on; metric source only). Falls back to final.
    out.compareMode = b.compareMode === 'same_point' ? 'same_point' : 'final';
    out.compareClipField = String(b.compareClipField || '').slice(0, 200);
    if (out.source === 'metric') {
      out.model = String(b.model || '').slice(0, 120);
      out.view = String(b.view || '').slice(0, 120);
      out.measure = String(b.measure || '').slice(0, 200);
      out.measureLabel = String(b.measureLabel || '').slice(0, 200);
      const mf = {};
      if (b.metricFilters && typeof b.metricFilters === 'object' && !Array.isArray(b.metricFilters)) {
        for (const [k, v] of Object.entries(b.metricFilters).slice(0, 10)) {
          if (k && v != null && String(v).trim()) mf[String(k).slice(0, 200)] = String(v).slice(0, 500);
        }
      }
      out.metricFilters = mf;
      return out.model && out.view && out.measure ? out : null;
    }
    out.dashboardId = String(b.dashboardId || '').slice(0, 64);
    out.tileId = String(b.tileId || '').slice(0, 64);
    out.tileName = String(b.tileName || '').slice(0, 200);
    return out.dashboardId && out.tileId ? out : null;
  }
  function clean(b, entityId, suiteId) {
    const isoOrBlank = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? new Date(t).toISOString() : ''; };
    const channels = Array.isArray(b.channels) ? [...new Set(b.channels.filter((c) => CHANNELS.includes(c)))] : [];
    const blocks = (Array.isArray(b.blocks) ? b.blocks : []).map(cleanBlock).filter(Boolean).slice(0, MAX_BLOCKS);
    // The comparison event must be one of the SAME client's events (never cross-tenant).
    let compareSuiteId = String(b.compareSuiteId || '').slice(0, 64);
    if (compareSuiteId) {
      const cs = db.getSuite(compareSuiteId);
      if (!cs || cs.entityId !== entityId || cs.id === suiteId) compareSuiteId = '';
    }
    return {
      entityId, suiteId,
      name: String(b.name || '').slice(0, 120),
      cadenceMin: Math.max(10, Math.min(240, Math.round(Number(b.cadenceMin)) || 30)),
      windowStart: isoOrBlank(b.windowStart), windowEnd: isoOrBlank(b.windowEnd),
      blocks, channels: channels.length ? channels : ['push'],
      smsRecipients: phoneList(b.smsRecipients), waRecipients: phoneList(b.waRecipients),
      compareSuiteId, compareLabel: String(b.compareLabel || '').slice(0, 80),
      timezone: String(b.timezone || DEFAULT_TZ).slice(0, 64),
      status: b.status === 'paused' ? 'paused' : 'active',
    };
  }

  function upsert(id, c, who) {
    const ts = now();
    if (id) {
      sql.prepare(`UPDATE live_pulses SET name=?, cadence_min=?, window_start=?, window_end=?, blocks=?, channels=?,
        sms_recipients=?, wa_recipients=?, compare_suite_id=?, compare_label=?, timezone=?, status=?, updated_by=?, updated_at=? WHERE id=?`)
        .run(c.name, c.cadenceMin, c.windowStart, c.windowEnd, JSON.stringify(c.blocks), JSON.stringify(c.channels),
          JSON.stringify(c.smsRecipients), JSON.stringify(c.waRecipients), c.compareSuiteId, c.compareLabel, c.timezone, c.status, who || '', ts, id);
      return pulseById(id);
    }
    const nid = uuid();
    sql.prepare(`INSERT INTO live_pulses (id, entity_id, suite_id, name, cadence_min, window_start, window_end, blocks, channels,
      sms_recipients, wa_recipients, compare_suite_id, compare_label, timezone, status, created_by, created_at, updated_by, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(nid, c.entityId, c.suiteId, c.name, c.cadenceMin, c.windowStart, c.windowEnd, JSON.stringify(c.blocks), JSON.stringify(c.channels),
        JSON.stringify(c.smsRecipients), JSON.stringify(c.waRecipients), c.compareSuiteId, c.compareLabel, c.timezone, c.status, who || '', ts, who || '', ts);
    return pulseById(nid);
  }

  // ── formatting (mirrors alerts so numbers read the same everywhere) ──
  function fmtNum(v, unit, moneySym = 'R') {
    if (v == null) return '—';
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    const s = Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-ZA') : String(Math.round(n * 100) / 100);
    if (unit === 'ZAR') return `${moneySym}${s}`; // generic money unit; symbol follows the client's reporting currency
    if (unit === '%') return `${s}%`;
    return unit && unit !== 'count' ? `${s} ${unit}` : s;
  }
  function moneySymFor(p) {
    try { return require('./currency').symbolFor(mailer.resolveBranding(p.entityId, p.suiteId).currency); }
    catch { return 'R'; }
  }
  function localHHMM(tz, date = new Date()) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(date);
      const hh = parts.find((x) => x.type === 'hour')?.value || '00';
      const mm = parts.find((x) => x.type === 'minute')?.value || '00';
      return `${hh}:${mm}`;
    } catch { return ''; }
  }

  // ── reading blocks (scoped exactly like alerts: a synthetic client user) ──
  function evalUser(p) {
    return { id: `livepulse:${p.entityId}`, email: p.createdBy || 'livepulse@howler', role: 'client', entityIds: [p.entityId] };
  }
  async function readValueBlock(p, b, suiteId, extraFilters) {
    try {
      if (b.source === 'metric') {
        if (typeof resolveCustomMetric !== 'function') return null;
        const v = await resolveCustomMetric({ model: b.model, view: b.view, measure: b.measure, filters: { ...(b.metricFilters || {}), ...(extraFilters || {}) }, user: evalUser(p), suiteId });
        return v == null ? null : Number(v);
      }
      if (typeof resolveTileValue !== 'function') return null;
      const v = await resolveTileValue({ dashboardId: b.dashboardId, tileId: b.tileId, user: evalUser(p), suiteId });
      return v == null ? null : Number(v);
    } catch (e) { console.error('[livepulse] value read failed', p.id, b.id, e.message); return null; }
  }
  // Top-N off a breakdown tile: first field = the name, last field = the number
  // (resolveTileRows lists dimensions first, measures last — a "revenue by bar"
  // table is one of each). Sorted here so the tile's own sort doesn't matter.
  async function readTopListBlock(p, b) {
    try {
      if (typeof resolveTileRows !== 'function') return [];
      const r = await resolveTileRows({ dashboardId: b.dashboardId, tileId: b.tileId, user: evalUser(p), suiteId: p.suiteId, limit: 200 });
      if (!r || !r.fields || r.fields.length < 2) return [];
      const nameF = r.fields[0].name, valF = r.fields[r.fields.length - 1].name;
      return (r.rows || [])
        .map((row) => ({ name: String(row[nameF] ?? '').slice(0, 60), value: Number(row[valF]) }))
        .filter((x) => x.name && Number.isFinite(x.value))
        .sort((a, c) => c.value - a.value)
        .slice(0, b.topN || 3);
    } catch (e) { console.error('[livepulse] top-list read failed', p.id, b.id, e.message); return []; }
  }
  function readEventOpsBlock(p) {
    try {
      if (!eventops || typeof eventops.suiteSummary !== 'function') return null;
      const s = eventops.suiteSummary(p.suiteId);
      if (!s) return null;
      return { deployed: s.devices.deployed, total: s.devices.total, lost: s.devices.lost, damaged: s.devices.damaged, openIssues: s.openIssues };
    } catch { return null; }
  }
  // Signal flow off the Data health board: % of roster devices online, overall or
  // for one station. `b.station` blank = the whole event. Computed live (never a
  // stored snapshot) so it's the same number the flow meter shows.
  function readSignalBlock(p, b) {
    try {
      if (typeof signalFlow !== 'function') return null;
      const f = signalFlow(p.suiteId, { station: b.station || '', category: b.category || '' });
      return f && (f.total || (f.stations && f.stations.length)) ? f : null;
    } catch (e) { console.error('[livepulse] signal read failed', p.id, b.id, e.message); return null; }
  }
  // One compact reading of a signal block, honouring its metric mode (flow % /
  // online / offline / both). Shared by the message and the preview.
  function signalText(b, f) {
    if (!f || f.pct == null) return null;
    const below = f.target != null && f.pct < f.target ? ` ⚠️ below target ${f.target}%` : '';
    const m = b.metric || 'flow';
    if (m === 'online') return `${f.on} online (of ${f.total})`;
    if (m === 'offline') return `${f.off} offline (of ${f.total})`;
    if (m === 'both') return `${f.on} online · ${f.off} offline · ${f.pct}%${below}`;
    return `${f.pct}% online (${f.on}/${f.total})${below}`;
  }

  // ── like-for-like ("same point in time") comparison ──
  // Mid-event, "% of last year's FINAL" answers the wrong question — organisers want
  // "how am I tracking vs last year BY THIS POINT": day N of the event at the same
  // clock time, which works for single- and multi-day events alike. Both events are
  // anchored on their Looker start dates (core_events.start_date via
  // resolveEventDate); we compute how far into THIS event we are (whole local days +
  // wall-clock HH:MM in the pulse's timezone) and clip the past event's read with a
  // `before <their day N> <same HH:MM>` filter on the block's date dimension.
  // Every step fails SOFT to the final-total comparison — a number still lands.
  const evStartCache = new Map(); // suiteId -> { at, date } (one tiny Looker query; 6h TTL)
  async function eventStartDate(p, suiteId) {
    const hit = evStartCache.get(suiteId);
    if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.date;
    let date = null;
    try { if (typeof resolveEventDate === 'function') date = await resolveEventDate({ suiteId, user: evalUser(p) }); } catch { date = null; }
    evStartCache.set(suiteId, { at: Date.now(), date });
    return date;
  }
  function localYMD(tz, date = new Date()) {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); } catch { return null; }
  }
  function addDays(ymd, n) { const d = new Date(Date.parse(`${ymd}T12:00:00Z`)); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  async function samePointClip(p, b) {
    if (b.source !== 'metric' || (b.compareMode || 'final') !== 'same_point' || !b.compareClipField) return null;
    const curStart = await eventStartDate(p, p.suiteId);
    const cmpStart = await eventStartDate(p, p.compareSuiteId);
    const today = localYMD(p.timezone);
    const hhmm = localHHMM(p.timezone);
    if (!curStart || !cmpStart || !today || !hhmm) return null;
    const dayN = Math.max(0, Math.round((Date.parse(today) - Date.parse(curStart)) / 86400e3));
    return { [b.compareClipField]: `before ${addDays(cmpStart, dayN)} ${hhmm}` };
  }

  // One full snapshot: every block's current reading (+ the comparison event's
  // reading for blocks that asked for it). Stored on the run so the NEXT run can
  // compute "+since last" deltas and per-hour rates from it.
  async function buildSnapshot(p) {
    const snap = {};
    for (const b of p.blocks || []) {
      if (b.type === 'eventops') { snap[b.id] = { ops: readEventOpsBlock(p) }; continue; }
      if (b.type === 'signal') { snap[b.id] = { flow: readSignalBlock(p, b) }; continue; }
      if (b.type === 'top_list') { snap[b.id] = { rows: await readTopListBlock(p, b) }; continue; }
      const cur = { value: await readValueBlock(p, b, p.suiteId) };
      if (b.compare && p.compareSuiteId) {
        const clip = await samePointClip(p, b);
        cur.compare = await readValueBlock(p, b, p.compareSuiteId, clip || undefined);
        cur.compareMode = clip ? 'same_point' : 'final';
      }
      snap[b.id] = cur;
    }
    return snap;
  }

  // ── the wording: one compact, phone-first text block ──
  const BLOCK_ICON = { value: '📊', top_list: '🏆', eventops: '🎛', signal: '📶' };
  function composeMessage(p, snap, prevRun) {
    const sym = moneySymFor(p);
    const prev = prevRun ? parseJson(prevRun.values_json, {}) : {};
    const prevAt = prevRun ? prevRun.at : '';
    const prevMin = prevAt ? Math.max(1, Math.round((Date.now() - Date.parse(prevAt)) / 60000)) : 0;
    const compareName = p.compareLabel || 'last event';
    const lines = [];
    for (const b of p.blocks || []) {
      const s = snap[b.id] || {};
      const icon = b.icon || BLOCK_ICON[b.type] || '📊';
      const label = b.label || b.tileName || b.measureLabel || 'Metric';
      if (b.type === 'eventops') {
        const o = s.ops;
        if (!o) continue;
        const bits = [`${o.deployed} deployed / ${o.total} devices`];
        if (o.openIssues) bits.push(`${o.openIssues} open issue${o.openIssues === 1 ? '' : 's'}`);
        if (o.lost + o.damaged) bits.push(`${o.lost + o.damaged} lost/damaged`);
        lines.push(`${icon} ${label || 'Devices'}: ${bits.join(' · ')}`);
        continue;
      }
      if (b.type === 'top_list') {
        if (!(s.rows || []).length) continue;
        lines.push(`${icon} ${label}: ${s.rows.map((r) => `${r.name} ${fmtNum(r.value, b.unit, sym)}`).join(' · ')}`);
        continue;
      }
      if (b.type === 'signal') {
        const txt = signalText(b, s.flow);
        if (!txt) continue;
        const scope = (s.flow && s.flow.scope) || 'all stations';
        lines.push(`${icon} ${label || 'Signal flow'}${scope ? ` (${scope})` : ''}: ${txt}`);
        continue;
      }
      // value block
      if (s.value == null) continue;
      const bits = [fmtNum(s.value, b.unit, sym)];
      const pv = prev[b.id] && prev[b.id].value;
      if (b.showDelta && pv != null && prevMin > 0) {
        const d = s.value - pv;
        const dTxt = `${d >= 0 ? '+' : '−'}${fmtNum(Math.abs(d), b.unit, sym)}`;
        const extra = [];
        extra.push(`${dTxt} since ${localHHMM(p.timezone, new Date(Date.parse(prevAt)))}`);
        if (b.showRate && d >= 0) extra.push(`~${fmtNum((d / prevMin) * 60, b.unit === 'ZAR' ? 'ZAR' : '', sym)}/hr`);
        bits.push(`(${extra.join(' · ')})`);
      }
      if (b.compare && s.compare != null && Number(s.compare) > 0) {
        // "by this point" = like-for-like (same day-of-event + clock time); otherwise
        // the % is against the past event's final number — say which, honestly.
        bits.push(`· ${Math.round((s.value / Number(s.compare)) * 100)}% of ${compareName}${s.compareMode === 'same_point' ? ' by this point' : ''}`);
      }
      lines.push(`${icon} ${label}: ${bits.join(' ')}`);
    }
    const su = db.getSuite(p.suiteId);
    const head = `⚡ ${p.name || 'Live update'} — ${su ? su.name : 'your event'} · ${localHHMM(p.timezone)}`;
    const tail = `Next update ~${p.cadenceMin} min.`;
    return lines.length ? `${head}\n${lines.join('\n')}\n${tail}` : `${head}\nNo readable metrics yet — check the blocks in Pulse.\n${tail}`;
  }

  // ── WhatsApp 24h customer-care window ──
  // Free-form WhatsApp (no template) is only allowed to numbers that messaged US in
  // the last 24h. The Owl logs every inbound in owl_wa_msgs — the window is simply
  // the latest 'user' row's age. Fail CLOSED (no table / no inbound → no send).
  function waInWindow(msisdn) {
    try {
      const r = sql.prepare("SELECT MAX(created_at) c FROM owl_wa_msgs WHERE msisdn=? AND role='user'").get(msisdn);
      return !!(r && r.c) && (Date.now() - Date.parse(r.c)) < 24 * 60 * 60 * 1000;
    } catch { return false; }
  }

  // ── deliver: inbox (always) + push/email via the OS spine + SMS/WhatsApp direct ──
  function deliver(p, message) {
    const delivered = ['inbox'];
    const osChannels = (p.channels || []).filter((c) => c === 'push' || c === 'email');
    try {
      if (os?.announce) {
        // ONE thread per pulse (subjectType/subjectId): every update appends to it,
        // so the inbox holds a scrollable log of the whole event night.
        os.announce({
          entityId: p.entityId,
          title: `⚡ ${p.name || 'Live update'}`,
          body: message,
          priority: 'fyi', createdBy: 'livepulse', authorType: 'system',
          channels: osChannels,           // [] => inbox only
          subjectType: 'livepulse', subjectId: p.id,
        });
        for (const c of osChannels) delivered.push(c);
      }
    } catch (e) { console.error('[livepulse] inbox/announce failed', p.id, e.message); }
    const link = mailer?.baseUrl ? mailer.baseUrl() : '';
    if ((p.channels || []).includes('sms') && messaging?.sendSms && (p.smsRecipients || []).length) {
      const text = `${message}${link ? `\n${link}` : ''}`.slice(0, 600);
      for (const to of p.smsRecipients) messaging.sendSms({ to, text }).catch(() => {});
      delivered.push('sms');
    }
    if ((p.channels || []).includes('whatsapp') && messaging?.sendWhatsapp && (p.waRecipients || []).length) {
      let sent = 0, skipped = 0;
      for (const to of p.waRecipients) {
        const msisdn = messaging.normaliseMsisdn ? messaging.normaliseMsisdn(to) : to;
        if (!waInWindow(msisdn)) { skipped++; continue; } // outside 24h window — needs a template, so skip
        messaging.sendWhatsapp({ to: msisdn, text: message.slice(0, 1000) }).catch(() => {});
        sent++;
      }
      if (sent) delivered.push('whatsapp');
      if (skipped) delivered.push(`whatsapp-skipped:${skipped}`);
    }
    return [...new Set(delivered)];
  }

  function recordRun(p, message, snap, channels, status) {
    sql.prepare('INSERT INTO live_pulse_runs (id, pulse_id, entity_id, at, message, values_json, channels, status) VALUES (?,?,?,?,?,?,?,?)')
      .run(uuid(), p.id, p.entityId, now(), message, JSON.stringify(snap).slice(0, 60000), JSON.stringify(channels || []), status);
    // Keep the log bounded: an event night at 15-min cadence is < 100 runs.
    sql.prepare('DELETE FROM live_pulse_runs WHERE pulse_id=? AND id NOT IN (SELECT id FROM live_pulse_runs WHERE pulse_id=? ORDER BY at DESC LIMIT 200)').run(p.id, p.id);
  }

  // Send ONE update now. `manual` (the editor's "Send now") delivers for real but
  // does NOT claim the cadence slot, so the schedule keeps its own rhythm.
  async function sendUpdate(p, { manual = false } = {}) {
    const ts = now();
    if (!manual) {
      // Claim BEFORE reading/delivering (mark-before-send): if the process dies
      // mid-send the cadence stops the next tick re-sending — a crash can drop one
      // update, never spam repeats. Same convention as alerts + the digest scheduler.
      sql.prepare('UPDATE live_pulses SET last_sent_at=?, send_count=send_count+1 WHERE id=?').run(ts, p.id);
    }
    const prevRun = lastSentRun(p.id);
    const snap = await buildSnapshot(p);
    const message = composeMessage(p, snap, prevRun);
    const channels = deliver(p, message);
    recordRun(p, message, snap, channels, 'sent');
    return { message, channels, snapshot: snap };
  }

  // ── Preview (setup-time verification) ────────────────────────────────────────
  // Resolve every block's CURRENT number for a DRAFT config without sending or
  // saving — so the editor can show "is this pulling the right number?" as you
  // build. Incomplete blocks (no tile/measure picked yet) are dropped by clean().
  async function previewDraft(draft, { entityId, suiteId, user }) {
    const c = clean(draft || {}, entityId, suiteId);
    const p = { id: 'preview', ...c, entityId, suiteId, createdBy: (user && user.email) || 'preview' };
    const snap = await buildSnapshot(p);
    const message = composeMessage(p, snap, null); // no "since last" baseline in a preview
    const sym = moneySymFor(p);
    const blocks = (p.blocks || []).map((b) => {
      const s = snap[b.id] || {};
      const label = b.label || b.tileName || b.measureLabel || (b.type === 'eventops' ? 'Devices' : 'Metric');
      if (b.type === 'eventops') return { id: b.id, type: b.type, label, icon: b.icon || '', ok: !!s.ops, ops: s.ops || null };
      if (b.type === 'signal') { const txt = signalText(b, s.flow); return { id: b.id, type: b.type, label: label === 'Metric' ? 'Signal flow' : label, icon: b.icon || '', ok: !!txt, value: txt, scope: (s.flow && s.flow.scope) || '' }; }
      if (b.type === 'top_list') return { id: b.id, type: b.type, label, icon: b.icon || '', ok: (s.rows || []).length > 0, rows: (s.rows || []).map((r) => ({ name: r.name, value: fmtNum(r.value, b.unit, sym) })) };
      return { id: b.id, type: b.type, label, icon: b.icon || '', ok: s.value != null, value: s.value == null ? null : fmtNum(s.value, b.unit, sym), compare: (b.compare && s.compare != null) ? fmtNum(s.compare, b.unit, sym) : null };
    });
    return { message, blocks };
  }
  // "Send to me" — deliver the preview to the CURRENT user only (their push +
  // their own email), never the configured recipient list, so setup can be
  // verified on the phone without pinging the team.
  async function sendPreviewToMe(draft, { entityId, suiteId, user }) {
    const { message, blocks } = await previewDraft(draft, { entityId, suiteId, user });
    const su = db.getSuite(suiteId);
    const title = `⚡ Preview — ${su ? su.name : 'live update'}`;
    const link = `${mailer?.baseUrl ? mailer.baseUrl() : ''}/alerts?tab=live`;
    const delivered = [];
    try { if (push?.sendToUser && await push.sendToUser(user.id, { title, body: message, url: link })) delivered.push('push'); } catch (e) { console.error('[livepulse] preview push failed', e.message); }
    try { if (mailer?.send && user.email) { await mailer.send({ to: user.email, subject: title, text: `${message}\n\n${link}`, kind: 'other', entity: entityId }); delivered.push('email'); } } catch (e) { console.error('[livepulse] preview email failed', e.message); }
    return { message, blocks, delivered };
  }

  // A pulse is "live" when the manual switch is on OR the clock is inside its window.
  function isLiveNow(p, at = now()) {
    if (p.live) return true;
    return !!(p.windowStart && p.windowEnd && p.windowStart <= at && at <= p.windowEnd);
  }
  function isDue(p) {
    if (!p.lastSentAt) return true;
    // 20s of slack so a 60s tick doesn't slip one whole tick every cycle.
    return (Date.now() - Date.parse(p.lastSentAt)) >= p.cadenceMin * 60000 - 20000;
  }

  // ── the tick (60s, like the digest scheduler; re-entrancy guarded) ──
  const TICK_MS = Number(process.env.LIVEPULSE_TICK_MS) || 60000;
  let ticking = false;
  async function tick() {
    if (!enabled() || ticking) return;
    ticking = true;
    try {
      const due = sql.prepare("SELECT * FROM live_pulses WHERE status='active'").all().map(rowToPulse)
        .filter((p) => (p.blocks || []).length && isLiveNow(p) && isDue(p));
      for (const p of due) { try { await sendUpdate(p); } catch (e) { console.error('[livepulse] send failed', p.id, e.message); } }
    } finally { ticking = false; }
  }
  const timer = setInterval(() => tick().catch(() => {}), TICK_MS);
  if (timer.unref) timer.unref();

  // ── access guards (same as Alerts — this IS a subsection of Alerts) ──
  const canView = (user, suiteId) => isAdmin(user) || auth.canAccessSuite(user, suiteId);
  function canManage(user, suiteId) {
    if (isAdmin(user)) return true;
    const su = db.getSuite(suiteId);
    return !!su && auth.canAccessSuite(user, suiteId) && auth.hasPermission(user, su.entityId, 'alerts.manage');
  }
  const off = (res) => res.status(404).json({ error: 'Live updates are disabled' });
  const decorate = (p) => ({ ...p, liveNow: isLiveNow(p), recent: runsFor(p.id, 3) });

  // ── routes (one guarded set serves admin + client self-service, keyed by suite) ──
  app.get('/api/livepulse/suites/:suiteId', auth.requireAuth, (req, res) => {
    if (!enabled()) return off(res);
    const su = db.getSuite(req.params.suiteId);
    if (!su) return res.status(404).json({ error: 'Event not found' });
    if (!canView(req.user, req.params.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    let signalStations = [];
    try { if (typeof signalFlow === 'function') signalStations = (signalFlow(req.params.suiteId).stations || []).filter((s) => s.name).map((s) => ({ name: s.name, zone: s.zone })); } catch { signalStations = []; }
    res.json({
      pulses: listForSuite(req.params.suiteId).map(decorate),
      canManage: canManage(req.user, req.params.suiteId),
      smsAvailable: !!(messaging?.status?.() || {}).configured,
      whatsappAvailable: !!(messaging?.waConfigured?.()),
      eventopsAvailable: !!(eventops && typeof eventops.suiteSummary === 'function' && eventops.suiteSummary(req.params.suiteId) && (eventops.suiteSummary(req.params.suiteId).devices || {}).total),
      // The Signal-flow block is offered when the Data health board knows any station.
      // Each station carries its zone (category) so the picker can group by category.
      signalAvailable: signalStations.length > 0,
      signalStations,
    });
  });

  app.post('/api/livepulse/suites/:suiteId', auth.requireAuth, (req, res) => {
    if (!enabled()) return off(res);
    const su = db.getSuite(req.params.suiteId);
    if (!su) return res.status(404).json({ error: 'Event not found' });
    if (!canManage(req.user, req.params.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    const c = clean(req.body || {}, su.entityId, su.id);
    if (!c.name) return res.status(400).json({ error: 'Give the live update a name.' });
    if (!c.blocks.length) return res.status(400).json({ error: 'Add at least one metric block.' });
    res.status(201).json({ pulse: decorate(upsert(null, c, req.user.email)) });
  });

  app.put('/api/livepulse/:id', auth.requireAuth, (req, res) => {
    if (!enabled()) return off(res);
    const p = pulseById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Live update not found' });
    if (!canManage(req.user, p.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    const c = clean({ ...p, ...req.body }, p.entityId, p.suiteId);
    if (!c.name) return res.status(400).json({ error: 'Give the live update a name.' });
    if (!c.blocks.length) return res.status(400).json({ error: 'Add at least one metric block.' });
    res.json({ pulse: decorate(upsert(p.id, c, req.user.email)) });
  });

  app.delete('/api/livepulse/:id', auth.requireAuth, (req, res) => {
    if (!enabled()) return off(res);
    const p = pulseById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Live update not found' });
    if (!canManage(req.user, p.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    sql.prepare('DELETE FROM live_pulses WHERE id=?').run(p.id);
    sql.prepare('DELETE FROM live_pulse_runs WHERE pulse_id=?').run(p.id);
    res.status(204).end();
  });

  app.post('/api/livepulse/:id/status', auth.requireAuth, (req, res) => {
    if (!enabled()) return off(res);
    const p = pulseById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Live update not found' });
    if (!canManage(req.user, p.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    const status = (req.body || {}).status === 'paused' ? 'paused' : 'active';
    sql.prepare('UPDATE live_pulses SET status=?, updated_at=? WHERE id=?').run(status, now(), p.id);
    res.json({ pulse: decorate(pulseById(p.id)) });
  });

  // Go live / stop — the organiser's manual switch (doors opened early, event overran).
  // Going live resets the cadence so the FIRST update lands on the next tick.
  app.post('/api/livepulse/:id/live', auth.requireAuth, (req, res) => {
    if (!enabled()) return off(res);
    const p = pulseById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Live update not found' });
    if (!canManage(req.user, p.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    const live = (req.body || {}).live ? 1 : 0;
    sql.prepare("UPDATE live_pulses SET live=?, last_sent_at=CASE WHEN ? THEN '' ELSE last_sent_at END, updated_at=? WHERE id=?").run(live, live, now(), p.id);
    res.json({ pulse: decorate(pulseById(p.id)) });
  });

  // Send one now (real delivery) — for testing the setup or an on-demand snapshot.
  app.post('/api/livepulse/:id/test', auth.requireAuth, async (req, res) => {
    if (!enabled()) return off(res);
    const p = pulseById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Live update not found' });
    if (!canManage(req.user, p.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    try { const r = await sendUpdate(p, { manual: true }); res.json({ ok: true, message: r.message, channels: r.channels }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Live preview of the numbers a DRAFT would show (no send, no save) — the editor
  // calls this to verify each block pulls the right figure while you set it up.
  app.post('/api/livepulse/suites/:suiteId/preview', auth.requireAuth, async (req, res) => {
    if (!enabled()) return off(res);
    const su = db.getSuite(req.params.suiteId);
    if (!su) return res.status(404).json({ error: 'Event not found' });
    if (!canManage(req.user, req.params.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    try { res.json(await previewDraft(req.body || {}, { entityId: su.entityId, suiteId: su.id, user: req.user })); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Send the preview to ME (the current user) only — a phone check before going live.
  app.post('/api/livepulse/suites/:suiteId/preview-send', auth.requireAuth, async (req, res) => {
    if (!enabled()) return off(res);
    const su = db.getSuite(req.params.suiteId);
    if (!su) return res.status(404).json({ error: 'Event not found' });
    if (!canManage(req.user, req.params.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    try { const r = await sendPreviewToMe(req.body || {}, { entityId: su.entityId, suiteId: su.id, user: req.user }); res.json({ ok: true, ...r }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/livepulse/:id/runs', auth.requireAuth, (req, res) => {
    if (!enabled()) return off(res);
    const p = pulseById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Live update not found' });
    if (!canView(req.user, p.suiteId)) return res.status(403).json({ error: 'Not allowed' });
    res.json({ runs: runsFor(p.id, 100) });
  });

  app.get('/api/livepulse/status', auth.requireAuth, (req, res) => res.json({ enabled: enabled() }));

  // ── Programmatic create (the Owl's createLiveUpdate act-tool commit path) ──────
  // Same clean + permission (canManage) + upsert the POST route uses, so a live
  // pulse the Owl proposes-then-confirms is identical to a hand-made one.
  function createLivePulseFor({ suiteId, draft, user, via }) {
    if (!enabled()) return { ok: false, error: 'Live updates are disabled' };
    const su = db.getSuite(suiteId);
    if (!su) return { ok: false, error: 'Event not found' };
    if (!canManage(user, suiteId)) return { ok: false, error: 'You don\'t have permission to set up live updates for this event.' };
    const c = clean(draft || {}, su.entityId, su.id);
    if (!c.name) return { ok: false, error: 'Give the live update a name.' };
    if (!c.blocks.length) return { ok: false, error: 'Pick at least one metric to include.' };
    const pulse = upsert(null, c, (user && user.email) || 'owl');
    if (via && pulse) { try { sql.prepare('UPDATE live_pulses SET created_via=? WHERE id=?').run(String(via).slice(0, 20), pulse.id); pulse.createdVia = String(via).slice(0, 20); } catch { /* cosmetic */ } }
    return { ok: true, pulse };
  }

  console.log('[livepulse] mounted', enabled() ? '(enabled)' : '(disabled — set livepulse_enabled=1)');
  return { sendUpdate, tick, listForSuite, pulseById, runsFor, isLiveNow, composeMessage, previewDraft, sendPreviewToMe, createLivePulse: createLivePulseFor };
}

// Option lists exported so the Owl's createLiveUpdate act-tool builds its schema FROM
// these — one source of truth (same pattern as alerts).
module.exports = { mount, CHANNELS, BLOCK_TYPES, MAX_BLOCKS };
