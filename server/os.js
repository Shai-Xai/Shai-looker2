// ─── Experience OS: the comms spine ──────────────────────────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns its own tables (all `os_` prefixed)
// and all its routes (all under /api/os). Mounted from index.js with a single
// `require('./os').mount(app, { db, auth })`. To remove the whole feature:
// delete this file + that line, then drop the os_* tables. Nothing else in the
// app depends on it. A kill switch (settings key `os_enabled`) hides/disables
// it in production without a deploy.
//
// The spine: a `thread` (anchored to an entity, optionally to a subject) holds
// `messages`; per-user `receipts` track read/ack. Announcements & tasks are
// just threads with a priority / due-state — same primitive, so the model can
// grow without reshaping.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

function mount(app, { db, auth, mailer, push, slack, onInbound }) {
  const sql = db.db;            // raw better-sqlite3 handle
  const now = () => new Date().toISOString();
  const uuid = () => crypto.randomUUID();
  // Attachment files live on the persistent disk next to the DB.
  const ATT_DIR = path.join(process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data'), 'attachments');
  fs.mkdirSync(ATT_DIR, { recursive: true });

  sql.exec(`
    CREATE TABLE IF NOT EXISTS os_threads (
      id          TEXT PRIMARY KEY,
      entity_id   TEXT NOT NULL,
      suite_id    TEXT NOT NULL DEFAULT '',
      subject_type TEXT NOT NULL DEFAULT 'message',  -- message | task | settlement | document | dashboard
      subject_id  TEXT NOT NULL DEFAULT '',
      title       TEXT NOT NULL DEFAULT '',
      priority    TEXT NOT NULL DEFAULT 'normal',     -- fyi | normal | needs_reply | must_ack
      status      TEXT NOT NULL DEFAULT 'open',       -- open | closed
      created_by  TEXT NOT NULL DEFAULT '',           -- email of the author
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_os_threads_entity ON os_threads(entity_id, updated_at);

    CREATE TABLE IF NOT EXISTS os_messages (
      id           TEXT PRIMARY KEY,
      thread_id    TEXT NOT NULL,
      author_type  TEXT NOT NULL DEFAULT 'howler',    -- howler | client | owl | system
      author_email TEXT NOT NULL DEFAULT '',
      author_name  TEXT NOT NULL DEFAULT '',
      channel      TEXT NOT NULL DEFAULT 'pulse',     -- pulse | email | slack | whatsapp
      body         TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_os_messages_thread ON os_messages(thread_id, created_at);

    CREATE TABLE IF NOT EXISTS os_receipts (
      thread_id TEXT NOT NULL,
      user_id   TEXT NOT NULL,
      kind      TEXT NOT NULL DEFAULT 'read',         -- read | ack
      at        TEXT NOT NULL,
      PRIMARY KEY (thread_id, user_id, kind)
    );

    -- Files attached to messages. Bytes live on disk (ATT_DIR/<id>); this row
    -- is the metadata + the scoping anchor (entity via thread).
    CREATE TABLE IF NOT EXISTS os_attachments (
      id         TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      thread_id  TEXT NOT NULL,
      name       TEXT NOT NULL,
      mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
      size       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_os_attachments_msg ON os_attachments(message_id);
  `);

  // Idempotency for inbound email: store the source Message-ID so webhook
  // retries don't double-post. (ALTER for DBs created before this column.)
  try {
    const cols = sql.prepare('PRAGMA table_info(os_messages)').all().map((c) => c.name);
    if (!cols.includes('ext_id')) sql.exec("ALTER TABLE os_messages ADD COLUMN ext_id TEXT NOT NULL DEFAULT ''");
  } catch (e) { console.error('[os] ext_id migration skipped:', e.message); }

  const enabled = () => db.getSetting('os_enabled', '1') !== '0'; // on by default; kill switch
  const isAdmin = (u) => u && u.role === 'admin';
  const entityIds = (u) => u?.entityIds || [];
  const canEntity = (u, entityId) => isAdmin(u) || (entityId && entityIds(u).includes(entityId));

  // ── shapers ──
  function threadRow(r) {
    return {
      id: r.id, entityId: r.entity_id, suiteId: r.suite_id, subjectType: r.subject_type,
      subjectId: r.subject_id, title: r.title, priority: r.priority, status: r.status,
      createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }
  function messageRow(r) {
    return { id: r.id, threadId: r.thread_id, authorType: r.author_type, authorEmail: r.author_email, authorName: r.author_name, channel: r.channel, body: r.body, createdAt: r.created_at };
  }
  // Read/ack state for a thread + a given user.
  function threadState(threadId, userId) {
    const rows = sql.prepare('SELECT kind, at FROM os_receipts WHERE thread_id=? AND user_id=?').all(threadId, userId);
    const last = sql.prepare('SELECT MAX(created_at) m FROM os_messages WHERE thread_id=?').get(threadId)?.m || '';
    const readAt = rows.find((r) => r.kind === 'read')?.at || '';
    return { acked: rows.some((r) => r.kind === 'ack'), unread: !readAt || readAt < last };
  }
  const touch = (id) => sql.prepare('UPDATE os_threads SET updated_at=? WHERE id=?').run(now(), id);

  function thread(id) { const r = sql.prepare('SELECT * FROM os_threads WHERE id=?').get(id); return r ? threadRow(r) : null; }
  function messages(id) {
    const atts = sql.prepare('SELECT id, message_id, name, mime, size FROM os_attachments WHERE thread_id=?').all(id);
    const byMsg = {};
    for (const a of atts) (byMsg[a.message_id] = byMsg[a.message_id] || []).push({ id: a.id, name: a.name, mime: a.mime, size: a.size });
    return sql.prepare('SELECT * FROM os_messages WHERE thread_id=? ORDER BY created_at').all(id)
      .map((r) => ({ ...messageRow(r), attachments: byMsg[r.id] || [] }));
  }

  // Persist base64 attachments for a message. Defaults suit in-app uploads
  // (5 files, 10MB each); callers can raise the caps — inbound email carries
  // settlement/invoice PDFs that can run larger.
  const MAX_FILES = 5, MAX_BYTES = 10 * 1024 * 1024;
  function saveAttachments(threadId, messageId, list, { maxFiles = MAX_FILES, maxBytes = MAX_BYTES } = {}) {
    let n = 0;
    for (const f of (list || []).slice(0, maxFiles)) {
      try {
        const buf = Buffer.from(String(f.data || ''), 'base64');
        if (!buf.length || buf.length > maxBytes) continue;
        const id = uuid();
        fs.writeFileSync(path.join(ATT_DIR, id), buf);
        sql.prepare('INSERT INTO os_attachments (id, message_id, thread_id, name, mime, size, created_at) VALUES (?,?,?,?,?,?,?)')
          .run(id, messageId, threadId, String(f.name || 'file').slice(0, 200), String(f.mime || 'application/octet-stream').slice(0, 100), buf.length, now());
        n += 1;
      } catch (e) { console.error('[os] attachment save failed:', e.message); }
    }
    return n;
  }
  function entitiesFilter(u, qEntity) {
    if (isAdmin(u)) return qEntity ? [qEntity] : null; // null = all
    const own = entityIds(u);
    // Multi-profile clients: scope to the requested profile (if they own it),
    // else they'd see every profile's messages at once. No entity → all theirs.
    if (qEntity) return own.includes(qEntity) ? [qEntity] : [];
    return own;
  }

  // ── middleware ──
  const requireOn = (req, res, next) => (enabled() ? next() : res.status(404).json({ error: 'Experience OS is disabled' }));

  // ── email nudge (best-effort, fire-and-forget) ──────────────────────────────
  // When Howler posts to a client, email every login on that entity with a CTA
  // back into Pulse — the conversation itself stays in the inbox. No-ops when
  // the mailer isn't wired or configured, so this never blocks the API call.
  function emailEntity(entityId, t, body) {
    if (!mailer?.isConfigured()) return;
    // Every login LINKED to the entity that hasn't muted email — including admins
    // explicitly linked as part of this client's team (admins aren't linked by default).
    const to = db.listUsers()
      .filter((u) => (u.entityIds || []).includes(entityId) && u.notifyEmail !== false && db.notifyTypeOn(u.id, 'messages', 'email'))
      .map((u) => u.email);
    if (!to.length) return;
    const subject = t.priority === 'must_ack' ? `Action needed: ${t.title || 'a message from Howler'}`
      : t.priority === 'needs_reply' ? `Reply needed: ${t.title || 'a message from Howler'}`
      : `Howler: ${t.title || 'new message'}`;
    const lead = t.priority === 'must_ack' ? 'Howler needs you to read and acknowledge this in Pulse.'
      : t.priority === 'needs_reply' ? 'Howler is waiting on your reply in Pulse.' : '';
    const { html, text } = mailer.notificationEmail({
      title: t.title || 'A message from Howler',
      body: lead ? `${lead}\n\n${body}` : body,
      ctaText: t.priority === 'must_ack' ? 'Acknowledge in Pulse' : 'Reply in Pulse',
      ctaPath: '/inbox',
      entityId, // resolve this client's branding (logo / colour / sender / wording)
    });
    // One email per recipient so addresses are never exposed to each other.
    const fromName = (mailer.resolveBranding(entityId) || {}).senderName;
    for (const addr of to) mailer.send({ to: addr, subject, html, text, fromName, kind: 'notification', entity: entityId });
  }

  // ── push nudge (best-effort) ────────────────────────────────────────────────
  // Same fan-out as email, but to installed devices. Deep-links to the thread.
  function pushEntity(entityId, t, body) {
    if (!push?.isEnabled?.()) return;
    const brand = (mailer?.resolveBranding?.(entityId) || {});
    const title = brand.senderName ? `${brand.senderName}` : 'Howler : Pulse';
    push.sendToEntity(entityId, {
      title: t.title ? `${title}: ${t.title}` : title,
      body: String(body || '').slice(0, 180),
      url: `/inbox?thread=${t.id}`,
      tag: `thread-${t.id}`,
      icon: brand.logo && !String(brand.logo).startsWith('data:') ? brand.logo : '/logo.png',
      requireInteraction: t.priority === 'must_ack',
      // Acknowledge straight from the notification (where action buttons render).
      actions: t.priority === 'must_ack' ? [{ action: `ack:${t.id}`, title: 'Acknowledge' }, { action: 'review', title: 'Open' }] : undefined,
    }, 'messages').catch(() => {});
  }

  // Periodic reminder: a must-acknowledge thread that's still unacknowledged
  // after a delay gets a push nudge (with an Acknowledge button), re-nudging at
  // most once per window until it's acked or closed. Best-effort; respects each
  // user's push preference via sendToUser.
  function remindUnacked() {
    if (!enabled() || !push?.isEnabled?.()) return;
    const hours = Number(db.getSetting('ack_reminder_hours', '12')) || 12;
    const cutoff = new Date(Date.now() - hours * 3600e3).toISOString();
    const open = sql.prepare("SELECT * FROM os_threads WHERE priority='must_ack' AND status='open' AND created_at < ?").all(cutoff).map(threadRow);
    if (!open.length) return;
    const usersByEntity = new Map();
    for (const t of open) {
      let users = usersByEntity.get(t.entityId);
      if (!users) { users = db.listUsers().filter((u) => (u.entityIds || []).includes(t.entityId) && u.notifyPush !== false); usersByEntity.set(t.entityId, users); }
      for (const u of users) {
        if (threadState(t.id, u.id).acked) continue;
        const last = sql.prepare("SELECT at FROM os_receipts WHERE thread_id=? AND user_id=? AND kind='remind'").get(t.id, u.id)?.at;
        if (last && last > cutoff) continue; // already reminded this window
        push.sendToUser(u.id, {
          title: `Reminder: ${t.title || 'action needed'}`,
          body: 'This still needs your acknowledgement in Pulse.',
          url: `/inbox?thread=${t.id}`,
          tag: `ack-${t.id}`,
          requireInteraction: true,
          actions: [{ action: `ack:${t.id}`, title: 'Acknowledge' }, { action: 'review', title: 'Open' }],
        }, 'messages').catch(() => {});
        sql.prepare("INSERT OR REPLACE INTO os_receipts (thread_id, user_id, kind, at) VALUES (?,?,?,?)").run(t.id, u.id, 'remind', now());
      }
    }
  }
  const remindTimer = setInterval(() => { try { remindUnacked(); } catch (e) { console.error('[os] ack reminder failed', e.message); } }, 60 * 60000);
  if (remindTimer.unref) remindTimer.unref();
  setTimeout(() => { try { remindUnacked(); } catch { /* ignore */ } }, 30000);
  // Notify a client's team. `channels` chooses which methods this message uses
  // (admin's send-time choice); each recipient's own preference still applies
  // inside emailEntity / sendToEntity. Default = both.
  const VALID_CHANNELS = ['email', 'push', 'slack'];
  function cleanChannels(ch) {
    const list = Array.isArray(ch) ? ch.filter((c) => VALID_CHANNELS.includes(c)) : VALID_CHANNELS;
    return list.length ? list : VALID_CHANNELS; // never silently drop everything
  }
  // Mirror the nudge into the client's Slack, if they've connected one. Always-on
  // (not part of the admin's email/push channel choice) — connecting Slack just
  // works. Best-effort: no-ops when unconfigured, never blocks the API call.
  function slackEntity(entityId, t, body) {
    if (!slack?.isConfigured?.(entityId)) return;
    const link = mailer?.baseUrl?.() ? `${mailer.baseUrl()}/inbox?thread=${t.id}` : '';
    // Brand the Slack post with the client's sender name + logo (webhooks honour a
    // per-message name/avatar). Only pass an https logo — Slack can't fetch a
    // data: URL, and a bot token ignores these anyway (handled in slack.send).
    const brand = mailer?.resolveBranding?.(entityId) || {};
    const iconUrl = brand.logo && /^https?:\/\//.test(brand.logo) ? brand.logo : undefined;
    slack.notify({ entityId, title: t.title || 'New message in Pulse', body: String(body || '').slice(0, 2500), url: link, username: brand.senderName || undefined, iconUrl, kind: 'notification' }).catch(() => {});
  }
  function notifyEntity(entityId, t, body, channels) {
    const ch = cleanChannels(channels);
    if (ch.includes('email')) emailEntity(entityId, t, body);
    if (ch.includes('push')) pushEntity(entityId, t, body);
    if (ch.includes('slack')) slackEntity(entityId, t, body);
  }

  // ── Client + shared reads ───────────────────────────────────────────────────
  // Inbox: threads for the user's entities (admin: all, or ?entityId=). Includes
  // last message preview + unread/ack flags + pending-ack count for badges.
  app.get('/api/os/inbox', auth.requireAuth, requireOn, (req, res) => {
    const ids = entitiesFilter(req.user, req.query.entityId);
    let rows;
    if (ids === null) rows = sql.prepare('SELECT * FROM os_threads ORDER BY updated_at DESC LIMIT 200').all();
    else if (!ids.length) rows = [];
    else rows = sql.prepare(`SELECT * FROM os_threads WHERE entity_id IN (${ids.map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT 200`).all(...ids);
    const admin = isAdmin(req.user);
    // Per-user "deleted" threads stay hidden until something new arrives (the
    // thread's updated_at moves past when they hid it).
    const hidden = new Map(sql.prepare("SELECT thread_id, at FROM os_receipts WHERE user_id=? AND kind='hidden'").all(req.user.id).map((x) => [x.thread_id, x.at]));
    rows = rows.filter((r) => !(hidden.has(r.id) && hidden.get(r.id) >= r.updated_at));
    const out = rows.map((r) => {
      const last = sql.prepare('SELECT * FROM os_messages WHERE thread_id=? ORDER BY created_at DESC LIMIT 1').get(r.id);
      const st = threadState(r.id, req.user.id);
      // In the admin list, "acked" should mean the CLIENT acknowledged — not the
      // admin — so the chip reflects what Howler cares about.
      if (admin && r.priority === 'must_ack') {
        st.acked = sql.prepare("SELECT 1 FROM os_receipts re JOIN users u ON u.id=re.user_id WHERE re.thread_id=? AND re.kind='ack' AND u.role!='admin' LIMIT 1").get(r.id) ? true : false;
      }
      return { ...threadRow(r), entityName: db.getEntity(r.entity_id)?.name || '', preview: last ? messageRow(last) : null, ...st };
    });
    res.json({ threads: out, unread: out.filter((t) => t.unread).length, pendingAcks: out.filter((t) => t.priority === 'must_ack' && !t.acked).length });
  });

  // Single thread + messages (marks read).
  app.get('/api/os/threads/:id', auth.requireAuth, requireOn, (req, res) => {
    const t = thread(req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (!canEntity(req.user, t.entityId)) return res.status(403).json({ error: 'Not allowed' });
    sql.prepare('INSERT OR REPLACE INTO os_receipts (thread_id, user_id, kind, at) VALUES (?,?,?,?)').run(t.id, req.user.id, 'read', now());
    // For Howler (admin) viewers, surface the client's read/ack receipts so the
    // UI can show read/unread + acknowledgement inline next to each message —
    // WhatsApp-style, no separate panel needed.
    let clientReceipts = null;
    if (isAdmin(req.user)) {
      const rows = sql.prepare('SELECT user_id, kind, at FROM os_receipts WHERE thread_id=?').all(t.id);
      clientReceipts = rows
        .map((r) => { const u = db.getUser(r.user_id); return u && u.role !== 'admin' ? { email: u.email, kind: r.kind, at: r.at } : null; })
        .filter(Boolean);
    }
    const ent = db.getEntity(t.entityId);
    res.json({ thread: { ...t, entityName: ent?.name || '', entityLogo: ent?.logo || '' }, messages: messages(t.id), state: threadState(t.id, req.user.id), clientReceipts });
  });

  // Reply / post a message into a thread (optionally with attachments). Uses
  // its own JSON parser with a higher limit — base64 file payloads outgrow the
  // app-wide 5mb cap (index.js excludes this path from the global parser).
  const bigJson = express.json({ limit: '60mb' });
  app.post('/api/os/threads/:id/messages', bigJson, auth.requireAuth, requireOn, (req, res) => {
    const t = thread(req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (!canEntity(req.user, t.entityId)) return res.status(403).json({ error: 'Not allowed' });
    const body = String((req.body || {}).body || '').slice(0, 8000).trim();
    const files = Array.isArray((req.body || {}).attachments) ? req.body.attachments : [];
    if (!body && !files.length) return res.status(400).json({ error: 'Empty message' });
    const id = uuid();
    sql.prepare('INSERT INTO os_messages (id, thread_id, author_type, author_email, author_name, channel, body, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, t.id, isAdmin(req.user) ? 'howler' : 'client', req.user.email, '', 'pulse', body || '(attachment)', now());
    const nAtt = saveAttachments(t.id, id, files);
    touch(t.id);
    sql.prepare('INSERT OR REPLACE INTO os_receipts (thread_id, user_id, kind, at) VALUES (?,?,?,?)').run(t.id, req.user.id, 'read', now());
    if (isAdmin(req.user)) notifyEntity(t.entityId, t, nAtt ? `${body || ''}\n\n📎 ${nAtt} attachment${nAtt === 1 ? '' : 's'} — view in Pulse`.trim() : body);
    res.status(201).json({ messages: messages(t.id) });
  });

  // Download an attachment — scoped exactly like the thread it belongs to.
  app.get('/api/os/attachments/:id', auth.requireAuth, requireOn, (req, res) => {
    const a = sql.prepare('SELECT * FROM os_attachments WHERE id=?').get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    const t = thread(a.thread_id);
    if (!t || !canEntity(req.user, t.entityId)) return res.status(403).json({ error: 'Not allowed' });
    const file = path.join(ATT_DIR, a.id);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'File missing' });
    res.set('Content-Type', a.mime);
    res.set('Content-Disposition', `${req.query.dl ? 'attachment' : 'inline'}; filename="${encodeURIComponent(a.name)}"`);
    res.sendFile(file);
  });

  // Acknowledge a must-ack thread (captured: who + when).
  app.post('/api/os/threads/:id/ack', auth.requireAuth, requireOn, (req, res) => {
    const t = thread(req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (!canEntity(req.user, t.entityId)) return res.status(403).json({ error: 'Not allowed' });
    sql.prepare('INSERT OR REPLACE INTO os_receipts (thread_id, user_id, kind, at) VALUES (?,?,?,?)').run(t.id, req.user.id, 'ack', now());
    res.json({ ok: true });
  });

  // Mark a thread unread for this user (removes their read receipt so it shows
  // unread again in the list — without opening it).
  app.post('/api/os/threads/:id/unread', auth.requireAuth, requireOn, (req, res) => {
    const t = thread(req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (!canEntity(req.user, t.entityId)) return res.status(403).json({ error: 'Not allowed' });
    sql.prepare("DELETE FROM os_receipts WHERE thread_id=? AND user_id=? AND kind='read'").run(t.id, req.user.id);
    res.json({ ok: true });
  });

  // Delete a thread FROM THIS USER'S inbox (per-user hide — the shared record
  // and the other party's view are preserved). It reappears if a new message
  // arrives after it was hidden.
  app.delete('/api/os/threads/:id', auth.requireAuth, requireOn, (req, res) => {
    const t = thread(req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (!canEntity(req.user, t.entityId)) return res.status(403).json({ error: 'Not allowed' });
    sql.prepare('INSERT OR REPLACE INTO os_receipts (thread_id, user_id, kind, at) VALUES (?,?,?,?)').run(t.id, req.user.id, 'hidden', now());
    res.json({ ok: true });
  });

  // Must-ack threads the user hasn't acknowledged — drives the login banner.
  app.get('/api/os/pending', auth.requireAuth, requireOn, (req, res) => {
    const ids = entitiesFilter(req.user, null);
    if (ids !== null && !ids.length) return res.json({ pending: [] });
    const where = ids === null ? '' : `AND entity_id IN (${ids.map(() => '?').join(',')})`;
    const rows = sql.prepare(`SELECT * FROM os_threads WHERE priority='must_ack' AND status='open' ${where} ORDER BY created_at DESC`).all(...(ids === null ? [] : ids));
    const pending = rows.map(threadRow).filter((t) => !threadState(t.id, req.user.id).acked);
    res.json({ pending });
  });

  // ── Admin: send an announcement / open a thread to a client ──────────────────
  app.post('/api/os/admin/announce', bigJson, auth.requireAdmin, requireOn, (req, res) => {
    const { entityId, suiteId, title, body, priority, attachments, channels } = req.body || {};
    if (!entityId || !db.getEntity(entityId)) return res.status(400).json({ error: 'Valid entityId required' });
    if (!String(body || '').trim() && !(attachments || []).length) return res.status(400).json({ error: 'Message body required' });
    const pri = ['fyi', 'normal', 'needs_reply', 'must_ack'].includes(priority) ? priority : 'normal';
    const id = uuid();
    const ts = now();
    sql.prepare('INSERT INTO os_threads (id, entity_id, suite_id, subject_type, subject_id, title, priority, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, entityId, suiteId || '', 'message', '', String(title || '').slice(0, 200), pri, 'open', req.user.email, ts, ts);
    const mid = uuid();
    sql.prepare('INSERT INTO os_messages (id, thread_id, author_type, author_email, author_name, channel, body, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(mid, id, 'howler', req.user.email, '', 'pulse', String(body || '(attachment)').slice(0, 8000), ts);
    const nAtt = saveAttachments(id, mid, Array.isArray(attachments) ? attachments : []);
    const t = thread(id);
    // Admin announcements always mirror to a connected Slack (as they did before
    // Slack became a per-message channel) — append it to any explicit selection.
    notifyEntity(entityId, t, `${String(body || '').slice(0, 8000)}${nAtt ? `\n\n📎 ${nAtt} attachment${nAtt === 1 ? '' : 's'} — view in Pulse` : ''}`.trim(), Array.isArray(channels) ? [...channels, 'slack'] : channels);
    res.status(201).json({ thread: t });
  });

  // Programmatic announce — for other modules (e.g. campaign approval requests)
  // to post a thread to a client + notify, without going through HTTP. Pass
  // subjectType+subjectId to keep follow-up messages (submitted → rejected →
  // approved) in ONE thread per subject instead of starting a new one each time.
  function announce({ entityId, title, body, priority = 'normal', createdBy = 'system', authorType = 'system', channels, subjectType, subjectId }) {
    if (!enabled() || !entityId || !db.getEntity(entityId)) return null;
    const ts = now();
    const pri = ['fyi', 'normal', 'needs_reply', 'must_ack'].includes(priority) ? priority : 'normal';
    let id;
    const existing = (subjectType && subjectId)
      ? sql.prepare('SELECT * FROM os_threads WHERE entity_id=? AND subject_type=? AND subject_id=? ORDER BY updated_at DESC LIMIT 1').get(entityId, subjectType, subjectId)
      : null;
    if (existing) {
      id = existing.id;
      // Reopen + re-raise priority so it resurfaces in the inbox.
      sql.prepare('UPDATE os_threads SET status=?, priority=?, title=?, updated_at=? WHERE id=?').run('open', pri, String(title || existing.title).slice(0, 200), ts, id);
    } else {
      id = uuid();
      sql.prepare('INSERT INTO os_threads (id, entity_id, suite_id, subject_type, subject_id, title, priority, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, entityId, '', subjectType || 'message', subjectId || '', String(title || '').slice(0, 200), pri, 'open', createdBy, ts, ts);
    }
    sql.prepare('INSERT INTO os_messages (id, thread_id, author_type, author_email, author_name, channel, body, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(uuid(), id, authorType, createdBy, '', 'pulse', String(body || '').slice(0, 8000), ts);
    const t = thread(id);
    // `channels` undefined → default fan-out (email+push). An explicit array is taken
    // literally (even empty = inbox only) so callers like Alerts can land a thread
    // WITHOUT email/push when the user picked neither.
    if (channels === undefined) notifyEntity(entityId, t, String(body || '').slice(0, 8000));
    else { const ch = (Array.isArray(channels) ? channels : []).filter((c) => VALID_CHANNELS.includes(c)); if (ch.length) notifyEntity(entityId, t, String(body || '').slice(0, 8000), ch); }
    return t;
  }

  // Read a subject's thread (e.g. a campaign's approval conversation) for embedding
  // elsewhere. Read-only — does not mark read or mutate receipts.
  function subjectThread(entityId, subjectType, subjectId) {
    const r = sql.prepare('SELECT * FROM os_threads WHERE entity_id=? AND subject_type=? AND subject_id=? ORDER BY updated_at DESC LIMIT 1').get(entityId, subjectType, subjectId);
    if (!r) return null;
    return { thread: threadRow(r), messages: messages(r.id) };
  }

  // Admin: who has read / acknowledged a thread (the audit the ops team never had).
  app.get('/api/os/admin/threads/:id/receipts', auth.requireAdmin, requireOn, (req, res) => {
    const rows = sql.prepare('SELECT user_id, kind, at FROM os_receipts WHERE thread_id=?').all(req.params.id);
    const withEmail = rows.map((r) => ({ ...r, email: db.getUser(r.user_id)?.email || r.user_id }));
    res.json({ receipts: withEmail });
  });

  // Status (used by the client to know whether to show the feature at all).
  app.get('/api/os/status', auth.requireAuth, (req, res) => res.json({ enabled: enabled() }));

  // ── CC-the-Owl: inbound email ingestion ──────────────────────────────────────
  // External mail (email/forwards) lands here via a webhook. The Owl is CC'd on
  // a unique per-client address; we route by that address's token, thread by
  // subject, and post it as an `email`-channel message into the OS spine — so
  // outside comms become tracked, recallable knowledge alongside in-app messages.
  const inboundSecret = () => {
    let s = db.getSetting('inbound_secret', '');
    if (!s) { s = crypto.randomBytes(18).toString('base64url'); db.setSetting('inbound_secret', s); }
    return s;
  };
  // Local part of any recipient that matches a known client token wins.
  const tokenFromAddress = (addr) => String(addr || '').split('@')[0].trim().toLowerCase();

  // ── MIME tolerance ──
  // Some forwarders hand us the RAW message (encoded-word subject + multipart
  // body) instead of clean fields. Decode those so a CC'd email reads as plain
  // text in the inbox, not "=?UTF-8?Q?…" / "--boundary Content-Type: …".
  const decodeQP = (s, isWord = false) => String(s || '')
    .replace(/=\r?\n/g, '') // soft line breaks (body only; harmless for words)
    .replace(/_/g, isWord ? ' ' : '_') // '_' is space in encoded-words
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const decodeWordChunk = (charset, enc, data) => {
    try {
      const bytes = enc.toUpperCase() === 'B'
        ? Buffer.from(data, 'base64')
        : Buffer.from(decodeQP(data, true), 'binary');
      return bytes.toString(/utf-?8/i.test(charset) ? 'utf8' : 'latin1');
    } catch { return data; }
  };
  // Decode RFC 2047 "encoded-words" (subjects/headers), incl. adjacent chunks.
  const decodeEncodedWords = (s) => String(s || '')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+)(?==\?)/g, (_, c, e, d) => decodeWordChunk(c, e, d))
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, c, e, d) => decodeWordChunk(c, e, d));
  const stripHtml = (h) => String(h || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|br|tr|li|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n').trim();
  // Decode one MIME part's body per its transfer-encoding + charset (so multi-byte
  // UTF-8 like em-dashes/emoji come through, not mojibake).
  const decodePart = (headers, raw) => {
    const cte = (headers.match(/content-transfer-encoding:\s*([^\r\n;]+)/i) || [])[1]?.trim().toLowerCase();
    const charset = (headers.match(/charset="?([^"\r\n;]+)"?/i) || [])[1] || 'utf-8';
    const toStr = (buf) => buf.toString(/utf-?8/i.test(charset) ? 'utf8' : 'latin1');
    if (cte === 'base64') { try { return toStr(Buffer.from(raw.replace(/\s+/g, ''), 'base64')); } catch { return raw; } }
    if (cte === 'quoted-printable') return toStr(Buffer.from(decodeQP(raw), 'binary'));
    return raw;
  };
  // Turn a raw (possibly multipart) MIME body into readable text. Prefers the
  // text/plain part; falls back to a stripped text/html part. Non-MIME passes
  // through untouched.
  const mimeToText = (body) => {
    const s = String(body || '');
    const boundary = (s.match(/boundary="?([^"\r\n;]+)"?/i) || [])[1];
    if (boundary) {
      const parts = s.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?`));
      let plain = '', html = '';
      for (const part of parts) {
        const split = part.search(/\r?\n\r?\n/);
        if (split === -1) continue;
        const headers = part.slice(0, split);
        const raw = part.slice(split).replace(/^\r?\n\r?\n/, '');
        if (/content-type:\s*text\/plain/i.test(headers)) plain = plain || decodePart(headers, raw);
        else if (/content-type:\s*text\/html/i.test(headers)) html = html || decodePart(headers, raw);
        else if (/content-type:\s*multipart/i.test(headers)) { const inner = mimeToText(raw); if (inner) plain = plain || inner; }
      }
      const out = (plain || stripHtml(html)).trim();
      if (out) return out;
    }
    // A single part that still carries its own headers (Content-Type + a blank line).
    if (/^content-type:/im.test(s) && /\r?\n\r?\n/.test(s)) {
      const split = s.search(/\r?\n\r?\n/);
      const headers = s.slice(0, split); const raw = s.slice(split).replace(/^\r?\n\r?\n/, '');
      const decoded = decodePart(headers, raw);
      return /content-type:\s*text\/html/i.test(headers) ? stripHtml(decoded) : decoded;
    }
    return s;
  };
  const normSubject = (s) => decodeEncodedWords(String(s || '')).replace(/^((re|fwd|fw)\s*:\s*)+/i, '').trim().slice(0, 200);

  // Trim a reply email down to just the NEW text: cut the quoted original
  // ("On <date>, <name> wrote:", Outlook "From:" headers, "-----Original
  // Message-----", a ">" quote block) and common signature delimiters. Keeps the
  // inbox readable instead of carrying the whole thread each time. Conservative —
  // only trims when there's still meaningful text above the cut.
  const stripQuotedReply = (text) => {
    const s = String(text || '').replace(/\r\n/g, '\n');
    const lines = s.split('\n');
    let cut = -1;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i].trim();
      if (/^on\b.*\bwrote:\s*$/i.test(ln) // "On Wed, 17 Jun 2026 … wrote:"
        || /^-{2,}\s*original message\s*-{2,}/i.test(ln)
        || /^_{5,}\s*$/.test(ln) // Outlook divider
        || /^from:\s.+/i.test(ln) && /sent:|to:|subject:/i.test(lines.slice(i, i + 4).join(' ')) // Outlook header block
        || /^>\s?/.test(lines[i])) { cut = i; break; }
    }
    let body = cut >= 0 ? lines.slice(0, cut).join('\n') : s;
    // Strip a trailing signature ("-- " delimiter, or "Sent from my…").
    body = body.replace(/\n-- \n[\s\S]*$/,'').replace(/\n+sent from my [^\n]*$/i, '');
    body = body.replace(/\n{3,}/g, '\n\n').trim();
    // Only use the trimmed version if something substantial remains; else keep the
    // original (don't blank a message that's mostly a forward/quote).
    return body.length >= 2 ? body : s.trim();
  };
  const stripAngle = (a) => String(a || '').replace(/.*<([^>]+)>.*/, '$1').trim().toLowerCase();
  const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map(stripAngle).filter(Boolean);

  // Resolve which client an inbound email belongs to, by scanning recipients
  // (to + cc) for a local part that equals a client's inbox token.
  function routeEntity(recipients) {
    for (const addr of recipients) {
      const ent = db.findEntityByInboxToken(tokenFromAddress(addr));
      if (ent) return ent;
    }
    return null;
  }
  function authorTypeFor(entityId, fromEmail) {
    const u = db.getUserByEmail(fromEmail);
    if (u && u.role === 'admin') return 'howler';
    return 'client'; // client login OR an external participant writing into the thread
  }

  // Idempotent ingest. Returns { ok, threadId } | { skipped } | { error }.
  function ingestInbound({ from, to, cc, subject, text, html, raw, email, messageId, attachments }) {
    const fromEmail = stripAngle(from);
    const recipients = [...asList(to), ...asList(cc)];
    const ent = routeEntity(recipients);
    if (!ent) return { error: 'no matching client address', recipients };
    if (messageId) {
      const dup = sql.prepare('SELECT 1 FROM os_messages WHERE ext_id=? LIMIT 1').get(String(messageId));
      if (dup) return { skipped: true, reason: 'duplicate message-id' };
    }
    // Prefer a clean text part; fall back to stripped html, then to parsing a raw
    // MIME payload (some forwarders dump the whole message into one field).
    const looksRaw = (v) => /content-type:\s*(multipart|text)\//i.test(String(v || '')) || /boundary=/i.test(String(v || ''));
    let bodySrc = text && !looksRaw(text) ? text
      : (html ? stripHtml(html) : '');
    if (!bodySrc) bodySrc = mimeToText(text || html || raw || email || '');
    const body = stripQuotedReply(String(bodySrc || '')).slice(0, 16000).trim() || '(no body)';
    const subj = normSubject(subject) || '(no subject)';
    const ts = now();
    // Thread by normalised subject within the client; else open a new one.
    let t = sql.prepare("SELECT * FROM os_threads WHERE entity_id=? AND subject_type='message' AND title=? COLLATE NOCASE ORDER BY updated_at DESC LIMIT 1").get(ent.id, subj);
    let threadId;
    if (t) { threadId = t.id; }
    else {
      threadId = uuid();
      sql.prepare('INSERT INTO os_threads (id, entity_id, suite_id, subject_type, subject_id, title, priority, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(threadId, ent.id, '', 'message', '', subj, 'normal', 'open', fromEmail, ts, ts);
    }
    const authorType = authorTypeFor(ent.id, fromEmail);
    const mid = uuid();
    sql.prepare('INSERT INTO os_messages (id, thread_id, author_type, author_email, author_name, channel, body, created_at, ext_id) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(mid, threadId, authorType, fromEmail, '', 'email', body, ts, String(messageId || ''));
    // Inbound attachments (PDFs etc.). Forwarder posts [{ name, mime, data(base64) }].
    // Bigger caps than in-app uploads — settlement/invoice PDFs run larger. These
    // are the files the Owl's settlement auto-ingest (next slice) reads.
    const nAtt = saveAttachments(threadId, mid, Array.isArray(attachments) ? attachments : [], { maxFiles: 10, maxBytes: 25 * 1024 * 1024 });
    touch(threadId);
    // Hand stored attachments to the Owl auto-ingest (settlements/invoices), if
    // wired. Fire-and-forget: extraction is slow (AI) and must never block or
    // break the webhook response. Errors are swallowed + logged downstream.
    if (nAtt && typeof onInbound === 'function') {
      const meta = sql.prepare('SELECT id, name, mime, size FROM os_attachments WHERE message_id=?').all(mid);
      Promise.resolve().then(() => onInbound({ entityId: ent.id, threadId, messageId: mid, from: fromEmail, subject: subj, attachments: meta }))
        .catch((e) => console.error('[os] onInbound handler error:', e.message));
    }
    return { ok: true, threadId, messageId: mid, entityId: ent.id, created: !t, attachments: nAtt };
  }

  // One-time cleanup of messages/threads ingested before MIME decoding existed —
  // re-decodes raw multipart bodies and encoded-word subjects already in the DB.
  // Idempotent (only touches rows that still look raw) and guarded by a flag so
  // it scans once.
  function fixupLegacyInbound() {
    if (db.getSetting('inbound_mime_fixup_v1', '') === 'done') return;
    try {
      const msgs = sql.prepare("SELECT id, body FROM os_messages WHERE channel='email' AND (body LIKE '%Content-Type:%' OR body LIKE '%=?%?=%')").all();
      const upd = sql.prepare('UPDATE os_messages SET body=? WHERE id=?');
      let n = 0;
      for (const m of msgs) {
        const fixed = decodeEncodedWords(String(mimeToText(m.body) || '')).slice(0, 16000).trim();
        if (fixed && fixed !== m.body) { upd.run(fixed, m.id); n += 1; }
      }
      const ths = sql.prepare("SELECT id, title FROM os_threads WHERE title LIKE '%=?%?=%'").all();
      const updT = sql.prepare('UPDATE os_threads SET title=? WHERE id=?');
      let tn = 0;
      for (const th of ths) { const d = normSubject(th.title); if (d && d !== th.title) { updT.run(d, th.id); tn += 1; } }
      db.setSetting('inbound_mime_fixup_v1', 'done');
      if (n || tn) console.log(`[os] inbound MIME cleanup: fixed ${n} message(s), ${tn} subject(s)`);
    } catch (e) { console.error('[os] inbound MIME cleanup failed:', e.message); }
  }
  fixupLegacyInbound();

  // The webhook. NOT cookie-authed — protected by a shared secret (header
  // `x-owl-secret` or `?secret=`) that whatever forwards mail must include.
  // Transport-agnostic: Cloudflare Email Worker, SendGrid Parse, Resend inbound,
  // etc. all just POST this JSON shape.
  app.post('/api/inbound/email', bigJson, requireOn, (req, res) => {
    const given = req.get('x-owl-secret') || req.query.secret || (req.body || {}).secret || '';
    if (given !== inboundSecret()) return res.status(401).json({ error: 'bad secret' });
    const r = ingestInbound(req.body || {});
    if (r.ok) return res.status(201).json({ ok: true, threadId: r.threadId, attachments: r.attachments || 0 });
    if (r.skipped) return res.json({ ok: true, skipped: r.reason });
    console.warn('[os] inbound unrouted:', r.error, r.recipients || '');
    return res.status(202).json({ ok: false, error: r.error }); // 202: accepted but ignored
  });

  // Admin: inbound config (the secret + webhook URL to wire into the forwarder).
  app.get('/api/os/admin/inbound', auth.requireAdmin, (req, res) => {
    res.json({
      domain: db.getSetting('inbound_domain', ''),
      secret: inboundSecret(),
      webhookPath: '/api/inbound/email',
    });
  });
  app.put('/api/os/admin/inbound', auth.requireSuperAdmin, (req, res) => {
    if ((req.body || {}).domain !== undefined) db.setSetting('inbound_domain', String(req.body.domain || '').trim().replace(/^@/, ''));
    if ((req.body || {}).regenerateSecret) db.setSetting('inbound_secret', crypto.randomBytes(18).toString('base64url'));
    res.json({ domain: db.getSetting('inbound_domain', ''), secret: inboundSecret(), webhookPath: '/api/inbound/email' });
  });

  // Read a stored attachment's bytes (for the Owl auto-ingest to extract PDFs).
  // Scoped by the caller (the inbound hook only hands ids it just stored).
  function getAttachmentBuffer(id) {
    const a = sql.prepare('SELECT id, name, mime FROM os_attachments WHERE id=?').get(id);
    if (!a) return null;
    try { return { buf: fs.readFileSync(path.join(ATT_DIR, a.id)), name: a.name, mime: a.mime }; }
    catch (e) { console.error('[os] attachment read failed:', e.message); return null; }
  }

  console.log('[os] Experience OS spine mounted', enabled() ? '(enabled)' : '(disabled — set os_enabled=1)');
  return { announce, subjectThread, getAttachmentBuffer };
}

module.exports = { mount };
