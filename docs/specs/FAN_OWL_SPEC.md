# Spec — The Fan Owl (HowlerOne Smart Commerce Assistant)

> Status: **draft — workshopped 2026-07-02** · Owner: (tbd) · Roadmap: **1.4**
> · North Star: `docs/EXPERIENCE_OS_BRIEF.md` · Companions:
> `docs/specs/AGENTIC_OWL_SPEC.md` (the loop this rides), `docs/OWL_EMBED.md`
> (the embed handshake this extends), `docs/ENGAGEMENT_ENGINE.md` (where the
> fan data lands).
>
> **Scope of this spec:** the *consumer-facing* Owl — an embeddable assistant on
> promoters' public event websites that turns page-browsing fans into buyers:
> context-aware ticket recommendations, grounded Q&A, and (v1) a prefilled
> deep-link into Howler checkout. It is the Owl's **third door**: same brain and
> loop as `owlChat.js`, but a new persona (sales concierge, not data analyst), a
> new toolbox, and a much narrower trust boundary (anonymous fans, public data
> only).

## 0. In plain English (read this first)

Event websites are brochures: they tell the story (artists, experiences, venue)
while ticketing lives on a separate, utilitarian checkout page. Fans browsing an
artist page have to *leave the story* to work out which of seven ticket tiers
gets them in front of that artist — and many never come back.

**What we're building:** a small widget a promoter drops onto their site once.
On every page it knows where the fan is and shows, instantly, the one thing that
matters there — *"To see Luna X on Saturday you need a Saturday Pass (R950) ·
selling fast."* If the fan wants more, it opens into a chat where the Owl
answers questions (what's included in VIP, can I bring kids, refund policy) from
promoter-approved knowledge, recommends bundles and add-ons, and hands the fan a
**prefilled cart link** into Howler checkout. The website stays the stage for
storytelling; the assistant becomes the sales agent standing on it.

**And the flywheel:** every fan conversation is promoter insight. Top questions,
questions the Owl *couldn't* answer (FAQ gaps), and interest-without-purchase
("212 fans asked about camping and didn't buy") flow back into Pulse — where the
campaign engine can act on them. Insight → action → results, pointed at
consumers for the first time.

---

## 1. Workshop decisions (locked 2026-07-02)

1. **Commerce rails.** The Howler ticketing API provides **full inventory**
   (tiers, prices, availability) and supports **headless integration** (the
   Howler app already does it). Event *info* from the API is limited — so Pulse
   gains a client-editable **event knowledge** section (FAQs, policies, richer
   descriptions) that feeds the assistant, supplemented by reading the
   promoter's website itself.
2. **Checkout v1 = deep link, and the links are *supplied*.** Howler provides
   ready-made checkout links per ticket/add-on for now — no link-construction
   API needed. Each catalogue entry stores its link (entered in the same
   admin/self-service surface as the knowledge base); Pulse appends UTM + promo
   params when handing it to a fan so conversion stays measurable. The v1
   limitation is accepted: the link lands the fan on the right ticket, they
   pick quantity there — programmatic cart-prefill (quantities, multi-item
   bundles in one cart) is phase 2, in-widget headless checkout phase 3.
3. **Branding.** It is visibly **the Howler Owl 🦉** for now. A per-promoter
   branded assistant (their name/mascot on the same brain) is a future layer —
   the widget's look already flows from a per-site `branding` blob so this is a
   theming exercise later, not a rebuild.
4. **Where it lives: inside Pulse, as a disposable module** (decision rationale
   in §2.1).
5. **Pilots:** **Kappa Futur Festival** (kappafuturfestival.it — the complex
   case) and **Retreat Yourself** (ry.howler.co.za — the simple case). See §8.

## 2. Architecture

### 2.1 Inside Pulse, as a disposable module

The fan Owl ships as `server/fanOwl.js` (+ widget assets), mounted from
`index.js` in one line, owning its own `fan_*` tables — the standard disposable
pattern. Why in-Pulse and not a separate service:

- **It reuses everything:** the Claude tool-use loop and streaming plumbing
  (`owlChat.js`), the curated-catalogue pattern (`owlCatalogue.js`), the embed
  session mechanics (`owlEmbed.js`), promo codes + conversion/UTM tracking
  (`actions.js`), and the admin/self-service dual-surface conventions.
- **v1 risk is bounded:** the proactive layer is deterministic and cacheable
  (§2.2), the LLM only runs when a fan actually types, and checkout is a
  deep-link — Pulse never sits in the payment path.
- **The escape hatch is designed in:** the widget talks to Pulse only through a
  small public API (`/api/fan/...`, session-token auth, no cookies). If a
  large client's on-sale traffic ever outgrows the single Render instance, that
  API surface can be lifted into its own service (or fronted by a cache/CDN)
  without touching the widget contract. Static widget assets are
  cache-forever + CDN-able from day one.

### 2.2 Two layers: deterministic ribbon, conversational loop

The v2.0 concept said "the assistant instantly presents the most relevant
ticket on page load." That must **not** be an LLM call per pageview — at
event-site traffic it's ruinous for cost and latency. Split it:

- **The ribbon (push, deterministic, no LLM).** Page URL → confirmed page
  mapping (§3.C) → mapped ticket/add-on + cached live availability → rendered
  instantly. *"Next up: Retreat Yourself · 4-day pass incl. camping · Book
  now."* Pure rules; cheap enough for every pageview; cacheable per
  (page, availability-bucket).
- **The conversation (pull, the Owl loop).** Opens only when the fan engages.
  Same loop shape as `owlChat.js` (streamed turns, status pings, tools), new
  persona and toolbox:
  - `getOffer(pageCtx)` — the tickets/bundles/add-ons relevant here, with live
    price + coarse availability (from the Howler API via a short-TTL cache).
  - `searchKnowledge(question)` — promoter-authored FAQs/policies + approved
    site content; answers are **quoted from this corpus, never composed from
    thin air**.
  - `getCheckoutLink(item, promo?)` — returns the item's **stored,
    Howler-supplied** checkout link with UTM (+ validated promo) params
    appended. The Owl never constructs or edits URLs itself — it can only hand
    out links that exist in the catalogue.
  - `logInterest(kind, payload)` — feeds the insight flywheel (§6).

  No `askData`, no dashboards, no organiser tools — the fan toolbox is a
  hard-separate, minimal set.

### 2.3 The trust boundary (non-negotiables)

Fans are **anonymous**; nothing organiser-grade may reach this surface.

- **A new public-catalogue scope tier**, not `applyScope`. The fan Owl can see
  only what an admin/promoter has explicitly published: the ticket catalogue,
  knowledge entries, confirmed page mappings. It structurally cannot query
  Looker/organiser data — the tools above are its whole world.
- **Numbers only from tools** — the same rule as `OWL_CHAT_SYSTEM`, with less
  slack: a wrong refund-policy or price answer to a consumer is a legal
  problem, not an embarrassment. Prices and availability in the UI render from
  structured tool data (chips/cards), never from generated prose.
- **Coarse availability only** ("selling fast", "last few"), never exact
  counts — the chatbot must not become a competitor's live-sales scraper.
- **Policy answers are quotes.** Refunds, age limits, accessibility: answered
  verbatim from promoter-authored entries, with an honest "I don't know — ask
  the organiser" fallback (logged as an FAQ gap, §6).
- **Prompt-injection posture:** the fan message stream is hostile input. The
  toolbox is read-only + link-building; there is nothing to escalate to, and
  promo codes are validated server-side against `actions.js`, never invented.
- **Abuse controls:** per-site-key domain allowlist, anonymous session tokens
  (short-lived, minted by the widget loader), per-session + per-IP + per-site
  rate limits, per-site daily LLM budget with a graceful "ribbon-only" degrade.
- **New system prompts** register in `insights.promptRegistry()` like every
  other Owl prompt (the AI audit stays complete).

## 3. Where the knowledge comes from

**A. Howler ticketing API (live commerce truth).** Tiers, prices, availability,
add-ons; short-TTL cached per suite. The only source of numbers.

**B. Pulse event knowledge (the new client-editable section).** FAQs, policies,
rich descriptions, artist→ticket notes — everything the ticketing API doesn't
carry. Dual-surface per the house rule: **Admin → client detail tab** and
**client self-service** (`/api/my/fan-knowledge`, entity-enforced), same
component, `scope` prop.

**C. The promoter's website (crawl → suggest → confirm).** Promoters won't
hand-author metadata JSON per page. Instead: the embed reports page URLs; Pulse
crawls the site once and **the Owl suggests page mappings** ("this looks like
Luna X's artist page → map to Saturday Pass?") which the promoter confirms in a
mapping UI. Suggest-then-human-confirms — the same pattern the Experience OS
brief mandates for extraction. Crawled copy can also seed knowledge entries
(again as suggestions).

**D. Runtime page context.** The snippet sends the current URL (+ optional
`data-howler-page` hints for SPAs); the server resolves it against confirmed
mappings. Unmapped pages fall back to the event-level default offer.

## 4. Embed mechanics

One `<script>` tag per site:

```html
<script async src="https://<pulse-host>/fan-owl.js"
        data-site-key="pk_live_…"></script>
```

The loader (a few KB, immutable-cached) injects a launcher + ribbon and mounts
the widget itself in an **iframe served by Pulse** (same isolation logic as
`OwlEmbedPage`): all API calls are same-origin inside the frame, an anonymous
session token rides an Authorization header, no cookies, no third-party-cookie
issues. Unlike `owlEmbed.js` there is **no server-to-server handshake** — fans
have no backend to mint for them — so the trust anchors are the site key +
domain allowlist (checked against `Origin`/`Referer` on session mint) + rate
limits, and the session grants nothing beyond the public catalogue anyway.

Mobile-first, per the house rule: the widget is a bottom sheet on phones, a
corner panel on desktop; tap targets ≥ 40px; the ribbon collapses to a single
line on narrow viewports.

## 5. Data model sketch

```
fan_sites      id, entity_id, suite_id?, site_key, domains[], enabled,
               branding(json), llm_budget, created_at
fan_pages      id, site_id, url_pattern, page_type(home|lineup|artist|tickets|
               attraction|venue|faq|other), context(json: artist/ticket/addon ids),
               source(crawl|manual), status(suggested|confirmed|dismissed)
fan_knowledge  id, entity_id, suite_id?, kind(faq|policy|info), question?, body,
               position, source(manual|crawl_suggested), updated_by/at
fan_catalogue  per-suite offer list: ticket/addon/bundle, label, price, currency,
               deep_link (Howler-SUPPLIED, admin/client-entered — not derived),
               availability_bucket (API-fed, cached), public(bool)
fan_sessions   id, site_id, anon_id, page_ctx, started_at, ua_hash
fan_messages   id, session_id, role, body, tool_calls(json), at
fan_events     id, session_id, kind(ribbon_view|chat_open|reco_shown|reco_click|
               deeplink_click|conversion|faq_gap|interest), payload(json), at
```

Everything keys off `suite_id` where event-specific, `entity_id` where
client-wide — the same spine as the rest of Pulse.

## 6. The flywheel back into Pulse

`fan_events` is the point. Per site/page/day, Pulse reports: ribbon views →
chat opens → recommendation clicks → deep-link clicks → conversions (closed via
the existing UTM/conversion tracking in `actions.js`). Plus two
insight → action loops:

- **FAQ gaps:** questions the Owl couldn't answer become suggested
  `fan_knowledge` entries for the promoter to approve.
- **Interest segments:** `interest` events ("asked about camping, didn't buy")
  resolve into campaign audiences for the engagement engine — the promoter can
  retarget them in two clicks.

## 7. Phasing

1. **Concierge (this spec's build target).** Snippet + ribbon + grounded chat
   over knowledge/catalogue + prefilled deep-link + conversion tracking + the
   admin/self-service knowledge and mapping surfaces. Proves conversion lift.
2. **Commerce-aware.** Live urgency, bundles, promo codes (engine exists),
   "hold one while you read" if/when the Howler API exposes holds.
3. **In-widget checkout.** Headless Howler checkout inside the widget — no
   redirect. (The deep-link tool becomes a `checkout` tool; the widget gains a
   cart pane; Pulse still never stores card data.)
4. **Identity & personalisation.** Fan recognition (past purchases, loyalty),
   dynamic bundles, group flows, per-promoter branded assistants, voice.

## 8. Pilots

Deliberately opposite ends of the spectrum:

- **Retreat Yourself** (`ry.howler.co.za` — start here). Howler-hosted site,
  four pages (home / tickets / accommodation / FAQs), **one** 4-day pass,
  accommodation upgrades as add-ons, checkout already on Howler. Minimal
  mapping surface, existing FAQ content to seed the knowledge base, add-on
  upsell (glamping/pods/vehicle camping) is the obvious win. Ships the whole
  loop on easy mode.
- **Kappa Futur Festival** (`kappafuturfestival.it`). Rich multi-page site
  (program/lineup, tickets, VIP, events/afterparties, info), **seven+ tiers**
  (GA/VIP/Gold × 3-day/single-day, resident/group/transit discounts),
  experiences (Taverna Futurista, afterparties, lockers, hotel packages),
  checkout on `store.kappafuturfestival.it`. This is the stress test for page
  mapping, tier disambiguation ("which ticket gets me to the Sunday
  afterparty?") and multilingual copy (EN/IT — the Owl should answer in the
  page's language).

## 9. Metrics (define before pilot, measure from day one)

- Ribbon attach rate (views / pageviews) and chat engagement rate.
- Recommendation → deep-link CTR; deep-link → purchase conversion; **lift vs
  non-widget baseline** (A/B by page or time-slice where the pilot allows).
- Add-on/upsell take rate on assisted vs unassisted purchases.
- Answer rate (questions answered from knowledge vs "I don't know") and FAQ-gap
  closure over time.
- Cost per assisted conversion (LLM spend / conversions) — the number that
  decides how aggressive the proactive layer can get.

## 10. Risks

- **Howler API surface** — phase 1 is insulated (links are supplied, inventory
  is read-only), but holds, programmatic cart-prefill and per-market checkout
  differences gate phases 2–3; audit against the Howler app's headless
  integration before committing those shapes. Supplied links can also rot
  (tier renamed/replaced) — the catalogue should periodically HEAD-check its
  links and flag dead ones to the promoter.
- **Wrong answers to consumers** → the §2.3 non-negotiables; policy answers are
  quotes; measure answer accuracy in pilot before widening.
- **On-sale traffic spikes** → cacheable ribbon, LLM budget + ribbon-only
  degrade, CDN'd assets; revisit the split-out escape hatch if a pilot strains
  the instance.
- **Promoter metadata rot** (lineup changes, tier renames) → mappings re-crawl
  on a cadence and flag drift as suggestions; catalogue is API-fed, so prices
  never rot.
- **Scraping / abuse** → coarse availability, rate limits, domain allowlist,
  per-site budgets.
