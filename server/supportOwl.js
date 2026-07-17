// ─── Support Owl P0a — the knowledge spine (docs/specs/SUPPORT_OWL_SPEC.md) ─────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the `support_knowledge` table and all
// /api/admin/support-owl routes. Mounted from index.js with one line; remove that
// line + this file (+ drop the table) to uninstall.
//
// This is the FIRST slice of the Support Owl (the Owl's customer-care door): the
// two-tier knowledge base the future agent grounds on. The PLATFORM tier
// (entity_id = '') mirrors Howler's help docs from HelpDocs (helpdocs.io) via its
// read API — synced, never retyped — plus manual platform entries. The CLIENT
// tier stays in fan_knowledge for now (spec §2: no forced migration). No AI runs
// here yet: the sync is a verbatim mirror (HTML stripped), so there are no
// prompts to register and no per-call cost. Later phases (triage, drafts, the
// widget's support mode) consume searchKnowledge() below.
//
// Secrets: the HelpDocs key rides db settings (name matches secretbox's
// api_key heuristic → sealed at rest) and is reported write-only (set + mask).
// Kill switch: setting `support_owl_enabled` gates the sync + future consumer
// surfaces; the admin curation routes stay reachable (same shape as helpBot).

const crypto = require('crypto');
const { HttpError, asyncHandler } = require('./http');
const { safeGetText } = require('./safeFetch');

const HELPDOCS_API = 'https://api.helpdocs.io/v1/article';
const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;   // tick cadence
const SYNC_STALE_MS = 20 * 60 * 60 * 1000;  // re-sync when older than this (~nightly)

// HelpDocs fields can be plain strings or {lang: value} translation maps —
// take English (or the first translation) either way.
function langText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return String(v.en ?? Object.values(v)[0] ?? '');
  return String(v);
}

// Same de-tagging the Fan Owl's website reader uses: articles arrive as HTML,
// the knowledge base stores searchable plain text.
function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

// HelpDocs payload → clean rows. Defensive about field names/shapes (the API
// nests translations; ids appear as article_id or id) and PUBLISHED-only —
// a draft help doc must never ground a customer-facing answer.
function transformArticles(payload) {
  const list = Array.isArray(payload?.articles) ? payload.articles : [];
  const out = [];
  for (const a of list) {
    const status = String(a?.status || 'published').toLowerCase();
    if (status && status !== 'published') continue;
    const extId = String(a?.article_id || a?.id || '').trim();
    const title = langText(a?.title).trim().slice(0, 300);
    const body = stripHtml(langText(a?.body)).slice(0, 20000);
    if (!extId || !title || !body) continue;
    out.push({
      extId,
      title,
      body,
      category: String(a?.category_id || '').slice(0, 80),
      url: String(a?.url || '').slice(0, 600),
    });
  }
  return out;
}

// Upsert the synced mirror: add new, update changed, remove helpdocs rows whose
// article disappeared (unpublished/deleted upstream). Manual rows are untouched.
function applySync(sql, rows, at) {
  const existing = new Map(
    sql.prepare("SELECT id, ext_id, title, body, category, url FROM support_knowledge WHERE source = 'helpdocs'")
      .all().map((r) => [r.ext_id, r]),
  );
  let added = 0; let updated = 0;
  const upd = sql.prepare('UPDATE support_knowledge SET title=?, body=?, category=?, url=?, synced_at=?, updated_at=? WHERE id=?');
  const ins = sql.prepare(`INSERT INTO support_knowledge (id, entity_id, kind, title, body, category, source, ext_id, url, synced_at, updated_at)
    VALUES (?, '', 'article', ?, ?, ?, 'helpdocs', ?, ?, ?, ?)`);
  const seen = new Set();
  const tx = sql.transaction(() => {
    for (const r of rows) {
      seen.add(r.extId);
      const have = existing.get(r.extId);
      if (have) {
        if (have.title !== r.title || have.body !== r.body || have.category !== r.category || have.url !== r.url) {
          upd.run(r.title, r.body, r.category, r.url, at, at, have.id); updated += 1;
        } else {
          sql.prepare('UPDATE support_knowledge SET synced_at=? WHERE id=?').run(at, have.id);
        }
      } else { ins.run(crypto.randomUUID(), r.title, r.body, r.category, r.extId, r.url, at, at); added += 1; }
    }
    for (const [extId, r] of existing) if (!seen.has(extId)) sql.prepare('DELETE FROM support_knowledge WHERE id=?').run(r.id);
  });
  tx();
  const removed = [...existing.keys()].filter((k) => !seen.has(k)).length;
  return { added, updated, removed, total: rows.length };
}

// Two-tier retrieval (spec §2): platform tier ('') + the entity's own rows,
// keyword-scored (title > body), CLIENT TIER WINS — an entity row outranks a
// platform row on equal relevance, and results carry their tier so the agent
// can phrase "Howler's policy" vs "the organisers' policy". Exported for the
// later phases (triage, drafts, the widget's support mode).
function searchKnowledge(sql, entityId, query, limit = 6) {
  const words = [...new Set(String(query || '').toLowerCase().match(/[a-z0-9]+/g) || [])].filter((w) => w.length > 2);
  if (!words.length) return [];
  const rows = sql.prepare("SELECT * FROM support_knowledge WHERE entity_id IN ('', ?)").all(String(entityId || ''));
  return rows.map((k) => {
    const title = String(k.title).toLowerCase(); const body = String(k.body).toLowerCase();
    let score = 0;
    for (const w of words) { if (title.includes(w)) score += 3; if (body.includes(w)) score += 1; }
    if (score && k.entity_id) score += 2; // the client's own entry beats the generic one
    return { k, score };
  }).filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ k }) => ({ id: k.id, tier: k.entity_id ? 'client' : 'platform', kind: k.kind, title: k.title, body: k.body, url: k.url, source: k.source }));
}

const KINDS = new Set(['faq', 'policy', 'info', 'article']);

function mount(app, { db, auth, rateLimit }) {
  const sql = db.db;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS support_knowledge (
      id         TEXT PRIMARY KEY,
      entity_id  TEXT NOT NULL DEFAULT '',        -- '' = the platform (Howler) tier
      kind       TEXT NOT NULL DEFAULT 'article', -- faq | policy | info | article
      title      TEXT NOT NULL DEFAULT '',
      body       TEXT NOT NULL DEFAULT '',
      category   TEXT NOT NULL DEFAULT '',
      source     TEXT NOT NULL DEFAULT 'manual',  -- manual | helpdocs
      ext_id     TEXT NOT NULL DEFAULT '',        -- HelpDocs article id (synced rows)
      url        TEXT NOT NULL DEFAULT '',
      position   INTEGER NOT NULL DEFAULT 0,
      synced_at  TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_support_knowledge_entity ON support_knowledge(entity_id, kind);
  `);
  const now = () => new Date().toISOString();

  const enabled = () => db.getSetting('support_owl_enabled', '1') !== '0';
  const apiKey = () => String(db.getSetting('support_helpdocs_api_key', '') || '').trim();
  const lastSync = () => { try { return JSON.parse(db.getSetting('support_helpdocs_last_sync', '') || 'null'); } catch { return null; } };

  async function runSync(fetchText = safeGetText) {
    const key = apiKey();
    if (!key) throw new HttpError(400, 'Add the HelpDocs API key first (a read-only key from HelpDocs → Settings → API).');
    let summary;
    try {
      const raw = await fetchText(`${HELPDOCS_API}?key=${encodeURIComponent(key)}&include_body=true`, { timeoutMs: 30000, maxBytes: 20 * 1024 * 1024 });
      const rows = transformArticles(JSON.parse(raw));
      if (!rows.length) throw new Error('HelpDocs returned no published articles — check the key and that articles are published.');
      summary = { at: now(), ok: true, ...applySync(sql, rows, now()) };
    } catch (e) {
      db.setSetting('support_helpdocs_last_sync', JSON.stringify({ at: now(), ok: false, error: String(e.message).slice(0, 300) }));
      throw e instanceof HttpError ? e : new HttpError(502, `HelpDocs sync failed: ${String(e.message).slice(0, 200)}`);
    }
    db.setSetting('support_helpdocs_last_sync', JSON.stringify(summary));
    return summary;
  }

  const rowView = (r) => ({ id: r.id, entityId: r.entity_id, kind: r.kind, title: r.title, body: r.body, category: r.category, source: r.source, url: r.url, syncedAt: r.synced_at, updatedAt: r.updated_at });
  const overview = () => {
    const key = apiKey();
    return {
      enabled: enabled(),
      helpdocs: { keySet: !!key, keyMask: key ? `…${key.slice(-4)}` : '', lastSync: lastSync() },
      knowledge: sql.prepare("SELECT * FROM support_knowledge WHERE entity_id = '' ORDER BY source, category, title").all().map(rowView),
    };
  };

  // ── Admin surface (platform tier only in P0a; client tier stays in fan_knowledge) ──
  app.get('/api/admin/support-owl', auth.requireAdmin, (_req, res) => res.json(overview()));

  app.put('/api/admin/support-owl/settings', auth.requireAdmin, (req, res) => {
    const b = req.body || {};
    if (b.enabled !== undefined) db.setSetting('support_owl_enabled', b.enabled ? '1' : '0');
    // Write-only: an empty/omitted key never clears a stored one by accident.
    if (typeof b.helpdocsApiKey === 'string' && b.helpdocsApiKey.trim()) db.setSetting('support_helpdocs_api_key', b.helpdocsApiKey.trim());
    if (b.clearHelpdocsApiKey === true) db.setSetting('support_helpdocs_api_key', '');
    res.json(overview());
  });

  app.post('/api/admin/support-owl/sync',
    auth.requireAdmin,
    rateLimit({ windowMs: 5 * 60_000, max: 4, by: 'user', scope: 'support-sync', message: 'Give the sync a few minutes between runs.' }),
    asyncHandler(async (_req, res) => res.json({ ...(await runSync()), knowledge: overview().knowledge })));

  app.post('/api/admin/support-owl/knowledge', auth.requireAdmin, (req, res) => {
    const b = req.body || {};
    if (!String(b.title || '').trim() || !String(b.body || '').trim()) throw new HttpError(400, 'A title and body are required.');
    const id = crypto.randomUUID();
    sql.prepare(`INSERT INTO support_knowledge (id, entity_id, kind, title, body, category, source, updated_at)
      VALUES (?, '', ?, ?, ?, ?, 'manual', ?)`)
      .run(id, KINDS.has(b.kind) ? b.kind : 'faq', String(b.title).trim().slice(0, 300), String(b.body).trim().slice(0, 20000), String(b.category || '').slice(0, 80), now());
    res.status(201).json(rowView(sql.prepare('SELECT * FROM support_knowledge WHERE id=?').get(id)));
  });

  app.put('/api/admin/support-owl/knowledge/:id', auth.requireAdmin, (req, res) => {
    const row = sql.prepare('SELECT * FROM support_knowledge WHERE id=?').get(req.params.id);
    if (!row) throw new HttpError(404, 'Entry not found.');
    if (row.source === 'helpdocs') throw new HttpError(400, 'This entry is synced from HelpDocs — edit it there and re-sync.');
    const b = req.body || {};
    sql.prepare('UPDATE support_knowledge SET kind=?, title=?, body=?, category=?, updated_at=? WHERE id=?')
      .run(KINDS.has(b.kind) ? b.kind : row.kind, String(b.title ?? row.title).trim().slice(0, 300), String(b.body ?? row.body).trim().slice(0, 20000), String(b.category ?? row.category).slice(0, 80), now(), row.id);
    res.json(rowView(sql.prepare('SELECT * FROM support_knowledge WHERE id=?').get(row.id)));
  });

  app.delete('/api/admin/support-owl/knowledge/:id', auth.requireAdmin, (req, res) => {
    const row = sql.prepare('SELECT * FROM support_knowledge WHERE id=?').get(req.params.id);
    if (!row) throw new HttpError(404, 'Entry not found.');
    if (row.source === 'helpdocs') throw new HttpError(400, 'This entry is synced from HelpDocs — unpublish it there and re-sync.');
    sql.prepare('DELETE FROM support_knowledge WHERE id=?').run(row.id);
    res.status(204).end();
  });

  // Retrieval preview: what the future agent would ground on for this question
  // (optionally as a specific client, to see the tier override in action).
  app.get('/api/admin/support-owl/search', auth.requireAdmin, (req, res) => {
    res.json({ results: searchKnowledge(sql, String(req.query.entityId || ''), String(req.query.q || ''), 8) });
  });

  // Nightly-ish refresh: quiet no-op unless enabled + key set + the last sync has
  // gone stale. Failures are recorded on last_sync (surfaced in the admin view).
  const due = () => {
    if (!enabled() || !apiKey()) return false;
    const at = Date.parse(lastSync()?.at || 0) || 0;
    return Date.now() - at > SYNC_STALE_MS;
  };
  const timer = setInterval(() => { if (due()) runSync().catch(() => { /* recorded on last_sync */ }); }, SYNC_EVERY_MS);
  timer.unref?.();

  console.log('[supportOwl] knowledge spine mounted (P0a)');
  return { runSync, searchKnowledge: (entityId, q, limit) => searchKnowledge(sql, entityId, q, limit) };
}

module.exports = { mount, stripHtml, transformArticles, applySync, searchKnowledge, langText };
