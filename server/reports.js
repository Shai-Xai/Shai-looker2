// ─── Report Studio: block-based client reports ───────────────────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the report_templates / report_snapshots /
// report_assets tables and every /api/.../reports route. Spec:
// docs/specs/REPORT_STUDIO_SPEC.md.
//
// Model: a TEMPLATE (author blocks + schedule + recipients) generates immutable
// SNAPSHOTS (frozen numbers, chart PNGs, AI text) — one-off via "Generate now" or
// recurring via the module's own claim-first scheduler tick (same crash-safety
// convention as server/scheduler.js: the run-slot is claimed BEFORE the send, so a
// deploy mid-run can miss one run but never double-send). Snapshots are shared by
// capability token: /r/:token (public web viewer), /api/public/reports/:token(.pdf).
//
// Tile data resolves through the SAME scoped fact builder digests use
// (buildFactsFromTiles → tileQueryBody → applyScope), so a report can never read
// outside the client's entity scope. Kill switch: settings key `reports_enabled`
// ('0' disables the tick + 404s the routes).

const crypto = require('crypto');
const { asyncHandler, HttpError } = require('./http');
const emailBlocks = require('./emailBlocks');
const aiUsage = require('./aiUsage');

const DEFAULT_TZ = 'Africa/Johannesburg';

// The Report Studio analysis prompt — AI commentary over the tiles in one report
// section, or an executive summary over the whole report. Lives here with the
// feature (like emailDesign/fanOwl prompts) and is surfaced in the Admin → AI
// audit via promptRegistry() in server/insights.js.
const REPORT_SYSTEM = `You are a senior data analyst for Howler, an events ticketing platform (organisers run events; customers buy tickets; amounts are in South African Rand, ZAR — unless the standing instructions name another currency), writing analysis inside a polished client-facing report that may be shared onward with stakeholders (sponsors, partners, executives).

You are given the data behind the report tiles in scope (one section, or the whole report). Write presentation-ready commentary:
- Lead with the single most important takeaway across the tiles in scope.
- Support it with specific numbers: totals, period-over-period changes, top contributors, concentrations, outliers.
- Be honest — if a figure looks implausible or the data is too sparse to conclude much, say so briefly and cautiously.

Rules: synthesize ACROSS tiles, don't describe each tile in turn. 1-3 short paragraphs of plain prose — no headings, no bullet lists, no preamble, no meta commentary about "the data provided". Write for an external reader: no internal jargon or tool names.`;
const BLOCK_TYPES = new Set(['heading', 'text', 'image', 'button', 'divider', 'tile', 'ai', 'campaign', 'app', 'goals', 'social', 'live']);
const MAX_BLOCKS = 60;
const MAX_TILE_BLOCKS = 20;   // tile + campaign + app blocks share this data-block cap
const MAX_AI_BLOCKS = 8;

function mount(app, { db, auth, mailer, insights, currency, buildFactsFromTiles, factValueLabel, campaignsFor, appReportFor, goalsFor, social, liveLatestFor, anthropicKeyForEntity, aiInstructionsFor, notifyOps }) {
  const sql = db.db;
  const now = () => new Date().toISOString();
  const uuid = () => crypto.randomUUID();
  const newToken = () => crypto.randomBytes(18).toString('base64url'); // 144-bit capability
  const enabled = () => db.getSetting('reports_enabled', '1') !== '0';
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  sql.exec(`
    CREATE TABLE IF NOT EXISTS report_templates (
      id           TEXT PRIMARY KEY,
      entity_id    TEXT NOT NULL,
      title        TEXT NOT NULL DEFAULT '',
      blocks       TEXT NOT NULL DEFAULT '[]',
      recipients   TEXT NOT NULL DEFAULT '[]',
      cadence      TEXT NOT NULL DEFAULT 'none',   -- none | daily | weekly | monthly
      time_of_day  TEXT NOT NULL DEFAULT '07:00',
      weekday      INTEGER NOT NULL DEFAULT 1,      -- 0=Sun..6=Sat (weekly)
      monthday     INTEGER NOT NULL DEFAULT 1,      -- 1..28 (monthly)
      timezone     TEXT NOT NULL DEFAULT '${DEFAULT_TZ}',
      status       TEXT NOT NULL DEFAULT 'active',  -- active | paused
      next_run_at  TEXT,
      last_run_at  TEXT NOT NULL DEFAULT '',
      last_status  TEXT NOT NULL DEFAULT '',
      created_by   TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_report_templates_due ON report_templates(status, next_run_at);
    CREATE TABLE IF NOT EXISTS report_snapshots (
      id           TEXT PRIMARY KEY,
      template_id  TEXT NOT NULL,
      entity_id    TEXT NOT NULL,
      title        TEXT NOT NULL DEFAULT '',
      content      TEXT NOT NULL DEFAULT '{}',
      token        TEXT NOT NULL UNIQUE,
      sent_to      TEXT NOT NULL DEFAULT '[]',
      created_by   TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_report_snapshots_tpl ON report_snapshots(template_id, created_at);
    CREATE TABLE IF NOT EXISTS report_assets (
      token        TEXT PRIMARY KEY,
      snapshot_id  TEXT NOT NULL,
      mime         TEXT NOT NULL DEFAULT 'image/png',
      bytes        BLOB NOT NULL,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_report_assets_snap ON report_assets(snapshot_id);
  `);

  // ── sanitise author input ──
  function cleanBlocks(arr) {
    if (!Array.isArray(arr)) return [];
    let tiles = 0; let ais = 0;
    const out = [];
    for (const [i, b] of arr.slice(0, MAX_BLOCKS).entries()) {
      if (!b || !BLOCK_TYPES.has(b.type)) continue;
      if (['tile', 'campaign', 'app', 'goals', 'social', 'live'].includes(b.type) && ++tiles > MAX_TILE_BLOCKS) continue;
      if (b.type === 'ai' && ++ais > MAX_AI_BLOCKS) continue;
      out.push({
        id: String(b.id || `b${i}`).slice(0, 40),
        type: b.type,
        text: String(b.text || '').slice(0, 8000),
        level: [1, 2].includes(Number(b.level)) ? Number(b.level) : 1,
        url: String(b.url || '').slice(0, 1500000),   // data-URL images ride the template
        alt: String(b.alt || '').slice(0, 200),
        href: String(b.href || '').slice(0, 500),
        dashboardId: String(b.dashboardId || '').slice(0, 80),
        tileId: String(b.tileId || '').slice(0, 80),
        display: ['auto', 'chart', 'value', 'table'].includes(b.display) ? b.display : 'auto',
        scope: b.scope === 'report' ? 'report' : 'section',
        focus: String(b.focus || '').slice(0, 1000),
        campaignId: String(b.campaignId || '').slice(0, 60),
        appView: ['summary', 'trend', 'events'].includes(b.appView) ? b.appView : 'summary',
        days: [7, 14, 28, 90].includes(Number(b.days)) ? Number(b.days) : 28,
        socialView: ['accounts', 'trend', 'posts'].includes(b.socialView) ? b.socialView : 'accounts',
        socialMetric: ['reach', 'followers', 'impressions', 'engagement'].includes(b.socialMetric) ? b.socialMetric : 'reach',
        suiteId: String(b.suiteId || '').slice(0, 60),
      });
    }
    return out;
  }

  function clean(body, entityId) {
    const cadence = ['none', 'daily', 'weekly', 'monthly'].includes(body.cadence) ? body.cadence : 'none';
    return {
      entityId,
      title: String(body.title || '').slice(0, 120),
      blocks: cleanBlocks(body.blocks),
      recipients: Array.isArray(body.recipients) ? [...new Set(body.recipients.map((e) => String(e).trim().toLowerCase()).filter((e) => /.+@.+\..+/.test(e)))].slice(0, 25) : [],
      cadence,
      timeOfDay: /^\d{1,2}:\d{2}$/.test(body.timeOfDay || '') ? body.timeOfDay : '07:00',
      weekday: Number.isInteger(body.weekday) && body.weekday >= 0 && body.weekday <= 6 ? body.weekday : 1,
      monthday: Number.isInteger(body.monthday) && body.monthday >= 1 && body.monthday <= 28 ? body.monthday : 1,
      timezone: String(body.timezone || DEFAULT_TZ).slice(0, 60),
      status: body.status === 'paused' ? 'paused' : 'active',
    };
  }

  // ── timezone-aware schedule maths (mirrors server/scheduler.js, + monthly) ──
  const tzParts = (tz, date) => {
    const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    return Object.fromEntries(dtf.formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  };
  const tzOffsetMin = (tz, date) => {
    const p = tzParts(tz, date);
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return Math.round((asUTC - date.getTime()) / 60000);
  };
  const wallToUtc = (tz, y, mo, d, hh, mm) => {
    const guess = Date.UTC(y, mo - 1, d, hh, mm, 0);
    return new Date(guess - tzOffsetMin(tz, new Date(guess)) * 60000);
  };
  const localWeekday = (tz, date) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(tzParts(tz, date).weekday);

  function computeNextRun(tpl, from = new Date()) {
    if (tpl.cadence === 'none') return null;
    const tz = tpl.timezone || DEFAULT_TZ;
    const [hh, mm] = String(tpl.timeOfDay || '07:00').split(':').map(Number);
    for (let i = 0; i < 40; i++) { // 40 daily probes covers a full month boundary
      const probe = new Date(from.getTime() + i * 86400000);
      const p = tzParts(tz, probe);
      const cand = wallToUtc(tz, +p.year, +p.month, +p.day, hh || 0, mm || 0);
      if (cand <= from) continue;
      if (tpl.cadence === 'weekly' && localWeekday(tz, cand) !== (tpl.weekday ?? 1)) continue;
      if (tpl.cadence === 'monthly' && +tzParts(tz, cand).day !== (tpl.monthday || 1)) continue;
      return cand;
    }
    return null;
  }

  // ── row <-> object ──
  const rowToTpl = (r) => ({
    id: r.id, entityId: r.entity_id, title: r.title,
    blocks: JSON.parse(r.blocks || '[]'), recipients: JSON.parse(r.recipients || '[]'),
    cadence: r.cadence, timeOfDay: r.time_of_day, weekday: r.weekday, monthday: r.monthday, timezone: r.timezone,
    status: r.status, nextRunAt: r.next_run_at, lastRunAt: r.last_run_at, lastStatus: r.last_status,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  });
  const getTpl = (id) => { const r = sql.prepare('SELECT * FROM report_templates WHERE id=?').get(id); return r ? rowToTpl(r) : null; };
  const snapMeta = (r) => ({ id: r.id, templateId: r.template_id, title: r.title, token: r.token, path: `/r/${r.token}`, sentTo: JSON.parse(r.sent_to || '[]'), createdBy: r.created_by, createdAt: r.created_at });

  function upsert(id, t, createdBy) {
    const ts = now();
    const next = t.status === 'active' ? computeNextRun(t) : null;
    const nextIso = next ? next.toISOString() : null;
    if (id) {
      sql.prepare('UPDATE report_templates SET title=?, blocks=?, recipients=?, cadence=?, time_of_day=?, weekday=?, monthday=?, timezone=?, status=?, next_run_at=?, updated_at=? WHERE id=?')
        .run(t.title, JSON.stringify(t.blocks), JSON.stringify(t.recipients), t.cadence, t.timeOfDay, t.weekday, t.monthday, t.timezone, t.status, nextIso, ts, id);
      return getTpl(id);
    }
    const nid = uuid();
    sql.prepare('INSERT INTO report_templates (id, entity_id, title, blocks, recipients, cadence, time_of_day, weekday, monthday, timezone, status, next_run_at, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(nid, t.entityId, t.title, JSON.stringify(t.blocks), JSON.stringify(t.recipients), t.cadence, t.timeOfDay, t.weekday, t.monthday, t.timezone, t.status, nextIso, createdBy || '', ts, ts);
    return getTpl(nid);
  }

  // One analysis call: tile facts (same shape digests feed the model) → plain
  // prose, via insights' shared client/prompt plumbing. Frozen into the snapshot.
  async function reportAnalysis({ scopeLabel, reportTitle, focus, tiles, instructions, apiKey }) {
    const c = insights.requireClient(apiKey);
    const lines = [`Report: ${reportTitle || '(untitled)'}`, `Scope of this analysis: ${scopeLabel || 'the whole report'}`];
    if ((focus || '').trim()) lines.push(`The report author's focus for this analysis: ${focus.trim()}`);
    lines.push('', 'Tile data:');
    for (const t of tiles || []) {
      lines.push(`### ${t.title || '(untitled tile)'}${t.visType ? ` [${t.visType}]` : ''}`);
      if (t.context && t.context.trim()) lines.push(`(context: ${t.context.trim()})`);
      lines.push(insights.compactTable(t.fields, t.rows, 20), '');
    }
    const resp = await c.messages.create({
      model: insights.MODEL, max_tokens: 1200, thinking: { type: 'adaptive' }, output_config: { effort: 'low' },
      system: insights.systemWith(REPORT_SYSTEM, instructions),
      messages: [{ role: 'user', content: lines.join('\n') }],
    });
    return (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  }

  // ── snapshot generation (the core) ──
  const putAsset = (snapshotId, mime, bytes) => { const token = newToken(); sql.prepare('INSERT INTO report_assets (token, snapshot_id, mime, bytes, created_at) VALUES (?,?,?,?,?)').run(token, snapshotId, mime, bytes, now()); return token; };
  const getAsset = (token) => sql.prepare('SELECT mime, bytes FROM report_assets WHERE token=?').get(token) || null;

  // Flatten a fact's json_detail rows to a display table (rendered values,
  // pivoted measures as "key: val" pairs). Capped for the viewer/PDF/email.
  function factToTable(fact, maxCols = 8, maxRows = 12) {
    const f = fact.fields || {};
    const cols = [...(f.dimensions || []), ...(f.measures || []), ...(f.table_calculations || [])].slice(0, maxCols);
    const columns = cols.map((c) => String(c.label_short || c.label || c.name));
    const rows = (fact.rows || []).slice(0, maxRows).map((row) => cols.map((c) => {
      const cell = row[c.name];
      if (cell == null) return '';
      if (cell.value === undefined && cell.rendered === undefined && typeof cell === 'object') {
        return Object.entries(cell).map(([k, v]) => `${k}: ${v?.rendered ?? v?.value ?? ''}`).join('  ');
      }
      return String(cell.rendered ?? cell.value ?? '');
    }));
    return { columns, rows, more: Math.max(0, (fact.rows || []).length - maxRows) };
  }

  // Big-number formatting for KPI chips ("6,830"); money via the client's currency.
  const fmtNum = (v) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString('en-US') : String(v ?? '—'));
  // Synthesize a fact (the shape buildFactsFromTiles emits) from label/value pairs
  // or a daily series, so campaign + app blocks feed the AI analysis like tiles do.
  const metricsFact = (title, visType, metrics) => ({
    title, visType, context: '',
    fields: { dimensions: [{ name: 'metric', label: 'Metric' }], measures: [{ name: 'value', label: 'Value' }] },
    rows: metrics.map(([k, v]) => ({ metric: { value: k, rendered: k }, value: { value: v, rendered: String(v) } })),
    pivots: [],
  });
  const appSeriesFact = (title, series) => ({
    title, visType: 'looker_line', context: '',
    fields: { dimensions: [{ name: 'date', label: 'Day' }], measures: [{ name: 'uniques', label: 'App users' }, { name: 'views', label: 'Views' }, { name: 'ctaTaps', label: 'CTA taps' }] },
    rows: (series || []).map((r) => ({
      date: { value: r.date, rendered: r.date },
      uniques: { value: r.uniques || 0, rendered: String(r.uniques || 0) },
      views: { value: r.views || 0, rendered: String(r.views || 0) },
      ctaTaps: { value: r.ctaTaps || 0, rendered: String(r.ctaTaps || 0) },
    })),
    pivots: [],
  });

  // Resolve a template's author blocks into an immutable snapshot. Sequential by
  // design (one Looker query at a time — same as the digest fact builder).
  async function generateSnapshot(tpl, { byEmail = '' } = {}) {
    const entityId = tpl.entityId;
    let user = byEmail ? db.getUserByEmail(byEmail) : (tpl.createdBy ? db.getUserByEmail(tpl.createdBy) : null);
    if (!user || (user.role !== 'admin' && !(user.entityIds || []).includes(entityId))) {
      user = { id: `report:${entityId}`, email: byEmail || tpl.createdBy || '', role: 'client', entityIds: [entityId] };
    }
    const branding = mailer.resolveBranding(entityId);
    let tileimg = null;
    try { tileimg = require('./tileimg'); } catch (e) { console.error('[reports] tileimg load failed', e.message); }

    const snapshotId = uuid();
    const resolved = [];
    const factsByIdx = []; // parallel to resolved: the fact behind each tile block (for AI scoping)
    for (const b of tpl.blocks) {
      if (b.type === 'tile') {
        let fact = null;
        try { fact = ((await buildFactsFromTiles(user, entityId, [{ dashboardId: b.dashboardId, tileId: b.tileId }])).tiles || [])[0] || null; }
        catch (e) { console.error('[reports] tile resolve failed', b.dashboardId, b.tileId, e.message); }
        if (!fact) { resolved.push({ type: 'tile', kind: 'missing', title: b.text || 'Tile unavailable' }); factsByIdx.push(null); continue; }
        factsByIdx.push(fact);
        const asKpi = () => ({ type: 'tile', kind: 'kpi', title: fact.title, value: String(factValueLabel(fact) || '—') });
        const asTable = () => ({ type: 'tile', kind: 'table', title: fact.title, ...factToTable(fact) });
        if (b.display === 'value') { resolved.push(asKpi()); continue; }
        if (b.display === 'table') { resolved.push(asTable()); continue; }
        const png = tileimg ? tileimg.renderTilePng({ title: fact.title, vis: { type: fact.visType } }, fact, branding) : null;
        if (png && b.display !== 'value') { resolved.push({ type: 'tile', kind: 'chart', title: fact.title, assetToken: putAsset(snapshotId, 'image/png', png) }); continue; }
        // Not chartable: tables render as tables, single values as KPI chips.
        const isTable = /table/i.test(String(fact.visType || '')) || ((fact.rows || []).length > 1 && (fact.fields?.dimensions || []).length >= 1);
        resolved.push(isTable && b.display !== 'value' ? asTable() : asKpi());
        continue;
      }
      // Campaign block: headline results for ONE Engage campaign, frozen as a
      // sub-heading + KPI chips (same resolved vocabulary as tiles — the viewer,
      // PDF and email renderers need no special handling). Also feeds AI scope.
      if (b.type === 'campaign') {
        let c = null;
        try { c = (campaignsFor ? campaignsFor(entityId) : []).find((x) => x.id === b.campaignId) || null; }
        catch (e) { console.error('[reports] campaign resolve failed', b.campaignId, e.message); }
        if (!c) { factsByIdx.push(null); resolved.push({ type: 'tile', kind: 'missing', title: 'Campaign unavailable' }); continue; }
        const r = c.results || {};
        const sent = r.sent || 0;
        const ctr = sent > 0 ? Math.min(100, Math.round(((r.clicks || 0) / sent) * 100)) : 0;
        const title = c.title || c.config?.subject || 'Campaign';
        const metrics = [['Audience', c.audienceCount || 0], ['Sent', sent], ['Opens', r.opens || 0], ['Clicks', r.clicks || 0], ['Click rate', `${ctr}%`], ['Converted', r.converted || 0]];
        factsByIdx.push(metricsFact(`Campaign — ${title}${c.status ? ` (${c.status})` : ''}`, 'campaign', metrics));
        resolved.push({ type: 'heading', text: `📣 ${title}`, level: 2 });
        for (const [k, v] of metrics) resolved.push({ type: 'tile', kind: 'kpi', title: k, value: typeof v === 'number' ? fmtNum(v) : String(v) });
        continue;
      }
      // App analytics block: the client's native-app engagement (PostHog rollup,
      // flag-gated + scoped to their events by appReportFor). Three views:
      // summary KPI chips, a daily trend chart, or a per-event table.
      if (b.type === 'app') {
        let rep = null;
        try { rep = appReportFor ? await appReportFor(entityId, { days: b.days || 28 }) : null; }
        catch (e) { console.error('[reports] app analytics resolve failed', e.message); }
        if (!rep || !rep.scoped) { factsByIdx.push(null); resolved.push({ type: 'tile', kind: 'missing', title: 'App analytics unavailable' }); continue; }
        const t = rep.totals || {};
        const label = `App engagement — last ${rep.days} days`;
        if (b.appView === 'trend') {
          const fact = appSeriesFact(label, rep.series);
          factsByIdx.push(fact);
          const png = tileimg ? tileimg.renderTilePng({ title: label, vis: { type: 'looker_line' } }, fact, branding) : null;
          if (png) { resolved.push({ type: 'tile', kind: 'chart', title: label, assetToken: putAsset(snapshotId, 'image/png', png) }); continue; }
          resolved.push({ type: 'tile', kind: 'missing', title: `${label} — not enough data to chart` });
          continue;
        }
        if (b.appView === 'events') {
          const rows = (rep.events || []).slice(0, 12);
          factsByIdx.push(metricsFact(label, 'app', rows.map((e) => [e.eventName || e.eventRef, `${e.uniques || 0} users / ${e.views || 0} views / ${e.purchases || 0} purchases`])));
          resolved.push({
            type: 'tile', kind: 'table', title: `App engagement by event — last ${rep.days} days`,
            columns: ['Event', 'App users', 'Views', 'CTA taps', 'Purchases'],
            rows: rows.map((e) => [String(e.eventName || e.eventRef || ''), fmtNum(e.uniques || 0), fmtNum(e.views || 0), fmtNum(e.ctaTaps || 0), fmtNum(e.purchases || 0)]),
            more: Math.max(0, (rep.events || []).length - 12),
          });
          continue;
        }
        const metrics = [['App users', t.uniques || 0], ['Views', t.views || 0], ['Interactions', t.interactions || 0], ['CTA taps', t.ctaTaps || 0], ['Purchases', t.purchases || 0]];
        if (t.purchaseValue) metrics.push(['Purchase value', currency.format(t.purchaseValue, mailer.resolveBranding(entityId).currency)]);
        factsByIdx.push(metricsFact(label, 'app', metrics));
        resolved.push({ type: 'heading', text: `📱 ${label}`, level: 2 });
        for (const [k, v] of metrics) resolved.push({ type: 'tile', kind: 'kpi', title: k, value: typeof v === 'number' ? fmtNum(v) : String(v) });
        continue;
      }
      // Goals block: the entity's event goals with LIVE progress (same resolver
      // the Goals page + digests use — values computed, never invented), frozen
      // as a table. Feeds the AI scope with per-goal progress lines.
      if (b.type === 'goals') {
        let goals = [];
        try { goals = goalsFor ? await goalsFor(entityId, user) : []; }
        catch (e) { console.error('[reports] goals resolve failed', e.message); }
        if (!goals.length) { factsByIdx.push(null); resolved.push({ type: 'tile', kind: 'missing', title: 'Goals unavailable' }); continue; }
        const gf = (v) => (v == null ? '—' : (typeof v === 'number' ? fmtNum(v) : String(v)));
        const rows = goals.map((g) => {
          const pr = g.progress || {};
          return [
            `${g.isNorthStar ? '★ ' : ''}${g.name}${g.suiteName ? ` (${g.suiteName})` : ''}`,
            gf(pr.value),
            `${gf(g.targetValue)}${g.targetMax != null ? `–${gf(g.targetMax)}` : ''}${g.unit ? ` ${g.unit}` : ''}`,
            pr.pct != null ? `${pr.pct}%` : '—',
            String(pr.status || '—'),
          ];
        });
        factsByIdx.push(metricsFact('Event goals (progress already computed)', 'goals',
          goals.map((g) => { const pr = g.progress || {}; return [`${g.name}${g.suiteName ? ` [${g.suiteName}]` : ''}`, `${gf(pr.value)}/${gf(g.targetValue)}${pr.pct != null ? ` (${pr.pct}%)` : ''}${pr.status ? ` — pace ${pr.status}` : ''}`]; })));
        resolved.push({ type: 'tile', kind: 'table', title: '🎯 Goals', columns: ['Goal', 'Current', 'Target', 'Progress', 'Pace'], rows, more: 0 });
        continue;
      }
      // Social block: organic social performance (social-flag-gated). Three views:
      // connected accounts table, a daily metric trend chart, or top posts.
      if (b.type === 'social') {
        try {
          if (!social) throw new Error('social source not wired');
          const days = b.days || 28;
          if (b.socialView === 'trend') {
            const metric = b.socialMetric || 'reach';
            const series = social.series(entityId, { metric, days });
            if (!series || !series.length) throw new Error('no social series yet');
            const label = `Social ${metric} — last ${days} days`;
            const fact = {
              title: label, visType: 'looker_line', context: '',
              fields: { dimensions: [{ name: 'date', label: 'Day' }], measures: [{ name: 'value', label: metric[0].toUpperCase() + metric.slice(1) }] },
              rows: series.map((r) => ({ date: { value: r.date, rendered: r.date }, value: { value: r.value || 0, rendered: String(r.value || 0) } })),
              pivots: [],
            };
            factsByIdx.push(fact);
            const png = tileimg ? tileimg.renderTilePng({ title: label, vis: { type: 'looker_line' } }, fact, branding) : null;
            if (!png) throw new Error('not enough data to chart');
            resolved.push({ type: 'tile', kind: 'chart', title: label, assetToken: putAsset(snapshotId, 'image/png', png) });
          } else if (b.socialView === 'posts') {
            const posts = social.posts(entityId, { limit: 8 });
            if (!posts || !posts.length) throw new Error('no post metrics yet');
            factsByIdx.push(metricsFact('Top social posts', 'social', posts.map((pst) => [`${pst.platform}: ${String(pst.caption || pst.postId || '').slice(0, 60)}`, `${pst.reach || 0} reach / ${pst.likes || 0} likes / ${pst.engagement || 0} engagement`])));
            resolved.push({
              type: 'tile', kind: 'table', title: '🌐 Top social posts',
              columns: ['Platform', 'Post', 'Reach', 'Likes', 'Engagement'],
              rows: posts.map((pst) => [String(pst.platform || ''), String(pst.caption || pst.postId || '').slice(0, 60), fmtNum(pst.reach || 0), fmtNum(pst.likes || 0), fmtNum(pst.engagement || 0)]),
              more: 0,
            });
          } else {
            const accts = social.accounts(entityId);
            if (!accts || !accts.length) throw new Error('no social accounts connected');
            factsByIdx.push(metricsFact('Social accounts', 'social', accts.map((a) => [`${a.platform} @${a.username || a.name || ''}`, `${a.followers || 0} followers, ${a.postsCount || 0} posts`])));
            resolved.push({
              type: 'tile', kind: 'table', title: '🌐 Social accounts',
              columns: ['Platform', 'Account', 'Followers', 'Posts'],
              rows: accts.map((a) => [String(a.platform || ''), `@${a.username || a.name || ''}`, fmtNum(a.followers || 0), fmtNum(a.postsCount || 0)]),
              more: 0,
            });
          }
        } catch (e) {
          factsByIdx.push(null);
          resolved.push({ type: 'tile', kind: 'missing', title: `Social data unavailable (${e.message})` });
        }
        continue;
      }
      // Live block: the most recent Live Pulse update for one event — the same
      // multi-metric message the team received on event day, frozen verbatim.
      if (b.type === 'live') {
        let run = null;
        try { run = liveLatestFor ? liveLatestFor(entityId, b.suiteId) : null; }
        catch (e) { console.error('[reports] live resolve failed', e.message); }
        if (!run) { factsByIdx.push(null); resolved.push({ type: 'tile', kind: 'missing', title: 'No live updates for this event yet' }); continue; }
        const text = String(run.message || '').replace(/\*/g, '');
        factsByIdx.push(metricsFact(`Live update — ${run.pulseName || 'event day'} (${run.at})`, 'live', text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 20).map((l, li) => [`${li + 1}`, l])));
        resolved.push({ type: 'heading', text: `⚡ ${run.pulseName || 'Live update'}`, level: 2 });
        const when = (() => { try { return new Date(run.at).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' }); } catch { return run.at; } })();
        resolved.push({ type: 'text', text: `*As sent on ${when}:*\n\n${text}` });
        continue;
      }
      factsByIdx.push(null);
      if (b.type === 'image') {
        const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(b.url || '');
        if (m) {
          try { resolved.push({ type: 'image', assetToken: putAsset(snapshotId, m[1], Buffer.from(m[2], 'base64')), alt: b.alt }); continue; }
          catch (e) { console.error('[reports] image decode failed', e.message); }
        }
        if (/^https?:\/\//.test(b.url || '')) { resolved.push({ type: 'image', url: b.url, alt: b.alt }); }
        continue;
      }
      if (b.type === 'ai') {
        // Scope: 'report' = every tile fact; 'section' = tile facts since the last
        // heading ABOVE this block (headings delimit sections).
        let facts;
        let scopeLabel;
        if (b.scope === 'report') { facts = factsByIdx.filter(Boolean); scopeLabel = 'the whole report'; }
        else {
          facts = [];
          let heading = '';
          for (let j = tpl.blocks.indexOf(b) - 1; j >= 0; j--) {
            if (tpl.blocks[j].type === 'heading') { heading = tpl.blocks[j].text; break; }
            if (factsByIdx[j]) facts.unshift(factsByIdx[j]);
          }
          scopeLabel = heading ? `the "${heading}" section` : 'the tiles above';
        }
        if (!facts.length) { resolved.push({ type: 'ai', scope: b.scope, text: '', note: 'No tile data in scope for this analysis.' }); continue; }
        const apiKey = anthropicKeyForEntity(entityId);
        if (!insights.isConfigured(apiKey)) { resolved.push({ type: 'ai', scope: b.scope, text: '', note: 'AI is not configured for this client.' }); continue; }
        const instructions = [aiInstructionsFor(null, entityId), currency.aiNote(branding.currency)].filter(Boolean).join('\n\n');
        try {
          const text = await aiUsage.run({ entityId, kind: 'report' }, () => reportAnalysis({ scopeLabel, reportTitle: tpl.title, focus: b.focus, tiles: facts, instructions, apiKey }));
          resolved.push({ type: 'ai', scope: b.scope, text });
        } catch (e) {
          console.error('[reports] analysis failed', e.message);
          resolved.push({ type: 'ai', scope: b.scope, text: '', note: 'Analysis unavailable for this run.' });
        }
        continue;
      }
      // heading / text / button / divider pass through as authored.
      resolved.push({ type: b.type, text: b.text, level: b.level, href: b.href, alt: b.alt });
    }

    const content = { title: tpl.title || 'Report', generatedAt: now(), blocks: resolved };
    sql.prepare('INSERT INTO report_snapshots (id, template_id, entity_id, title, content, token, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(snapshotId, tpl.id, entityId, content.title, JSON.stringify(content), newToken(), byEmail || tpl.createdBy || '', now());
    return sql.prepare('SELECT * FROM report_snapshots WHERE id=?').get(snapshotId);
  }

  // ── email rendering (branded shell around the snapshot blocks) ──
  const kpiChipHtml = (b) => `<div style="display:inline-block;border:1px solid #e8e8ec;border-radius:12px;padding:12px 18px;margin:0 8px 8px 0;"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#86868b;">${esc(b.title)}</div><div style="font-size:22px;font-weight:800;color:#111;margin-top:2px;">${esc(b.value)}</div></div>`;
  const tableHtml = (b) => {
    const head = `<tr>${b.columns.map((c) => `<th style="text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#86868b;padding:6px 8px;border-bottom:1px solid #e8e8ec;">${esc(c)}</th>`).join('')}</tr>`;
    const rows = b.rows.map((r) => `<tr>${r.map((v) => `<td style="font-size:13px;color:#3a3a3c;padding:6px 8px;border-bottom:1px solid #f2f2f5;">${esc(v)}</td>`).join('')}</tr>`).join('');
    const more = b.more ? `<div style="font-size:11.5px;color:#86868b;margin-top:4px;">… ${b.more} more rows in the full report</div>` : '';
    return `<div>${b.title ? `<div style="font-size:13px;font-weight:700;color:#111;margin-bottom:6px;">${esc(b.title)}</div>` : ''}<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">${head}${rows}</table>${more}</div>`;
  };

  // Map resolved snapshot blocks onto emailBlocks' vocabulary (charts/images by
  // hosted URL; KPI chips + tables as prebuilt HTML), then render + wrap.
  function buildReportEmail(entityId, snap) {
    const branding = mailer.resolveBranding(entityId);
    const base = mailer.baseUrl();
    const content = JSON.parse(snap.content || '{}');
    const viewUrl = `${base}/r/${snap.token}`;
    const mapped = [];
    for (const b of content.blocks || []) {
      if (b.type === 'heading') mapped.push({ type: 'heading', text: b.text, level: b.level === 2 ? 3 : 2, align: 'left' });
      else if (b.type === 'text') mapped.push({ type: 'text', text: b.text, align: 'left' });
      else if (b.type === 'button') mapped.push({ type: 'button', text: b.text, href: b.href, align: 'left' });
      else if (b.type === 'divider') mapped.push({ type: 'divider' });
      else if (b.type === 'image') mapped.push({ type: 'image', url: b.assetToken ? `${base}/report-assets/${b.assetToken}` : b.url, alt: b.alt || '' });
      else if (b.type === 'ai' && b.text) mapped.push({ type: 'quote', text: b.text, align: 'left' });
      else if (b.type === 'tile') {
        if (b.kind === 'chart') mapped.push({ type: 'image', url: `${base}/report-assets/${b.assetToken}`, alt: b.title || '' });
        else if (b.kind === 'kpi') mapped.push({ type: 'html', html: kpiChipHtml(b) });
        else if (b.kind === 'table') mapped.push({ type: 'html', html: tableHtml(b) });
      }
    }
    mapped.push({ type: 'spacer', size: 'sm' }, { type: 'button', text: 'View the full report', href: viewUrl, align: 'center' });
    const { html: innerHtml, text: innerText } = emailBlocks.render(mapped, { brand: branding.brandColor });
    const dateLine = new Date(content.generatedAt || snap.created_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' });
    const logoSrc = branding.logo && branding.logo.startsWith('data:') ? `${base}/mail-assets/logo/${entityId}` : branding.logo;
    const brandMark = logoSrc ? `<img src="${esc(logoSrc)}" alt="${esc(branding.wordmark)}" style="max-height:40px;max-width:200px;display:block;" />`
      : `<div style="font-size:15px;font-weight:800;letter-spacing:-0.02em;color:#111;">${esc(branding.wordmark)}</div>`;
    const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;">${esc(content.title)} — ${esc(dateLine)}</div>
  <div style="max-width:600px;margin:0 auto;padding:28px 16px;">
    <div style="margin-bottom:14px;">${brandMark}</div>
    <div style="background:#ffffff;border:1px solid rgba(128,128,128,0.16);border-radius:14px;padding:26px;">
      <div style="font-size:22px;font-weight:800;letter-spacing:-0.01em;color:#111;">${esc(content.title)}</div>
      <div style="font-size:12.5px;color:#86868b;margin:4px 0 18px;">${esc(dateLine)}</div>
      ${innerHtml}
    </div>
    <div style="font-size:11.5px;color:#86868b;margin-top:14px;line-height:1.5;">Sent by ${esc(branding.senderName)} via Howler : Pulse</div>
  </div>
</body></html>`;
    return { subject: content.title, html, text: `${content.title} — ${dateLine}\n\n${innerText}\n\nView the full report: ${viewUrl}` };
  }

  // ── run a template: generate a snapshot + email the recipients ──
  async function runTemplate(tpl, { toOverride = '', byEmail = '' } = {}) {
    const snap = await generateSnapshot(tpl, { byEmail });
    const to = toOverride ? [toOverride] : (tpl.recipients || []).filter(Boolean);
    let ok = 0; let err = '';
    if (to.length) {
      const { subject, html, text } = buildReportEmail(tpl.entityId, snap);
      const senderName = mailer.resolveBranding(tpl.entityId).senderName;
      for (const rcpt of to) {
        const r = await mailer.send({ to: rcpt, subject, html, text, fromName: senderName, kind: 'report', entity: tpl.entityId });
        if (r.ok) ok += 1; else err = r.error || r.reason || 'email failed';
      }
      if (!toOverride) sql.prepare('UPDATE report_snapshots SET sent_to=? WHERE id=?').run(JSON.stringify(to), snap.id);
    }
    return { snapshot: snapMeta(sql.prepare('SELECT * FROM report_snapshots WHERE id=?').get(snap.id)), sent: ok, sendError: err };
  }

  // ── the tick (claim-first, mirrors server/scheduler.js) ──
  let ticking = false;
  async function tick() {
    if (!enabled()) return;
    if (ticking) return;
    ticking = true;
    try {
      const due = sql.prepare("SELECT * FROM report_templates WHERE status='active' AND next_run_at IS NOT NULL AND next_run_at <= ?").all(now());
      for (const r of due) {
        const tpl = rowToTpl(r);
        try {
          // CLAIM the slot before the run — a restart mid-run misses one run, never double-sends.
          const next = computeNextRun(tpl);
          sql.prepare('UPDATE report_templates SET next_run_at=?, last_status=?, updated_at=? WHERE id=?')
            .run(next ? next.toISOString() : null, `started: ${now()}`, now(), tpl.id);
          const res = await runTemplate(tpl);
          const status = res.sendError ? `error: ${res.sendError}` : `ok: sent to ${res.sent}`;
          sql.prepare('UPDATE report_templates SET last_run_at=?, last_status=?, updated_at=? WHERE id=?').run(now(), status.slice(0, 300), now(), tpl.id);
          if (res.sendError && notifyOps) { try { notifyOps(`Scheduled report failed — "${tpl.title}" for ${db.getEntity(tpl.entityId)?.name || tpl.entityId}: ${res.sendError}`); } catch { /* alerting must never break the tick */ } }
        } catch (e) {
          console.error('[reports] scheduled run failed', r.id, e.message);
          sql.prepare('UPDATE report_templates SET last_run_at=?, last_status=?, updated_at=? WHERE id=?').run(now(), `error: ${e.message}`.slice(0, 300), now(), r.id);
          if (notifyOps) { try { notifyOps(`Scheduled report failed — "${r.title}": ${e.message}`); } catch { /* best-effort */ } }
        }
      }
    } finally { ticking = false; }
  }
  const timer = setInterval(() => tick().catch(() => {}), 60000);
  if (timer.unref) timer.unref();
  setTimeout(() => tick().catch(() => {}), 12000); // shortly after boot, offset from the digest tick

  // ── routes ──
  const off = (res) => res.status(404).json({ error: 'Reports are disabled' });
  const listFor = (entityId, res) => res.json({ templates: sql.prepare('SELECT * FROM report_templates WHERE entity_id=? ORDER BY created_at DESC').all(entityId).map(rowToTpl) });
  const snapsFor = (tplId, res) => res.json({ snapshots: sql.prepare('SELECT * FROM report_snapshots WHERE template_id=? ORDER BY created_at DESC LIMIT 60').all(tplId).map(snapMeta) });
  const deleteSnapshot = (id) => { sql.prepare('DELETE FROM report_assets WHERE snapshot_id=?').run(id); sql.prepare('DELETE FROM report_snapshots WHERE id=?').run(id); };
  const deleteTemplate = (id) => { for (const s of sql.prepare('SELECT id FROM report_snapshots WHERE template_id=?').all(id)) deleteSnapshot(s.id); sql.prepare('DELETE FROM report_templates WHERE id=?').run(id); };

  // Admin — manage any client's reports.
  app.get('/api/admin/entities/:id/reports', auth.requireAdmin, (req, res) => enabled() ? listFor(req.params.id, res) : off(res));
  app.post('/api/admin/entities/:id/reports', auth.requireAdmin, (req, res) => enabled() ? res.status(201).json({ template: upsert(null, clean(req.body || {}, req.params.id), req.user.email) }) : off(res));
  app.put('/api/admin/reports/:tplId', auth.requireAdmin, (req, res) => { if (!enabled()) return off(res); const t = getTpl(req.params.tplId); if (!t) return res.status(404).json({ error: 'Not found' }); res.json({ template: upsert(t.id, clean(req.body || {}, t.entityId), t.createdBy) }); });
  app.delete('/api/admin/reports/:tplId', auth.requireAdmin, (req, res) => { if (!enabled()) return off(res); deleteTemplate(req.params.tplId); res.status(204).end(); });
  app.get('/api/admin/reports/:tplId/snapshots', auth.requireAdmin, (req, res) => enabled() ? snapsFor(req.params.tplId, res) : off(res));
  app.delete('/api/admin/report-snapshots/:id', auth.requireAdmin, (req, res) => { if (!enabled()) return off(res); deleteSnapshot(req.params.id); res.status(204).end(); });
  app.post('/api/admin/reports/:tplId/generate', auth.requireAdmin, asyncHandler(async (req, res) => {
    if (!enabled()) return off(res);
    const t = getTpl(req.params.tplId); if (!t) throw new HttpError(404, 'Not found');
    const snap = await generateSnapshot(t, { byEmail: req.user.email });
    res.status(201).json({ snapshot: snapMeta(snap) });
  }));
  app.post('/api/admin/reports/:tplId/send', auth.requireAdmin, asyncHandler(async (req, res) => {
    if (!enabled()) return off(res);
    const t = getTpl(req.params.tplId); if (!t) throw new HttpError(404, 'Not found');
    const r = await runTemplate(t, { toOverride: (req.body || {}).test ? req.user.email : '', byEmail: req.user.email });
    res.json(r);
  }));

  // Client self-service — own entity only, gated by the reports.manage permission.
  const ownsEntity = (req) => (req.user.entityIds || []).includes(req.params.entityId);
  const myGuard = (req, res) => { if (!enabled()) { off(res); return false; } if (!ownsEntity(req)) { res.status(403).json({ error: 'Not allowed' }); return false; } return true; };
  const myTpl = (req, res) => { const t = getTpl(req.params.tplId); if (!t || t.entityId !== req.params.entityId) { res.status(404).json({ error: 'Not found' }); return null; } return t; };
  const canManage = auth.requirePermission('reports.manage');
  app.get('/api/my/reports/:entityId', auth.requireAuth, canManage, (req, res) => { if (myGuard(req, res)) listFor(req.params.entityId, res); });
  app.post('/api/my/reports/:entityId', auth.requireAuth, canManage, (req, res) => { if (myGuard(req, res)) res.status(201).json({ template: upsert(null, clean(req.body || {}, req.params.entityId), req.user.email) }); });
  app.put('/api/my/reports/:entityId/:tplId', auth.requireAuth, canManage, (req, res) => { if (!myGuard(req, res)) return; const t = myTpl(req, res); if (t) res.json({ template: upsert(t.id, clean(req.body || {}, t.entityId), t.createdBy) }); });
  app.delete('/api/my/reports/:entityId/:tplId', auth.requireAuth, canManage, (req, res) => { if (!myGuard(req, res)) return; const t = myTpl(req, res); if (t) { deleteTemplate(t.id); res.status(204).end(); } });
  app.get('/api/my/reports/:entityId/:tplId/snapshots', auth.requireAuth, canManage, (req, res) => { if (!myGuard(req, res)) return; const t = myTpl(req, res); if (t) snapsFor(t.id, res); });
  app.delete('/api/my/reports/:entityId/snapshots/:id', auth.requireAuth, canManage, (req, res) => {
    if (!myGuard(req, res)) return;
    const s = sql.prepare('SELECT * FROM report_snapshots WHERE id=?').get(req.params.id);
    if (!s || s.entity_id !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    deleteSnapshot(s.id); res.status(204).end();
  });
  app.post('/api/my/reports/:entityId/:tplId/generate', auth.requireAuth, canManage, asyncHandler(async (req, res) => {
    if (!myGuard(req, res)) return;
    const t = myTpl(req, res); if (!t) return;
    const snap = await generateSnapshot(t, { byEmail: req.user.email });
    res.status(201).json({ snapshot: snapMeta(snap) });
  }));
  app.post('/api/my/reports/:entityId/:tplId/send', auth.requireAuth, canManage, asyncHandler(async (req, res) => {
    if (!myGuard(req, res)) return;
    const t = myTpl(req, res); if (!t) return;
    res.json(await runTemplate(t, { toOverride: (req.body || {}).test ? req.user.email : '', byEmail: req.user.email }));
  }));

  // Public (token = unguessable capability; revoke by deleting the snapshot).
  // Returns the frozen snapshot + NON-SECRET branding only — never live queries.
  const publicSnap = (token) => sql.prepare('SELECT * FROM report_snapshots WHERE token=?').get(String(token || '').slice(0, 60));
  app.get('/api/public/reports/:token', (req, res) => {
    if (!enabled()) return off(res);
    const s = publicSnap(req.params.token);
    if (!s) return res.status(404).json({ error: 'Report not found' });
    const b = mailer.resolveBranding(s.entity_id);
    res.json({
      ...JSON.parse(s.content || '{}'),
      branding: { name: b.wordmark, logo: b.logo || '', logoDark: b.logoDark || '', primary: b.brandColor, secondary: b.secondaryColor },
    });
  });
  app.get('/api/public/reports/:token/pdf', asyncHandler(async (req, res) => {
    if (!enabled()) return off(res);
    const s = publicSnap(req.params.token);
    if (!s) throw new HttpError(404, 'Report not found');
    const b = mailer.resolveBranding(s.entity_id);
    const pdf = await require('./reportPdf').renderPdf(JSON.parse(s.content || '{}'), { branding: b, getAsset });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${String(s.title || 'report').replace(/[^\w .-]+/g, '_').slice(0, 80)}.pdf"`);
    res.send(pdf);
  }));
  app.get('/report-assets/:token', (req, res) => {
    const a = getAsset(req.params.token);
    if (!a) return res.status(404).end();
    res.setHeader('Content-Type', a.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(a.bytes);
  });

  console.log('[reports] mounted', enabled() ? '(enabled)' : '(disabled — set reports_enabled=1)');
  return { _tick: tick, _generateSnapshot: generateSnapshot, _computeNextRun: computeNextRun, _cleanBlocks: cleanBlocks }; // _-prefixed: exposed for tests only
}

module.exports = { mount, REPORT_SYSTEM };
