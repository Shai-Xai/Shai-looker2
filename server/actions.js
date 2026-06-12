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

function mount(app, { db, auth, mailer, resolveAudience, draftCopy }) {
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
  `);

  // ── helpers ──
  const rowToAction = (r) => ({
    id: r.id, entityId: r.entity_id, type: r.type, status: r.status, title: r.title,
    config: JSON.parse(r.config || '{}'), audience: JSON.parse(r.audience || '[]'),
    results: JSON.parse(r.results || '{}'),
    createdBy: r.created_by, approvedBy: r.approved_by, approvedAt: r.approved_at,
    createdAt: r.created_at, updatedAt: r.updated_at,
  });
  const getAction = (id) => { const r = sql.prepare('SELECT * FROM actions WHERE id=?').get(id); return r ? rowToAction(r) : null; };
  // Public list shape: omit the full audience (can be thousands of emails).
  const publicAction = (a) => ({ ...a, audience: undefined, audienceCount: a.audience.length });
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
        mode: aud.mode === 'paste' ? 'paste' : 'tile',
        dashboardId: String(aud.dashboardId || ''),
        tileId: String(aud.tileId || ''),
        emailField: String(aud.emailField || ''),
        nameField: String(aud.nameField || ''),
        pasted: String(aud.pasted || '').slice(0, 200000),
      },
      subject: String(body.subject || '').slice(0, 200),
      body: String(body.body || '').slice(0, 8000),
      ctaText: String(body.ctaText || '').slice(0, 60),
      ctaUrl: String(body.ctaUrl || '').slice(0, 500),
      goal: String(body.goal || '').slice(0, 1000),
      clickToken: body.clickToken || crypto.randomBytes(6).toString('base64url'),
    };
  }

  // Resolve the audience for a config: tile query (scoped) or pasted emails,
  // minus this client's suppression list. Returns { list, fields?, excluded }.
  async function audienceFor(entityId, cfg, user) {
    let raw = [];
    let fields = [];
    if (cfg.audience.mode === 'paste') {
      raw = cfg.audience.pasted.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => EMAIL_RE.test(e)).map((email) => ({ email }));
    } else {
      if (!cfg.audience.dashboardId || !cfg.audience.tileId) return { list: [], fields: [], excluded: 0 };
      const res = await resolveAudience({ entityId, dashboardId: cfg.audience.dashboardId, tileId: cfg.audience.tileId, user });
      fields = res.fields;
      const emailField = cfg.audience.emailField || res.fields.find((f) => /email/i.test(f.name) || /email/i.test(f.label))?.name || '';
      const nameField = cfg.audience.nameField || '';
      if (emailField) {
        for (const row of res.rows) {
          const cell = row[emailField];
          const email = String((cell && (cell.value ?? cell)) || '').trim().toLowerCase();
          if (!EMAIL_RE.test(email)) continue;
          const nCell = nameField ? row[nameField] : null;
          raw.push({ email, name: nCell ? String(nCell.value ?? nCell ?? '').trim() : '' });
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
    return { list, fields, excluded };
  }

  // Render one recipient's email ({{name}} personalisation + tracked CTA + unsubscribe).
  function renderFor(action, recipient) {
    const cfg = action.config;
    const firstName = (recipient.name || '').split(/\s+/)[0] || '';
    const bodyText = cfg.body.replace(/\{\{\s*name\s*\}\}/gi, firstName || 'there');
    const ctaUrl = cfg.ctaUrl ? `${mailer.baseUrl()}/c/${cfg.clickToken}` : '';
    const unsubUrl = `${mailer.baseUrl()}/u/${unsubToken(action.entityId, recipient.email)}`;
    return mailer.campaignEmail({ entityId: action.entityId, assetScope: action.entityId, subject: cfg.subject, bodyText, ctaText: cfg.ctaText || 'View event', ctaUrl, unsubUrl });
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
        const { html, text } = renderFor(a, recipient);
        const r = await mailer.send({ to: recipient.email, subject: a.config.subject || a.title || 'An update from your event', html, text, fromName: branding.senderName });
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

  // List + CRUD (one set of handlers serves admin and client self-service).
  app.get('/api/actions/:entityId', auth.requireAuth, (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const rows = sql.prepare('SELECT * FROM actions WHERE entity_id=? ORDER BY created_at DESC LIMIT 100').all(req.params.entityId);
    res.json({ actions: rows.map((r) => publicAction(rowToAction(r))) });
  });
  app.post('/api/actions/:entityId', auth.requireAuth, (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const id = uuid();
    const cfg = cleanConfig(req.body || {});
    sql.prepare('INSERT INTO actions (id, entity_id, type, status, title, config, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, req.params.entityId, 'email_campaign', 'draft', String((req.body || {}).title || '').slice(0, 120), JSON.stringify(cfg), req.user.email, now(), now());
    res.status(201).json({ action: publicAction(getAction(id)) });
  });
  app.put('/api/actions/:entityId/:id', auth.requireAuth, (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const a = getAction(req.params.id);
    if (!a || a.entityId !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    if (a.status !== 'draft') return res.status(400).json({ error: 'Only drafts can be edited' });
    const cfg = { ...cleanConfig(req.body || {}), clickToken: a.config.clickToken };
    sql.prepare('UPDATE actions SET title=?, config=?, updated_at=? WHERE id=?')
      .run(String((req.body || {}).title || a.title).slice(0, 120), JSON.stringify(cfg), now(), a.id);
    res.json({ action: publicAction(getAction(a.id)) });
  });
  app.delete('/api/actions/:entityId/:id', auth.requireAuth, (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const a = getAction(req.params.id);
    if (!a || a.entityId !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    if (a.status === 'running') return res.status(400).json({ error: 'Cannot delete a running campaign' });
    sql.prepare('DELETE FROM actions WHERE id=?').run(a.id);
    res.status(204).end();
  });

  // Audience preview for an (unsaved) config: count + sample + field options.
  app.post('/api/actions/:entityId/audience-preview', auth.requireAuth, async (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    try {
      const cfg = cleanConfig(req.body || {});
      const { list, fields, excluded } = await audienceFor(req.params.entityId, cfg, req.user);
      res.json({ count: list.length, excluded, sample: list.slice(0, 8), fields: (fields || []).map((f) => ({ name: f.name, label: f.label })) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // AI-draft the campaign copy (editable afterwards).
  app.post('/api/actions/:entityId/draft-copy', auth.requireAuth, async (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    try {
      const out = await draftCopy({ entityId: req.params.entityId, goal: String((req.body || {}).goal || '').slice(0, 1000), audienceCount: Number((req.body || {}).audienceCount) || 0 });
      res.json(out);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Email preview (sample recipient) + test-send to self.
  app.post('/api/actions/:entityId/preview-email', auth.requireAuth, (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const fake = { id: 'preview', entityId: req.params.entityId, config: cleanConfig(req.body || {}) };
    const { html } = renderFor(fake, { email: 'sam@example.com', name: 'Sam' });
    res.json({ html });
  });
  app.post('/api/actions/:entityId/test-send', auth.requireAuth, async (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const fake = { id: 'test', entityId: req.params.entityId, config: cleanConfig(req.body || {}) };
    const { html, text } = renderFor(fake, { email: req.user.email, name: '' });
    const branding = mailer.resolveBranding(req.params.entityId);
    const r = await mailer.send({ to: req.user.email, subject: `[TEST] ${fake.config.subject || 'Campaign'}`, html, text, fromName: branding.senderName });
    r.ok ? res.json({ ok: true, to: req.user.email }) : res.status(400).json({ error: r.error || r.reason || 'not configured' });
  });

  // APPROVE & SEND — the human gate. Snapshots the audience at this moment and
  // kicks off the send. Both Howler admins and the client's own users may approve.
  app.post('/api/actions/:entityId/:id/approve', auth.requireAuth, async (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const a = getAction(req.params.id);
    if (!a || a.entityId !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    if (a.status !== 'draft') return res.status(400).json({ error: `Cannot approve a ${a.status} campaign` });
    if (!a.config.subject || !a.config.body) return res.status(400).json({ error: 'Subject and body are required' });
    try {
      const { list } = await audienceFor(a.entityId, a.config, req.user);
      if (!list.length) return res.status(400).json({ error: 'Audience is empty — nothing to send' });
      sql.prepare('UPDATE actions SET status=?, audience=?, approved_by=?, approved_at=?, updated_at=? WHERE id=?')
        .run('running', JSON.stringify(list), req.user.email, now(), now(), a.id);
      runCampaign(a.id).catch((e) => { console.error('[actions] run failed', a.id, e.message); setStatus(a.id, 'failed'); });
      res.json({ ok: true, sendingTo: list.length });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ── public routes (no auth; registered before the SPA fallback) ──
  // Tracked CTA click → count + redirect.
  app.get('/c/:token', (req, res) => {
    const r = sql.prepare(`SELECT * FROM actions WHERE json_extract(config,'$.clickToken')=?`).get(req.params.token);
    if (!r) return res.redirect('/');
    const a = rowToAction(r);
    const results = { ...a.results, clicks: (a.results.clicks || 0) + 1, lastClickAt: now() };
    saveResults(a.id, results);
    res.redirect(a.config.ctaUrl || '/');
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
