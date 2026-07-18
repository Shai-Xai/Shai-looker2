# Fan Owl × Howler Super App — integration investigation

> Status: **Phase 1 Pulse side BUILT (2026-07-18)** — per-site "Allow in Howler
> app" toggle (`allow_app` + `platform:'howler-app'` boots on
> `/api/fan/context`) and the `host=app` embed mode (FanOwlChannel bridge for
> close/checkout/navigate, safe-area, no footer). App (Flutter) side awaits
> mockup sign-off. · Companion to
> `docs/specs/FAN_OWL_SPEC.md` (the Fan Owl itself) and `docs/OWL_EMBED.md`
> (the organizer-portal embed handshake, the precedent for identity-linked
> embedding) · App repo: https://github.com/howler/HowlerApp_Standalone_Shai

## The goal

Put the **Fan Owl** (`server/fanOwl.js` + `/embed/fan` + `client/public/fan-owl.js`)
inside the **Howler super app** (Flutter) so a fan browsing an event in the app
gets the same booking-guide chat they'd get on the promoter's website — same
brain, same catalogue, same guardrails — just embedded natively.

## Why this is easier than it sounds

The Fan Owl was built as a **fully self-contained, anonymous, cross-origin
surface**. Everything the widget needs already travels over five public JSON
endpoints with no cookies and no auth:

| Endpoint | Role |
|---|---|
| `POST /api/fan/context` | boot: site key → session id + ribbon offer (no LLM) |
| `GET /api/fan/boot?sid=` | iframe boot: branding, history, starters, offer |
| `POST /api/fan/chat` | streamed chat (plain text + `<<<OWL_STATUS>>>` / `<<<FOLLOWUPS>>>` / `<<<FAN_OFFERS>>>` markers) |
| `POST /api/fan/lead` | explicit consent form |
| `POST /api/fan/event` | interaction beacons |

And `/embed/fan` (`FanOwlEmbedPage.jsx`) is already a **mobile-first,
full-viewport chat page** designed to be someone else's guest: it already
strips `X-Frame-Options`, already `postMessage`s `howler-fan-owl:close` to its
host, and the session id rides the URL fragment. Meanwhile the app already has
mature WebView patterns (`webview_flutter ^4.10.0`: `RemoteMapScreen`,
`PeachWebviewCheckout`, `SpotifyEmbedWidget`) and a CTA router
(`lib/core/routing/cta_router.dart`) that resolves taps into native routes.

## Recommended path: three phases

### Phase 1 — WebView embed (behaves exactly like the web) — the MVP

The Flutter app plays the role `fan-owl.js` plays on a promoter's site:

1. **App boots the session itself**: `POST <pulse-host>/api/fan/context` with
   `{ siteKey, anonId, url: 'app://event/<howlerEventId>/<screen>' }` →
   `sessionId` (+ the ribbon payload, usable for a native teaser chip).
2. **App opens a WebView** (full-screen sheet, matching the widget's mobile
   behaviour) at `https://<pulse-host>/embed/fan#sid=<sessionId>&host=app`.
3. **Bridge two events** out of the page into Flutter (JS channel or the
   existing postMessage): `close` → pop the sheet; `checkout:<url>` → hand the
   URL to `CtaRouter` (see Phase 2) or `url_launcher`.

**Pulse work (small — ~1–2 days):**
- **App access gate on `/api/fan/context`.** Today the boot call is gated by
  the browser `Origin` header vs the site's domain allowlist; a native app
  sends no Origin, so any site with a locked-down allowlist would 403. Add a
  per-site **"Allow in Howler app"** toggle (`allow_app` on `fan_sites`, both
  admin + `/api/my` surfaces per the dual-surface rule) and accept
  `platform: 'howler-app'` boots when it's on. (Origin was always a soft gate —
  the real guardrails are rate limits + the daily budget — so this is a
  product switch, not a security downgrade.)
- **`host=app` mode on `/embed/fan`:** hide the close ✕ or keep it (bridged),
  respect safe-area insets, optional `theme=dark`, and replace
  `window.open(url, '_blank')` on offer buttons with a postMessage
  (`howler-fan-owl:checkout:<url>`) when hosted — `window.open` is unreliable
  inside WebViews anyway.
- **Suppress "Powered by Howler"** footer when `host=app` (it's Howler's own app).

**App work (~2–3 days):**
- New disposable feature module `lib/feature/fan_owl/` — a small repository
  (the one `context` call), a cubit, and a WebView screen following
  `RemoteMapScreen` / `PeachWebviewCheckout` patterns (JS channel for the
  bridge, offline banner, loading state).
- **Entry point:** an "Ask about tickets 🦉" CTA on the event store screens
  (and optionally a native teaser chip fed by the `context` response's
  `pitch`/`offer` — the ribbon, rendered natively, zero AI).
- **Config: event → siteKey.** `fan_sites` are keyed by Pulse entity/suite, so
  the app needs a mapping from Howler event id → site key. Phase 1: ship it in
  the event CTA/feature config (or a PostHog flag payload) for pilot events.
  Later: a tiny public `GET /api/fan/resolve?eventId=<howler id>` on Pulse once
  the Howler→Pulse ingestion link exists.
- `anonId`: pass the app's stable analytics/device id, so the returning-fan
  memory and interest topics thread across app sessions (and across web+app if
  we ever share the id).

### Phase 2 — make it *better* than the web (native checkout + screen context)

Two upgrades the website can never have:

- **Buy without leaving the app.** The Owl's `getCheckoutLink` only hands out
  stored Howler ticket-store deep links. On the web that opens a browser tab;
  in the app, the bridge should feed the URL through `CtaRouter` so it lands on
  the **native event store / Peach checkout** for that event. Same UTM logging
  on Pulse's side (`link_issued` events fire regardless); conversion should
  jump. Add a `deeplink_click` beacon variant (e.g. payload `surface: 'app'`)
  so web vs app funnels separate cleanly in Fan Owl insights.
- **Per-screen context via the existing page-mapping machinery.** The Owl
  already switches offer/pitch/starters by URL pattern. Each app screen boots
  with a synthetic URL — `app://event/<id>/store|lineup|info|map|explore|wallet|feed|chat`
  — and promoters map them like website pages (the Pages editor has a one-click
  **"📱 + Howler app screens"** seeder). This explicitly covers **app-only
  screens with no website equivalent** (My Tickets/wallet, feed, chat): each
  gets its own organiser-approved info, starter chips and pitch. `app://`
  mappings are context-only — `navPath` returns `''` for them, so they never
  become website nav buttons. No new Pulse machinery: same `fan_pages` table.
- **Both widget styles, natively.** The site's `widgetStyle` (already in the
  `/api/fan/context` payload) drives the app entry point exactly like the web:
  `launcher` → floating Owl FAB + teaser chip; `bar` → a persistent ask bar
  docked above the app's bottom nav, with the deterministic `suggest`
  half-drawer payload the bar sites already get. Typing/tapping opens the sheet
  with the question pre-sent (`&ask=` fragment, already supported).

### Phase 3 — two optional deepenings (decide later, in either order)

- **Identity-linked sessions.** In the app the fan is *logged in* — the one
  thing the web Fan Owl never has. A consent-first variant of the boot call
  (pattern: `docs/OWL_EMBED.md`'s server-to-server handshake, or simply the
  fan tapping "let the Owl know it's me") could link the session to a
  `fan_profiles` row: the Owl greets by name, remembers preferences, and the
  phase-4 purchase-data join in `FAN_OWL_SPEC.md` gets its email key for free.
  Also unlocks ticket-aware answers ("you already have a Saturday pass — want
  camping?") once ingestion lands.
- **Fully native chat UI.** The `/api/fan/chat` stream is deliberately simple
  (plain text + three literal markers) — a Dart client can parse it exactly as
  `FanOwlEmbedPage.jsx` does and render bubbles/offer cards in `howler_ui_v2`.
  Perfect look-and-feel and no WebView keyboard jank, at the cost of a second
  client to keep in sync as the widget grows. Only worth it after Phase 1
  proves usage.

## Watch-outs

- **Daily budget:** app traffic shares the site's `daily_budget` (default 400
  user messages/day → ribbon-only degrade). If the app meaningfully adds
  volume, either raise it per pilot site or split an app budget.
- **Rate limits:** `/api/fan/chat` is limited per-IP (20/min) as well as
  per-session; carrier-grade NAT can pool many app users behind one IP. If the
  pilot hits this, key the IP limit by session for `platform: 'howler-app'`.
- **Site keys stay public** (they're in web page source already) — the
  `allow_app` toggle + enable switch remain the promoter's controls.
- **Streaming through WebView:** `fetch` streaming works fine in iOS
  WKWebView/Android WebView for same-origin calls inside the frame (it's what
  the embed page does today) — no change needed, but keep the heartbeat
  behaviour (it also keeps mobile radios from idling the socket).

## Effort summary

| Phase | Pulse | App |
|---|---|---|
| 1 · WebView MVP | ~1–2 days | ~2–3 days |
| 2 · Native checkout + app:// context | ~0.5 day | ~1–2 days |
| 3 · Identity link / native UI | design first | design first |

Phase 1+2 is a realistic one-sprint pilot for one event (Kappa/FuturFestival
being the obvious candidate — it's already the Fan Owl's stress-test pilot and
has its own dedicated app build).
