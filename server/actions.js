// ─── Action Engine: suggested actions → executed automations ──────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the `actions` + `action_suppressions`
// tables and all /api/.../actions routes. Mounted from index.js with injected
// deps (db, auth, mailer, audience resolver, AI drafter). Kill switch:
// settings key `actions_enabled` ('0' disables).
//
// The lifecycle is the product: nothing executes without an explicit human
// APPROVE. v1 action type: `email_campaign` (e.g. abandoned-cart emails) —
// audience comes from a dashboard tile's query (already scoped + filtered) or
// pasted emails; copy is AI-drafted and editable; results track sends + clicks.
// Later types (meta_ads, google_ads, howler_writeback) plug into the same
// lifecycle.

const crypto = require('crypto');

// Contact-list parsing (pasted text / uploaded CSV / Google Sheet) lives in a shared
// module to keep this file under budget — see audienceParse.js.
const { parseContactLines, csvHeader, parseContactTable, fetchGoogleSheetCsv, googleSheetCsvUrl } = require('./audienceParse');

// Audience person-mapping (dedupe + per-channel consent + reach) lives in a shared
// module so chat-created "query" segments reuse the SAME logic — see audienceMap.js.
const { MAX_AUDIENCE, MAX_AUDIENCE_HARD, MAX_SMS_DEFAULT, clampSmsCap, EMAIL_RE, cellVal, isYes, buildRows, finalizeAudience } = require('./audienceMap');
// Block-builder email content (Mailchimp-style stacked blocks → email-safe HTML).
const emailBlocks = require('./emailBlocks');
const cleanBlocks = emailBlocks.cleanBlocks;
const emailTheme = require('./emailTheme'); // the campaign's visual "look" (Tier-1 design)
// House-style copy normalisation: strip em dashes from client-authored (and
// AI-drafted) campaign copy on save, so what sends reads professionally.
const { deEmDash } = require('./textStyle');

function mount(app, { db, auth, mailer, push, messaging, os, billing, resolveAudience, draftCopy, listEvents }) {
  const sql = db.db;
  const now = () => new Date().toISOString();
  const uuid = () => crypto.randomUUID();
  const enabled = () => db.getSetting('actions_enabled', '1') !== '0';
  // Per-client governance: when on, campaigns must be approved before sending.
  const requireApprovalFor = (entityId) => db.getSetting(`approval_required:${entityId}`, '0') === '1';
  // Per-client audience cap — the max recipients a single campaign can reach for
  // this client (default MAX_AUDIENCE; admin-set per client; hard-ceilinged).
  const capFor = (entityId) => { const v = parseInt(db.getSetting(`audience_cap:${entityId}`, ''), 10); return Number.isFinite(v) && v > 0 ? Math.min(v, MAX_AUDIENCE_HARD) : MAX_AUDIENCE; };
  // Per-client SMS sub-cap — a tighter ceiling on how many SMS one campaign can send,
  // so a large email cap can't trigger an equally-large (costly) SMS blast by accident.
  // Default MAX_SMS_DEFAULT; admin-set per client; 0 blocks SMS entirely; hard-ceilinged.
  const smsCapFor = (entityId) => clampSmsCap(db.getSetting(`sms_cap:${entityId}`, ''));
  const approverKey = (a) => (a.type === 'howler' ? 'howler' : `user:${a.userId}`);
  const approverLabel = (a) => (a.type === 'howler' ? 'Howler' : (a.name || a.email || 'Teammate'));
  // Approval progress for an action: each required approver + whether they've
  // signed off, and whether all are in.
  function approvalSummary(action) {
    const approvers = action.config.approvers || [];
    const done = new Map(sql.prepare('SELECT approver_key, by_email, at FROM action_approvals WHERE action_id=?').all(action.id).map((r) => [r.approver_key, r]));
    const list = approvers.map((a) => { const k = approverKey(a); const d = done.get(k); return { key: k, label: approverLabel(a), type: a.type, approved: !!d, by: d?.by_email || '', at: d?.at || '' }; });
    return { approvers: list, complete: list.length > 0 && list.every((x) => x.approved), pending: list.filter((x) => !x.approved).length };
  }

  sql.exec(`
    CREATE TABLE IF NOT EXISTS actions (
      id          TEXT PRIMARY KEY,
      entity_id   TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'email_campaign',
      status      TEXT NOT NULL DEFAULT 'draft',   -- draft | running | done | failed
      title       TEXT NOT NULL DEFAULT '',
      config      TEXT NOT NULL DEFAULT '{}',       -- audience + copy + cta + tokens
      audience    TEXT NOT NULL DEFAULT '[]',       -- snapshot at approve time [{email,name}]
      results     TEXT NOT NULL DEFAULT '{}',       -- { sent, failed, clicks, lastClickAt }
      created_by  TEXT NOT NULL DEFAULT '',
      approved_by TEXT NOT NULL DEFAULT '',
      approved_at TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_actions_entity ON actions(entity_id, created_at);

    CREATE TABLE IF NOT EXISTS action_suppressions (
      entity_id TEXT NOT NULL,
      email     TEXT NOT NULL,
      at        TEXT NOT NULL,
      reason    TEXT NOT NULL DEFAULT 'unsubscribed',
      PRIMARY KEY (entity_id, email)
    );

    -- One row per click event, attributed to the recipient when the link
    -- carried their signed token (forwarded links attribute to the original
    -- recipient — standard email-marketing behaviour).
    CREATE TABLE IF NOT EXISTS action_clicks (
      action_id TEXT NOT NULL,
      email     TEXT NOT NULL DEFAULT '',
      at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_action_clicks ON action_clicks(action_id, email);

    -- Email opens, captured by a 1x1 tracking pixel (one row per open event;
    -- unique openers = distinct emails). Email only; imperfect (image-blocking /
    -- Apple Mail Privacy Protection) but the standard open-rate signal.
    CREATE TABLE IF NOT EXISTS action_opens (
      action_id TEXT NOT NULL,
      email     TEXT NOT NULL DEFAULT '',
      at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_action_opens ON action_opens(action_id, email);

    -- Short links for SMS: map a long tracked /c/ or /u/ URL (signed token, ~80
    -- chars — would blow an SMS segment) to a tiny /k/<code> redirect. Code is
    -- derived from the target, so identical links (re-sends) reuse one row.
    CREATE TABLE IF NOT EXISTS action_short_links (
      code   TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      at     TEXT NOT NULL
    );

    -- Memory for recurring automations: who a campaign family has already
    -- emailed, so the daily check only queues NEW people.
    CREATE TABLE IF NOT EXISTS action_sent (
      root_id TEXT NOT NULL,
      email   TEXT NOT NULL,
      at      TEXT NOT NULL,
      PRIMARY KEY (root_id, email)
    );

    -- Per-recipient ledger for one campaign run (crash-safe sends): a row lands at
    -- delivery; resume skips anyone ledgered — a mid-blast deploy never re-emails.
    CREATE TABLE IF NOT EXISTS action_sends (
      action_id TEXT NOT NULL,
      recipient TEXT NOT NULL,  -- email (email channel) or phone (sms channel)
      channel   TEXT NOT NULL,  -- email | sms
      at        TEXT NOT NULL,
      PRIMARY KEY (action_id, recipient, channel)
    );

    -- Drip sequences: one row per enrolled recipient, tracking where they are in
    -- the sequence and when the next step is due. They drop out (status flips)
    -- the moment they buy (re-checked against the abandoned audience each step).
    CREATE TABLE IF NOT EXISTS action_enrollments (
      action_id   TEXT NOT NULL,
      email       TEXT NOT NULL,
      name        TEXT NOT NULL DEFAULT '',
      ticket      TEXT NOT NULL DEFAULT '',
      anchor_at   TEXT NOT NULL,                 -- abandonment time (or detection time)
      step_index  INTEGER NOT NULL DEFAULT 0,    -- next step to send (0-based)
      next_at     TEXT NOT NULL,                 -- when that step is due
      status      TEXT NOT NULL DEFAULT 'active',-- active | converted | done | unsubscribed
      enrolled_at TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      PRIMARY KEY (action_id, email)
    );
    CREATE INDEX IF NOT EXISTS idx_enroll_due ON action_enrollments(status, next_at);

    -- Uploaded promo/discount codes for unique-code campaigns. One code is
    -- claimed per customer (email) and kept for their whole journey.
    CREATE TABLE IF NOT EXISTS action_promo_codes (
      action_id   TEXT NOT NULL,
      code        TEXT NOT NULL,
      email       TEXT NOT NULL DEFAULT '',   -- '' = available; else assigned recipient
      assigned_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (action_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_promo_avail ON action_promo_codes(action_id, email);

    -- Master campaigns: a first-class record per (entity, name) holding metadata
    -- (a target to track against). Segment campaigns link by config.master = name.
    -- Per-recipient approvals for a campaign awaiting sign-off (status 'pending').
    -- approver_key = 'user:<id>' (a named person) or 'howler' (any Howler admin).
    CREATE TABLE IF NOT EXISTS action_approvals (
      action_id    TEXT NOT NULL,
      approver_key TEXT NOT NULL,
      by_email     TEXT NOT NULL DEFAULT '',
      at           TEXT NOT NULL,
      PRIMARY KEY (action_id, approver_key)
    );

    CREATE TABLE IF NOT EXISTS campaign_masters (
      entity_id  TEXT NOT NULL,
      name       TEXT NOT NULL,
      target     INTEGER NOT NULL DEFAULT 0,  -- goal (e.g. conversions); 0 = none
      created_at TEXT NOT NULL,
      PRIMARY KEY (entity_id, name)
    );
  `);
  // Recurring-automation columns (ALTER for existing DBs).
  try {
    const cols = sql.prepare('PRAGMA table_info(actions)').all().map((c) => c.name);
    if (!cols.includes('recurring')) sql.exec('ALTER TABLE actions ADD COLUMN recurring INTEGER NOT NULL DEFAULT 0');
    if (!cols.includes('parent_id')) sql.exec("ALTER TABLE actions ADD COLUMN parent_id TEXT NOT NULL DEFAULT ''");
    if (!cols.includes('last_check')) sql.exec("ALTER TABLE actions ADD COLUMN last_check TEXT NOT NULL DEFAULT ''");
    if (!cols.includes('created_via')) sql.exec("ALTER TABLE actions ADD COLUMN created_via TEXT NOT NULL DEFAULT ''"); // provenance: owl | whatsapp | claude | chatgpt | api
    // Approval outcome the creator hasn't seen yet — drives a guaranteed in-app
    // banner (existing rows default to seen so no historical banners appear).
    if (!cols.includes('outcome')) sql.exec("ALTER TABLE actions ADD COLUMN outcome TEXT NOT NULL DEFAULT ''");          // '' | approved | rejected
    if (!cols.includes('outcome_by')) sql.exec("ALTER TABLE actions ADD COLUMN outcome_by TEXT NOT NULL DEFAULT ''");
    if (!cols.includes('outcome_note')) sql.exec("ALTER TABLE actions ADD COLUMN outcome_note TEXT NOT NULL DEFAULT ''");
    if (!cols.includes('outcome_at')) sql.exec("ALTER TABLE actions ADD COLUMN outcome_at TEXT NOT NULL DEFAULT ''");
    if (!cols.includes('outcome_seen')) sql.exec('ALTER TABLE actions ADD COLUMN outcome_seen INTEGER NOT NULL DEFAULT 1');
    const ecols = sql.prepare('PRAGMA table_info(action_enrollments)').all().map((c) => c.name);
    if (!ecols.includes('phone')) sql.exec("ALTER TABLE action_enrollments ADD COLUMN phone TEXT NOT NULL DEFAULT ''"); // for SMS sequences
    const ccols = sql.prepare('PRAGMA table_info(action_clicks)').all().map((c) => c.name);
    if (!ccols.includes('channel')) sql.exec("ALTER TABLE action_clicks ADD COLUMN channel TEXT NOT NULL DEFAULT ''"); // email | sms | '' (legacy)
    // Drip step index the open/click belongs to (-1 = once-off/legacy/unknown).
    if (!ccols.includes('step')) sql.exec('ALTER TABLE action_clicks ADD COLUMN step INTEGER NOT NULL DEFAULT -1');
    const ocols = sql.prepare('PRAGMA table_info(action_opens)').all().map((c) => c.name);
    if (!ocols.includes('step')) sql.exec('ALTER TABLE action_opens ADD COLUMN step INTEGER NOT NULL DEFAULT -1');
    // Point lookup for the public open/click routes (actionTracking.js). A blast
    // to N recipients produces a burst of N+ pixel/click hits within minutes —
    // without this expression index each hit is a full-table scan.
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_actions_click_token ON actions(json_extract(config,'$.clickToken'))`);
  } catch (e) { console.error('[actions] migration skipped:', e.message); }

  // ── helpers ──
  // The audience snapshot can be tens of MB of JSON (50k recipients). Most
  // readers (list, tracking, approvals, conversion sweeps) never need it, so it
  // parses LAZILY on first access — and non-enumerable, so `{ ...action }`
  // spreads and res.json never drag it along. Rows selected WITHOUT the
  // audience column (the list route) fetch it on demand.
  const rowToAction = (r) => {
    const a = {
      id: r.id, entityId: r.entity_id, type: r.type, status: r.status, title: r.title,
      config: JSON.parse(r.config || '{}'),
      results: JSON.parse(r.results || '{}'),
      audienceCount: r.audience_count ?? undefined, // present when read without the blob
      recurring: !!r.recurring, parentId: r.parent_id || '', lastCheck: r.last_check || '',
      createdBy: r.created_by, createdVia: r.created_via || '', approvedBy: r.approved_by, approvedAt: r.approved_at,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
    let aud = null;
    Object.defineProperty(a, 'audience', {
      enumerable: false, configurable: true,
      get() { if (!aud) aud = JSON.parse(r.audience ?? sql.prepare('SELECT audience FROM actions WHERE id=?').get(a.id)?.audience ?? '[]'); return aud; },
      set(v) { aud = v; },
    });
    return a;
  };
  const getAction = (id) => { const r = sql.prepare('SELECT * FROM actions WHERE id=?').get(id); return r ? rowToAction(r) : null; };
  // Public list shape: omit the full audience (can be thousands of emails).
  const publicAction = (a) => ({
    ...a, audience: undefined, audienceCount: a.audienceCount ?? a.audience.length,
    promoCodes: (a.config?.promo || {}).source === 'unique' ? promoStats(a.id) : null,
    approval: (a.config?.approvers || []).length ? approvalSummary(a) : null,
  });
  // List reads select everything EXCEPT the audience blob (the count comes from
  // json_array_length — C-side, no JS parse of a multi-MB string per row).
  const LIST_COLS = 'id, entity_id, type, status, title, config, results, recurring, parent_id, last_check, created_by, created_via, approved_by, approved_at, created_at, updated_at, json_array_length(audience) AS audience_count';
  const saveResults = (id, results) => sql.prepare('UPDATE actions SET results=?, updated_at=? WHERE id=?').run(JSON.stringify(results), now(), id);
  const setStatus = (id, status) => sql.prepare('UPDATE actions SET status=?, updated_at=? WHERE id=?').run(status, now(), id);

  // `action_clicks` is the source of truth; `results.{clicks,emailClicks,smsClicks}`
  // are a cache the `/c/` route bumps for instant feedback, reconciled here from the
  // table (they drift on partial writes). `byChannel` lets a caller pass a precomputed
  // GROUP BY. The TOTAL counter only heals UPWARD (legacy untagged clicks predate
  // per-recipient rows); per-channel counts mirror the table.
  function reconcileClicks(action, byChannel) {
    const rows = byChannel || sql.prepare('SELECT channel, COUNT(*) n FROM action_clicks WHERE action_id=? GROUP BY channel').all(action.id);
    let total = 0, email = 0, sms = 0;
    for (const r of rows) { total += r.n; if (r.channel === 'email') email += r.n; else if (r.channel === 'sms') sms += r.n; }
    const res = action.results || {};
    const clicks = Math.max(res.clicks || 0, total);
    if ((res.clicks || 0) !== clicks || (res.emailClicks || 0) !== email || (res.smsClicks || 0) !== sms) {
      const next = { ...res, clicks, emailClicks: email, smsClicks: sms };
      try { saveResults(action.id, next); } catch { /* read-path heal; ignore write hiccup */ }
      action.results = next;
    }
    return action;
  }

  const suppressed = (entityId) => new Set(sql.prepare('SELECT email FROM action_suppressions WHERE entity_id=?').all(entityId).map((r) => r.email));
  // Resolver for `query`-source segments (cohorts the Owl builds in chat) — scoped
  // people-query over the curated catalogue. Shares audienceMap shaping; we apply our
  // own suppression below, exactly like the tile/paste paths.
  const { resolveQueryAudience } = require('./audienceQuery')({ auth, db });
  const unsubSecret = () => {
    let s = db.getSetting('unsub_secret', '');
    if (!s) { s = crypto.randomBytes(18).toString('base64url'); db.setSetting('unsub_secret', s); }
    return s;
  };
  const unsubToken = (entityId, email) => {
    const payload = Buffer.from(JSON.stringify({ e: email, n: entityId })).toString('base64url');
    const sig = crypto.createHmac('sha256', unsubSecret()).update(payload).digest('base64url').slice(0, 16);
    return `${payload}.${sig}`;
  };
  // Store a URL → a tiny deterministic HMAC code (identical URLs collapse to one
  // row). Powers the SMS /k/<code> short links and per-link /c/?k=<code> tracking
  // of custom HTML. Returns '' if the store is unavailable (callers keep raw URL).
  const registerTarget = (url) => {
    if (!url) return '';
    try {
      const code = crypto.createHmac('sha256', unsubSecret()).update(url).digest('base64url').slice(0, 8);
      sql.prepare('INSERT OR IGNORE INTO action_short_links (code, target, at) VALUES (?,?,?)').run(code, url, now());
      return code;
    } catch { return ''; }
  };
  // Shorten a long absolute URL to a /k/<code> redirect so SMS stays in one segment.
  const shortLink = (targetUrl) => {
    if (!targetUrl) return targetUrl;
    const code = registerTarget(targetUrl);
    return code ? `${mailer.baseUrl()}/k/${code}` : targetUrl;
  };
  const parseUnsubToken = (token) => {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig) return null;
    const want = crypto.createHmac('sha256', unsubSecret()).update(payload).digest('base64url').slice(0, 16);
    if (sig !== want) return null;
    try { const j = JSON.parse(Buffer.from(payload, 'base64url').toString()); return j.e && j.n ? j : null; } catch { return null; }
  };

  // Sanitise an audience config (one source). At depth 0 it also carries a
  // multi-source `sources`/`combine` (each block shaped recursively, one level deep).
  function shapeAudience(aud = {}, depth = 0) {
    const out = {
      mode: ['paste', 'gsheet', 'snapshot', 'segment', 'query'].includes(aud.mode) ? aud.mode : 'tile',
      gsheetUrl: String(aud.gsheetUrl || '').slice(0, 1000), // when mode = 'gsheet' (linked Google Sheet, read live)
      segmentId: String(aud.segmentId || ''), // when mode = 'segment' (reference, resolved live)
      // when mode = 'query' (an Owl-built cohort) — curated explore + dim filters, resolved by audienceFor's query branch (identity columns fixed server-side).
      model: String(aud.model || ''),
      view: String(aud.view || ''),
      suiteId: String(aud.suiteId || '').slice(0, 64), // event scope carried on the audience (honoured by audienceFor)
      queryFilters: (aud.queryFilters && typeof aud.queryFilters === 'object' && !Array.isArray(aud.queryFilters))
        ? Object.fromEntries(Object.entries(aud.queryFilters).slice(0, 50).map(([k, v]) => [String(k), String(v)]))
        : {},
      phoneField: String(aud.phoneField || ''), // mobile column (for SMS)
      dashboardId: String(aud.dashboardId || ''),
      tileId: String(aud.tileId || ''),
      emailField: String(aud.emailField || ''),
      nameField: String(aud.nameField || ''),
      consentField: String(aud.consentField || ''), // legacy single consent (→ email)
      emailConsentField: String(aud.emailConsentField || ''), // per-channel marketing consent columns
      smsConsentField: String(aud.smsConsentField || ''),
      ticketField: String(aud.ticketField || ''),
      anchorField: String(aud.anchorField || ''), // abandonment timestamp column (drip timing)
      // Optional second source of customer attributes (lifetime spend, loyalty
      // tier…), joined to the audience by email — its columns become filterable.
      attrDashboardId: String(aud.attrDashboardId || ''),
      attrTileId: String(aud.attrTileId || ''),
      attrEmailField: String(aud.attrEmailField || ''),
      // Dashboard (Looker) filters captured from a "segment from tile" flow,
      // keyed by query field — applied at resolution (server drops ANY_VALUE).
      lookerFilters: (aud.lookerFilters && typeof aud.lookerFilters === 'object' && !Array.isArray(aud.lookerFilters))
        ? Object.fromEntries(Object.entries(aud.lookerFilters).slice(0, 50).map(([k, v]) => [String(k), String(v)]))
        : {},
      // Optional targeting filters on the tile's own columns (city, age,
      // ticket category, new/returning…). op 'in' = value ∈ values;
      // 'between' = min ≤ numeric ≤ max. All filters AND together.
      filters: Array.isArray(aud.filters) ? aud.filters.slice(0, 8).map((fl) => ({
        field: String(fl.field || ''),
        op: fl.op === 'between' ? 'between' : 'in',
        values: Array.isArray(fl.values) ? fl.values.map((v) => String(v)).slice(0, 100) : [],
        min: (fl.min === '' || fl.min == null) ? null : Number(fl.min),
        max: (fl.max === '' || fl.max == null) ? null : Number(fl.max),
      })).filter((fl) => fl.field) : [],
      pasted: String(aud.pasted || '').slice(0, 200000),
    };
    // Multi-source: combine several blocks (Union / Intersect / Exclude).
    if (depth === 0 && Array.isArray(aud.sources) && aud.sources.length) {
      out.sources = aud.sources.slice(0, 10).map((b) => shapeAudience(b, 1));
      out.combine = ['union', 'intersect', 'exclude'].includes(aud.combine) ? aud.combine : 'union';
    }
    return out;
  }

  // Sanitise a draft config from the client.
  function cleanConfig(body) {
    const aud = body.audience || {};
    return {
      // Delivery channel: 'email', 'sms' (Clickatell), or 'both' — when both,
      // each recipient gets an email (if they have an address) and an SMS (if
      // they have a number).
      channel: ['sms', 'both'].includes(body.channel) ? body.channel : 'email',
      audience: shapeAudience(aud),
      // Delivery mode: 'once' = single send to the current list; 'sequence' = an
      // automated drip (enroll abandoners, send timed steps, drop on purchase).
      campaignMode: body.campaignMode === 'sequence' ? 'sequence' : 'once',
      // Drip timing: 'abandonment' = anchor each person on their abandonment time
      // and only enrol FRESH ones (within freshHours); 'send' = run forward from
      // enrolment for the whole list; '' = legacy (anchor if mapped, enrol all).
      dripStart: ['abandonment', 'send'].includes(body.dripStart) ? body.dripStart : '',
      freshHours: Math.min(8760, Math.max(1, Number(body.freshHours) || 48)),
      // Transactional/operational override: bypass marketing-consent gating (for
      // genuinely non-marketing messages — event info, settlement notices).
      ignoreConsent: !!body.ignoreConsent,
      // Sequence steps: each { delayHours, subject, body, ctaText }. delayHours is
      // measured from the anchor (abandonment) time. Capped + sorted on save.
      steps: Array.isArray(body.steps) ? body.steps.slice(0, 12).map((s) => ({
        delayHours: Math.max(0, Number(s.delayHours) || 0),
        subject: deEmDash(String(s.subject || '').slice(0, 200)),
        body: deEmDash(String(s.body || '').slice(0, 8000)),
        smsBody: deEmDash(String(s.smsBody || '').slice(0, 2000)), // separate SMS copy per step when channel = 'both'
        ctaText: deEmDash(String(s.ctaText || '').slice(0, 60)),
        // Per-step content parity with once-off: template / custom HTML / block builder.
        contentMode: ['html', 'blocks'].includes(s.contentMode) ? s.contentMode : 'template',
        customHtml: String(s.customHtml || '').slice(0, 100000),
        blocks: cleanBlocks(s.blocks),
        heroImage: String(s.heroImage || '').slice(0, 1500000),
      })).sort((a, b) => a.delayHours - b.delayHours) : [],
      // Promo / discount codes. type 'promo' attaches to the ticket (can append
      // to the buy link); type 'discount' is entered at checkout (never appended,
      // shown as "enter this code"). source 'unique' draws from an uploaded pool
      // (one code per customer); 'generic' is one code for all.
      promo: {
        source: ['generic', 'unique'].includes((body.promo || {}).source) ? body.promo.source : 'none',
        type: (body.promo || {}).type === 'discount' ? 'discount' : 'promo',
        code: String((body.promo || {}).code || '').slice(0, 80),
        benefit: String((body.promo || {}).benefit || '').slice(0, 140),
        appendToLink: (body.promo || {}).type === 'discount' ? false : ((body.promo || {}).appendToLink !== false),
      },
      contentMode: ['html', 'blocks'].includes(body.contentMode) ? body.contentMode : 'template',
      blocks: cleanBlocks(body.blocks),   // block-builder content (contentMode 'blocks')
      theme: emailTheme.clean(body.theme), // the builder email's visual look (Tier-1 design)
      eventSuiteId: String(body.eventSuiteId || ''),
      // AI copy language for THIS campaign: overrides the client default when set
      // (so a multi-language client can draft one audience in French, another in
      // English). Blank = inherit the client's default language. Steers the AI
      // draft only; the saved copy is what sends.
      language: String(body.language || '').slice(0, 5).toLowerCase(),
      heroImage: String(body.heroImage || '').slice(0, 2000000),  // hero image data-URL/URL
      customHtml: String(body.customHtml || '').slice(0, 500000), // custom-HTML mode body
      subject: deEmDash(String(body.subject || '').slice(0, 200)),
      body: deEmDash(String(body.body || '').slice(0, 8000)),
      smsBody: deEmDash(String(body.smsBody || '').slice(0, 2000)), // separate SMS copy when channel = 'both'
      ctaText: deEmDash(String(body.ctaText || '').slice(0, 60)),
      ctaUrl: String(body.ctaUrl || '').slice(0, 500),
      utm: {
        source: String(body.utm?.source || '').slice(0, 100),
        medium: String(body.utm?.medium || '').slice(0, 100),
        campaign: String(body.utm?.campaign || '').slice(0, 150),
        term: String(body.utm?.term || '').slice(0, 100),
        content: String(body.utm?.content || '').slice(0, 100),
      },
      goal: String(body.goal || '').slice(0, 1000),
      // Required approvers (when sent for approval). Each is a named user
      // {type:'user',userId,email,name} or {type:'howler'} (any Howler admin).
      approvers: Array.isArray(body.approvers) ? body.approvers.slice(0, 10).map((a) => (
        a && a.type === 'howler' ? { type: 'howler' } : { type: 'user', userId: String(a.userId || ''), email: String(a.email || ''), name: String(a.name || '') }
      )).filter((a) => a.type === 'howler' || a.userId) : [],
      // Master campaign: a shared group name linking related segment campaigns
      // (e.g. one master "Bushfire abandoned cart" over VIP / GA / Cape Town
      // segments) so they manage + report together.
      master: String(body.master || '').slice(0, 80),
      // Which template (recipe) this campaign came from — labels it and groups
      // it (e.g. 'Abandoned carts'), and helps the automation later.
      templateKey: String(body.templateKey || '').slice(0, 60),
      category: String(body.category || '').slice(0, 80),
      // Conversion tracking. 'dropout' = left the audience/abandoned list (original);
      // 'list' = present in a SEPARATE source (attendance/completed-orders), matched by
      // email — confirm conversions against real sales instead of inferring from removal.
      conversion: {
        mode: (body.conversion || {}).mode === 'list' ? 'list' : 'dropout',
        source: shapeAudience((body.conversion || {}).source || {}),
      },
      clickToken: body.clickToken || crypto.randomBytes(6).toString('base64url'),
      source: String(body.source || '').slice(0, 40), // where it was drafted (e.g. 'owl-whatsapp')
    };
  }

  // Resolve the audience for a config: tile query (scoped) or pasted emails,
  // minus this client's suppression list. Returns { list, fields?, excluded }.
  // cellVal / isYes / buildRows / finalizeAudience come from ./audienceMap (shared).

  // Distinct values of an attribute across parsed members (capped) — powers the
  // "is one of" multi-select for pasted/Sheet lists without a tile to query.
  function distinctValues(members, name) {
    const set = new Set();
    for (const m of members) {
      const v = (m.attributes && m.attributes[name] != null) ? String(m.attributes[name]).trim() : '';
      if (v) set.add(v);
      if (set.size >= 200) break;
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  // Does a tile row pass all the targeting filters? (AND across filters.)
  function rowPassesFilters(row, filters) {
    for (const fl of filters || []) {
      const cell = cellVal(row[fl.field]);
      if (fl.op === 'between') {
        const n = Number(String(cell).replace(/[^0-9.-]/g, ''));
        if (!Number.isFinite(n)) return false;
        if (fl.min != null && n < fl.min) return false;
        if (fl.max != null && n > fl.max) return false;
      } else { // 'in'
        if (!fl.values.length) continue; // empty = no constraint
        const v = cell.toLowerCase();
        if (!fl.values.some((x) => String(x).trim().toLowerCase() === v)) return false;
      }
    }
    return true;
  }

  // Read a saved segment (owned by segments.js, same SQLite DB). Guarded so the
  // campaign engine still works if the segments module is absent.
  function segmentRow(entityId, segmentId) {
    if (!segmentId) return null;
    try { return sql.prepare('SELECT name, definition FROM segments WHERE id=? AND entity_id=?').get(segmentId, entityId) || null; }
    catch { return null; }
  }
  const segmentDefinition = (entityId, segmentId) => { const r = segmentRow(entityId, segmentId); return r ? JSON.parse(r.definition || '{}') : null; };
  const segmentName = (entityId, segmentId) => segmentRow(entityId, segmentId)?.name || '';

  // Channel-aware content validation. SMS has no subject; email/both need one.
  // For 'both', the SMS uses smsBody (falls back to body), so body+subject suffice.
  function contentError(cfg) {
    const needsSubject = cfg.channel !== 'sms';
    // Custom-HTML emails keep content in customHtml, not body — count either as "a message".
    const emailContent = (c) => (c?.contentMode === 'html' ? (c?.customHtml || '').trim() : c?.contentMode === 'blocks' ? ((c?.blocks || []).length ? 'blocks' : '') : (c?.body || '').trim());
    if (cfg.campaignMode === 'sequence') {
      const s0 = (cfg.steps || [])[0];
      if (!s0 || !emailContent(s0)) return 'Add at least one step with a message';
      if (needsSubject && !s0.subject) return 'Add a subject to step 1';
      return null;
    }
    if (cfg.channel === 'sms') return cfg.body ? null : 'A message is required'; // SMS-only edits body directly
    if (!emailContent(cfg)) return 'A message is required';
    if (needsSubject && !cfg.subject) return 'A subject is required';
    // 'both': SMS uses smsBody (falls back to body) — require one.
    if (cfg.channel === 'both' && !((cfg.smsBody || '').trim() || (cfg.body || '').trim())) return 'An SMS message is required';
    return null;
  }

  // Combine several source blocks into one audience (Union / Intersect / Exclude).
  // Each block is resolved with its OWN filters via audienceFor; we then merge by
  // identity (email, else phone). Exclude = first block MINUS the rest.
  async function combineSources(entityId, cfg, user, depth) {
    const combine = ['union', 'intersect', 'exclude'].includes(cfg.audience.combine) ? cfg.audience.combine : 'union';
    const blocks = (cfg.audience.sources || []).slice(0, 10);
    const keyOf = (m) => String(m.email || m.phone || '').toLowerCase();
    const subs = [];
    const lists = [];
    for (const b of blocks) {
      const sub = await audienceFor(entityId, { ...cfg, audience: b }, user, depth + 1);
      subs.push(sub);
      lists.push(sub.list || []);
    }
    const out = new Map();
    if (combine === 'intersect') {
      const [first = [], ...rest] = lists;
      const sets = rest.map((l) => new Set(l.map(keyOf)));
      for (const m of first) { const k = keyOf(m); if (k && sets.every((s) => s.has(k)) && !out.has(k)) out.set(k, m); }
    } else if (combine === 'exclude') {
      const [first = [], ...rest] = lists;
      const bad = new Set(rest.flatMap((l) => l.map(keyOf)));
      for (const m of first) { const k = keyOf(m); if (k && !bad.has(k) && !out.has(k)) out.set(k, m); }
    } else { // union
      for (const l of lists) for (const m of l) { const k = keyOf(m); if (k && !out.has(k)) out.set(k, m); }
    }
    const list = [...out.values()].slice(0, capFor(entityId));
    const reach = { total: list.length, email: list.filter((r) => r.email && r.emailOk).length, sms: list.filter((r) => r.phone && r.smsOk).length };
    const noConsent = list.filter((r) => !(r.email && r.emailOk) && !(r.phone && r.smsOk)).length;
    // Surface the PRIMARY block's fields/columns so the editor keeps the primary
    // source's column-match + targeting filters even once combine blocks are added.
    const p = subs[0] || {};
    return { list, fields: p.fields || [], filterFields: p.filterFields || [], columns: p.columns || [], excluded: 0, noConsent, filteredOut: 0, reach, combined: combine };
  }

  async function audienceFor(entityId, cfg, user, depth = 0) {
    if (depth > 5) return { list: [], fields: [], filterFields: [], excluded: 0, noConsent: 0, filteredOut: 0 }; // cycle guard
    // A segment-backed audience resolves the referenced segment's LIVE definition
    // each time (segments are always-current; reference, not copy).
    if (cfg.audience && cfg.audience.mode === 'segment') {
      const def = segmentDefinition(entityId, cfg.audience.segmentId);
      if (!def) return { list: [], fields: [], filterFields: [], excluded: 0, noConsent: 0, filteredOut: 0, segmentMissing: true };
      cfg = { ...cfg, audience: def };
    }
    // Multi-source: combine several blocks (Union / Intersect / Exclude).
    if (cfg.audience && Array.isArray(cfg.audience.sources) && cfg.audience.sources.length) {
      return combineSources(entityId, cfg, user, depth);
    }
    // Event scope: a segment's OWN event (`audience.suiteId`, baked in at create) beats the
    // campaign's — a scoped segment never widens. Falls back to the campaign's event (query + tile).
    const scopeSuite = (cfg.audience && cfg.audience.suiteId) || cfg.eventSuiteId || '';
    if (cfg.audience && cfg.audience.mode === 'query') {
      const { raw } = await resolveQueryAudience({ entityId, definition: cfg.audience, user, suiteId: scopeSuite, limit: capFor(entityId) * 2 });
      const { list, excluded, noConsent, reach } = finalizeAudience(raw, suppressed(entityId), capFor(entityId));
      return { list, fields: [], filterFields: [], columns: [], excluded, noConsent, filteredOut: 0, reach };
    }
    let raw = [];
    let fields = [];
    let filterFields = [];
    let columns = []; // header columns of a delimited list (paste/gsheet) — for column-mapping
    let filteredOut = 0;
    if (cfg.audience.mode === 'paste' || cfg.audience.mode === 'gsheet') {
      // Pasted text / uploaded CSV-Excel (parsed to text client-side), or a linked
      // Google Sheet fetched LIVE each resolve so the segment tracks the sheet.
      const text = cfg.audience.mode === 'gsheet'
        ? await fetchGoogleSheetCsv(cfg.audience.gsheetUrl)
        : (cfg.audience.pasted || '');
      columns = csvHeader(text);
      // Explicit column mapping when given; else the per-line heuristic (no attrs).
      let parsed = parseContactTable(text, cfg.audience) || parseContactLines(text);
      // Offer EVERY column as a filterable field (with its distinct values) so the
      // list can be targeted on ticket type / city / age / gender etc.
      if (columns.length && parsed.some((m) => m.attributes)) {
        filterFields = columns.map((name) => ({ name, label: name, values: distinctValues(parsed, name) }));
      }
      // Apply targeting filters on the row attributes (AND across filters).
      const fl = cfg.audience.filters || [];
      if (fl.length) {
        const before = parsed.length;
        parsed = parsed.filter((m) => rowPassesFilters(m.attributes || {}, fl));
        filteredOut = before - parsed.length;
      }
      raw = parsed;
    } else {
      if (!cfg.audience.dashboardId || !cfg.audience.tileId) return { list: [], fields: [], filterFields: [], excluded: 0, noConsent: 0, filteredOut: 0 };
      // `lookerFilters` are the dashboard filters captured when a segment was made
      // from a tile — applied at query time so the segment resolves that cohort.
      const res = await resolveAudience({ entityId, dashboardId: cfg.audience.dashboardId, tileId: cfg.audience.tileId, user, filterOverrides: cfg.audience.lookerFilters || {}, suiteId: scopeSuite, limit: capFor(entityId) * 2 });
      fields = res.fields;
      const emailField = cfg.audience.emailField || res.fields.find((f) => /email/i.test(f.name) || /email/i.test(f.label))?.name || '';
      const nameField = cfg.audience.nameField || '';
      // Per-channel marketing consent. Explicit columns only (no silent
      // auto-detect) so existing campaigns don't change behaviour; legacy single
      // consentField maps to email. ignoreConsent (transactional) bypasses both.
      const emailConsentField = cfg.audience.emailConsentField || cfg.audience.consentField || '';
      const smsConsentField = cfg.audience.smsConsentField || '';
      const ignoreConsent = !!cfg.ignoreConsent;
      const ticketField = cfg.audience.ticketField || '';
      const anchorField = cfg.audience.anchorField || '';
      const phoneField = cfg.audience.phoneField || '';
      const filters = cfg.audience.filters || [];
      // Optional attributes source: resolve once and key by email, so its
      // columns can be filtered on (joined to each audience row).
      let attrMap = null; let attrFields = [];
      if (cfg.audience.attrDashboardId && cfg.audience.attrTileId) {
        try {
          const ar = await resolveAudience({ entityId, dashboardId: cfg.audience.attrDashboardId, tileId: cfg.audience.attrTileId, user, suiteId: scopeSuite, limit: capFor(entityId) * 2 });
          attrFields = ar.fields || [];
          const aEmail = cfg.audience.attrEmailField || attrFields.find((f) => /email/i.test(f.name) || /email/i.test(f.label))?.name || '';
          if (aEmail) { attrMap = new Map(); for (const r of ar.rows) { const e = cellVal(r[aEmail]).toLowerCase(); if (e) attrMap.set(e, r); } }
        } catch (e) { console.error('[actions] attributes source failed', e.message); }
      }
      // Fields offered for FILTERING = audience tile + attributes tile (tagged
      // with their source so the UI can fetch each one's distinct values).
      filterFields = [
        ...res.fields.map((f) => ({ name: f.name, label: f.label, dashboardId: cfg.audience.dashboardId, tileId: cfg.audience.tileId })),
        ...attrFields.map((f) => ({ name: f.name, label: `${f.label} (attributes)`, dashboardId: cfg.audience.attrDashboardId, tileId: cfg.audience.attrTileId })),
      ];
      if (emailField) {
        // Shape rows → recipients (consent-tagged) via the shared mapper.
        const built = buildRows(res.rows, { emailField, nameField, phoneField, ticketField, anchorField, emailConsentField, smsConsentField, ignoreConsent, fields: res.fields, attrFields, attrMap, rowPassesFilters, filters });
        raw = built.raw; filteredOut += built.filteredOut;
      }
    }
    // Dedupe + suppression + per-channel reach (shared with Owl segments).
    const { list, excluded, noConsent, reach } = finalizeAudience(raw, suppressed(entityId), capFor(entityId));
    return { list, fields, filterFields, columns, excluded, noConsent, filteredOut, reach };
  }

  // ── Promo / discount codes ──
  const promoStats = (actionId) => {
    const total = sql.prepare('SELECT COUNT(*) n FROM action_promo_codes WHERE action_id=?').get(actionId)?.n || 0;
    const used = sql.prepare("SELECT COUNT(*) n FROM action_promo_codes WHERE action_id=? AND email!=''").get(actionId)?.n || 0;
    return { total, used, available: total - used };
  };
  // Append uploaded codes to the pool (never removes assigned ones).
  function addPromoCodes(actionId, codes) {
    const ins = sql.prepare('INSERT OR IGNORE INTO action_promo_codes (action_id, code) VALUES (?,?)');
    let n = 0;
    for (const c of codes || []) { const code = String(c || '').trim(); if (code) { ins.run(actionId, code); n += 1; } }
    return n;
  }
  // Claim (or look up) this recipient's unique code. Returns '' if the pool is empty.
  function assignPromo(actionId, email) {
    const existing = sql.prepare('SELECT code FROM action_promo_codes WHERE action_id=? AND email=?').get(actionId, email);
    if (existing) return existing.code;
    const free = sql.prepare("SELECT code FROM action_promo_codes WHERE action_id=? AND email='' LIMIT 1").get(actionId);
    if (!free) return '';
    sql.prepare('UPDATE action_promo_codes SET email=?, assigned_at=? WHERE action_id=? AND code=?').run(email, now(), actionId, free.code);
    return free.code;
  }
  // Resolve the promo a recipient should see (generic = same for all; unique =
  // their claimed code). For preview/test, a sample code.
  function promoForRecipient(action, email) {
    const p = action.config.promo || {};
    if (p.source === 'none' || !p.source) return null;
    let code = '';
    if (p.source === 'generic') code = p.code || '';
    else if (p.source === 'unique') code = (action.id && !['preview', 'test'].includes(action.id)) ? assignPromo(action.id, email) : 'SAMPLE-CODE';
    if (!code) return null;
    return { code, benefit: p.benefit || '', type: p.type || 'promo', appendToLink: !!p.appendToLink };
  }

  // Fill generic merge fields: any remaining {{Column}} from the recipient's attributes
  // (case-insensitive by header/label/name), applied AFTER the special tokens ({{name}},
  // {{ticketType}}, {{cta}}, {{unsubscribe}}). Known-but-empty → '' ; unknown token (typo)
  // is left untouched so preview catches it; valid tokens never leak braces.
  function fillAttrs(s, recipient) {
    const attrs = (recipient && recipient.attributes) || {};
    const keys = Object.keys(attrs);
    if (!keys.length) return String(s || '');
    const lut = {};
    for (const k of keys) lut[k.toLowerCase().trim()] = attrs[k];
    return String(s || '').replace(/\{\{\s*([\w .\-/()]+?)\s*\}\}/g, (m, key) => {
      const lk = String(key).toLowerCase().trim();
      return Object.prototype.hasOwnProperty.call(lut, lk) ? String(lut[lk] ?? '') : m;
    });
  }

  function renderFor(action, recipient, step, stepIndex = 0) {
    const cfg = action.config;
    const realSend = action.id && !['preview', 'test'].includes(action.id);
    // Open-tracking pixel — only on real sends (never preview/test). Uses the
    // same per-recipient token as clicks so opens attribute to a person.
    const openPixel = (rtok) => (realSend && cfg.clickToken
      ? `<img src="${mailer.baseUrl()}/o/${cfg.clickToken}/${rtok}/${stepIndex}" width="1" height="1" alt="" style="display:none;max-height:0;max-width:0;overflow:hidden;" />`
      : '');
    const withPixel = (html, rtok) => { const p = openPixel(rtok); if (!p) return html; return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${p}</body>`) : html + p; };
    // A drip step carries its OWN content (subject/body/cta + contentMode/customHtml/
    // heroImage), exactly like a once-off — so each step has the full editor.
    const src = step || cfg;
    const useSubject = src.subject || cfg.subject;
    const useBody = src.body || (step ? '' : cfg.body);
    const useCta = src.ctaText || cfg.ctaText;
    const useContentMode = src.contentMode || 'template';
    // Block-builder content renders to HTML up front, then flows through the SAME
    // token + link-tracking + unsubscribe path as custom HTML below.
    let useHtml = src.customHtml || '';
    if (useContentMode === 'blocks') {
      // Host each block image (data-URLs get stripped by email clients) on real sends.
      const blockPath = step ? `/mail-assets/campaign/${action.id}/${stepIndex}/blocks` : `/mail-assets/campaign/${action.id}/blocks`;
      const blocks = realSend
        ? emailBlocks.hostImages(src.blocks || [], (b, key) => `${mailer.baseUrl()}${blockPath}/${b.id}/${key}`)
        : (src.blocks || []);
      const branding = mailer.resolveBranding(action.entityId, action.config?.eventSuiteId || '');
      const theme = emailTheme.resolve(action.config?.theme, branding); // Tier-1 look, accent ← brand
      const { html: innerHtml, text: innerText } = emailBlocks.render(blocks, { theme });
      const rtok0 = unsubToken(action.entityId, recipient.email);
      const built = mailer.campaignBlocksEmail({ branding, entityId: action.entityId, assetScope: (action.config?.eventSuiteId || action.entityId), subject: useSubject, innerHtml, innerText, unsubUrl: `${mailer.baseUrl()}/u/${rtok0}`, promo: promoForRecipient(action, recipient.email), theme });
      useHtml = built.html;
    }
    const firstName = (recipient.name || '').split(/\s+/)[0] || '';
    const ticket = recipient.ticket || '';
    // Per-recipient tracked link: the same signed token used for unsubscribe
    // identifies WHO clicked, powering the campaign report.
    const rtok = unsubToken(action.entityId, recipient.email);
    // Promo/discount code for this recipient. A 'promo' code can ride the buy
    // link (?promo=CODE); a 'discount' code is entered manually at checkout.
    const promo = promoForRecipient(action, recipient.email);
    const appendPromo = promo && promo.type === 'promo' && promo.appendToLink && promo.code;
    const baseClick = cfg.ctaUrl ? `${mailer.baseUrl()}/c/${cfg.clickToken}/${rtok}/e/${stepIndex}` : ''; // /e = email channel, then step index
    const ctaUrl = baseClick && appendPromo ? `${baseClick}${baseClick.includes('?') ? '&' : '?'}promo=${encodeURIComponent(promo.code)}` : baseClick;
    const unsubUrl = `${mailer.baseUrl()}/u/${rtok}`;
    const tok = (s) => fillAttrs(String(s || '')
      .replace(/\{\{\s*name\s*\}\}/gi, firstName || 'there')
      .replace(/\{\{\s*(ticket_?type|ticket)\s*\}\}/gi, ticket || 'your tickets')
      .replace(/\{\{\s*cta(_url)?\s*\}\}/gi, ctaUrl || '#')
      .replace(/\{\{\s*promo_benefit\s*\}\}/gi, promo?.benefit || '')
      .replace(/\{\{\s*promo(_?code)?\s*\}\}/gi, promo?.code || '')
      .replace(/\{\{\s*unsubscribe\s*\}\}/gi, unsubUrl), recipient);
    const subject = tok(useSubject);

    if ((useContentMode === 'html' || useContentMode === 'blocks') && useHtml.trim()) {
      let html = tok(useHtml);
      // Track + tag EVERY external link in custom HTML (full multi-link attribution):
      // route each external <a href> through the /c/ click redirect with the original
      // URL stored server-side (?k=code — looked up, never a user-suppliable open
      // redirect; /c/ then appends UTMs). Own links and mailto/tel/# are left alone.
      if (cfg.clickToken) {
        const ownBase = mailer.baseUrl();
        html = html.replace(/(<a\b[^>]*?\shref=)(["'])(https?:\/\/[^"'\s]+)\2/gi, (m, pre, q, url) => {
          if (url.startsWith(ownBase)) return m; // our own links — don't re-track
          const code = registerTarget(url);
          if (!code) return m; // store unavailable → keep the original link
          return `${pre}${q}${ownBase}/c/${cfg.clickToken}/${rtok}/e/${stepIndex}?k=${code}${q}`;
        });
      }
      // Guarantee an unsubscribe link (compliance) if the author didn't include one.
      if (!/unsubscrib/i.test(html)) {
        const footer = `<div style="font-size:11px;color:#888;text-align:center;padding:18px;font-family:-apple-system,Segoe UI,Roboto,sans-serif;">Sent via Howler : Pulse · <a href="${unsubUrl}" style="color:#888;">Unsubscribe</a></div>`;
        html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${footer}</body>`) : html + footer;
      }
      const text = `${tok(useHtml).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000)}\n\nUnsubscribe: ${unsubUrl}`;
      return { html: withPixel(html, rtok), text, subject };
    }

    // Hero image: hosted by action id (+ step index) for real sends (email clients
    // strip data-URLs); inline for preview/test so it shows live.
    const heroRaw = src.heroImage || '';
    const heroPath = step ? `/mail-assets/campaign/${action.id}/${stepIndex}` : `/mail-assets/campaign/${action.id}`;
    const heroImage = heroRaw
      ? (heroRaw.startsWith('data:') && realSend ? `${mailer.baseUrl()}${heroPath}` : heroRaw)
      : '';
    // Brand the campaign with its EVENT's branding (logo/colour/sender) when the
    // campaign is tied to one; the asset scope carries the suite so the email's
    // logo URL resolves the event's logo.
    const evSuite = action.config?.eventSuiteId || '';
    const { html, text } = mailer.campaignEmail({ entityId: action.entityId, assetScope: evSuite || action.entityId, branding: mailer.resolveBranding(action.entityId, evSuite), subject, bodyText: tok(useBody), ctaText: useCta || 'View event', ctaUrl, unsubUrl, heroImage, promo });
    return { html: withPixel(html, rtok), text, subject };
  }

  // Render an SMS for a recipient: plain text with tokens, a tracked short link
  // (clicks attributed like email), the promo code inline, and a link-based
  // opt-out (alphanumeric sender IDs can't receive STOP replies).
  function renderSmsFor(action, recipient, step, stepIndex = 0) {
    const cfg = action.config;
    // 'both'-channel campaigns have a separate SMS copy. In a sequence each step
    // carries its own smsBody (falling back to the step's email body, then the
    // campaign-level copy); SMS-only campaigns edit body directly.
    const useBody = step ? (step.smsBody || step.body || cfg.smsBody || cfg.body) : (cfg.smsBody || cfg.body);
    const firstName = (recipient.name || '').split(/\s+/)[0] || '';
    const rtok = unsubToken(action.entityId, recipient.email || recipient.phone || '');
    const promo = promoForRecipient(action, recipient.email || '');
    const appendPromo = promo && promo.type === 'promo' && promo.appendToLink && promo.code;
    const base = cfg.ctaUrl ? `${mailer.baseUrl()}/c/${cfg.clickToken}/${rtok}/s/${stepIndex}` : ''; // /s = sms channel, then step index
    const fullLink = base && appendPromo ? `${base}${base.includes('?') ? '&' : '?'}promo=${encodeURIComponent(promo.code)}` : base;
    const link = shortLink(fullLink); // SMS: long tracked URL → tiny /k/ redirect
    const tok = (s) => fillAttrs(String(s || '')
      .replace(/\{\{\s*name\s*\}\}/gi, firstName || 'there')
      .replace(/\{\{\s*(ticket_?type|ticket)\s*\}\}/gi, recipient.ticket || 'your tickets')
      .replace(/\{\{\s*cta(_url)?\s*\}\}/gi, link || '')
      .replace(/\{\{\s*promo_benefit\s*\}\}/gi, promo?.benefit || '')
      .replace(/\{\{\s*promo(_?code)?\s*\}\}/gi, promo?.code || ''), recipient);
    let text = tok(useBody);
    if (promo && !/\{\{\s*promo/i.test(useBody)) text += `\nCode: ${promo.code}${promo.type === 'discount' ? ' (enter at checkout)' : ''}`;
    if (link && !/\{\{\s*cta/i.test(useBody)) text += `\n${link}`;
    text += `\nOpt out: ${shortLink(`${mailer.baseUrl()}/u/${rtok}`)}`;
    return text;
  }

  // Execute: send to every recipient in the snapshot. Runs detached; the UI
  // polls status. Mailer failures are counted, never crash the loop.
  async function runCampaign(actionId) {
    const a = getAction(actionId);
    if (!a || a.status !== 'running') return;
    const branding = mailer.resolveBranding(a.entityId, a.config?.eventSuiteId || '');
    const wantsEmail = a.config.channel !== 'sms';
    const wantsSms = a.config.channel !== 'email';
    // SMS sub-cap: a tighter ceiling than the audience cap so a big email blast can't
    // also fire a big (costly) SMS blast. Once hit, remaining recipients still get email.
    const smsCap = smsCapFor(a.entityId);
    // Crash-safe resume: the action_sends ledger says who this campaign already
    // reached (a deploy/crash mid-blast kills the loop; boot resumes it). Counters
    // re-derive from the ledger so a restart can't under-count billing.
    const ledger = sql.prepare('SELECT recipient, channel FROM action_sends WHERE action_id=?').all(a.id);
    const doneEmail = new Set(ledger.filter((l) => l.channel === 'email').map((l) => l.recipient));
    const doneSms = new Set(ledger.filter((l) => l.channel === 'sms').map((l) => l.recipient));
    const markSent = sql.prepare('INSERT OR IGNORE INTO action_sends (action_id, recipient, channel, at) VALUES (?,?,?,?)');
    const results = { sent: 0, failed: 0, clicks: a.results.clicks || 0, total: a.audience.length, startedAt: a.results.startedAt || now(), emailSent: doneEmail.size, smsSent: doneSms.size };
    saveResults(a.id, results);
    let processed = 0;
    for (const recipient of a.audience) {
      // Kill switch: re-read the live status every 20 recipients so a pause/delete
      // takes effect mid-blast (within ~2.5s) instead of running to completion.
      if (processed > 0 && processed % 20 === 0) {
        const live = getAction(a.id);
        if (!live || live.status !== 'running') {
          results.finishedAt = now(); saveResults(a.id, results);
          console.log(`[actions] campaign ${a.id} STOPPED mid-send (status now ${live ? live.status : 'deleted'}) after ${results.sent} sent`);
          return;
        }
      }
      processed += 1;
      // Per recipient: try each channel they qualify for. Reached on ≥1 channel
      // counts as sent; only count failed if every attempted channel failed.
      // We also track per-channel delivered counts so the report can compute an
      // honest per-channel CTR (clicks/delivered) on both-channel campaigns.
      const emailKey = String(recipient.email || '').toLowerCase();
      const emailDone = !!emailKey && doneEmail.has(emailKey);
      const smsDone = !!recipient.phone && doneSms.has(String(recipient.phone));
      let ok = emailDone || smsDone; // reached on a previous (interrupted) run
      let attempted = false, lastErr = '';
      try {
        // Per-channel consent enforced here (emailOk/smsOk set at resolution;
        // undefined on legacy audiences = allowed). The transactional toggle
        // sets both true at resolution, so this stays a simple per-channel check.
        if (wantsEmail && recipient.email && recipient.emailOk !== false && !emailDone) {
          attempted = true;
          const { html, text, subject } = renderFor(a, recipient);
          const r = await mailer.send({ to: recipient.email, subject: subject || a.title || 'An update from your event', html, text, fromName: branding.senderName, kind: 'campaign', entity: a.entityId });
          if (r.ok) { ok = true; results.emailSent += 1; markSent.run(a.id, emailKey, 'email', now()); } else lastErr = r.error || r.reason || 'email failed';
        }
        if (wantsSms && recipient.phone && recipient.smsOk !== false && !smsDone && results.smsSent < smsCap) {
          attempted = true;
          const r = await messaging.sendSms({ to: recipient.phone, text: renderSmsFor(a, recipient) });
          if (r.ok) { ok = true; results.smsSent += 1; markSent.run(a.id, String(recipient.phone), 'sms', now()); } else lastErr = r.error || r.reason || 'SMS failed';
        }
      } catch (e) { lastErr = e.message; }
      if (ok) results.sent += 1; else if (attempted) { results.failed += 1; results.lastError = lastErr; }
      if ((results.sent + results.failed) % 20 === 0) saveResults(a.id, results);
      if (attempted) await new Promise((res) => setTimeout(res, 120)); // gentle rate (~8/sec); resumes skip the wait
    }
    results.finishedAt = now();
    saveResults(a.id, results);
    setStatus(a.id, results.sent > 0 || a.audience.length === 0 ? 'done' : 'failed');
    console.log(`[actions] campaign ${a.id} finished: ${results.sent} sent, ${results.failed} failed`);
  }

  // ── routes ──
  const off = (res) => res.status(404).json({ error: 'Actions are disabled' });
  const canEntity = (req, entityId) => req.user.role === 'admin' || (req.user.entityIds || []).includes(entityId);
  const guard = (req, res, entityId) => {
    if (!enabled()) { off(res); return false; }
    if (!canEntity(req, entityId)) { res.status(403).json({ error: 'Not allowed' }); return false; }
    return true;
  };

  // ── Master campaigns (first-class) ──
  // Stats per master = aggregate of its segment campaigns (by config.master).
  function masterList(entityId) {
    const actions = sql.prepare('SELECT config, results FROM actions WHERE entity_id=?').all(entityId)
      .map((r) => ({ config: JSON.parse(r.config || '{}'), results: JSON.parse(r.results || '{}') }));
    const byName = new Map();
    for (const a of actions) {
      const name = a.config.master; if (!name) continue;
      const s = byName.get(name) || { campaigns: 0, sent: 0, clicks: 0, converted: 0, enrolled: 0, cost: 0 };
      s.campaigns += 1; s.sent += a.results.sent || 0; s.clicks += a.results.clicks || 0;
      s.converted += a.results.converted || 0; s.enrolled += a.results.enrolled || 0;
      // Cost: per-channel sends × the client's effective rate (same basis as the
      // single-campaign report), summed across the master's campaigns.
      if (billing) {
        const ch = a.config.channel || 'email'; const both = ch === 'both';
        const emailSent = both ? (a.results.emailSent || 0) : (ch === 'email' ? (a.results.sent || 0) : 0);
        const smsSent = both ? (a.results.smsSent || 0) : (ch === 'sms' ? (a.results.sent || 0) : 0);
        s.cost += billing.costFor(entityId, { email: emailSent, sms: smsSent }).total;
      }
      byName.set(name, s);
    }
    // Union of records (which may have a target but no campaigns yet) + used names.
    const recs = new Map(sql.prepare('SELECT name, target FROM campaign_masters WHERE entity_id=?').all(entityId).map((r) => [r.name, r.target]));
    for (const n of byName.keys()) if (!recs.has(n)) recs.set(n, 0);
    const currency = billing ? (billing.masterRates().currency || 'ZAR') : 'ZAR';
    return [...recs.entries()].map(([name, target]) => ({ name, target, currency, stats: byName.get(name) || { campaigns: 0, sent: 0, clicks: 0, converted: 0, enrolled: 0, cost: 0 } }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  // Repoint every segment campaign from one master name to another (rename).
  const renameMaster = sql.transaction((entityId, from, to) => {
    for (const r of sql.prepare('SELECT id, config FROM actions WHERE entity_id=?').all(entityId)) {
      const c = JSON.parse(r.config || '{}');
      if (c.master === from) { c.master = to; sql.prepare('UPDATE actions SET config=?, updated_at=? WHERE id=?').run(JSON.stringify(c), now(), r.id); }
    }
  });

  app.get('/api/actions/:entityId/masters', auth.requireAuth, auth.requirePermission('campaigns.view'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    res.json({ masters: masterList(req.params.entityId) });
  });
  // Create/update a master: set target and/or rename (ripples to its campaigns).
  app.put('/api/actions/:entityId/masters', auth.requireAuth, auth.requirePermission('campaigns.approve'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const eId = req.params.entityId;
    const name = String((req.body || {}).name || '').trim().slice(0, 80);
    const rename = (req.body || {}).rename != null ? String(req.body.rename).trim().slice(0, 80) : null;
    const target = Math.max(0, Math.round(Number((req.body || {}).target) || 0));
    if (!name) return res.status(400).json({ error: 'name required' });
    if (rename != null && rename !== name) {
      if (!rename) return res.status(400).json({ error: 'New name cannot be empty' });
      renameMaster(eId, name, rename);
      sql.prepare('DELETE FROM campaign_masters WHERE entity_id=? AND name=?').run(eId, name);
      sql.prepare('INSERT INTO campaign_masters (entity_id, name, target, created_at) VALUES (?,?,?,?) ON CONFLICT(entity_id,name) DO UPDATE SET target=excluded.target').run(eId, rename, target, now());
      return res.json({ ok: true, name: rename });
    }
    sql.prepare('INSERT INTO campaign_masters (entity_id, name, target, created_at) VALUES (?,?,?,?) ON CONFLICT(entity_id,name) DO UPDATE SET target=excluded.target').run(eId, name, target, now());
    res.json({ ok: true, name });
  });
  // Delete a master: ungroup its campaigns (never deletes the campaigns).
  app.delete('/api/actions/:entityId/masters/:name', auth.requireAuth, auth.requirePermission('campaigns.approve'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    renameMaster(req.params.entityId, req.params.name, '');
    sql.prepare('DELETE FROM campaign_masters WHERE entity_id=? AND name=?').run(req.params.entityId, req.params.name);
    res.status(204).end();
  });

  // List + CRUD (one set of handlers serves admin and client self-service).
  app.get('/api/actions/:entityId', auth.requireAuth, auth.requirePermission('campaigns.view'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const rows = sql.prepare(`SELECT ${LIST_COLS} FROM actions WHERE entity_id=? ORDER BY created_at DESC LIMIT 100`).all(req.params.entityId);
    // People who can be named as approvers: client members whose role grants
    // campaigns.approve. (Plus a 'Howler' option offered client-side.)
    const candidates = db.listUsers()
      .filter((u) => u.role !== 'admin' && (u.entityIds || []).includes(req.params.entityId) && auth.hasPermission(u, req.params.entityId, 'campaigns.approve'))
      .map((u) => ({ userId: u.id, email: u.email }));
    // Roll up opens/clicks for JUST the campaigns we're listing — scoped to this
    // entity's own action ids (already in hand from `rows`), never a full-table
    // scan across every tenant's action_opens/action_clicks (those tables grow
    // without bound, so an unscoped GROUP BY here is a per-load cost cliff).
    const ids = rows.map((r) => r.id);
    const ph = ids.map(() => '?').join(',');
    const openMap = {};
    const clickMap = {};
    if (ids.length) {
      // Unique openers per campaign → open rate on the list.
      try { for (const o of sql.prepare(`SELECT action_id, COUNT(DISTINCT email) n FROM action_opens WHERE email!='' AND action_id IN (${ph}) GROUP BY action_id`).all(...ids)) openMap[o.action_id] = o.n; } catch { /* table may be new */ }
      // Per-channel clicks per campaign → reconcile the cached counters from the
      // source-of-truth table so the list + master rollup can't drift from it
      // (the counter is just a cache; see reconcileClicks).
      try { for (const c of sql.prepare(`SELECT action_id, channel, COUNT(*) n FROM action_clicks WHERE action_id IN (${ph}) GROUP BY action_id, channel`).all(...ids)) (clickMap[c.action_id] = clickMap[c.action_id] || []).push({ channel: c.channel, n: c.n }); } catch { /* table may be new */ }
    }
    const actions = rows.map((r) => {
      const a = reconcileClicks(rowToAction(r), clickMap[r.id] || []);
      const pub = publicAction(a);
      const sent = pub.results?.sent || 0;
      if (pub.config?.channel !== 'sms' && sent > 0) pub.openRate = Math.min(100, Math.round(((openMap[pub.id] || 0) / sent) * 100));
      return pub;
    });
    res.json({ actions, requireApproval: requireApprovalFor(req.params.entityId), approverCandidates: candidates });
  });
  // Per-client "require approval" governance setting. (Before the :id routes so
  // 'approval-setting' isn't swallowed by :id.)
  app.get('/api/actions/:entityId/approval-setting', auth.requireAuth, auth.requirePermission('campaigns.view'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    res.json({ requireApproval: requireApprovalFor(req.params.entityId) });
  });
  app.put('/api/actions/:entityId/approval-setting', auth.requireAuth, auth.requirePermission('team.manage'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    db.setSetting(`approval_required:${req.params.entityId}`, (req.body || {}).requireApproval ? '1' : '0');
    res.json({ requireApproval: requireApprovalFor(req.params.entityId) });
  });
  // Per-client campaign audience cap — Howler-admin only (a client can't raise their own send limit).
  const capPayload = (entityId) => ({ cap: capFor(entityId), smsCap: smsCapFor(entityId), default: MAX_AUDIENCE, smsDefault: MAX_SMS_DEFAULT, max: MAX_AUDIENCE_HARD });
  app.get('/api/admin/entities/:entityId/audience-cap', auth.requireAdmin, (req, res) =>
    res.json(capPayload(req.params.entityId)));
  app.put('/api/admin/entities/:entityId/audience-cap', auth.requireAdmin, (req, res) => {
    const body = req.body || {};
    if ('cap' in body) { const n = parseInt(body.cap, 10); db.setSetting(`audience_cap:${req.params.entityId}`, Number.isFinite(n) && n > 0 ? String(Math.min(n, MAX_AUDIENCE_HARD)) : ''); }
    // SMS sub-cap: blank → default; 0 → block SMS entirely (a valid, deliberate setting).
    if ('smsCap' in body) { const s = parseInt(body.smsCap, 10); db.setSetting(`sms_cap:${req.params.entityId}`, body.smsCap === '' || body.smsCap == null ? '' : (Number.isFinite(s) && s >= 0 ? String(Math.min(s, MAX_AUDIENCE_HARD)) : '')); }
    res.json(capPayload(req.params.entityId));
  });
  app.post('/api/actions/:entityId', auth.requireAuth, auth.requirePermission('campaigns.approve'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const id = uuid();
    const cfg = cleanConfig(req.body || {});
    const rec = ((req.body || {}).recurring || cfg.campaignMode === 'sequence') && cfg.audience.mode === 'tile' ? 1 : 0;
    sql.prepare('INSERT INTO actions (id, entity_id, type, status, title, config, recurring, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, req.params.entityId, 'email_campaign', 'draft', String((req.body || {}).title || '').slice(0, 120), JSON.stringify(cfg), rec, req.user.email, now(), now());
    if (Array.isArray((req.body || {}).promoCodes)) addPromoCodes(id, req.body.promoCodes);
    res.status(201).json({ action: publicAction(getAction(id)) });
  });
  // Duplicate any campaign → a fresh draft (cloned content/audience, new tracking
  // token, reset stats/approvals). Lets a sent campaign be re-run or tweaked.
  app.post('/api/actions/:entityId/:id/duplicate', auth.requireAuth, auth.requirePermission('campaigns.approve'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const a = getAction(req.params.id);
    if (!a || a.entityId !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    const id = uuid();
    // Fresh clickToken so the copy's opens/clicks track separately; drop any
    // approver sign-offs from the source.
    const cfg = { ...a.config, clickToken: crypto.randomBytes(6).toString('base64url'), approvers: [] };
    const rec = (a.recurring || cfg.campaignMode === 'sequence') && cfg.audience?.mode === 'tile' ? 1 : 0;
    sql.prepare('INSERT INTO actions (id, entity_id, type, status, title, config, recurring, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, req.params.entityId, 'email_campaign', 'draft', `Copy of ${a.title || a.config.subject || 'campaign'}`.slice(0, 120), JSON.stringify(cfg), rec, req.user.email, now(), now());
    res.status(201).json({ action: publicAction(getAction(id)) });
  });
  app.put('/api/actions/:entityId/:id', auth.requireAuth, auth.requirePermission('campaigns.approve'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const a = getAction(req.params.id);
    if (!a || a.entityId !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    if (a.status !== 'draft' && a.status !== 'auto') return res.status(400).json({ error: 'Only drafts can be edited' });
    const cfg = { ...cleanConfig(req.body || {}), clickToken: a.config.clickToken };
    const rec = ((req.body || {}).recurring || cfg.campaignMode === 'sequence') && cfg.audience.mode === 'tile' ? 1 : 0;
    sql.prepare('UPDATE actions SET title=?, config=?, recurring=?, updated_at=? WHERE id=?')
      .run(String((req.body || {}).title || a.title).slice(0, 120), JSON.stringify(cfg), rec, now(), a.id);
    if (Array.isArray((req.body || {}).promoCodes)) addPromoCodes(a.id, req.body.promoCodes);
    res.json({ action: publicAction(getAction(a.id)) });
  });
  app.delete('/api/actions/:entityId/:id', auth.requireAuth, auth.requirePermission('campaigns.approve'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const a = getAction(req.params.id);
    if (!a || a.entityId !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    if (a.status === 'running') return res.status(400).json({ error: 'Cannot delete a running campaign' });
    sql.prepare('DELETE FROM actions WHERE id=?').run(a.id);
    res.status(204).end();
  });

  // The client's events (suites) — for optionally linking a campaign to an event.
  app.get('/api/actions/:entityId/events', auth.requireAuth, auth.requirePermission('campaigns.view'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    res.json({ events: (listEvents ? listEvents(req.params.entityId) : []) });
  });

  // Public: serve a campaign's hero image (data-URL stored on the action) so
  // real sends reference a URL, not an embedded data-URL clients would strip.
  // Serve a builder BLOCK's image: /mail-assets/campaign/:id/blocks/:blockId/:key
  // (once-off) or /:id/:step/blocks/:blockId/:key (per drip step). key = url|thumb.
  const serveDataUrl = (res, img) => {
    if (!img) return res.status(404).end();
    if (!img.startsWith('data:')) return res.redirect(302, img);
    const m = img.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!m) return res.status(404).end();
    const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
    res.set('Content-Type', m[1] || 'image/png');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(buf);
  };
  const blockImg = (a, stepIdx, blockId, key) => {
    const blocks = (stepIdx >= 0 ? a?.config?.steps?.[stepIdx]?.blocks : a?.config?.blocks) || [];
    const b = emailBlocks.flattenBlocks(blocks).find((x) => x.id === blockId); // incl. column children
    return b ? (key === 'thumb' ? b.thumb : b.url) : '';
  };
  app.get('/mail-assets/campaign/:id/blocks/:blockId/:key', (req, res) => serveDataUrl(res, blockImg(getAction(req.params.id), -1, req.params.blockId, req.params.key)));
  app.get('/mail-assets/campaign/:id/:step/blocks/:blockId/:key', (req, res) => serveDataUrl(res, blockImg(getAction(req.params.id), Number(req.params.step), req.params.blockId, req.params.key)));
  app.get('/mail-assets/campaign/:id/:step?', (req, res) => {
    const a = getAction(req.params.id);
    // Per-step hero for drip sequences (/:step), else the campaign-level hero.
    const stepIdx = req.params.step != null && Number.isInteger(Number(req.params.step)) ? Number(req.params.step) : -1;
    const img = (stepIdx >= 0 ? (a?.config?.steps?.[stepIdx]?.heroImage) : a?.config?.heroImage) || '';
    if (!img) return res.status(404).end();
    if (!img.startsWith('data:')) return res.redirect(302, img);
    const m = img.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!m) return res.status(404).end();
    const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
    res.set('Content-Type', m[1] || 'image/png');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(buf);
  });

  // Audience preview for an (unsaved) config: count + sample + field options.
  app.post('/api/actions/:entityId/audience-preview', auth.requireAuth, auth.requirePermission('campaigns.approve'), async (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    try {
      const cfg = cleanConfig(req.body || {});
      const { list, fields, filterFields, columns, excluded, noConsent, filteredOut, segmentMissing, reach } = await audienceFor(req.params.entityId, cfg, req.user);
      // Honest SMS preview: the send loop stops sending SMS once the sub-cap is hit, so
      // show the capped number (and flag the cap) rather than the full consenting count.
      const smsCap = smsCapFor(req.params.entityId);
      const baseReach = reach || { total: list.length, email: 0, sms: 0 };
      const shownReach = { ...baseReach, sms: Math.min(baseReach.sms || 0, smsCap) };
      res.json({ count: list.length, excluded, noConsent, filteredOut, segmentMissing: !!segmentMissing, reach: shownReach, smsCap, smsCapped: (baseReach.sms || 0) > smsCap, sample: list.slice(0, 8), fields: (fields || []).map((f) => ({ name: f.name, label: f.label })), filterFields: filterFields || [], columns: columns || [] });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Distinct values for a tile column — powers the targeting filter multi-select.
  app.post('/api/actions/:entityId/field-values', auth.requireAuth, auth.requirePermission('campaigns.view'), async (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const { dashboardId, tileId, field, eventSuiteId } = req.body || {};
    if (!dashboardId || !tileId || !field) return res.json({ values: [] });
    try {
      const r = await resolveAudience({ entityId: req.params.entityId, dashboardId, tileId, user: req.user, suiteId: eventSuiteId || '' });
      const seen = new Map(); // lower → original
      for (const row of r.rows || []) {
        const v = cellVal(row[field]);
        if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
        if (seen.size >= 200) break;
      }
      res.json({ values: [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(0, 100) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // AI-draft the campaign copy (editable afterwards).
  app.post('/api/actions/:entityId/draft-copy', auth.requireAuth, auth.requirePermission('campaigns.approve'), async (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    try {
      const out = await draftCopy({ entityId: req.params.entityId, goal: String((req.body || {}).goal || '').slice(0, 1000), audienceCount: Number((req.body || {}).audienceCount) || 0, eventSuiteId: String((req.body || {}).eventSuiteId || ''), language: String((req.body || {}).language || '').slice(0, 5).toLowerCase() });
      res.json(out);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Email preview (sample recipient) + test-send to self.
  app.post('/api/actions/:entityId/preview-email', auth.requireAuth, auth.requirePermission('campaigns.approve'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const cfg = cleanConfig(req.body || {});
    const fake = { id: 'preview', entityId: req.params.entityId, config: cfg };
    // Use a real sample recipient (from the audience preview) when the client sends
    // one, so merge fields ({{Ticket Type}}, {{City}}…) render with actual values.
    const s = (req.body || {}).sample || {};
    const recipient = { email: s.email || 'sam@example.com', name: s.name || 'Sam', ticket: s.ticket || 'General Admission', phone: s.phone || '+27820000000', attributes: s.attributes || {} };
    // The client sends the active step's copy in cfg.body, so render from that
    // (step=null) — works for once-off and per-step sequence previews alike.
    // Return whichever channel(s) apply: email html, SMS text, or both.
    const out = {};
    if (cfg.channel !== 'sms') out.html = renderFor(fake, recipient).html;
    if (cfg.channel !== 'email') out.sms = renderSmsFor(fake, recipient, null);
    res.json(out);
  });
  app.post('/api/actions/:entityId/test-send', auth.requireAuth, auth.requirePermission('campaigns.approve'), async (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const cfg = cleanConfig(req.body || {});
    const fake = { id: 'test', entityId: req.params.entityId, config: cfg };
    // SMS test goes to a phone you enter; email test goes to your own address.
    // For 'both', send whichever the test data supports and report each.
    const wantsEmail = cfg.channel !== 'sms';
    const wantsSms = cfg.channel !== 'email';
    const done = [];
    if (wantsSms) {
      const to = String((req.body || {}).testPhone || '').trim();
      if (!to) return res.status(400).json({ error: 'Enter a mobile number to test the SMS' });
      const text = renderSmsFor(fake, { email: req.user.email, name: 'Sam', ticket: 'General Admission', phone: to });
      const r = await messaging.sendSms({ to, text: `[TEST] ${text}` });
      if (!r.ok) return res.status(400).json({ error: r.error || r.reason || 'SMS not configured' });
      done.push(to);
    }
    if (wantsEmail) {
      const { html, text, subject } = renderFor(fake, { email: req.user.email, name: '', ticket: 'General Admission' });
      const branding = mailer.resolveBranding(req.params.entityId, fake.config?.eventSuiteId || '');
      const r = await mailer.send({ to: req.user.email, subject: `[TEST] ${subject || 'Campaign'}`, html, text, fromName: branding.senderName, kind: 'test', entity: req.params.entityId });
      if (!r.ok) return res.status(400).json({ error: r.error || r.reason || 'email not configured' });
      done.push(req.user.email);
    }
    res.json({ ok: true, to: done.join(' & ') });
  });

  // APPROVE & SEND — the human gate. Snapshots the audience at this moment and
  // kicks off the send. Both Howler admins and the client's own users may approve.
  app.post('/api/actions/:entityId/:id/approve', auth.requireAuth, auth.requirePermission('campaigns.approve'), async (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const a = getAction(req.params.id);
    if (!a || a.entityId !== req.params.entityId) return res.status(404).json({ error: 'Not found' });

    // PENDING: record this user's sign-off against their approver slot. Only
    // when ALL required approvers are in does it fall through and actually send.
    if (a.status === 'pending') {
      // Only a Howler admin LINKED to this client may fill the 'Howler' slot
      // (mirrors who gets notified; falls back to any admin if none are linked).
      const canHowler = req.user.role === 'admin' && howlerAdminsFor(a.entityId).some((u) => u.id === req.user.id);
      const slots = (a.config.approvers || []).map(approverKey);
      const myKeys = [`user:${req.user.id}`, ...(canHowler ? ['howler'] : [])].filter((k) => slots.includes(k));
      if (!myKeys.length) return res.status(403).json({ error: 'You are not an approver for this campaign' });
      const ins = sql.prepare('INSERT OR IGNORE INTO action_approvals (action_id, approver_key, by_email, at) VALUES (?,?,?,?)');
      for (const k of myKeys) ins.run(a.id, k, req.user.email, now());
      const summ = approvalSummary(getAction(a.id));
      if (!summ.complete) return res.json({ ok: true, pending: true, remaining: summ.pending });
      // All approvals in → tell the sender, then flip to draft and continue
      // into the send logic below.
      notifySender(a, { approved: true, by: req.user.email });
      sql.prepare("UPDATE actions SET status='draft', updated_at=? WHERE id=?").run(now(), a.id);
    } else if (a.status !== 'draft') {
      return res.status(400).json({ error: `Cannot approve a ${a.status} campaign` });
    } else if (requireApprovalFor(a.entityId)) {
      // Governance: this client requires sign-off — must go through approval.
      return res.status(400).json({ error: 'This client requires approval — use “Send for approval”.' });
    }
    const isSequence = a.config.campaignMode === 'sequence';
    const cErr = contentError(a.config);
    if (cErr) return res.status(400).json({ error: cErr });

    // A sequence (drip) or recurring template ACTIVATES on approval and then runs
    // fully automatically — no per-send approval. The check enrolls new
    // abandoners (sequence) or queues child drafts (recurring single-send).
    if (isSequence || a.recurring) {
      sql.prepare('UPDATE actions SET status=?, approved_by=?, approved_at=?, updated_at=? WHERE id=?')
        .run('auto', req.user.email, now(), now(), a.id);
      if (isSequence) enrollSequence(getAction(a.id)).catch((e) => console.error('[actions] initial enroll failed', a.id, e.message));
      return res.json({ ok: true, activated: true });
    }

    try {
      // Auto-queued children carry a pre-resolved snapshot (the NEW people at
      // check time); everything else resolves the audience now.
      let list;
      if (a.config.audience.mode === 'snapshot') {
        const sup = suppressed(a.entityId);
        list = a.audience.filter((r) => !sup.has(r.email));
      } else {
        ({ list } = await audienceFor(a.entityId, a.config, req.user));
      }
      if (!list.length) return res.status(400).json({ error: 'Audience is empty — nothing to send' });
      sql.prepare('UPDATE actions SET status=?, audience=?, approved_by=?, approved_at=?, updated_at=? WHERE id=?')
        .run('running', JSON.stringify(list), req.user.email, now(), now(), a.id);
      // Remember who this campaign family has reached, for recurring dedupe.
      const rootId = a.parentId || a.id;
      const ins = sql.prepare('INSERT OR IGNORE INTO action_sent (root_id, email, at) VALUES (?,?,?)');
      for (const r of list) ins.run(rootId, r.email, now());
      runCampaign(a.id).catch((e) => { console.error('[actions] run failed', a.id, e.message); setStatus(a.id, 'failed'); });
      res.json({ ok: true, sendingTo: list.length });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Schedule a one-off campaign to send at a future time (or unschedule → draft).
  // A tick sends it when due, resolving the audience LIVE at that moment.
  app.post('/api/actions/:entityId/:id/schedule', auth.requireAuth, auth.requirePermission('campaigns.approve'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const a = getAction(req.params.id);
    if (!a || a.entityId !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    const at = String(req.body?.at || '').trim();
    // Empty `at` cancels a schedule → back to draft.
    if (!at) {
      if (a.status !== 'scheduled') return res.status(400).json({ error: 'Not scheduled' });
      sql.prepare('UPDATE actions SET status=?, config=?, updated_at=? WHERE id=?').run('draft', JSON.stringify({ ...a.config, scheduledAt: '' }), now(), a.id);
      return res.json({ ok: true, unscheduled: true });
    }
    if (!['draft', 'scheduled'].includes(a.status)) return res.status(400).json({ error: `Can't schedule a ${a.status} campaign` });
    if (a.config.campaignMode === 'sequence' || a.recurring) return res.status(400).json({ error: 'Scheduling is for one-off sends (sequences/automations run continuously).' });
    const cErr = contentError(a.config);
    if (cErr) return res.status(400).json({ error: cErr });
    const when = new Date(at);
    if (isNaN(when.getTime())) return res.status(400).json({ error: 'Invalid date/time' });
    if (when.getTime() < Date.now() + 30000) return res.status(400).json({ error: 'Pick a time at least a minute from now' });
    if (requireApprovalFor(a.entityId)) return res.status(400).json({ error: 'This client requires approval — submit for approval, then schedule.' });
    sql.prepare('UPDATE actions SET status=?, config=?, approved_by=?, approved_at=?, updated_at=? WHERE id=?')
      .run('scheduled', JSON.stringify({ ...a.config, scheduledAt: when.toISOString() }), req.user.email, now(), now(), a.id);
    res.json({ ok: true, scheduledAt: when.toISOString() });
  });

  // Send a due scheduled campaign — resolves the audience live, then runs.
  async function runScheduledSend(a) {
    // Atomically CLAIM the job before the (slow) audience resolution: flip scheduled →
    // running only if still scheduled. If we didn't win (changes !== 1), an overlapping
    // tick or manual launch took it — bail so the campaign can't be sent twice.
    const claim = sql.prepare("UPDATE actions SET status='running', updated_at=? WHERE id=? AND status='scheduled'").run(now(), a.id);
    if (claim.changes !== 1) return;
    let list;
    if (a.config.audience.mode === 'snapshot') { const sup = suppressed(a.entityId); list = a.audience.filter((r) => !sup.has(r.email)); }
    else { ({ list } = await audienceFor(a.entityId, a.config, { id: 'scheduler', email: 'scheduler@pulse', role: 'admin', entityIds: [] })); }
    if (!list.length) { saveResults(a.id, { ...a.results, lastError: 'Audience was empty at the scheduled time' }); setStatus(a.id, 'failed'); return; }
    sql.prepare("UPDATE actions SET audience=?, updated_at=? WHERE id=?").run(JSON.stringify(list), now(), a.id);
    const rootId = a.parentId || a.id;
    const ins = sql.prepare('INSERT OR IGNORE INTO action_sent (root_id, email, at) VALUES (?,?,?)');
    for (const r of list) ins.run(rootId, r.email, now());
    runCampaign(a.id).catch((e) => { console.error('[actions] scheduled run failed', a.id, e.message); setStatus(a.id, 'failed'); });
  }
  let schedTicking = false; // re-entrancy guard: never let two ticks overlap
  async function processScheduled() {
    if (!enabled() || schedTicking) return;
    schedTicking = true;
    try {
      const nowIso = now();
      const due = sql.prepare("SELECT id FROM actions WHERE status='scheduled' AND json_extract(config,'$.scheduledAt') <= ?").all(nowIso);
      for (const { id } of due) { const a = getAction(id); if (a && a.status === 'scheduled') await runScheduledSend(a).catch((e) => console.error('[actions] schedule tick', id, e.message)); }
    } finally { schedTicking = false; }
  }
  const schedTimer = setInterval(() => processScheduled().catch(() => {}), 60000);
  if (schedTimer.unref) schedTimer.unref();
  setTimeout(() => processScheduled().catch(() => {}), 20000);

  // Stop a campaign — works for an automation/drip (auto), a scheduled send, OR a
  // once-off blast already in flight (running). The send loops re-check status, so
  // a 'running' campaign halts mid-blast within ~20 recipients; auto/scheduled stop
  // before the next tick fires. Returns the resulting status.
  app.post('/api/actions/:entityId/:id/pause', auth.requireAuth, auth.requirePermission('campaigns.approve'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const a = getAction(req.params.id);
    if (!a || a.entityId !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    if (a.status === 'auto' || a.status === 'scheduled') { setStatus(a.id, 'draft'); return res.json({ ok: true, status: 'draft' }); }
    if (a.status === 'running') { setStatus(a.id, 'paused'); return res.json({ ok: true, status: 'paused' }); } // the in-flight loop sees this and stops
    return res.status(400).json({ error: `Nothing to stop — this campaign is ${a.status}.` });
  });

  // ── Approval workflow ──
  // Notify the named approvers (inbox message + push, deep-link to the campaign).
  // The Howler admins who "own" a client = those linked to it (entityIds). They
  // get the 'Howler' approval pings — not every global admin. If somehow none
  // are linked, fall back to all admins so an approval is never a dead-end.
  function howlerAdminsFor(entityId) {
    const admins = db.listUsers().filter((u) => u.role === 'admin');
    const linked = admins.filter((u) => (u.entityIds || []).includes(entityId));
    return linked.length ? linked : admins;
  }
  // Pending campaigns where THIS user is an outstanding approver (hasn't signed
  // off yet) — drives the "needs your approval" banner. { count, first }.
  function awaitingApprovalFor(user, entityId) {
    if (!user) return { count: 0, first: '' };
    const rows = sql.prepare("SELECT * FROM actions WHERE entity_id=? AND status='pending'").all(entityId).map(rowToAction);
    const canHowler = user.role === 'admin' && howlerAdminsFor(entityId).some((u) => u.id === user.id);
    const myKeys = [`user:${user.id}`, ...(canHowler ? ['howler'] : [])];
    let count = 0; let first = '';
    for (const a of rows) {
      const mine = approvalSummary(a).approvers.filter((x) => myKeys.includes(x.key) && !x.approved);
      if (mine.length) { count += 1; if (!first) first = a.id; }
    }
    return { count, first };
  }

  // Approval outcomes the signed-in user (the campaign creator) hasn't seen yet
  // — drives a guaranteed "your campaign was approved / sent back" banner.
  function unseenOutcomesFor(user, entityId) {
    if (!user?.email) return [];
    return sql.prepare("SELECT id, title, config, outcome, outcome_by, outcome_note FROM actions WHERE entity_id=? AND outcome!='' AND outcome_seen=0 AND lower(created_by)=lower(?) ORDER BY outcome_at DESC")
      .all(entityId, user.email)
      .map((r) => ({ id: r.id, title: r.title || JSON.parse(r.config || '{}').subject || 'Your campaign', outcome: r.outcome, by: r.outcome_by || '', note: r.outcome_note || '' }));
  }
  // A short, human summary of a campaign's key settings — for the approval
  // inbox message + email so approvers know what they're signing off.
  function campaignSummaryLines(a) {
    const c = a.config;
    const isSeq = c.campaignMode === 'sequence';
    const lines = [];
    lines.push(`Channel: ${c.channel === 'both' ? 'Email + SMS' : c.channel === 'sms' ? 'SMS' : 'Email'}`);
    lines.push(`Type: ${isSeq ? `Drip sequence — ${(c.steps || []).length} step${(c.steps || []).length === 1 ? '' : 's'}` : a.recurring ? 'Automated (daily check)' : 'One-off send'}`);
    if (!isSeq && c.subject) lines.push(`Subject: ${c.subject}`);
    const audSrc = c.audience?.mode === 'paste' ? 'Pasted list'
      : c.audience?.mode === 'snapshot' ? 'Queued by automation'
      : c.audience?.mode === 'segment' ? `Segment — ${segmentName(a.entityId, c.audience.segmentId) || 'saved'}`
      : 'Dashboard tile';
    lines.push(`Audience: ${audSrc}`);
    if (c.master) lines.push(`Master: ${c.master}`);
    if (c.promo?.source && c.promo.source !== 'none') lines.push(`Offer: ${c.promo.code || c.promo.type}`);
    lines.push(`Approvers: ${approvalSummary(a).approvers.map((x) => x.label).join(', ') || '—'}`);
    return lines;
  }
  // The actual campaign copy, for the approval message + email so approvers can
  // see what they're signing off without opening the app. Returns plain text
  // (inbox) and an HTML card that approximates the email (notification email).
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmtDelay = (h) => (h % 24 === 0 && h >= 24 ? `+${h / 24}d` : `+${h}h`);
  function campaignContentPreview(a) {
    const c = a.config;
    const isSeq = c.campaignMode === 'sequence';
    const isEmail = c.channel !== 'sms';
    const card = (subject, bodyText, hero) => `
      <div style="border:1px solid #e6e6e6;border-radius:10px;padding:14px;margin:8px 0;background:#fff;">
        ${hero ? `<img src="${esc(hero)}" alt="" style="max-width:100%;border-radius:6px;margin-bottom:10px;display:block;" />` : ''}
        ${isEmail && subject ? `<div style="font-weight:700;font-size:15px;margin-bottom:6px;">${esc(subject)}</div>` : ''}
        <div style="font-size:13px;line-height:1.5;color:#333;white-space:pre-wrap;">${esc(bodyText)}</div>
      </div>`;
    if (isSeq) {
      const steps = c.steps || [];
      const text = steps.map((s, i) => `— Step ${i + 1} (${fmtDelay(s.delayHours)}) —\n${isEmail && s.subject ? `Subject: ${s.subject}\n` : ''}${s.body || ''}`).join('\n\n');
      const html = steps.map((s, i) => `<div style="font-size:11px;font-weight:700;color:#7c3aed;margin-top:10px;">Step ${i + 1} · ${fmtDelay(s.delayHours)}</div>${card(s.subject, s.body, i === 0 ? c.heroImage : '')}`).join('');
      return { text, html };
    }
    const text = `${isEmail && c.subject ? `Subject: ${c.subject}\n` : ''}${c.body || ''}`;
    return { text, html: card(c.subject, c.body, isEmail ? c.heroImage : '') };
  }
  function notifyApprovers(a, opts = {}) {
    const note = String(opts.message || '').trim();
    const path = `/actions?action=${a.id}`;
    const link = `${mailer.baseUrl()}${path}`;
    const title = 'Campaign approval needed';
    const name = a.title || a.config.subject || 'A campaign';
    const lines = campaignSummaryLines(a);
    const content = campaignContentPreview(a);
    const noteBlock = note ? `“${opts.fromName || 'The sender'}” says:\n${note}\n\n` : '';
    const body = `${noteBlock}“${name}” is waiting for your approval.\n\n${lines.map((l) => `• ${l}`).join('\n')}\n\n— Content —\n${content.text}\n\nReview, preview & approve (or send back to draft):\n${link}`;
    const wantsHowler = (a.config.approvers || []).some((x) => x.type === 'howler');
    const howler = wantsHowler ? howlerAdminsFor(a.entityId) : [];
    try { os?.announce?.({ entityId: a.entityId, title, body, priority: 'needs_reply', createdBy: 'campaigns@pulse', authorType: 'system', subjectType: 'campaign', subjectId: a.id }); } catch { /* os optional */ }
    if (push?.isEnabled?.()) {
      const pushBody = note ? `${note.slice(0, 90)} — “${name}” needs approval.` : `“${name}” is waiting for your approval.`;
      for (const ap of a.config.approvers || []) {
        if (ap.type === 'user' && ap.userId) push.sendToUser(ap.userId, { title, body: pushBody, url: path, tag: `approve-${a.id}`, requireInteraction: true }).catch(() => {});
      }
      for (const u of howler) push.sendToUser(u.id, { title, body: pushBody, url: path, tag: `approve-${a.id}`, requireInteraction: true }).catch(() => {});
    }
    // Email each approver too — a named person's address, or the Howler admins
    // linked to this client.
    if (mailer?.isConfigured?.()) {
      const emails = new Set();
      for (const ap of a.config.approvers || []) {
        if (ap.type !== 'howler' && ap.email) emails.add(ap.email);
      }
      for (const u of howler) emails.add(u.email);
      if (emails.size) {
        const summaryHtml = lines.map((l) => { const [k, ...v] = l.split(':'); return `<b>${k}:</b>${v.join(':')}`; }).join('<br>');
        const noteHtml = note ? `<div style="border-left:3px solid var(--brand,#ff385c);padding:6px 0 6px 12px;margin-bottom:14px;"><b>${esc(opts.fromName || 'The sender')}</b> says:<br>${esc(note)}</div>` : '';
        const html = mailer.notificationEmail({
          title, body: `${noteHtml}“${esc(name)}” is waiting for your approval.<br><br>${summaryHtml}<br><br><b>Preview${a.config.channel === 'sms' ? ' (SMS)' : ''}:</b>${content.html}Open it to approve, or send it back to draft.`,
          ctaText: 'Review & approve', ctaPath: path, preheader: `Approval needed: ${name}`, entityId: a.entityId,
        });
        mailer.send({ to: [...emails], subject: `Approval needed: ${name}`, html, kind: 'campaign-approval', entity: a.entityId }).catch(() => {});
      }
    }
  }

  // Tell the campaign's creator the outcome — approved (sending) or sent back to
  // draft (with the reviewer's comment). Inbox + push + email, skipping the
  // reviewer if they're also the sender.
  function notifySender(a, { approved, note = '', by = '' }) {
    const sender = (db.listUsers() || []).find((u) => u.email && a.createdBy && u.email.toLowerCase() === a.createdBy.toLowerCase());
    if (!sender || sender.email.toLowerCase() === (by || '').toLowerCase()) return;
    // Record the unseen outcome on the campaign — this drives a banner that
    // ALWAYS shows to the creator next time they load Pulse, independent of
    // whether push/email reached them.
    sql.prepare("UPDATE actions SET outcome=?, outcome_by=?, outcome_note=?, outcome_at=?, outcome_seen=0 WHERE id=?")
      .run(approved ? 'approved' : 'rejected', by || '', String(note || '').slice(0, 500), now(), a.id);
    const name = a.title || a.config.subject || 'Your campaign';
    const path = `/actions?action=${a.id}`;
    const link = `${mailer.baseUrl()}${path}`;
    const title = approved ? 'Campaign approved' : 'Campaign sent back to draft';
    const body = approved
      ? `“${name}” was approved${by ? ` by ${by}` : ''} and is now sending.`
      : `“${name}” was sent back to draft${by ? ` by ${by}` : ''}.${note ? `\n\nComment: ${note}` : ''}\n\nOpen it to make changes and resubmit:\n${link}`;
    try { os?.announce?.({ entityId: a.entityId, title, body, priority: approved ? 'fyi' : 'needs_reply', createdBy: 'campaigns@pulse', authorType: 'system', subjectType: 'campaign', subjectId: a.id }); } catch { /* os optional */ }
    if (push?.isEnabled?.()) push.sendToUser(sender.id, { title, body: approved ? `“${name}” was approved.` : `“${name}” was sent back to draft.`, url: path, tag: `outcome-${a.id}` }).catch(() => {});
    if (mailer?.isConfigured?.()) {
      const html = mailer.notificationEmail({
        title,
        body: approved
          ? `Good news — “${name}” was approved${by ? ` by ${by}` : ''} and is now sending.`
          : `“${name}” was sent back to draft${by ? ` by ${by}` : ''}.${note ? `<br><br><b>Comment:</b> ${note}` : ''}<br><br>Open it to make changes and resubmit.`,
        ctaText: 'Open campaign', ctaPath: path, preheader: title, entityId: a.entityId,
      });
      mailer.send({ to: sender.email, subject: `${title}: ${name}`, html, kind: 'campaign-approval', entity: a.entityId }).catch(() => {});
    }
  }

  // The campaign's comms/approval conversation — so anyone viewing the campaign
  // sees the full log (who submitted, approvals, rejections, comments).
  app.get('/api/actions/:entityId/:id/thread', auth.requireAuth, auth.requirePermission('campaigns.view'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const a = getAction(req.params.id);
    if (!a || a.entityId !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    const t = os?.subjectThread?.(a.entityId, 'campaign', a.id);
    const messages = (t?.messages || []).map((m) => ({
      author: m.authorType === 'howler' ? 'Howler' : m.authorType === 'system' ? 'Pulse' : (m.authorName || m.authorEmail || 'Someone'),
      body: m.body, at: m.createdAt,
    }));
    res.json({ messages });
  });

  // Submit a draft for approval → status 'pending', notify the named approvers.
  app.post('/api/actions/:entityId/:id/submit', auth.requireAuth, auth.requirePermission('campaigns.approve'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const a = getAction(req.params.id);
    if (!a || a.entityId !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    if (a.status !== 'draft') return res.status(400).json({ error: `Can't submit a ${a.status} campaign` });
    const approvers = Array.isArray(req.body?.approvers) ? req.body.approvers : (a.config.approvers || []);
    if (!approvers.length) return res.status(400).json({ error: 'Add at least one approver' });
    const cfg = { ...a.config, approvers: cleanConfig({ ...req.body, approvers }).approvers };
    sql.prepare('DELETE FROM action_approvals WHERE action_id=?').run(a.id);
    sql.prepare('UPDATE actions SET status=?, config=?, updated_at=? WHERE id=?').run('pending', JSON.stringify(cfg), now(), a.id);
    notifyApprovers(getAction(a.id), { message: String(req.body?.message || '').slice(0, 2000), fromName: req.user.email });
    res.json({ ok: true, pending: true });
  });

  // Reject a pending campaign → back to draft (clears approvals), notify creator.
  app.post('/api/actions/:entityId/:id/reject', auth.requireAuth, auth.requirePermission('campaigns.approve'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const a = getAction(req.params.id);
    if (!a || a.entityId !== req.params.entityId || a.status !== 'pending') return res.status(400).json({ error: 'Not awaiting approval' });
    sql.prepare('DELETE FROM action_approvals WHERE action_id=?').run(a.id);
    setStatus(a.id, 'draft');
    const note = String(req.body?.note || '').slice(0, 500);
    notifySender(a, { approved: false, note, by: req.user.email });
    res.json({ ok: true });
  });

  // Creator acknowledges an approval-outcome banner → clears it.
  app.post('/api/actions/:entityId/:id/ack-outcome', auth.requireAuth, auth.requirePermission('campaigns.view'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const a = getAction(req.params.id);
    if (!a || a.entityId !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    if ((a.createdBy || '').toLowerCase() !== (req.user.email || '').toLowerCase()) return res.status(403).json({ error: 'Not allowed' });
    sql.prepare('UPDATE actions SET outcome_seen=1 WHERE id=?').run(a.id);
    res.json({ ok: true });
  });

  // Detailed campaign report: per-recipient clicks (who, how many, when),
  // plus the summary. Names come from the audience snapshot.
  // Journey funnel for a drip sequence: per-step "received" counts (a step is
  // received once the recipient advances past it) + status breakdown. Shows
  // where people convert or drop off through the sequence.
  app.get('/api/actions/:entityId/:id/journey', auth.requireAuth, auth.requirePermission('campaigns.view'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const a = getAction(req.params.id);
    if (!a || a.entityId !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    const rows = sql.prepare('SELECT step_index, status FROM action_enrollments WHERE action_id=?').all(a.id);
    const steps = a.config.steps || [];
    const byStatus = { active: 0, converted: 0, unsubscribed: 0, done: 0 };
    for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    // Per-step engagement: distinct people who opened / clicked each step's message.
    const openByStep = {}; const clickByStep = {};
    try { for (const o of sql.prepare("SELECT step, COUNT(DISTINCT email) n FROM action_opens WHERE action_id=? AND email!='' GROUP BY step").all(a.id)) openByStep[o.step] = o.n; } catch { /* legacy */ }
    try { for (const c of sql.prepare("SELECT step, COUNT(DISTINCT email) n FROM action_clicks WHERE action_id=? AND email!='' GROUP BY step").all(a.id)) clickByStep[c.step] = c.n; } catch { /* legacy */ }
    const stepStats = steps.map((s, k) => ({
      index: k, delayHours: s.delayHours, subject: s.subject,
      received: rows.filter((r) => r.step_index > k).length,        // advanced past step k = got it
      opened: openByStep[k] || 0,
      clicked: clickByStep[k] || 0,
      converted: rows.filter((r) => r.status === 'converted' && r.step_index === k + 1).length, // converted right after step k
    }));
    res.json({ enrolled: rows.length, ...byStatus, steps: stepStats });
  });
  app.get('/api/actions/:entityId/:id/report', auth.requireAuth, auth.requirePermission('campaigns.view'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const a = getAction(req.params.id);
    if (!a || a.entityId !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    const rows = sql.prepare('SELECT email, COUNT(*) n, MAX(at) lastAt, MIN(at) firstAt FROM action_clicks WHERE action_id=? GROUP BY email ORDER BY n DESC, lastAt DESC').all(a.id);
    const nameOf = Object.fromEntries(a.audience.map((r) => [r.email, r.name || '']));
    const clickers = rows.filter((r) => r.email).map((r) => ({ email: r.email, name: nameOf[r.email] || '', clicks: r.n, firstAt: r.firstAt, lastAt: r.lastAt }));
    const tableTotal = rows.reduce((s, r) => s + r.n, 0);
    const tableAnon = rows.find((r) => !r.email)?.n || 0;
    // Reconcile with the legacy click counter: campaigns sent before per-recipient
    // tracking recorded clicks there (and on non-attributable links), so the
    // action_clicks table is empty for them. Surface those as unattributed.
    const counter = a.results.clicks || 0;
    const legacy = Math.max(0, counter - tableTotal);
    const totalClicks = tableTotal + legacy;
    const anonClicks = tableAnon + legacy;
    const sent = a.results.sent || 0;
    const channel = a.config.channel || 'email';
    const both = channel === 'both';
    // Per-channel click attribution. New sends tag each click with its channel
    // ('email' via /e links, 'sms' via /s); legacy untagged clicks ('') belong to
    // the only channel on a single-channel campaign, otherwise stay unattributed.
    const byCh = sql.prepare("SELECT channel, COUNT(*) n FROM action_clicks WHERE action_id=? GROUP BY channel").all(a.id);
    reconcileClicks(a, byCh); // heal the cached counters from the source-of-truth table on view
    const chCount = (c) => byCh.find((r) => r.channel === c)?.n || 0;
    const untaggedClicks = chCount('');
    let emailClicks = chCount('email');
    let smsClicks = chCount('sms');
    if (channel === 'email') emailClicks += untaggedClicks + legacy;
    else if (channel === 'sms') smsClicks += untaggedClicks + legacy;
    // Per-channel delivered counts (fall back to total sent on single-channel).
    const emailSent = both ? (a.results.emailSent || 0) : (channel === 'email' ? sent : 0);
    const smsSent = both ? (a.results.smsSent || 0) : (channel === 'sms' ? sent : 0);
    const pct = (num, den) => (den > 0 ? Math.min(100, Math.round((num / den) * 100)) : 0);
    // Opens (email pixel). Unique openers = distinct attributed emails; total =
    // the counter (incl. anonymous/blocked-token loads).
    const uniqueOpeners = sql.prepare("SELECT COUNT(DISTINCT email) n FROM action_opens WHERE action_id=? AND email!=''").get(a.id)?.n || 0;
    const totalOpens = a.results.opens || 0;
    const emailChannel = a.config.channel !== 'sms'; // opens only meaningful for email
    res.json({
      title: a.title || a.config.subject, status: a.status, approvedBy: a.approvedBy, approvedAt: a.approvedAt,
      sent, failed: a.results.failed || 0, total: a.results.total ?? a.audience.length,
      totalClicks, uniqueClickers: clickers.length, anonClicks,
      // CTR mirrors the card (total clicks / sent) so the two never disagree.
      ctr: sent > 0 ? Math.min(100, Math.round((totalClicks / sent) * 100)) : 0,
      // Per-channel split (shown when a campaign uses both channels).
      perChannel: { email: { sent: emailSent, clicks: emailClicks, ctr: pct(emailClicks, emailSent) }, sms: { sent: smsSent, clicks: smsClicks, ctr: pct(smsClicks, smsSent) } },
      // Actual spend: per-channel sends × the client's effective rate.
      cost: billing ? billing.costFor(a.entityId, { email: emailSent, sms: smsSent }) : null,
      opens: totalOpens, uniqueOpeners, hasOpens: emailChannel,
      openRate: emailChannel && sent > 0 ? Math.min(100, Math.round((uniqueOpeners / sent) * 100)) : 0,
      converted: a.results.converted || 0,
      convRate: sent > 0 ? Math.round(((a.results.converted || 0) / sent) * 100) : 0,
      clickers,
      nonClickers: a.audience.filter((r) => !clickers.some((c) => c.email === r.email)).length,
      attributed: clickers.length > 0 || tableAnon > 0,
      // Campaign details (so a sent campaign can be reviewed, not just its stats).
      details: {
        channel: a.config.channel || 'email',
        type: a.config.campaignMode === 'sequence' ? `Drip sequence (${(a.config.steps || []).length} steps)` : a.recurring ? 'Automated (daily check)' : a.config.scheduledAt ? 'Scheduled one-off' : 'One-off',
        subject: a.config.subject || '', body: a.config.body || '', smsBody: a.config.smsBody || '',
        contentMode: a.config.contentMode || 'template', hasHero: !!a.config.heroImage,
        steps: (a.config.steps || []).map((s) => ({ delayHours: s.delayHours, subject: s.subject, body: s.body })),
        master: a.config.master || '', ctaUrl: a.config.ctaUrl || '',
        audience: campaignSummaryLines(a).find((l) => l.startsWith('Audience:'))?.replace('Audience: ', '') || '',
        approvers: approvalSummary(a).approvers.map((x) => x.label),
        promo: a.config.promo?.source && a.config.promo.source !== 'none'
          ? { type: a.config.promo.type === 'discount' ? 'Discount' : 'Promo', code: a.config.promo.code || '', benefit: a.config.promo.benefit || '', source: a.config.promo.source }
          : null,
        utm: a.config.utm || {},
        scheduledAt: a.config.scheduledAt || '',
      },
    });
  });

  // ── Recurring automations: the daily check ──────────────────────────────────
  // Every active automation ('auto') re-runs its audience tile roughly daily;
  // anyone NEW (never reached by this campaign family, not suppressed) is
  // queued as a child DRAFT for explicit human approval — automation proposes,
  // a person approves. The synthetic admin user scopes exactly like a real one.
  async function autoCheck() {
    if (!enabled()) return;
    const due = sql.prepare("SELECT id FROM actions WHERE status='auto' AND (last_check='' OR last_check < ?)")
      .all(new Date(Date.now() - 20 * 3600e3).toISOString());
    for (const { id } of due) {
      const a = getAction(id);
      if (!a) continue;
      sql.prepare('UPDATE actions SET last_check=? WHERE id=?').run(now(), a.id);
      // Drip sequences enroll new abandoners instead of queuing child drafts.
      if (a.config.campaignMode === 'sequence') { try { await enrollSequence(a); } catch (e) { console.error('[actions] enroll failed', a.id, e.message); } continue; }
      try {
        const sysUser = { id: 'auto-check', email: 'auto@pulse', role: 'admin', entityIds: [] };
        const { list } = await audienceFor(a.entityId, a.config, sysUser);
        const already = new Set(sql.prepare('SELECT email FROM action_sent WHERE root_id=?').all(a.id).map((r) => r.email));
        const fresh = list.filter((r) => !already.has(r.email));
        if (!fresh.length) continue;
        const childId = uuid();
        const cfg = { ...a.config, audience: { ...a.config.audience, mode: 'snapshot' }, clickToken: crypto.randomBytes(6).toString('base64url') };
        const day = new Date().toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
        sql.prepare('INSERT INTO actions (id, entity_id, type, status, title, config, audience, parent_id, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .run(childId, a.entityId, 'email_campaign', 'draft', `${a.title || 'Campaign'} — ${day} (${fresh.length} new)`.slice(0, 120),
            JSON.stringify(cfg), JSON.stringify(fresh), a.id, 'automation', now(), now());
        console.log(`[actions] automation "${a.title}" queued ${fresh.length} new recipient(s) for approval`);
        // Nudge the client's team: a campaign is waiting for a human to approve.
        // Action buttons (Approve/Review) where supported; tap always deep-links
        // to the campaign. requireInteraction — it's a decision, not an FYI.
        if (push?.isEnabled?.()) {
          push.sendToEntity(a.entityId, {
            title: 'Campaign ready for approval',
            body: `${a.title || 'A campaign'} — ${fresh.length} new recipient${fresh.length === 1 ? '' : 's'} waiting for your go-ahead.`,
            url: `/actions?action=${childId}`,
            tag: `action-${childId}`,
            requireInteraction: true,
            actions: [{ action: `approve:${a.entityId}:${childId}`, title: 'Approve' }, { action: 'review', title: 'Review' }],
          }, 'alerts').catch(() => {});
        }
      } catch (e) { console.error('[actions] auto-check failed', a.id, e.message); }
    }
  }
  const autoTimer = setInterval(() => autoCheck().catch(() => {}), 10 * 60000);
  if (autoTimer.unref) autoTimer.unref();
  setTimeout(() => autoCheck().catch(() => {}), 20000);

  // ── Drip sequences: enrollment + the per-recipient send tick ─────────────────
  const sysUser = { id: 'auto-check', email: 'auto@pulse', role: 'admin', entityIds: [] };
  // In 'list' conversion mode, resolve the separate conversion source (attendance /
  // completed-orders) → lowercased set of emails that have converted. Null for the
  // default 'dropout' model (callers keep prior behaviour); consent ignored (we only
  // need the emails); failures fall back to null so a broken source can't flag everyone.
  async function convertedEmails(action) {
    const conv = action.config && action.config.conversion;
    if (!conv || conv.mode !== 'list' || !conv.source) return null;
    try {
      const subCfg = { ...action.config, audience: conv.source, ignoreConsent: true, channel: 'email' };
      const { list } = await audienceFor(action.entityId, subCfg, sysUser);
      return new Set(list.map((r) => String(r.email || '').toLowerCase()).filter(Boolean));
    } catch (e) { console.error('[actions] conversion source failed', action.id, e.message); return null; }
  }
  const parseAnchor = (raw) => { const t = raw ? Date.parse(String(raw)) : NaN; return Number.isFinite(t) ? new Date(t) : null; };
  const stepDue = (anchorMs, delayHours) => new Date(anchorMs + (delayHours || 0) * 3600e3).toISOString();

  // Enroll any NEW abandoners into the sequence at step 0. Anchor = the row's
  // abandonment timestamp (if a column is mapped), else now (detection time).
  async function enrollSequence(a) {
    const steps = a.config.steps || [];
    if (!steps.length) return;
    const usesUniqueCodes = (a.config.promo || {}).source === 'unique';
    const { list } = await audienceFor(a.entityId, a.config, sysUser);
    const enrolled = new Set(sql.prepare('SELECT email FROM action_enrollments WHERE action_id=?').all(a.id).map((r) => r.email));
    const ins = sql.prepare('INSERT OR IGNORE INTO action_enrollments (action_id, email, name, ticket, phone, anchor_at, step_index, next_at, status, enrolled_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    // Drip timing mode (see cleanConfig): 'send' runs forward from enrolment for
    // the whole list; 'abandonment' anchors on each person's abandonment time and
    // enrols only FRESH ones (within freshHours); '' is legacy (anchor if mapped).
    const dripStart = a.config.dripStart || '';
    const freshMs = (Number(a.config.freshHours) || 48) * 3600e3;
    let n = 0; let pausedForCodes = false; let skippedStale = 0;
    for (const r of list) {
      if (enrolled.has(r.email)) continue;
      // Unique-code campaigns reserve a code at enrollment. If the pool is empty,
      // PAUSE new enrollments (those already in the journey keep their code).
      if (usesUniqueCodes && !assignPromo(a.id, r.email)) { pausedForCodes = true; break; }
      const anchorMs = dripStart === 'send' ? Date.now() : (parseAnchor(r.anchorRaw) || new Date()).getTime();
      // Fresh-only: in abandonment mode, don't enrol anyone past the window.
      if (dripStart === 'abandonment' && (Date.now() - anchorMs) > freshMs) { skippedStale += 1; continue; }
      ins.run(a.id, r.email, r.name || '', r.ticket || '', r.phone || '', new Date(anchorMs).toISOString(), 0, stepDue(anchorMs, steps[0].delayHours), 'active', now(), now());
      n += 1;
    }
    if (skippedStale) console.log(`[actions] sequence "${a.title}" skipped ${skippedStale} stale (outside ${a.config.freshHours || 48}h fresh window)`);
    const res = a.results || {};
    if (n || res.codesEmpty !== pausedForCodes) saveResults(a.id, { ...res, enrolled: (res.enrolled || 0) + n, codesEmpty: pausedForCodes });
    if (n) console.log(`[actions] sequence "${a.title}" enrolled ${n} new`);
    if (pausedForCodes) {
      console.log(`[actions] sequence "${a.title}" paused enrolment — promo codes exhausted`);
      if (push?.isEnabled?.()) push.sendToEntity(a.entityId, { title: 'Promo codes running out', body: `"${a.title || 'Your campaign'}" has paused new sign-ups — upload more codes to resume.`, url: `/actions?action=${a.id}`, tag: `codes-${a.id}` }, 'alerts').catch(() => {});
    }
  }

  // Process all due steps: re-run the audience (droppers have bought/expired → stop),
  // send the due step to those still active, advance them. Re-entrancy guard: a large
  // batch (~1,500 paced at 120ms) can take ~3 min (≈ the timer interval); next_at/
  // step_index advance only AFTER each send, so an overlapping run would re-send the
  // same step — the flag makes it a no-op until this one drains.
  let processing = false;
  async function processSequences() {
    if (!enabled()) return;
    if (processing) return; // a previous (slow) run is still in flight — skip
    processing = true;
    try {
    const dueRows = sql.prepare("SELECT DISTINCT action_id FROM action_enrollments WHERE status='active' AND next_at <= ?").all(now());
    for (const { action_id } of dueRows) {
      const a = getAction(action_id);
      if (!a || a.status !== 'auto' || a.config.campaignMode !== 'sequence') continue;
      const steps = a.config.steps || [];
      const branding = mailer.resolveBranding(a.entityId, a.config?.eventSuiteId || '');
      let reachable = new Map(); // email -> { emailOk, smsOk } (re-evaluated live, so consent changes apply mid-journey)
      try { const { list } = await audienceFor(a.entityId, a.config, sysUser); for (const r of list) reachable.set(r.email, r); }
      catch (e) { console.error('[actions] sequence audience re-check failed', a.id, e.message); continue; }
      // 'list' conversion mode: confirm conversions against a separate attendance/
      // orders source (null = the default 'left the audience' model).
      const convSet = await convertedEmails(a);
      const sup = suppressed(a.entityId);
      const due = sql.prepare("SELECT * FROM action_enrollments WHERE action_id=? AND status='active' AND next_at <= ?").all(a.id, now());
      let sent = 0; let converted = 0; let emailSent = 0; let smsSent = 0;
      let n2 = 0;
      for (const e of due) {
        // Kill switch: if the sequence is paused mid-batch, stop sending now
        // (re-checked every 20) rather than draining the whole due list.
        if (n2 > 0 && n2 % 20 === 0 && getAction(a.id)?.status !== 'auto') break;
        n2 += 1;
        if (sup.has(e.email)) { sql.prepare("UPDATE action_enrollments SET status='unsubscribed', updated_at=? WHERE action_id=? AND email=?").run(now(), a.id, e.email); continue; }
        // Conversion / drop-out. 'list' mode: converted = in the conversion source;
        // left-the-audience-but-not-in-list just ends ('done'). Default mode:
        // converted = gone from the abandoned audience (bought or expired).
        if (convSet) {
          if (convSet.has(String(e.email || '').toLowerCase())) { sql.prepare("UPDATE action_enrollments SET status='converted', updated_at=? WHERE action_id=? AND email=?").run(now(), a.id, e.email); converted += 1; continue; }
          if (!reachable.has(e.email)) { sql.prepare("UPDATE action_enrollments SET status='done', updated_at=? WHERE action_id=? AND email=?").run(now(), a.id, e.email); continue; }
        } else if (!reachable.has(e.email)) { sql.prepare("UPDATE action_enrollments SET status='converted', updated_at=? WHERE action_id=? AND email=?").run(now(), a.id, e.email); converted += 1; continue; }
        const step = steps[e.step_index];
        if (!step) { sql.prepare("UPDATE action_enrollments SET status='done', updated_at=? WHERE action_id=? AND email=?").run(now(), a.id, e.email); continue; }
        try {
          const consent = reachable.get(e.email) || {};
          // Merge fields resolve live from the re-checked audience row's attributes.
          const rcpt = { email: e.email, name: e.name, ticket: e.ticket, phone: e.phone, attributes: consent.attributes || {} };
          const wantsEmail = a.config.channel !== 'sms';
          const wantsSms = a.config.channel !== 'email';
          let ok = false;
          if (wantsEmail && e.email && consent.emailOk !== false) { const { html, text, subject } = renderFor(a, rcpt, step, e.step_index); const r = await mailer.send({ to: e.email, subject: subject || a.title || 'A reminder from your event', html, text, fromName: branding.senderName, kind: 'campaign', entity: a.entityId }); if (r.ok) { ok = true; emailSent += 1; } }
          if (wantsSms && e.phone && consent.smsOk !== false) { const r = await messaging.sendSms({ to: e.phone, text: renderSmsFor(a, rcpt, step, e.step_index) }); if (r.ok) { ok = true; smsSent += 1; } }
          if (ok) sent += 1;
        } catch (err) { console.error('[actions] sequence send failed', a.id, e.email, err.message); }
        // Advance to the next step (or finish).
        const nextIdx = e.step_index + 1;
        if (nextIdx >= steps.length) sql.prepare("UPDATE action_enrollments SET status='done', step_index=?, updated_at=? WHERE action_id=? AND email=?").run(nextIdx, now(), a.id, e.email);
        else sql.prepare('UPDATE action_enrollments SET step_index=?, next_at=?, updated_at=? WHERE action_id=? AND email=?').run(nextIdx, stepDue(Date.parse(e.anchor_at), steps[nextIdx].delayHours), now(), a.id, e.email);
        await new Promise((r) => setTimeout(r, 120)); // gentle rate
      }
      if (sent || converted) {
        const res = a.results || {};
        saveResults(a.id, { ...res, sent: (res.sent || 0) + sent, converted: (res.converted || 0) + converted, emailSent: (res.emailSent || 0) + emailSent, smsSent: (res.smsSent || 0) + smsSent });
      }
    }
    } finally {
      processing = false;
    }
  }
  const dripTimer = setInterval(() => processSequences().catch(() => {}), 3 * 60000);
  if (dripTimer.unref) dripTimer.unref();
  setTimeout(() => processSequences().catch(() => {}), 30000);

  // ── Conversion tracking for ONCE-OFF campaigns ──────────────────────────────
  // Sequences track conversions inline (drop-out = bought). For sent once-off
  // campaigns with a re-runnable tile audience, periodically re-run the abandoned
  // audience: anyone we emailed who's no longer in it has bought (or expired).
  // Recompute (idempotent), update results.converted. Bounded to recent sends.
  async function checkConversions() {
    if (!enabled()) return;
    const cutoff = new Date(Date.now() - 14 * 86400e3).toISOString(); // track for 14 days post-send
    const recheck = new Date(Date.now() - 6 * 3600e3).toISOString();  // at most every 6h per campaign
    const due = sql.prepare("SELECT id FROM actions WHERE status='done' AND approved_at > ? AND (last_check='' OR last_check < ?)").all(cutoff, recheck);
    for (const { id } of due) {
      const a = getAction(id);
      if (!a || a.config.campaignMode === 'sequence') continue;
      const listMode = a.config.conversion?.mode === 'list' && a.config.conversion?.source;
      // Dropout mode needs a re-runnable tile audience; list mode matches the
      // snapshot against a separate source, so any audience type works.
      if (!listMode && a.config.audience?.mode !== 'tile') continue;
      sql.prepare('UPDATE actions SET last_check=? WHERE id=?').run(now(), a.id);
      try {
        let converted;
        if (listMode) {
          const conv = await convertedEmails(a);
          if (!conv) continue; // source failed — leave the count as-is
          converted = (a.audience || []).filter((r) => conv.has(String(r.email || '').toLowerCase())).length;
        } else {
          const { list } = await audienceFor(a.entityId, a.config, sysUser);
          const stillAbandoning = new Set(list.map((r) => r.email));
          converted = (a.audience || []).filter((r) => !stillAbandoning.has(r.email)).length;
        }
        if (converted !== (a.results.converted || 0)) saveResults(a.id, { ...a.results, converted });
      } catch (e) { console.error('[actions] conversion check failed', a.id, e.message); }
    }
  }
  const convTimer = setInterval(() => checkConversions().catch(() => {}), 30 * 60000);
  if (convTimer.unref) convTimer.unref();
  setTimeout(() => checkConversions().catch(() => {}), 45000);

  // Crash recovery: a deploy mid-blast leaves campaigns stuck 'running'. Resume
  // after boot — the action_sends ledger means nobody is ever emailed twice.
  setTimeout(() => {
    if (!enabled()) return; // kill switch also stops resumes
    for (const r of sql.prepare("SELECT id FROM actions WHERE status='running'").all()) {
      console.log('[actions] resuming campaign interrupted by restart:', r.id);
      runCampaign(r.id).catch((e) => { console.error('[actions] resume failed', r.id, e.message); setStatus(r.id, 'failed'); });
    }
  }, 12000).unref?.();

  // ── public routes (no auth; registered before the SPA fallback) ──
  // Open pixel /o, tracked click /c, SMS short link /k, unsubscribe /u — the
  // burst-hot paths a blast generates. Extracted to actionTracking.js: indexed
  // token lookup, never parses the audience blob.
  require('./actionTracking').mount(app, { sql, now, saveResults, parseUnsubToken });

  console.log('[actions] action engine mounted', enabled() ? '(enabled)' : '(disabled — set actions_enabled=1)');
  // Campaigns for a client, newest first, WITHOUT the (PII-heavy) audience snapshot —
  // used by the Owl's getCampaigns tool. publicAction hides the audience + adds a count.
  const listForEntity = (entityId) => sql.prepare(`SELECT ${LIST_COLS} FROM actions WHERE entity_id=? ORDER BY created_at DESC LIMIT 100`).all(entityId).map((r) => publicAction(rowToAction(r)));
  // Programmatic create of a DRAFT campaign (the Owl/API commit path). ALWAYS
  // status 'draft' — never sends; a human approves in Engage. Same ownership +
  // campaigns.approve check + cleanConfig as the POST route (identical drafts).
  function createDraftCampaign({ entityId, title, config, user, via }) {
    if (!user || !entityId) return { ok: false, error: 'Missing user or client' };
    const isAdmin = user.role === 'admin';
    if (!(isAdmin || (user.entityIds || []).includes(entityId))) return { ok: false, error: 'Not allowed' };
    if (!isAdmin && auth.hasPermission && !auth.hasPermission(user, entityId, 'campaigns.approve')) {
      return { ok: false, error: "You don't have permission to create campaigns for this client." };
    }
    const id = uuid();
    const cfg = cleanConfig(config || {});
    sql.prepare('INSERT INTO actions (id, entity_id, type, status, title, config, recurring, created_by, created_via, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, entityId, 'email_campaign', 'draft', String(title || '').slice(0, 120), JSON.stringify(cfg), 0, (user.email || 'owl'), String(via || '').slice(0, 20), now(), now());
    return { ok: true, action: publicAction(getAction(id)) };
  }
  return { awaitingApprovalFor, unseenOutcomesFor, audienceFor, listForEntity, draftCopy, createDraftCampaign };
}

// Pure helpers exported for unit testing (list parsing + Google Sheet URL).
module.exports = { mount, parseContactLines, googleSheetCsvUrl };
