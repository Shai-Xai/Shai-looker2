# Spec — Digest & briefing personalisation (generalised + per-user)

> Status: **draft for review** · Owner: (tbd) · Relates to: digest feedback loop
> (shipped 2026-06-17), roadmap 1.3 (precompute briefings in background). North
> Star: `docs/EXPERIENCE_OS_BRIEF.md`. This records the direction for making
> digests both **standardised** (a shared house style) and **personalised per
> reader** — not a commitment to build now.

## 1. Problem
A scheduled digest is generated **once per job** and emailed identically to its
whole recipient list; personalisation stops at the **role lens**
(exec/marketing/finance/ops). The feedback loop we just shipped distils feedback
into a **client-level** preferences note — so **one person's feedback tunes
everyone's** digest. We want a model where digests share a generalised base **and**
adapt to the individual reader, without losing consistency or blowing up cost.

## 2. What already exists (build on, don't rebuild)
- **The home briefing is already per-user** — each reader has a personal `tune`
  (free-text standing requests) + focus tiles, generated individually
  (`generateBriefing`, `briefing_tune:<entityId>` user-pref).
- **Instruction layers** already cascade (global → client `aiContext` → event →
  role lens → phase/time → reader tune) via `briefingInstructionsFor`, used by
  **both** the briefing and the digest.
- **Feedback is already attributed to the individual** — the in-email links are
  per-recipient (signed token carries the email), and `digest_feedback` rows store
  `email`. We currently *pool* it at client level; the per-user signal is banked.
- The distilled **client preferences note** (`digest_prefs:<entityId>`) is injected
  into both digest + briefing generation today.

So the machinery for per-user exists for briefings; the gap is (a) wiring it to
**scheduled digests** and (b) **routing feedback** to the right layer.

## 3. Target model — a preference cascade
Most-general → most-specific; each layer **adds** on top (more specific wins on
conflicts). The UI shows what's inherited vs personal (the standard "blank inherits
the tier below" pattern).

1. **Platform** — global standing instructions.
2. **Client / entity** — the shared, **AM-curated** house style (today's
   `digest_prefs` note, but curated rather than silently auto-applied).
3. **Role lens** — exec / marketing / finance / ops framing.
4. **Event** — phase + timing context.
5. **Per-user** — the reader's own tune + **their** distilled feedback. *(new for
   digests; already real for briefings)*

End state: a scheduled digest is *"the per-user briefing, role-lensed, scheduled
and emailed"* — one personalisation model for both surfaces.

## 4. Two decisions that make it work
- **Feedback routing by author.** A recipient's feedback feeds **their** per-user
  layer by default. An AM (or the user) can **promote** a genuinely general insight
  up to the shared client layer. This flips today's behaviour: one person reshapes
  everyone's digest only **on purpose**, never silently.
- **Generation strategy (cost/perf).** Generate the **shared base once**; only
  re-generate for recipients who actually have a personal delta (most won't), and
  cache. Pairs with roadmap **1.3 (precompute in background)** so personalised
  digests don't inflate send time or AI spend.

## 5. Data model (mostly already present)
- `digest_feedback.email` — per-recipient attribution. **Present.**
- **New (when built):** `digest_prefs` becomes two tiers —
  - `digest_prefs:<entityId>` (shared, AM-curated) — exists.
  - `user_digest_prefs:<userId>:<entityId>` (per-user distilled note) — new, mirrors
    the existing `briefing_tune` user-pref.
- Scheduled jobs gain an optional **`personalise`** flag (off = today's shared send;
  on = per-recipient generation for recipients who have a personal layer).

## 6. Distillation routing (when built)
- Per-user feedback → distils into that user's `user_digest_prefs`.
- Feedback an AM marks "applies to everyone" → distils into the shared client note.
- Both notes are **editable**; provenance is shown ("learned from N items").

## 7. Phased path
1. **Now (shipped):** client-level feedback loop; per-user feedback **banked**
   (attributed) but pooled.
2. **Per-user briefing parity:** ensure the briefing's per-user tune + feedback
   distillation is solid (it largely is).
3. **Per-user digest generation:** add the `personalise` job flag + shared-base +
   per-recipient delta generation + cache.
4. **Feedback routing + promotion:** split distillation into per-user vs shared;
   AM promotion UI.
5. **Precompute (roadmap 1.3):** background-generate so personalised sends stay fast.

## 8. Near-term posture (until per-user lands)
- **Keep the auto-distil loop on** — it's genuinely useful for a small, aligned
  team, and the note is AM-editable.
- **Per-user feedback is already attributed and banked**, so the eventual per-user
  build starts with real history — nothing is lost.
- If silent "one-applies-to-all" becomes a concern before per-user ships, the cheap
  interim is to make the shared note **AM-reviewed** (distil → proposed → confirm)
  rather than auto-live.

## 9. Open questions
- **Who tunes per-user:** the reader (self-service, like the briefing tune), the AM
  on their behalf, or both? (Lean: both — dual-surface.)
- **Default personalisation:** opt-in per job, or on by default once a reader has a
  personal layer? (Lean: automatic when a personal delta exists.)
- **Consistency guardrails:** cap how far a per-user layer can diverge from the
  house style? (Lean: per-user *adds emphasis*, can't drop compliance/house basics.)
- **Cost ceiling:** max personalised generations per send before falling back to the
  shared base? (Decide with 1.3.)
