# CC-the-Owl — inbound email setup

Pulse captures emails into a client's inbox when their **Owl address** is CC'd (or
mail is forwarded to it). The app exposes one secret-protected webhook; any mail
service that can POST JSON to it works. Recommended: **Cloudflare Email Routing +
an Email Worker** (free, full control, and the domain is already on Cloudflare).

The flow:

```
someone emails/CCs  →  Cloudflare receives (MX)  →  Email Worker parses MIME
                    →  POST /api/inbound/email (x-owl-secret)  →  threads into the inbox
```

## 1. Pulse side (2 min)
Admin → **Integrations → Inbound email — CC the Owl**:
- **Inbound domain**: the domain you'll receive on, e.g. `howler-pulse.com`
  (Owl addresses become `token@howler-pulse.com`). Save.
- **Copy** the **Webhook URL** (e.g. `https://howler-pulse-v2.onrender.com/api/inbound/email`)
  and the **Webhook secret** — you'll paste both into the Worker below.

Each client's address is shown in Admin → *client* → **Messages** ("CC the Owl"),
and to the client in their **Settings → Integrations & branding**.

## 2. Cloudflare — enable Email Routing
Dashboard → your domain → **Email → Email Routing → Get started**. Accept the
**MX + SPF** records it adds (one click). This lets the domain receive mail.

## 3. Cloudflare — the Email Worker
Email Routing → **Email Workers → Create** (or Workers & Pages → Create →
Worker). Name it `owl-inbound`, pick **"Create my own"**, and use the
ZERO-DEPENDENCY version below — the dashboard editor can't install npm
packages, so this parses the MIME inline:

```js
export default {
  async email(message, env, ctx) {
    const raw = await new Response(message.raw).text();
    const cut = raw.search(/\r?\n\r?\n/);
    const headerBlock = cut === -1 ? raw : raw.slice(0, cut);
    let body = cut === -1 ? '' : raw.slice(cut).trim();

    // Unfold + parse headers
    const headers = {};
    let cur = '';
    const push = () => {
      const m = cur.match(/^([^:]+):\s*([\s\S]*)$/);
      if (m) { const k = m[1].toLowerCase(); headers[k] = headers[k] ? headers[k] + ', ' + m[2] : m[2]; }
    };
    for (const ln of headerBlock.split(/\r?\n/)) {
      if (/^\s/.test(ln) && cur) cur += ' ' + ln.trim();
      else { if (cur) push(); cur = ln; }
    }
    if (cur) push();

    // Best-effort text body: first text/plain (else text/html) part of a multipart
    let text = body;
    const bm = (headers['content-type'] || '').match(/boundary="?([^";]+)"?/i);
    if (bm) {
      const parts = body.split('--' + bm[1]);
      const pick = parts.find(p => /content-type:\s*text\/plain/i.test(p))
        || parts.find(p => /content-type:\s*text\/html/i.test(p)) || '';
      const pi = pick.search(/\r?\n\r?\n/);
      text = pi === -1 ? pick : pick.slice(pi).trim();
      if (/quoted-printable/i.test(pick)) {
        text = text.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
      } else if (/base64/i.test(pick)) {
        try { text = atob(text.replace(/\s+/g, '')); } catch {}
      }
    }

    const addrs = (v) => (v || '').split(',')
      .map(s => { const m = s.match(/<([^>]+)>/); return (m ? m[1] : s).trim(); })
      .filter(s => s.includes('@'));

    await fetch(env.OWL_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-owl-secret': env.OWL_SECRET },
      body: JSON.stringify({
        from: message.from,
        to: [...new Set([message.to, ...addrs(headers['to'])])], // envelope recipient first — catches BCC'd owl addresses
        cc: addrs(headers['cc']),
        subject: headers['subject'] || '',
        text: text.slice(0, 15000),
        html: '',
        messageId: headers['message-id'] || '',
      }),
    });
  },
};
```

(If deploying via Wrangler locally instead, the `postal-mime` version in git
history also works — `npm i postal-mime` first.)

- Worker → **Settings → Variables and Secrets**: add
  - `OWL_WEBHOOK_URL` = the webhook URL from step 1
  - `OWL_SECRET` = the webhook secret from step 1  *(mark as encrypted)*
- **Deploy** again so the variables take effect.

## 4. Route mail to the Worker
Email Routing → **Routing rules → Catch-all** → action **Send to a Worker** →
pick the Worker → Save. (Catch-all forwards every address on the domain; Pulse
ignores any that don't match a known client token, returning `202`.)

## 5. Test
- Send (or CC) an email to a client's Owl address.
- It should appear in that client's Pulse inbox within seconds, as an
  `email`-channel message, threaded by subject. `Re:`/`Fwd:` replies append to
  the same thread; duplicate Message-IDs are de-duped.
- Nothing arriving? Worker → **Logs** shows each invocation; a `401` means the
  secret is wrong, `202` means the address didn't match a client token.

## Notes
- **Attachments/images are not captured yet** — only the message body. Adding
  them needs object storage (Cloudflare R2 recommended) + an attachments table;
  deferred by choice.
- **Security**: the webhook only accepts POSTs carrying the correct
  `x-owl-secret`. Rotate it any time (Admin → Integrations → Rotate); update the
  Worker's `OWL_SECRET` to match.
- **Other transports**: SendGrid Inbound Parse or Resend inbound work too — they
  just need to POST the same JSON shape with the `x-owl-secret` header.
