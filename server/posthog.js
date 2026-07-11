// ─── PostHog app analytics — direct integration — DISPOSABLE MODULE ────────────
// Pulls Howler-app product analytics INTO Pulse straight from PostHog
// (https://posthog.com), skipping the PostHog → warehouse → Looker hop for
// app-ONLY reporting: live actives, per-event attention, CTA taps, purchases,
// notifications and app-user profiles. Anything that must JOIN app data to
// ticketing/revenue stays on the Looker path — this module never replaces it.
// Spec: docs/specs/POSTHOG_APP_ANALYTICS_SPEC.md.
//
// Connection is PLATFORM-LEVEL (one Howler app → one PostHog project), stored in
// settings with .env fallback like Looker's: posthog_host / posthog_project_id /
// posthog_api_key (a PERSONAL API key with query-read scope — project keys are
// ingest-only and cannot query). The key is write-only: reads report set + mask.
//
// Two data tiers (PostHog rate-limits its query endpoints, so queries are scarce):
//   • Daily rollups → SQLite (posthog_daily_app / posthog_daily_event), refreshed
//     by a self-guarded daily tick (kill switch posthog_sync_enabled='0') and
//     restated for the trailing week — powers trends without burning queries.
//   • Live HogQL with a short TTL cache — "today so far", the events catalog and
//     app-user profile lookups. A down PostHog degrades to yesterday's rollup.
//
// Client scoping: the app stamps every tracked event with the Howler event id
// (property name configurable, default `eventID`). A client's visible ids come
// from their suites' locked filters — `core_events.id` directly, event NAMES
// resolved to ids via one cached Looker lookup — and are forced into every
// scoped HogQL query server-side, fail-closed (no resolvable ids → no data),
// mirroring auth.scopeForQuery for Looker.
//
// Mount: require('./posthog').mount(app, { db, auth, runLookerQuery })
// Uninstall: remove the mount line + this file + PosthogCard/AppAnalytics UI +
// the 'appanalytics' flag row. Tables are owned here and safe to drop.

const { HttpError, asyncHandler } = require('./http');

// System prompt for the App-analytics page summary (streamed by the ✨ button,
// exact same UX as the whole-dashboard summary). Registered in the AI audit via
// promptRegistry() below, which insights.promptRegistry() spreads in.
const APP_INSIGHT_SYSTEM = `You are the Owl — the senior data analyst for Howler, an events ticketing platform (organisers run events; customers buy tickets and engage in the Howler consumer app; amounts in South African Rand, ZAR).

You are given everything shown on one client's App analytics page for a date window: headline engagement (live actives, unique viewers), the daily series, per-event totals, interaction-type/surface breakdowns, community posts (with their view counts), campaign sends, app-link clicks and the most active app users.

Write the page's story for a non-technical organiser:
- Open with 1-2 sentences on the headline: how their events are doing inside the app this window, and the direction of travel.
- Then 3-6 bullets with the most important specific findings, always with numbers: trend turns and spikes (tie them to the posts / campaign sends / link-click surges that plausibly drove them — they carry timestamps), what people actually do in the app (interaction types, surfaces, CTA taps vs views), the standout posts by views, and anything notable about the top users.
- End with "Try next:" and 2-3 concrete suggestions grounded in THIS data — e.g. repeat the format/timing of the post that outperformed, tag campaigns to the app, place CTAs on the busiest surface, re-engage a quiet stretch. No generic advice.

Rules: only use the numbers given — never invent, recompute or extrapolate; skip sections with no data rather than mentioning their absence; attribute spikes cautiously ("lines up with", "likely helped") rather than claiming causation; be concise and skimmable; no headings other than the closing "Try next:".`;

// Compact fact sheet the model reads — one section per page panel, numbers only.
function buildAppInsightPrompt({ report, live, moments: mom = [], linkClicks: clicks = [], breakdowns = [], topUsers = [] }) {
  const L = [];
  L.push(`Window: ${report.from} to ${report.to} (${report.days} days, inclusive).`);
  if (live) L.push(`Live: ${live.actives} unique viewers today so far; ${live.windowUniques} unique viewers across the whole window.`);
  const t = report.totals || {};
  L.push(`Window totals: interactions ${t.interactions || 0}; views ${t.views || 0}; CTA taps ${t.ctaTaps || 0}; purchases ${t.purchases || 0}${t.purchaseValue ? ` (value ${t.purchaseValue})` : ''}.`);
  if ((report.series || []).length) {
    L.push('', 'Daily series (date · uniques · interactions · views · ctaTaps):');
    for (const r of report.series.slice(-31)) L.push(`${r.date} · ${r.uniques} · ${r.interactions} · ${r.views} · ${r.ctaTaps}`);
  }
  if ((report.events || []).length) {
    L.push('', 'Per event (name · uniques · interactions · views · ctaTaps · purchases):');
    for (const e of report.events.slice(0, 10)) L.push(`${e.eventName || e.eventRef} · ${e.uniques} · ${e.interactions} · ${e.views} · ${e.ctaTaps} · ${e.purchases}`);
  }
  for (const b of breakdowns) {
    if (!b.values.length) continue;
    L.push('', `Breakdown by ${b.key} (value · count · unique people):`);
    for (const v of b.values.slice(0, 8)) L.push(`${v.value} · ${v.count} · ${v.uniques}`);
  }
  const posts = mom.filter((m) => m.type === 'post');
  if (posts.length) {
    L.push('', 'Community posts in the window (time · community · views · reactions · comments · text):');
    for (const p of posts.slice(0, 20)) L.push(`${String(p.at).slice(0, 16)} · ${p.community || '-'} · ${p.impressions ?? p.reach ?? '?'} · ${p.reactions ?? 0} · ${p.comments ?? 0} · ${p.text || p.label}`);
  }
  const camps = mom.filter((m) => m.type === 'campaign');
  if (camps.length) {
    L.push('', 'Campaign sends (time · title · app-relevant):');
    for (const cpn of camps.slice(0, 20)) L.push(`${String(cpn.at).slice(0, 16)} · ${cpn.label} · ${cpn.appLinked ? 'yes' : 'no'}`);
  }
  if (clicks.length) L.push('', `App-link clicks by day: ${clicks.map((r) => `${r.date}:${r.clicks}`).join(' · ')} (total ${clicks.reduce((a, r) => a + r.clicks, 0)}).`);
  if (topUsers.length) {
    L.push('', 'Most active app users (name/email · interactions · last seen):');
    for (const u of topUsers) L.push(`${[u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'unknown'} · ${u.interactions} · ${String(u.lastSeen).slice(0, 16)}`);
  }
  return L.join('\n');
}
// Surfaced in Admin → AI "Everything the AI is told" via insights.promptRegistry().
function promptRegistry() {
  return [{ key: 'appAnalyticsSummary', label: 'App analytics — Owl page summary', scope: 'Summarises a client\'s App analytics page (engagement, posts, campaigns, link clicks, top users) with grounded suggestions', text: APP_INSIGHT_SYSTEM }];
}

const DAYS_DEFAULT = 28;
const DAYS_MAX = 90;
const RESTATE_DAYS = 7;    // nightly window — PostHog restates late-arriving events
const BACKFILL_DAYS = 90;  // first-ever sync reaches back this far
const LIVE_TTL = 4 * 60_000;    // "today so far" cache
const PEOPLE_TTL = 60_000;      // app-user lookups
const CATALOG_TTL = 10 * 60_000;

// ── HogQL building blocks (pure — exported for tests) ───────────────────────────
// Everything user-configurable (event names, property names, event ids) reaches
// HogQL through these two — never by direct interpolation.
const hqlStr = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const hqlList = (arr) => arr.map(hqlStr).join(', ');
const prop = (name) => `properties[${hqlStr(name)}]`;
const personProp = (name) => `person.properties[${hqlStr(name)}]`;
// A mapping entry is `eventName` or `eventName : property=value` — the latter for
// apps that funnel everything through one generic event (e.g. `interaction`) and
// distinguish views/CTAs/purchases by a property. Parsed lazily at query time so
// the stored mapping stays plain strings.
function parseMapEntry(s) {
  const m = String(s).match(/^(.*?)\s*:\s*([^=:]+)=(.*)$/);
  if (m && m[1].trim() && m[2].trim()) return { event: m[1].trim(), prop: m[2].trim(), value: m[3].trim() };
  return { event: String(s).trim() };
}
const entryCond = (e) => {
  if (!e.prop) return `event = ${hqlStr(e.event)}`;
  // `event : key=*` = the property is PRESENT with any value (e.g. every
  // `interaction` carrying a CTA_Label counts as a CTA tap).
  return e.value === '*'
    ? `(event = ${hqlStr(e.event)} AND notEmpty(toString(${prop(e.prop)})))`
    : `(event = ${hqlStr(e.event)} AND toString(${prop(e.prop)}) = ${hqlStr(e.value)})`;
};
// countIf over a configured mapping list; an unmapped (empty) list is a constant
// 0 so the column always exists and an empty OR never reaches PostHog.
const mapCond = (list) => list.map(parseMapEntry).map(entryCond).join(' OR ');
const countIn = (list, as) => (list.length ? `countIf(${mapCond(list)}) AS ${as}` : `0 AS ${as}`);

// The query API returns rows as arrays aligned to `columns` — zip into objects.
function zipRows(data) {
  const cols = data?.columns || [];
  return (data?.results || []).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}

// Accepts an array or comma/newline-separated string → clean unique list.
function nameList(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[\n,]+/);
  return [...new Set(arr.map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 40);
}

// Which PostHog events mean what. Defaults cover PostHog's autocapture names;
// the real Howler taxonomy is mapped in Admin → App analytics (events catalog
// alongside). Person-profile property names ride in the same setting.
const DEFAULT_MAP = {
  screenEvents: ['$screen', '$pageview'],
  ctaEvents: [],
  purchaseEvents: [],
  purchaseValueProp: '',
  notificationEvents: [],
  // Property keys the breakdown panels group by (Howler app taxonomy).
  breakdownProps: ['interaction_type', 'CTA_Label', 'surface'],
  personProps: { email: '$email', firstName: 'name', lastName: 'surname', phone: 'mobile' },
};

function mount(app, { db, auth, runLookerQuery, ai, fetchImpl, startTimer = true }) {
  const sql = db.db;
  const doFetch = fetchImpl || fetch;
  const now = () => new Date().toISOString();

  sql.exec(`
    CREATE TABLE IF NOT EXISTS posthog_daily_app (
      date TEXT PRIMARY KEY,
      dau INTEGER NOT NULL DEFAULT 0, new_users INTEGER NOT NULL DEFAULT 0,
      sessions INTEGER NOT NULL DEFAULT 0, interactions INTEGER NOT NULL DEFAULT 0,
      views INTEGER NOT NULL DEFAULT 0, notif_events INTEGER NOT NULL DEFAULT 0,
      synced_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS posthog_daily_event (
      date TEXT NOT NULL,
      event_ref TEXT NOT NULL,           -- Howler event id as stamped by the app
      event_name TEXT NOT NULL DEFAULT '',
      uniques INTEGER NOT NULL DEFAULT 0, interactions INTEGER NOT NULL DEFAULT 0,
      views INTEGER NOT NULL DEFAULT 0, cta_taps INTEGER NOT NULL DEFAULT 0,
      purchases INTEGER NOT NULL DEFAULT 0, purchase_value REAL NOT NULL DEFAULT 0,
      notif_events INTEGER NOT NULL DEFAULT 0,
      synced_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (date, event_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_posthog_event_ref ON posthog_daily_event(event_ref, date);
  `);
  // Existing deployments predate the per-event notification count.
  try { sql.exec('ALTER TABLE posthog_daily_event ADD COLUMN notif_events INTEGER NOT NULL DEFAULT 0'); } catch { /* already there */ }
  const upApp = sql.prepare(`INSERT INTO posthog_daily_app (date,dau,new_users,sessions,interactions,views,notif_events,synced_at)
    VALUES (@date,@dau,@new_users,@sessions,@interactions,@views,@notif_events,@synced_at)
    ON CONFLICT(date) DO UPDATE SET dau=excluded.dau, sessions=excluded.sessions, interactions=excluded.interactions,
      views=excluded.views, notif_events=excluded.notif_events, synced_at=excluded.synced_at`);
  const upNew = sql.prepare(`INSERT INTO posthog_daily_app (date,new_users,synced_at) VALUES (?,?,?)
    ON CONFLICT(date) DO UPDATE SET new_users=excluded.new_users`);
  const upEvent = sql.prepare(`INSERT INTO posthog_daily_event (date,event_ref,event_name,uniques,interactions,views,cta_taps,purchases,purchase_value,notif_events,synced_at)
    VALUES (@date,@event_ref,@event_name,@uniques,@interactions,@views,@cta_taps,@purchases,@purchase_value,@notif_events,@synced_at)
    ON CONFLICT(date,event_ref) DO UPDATE SET event_name=excluded.event_name, uniques=excluded.uniques,
      interactions=excluded.interactions, views=excluded.views, cta_taps=excluded.cta_taps,
      purchases=excluded.purchases, purchase_value=excluded.purchase_value, notif_events=excluded.notif_events, synced_at=excluded.synced_at`);

  // ── connection (platform settings → .env fallback, resolved per call) ──────────
  function conn() {
    return {
      host: (db.getSetting('posthog_host', '') || process.env.POSTHOG_HOST || 'https://eu.posthog.com').replace(/\/$/, ''),
      projectId: db.getSetting('posthog_project_id', '') || process.env.POSTHOG_PROJECT_ID || '',
      apiKey: db.getSetting('posthog_api_key', '') || process.env.POSTHOG_API_KEY || '',
      eventIdProp: db.getSetting('posthog_event_id_property', '') || 'eventID',
      eventNameProp: db.getSetting('posthog_event_name_property', '') || 'eventName',
    };
  }
  const isConfigured = () => { const c = conn(); return !!(c.host && c.projectId && c.apiKey); };
  function metricMap() {
    let stored = {};
    try { stored = JSON.parse(db.getSetting('posthog_metric_map', '') || '{}') || {}; } catch { /* keep defaults */ }
    return {
      screenEvents: nameList(stored.screenEvents ?? DEFAULT_MAP.screenEvents),
      ctaEvents: nameList(stored.ctaEvents ?? DEFAULT_MAP.ctaEvents),
      purchaseEvents: nameList(stored.purchaseEvents ?? DEFAULT_MAP.purchaseEvents),
      purchaseValueProp: String(stored.purchaseValueProp ?? DEFAULT_MAP.purchaseValueProp).trim(),
      notificationEvents: nameList(stored.notificationEvents ?? DEFAULT_MAP.notificationEvents),
      breakdownProps: nameList(stored.breakdownProps ?? DEFAULT_MAP.breakdownProps),
      personProps: { ...DEFAULT_MAP.personProps, ...(stored.personProps && typeof stored.personProps === 'object' ? stored.personProps : {}) },
    };
  }

  // ── HogQL runner: small concurrency gate + TTL cache. Queries are scarce. ──────
  let active = 0;
  const queue = [];
  const qcache = new Map(); // query -> { at, rows }
  async function hogql(query, { ttl = 0 } = {}) {
    const c = conn();
    if (!c.projectId || !c.apiKey) throw new HttpError(400, 'PostHog isn\'t connected yet — add the project ID + personal API key in Integrations.');
    const hit = ttl && qcache.get(query);
    if (hit && Date.now() - hit.at < ttl) return hit.rows;
    if (active >= 2) await new Promise((r) => queue.push(r));
    active++;
    try {
      let res;
      try {
        res = await doFetch(`${c.host}/api/projects/${encodeURIComponent(c.projectId)}/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
          body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
          signal: AbortSignal.timeout(45_000),
        });
      } catch {
        // NOT 5xx: the client UI presents gateway statuses as "Pulse is updating",
        // which misdiagnoses a PostHog outage as a Pulse deploy. 424 keeps the
        // real message on screen.
        throw new HttpError(424, 'Could not reach PostHog — try again in a minute.');
      }
      if (res.status === 401 || res.status === 403) throw new HttpError(400, 'PostHog rejected the API key — it must be a personal API key with query read access.');
      if (res.status === 429) throw new HttpError(429, 'PostHog is rate-limiting us — showing the last synced data instead.');
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        const detail = String(data?.detail || data?.error || '').slice(0, 200);
        throw new HttpError(424, `PostHog returned an error (HTTP ${res.status})${detail ? `: ${detail}` : '.'}`);
      }
      const rows = zipRows(data);
      if (qcache.size > 200) qcache.clear();
      if (ttl) qcache.set(query, { at: Date.now(), rows });
      return rows;
    } finally {
      active--; const next = queue.shift(); if (next) next();
    }
  }

  // ── nightly sync → rollup tables. NEVER throws (records the error instead). ────
  async function syncDaily(days) {
    if (!isConfigured()) return { ok: false, reason: 'not_configured', error: 'PostHog is not connected.' };
    const first = !db.getSetting('posthog_last_sync', '');
    const N = Math.min(Math.max(Number(days) || (first ? BACKFILL_DAYS : RESTATE_DAYS), 1), BACKFILL_DAYS);
    const m = metricMap();
    const c = conn();
    const win = `timestamp >= toStartOfDay(now()) - INTERVAL ${N} DAY`;
    try {
      const appRows = await hogql(`
        SELECT toString(toDate(timestamp)) AS day, uniq(person_id) AS dau,
               uniq(${prop('$session_id')}) AS sessions, count() AS interactions,
               ${countIn(m.screenEvents, 'views')}, ${countIn(m.notificationEvents, 'notif_events')}
        FROM events WHERE ${win} GROUP BY day ORDER BY day`);
      const ts = now();
      for (const r of appRows) {
        if (!r.day) continue;
        upApp.run({ date: r.day, dau: Number(r.dau) || 0, new_users: 0, sessions: Number(r.sessions) || 0, interactions: Number(r.interactions) || 0, views: Number(r.views) || 0, notif_events: Number(r.notif_events) || 0, synced_at: ts });
      }
      const newRows = await hogql(`
        SELECT toString(toDate(created_at)) AS day, count() AS new_users
        FROM persons WHERE created_at >= toStartOfDay(now()) - INTERVAL ${N} DAY GROUP BY day ORDER BY day`);
      for (const r of newRows) if (r.day) upNew.run(r.day, Number(r.new_users) || 0, ts);
      const evId = prop(c.eventIdProp);
      const value = m.purchaseValueProp && m.purchaseEvents.length
        ? `sumIf(toFloat(${prop(m.purchaseValueProp)}), ${mapCond(m.purchaseEvents)}) AS purchase_value`
        : '0 AS purchase_value';
      const evRows = await hogql(`
        SELECT toString(toDate(timestamp)) AS day, toString(${evId}) AS event_ref,
               any(toString(${prop(c.eventNameProp)})) AS event_name,
               uniq(person_id) AS uniques, count() AS interactions,
               ${countIn(m.screenEvents, 'views')}, ${countIn(m.ctaEvents, 'cta_taps')},
               ${countIn(m.purchaseEvents, 'purchases')}, ${value}, ${countIn(m.notificationEvents, 'notif_events')}
        FROM events WHERE ${win} AND notEmpty(toString(${evId}))
        GROUP BY day, event_ref ORDER BY day DESC LIMIT 50000`);
      let rows = 0;
      for (const r of evRows) {
        if (!r.day || !r.event_ref) continue;
        upEvent.run({ date: r.day, event_ref: String(r.event_ref), event_name: String(r.event_name || ''), uniques: Number(r.uniques) || 0, interactions: Number(r.interactions) || 0, views: Number(r.views) || 0, cta_taps: Number(r.cta_taps) || 0, purchases: Number(r.purchases) || 0, purchase_value: Number(r.purchase_value) || 0, notif_events: Number(r.notif_events) || 0, synced_at: ts });
        rows++;
      }
      // True window-uniques for the headline (daily uniques don't sum).
      const [wk] = await hogql('SELECT uniq(person_id) AS n FROM events WHERE timestamp >= now() - INTERVAL 7 DAY');
      const [mo] = await hogql('SELECT uniq(person_id) AS n FROM events WHERE timestamp >= now() - INTERVAL 30 DAY');
      db.setSetting('posthog_headline', JSON.stringify({ wau: Number(wk?.n) || 0, mau: Number(mo?.n) || 0, at: ts }));
      db.setSetting('posthog_last_sync', ts);
      db.setSetting('posthog_last_error', '');
      return { ok: true, days: N, appDays: appRows.length, eventRows: rows };
    } catch (e) {
      const msg = String(e.message || e).slice(0, 300);
      db.setSetting('posthog_last_error', msg);
      return { ok: false, error: msg };
    }
  }

  // Hourly check, once per local day, kill switch posthog_sync_enabled='0'.
  let ticking = false;
  async function tick() {
    if (ticking) return;
    if (db.getSetting('posthog_sync_enabled', '1') === '0' || !isConfigured()) return;
    const today = new Date().toISOString().slice(0, 10);
    if (db.getSetting('posthog_last_auto', '') === today) return;
    ticking = true;
    try { await syncDaily(); db.setSetting('posthog_last_auto', today); }
    catch (e) { console.error('[posthog] tick failed:', e.message); }
    ticking = false;
  }
  if (startTimer) { const timer = setInterval(() => tick().catch(() => {}), 60 * 60_000); timer.unref?.(); }

  // ── client scoping: entity → Howler event ids (fail closed) ────────────────────
  // From the entity's suites' locked filters: core_events.id values directly;
  // event NAMES resolved to ids via one Looker query (ids are stable → cached).
  function suiteEventScope(locks) {
    const ids = new Set(), names = new Set();
    for (const [key, v] of Object.entries(locks || {})) {
      if (v == null || v === '') continue;
      const field = key.includes('.') ? key : (auth.filterNameToField ? auth.filterNameToField(key) : null);
      if (field !== 'core_events.id' && field !== 'core_events.name') continue;
      for (const part of String(v).split(',')) {
        const t = part.trim();
        if (!t || t.includes('%')) continue; // never scope on wildcard patterns
        (field === 'core_events.id' ? ids : names).add(t);
      }
    }
    return { ids: [...ids], names: [...names] };
  }

  // Find a model/explore that exposes core_events.name (for the name→id lookup)
  // by scanning saved dashboard filters — same trick as /api/admin/filter-fields.
  let _lookupHome = null, _lookupHomeAt = 0;
  function lookupHome() {
    if (_lookupHome && Date.now() - _lookupHomeAt < 10 * 60_000) return _lookupHome;
    for (const d of db.listDashboards ? db.listDashboards() : []) {
      const full = db.getDashboard ? db.getDashboard(d.id) : null;
      for (const f of full?.filters || []) {
        if ((f.field || f.dimension) === 'core_events.name' && f.model && f.explore) {
          _lookupHome = { model: f.model, explore: f.explore }; _lookupHomeAt = Date.now();
          return _lookupHome;
        }
      }
    }
    return null;
  }
  async function idsForNames(names) {
    if (!names.length || !runLookerQuery) return [];
    const home = lookupHome();
    if (!home) return [];
    try {
      const rows = await runLookerQuery('/queries/run/json', {
        model: home.model, view: home.explore,
        fields: ['core_events.name', 'core_events.id'],
        filters: { 'core_events.name': names.join(',') }, limit: 500,
      });
      const want = new Set(names.map((n) => n.toLowerCase()));
      return [...new Set((rows || [])
        .filter((r) => want.has(String(r['core_events.name'] || '').toLowerCase()) && r['core_events.id'] != null)
        .map((r) => String(r['core_events.id'])))];
    } catch (e) {
      console.error('[posthog] event name→id lookup failed:', e.message);
      return [];
    }
  }

  async function eventIdsForEntity(entityId) {
    const ids = new Set(), names = new Set();
    for (const su of db.listSuitesForEntity ? db.listSuitesForEntity(entityId) : []) {
      const scope = suiteEventScope(db.lockedFiltersForSuite(su.id));
      scope.ids.forEach((i) => ids.add(i));
      scope.names.forEach((n) => names.add(n));
    }
    const inputKey = JSON.stringify([[...ids].sort(), [...names].sort()]);
    let cached = null;
    try { cached = JSON.parse(db.getSetting(`posthog_evscope:${entityId}`, '') || 'null'); } catch { /* re-resolve */ }
    if (cached && cached.key === inputKey && Date.now() - new Date(cached.at).getTime() < 6 * 3600_000) return cached.ids;
    (await idsForNames([...names])).forEach((i) => ids.add(i));
    const out = [...ids];
    db.setSetting(`posthog_evscope:${entityId}`, JSON.stringify({ key: inputKey, ids: out, at: now() }));
    return out;
  }

  // ── report views (rollup tables — no PostHog traffic) ──────────────────────────
  const clampDays = (d) => Math.min(Math.max(Number(d) || DAYS_DEFAULT, 1), DAYS_MAX);
  const sinceDate = (days) => new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  // Normalize a reporting window. Explicit {from,to} dates (YYYY-MM-DD, inclusive)
  // win; otherwise `days` back from today. Accepts a bare number for the older
  // days-only callers. Dates are read in the PostHog project's timezone —
  // consistent with the rollup, whose `date` column came from toDate(timestamp).
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  function win(o) {
    const q = o && typeof o === 'object' ? o : { days: o };
    const from = DATE_RE.test(String(q.from || '')) ? String(q.from) : '';
    const to = DATE_RE.test(String(q.to || '')) ? String(q.to) : '';
    if (from && to && from <= to) {
      return { from, to, days: Math.min(Math.round((Date.parse(to) - Date.parse(from)) / 86400_000) + 1, 366) };
    }
    const days = clampDays(q.days);
    return { from: sinceDate(days - 1), to: new Date().toISOString().slice(0, 10), days };
  }
  const tsWin = (w) => `timestamp >= toDateTime(${hqlStr(w.from)}) AND timestamp < toDateTime(${hqlStr(w.to)}) + INTERVAL 1 DAY`;
  const winQ = (req) => ({ days: req.query.days, from: req.query.from, to: req.query.to });
  function status() {
    let headline = {};
    try { headline = JSON.parse(db.getSetting('posthog_headline', '') || '{}'); } catch { /* fine */ }
    return { configured: isConfigured(), lastSync: db.getSetting('posthog_last_sync', ''), lastError: db.getSetting('posthog_last_error', ''), headline };
  }
  function appReport(o) {
    const w = win(o);
    const m = metricMap();
    const series = sql.prepare('SELECT * FROM posthog_daily_app WHERE date>=? AND date<=? ORDER BY date ASC').all(w.from, w.to);
    const totals = { newUsers: 0, sessions: 0, interactions: 0, views: 0, notifEvents: 0 };
    for (const r of series) { totals.newUsers += r.new_users; totals.sessions += r.sessions; totals.interactions += r.interactions; totals.views += r.views; totals.notifEvents += r.notif_events; }
    const topEvents = sql.prepare(`
      SELECT event_ref AS eventRef, MAX(event_name) AS eventName, SUM(uniques) AS uniques, SUM(interactions) AS interactions,
             SUM(views) AS views, SUM(cta_taps) AS ctaTaps, SUM(purchases) AS purchases, SUM(purchase_value) AS purchaseValue
      FROM posthog_daily_event WHERE date>=? AND date<=? GROUP BY event_ref ORDER BY uniques DESC LIMIT 25`).all(w.from, w.to);
    return { ...status(), days: w.days, from: w.from, to: w.to, totals, series, topEvents, breakdowns: m.breakdownProps, notificationsMapped: m.notificationEvents.length > 0 };
  }
  function entityReport(entityId, o, ids) {
    const w = win(o);
    const m = metricMap();
    if (!ids.length) return { ...status(), days: w.days, from: w.from, to: w.to, scoped: false, eventIds: [], totals: null, series: [], events: [] };
    const ph = ids.map(() => '?').join(',');
    const series = sql.prepare(`
      SELECT date, SUM(uniques) AS uniques, SUM(interactions) AS interactions, SUM(views) AS views,
             SUM(cta_taps) AS ctaTaps, SUM(purchases) AS purchases, SUM(purchase_value) AS purchaseValue,
             SUM(notif_events) AS notifications
      FROM posthog_daily_event WHERE date>=? AND date<=? AND event_ref IN (${ph}) GROUP BY date ORDER BY date ASC`).all(w.from, w.to, ...ids);
    const events = sql.prepare(`
      SELECT event_ref AS eventRef, MAX(event_name) AS eventName, SUM(uniques) AS uniques, SUM(interactions) AS interactions,
             SUM(views) AS views, SUM(cta_taps) AS ctaTaps, SUM(purchases) AS purchases, SUM(purchase_value) AS purchaseValue,
             SUM(notif_events) AS notifications
      FROM posthog_daily_event WHERE date>=? AND date<=? AND event_ref IN (${ph}) GROUP BY event_ref ORDER BY uniques DESC`).all(w.from, w.to, ...ids);
    const totals = { uniques: 0, interactions: 0, views: 0, ctaTaps: 0, purchases: 0, purchaseValue: 0, notifications: 0 };
    for (const r of events) { totals.uniques += r.uniques; totals.interactions += r.interactions; totals.views += r.views; totals.ctaTaps += r.ctaTaps; totals.purchases += r.purchases; totals.purchaseValue += r.purchaseValue; totals.notifications += r.notifications; }
    return { ...status(), days: w.days, from: w.from, to: w.to, scoped: true, eventIds: ids, totals, series, events, breakdowns: m.breakdownProps, notificationsMapped: m.notificationEvents.length > 0 };
  }

  // ── live tier (short-TTL HogQL; callers treat a failure as "live unavailable") ──
  async function liveToday(ids) {
    const m = metricMap();
    const c = conn();
    const scope = ids ? ` AND toString(${prop(c.eventIdProp)}) IN (${hqlList(ids)})` : '';
    const [row] = await hogql(`
      SELECT uniq(person_id) AS actives, uniq(${prop('$session_id')}) AS sessions,
             count() AS interactions, ${countIn(m.screenEvents, 'views')}
      FROM events WHERE timestamp >= toStartOfDay(now())${scope}`, { ttl: LIVE_TTL });
    return { actives: Number(row?.actives) || 0, sessions: Number(row?.sessions) || 0, interactions: Number(row?.interactions) || 0, views: Number(row?.views) || 0, asOf: now() };
  }
  // True uniques over the whole window (summing per-day uniques over-counts —
  // the same fan on three days is three daily-uniques but ONE person).
  async function windowUniques(ids, o) {
    const w = win(o);
    const c = conn();
    const scope = ids ? ` AND toString(${prop(c.eventIdProp)}) IN (${hqlList(ids)})` : '';
    const [row] = await hogql(`SELECT uniq(person_id) AS u FROM events WHERE ${tsWin(w)}${scope}`, { ttl: LIVE_TTL });
    return Number(row?.u) || 0;
  }
  const withLive = async (report, ids) => {
    try { return { ...report, live: { ...(await liveToday(ids)), windowUniques: await windowUniques(ids, { from: report.from, to: report.to }) } }; }
    catch (e) { return { ...report, live: null, liveError: e instanceof HttpError ? e.message : 'Live numbers are unavailable right now.' }; }
  };

  // Hour-by-hour — straight from PostHog (the rollup is daily), same short cache
  // and scoping as the other live queries. Defaults to today; an explicit range
  // is capped at 14 days (hour-points beyond that are noise and cost).
  async function todayHourly(ids, o = {}) {
    const w = o.from || o.to ? win(o) : win({ from: new Date().toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) });
    if (w.days > 14) throw new HttpError(400, 'Hourly view covers at most 14 days — narrow the date range.');
    const m = metricMap();
    const c = conn();
    const scope = ids ? ` AND toString(${prop(c.eventIdProp)}) IN (${hqlList(ids)})` : '';
    const rows = await hogql(`
      SELECT toString(toStartOfHour(timestamp)) AS hour, uniq(person_id) AS uniques, count() AS interactions,
             ${countIn(m.screenEvents, 'views')}, ${countIn(m.ctaEvents, 'cta_taps')}, ${countIn(m.purchaseEvents, 'purchases')}
      FROM events WHERE ${tsWin(w)}${scope} GROUP BY hour ORDER BY hour LIMIT 1000`, { ttl: LIVE_TTL });
    return {
      asOf: now(), from: w.from, to: w.to, days: w.days,
      hours: rows.map((r) => ({ hour: String(r.hour), uniques: Number(r.uniques) || 0, interactions: Number(r.interactions) || 0, views: Number(r.views) || 0, ctaTaps: Number(r.cta_taps) || 0, purchases: Number(r.purchases) || 0 })),
    };
  }

  // Top values of one breakdown property (interaction_type / CTA_Label / surface
  // …), counted + uniqued over the window, optionally scoped to event ids. Which
  // keys are offered comes from the mapping (metricMap().breakdownProps).
  async function breakdown({ ids = null, days, from, to, key }) {
    const w = win({ days, from, to });
    const c = conn();
    const scope = ids ? ` AND toString(${prop(c.eventIdProp)}) IN (${hqlList(ids)})` : '';
    const rows = await hogql(`SELECT toString(${prop(key)}) AS v, count() AS n, uniq(person_id) AS u FROM events WHERE ${tsWin(w)} AND notEmpty(toString(${prop(key)}))${scope} GROUP BY v ORDER BY n DESC LIMIT 25`, { ttl: LIVE_TTL });
    return { key, days: w.days, values: rows.map((r) => ({ value: String(r.v), count: Number(r.n) || 0, uniques: Number(r.u) || 0 })) };
  }
  // Daily time-series per breakdown VALUE (the "show it in the line graph" view):
  // one row per (day, value) for the given values — or the window's top 6 when
  // none are named. Same scoping and key rules as breakdown().
  async function breakdownSeries({ ids = null, days, from, to, key, values = [], granularity = 'day' }) {
    const w = win({ days, from, to });
    const hourly = granularity === 'hour';
    if (hourly && w.days > 14) throw new HttpError(400, 'Hourly view covers at most 14 days — narrow the date range.');
    const c = conn();
    const scope = ids ? ` AND toString(${prop(c.eventIdProp)}) IN (${hqlList(ids)})` : '';
    let vals = nameList(values).slice(0, 8);
    if (!vals.length) vals = (await breakdown({ ids, from: w.from, to: w.to, key })).values.slice(0, 6).map((v) => v.value);
    if (!vals.length) return { key, days: w.days, granularity: hourly ? 'hour' : 'day', values: [], series: [] };
    const bucket = hourly ? 'toString(toStartOfHour(timestamp))' : 'toString(toDate(timestamp))';
    const rows = await hogql(`SELECT ${bucket} AS day, toString(${prop(key)}) AS v, count() AS n, uniq(person_id) AS u FROM events WHERE ${tsWin(w)} AND toString(${prop(key)}) IN (${hqlList(vals)})${scope} GROUP BY day, v ORDER BY day LIMIT 5000`, { ttl: LIVE_TTL });
    return { key, days: w.days, granularity: hourly ? 'hour' : 'day', values: vals, series: rows.map((r) => ({ day: String(r.day), value: String(r.v), count: Number(r.n) || 0, uniques: Number(r.u) || 0 })) };
  }
  // Clients may only group by the admin-configured keys (no property probing).
  function breakdownKeyOrThrow(req) {
    const key = String(req.query.key || '').trim();
    if (!metricMap().breakdownProps.includes(key)) throw new HttpError(400, 'Unknown breakdown — pick one of the configured properties.');
    return key;
  }

  // App-user profiles (PostHog person properties: email / name / surname / mobile).
  // `ids` null = whole app (admin); an array = scoped to those Howler events.
  // Paged (offset + hasMore) and orderable: 'recent' (last seen) or 'active'
  // (most interactions — the "top users" view).
  async function people({ ids = null, days, from, to, q = '', limit = 200, offset = 0, orderBy = 'recent' } = {}) {
    const w = win({ days, from, to });
    const L = Math.min(Math.max(Number(limit) || 200, 1), 500);
    const off = Math.min(Math.max(Number(offset) || 0, 0), 1800);
    const order = orderBy === 'active' ? 'interactions DESC' : 'lastSeen DESC';
    const m = metricMap();
    const c = conn();
    const p = m.personProps;
    const term = String(q || '').trim().slice(0, 80);
    const scope = ids ? ` AND toString(${prop(c.eventIdProp)}) IN (${hqlList(ids)})` : '';
    const search = term
      ? ` AND (${[p.email, p.firstName, p.lastName, p.phone].map((f) => `toString(${personProp(f)}) ILIKE ${hqlStr(`%${term}%`)}`).join(' OR ')})`
      : '';
    // Personal API keys forbid OFFSET (PostHog HTTP 400) — fetch up to the end of
    // the requested page in one bounded query and slice the page out locally.
    const fetchN = Math.min(off + L + 1, 2000);
    const rows = await hogql(`
      SELECT any(toString(${personProp(p.email)})) AS email, any(toString(${personProp(p.firstName)})) AS firstName,
             any(toString(${personProp(p.lastName)})) AS lastName, any(toString(${personProp(p.phone)})) AS phone,
             max(timestamp) AS lastSeen, count() AS interactions,
             groupUniqArray(5)(toString(${prop(c.eventNameProp)})) AS eventNames
      FROM events WHERE ${tsWin(w)}${scope}${search}
      GROUP BY person_id ORDER BY ${order} LIMIT ${fetchN}`, { ttl: PEOPLE_TTL });
    return {
      days: w.days, offset: off, orderBy: orderBy === 'active' ? 'active' : 'recent', hasMore: rows.length > off + L,
      people: rows.slice(off, off + L).map((r) => ({ ...r, eventNames: (r.eventNames || []).filter(Boolean) })),
    };
  }

  // Moments — things WE did that could move the app numbers: community posts
  // (Social+, server/socialplus.js) and campaign sends (Engage, server/actions.js),
  // overlaid on the charts as markers so a DAU spike lines up with its cause.
  // Reads sibling modules' tables read-only and degrades to [] when a module
  // isn't installed. Timestamps are ISO strings; lexical compare against the
  // window works ('~' sorts after 'T', so `to~` is an inclusive end-of-day cap).
  function moments(entityId, o) {
    const w = win(o);
    const cap = `${w.to}~`;
    const out = [];
    try {
      const COLS = 'post_id, community_name, text, posted_at, impressions, reach, reactions, comments, shares';
      const rows = entityId
        ? sql.prepare(`SELECT ${COLS} FROM socialplus_posts WHERE entity_id=? AND posted_at>=? AND posted_at<=? ORDER BY posted_at DESC LIMIT 100`).all(entityId, w.from, cap)
        : sql.prepare(`SELECT ${COLS} FROM socialplus_posts WHERE posted_at>=? AND posted_at<=? ORDER BY posted_at DESC LIMIT 100`).all(w.from, cap);
      for (const r of rows) {
        const text = String(r.text || '').replace(/\s+/g, ' ');
        out.push({
          at: String(r.posted_at), type: 'post', appLinked: true,
          label: `${r.community_name ? `${r.community_name}: ` : ''}${text.slice(0, 60) || 'Community post'}`,
          // Full metadata for the tap-a-marker detail card + views-scaled stems.
          postId: String(r.post_id || ''), community: String(r.community_name || ''), text: text.slice(0, 240),
          impressions: r.impressions == null ? null : Number(r.impressions), reach: r.reach == null ? null : Number(r.reach),
          reactions: r.reactions == null ? null : Number(r.reactions), comments: r.comments == null ? null : Number(r.comments),
          shares: r.shares == null ? null : Number(r.shares),
        });
      }
    } catch { /* Social+ not installed — no post markers */ }
    try {
      const rows = entityId
        ? sql.prepare("SELECT title, approved_at, config FROM actions WHERE entity_id=? AND approved_at>=? AND approved_at<=? AND status IN ('done','running') ORDER BY approved_at DESC LIMIT 100").all(entityId, w.from, cap)
        : sql.prepare("SELECT title, approved_at, config FROM actions WHERE approved_at>=? AND approved_at<=? AND status IN ('done','running') ORDER BY approved_at DESC LIMIT 100").all(w.from, cap);
      // Is this campaign app-relevant? The composer's explicit channel tag wins
      // (config.channelTag, 'app' = yes, any other tag = no); untagged campaigns
      // are auto-detected: content carrying a ChottuLink short URL (those exist
      // to deep-link into the Howler app) counts as app-driving. Raw substring
      // scan of the config JSON — bodies/steps/CTAs all live in there.
      let shortUrls = [];
      try {
        shortUrls = (entityId
          ? sql.prepare("SELECT short_url FROM chottu_links WHERE entity_id=? AND short_url != '' LIMIT 300").all(entityId)
          : sql.prepare("SELECT short_url FROM chottu_links WHERE short_url != '' LIMIT 300").all()
        ).map((r) => String(r.short_url));
      } catch { /* Chottu not installed — tag-only detection */ }
      for (const r of rows) {
        let tag = '';
        try { tag = String(JSON.parse(r.config || '{}').channelTag || ''); } catch { /* unreadable config — treat as untagged */ }
        const appLinked = tag ? tag === 'app' : shortUrls.some((u) => String(r.config || '').includes(u));
        out.push({ at: String(r.approved_at), type: 'campaign', label: String(r.title || 'Campaign').slice(0, 60), tag, appLinked });
      }
    } catch { /* Engage not installed — no campaign markers */ }
    return out.sort((a, b) => (a.at < b.at ? -1 : 1));
  }
  // Daily ChottuLink clicks as an overlay SERIES (not markers): Chottu snapshots
  // each link's cumulative total once a day (chottu_link_stats), so clicks-on-day
  // = today's total − yesterday's, summed over the entity's links. Needs two
  // snapshots to produce a point — history deepens daily. [] when not installed.
  function linkClicks(entityId, o) {
    const w = win(o);
    try {
      const rows = entityId
        ? sql.prepare(`SELECT s.captured_on AS date, SUM(s.total_clicks) AS total FROM chottu_link_stats s JOIN chottu_links l ON l.id = s.link_id
            WHERE l.entity_id=? AND s.captured_on >= date(?, '-1 day') AND s.captured_on <= ? GROUP BY s.captured_on ORDER BY s.captured_on`).all(entityId, w.from, w.to)
        : sql.prepare(`SELECT s.captured_on AS date, SUM(s.total_clicks) AS total FROM chottu_link_stats s
            WHERE s.captured_on >= date(?, '-1 day') AND s.captured_on <= ? GROUP BY s.captured_on ORDER BY s.captured_on`).all(w.from, w.to)
      const out = [];
      for (let i = 1; i < rows.length; i++) {
        if (rows[i].date < w.from) continue;
        out.push({ date: String(rows[i].date), clicks: Math.max(0, (rows[i].total || 0) - (rows[i - 1].total || 0)) });
      }
      return out;
    } catch { return []; /* Chottu links not installed */ }
  }

  // ── 🦉 Owl summary of the whole App analytics page ──────────────────────────────
  // Same UX as the whole-dashboard summary: gather everything the page shows for
  // this client + window, stream an analyst read with grounded suggestions.
  // Prompt lives here (module-owned, like journeys) and is surfaced in the AI
  // audit via insights.promptRegistry() spreading this module's promptRegistry().
  async function appInsightFacts(entityId, q) {
    const w = win(q);
    const ids = await eventIdsForEntity(entityId);
    const rep = entityReport(entityId, w, ids);
    if (!rep.scoped) throw new HttpError(400, 'No app data is scoped to this client yet — their suites need an event lock first.');
    let live = null;
    try { live = { ...(await liveToday(ids)), windowUniques: await windowUniques(ids, w) }; } catch { /* rollup still tells the story */ }
    const bds = [];
    for (const key of metricMap().breakdownProps.slice(0, 3)) {
      try { bds.push(await breakdown({ ids, from: w.from, to: w.to, key })); } catch { /* skip a failing key */ }
    }
    let topUsers = [];
    try { topUsers = (await people({ ids, from: w.from, to: w.to, orderBy: 'active', limit: 10 })).people; } catch { /* optional */ }
    return { report: rep, live, moments: moments(entityId, w), linkClicks: linkClicks(entityId, w), breakdowns: bds, topUsers };
  }
  async function streamAppInsight(ctx, onText) {
    const { requireClient, systemWith, MODEL } = require('./insights'); // lazy — avoids an init-time require cycle (insights' registry requires this module)
    const c = requireClient(ctx.apiKey);
    const stream = c.messages.stream({
      model: MODEL,
      max_tokens: 1400,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      system: systemWith(APP_INSIGHT_SYSTEM, ctx.instructions),
      messages: [{ role: 'user', content: buildAppInsightPrompt(ctx) }],
    });
    stream.on('text', (t) => onText(t));
    await stream.finalMessage();
  }

  // ── routes ──────────────────────────────────────────────────────────────────────
  const myEntity = (req, res, next) => {
    const eid = req.params.entityId;
    if (req.user && (req.user.role === 'admin' || (req.user.entityIds || []).includes(eid))) return next();
    return res.status(403).json({ error: 'Not your client.' });
  };
  const maskKey = (k) => (k ? `••••${String(k).slice(-4)}` : '');

  // Connection + mapping (platform-level; the key is write-only).
  app.get('/api/admin/posthog/settings', auth.requireAdmin, (_req, res) => {
    const c = conn();
    res.json({
      host: db.getSetting('posthog_host', ''), projectId: db.getSetting('posthog_project_id', ''),
      keySet: !!(db.getSetting('posthog_api_key', '') || process.env.POSTHOG_API_KEY),
      keyHint: maskKey(db.getSetting('posthog_api_key', '')),
      envFallback: !db.getSetting('posthog_api_key', '') && !!process.env.POSTHOG_API_KEY,
      eventIdProp: c.eventIdProp, eventNameProp: c.eventNameProp,
      metricMap: metricMap(), syncEnabled: db.getSetting('posthog_sync_enabled', '1') !== '0',
      ...status(),
    });
  });
  app.put('/api/admin/posthog/settings', auth.requireAdmin, (req, res) => {
    const b = req.body || {};
    if (b.host !== undefined) db.setSetting('posthog_host', String(b.host || '').replace(/\/$/, '').trim());
    if (b.projectId !== undefined) db.setSetting('posthog_project_id', String(b.projectId || '').trim());
    if (b.apiKey) db.setSetting('posthog_api_key', String(b.apiKey).trim());
    if (b.clearApiKey) db.setSetting('posthog_api_key', '');
    if (b.eventIdProp !== undefined) db.setSetting('posthog_event_id_property', String(b.eventIdProp || '').trim());
    if (b.eventNameProp !== undefined) db.setSetting('posthog_event_name_property', String(b.eventNameProp || '').trim());
    if (b.syncEnabled !== undefined) db.setSetting('posthog_sync_enabled', b.syncEnabled ? '1' : '0');
    if (b.metricMap && typeof b.metricMap === 'object') {
      const cur = metricMap();
      const nx = {
        screenEvents: nameList(b.metricMap.screenEvents ?? cur.screenEvents),
        ctaEvents: nameList(b.metricMap.ctaEvents ?? cur.ctaEvents),
        purchaseEvents: nameList(b.metricMap.purchaseEvents ?? cur.purchaseEvents),
        purchaseValueProp: String(b.metricMap.purchaseValueProp ?? cur.purchaseValueProp).trim().slice(0, 80),
        notificationEvents: nameList(b.metricMap.notificationEvents ?? cur.notificationEvents),
        breakdownProps: nameList(b.metricMap.breakdownProps ?? cur.breakdownProps),
        personProps: { ...cur.personProps },
      };
      for (const k of ['email', 'firstName', 'lastName', 'phone']) {
        if (b.metricMap.personProps?.[k] !== undefined) nx.personProps[k] = String(b.metricMap.personProps[k] || '').trim().slice(0, 80) || DEFAULT_MAP.personProps[k];
      }
      db.setSetting('posthog_metric_map', JSON.stringify(nx));
    }
    qcache.clear();
    res.json({ ok: true });
  });
  app.post('/api/admin/posthog/test', auth.requireAdmin, asyncHandler(async (_req, res) => {
    if (!isConfigured()) throw new HttpError(400, 'Add the PostHog host, project ID and personal API key first.');
    const [row] = await hogql('SELECT count() AS n FROM events WHERE timestamp >= now() - INTERVAL 1 DAY');
    res.json({ ok: true, events24h: Number(row?.n) || 0 });
  }));
  // What the app actually sends — for the mapping editor (top events, 30 days).
  app.get('/api/admin/posthog/events-catalog', auth.requireAdmin, asyncHandler(async (_req, res) => {
    const rows = await hogql('SELECT event, count() AS n FROM events WHERE timestamp >= now() - INTERVAL 30 DAY GROUP BY event ORDER BY n DESC LIMIT 200', { ttl: CATALOG_TTL });
    res.json({ events: rows.map((r) => ({ event: String(r.event), count: Number(r.n) || 0 })) });
  }));
  // History hunt: does ANYTHING matching a term exist — searching a full year of
  // event NAMES and the configured breakdown-property VALUES (a "notification
  // opened" can hide as interaction_type=notification_opened rather than its own
  // event). Returns counts + first/last seen so "we used to track it" shows too.
  app.get('/api/admin/posthog/search-events', auth.requireAdmin, asyncHandler(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 60);
    if (!q) throw new HttpError(400, 'Pass ?q= — e.g. notif.');
    const like = hqlStr(`%${q}%`);
    const events = await hogql(`SELECT event, count() AS n, toString(min(timestamp)) AS firstSeen, toString(max(timestamp)) AS lastSeen FROM events WHERE timestamp >= now() - INTERVAL 365 DAY AND event ILIKE ${like} GROUP BY event ORDER BY n DESC LIMIT 40`, { ttl: CATALOG_TTL });
    const values = [];
    for (const key of metricMap().breakdownProps) {
      const rows = await hogql(`SELECT toString(${prop(key)}) AS v, count() AS n, toString(min(timestamp)) AS firstSeen, toString(max(timestamp)) AS lastSeen FROM events WHERE timestamp >= now() - INTERVAL 365 DAY AND toString(${prop(key)}) ILIKE ${like} GROUP BY v ORDER BY n DESC LIMIT 20`, { ttl: CATALOG_TTL });
      for (const r of rows) values.push({ key, value: String(r.v), count: Number(r.n) || 0, firstSeen: String(r.firstSeen), lastSeen: String(r.lastSeen) });
    }
    res.json({
      q,
      events: events.map((r) => ({ event: String(r.event), count: Number(r.n) || 0, firstSeen: String(r.firstSeen), lastSeen: String(r.lastSeen) })),
      values,
    });
  }));

  // Top values of one property on one event — the tool for writing
  // `event : property=value` mapping entries (e.g. what does `interaction`'s
  // `action` property contain?). Everything escaped via hqlStr.
  app.get('/api/admin/posthog/property-values', auth.requireAdmin, asyncHandler(async (req, res) => {
    const event = String(req.query.event || '').trim().slice(0, 200);
    const key = String(req.query.key || '').trim().slice(0, 200);
    if (!event || !key) throw new HttpError(400, 'Pass ?event= and ?key=.');
    const rows = await hogql(`SELECT toString(${prop(key)}) AS v, count() AS n FROM events WHERE event = ${hqlStr(event)} AND timestamp >= now() - INTERVAL 30 DAY AND notEmpty(toString(${prop(key)})) GROUP BY v ORDER BY n DESC LIMIT 50`, { ttl: CATALOG_TTL });
    res.json({ event, key, values: rows.map((r) => ({ value: String(r.v), count: Number(r.n) || 0 })) });
  }));
  // Does the configured event-id property actually exist, and what do its values
  // look like? Answers "whole app has data but a client's view is empty" without
  // guesswork: shows how many recent events carry the property, sample values (to
  // eyeball against core_events.id), the real property keys the app sends (event
  // + person), and what the local rollup holds.
  app.get('/api/admin/posthog/diagnose', auth.requireAdmin, asyncHandler(async (_req, res) => {
    const c = conn();
    const [tagged] = await hogql(`SELECT count() AS n, uniq(toString(${prop(c.eventIdProp)})) AS ids FROM events WHERE timestamp >= now() - INTERVAL 7 DAY AND notEmpty(toString(${prop(c.eventIdProp)}))`);
    const sample = await hogql(`SELECT toString(${prop(c.eventIdProp)}) AS v, any(toString(${prop(c.eventNameProp)})) AS name, count() AS n FROM events WHERE timestamp >= now() - INTERVAL 7 DAY AND notEmpty(toString(${prop(c.eventIdProp)})) GROUP BY v ORDER BY n DESC LIMIT 12`);
    // Key discovery can fail on older HogQL — degrade to null rather than 500.
    const keysOf = async (expr) => {
      try {
        const rows = await hogql(`SELECT arrayJoin(JSONExtractKeys(${expr})) AS key, count() AS n FROM events WHERE timestamp >= now() - INTERVAL 1 DAY GROUP BY key ORDER BY n DESC LIMIT 40`, { ttl: CATALOG_TTL });
        return rows.map((r) => ({ key: String(r.key), count: Number(r.n) || 0 }));
      } catch { return null; }
    };
    res.json({
      eventIdProp: c.eventIdProp,
      taggedEvents7d: Number(tagged?.n) || 0,
      distinctIds7d: Number(tagged?.ids) || 0,
      sampleIds: sample.map((r) => ({ id: String(r.v), name: String(r.name || ''), count: Number(r.n) || 0 })),
      eventPropertyKeys: await keysOf('properties'),
      personPropertyKeys: await keysOf('person.properties'),
      rollup: {
        eventRows: sql.prepare('SELECT COUNT(*) c FROM posthog_daily_event').get().c,
        eventRowsLast7d: sql.prepare('SELECT COUNT(*) c FROM posthog_daily_event WHERE date>=?').get(sinceDate(7)).c,
        appDays: sql.prepare('SELECT COUNT(*) c FROM posthog_daily_app').get().c,
      },
    });
  }));

  // Management view (whole app), with an optional per-client lens (dual surface).
  app.get('/api/admin/app-analytics', auth.requireAdmin, asyncHandler(async (req, res) => {
    const eid = String(req.query.entityId || '');
    if (eid) {
      const ids = await eventIdsForEntity(eid);
      return res.json(await withLive(entityReport(eid, winQ(req), ids), ids.length ? ids : null));
    }
    res.json(await withLive(appReport(winQ(req)), null));
  }));
  app.get('/api/admin/app-analytics/people', auth.requireAdmin, asyncHandler(async (req, res) => {
    const eid = String(req.query.entityId || '');
    const ids = eid ? await eventIdsForEntity(eid) : null;
    if (eid && !ids.length) return res.json({ days: win(winQ(req)).days, people: [], scoped: false });
    res.json(await people({ ids, ...winQ(req), q: req.query.q, limit: req.query.limit, offset: req.query.offset, orderBy: req.query.orderBy }));
  }));
  app.get('/api/admin/app-analytics/breakdown', auth.requireAdmin, asyncHandler(async (req, res) => {
    const key = breakdownKeyOrThrow(req);
    const eid = String(req.query.entityId || '');
    const ids = eid ? await eventIdsForEntity(eid) : null;
    if (eid && !ids.length) return res.json({ key, days: win(winQ(req)).days, values: [] });
    res.json(await breakdown({ ids, ...winQ(req), key }));
  }));
  app.get('/api/admin/app-analytics/moments', auth.requireAdmin, (req, res) => {
    const eid = String(req.query.entityId || '') || null;
    res.json({ moments: moments(eid, winQ(req)), linkClicks: linkClicks(eid, winQ(req)) });
  });
  app.get('/api/admin/app-analytics/today', auth.requireAdmin, asyncHandler(async (req, res) => {
    const eid = String(req.query.entityId || '');
    const ids = eid ? await eventIdsForEntity(eid) : null;
    if (eid && !ids.length) return res.json({ asOf: now(), hours: [] });
    res.json(await todayHourly(ids, winQ(req)));
  }));
  app.get('/api/admin/app-analytics/breakdown-series', auth.requireAdmin, asyncHandler(async (req, res) => {
    const key = breakdownKeyOrThrow(req);
    const eid = String(req.query.entityId || '');
    const ids = eid ? await eventIdsForEntity(eid) : null;
    if (eid && !ids.length) return res.json({ key, days: win(winQ(req)).days, values: [], series: [] });
    res.json(await breakdownSeries({ ids, ...winQ(req), key, values: req.query.values, granularity: req.query.granularity }));
  }));
  app.post('/api/admin/app-analytics/sync', auth.requireAdmin, asyncHandler(async (req, res) => {
    const r = await syncDaily(Number(req.body?.days) || undefined);
    if (!r.ok) throw new HttpError(400, r.error || 'Sync failed.');
    res.json({ ...r, ...appReport(req.query.days) });
  }));

  // Client self-service — scoped to their events, fail closed.
  app.get('/api/my/app-analytics/:entityId', auth.requireAuth, myEntity, asyncHandler(async (req, res) => {
    const ids = await eventIdsForEntity(req.params.entityId);
    const report = entityReport(req.params.entityId, winQ(req), ids);
    res.json(ids.length ? await withLive(report, ids) : { ...report, live: null });
  }));
  app.get('/api/my/app-analytics/:entityId/people', auth.requireAuth, myEntity, asyncHandler(async (req, res) => {
    const ids = await eventIdsForEntity(req.params.entityId);
    if (!ids.length) return res.json({ days: win(winQ(req)).days, people: [], scoped: false });
    res.json(await people({ ids, ...winQ(req), q: req.query.q, limit: req.query.limit, offset: req.query.offset, orderBy: req.query.orderBy }));
  }));
  app.get('/api/my/app-analytics/:entityId/breakdown', auth.requireAuth, myEntity, asyncHandler(async (req, res) => {
    const key = breakdownKeyOrThrow(req);
    const ids = await eventIdsForEntity(req.params.entityId);
    if (!ids.length) return res.json({ key, days: win(winQ(req)).days, values: [] });
    res.json(await breakdown({ ids, ...winQ(req), key }));
  }));
  // Streamed Owl summary of the page (mirrors POST /api/dashboard-insight).
  async function insightHandler(entityId, req, res) {
    const facts = await appInsightFacts(entityId, winQ(req));
    const apiKey = ai?.keyFor ? ai.keyFor(entityId) : '';
    const instructions = ai?.instructionsFor ? ai.instructionsFor(entityId) : '';
    try {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      const run = () => streamAppInsight({ ...facts, apiKey, instructions }, (txt) => res.write(txt));
      await (ai?.meter ? ai.meter('app_insight', entityId, run) : run());
      res.end();
    } catch (err) {
      if (res.headersSent) { res.write('\n\n[error: the summary could not be completed]'); res.end(); console.error('[posthog insight]', err.message); }
      else throw err;
    }
  }
  app.post('/api/my/app-analytics/:entityId/insight', auth.requireAuth, myEntity, asyncHandler(async (req, res) => insightHandler(req.params.entityId, req, res)));
  app.post('/api/admin/app-analytics/insight', auth.requireAdmin, asyncHandler(async (req, res) => {
    const eid = String(req.query.entityId || req.body?.entityId || '');
    if (!eid) throw new HttpError(400, 'Pass entityId — the Owl summary is per client.');
    await insightHandler(eid, req, res);
  }));

  app.get('/api/my/app-analytics/:entityId/moments', auth.requireAuth, myEntity, (req, res) => {
    res.json({ moments: moments(req.params.entityId, winQ(req)), linkClicks: linkClicks(req.params.entityId, winQ(req)) });
  });
  app.get('/api/my/app-analytics/:entityId/today', auth.requireAuth, myEntity, asyncHandler(async (req, res) => {
    const ids = await eventIdsForEntity(req.params.entityId);
    if (!ids.length) return res.json({ asOf: now(), hours: [] });
    res.json(await todayHourly(ids, winQ(req)));
  }));
  app.get('/api/my/app-analytics/:entityId/breakdown-series', auth.requireAuth, myEntity, asyncHandler(async (req, res) => {
    const key = breakdownKeyOrThrow(req);
    const ids = await eventIdsForEntity(req.params.entityId);
    if (!ids.length) return res.json({ key, days: win(winQ(req)).days, values: [], series: [] });
    res.json(await breakdownSeries({ ids, ...winQ(req), key, values: req.query.values, granularity: req.query.granularity }));
  }));

  console.log('[posthog] app-analytics connector mounted');
  return { syncDaily, tick, appReport, entityReport, eventIdsForEntity, suiteEventScope, liveToday, windowUniques, breakdown, breakdownSeries, todayHourly, moments, linkClicks, appInsightFacts, people, isConfigured, hogql };
}

// ── getAppAnalytics — the Owl's read tool over this module ({ schema, run },
// registered in owlTools.js like journeys.owlTool). Forced to the client's own
// event ids exactly like their App page (fail closed); numbers come straight
// from the rollup + live tier — never invented. Flag-gated via OWL_TOOL_FLAGS
// ('appanalytics'): flag off = the tool is never offered to the model.
function owlTool({ db, getApi }) {
  const refuse = (reason, message) => ({ ok: false, reason, message });
  async function run(args = {}, ctx = {}) {
    const { user, suiteId, entityId } = ctx;
    if (!user) return refuse('no_user', 'No authenticated user.');
    const eid = entityId || (suiteId && db && db.getSuite ? (db.getSuite(suiteId) || {}).entityId : null);
    if (!eid) return refuse('no_client', 'Open or pick a client first.');
    const api = typeof getApi === 'function' ? getApi() : null;
    if (!api || !api.entityReport) return refuse('unavailable', 'App analytics isn\'t available right now.');
    if (!api.isConfigured()) return refuse('not_configured', 'The PostHog connection isn\'t set up yet (Admin → Integrations → PostHog).');
    const days = Number(args.days) || DAYS_DEFAULT;
    const ids = await api.eventIdsForEntity(eid);
    const rep = api.entityReport(eid, days, ids);
    if (!rep.scoped) return refuse('no_scope', 'No Howler event ids resolve for this client yet — their suites need an event lock before app data can be scoped to them.');
    let live = null; // a briefly unreachable PostHog degrades to the rollup, never an error
    try { live = { ...(await api.liveToday(ids)), windowUniques: await api.windowUniques(ids, days) }; } catch { live = null; }
    let breakdown = null;
    if (args.breakdown) {
      if (!(rep.breakdowns || []).includes(args.breakdown)) return refuse('unknown_breakdown', `Pick a configured breakdown: ${(rep.breakdowns || []).join(', ') || '(none configured)'}.`);
      try { breakdown = await api.breakdown({ ids, days, key: args.breakdown }); } catch { breakdown = null; }
    }
    return {
      ok: true, days: rep.days, lastSync: rep.lastSync,
      totals: rep.totals, live, events: (rep.events || []).slice(0, 15),
      breakdownsAvailable: rep.breakdowns || [], breakdown,
      note: 'In-app engagement from the Howler consumer app (PostHog), scoped to this client\'s events. live.actives = unique people today so far; live.windowUniques = unique people across the whole window (use this for "how many people", not the summed daily uniques). "purchases" are in-app purchase EVENTS — ticket-sales revenue truth lives in the dashboards, say so if asked about revenue.',
    };
  }
  const schema = {
    name: 'getAppAnalytics',
    description: 'Howler CONSUMER APP engagement for this client\'s events, from PostHog: unique viewers (live + window), views, interactions, CTA taps and in-app purchase signals — per event, with optional breakdowns (e.g. interaction_type, CTA_Label, surface — the reply lists breakdownsAvailable). Use for "how is my event doing in the app", "what are people tapping", "app views this week". Read-only.',
    input_schema: { type: 'object', properties: {
      days: { type: 'number', description: 'Window in days (default 28, max 90).' },
      breakdown: { type: 'string', description: 'Optional property to break down by — call without it first; the reply lists breakdownsAvailable.' },
    } },
  };
  return { schema, run };
}

module.exports = { mount, owlTool, promptRegistry, buildAppInsightPrompt, hqlStr, hqlList, prop, personProp, countIn, parseMapEntry, mapCond, zipRows, nameList, DEFAULT_MAP };
