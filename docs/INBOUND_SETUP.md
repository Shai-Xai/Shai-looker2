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
Workers & Pages → **Create → Worker**. Replace the code with:

```js
import PostalMime from 'postal-mime';

export default {
  async email(message, env) {
    const buf = await new Response(message.raw).arrayBuffer();
    const email = await new PostalMime().parse(buf);
    const addrs = (list) => (list || []).map((a) => a.address).filter(Boolean);
    const payload = {
      from: email.from?.address || message.from,
      to: addrs(email.to),
      cc: addrs(email.cc),
      subject: email.subject || '',
      text: email.text || '',
      html: email.html || '',
      messageId: email.messageId || message.headers.get('message-id') || '',
    };
    await fetch(env.OWL_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-owl-secret': env.OWL_SECRET },
      body: JSON.stringify(payload),
    });
  },
};
```

- Add the dependency: in the Worker editor, `postal-mime` resolves automatically
  on deploy; if using Wrangler locally, `npm i postal-mime`.
- Worker → **Settings → Variables**: add
  - `OWL_WEBHOOK_URL` = the webhook URL from step 1
  - `OWL_SECRET` = the webhook secret from step 1  *(mark as encrypted)*
- **Deploy**.

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
