// ─── Campaign tracking routes — extracted from actions.js ─────────────────────
// The PUBLIC (no-auth) endpoints stamped into every campaign email/SMS: the open
// pixel (/o), the tracked click redirect (/c), the SMS short link (/k) and the
// unsubscribe page (/u). These are the hottest paths in the campaign engine — a
// blast to N recipients produces a burst of N+ hits within minutes of sending —
// so they are deliberately cheap:
//
//   • The token lookup rides idx_actions_click_token (an expression index on
//     json_extract(config,'$.clickToken'), created in actions.js's migration) —
//     a point lookup, never a table scan.
//   • The audience blob (potentially tens of MB of JSON for a big audience) is
//     NEVER selected or parsed here — only id/config/results.
//
// Factory: require('./actionTracking').mount(app, { sql, now, saveResults,
// parseUnsubToken, canonicalContact }). Owns no tables — writes to actions.js's
// action_opens / action_clicks / action_suppressions / action_short_links.

function mount(app, { sql, now, saveResults, parseUnsubToken, canonicalContact }) {
  // Only what the tracking paths need — no SELECT *, no audience.
  const trackedAction = (token) => {
    const r = sql.prepare(`SELECT id, config, results FROM actions WHERE json_extract(config,'$.clickToken')=?`).get(String(token || ''));
    return r ? { id: r.id, config: JSON.parse(r.config || '{}'), results: JSON.parse(r.results || '{}') } : null;
  };

  // Open-tracking pixel: records an email open (attributed when the recipient
  // token is present) then returns a 1x1 GIF. Never blocks the pixel.
  const OPEN_PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  app.get('/o/:token/:rtok?/:step?', (req, res) => {
    try {
      const a = trackedAction(req.params.token);
      if (a) {
        const who = req.params.rtok ? parseUnsubToken(req.params.rtok) : null;
        const step = Number.isInteger(Number(req.params.step)) ? Number(req.params.step) : -1;
        sql.prepare('INSERT INTO action_opens (action_id, email, at, step) VALUES (?,?,?,?)').run(a.id, who?.e ? String(who.e).toLowerCase() : '', now(), step);
        saveResults(a.id, { ...a.results, opens: (a.results.opens || 0) + 1, lastOpenAt: now() });
      }
    } catch { /* never block the pixel */ }
    res.set('Content-Type', 'image/gif');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.end(OPEN_PIXEL);
  });

  // Tracked CTA click → count + redirect, appending the campaign's UTMs to the
  // destination (existing query keys win).
  app.get('/c/:token/:rtok?/:ch?/:step?', (req, res) => {
    const a = trackedAction(req.params.token);
    if (!a) return res.redirect('/');
    // Attribute the click when the link carries a valid recipient token, and the
    // channel from the link suffix (/e = email, /s = sms), and the drip step index.
    const who = req.params.rtok ? parseUnsubToken(req.params.rtok) : null;
    const channel = req.params.ch === 'e' ? 'email' : req.params.ch === 's' ? 'sms' : '';
    const step = Number.isInteger(Number(req.params.step)) ? Number(req.params.step) : -1;
    try { sql.prepare('INSERT INTO action_clicks (action_id, email, at, channel, step) VALUES (?,?,?,?,?)').run(a.id, who?.e ? String(who.e).toLowerCase() : '', now(), channel, step); } catch { /* never block the redirect */ }
    // Bump total + per-channel counters in results so rollups (list/master) get
    // per-channel clicks cheaply without re-querying action_clicks.
    const results = { ...a.results, clicks: (a.results.clicks || 0) + 1, lastClickAt: now() };
    if (channel === 'email') results.emailClicks = (a.results.emailClicks || 0) + 1;
    else if (channel === 'sms') results.smsClicks = (a.results.smsClicks || 0) + 1;
    saveResults(a.id, results);
    // Per-link tracking (custom HTML): ?k=<code> names this specific link's
    // destination (stored server-side). Falls back to the campaign's buy link.
    let dest = a.config.ctaUrl || '/';
    if (req.query.k) {
      try { const row = sql.prepare('SELECT target FROM action_short_links WHERE code=?').get(String(req.query.k)); if (row?.target) dest = row.target; } catch { /* fall back to ctaUrl */ }
    }
    const promo = req.query.promo ? String(req.query.promo) : ''; // promo code rides the tracked link → forward to the destination
    try {
      const u = new URL(dest);
      // Promo goes on FIRST (right after the Howler link), THEN the UTM params.
      if (promo && !u.searchParams.has('promo')) u.searchParams.set('promo', promo);
      const utm = a.config.utm || {};
      for (const [k, v] of Object.entries({ utm_source: utm.source, utm_medium: utm.medium, utm_campaign: utm.campaign, utm_term: utm.term, utm_content: utm.content })) {
        if (v && !u.searchParams.has(k)) u.searchParams.set(k, v);
      }
      dest = u.toString();
    } catch {
      // relative or odd URL — still carry the promo code through if present.
      if (promo && !/[?&]promo=/.test(dest)) dest += (dest.includes('?') ? '&' : '?') + 'promo=' + encodeURIComponent(promo);
    }
    res.redirect(dest);
  });

  // Short-link redirect (SMS) → the real tracked /c/ or opt-out /u/ URL (which then records/redirects).
  app.get('/k/:code', (req, res) => {
    try {
      const row = sql.prepare('SELECT target FROM action_short_links WHERE code=?').get(req.params.code);
      if (row?.target) return res.redirect(row.target);
    } catch { /* fall through to home */ }
    res.redirect('/');
  });

  // Unsubscribe → suppression list + tiny confirmation page. The token's contact
  // may be an email OR a phone (SMS opt-out for phone-only recipients) — stored
  // canonicalised (email lowercased / phone normalised) so send-time suppression
  // checks match it whatever format the next audience carries the contact in.
  const suppress = (token) => {
    const t = parseUnsubToken(token);
    if (t) {
      sql.prepare('INSERT OR REPLACE INTO action_suppressions (entity_id, email, at, reason) VALUES (?,?,?,?)')
        .run(t.n, canonicalContact ? canonicalContact(t.e) : String(t.e).toLowerCase(), now(), 'unsubscribed');
    }
    return t;
  };
  // RFC 8058 one-click unsubscribe: Gmail/Yahoo POST to the List-Unsubscribe URL
  // (set by mailer.send for campaign mail). No page — just do it and say 200.
  app.post('/u/:token', (req, res) => { suppress(req.params.token); res.json({ ok: true }); });
  app.get('/u/:token', (req, res) => {
    const t = suppress(req.params.token);
    res.set('Content-Type', 'text/html').send(`<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f5f7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;">
      <div style="background:#fff;border:1px solid #e8e8ec;border-radius:14px;padding:32px 36px;text-align:center;max-width:420px;">
        <div style="font-size:26px;margin-bottom:10px;">${t ? '✓' : '⚠'}</div>
        <div style="font-size:16px;font-weight:700;color:#111;margin-bottom:6px;">${t ? "You're unsubscribed" : 'Invalid link'}</div>
        <div style="font-size:13.5px;color:#6e6e73;line-height:1.5;">${t ? 'You will no longer receive campaign emails or SMS from this event organiser.' : 'This unsubscribe link is not valid.'}</div>
      </div></body></html>`);
  });
}

module.exports = { mount };
