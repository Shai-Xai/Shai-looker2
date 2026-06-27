// ─── Reporting currency ──────────────────────────────────────────────────────
// A client's display/reporting currency — how Pulse PRESENTS and TALKS about
// money (symbol, grouping, and the currency the Owl writes amounts in). It is
// NOT a data filter and NOT the billing currency (server/billing.js handles what
// Howler charges for messages). Resolved through the branding chain
// (defaults ← platform ← client ← event) so it inherits and rides to the browser.
//
// ZAR is the platform default. The mirror of this table lives in
// client/src/lib/currency.js — keep the two in sync.

const DEFAULT = 'ZAR';

// Curated list (code → symbol, name, locale for grouping, decimal places).
// Ordered for the picker: ZAR first, then the currencies Howler clients are most
// likely to report in.
const CURRENCIES = [
  ['ZAR', 'R', 'South African Rand', 'en-ZA', 2],
  ['USD', '$', 'US Dollar', 'en-US', 2],
  ['EUR', '€', 'Euro', 'en-IE', 2],
  ['GBP', '£', 'British Pound', 'en-GB', 2],
  ['AUD', 'A$', 'Australian Dollar', 'en-AU', 2],
  ['NZD', 'NZ$', 'New Zealand Dollar', 'en-NZ', 2],
  ['CAD', 'C$', 'Canadian Dollar', 'en-CA', 2],
  ['NAD', 'N$', 'Namibian Dollar', 'en-NA', 2],
  ['BWP', 'P', 'Botswana Pula', 'en-BW', 2],
  ['KES', 'KSh', 'Kenyan Shilling', 'en-KE', 2],
  ['NGN', '₦', 'Nigerian Naira', 'en-NG', 2],
  ['GHS', 'GH₵', 'Ghanaian Cedi', 'en-GH', 2],
  ['TZS', 'TSh', 'Tanzanian Shilling', 'en-TZ', 2],
  ['UGX', 'USh', 'Ugandan Shilling', 'en-UG', 0],
  ['ZMW', 'K', 'Zambian Kwacha', 'en-ZM', 2],
  ['MUR', '₨', 'Mauritian Rupee', 'en-MU', 2],
  ['AED', 'AED', 'UAE Dirham', 'en-AE', 2],
  ['INR', '₹', 'Indian Rupee', 'en-IN', 2],
  ['SGD', 'S$', 'Singapore Dollar', 'en-SG', 2],
  ['HKD', 'HK$', 'Hong Kong Dollar', 'en-HK', 2],
  ['JPY', '¥', 'Japanese Yen', 'ja-JP', 0],
  ['CNY', '¥', 'Chinese Yuan', 'zh-CN', 2],
  ['BRL', 'R$', 'Brazilian Real', 'pt-BR', 2],
  ['MXN', 'MX$', 'Mexican Peso', 'es-MX', 2],
];

const BY_CODE = new Map(CURRENCIES.map(([code, symbol, name, locale, decimals]) => [code, { code, symbol, name, locale, decimals }]));

// Coerce any input to a known currency code; unknown/blank → the platform default.
function normalize(code) {
  const c = String(code || '').trim().toUpperCase();
  return BY_CODE.has(c) ? c : DEFAULT;
}
function info(code) { return BY_CODE.get(normalize(code)); }
function symbolFor(code) { return info(code).symbol; }

// Format a number as money in the given currency: "R1,234.00", "$1,234.00",
// "¥1,234". Symbol-prefixed; grouping/decimals follow the currency's locale.
function format(amount, code) {
  const cur = info(code);
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  // Deterministic comma/dot grouping (the symbol carries the locale), so money
  // reads the same everywhere: R1,234.50 · $1,234.50 · ¥1,000.
  const body = n.toLocaleString('en-US', { minimumFractionDigits: cur.decimals, maximumFractionDigits: cur.decimals });
  return `${cur.symbol}${body}`;
}

// One-line instruction appended to AI prompts so the Owl writes amounts in the
// client's currency. Empty for ZAR (the prompts already assume Rand), so default
// clients add nothing to the prompt.
function aiNote(code) {
  const c = normalize(code);
  if (c === DEFAULT) return '';
  const cur = info(c);
  return `Currency: this client reports in ${cur.name} (${cur.code}), NOT South African Rand. Express ALL monetary amounts in ${cur.code}, using the "${cur.symbol}" symbol — never relabel them as Rand or use "R".`;
}

// The list for a picker: [{ code, symbol, name }].
function list() { return CURRENCIES.map(([code, symbol, name]) => ({ code, symbol, name })); }

module.exports = { DEFAULT, normalize, info, symbolFor, format, aiNote, list, CURRENCIES };
