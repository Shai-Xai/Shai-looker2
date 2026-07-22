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

module.exports = function actionAutomations({ app, auth, guard, sql, now, uuid, enabled, getAction, audienceFor, saveResults, push, enrollSequence, sysUser }) {
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
  setTimeout(() => autoCheck().catch(() => {}), 20000).unref?.();

  // ── Conversion tracking for ONCE-OFF campaigns ──────────────────────────────
  // Sequences track conversions inline (drop-out = bought). For sent once-off
  // campaigns with a re-runnable tile audience, periodically re-run the abandoned
  // audience: anyone we emailed who's no longer in it has bought (or expired).
  // Recompute (idempotent), update results.converted. Bounded to recent sends.
  const lc = (s) => String(s || '').toLowerCase();
  // Is dropout/list conversion tracking even applicable to this campaign? (once-off,
  // and either a re-runnable tile audience for dropout, or a configured list source.)
  function convMode(a) {
    if (!a || a.config.campaignMode === 'sequence') return null;
    if (a.config.conversion?.mode === 'list' && a.config.conversion?.source) return 'list';
    if (a.config.audience?.mode === 'tile') return 'dropout';
    return null;
  }
  // Recompute conversions for ONE campaign now. Dropout: anyone we emailed who's no
  // longer in the abandoned audience has bought (or expired). List: anyone in the
  // separate orders/attendance source. Returns { converted, mode, audience } or null
  // when tracking doesn't apply / the source failed (so callers leave the count as-is).
  async function recomputeConversion(a) {
    const mode = convMode(a);
    if (!mode) return null;
    const audience = (a.audience || []);
    if (mode === 'list') {
      const conv = await convertedEmails(a);
      if (!conv) return null;
      return { mode, audience: audience.length, converted: audience.filter((r) => conv.has(lc(r.email))).length };
    }
    const { list } = await audienceFor(a.entityId, a.config, sysUser);
    const stillAbandoning = new Set(list.map((r) => lc(r.email))); // case-insensitive so casing drift ≠ false conversions
    return { mode, audience: audience.length, converted: audience.filter((r) => !stillAbandoning.has(lc(r.email))).length };
  }

  async function checkConversions() {
    if (!enabled()) return;
    const cutoff = new Date(Date.now() - 14 * 86400e3).toISOString(); // track for 14 days post-send
    const recheck = new Date(Date.now() - 6 * 3600e3).toISOString();  // at most every 6h per campaign
    const due = sql.prepare("SELECT id FROM actions WHERE status='done' AND approved_at > ? AND (last_check='' OR last_check < ?)").all(cutoff, recheck);
    for (const { id } of due) {
      const a = getAction(id);
      if (!a || !convMode(a)) continue;
      sql.prepare('UPDATE actions SET last_check=? WHERE id=?').run(now(), a.id);
      try {
        const out = await recomputeConversion(a);
        if (out && out.converted !== (a.results.converted || 0)) saveResults(a.id, { ...a.results, converted: out.converted });
      } catch (e) { console.error('[actions] conversion check failed', a.id, e.message); }
    }
  }
  const convTimer = setInterval(() => checkConversions().catch(() => {}), 30 * 60000);
  if (convTimer.unref) convTimer.unref();
  setTimeout(() => checkConversions().catch(() => {}), 45000).unref?.();

  // Manual "re-check now" — force a conversion recompute without waiting for the
  // 6-hourly sweep, then return the fresh count. (Mounted here since the compute
  // lives here; keeps actions.js under its line budget.)
  if (app && auth && guard) {
    app.post('/api/actions/:entityId/:id/recheck-conversions', auth.requireAuth, auth.requirePermission('campaigns.view'), async (req, res) => {
      if (!guard(req, res, req.params.entityId)) return;
      const a = getAction(req.params.id);
      if (!a || a.entityId !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
      if (!convMode(a)) return res.status(400).json({ error: 'Conversion tracking does not apply to this campaign.' });
      try {
        const out = await recomputeConversion(a);
        if (!out) return res.status(502).json({ error: 'Could not read the conversion source right now — try again shortly.' });
        if (out.converted !== (a.results.converted || 0)) saveResults(a.id, { ...a.results, converted: out.converted });
        const sent = a.results.sent || 0;
        res.json({ converted: out.converted, mode: out.mode, audience: out.audience, convRate: sent > 0 ? Math.round((out.converted / sent) * 100) : 0 });
      } catch (e) { console.error('[actions] manual conversion recheck failed', a.id, e.message); res.status(500).json({ error: 'Re-check failed.' }); }
    });
  }

  return { convertedEmails, convMode, recomputeConversion };
};
