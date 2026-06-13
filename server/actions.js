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

const MAX_AUDIENCE = 2000;       // v1 safety cap per campaign
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function mount(app, { db, auth, mailer, push, resolveAudience, draftCopy, listEvents }) {
  const sql = db.db;
  const now = () => new Date().toISOString();
  const uuid = () => crypto.randomUUID();
  const enabled = () => db.getSetting('actions_enabled', '1') !== '0';

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

    -- Memory for recurring automations: who a campaign family has already
    -- emailed, so the daily check only queues NEW people.
    CREATE TABLE IF NOT EXISTS action_sent (
      root_id TEXT NOT NULL,
      email   TEXT NOT NULL,
      at      TEXT NOT NULL,
      PRIMARY KEY (root_id, email)
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
  } catch (e) { console.error('[actions] recurring migration skipped:', e.message); }

  // ── helpers ──
  const rowToAction = (r) => ({
    id: r.id, entityId: r.entity_id, type: r.type, status: r.status, title: r.title,
    config: JSON.parse(r.config || '{}'), audience: JSON.parse(r.audience || '[]'),
    results: JSON.parse(r.results || '{}'),
    recurring: !!r.recurring, parentId: r.parent_id || '', lastCheck: r.last_check || '',
    createdBy: r.created_by, approvedBy: r.approved_by, approvedAt: r.approved_at,
    createdAt: r.created_at, updatedAt: r.updated_at,
  });
  const getAction = (id) => { const r = sql.prepare('SELECT * FROM actions WHERE id=?').get(id); return r ? rowToAction(r) : null; };
  // Public list shape: omit the full audience (can be thousands of emails).
  const publicAction = (a) => ({
    ...a, audience: undefined, audienceCount: a.audience.length,
    promoCodes: (a.config?.promo || {}).source === 'unique' ? promoStats(a.id) : null,
  });
  const saveResults = (id, results) => sql.prepare('UPDATE actions SET results=?, updated_at=? WHERE id=?').run(JSON.stringify(results), now(), id);
  const setStatus = (id, status) => sql.prepare('UPDATE actions SET status=?, updated_at=? WHERE id=?').run(status, now(), id);

  const suppressed = (entityId) => new Set(sql.prepare('SELECT email FROM action_suppressions WHERE entity_id=?').all(entityId).map((r) => r.email));
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
  const parseUnsubToken = (token) => {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig) return null;
    const want = crypto.createHmac('sha256', unsubSecret()).update(payload).digest('base64url').slice(0, 16);
    if (sig !== want) return null;
    try { const j = JSON.parse(Buffer.from(payload, 'base64url').toString()); return j.e && j.n ? j : null; } catch { return null; }
  };

  // Sanitise a draft config from the client.
  function cleanConfig(body) {
    const aud = body.audience || {};
    return {
      audience: {
        mode: ['paste', 'snapshot'].includes(aud.mode) ? aud.mode : 'tile',
        dashboardId: String(aud.dashboardId || ''),
        tileId: String(aud.tileId || ''),
        emailField: String(aud.emailField || ''),
        nameField: String(aud.nameField || ''),
        consentField: String(aud.consentField || ''),
        ticketField: String(aud.ticketField || ''),
        anchorField: String(aud.anchorField || ''), // abandonment timestamp column (drip timing)
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
      },
      // Delivery mode: 'once' = single send to the current list; 'sequence' = an
      // automated drip (enroll abandoners, send timed steps, drop on purchase).
      campaignMode: body.campaignMode === 'sequence' ? 'sequence' : 'once',
      // Sequence steps: each { delayHours, subject, body, ctaText }. delayHours is
      // measured from the anchor (abandonment) time. Capped + sorted on save.
      steps: Array.isArray(body.steps) ? body.steps.slice(0, 12).map((s) => ({
        delayHours: Math.max(0, Number(s.delayHours) || 0),
        subject: String(s.subject || '').slice(0, 200),
        body: String(s.body || '').slice(0, 8000),
        ctaText: String(s.ctaText || '').slice(0, 60),
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
      contentMode: body.contentMode === 'html' ? 'html' : 'template',
      eventSuiteId: String(body.eventSuiteId || ''),
      heroImage: String(body.heroImage || '').slice(0, 2000000),  // hero image data-URL/URL
      customHtml: String(body.customHtml || '').slice(0, 500000), // custom-HTML mode body
      subject: String(body.subject || '').slice(0, 200),
      body: String(body.body || '').slice(0, 8000),
      ctaText: String(body.ctaText || '').slice(0, 60),
      ctaUrl: String(body.ctaUrl || '').slice(0, 500),
      utm: {
        source: String(body.utm?.source || '').slice(0, 100),
        medium: String(body.utm?.medium || '').slice(0, 100),
        campaign: String(body.utm?.campaign || '').slice(0, 150),
        term: String(body.utm?.term || '').slice(0, 100),
        content: String(body.utm?.content || '').slice(0, 100),
      },
      goal: String(body.goal || '').slice(0, 1000),
      // Master campaign: a shared group name linking related segment campaigns
      // (e.g. one master "Bushfire abandoned cart" over VIP / GA / Cape Town
      // segments) so they manage + report together.
      master: String(body.master || '').slice(0, 80),
      // Which template (recipe) this campaign came from — labels it and groups
      // it (e.g. 'Abandoned carts'), and helps the automation later.
      templateKey: String(body.templateKey || '').slice(0, 60),
      category: String(body.category || '').slice(0, 80),
      clickToken: body.clickToken || crypto.randomBytes(6).toString('base64url'),
    };
  }

  // Resolve the audience for a config: tile query (scoped) or pasted emails,
  // minus this client's suppression list. Returns { list, fields?, excluded }.
  const cellVal = (cell) => String((cell && (cell.value ?? cell)) || '').trim();
  const isYes = (v) => ['yes', 'y', 'true', '1', 'consented', 'opted in', 'opt in'].includes(String(v).trim().toLowerCase());

  // Does a tile row pass all the targeting filters? (AND across filters.)
  function rowPassesFilters(row, filters) {
    for (const fl of filters || []) {
      const cell = cellVal(row[fl.field]);
      if (fl.op === 'between') {
        const n = Number(String(cell).replace(/[^0-9.\-]/g, ''));
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

  async function audienceFor(entityId, cfg, user) {
    let raw = [];
    let fields = [];
    let noConsent = 0;
    let filteredOut = 0;
    if (cfg.audience.mode === 'paste') {
      raw = cfg.audience.pasted.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => EMAIL_RE.test(e)).map((email) => ({ email }));
    } else {
      if (!cfg.audience.dashboardId || !cfg.audience.tileId) return { list: [], fields: [], excluded: 0, noConsent: 0, filteredOut: 0 };
      const res = await resolveAudience({ entityId, dashboardId: cfg.audience.dashboardId, tileId: cfg.audience.tileId, user });
      fields = res.fields;
      const emailField = cfg.audience.emailField || res.fields.find((f) => /email/i.test(f.name) || /email/i.test(f.label))?.name || '';
      const nameField = cfg.audience.nameField || '';
      const consentField = cfg.audience.consentField || '';
      const ticketField = cfg.audience.ticketField || '';
      const anchorField = cfg.audience.anchorField || '';
      const filters = cfg.audience.filters || [];
      if (emailField) {
        for (const row of res.rows) {
          const email = cellVal(row[emailField]).toLowerCase();
          if (!EMAIL_RE.test(email)) continue;
          // Targeting filters (city/age/ticket category/…) — narrow the segment.
          if (filters.length && !rowPassesFilters(row, filters)) { filteredOut += 1; continue; }
          // Consent gate: when a consent column is chosen, only include "Yes".
          if (consentField && !isYes(cellVal(row[consentField]))) { noConsent += 1; continue; }
          raw.push({ email, name: nameField ? cellVal(row[nameField]) : '', ticket: ticketField ? cellVal(row[ticketField]) : '', anchorRaw: anchorField ? cellVal(row[anchorField]) : '' });
        }
      }
    }
    // Dedupe + suppression.
    const sup = suppressed(entityId);
    const seen = new Set();
    const list = [];
    let excluded = 0;
    for (const r of raw) {
      if (seen.has(r.email)) continue;
      seen.add(r.email);
      if (sup.has(r.email)) { excluded += 1; continue; }
      list.push(r);
      if (list.length >= MAX_AUDIENCE) break;
    }
    return { list, fields, excluded, noConsent, filteredOut };
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

  // Render one recipient's email. Tokens: {{name}}, {{ticketType}}, {{cta}},
  // {{unsubscribe}}. Two modes: the built branded template, or the client's own
  // uploaded HTML (we still inject tracking + a guaranteed unsubscribe link).
  function renderFor(action, recipient, step) {
    const cfg = action.config;
    // A drip step overrides the campaign-level copy (custom-HTML mode is
    // campaign-level only; steps use the branded template).
    const useSubject = step ? (step.subject || cfg.subject) : cfg.subject;
    const useBody = step ? (step.body || cfg.body) : cfg.body;
    const useCta = step ? (step.ctaText || cfg.ctaText) : cfg.ctaText;
    const firstName = (recipient.name || '').split(/\s+/)[0] || '';
    const ticket = recipient.ticket || '';
    // Per-recipient tracked link: the same signed token used for unsubscribe
    // identifies WHO clicked, powering the campaign report.
    const rtok = unsubToken(action.entityId, recipient.email);
    // Promo/discount code for this recipient. A 'promo' code can ride the buy
    // link (?promo=CODE); a 'discount' code is entered manually at checkout.
    const promo = promoForRecipient(action, recipient.email);
    const appendPromo = promo && promo.type === 'promo' && promo.appendToLink && promo.code;
    const baseClick = cfg.ctaUrl ? `${mailer.baseUrl()}/c/${cfg.clickToken}/${rtok}` : '';
    const ctaUrl = baseClick && appendPromo ? `${baseClick}${baseClick.includes('?') ? '&' : '?'}promo=${encodeURIComponent(promo.code)}` : baseClick;
    const unsubUrl = `${mailer.baseUrl()}/u/${rtok}`;
    const tok = (s) => String(s || '')
      .replace(/\{\{\s*name\s*\}\}/gi, firstName || 'there')
      .replace(/\{\{\s*(ticket_?type|ticket)\s*\}\}/gi, ticket || 'your tickets')
      .replace(/\{\{\s*cta(_url)?\s*\}\}/gi, ctaUrl || '#')
      .replace(/\{\{\s*promo_benefit\s*\}\}/gi, promo?.benefit || '')
      .replace(/\{\{\s*promo(_?code)?\s*\}\}/gi, promo?.code || '')
      .replace(/\{\{\s*unsubscribe\s*\}\}/gi, unsubUrl);
    const subject = tok(useSubject);

    if (!step && cfg.contentMode === 'html' && (cfg.customHtml || '').trim()) {
      let html = tok(cfg.customHtml);
      // Guarantee an unsubscribe link (compliance) if the author didn't include one.
      if (!/unsubscrib/i.test(html)) {
        const footer = `<div style="font-size:11px;color:#888;text-align:center;padding:18px;font-family:-apple-system,Segoe UI,Roboto,sans-serif;">Sent via Howler : Pulse · <a href="${unsubUrl}" style="color:#888;">Unsubscribe</a></div>`;
        html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${footer}</body>`) : html + footer;
      }
      const text = `${tok(cfg.customHtml).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000)}\n\nUnsubscribe: ${unsubUrl}`;
      return { html, text, subject };
    }

    // Hero image: hosted by action id for real sends (email clients strip
    // data-URLs); inline for preview/test so it shows live.
    const realSend = action.id && !['preview', 'test'].includes(action.id);
    const heroImage = cfg.heroImage
      ? (cfg.heroImage.startsWith('data:') && realSend ? `${mailer.baseUrl()}/mail-assets/campaign/${action.id}` : cfg.heroImage)
      : '';
    const { html, text } = mailer.campaignEmail({ entityId: action.entityId, assetScope: action.entityId, subject, bodyText: tok(useBody), ctaText: useCta || 'View event', ctaUrl, unsubUrl, heroImage, promo });
    return { html, text, subject };
  }

  // Execute: send to every recipient in the snapshot. Runs detached; the UI
  // polls status. Mailer failures are counted, never crash the loop.
  async function runCampaign(actionId) {
    const a = getAction(actionId);
    if (!a || a.status !== 'running') return;
    const branding = mailer.resolveBranding(a.entityId);
    const results = { sent: 0, failed: 0, clicks: a.results.clicks || 0, total: a.audience.length, startedAt: now() };
    saveResults(a.id, results);
    for (const recipient of a.audience) {
      try {
        const { html, text, subject } = renderFor(a, recipient);
        const r = await mailer.send({ to: recipient.email, subject: subject || a.title || 'An update from your event', html, text, fromName: branding.senderName, kind: 'campaign', entity: a.entityId });
        if (r.ok) results.sent += 1; else { results.failed += 1; results.lastError = r.error || r.reason || 'send failed'; }
      } catch (e) { results.failed += 1; results.lastError = e.message; }
      if ((results.sent + results.failed) % 20 === 0) saveResults(a.id, results);
      await new Promise((res) => setTimeout(res, 120)); // gentle rate (~8/sec)
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
      const s = byName.get(name) || { campaigns: 0, sent: 0, clicks: 0, converted: 0, enrolled: 0 };
      s.campaigns += 1; s.sent += a.results.sent || 0; s.clicks += a.results.clicks || 0;
      s.converted += a.results.converted || 0; s.enrolled += a.results.enrolled || 0;
      byName.set(name, s);
    }
    // Union of records (which may have a target but no campaigns yet) + used names.
    const recs = new Map(sql.prepare('SELECT name, target FROM campaign_masters WHERE entity_id=?').all(entityId).map((r) => [r.name, r.target]));
    for (const n of byName.keys()) if (!recs.has(n)) recs.set(n, 0);
    return [...recs.entries()].map(([name, target]) => ({ name, target, stats: byName.get(name) || { campaigns: 0, sent: 0, clicks: 0, converted: 0, enrolled: 0 } }))
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
    const rows = sql.prepare('SELECT * FROM actions WHERE entity_id=? ORDER BY created_at DESC LIMIT 100').all(req.params.entityId);
    res.json({ actions: rows.map((r) => publicAction(rowToAction(r))) });
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
  app.get('/mail-assets/campaign/:id', (req, res) => {
    const a = getAction(req.params.id);
    const img = a?.config?.heroImage || '';
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
      const { list, fields, excluded, noConsent, filteredOut } = await audienceFor(req.params.entityId, cfg, req.user);
      res.json({ count: list.length, excluded, noConsent, filteredOut, sample: list.slice(0, 8), fields: (fields || []).map((f) => ({ name: f.name, label: f.label })) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Distinct values for a tile column — powers the targeting filter multi-select.
  app.post('/api/actions/:entityId/field-values', auth.requireAuth, auth.requirePermission('campaigns.view'), async (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const { dashboardId, tileId, field } = req.body || {};
    if (!dashboardId || !tileId || !field) return res.json({ values: [] });
    try {
      const r = await resolveAudience({ entityId: req.params.entityId, dashboardId, tileId, user: req.user });
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
      const out = await draftCopy({ entityId: req.params.entityId, goal: String((req.body || {}).goal || '').slice(0, 1000), audienceCount: Number((req.body || {}).audienceCount) || 0 });
      res.json(out);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Email preview (sample recipient) + test-send to self.
  app.post('/api/actions/:entityId/preview-email', auth.requireAuth, auth.requirePermission('campaigns.approve'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const fake = { id: 'preview', entityId: req.params.entityId, config: cleanConfig(req.body || {}) };
    const { html } = renderFor(fake, { email: 'sam@example.com', name: 'Sam', ticket: 'General Admission' });
    res.json({ html });
  });
  app.post('/api/actions/:entityId/test-send', auth.requireAuth, auth.requirePermission('campaigns.approve'), async (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const fake = { id: 'test', entityId: req.params.entityId, config: cleanConfig(req.body || {}) };
    const { html, text, subject } = renderFor(fake, { email: req.user.email, name: '', ticket: 'General Admission' });
    const branding = mailer.resolveBranding(req.params.entityId);
    const r = await mailer.send({ to: req.user.email, subject: `[TEST] ${subject || 'Campaign'}`, html, text, fromName: branding.senderName, kind: 'test', entity: req.params.entityId });
    r.ok ? res.json({ ok: true, to: req.user.email }) : res.status(400).json({ error: r.error || r.reason || 'not configured' });
  });

  // APPROVE & SEND — the human gate. Snapshots the audience at this moment and
  // kicks off the send. Both Howler admins and the client's own users may approve.
  app.post('/api/actions/:entityId/:id/approve', auth.requireAuth, auth.requirePermission('campaigns.approve'), async (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const a = getAction(req.params.id);
    if (!a || a.entityId !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    if (a.status !== 'draft') return res.status(400).json({ error: `Cannot approve a ${a.status} campaign` });
    const isSequence = a.config.campaignMode === 'sequence';
    if (isSequence) {
      const s0 = (a.config.steps || [])[0];
      if (!s0 || !s0.subject || !s0.body) return res.status(400).json({ error: 'Add at least one step with a subject and body' });
    } else if (!a.config.subject || !a.config.body) {
      return res.status(400).json({ error: 'Subject and body are required' });
    }

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

  // Pause a recurring automation (back to draft; the check stops).
  app.post('/api/actions/:entityId/:id/pause', auth.requireAuth, auth.requirePermission('campaigns.approve'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const a = getAction(req.params.id);
    if (!a || a.entityId !== req.params.entityId || a.status !== 'auto') return res.status(400).json({ error: 'Not an active automation' });
    setStatus(a.id, 'draft');
    res.json({ ok: true });
  });

  // Detailed campaign report: per-recipient clicks (who, how many, when),
  // plus the summary. Names come from the audience snapshot.
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
    res.json({
      title: a.title || a.config.subject, status: a.status, approvedBy: a.approvedBy, approvedAt: a.approvedAt,
      sent, failed: a.results.failed || 0, total: a.results.total ?? a.audience.length,
      totalClicks, uniqueClickers: clickers.length, anonClicks,
      // CTR mirrors the card (total clicks / sent) so the two never disagree.
      ctr: sent > 0 ? Math.min(100, Math.round((totalClicks / sent) * 100)) : 0,
      clickers,
      nonClickers: a.audience.filter((r) => !clickers.some((c) => c.email === r.email)).length,
      attributed: clickers.length > 0 || tableAnon > 0,
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
          }).catch(() => {});
        }
      } catch (e) { console.error('[actions] auto-check failed', a.id, e.message); }
    }
  }
  const autoTimer = setInterval(() => autoCheck().catch(() => {}), 10 * 60000);
  if (autoTimer.unref) autoTimer.unref();
  setTimeout(() => autoCheck().catch(() => {}), 20000);

  // ── Drip sequences: enrollment + the per-recipient send tick ─────────────────
  const sysUser = { id: 'auto-check', email: 'auto@pulse', role: 'admin', entityIds: [] };
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
    const ins = sql.prepare('INSERT OR IGNORE INTO action_enrollments (action_id, email, name, ticket, anchor_at, step_index, next_at, status, enrolled_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
    let n = 0; let pausedForCodes = false;
    for (const r of list) {
      if (enrolled.has(r.email)) continue;
      // Unique-code campaigns reserve a code at enrollment. If the pool is empty,
      // PAUSE new enrollments (those already in the journey keep their code).
      if (usesUniqueCodes && !assignPromo(a.id, r.email)) { pausedForCodes = true; break; }
      const anchor = parseAnchor(r.anchorRaw) || new Date();
      ins.run(a.id, r.email, r.name || '', r.ticket || '', anchor.toISOString(), 0, stepDue(anchor.getTime(), steps[0].delayHours), 'active', now(), now());
      n += 1;
    }
    const res = a.results || {};
    if (n || res.codesEmpty !== pausedForCodes) saveResults(a.id, { ...res, enrolled: (res.enrolled || 0) + n, codesEmpty: pausedForCodes });
    if (n) console.log(`[actions] sequence "${a.title}" enrolled ${n} new`);
    if (pausedForCodes) {
      console.log(`[actions] sequence "${a.title}" paused enrolment — promo codes exhausted`);
      if (push?.isEnabled?.()) push.sendToEntity(a.entityId, { title: 'Promo codes running out', body: `"${a.title || 'Your campaign'}" has paused new sign-ups — upload more codes to resume.`, url: `/actions?action=${a.id}`, tag: `codes-${a.id}` }).catch(() => {});
    }
  }

  // Process all due steps. Once per action: re-run the audience to know who's
  // still abandoning (anyone who dropped out has bought/expired → stop them),
  // then send the due step to those still active and advance them.
  async function processSequences() {
    if (!enabled()) return;
    const dueRows = sql.prepare("SELECT DISTINCT action_id FROM action_enrollments WHERE status='active' AND next_at <= ?").all(now());
    for (const { action_id } of dueRows) {
      const a = getAction(action_id);
      if (!a || a.status !== 'auto' || a.config.campaignMode !== 'sequence') continue;
      const steps = a.config.steps || [];
      const branding = mailer.resolveBranding(a.entityId);
      let stillAbandoning = new Set();
      try { const { list } = await audienceFor(a.entityId, a.config, sysUser); stillAbandoning = new Set(list.map((r) => r.email)); }
      catch (e) { console.error('[actions] sequence audience re-check failed', a.id, e.message); continue; }
      const sup = suppressed(a.entityId);
      const due = sql.prepare("SELECT * FROM action_enrollments WHERE action_id=? AND status='active' AND next_at <= ?").all(a.id, now());
      let sent = 0; let converted = 0;
      for (const e of due) {
        // Conversion / suppression: gone from the abandoned list = bought (or
        // expired); unsubscribed = removed. Either way, stop the journey.
        if (!stillAbandoning.has(e.email)) { sql.prepare("UPDATE action_enrollments SET status='converted', updated_at=? WHERE action_id=? AND email=?").run(now(), a.id, e.email); converted += 1; continue; }
        if (sup.has(e.email)) { sql.prepare("UPDATE action_enrollments SET status='unsubscribed', updated_at=? WHERE action_id=? AND email=?").run(now(), a.id, e.email); continue; }
        const step = steps[e.step_index];
        if (!step) { sql.prepare("UPDATE action_enrollments SET status='done', updated_at=? WHERE action_id=? AND email=?").run(now(), a.id, e.email); continue; }
        try {
          const { html, text, subject } = renderFor(a, { email: e.email, name: e.name, ticket: e.ticket }, step);
          const r = await mailer.send({ to: e.email, subject: subject || a.title || 'A reminder from your event', html, text, fromName: branding.senderName, kind: 'campaign', entity: a.entityId });
          if (r.ok) sent += 1;
        } catch (err) { console.error('[actions] sequence send failed', a.id, e.email, err.message); }
        // Advance to the next step (or finish).
        const nextIdx = e.step_index + 1;
        if (nextIdx >= steps.length) sql.prepare("UPDATE action_enrollments SET status='done', step_index=?, updated_at=? WHERE action_id=? AND email=?").run(nextIdx, now(), a.id, e.email);
        else sql.prepare('UPDATE action_enrollments SET step_index=?, next_at=?, updated_at=? WHERE action_id=? AND email=?').run(nextIdx, stepDue(Date.parse(e.anchor_at), steps[nextIdx].delayHours), now(), a.id, e.email);
        await new Promise((r) => setTimeout(r, 120)); // gentle rate
      }
      if (sent || converted) {
        const res = a.results || {};
        saveResults(a.id, { ...res, sent: (res.sent || 0) + sent, converted: (res.converted || 0) + converted });
      }
    }
  }
  const dripTimer = setInterval(() => processSequences().catch(() => {}), 3 * 60000);
  if (dripTimer.unref) dripTimer.unref();
  setTimeout(() => processSequences().catch(() => {}), 30000);

  // ── public routes (no auth; registered before the SPA fallback) ──
  // Tracked CTA click → count + redirect, with the campaign's UTM parameters
  // appended to the destination (clean URL in the email, full attribution in
  // the client's analytics). Existing query keys on the destination win.
  app.get('/c/:token/:rtok?', (req, res) => {
    const r = sql.prepare(`SELECT * FROM actions WHERE json_extract(config,'$.clickToken')=?`).get(req.params.token);
    if (!r) return res.redirect('/');
    const a = rowToAction(r);
    // Attribute the click when the link carries a valid recipient token.
    const who = req.params.rtok ? parseUnsubToken(req.params.rtok) : null;
    try { sql.prepare('INSERT INTO action_clicks (action_id, email, at) VALUES (?,?,?)').run(a.id, who?.e ? String(who.e).toLowerCase() : '', now()); } catch { /* never block the redirect */ }
    const results = { ...a.results, clicks: (a.results.clicks || 0) + 1, lastClickAt: now() };
    saveResults(a.id, results);
    let dest = a.config.ctaUrl || '/';
    try {
      const u = new URL(dest);
      const utm = a.config.utm || {};
      for (const [k, v] of Object.entries({ utm_source: utm.source, utm_medium: utm.medium, utm_campaign: utm.campaign, utm_term: utm.term, utm_content: utm.content })) {
        if (v && !u.searchParams.has(k)) u.searchParams.set(k, v);
      }
      dest = u.toString();
    } catch { /* relative or odd URL — redirect as-is */ }
    res.redirect(dest);
  });
  // Unsubscribe → suppression list + tiny confirmation page.
  app.get('/u/:token', (req, res) => {
    const t = parseUnsubToken(req.params.token);
    if (t) {
      sql.prepare('INSERT OR REPLACE INTO action_suppressions (entity_id, email, at, reason) VALUES (?,?,?,?)')
        .run(t.n, String(t.e).toLowerCase(), now(), 'unsubscribed');
    }
    res.set('Content-Type', 'text/html').send(`<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f5f7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;">
      <div style="background:#fff;border:1px solid #e8e8ec;border-radius:14px;padding:32px 36px;text-align:center;max-width:420px;">
        <div style="font-size:26px;margin-bottom:10px;">${t ? '✓' : '⚠'}</div>
        <div style="font-size:16px;font-weight:700;color:#111;margin-bottom:6px;">${t ? "You're unsubscribed" : 'Invalid link'}</div>
        <div style="font-size:13.5px;color:#6e6e73;line-height:1.5;">${t ? 'You will no longer receive campaign emails for this event organiser.' : 'This unsubscribe link is not valid.'}</div>
      </div></body></html>`);
  });

  console.log('[actions] action engine mounted', enabled() ? '(enabled)' : '(disabled — set actions_enabled=1)');
}

module.exports = { mount };
