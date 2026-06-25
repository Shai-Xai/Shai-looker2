// ─── Setup nudges — SELF-CONTAINED, DISPOSABLE MODULE ─────────────────────────
// A once-a-day evaluator that finds clients whose setup has been outstanding for
// a while and nudges the right people — BULKED so nobody gets a flood:
//   • the CLIENT's users get a value-led "get more out of Pulse" email (opt-in
//     per client), covering all that client's gaps at once. (The persistent
//     in-app onboarding card already nudges them inside Pulse.)
//   • the ACCOUNT TEAM (Howler admins) get a factual "these clients need setup"
//     email summary, bulked across all the clients assigned to them.
// Who receives it is configured per client in the back-end onboarding section
// (admin defaults to the entity's owner/support; clients are opt-in). All managed
// here — kill switch + grace + repeat cadence in settings.
//
// Mount: require('./setupNudge').mount(app, { db, auth, mailer });

function mount(app, { db, auth, mailer }) {
  const sql = db.db;
  sql.exec(`CREATE TABLE IF NOT EXISTS setup_nudge_recipients (
    entity_id TEXT NOT NULL, audience TEXT NOT NULL, user_id TEXT NOT NULL,
    PRIMARY KEY (entity_id, audience, user_id)
  );`);
  sql.exec(`CREATE TABLE IF NOT EXISTS setup_nudge_state (
    key TEXT NOT NULL, audience TEXT NOT NULL, last_sent_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (key, audience)
  );`);

  const setting = (k, d) => db.getSetting(k, d);
  const enabled = () => setting('setup_nudge_enabled', '1') !== '0';
  const graceDays = () => Number(setting('setup_nudge_grace_days', '3')) || 3;
  const repeatDays = () => Number(setting('setup_nudge_repeat_days', '7')) || 7;
  const sendHour = () => Number(setting('setup_nudge_hour', '9')) || 9;

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
  const throttled = (key, audience) => {
    try { const r = sql.prepare('SELECT last_sent_at FROM setup_nudge_state WHERE key=? AND audience=?').get(key, audience); if (!r?.last_sent_at) return false; return (Date.now() - new Date(r.last_sent_at).getTime()) < repeatDays() * 86400000; } catch { return false; }
  };
  const mark = (key, audience) => { try { sql.prepare('INSERT INTO setup_nudge_state (key,audience,last_sent_at) VALUES (?,?,?) ON CONFLICT(key,audience) DO UPDATE SET last_sent_at=excluded.last_sent_at').run(key, audience, new Date().toISOString()); } catch { /* ignore */ } };

  // ── Messages (value-led for clients, factual for the team) ──────────────────
  const li = (s) => `<li style="margin:4px 0">${s}</li>`;
  const VALUE = { 'Data scope': 'See only your events’ live numbers', 'A suite of dashboards': 'Your live dashboards, organised by event', 'A login': 'Get your team into Pulse', Branding: 'Make Pulse look like you — logo & colours', 'Email template': 'Brand the emails Pulse sends for you', Inventive: 'Ask your data questions with the AI analyst', Integrations: 'Sync audiences to Meta & TikTok', 'A digest': 'An automated briefing emailed to your team', 'Briefing tuned': 'A sharper daily read from the Owl' };
  function clientHtml(e, st) {
    const wins = st.account.map((a) => li(VALUE[a] || a)).join('');
    const evs = st.events.length ? `<p style="margin:14px 0 4px;font-weight:600">Per event, you could still add:</p><ul style="padding-left:18px;margin:0">${st.events.map((x) => li(`<b>${x.name}</b> — ${x.missing.join(', ')}`)).join('')}</ul>` : '';
    return `<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1d1d1f">
      <p>Hi 👋 — you're close to getting the most out of <b>Pulse</b>. A few quick wins are still open${st.account.length ? ':' : '.'}</p>
      ${wins ? `<ul style="padding-left:18px;margin:8px 0">${wins}</ul>` : ''}${evs}
      <p style="margin-top:16px"><a href="${mailer.baseUrl ? mailer.baseUrl() : ''}" style="background:#FF385C;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">Open Pulse</a></p>
      <p style="color:#86868b;font-size:13px;margin-top:14px">Need a hand? Just reply — your Howler team is happy to help.</p></div>`;
  }
  function adminHtml(rows) {
    const body = rows.map(({ e, st }) => `<div style="margin:0 0 14px"><div style="font-weight:700">${e.name} <span style="color:#86868b;font-weight:400">— ${st.missing} outstanding</span></div>
      ${st.account.length ? `<div style="font-size:13px;color:#444">Account: ${st.account.join(', ')}</div>` : ''}
      ${st.events.map((x) => `<div style="font-size:13px;color:#444">${x.name}: ${x.missing.join(', ')}</div>`).join('')}</div>`).join('');
    return `<div style="font-family:system-ui,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1d1d1f">
      <p><b>${rows.length}</b> client${rows.length === 1 ? '' : 's'} still have outstanding Pulse setup:</p>${body}
      <p style="color:#86868b;font-size:12px">You're getting this because you're the account owner/support. Manage who's notified per client in Admin → the client → Setup checklist → Reminders.</p></div>`;
  }

  // ── The daily run ───────────────────────────────────────────────────────────
  function evaluate({ force = false } = {}) {
    if (!enabled() && !force) return { skipped: 'disabled' };
    let entities = []; try { entities = sql.prepare('SELECT id FROM entities').all().map((r) => db.getEntity(r.id)).filter(Boolean); } catch { return { error: 'no entities' }; }
    const adminAgg = {}; let clientSent = 0;
    for (const e of entities) {
      if (!force && e.createdAt && (Date.now() - new Date(e.createdAt).getTime()) < graceDays() * 86400000) continue;
      const st = setupStatus(e.id);
      if (!st.missing) continue;
      // Client nudge (opt-in, value-led) — a targeted email to the chosen client
      // users (the persistent in-app onboarding card already nudges them in-app).
      if (clientNudgeOn(e.id) && (force || !throttled(e.id, 'client'))) {
        const emails = emailsOf(clientRecipients(e));
        if (emails.length && mailer.isConfigured?.()) { try { mailer.send({ to: emails, subject: 'Get more out of Pulse — a few quick steps left', html: clientHtml(e, st), kind: 'setup-nudge', entity: e.id }); } catch { /* ignore */ } if (!force) mark(e.id, 'client'); clientSent += 1; }
      }
      // Aggregate for the account team.
      for (const uid of adminRecipients(e)) { (adminAgg[uid] = adminAgg[uid] || []).push({ e, st }); }
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
    try { evaluate(); } catch (e) { console.error('[setupNudge] run failed:', e.message); }
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
      settings: { enabled: enabled(), graceDays: graceDays(), repeatDays: repeatDays() },
    });
  });
  app.put('/api/admin/entities/:id/setup-nudge', auth.requireAdmin, (req, res) => {
    const e = db.getEntity(req.params.id); if (!e) return res.status(404).json({ error: 'No such client' });
    const b = req.body || {};
    if (typeof b.clientOn === 'boolean') db.setSetting(`setup_nudge_client_on:${e.id}`, b.clientOn ? '1' : '0');
    const setList = (audience, ids) => { if (!Array.isArray(ids)) return; sql.prepare('DELETE FROM setup_nudge_recipients WHERE entity_id=? AND audience=?').run(e.id, audience); const ins = sql.prepare('INSERT OR IGNORE INTO setup_nudge_recipients (entity_id,audience,user_id) VALUES (?,?,?)'); for (const uid of ids) ins.run(e.id, audience, uid); };
    setList('client', b.clientRecipients); setList('admin', b.adminRecipients);
    res.json({ ok: true });
  });
  // Send the nudges for this one client right now (ignores grace/throttle) — a test.
  app.post('/api/admin/entities/:id/setup-nudge/test', auth.requireAdmin, (req, res) => {
    const e = db.getEntity(req.params.id); if (!e) return res.status(404).json({ error: 'No such client' });
    const st = setupStatus(e.id);
    try {
      const emails = emailsOf(clientRecipients(e));
      if (req.body?.audience !== 'admin' && clientNudgeOn(e.id) && emails.length && mailer.isConfigured?.()) mailer.send({ to: emails, subject: 'Get more out of Pulse — a few quick steps left', html: clientHtml(e, st), kind: 'setup-nudge', entity: e.id });
      const adminEmails = emailsOf(adminRecipients(e));
      if (req.body?.audience !== 'client' && adminEmails.length && mailer.isConfigured?.()) mailer.send({ to: adminEmails, subject: `Pulse setup: ${e.name} needs attention`, html: adminHtml([{ e, st }]), kind: 'setup-nudge' });
      res.json({ ok: true, sentTo: { client: clientNudgeOn(e.id) ? emailsOf(clientRecipients(e)) : [], admin: emailsOf(adminRecipients(e)) }, missing: st.missing });
    } catch (err) { res.status(500).json({ error: 'Send failed' }); }
  });

  console.log('[setupNudge] outstanding-setup nudges mounted');
  return { evaluate, setupStatus };
}

module.exports = { mount };
