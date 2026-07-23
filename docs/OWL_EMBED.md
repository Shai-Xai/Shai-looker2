# Embedding the Owl in the Howler organizer portal

**Status: pilot.** The Owl — Pulse's AI data analyst — can be embedded inside the
Howler organizer portal so organizers ask questions about their own ticketing
data without ever leaving the portal. It's the Inventive pattern, inverted:
this time **Pulse is the guest and the portal is the host**.

Server module: `server/owlEmbed.js` · Embed page: `client/src/pages/OwlEmbedPage.jsx`
· Admin config: **Pulse Admin → AI → Organizer portal Owl (pilot)**.

## How it works (one diagram)

```
Organizer's browser                Portal backend                    Pulse
────────────────────               ──────────────                    ─────
opens "Ask the Owl"  ───────────▶  POST /api/embed/owl/session ────▶ verify shared secret
                                   { orgId, email, name }            map org → Pulse client
                                                                     JIT shadow login (client-scoped)
                     ◀───────────  { url }  ◀─────────────────────── short-lived token (2h)
renders <iframe src=url>
   └── iframe = Pulse's /embed/owl page; every API call carries the token
       (Authorization header — no cookies, so no third-party-cookie issues)
       and the Owl answers ONLY that client's data (the same applyScope gate
       as every Pulse dashboard tile).
```

## Setup (Howler side, once)

1. In **Pulse Admin → AI → Organizer portal Owl (pilot)**:
   - set a strong **shared secret** (give it to the portal team; it's write-only after saving),
   - add **organization → client links**: the Howler organization id ↔ the Pulse
     client (entity) whose data that org should see,
   - tick **Enable** and save.
2. Only linked organizations can get a session — everyone else gets a 404. Until
   the Howler→Pulse data integration lands, that means the pilot serves the orgs
   that already exist as Pulse clients; when ingestion ships, links can be
   created automatically per org and this contract stays identical.

## Portal integration (portal team)

### 1. Mint a session (server-to-server — never from the browser)

When a logged-in organizer opens the Owl panel, the **portal backend** calls:

```
POST https://<pulse-host>/api/embed/owl/session
Authorization: Bearer <shared secret>
Content-Type: application/json

{
  "orgId": "<howler organization id>",
  "email": "jane@festco.com",       // the organizer's email (their identity in Pulse)
  "firstName": "Jane",              // optional, used on first provision
  "lastName": "Doe"                 // optional
}
```

Response `200`:

```json
{
  "token": "…",
  "url": "https://<pulse-host>/embed/owl#token=…",
  "expiresIn": 7200,
  "entity": { "id": "…", "name": "FestCo" },
  "user": { "id": "…", "email": "jane@festco.com" }
}
```

Errors: `401` bad/missing secret · `403` embed switched off · `404` org not
linked · `409` the email belongs to a different Pulse account (an admin/staff
login, or a client of another entity — ask Howler to resolve) · `400` bad input.

Notes:
- The token lives in the **URL fragment** (`#token=`), which browsers never send
  to servers — it stays out of access logs. Don't log the URL on your side either.
- Tokens last **2 hours**. Mint a fresh one each time the panel opens; there is
  no refresh endpoint (just call session again).
- The first call for a new organizer **auto-creates their Pulse login** (a
  "shadow" account with an unusable password — the portal is its only door).
  Their chats, saved threads and Owl memory are theirs across sessions.

### 2. Embed the iframe

```html
<iframe
  src="<the url from the session response>"
  style="width:100%;height:100%;border:0"
  allow="clipboard-write"
  title="Ask the Owl"
></iframe>
```

That's it — no postMessage handshake needed. The page is fully self-contained
(chat, saved threads, event picker, charts, follow-up chips). It's built
mobile-first: a full-width panel, a slide-over on small screens, so it works in
a drawer, a modal, or a full page.

### Recommended UX

- Put it behind an "Ask the Owl 🦉" button/panel in the org's dashboard area.
- Size the container like a chat panel (e.g. right-hand drawer on desktop,
  full-screen sheet on mobile).
- On open, mint a fresh session server-side and set the iframe `src`. If the
  iframe shows the "session expired" note, mint again and reload the `src`.

## Security model (for reviewers)

- **The shared secret only mints sessions for linked orgs.** An unlinked org id
  yields nothing; links are admin-managed in Pulse.
- **Sessions can't widen an existing account.** Emails belonging to admins/staff
  or to a different client are refused (409) — the portal cannot impersonate
  privileged Pulse users.
- **The token is a 2-hour JWT for one entity-pinned client user.** The hard data
  boundary is the same `applyScope` organiser lock every Pulse tile uses; the
  Owl's tools cannot reach another client's data regardless of prompt content.
- **No cookies, no CORS widening.** The iframe content is served by Pulse, so
  all its API calls are same-origin; the token rides an Authorization header
  (`auth.attachUser` accepts only embed-claim JWTs Pulse itself signed).
- Session minting is rate-limited per IP; the secret is stored write-only and
  compared in constant time.

## Roadmap hooks

- When the **Howler→Pulse integration** ships, auto-create the entity + link per
  Howler org at ingestion time — the handshake and iframe stay unchanged, the
  pilot just widens to every self-service organizer.
- Per-org enable/disable, usage reporting and portal-side theming can layer on
  the same session endpoint (add fields to the response, not a new flow).
