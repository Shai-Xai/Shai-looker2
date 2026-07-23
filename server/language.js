// ─── AI content language ──────────────────────────────────────────────────────
// The language Pulse's AI WRITES in for a client — briefings, digests, per-tile
// insights, goal reads, alert notes, and campaign copy (the Owl too). It steers
// only AI-GENERATED prose; it does NOT translate the app's own UI chrome (buttons,
// labels) — that's a separate, larger i18n job. Resolved through the branding chain
// (defaults ← platform ← client ← event) so it inherits and rides like the rest of
// the brand. English is the platform default (the prompts are written in English),
// so default clients add nothing to the prompt.
//
// The mirror of this list lives in client/src/lib/language.js — keep the two in sync.

const DEFAULT = 'en';

// Curated list (code → English name → endonym/native name). English first, then the
// languages Howler clients are most likely to want — South Africa's officials, then
// the common international ones. Endonym is shown in the picker so a client recognises
// their own language.
const LANGUAGES = [
  ['en', 'English', 'English'],
  ['af', 'Afrikaans', 'Afrikaans'],
  ['zu', 'Zulu', 'isiZulu'],
  ['xh', 'Xhosa', 'isiXhosa'],
  ['st', 'Sotho', 'Sesotho'],
  ['tn', 'Tswana', 'Setswana'],
  ['fr', 'French', 'Français'],
  ['pt', 'Portuguese', 'Português'],
  ['es', 'Spanish', 'Español'],
  ['de', 'German', 'Deutsch'],
  ['nl', 'Dutch', 'Nederlands'],
  ['it', 'Italian', 'Italiano'],
  ['sw', 'Swahili', 'Kiswahili'],
  ['ar', 'Arabic', 'العربية'],
  ['zh', 'Chinese', '中文'],
];

const BY_CODE = new Map(LANGUAGES.map(([code, name, native]) => [code, { code, name, native }]));

// Coerce any input to a known language code; unknown/blank → the platform default.
function normalize(code) {
  const c = String(code || '').trim().toLowerCase();
  return BY_CODE.has(c) ? c : DEFAULT;
}
function info(code) { return BY_CODE.get(normalize(code)); }

// One-line instruction appended to AI prompts so every piece of generated copy is
// written in the client's language. Empty for English (the prompts already are), so
// default clients add nothing. Numbers/currency formatting are unaffected.
function aiNote(code) {
  const c = normalize(code);
  if (c === DEFAULT) return '';
  const lang = info(c);
  return `Language: write ALL of your generated prose — every heading, sentence and call-to-action — in ${lang.name} (${lang.native}), NOT English. Keep proper nouns (event names, brand names, ticket-type names) and any code/URLs exactly as given; translate everything else naturally and idiomatically, as a native ${lang.name} speaker would write it.`;
}

// The list for a picker: [{ code, name, native }].
function list() { return LANGUAGES.map(([code, name, native]) => ({ code, name, native })); }

module.exports = { DEFAULT, normalize, info, aiNote, list, LANGUAGES };
