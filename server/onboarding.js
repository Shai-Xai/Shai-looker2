// ─── Onboarding checklist — SELF-CONTAINED, DISPOSABLE MODULE ─────────────────
// A light-touch "Getting started" guide for a client: a handful of setup steps,
// AUTO-detected where we can (branding saved, team invited, first segment…) and
// manually tickable for the rest. Per-entity progress drives a home-page card that
// keeps nudging until complete. Dual-surface: clients see their own; an admin can
// read any client's progress (a seed for the future AM cockpit).
//
// Mount: require('./onboarding').mount(app, { db, auth });

function mount(app, { db, auth }) {
  const sql = db.db;
  sql.exec(`CREATE TABLE IF NOT EXISTS onboarding_state (
    entity_id  TEXT NOT NULL,
    key        TEXT NOT NULL,          -- a step key, or '__dismissed'
    done       INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (entity_id, key)
  );`);

  // Safe count helpers — return 0 if a table isn't created yet (mount order).
  const count = (q, e) => { try { return sql.prepare(q).get(e)?.n || 0; } catch { return 0; } };
  const brandingDone = (e) => { try { const b = db.getEntityMailBranding(e) || {}; return !!(b.logo || b.brandColor || b.senderName || b.header) || !!db.getEntity(e)?.logo; } catch { return false; } };
  // Auto-tick once either ad platform is connected (token + account set).
  const adChannelsDone = (e) => { try { return require('./meta').isConfigured(e) || require('./tiktok').isConfigured(e); } catch { return false; } };
  // Auto-tick once any pixel/tag id is saved in the Pulse Pixel section.
  const pixelDone = (e) => { try { return require('./pixel').view(db.getEntityIntegrations(e) || {}).configured; } catch { return false; } };

  // Step catalogue. `auto` (when present) auto-completes the step from real state;
  // steps without `auto` are manual (a CTA + tick). Order = the suggested journey,
  // grouped into three plain-language `phase`s for the card. `guide` keys into the
  // front-end walkthrough content (client/src/lib/guides.js) — the "Show me how".
  // Step keys are stable (don't rename) so stored progress + auto-checks keep working.
  const STEPS = [
    // Phase 1 — Make it yours
    { key: 'branding', phase: 'Make it yours', guide: 'branding', icon: '🎨', title: 'Add your logo & brand colour', desc: 'Upload your logo and pick your colour, so your emails and the whole app then look like you.', cta: '/settings?section=email', auto: brandingDone },
    { key: 'team', phase: 'Make it yours', guide: 'team', icon: '👥', title: 'Invite your team', desc: 'Add the people who should get access and briefings.', cta: '/settings?section=team', auto: (e) => count('SELECT COUNT(*) n FROM user_entities WHERE entity_id=?', e) >= 2 },
    // Phase 2 — Stay in the loop
    { key: 'notifications', phase: 'Stay in the loop', guide: 'notifications', icon: '🔔', title: 'Turn on notifications', desc: 'Get a nudge on your phone when something needs you, even when Pulse is closed.', cta: '/settings?section=notifications' },
    { key: 'alerts', phase: 'Stay in the loop', guide: 'alerts', icon: '🚨', title: 'Set up an alert', desc: 'Watch a number that matters (tickets, revenue, low stock) and get pinged the moment it crosses your threshold.', cta: '/alerts', auto: (e) => count('SELECT COUNT(*) n FROM alerts WHERE entity_id=?', e) > 0 },
    { key: 'digest', phase: 'Stay in the loop', guide: 'digest', icon: '🗓', title: 'Set up your weekly briefing', desc: 'An automated briefing emailed to your team on the schedule you choose.', cta: '/digests', auto: (e) => count("SELECT COUNT(*) n FROM scheduled_jobs WHERE entity_id=? AND type='digest'", e) > 0 },
    // Phase 3 — See & act on your data
    { key: 'explore', phase: 'See & act on your data', guide: 'explore', icon: '📊', title: 'Take a tour of your dashboards', desc: 'Open your suites and get a feel for your live data.', cta: '/' },
    { key: 'goals', phase: 'See & act on your data', guide: 'goals', icon: '⭐', title: 'Set your event goals', desc: 'Pick the numbers that matter (a ticket or revenue target) and track them live against where they need to be.', cta: '/?goals=new', auto: (e) => count('SELECT COUNT(*) n FROM goals WHERE entity_id=?', e) > 0 },
    { key: 'segment', phase: 'See & act on your data', guide: 'segment', icon: '🎯', title: 'Create your first audience', desc: 'Turn a dashboard tile or a list into a reusable audience you can message.', cta: '/engage/segments', auto: (e) => count('SELECT COUNT(*) n FROM segments WHERE entity_id=?', e) > 0 },
    { key: 'campaign', phase: 'See & act on your data', guide: 'campaign', icon: '📣', title: 'Launch your first campaign', desc: 'Email or SMS an audience, and winning back abandoned carts is a great first one.', cta: '/engage/campaigns', auto: (e) => count('SELECT COUNT(*) n FROM actions WHERE entity_id=?', e) > 0 },
    { key: 'channels', phase: 'See & act on your data', guide: 'channels', icon: '🔗', title: 'Connect Meta & TikTok', desc: 'Link your ad accounts to push audiences to Meta & TikTok Custom Audiences for targeting.', cta: '/settings?section=integrations', auto: adChannelsDone },
    { key: 'pixel', phase: 'See & act on your data', icon: '🎯', title: 'Install the Pulse Pixel', desc: 'One snippet on your website or ticket shop — remarketing lists then build automatically in Meta, Google and TikTok.', cta: '/settings?section=integrations', auto: pixelDone },
  ];

  function progress(entityId) {
    const manual = {};
    try { for (const r of sql.prepare('SELECT key, done FROM onboarding_state WHERE entity_id=?').all(entityId)) manual[r.key] = r.done; } catch { /* table new */ }
    const steps = STEPS.map((s) => {
      const autoDone = s.auto ? !!s.auto(entityId) : false;
      const manualDone = manual[s.key] === 1;
      return { key: s.key, phase: s.phase, guide: s.guide, icon: s.icon, title: s.title, desc: s.desc, cta: s.cta, auto: !!s.auto, done: autoDone || manualDone };
    });
    const done = steps.filter((s) => s.done).length;
    return { steps, done, total: steps.length, complete: done === steps.length, dismissed: manual.__dismissed === 1 };
  }
  const setState = (entityId, key, done) => sql.prepare('INSERT INTO onboarding_state (entity_id,key,done,updated_at) VALUES (?,?,?,?) ON CONFLICT(entity_id,key) DO UPDATE SET done=excluded.done, updated_at=excluded.updated_at').run(entityId, key, done ? 1 : 0, new Date().toISOString());

  const canEntity = (req, entityId) => req.user.role === 'admin' || (req.user.entityIds || []).includes(entityId);
  const guard = (req, res, entityId) => { if (!canEntity(req, entityId)) { res.status(403).json({ error: 'Not allowed' }); return false; } return true; };

  // Client self-service: the entity in context.
  app.get('/api/my/onboarding/:entityId', auth.requireAuth, (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    res.json(progress(req.params.entityId));
  });
  // Tick / untick a manual step (auto steps ignore this — they reflect real state).
  app.post('/api/my/onboarding/:entityId/:key', auth.requireAuth, (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const valid = STEPS.some((s) => s.key === req.params.key);
    if (!valid) return res.status(400).json({ error: 'Unknown step' });
    setState(req.params.entityId, req.params.key, !!(req.body && req.body.done));
    res.json(progress(req.params.entityId));
  });
  // Dismiss (hide) or restore the whole checklist.
  app.post('/api/my/onboarding/:entityId/dismiss', auth.requireAuth, (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    setState(req.params.entityId, '__dismissed', (req.body && req.body.dismissed) !== false);
    res.json(progress(req.params.entityId));
  });
  // Admin: read any client's progress (seed for the AM cockpit).
  app.get('/api/admin/entities/:id/onboarding', auth.requireAdmin, (req, res) => res.json(progress(req.params.id)));

  console.log('[onboarding] checklist module mounted');
  return { progress };
}

module.exports = { mount };
