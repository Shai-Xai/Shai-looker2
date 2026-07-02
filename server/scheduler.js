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

function mount(app, { db, auth, mailer, messaging, push, generateContent, roleLenses, recordDigest, feedbackUrl, replyTo, notifyOps }) {
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
    if (!cols.includes('channel')) sql.exec("ALTER TABLE scheduled_jobs ADD COLUMN channel TEXT NOT NULL DEFAULT 'email'");           // email | sms | both
    if (!cols.includes('sms_recipients')) sql.exec("ALTER TABLE scheduled_jobs ADD COLUMN sms_recipients TEXT NOT NULL DEFAULT '[]'"); // phone numbers
    if (!cols.includes('align_days_before')) sql.exec("ALTER TABLE scheduled_jobs ADD COLUMN align_days_before INTEGER NOT NULL DEFAULT 0"); // honour each dashboard's days-to-go sync
    if (!cols.includes('priority_dashboards')) sql.exec("ALTER TABLE scheduled_jobs ADD COLUMN priority_dashboards TEXT NOT NULL DEFAULT '[]'"); // dashboards always swept into AI-mode facts
    if (!cols.includes('include_followed')) sql.exec("ALTER TABLE scheduled_jobs ADD COLUMN include_followed INTEGER NOT NULL DEFAULT 0"); // pull the client's followed tiles into the digest (both modes)
    if (!cols.includes('followed_visual')) sql.exec("ALTER TABLE scheduled_jobs ADD COLUMN followed_visual INTEGER NOT NULL DEFAULT 0"); // render followed tiles as charts/metric chips in the email
    if (!cols.includes('followed_tiles')) sql.exec("ALTER TABLE scheduled_jobs ADD COLUMN followed_tiles TEXT NOT NULL DEFAULT '[]'"); // chosen subset of followed tiles ([] = all)
    if (!cols.includes('include_goals')) sql.exec("ALTER TABLE scheduled_jobs ADD COLUMN include_goals INTEGER NOT NULL DEFAULT 0"); // add a goals summary (Results pillar) to the digest
    if (!cols.includes('suite_ids')) sql.exec("ALTER TABLE scheduled_jobs ADD COLUMN suite_ids TEXT NOT NULL DEFAULT '[]'"); // events this digest covers ([] = all); multi-event clients can scope + separate per event
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
    channel: r.channel || 'email', smsRecipients: JSON.parse(r.sms_recipients || '[]'),
    alignDaysBefore: r.align_days_before === 1,
    priorityDashboards: JSON.parse(r.priority_dashboards || '[]'),
    includeFollowed: r.include_followed === 1,
    followedVisual: r.followed_visual === 1,
    followedTiles: JSON.parse(r.followed_tiles || '[]'),
    includeGoals: r.include_goals === 1,
    suiteIds: JSON.parse(r.suite_ids || '[]'),
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
      channel: ['sms', 'both'].includes(body.channel) ? body.channel : 'email',
      smsRecipients: Array.isArray(body.smsRecipients) ? [...new Set(body.smsRecipients.map((p) => String(p).replace(/[^\d+]/g, '').trim()).filter((p) => p.replace(/\D/g, '').length >= 7))].slice(0, 25) : [],
      alignDaysBefore: body.alignDaysBefore ? 1 : 0,
      priorityDashboards: Array.isArray(body.priorityDashboards) ? [...new Set(body.priorityDashboards.map((d) => String(d)).filter(Boolean))].slice(0, 20) : [],
      includeFollowed: body.includeFollowed ? 1 : 0,
      followedVisual: body.followedVisual ? 1 : 0,
      followedTiles: Array.isArray(body.followedTiles) ? body.followedTiles.filter((t) => t && t.dashboardId && t.tileId).slice(0, 40).map((t) => ({ dashboardId: String(t.dashboardId), tileId: String(t.tileId) })) : [],
      includeGoals: body.includeGoals ? 1 : 0,
      suiteIds: Array.isArray(body.suiteIds) ? [...new Set(body.suiteIds.map((s) => String(s)).filter(Boolean))].slice(0, 30) : [],
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
      sql.prepare(`UPDATE scheduled_jobs SET title=?, role=?, role_focus=?, focus_mode=?, custom_message=?, content_mode=?, tiles=?, recipients=?, channel=?, sms_recipients=?, align_days_before=?, priority_dashboards=?, include_followed=?, followed_visual=?, followed_tiles=?, include_goals=?, suite_ids=?, cadence=?, time_of_day=?, weekday=?, run_at=?, timezone=?, status=?, next_run_at=?, updated_at=? WHERE id=?`)
        .run(j.title, j.role, j.roleFocus, j.focusMode, j.customMessage, j.contentMode, JSON.stringify(j.tiles), JSON.stringify(j.recipients), j.channel, JSON.stringify(j.smsRecipients), j.alignDaysBefore, JSON.stringify(j.priorityDashboards), j.includeFollowed, j.followedVisual, JSON.stringify(j.followedTiles), j.includeGoals, JSON.stringify(j.suiteIds || []), j.cadence, j.timeOfDay, j.weekday, j.runAt, j.timezone, j.status, nextIso, ts, id);
      return getJob(id);
    }
    const nid = uuid();
    sql.prepare(`INSERT INTO scheduled_jobs (id, entity_id, type, title, role, role_focus, focus_mode, custom_message, content_mode, tiles, recipients, channel, sms_recipients, align_days_before, priority_dashboards, include_followed, followed_visual, followed_tiles, include_goals, suite_ids, cadence, time_of_day, weekday, run_at, timezone, status, next_run_at, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(nid, j.entityId, 'digest', j.title, j.role, j.roleFocus, j.focusMode, j.customMessage, j.contentMode, JSON.stringify(j.tiles), JSON.stringify(j.recipients), j.channel, JSON.stringify(j.smsRecipients), j.alignDaysBefore, JSON.stringify(j.priorityDashboards), j.includeFollowed, j.followedVisual, JSON.stringify(j.followedTiles), j.includeGoals, JSON.stringify(j.suiteIds || []), j.cadence, j.timeOfDay, j.weekday, j.runAt, j.timezone, j.status, nextIso, createdBy || '', ts, ts);
    return getJob(nid);
  }

  // Render a job's email (real content; throws if generation fails).
  // Generate the structured digest content (the one expensive AI call).
  // `debug` asks generateContent to attach the fact tiles it read (preview only).
  async function buildContent(job, recipientEmail, { debug = false } = {}) {
    return generateContent({ entityId: job.entityId, role: job.role, roleFocus: job.roleFocus, focusMode: job.focusMode, contentMode: job.contentMode, tiles: job.tiles, alignDaysBefore: !!job.alignDaysBefore, priorityDashboards: job.priorityDashboards || [], includeFollowed: !!job.includeFollowed, followedVisual: !!job.followedVisual, followedTiles: job.followedTiles || [], includeGoals: !!job.includeGoals, suiteIds: job.suiteIds || [], creatorEmail: job.createdBy || '', recipientEmail, debug });
  }
  // Render the email for already-generated content (cheap — no AI). A per-recipient
  // feedbackUrl embeds 👍/👎/comment links back into Pulse.
  function emailFor(job, content, { feedbackUrl: fbUrl = '' } = {}) {
    const lens = lensFor(job);
    // Single-event digests brand with that event; portfolio digests stay client-level.
    const bSuite = content?.brandingSuiteId || '';
    const branding = mailer.resolveBranding(job.entityId, bSuite);
    const email = mailer.digestEmail({ branding, entityId: job.entityId, assetScope: bSuite || job.entityId, content, roleLabel: lens.label, customMessage: job.customMessage, feedbackUrl: fbUrl });
    return { ...email, content, senderName: branding.senderName };
  }
  // Preview/back-compat: generate + render in one go (no feedback link).
  async function render(job, recipientEmail, opts = {}) {
    const content = await buildContent(job, recipientEmail, opts);
    return emailFor(job, content, {});
  }

  // A short SMS version of the digest — the one-line headline (+ custom note),
  // with a link back into Pulse. Email stays the rich version.
  function buildDigestSms(job, content) {
    const headline = String(content?.headline || `${lensFor(job).label} digest`).replace(/\s+/g, ' ').trim();
    const note = String(job.customMessage || '').replace(/\s+/g, ' ').trim();
    let body = (note ? `${note} — ${headline}` : headline).slice(0, 300);
    const link = mailer.baseUrl ? mailer.baseUrl() : '';
    return link ? `${body}\n${link}` : body;
  }

  // Run a job: render once, send to email + SMS recipients per the job's channel.
  // `manual` skips rescheduling; a test `toOverride` is email-only.
  async function runJob(job, { manual, toOverride } = {}) {
    const wantsEmail = (job.channel || 'email') !== 'sms';
    const wantsSms = (job.channel || 'email') !== 'email';
    const emailTo = toOverride ? [toOverride] : (job.recipients || []).filter(Boolean);
    const smsTo = toOverride ? [] : (job.smsRecipients || []).filter(Boolean);
    let result;
    if (!(wantsEmail && emailTo.length) && !(wantsSms && smsTo.length)) {
      result = { status: 'skipped', detail: 'no recipients' };
    } else {
      try {
        const content = await buildContent(job, emailTo[0] || smsTo[0] || '');
        const lens = lensFor(job);
        const senderName = mailer.resolveBranding(job.entityId).senderName;
        const subject = content.subject;
        let ok = 0, err = '';
        if (wantsEmail && emailTo.length) {
          // Archive this digest (so it's browsable + feedback-able) and reply-route.
          const digestId = recordDigest ? recordDigest({ entityId: job.entityId, jobId: job.id, role: job.role, roleLabel: lens.label, subject, headline: content.headline, content, recipients: emailTo }) : '';
          const reply = replyTo ? replyTo(job.entityId) : null;
          for (const to of emailTo) {
            const fbUrl = (digestId && feedbackUrl) ? feedbackUrl(digestId, to) : '';
            const { html, text } = emailFor(job, content, { feedbackUrl: fbUrl });
            const r = await mailer.send({ to, subject: subject || `${lens.label} digest`, html, text, fromName: senderName, kind: 'digest', entity: job.entityId, replyTo: reply });
            if (r.ok) ok += 1; else err = r.error || r.reason || 'email failed';
          }
        }
        if (wantsSms && messaging?.sendSms) {
          const smsText = buildDigestSms(job, content);
          for (const to of smsTo) {
            const r = await messaging.sendSms({ to, text: smsText });
            if (r.ok) ok += 1; else err = r.error || r.reason || 'SMS failed';
          }
        }
        result = ok ? { status: 'ok', detail: `sent to ${ok}` } : { status: 'error', detail: err || 'send failed' };
        // Push nudge to the EMAIL recipients who have push on — "your briefing is
        // ready", deep-linking home. Collapse tag = one per entity, so a new
        // day's nudge replaces the previous instead of stacking. Best-effort.
        if (ok && wantsEmail && push?.isEnabled?.()) {
          try {
            const byEmail = new Map(db.listUsers().map((u) => [u.email, u]));
            const lensLabel = lensFor(job).label;
            for (const to of emailTo) {
              const u = byEmail.get(to);
              if (u && u.notifyPush !== false) {
                push.sendToUser(u.id, {
                  title: 'Your briefing is ready',
                  body: `${lensLabel} digest for ${db.getEntity(job.entityId)?.name || 'your event'} just landed.`,
                  url: '/',
                  tag: `digest-${job.entityId}`,
                }, 'digest').catch(() => {});
              }
            }
          } catch { /* push is best-effort */ }
        }
      } catch (e) { result = { status: 'error', detail: e.message }; }
    }
    if (!manual) {
      // The run-slot was already claimed by tick() BEFORE the send (next_run_at
      // advanced / 'once' retired) — here we only record the outcome.
      sql.prepare('UPDATE scheduled_jobs SET last_run_at=?, last_status=?, updated_at=? WHERE id=?')
        .run(now(), `${result.status}: ${result.detail}`.slice(0, 300), now(), job.id);
      // A failed scheduled digest used to die silently in last_status — raise ops.
      if (result.status === 'error' && notifyOps) {
        try { notifyOps(`Scheduled digest failed — "${job.title || job.role}" for ${db.getEntity(job.entityId)?.name || job.entityId}: ${result.detail}`); } catch { /* alerting must never break the tick */ }
      }
    }
    return result;
  }

  // ── the tick ──
  // Re-entrancy guard: a digest render does a live Looker pull + AI write that
  // can take 30-60s (see render()), and the tick fires every 60s — the flag
  // makes an overlapping tick a no-op until the current one drains.
  // Single-instance deployment, so an in-process flag is sufficient.
  //
  // CRASH SAFETY: each job's run-slot is CLAIMED (next_run_at advanced, 'once'
  // retired) BEFORE the send starts. Deploys restart this process routinely
  // (autoDeploy on push); if the claim happened after the send — the old shape —
  // a restart between "emails delivered" and "row updated" re-selected the job
  // on boot and re-sent the whole digest to every real recipient. Claim-first
  // means a crash mid-send can only MISS one run (visible in last_status as a
  // stuck 'started …'), never double-send. Same convention as owlWhatsapp/
  // goalNudge: mark before send.
  let ticking = false;
  async function tick() {
    if (!enabled()) return;
    if (ticking) return; // a previous (slow) tick is still running — skip this one
    ticking = true;
    try {
      const due = sql.prepare("SELECT * FROM scheduled_jobs WHERE status='active' AND next_run_at IS NOT NULL AND next_run_at <= ?").all(now());
      for (const r of due) {
        const job = rowToJob(r);
        try {
          const next = job.cadence === 'once' ? null : computeNextRun(job);
          sql.prepare('UPDATE scheduled_jobs SET next_run_at=?, status=?, last_status=?, updated_at=? WHERE id=?')
            .run(next ? next.toISOString() : null, job.cadence === 'once' ? 'done' : job.status, `started: ${now()}`, now(), job.id);
          await runJob(job);
        } catch (e) { console.error('[scheduler] job failed', r.id, e.message); }
      }
    } finally {
      ticking = false;
    }
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
  app.post('/api/admin/digests/preview', auth.requireAdmin, (req, res) => preview(req.body || {}, res, req.user.email));
  // Send a test of the CURRENT (possibly unsaved) editor config to the admin.
  app.post('/api/admin/digests/test-send', auth.requireAdmin, (req, res) => testSendConfig(req.body || {}, (req.body || {}).entityId, req.user.email, res));
  app.post('/api/admin/digests/test-send-sms', auth.requireAdmin, (req, res) => { if (!enabled()) return off(res); testSendSms(req.body || {}, (req.body || {}).entityId, (req.body || {}).phone, res); });

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
  app.post('/api/my/digests/:entityId/preview', auth.requireAuth, auth.requirePermission('digests.manage'), (req, res) => { if (!enabled()) return off(res); if (!ownsEntity(req)) return res.status(403).json({ error: 'Not allowed' }); preview({ ...req.body, entityId: req.params.entityId }, res, req.user.email); });
  app.post('/api/my/digests/:entityId/test-send', auth.requireAuth, auth.requirePermission('digests.manage'), (req, res) => { if (!enabled()) return off(res); if (!ownsEntity(req)) return res.status(403).json({ error: 'Not allowed' }); testSendConfig({ ...req.body, entityId: req.params.entityId }, req.params.entityId, req.user.email, res); });
  app.post('/api/my/digests/:entityId/test-send-sms', auth.requireAuth, auth.requirePermission('digests.manage'), (req, res) => { if (!enabled()) return off(res); if (!ownsEntity(req)) return res.status(403).json({ error: 'Not allowed' }); testSendSms({ ...req.body, entityId: req.params.entityId }, req.params.entityId, (req.body || {}).phone, res); });

  // Render + send the current (unsaved) config as a test to one address.
  async function testSendConfig(body, entityId, toEmail, res) {
    if (!entityId) return res.status(400).json({ error: 'entityId required' });
    const job = { ...clean(body, entityId), id: 'test', createdBy: toEmail };
    const r = await runJob(job, { manual: true, toOverride: toEmail });
    return r.status === 'ok' ? res.json({ ok: true, to: toEmail }) : res.status(400).json({ error: r.detail });
  }

  // Send the SMS version of the current (unsaved) config to one mobile number.
  async function testSendSms(body, entityId, toPhone, res) {
    if (!entityId) return res.status(400).json({ error: 'entityId required' });
    if (!messaging?.sendSms) return res.status(400).json({ error: 'SMS is not configured for this client.' });
    const phone = String(toPhone || '').replace(/[^\d+]/g, '');
    if (phone.replace(/\D/g, '').length < 7) return res.status(400).json({ error: 'Enter a valid mobile number.' });
    const job = { ...clean(body, entityId), id: 'test' };
    try {
      const { content } = await render(job, '');
      const r = await messaging.sendSms({ to: phone, text: buildDigestSms(job, content) });
      return r.ok ? res.json({ ok: true, to: phone }) : res.status(502).json({ error: r.error || r.reason || 'SMS failed' });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // Render a preview email from an (unsaved) job config.
  // body.live=false (the default) renders the SAMPLE layout instantly — used by
  // the editor's debounced auto-preview so layout/branding updates are free.
  // body.live=true does the real thing (Looker pulls + AI write — can take
  // 30-60s, costs tokens) — used by the explicit Refresh button.
  async function preview(body, res, whoEmail = '') {
    const entityId = body.entityId;
    if (!entityId) return res.status(400).json({ error: 'entityId required' });
    const job = { ...clean(body, entityId), id: 'preview', createdBy: whoEmail };
    const lens = lensFor(job);
    const sample = (reason) => {
      const content = sampleContent(lens.label);
      const bSuite = content?.brandingSuiteId || '';
      const branding = mailer.resolveBranding(entityId, bSuite);
      const { html, subject } = mailer.digestEmail({ branding, entityId, assetScope: bSuite || entityId, content, roleLabel: lens.label, customMessage: job.customMessage });
      res.json({ html, subject, sample: true, reason: reason || '' });
    };
    if (!body.live) return sample('');
    try {
      const { html, subject, content } = await render(job, (job.recipients[0] || ''), { debug: true });
      res.json({ html, subject, sample: false, generatedAt: new Date().toISOString(), facts: content?.facts || [], dropped: content?.dropped || [] });
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

  // ── WhatsApp digest: the SAME configured digest, condensed for a chat bubble ──
  // Render the entity's active digest job with the real content builder, then squeeze
  // it to a few short lines. Null when no digest is configured, so the WhatsApp
  // scheduler falls back to its lightweight Owl summary. Best-effort; never throws.
  async function whatsappDigestFor(entityId, recipientEmail) {
    try {
      const row = sql.prepare("SELECT * FROM scheduled_jobs WHERE entity_id=? AND type='digest' AND status='active' ORDER BY created_at LIMIT 1").get(entityId);
      if (!row) return null;
      const j = rowToJob(row);
      const content = await generateContent({
        entityId, role: j.role, roleFocus: j.roleFocus, focusMode: j.focusMode, contentMode: j.contentMode,
        tiles: j.tiles, alignDaysBefore: j.alignDaysBefore, priorityDashboards: j.priorityDashboards,
        includeFollowed: j.includeFollowed, followedVisual: false, followedTiles: j.followedTiles,
        includeGoals: j.includeGoals, suiteIds: j.suiteIds, recipientEmail: recipientEmail || '',
      });
      return condenseDigest(content);
    } catch (e) { console.error('[scheduler] whatsappDigest failed', e && e.message); return null; }
  }

  console.log('[scheduler] mounted', enabled() ? '(enabled)' : '(disabled — set scheduler_enabled=1)');
  return { whatsappDigestFor, _tick: tick, _runJob: runJob }; // _-prefixed: exposed for tests only
}

// Squeeze a (flat or multi-event) digest into a short WhatsApp message: headline,
// up to 5 KPIs, and the lead narrative line (labels/money already formatted upstream).
function condenseDigest(c) {
  if (!c) return '';
  const lines = [`*${String(c.headline || c.subject || 'Your update').replace(/[*\n]/g, ' ').trim().slice(0, 160)}*`];
  let kpis = Array.isArray(c.kpis) ? c.kpis.slice() : [];
  if (!kpis.length && Array.isArray(c.events)) kpis = c.events.flatMap((e) => (e.kpis || []).map((k) => ({ label: `${e.suiteName} · ${k.label}`, value: k.value })));
  for (const k of kpis.slice(0, 5)) if (k && k.label && k.value) lines.push(`${k.label}: ${k.value}`);
  const narr = (Array.isArray(c.narrative) && c.narrative[0]) || (Array.isArray(c.events) && c.events[0] && (c.events[0].narrative || [])[0]) || '';
  if (narr) lines.push(`\n${String(narr).replace(/\n/g, ' ').slice(0, 320)}`);
  return lines.join('\n').trim();
}

module.exports = { mount };
