// ─── Resend webhooks: bounces & spam complaints — disposable module ───────────
// All clients send from ONE verified Resend domain, so one client re-mailing a
// dead list burns deliverability for everyone. This endpoint receives Resend's
// delivery events and turns the two reputation-critical ones into GLOBAL
// suppressions (mailer.js enforces them on every send):
//   email.bounced    → suppressed for ALL mail (the address is dead)
//   email.complained → suppressed for marketing kinds (they flagged us as spam)
//
// Setup (Resend → Webhooks → Add endpoint):
//   URL:    https://<pulse>/api/webhooks/resend
//   Events: email.bounced, email.complained
//   Secret: paste the signing secret (whsec_…) into Admin → Integrations →
//           Email, or set RESEND_WEBHOOK_SECRET. Write-only, like every secret.
//
// Signatures are svix-style (Resend uses Svix): HMAC-SHA256 over
// "<svix-id>.<svix-timestamp>.<raw body>" with the base64 secret, compared
// constant-time against each "v1,<sig>" entry. Fail closed: no secret
// configured → 503; bad signature/timestamp → 401. The route parses its own
// RAW body (index.js exempts it from the global JSON parser) — signature
// verification needs the exact bytes.

const crypto = require('crypto');

const TOLERANCE_S = 5 * 60; // reject events older/newer than ±5 min (replay guard)

function mount(app, { db, auth, mailer, notifyOps }) {
  const secret = () => (db.getSetting('resend_webhook_secret', '') || process.env.RESEND_WEBHOOK_SECRET || '').trim();

  const readRaw = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 256 * 1024) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  const verify = (raw, headers) => {
    const s = secret();
    if (!s) return { ok: false, status: 503, error: 'webhook secret not configured' };
    const id = String(headers['svix-id'] || '');
    const ts = String(headers['svix-timestamp'] || '');
    const sigs = String(headers['svix-signature'] || '');
    if (!id || !ts || !sigs) return { ok: false, status: 401, error: 'missing signature headers' };
    if (Math.abs(Date.now() / 1000 - Number(ts)) > TOLERANCE_S) return { ok: false, status: 401, error: 'timestamp outside tolerance' };
    let key;
    try { key = Buffer.from(s.replace(/^whsec_/, ''), 'base64'); } catch { return { ok: false, status: 503, error: 'bad secret' }; }
    const want = crypto.createHmac('sha256', key).update(`${id}.${ts}.`).update(raw).digest('base64');
    const wantBuf = Buffer.from(want);
    for (const part of sigs.split(/\s+/)) {
      const [, sig] = part.split(','); // "v1,<base64>"
      if (!sig) continue;
      try { if (crypto.timingSafeEqual(wantBuf, Buffer.from(sig))) return { ok: true }; } catch { /* length mismatch — keep trying */ }
    }
    return { ok: false, status: 401, error: 'signature mismatch' };
  };

  app.post('/api/webhooks/resend', async (req, res) => {
    try {
      const raw = await readRaw(req);
      const v = verify(raw, req.headers);
      if (!v.ok) return res.status(v.status).json({ error: v.error });
      let event;
      try { event = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'invalid JSON' }); }
      const type = String(event?.type || '');
      if (type === 'email.bounced' || type === 'email.complained') {
        const reason = type === 'email.bounced' ? 'bounced' : 'complained';
        const detail = String(event?.data?.bounce?.message || event?.data?.subject || '').slice(0, 200);
        const recipients = Array.isArray(event?.data?.to) ? event.data.to : [event?.data?.to].filter(Boolean);
        for (const r of recipients) mailer.addSuppression(r, reason, detail);
        console.log(`[mailWebhooks] ${reason}: ${recipients.join(', ')}${detail ? ` (${detail})` : ''}`);
        // A complaint is a reputation event a human should glance at.
        if (reason === 'complained' && notifyOps) try { notifyOps(`Spam complaint from ${recipients.join(', ')} — check the campaign that reached them`); } catch { /* never fail the ack */ }
      }
      res.json({ ok: true }); // ack everything we verified — unknown types are fine
    } catch (e) {
      console.error('[mailWebhooks] error:', e.message);
      res.status(400).json({ error: 'webhook error' });
    }
  });

  // Admin: see and manage the global suppression list (e.g. un-suppress an
  // address after its owner fixed a full mailbox).
  app.get('/api/admin/mail-suppressions', auth.requireAdmin, (_req, res) => res.json({ suppressions: mailer.listSuppressions() }));
  app.delete('/api/admin/mail-suppressions/:email', auth.requireAdmin, (req, res) => res.json({ ok: mailer.removeSuppression(req.params.email) }));

  console.log('[mailWebhooks] Resend webhook mounted', secret() ? '(secret set)' : '(NO secret — endpoint returns 503 until configured)');
}

module.exports = { mount };
