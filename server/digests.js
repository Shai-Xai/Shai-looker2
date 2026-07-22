// ─── Digests: delivery + history + feedback (the knowledge-base loop) ───────────
// Disposable routes-module. Owns the in-email feedback pages (/df/:token), the
// in-app digest archive + feedback routes, the preference-learning loop that
// distils feedback into each client's saved note, AND the scheduler mount that
// delivers recurring/one-off digests (wired with this module's history/feedback
// helpers + the injected content builder and role lenses). Remove the mount()
// line in index.js + this file (and server/scheduler.js) to uninstall. Lifted
// VERBATIM out of index.js — collaborators arrive as injected deps.
const { asyncHandler, allowInlineScripts } = require('./http'); // a rejected async handler must reach errorMiddleware, not hang the request
const crypto = require('crypto');

module.exports.mount = function mountDigests(app, { db, auth, mailer, messaging, push, insights, buildDigestContent, ROLE_LENSES, anthropicKeyForEntity, inboxView, notifyOps }) {
  // ─── Digest history + feedback (the knowledge-base loop) ─────────────────────
  function digestFbSecret() { let s = db.getSetting('digest_fb_secret', ''); if (!s) { s = crypto.randomBytes(18).toString('base64url'); db.setSetting('digest_fb_secret', s); } return s; }
  function signDigestToken(o) { const p = Buffer.from(JSON.stringify(o)).toString('base64url'); const sig = crypto.createHmac('sha256', digestFbSecret()).update(p).digest('base64url').slice(0, 16); return `${p}.${sig}`; }
  function parseDigestToken(tok) { const [p, sig] = String(tok || '').split('.'); if (!p || !sig) return null; const want = crypto.createHmac('sha256', digestFbSecret()).update(p).digest('base64url').slice(0, 16); if (sig !== want) return null; try { return JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; } }
  const digestFeedbackUrl = (digestId, email) => `${mailer.baseUrl()}/df/${signDigestToken({ d: digestId, e: (email || '').toLowerCase() })}`;
  const digestReplyTo = (entityId) => { try { return inboxView(entityId).address || null; } catch { return null; } };
  function recordDigestHistory(args) { try { return db.addDigestHistory(args); } catch (e) { console.error('[digest] history save failed', e.message); return ''; } }

  // Distil accumulated feedback (digest + briefing) → the per-client preferences note.
  const learningEntities = new Set();
  async function learnDigestPrefs(entityId) {
    if (!entityId || learningEntities.has(entityId)) return;
    learningEntities.add(entityId);
    try {
      const fb = db.listDigestFeedback(entityId, { limit: 200 });
      const briefFb = db.listBriefingFeedback().filter((f) => f.entityId === entityId && (f.comment || f.kind === 'dislike'));
      const items = [
        ...fb.map((f) => `[digest ${f.kind}] ${f.comment || (f.kind === 'up' ? '(liked)' : f.kind === 'down' ? '(disliked)' : '')}`.trim()),
        ...briefFb.map((f) => `[briefing ${f.kind}] ${(f.comment || '').trim()}`.trim()),
      ].filter((s) => s && !/^\[[a-z]+ [a-z]+\]$/i.test(s)).slice(0, 150);
      if (!items.length) return;
      const apiKey = anthropicKeyForEntity(entityId);
      if (!insights.isConfigured(apiKey)) return;
      const prev = db.getDigestPrefs(entityId).note || '';
      const note = await insights.distilPreferences({ items, previous: prev, apiKey });
      if (note) { db.setDigestPrefs(entityId, { note, fromCount: items.length }); db.markDigestFeedbackDistilled(entityId); }
    } catch (e) { console.error('[digest] learnDigestPrefs failed', e.message); }
    finally { learningEntities.delete(entityId); }
  }
  function maybeLearn(entityId) { try { if (db.listDigestFeedback(entityId, { onlyUndistilled: true, limit: 50 }).length >= 3) learnDigestPrefs(entityId); } catch { /* best-effort */ } }
  function saveDigestFeedback({ entityId, digestId, source, email, kind, comment }) {
    const id = db.addDigestFeedback({ entityId, digestId, source, email, kind, comment });
    maybeLearn(entityId);
    return id;
  }

  // In-email feedback page (signed token, no login needed).
  function digestFbPage(msg, token, digest) {
    const headline = digest ? String(digest.headline || digest.subject || '').replace(/</g, '&lt;') : '';
    return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Digest feedback</title></head>
  <body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f5f5f7;color:#1d1d1f;">
  <div style="max-width:520px;margin:0 auto;padding:40px 20px;">
    <div style="background:#fff;border:1px solid #e8e8ec;border-radius:16px;padding:26px;">
      <div style="font-size:18px;font-weight:800;margin-bottom:6px;">${msg}</div>
      ${headline ? `<div style="font-size:13px;color:#86868b;margin-bottom:16px;">On: ${headline}</div>` : ''}
      <label style="font-size:13px;font-weight:600;">Anything you'd add? (what you liked, what to change)</label>
      <textarea id="c" rows="5" style="width:100%;box-sizing:border-box;margin-top:8px;padding:11px;border:1.5px solid #e0e0e5;border-radius:10px;font-size:14px;font-family:inherit;"></textarea>
      <button id="b" style="margin-top:12px;background:#ff385c;color:#fff;border:none;border-radius:980px;padding:11px 22px;font-size:14px;font-weight:700;cursor:pointer;">Send feedback</button>
      <div id="d" style="font-size:13px;color:#1a8a4a;margin-top:12px;"></div>
    </div>
    <div style="font-size:12px;color:#a1a1a6;text-align:center;margin-top:14px;">Howler · Pulse — this helps tune your future digests.</div>
  </div>
  <script>
    var b=document.getElementById('b');
    b.onclick=function(){var c=document.getElementById('c').value.trim();if(!c){document.getElementById('d').textContent='Add a note first.';return;}b.disabled=true;
      fetch('/df/${token}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'comment',comment:c})})
      .then(function(){document.getElementById('d').textContent='Thanks — sent. You can close this tab.';document.getElementById('c').value='';})
      .catch(function(){document.getElementById('d').textContent='Could not send — please reply to the email instead.';b.disabled=false;});};
  </script></body></html>`;
  }
  app.get('/df/:token', (req, res) => {
    allowInlineScripts(res); // the feedback page carries its own inline submit script
    const t = parseDigestToken(req.params.token);
    if (!t || !t.d) return res.status(400).type('html').send(digestFbPage('That feedback link looks invalid or expired.', req.params.token, null));
    const d = db.getDigestHistory(t.d);
    const v = req.query.v;
    if (d && (v === 'up' || v === 'down')) saveDigestFeedback({ entityId: d.entityId, digestId: t.d, source: 'email', email: t.e || '', kind: v, comment: '' });
    const msg = v === 'up' ? 'Glad it landed 👍' : v === 'down' ? 'Noted — thanks 👎' : 'Thanks for the feedback';
    res.type('html').send(digestFbPage(msg, req.params.token, d));
  });
  app.post('/df/:token', (req, res) => {
    const t = parseDigestToken(req.params.token);
    if (!t || !t.d) return res.status(400).json({ error: 'bad token' });
    const d = db.getDigestHistory(t.d);
    const kind = ['up', 'down'].includes(req.body?.kind) ? req.body.kind : 'comment';
    saveDigestFeedback({ entityId: d?.entityId || '', digestId: t.d, source: 'email', email: t.e || '', kind, comment: String(req.body?.comment || '') });
    res.json({ ok: true });
  });

  // In-app digest archive + feedback. Entity-aware (works for an admin previewing a
  // client too) — distinct path so it never collides with the scheduler's
  // /api/my/digests/:entityId job routes.
  const canEntityReq = (req, entityId) => req.user.role === 'admin' || (req.user.entityIds || []).includes(entityId);
  app.get('/api/my/digest-history/:entityId', auth.requireAuth, (req, res) => {
    if (!canEntityReq(req, req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
    res.json({ digests: db.listDigestHistory(req.params.entityId, 60).map((d) => ({ id: d.id, role: d.roleLabel || d.role, subject: d.subject, headline: d.headline, createdAt: d.createdAt })) });
  });
  app.get('/api/my/digest-history/:entityId/:id', auth.requireAuth, (req, res) => {
    if (!canEntityReq(req, req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
    const d = db.getDigestHistory(req.params.id);
    if (!d || d.entityId !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    res.json({ ...d, feedback: db.feedbackForDigest(d.id) });
  });
  app.post('/api/my/digest-history/:entityId/:id/feedback', auth.requireAuth, (req, res) => {
    if (!canEntityReq(req, req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
    const d = db.getDigestHistory(req.params.id);
    if (!d || d.entityId !== req.params.entityId) return res.status(404).json({ error: 'Not found' });
    const kind = ['up', 'down'].includes(req.body?.kind) ? req.body.kind : 'comment';
    saveDigestFeedback({ entityId: req.params.entityId, digestId: d.id, source: 'inapp', email: req.user.email, kind, comment: String(req.body?.comment || '') });
    res.json({ ok: true });
  });
  // Edit a feedback comment (own comments; admins may edit any) — re-feeds the loop.
  app.put('/api/my/digest-history/:entityId/:id/feedback/:fbId', auth.requireAuth, (req, res) => {
    if (!canEntityReq(req, req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
    const row = db.getDigestFeedbackRow(req.params.fbId);
    if (!row || row.entityId !== req.params.entityId || row.digestId !== req.params.id) return res.status(404).json({ error: 'Not found' });
    if (req.user.role !== 'admin' && (row.email || '') !== (req.user.email || '').toLowerCase()) return res.status(403).json({ error: 'Not your comment' });
    db.updateDigestFeedback(req.params.fbId, String(req.body?.comment || ''));
    maybeLearn(req.params.entityId);
    res.json({ ok: true });
  });
  // Admin: review feedback + the learned preferences note (+ trigger a re-distil / edit).
  app.get('/api/admin/entities/:id/digest-feedback', auth.requireAdmin, (req, res) => {
    res.json({ feedback: db.listDigestFeedback(req.params.id, { limit: 200 }), prefs: db.getDigestPrefs(req.params.id) });
  });
  app.post('/api/admin/entities/:id/digest-learn', auth.requireAdmin, asyncHandler(async (req, res) => {
    await learnDigestPrefs(req.params.id);
    res.json({ prefs: db.getDigestPrefs(req.params.id) });
  }));
  app.put('/api/admin/entities/:id/digest-prefs', auth.requireAdmin, (req, res) => {
    db.setDigestPrefs(req.params.id, { note: String((req.body || {}).note || ''), fromCount: db.getDigestPrefs(req.params.id).fromCount || 0 });
    res.json({ prefs: db.getDigestPrefs(req.params.id) });
  });

  const sched = require('./scheduler').mount(app, { db, auth, mailer, messaging, push, generateContent: buildDigestContent, roleLenses: ROLE_LENSES, recordDigest: recordDigestHistory, feedbackUrl: digestFeedbackUrl, replyTo: digestReplyTo, notifyOps });
  return { whatsappDigestFor: sched && sched.whatsappDigestFor }; // for the WhatsApp Owl scheduler
};
