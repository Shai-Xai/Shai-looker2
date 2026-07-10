# Sales collateral — Pulse pitch pack

Client-facing pitch assets built from [`docs/PRODUCT_OVERVIEW_SALES.md`](../PRODUCT_OVERVIEW_SALES.md)
(statuses honest as of 2026-07-09). Regenerate whenever the overview's feature
statuses change materially.

| File | What it is |
|---|---|
| `Pulse-Sales-Pitch.pdf` | 7-page leave-behind PDF: the loop, feature pillars, Owl channel hub (app/WhatsApp/ChatGPT/Claude), marketer's dream, Event Ops command centre with live site-map heat view, the Howler One stack, comparison, CTA. Includes stylised product mockups (not real screenshots). |
| `Pulse-Sales-Pitch-Lite.pdf` | 6-page forwardable version: every section of the full pitch, but copy lightened to headline-level chips, all mechanics and the competitor table removed. Share this one by default; keep the full 7-pager for late-stage deep dives. |
| `Pulse-Sales-Deck.pptx` | 13-slide pitch deck (16:9). **To get the Google Slides version:** upload to [Google Drive](https://drive.google.com) → double-click → it opens/converts as Google Slides. |
| `Pulse-Sales-Deck-Lite.pptx` | 7-slide lite deck matching the lite PDF (outcomes only, no mechanics). Same Google Slides route: upload to Drive and double-click. |
| `pulse-pitch.src.html` | Source for the PDF. Edit, then render: `chromium --headless --no-sandbox --print-to-pdf=Pulse-Sales-Pitch.pdf --no-pdf-header-footer pulse-pitch.src.html` |
| `make-deck.src.js` | Source for the deck. Edit, then: `npm i pptxgenjs && node make-deck.src.js (needs sitemap-mockup.png as sitemap.png alongside)` |

Status tags were intentionally removed from the client-facing assets (v2); check
the overview before promising anything still in beta.
