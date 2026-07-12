# Sales collateral — Pulse pitch pack

Client-facing pitch assets built from [`docs/PRODUCT_OVERVIEW_SALES.md`](../PRODUCT_OVERVIEW_SALES.md)
(statuses honest as of 2026-07-09). Regenerate whenever the overview's feature
statuses change materially.

| File | What it is |
|---|---|
| `Pulse-Sales-Pitch-mc-v{1,2,3}.pdf` | **Milk & Cookies board deck** — versioned; **v6 is current**. The loop, the Howler One stack, See/Ask, the channel hub, marketer's dream, Event Ops with live site-map heat view, comparison, CTA. v3 is a 9-page skim-friendly rework with two full-bleed breather pages; v4 stripped box-shadows; v5 added the real WhatsApp/ChatGPT/Claude logos; v6 replaced gradient-clipped headline text with solid colour (it exports as an opaque gradient block in iOS PDF viewers). v4 note: box-shadows stripped (they render as hard grey rectangles in some PDF viewers, e.g. macOS Preview and the Drive preview). Public-safe (no vendor/URL/architecture/maturity/roadmap). Carries M&C's real numbers, so it is M&C-specific — do not forward to another prospect. |
| `Pulse-Sales-Pitch-Lite.pdf` | 6-page forwardable version: every section of the full pitch, but copy lightened to headline-level chips, all mechanics and the competitor table removed. Share this one by default; keep the full 7-pager for late-stage deep dives. |
| `Pulse-Sales-Deck.pptx` | 13-slide pitch deck (16:9). **To get the Google Slides version:** upload to [Google Drive](https://drive.google.com) → double-click → it opens/converts as Google Slides. |
| `Pulse-Sales-Deck-Generic.pptx` | The 13-slide deck with no client data: no prepared-for line, and the dashboard mockup uses fictional "Aurora Fest" numbers (dash-generic.png). Safe for any prospect or cold outreach. |
| `Pulse-Sales-Deck-Lite.pptx` | 7-slide lite deck matching the lite PDF (outcomes only, no mechanics). Same Google Slides route: upload to Drive and double-click. |
| `pulse-pitch-mc-v{1,2,3}.src.html` + `build-pulse-pitch-mc-v{1,2,3}.sh` | Source + build script, one pair per version. **Never edit a version in place** — copy it to the next number. Build a version with its script, e.g. `./build-pulse-pitch-mc-v3.sh` → `Pulse-Sales-Pitch-mc-v3.pdf`. |
| `make-deck.src.js` | Source for the deck. Edit, then: `npm i pptxgenjs && node make-deck.src.js (needs sitemap-mockup.png as sitemap.png alongside)` |

Status tags were intentionally removed from the client-facing assets (v2); check
the overview before promising anything still in beta.
