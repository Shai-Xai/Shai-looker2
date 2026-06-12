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

function mount(app, { db, auth, mailer, push }) {
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

  // Persist base64 attachments for a message. Hard limits: 5 files, 10MB each.
  const MAX_FILES = 5, MAX_BYTES = 10 * 1024 * 1024;
  function saveAttachments(threadId, messageId, list) {
    let n = 0;
    for (const f of (list || []).slice(0, MAX_FILES)) {
      try {
        const buf = Buffer.from(String(f.data || ''), 'base64');
        if (!buf.length || buf.length > MAX_BYTES) continue;
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
    // Every login LINKED to the entity — including admins who are explicitly
    // linked as part of this client's team (admins are never linked by default).
    const to = db.listUsers().filter((u) => (u.entityIds || []).includes(entityId)).map((u) => u.email);
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
    }).catch(() => {});
  }
  // Notify a client's team across every channel (email + push).
  function notifyEntity(entityId, t, body) { emailEntity(entityId, t, body); pushEntity(entityId, t, body); }

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
    res.json({ thread: { ...t, entityName: db.getEntity(t.entityId)?.name || '' }, messages: messages(t.id), state: threadState(t.id, req.user.id), clientReceipts });
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
    const { entityId, suiteId, title, body, priority, attachments } = req.body || {};
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
    notifyEntity(entityId, t, `${String(body || '').slice(0, 8000)}${nAtt ? `\n\n📎 ${nAtt} attachment${nAtt === 1 ? '' : 's'} — view in Pulse` : ''}`.trim());
    res.status(201).json({ thread: t });
  });

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
  const normSubject = (s) => String(s || '').replace(/^((re|fwd|fw)\s*:\s*)+/i, '').trim().slice(0, 200);
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
  function ingestInbound({ from, to, cc, subject, text, html, messageId }) {
    const fromEmail = stripAngle(from);
    const recipients = [...asList(to), ...asList(cc)];
    const ent = routeEntity(recipients);
    if (!ent) return { error: 'no matching client address', recipients };
    if (messageId) {
      const dup = sql.prepare('SELECT 1 FROM os_messages WHERE ext_id=? LIMIT 1').get(String(messageId));
      if (dup) return { skipped: true, reason: 'duplicate message-id' };
    }
    const body = String(text || html || '').slice(0, 16000).trim() || '(no body)';
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
    sql.prepare('INSERT INTO os_messages (id, thread_id, author_type, author_email, author_name, channel, body, created_at, ext_id) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(uuid(), threadId, authorType, fromEmail, '', 'email', body, ts, String(messageId || ''));
    touch(threadId);
    return { ok: true, threadId, entityId: ent.id, created: !t };
  }

  // The webhook. NOT cookie-authed — protected by a shared secret (header
  // `x-owl-secret` or `?secret=`) that whatever forwards mail must include.
  // Transport-agnostic: Cloudflare Email Worker, SendGrid Parse, Resend inbound,
  // etc. all just POST this JSON shape.
  app.post('/api/inbound/email', requireOn, (req, res) => {
    const given = req.get('x-owl-secret') || req.query.secret || (req.body || {}).secret || '';
    if (given !== inboundSecret()) return res.status(401).json({ error: 'bad secret' });
    const r = ingestInbound(req.body || {});
    if (r.ok) return res.status(201).json({ ok: true, threadId: r.threadId });
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
  app.put('/api/os/admin/inbound', auth.requireAdmin, (req, res) => {
    if ((req.body || {}).domain !== undefined) db.setSetting('inbound_domain', String(req.body.domain || '').trim().replace(/^@/, ''));
    if ((req.body || {}).regenerateSecret) db.setSetting('inbound_secret', crypto.randomBytes(18).toString('base64url'));
    res.json({ domain: db.getSetting('inbound_domain', ''), secret: inboundSecret(), webhookPath: '/api/inbound/email' });
  });

  console.log('[os] Experience OS spine mounted', enabled() ? '(enabled)' : '(disabled — set os_enabled=1)');
}

module.exports = { mount };
