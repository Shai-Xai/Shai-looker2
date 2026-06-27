# Howler : Pulse — Release Notes
**11 June 2026 · the 24-hour build · howler-pulse-v2.onrender.com**

Everything below shipped in the last 24 hours (46 releases): a personalised, AI-briefed home page; interactive settlement reports and invoices; dashboard tabs with swipe; and a full visual overhaul with dark mode — all live in production.

---

## 🦉 Meet the Owl — your AI analyst

- **Personalised home briefing.** The landing page now opens with the Owl's read of your account: *"Howzat, Shai 👋 — here's what changed since your last visit."* A grounded, quantitative briefing built from your live dashboard data — headline story, key bullets, and "Worth a look" cards that deep-link straight to the right dashboard and tab.
- **Grounded by design.** The Owl only speaks to numbers pulled live from your dashboards (values, charts *and* tables, swept across your whole catalogue). It cannot invent figures, and every link it offers is validated against your real dashboards.
- **It learns what you check.** Pulse tracks which dashboards you open; the briefing prioritises what you actually use, "Your shortcuts" surface your most-visited dashboards, and "since your last visit" framing is computed from your own sessions.
- **Event-phase aware.** Every event moves through phases — Pre Launch, Launch, Artist Drops, Mid Campaign, Build Up (final 7 days), Event Day, Day After, Post Event. Set your event's key dates once and the briefing automatically changes its focus as the campaign progresses. Each phase's instructions are editable globally (Howler) and per event (you).
- **Time-of-day aware.** Morning briefings recap what happened overnight and set up the day; midday tracks how today is pacing; evening wraps the day and looks at tomorrow.
- **Tune it yourself.** The ⚙ Tune button on the briefing lets you set your personal focus ("always mention resale"), your event dates, the current phase, and per-phase wording — no developer needed.
- **Pin & Follow on any tile.** Hover any dashboard tile (tap ⋯ on mobile): **📌 Pin** puts the live tile on your home page (uniform cards in a swipeable strip); **👁 Follow** tells the Owl it must cover that tile in every briefing.
- **Feedback loop.** Under every briefing: ♥ if it's useful, 👎 with a note if something's off, or **🔍 Investigate** to ask Howler to dig into the data — your note arrives with the exact briefing attached.
- **AI insights everywhere, owl-branded.** Per-tile insights, whole-dashboard summaries, and follow-up chat — now streaming live with the animated Howler owl mark throughout.

## 🧾 Settlements & Invoices — interactive, not PDFs

- **A new Settlements section** in the sidebar: every event's settlement reports as interactive pages — KPI strip, a "where the money went" waterfall (turnover → fees → advances → value due), searchable ticket-sales tables with category and phase roll-ups, commission breakdown with mix chart, and a payments timeline.
- **Weekly vs Final** settlement types, **Ticketing vs Cashless** report kinds — grouped by event, with the final report as the headline card and weeklies as a history list.
- **Notes on every section** (collaborative — you and Howler see the same notes) plus a notes summary; **Ask the Owl** works on the settlement itself.
- **Invoices, rendered.** Uploaded Howler invoices become interactive views — totals, line items, payment details — with the original PDF embedded and downloadable. Every number is cross-checked against the document before publishing.

## 🧭 Navigation, redesigned

- **Dashboard tabs.** Related dashboards now appear as tabs inside a parent (e.g. Overview · Daily Sales · Ticket Types · Pricing) — switching is instant, the header stays put, and on mobile you can **swipe left/right** between tabs.
- **Sidebar upgrades:** search across all suites and dashboards, remembered expand state, tab-count badges, tighter layout.
- **Profile in the bottom-left** with Integrations, dark-mode toggle and log out — the top header is clean.
- Round **home button**, smarter mobile header, and a combined Summary + Filters bar on phones.

## 🎨 Design & experience

- **Full motion design system:** staggered tile entrances, count-up KPIs, skeleton loading, sliding nav indicator, animated AI panels with gradient borders, micro-interactions throughout — all respecting reduced-motion settings.
- **Dark mode**, end to end — dashboards, tables, charts, settlements, admin.
- **Mobile polish:** bottom-sheet filters with drag-to-dismiss, swipeable pinned-tile strip, quiet tile icons behind a single ⋯, branded loading splash (no more blank screens).

## ⚙️ For the Howler team (admin)

- **Per-client workspace:** each client now has Settings, Suites, **Briefing** (event dates, phases, instructions, that client's feedback), **Settlements** (upload → AI extraction with live progress → cross-checked totals → publish), invoices, logins and integrations in one place.
- **AI controls:** global AI instructions, briefing rules, editable phase and time-of-day defaults, and a feedback inbox (with Investigate requests) under Admin → AI.
- **Sets editor:** "Tab of" control turns any dashboard into a sub-dashboard tab; reusable tile library; client preview that's fully scoped to one client.
- **Backup & restore** covers everything new (settlements, invoices, marks, feedback, view history).

## 🚀 Reliability

- Eliminated the blank-screen-on-load issue for good (cache headers + branded boot splash + an app-wide safety net that shows a Reload screen instead of a white page).
- AI text now streams live through the production proxy (insights, summaries, extraction progress).
- Fixed: organiser locks not applying on dashboards that name their filters differently, settlement/invoice scoping in client preview, briefing Refresh re-serving cached data, chart tiles failing when value labels are on, and two admin crashes.
- Hard security boundary maintained throughout: every query is force-scoped to the client's organiser — including everything the Owl reads.
- All new data (settlements, invoices, pins/follows, feedback, view history) is covered by Backup & Restore, and the AI/query layers are caching-bounded to scale comfortably to 50–100 clients.

---

### Getting the most out of it (2 minutes per client)
1. **Set event dates** — home → briefing ⚙ Tune (or Admin → Client → Briefing): on-sale date + event dates. Phases take over from there.
2. **Follow 2–3 tiles** that matter most — the Owl will never skip them.
3. **Pin your vital signs** — they'll live on your home page.
4. **React to briefings** — ♥ / 👎 / 🔍 feedback goes straight to Howler and makes the Owl sharper.
