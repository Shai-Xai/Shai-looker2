# Pulse API — client guide

Connect your own tools — or an AI assistant — to your Pulse data. This guide is
for you (the client) and the people who build things for you. No Pulse
internals knowledge needed.

> **What you can do with it**
> - Pull your live numbers (ticket sales, revenue, campaign results) into your
>   own spreadsheets, dashboards or systems — no more exports and screenshots.
> - Point an AI assistant (like Claude) at your Pulse and ask questions in
>   plain language: *"How are VIP sales tracking against the goal?"*
> - Optionally, pull the detailed records behind a dashboard table (e.g. your
>   ticket-buyer list) into your own CRM or data warehouse.

---

## 1. Getting access

1. **Ask your Howler contact to switch on API access** for your account. It's
   off by default and enabled per client, deliberately.
2. In Pulse, go to **Settings → Integrations** and find the
   **🔌 API access & AI agents** card.
3. Give your key a name that says what it's for (e.g. *"Finance spreadsheet"*
   or *"Claude assistant"*) and press **+ New read-only key**.
4. **Copy the key immediately.** It looks like `pulse_sk_…` and is shown only
   this once. If you lose it, revoke it and make a new one — nobody can look it
   up for you, not even Howler.

Treat the key like a password: don't email it around, don't put it in
documents, and give each tool its **own** key so you can switch one off without
breaking the others.

> **Who can manage keys?** Anyone on your team whose Pulse role includes
> *managing integrations* (your account Owner always can). Your Howler account
> manager can also create and revoke keys for you.

## 2. The two ways to connect

Your Pulse address is the same one you use in the browser — shown as
`https://your-pulse-domain` below. The key card shows your exact URLs.

### A. For your own systems — the REST API

Your developer (or any tool that can call a web API) sends the key with each
request:

```
GET https://your-pulse-domain/api/v1/me
Authorization: Bearer pulse_sk_…
```

What's available:

| Ask for | You get |
| --- | --- |
| `/api/v1/me` | Your account name, your events, what this key may do |
| `/api/v1/dashboards` | Your dashboards, per event |
| `/api/v1/dashboards/{id}` | One dashboard's tiles — the ids you need for metrics |
| `/api/v1/metric?dashboardId=…&tileId=…` | The live number a KPI tile shows right now |
| `/api/v1/segments` | Your saved audiences with size + email/SMS reach |
| `/api/v1/segments/{id}/reach` | One segment re-counted live |
| `/api/v1/campaigns` | Your campaigns with sent / clicks / opens / CTR |
| `/api/v1/campaigns/{id}` | One campaign's results |
| `/api/v1/goals?suiteId=…&progress=1` | Your goals for an event, with live progress |
| `/api/v1/data-sources` | What you can query directly — measures, group-bys, filters |
| `POST /api/v1/query` | Ask for any curated number with your own breakdown/filters/dates — no dashboard needed |
| `/api/v1/tiles/rows?dashboardId=…&tileId=…` | *Row-level keys only* — the table behind a tile |

Everything comes back as JSON. A typical first call:

```bash
curl -H "Authorization: Bearer pulse_sk_…" https://your-pulse-domain/api/v1/me
```

### B. For AI assistants — the MCP connection

Connecting an AI assistant puts **the Owl** — Pulse's data analyst — in your
assistant: ask questions in plain language, get answers grounded in your live
data. Pulse speaks **MCP** (Model Context Protocol), the standard AI
assistants use to work with tools. To connect Claude:

1. Make sure you're **logged into Pulse** in your browser.
2. In Claude, add a **custom connector** (Settings → Connectors). Name it
   **The Owl 🦉** (that's who you'll be talking to), URL
   `https://your-pulse-domain/mcp`. Leave any *OAuth Client ID* /
   *Client Secret* fields **blank** — Claude registers itself automatically.
3. Click **Connect**. A Pulse approval page opens: pick **which client** to
   connect and (optionally) whether to allow row-level data, then press
   **Approve & connect**.

That's it — no keys to copy. Behind the scenes Pulse creates a named API key
for the connection; you'll see it (e.g. *"Claude (connected 2026-07-01)"*) in
Settings → Integrations, and revoking it there disconnects Claude instantly.

Claude now speaks as the Owl, with tools like *list dashboards*, *get metric*
and *query data*. Good first prompt: *"Owl, give me a snapshot of how my next
event is selling."* Others to try: *"revenue by ticket type, last 30 days"* ·
*"how big is my VIP segment?"* · *"are my goals on pace?"*

> **Developer note:** tools that take a plain Bearer header (scripts, some MCP
> clients) can still just send `Authorization: Bearer pulse_sk_…` — the OAuth
> flow is optional sugar on top of the same keys.

The assistant can only ever **look things up** — it can't send campaigns,
change settings or spend money on your behalf.

#### ChatGPT (and other OpenAI tools)

Pulse works with OpenAI too — it's the same MCP connection:

- **ChatGPT:** with a Plus/Pro/Business/Enterprise plan, turn on **Developer
  mode** (Settings → Connectors), add a custom connector pointing at
  `https://your-pulse-domain/mcp`, and approve on the Pulse page exactly like
  Claude. Pulse also exposes the standard `search` and `fetch` tools ChatGPT
  needs, so it works for Deep Research and "company knowledge" style questions.
- **OpenAI Responses API (developers):** point the built-in MCP tool at the
  same URL with your key as a Bearer header — no extra setup:

  ```python
  client.responses.create(
    model="gpt-5",
    tools=[{"type": "mcp", "server_label": "pulse",
            "server_url": "https://your-pulse-domain/mcp",
            "headers": {"Authorization": "Bearer pulse_sk_…"},
            "require_approval": "never"}],
    input="How is my next event selling?")
  ```

## 3. Row-level data (optional)

By default, keys read **numbers only** — counts, totals, rates. No personal
data of your customers is reachable.

If you need the actual records (e.g. pull your ticket-buyer table into your
CRM), tick **"Also allow row-level data"** when creating a key. That key can
then fetch the full table behind any tile on your dashboards — every column,
up to 10,000 rows per request.

**Please note:** those rows are your customers' personal data. You're
responsible for using it lawfully (POPIA/GDPR) — only grant row-level keys to
systems that genuinely need them, and revoke them when a project ends. Every
pull is logged.

## 4. Fair use & safety

- **Limits:** around 120 requests per minute per key (20/min for the heavier
  live lookups). If you hit the limit you'll get a `429 — slow down` response;
  just retry a little later.
- **Your data only:** a key is locked to your account. It cannot see any other
  Howler client's data, full stop.
- **Audit trail:** every call made with your keys is logged — you or Howler
  can always see what a connected tool has been doing.
- **Instant off-switch:** revoke a key in Settings → Integrations and it stops
  working immediately. Howler can also switch off API access for your whole
  account in one move.

## 5. If something doesn't work

| You see | It means | Do this |
| --- | --- | --- |
| `401` | Missing, mistyped or revoked key | Check the `Authorization: Bearer …` header; make a new key if needed |
| `403 — switched off` | API access isn't enabled for your account | Ask your Howler contact |
| `403 — scope` | The key doesn't have that permission (e.g. row-level) | Create a key with the right option ticked |
| `404` | That dashboard/tile/segment isn't in your account | Check the id via `/api/v1/dashboards` |
| `429` | Too many requests | Wait for the number of seconds in `Retry-After`, then retry |
| Claude's Connect button loops or fails | You're not logged into Pulse in that browser, or API access is off | Log into Pulse first, then Connect again; if the approval page says access is off, ask Howler |

Still stuck? Your Howler contact can see the audit log and help you debug.

---

*Questions or a use case we don't cover yet (writes, webhooks, more data)?
Tell your Howler contact — the API grows based on what clients need.*
