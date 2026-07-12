// ─── Client onboarding journey — SELF-CONTAINED, DISPOSABLE MODULE ────────────
// The client-facing onboarding PACK: a layered, phased journey that moves a new
// client from "first login" to "fully activated", with steps AUTO-detected from
// real usage wherever possible (dashboards viewed, app installed, Owl asked,
// WhatsApp linked, connector used, journey built…) and manually tickable for the
// rest. Four phases, each unlocking naturally as the previous completes:
//   1. The fundamentals   — dashboards, the app, notifications, the Owl, digest
//   2. Goals & first sends — goals, alerts, audiences, a first simple email
//   3. The Owl everywhere  — WhatsApp, Claude & ChatGPT connectors
//   4. Automate & amplify  — journeys, ad accounts, the Pulse Pixel
// An email layer walks the client through the layers: a branded WELCOME PACK
// when their first login exists, then a congratulations + "here's what's next"
// email as each phase completes (an inbox announcement rides along). The account
// team (owner/support) gets a factual heads-up on each phase completion — the
// journey moves the client AND the AM through the stages together.
// Dual-surface: clients see their own journey (/api/my/onboarding/…); admins
// read + manage any client's (/api/admin/entities/:id/onboarding…).
//
// Mount: require('./onboarding').mount(app, { db, auth, mailer, os });

function mount(app, { db, auth, mailer, os }) {
  const sql = db.db;
  sql.exec(`CREATE TABLE IF NOT EXISTS onboarding_state (
    entity_id  TEXT NOT NULL,
    key        TEXT NOT NULL,          -- a step key, or '__dismissed'
    done       INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (entity_id, key)
  );`);
  // One row per onboarding email actually handled per client — 'welcome' or
  // 'phase:<key>'. sent_at='baseline' marks emails skipped on purpose (the client
  // predates the email layer, or the phase was already done at welcome time).
  sql.exec(`CREATE TABLE IF NOT EXISTS onboarding_mail_log (
    entity_id TEXT NOT NULL, key TEXT NOT NULL, sent_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (entity_id, key)
  );`);

  // Safe count helpers — return 0 if a table isn't created yet (mount order).
  const count = (q, e) => { try { return sql.prepare(q).get(e)?.n || 0; } catch { return 0; } };
  const brandingDone = (e) => { try { const b = db.getEntityMailBranding(e) || {}; return !!(b.logo || b.brandColor || b.senderName || b.header) || !!db.getEntity(e)?.logo; } catch { return false; } };
  // Auto-tick once either ad platform is connected (token + account set).
  const adChannelsDone = (e) => { try { return require('./meta').isConfigured(e) || require('./tiktok').isConfigured(e); } catch { return false; } };
  // Auto-tick once any pixel/tag id is saved in the Pulse Pixel section.
  const pixelDone = (e) => { try { return require('./pixel').view(db.getEntityIntegrations(e) || {}).configured; } catch { return false; } };
  // A client user opened a dashboard (user_views is per-user; scope via membership).
  const exploredDone = (e) => count('SELECT COUNT(*) n FROM user_views v JOIN user_entities ue ON ue.user_id=v.user_id WHERE ue.entity_id=?', e) > 0;
  // Someone on the client's team runs Pulse as an installed app.
  const installDone = (e) => count('SELECT COUNT(*) n FROM app_installs a JOIN user_entities ue ON ue.user_id=a.user_id WHERE ue.entity_id=?', e) > 0;
  // A push subscription exists for one of the client's users.
  const notificationsDone = (e) => count('SELECT COUNT(*) n FROM push_subscriptions p JOIN user_entities ue ON ue.user_id=p.user_id WHERE ue.entity_id=?', e) > 0;
  // A client user asked the Owl something in-app (threads by the client's own users).
  const owlChatDone = (e) => count('SELECT COUNT(*) n FROM owl_threads t JOIN user_entities ue ON ue.user_id=t.user_id AND ue.entity_id=t.entity_id WHERE t.entity_id=?', e) > 0;
  // The Owl is linked on WhatsApp: a number in the allowlist for this client, or
  // an actual WhatsApp conversation attributed to it.
  const whatsappDone = (e) => {
    try { const map = JSON.parse(db.getSetting('owl_whatsapp_numbers', '') || '{}'); if (Object.values(map).some((v) => v && v.entityId === e)) return true; } catch { /* ignore */ }
    return count('SELECT COUNT(*) n FROM owl_wa_msgs WHERE entity_id=?', e) > 0;
  };
  // Claude/ChatGPT connected: the client's MCP connector has actually been used.
  const connectorDone = (e) => count("SELECT COUNT(*) n FROM api_audit WHERE entity_id=? AND surface='mcp'", e) > 0;
  // Owl mastery signals: a tile insight generated; an audience/campaign the Owl
  // (any agent surface) created — provenance lives in created_via; feedback filed.
  const insightDone = (e) => count("SELECT COUNT(*) n FROM ai_usage WHERE entity_id=? AND kind='tile_insight'", e) > 0;
  const AGENT_VIA = "('owl','whatsapp','claude','chatgpt')";
  const owlSegmentDone = (e) => count(`SELECT COUNT(*) n FROM segments WHERE entity_id=? AND created_via IN ${AGENT_VIA}`, e) > 0;
  const owlCampaignDone = (e) => count(`SELECT COUNT(*) n FROM actions WHERE entity_id=? AND created_via IN ${AGENT_VIA}`, e) > 0;
  const feedbackDone = (e) => count("SELECT COUNT(*) n FROM tickets WHERE entity_id=? AND reporter_role='client'", e) > 0;
  // A journey or drip sequence exists (the Owl's journeys land as draft campaigns
  // with a `journey` tree in config; drips carry campaignMode:'sequence').
  const journeyDone = (e) => count(`SELECT COUNT(*) n FROM actions WHERE entity_id=? AND (recurring=1 OR instr(config,'"journey"')>0 OR instr(config,'"campaignMode":"sequence"')>0)`, e) > 0;

  // The five layers of the journey. Order matters — the client's "current" phase
  // is the first incomplete one, and the phase emails walk this ladder. Each
  // phase carries its collectible sticker (the gamification layer awards it and
  // the phase email celebrates it by name).
  const PHASES = [
    { key: 'fundamentals', icon: '🧭', title: 'The fundamentals', sticker: '🧭 Pathfinder', tagline: 'Find your feet — your live dashboards, the app on your phone, your daily read.' },
    { key: 'meetowl', icon: '🦉', title: 'Meet the Owl', sticker: '🦉 Owl Whisperer', tagline: 'Your on-demand analyst — it answers, builds and drafts for you.' },
    { key: 'engage', icon: '🎯', title: 'Goals & first sends', sticker: '🎯 Sharpshooter', tagline: 'Set targets, get to know your audiences, and send your first email.' },
    { key: 'owl', icon: '💬', title: 'The Owl everywhere', sticker: '💬 Everywhere Owl', tagline: 'Take your data analyst with you — WhatsApp, Claude and ChatGPT.' },
    { key: 'automate', icon: '⚙️', title: 'Automate & amplify', sticker: '⚙️ Automation Architect', tagline: 'Journeys that run themselves, and your ad accounts wired in.' },
  ];

  // Step catalogue. `auto` (when present) auto-completes the step from real state;
  // steps without `auto` are manual (a CTA + tick). `phase` keys into PHASES;
  // `guide` keys into the front-end walkthrough content (client/src/lib/guides.js);
  // `pts` is the step's Pulse Points value (the gamification layer sums these).
  // Step keys are stable (don't rename) so stored progress + auto-checks keep working.
  const STEPS = [
    // Phase 1 — The fundamentals
    { key: 'explore', phase: 'fundamentals', guide: 'explore', icon: '📊', pts: 50, title: 'Take a tour of your dashboards', desc: 'Open your suites and get a feel for your live data.', cta: '/', auto: exploredDone },
    { key: 'install', phase: 'fundamentals', guide: 'install', icon: '📲', pts: 50, title: 'Put Pulse on your phone', desc: 'Install the app — a home-screen icon, full screen, always a tap away.', cta: '/', auto: installDone },
    { key: 'notifications', phase: 'fundamentals', guide: 'notifications', icon: '🔔', pts: 50, title: 'Turn on notifications', desc: 'Get a nudge on your phone when something needs you, even when Pulse is closed.', cta: '/settings?section=notifications', auto: notificationsDone },
    { key: 'digest', phase: 'fundamentals', guide: 'digest', icon: '🗓', pts: 100, title: 'Set up your weekly briefing', desc: 'An automated briefing emailed to your team on the schedule you choose.', cta: '/digests', auto: (e) => count("SELECT COUNT(*) n FROM scheduled_jobs WHERE entity_id=? AND type='digest'", e) > 0 },
    { key: 'branding', phase: 'fundamentals', guide: 'branding', icon: '🎨', pts: 50, title: 'Add your logo & brand colour', desc: 'Upload your logo and pick your colour, so your emails and the whole app then look like you.', cta: '/settings?section=email', auto: brandingDone },
    { key: 'team', phase: 'fundamentals', guide: 'team', icon: '👥', pts: 50, title: 'Invite your team', desc: 'Add the people who should get access and briefings.', cta: '/settings?section=team', auto: (e) => count('SELECT COUNT(*) n FROM user_entities WHERE entity_id=?', e) >= 2 },
    // Phase 2 — Meet the Owl (in-app mastery; drafts only, nothing sends here)
    { key: 'owlchat', phase: 'meetowl', guide: 'owlchat', icon: '🦉', pts: 50, title: 'Ask the Owl a question', desc: 'Your on-demand analyst — ask anything about your numbers in plain language.', cta: '/', auto: owlChatDone },
    { key: 'insight', phase: 'meetowl', guide: 'insights', icon: '💡', pts: 50, title: 'Get a tile insight', desc: 'Tap the 🦉 on any dashboard tile for a plain-English read of the numbers.', cta: '/', auto: insightDone },
    { key: 'owlsegment', phase: 'meetowl', guide: 'owlsegment', icon: '🎯', pts: 100, title: 'Have the Owl build you an audience', desc: '“Everyone who abandoned a cart this week” — just ask, and it becomes a reusable audience.', cta: '/', auto: owlSegmentDone },
    { key: 'owlcampaign', phase: 'meetowl', guide: 'owlcampaign', icon: '📣', pts: 100, title: 'Have the Owl draft a campaign', desc: 'It writes the email; you review before anything sends.', cta: '/', auto: owlCampaignDone },
    { key: 'feedback', phase: 'meetowl', guide: 'feedback', icon: '💡', pts: 50, title: 'Send feedback or report a bug', desc: 'Spotted something off, or wish Pulse did more? Tell us — we really do fix them.', cta: '/product', auto: feedbackDone },
    // Phase 3 — Goals & first sends
    { key: 'goals', phase: 'engage', guide: 'goals', icon: '⭐', pts: 100, title: 'Set your event goals', desc: 'Pick the numbers that matter (a ticket or revenue target) and track them live against where they need to be.', cta: '/?goals=new', auto: (e) => count('SELECT COUNT(*) n FROM goals WHERE entity_id=?', e) > 0 },
    { key: 'alerts', phase: 'engage', guide: 'alerts', icon: '🚨', pts: 50, title: 'Set up an alert', desc: 'Watch a number that matters (tickets, revenue, low stock) and get pinged the moment it crosses your threshold.', cta: '/alerts', auto: (e) => count('SELECT COUNT(*) n FROM alerts WHERE entity_id=?', e) > 0 },
    { key: 'segment', phase: 'engage', guide: 'segment', icon: '🎯', pts: 100, title: 'Create your first audience', desc: 'Turn a dashboard tile or a list into a reusable audience you can message.', cta: '/engage/segments', auto: (e) => count('SELECT COUNT(*) n FROM segments WHERE entity_id=?', e) > 0 },
    { key: 'campaign', phase: 'engage', guide: 'campaign', icon: '📣', pts: 150, title: 'Send your first email campaign', desc: 'A simple email to an audience — winning back abandoned carts is a great first one.', cta: '/engage/campaigns', auto: (e) => count('SELECT COUNT(*) n FROM actions WHERE entity_id=?', e) > 0 },
    // Phase 4 — The Owl everywhere
    { key: 'whatsapp', phase: 'owl', guide: 'whatsapp', icon: '💬', pts: 100, title: 'Chat to the Owl on WhatsApp', desc: 'Your numbers answered where you already are — ask your Howler team to link your number.', cta: '/inbox', auto: whatsappDone },
    { key: 'connector', phase: 'owl', guide: 'connector', icon: '🔌', pts: 100, title: 'Connect Claude or ChatGPT', desc: 'Plug Pulse into your AI assistant, so it can answer with your live event data.', cta: '/settings?section=integrations', auto: connectorDone },
    // Phase 5 — Automate & amplify
    { key: 'journey', phase: 'automate', guide: 'journey', icon: '🧭', pts: 150, title: 'Build your first journey', desc: 'A multi-step automation that reacts to what people do — ask the Owl to draft one.', cta: '/engage/journeys', auto: journeyDone },
    { key: 'channels', phase: 'automate', guide: 'channels', icon: '🔗', pts: 100, title: 'Connect Meta & TikTok', desc: 'Link your ad accounts to push audiences to Meta & TikTok Custom Audiences for targeting.', cta: '/settings?section=integrations', auto: adChannelsDone },
    { key: 'pixel', phase: 'automate', icon: '🎯', pts: 100, title: 'Install the Pulse Pixel', desc: 'One snippet on your website or ticket shop — remarketing lists then build automatically in Meta, Google and TikTok.', cta: '/settings?section=integrations', auto: pixelDone },
  ];
  // Bonus points the gamification layer awards on top of steps.
  const PHASE_BONUS = 250; const ACTIVATED_BONUS = 500;

  function progress(entityId) {
    const manual = {};
    try { for (const r of sql.prepare('SELECT key, done FROM onboarding_state WHERE entity_id=?').all(entityId)) manual[r.key] = r.done; } catch { /* table new */ }
    const steps = STEPS.map((s) => {
      const autoDone = s.auto ? !!s.auto(entityId) : false;
      const manualDone = manual[s.key] === 1;
      return { key: s.key, phase: s.phase, guide: s.guide, icon: s.icon, pts: s.pts || 50, title: s.title, desc: s.desc, cta: s.cta, auto: !!s.auto, done: autoDone || manualDone };
    });
    const phases = PHASES.map((p) => {
      const ps = steps.filter((s) => s.phase === p.key);
      const done = ps.filter((s) => s.done).length;
      return { key: p.key, icon: p.icon, title: p.title, sticker: p.sticker, tagline: p.tagline, done, total: ps.length, complete: done === ps.length };
    });
    const current = phases.find((p) => !p.complete);
    const done = steps.filter((s) => s.done).length;
    const complete = done === steps.length;
    // Journey-derived Pulse Points: steps + a bonus per finished phase (+ the
    // full-activation bonus). Activity-badge points ride on top in gamify.js.
    const points = steps.filter((s) => s.done).reduce((n, s) => n + s.pts, 0)
      + phases.filter((p) => p.complete).length * PHASE_BONUS + (complete ? ACTIVATED_BONUS : 0);
    return { steps, phases, currentPhase: current ? current.key : null, done, total: steps.length, points, complete, dismissed: manual.__dismissed === 1 };
  }
  const setState = (entityId, key, done) => sql.prepare('INSERT INTO onboarding_state (entity_id,key,done,updated_at) VALUES (?,?,?,?) ON CONFLICT(entity_id,key) DO UPDATE SET done=excluded.done, updated_at=excluded.updated_at').run(entityId, key, done ? 1 : 0, new Date().toISOString());

  // ── The onboarding email layer ──────────────────────────────────────────────
  const setting = (k, d) => db.getSetting(k, d);
  const mailEnabled = () => setting('onboarding_mail_enabled', '1') !== '0';
  const mailOnFor = (eid) => setting(`onboarding_mail_on:${eid}`, '1') !== '0';
  // Clients created longer ago than this get baselined silently instead of a
  // late "welcome" — the email layer is for genuinely new clients.
  const welcomeWindowDays = () => Number(setting('onboarding_welcome_window_days', '14')) || 14;

  const COPY_DEFAULTS = {
    welcomeSubject: 'Welcome to Pulse 🚀 — your event data, working for you',
    welcomeIntro: "Hi 👋 — welcome aboard! Pulse turns your live event data into insight you can act on. We'll walk you through it in easy layers, starting with the fundamentals below.",
    phaseIntro: 'Nice work — you’ve completed a whole phase of getting set up. Here’s what the next layer unlocks.',
    finaleIntro: 'That’s every phase complete — you’re getting everything Pulse has to give. 🎉',
    button: 'Open Pulse',
    signoff: 'Stuck on anything? Just reply — your Howler team is happy to help.',
  };
  const COPY_KEYS = Object.keys(COPY_DEFAULTS);
  // Empty (unset OR cleared) falls back to the default, so blanking a field in
  // the editor resets it rather than sending an empty email line.
  const copy = (k) => setting(`onboarding_copy_${k}`, '') || COPY_DEFAULTS[k] || '';

  const mailLog = (eid) => { const m = {}; try { for (const r of sql.prepare('SELECT key, sent_at FROM onboarding_mail_log WHERE entity_id=?').all(eid)) m[r.key] = r.sent_at; } catch { /* new */ } return m; };
  const markMail = (eid, key, baseline) => { try { sql.prepare('INSERT INTO onboarding_mail_log (entity_id,key,sent_at) VALUES (?,?,?) ON CONFLICT(entity_id,key) DO UPDATE SET sent_at=excluded.sent_at').run(eid, key, baseline ? 'baseline' : new Date().toISOString()); } catch { /* ignore */ } };
  const clientUserIds = (eid) => { try { return sql.prepare('SELECT user_id FROM user_entities WHERE entity_id=?').all(eid).map((r) => r.user_id); } catch { return []; } };
  const emailsOf = (ids) => ids.map((id) => db.getUser(id)).filter((u) => u && u.email && u.notifyEmail !== false).map((u) => u.email);
  // The account team for milestone emails: the per-client "Account team" list
  // (configured in Setup checklist → Reminders, shared with the setup nudges),
  // else the entity's owner + support. NEVER all admins — a client with no
  // account team configured simply doesn't email the team (set the owner!).
  const teamEmails = (e) => {
    let ids = [];
    try { ids = sql.prepare("SELECT user_id FROM setup_nudge_recipients WHERE entity_id=? AND audience='admin'").all(e.id).map((r) => r.user_id); } catch { /* table mounts later */ }
    if (!ids.length) ids = [e.howlerOwnerUserId, ...(e.howlerSupportIds || [])].filter(Boolean);
    return emailsOf([...new Set(ids)]);
  };

  // The plain-text body for a phase's step list — rides inside the branded
  // notification shell (which renders text with line breaks preserved).
  const stepLines = (phaseKey) => STEPS.filter((s) => s.phase === phaseKey).map((s) => `${s.icon} ${s.title} — ${s.desc}`).join('\n');

  // Send one branded onboarding email to the client's users (+ an inbox thread).
  // Best-effort: returns true if either surface delivered.
  function deliver(e, { title, body, subject, mailKey }) {
    let delivered = false;
    try { if (os?.announce?.({ entityId: e.id, title, body, priority: 'fyi', channels: [], subjectType: 'onboarding', subjectId: mailKey })) delivered = true; } catch { /* ignore */ }
    const to = emailsOf(clientUserIds(e.id));
    if (to.length && mailer.isConfigured?.()) {
      try {
        const { html, text } = mailer.notificationEmail({ title, body: `${body}\n\n${copy('signoff')}`, ctaText: copy('button'), ctaPath: '/', entityId: e.id, assetScope: e.id });
        mailer.send({ to, subject, html, text, kind: 'onboarding', entity: e.id, fromName: (mailer.resolveBranding(e.id) || {}).senderName });
        delivered = true;
      } catch { /* ignore */ }
    }
    return delivered;
  }

  function sendWelcome(e, prog) {
    const p1 = PHASES[0];
    const body = `${copy('welcomeIntro')}\n\nPhase 1 · ${p1.icon} ${p1.title}\n${p1.tagline}\n\n${stepLines(p1.key)}`;
    const ok = deliver(e, { title: 'Welcome to Pulse', body, subject: copy('welcomeSubject'), mailKey: 'welcome' });
    if (ok) {
      markMail(e.id, 'welcome');
      // Phases already complete at welcome time don't deserve a same-day congrats
      // blast — baseline them so the emails start from where the client really is.
      for (const ph of prog.phases.filter((x) => x.complete)) markMail(e.id, `phase:${ph.key}`, true);
    }
    return ok;
  }

  function sendPhaseComplete(e, phase) {
    const idx = PHASES.findIndex((p) => p.key === phase.key);
    const next = PHASES[idx + 1];
    const title = `Phase ${idx + 1} complete: ${phase.title} ✅`;
    const earned = phase.sticker ? `You've earned the ${phase.sticker} sticker — it's on your shelf in Pulse.\n\n` : '';
    const body = next
      ? `${copy('phaseIntro')}\n\n${earned}Next up — Phase ${idx + 2} · ${next.icon} ${next.title}\n${next.tagline}\n\n${stepLines(next.key)}`
      : `${copy('finaleIntro')}\n\n${earned}`.trim();
    const subject = next ? `${phase.title} — done ✅ Next up: ${next.title}` : 'You’re fully set up on Pulse 🎉';
    const ok = deliver(e, { title, body, subject, mailKey: `phase:${phase.key}` });
    if (ok) {
      markMail(e.id, `phase:${phase.key}`);
      // Factual heads-up to the account team, so the AM moves through the stages
      // with the client (and knows when to start the next conversation).
      const to = teamEmails(e);
      if (to.length && mailer.isConfigured?.()) {
        try { mailer.send({ to, subject: `${e.name} completed onboarding phase ${idx + 1}: ${phase.title}`, html: `<div style="font-family:system-ui,Arial,sans-serif;font-size:14px;line-height:1.5"><p><b>${e.name}</b> just completed <b>Phase ${idx + 1} · ${phase.title}</b> of their Pulse onboarding.</p><p>${next ? `They've been introduced to Phase ${idx + 2} · ${next.title} — a good moment to check in and help them take the next step.` : 'They are fully onboarded. 🎉'}</p></div>`, kind: 'onboarding' }); } catch { /* ignore */ }
      }
    }
    return ok;
  }

  // A one-tap AM nudge (the cockpit's button): a value-led "here's what's still
  // open in your current phase" note on both surfaces. No throttle — it's manual.
  function sendNudge(e) {
    const prog = progress(e.id);
    const cur = prog.phases.find((p) => !p.complete);
    if (!cur) return false;
    const idx = PHASES.findIndex((p) => p.key === cur.key);
    const open = prog.steps.filter((s) => s.phase === cur.key && !s.done);
    const body = `A little push from your Howler team 👋\n\nYou're ${cur.done} of ${cur.total} through Phase ${idx + 1} · ${cur.icon} ${cur.title} — here's what's still open:\n\n${open.map((s) => `${s.icon} ${s.title} — ${s.desc}`).join('\n')}`;
    return deliver(e, { title: `Almost there: ${cur.title}`, body, subject: `A few steps from your next Pulse milestone`, mailKey: `nudge:${cur.key}` });
  }

  // The periodic evaluator: welcomes newly-stood-up clients (first login exists)
  // and congratulates phase completions. Old clients get baselined silently.
  async function evaluate({ force = false } = {}) {
    if (!mailEnabled() && !force) return { skipped: 'disabled' };
    let entities = []; try { entities = sql.prepare('SELECT id FROM entities').all().map((r) => db.getEntity(r.id)).filter(Boolean); } catch { return { error: 'no entities' }; }
    let welcomes = 0; let phaseMails = 0;
    for (const e of entities) {
      if (!mailOnFor(e.id)) continue;
      if (!clientUserIds(e.id).length) continue; // no logins yet — welcome waits
      const log = mailLog(e.id);
      const prog = progress(e.id);
      if (!log.welcome) {
        const ageDays = e.createdAt ? (Date.now() - new Date(e.createdAt).getTime()) / 86400000 : Infinity;
        if (ageDays > welcomeWindowDays()) {
          // Predates the email layer — baseline everything already done, silently.
          markMail(e.id, 'welcome', true);
          for (const ph of prog.phases.filter((x) => x.complete)) markMail(e.id, `phase:${ph.key}`, true);
        } else if (sendWelcome(e, prog)) welcomes += 1;
        continue; // phase congrats start on the next pass — never same-run as welcome
      }
      // One phase email per run, for the FURTHEST newly-completed phase; earlier
      // newly-complete phases are baselined (one clear email beats a flood).
      const fresh = prog.phases.filter((p) => p.complete && !log[`phase:${p.key}`]);
      if (fresh.length) {
        const top = fresh[fresh.length - 1];
        for (const ph of fresh.slice(0, -1)) markMail(e.id, `phase:${ph.key}`, true);
        if (sendPhaseComplete(e, top)) phaseMails += 1;
      }
    }
    return { welcomes, phaseMails };
  }
  // Check twice an hour — a welcome lands within ~30 min of the first login.
  // unref: never keep a short-lived process (tests, scripts) alive for this.
  setInterval(() => { evaluate().catch((err) => console.error('[onboarding] evaluate failed:', err.message)); }, 30 * 60 * 1000).unref?.();

  // ── Client self-service: the entity in context ──────────────────────────────
  const canEntity = (req, entityId) => req.user.role === 'admin' || (req.user.entityIds || []).includes(entityId);
  const guard = (req, res, entityId) => { if (!canEntity(req, entityId)) { res.status(403).json({ error: 'Not allowed' }); return false; } return true; };

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

  // ── Admin: read + manage any client's journey (the AM cockpit seed) ─────────
  app.get('/api/admin/entities/:id/onboarding', auth.requireAdmin, (req, res) => {
    const log = mailLog(req.params.id);
    res.json({
      ...progress(req.params.id),
      mail: { enabled: mailEnabled(), on: mailOnFor(req.params.id), welcomeSentAt: log.welcome || null, phases: Object.fromEntries(PHASES.map((p) => [p.key, log[`phase:${p.key}`] || null])), hasLogins: clientUserIds(req.params.id).length > 0 },
    });
  });
  // Tick a manual step on the client's behalf.
  app.post('/api/admin/entities/:id/onboarding/step/:key', auth.requireAdmin, (req, res) => {
    if (!STEPS.some((s) => s.key === req.params.key)) return res.status(400).json({ error: 'Unknown step' });
    setState(req.params.id, req.params.key, !!(req.body && req.body.done));
    res.json(progress(req.params.id));
  });
  // Per-client email opt-out (welcome + phase emails).
  app.put('/api/admin/entities/:id/onboarding-mail', auth.requireAdmin, (req, res) => {
    if (typeof req.body?.on === 'boolean') db.setSetting(`onboarding_mail_on:${req.params.id}`, req.body.on ? '1' : '0');
    res.json({ ok: true, on: mailOnFor(req.params.id) });
  });
  // Send (or re-send) the welcome pack right now.
  app.post('/api/admin/entities/:id/onboarding/welcome', auth.requireAdmin, (req, res) => {
    const e = db.getEntity(req.params.id); if (!e) return res.status(404).json({ error: 'No such client' });
    if (!clientUserIds(e.id).length) return res.status(400).json({ error: 'No client logins yet — create a login first, so someone receives it.' });
    const ok = sendWelcome(e, progress(e.id));
    res.json({ ok, sentTo: emailsOf(clientUserIds(e.id)) });
  });

  // ── Global settings: kill switch + editable wording (Admin → Onboarding) ───
  app.get('/api/admin/onboarding-mail/settings', auth.requireAdmin, (_req, res) => {
    res.json({ enabled: mailEnabled(), welcomeWindowDays: welcomeWindowDays(), copy: Object.fromEntries(COPY_KEYS.map((k) => [k, copy(k)])), copyDefaults: COPY_DEFAULTS, phases: PHASES });
  });
  app.put('/api/admin/onboarding-mail/settings', auth.requireAdmin, (req, res) => {
    const b = req.body || {};
    if (typeof b.enabled === 'boolean') db.setSetting('onboarding_mail_enabled', b.enabled ? '1' : '0');
    const n = Number(b.welcomeWindowDays); if (Number.isFinite(n) && n > 0) db.setSetting('onboarding_welcome_window_days', String(Math.round(n)));
    if (b.copy && typeof b.copy === 'object') for (const k of COPY_KEYS) { if (typeof b.copy[k] === 'string') db.setSetting(`onboarding_copy_${k}`, b.copy[k].slice(0, 500)); }
    res.json({ ok: true });
  });
  // Email the logged-in admin a sample welcome pack with the current wording.
  app.post('/api/admin/onboarding-mail/test', auth.requireAdmin, (req, res) => {
    const to = req.user?.email;
    if (!to) return res.status(400).json({ error: 'Your account has no email address.' });
    if (!mailer.isConfigured?.()) return res.status(400).json({ error: 'Email is not configured.' });
    const p1 = PHASES[0];
    const body = `${copy('welcomeIntro')}\n\nPhase 1 · ${p1.icon} ${p1.title}\n${p1.tagline}\n\n${stepLines(p1.key)}\n\n${copy('signoff')}`;
    try {
      const { html, text } = mailer.notificationEmail({ title: 'Welcome to Pulse', body, ctaText: copy('button'), ctaPath: '/' });
      mailer.send({ to, subject: copy('welcomeSubject'), html, text, kind: 'onboarding' });
      res.json({ ok: true, to });
    } catch { res.status(500).json({ error: 'Send failed' }); }
  });

  console.log('[onboarding] phased journey + email layer mounted');
  return { progress, evaluate, nudge: sendNudge, phases: PHASES, bonuses: { phase: PHASE_BONUS, activated: ACTIVATED_BONUS } };
}

module.exports = { mount };
