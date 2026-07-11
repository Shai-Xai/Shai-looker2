# 📲 App analytics — Event mapping guide

*For the Howler team configuring App analytics in Pulse. No code needed —
everything happens in [Pulse Admin → App analytics](https://howler-pulse-v2.onrender.com/admin).*

---

## Why mapping exists (read this first)

The Howler app doesn't send neatly-named events like "view" or "purchase" to
PostHog. It sends **one generic event called `interaction`** for almost
everything a user does, and describes *what kind* of interaction it was in
**properties**:

| Property | What it holds | Example values |
|---|---|---|
| `interaction_type` | what the user did | `cta_click`, `drop_off`, `follow`, `like`… |
| `CTA_Label` | which button was tapped | (the button's label) |
| `surface` | where in the app it happened | `event_detail`, … |
| `event_id` | which Howler event it belongs to | `40669` |

Pulse counts **Views, CTA taps, Purchases and Notifications** by matching
events against *definitions you write* — the mapping. Until a definition
matches something real, that metric reads zero and its tile stays hidden.
**Mapping = telling Pulse which interactions mean what.**

---

## The syntax (one definition per line)

Each box in the 🧭 Event mapping card takes one or more lines. Three forms:

```
$screen                                ← a plain event name: every event called $screen counts
interaction : interaction_type=cta_click   ← event + property: only interactions whose
                                             interaction_type equals cta_click count
interaction : CTA_Label=*              ← the * wildcard: any interaction that HAS a
                                             CTA_Label (whatever its value) counts
```

Rules:
- **One definition per line.** Multiple lines are OR'd — an event matching any
  line counts.
- **Names are case-sensitive.** `CTA_Label` ≠ `cta_label`. Always copy names
  from the catalog/Diagnose, never type from memory.
- Spaces around the `:` and `=` don't matter.

---

## The boxes and what to put in them

All on **Admin → 📲 App analytics → 🧭 Event mapping** (with the "All clients —
whole app" selector active):

| Box | Meaning | What we use today |
|---|---|---|
| **Screen / page views** | what counts as a "view" | `interaction : interaction_type=<the view value>` — find it in the breakdown (below) |
| **CTA taps** | ticket-button and other CTA taps | `interaction : interaction_type=cta_click` ✅ confirmed |
| **Purchases** | in-app purchase events | only if a purchase-ish value exists; otherwise **leave empty** — real ticket revenue lives in the Looker dashboards |
| **Notifications** | notification opt-ins/opens | map when the app sends them |
| **Purchase value property** | the property carrying an amount on purchase events | only if Purchases is mapped |
| **CTA label property** | the property carrying the button label (`view_tickets`, `buy_tickets`, …) — powers the 🎯 **CTA clicks by label** chart | default `CTA_Label`; if the chart stays empty, find the real key with 🔬 Diagnose → property explorer → **List keys** on `interaction : interaction_type=cta_click` |
| **Breakdown properties** | which property chips show in "What's driving it" | `interaction_type`, `CTA_Label`, `surface` (already set) |
| **Person profile properties** | where names/emails/mobiles live on PostHog person profiles | run 🔬 Diagnose and copy the real keys (email is `$email`; the name/surname/mobile keys likely differ from the defaults) |

---

## How to find the right names and values (never guess)

Three tools on the same page:

1. **🧩 What's driving it** — click `interaction_type` and read the ranked
   table + trend lines. This is where you find the view-ish and purchase-ish
   values to put in the mapping.
2. **Show events catalog** (in the mapping card) — every event *name* the app
   sends, busiest first. Confirms whether something is its own event or lives
   inside `interaction`.
3. **🔬 Diagnose** — the deep check:
   - confirms the event-ID property carries values (and shows samples to
     compare against Looker's event IDs);
   - lists the **real property keys** the app sends — both on events and on
     person profiles (for the name/surname/mobile mapping);
   - has a **value explorer**: type an event + property key, see its top
     values — copy-paste material for mapping lines.

---

## The procedure (5 minutes)

1. Open **Admin → 📲 App analytics**, selector on **All clients — whole app**.
2. In **What's driving it → interaction_type**, identify the values for
   views / CTAs / purchases.
3. Fill the mapping boxes using the syntax above.
4. In **Person profile properties**, replace the defaults with the keys 🔬
   Diagnose shows (so App users get names + mobiles, not just emails).
5. **Save mapping**, then **↻ Sync now**. The manual sync recounts the **full
   90 days**, so history backfills in one click. (The automatic nightly sync
   only restates the last 7 days — after any mapping change, always Sync now.)
6. Verify: the Views/CTA tiles appear with numbers, and a per-client lens
   (pick a client in the selector) shows the same metrics scoped to their
   events.

---

## Good to know

- **Hidden tiles are normal.** Views/CTA taps/Purchases tiles, chart chips and
  table columns hide while their mapping matches nothing, and reappear on
  their own after Save + Sync.
- **Per-client numbers need `event_id`.** A client only gets credit for
  interactions stamped with their Howler event ID. If a metric shows app-wide
  but is empty for every client, the app is tracking it *without* `event_id` —
  that's a tracking-plan fix for the app team, not a Pulse setting.
- **Changing a mapping never loses data.** Raw events live in PostHog; the
  mapping only controls how Pulse counts them. Fix a mistake → Save → Sync
  now → everything recounts.
- **Clients see nothing until flagged on.** The client 📲 App page is behind
  the **App analytics** feature flag (Admin → Product → 🚩 Flags), default off
  while in beta. Flip it per client when their data looks right.
- Errors on the page show PostHog's real message — if one appears repeatedly,
  screenshot it for the Pulse team rather than retrying.

*Questions or a value that doesn't fit these patterns → Pulse team. Deeper
technical detail: `docs/specs/POSTHOG_APP_ANALYTICS_SPEC.md`.*
