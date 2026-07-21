// ─── DSAR / data-lifecycle tooling — disposable module ────────────────────────
// POPIA/GDPR machinery (audit F4). Two jobs, both registry-driven sweeps over
// every table that holds contact-level personal data (the registry mirrors the
// PII map in docs/PRIVACY_DATA_MAP.md — keep both in sync when adding tables):
//
//   • purgeEntityData(entityId) — full cleanup when a client is offboarded.
//     deleteEntity's FK cascade only reaches 4 tables; every feature table
//     (campaigns, fan profiles, surveys, chat, mail log, pixel…) uses a plain
//     entity_id with no FK and previously survived forever. Wired into
//     DELETE /api/admin/entities/:id so offboarding is actually complete.
//   • forgetContact({email, phone}) — "right to erasure" for one person:
//     deletes/scrubs their rows everywhere INCLUDING inside historical
//     campaign-audience JSON snapshots, but DELIBERATELY KEEPS suppression
//     rows (mail_suppressions / action_suppressions): remembering who asked
//     not to be contacted is the lawful, minimal exception — forgetting it
//     would re-subscribe them.
//   • exportContact({email, phone}) — "right of access": everything held on a
//     contact, as JSON, for DSAR responses.
//
// Sweeps are fault-tolerant per table (modules are disposable — a table may
// not exist on this install); anything skipped is reported, never silent.
// Known gap, documented not hidden: os/ticket attachment BYTES live on disk
// keyed by row id — rows are deleted here; orphaned files are unreferenced
// and unreadable via the app, and are bounded by the disk-retention story.
//
// Self-owned: remove this file + the mounts in index.js to uninstall.

let db = null;
const sql = () => db.db;

// One @eid parameter, possibly used several times (better-sqlite3 named params).
const ENTITY_PURGE = [
  // campaigns + children (send ledger, tracking, drip state)
  ['action_clicks', 'DELETE FROM action_clicks WHERE action_id IN (SELECT id FROM actions WHERE entity_id=@eid)'],
  ['action_opens', 'DELETE FROM action_opens WHERE action_id IN (SELECT id FROM actions WHERE entity_id=@eid)'],
  ['action_short_links', 'DELETE FROM action_short_links WHERE action_id IN (SELECT id FROM actions WHERE entity_id=@eid)'],
  ['action_sent', 'DELETE FROM action_sent WHERE root_id IN (SELECT id FROM actions WHERE entity_id=@eid)'],
  ['action_sends', 'DELETE FROM action_sends WHERE action_id IN (SELECT id FROM actions WHERE entity_id=@eid)'],
  ['action_enrollments', 'DELETE FROM action_enrollments WHERE action_id IN (SELECT id FROM actions WHERE entity_id=@eid)'],
  ['action_promo_codes', 'DELETE FROM action_promo_codes WHERE action_id IN (SELECT id FROM actions WHERE entity_id=@eid)'],
  ['action_approvals', 'DELETE FROM action_approvals WHERE action_id IN (SELECT id FROM actions WHERE entity_id=@eid)'],
  ['actions', 'DELETE FROM actions WHERE entity_id=@eid'],
  ['action_suppressions', 'DELETE FROM action_suppressions WHERE entity_id=@eid'], // per-entity opt-outs die with the entity; GLOBAL mail_suppressions survive
  ['campaign_masters', 'DELETE FROM campaign_masters WHERE entity_id=@eid'],
  // fan capture (profiles → sessions → messages/events)
  ['fan_messages', 'DELETE FROM fan_messages WHERE session_id IN (SELECT id FROM fan_sessions WHERE profile_id IN (SELECT id FROM fan_profiles WHERE entity_id=@eid))'],
  ['fan_events', 'DELETE FROM fan_events WHERE session_id IN (SELECT id FROM fan_sessions WHERE profile_id IN (SELECT id FROM fan_profiles WHERE entity_id=@eid))'],
  ['fan_events#site', 'DELETE FROM fan_events WHERE site_id IN (SELECT id FROM fan_sites WHERE entity_id=@eid)'],
  ['fan_sessions', 'DELETE FROM fan_sessions WHERE profile_id IN (SELECT id FROM fan_profiles WHERE entity_id=@eid)'],
  ['fan_profiles', 'DELETE FROM fan_profiles WHERE entity_id=@eid'],
  ['fan_assets', 'DELETE FROM fan_assets WHERE entity_id=@eid'],
  ['fan_sites', 'DELETE FROM fan_sites WHERE entity_id=@eid'],
  ['fan_catalogue', 'DELETE FROM fan_catalogue WHERE entity_id=@eid'],
  ['fan_knowledge', 'DELETE FROM fan_knowledge WHERE entity_id=@eid'],
  ['fan_pages', 'DELETE FROM fan_pages WHERE entity_id=@eid'],
  // surveys
  ['survey_links', 'DELETE FROM survey_links WHERE survey_id IN (SELECT id FROM surveys WHERE entity_id=@eid)'],
  ['survey_responses', 'DELETE FROM survey_responses WHERE survey_id IN (SELECT id FROM surveys WHERE entity_id=@eid)'],
  ['surveys', 'DELETE FROM surveys WHERE entity_id=@eid'],
  // OS inbox (threads → messages/receipts/attachment rows)
  ['os_receipts', 'DELETE FROM os_receipts WHERE thread_id IN (SELECT id FROM os_threads WHERE entity_id=@eid)'],
  ['os_attachments', 'DELETE FROM os_attachments WHERE thread_id IN (SELECT id FROM os_threads WHERE entity_id=@eid)'],
  ['os_messages', 'DELETE FROM os_messages WHERE thread_id IN (SELECT id FROM os_threads WHERE entity_id=@eid)'],
  ['os_threads', 'DELETE FROM os_threads WHERE entity_id=@eid'],
  // fan social chat
  ['social_chat_members', 'DELETE FROM social_chat_members WHERE channel_id IN (SELECT id FROM social_chat_channels WHERE entity_id=@eid)'],
  ['social_chat_reactions', 'DELETE FROM social_chat_reactions WHERE message_id IN (SELECT id FROM social_chat_messages WHERE entity_id=@eid)'],
  ['social_chat_reads', 'DELETE FROM social_chat_reads WHERE channel_id IN (SELECT id FROM social_chat_channels WHERE entity_id=@eid)'],
  ['social_chat_user_pins', 'DELETE FROM social_chat_user_pins WHERE channel_id IN (SELECT id FROM social_chat_channels WHERE entity_id=@eid)'],
  ['social_chat_messages', 'DELETE FROM social_chat_messages WHERE entity_id=@eid'],
  ['social_chat_channels', 'DELETE FROM social_chat_channels WHERE entity_id=@eid'],
  // social feed + social+
  ['social_feed_posts', 'DELETE FROM social_feed_posts WHERE entity_id=@eid'],
  ['social_feed_comments', 'DELETE FROM social_feed_comments WHERE entity_id=@eid'],
  ['social_feed_members', 'DELETE FROM social_feed_members WHERE entity_id=@eid'],
  ['social_feed_posters', 'DELETE FROM social_feed_posters WHERE entity_id=@eid'],
  ['socialplus_joins', 'DELETE FROM socialplus_joins WHERE entity_id=@eid'],
  ['socialplus_members', 'DELETE FROM socialplus_members WHERE entity_id=@eid'],
  ['socialplus_presence', 'DELETE FROM socialplus_presence WHERE entity_id=@eid'],
  ['socialplus_actors', 'DELETE FROM socialplus_actors WHERE entity_id=@eid'],
  // mail + pixel + uploads + WhatsApp + Owl chat
  ['mail_log', 'DELETE FROM mail_log WHERE entity_id=@eid'],
  ['pixel_events', 'DELETE FROM pixel_events WHERE entity_id=@eid'],
  ['pixel_audiences', 'DELETE FROM pixel_audiences WHERE entity_id=@eid'],
  ['owl_uploads', 'DELETE FROM owl_uploads WHERE entity_id=@eid'],
  ['owl_wa_msgs', 'DELETE FROM owl_wa_msgs WHERE entity_id=@eid'],
  ['owl_wa_events', 'DELETE FROM owl_wa_events WHERE entity_id=@eid'],
  ['owl_wa_suggest', 'DELETE FROM owl_wa_suggest WHERE entity_id=@eid'],
  ['owl_wa_sent', 'DELETE FROM owl_wa_sent WHERE entity_id=@eid'],
  ['owl_wa_pending', 'DELETE FROM owl_wa_pending WHERE entity_id=@eid'],
  ['owl_messages', 'DELETE FROM owl_messages WHERE thread_id IN (SELECT id FROM owl_threads WHERE entity_id=@eid)'],
  ['owl_threads', 'DELETE FROM owl_threads WHERE entity_id=@eid'],
  // tickets (product board) raised under this entity
  ['ticket_comments', 'DELETE FROM ticket_comments WHERE ticket_id IN (SELECT id FROM tickets WHERE entity_id=@eid)'],
  ['ticket_attachments', 'DELETE FROM ticket_attachments WHERE ticket_id IN (SELECT id FROM tickets WHERE entity_id=@eid)'],
  ['tickets', 'DELETE FROM tickets WHERE entity_id=@eid'],
  // financial documents (FK is SET NULL — rows would otherwise linger orphaned)
  ['settlements', 'DELETE FROM settlements WHERE entity_id=@eid'],
  ['event_documents', 'DELETE FROM event_documents WHERE entity_id=@eid'],
  // event-ops staff lists
  ['eventops_staff', 'DELETE FROM eventops_staff WHERE entity_id=@eid'],
  ['eventops_staff_wa', 'DELETE FROM eventops_staff_wa WHERE entity_id=@eid'],
];

// Contact-level erasure. @e = lowercased email, @p / @pd = phone raw/digits.
// Suppression tables are ABSENT by design (see module header).
const CONTACT_FORGET = [
  ['action_clicks', "DELETE FROM action_clicks WHERE lower(email)=@e AND @e<>''"],
  ['action_opens', "DELETE FROM action_opens WHERE lower(email)=@e AND @e<>''"],
  ['action_sent', "DELETE FROM action_sent WHERE lower(email)=@e AND @e<>''"],
  ['action_sends', "DELETE FROM action_sends WHERE (lower(recipient)=@e AND @e<>'') OR (@p<>'' AND (recipient=@p OR recipient=@pd))"],
  ['action_enrollments', "DELETE FROM action_enrollments WHERE lower(email)=@e AND @e<>''"],
  ['action_promo_codes', "DELETE FROM action_promo_codes WHERE lower(email)=@e AND @e<>''"],
  ['survey_responses', "DELETE FROM survey_responses WHERE lower(email)=@e AND @e<>''"],
  ['survey_links', "DELETE FROM survey_links WHERE lower(email)=@e AND @e<>''"],
  ['fan_messages', "DELETE FROM fan_messages WHERE session_id IN (SELECT s.id FROM fan_sessions s JOIN fan_profiles p ON p.id=s.profile_id WHERE lower(p.email)=@e AND @e<>'')"],
  ['fan_events', "DELETE FROM fan_events WHERE session_id IN (SELECT s.id FROM fan_sessions s JOIN fan_profiles p ON p.id=s.profile_id WHERE lower(p.email)=@e AND @e<>'')"],
  ['fan_sessions', "DELETE FROM fan_sessions WHERE profile_id IN (SELECT id FROM fan_profiles WHERE lower(email)=@e AND @e<>'')"],
  ['fan_profiles', "DELETE FROM fan_profiles WHERE lower(email)=@e AND @e<>''"],
  ['mail_log', "DELETE FROM mail_log WHERE lower(recipient)=@e AND @e<>''"],
  ['owl_wa_msgs', "DELETE FROM owl_wa_msgs WHERE @p<>'' AND (msisdn=@p OR msisdn=@pd)"],
  ['owl_wa_events', "DELETE FROM owl_wa_events WHERE @p<>'' AND (msisdn=@p OR msisdn=@pd)"],
  ['owl_wa_suggest', "DELETE FROM owl_wa_suggest WHERE @p<>'' AND (msisdn=@p OR msisdn=@pd)"],
  ['owl_wa_sent', "DELETE FROM owl_wa_sent WHERE @p<>'' AND (msisdn=@p OR msisdn=@pd)"],
  ['owl_wa_pending', "DELETE FROM owl_wa_pending WHERE @p<>'' AND (msisdn=@p OR msisdn=@pd)"],
];

const digits = (s) => String(s || '').replace(/\D/g, '');
const contactParams = ({ email, phone }) => ({
  e: String(email || '').trim().toLowerCase(),
  p: String(phone || '').trim(),
  pd: digits(phone),
});

// Run a sweep list; per-table fault tolerance. Returns { removed, skipped }.
function runSweep(steps, params) {
  const removed = {};
  const skipped = [];
  for (const [label, stmt] of steps) {
    try {
      const info = sql().prepare(stmt).run(params);
      if (info.changes) removed[label] = (removed[label] || 0) + info.changes;
    } catch {
      skipped.push(label); // table/column absent on this install — reported, not silent
    }
  }
  return { removed, skipped };
}

function purgeEntityData(entityId) {
  const out = runSweep(ENTITY_PURGE, { eid: String(entityId) });
  return { entityId, ...out };
}

// Does this audience row belong to the contact being forgotten?
function rowMatches(row, { e, p, pd }) {
  if (!row || typeof row !== 'object') return false;
  const em = String(row.email || '').trim().toLowerCase();
  if (e && em === e) return true;
  const ph = String(row.phone || row.msisdn || '').trim();
  return !!(p && ph && (ph === p || digits(ph) === pd));
}

// Scrub the contact out of historical campaign-audience JSON snapshots
// (actions.audience, and config.audience where embedded). LIKE prefilter keeps
// this from parsing every blob; matching is done on parsed rows.
function scrubAudiences(params) {
  let scrubbed = 0;
  const needles = [params.e, params.p, params.pd].filter(Boolean);
  if (!needles.length) return 0;
  let rows = [];
  try {
    const like = needles.map(() => '(audience LIKE ? OR config LIKE ?)').join(' OR ');
    rows = sql().prepare(`SELECT id, audience, config FROM actions WHERE ${like}`)
      .all(...needles.flatMap((n) => [`%${n}%`, `%${n}%`]));
  } catch { return 0; } // actions table absent on this install
  const upd = sql().prepare('UPDATE actions SET audience=@audience, config=@config WHERE id=@id');
  for (const r of rows) {
    let audience = r.audience, config = r.config, touched = false;
    try {
      const list = JSON.parse(r.audience || 'null');
      if (Array.isArray(list)) {
        const kept = list.filter((row) => !rowMatches(row, params));
        if (kept.length !== list.length) { audience = JSON.stringify(kept); scrubbed += list.length - kept.length; touched = true; }
      }
    } catch { /* not JSON — leave untouched */ }
    try {
      const cfg = JSON.parse(r.config || 'null');
      if (cfg && Array.isArray(cfg.audience)) {
        const kept = cfg.audience.filter((row) => !rowMatches(row, params));
        if (kept.length !== cfg.audience.length) { cfg.audience = kept; config = JSON.stringify(cfg); scrubbed += 1; touched = true; }
      }
    } catch { /* not JSON — leave untouched */ }
    if (touched) upd.run({ id: r.id, audience, config });
  }
  return scrubbed;
}

function forgetContact({ email, phone }) {
  const params = contactParams({ email, phone });
  if (!params.e && !params.p) throw new (require('./http').HttpError)(400, 'Provide an email or phone to forget.');
  const out = runSweep(CONTACT_FORGET, params);
  const audienceRows = scrubAudiences(params);
  if (audienceRows) out.removed['actions.audience (snapshot rows)'] = audienceRows;
  // Suppressions intentionally kept — record that honestly in the result.
  return { email: params.e || undefined, phone: params.p || undefined, ...out, kept: ['mail_suppressions', 'action_suppressions'] };
}

// Right of access: everything held on a contact. SELECT mirror of the forget
// sweep + audience-snapshot membership (campaign id/name only, not the blob).
function exportContact({ email, phone }) {
  const params = contactParams({ email, phone });
  if (!params.e && !params.p) throw new (require('./http').HttpError)(400, 'Provide an email or phone to export.');
  const data = {};
  for (const [label, stmt] of CONTACT_FORGET) {
    try {
      const rows = sql().prepare(stmt.replace(/^DELETE FROM (\w+) WHERE/, 'SELECT * FROM $1 WHERE')).all(params);
      if (rows.length) data[label] = rows;
    } catch { /* table absent */ }
  }
  try {
    const suppression = sql().prepare("SELECT 'mail' AS tier, email, reason FROM mail_suppressions WHERE lower(email)=@e AND @e<>'' UNION ALL SELECT 'entity', email, reason FROM action_suppressions WHERE lower(email)=@e AND @e<>''").all(params);
    if (suppression.length) data.suppressions = suppression;
  } catch { /* absent */ }
  const inAudiences = [];
  try {
    const needles = [params.e, params.p, params.pd].filter(Boolean);
    const like = needles.map(() => '(audience LIKE ? OR config LIKE ?)').join(' OR ');
    for (const r of sql().prepare(`SELECT id, title, audience FROM actions WHERE ${like}`).all(...needles.flatMap((n) => [`%${n}%`, `%${n}%`]))) {
      try {
        const list = JSON.parse(r.audience || 'null');
        if (Array.isArray(list) && list.some((row) => rowMatches(row, params))) inAudiences.push({ campaignId: r.id, title: r.title });
      } catch { /* not JSON */ }
    }
  } catch { /* absent */ }
  if (inAudiences.length) data.campaign_audiences = inAudiences;
  return { email: params.e || undefined, phone: params.p || undefined, exportedAt: new Date().toISOString(), data };
}

function mount(app, deps) {
  db = deps.db;
  const { auth } = deps;
  const { asyncHandler } = require('./http');

  // Right of access — JSON download of everything held on a contact.
  app.get('/api/admin/dsar/export', auth.requireSuperAdmin, asyncHandler(async (req, res) => {
    res.json(exportContact({ email: req.query.email, phone: req.query.phone }));
  }));
  // Right to erasure — destructive; super-admin + explicit confirm flag.
  app.post('/api/admin/dsar/forget', auth.requireSuperAdmin, asyncHandler(async (req, res) => {
    const { email, phone, confirm } = req.body || {};
    if (confirm !== true) return res.status(400).json({ error: 'Pass confirm:true — this permanently erases the contact everywhere.' });
    const result = forgetContact({ email, phone });
    try { db.recordAction({ userId: req.user.id, action: 'admin.dsar.forget', label: `Forgot contact ${result.email || result.phone}`, method: 'POST', path: req.path }); } catch { /* audit best-effort */ }
    res.json(result);
  }));
  return module.exports;
}

// Complete offboarding in one call: sweep the no-FK feature tables, then let
// deleteEntity's FK cascade take the core 4. Audited like other admin actions.
function offboardEntity(entityId, userId) {
  const purged = purgeEntityData(entityId);
  db.deleteEntity(entityId);
  try { db.recordAction({ userId, action: 'admin.entity.delete', label: `Deleted entity ${entityId} (+purged ${Object.keys(purged.removed).length} tables)`, method: 'DELETE', path: `/api/admin/entities/${entityId}` }); } catch { /* audit best-effort */ }
  return { ok: true, purged };
}

function init(deps) { db = deps.db; return module.exports; }

module.exports = { init, mount, purgeEntityData, forgetContact, exportContact, offboardEntity, _registry: { ENTITY_PURGE, CONTACT_FORGET } };
