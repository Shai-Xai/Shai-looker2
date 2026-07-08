// ─── Recurring campaign automations — extracted from actions.js ───────────────
// The two background loops that keep 'auto' campaigns alive:
//   • autoCheck — every active automation re-runs its audience tile roughly
//     daily; anyone NEW (never reached by this campaign family) is queued as a
//     child DRAFT for explicit human approval — automation proposes, a person
//     approves. Drip sequences enroll new abandoners instead.
//   • checkConversions — for sent once-off campaigns, periodically re-run the
//     audience (or the separate conversion source) and recompute
//     results.converted. Idempotent; bounded to recent sends.
// Factory: require('./actionAutomations')({ sql, now, uuid, enabled, getAction,
// audienceFor, saveResults, push, enrollSequence, sysUser }). Returns
// { convertedEmails } (the drip loop shares the conversion-source resolver).

const crypto = require('crypto');

module.exports = function actionAutomations({ sql, now, uuid, enabled, getAction, audienceFor, saveResults, push, enrollSequence, sysUser }) {
  // In 'list' conversion mode, resolve the separate conversion source (attendance /
  // completed-orders) → lowercased set of emails that have converted. Null for the
  // default 'dropout' model (callers keep prior behaviour); consent ignored (we only
  // need the emails); failures fall back to null so a broken source can't flag everyone.
  async function convertedEmails(action) {
    const conv = action.config && action.config.conversion;
    if (!conv || conv.mode !== 'list' || !conv.source) return null;
    try {
      const subCfg = { ...action.config, audience: conv.source, ignoreConsent: true, channel: 'email' };
      const { list } = await audienceFor(action.entityId, subCfg, sysUser);
      return new Set(list.map((r) => String(r.email || '').toLowerCase()).filter(Boolean));
    } catch (e) { console.error('[actions] conversion source failed', action.id, e.message); return null; }
  }

  async function autoCheck() {
    if (!enabled()) return;
    const due = sql.prepare("SELECT id FROM actions WHERE status='auto' AND (last_check='' OR last_check < ?)")
      .all(new Date(Date.now() - 20 * 3600e3).toISOString());
    for (const { id } of due) {
      const a = getAction(id);
      if (!a) continue;
      sql.prepare('UPDATE actions SET last_check=? WHERE id=?').run(now(), a.id);
      // Drip sequences enroll new abandoners instead of queuing child drafts.
      if (a.config.campaignMode === 'sequence') { try { await enrollSequence(a); } catch (e) { console.error('[actions] enroll failed', a.id, e.message); } continue; }
      try {
        const { list } = await audienceFor(a.entityId, a.config, sysUser);
        const already = new Set(sql.prepare('SELECT email FROM action_sent WHERE root_id=?').all(a.id).map((r) => r.email));
        const fresh = list.filter((r) => !already.has(r.email));
        if (!fresh.length) continue;
        const childId = uuid();
        const cfg = { ...a.config, audience: { ...a.config.audience, mode: 'snapshot' }, clickToken: crypto.randomBytes(6).toString('base64url') };
        const day = new Date().toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
        sql.prepare('INSERT INTO actions (id, entity_id, type, status, title, config, audience, parent_id, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .run(childId, a.entityId, 'email_campaign', 'draft', `${a.title || 'Campaign'} — ${day} (${fresh.length} new)`.slice(0, 120),
            JSON.stringify(cfg), JSON.stringify(fresh), a.id, 'automation', now(), now());
        console.log(`[actions] automation "${a.title}" queued ${fresh.length} new recipient(s) for approval`);
        // Nudge the client's team: a campaign is waiting for a human to approve.
        // Action buttons (Approve/Review) where supported; tap always deep-links
        // to the campaign. requireInteraction — it's a decision, not an FYI.
        if (push?.isEnabled?.()) {
          push.sendToEntity(a.entityId, {
            title: 'Campaign ready for approval',
            body: `${a.title || 'A campaign'} — ${fresh.length} new recipient${fresh.length === 1 ? '' : 's'} waiting for your go-ahead.`,
            url: `/actions?action=${childId}`,
            tag: `action-${childId}`,
            requireInteraction: true,
            actions: [{ action: `approve:${a.entityId}:${childId}`, title: 'Approve' }, { action: 'review', title: 'Review' }],
          }, 'alerts').catch(() => {});
        }
      } catch (e) { console.error('[actions] auto-check failed', a.id, e.message); }
    }
  }
  const autoTimer = setInterval(() => autoCheck().catch(() => {}), 10 * 60000);
  if (autoTimer.unref) autoTimer.unref();
  setTimeout(() => autoCheck().catch(() => {}), 20000);

  // ── Conversion tracking for ONCE-OFF campaigns ──────────────────────────────
  // Sequences track conversions inline (drop-out = bought). For sent once-off
  // campaigns with a re-runnable tile audience, periodically re-run the abandoned
  // audience: anyone we emailed who's no longer in it has bought (or expired).
  // Recompute (idempotent), update results.converted. Bounded to recent sends.
  async function checkConversions() {
    if (!enabled()) return;
    const cutoff = new Date(Date.now() - 14 * 86400e3).toISOString(); // track for 14 days post-send
    const recheck = new Date(Date.now() - 6 * 3600e3).toISOString();  // at most every 6h per campaign
    const due = sql.prepare("SELECT id FROM actions WHERE status='done' AND approved_at > ? AND (last_check='' OR last_check < ?)").all(cutoff, recheck);
    for (const { id } of due) {
      const a = getAction(id);
      if (!a || a.config.campaignMode === 'sequence') continue;
      const listMode = a.config.conversion?.mode === 'list' && a.config.conversion?.source;
      // Dropout mode needs a re-runnable tile audience; list mode matches the
      // snapshot against a separate source, so any audience type works.
      if (!listMode && a.config.audience?.mode !== 'tile') continue;
      sql.prepare('UPDATE actions SET last_check=? WHERE id=?').run(now(), a.id);
      try {
        let converted;
        if (listMode) {
          const conv = await convertedEmails(a);
          if (!conv) continue; // source failed — leave the count as-is
          converted = (a.audience || []).filter((r) => conv.has(String(r.email || '').toLowerCase())).length;
        } else {
          const { list } = await audienceFor(a.entityId, a.config, sysUser);
          const stillAbandoning = new Set(list.map((r) => r.email));
          converted = (a.audience || []).filter((r) => !stillAbandoning.has(r.email)).length;
        }
        if (converted !== (a.results.converted || 0)) saveResults(a.id, { ...a.results, converted });
      } catch (e) { console.error('[actions] conversion check failed', a.id, e.message); }
    }
  }
  const convTimer = setInterval(() => checkConversions().catch(() => {}), 30 * 60000);
  if (convTimer.unref) convTimer.unref();
  setTimeout(() => checkConversions().catch(() => {}), 45000);

  return { convertedEmails };
};
