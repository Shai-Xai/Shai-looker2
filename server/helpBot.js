// ─── Product help: what the Owl knows about Pulse ITSELF ───────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the `help_articles` table and both
// surfaces of the dual-surface rule:
//   • client self-service — the Owl chat: createOwlTool() below builds the
//     `productHelp` tool, registered in the shared Owl registry
//     (server/owlTools.js), so BOTH Owl doors (web chat + WhatsApp) answer
//     how-to / what's-new questions. ONE Owl — no separate help bot.
//   • admin curation      — /api/admin/help/* (curate + PUBLISH the knowledge,
//     kill switch `help_enabled`). Lives under Admin → Product → Help knowledge.
// Mounted from index.js with injected deps; remove that line + this file (+ the
// seed) to uninstall.
//
// It grounds answers about PULSE ITSELF — how to do things, what's new, what a
// user can/can't do — NOT the client's ticketing data (the Owl's other tools).
// UNRELEASED WORK CAN NEVER SURFACE: retrieval reads PUBLISHED articles and
// PUBLISHED release notes only — an admin publishing is the gate — and the
// grounding brief forbids stating product facts from anywhere else.
//
// Prompt registered for the AI audit via insights.promptRegistry() (it lazy-
// requires HELP_SYSTEM from here, so no load cycle).

const crypto = require('crypto');
const owlCatalogue = require('./owlCatalogue');
const roles = require('./roles');

// The grounding brief the productHelp tool hands the Owl WITH its result — the
// rules for answering product questions. Grounded, role/tenant aware, declines.
const HELP_SYSTEM = `PRODUCT-HELP GROUNDING — how to use this result. The user asked about Pulse ITSELF (the product), not their event data. Answer ONLY from the "articles" and "whatsNew" entries in this result: they are the curated, PUBLISHED knowledge and the single source of truth about the product. NEVER invent or assume features, screens, steps or settings — if these entries don't cover the question, say plainly that you don't have it in your help notes yet, offer the closest thing you DO know, and point the user to their Howler contact or the in-app "Report an issue" button. Do not guess. Respect the user context in this result: don't walk the user through something their role can't do (say who can instead), and don't pitch features listed under featuresMissing — at most, if directly asked, note the feature exists but isn't enabled for their account. When an entry carries a "screen" path, tell the user where to go in plain words (e.g. "open Engage → Campaigns") and be concrete about the steps. For what's-new questions use only the dated "whatsNew" entries — cite each item's date and never fabricate a change or a date. Keep it concise, warm and mobile-friendly: lead with the direct answer, then the steps.`;

// ── Retrieval ──────────────────────────────────────────────────────────────────
const STOP = new Set(['the', 'and', 'for', 'you', 'your', 'how', 'what', 'can', 'does', 'with', 'from', 'this', 'that', 'are', 'set', 'get', 'use', 'about', 'where', 'when', 'why', 'who', 'have', 'has', 'not', 'pulse']);
function terms(q) {
  return [...new Set(String(q || '').toLowerCase().match(/[a-z0-9]+/g) || [])].filter((t) => t.length >= 3 && !STOP.has(t));
}

// The feature tags a tenant HAS. An article tagged with a feature it lacks is
// dropped from retrieval (so cashless help never surfaces for a non-cashless
// event). Base features ship for everyone; OPTIONAL features are added only on
// POSITIVE evidence (default absent) so we never pitch something the account
// doesn't have. Cashless = a cashless data explore is registered AND enabled for
// this client (that's how cashless data is wired into Pulse).
const BASE_FEATURES = ['dashboards', 'insights', 'inbox', 'digests', 'campaigns', 'goals', 'alerts', 'settlements', 'documents', 'settings'];
const ALL_FEATURES = new Set([...BASE_FEATURES, 'cashless']);
function tenantFeatures(db, entityId) {
  const f = new Set(BASE_FEATURES);
  try {
    for (const ex of owlCatalogue.explores(db) || []) {
      const label = `${ex.label || ''} ${ex.view || ''}`.toLowerCase();
      if (/cashless/.test(label) && owlCatalogue.exploreEnabledFor(db, `${ex.model}::${ex.view}`, entityId)) { f.add('cashless'); break; }
    }
  } catch { /* no catalogue → optional features stay absent */ }
  return f;
}

// Score published articles against the query + role, dropping any that need a
// feature the tenant doesn't have. Returns the top `limit`, best first.
function retrieve(rows, { query, roleKey, features, limit = 6 }) {
  const qs = terms(query);
  const scored = [];
  for (const a of rows) {
    if (!a.published) continue;
    const need = (a.features || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (need.length && !need.some((n) => features.has(n))) continue; // requires a feature this tenant lacks
    const title = String(a.title || '').toLowerCase();
    const tags = String(a.tags || '').toLowerCase();
    const body = String(a.body || '').toLowerCase();
    let score = 0;
    for (const t of qs) {
      if (title.includes(t)) score += 4;
      if (tags.includes(t)) score += 3;
      if (body.includes(t)) score += 1;
    }
    const art = a.roles ? a.roles.split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (roleKey && art.includes(roleKey)) score += 2; // role-relevant boost
    if (tags.includes('overview') || tags.includes('getting-started')) score += 0.5; // gentle fallback anchor
    scored.push({ a, score });
  }
  scored.sort((x, y) => y.score - x.score);
  // Keep matches; if nothing matched at all, fall back to the overview/getting-started
  // anchors so the Owl can still orient a lost user rather than answer blind.
  let picked = scored.filter((s) => s.score > 0).slice(0, limit);
  if (!picked.length) picked = scored.filter((s) => /overview|getting-started/.test((s.a.tags || '').toLowerCase())).slice(0, limit);
  return picked.map((s) => s.a);
}

const rowToArticle = (r) => r && ({ id: r.id, slug: r.slug, title: r.title, body: r.body, tags: r.tags, roles: r.roles, features: r.features, deepLink: r.deep_link, published: !!r.published, source: r.source, createdAt: r.created_at, updatedAt: r.updated_at });

// ── The Owl's productHelp tool ─────────────────────────────────────────────────
// Built here (the knowledge lives here) and registered in the shared registry
// (server/owlTools.js → productHelp), so the web chat, the WhatsApp door and the
// "/" palette all pick it up with no extra wiring. Statements are prepared
// lazily on first run: the registry can be built before mount() creates the table.
function createOwlTool({ db, auth }) {
  let stmt = null;
  const allArticles = () => {
    if (!stmt) stmt = db.db.prepare('SELECT * FROM help_articles');
    return stmt.all().map(rowToArticle);
  };
  const schema = {
    name: 'productHelp',
    description: "Look up how Pulse ITSELF works: how-to steps, where a screen or setting lives, what the user can do with their access, and what's new / recently released. Use it for ANY question about the product or its features (NOT the client's ticketing data). Returns curated help articles + published release notes tailored to this user — answer ONLY from them, following the grounding instructions in the result.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: `What the user wants to know, e.g. "set up an abandoned cart campaign" or "what's new in Pulse"` },
      },
      required: ['query'],
    },
  };
  async function run(input, ctx = {}) {
    if (db.getSetting('help_enabled', '1') === '0') return { ok: false, reason: 'disabled', message: 'Product help is switched off right now — tell the user you can\'t look that up at the moment and to contact Howler.' };
    const user = ctx.user || {};
    const entityId = ctx.entityId || '';
    const isAdmin = user.role === 'admin';
    const roleKey = isAdmin ? 'admin' : ((entityId && auth.roleForEntity && auth.roleForEntity(user, entityId)) || '');
    const roleDef = roleKey && roleKey !== 'admin' ? roles.getRole(roleKey) : null;
    const roleLabel = isAdmin ? 'Howler staff (admin — full access)' : (roleDef ? `${roleDef.label} — ${roleDef.description}` : 'a Pulse user');
    const features = tenantFeatures(db, entityId);
    const articles = retrieve(allArticles(), { query: String(input.query || ''), roleKey, features, limit: 6 });
    // The "what's new" corpus: PUBLISHED release notes only — drafts are invisible.
    let releases = [];
    try { releases = db.listReleaseNotes().filter((n) => n.published).slice(0, 8); } catch { releases = []; }
    const ent = entityId ? db.getEntity(entityId) : null;
    const su = ctx.suiteId ? db.getSuite(ctx.suiteId) : null;
    return {
      ok: true,
      instructions: HELP_SYSTEM,
      userContext: {
        role: roleLabel,
        ...(ent ? { client: ent.name } : {}),
        ...(su ? { event: su.name } : {}),
        featuresMissing: [...ALL_FEATURES].filter((f) => !features.has(f)),
      },
      articles: articles.map((a) => ({ title: a.title, body: a.body, ...(a.deepLink ? { screen: a.deepLink } : {}) })),
      whatsNew: releases.map((n) => ({ date: n.date, title: n.title || '(update)', summary: String(n.body || '').slice(0, 400), ...(n.howTo ? { howTo: String(n.howTo).slice(0, 200) } : {}), ...(n.deepLink ? { screen: n.deepLink } : {}) })),
      ...(articles.length ? {} : { note: 'No closely matching help articles were found — if you can\'t answer confidently from what IS here, say you don\'t have it in your help notes and point them to their Howler contact.' }),
    };
  }
  return { schema, run, menu: { cmd: 'help', label: 'Pulse help', icon: '💬', example: "What's new — or how do I set something up?" } };
}

function mountHelpBot(app, { db, auth }) {
  const sql = db.db;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS help_articles (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '',
      roles TEXT NOT NULL DEFAULT '',
      features TEXT NOT NULL DEFAULT '',
      deep_link TEXT NOT NULL DEFAULT '',
      published INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const now = () => new Date().toISOString();
  const listStmt = sql.prepare('SELECT * FROM help_articles ORDER BY title COLLATE NOCASE ASC');
  const getStmt = sql.prepare('SELECT * FROM help_articles WHERE id=?');
  const listArticles = () => listStmt.all().map(rowToArticle);
  const getArticle = (id) => rowToArticle(getStmt.get(id));

  // Expose upsert/list so the seed module (server/helpBotSeed.js) can plant the
  // starter corpus once, without duplicating the SQL.
  function upsertArticle(a = {}) {
    const id = a.id || crypto.randomUUID();
    const ts = now();
    const cur = getStmt.get(id);
    if (cur) {
      sql.prepare('UPDATE help_articles SET slug=?, title=?, body=?, tags=?, roles=?, features=?, deep_link=?, published=?, updated_at=? WHERE id=?')
        .run(a.slug ?? cur.slug, a.title ?? cur.title, a.body ?? cur.body, a.tags ?? cur.tags, a.roles ?? cur.roles, a.features ?? cur.features, a.deepLink ?? cur.deep_link, (a.published === undefined ? cur.published : (a.published ? 1 : 0)), ts, id);
    } else {
      sql.prepare('INSERT INTO help_articles (id,slug,title,body,tags,roles,features,deep_link,published,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, a.slug || '', a.title || '', a.body || '', a.tags || '', a.roles || '', a.features || '', a.deepLink || '', (a.published === false ? 0 : 1), (a.source === 'seed' ? 'seed' : 'manual'), ts, ts);
    }
    return getArticle(id);
  }

  // ── Admin curation surface (publish = the release gate for product help) ─────
  app.get('/api/admin/help/articles', auth.requireAdmin, (_req, res) => res.json(listArticles()));
  app.post('/api/admin/help/articles', auth.requireAdmin, (req, res) => res.status(201).json(upsertArticle({ ...(req.body || {}), id: undefined, source: 'manual' })));
  app.put('/api/admin/help/articles/:id', auth.requireAdmin, (req, res) => {
    if (!getArticle(req.params.id)) return res.status(404).json({ error: 'Help article not found' });
    res.json(upsertArticle({ ...(req.body || {}), id: req.params.id }));
  });
  app.delete('/api/admin/help/articles/:id', auth.requireAdmin, (req, res) => { sql.prepare('DELETE FROM help_articles WHERE id=?').run(req.params.id); res.status(204).end(); });
  app.get('/api/admin/help/settings', auth.requireAdmin, (_req, res) => res.json({ enabled: db.getSetting('help_enabled', '1') !== '0' }));
  app.put('/api/admin/help/settings', auth.requireAdmin, (req, res) => {
    const b = req.body || {};
    if (b.enabled !== undefined) db.setSetting('help_enabled', b.enabled ? '1' : '0');
    res.json({ enabled: db.getSetting('help_enabled', '1') !== '0' });
  });

  // Handed back so the seed can plant the starter corpus + tests can drive it.
  return { listArticles, upsertArticle, retrieve: (opts) => retrieve(listArticles(), opts), tenantFeatures: (eid) => tenantFeatures(db, eid) };
}

module.exports = { mount: mountHelpBot, createOwlTool, HELP_SYSTEM, retrieve, tenantFeatures, terms };
