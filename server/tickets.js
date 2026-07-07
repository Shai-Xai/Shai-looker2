// ─── Product feedback board: bugs · improvements · ideas → tickets ─────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns its own tables (all `ticket_` prefixed)
// and all its routes. Mounted from index.js with a single
// `require('./tickets').mount(app, { db, auth, insights, adminAnthropicKey, os })`.
// To remove the whole feature: delete this file + that line, then drop the
// ticket_* tables and the promptRegistry() reference in insights.js. A kill switch
// (settings key `tickets_enabled`) hides/disables it in production without a deploy.
//
// The loop this closes (Pulse's own insight → action → results, pointed inward):
//   1. Anyone in-app (staff OR a client) reports a bug, an improvement, or an idea
//      from a global widget that captures the screen they were on.
//   2. The AI turns the raw report into a clean, structured ticket (a mini-PRD for
//      improvements/ideas; a structured bug report for bugs).
//   3. It lands on a live board (Admin → Tickets). A dev triages, accepts, assigns.
//   4. "Copy for Claude" assembles a self-contained build brief to hand to Claude.
//   5. As the ticket moves to shipped, the reporter is notified — loop closed.
//
// The AI prompt (TICKET_DRAFT_SYSTEM) is exported so insights.promptRegistry() can
// surface it in the Admin AI audit without bloating insights.js (see owlChat).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

// The one hardcoded system prompt this module owns. Kept here (not in insights.js)
// so the feature stays self-contained + disposable; referenced by name from
// insights.promptRegistry() so the "Everything the AI is told" audit stays complete.
const TICKET_DRAFT_SYSTEM = `You turn a rough, internal product report into a clean, actionable engineering ticket for Howler Pulse (a multi-tenant, white-label events analytics + client-engagement platform; Node/Express + SQLite backend, React SPA frontend; mobile-first).

You are given a report's TYPE (bug | improvement | idea), the reporter's short title, the in-app SCREEN/area they were on, the specific dashboard TILE they flagged (if any — reports filed from a dashboard can name the offending tile), and what they wrote. Rewrite it into a crisp ticket a developer (or Claude) could pick up and build. When a tile is named, treat it as the primary locus of the issue and reference it in the Affected area.

Respond with ONLY strict JSON (no markdown fences) of the form:
{
  "title": "a crisp, specific ticket title, <12 words, no trailing period",
  "ticket": "the ticket body as GitHub-flavoured markdown (see structure below)"
}

Structure the "ticket" markdown by type:
- bug → sections: **Summary** (one line), **Steps to reproduce** (numbered; infer sensible steps if the reporter didn't spell them out, and say so), **Expected vs actual**, **Affected area** (the screen/route given), **Likely severity** (one of: low / medium / high / critical, with a one-line reason).
- improvement or idea → a lightweight spec: **Objective** (the outcome the reporter wants, in their words, tightened), **Problem / why now** (the pain or opportunity), **Proposed approach** (1-3 concrete options or a recommended direction — keep it high-level, don't over-design), **Acceptance criteria** (a short bullet checklist of what "done" looks like), **Affected area** (screen/route + likely surfaces), **Effort** (rough t-shirt size: S / M / L, with a one-line reason).

Rules:
- Be concrete and specific; interpret the report, don't just restate it. Preserve the reporter's actual intent and any facts they gave — never invent product behaviour or claims you can't support.
- Where you're inferring (repro steps, severity, effort), make it obvious it's an inference so a human can correct it.
- Keep it tight and skimmable — short sentences, bullets over prose. No preamble, no sign-off, no emojis.
- Remember Pulse's principles: mobile-first, and every client-facing feature ships with both an admin surface and client self-service. Flag it in the ticket if the request would need both.`;

function mount(app, { db, auth, insights, adminAnthropicKey, os, github, push }) {
  const sql = db.db;                 // raw better-sqlite3 handle
  const now = () => new Date().toISOString();
  const uuid = () => crypto.randomUUID();
  // Report attachments (screenshots / images / short videos) live on the persistent
  // disk next to the DB, in their own folder so the feature stays self-removable.
  const ATT_DIR = path.join(process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data'), 'ticket-attachments');
  fs.mkdirSync(ATT_DIR, { recursive: true });

  sql.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id            TEXT PRIMARY KEY,
      type          TEXT NOT NULL DEFAULT 'bug',      -- bug | improvement | idea
      title         TEXT NOT NULL DEFAULT '',         -- the reporter's short title
      body          TEXT NOT NULL DEFAULT '',         -- what the reporter wrote (raw)
      screen        TEXT NOT NULL DEFAULT '',         -- in-app route/screen they were on
      urgency       TEXT NOT NULL DEFAULT 'normal',   -- low | normal | high | urgent
      status        TEXT NOT NULL DEFAULT 'inbox',    -- inbox|triaged|accepted|in_progress|in_review|shipped|declined
      priority      INTEGER NOT NULL DEFAULT 0,       -- dev-set ordering within a lane (higher = top)
      reporter_id    TEXT NOT NULL DEFAULT '',
      reporter_email TEXT NOT NULL DEFAULT '',
      reporter_name  TEXT NOT NULL DEFAULT '',
      reporter_role  TEXT NOT NULL DEFAULT 'client',  -- admin | client (who filed it)
      entity_id     TEXT NOT NULL DEFAULT '',         -- the client this relates to (if any)
      assignee      TEXT NOT NULL DEFAULT '',         -- dev who picked it up (email)
      ai_title      TEXT NOT NULL DEFAULT '',         -- AI-suggested crisp title
      ai_summary    TEXT NOT NULL DEFAULT '',         -- AI-structured ticket (markdown)
      ai_status     TEXT NOT NULL DEFAULT 'pending',  -- pending | ready | error | skipped
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status, priority, updated_at);
    CREATE INDEX IF NOT EXISTS idx_tickets_reporter ON tickets(reporter_id, created_at);

    -- Activity log: dev notes + status-change history for one ticket.
    CREATE TABLE IF NOT EXISTS ticket_comments (
      id           TEXT PRIMARY KEY,
      ticket_id    TEXT NOT NULL,
      author_email TEXT NOT NULL DEFAULT '',
      author_role  TEXT NOT NULL DEFAULT 'admin',
      kind         TEXT NOT NULL DEFAULT 'comment',  -- comment | status | system
      body         TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_comments ON ticket_comments(ticket_id, created_at);

    -- Files attached to a report (screenshot / image / video). Bytes live on disk
    -- (ATT_DIR/<id>); this row is the metadata + the scoping anchor (via ticket).
    CREATE TABLE IF NOT EXISTS ticket_attachments (
      id         TEXT PRIMARY KEY,
      ticket_id  TEXT NOT NULL,
      name       TEXT NOT NULL,
      mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
      size       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_attachments ON ticket_attachments(ticket_id);
  `);

  // Ship → review columns (added after the first release, so ALTER for existing DBs).
  // ship_note = the overview of what was built; test_url = where the reporter tests it;
  // client_verdict = approved | rejected once they've reviewed the shipped work.
  try {
    const cols = sql.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
    const add = (name, ddl) => { if (!cols.includes(name)) sql.exec(`ALTER TABLE tickets ADD COLUMN ${ddl}`); };
    add('ship_note', "ship_note TEXT NOT NULL DEFAULT ''");
    add('test_url', "test_url TEXT NOT NULL DEFAULT ''");
    add('client_verdict', "client_verdict TEXT NOT NULL DEFAULT ''");
    add('client_verdict_note', "client_verdict_note TEXT NOT NULL DEFAULT ''");
    add('client_verdict_at', "client_verdict_at TEXT NOT NULL DEFAULT ''");
    add('github_issue_number', 'github_issue_number INTEGER NOT NULL DEFAULT 0');
    add('github_url', "github_url TEXT NOT NULL DEFAULT ''");
    add('decline_reason', "decline_reason TEXT NOT NULL DEFAULT ''");
    add('source', "source TEXT NOT NULL DEFAULT 'widget'"); // entry point: 'widget' (form) | 'owl' (chat)
    add('github_pr_number', 'github_pr_number INTEGER NOT NULL DEFAULT 0');
    add('github_pr_url', "github_pr_url TEXT NOT NULL DEFAULT ''");
    // A report filed from a dashboard can pinpoint the specific tile it's about,
    // so triage doesn't have to guess which chart/table is affected.
    add('tile_id', "tile_id TEXT NOT NULL DEFAULT ''");     // the tile's id on the dashboard
    add('tile_name', "tile_name TEXT NOT NULL DEFAULT ''"); // its human title (for display)
    // Which environment this ticket is built into: 'staging' (test first, then
    // promote) or 'production' (straight to main). Legacy rows default to production.
    add('target', "target TEXT NOT NULL DEFAULT 'production'");
  } catch (e) { console.error('[tickets] ship-review migration skipped:', e.message); }
  // Comments gained a visibility flag (internal dev note vs public reply the
  // reporter sees + gets notified about) after launch — ALTER for existing DBs.
  try { sql.exec("ALTER TABLE ticket_comments ADD COLUMN visibility TEXT NOT NULL DEFAULT 'internal'"); } catch { /* already present */ }

  const enabled = () => db.getSetting('tickets_enabled', '1') !== '0'; // on by default; kill switch
  const requireOn = (req, res, next) => (enabled() ? next() : res.status(404).json({ error: 'The product board is disabled' }));
  // Reports can carry base64 screenshots/images/short videos — bigger than the
  // app-wide 5mb JSON cap (index.js excludes /api/my/tickets from the global parser).
  const bigJson = express.json({ limit: '150mb' });
  const isAdmin = (u) => u && u.role === 'admin';

  const TYPES = ['bug', 'improvement', 'idea'];
  const URGENCIES = ['low', 'normal', 'high', 'urgent'];
  const STATUSES = ['inbox', 'triaged', 'accepted', 'in_progress', 'staging', 'shipped', 'approved', 'rejected', 'declined'];
  const STATUS_LABELS = {
    inbox: 'New', triaged: 'Triaged', accepted: 'Accepted', in_progress: 'In progress',
    staging: 'On staging — verify', shipped: 'Shipped — awaiting review', approved: 'Approved', rejected: 'Rejected — reopen', declined: 'Declined',
  };
  const clamp = (s, n) => String(s || '').slice(0, n);

  const userName = (u) => (u?.fullName || [u?.firstName, u?.lastName].filter(Boolean).join(' ') || u?.email || '').trim();

  // ── attachments ──
  // Persist base64 files for a report. Caps suit a screenshot or two plus a short
  // screen recording; oversized/empty payloads are skipped, never fatal.
  const MAX_FILES = 4, MAX_BYTES = 30 * 1024 * 1024; // 30MB each (base64 inflates ~33%)
  function saveAttachments(ticketId, list) {
    let n = 0;
    for (const f of (Array.isArray(list) ? list : []).slice(0, MAX_FILES)) {
      try {
        const buf = Buffer.from(String(f.data || '').replace(/^data:[^,]*,/, ''), 'base64');
        if (!buf.length || buf.length > MAX_BYTES) continue;
        const id = uuid();
        fs.writeFileSync(path.join(ATT_DIR, id), buf);
        sql.prepare('INSERT INTO ticket_attachments (id, ticket_id, name, mime, size, created_at) VALUES (?,?,?,?,?,?)')
          .run(id, ticketId, String(f.name || 'file').slice(0, 200), String(f.mime || 'application/octet-stream').slice(0, 100), buf.length, now());
        n += 1;
      } catch (e) { console.error('[tickets] attachment save failed:', e.message); }
    }
    return n;
  }
  const attList = (ticketId) => sql.prepare('SELECT id, name, mime, size FROM ticket_attachments WHERE ticket_id=? ORDER BY created_at').all(ticketId)
    .map((a) => ({ id: a.id, name: a.name, mime: a.mime, size: a.size, url: `/api/tickets/attachments/${a.id}` }));

  // ── shapers ──
  function ticketRow(r) {
    return {
      id: r.id, type: r.type, title: r.title, body: r.body, screen: r.screen, urgency: r.urgency,
      tileId: r.tile_id || '', tileName: r.tile_name || '',
      status: r.status, statusLabel: STATUS_LABELS[r.status] || r.status, priority: r.priority,
      reporterEmail: r.reporter_email, reporterName: r.reporter_name, reporterRole: r.reporter_role,
      entityId: r.entity_id, entityName: r.entity_id ? (db.getEntity(r.entity_id)?.name || '') : '',
      assignee: r.assignee, aiTitle: r.ai_title, aiSummary: r.ai_summary, aiStatus: r.ai_status, source: r.source || 'widget',
      shipNote: r.ship_note || '', testUrl: r.test_url || '',
      clientVerdict: r.client_verdict || '', clientVerdictNote: r.client_verdict_note || '', clientVerdictAt: r.client_verdict_at || '', declineReason: r.decline_reason || '',
      githubIssue: r.github_issue_number || 0, githubUrl: r.github_url || '', prNumber: r.github_pr_number || 0, prUrl: r.github_pr_url || '',
      target: r.target || 'production',
      attachments: attList(r.id), createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }
  // The client's own view: their content + progress, none of the internal dev fields.
  function myTicketRow(r) {
    return {
      id: r.id, type: r.type, title: r.title, body: r.body, screen: r.screen, urgency: r.urgency,
      tileId: r.tile_id || '', tileName: r.tile_name || '',
      status: r.status, statusLabel: STATUS_LABELS[r.status] || r.status,
      aiTitle: r.ai_title, aiSummary: r.ai_summary, aiStatus: r.ai_status,
      shipNote: r.ship_note || '', testUrl: r.test_url || '', target: r.target || 'production',
      clientVerdict: r.client_verdict || '', clientVerdictNote: r.client_verdict_note || '', clientVerdictAt: r.client_verdict_at || '', declineReason: r.decline_reason || '',
      attachments: attList(r.id), comments: comments(r.id, { publicOnly: true }), createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }
  const getTicket = (id) => sql.prepare('SELECT * FROM tickets WHERE id=?').get(id);
  const touch = (id) => sql.prepare('UPDATE tickets SET updated_at=? WHERE id=?').run(now(), id);
  function logComment(ticketId, { authorEmail = 'system', authorRole = 'system', kind = 'comment', body = '', visibility = 'internal' }) {
    sql.prepare('INSERT INTO ticket_comments (id, ticket_id, author_email, author_role, kind, body, visibility, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(uuid(), ticketId, authorEmail, authorRole, kind, clamp(body, 8000), visibility === 'public' ? 'public' : 'internal', now());
  }
  // All comments for the admin trail; publicOnly = the reporter-facing conversation
  // (public replies only — status/system lines and internal dev notes stay internal).
  const comments = (id, { publicOnly = false } = {}) => sql.prepare(
    `SELECT * FROM ticket_comments WHERE ticket_id=?${publicOnly ? " AND visibility='public' AND kind='comment'" : ''} ORDER BY created_at`,
  ).all(id)
    .map((c) => ({ id: c.id, authorEmail: c.author_email, authorRole: c.author_role, kind: c.kind, visibility: c.visibility || 'internal', body: c.body, createdAt: c.created_at }));

  // ── AI drafting ───────────────────────────────────────────────────────────────
  // Turn the raw report into a structured ticket. Uses the shared insights client +
  // resilient JSON parser (no prompt in insights.js — see TICKET_DRAFT_SYSTEM above).
  async function draftTicket({ type, title, body, screen, tile }) {
    const apiKey = adminAnthropicKey ? adminAnthropicKey() : (process.env.ANTHROPIC_API_KEY || '');
    const c = insights.requireClient(apiKey); // throws NO_API_KEY when unset (caller handles)
    const user = [
      `Type: ${type}`,
      `Reporter's title: ${title || '(none given)'}`,
      `Screen / area: ${screen || '(unknown)'}`,
      ...(tile ? [`Affected tile: ${tile}`] : []),
      '',
      'What they wrote:',
      body || '(no description)',
    ].join('\n');
    const resp = await c.messages.create({
      model: insights.MODEL,
      max_tokens: 1400,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      system: insights.systemWith(TICKET_DRAFT_SYSTEM, db.getSetting('ai_instructions')),
      messages: [{ role: 'user', content: user }],
    });
    const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const parsed = await insights.parseModelJsonResilient(c, text, 'ticket');
    return { title: clamp(parsed?.title || '', 160), summary: String(parsed?.ticket || parsed?.summary || '') };
  }
  // Draft in the background after a report is filed; write the result back. Never
  // throws into the request path — a failed/absent AI just leaves the raw report.
  function draftInBackground(id) {
    const t = getTicket(id);
    if (!t) return;
    if (!insights.isConfigured(adminAnthropicKey ? adminAnthropicKey() : process.env.ANTHROPIC_API_KEY)) {
      sql.prepare('UPDATE tickets SET ai_status=? WHERE id=?').run('skipped', id);
      return;
    }
    draftTicket({ type: t.type, title: t.title, body: t.body, screen: t.screen, tile: t.tile_name })
      .then(({ title, summary }) => {
        sql.prepare('UPDATE tickets SET ai_title=?, ai_summary=?, ai_status=? WHERE id=?')
          .run(title, summary, 'ready', id);
      })
      .catch((e) => {
        console.error('[tickets] AI draft failed:', e.message);
        sql.prepare('UPDATE tickets SET ai_status=? WHERE id=?').run('error', id);
      });
  }

  // Assemble the self-contained "Copy for Claude" build brief. Everything a coding
  // agent needs to pick the ticket up: the structured spec, where it lives, the
  // acceptance bar, and the house rules (mobile-first, dual-surface, ratcheted
  // module budgets, push to branch + main).
  // The branch a build for this ticket should target: the staging branch when the
  // ticket is aimed at staging (test-first), otherwise production (main).
  const prodBranch = () => github?.prodBranch?.() || 'main';
  const stagingBranch = () => github?.stagingBranch?.() || 'staging';
  const baseBranchFor = (t) => (t.target === 'staging' ? stagingBranch() : prodBranch());
  function claudeBrief(t) {
    const spec = (t.ai_status === 'ready' && t.ai_summary) ? t.ai_summary
      : `**${t.type} report (unstructured — AI draft unavailable):**\n\n${t.body || '(no description)'}`;
    const heading = t.ai_title || t.title || `${t.type} report`;
    const base = baseBranchFor(t);
    const atts = attList(t.id);
    return [
      `# Build ticket: ${heading}`,
      '',
      `- **Type:** ${t.type}`,
      `- **Screen / area:** ${t.screen || 'unknown'}`,
      t.tile_name ? `- **Affected tile:** ${t.tile_name}${t.tile_id ? ` (tile id: ${t.tile_id})` : ''}` : '',
      `- **Urgency:** ${t.urgency}`,
      `- **Reported by:** ${t.reporter_name || t.reporter_email}${t.entity_id ? ` (client: ${db.getEntity(t.entity_id)?.name || t.entity_id})` : ''}`,
      `- **Ticket id:** ${t.id}`,
      atts.length ? `- **Attachments:** ${atts.map((a) => a.name).join(', ')} (screenshots/video the reporter added — ask a human to view these; they aren't in this text).` : '',
      '',
      // A ticket the client sent back after review: lead with what still needs fixing.
      t.client_verdict === 'rejected' && t.client_verdict_note
        ? `## ⚠️ Sent back by the reporter — fix this first\n\n${t.client_verdict_note}\n` : '',
      '## Spec',
      '',
      spec,
      '',
      `- **Deploy target:** ${t.target === 'staging' ? `staging (test first) — open the pull request against the \`${base}\` branch` : `production — open the pull request against the \`${base}\` branch`}`,
      '',
      '## How to build it',
      '',
      '1. Work in the Howler Pulse repo. Read `CLAUDE.md` + `PROJECT_OVERVIEW.md` first for conventions.',
      '2. Keep it **mobile-first**; if it is client-facing, ship **both** an admin surface and client self-service (the dual-surface rule).',
      '3. Prefer a small, self-contained module over growing a god-file; respect the server line budgets.',
      '4. Implement the acceptance criteria above, then verify (tests / run the app).',
      `5. Commit with a clear message and open the pull request against the **\`${base}\`** branch (${t.target === 'staging' ? 'it deploys to the staging server so this can be tested before production' : 'production — Render deploys from it'}).`,
      '',
      '_When done, the merged PR auto-updates this ticket on the Pulse product board so the reporter is notified._',
    ].join('\n');
  }

  // ── Submit (staff OR client) — the global report widget posts here ─────────────
  // Any logged-in user can file. Reporter + entity are derived server-side from the
  // session (never trusted from the body) so a client can't file against another
  // client. entity_id: for a client, their (first) entity; an admin may name one.
  // Shared creation path — used by the report widget (POST below) and the Owl act
  // layer. `source` tags the entry point ('widget' | 'owl') so we can compare what
  // people prefer. Pre-drafted aiTitle/aiSummary (the Owl already structured it in
  // chat) skip the background AI draft. Entity is derived from the reporter: an
  // admin may target a client; a client is locked to one they own. Throws on empty.
  function createTicket({ user, type, title, body, screen, urgency, entityId, attachments, source = 'widget', aiTitle, aiSummary, tileId, tileName }) {
    const t = TYPES.includes(type) ? type : 'bug';
    const urg = URGENCIES.includes(urgency) ? urgency : 'normal';
    const ti = clamp(title, 200).trim();
    const bo = clamp(body, 8000).trim();
    const sc = clamp(screen, 300).trim();
    const tileI = clamp(tileId, 100).trim();     // the flagged tile (optional; dashboards only)
    const tileN = clamp(tileName, 300).trim();
    if (!bo && !ti) { const e = new Error('Add a title or a description.'); e.code = 'EMPTY'; throw e; }
    const admin = isAdmin(user);
    const eid = admin
      ? (entityId && db.getEntity(entityId) ? entityId : '')
      : ((user.entityIds || []).includes(entityId) ? entityId : (user.entityIds || [])[0] || '');
    const id = uuid();
    const ts = now();
    const preDrafted = !!(aiTitle || aiSummary);
    sql.prepare(`INSERT INTO tickets
      (id, type, title, body, screen, tile_id, tile_name, urgency, status, priority, reporter_id, reporter_email, reporter_name, reporter_role, entity_id, source, ai_title, ai_summary, ai_status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, t, ti, bo, sc, tileI, tileN, urg, 'inbox', 0, user.id, user.email, userName(user),
        admin ? 'admin' : 'client', eid, source === 'owl' ? 'owl' : 'widget',
        clamp(aiTitle || '', 200), String(aiSummary || '').slice(0, 20000), preDrafted ? 'ready' : 'pending', ts, ts);
    saveAttachments(id, attachments); // screenshots / images / short video
    if (!preDrafted) draftInBackground(id); // fire-and-forget; the row is already saved
    return myTicketRow(getTicket(id));
  }

  app.post('/api/my/tickets', bigJson, auth.requireAuth, requireOn, (req, res) => {
    const b = req.body || {};
    try {
      const ticket = createTicket({ user: req.user, type: b.type, title: b.title, body: b.body, screen: b.screen, urgency: b.urgency, entityId: b.entityId, attachments: b.attachments, tileId: b.tileId, tileName: b.tileName, source: 'widget' });
      res.status(201).json({ ticket });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Client self-service: the tickets I reported (my content + live status).
  app.get('/api/my/tickets', auth.requireAuth, requireOn, (req, res) => {
    const rows = sql.prepare('SELECT * FROM tickets WHERE reporter_id=? ORDER BY created_at DESC LIMIT 200').all(req.user.id);
    res.json({ tickets: rows.map(myTicketRow) });
  });

  // Serve an attachment's bytes — scoped like its ticket: an admin, or the person
  // who reported it. Inline by default (so images/video render); ?dl to download.
  app.get('/api/tickets/attachments/:id', auth.requireAuth, requireOn, (req, res) => {
    const a = sql.prepare('SELECT * FROM ticket_attachments WHERE id=?').get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    const t = getTicket(a.ticket_id);
    if (!t || !(isAdmin(req.user) || t.reporter_id === req.user.id)) return res.status(403).json({ error: 'Not allowed' });
    const file = path.join(ATT_DIR, a.id);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'File missing' });
    res.set('Content-Type', a.mime);
    res.set('Content-Disposition', `${req.query.dl ? 'attachment' : 'inline'}; filename="${encodeURIComponent(a.name)}"`);
    res.sendFile(file);
  });

  // ── Admin board ────────────────────────────────────────────────────────────────
  app.get('/api/admin/tickets', auth.requireAdmin, requireOn, (req, res) => {
    const { type, status } = req.query || {};
    const where = [], args = [];
    if (TYPES.includes(type)) { where.push('type=?'); args.push(type); }
    if (STATUSES.includes(status)) { where.push('status=?'); args.push(status); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = sql.prepare(`SELECT * FROM tickets ${clause} ORDER BY priority DESC, updated_at DESC LIMIT 500`).all(...args);
    const counts = {};
    for (const s of STATUSES) counts[s] = 0;
    for (const r of sql.prepare('SELECT status, COUNT(*) n FROM tickets GROUP BY status').all()) counts[r.status] = r.n;
    res.json({ tickets: rows.map(ticketRow), counts, columns: STATUSES, labels: STATUS_LABELS });
  });

  // Who a ticket can be assigned to: Howler admins + anyone tagged with the 'dev'
  // role. Declared before the :id route so "assignees" isn't read as a ticket id.
  app.get('/api/admin/tickets/assignees', auth.requireAdmin, requireOn, (_req, res) => {
    const users = db.listUsers().filter((u) => u.role === 'admin' || (u.roles || []).includes('dev'));
    const assignees = users
      .map((u) => ({ email: u.email, name: userName(u), isAdmin: u.role === 'admin', isDev: (u.roles || []).includes('dev') }))
      .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
    res.json({ assignees });
  });

  app.get('/api/admin/tickets/:id', auth.requireAdmin, requireOn, (req, res) => {
    const t = getTicket(req.params.id);
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    res.json({ ticket: ticketRow(t), comments: comments(t.id), claudeBrief: claudeBrief(t) });
  });

  // Create a GitHub issue from this ticket (the build brief becomes the issue body).
  // If GitHub isn't configured, hand back a prefilled new-issue URL so the admin's
  // browser can file it manually — the feature works with zero server credentials.
  app.post('/api/admin/tickets/:id/github-issue', auth.requireAdmin, requireOn, async (req, res) => {
    let t = getTicket(req.params.id);
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    if (t.github_url) return res.json({ ticket: ticketRow(t), alreadyLinked: true });
    // Deploy target chosen at send time: 'staging' (test first, then promote) or
    // 'production' (straight to main). Default staging — safer, promote once verified.
    const target = (req.body || {}).target === 'production' ? 'production' : 'staging';
    if (target !== t.target) { sql.prepare('UPDATE tickets SET target=?, updated_at=? WHERE id=?').run(target, now(), t.id); t = getTicket(t.id); }
    const base = baseBranchFor(t);
    const title = t.ai_title || t.title || `${t.type} report`;
    let body = `${claudeBrief(t)}\n\n---\n_Filed from Howler Pulse · ticket ${t.id}_`;
    // Dispatch mode: 'build' → @claude builds + opens a PR; 'plan' → @claude posts a
    // plan + questions and waits (good for big/fuzzy tickets); omitted → the global
    // "Ask Claude to build it" toggle decides. Pulse issues are created via a PAT,
    // which (unlike GITHUB_TOKEN) does trigger the Claude Code Action.
    const mode = (req.body || {}).mode;
    const doBuild = mode === 'build' || (!mode && !!github?.dispatchEnabled?.());
    if (mode === 'plan') body += `\n\n@claude review this ticket and reply with a short implementation plan and any clarifying questions as a comment. Do NOT write code or open a pull request yet — wait for a follow-up "@claude go ahead" before building. When you do build, open the PR against the \`${base}\` branch.`;
    else if (doBuild) body += `\n\n@claude please implement this ticket and open a pull request against the \`${base}\` branch.`;
    const dispatched = doBuild || mode === 'plan';
    if (!github?.isConfigured?.()) {
      return res.json({ needsConfig: true, prefillUrl: github?.newIssueUrl?.({ title, body }) || '' });
    }
    try {
      const issue = await github.createIssue({ title, body });
      sql.prepare('UPDATE tickets SET github_issue_number=?, github_url=?, updated_at=? WHERE id=?').run(issue.number, issue.url, now(), t.id);
      logComment(t.id, { authorEmail: req.user.email, authorRole: 'admin', kind: 'system', body: `Created GitHub issue #${issue.number} → ${target} (\`${base}\`)${mode === 'plan' ? ' and asked Claude to plan it' : doBuild ? ' and asked Claude to build it' : ''}: ${issue.url}` });
      // Sending to GitHub IS the acceptance act — advance early-stage tickets so the
      // board reflects it (the reporter gets the "accepted" nudge). Later stages stay.
      if (['inbox', 'triaged'].includes(t.status)) {
        sql.prepare('UPDATE tickets SET status=?, updated_at=? WHERE id=?').run('accepted', now(), t.id);
        logComment(t.id, { authorEmail: req.user.email, authorRole: 'admin', kind: 'status', body: `${STATUS_LABELS[t.status]} → ${STATUS_LABELS.accepted} (sent to GitHub)` });
        notifyReporter(getTicket(t.id), t.status);
      }
      res.status(201).json({ ticket: ticketRow(getTicket(t.id)), issue, dispatched, planned: mode === 'plan' });
    } catch (e) {
      console.error('[tickets] github issue failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Promote to production: open (or reuse) the release PR that merges the staging
  // branch into production. Release-train — merging it ships EVERY ticket currently
  // on staging (the webhook flips them to Shipped on merge). Honest about that: the
  // response lists how many staging tickets ride along. No per-ticket cherry-pick —
  // a shared staging branch can't cleanly un-merge one change.
  app.post('/api/admin/tickets/:id/promote', auth.requireAdmin, requireOn, async (req, res) => {
    const t = getTicket(req.params.id);
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    if (!github?.isConfigured?.()) return res.status(400).json({ error: 'Connect GitHub (token + repo) to promote.' });
    const staged = sql.prepare("SELECT id, ai_title, title FROM tickets WHERE status='staging'").all();
    const lines = staged.map((s) => `- ${s.ai_title || s.title || s.id}${s.github_issue_number ? ` (#${s.github_issue_number})` : ''}`);
    const body = [`Promote staging → production (release).`, '', `Ships ${staged.length} ticket${staged.length === 1 ? '' : 's'} now on staging:`, ...lines, '', '_Opened from Howler Pulse._'].join('\n');
    try {
      const pr = await github.openReleasePr({ title: `Release: promote ${stagingBranch()} → ${prodBranch()}`, body });
      if (pr.nothingToPromote) return res.json({ nothingToPromote: true, staged: staged.length });
      logComment(t.id, { authorEmail: req.user.email, authorRole: 'admin', kind: 'system', body: `${pr.created ? 'Opened' : 'Using open'} release PR #${pr.number} to promote staging → production (${staged.length} ticket${staged.length === 1 ? '' : 's'}): ${pr.url}` });
      res.json({ releasePr: pr, staged: staged.length });
    } catch (e) {
      console.error('[tickets] promote failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Delete a ticket for good — its comments + attachment files too. (For clearing
  // test tickets / spam; the reporter's My-reports view drops it as well.)
  app.delete('/api/admin/tickets/:id', auth.requireAdmin, requireOn, (req, res) => {
    const t = getTicket(req.params.id);
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    for (const a of sql.prepare('SELECT id FROM ticket_attachments WHERE ticket_id=?').all(t.id)) {
      try { fs.unlinkSync(path.join(ATT_DIR, a.id)); } catch { /* file may already be gone */ }
    }
    sql.prepare('DELETE FROM ticket_attachments WHERE ticket_id=?').run(t.id);
    sql.prepare('DELETE FROM ticket_comments WHERE ticket_id=?').run(t.id);
    sql.prepare('DELETE FROM tickets WHERE id=?').run(t.id);
    res.json({ ok: true });
  });

  // Update a ticket: status / assignee / priority / type / urgency / edited AI ticket.
  // A status change is logged to the activity trail; moving to a terminal state can
  // notify the reporting client (results, closed loop).
  app.patch('/api/admin/tickets/:id', auth.requireAdmin, requireOn, (req, res) => {
    const t = getTicket(req.params.id);
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    const b = req.body || {};
    const sets = [], args = [];
    const set = (col, val) => { sets.push(`${col}=?`); args.push(val); };
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) return res.status(400).json({ error: 'Unknown status' });
      set('status', b.status);
      // Capture the admin's reason when declining (shown to the reporter).
      if (b.status === 'declined' && b.declineReason !== undefined) set('decline_reason', clamp(b.declineReason, 4000).trim());
    }
    if (b.type !== undefined && TYPES.includes(b.type)) set('type', b.type);
    if (b.urgency !== undefined && URGENCIES.includes(b.urgency)) set('urgency', b.urgency);
    if (b.assignee !== undefined) set('assignee', clamp(b.assignee, 200));
    if (b.priority !== undefined) set('priority', Number(b.priority) || 0);
    if (b.aiSummary !== undefined) set('ai_summary', String(b.aiSummary).slice(0, 20000));
    if (b.aiTitle !== undefined) set('ai_title', clamp(b.aiTitle, 200));
    if (b.shipNote !== undefined) set('ship_note', clamp(b.shipNote, 8000));
    if (b.testUrl !== undefined) set('test_url', clamp(b.testUrl, 1000).trim());
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    set('updated_at', now());
    sql.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id=?`).run(...args, t.id);
    if (b.status !== undefined && b.status !== t.status) {
      logComment(t.id, { authorEmail: req.user.email, authorRole: 'admin', kind: 'status', body: `${STATUS_LABELS[t.status] || t.status} → ${STATUS_LABELS[b.status] || b.status}` });
      notifyReporter(getTicket(t.id), t.status);
    }
    res.json({ ticket: ticketRow(getTicket(t.id)) });
  });

  // Add a comment: an internal dev note (default), or a PUBLIC reply the reporter
  // sees in their conversation and gets notified about (push + inbox mirror).
  app.post('/api/admin/tickets/:id/comments', auth.requireAdmin, requireOn, (req, res) => {
    const t = getTicket(req.params.id);
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    const body = clamp((req.body || {}).body, 8000).trim();
    if (!body) return res.status(400).json({ error: 'Empty note' });
    const visibility = (req.body || {}).visibility === 'public' ? 'public' : 'internal';
    logComment(t.id, { authorEmail: req.user.email, authorRole: 'admin', kind: 'comment', body, visibility });
    touch(t.id);
    if (visibility === 'public') notifyReporterComment(t, body);
    res.status(201).json({ comments: comments(t.id) });
  });

  // Reporter side of the conversation: reply on your own ticket (always public).
  // The assignee (if any) gets a push nudge; the board shows it in the trail.
  app.post('/api/my/tickets/:id/comments', auth.requireAuth, requireOn, (req, res) => {
    const t = getTicket(req.params.id);
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    if (t.reporter_id !== req.user.id) return res.status(403).json({ error: 'Not allowed' });
    const body = clamp((req.body || {}).body, 8000).trim();
    if (!body) return res.status(400).json({ error: 'Empty message' });
    logComment(t.id, { authorEmail: req.user.email, authorRole: 'reporter', kind: 'comment', body, visibility: 'public' });
    touch(t.id);
    const assignee = t.assignee ? db.getUserByEmail(t.assignee) : null;
    if (assignee) { try { push?.sendToUser?.(assignee.id, { title: `💬 Reporter replied on “${label(t)}”`, body: body.slice(0, 180), url: '/admin', tag: `ticket-${t.id}` }, 'messages'); } catch (e) { console.error('[tickets] assignee nudge failed:', e.message); } }
    res.status(201).json({ comments: comments(t.id, { publicOnly: true }) });
  });

  // Re-run the AI draft (e.g. after editing the raw body, or first-time if AI was
  // unconfigured when it was filed). Synchronous so the admin sees the result.
  app.post('/api/admin/tickets/:id/redraft', auth.requireAdmin, requireOn, async (req, res) => {
    const t = getTicket(req.params.id);
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    if (!insights.isConfigured(adminAnthropicKey ? adminAnthropicKey() : process.env.ANTHROPIC_API_KEY)) {
      return res.status(400).json({ error: 'Set an Anthropic API key in Admin → Integrations to draft tickets.' });
    }
    try {
      const { title, summary } = await draftTicket({ type: t.type, title: t.title, body: t.body, screen: t.screen, tile: t.tile_name });
      sql.prepare('UPDATE tickets SET ai_title=?, ai_summary=?, ai_status=?, updated_at=? WHERE id=?')
        .run(title, summary, 'ready', now(), t.id);
      res.json({ ticket: ticketRow(getTicket(t.id)) });
    } catch (e) {
      console.error('[tickets] redraft failed:', e.message);
      res.status(500).json({ error: 'Could not draft this ticket — please try again.' });
    }
  });

  // Tell the reporter their ticket moved. Fires on every meaningful status change
  // (not just shipped). Two channels: a web-push notification straight to the
  // reporting USER (works for any role — this is what reaches staff who reported a
  // bug, and drives the on-device banner), plus — for client reporters tied to an
  // entity — an in-app Pulse inbox thread via the OS spine (with email/push fanout).
  const label = (t) => t.ai_title || t.title || 'your report';
  function shipBody(t) {
    const overview = (t.ship_note || '').trim() || (t.ai_summary || '').trim() || `We've built the ${t.type} you reported.`;
    const parts = [`Good news — "${label(t)}" has shipped. Here's what we built:`, '', overview, ''];
    if (t.test_url) parts.push(`Try it: ${t.test_url}`, '');
    parts.push('Review it under Product → My reports and let us know — approve it, or send it back with what still needs fixing.');
    return parts.join('\n');
  }
  // Reporter-facing message per new status. Statuses not listed here don't notify
  // (e.g. approved/rejected are the reporter's OWN actions; inbox is the start).
  function reporterMessage(t) {
    switch (t.status) {
      case 'triaged': return { title: 'We’re reviewing your report', body: `Your ${t.type} “${label(t)}” has been logged and is being reviewed.` };
      case 'accepted': return { title: 'Your report was accepted ✅', body: `Good news — we’ve accepted your ${t.type} “${label(t)}” and it’s queued to build.` };
      case 'in_progress': return { title: 'We’ve started building 🔨', body: `Work has started on your ${t.type} “${label(t)}”.` };
      case 'staging': return { title: 'Ready to preview on staging 🧪', body: `Your ${t.type} “${label(t)}” is built and running on our staging environment for final checks before it goes live. We’ll let you know the moment it ships to production.` };
      case 'shipped': return { title: 'Shipped — please review 🎉', body: shipBody(t), priority: 'needs_reply' };
      case 'declined': return { title: 'Update on your report', body: `We won’t be taking your ${t.type} “${label(t)}” forward${t.decline_reason ? `: ${t.decline_reason}` : ' for now.'}` };
      default: return null;
    }
  }
  function notifyReporter(t, prevStatus) {
    if (!t || t.status === prevStatus) return;
    const msg = reporterMessage(t);
    if (!msg) return;
    // 1) Direct push to the reporting user — the universal channel (any role).
    try { push?.sendToUser?.(t.reporter_id, { title: msg.title, body: String(msg.body).slice(0, 180), url: '/product', tag: `ticket-${t.id}` }, 'messages'); } catch (e) { console.error('[tickets] push failed:', e.message); }
    // 2) Client reporters (tied to an entity) also get an in-app inbox thread.
    if (t.entity_id && os?.announce) {
      try {
        os.announce({ entityId: t.entity_id, title: msg.title, body: msg.body, priority: msg.priority || 'fyi', createdBy: 'Product', authorType: 'system', subjectType: 'ticket', subjectId: t.id });
      } catch (e) { console.error('[tickets] reporter notify failed:', e.message); }
    }
  }
  // A public admin reply → tell the reporter: push (any role), plus — for client
  // reporters — mirrored into the SAME inbox thread as their status updates. The
  // ticket's conversation (Product → My reports) is the canonical place to reply.
  function notifyReporterComment(t, body) {
    const title = `💬 New reply on “${label(t)}”`;
    try { push?.sendToUser?.(t.reporter_id, { title, body: String(body).slice(0, 180), url: '/product', tag: `ticket-${t.id}` }, 'messages'); } catch (e) { console.error('[tickets] push failed:', e.message); }
    if (t.entity_id && os?.announce) {
      try {
        os.announce({ entityId: t.entity_id, title, body: `${body}\n\nReply under Product → My reports.`, priority: 'normal', createdBy: 'Product', authorType: 'howler', subjectType: 'ticket', subjectId: t.id });
      } catch (e) { console.error('[tickets] reporter notify failed:', e.message); }
    }
  }

  // Notify the team (as a ticket comment) when the reporter approves or rejects a
  // shipped ticket, so the board reflects the outcome without a webhook.
  function notifyTeamOnVerdict(t) {
    const who = t.reporter_name || t.reporter_email || 'The reporter';
    if (t.client_verdict === 'approved') logComment(t.id, { authorEmail: t.reporter_email, authorRole: 'client', kind: 'status', body: `✅ ${who} approved the shipped work.` });
    else if (t.client_verdict === 'rejected') logComment(t.id, { authorEmail: t.reporter_email, authorRole: 'client', kind: 'status', body: `↩️ ${who} sent it back: ${t.client_verdict_note || '(no reason given)'}` });
  }

  // Client self-service: approve or reject the SHIPPED work. Only the reporter, only
  // while shipped. Approve → 'approved' (done). Reject → 'rejected' (dev reopens);
  // a reason is required so the team knows what to fix.
  app.post('/api/my/tickets/:id/verdict', auth.requireAuth, requireOn, (req, res) => {
    const t = getTicket(req.params.id);
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    if (t.reporter_id !== req.user.id) return res.status(403).json({ error: 'Not allowed' });
    if (t.status !== 'shipped') return res.status(400).json({ error: 'This report is not awaiting your review.' });
    const verdict = (req.body || {}).verdict;
    if (verdict !== 'approved' && verdict !== 'rejected') return res.status(400).json({ error: 'verdict must be approved or rejected' });
    const note = clamp((req.body || {}).note, 4000).trim();
    if (verdict === 'rejected' && !note) return res.status(400).json({ error: 'Please say what still needs fixing.' });
    sql.prepare('UPDATE tickets SET status=?, client_verdict=?, client_verdict_note=?, client_verdict_at=?, updated_at=? WHERE id=?')
      .run(verdict === 'approved' ? 'approved' : 'rejected', verdict, note, now(), now(), t.id);
    notifyTeamOnVerdict(getTicket(t.id));
    res.json({ ticket: myTicketRow(getTicket(t.id)) });
  });

  // ── GitHub webhook: PR events → auto-update the linked ticket ──────────────────
  // A merged PR auto-Ships its ticket (and notifies the reporter); an opened PR
  // links it + nudges the board forward. Verified by HMAC (github.verifyWebhook)
  // over the RAW body (index.js excludes this path from the global JSON parser).
  // PR → ticket link is by the issue number Pulse stored, found in the PR body
  // ("Fixes #N") or the branch name (claude/issue-N-…).
  const rawJson = express.raw({ type: '*/*', limit: '5mb' });
  function issueNumbersFromPr(pr) {
    const nums = new Set();
    for (const m of String(pr.body || '').matchAll(/#(\d+)/g)) nums.add(Number(m[1]));
    const bm = String(pr.head?.ref || '').match(/issue[-_/](\d+)/i);
    if (bm) nums.add(Number(bm[1]));
    return [...nums].filter(Boolean);
  }
  const ticketsForIssues = (nums) => nums.map((n) => sql.prepare('SELECT * FROM tickets WHERE github_issue_number=?').get(n)).filter(Boolean);
  function handlePullRequest(payload) {
    const pr = payload.pull_request;
    if (!pr) return;
    const action = payload.action;
    const base = String(pr.base?.ref || '');
    const head = String(pr.head?.ref || '');
    const prod = prodBranch(), staging = stagingBranch();

    // Release promotion: merging the staging branch into production ships everything
    // sitting on staging at once (a release train). The release PR carries no
    // per-ticket issue refs, so we flip by status, not by issue number.
    if (action === 'closed' && pr.merged && head === staging && staging !== prod && base === prod) {
      for (const t of sql.prepare("SELECT * FROM tickets WHERE status='staging'").all()) {
        const note = (t.ship_note || '').trim() || `Verified on staging, promoted to production via release PR #${pr.number}.`;
        sql.prepare('UPDATE tickets SET status=?, ship_note=?, updated_at=? WHERE id=?').run('shipped', note.slice(0, 8000), now(), t.id);
        logComment(t.id, { authorEmail: 'github', authorRole: 'system', kind: 'status', body: `Release PR #${pr.number} merged — promoted to production, shipped.` });
        notifyReporter(getTicket(t.id), t.status);
      }
      return;
    }

    for (const t of ticketsForIssues(issueNumbersFromPr(pr))) {
      if (String(t.github_pr_url || '') !== String(pr.html_url || '')) {
        sql.prepare('UPDATE tickets SET github_pr_number=?, github_pr_url=?, updated_at=? WHERE id=?').run(pr.number, pr.html_url, now(), t.id);
      }
      if (action === 'closed' && pr.merged) {
        if (t.status === 'shipped' || t.status === 'approved') continue; // already done
        // A PR into the staging branch lands the ticket "on staging" to verify; a PR
        // into production ships it. The PR's actual base branch is the source of truth.
        const toStaging = base === staging && staging !== prod;
        if (toStaging) {
          if (t.status === 'staging') continue; // already there
          sql.prepare('UPDATE tickets SET status=?, updated_at=? WHERE id=?').run('staging', now(), t.id);
          logComment(t.id, { authorEmail: 'github', authorRole: 'system', kind: 'status', body: `PR #${pr.number} merged into \`${base}\` — now on staging to verify.` });
          notifyReporter(getTicket(t.id), t.status);
        } else {
          const note = (t.ship_note || '').trim() || `Shipped via PR #${pr.number}: ${String(pr.title || '').trim()}`.slice(0, 8000);
          sql.prepare('UPDATE tickets SET status=?, ship_note=?, updated_at=? WHERE id=?').run('shipped', note, now(), t.id);
          logComment(t.id, { authorEmail: 'github', authorRole: 'system', kind: 'status', body: `PR #${pr.number} merged into \`${base}\` — auto-shipped.` });
          notifyReporter(getTicket(t.id), t.status);
        }
      } else if (action === 'closed' && !pr.merged) {
        logComment(t.id, { authorEmail: 'github', authorRole: 'system', kind: 'system', body: `PR #${pr.number} closed without merging.` });
      } else if (['opened', 'reopened', 'ready_for_review'].includes(action)) {
        logComment(t.id, { authorEmail: 'github', authorRole: 'system', kind: 'system', body: `PR #${pr.number} opened${base ? ` → \`${base}\`` : ''}: ${pr.html_url}` });
        if (['inbox', 'triaged', 'accepted'].includes(t.status)) {
          const prev = t.status;
          sql.prepare('UPDATE tickets SET status=?, updated_at=? WHERE id=?').run('in_progress', now(), t.id);
          notifyReporter(getTicket(t.id), prev);
        }
      }
    }
  }
  // NOT cookie-authed — GitHub signs each delivery; we verify the HMAC signature.
  app.post('/api/github/webhook', rawJson, (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!github?.verifyWebhook?.(raw, req.get('x-hub-signature-256'))) return res.status(401).json({ error: 'bad signature' });
    let payload; try { payload = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'bad json' }); }
    if (req.get('x-github-event') === 'pull_request') {
      try { handlePullRequest(payload); } catch (e) { console.error('[tickets] webhook error:', e.message); }
    }
    res.json({ ok: true });
  });

  console.log('[tickets] Product board mounted', enabled() ? '(enabled)' : '(disabled — set tickets_enabled=1)');
  return { draftInBackground, createTicket };
}

module.exports = { mount, TICKET_DRAFT_SYSTEM };
