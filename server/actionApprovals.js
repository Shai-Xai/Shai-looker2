// ─── Campaign approval workflow: summaries + notifications — extracted from actions.js ──
// Everything about telling humans what they're signing off and what happened:
// the approval summary lines (what approvers see), the content preview, the
// approver notifications (inbox + push + email) and the creator outcome
// notifications. Factory so the action engine's own helpers stay injected:
//   require('./actionApprovals')({ db, sql, mailer, push, os, now, approvalSummary, segmentName, rowToAction })

module.exports = function actionApprovals({ db, sql, mailer, push, os, now, approvalSummary, segmentName, rowToAction }) {
  // Howler admins LINKED to this client (fall back to all admins if none) — the
  // people behind the generic 'Howler' approver slot.
  function howlerAdminsFor(entityId) {
    const admins = db.listUsers().filter((u) => u.role === 'admin');
    const linked = admins.filter((u) => (u.entityIds || []).includes(entityId));
    return linked.length ? linked : admins;
  }
  // Pending campaigns where THIS user is an outstanding approver (hasn't signed
  // off yet) — drives the "needs your approval" banner. { count, first }.
  function awaitingApprovalFor(user, entityId) {
    if (!user) return { count: 0, first: '' };
    const rows = sql.prepare("SELECT * FROM actions WHERE entity_id=? AND status='pending'").all(entityId).map(rowToAction);
    const canHowler = user.role === 'admin' && howlerAdminsFor(entityId).some((u) => u.id === user.id);
    const myKeys = [`user:${user.id}`, ...(canHowler ? ['howler'] : [])];
    let count = 0; let first = '';
    for (const a of rows) {
      const mine = approvalSummary(a).approvers.filter((x) => myKeys.includes(x.key) && !x.approved);
      if (mine.length) { count += 1; if (!first) first = a.id; }
    }
    return { count, first };
  }

  // Approval outcomes the signed-in user (the campaign creator) hasn't seen yet
  // — drives a guaranteed "your campaign was approved / sent back" banner.
  function unseenOutcomesFor(user, entityId) {
    if (!user?.email) return [];
    return sql.prepare("SELECT id, title, config, outcome, outcome_by, outcome_note FROM actions WHERE entity_id=? AND outcome!='' AND outcome_seen=0 AND lower(created_by)=lower(?) ORDER BY outcome_at DESC")
      .all(entityId, user.email)
      .map((r) => ({ id: r.id, title: r.title || JSON.parse(r.config || '{}').subject || 'Your campaign', outcome: r.outcome, by: r.outcome_by || '', note: r.outcome_note || '' }));
  }
  // A short, human summary of a campaign's key settings — for the approval
  // inbox message + email so approvers know what they're signing off. `reach`
  // (optional) is the audience resolved at submit time — approvers must see a
  // NUMBER, not just a source name, before they sign off.
  function campaignSummaryLines(a, reach) {
    const c = a.config;
    const isSeq = c.campaignMode === 'sequence';
    const lines = [];
    lines.push(`Channel: ${c.channel === 'both' ? 'Email + SMS' : c.channel === 'sms' ? 'SMS' : 'Email'}`);
    lines.push(`Type: ${isSeq ? `Drip sequence — ${(c.steps || []).length} step${(c.steps || []).length === 1 ? '' : 's'}` : a.recurring ? 'Automated (daily check)' : 'One-off send'}`);
    if (!isSeq && c.subject) lines.push(`Subject: ${c.subject}`);
    const audSrc = c.audience?.mode === 'paste' ? 'Pasted list'
      : c.audience?.mode === 'snapshot' ? 'Queued by automation'
      : c.audience?.mode === 'segment' ? `Segment — ${segmentName(a.entityId, c.audience.segmentId) || 'saved'}`
      : 'Dashboard tile';
    // Reach at submit time (re-resolved live at send, so flag it as an estimate).
    const reachTxt = reach && Number.isFinite(reach.total)
      ? ` — ${reach.total.toLocaleString('en-ZA')} recipient${reach.total === 1 ? '' : 's'} now (email ${reach.email ?? 0} · SMS ${reach.sms ?? 0}; re-resolved at send)`
      : '';
    lines.push(`Audience: ${audSrc}${reachTxt}`);
    // Consent bypass must be IMPOSSIBLE to sign off without noticing.
    if (c.ignoreConsent) lines.push('⚠ CONSENT BYPASS — sends to the whole audience regardless of marketing-consent columns (transactional use only)');
    if (c.master) lines.push(`Master: ${c.master}`);
    if (c.promo?.source && c.promo.source !== 'none') lines.push(`Offer: ${c.promo.code || c.promo.type}`);
    lines.push(`Approvers: ${approvalSummary(a).approvers.map((x) => x.label).join(', ') || '—'}`);
    return lines;
  }
  // The actual campaign copy, for the approval message + email so approvers can
  // see what they're signing off without opening the app. Returns plain text
  // (inbox) and an HTML card that approximates the email (notification email).
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmtDelay = (h) => (h % 24 === 0 && h >= 24 ? `+${h / 24}d` : `+${h}h`);
  function campaignContentPreview(a) {
    const c = a.config;
    const isSeq = c.campaignMode === 'sequence';
    const isEmail = c.channel !== 'sms';
    const card = (subject, bodyText, hero) => `
      <div style="border:1px solid #e6e6e6;border-radius:10px;padding:14px;margin:8px 0;background:#fff;">
        ${hero ? `<img src="${esc(hero)}" alt="" style="max-width:100%;border-radius:6px;margin-bottom:10px;display:block;" />` : ''}
        ${isEmail && subject ? `<div style="font-weight:700;font-size:15px;margin-bottom:6px;">${esc(subject)}</div>` : ''}
        <div style="font-size:13px;line-height:1.5;color:#333;white-space:pre-wrap;">${esc(bodyText)}</div>
      </div>`;
    if (isSeq) {
      const steps = c.steps || [];
      const text = steps.map((s, i) => `— Step ${i + 1} (${fmtDelay(s.delayHours)}) —\n${isEmail && s.subject ? `Subject: ${s.subject}\n` : ''}${s.body || ''}`).join('\n\n');
      const html = steps.map((s, i) => `<div style="font-size:11px;font-weight:700;color:#7c3aed;margin-top:10px;">Step ${i + 1} · ${fmtDelay(s.delayHours)}</div>${card(s.subject, s.body, i === 0 ? c.heroImage : '')}`).join('');
      return { text, html };
    }
    const text = `${isEmail && c.subject ? `Subject: ${c.subject}\n` : ''}${c.body || ''}`;
    return { text, html: card(c.subject, c.body, isEmail ? c.heroImage : '') };
  }
  function notifyApprovers(a, opts = {}) {
    const note = String(opts.message || '').trim();
    const path = `/actions?action=${a.id}`;
    const link = `${mailer.baseUrl()}${path}`;
    const title = 'Campaign approval needed';
    const name = a.title || a.config.subject || 'A campaign';
    const lines = campaignSummaryLines(a, opts.reach);
    const content = campaignContentPreview(a);
    const noteBlock = note ? `“${opts.fromName || 'The sender'}” says:\n${note}\n\n` : '';
    const body = `${noteBlock}“${name}” is waiting for your approval.\n\n${lines.map((l) => `• ${l}`).join('\n')}\n\n— Content —\n${content.text}\n\nReview, preview & approve (or send back to draft):\n${link}`;
    const wantsHowler = (a.config.approvers || []).some((x) => x.type === 'howler');
    const howler = wantsHowler ? howlerAdminsFor(a.entityId) : [];
    try { os?.announce?.({ entityId: a.entityId, title, body, priority: 'needs_reply', createdBy: 'campaigns@pulse', authorType: 'system', subjectType: 'campaign', subjectId: a.id }); } catch { /* os optional */ }
    if (push?.isEnabled?.()) {
      const pushBody = note ? `${note.slice(0, 90)} — “${name}” needs approval.` : `“${name}” is waiting for your approval.`;
      for (const ap of a.config.approvers || []) {
        if (ap.type === 'user' && ap.userId) push.sendToUser(ap.userId, { title, body: pushBody, url: path, tag: `approve-${a.id}`, requireInteraction: true }).catch(() => {});
      }
      for (const u of howler) push.sendToUser(u.id, { title, body: pushBody, url: path, tag: `approve-${a.id}`, requireInteraction: true }).catch(() => {});
    }
    // Email each approver too — a named person's address, or the Howler admins
    // linked to this client.
    if (mailer?.isConfigured?.()) {
      const emails = new Set();
      for (const ap of a.config.approvers || []) {
        if (ap.type !== 'howler' && ap.email) emails.add(ap.email);
      }
      for (const u of howler) emails.add(u.email);
      if (emails.size) {
        const summaryHtml = lines.map((l) => { const [k, ...v] = l.split(':'); return v.length ? `<b>${esc(k)}:</b>${esc(v.join(':'))}` : esc(l); }).join('<br>');
        const noteHtml = note ? `<div style="border-left:3px solid var(--brand,#ff385c);padding:6px 0 6px 12px;margin-bottom:14px;"><b>${esc(opts.fromName || 'The sender')}</b> says:<br>${esc(note)}</div>` : '';
        const html = mailer.notificationEmail({
          title, body: `${noteHtml}“${esc(name)}” is waiting for your approval.<br><br>${summaryHtml}<br><br><b>Preview${a.config.channel === 'sms' ? ' (SMS)' : ''}:</b>${content.html}Open it to approve, or send it back to draft.`,
          ctaText: 'Review & approve', ctaPath: path, preheader: `Approval needed: ${name}`, entityId: a.entityId,
        });
        mailer.send({ to: [...emails], subject: `Approval needed: ${name}`, html, kind: 'campaign-approval', entity: a.entityId }).catch(() => {});
      }
    }
  }

  // Tell the campaign's creator the outcome — approved (sending) or sent back to
  // draft (with the reviewer's comment). Inbox + push + email, skipping the
  // reviewer if they're also the sender.
  function notifySender(a, { approved, note = '', by = '' }) {
    const sender = (db.listUsers() || []).find((u) => u.email && a.createdBy && u.email.toLowerCase() === a.createdBy.toLowerCase());
    if (!sender || sender.email.toLowerCase() === (by || '').toLowerCase()) return;
    // Record the unseen outcome on the campaign — this drives a banner that
    // ALWAYS shows to the creator next time they load Pulse, independent of
    // whether push/email reached them.
    sql.prepare("UPDATE actions SET outcome=?, outcome_by=?, outcome_note=?, outcome_at=?, outcome_seen=0 WHERE id=?")
      .run(approved ? 'approved' : 'rejected', by || '', String(note || '').slice(0, 500), now(), a.id);
    const name = a.title || a.config.subject || 'Your campaign';
    const path = `/actions?action=${a.id}`;
    const link = `${mailer.baseUrl()}${path}`;
    const title = approved ? 'Campaign approved' : 'Campaign sent back to draft';
    const body = approved
      ? `“${name}” was approved${by ? ` by ${by}` : ''} and is now sending.`
      : `“${name}” was sent back to draft${by ? ` by ${by}` : ''}.${note ? `\n\nComment: ${note}` : ''}\n\nOpen it to make changes and resubmit:\n${link}`;
    try { os?.announce?.({ entityId: a.entityId, title, body, priority: approved ? 'fyi' : 'needs_reply', createdBy: 'campaigns@pulse', authorType: 'system', subjectType: 'campaign', subjectId: a.id }); } catch { /* os optional */ }
    if (push?.isEnabled?.()) push.sendToUser(sender.id, { title, body: approved ? `“${name}” was approved.` : `“${name}” was sent back to draft.`, url: path, tag: `outcome-${a.id}` }).catch(() => {});
    if (mailer?.isConfigured?.()) {
      const html = mailer.notificationEmail({
        title,
        body: approved
          ? `Good news — “${name}” was approved${by ? ` by ${by}` : ''} and is now sending.`
          : `“${name}” was sent back to draft${by ? ` by ${by}` : ''}.${note ? `<br><br><b>Comment:</b> ${esc(note)}` : ''}<br><br>Open it to make changes and resubmit.`,
        ctaText: 'Open campaign', ctaPath: path, preheader: title, entityId: a.entityId,
      });
      mailer.send({ to: sender.email, subject: `${title}: ${name}`, html, kind: 'campaign-approval', entity: a.entityId }).catch(() => {});
    }
  }

  return { howlerAdminsFor, awaitingApprovalFor, unseenOutcomesFor, campaignSummaryLines, notifyApprovers, notifySender };
};
