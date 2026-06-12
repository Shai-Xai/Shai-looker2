// ─── Scheduler: recurring & one-off jobs (scheduled digests) ───────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the `scheduled_jobs` table and all its
// routes (under /api/.../digests). Mounted from index.js with one line and a few
// injected deps. A 60-second tick runs anything due. Kill switch: settings key
// `scheduler_enabled` ('0' disables the tick + 404s the routes).
//
// Content generation lives in index.js (it owns Looker/AI/catalogue) and is
// injected as `generateContent`; this module owns scheduling + recipients +
// rendering-to-email (via mailer) + the send log.

const crypto = require('crypto');

const DEFAULT_TZ = 'Africa/Johannesburg'; // GMT+2
const ROLES = ['exec', 'marketing', 'finance', 'ops'];

function mount(app, { db, auth, mailer, push, generateContent, roleLenses }) {
  const sql = db.db;
  const now = () => new Date().toISOString();
  const uuid = () => crypto.randomUUID();
  const enabled = () => db.getSetting('scheduler_enabled', '1') !== '0';

  sql.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id           TEXT PRIMARY KEY,
      entity_id    TEXT NOT NULL,
      type         TEXT NOT NULL DEFAULT 'digest',
      title        TEXT NOT NULL DEFAULT '',
      role         TEXT NOT NULL DEFAULT 'exec',
      role_focus   TEXT NOT NULL DEFAULT '',        -- optional override/blend of the role lens
      focus_mode   TEXT NOT NULL DEFAULT 'override', -- override | blend (how role_focus combines with the lens)
      custom_message TEXT NOT NULL DEFAULT '',       -- a personal note rendered at the top of the email
      content_mode TEXT NOT NULL DEFAULT 'ai',       -- ai | curated
      tiles        TEXT NOT NULL DEFAULT '[]',       -- [{dashboardId,tileId}] for curated; tileId '*' = whole dashboard
      recipients   TEXT NOT NULL DEFAULT '[]',       -- [email]
      cadence      TEXT NOT NULL DEFAULT 'daily',     -- daily | weekly | once
      time_of_day  TEXT NOT NULL DEFAULT '07:00',
      weekday      INTEGER NOT NULL DEFAULT 1,        -- 0=Sun..6=Sat (weekly)
      run_at       TEXT NOT NULL DEFAULT '',          -- ISO (once)
      timezone     TEXT NOT NULL DEFAULT '${DEFAULT_TZ}',
      status       TEXT NOT NULL DEFAULT 'active',     -- active | paused | done
      last_run_at  TEXT NOT NULL DEFAULT '',
      last_status  TEXT NOT NULL DEFAULT '',
      next_run_at  TEXT,
      created_by   TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_due ON scheduled_jobs(status, next_run_at);
  `);
  // ALTER for DBs created before focus_mode existed.
  try {
    const cols = sql.prepare('PRAGMA table_info(scheduled_jobs)').all().map((c) => c.name);
    if (!cols.includes('focus_mode')) sql.exec("ALTER TABLE scheduled_jobs ADD COLUMN focus_mode TEXT NOT NULL DEFAULT 'override'");
    if (!cols.includes('custom_message')) sql.exec("ALTER TABLE scheduled_jobs ADD COLUMN custom_message TEXT NOT NULL DEFAULT ''");
  } catch (e) { console.error('[scheduler] column migration skipped:', e.message); }

  // ── timezone-aware schedule maths ──
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

  function computeNextRun(job, from = new Date()) {
    const tz = job.timezone || DEFAULT_TZ;
    if (job.cadence === 'once') { const t = job.runAt ? new Date(job.runAt) : null; return t && t > from ? t : null; }
    const [hh, mm] = String(job.timeOfDay || '07:00').split(':').map(Number);
    for (let i = 0; i < 8; i++) {
      const probe = new Date(from.getTime() + i * 86400000);
      const p = tzParts(tz, probe);
      const cand = wallToUtc(tz, +p.year, +p.month, +p.day, hh || 0, mm || 0);
      if (cand <= from) continue;
      if (job.cadence === 'weekly' && localWeekday(tz, cand) !== (job.weekday ?? 1)) continue;
      return cand;
    }
    return null;
  }

  // ── row <-> object ──
  const rowToJob = (r) => ({
    id: r.id, entityId: r.entity_id, type: r.type, title: r.title, role: r.role, roleFocus: r.role_focus, focusMode: r.focus_mode || 'override',
    customMessage: r.custom_message || '',
    contentMode: r.content_mode, tiles: JSON.parse(r.tiles || '[]'), recipients: JSON.parse(r.recipients || '[]'),
    cadence: r.cadence, timeOfDay: r.time_of_day, weekday: r.weekday, runAt: r.run_at, timezone: r.timezone,
    status: r.status, lastRunAt: r.last_run_at, lastStatus: r.last_status, nextRunAt: r.next_run_at,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  });
  const getJob = (id) => { const r = sql.prepare('SELECT * FROM scheduled_jobs WHERE id=?').get(id); return r ? rowToJob(r) : null; };
  const lensFor = (job) => (roleLenses[job.role] || roleLenses.exec);

  // Sanitise an incoming job patch from the client.
  function clean(body, entityId) {
    const role = ROLES.includes(body.role) ? body.role : 'exec';
    const cadence = ['daily', 'weekly', 'once'].includes(body.cadence) ? body.cadence : 'daily';
    return {
      entityId,
      title: String(body.title || '').slice(0, 80),
      role,
      roleFocus: String(body.roleFocus || '').slice(0, 1000),
      focusMode: body.focusMode === 'blend' ? 'blend' : 'override',
      customMessage: String(body.customMessage || '').slice(0, 2000),
      contentMode: body.contentMode === 'curated' ? 'curated' : 'ai',
      tiles: Array.isArray(body.tiles) ? body.tiles.filter((t) => t && t.dashboardId && t.tileId).slice(0, 40).map((t) => ({ dashboardId: String(t.dashboardId), tileId: String(t.tileId) })) : [],
      recipients: Array.isArray(body.recipients) ? [...new Set(body.recipients.map((e) => String(e).trim().toLowerCase()).filter(Boolean))].slice(0, 25) : [],
      cadence,
      timeOfDay: /^\d{1,2}:\d{2}$/.test(body.timeOfDay || '') ? body.timeOfDay : '07:00',
      weekday: Number.isInteger(body.weekday) && body.weekday >= 0 && body.weekday <= 6 ? body.weekday : 1,
      runAt: body.runAt ? String(body.runAt) : '',
      timezone: String(body.timezone || DEFAULT_TZ),
      status: body.status === 'paused' ? 'paused' : 'active',
    };
  }

  function upsert(id, j, createdBy) {
    const ts = now();
    const next = j.status === 'active' ? computeNextRun(j) : null;
    const nextIso = next ? next.toISOString() : (j.status === 'active' && j.cadence === 'once' && j.runAt ? new Date(j.runAt).toISOString() : null);
    if (id) {
      sql.prepare(`UPDATE scheduled_jobs SET title=?, role=?, role_focus=?, focus_mode=?, custom_message=?, content_mode=?, tiles=?, recipients=?, cadence=?, time_of_day=?, weekday=?, run_at=?, timezone=?, status=?, next_run_at=?, updated_at=? WHERE id=?`)
        .run(j.title, j.role, j.roleFocus, j.focusMode, j.customMessage, j.contentMode, JSON.stringify(j.tiles), JSON.stringify(j.recipients), j.cadence, j.timeOfDay, j.weekday, j.runAt, j.timezone, j.status, nextIso, ts, id);
      return getJob(id);
    }
    const nid = uuid();
    sql.prepare(`INSERT INTO scheduled_jobs (id, entity_id, type, title, role, role_focus, focus_mode, custom_message, content_mode, tiles, recipients, cadence, time_of_day, weekday, run_at, timezone, status, next_run_at, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(nid, j.entityId, 'digest', j.title, j.role, j.roleFocus, j.focusMode, j.customMessage, j.contentMode, JSON.stringify(j.tiles), JSON.stringify(j.recipients), j.cadence, j.timeOfDay, j.weekday, j.runAt, j.timezone, j.status, nextIso, createdBy || '', ts, ts);
    return getJob(nid);
  }

  // Render a job's email (real content; throws if generation fails).
  async function render(job, recipientEmail) {
    const lens = lensFor(job);
    const content = await generateContent({ entityId: job.entityId, role: job.role, roleFocus: job.roleFocus, focusMode: job.focusMode, contentMode: job.contentMode, tiles: job.tiles, recipientEmail });
    const branding = mailer.resolveBranding(job.entityId);
    const email = mailer.digestEmail({ branding, entityId: job.entityId, assetScope: job.entityId, content, roleLabel: lens.label, customMessage: job.customMessage });
    return { ...email, content, senderName: branding.senderName };
  }

  // Run a job: render once, send to all recipients. `manual` skips rescheduling.
  async function runJob(job, { manual, toOverride } = {}) {
    const recipients = toOverride ? [toOverride] : job.recipients.filter(Boolean);
    let result;
    if (!recipients.length) { result = { status: 'skipped', detail: 'no recipients' }; }
    else {
      try {
        const { html, text, subject, senderName } = await render(job, recipients[0]);
        let ok = 0, err = '';
        for (const to of recipients) {
          const r = await mailer.send({ to, subject: subject || `${lensFor(job).label} digest`, html, text, fromName: senderName, kind: 'digest', entity: job.entityId });
          if (r.ok) ok += 1; else err = r.error || r.reason || 'send failed';
        }
        result = ok ? { status: 'ok', detail: `sent to ${ok}` } : { status: 'error', detail: err };
        // Push nudge to the recipients who have push on — "your briefing is
        // ready", deep-linking home. Collapse tag = one per entity, so a new
        // day's nudge replaces the previous instead of stacking. Best-effort.
        if (ok && push?.isEnabled?.()) {
          try {
            const byEmail = new Map(db.listUsers().map((u) => [u.email, u]));
            const lensLabel = lensFor(job).label;
            for (const to of recipients) {
              const u = byEmail.get(to);
              if (u && u.notifyPush !== false) {
                push.sendToUser(u.id, {
                  title: 'Your briefing is ready',
                  body: `${lensLabel} digest for ${db.getEntity(job.entityId)?.name || 'your event'} just landed.`,
                  url: '/',
                  tag: `digest-${job.entityId}`,
                }).catch(() => {});
              }
            }
          } catch { /* push is best-effort */ }
        }
      } catch (e) { result = { status: 'error', detail: e.message }; }
    }
    if (!manual) {
      const next = job.cadence === 'once' ? null : computeNextRun(job);
      const newStatus = job.cadence === 'once' ? 'done' : job.status;
      sql.prepare('UPDATE scheduled_jobs SET last_run_at=?, last_status=?, next_run_at=?, status=?, updated_at=? WHERE id=?')
        .run(now(), `${result.status}: ${result.detail}`.slice(0, 300), next ? next.toISOString() : null, newStatus, now(), job.id);
    }
    return result;
  }

  // ── the tick ──
  async function tick() {
    if (!enabled()) return;
    const due = sql.prepare("SELECT * FROM scheduled_jobs WHERE status='active' AND next_run_at IS NOT NULL AND next_run_at <= ?").all(now());
    for (const r of due) { try { await runJob(rowToJob(r)); } catch (e) { console.error('[scheduler] job failed', r.id, e.message); } }
  }
  const timer = setInterval(() => tick().catch(() => {}), 60000);
  if (timer.unref) timer.unref();
  setTimeout(() => tick().catch(() => {}), 8000); // shortly after boot

  // ── routes ──
  const off = (res) => res.status(404).json({ error: 'Scheduler is disabled' });
  const lensList = () => ROLES.map((k) => ({ key: k, ...roleLenses[k] }));

  // Shared handlers (admin = any entity; client = own entity, enforced by caller).
  const listFor = (entityId, res) => res.json({ jobs: sql.prepare('SELECT * FROM scheduled_jobs WHERE entity_id=? ORDER BY created_at DESC').all(entityId).map(rowToJob), roles: lensList(), timezone: DEFAULT_TZ });
  const createFor = (entityId, body, who, res) => res.status(201).json({ job: upsert(null, clean(body, entityId), who) });
  const updateFor = (job, body, res) => res.json({ job: upsert(job.id, clean(body, job.entityId), job.createdBy) });

  // Admin — manage any client's digests.
  app.get('/api/admin/entities/:id/digests', auth.requireAdmin, (req, res) => enabled() ? listFor(req.params.id, res) : off(res));
  app.post('/api/admin/entities/:id/digests', auth.requireAdmin, (req, res) => enabled() ? createFor(req.params.id, req.body || {}, req.user.email, res) : off(res));
  app.put('/api/admin/digests/:jobId', auth.requireAdmin, (req, res) => { if (!enabled()) return off(res); const j = getJob(req.params.jobId); if (!j) return res.status(404).json({ error: 'Not found' }); updateFor(j, req.body || {}, res); });
  app.delete('/api/admin/digests/:jobId', auth.requireAdmin, (req, res) => { if (!enabled()) return off(res); sql.prepare('DELETE FROM scheduled_jobs WHERE id=?').run(req.params.jobId); res.status(204).end(); });
  // Run now → sends to the signed-in admin (a safe live test of the real content).
  app.post('/api/admin/digests/:jobId/test', auth.requireAdmin, async (req, res) => {
    if (!enabled()) return off(res);
    const j = getJob(req.params.jobId); if (!j) return res.status(404).json({ error: 'Not found' });
    const r = await runJob(j, { manual: true, toOverride: req.user.email });
    r.status === 'ok' ? res.json({ ok: true, to: req.user.email }) : res.status(400).json({ error: r.detail });
  });
  // Send the real thing now to the configured recipients (does not reschedule).
  app.post('/api/admin/digests/:jobId/run', auth.requireAdmin, async (req, res) => {
    if (!enabled()) return off(res);
    const j = getJob(req.params.jobId); if (!j) return res.status(404).json({ error: 'Not found' });
    const r = await runJob(j, { manual: true });
    r.status === 'ok' ? res.json({ ok: true, detail: r.detail }) : res.status(400).json({ error: r.detail });
  });
  // Live preview (renders real content; falls back to a labelled sample if AI
  // isn't configured yet, so the layout is always viewable).
  app.post('/api/admin/digests/preview', auth.requireAdmin, (req, res) => preview(req.body || {}, res));
  // Send a test of the CURRENT (possibly unsaved) editor config to the admin.
  app.post('/api/admin/digests/test-send', auth.requireAdmin, (req, res) => testSendConfig(req.body || {}, (req.body || {}).entityId, req.user.email, res));

  // Client self-service — own entity only.
  const ownsEntity = (req) => (req.user.entityIds || []).includes(req.params.entityId);
  app.get('/api/my/digests/:entityId', auth.requireAuth, auth.requirePermission('digests.manage'), (req, res) => { if (!enabled()) return off(res); if (!ownsEntity(req)) return res.status(403).json({ error: 'Not allowed' }); listFor(req.params.entityId, res); });
  app.post('/api/my/digests/:entityId', auth.requireAuth, auth.requirePermission('digests.manage'), (req, res) => { if (!enabled()) return off(res); if (!ownsEntity(req)) return res.status(403).json({ error: 'Not allowed' }); createFor(req.params.entityId, req.body || {}, req.user.email, res); });
  app.put('/api/my/digests/:entityId/:jobId', auth.requireAuth, auth.requirePermission('digests.manage'), (req, res) => { if (!enabled()) return off(res); if (!ownsEntity(req)) return res.status(403).json({ error: 'Not allowed' }); const j = getJob(req.params.jobId); if (!j || j.entityId !== req.params.entityId) return res.status(404).json({ error: 'Not found' }); updateFor(j, req.body || {}, res); });
  app.delete('/api/my/digests/:entityId/:jobId', auth.requireAuth, auth.requirePermission('digests.manage'), (req, res) => { if (!enabled()) return off(res); if (!ownsEntity(req)) return res.status(403).json({ error: 'Not allowed' }); const j = getJob(req.params.jobId); if (!j || j.entityId !== req.params.entityId) return res.status(404).json({ error: 'Not found' }); sql.prepare('DELETE FROM scheduled_jobs WHERE id=?').run(j.id); res.status(204).end(); });
  app.post('/api/my/digests/:entityId/:jobId/test', auth.requireAuth, auth.requirePermission('digests.manage'), async (req, res) => {
    if (!enabled()) return off(res); if (!ownsEntity(req)) return res.status(403).json({ error: 'Not allowed' });
    const j = getJob(req.params.jobId); if (!j || j.entityId !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    const r = await runJob(j, { manual: true, toOverride: req.user.email });
    r.status === 'ok' ? res.json({ ok: true, to: req.user.email }) : res.status(400).json({ error: r.detail });
  });
  app.post('/api/my/digests/:entityId/preview', auth.requireAuth, auth.requirePermission('digests.manage'), (req, res) => { if (!enabled()) return off(res); if (!ownsEntity(req)) return res.status(403).json({ error: 'Not allowed' }); preview({ ...req.body, entityId: req.params.entityId }, res); });
  app.post('/api/my/digests/:entityId/test-send', auth.requireAuth, auth.requirePermission('digests.manage'), (req, res) => { if (!enabled()) return off(res); if (!ownsEntity(req)) return res.status(403).json({ error: 'Not allowed' }); testSendConfig({ ...req.body, entityId: req.params.entityId }, req.params.entityId, req.user.email, res); });

  // Render + send the current (unsaved) config as a test to one address.
  async function testSendConfig(body, entityId, toEmail, res) {
    if (!entityId) return res.status(400).json({ error: 'entityId required' });
    const job = { ...clean(body, entityId), id: 'test' };
    const r = await runJob(job, { manual: true, toOverride: toEmail });
    return r.status === 'ok' ? res.json({ ok: true, to: toEmail }) : res.status(400).json({ error: r.detail });
  }

  // Render a preview email from an (unsaved) job config.
  // body.live=false (the default) renders the SAMPLE layout instantly — used by
  // the editor's debounced auto-preview so layout/branding updates are free.
  // body.live=true does the real thing (Looker pulls + AI write — can take
  // 30-60s, costs tokens) — used by the explicit Refresh button.
  async function preview(body, res) {
    const entityId = body.entityId;
    if (!entityId) return res.status(400).json({ error: 'entityId required' });
    const job = { ...clean(body, entityId), id: 'preview' };
    const lens = lensFor(job);
    const sample = (reason) => {
      const content = sampleContent(lens.label);
      const branding = mailer.resolveBranding(entityId);
      const { html, subject } = mailer.digestEmail({ branding, entityId, assetScope: entityId, content, roleLabel: lens.label, customMessage: job.customMessage });
      res.json({ html, subject, sample: true, reason: reason || '' });
    };
    if (!body.live) return sample('');
    try {
      const { html, subject } = await render(job, (job.recipients[0] || ''));
      res.json({ html, subject, sample: false, generatedAt: new Date().toISOString() });
    } catch (e) {
      // Fall back to the sample layout, but SURFACE the reason so the editor
      // can show why live data didn't come back.
      sample(e.message);
    }
  }
  const sampleContent = (roleLabel) => ({
    subject: `${roleLabel} digest — sample`,
    headline: 'This is a **sample** layout. Press “Refresh with live data” to generate the real thing.',
    kpis: [
      { label: 'Tickets sold', value: '8,430', delta: '+12% vs last week' },
      { label: 'Revenue', value: 'R1.24m', delta: '+R140k' },
      { label: 'Sell-through', value: '62%', delta: '4 days to event' },
    ],
    narrative: ['Sales are pacing ahead of last week, led by GA tier. Friday remains the strongest channel.', 'Watch the **VIP** tier — slower than projected; a targeted push could close the gap.'],
    actions: [{ text: 'Review the Marketing dashboard for channel mix' }, { text: 'Consider a VIP flash promo this weekend' }],
  });

  console.log('[scheduler] mounted', enabled() ? '(enabled)' : '(disabled — set scheduler_enabled=1)');
}

module.exports = { mount };
