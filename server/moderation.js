// ─── Social moderation: banned lists, rule engine, review queue ──────────────
// SELF-CONTAINED, DISPOSABLE MODULE — phase 1 of the AI social moderation scope
// (wire contract: docs/specs/MODERATION_CONTRACT.md · plan:
// docs/specs/MODERATION_P1_PLAN.md). Owns the `moderation_rules` +
// `moderation_items` tables and the dashboard routes; server/social.js and
// server/chat.js call the exported screen/record helpers on their app-facing
// write paths (the ONLY paths fan content enters — see contract §2) and own the
// `moderation_status` columns on their content tables.
//
// Pipeline (phase 1, all synchronous + in-process): normalize → exact match
// (→ BLOCK, 422) → fuzzy match (→ HOLD, 202, author-only until reviewed). AI
// classification and image pHash are phase 2. Rules resolve platform ∪ owning
// client (a client adds to, never subtracts from, the platform list) and are
// cached in-process (~30 s TTL) so the sync path stays sub-10 ms.
//
// Blocked responses NEVER echo which entry matched (don't teach evasion) —
// match evidence lives only in moderation_items for the moderator surfaces.
// If this module isn't mounted, every screen call passes and every record call
// no-ops — removing it simply un-moderates the social surface (fail-open).
//
// Roles: client console = `moderation.manage` permission (roles.js) at
// /api/my/moderation (flag-gated: community.moderation). Platform lists +
// queue = Howler admins read; WRITES need the `platform_moderator` tag
// (roles.js, SUPER_ADMIN pattern). TO REMOVE: delete this file + mount line +
// the screen/record calls in social.js/chat.js + the flag/gate/permission rows;
// drop moderation_* tables (moderation_status columns are harmless leftovers).

const crypto = require('crypto');
const { HttpError, asyncHandler } = require('./http');
const roles = require('./roles');

const RULE_KINDS = ['word', 'phrase', 'emoji']; // 'image' is phase 2
const ACTIONS = ['', 'block', 'hold']; // '' = default (block on exact, hold on fuzzy)
const MAX_VALUE = 120;
const SNAPSHOT_DAYS_DEFAULT = 90; // retention before snapshots are redacted

// ── normalizer (pure — exported for tests) ──────────────────────────────────
// Defeats trivial evasion before any matching: case/width folding, zero-width
// strip, diacritic fold, leetspeak, repeated-char collapse. Emoji are handled
// separately (foldEmoji) so a text ban never mangles emoji sequences.
const LEET = { '@': 'a', '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', $: 's', '!': 'i' };
function normalizeText(input) {
  let s = String(input || '').normalize('NFKC').toLowerCase();
  s = s.replace(/[\u200B-\u200F\u2060\uFEFF\u00AD]/g, ''); // zero-width chars + soft hyphen
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); // diacritics: fúck → fuck
  s = s.replace(/[@013457!$]/g, (c) => LEET[c] || c); // f@ck / sh1t → fack / shit… then matched
  s = s.replace(/([a-z])\1{2,}/g, '$1'); // fuuuck → fuck (runs of 3+; 'class' keeps its ss)
  return s;
}
// Word tokens of the normalized text (letters/digits runs — emoji drop out here).
const tokensOf = (s) => (s.match(/[a-z0-9]+/g) || []);
// Spaced-out variants: runs of single-char tokens joined ("f u c k" → "fuck").
// Only single-char runs join, so normal words never merge into false hits.
function joinedSingles(s) {
  const out = [];
  let run = [];
  for (const t of tokensOf(s)) {
    if (t.length === 1) { run.push(t); continue; }
    if (run.length > 1) out.push(run.join(''));
    run = [];
  }
  if (run.length > 1) out.push(run.join(''));
  return out;
}
// Emoji folding: strip skin tones + variation selectors so a banned base emoji
// matches all its tone/ZWJ variants (🖕🏽 → 🖕). Sequence order is preserved.
// (Variation selectors stripped via alternation, not a character class —
// no-misleading-character-class rejects combining chars inside classes.)
const foldEmoji = (s) => String(s || '').normalize('NFKC').replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '').replace(/\uFE0E|\uFE0F/g, '');

function levenshtein(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1; // early out — row can't recover
    prev = cur;
  }
  return prev[b.length];
}
// Length-scaled fuzzy budget (contract §3): short entries tolerate 1 edit,
// longer ones 2. Entries under 4 chars get no fuzzy pass at all (too noisy).
const editBudget = (len) => (len < 4 ? 0 : len <= 6 ? 1 : 2);

// Match one text rule against pre-computed text forms. Exact hits are
// word/phrase-boundary aware (the Scunthorpe rule: 'class' must not trip on
// 'ass'); fuzzy adds edit distance, spaced-out joins, and (entries ≥5 chars)
// embedded-substring hits inside longer tokens.
function matchTextRule(rule, forms) {
  const v = rule.value_normalized;
  if (!v) return null;
  if (rule.kind === 'emoji') return forms.emoji.includes(foldEmoji(v)) ? 'exact' : null;
  const words = v.split(' ');
  if (words.length > 1) { // phrase: normalized token-sequence containment
    const seq = words.join(' ');
    return ` ${forms.tokens.join(' ')} `.includes(` ${seq} `) ? 'exact' : null;
  }
  if (forms.tokenSet.has(v)) return 'exact';
  if (forms.singles.includes(v)) return 'fuzzy'; // f u c k
  const max = editBudget(v.length);
  for (const t of forms.tokens) {
    if (v.length >= 5 && t.length > v.length && t.includes(v)) return 'fuzzy'; // embedded
    if (max && Math.abs(t.length - v.length) <= max && levenshtein(t, v, max) <= max) return 'fuzzy';
  }
  return null;
}

// ── module state (set at mount; helpers no-op/pass before then) ─────────────
let S = null; // { sql, db, now, uuid }
let cache = new Map(); // entityId ('' = platform-only) → { at, rules }
const CACHE_TTL = 30_000;
const bustCache = () => { cache = new Map(); };

function rulesFor(entityId) {
  const key = String(entityId || '');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.rules;
  const rules = S.sql.prepare(
    "SELECT * FROM moderation_rules WHERE active=1 AND (scope='platform' OR entity_id=?)").all(key);
  cache.set(key, { at: Date.now(), rules });
  return rules;
}

// ── the screen API (used by social.js / chat.js on every fan write) ─────────
// → { outcome: 'pass'|'hold'|'block', reason, matches: [{id, kind, how}] }
function screenText(entityId, text) {
  if (!S || !String(text || '').trim()) return { outcome: 'pass', matches: [] };
  const norm = normalizeText(text);
  const tokens = tokensOf(norm);
  // Emoji are matched on the RAW input (folded) — normalizeText strips ZWJ
  // (it sits in the zero-width range), which would desync composed sequences.
  const forms = { tokens, tokenSet: new Set(tokens), singles: joinedSingles(norm), emoji: foldEmoji(text) };
  const matches = [];
  let outcome = 'pass';
  let reason = '';
  for (const r of rulesFor(entityId)) {
    const how = matchTextRule(r, forms);
    if (!how) continue;
    const action = r.match_action || (how === 'exact' ? 'block' : 'hold');
    matches.push({ id: r.id, kind: r.kind, how, action });
    if (action === 'block') { outcome = 'block'; reason = r.kind === 'emoji' ? 'banned_emoji' : 'banned_term'; }
    else if (outcome !== 'block') { outcome = 'hold'; reason = 'similar_match'; }
  }
  return { outcome, reason, matches };
}
// Reactions have no reviewable hold state (contract §6) — ANY emoji-rule match
// blocks, regardless of the entry's action override. Exact folded match only.
function screenEmoji(entityId, emoji) {
  if (!S || !emoji) return { outcome: 'pass', matches: [] };
  const folded = foldEmoji(emoji);
  const matches = rulesFor(entityId)
    .filter((r) => r.kind === 'emoji' && foldEmoji(r.value_normalized) && folded.includes(foldEmoji(r.value_normalized)))
    .map((r) => ({ id: r.id, kind: r.kind, how: 'exact', action: 'block' }));
  return { outcome: matches.length ? 'block' : 'pass', reason: 'banned_emoji', matches };
}

// ── queue + audit writers ───────────────────────────────────────────────────
function insertItem({ contentType, contentId = '', snapshot, authorUserId = '', communityId = '', channelId = '', entityId, trigger, evidence, status }) {
  if (!S) return null;
  const id = `mod_${S.uuid().slice(0, 12)}`;
  S.sql.prepare(`INSERT INTO moderation_items (id, content_type, content_id, snapshot, author_user_id, community_id, channel_id, entity_id, trigger, evidence, status, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, contentType, String(contentId), JSON.stringify(snapshot || {}), String(authorUserId), String(communityId), String(channelId), String(entityId || ''), trigger, JSON.stringify(evidence || {}), status, S.now());
  return id;
}
// Fuzzy hit → content persisted as held + a pending review item.
const recordHold = (info) => insertItem({ ...info, trigger: 'similar_rule', status: 'pending' });
// Exact hit → nothing persisted in content tables; audit-only item.
const recordBlockedAttempt = (info) => insertItem({ ...info, contentId: '', trigger: 'exact_rule', status: 'auto_blocked' });
// User report → pending item, content STAYS VISIBLE until declined.
// Idempotent per (content, reporter): a duplicate report is a silent no-op.
function recordReport({ contentType, contentId, reporterId, reason = '', ...info }) {
  if (!S) return null;
  const dup = S.sql.prepare(
    "SELECT 1 FROM moderation_items WHERE content_type=? AND content_id=? AND trigger='user_report' AND status='pending' AND evidence LIKE ? LIMIT 1")
    .get(contentType, String(contentId), `%"reporterId":"${String(reporterId)}"%`);
  if (dup) return null;
  return insertItem({
    ...info, contentType, contentId, trigger: 'user_report', status: 'pending',
    evidence: { reporterId: String(reporterId), reportReason: String(reason || '').slice(0, 200) },
  });
}

// The 422/202 wire shapes (contract §4) — sent directly, not via HttpError,
// because errorMiddleware can't carry the structured `moderation` object.
const blockedBody = (reason) => ({ error: 'content_blocked', moderation: { status: 'blocked', reason: reason || 'banned_term' } });
const heldMeta = (reason) => ({ status: 'held', reason: reason || 'similar_match' });

// ── mount: tables + dashboard routes ────────────────────────────────────────
function mount(app, { db, auth }) {
  const sql = db.db;
  S = {
    sql, db,
    now: () => new Date().toISOString(),
    uuid: () => crypto.randomUUID(),
  };
  bustCache();

  sql.exec(`
    CREATE TABLE IF NOT EXISTS moderation_rules (
      id               TEXT PRIMARY KEY,
      scope            TEXT NOT NULL DEFAULT 'client',   -- platform | client
      entity_id        TEXT NOT NULL DEFAULT '',          -- '' for platform rows
      kind             TEXT NOT NULL DEFAULT 'word',      -- word | phrase | emoji | image(p2)
      value            TEXT NOT NULL,                     -- raw, as entered
      value_normalized TEXT NOT NULL,                     -- match key (normalizeText / foldEmoji)
      image_hash       TEXT NOT NULL DEFAULT '',          -- pHash (kind=image, phase 2)
      match_action     TEXT NOT NULL DEFAULT '',          -- ''=default | block | hold
      active           INTEGER NOT NULL DEFAULT 1,
      created_by       TEXT NOT NULL DEFAULT '',
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_modr_scope ON moderation_rules(scope, entity_id, active);

    CREATE TABLE IF NOT EXISTS moderation_items (
      id             TEXT PRIMARY KEY,
      content_type   TEXT NOT NULL,                       -- post | comment | chat_message | reaction | channel_name
      content_id     TEXT NOT NULL DEFAULT '',            -- '' for blocked attempts (nothing persisted)
      snapshot       TEXT NOT NULL DEFAULT '{}',          -- content at decision time (survives edits/deletes; redacted after retention)
      author_user_id TEXT NOT NULL DEFAULT '',
      community_id   TEXT NOT NULL DEFAULT '',
      channel_id     TEXT NOT NULL DEFAULT '',
      entity_id      TEXT NOT NULL DEFAULT '',
      trigger        TEXT NOT NULL,                       -- exact_rule | similar_rule | ai(p2) | user_report
      evidence       TEXT NOT NULL DEFAULT '{}',          -- {ruleId,..} | {reporterId,reportReason} | {aiCategory,aiConfidence}(p2)
      status         TEXT NOT NULL,                       -- pending | approved | declined | auto_blocked
      reviewed_by    TEXT NOT NULL DEFAULT '',
      reviewed_at    TEXT NOT NULL DEFAULT '',
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_modi_queue ON moderation_items(entity_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_modi_content ON moderation_items(content_type, content_id);
  `);

  // Snapshot retention: redact content past the configurable window (privacy —
  // contract §11). Lazy: runs at mount + before audit reads; cheap no-op after.
  function redactOldSnapshots() {
    const days = Number(db.getSetting('moderation_snapshot_days', '')) || SNAPSHOT_DAYS_DEFAULT;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    sql.prepare("UPDATE moderation_items SET snapshot='{\"redacted\":true}' WHERE created_at<? AND snapshot NOT LIKE '%redacted%'").run(cutoff);
  }
  redactOldSnapshots();

  // ── rules CRUD (shared by all three surfaces) ──
  const ruleRow = (r) => ({
    id: r.id, scope: r.scope, entityId: r.entity_id || null, kind: r.kind, value: r.value,
    matchAction: r.match_action || null, active: !!r.active, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  });
  const looksEmoji = (v) => /\p{Extended_Pictographic}/u.test(v);
  function createRule(scope, entityId, body, user) {
    const value = String((body || {}).value || '').trim().slice(0, MAX_VALUE);
    if (!value) throw new HttpError(400, 'A word, phrase or emoji is required');
    let kind = String((body || {}).kind || '');
    if (!kind) kind = looksEmoji(value) ? 'emoji' : (normalizeText(value).trim().includes(' ') ? 'phrase' : 'word');
    if (!RULE_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${RULE_KINDS.join(', ')} (images arrive in phase 2)`);
    const action = String((body || {}).matchAction || '').replace('flag', 'hold');
    if (!ACTIONS.includes(action)) throw new HttpError(400, 'matchAction must be block or hold');
    const normalized = kind === 'emoji' ? foldEmoji(value) : normalizeText(value).replace(/\s+/g, ' ').trim();
    if (!normalized) throw new HttpError(400, 'That entry normalizes to nothing — nothing would ever match it');
    const id = `rul_${S.uuid().slice(0, 12)}`;
    sql.prepare(`INSERT INTO moderation_rules (id, scope, entity_id, kind, value, value_normalized, match_action, created_by, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, scope, scope === 'platform' ? '' : String(entityId), kind, value, normalized, action, user?.email || '', S.now(), S.now());
    bustCache();
    return ruleRow(sql.prepare('SELECT * FROM moderation_rules WHERE id=?').get(id));
  }
  function scopedRule(id, scope, entityId) {
    const r = sql.prepare('SELECT * FROM moderation_rules WHERE id=?').get(String(id));
    if (!r || r.scope !== scope || (scope === 'client' && r.entity_id !== String(entityId))) throw new HttpError(404, 'Rule not found');
    return r;
  }
  function listRules(scope, entityId) {
    const rows = scope === 'platform'
      ? sql.prepare("SELECT * FROM moderation_rules WHERE scope='platform' ORDER BY created_at DESC").all()
      : sql.prepare("SELECT * FROM moderation_rules WHERE scope='client' AND entity_id=? ORDER BY created_at DESC").all(String(entityId));
    return { rules: rows.map(ruleRow) };
  }
  function patchRule(scope, entityId, id, body) {
    const r = scopedRule(id, scope, entityId);
    const sets = {};
    if (body.active !== undefined) sets.active = body.active ? 1 : 0;
    if (body.matchAction !== undefined) {
      const a = String(body.matchAction || '').replace('flag', 'hold');
      if (!ACTIONS.includes(a)) throw new HttpError(400, 'matchAction must be block or hold');
      sets.match_action = a;
    }
    if (body.value !== undefined) {
      const v = String(body.value || '').trim().slice(0, MAX_VALUE);
      if (!v) throw new HttpError(400, 'A value is required');
      sets.value = v;
      sets.value_normalized = r.kind === 'emoji' ? foldEmoji(v) : normalizeText(v).replace(/\s+/g, ' ').trim();
    }
    const keys = Object.keys(sets);
    if (keys.length) sql.prepare(`UPDATE moderation_rules SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`).run(...keys.map((k) => sets[k]), S.now(), r.id);
    bustCache();
    return ruleRow(sql.prepare('SELECT * FROM moderation_rules WHERE id=?').get(r.id));
  }
  function deleteRule(scope, entityId, id) {
    scopedRule(id, scope, entityId);
    sql.prepare('DELETE FROM moderation_rules WHERE id=?').run(String(id));
    bustCache();
  }
  // Bulk import: one entry per line (CSV/paste). Kind auto-detected per line.
  function importRules(scope, entityId, body, user) {
    const lines = String((body || {}).entries || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean).slice(0, 500);
    let created = 0;
    for (const line of lines) { try { createRule(scope, entityId, { value: line }, user); created++; } catch { /* skip bad lines */ } }
    return { ok: true, created, skipped: lines.length - created };
  }

  // ── review queue + audit ──
  const itemRow = (r) => ({
    id: r.id, contentType: r.content_type, contentId: r.content_id || null,
    snapshot: (() => { try { return JSON.parse(r.snapshot); } catch { return {}; } })(),
    authorUserId: r.author_user_id || null, communityId: r.community_id || null, channelId: r.channel_id || null,
    entityId: r.entity_id || null, trigger: r.trigger,
    evidence: (() => { try { return JSON.parse(r.evidence); } catch { return {}; } })(),
    status: r.status, reviewedBy: r.reviewed_by || null, reviewedAt: r.reviewed_at || null, createdAt: r.created_at,
  });
  // entityId null → platform view (everything, filterable) — Howler oversight
  // also covers clients whose own console flag is off (contract §8.2).
  function listItems({ entityId = null, status = 'pending', type = '', limit = 100, before = '' } = {}) {
    const cond = ['1=1'];
    const args = [];
    if (entityId != null) { cond.push('entity_id=?'); args.push(String(entityId)); }
    if (status) { cond.push('status=?'); args.push(status); }
    if (type) { cond.push('content_type=?'); args.push(type); }
    if (before) { cond.push('created_at<?'); args.push(before); }
    const rows = sql.prepare(`SELECT * FROM moderation_items WHERE ${cond.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
      .all(...args, Math.min(Math.max(Number(limit) || 100, 1), 200));
    const pending = sql.prepare(`SELECT COUNT(*) n, MIN(created_at) oldest FROM moderation_items WHERE status='pending'${entityId != null ? ' AND entity_id=?' : ''}`)
      .get(...(entityId != null ? [String(entityId)] : []));
    return { items: rows.map(itemRow), pendingCount: pending.n, oldestPendingAt: pending.oldest || null, nextCursor: rows.length ? rows[rows.length - 1].created_at : null };
  }
  // Flip the underlying content row's moderation_status. Content tables belong
  // to social.js/chat.js; guarded so a missing module (not mounted) can't 500.
  const CONTENT_TABLES = { post: 'social_feed_posts', comment: 'social_feed_comments', chat_message: 'social_chat_messages' };
  function setContentStatus(item, status) {
    const table = CONTENT_TABLES[item.content_type];
    if (!table || !item.content_id) return;
    try {
      sql.prepare(`UPDATE ${table} SET moderation_status=? WHERE id=?`).run(status, item.content_id);
      if (table === 'social_chat_messages' && status === 'removed') { // mirror moderator delete: clear pins
        sql.prepare('UPDATE social_chat_messages SET pinned=0 WHERE id=?').run(item.content_id);
        sql.prepare('DELETE FROM social_chat_user_pins WHERE message_id=?').run(item.content_id);
      }
    } catch { /* content module not mounted — the item still records the decision */ }
  }
  function decide(id, entityId, approve, user) {
    const ids = Array.isArray(id) ? id : [id];
    const out = [];
    for (const one of ids) {
      const r = sql.prepare('SELECT * FROM moderation_items WHERE id=?').get(String(one));
      if (!r || (entityId != null && r.entity_id !== String(entityId))) throw new HttpError(404, 'Queue item not found');
      if (r.status !== 'pending') throw new HttpError(400, 'This item has already been decided');
      // Approve: held content → visible (a user report just closes — it was
      // never hidden). Decline: content → removed (author sees the stub).
      if (approve) { if (r.trigger !== 'user_report') setContentStatus(r, 'visible'); }
      else setContentStatus(r, 'removed');
      sql.prepare('UPDATE moderation_items SET status=?, reviewed_by=?, reviewed_at=? WHERE id=?')
        .run(approve ? 'approved' : 'declined', user?.email || '', S.now(), r.id);
      out.push(itemRow(sql.prepare('SELECT * FROM moderation_items WHERE id=?').get(r.id)));
    }
    return Array.isArray(id) ? { items: out } : out[0];
  }

  // ── routes: platform · admin-on-behalf · client self-service ──
  // Platform WRITES need the platform_moderator tag; reads are open to admins.
  const requirePlatformMod = (req, res, next) => {
    if (!roles.isPlatformModerator(req.user)) return res.status(403).json({ error: 'Platform moderator access required' });
    next();
  };
  // (surface, scope, entityFrom) → the same handlers on all three prefixes.
  function mountSurface(prefix, mws, scope, eid) {
    const wrap = (fn) => asyncHandler(async (req, res) => res.json(await fn(req)));
    app.get(`${prefix}/rules`, ...mws.read, wrap((req) => listRules(scope, eid(req))));
    app.post(`${prefix}/rules`, ...mws.write, wrap((req) => createRule(scope, eid(req), req.body || {}, req.user)));
    app.post(`${prefix}/rules/import`, ...mws.write, wrap((req) => importRules(scope, eid(req), req.body || {}, req.user)));
    // "Would this be caught?" — moderator-facing, so match evidence IS returned.
    app.post(`${prefix}/rules/test`, ...mws.read, wrap((req) => {
      const v = screenText(eid(req), String((req.body || {}).text || ''));
      return { outcome: v.outcome, matches: v.matches.map((m) => ({ ...m, value: sql.prepare('SELECT value FROM moderation_rules WHERE id=?').get(m.id)?.value })) };
    }));
    app.patch(`${prefix}/rules/:id`, ...mws.write, wrap((req) => patchRule(scope, eid(req), req.params.id, req.body || {})));
    app.delete(`${prefix}/rules/:id`, ...mws.write, wrap((req) => { deleteRule(scope, eid(req), req.params.id); return { ok: true }; }));
    app.get(`${prefix}/queue`, ...mws.read, wrap((req) => listItems({
      entityId: scope === 'platform' ? (String(req.query.entityId || '') || null) : eid(req),
      status: String(req.query.status ?? 'pending'), type: String(req.query.type || ''),
      limit: req.query.limit, before: String(req.query.before || ''),
    })));
    app.post(`${prefix}/queue/:id/approve`, ...mws.write, wrap((req) => decide((req.body || {}).ids || req.params.id, scope === 'platform' ? null : eid(req), true, req.user)));
    app.post(`${prefix}/queue/:id/decline`, ...mws.write, wrap((req) => decide((req.body || {}).ids || req.params.id, scope === 'platform' ? null : eid(req), false, req.user)));
    app.get(`${prefix}/audit`, ...mws.read, wrap((req) => {
      redactOldSnapshots();
      return listItems({ entityId: scope === 'platform' ? (String(req.query.entityId || '') || null) : eid(req), status: '', limit: req.query.limit, before: String(req.query.before || '') });
    }));
  }
  mountSurface('/api/admin/moderation',
    { read: [auth.requireAdmin], write: [auth.requireAdmin, requirePlatformMod] },
    'platform', () => '');
  mountSurface('/api/admin/entities/:entityId/moderation',
    { read: [auth.requireAdmin], write: [auth.requireAdmin] },
    'client', (req) => String(req.params.entityId));
  const myEid = (req) => String(req.query.entityId || (req.body || {}).entityId || '');
  const myPerm = auth.requirePermission(roles.PERMISSIONS.MODERATION_MANAGE, myEid);
  mountSurface('/api/my/moderation',
    { read: [auth.requireAuth, myPerm], write: [auth.requireAuth, myPerm] },
    'client', myEid);

  return { screenText, screenEmoji, recordHold, recordBlockedAttempt, recordReport };
}

module.exports = {
  mount, screenText, screenEmoji, recordHold, recordBlockedAttempt, recordReport,
  blockedBody, heldMeta,
  // pure pieces, exported for tests
  normalizeText, foldEmoji, joinedSingles, levenshtein,
  _bustCache: bustCache,
};
