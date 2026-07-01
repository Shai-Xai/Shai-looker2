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
Worker). Name it `owl-inbound`, pick **"Create my own"**, and use the ZERO-DEPENDENCY
version below — the dashboard editor can't install npm packages, so this parses
the MIME inline, **including base64 attachments** (settlement / invoice PDFs, now
used by the Owl's auto-ingest):

```js
export default {
  async email(message, env, ctx) {
    const raw = await new Response(message.raw).text();
    const cut = raw.search(/\r?\n\r?\n/);
    const headerBlock = cut === -1 ? raw : raw.slice(0, cut);
    const body = cut === -1 ? '' : raw.slice(cut).trim();

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

    const boundary = (headers['content-type'] || '').match(/boundary="?([^";]+)"?/i)?.[1];
    const parts = boundary ? body.split('--' + boundary) : [];
    const bodyOf = (part) => { const i = part.search(/\r?\n\r?\n/); return i === -1 ? '' : part.slice(i).trim(); };

    // Best-effort text body: first text/plain (else text/html) part of a multipart
    let text = body;
    if (parts.length) {
      const pick = parts.find(p => /content-type:\s*text\/plain/i.test(p))
        || parts.find(p => /content-type:\s*text\/html/i.test(p)) || '';
      text = bodyOf(pick);
      if (/quoted-printable/i.test(pick)) text = text.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
      else if (/base64/i.test(pick)) { try { text = atob(text.replace(/\s+/g, '')); } catch {} }
    }

    // Attachments: base64 parts carrying a filename / attachment disposition.
    // Caps mirror the server (≤10 files, ~25MB each); bigger files are dropped.
    const MAX_FILES = 10, MAX_B64 = 34 * 1024 * 1024;
    const attachments = [];
    for (const p of parts) {
      const bi = p.search(/\r?\n\r?\n/);
      const head = bi === -1 ? p : p.slice(0, bi);
      const fn = head.match(/(?:file)?name\*?=(?:"([^"]+)"|([^;\r\n]+))/i);
      if (!(/content-disposition:\s*attachment/i.test(head) || fn)) continue;
      if (!/content-transfer-encoding:\s*base64/i.test(head)) continue;
      const data = bodyOf(p).replace(/\s+/g, '');
      if (!data || data.length > MAX_B64) continue;
      attachments.push({
        name: ((fn && (fn[1] || fn[2])) || 'file').trim(),
        mime: (head.match(/content-type:\s*([^;\r\n]+)/i)?.[1] || 'application/octet-stream').trim(),
        data,
      });
      if (attachments.length >= MAX_FILES) break;
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
        attachments,
      }),
    });
  },
};
```

*Prefer a real MIME parser?* Deploying via **Wrangler** (`npm i postal-mime`) lets
you use `PostalMime.parse(message.raw)` + `email.attachments` instead — more robust
for unusual encodings, but it can't be pasted into the dashboard. The inline version
above is fine for Howler's own mailer.

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
- **Attachments are captured** (with the `postal-mime` Worker above) — up to 10
  files, 25MB each, stored on the data disk and shown on the message in the inbox.
  PDFs also feed the Owl's settlement/invoice auto-ingest. (The older zero-dep
  Worker forwards body text only.)
- **Security**: the webhook only accepts POSTs carrying the correct
  `x-owl-secret`. Rotate it any time (Admin → Integrations → Rotate); update the
  Worker's `OWL_SECRET` to match.
- **Other transports**: SendGrid Inbound Parse or Resend inbound work too — they
  just need to POST the same JSON shape with the `x-owl-secret` header.
