# Sales collateral — Pulse pitch pack

Client-facing pitch assets built from [`docs/PRODUCT_OVERVIEW_SALES.md`](../PRODUCT_OVERVIEW_SALES.md)
(statuses honest as of 2026-07-09). Regenerate whenever the overview's feature
statuses change materially.

| File | What it is |
|---|---|
| `Pulse-Sales-Pitch.pdf` | 3-page leave-behind PDF: the loop, feature pillars, comparison table, CTA. |
| `Pulse-Sales-Deck.pptx` | 10-slide pitch deck (16:9). **To get the Google Slides version:** upload to [Google Drive](https://drive.google.com) → double-click → it opens/converts as Google Slides. |
| `pulse-pitch.src.html` | Source for the PDF. Edit, then render: `chromium --headless --no-sandbox --print-to-pdf=Pulse-Sales-Pitch.pdf --no-pdf-header-footer pulse-pitch.src.html` |
| `make-deck.src.js` | Source for the deck. Edit, then: `npm i pptxgenjs && node make-deck.src.js` |

Status tags used in the assets mirror the overview's key: LIVE · BETA ·
NEEDS SETUP/CONNECTION. Keep them honest — don't overclaim.
