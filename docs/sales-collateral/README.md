# Sales collateral — Pulse pitch pack

Client-facing pitch assets built from [`docs/PRODUCT_OVERVIEW_SALES.md`](../PRODUCT_OVERVIEW_SALES.md)
(statuses honest as of 2026-07-09). Regenerate whenever the overview's feature
statuses change materially.

| File | What it is |
|---|---|
| `Pulse-Sales-Pitch.pdf` | 6-page leave-behind PDF: the loop, feature pillars, channels, marketer's dream, Event Ops command centre, comparison, CTA. Includes stylised product mockups (not real screenshots). |
| `Pulse-Sales-Deck.pptx` | 12-slide pitch deck (16:9). **To get the Google Slides version:** upload to [Google Drive](https://drive.google.com) → double-click → it opens/converts as Google Slides. |
| `pulse-pitch.src.html` | Source for the PDF. Edit, then render: `chromium --headless --no-sandbox --print-to-pdf=Pulse-Sales-Pitch.pdf --no-pdf-header-footer pulse-pitch.src.html` |
| `make-deck.src.js` | Source for the deck. Edit, then: `npm i pptxgenjs && node make-deck.src.js` |

Status tags were intentionally removed from the client-facing assets (v2); check
the overview before promising anything still in beta.
