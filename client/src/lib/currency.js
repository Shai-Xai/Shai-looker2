// Reporting currency — the client mirror of server/currency.js. How Pulse shows
// and talks about money (symbol, grouping). NOT a data filter, NOT the billing
// currency. Resolved through the brand engine (see brand.js useCurrency()).
// Keep this table in sync with server/currency.js.

export const DEFAULT_CURRENCY = 'ZAR';

// code → symbol, name, locale (grouping), decimals. ZAR first; ordered for the picker.
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

export function normalizeCurrency(code) {
  const c = String(code || '').trim().toUpperCase();
  return BY_CODE.has(c) ? c : DEFAULT_CURRENCY;
}
export function currencyInfo(code) { return BY_CODE.get(normalizeCurrency(code)); }
export function currencySymbol(code) { return currencyInfo(code).symbol; }

// Format a number as money in the given currency: "R1,234.00", "$1,234.00".
// Symbol-prefixed; grouping/decimals follow the currency's locale.
export function formatMoney(amount, code) {
  const cur = currencyInfo(code);
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  // Deterministic comma/dot grouping (symbol carries the locale): R1,234.50 · $1,234.50.
  const body = n.toLocaleString('en-US', { minimumFractionDigits: cur.decimals, maximumFractionDigits: cur.decimals });
  return `${cur.symbol}${body}`;
}

// The list for a <select> picker: [{ code, symbol, name }].
export const currencyList = () => CURRENCIES.map(([code, symbol, name]) => ({ code, symbol, name }));
