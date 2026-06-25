// ─── Setup nudges — SELF-CONTAINED, DISPOSABLE MODULE ─────────────────────────
// A once-a-day evaluator that finds clients whose setup has been outstanding for
// a while and nudges the right people — BULKED so nobody gets a flood:
//   • the CLIENT's users get a value-led "get more out of Pulse" nudge (opt-in
//     per client), covering all that client's gaps at once, on BOTH surfaces:
//     an in-app inbox thread (their shared client inbox) + a targeted email to
//     the chosen client recipients.
//   • the ACCOUNT TEAM (Howler admins) get a factual "these clients need setup"
//     email summary, bulked across all the clients assigned to them.
// Who receives it is configured per client in the back-end onboarding section
// (admin defaults to the entity's owner/support; clients are opt-in). All managed
// here — kill switch + grace + repeat cadence in settings.
//
// Mount: require('./setupNudge').mount(app, { db, auth, mailer });

function mount(app, { db, auth, mailer, insights, resolveRecipe, audienceFor, anthropicKeyForEntity, aiInstructionsFor, os }) {
  const sql = db.db;
  sql.exec(`CREATE TABLE IF NOT EXISTS setup_nudge_recipients (
    entity_id TEXT NOT NULL, audience TEXT NOT NULL, user_id TEXT NOT NULL,
    PRIMARY KEY (entity_id, audience, user_id)
  );`);
  sql.exec(`CREATE TABLE IF NOT EXISTS setup_nudge_state (
    key TEXT NOT NULL, audience TEXT NOT NULL, last_sent_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (key, audience)
  );`);
  // Cached live metric per client (the abandoned-cart count + its AI-polished
  // line) — refreshed at most once a day so we don't re-query Looker on each run.
  sql.exec(`CREATE TABLE IF NOT EXISTS setup_nudge_metric (
    entity_id TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, line TEXT NOT NULL DEFAULT '', at TEXT NOT NULL DEFAULT ''
  );`);

  const setting = (k, d) => db.getSetting(k, d);
  const enabled = () => setting('setup_nudge_enabled', '1') !== '0';
  // Cadence — a global default with an optional per-client override (blank = inherit
  // the global). Pass an entity id to honour its override; omit it for the global.
  const cadence = (eid, key, dflt) => {
    if (eid) { const o = Number(setting(`${key}:${eid}`, '')); if (o > 0) return o; }
    return Number(setting(key, String(dflt))) || dflt;
  };
  const graceDays = (eid) => cadence(eid, 'setup_nudge_grace_days', 3);
  const repeatDays = (eid) => cadence(eid, 'setup_nudge_repeat_days', 7);
  const sendHour = () => Number(setting('setup_nudge_hour', '9')) || 9;

  // Editable wording (global) — defaults are the original hardcoded copy. Only the
  // client-facing value copy is editable; the dynamic lists (outstanding items, the
  // opportunity line) and the factual admin summary are always generated.
  const COPY_DEFAULTS = {
    subject: 'Get more out of Pulse — a few quick steps left',
    title: 'Get more out of Pulse — a few steps left',
    intro: "Hi 👋 — you're close to getting the most out of Pulse.",
    button: 'Open Pulse',
    signoff: 'Need a hand? Just reply — your Howler team is happy to help.',
  };
  const COPY_KEYS = Object.keys(COPY_DEFAULTS);
  // Empty (unset OR explicitly cleared) falls back to the default, so blanking a
  // field in the editor resets it rather than sending an empty email line.
  const copy = (k) => setting(`setup_nudge_copy_${k}`, '') || COPY_DEFAULTS[k] || '';

  const count = (q, ...a) => { try { return sql.prepare(q).get(...a)?.n || 0; } catch { return 0; } };
  const ticksFor = (eid) => { const m = {}; try { for (const r of sql.prepare('SELECT key, done FROM setup_wizard_progress WHERE entity_id=?').all(eid)) m[r.key] = r.done; } catch { /* new */ } return m; };
  const hasBrand = (b) => !!(b && (b.logo || b.brandColor || b.senderName || b.secondaryColor));
  const hasTmpl = (b) => !!(b && (b.header || b.intro || b.footer));

  // What's still outstanding for a client (account + per-event), using real data
  // plus the AM's manual ticks (amchk_… in the setup-wizard progress store).
  function setupStatus(entityId) {
    const e = db.getEntity(entityId); if (!e) return { account: [], events: [], total: 0, missing: 0 };
    const t = ticksFor(entityId);
    const done = (key, auto) => auto || t['amchk_' + key] === 1;
    const account = [];
    if (!(e.allOrganisers || Object.values(e.lockedFilters || {}).some((v) => String(v || '').trim()))) account.push('Data scope');
    const suites = db.listSuitesForEntity(entityId) || [];
    if (!suites.length) account.push('A suite of dashboards');
    if (count('SELECT COUNT(*) n FROM user_entities WHERE entity_id=?', entityId) === 0) account.push('A login');
    const brand = (() => { try { return db.getEntityMailBranding(entityId) || {}; } catch { return {}; } })();
    if (!done('branding', hasBrand(brand) || !!e.logo)) account.push('Branding');
    if (!done('emailtmpl', hasTmpl(brand))) account.push('Email template');
    if (!done('inventive', !!(e.inventiveRefId || e.inventiveName))) account.push('Inventive');
    if (!done('integrations', false)) account.push('Integrations');
    if (!done('digest', count("SELECT COUNT(*) n FROM scheduled_jobs WHERE entity_id=? AND type='digest'", entityId) > 0)) account.push('A digest');
    if (!done('briefing', false)) account.push('Briefing tuned');
    // Per event (suite)
    const events = [];
    for (const su of suites) {
      const sd = (key, auto) => auto || t[`amchk_${su.id}_${key}`] === 1;
      const sb = (() => { try { return db.getSuiteMailBranding(su.id) || {}; } catch { return {}; } })();
      const miss = [];
      if (!sd('goals', count("SELECT COUNT(*) n FROM goals WHERE suite_id=? AND scope='event' AND status='active'", su.id) > 0)) miss.push('goals');
      if (!sd('alerts', count('SELECT COUNT(*) n FROM alerts WHERE suite_id=?', su.id) > 0)) miss.push('alerts');
      if (!sd('branding', hasBrand(sb))) miss.push('branding');
      if (!sd('emailtmpl', hasTmpl(sb))) miss.push('email template');
      if (!sd('briefing', false)) miss.push('briefing');
      if (!sd('digest', false)) miss.push('digest');
      if (!sd('segment', false)) miss.push('audience');
      if (!sd('cart', false)) miss.push('abandoned-cart campaign');
      if (miss.length) events.push({ name: su.name, missing: miss });
    }
    return { account, events, missing: account.length + events.reduce((n, x) => n + x.missing.length, 0) };
  }

  // ── Recipients ──────────────────────────────────────────────────────────────
  const cfgRecipients = (eid, audience) => { try { return sql.prepare('SELECT user_id FROM setup_nudge_recipients WHERE entity_id=? AND audience=?').all(eid, audience).map((r) => r.user_id); } catch { return []; } };
  const allAdmins = () => db.listUsers().filter((u) => u.role === 'admin');
  const clientUsersOf = (eid) => { try { return sql.prepare('SELECT user_id FROM user_entities WHERE entity_id=?').all(eid).map((r) => r.user_id); } catch { return []; } };
  // Admin recipients: configured override, else the entity's owner + support, else all admins.
  function adminRecipients(e) {
    const cfg = cfgRecipients(e.id, 'admin'); if (cfg.length) return cfg;
    const owner = [e.howlerOwnerUserId, ...(e.howlerSupportIds || [])].filter(Boolean);
    if (owner.length) return owner;
    return allAdmins().map((u) => u.id);
  }
  // Client recipients: configured override, else all the client's users.
  const clientRecipients = (e) => { const cfg = cfgRecipients(e.id, 'client'); return cfg.length ? cfg : clientUsersOf(e.id); };
  const clientNudgeOn = (eid) => setting(`setup_nudge_client_on:${eid}`, '0') === '1';
  const emailsOf = (ids) => ids.map((id) => db.getUser(id)).filter((u) => u && u.email && u.notifyEmail !== false).map((u) => u.email);

  // ── Throttle ──────────────────────────────────────────────────────────────
  const throttled = (key, audience, eid) => {
    try { const r = sql.prepare('SELECT last_sent_at FROM setup_nudge_state WHERE key=? AND audience=?').get(key, audience); if (!r?.last_sent_at) return false; return (Date.now() - new Date(r.last_sent_at).getTime()) < repeatDays(eid) * 86400000; } catch { return false; }
  };
  const mark = (key, audience) => { try { sql.prepare('INSERT INTO setup_nudge_state (key,audience,last_sent_at) VALUES (?,?,?) ON CONFLICT(key,audience) DO UPDATE SET last_sent_at=excluded.last_sent_at').run(key, audience, new Date().toISOString()); } catch { /* ignore */ } };

  // ── Personalisation: a live abandoned-cart count + AI-polished line ─────────
  // Entirely best-effort — runs a live audience query (so it needs the client to
  // actually have the data/tile) and an AI call. ANY failure → returns null and
  // the nudge just uses its plain value-led copy. Cached for a day.
  const cacheMetric = (eid, n, line) => { try { sql.prepare('INSERT INTO setup_nudge_metric (entity_id,n,line,at) VALUES (?,?,?,?) ON CONFLICT(entity_id) DO UPDATE SET n=excluded.n, line=excluded.line, at=excluded.at').run(eid, n, line || '', new Date().toISOString()); } catch { /* ignore */ } };
  async function cartOpportunity(e) {
    if (typeof resolveRecipe !== 'function' || typeof audienceFor !== 'function') return null;
    try { const c = sql.prepare('SELECT n, line, at FROM setup_nudge_metric WHERE entity_id=?').get(e.id); if (c?.at && (Date.now() - new Date(c.at).getTime()) < 86400000) return c.n > 0 ? { count: c.n, line: c.line } : null; } catch { /* ignore */ }
    let count = 0;
    try {
      const rec = resolveRecipe(e.id, 'abandoned_cart');
      if (!rec?.definition?.dashboardId) { cacheMetric(e.id, 0, ''); return null; }
      const user = { id: 'system:nudge', email: '', role: 'admin', entityIds: [e.id] };
      const res = await audienceFor({ entityId: e.id, dashboardId: rec.definition.dashboardId, tileId: rec.definition.tileId, user, suiteId: '' });
      count = Array.isArray(res?.rows) ? res.rows.length : 0;
    } catch { cacheMetric(e.id, 0, ''); return null; }
    if (count <= 0) { cacheMetric(e.id, 0, ''); return null; }
    let line = '';
    try {
      const apiKey = anthropicKeyForEntity?.(e.id);
      if (apiKey && insights?.isConfigured?.(apiKey)) line = await insights.opportunityLine({ clientName: e.name, item: 'an abandoned-cart win-back campaign', metric: `${count} customers abandoned checkout without buying`, apiKey, instructions: aiInstructionsFor?.(null) || '' });
    } catch { /* fall back to templated */ }
    if (!line) line = `${count.toLocaleString()} customers abandoned checkout — a win-back campaign could bring them back.`;
    cacheMetric(e.id, count, line);
    return { count, line };
  }

  // ── Messages (value-led for clients, factual for the team) ──────────────────
  const li = (s) => `<li style="margin:4px 0">${s}</li>`;
  // Escape admin-editable copy before it lands in the HTML email.
  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const VALUE = { 'Data scope': 'See only your events’ live numbers', 'A suite of dashboards': 'Your live dashboards, organised by event', 'A login': 'Get your team into Pulse', Branding: 'Make Pulse look like you — logo & colours', 'Email template': 'Brand the emails Pulse sends for you', Inventive: 'Ask your data questions with the AI analyst', Integrations: 'Sync audiences to Meta & TikTok', 'A digest': 'An automated briefing emailed to your team', 'Briefing tuned': 'A sharper daily read from the Owl' };
  function clientHtml(e, st, opp) {
    const wins = st.account.map((a) => li(VALUE[a] || a)).join('');
    const evs = st.events.length ? `<p style="margin:14px 0 4px;font-weight:600">Per event, you could still add:</p><ul style="padding-left:18px;margin:0">${st.events.map((x) => li(`<b>${x.name}</b> — ${x.missing.join(', ')}`)).join('')}</ul>` : '';
    const hook = opp?.line ? `<div style="background:#fff0f3;border:1px solid #ffd2dd;border-radius:10px;padding:12px 14px;margin:0 0 14px;font-weight:600">💸 ${opp.line}</div>` : '';
    return `<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1d1d1f">
      <p>${esc(copy('intro'))}</p>
      ${hook}
      <p>A few quick wins are still open${st.account.length ? ':' : '.'}</p>
      ${wins ? `<ul style="padding-left:18px;margin:8px 0">${wins}</ul>` : ''}${evs}
      <p style="margin-top:16px"><a href="${mailer.baseUrl ? mailer.baseUrl() : ''}" style="background:#FF385C;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">${esc(copy('button'))}</a></p>
      <p style="color:#86868b;font-size:13px;margin-top:14px">${esc(copy('signoff'))}</p></div>`;
  }
  // Plain-text version for the in-app inbox thread (the OS spine stores message
  // bodies as text, not HTML). Same value-led framing as the email.
  function clientInboxBody(e, st, opp) {
    const lines = [copy('intro')];
    if (opp?.line) lines.push('', `💸 ${opp.line}`);
    if (st.account.length) { lines.push('', 'Still to set up:'); for (const a of st.account) lines.push(`• ${VALUE[a] || a}`); }
    if (st.events.length) { lines.push('', 'Per event, you could still add:'); for (const x of st.events) lines.push(`• ${x.name} — ${x.missing.join(', ')}`); }
    lines.push('', copy('signoff'));
    return lines.join('\n');
  }
  // Post (or re-raise) ONE thread on the client's shared inbox. channels:[] keeps
  // it inbox-only — the targeted email is sent separately. A stable subject means
  // a repeat nudge reopens the same thread instead of spawning a new one.
  const postClientInbox = (e, st, opp) => {
    try { return !!os?.announce?.({ entityId: e.id, title: copy('title'), body: clientInboxBody(e, st, opp), priority: 'fyi', channels: [], subjectType: 'setup-nudge', subjectId: 'setup' }); } catch { return false; }
  };
  function adminHtml(rows) {
    const body = rows.map(({ e, st, opp }) => `<div style="margin:0 0 14px"><div style="font-weight:700">${e.name} <span style="color:#86868b;font-weight:400">— ${st.missing} outstanding</span></div>
      ${opp?.count ? `<div style="font-size:13px;color:#b00020">~${opp.count.toLocaleString()} abandoned carts unactioned</div>` : ''}
      ${st.account.length ? `<div style="font-size:13px;color:#444">Account: ${st.account.join(', ')}</div>` : ''}
      ${st.events.map((x) => `<div style="font-size:13px;color:#444">${x.name}: ${x.missing.join(', ')}</div>`).join('')}</div>`).join('');
    return `<div style="font-family:system-ui,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1d1d1f">
      <p><b>${rows.length}</b> client${rows.length === 1 ? '' : 's'} still have outstanding Pulse setup:</p>${body}
      <p style="color:#86868b;font-size:12px">You're getting this because you're the account owner/support. Manage who's notified per client in Admin → the client → Setup checklist → Reminders.</p></div>`;
  }

  // ── The daily run ───────────────────────────────────────────────────────────
  async function evaluate({ force = false } = {}) {
    if (!enabled() && !force) return { skipped: 'disabled' };
    let entities = []; try { entities = sql.prepare('SELECT id FROM entities').all().map((r) => db.getEntity(r.id)).filter(Boolean); } catch { return { error: 'no entities' }; }
    const adminAgg = {}; let clientSent = 0;
    for (const e of entities) {
      if (!force && e.createdAt && (Date.now() - new Date(e.createdAt).getTime()) < graceDays(e.id) * 86400000) continue;
      const st = setupStatus(e.id);
      if (!st.missing) continue;
      // Personalised opportunity (live abandoned-cart count + AI line) — best-effort.
      const opp = await cartOpportunity(e).catch(() => null);
      // Client nudge (opt-in, value-led) on BOTH surfaces: an in-app inbox thread
      // (the shared client inbox) + a targeted email to the chosen client users.
      if (clientNudgeOn(e.id) && (force || !throttled(e.id, 'client', e.id))) {
        let delivered = postClientInbox(e, st, opp);
        const emails = emailsOf(clientRecipients(e));
        if (emails.length && mailer.isConfigured?.()) { try { mailer.send({ to: emails, subject: copy('subject'), html: clientHtml(e, st, opp), kind: 'setup-nudge', entity: e.id }); delivered = true; } catch { /* ignore */ } }
        if (delivered) { if (!force) mark(e.id, 'client'); clientSent += 1; }
      }
      // Aggregate for the account team.
      for (const uid of adminRecipients(e)) { (adminAgg[uid] = adminAgg[uid] || []).push({ e, st, opp }); }
    }
    // One bulked email per admin recipient.
    let adminSent = 0;
    for (const [uid, rows] of Object.entries(adminAgg)) {
      if (!force && throttled(uid, 'admin')) continue;
      const u = db.getUser(uid); if (!u || !u.email || u.notifyEmail === false) continue;
      if (mailer.isConfigured?.()) { try { mailer.send({ to: u.email, subject: `Pulse setup: ${rows.length} client${rows.length === 1 ? '' : 's'} need attention`, html: adminHtml(rows), kind: 'setup-nudge' }); adminSent += 1; } catch { /* ignore */ } }
      if (!force) mark(uid, 'admin');
    }
    return { clients: clientSent, adminEmails: adminSent };
  }

  // Daily tick: check every 20 min; run once when we hit the send hour.
  setInterval(() => {
    if (!enabled()) return;
    const now = new Date();
    if (now.getHours() !== sendHour()) return;
    const today = now.toISOString().slice(0, 10);
    if (setting('setup_nudge_last_run', '') === today) return;
    db.setSetting('setup_nudge_last_run', today);
    evaluate().catch((e) => console.error('[setupNudge] run failed:', e.message));
  }, 20 * 60 * 1000);

  // ── Admin API — managed in the client onboarding section ────────────────────
  app.get('/api/admin/entities/:id/setup-nudge', auth.requireAdmin, (req, res) => {
    const e = db.getEntity(req.params.id); if (!e) return res.status(404).json({ error: 'No such client' });
    res.json({
      clientOn: clientNudgeOn(e.id),
      clientRecipients: cfgRecipients(e.id, 'client'),
      adminRecipients: cfgRecipients(e.id, 'admin'),
      defaultAdmins: [e.howlerOwnerUserId, ...(e.howlerSupportIds || [])].filter(Boolean),
      clientUsers: clientUsersOf(e.id),
      status: setupStatus(e.id),
      // Effective cadence for this client + the raw override (blank = inheriting the
      // global default, which is sent alongside so the UI can show what's inherited).
      settings: { enabled: enabled(), graceDays: graceDays(), repeatDays: repeatDays() },
      cadence: {
        graceDays: graceDays(e.id), repeatDays: repeatDays(e.id),
        graceOverride: setting(`setup_nudge_grace_days:${e.id}`, ''),
        repeatOverride: setting(`setup_nudge_repeat_days:${e.id}`, ''),
        globalGrace: graceDays(), globalRepeat: repeatDays(),
      },
    });
  });
  app.put('/api/admin/entities/:id/setup-nudge', auth.requireAdmin, (req, res) => {
    const e = db.getEntity(req.params.id); if (!e) return res.status(404).json({ error: 'No such client' });
    const b = req.body || {};
    if (typeof b.clientOn === 'boolean') db.setSetting(`setup_nudge_client_on:${e.id}`, b.clientOn ? '1' : '0');
    const setList = (audience, ids) => { if (!Array.isArray(ids)) return; sql.prepare('DELETE FROM setup_nudge_recipients WHERE entity_id=? AND audience=?').run(e.id, audience); const ins = sql.prepare('INSERT OR IGNORE INTO setup_nudge_recipients (entity_id,audience,user_id) VALUES (?,?,?)'); for (const uid of ids) ins.run(e.id, audience, uid); };
    setList('client', b.clientRecipients); setList('admin', b.adminRecipients);
    // Per-client cadence override: '' / null clears it (back to the global default).
    const setOverride = (field, key) => { if (!(field in b)) return; const n = Number(b[field]); db.setSetting(`${key}:${e.id}`, n > 0 ? String(Math.round(n)) : ''); };
    setOverride('graceOverride', 'setup_nudge_grace_days'); setOverride('repeatOverride', 'setup_nudge_repeat_days');
    res.json({ ok: true });
  });

  // ── Global Reminders settings (cadence + editable wording) — Admin → Onboarding ─
  app.get('/api/admin/setup-nudge/settings', auth.requireAdmin, (_req, res) => {
    res.json({
      enabled: enabled(), graceDays: graceDays(), repeatDays: repeatDays(), hour: sendHour(),
      copy: Object.fromEntries(COPY_KEYS.map((k) => [k, copy(k)])), copyDefaults: COPY_DEFAULTS,
    });
  });
  app.put('/api/admin/setup-nudge/settings', auth.requireAdmin, (req, res) => {
    const b = req.body || {};
    if (typeof b.enabled === 'boolean') db.setSetting('setup_nudge_enabled', b.enabled ? '1' : '0');
    const posInt = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? String(Math.round(n)) : null; };
    if (posInt(b.graceDays)) db.setSetting('setup_nudge_grace_days', posInt(b.graceDays));
    if (posInt(b.repeatDays)) db.setSetting('setup_nudge_repeat_days', posInt(b.repeatDays));
    if (b.hour != null) { const h = Number(b.hour); if (Number.isFinite(h) && h >= 0 && h <= 23) db.setSetting('setup_nudge_hour', String(Math.round(h))); }
    if (b.copy && typeof b.copy === 'object') for (const k of COPY_KEYS) { if (typeof b.copy[k] === 'string') db.setSetting(`setup_nudge_copy_${k}`, b.copy[k].slice(0, 400)); }
    res.json({ ok: true });
  });
  // Send the nudges for this one client right now (ignores grace/throttle) — a test.
  app.post('/api/admin/entities/:id/setup-nudge/test', auth.requireAdmin, async (req, res) => {
    const e = db.getEntity(req.params.id); if (!e) return res.status(404).json({ error: 'No such client' });
    const st = setupStatus(e.id);
    const opp = await cartOpportunity(e).catch(() => null);
    try {
      const emails = emailsOf(clientRecipients(e));
      let inboxed = false;
      if (req.body?.audience !== 'admin' && clientNudgeOn(e.id)) {
        inboxed = postClientInbox(e, st, opp);
        if (emails.length && mailer.isConfigured?.()) mailer.send({ to: emails, subject: copy('subject'), html: clientHtml(e, st, opp), kind: 'setup-nudge', entity: e.id });
      }
      const adminEmails = emailsOf(adminRecipients(e));
      if (req.body?.audience !== 'client' && adminEmails.length && mailer.isConfigured?.()) mailer.send({ to: adminEmails, subject: `Pulse setup: ${e.name} needs attention`, html: adminHtml([{ e, st, opp }]), kind: 'setup-nudge' });
      res.json({ ok: true, sentTo: { client: clientNudgeOn(e.id) ? emailsOf(clientRecipients(e)) : [], admin: emailsOf(adminRecipients(e)) }, clientInbox: inboxed, missing: st.missing, opportunity: opp || null });
    } catch (err) { res.status(500).json({ error: 'Send failed' }); }
  });

  console.log('[setupNudge] outstanding-setup nudges mounted');
  return { evaluate, setupStatus };
}

module.exports = { mount };
