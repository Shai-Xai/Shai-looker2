// AI content language — the client mirror of server/language.js. The language
// Pulse's AI WRITES generated copy in (briefings, digests, insights, campaign
// copy, the Owl). It steers AI prose only — it does NOT translate the app's own
// UI chrome. Used by the admin language picker. Keep in sync with server/language.js.

export const DEFAULT_LANGUAGE = 'en';

// code → English name → endonym (native name). English first; then the languages
// Howler clients are most likely to want.
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

// The list for a <select> picker: [{ code, name, native }].
export const languageList = () => LANGUAGES.map(([code, name, native]) => ({ code, name, native }));
