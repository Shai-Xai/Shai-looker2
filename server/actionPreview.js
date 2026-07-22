// Campaign preview + test-send routes — extracted from actions.js to keep it under
// its line budget. Renders a sample-recipient email/SMS preview, and fires a
// [TEST] copy to the addresses the sender chooses (their own address, teammates,
// or any external address — they need not be Pulse users). Factory: the render +
// audience helpers stay owned by the action engine and are injected.
//   require('./actionPreview')(app, { auth, guard, cleanConfig, renderFor, renderSmsFor, audienceFor, mailer, messaging })
const { EMAIL_RE } = require('./audienceMap');

module.exports = function actionPreview(app, { auth, guard, cleanConfig, renderFor, renderSmsFor, audienceFor, mailer, messaging }) {
  // Email preview (sample recipient) + test-send to chosen addresses.
  app.post('/api/actions/:entityId/preview-email', auth.requireAuth, auth.requirePermission('campaigns.approve'), (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const cfg = cleanConfig(req.body || {});
    const fake = { id: 'preview', entityId: req.params.entityId, config: cfg };
    // Use a real sample recipient (from the audience preview) when the client sends
    // one, so merge fields ({{Ticket Type}}, {{City}}…) render with actual values.
    const s = (req.body || {}).sample || {};
    const recipient = { email: s.email || 'sam@example.com', name: s.name || 'Sam', ticket: s.ticket || 'General Admission', phone: s.phone || '+27820000000', attributes: s.attributes || {} };
    // The client sends the active step's copy in cfg.body, so render from that
    // (step=null) — works for once-off and per-step sequence previews alike.
    // Return whichever channel(s) apply: email html, SMS text, or both.
    const out = {};
    if (cfg.channel !== 'sms') out.html = renderFor(fake, recipient).html;
    if (cfg.channel !== 'email') out.sms = renderSmsFor(fake, recipient, null);
    res.json(out);
  });
  app.post('/api/actions/:entityId/test-send', auth.requireAuth, auth.requirePermission('campaigns.approve'), async (req, res) => {
    if (!guard(req, res, req.params.entityId)) return;
    const cfg = cleanConfig(req.body || {});
    const fake = { id: 'test', entityId: req.params.entityId, config: cfg };
    // SMS test goes to a phone you enter; email test goes to chosen addresses.
    // For 'both', send whichever the test data supports and report each.
    const wantsEmail = cfg.channel !== 'sms';
    const wantsSms = cfg.channel !== 'email';
    const done = [];
    if (wantsSms) {
      const to = String((req.body || {}).testPhone || '').trim();
      if (!to) return res.status(400).json({ error: 'Enter a mobile number to test the SMS' });
      const text = renderSmsFor(fake, { email: req.user.email, name: 'Sam', ticket: 'General Admission', phone: to });
      const r = await messaging.sendSms({ to, text: `[TEST] ${text}` });
      if (!r.ok) return res.status(400).json({ error: r.error || r.reason || 'SMS not configured' });
      done.push(to);
    }
    if (wantsEmail) {
      // Recipients: any addresses the sender typed — teammates or external (need
      // not be Pulse users; commas/spaces/array). Empty → the sender's own address.
      const raw = (req.body || {}).testEmails;
      const parts = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,;]+/);
      const seen = new Set(); const recipients = [];
      for (const p of parts) {
        const e = String(p || '').trim();
        if (!e) continue;
        if (!EMAIL_RE.test(e)) return res.status(400).json({ error: `Not a valid email address: ${e}` });
        const k = e.toLowerCase(); if (!seen.has(k)) { seen.add(k); recipients.push(e); }
      }
      if (!recipients.length) recipients.push(req.user.email);
      if (recipients.length > 20) return res.status(400).json({ error: 'Test send is capped at 20 recipients at a time' });
      // Personalise the test with a REAL sample recipient so merge fields render.
      let sample = null;
      try { const { list } = await audienceFor(req.params.entityId, cfg, req.user); sample = (list || [])[0] || null; } catch { /* best effort */ }
      const sampleFields = { name: sample?.name || 'Sam Sample', ticket: sample?.ticket || 'General Admission', attributes: sample?.attributes || {} };
      const branding = mailer.resolveBranding(req.params.entityId, fake.config?.eventSuiteId || '');
      for (const to of recipients) { // render per recipient → own unsubscribe/link token
        const { html, text, subject } = renderFor(fake, { email: to, ...sampleFields });
        const r = await mailer.send({ to, subject: `[TEST] ${subject || 'Campaign'}`, html, text, fromName: branding.senderName, kind: 'test', entity: req.params.entityId });
        if (!r.ok) return res.status(400).json({ error: r.error || r.reason || 'email not configured' });
        done.push(to);
      }
    }
    res.json({ ok: true, to: done.join(' & ') });
  });
};
