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

function mount(app, { db, auth, mailer }) {
  const sql = db.db;            // raw better-sqlite3 handle
  const now = () => new Date().toISOString();
  const uuid = () => crypto.randomUUID();

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
  `);

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
  function messages(id) { return sql.prepare('SELECT * FROM os_messages WHERE thread_id=? ORDER BY created_at').all(id).map(messageRow); }
  function entitiesFilter(u, qEntity) {
    if (isAdmin(u)) return qEntity ? [qEntity] : null; // null = all
    return entityIds(u);
  }

  // ── middleware ──
  const requireOn = (req, res, next) => (enabled() ? next() : res.status(404).json({ error: 'Experience OS is disabled' }));

  // ── email nudge (best-effort, fire-and-forget) ──────────────────────────────
  // When Howler posts to a client, email every login on that entity with a CTA
  // back into Pulse — the conversation itself stays in the inbox. No-ops when
  // the mailer isn't wired or configured, so this never blocks the API call.
  function emailEntity(entityId, t, body) {
    if (!mailer?.isConfigured()) return;
    const to = db.listUsers().filter((u) => u.role !== 'admin' && (u.entityIds || []).includes(entityId)).map((u) => u.email);
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
    });
    // One email per recipient so addresses are never exposed to each other.
    for (const addr of to) mailer.send({ to: addr, subject, html, text });
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
    const out = rows.map((r) => {
      const last = sql.prepare('SELECT * FROM os_messages WHERE thread_id=? ORDER BY created_at DESC LIMIT 1').get(r.id);
      const st = threadState(r.id, req.user.id);
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
    res.json({ thread: { ...t, entityName: db.getEntity(t.entityId)?.name || '' }, messages: messages(t.id), state: threadState(t.id, req.user.id) });
  });

  // Reply / post a message into a thread.
  app.post('/api/os/threads/:id/messages', auth.requireAuth, requireOn, (req, res) => {
    const t = thread(req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (!canEntity(req.user, t.entityId)) return res.status(403).json({ error: 'Not allowed' });
    const body = String((req.body || {}).body || '').slice(0, 8000).trim();
    if (!body) return res.status(400).json({ error: 'Empty message' });
    const id = uuid();
    sql.prepare('INSERT INTO os_messages (id, thread_id, author_type, author_email, author_name, channel, body, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, t.id, isAdmin(req.user) ? 'howler' : 'client', req.user.email, '', 'pulse', body, now());
    touch(t.id);
    sql.prepare('INSERT OR REPLACE INTO os_receipts (thread_id, user_id, kind, at) VALUES (?,?,?,?)').run(t.id, req.user.id, 'read', now());
    if (isAdmin(req.user)) emailEntity(t.entityId, t, body); // nudge the client when Howler replies
    res.status(201).json({ messages: messages(t.id) });
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
  app.post('/api/os/admin/announce', auth.requireAdmin, requireOn, (req, res) => {
    const { entityId, suiteId, title, body, priority } = req.body || {};
    if (!entityId || !db.getEntity(entityId)) return res.status(400).json({ error: 'Valid entityId required' });
    if (!String(body || '').trim()) return res.status(400).json({ error: 'Message body required' });
    const pri = ['fyi', 'normal', 'needs_reply', 'must_ack'].includes(priority) ? priority : 'normal';
    const id = uuid();
    const ts = now();
    sql.prepare('INSERT INTO os_threads (id, entity_id, suite_id, subject_type, subject_id, title, priority, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, entityId, suiteId || '', 'message', '', String(title || '').slice(0, 200), pri, 'open', req.user.email, ts, ts);
    sql.prepare('INSERT INTO os_messages (id, thread_id, author_type, author_email, author_name, channel, body, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(uuid(), id, 'howler', req.user.email, '', 'pulse', String(body).slice(0, 8000), ts);
    const t = thread(id);
    emailEntity(entityId, t, String(body).slice(0, 8000));
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

  console.log('[os] Experience OS spine mounted', enabled() ? '(enabled)' : '(disabled — set os_enabled=1)');
}

module.exports = { mount };
