# Spec — The Support Owl (customer support agent) — DRAFT for discussion

> Status: **brainstorm / design map** (started 2026-07-17). Nothing here is locked —
> this is the thinking surface for the workshop. Sibling of
> `docs/specs/FAN_OWL_SPEC.md`; read that first for the widget mechanics and trust
> boundary this builds on.
>
> **Build state:** P0a (the knowledge spine) is built and on **staging** —
> `server/supportOwl.js` (`support_knowledge` table, HelpDocs sync via the read
> API, nightly refresh, two-tier `searchKnowledge`, kill switch
> `support_owl_enabled`) + Admin → Product → 🛟 Support Owl
> (`SupportOwlAdmin.jsx`: write-only HelpDocs key, Sync now, manual platform
> entries, retrieval preview). No AI calls yet. Next: P0b (Freshdesk webhook +
> triage).

## 0. In plain English (read this first)

**The Fan Owl sells; the Support Owl cares.** Same brain, different job: an AI
agent that handles end-customers' (ticket-buyers') support questions — over
**email**, on the **event website**, and on **WhatsApp** — grounded in Howler's
own help docs plus everything the client has already taught the Fan Owl, and
**escalating to a human** the moment it's out of its depth.

The elegant part: this is an **assembly job, not a greenfield build**. Pulse
already has:

- the anonymous public chat widget + per-client knowledge base (`fanOwl.js`),
- a WhatsApp door with webhook, sessions, buttons and the 24h window
  (`owlWhatsapp.js` on Clickatell),
- an inbound-email spine with per-client routing, threading and reply-stripping
  (`os.js` → `POST /api/inbound/email`, see `docs/INBOUND_SETUP.md`),
- the shared agent loop (`owlChat.runOwlLoop`), per-client AI metering
  (`aiUsage.js`), and a full human-notification fan-out (`os.announce` →
  inbox/email/push/Slack).

**Freshdesk stays.** Howler's support email keeps living in Freshdesk; the
Support Owl works *with* it (drafting/replying via the Freshdesk API) rather
than replacing it. We choose per channel and per client what routes where.

## 1. Naming & where it sits

- Working name: **Support Owl** — the Owl's **fourth door** (after chat, skills,
  WhatsApp/Fan). One brain, one more room it stands in.
- A new **self-contained disposable module** `server/supportOwl.js` (own
  `support_*` tables, mounts in one line, ≤1500 lines per the architecture
  test), plus a thin Freshdesk connector (`server/freshdesk.js`) it drives.
- Persona: the calm, competent help-desk friend. Contrast with the Fan Owl's
  hype-friend voice — support tone is *reassure, resolve, own the problem*.
  New system prompt, registered in `insights.promptRegistry()` like every other.

## 2. The knowledge model — two tiers (decided direction)

Support answers need **general Howler knowledge** (how tickets/refunds/cashless
/entry work on the platform) *and* **client-specific knowledge** (this event's
own policies, prices, logistics). So the KB is layered, exactly like settings:

| Tier | What | Where it lives | Who maintains it |
|---|---|---|---|
| **Platform** | All Howler help docs — the general "how Howler works" corpus | new `support_knowledge` rows with `entity_id = ''` (platform-scoped) | Howler staff, in Admin → Support Owl. **Synced, not retyped**: the help docs live on **HelpDocs** (helpdocs.io), which has a clean read API — `GET https://api.helpdocs.io/v1/article` (`include_body=true`, read-only API key; docs: apidocs.helpdocs.io) — so a nightly sync + "Sync now" button mirrors them into Pulse. The public help-centre crawl (`safeGetText` → AI-distil → human-review, already built for the Fan Owl) is the fallback/top-up |
| **Client** | The event's own FAQs/policies/catalogue/page info | the existing `fan_knowledge` + `fan_catalogue` + `fan_pages.content` — reused as-is, zero migration | the client (self-service) or Howler on their behalf — the surfaces already exist (`FanOwlAdmin`) |

Retrieval searches both tiers; **the client tier wins on conflict** (their
refund policy beats the generic one). The prompt labels which tier an answer
came from so the Owl says "Howler's policy" vs "the organisers' policy"
correctly. Blank client tier ⇒ inherit platform, per the inheritance rule.

Sync notes: store `source: 'helpdocs'`, `ext_id` (HelpDocs article id),
`synced_at` per entry so re-syncs upsert cleanly, and human edits to synced
entries are either locked or forked-on-edit (decide in workshop). Category
structure comes over the same API. A "Sync now" button + a nightly
`scheduler.js` job.

## 3. The three channels

### 3.1 Email — the Freshdesk question (the crux)

Three shapes considered:

- **(A) Owl inside Freshdesk** — Freshdesk remains the transport + system of
  record. A Freshdesk automation rule fires a **webhook to Pulse** on every new
  ticket/reply; Pulse identifies the client (see routing below), runs the
  support loop, and responds **via the Freshdesk API** — first as a **private
  note (draft)** a human approves, later as a direct reply for high-confidence
  categories. Escalation = assign the ticket to the human group + drop a
  context note. Human agents keep their whole world (views, SLAs, macros).
- **(B) Pulse-native email** — per-client support addresses
  (`support-<token>@<inbound domain>`) route into the **existing** Pulse
  inbound spine; the Owl replies via `mailer.js` (Resend) with per-client
  branding; escalations become `needs_reply` OS threads. No Freshdesk at all
  on these addresses.
- **(C) Hybrid — recommended.** Start with (A): zero migration, zero new email
  infrastructure, the team keeps Freshdesk, and the Owl's value shows up as
  drafts inside the tool they already use. Keep (B) in the back pocket for
  clients who want their *own* branded support address later — the spine for
  it is already built and both shapes share the same brain + KB, so this is a
  transport choice per client, not a fork.

**Who owns what (the division of labour, spelled out):**

| Concern | Lives in | Why |
|---|---|---|
| The human agents' queue, views, SLAs, assignments, macros | **Freshdesk** | It already works; humans keep their tool. Replacing it is a separate (later, optional) decision |
| The agent's brain — persona, loop, tools | **Pulse** | One brain across email/web/WA; same `runOwlLoop` as every Owl door |
| Both knowledge tiers (Howler help docs + client KB) | **Pulse** | Single source of truth for all three channels; Freshdesk Solutions is a *feed* into it, not the store |
| Per-client config: channels on/off, draft↔auto dial, escalation rules & contacts, tone | **Pulse** (dual-surface: Admin + client Settings) | This is client-scoped product config — it belongs with the entity, not in a Howler-global helpdesk |
| Monitoring: every Owl draft/reply/escalation, acceptance rate, KB gaps, AI cost per client | **Pulse** (Support Owl admin view + `aiUsage`) | The insight flywheel; Freshdesk only sees its own tickets, Pulse sees all channels |
| The customer-facing transcript on email | **Freshdesk** (ticket) — mirrored into `support_threads` | Humans reply from Freshdesk; Pulse keeps the copy for context, analytics and the other channels |

So: **Freshdesk keeps the humans; Pulse manages the agent.** From Pulse's admin
you see and steer everything the Owl does (on every channel, per client); you
just don't *staff* the email queue there — until/unless a later phase decides
the OS inbox should take that over too (P4/P5 territory, not now).

**Rollout in practice (P0, ~concretely):** connect Freshdesk (domain + API key
in Admin → Integrations, write-only) → sync the help-doc tier → turn on
"draft mode" for one pilot client → Freshdesk automation posts new tickets to
`POST /api/support/freshdesk` → the Owl's draft appears as a private note
within seconds, with its confidence + sources + a "reply I'd send" the human
can paste/edit → humans work exactly as today, just faster. Pulse's admin view
shows every draft and what happened to it. Nothing customer-facing changes
until acceptance data says it should.

**Per-client routing — today's reality and the first win.** Today ALL inbound
support lands in **one shared support address**, and Freshdesk automation
rules flag tickets per client — keyword/rule-based, brittle, and admittedly
"can be done better". That makes **AI triage the Owl's first job, before it
drafts a single reply**: on every new ticket the Owl reads the message,
matches it against Pulse's own client/event roster (entity + suite names,
aliases, event dates — context Freshdesk rules will never have), and writes
the classification back to the ticket (Company / a custom field / tags) via
the API, with a confidence score. High confidence ⇒ tagged silently; low ⇒
flagged "unroutable" for a human. This replaces the rule spaghetti with one
maintained-nowhere-else source of truth (Pulse already knows the clients) and
is shippable value **before** any customer-facing AI. Longer-term options if
we want deterministic routing: dedicated per-client addresses forwarding into
the same inbox (`to` address ⇒ entity). Unmappable tickets ⇒ the Owl answers
from the **platform tier only** (generic Howler help), which is still useful —
or stays silent, per config.

**Freshdesk's integration surface (what we can lean on):** webhooks out of
automation rules (our trigger in), a full REST API (our notes/replies/fields
out), a **native WhatsApp Business channel** (WhatsApp messages become
tickets — see §3.3), two first-party Slack apps, and a 1,000+ app marketplace
(Teams, Shopify, Salesforce/HubSpot, Jira, telephony, Zapier) plus custom
in-Freshdesk apps if we ever want a "Pulse context" sidebar in the agent view.
Freshworks also sells its own AI agent (Freddy) — the reason to build ours
instead is the whole point of this spec: Freddy will never know the client's
event, catalogue, Pulse data or our two-tier KB.

### 3.2 Website — extend the Fan Owl widget

The widget is already on the event site talking to fans; support is a
**capability blend, not a second widget**. The support toolbox + platform-tier
knowledge join the fan toolbox behind the same `/api/fan/chat` loop; intent
decides which hat the Owl wears mid-conversation ("which ticket should I get?"
→ booking guide; "I never got my tickets" → support). One new tool:
`escalateToHuman` (below). Optionally later: a "Get help" entry point in the
widget UI that pre-frames the support persona and collects an email for
follow-up (reusing the consent-first lead form).

### 3.3 WhatsApp — a second identity path on the existing door

`owlWhatsapp.js` already does transport, sessions, buttons, media and the 24h
window. Today unknown numbers are rejected (organiser allowlist). Add an
**end-customer path**: a number that doesn't resolve to a Pulse user falls
through to the support persona. Open question (workshop): **which client is an
unknown number asking about?** Options: per-client WhatsApp numbers (clean but
costs a number per client), a keyword/menu first-touch ("which event?"),
or launch WhatsApp support only from client-site links
(`wa.me/<number>?text=<event-code>`) that pre-seed the entity. Lean: start
with the wa.me deep link from the event site + widget, so the entity rides in.

Alternative shape worth weighing: **Freshdesk's native WhatsApp Business
channel** turns WhatsApp messages into Freshdesk tickets — meaning the same
Owl↔Freshdesk integration built for email (webhook in, note/reply out) would
cover WhatsApp *for free*, with humans handling escalations in the queue they
already staff. Trade-off: replies ride Freshdesk instead of our existing
Clickatell plumbing (buttons, media, digests), and it needs a WhatsApp
Business number connected to Freshdesk. Decide in workshop; the brain and KB
are identical either way, so this is transport-only.

## 4. Per-customer context & order lookups

- Everything scoped by `entity_id`, same as every other surface; the support
  loop gets the same grounding pack as the Fan Owl (catalogue, knowledge,
  aiContext) plus the platform tier.
- **Order status** ("where are my tickets?") is the #1 support question and
  needs data access. The Owl's `askData` + scope gate exist, but the caller
  here is an **anonymous end-customer** — so lookups must be verification-first:
  the customer supplies an order reference/email, the tool returns a **match /
  no-match + safe status summary** (never enumerates other buyers, mirroring
  the existing PII discipline in the segments tools). Phase 2+; drafts-only
  email mode doesn't need it on day one because the human approves anyway.
- Conversation memory per customer: email threads thread naturally; web/WA
  reuse the existing session stores.

## 5. Escalation — the human handoff (as much the product as the answers)

Map onto the sanctioned **autonomy ladder** (`docs/SKILLS_BRIEF.md` §3):
nothing escalates silently, default to L2.

- **L1 — draft**: every reply is a draft a human approves (Freshdesk private
  note / OS thread). This is the launch mode for email.
- **L2 — auto-send in bounds**: auto-reply only when (a) the answer is fully
  grounded in the KB, (b) the category is on the allow-list, (c) confidence
  is high. Everything else escalates. This is the launch mode for web/WA chat
  (where an instant answer is the whole point) — with the escape hatch below.
- **Always-escalate list** (config, seeded): refunds & chargebacks, payment
  disputes, medical/safety/legal, angry or distressed customers, press,
  anything involving another named person, explicit "I want a human".
- **The `escalateToHuman` tool** (all channels): captures a structured summary
  (who, what, channel, transcript, what the Owl already tried), then routes —
  email: assign the Freshdesk ticket to the human group + context note;
  web/WA: open a `needs_reply` OS thread to the client team via `os.announce`
  (email+push+Slack fan-out already built) **or** create a Freshdesk ticket on
  the customer's behalf, per client config. The customer always gets an honest
  handoff message ("I've passed this to the team — you'll hear back at …").
- Escalations are the **flywheel**: every one is a logged KB gap
  (`faq_gap`-style), surfaced in the insights view so the platform/client tier
  grows where it's actually thin.

## 6. Data model sketch (new tables, `support_*`)

```
support_knowledge   id, entity_id ('' = platform tier), kind (faq|policy|info|article),
                    question, body, source ('manual'|'freshdesk'|'crawl'), ext_id,
                    locked, position, synced_at, updated_at
support_threads     id, entity_id, channel (email|web|whatsapp), ext_ref (freshdesk
                    ticket id / fan session id / msisdn), customer_email, customer_name,
                    status (open|answered|escalated|closed), created_at, updated_at
support_messages    id, thread_id, role (customer|owl|human), body, tool_calls,
                    confidence, created_at
support_escalations id, thread_id, reason, category, routed_to (freshdesk|os|slack),
                    ext_ref, resolved_at, created_at
```

(Client-tier knowledge stays in `fan_knowledge` — `support_knowledge` may
ultimately absorb it, but don't force a migration in phase 1.)

## 7. Config surfaces (dual-surface rule, honoured up front)

- **Admin → Support Owl** (platform): the Howler help-doc tier (list + sync
  from Freshdesk + crawl), Freshdesk connection (domain + API key,
  write-only secret), global always-escalate rules, per-client enablement.
- **Admin → client tab / client Settings → Support** (dual-surface, same
  component + `scope` prop): channel toggles (email draft/auto, widget support
  mode, WhatsApp), the client's escalation contacts, tone notes, and the
  shared knowledge editor they already know from the Fan Owl.
- Wire into the **setup wizard** when this ships as part of standing a client
  up; add prompts to `promptRegistry()`; meter every call via
  `aiUsage.run({ entityId, kind: 'support_owl' })`; add the layer to
  `GET /api/admin/ai-overview`.

## 8. Phasing (each phase ships value alone)

1. **P0 — Knowledge + triage + email drafts (lowest risk, immediate value).**
   Platform-tier KB synced from HelpDocs; Freshdesk webhook → support loop.
   First deliverable inside P0 is **AI triage** (classify ticket → client,
   write it back to the ticket) — replaces the brittle rule flags and ships
   value before anything customer-facing. Then **private-note drafts** on
   real tickets; escalation = it just doesn't draft. Humans send everything.
   Measures: triage accuracy vs the old rules, draft acceptance rate, time
   saved.
2. **P1 — Website support mode.** Support toolbox + platform tier join the
   Fan Owl widget; `escalateToHuman` → OS thread/Freshdesk ticket. Auto-answer
   with the always-escalate list active.
3. **P2 — Email auto-send in bounds.** Freshdesk replies (not notes) for
   allow-listed categories once P0 acceptance is provably high; per-client
   dial (draft ↔ auto), like the notices severity dial.
4. **P3 — WhatsApp support path** (entity-seeded wa.me links first) +
   **order-status lookups** (verification-first `askData`).
5. **P4 — Pulse-native branded support addresses** (shape B) for clients who
   want `support@their-event.com` without Freshdesk.

## 9. Open questions for the workshop

1. ~~Where do the help docs live?~~ **Answered 2026-07-17: HelpDocs
   (helpdocs.io)** — sync via its read API. ~~Routing signal?~~ **Answered:
   one shared support address + rule flags today; the Owl's AI triage
   replaces the rules (P0), writing the client back onto the ticket.**
   Remaining sub-question: which Freshdesk field carries it (Company vs
   custom field vs tags), and do we ever add per-client forward addresses
   for determinism?
2. WhatsApp transport: our Clickatell door vs Freshdesk's native WhatsApp
   channel (one integration covers email + WA, but replies lose our
   buttons/media plumbing)? See §3.3.
3. Auto-send appetite: is Howler comfortable with L2 auto-replies on web chat
   from day one (Fan Owl already answers fans live), and what's the bar for
   email?
4. WhatsApp identity for end-customers (per-client numbers vs deep links).
5. Does the *client's own team* also get a support view in Pulse (see/join
   escalated threads), or is P0–P2 purely Howler-staff-facing?
6. SLA expectations — does an escalation need a "human replied within X"
   nudge loop (the `must_ack`/`remindUnacked` machinery exists)?

## 10. Risks

- **Wrong answers to paying customers** — mitigated by the same non-negotiables
  as the Fan Owl (grounded-only, "I don't know" + escalate beats invention),
  drafts-first on email, always-escalate list, and per-site budgets.
- **Freshdesk API coupling** — keep the connector thin and one-file so a
  provider change (or the day Freshdesk *is* replaced) swaps one module.
- **PII** — order lookups are the danger zone; verification-first tools, no
  enumeration, and nothing in P0/P1 touches buyer data at all.
- **Scope creep into a full helpdesk** — the spine (`os.js`) will tempt us to
  rebuild Freshdesk. Don't: Pulse owns the *agent*, Freshdesk owns the *queue*,
  until a real client need says otherwise.
