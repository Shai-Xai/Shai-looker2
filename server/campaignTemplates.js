// ─── Campaign email templates — SELF-CONTAINED, DISPOSABLE MODULE ─────────────
// Reusable email CONTENT a user saves once and applies when building a campaign:
// subject + body (built-template) or custom HTML, a hero image, and the CTA button
// text. Per-client + dual-surface (admin manages a client's; the client manages
// their own), scoped server-side like segments. Promo/UTM/audience stay on the
// campaign — a template is just the message.
//
// Mount: require('./campaignTemplates').mount(app, { db, auth });
const crypto = require('crypto');
const { cleanBlocks } = require('./emailBlocks'); // block-builder content sanitiser

function mount(app, { db, auth }) {
  const sql = db.db;
  const now = () => new Date().toISOString();
  sql.exec(`CREATE TABLE IF NOT EXISTS campaign_templates (
    id           TEXT PRIMARY KEY,
    entity_id    TEXT NOT NULL,
    name         TEXT NOT NULL DEFAULT 'Untitled template',
    subject      TEXT NOT NULL DEFAULT '',
    content_mode TEXT NOT NULL DEFAULT 'template',  -- 'template' | 'html' | 'blocks'
    body         TEXT NOT NULL DEFAULT '',
    custom_html  TEXT NOT NULL DEFAULT '',
    blocks       TEXT NOT NULL DEFAULT '[]',        -- JSON block list (content_mode 'blocks')
    hero_image   TEXT NOT NULL DEFAULT '',
    cta_text     TEXT NOT NULL DEFAULT '',
    created_by   TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_campaign_templates_entity ON campaign_templates(entity_id);`);
  // Migration for DBs created before the block builder shipped.
  try { sql.exec("ALTER TABLE campaign_templates ADD COLUMN blocks TEXT NOT NULL DEFAULT '[]'"); } catch { /* already present */ }

  const canEntity = (req, entityId) => req.user.role === 'admin' || (req.user.entityIds || []).includes(entityId);
  const guard = (req, res, entityId) => { if (!canEntity(req, entityId)) { res.status(403).json({ error: 'Not allowed' }); return false; } return true; };
  const clean = (b = {}) => ({
    name: String(b.name || '').trim().slice(0, 120) || 'Untitled template',
    subject: String(b.subject || '').slice(0, 200),
    contentMode: ['html', 'blocks'].includes(b.contentMode) ? b.contentMode : 'template',
    body: String(b.body || '').slice(0, 8000),
    customHtml: String(b.customHtml || '').slice(0, 100000),
    blocks: JSON.stringify(cleanBlocks(b.blocks)),
    heroImage: String(b.heroImage || '').slice(0, 1500000),
    ctaText: String(b.ctaText || '').slice(0, 60),
  });
  const parseBlocks = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
  const row = (r) => ({ id: r.id, entityId: r.entity_id, name: r.name, subject: r.subject, contentMode: r.content_mode, body: r.body, customHtml: r.custom_html, blocks: parseBlocks(r.blocks), heroImage: r.hero_image, ctaText: r.cta_text, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at });
  const get = (id) => sql.prepare('SELECT * FROM campaign_templates WHERE id=?').get(id);

  app.get('/api/campaign-templates/:entityId', auth.requireAuth, auth.requirePermission('campaigns.view'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    res.json({ templates: sql.prepare('SELECT * FROM campaign_templates WHERE entity_id=? ORDER BY updated_at DESC LIMIT 200').all(req.params.entityId).map(row) });
  });
  app.post('/api/campaign-templates/:entityId', auth.requireAuth, auth.requirePermission('campaigns.approve'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const c = clean(req.body || {});
    const id = crypto.randomUUID(); const ts = now();
    sql.prepare('INSERT INTO campaign_templates (id,entity_id,name,subject,content_mode,body,custom_html,blocks,hero_image,cta_text,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, req.params.entityId, c.name, c.subject, c.contentMode, c.body, c.customHtml, c.blocks, c.heroImage, c.ctaText, req.user.email, ts, ts);
    res.status(201).json({ template: row(get(id)) });
  });
  app.put('/api/campaign-templates/:entityId/:id', auth.requireAuth, auth.requirePermission('campaigns.approve'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const cur = get(req.params.id);
    if (!cur || cur.entity_id !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    const c = clean(req.body || {});
    sql.prepare('UPDATE campaign_templates SET name=?,subject=?,content_mode=?,body=?,custom_html=?,blocks=?,hero_image=?,cta_text=?,updated_at=? WHERE id=?')
      .run(c.name, c.subject, c.contentMode, c.body, c.customHtml, c.blocks, c.heroImage, c.ctaText, now(), req.params.id);
    res.json({ template: row(get(req.params.id)) });
  });
  app.delete('/api/campaign-templates/:entityId/:id', auth.requireAuth, auth.requirePermission('campaigns.approve'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const cur = get(req.params.id);
    if (!cur || cur.entity_id !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    sql.prepare('DELETE FROM campaign_templates WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });

  console.log('[campaignTemplates] module mounted');
}

module.exports = { mount };
