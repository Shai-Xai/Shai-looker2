// ─── Audience person-mapping — shared by the campaign engine + Owl segments ────
// Extracted from server/actions.js so (a) actions.js stays under its line budget and
// (b) chat-created "query" segments reuse the EXACT same dedupe + per-channel consent
// + reach logic real campaigns use — no second implementation to drift. Pure: no DB,
// no scope (the caller resolves rows under the hard scope gate first).
//
// A "row" is a Looker json_detail cell map ({ [field]: { value } } or a plain object);
// cellVal copes with both. `member` shape: { email, name, ticket, phone, anchorRaw,
// emailOk, smsOk, attributes }.

const MAX_AUDIENCE = 2000;       // v1 safety cap per campaign
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cellVal = (cell) => String((cell && (cell.value ?? cell)) || '').trim();
const isYes = (v) => ['yes', 'y', 'true', '1', 'consented', 'opted in', 'opt in'].includes(String(v).trim().toLowerCase());

// rows → shaped recipients (with per-channel consent tagged). Mirrors the tile branch
// of audienceFor verbatim. `opts`: { emailField, nameField, phoneField, ticketField,
// anchorField, emailConsentField, smsConsentField, ignoreConsent, fields, attrFields,
// attrMap, rowPassesFilters, filters }. Returns { raw, filteredOut }.
function buildRows(rows, opts = {}) {
  const {
    emailField, nameField, phoneField, ticketField, anchorField,
    emailConsentField, smsConsentField, ignoreConsent,
    fields = [], attrFields = [], attrMap = null, rowPassesFilters, filters = [],
  } = opts;
  const raw = [];
  let filteredOut = 0;
  if (!emailField) return { raw, filteredOut };
  for (const row of rows || []) {
    const email = cellVal(row[emailField]).toLowerCase();
    if (!EMAIL_RE.test(email)) continue;
    // Merge the attributes row (if any) so filters can read its columns.
    const merged = attrMap ? { ...row, ...(attrMap.get(email) || {}) } : row;
    // Targeting filters (city/age/ticket category/lifetime spend/…).
    if (filters.length && rowPassesFilters && !rowPassesFilters(merged, filters)) { filteredOut += 1; continue; }
    // Per-channel consent: don't drop — tag each channel so reach can be shown and
    // consent enforced per channel at send. ignoreConsent bypasses (transactional).
    const phone = phoneField ? cellVal(row[phoneField]) : '';
    const emailOk = ignoreConsent || !emailConsentField || isYes(cellVal(row[emailConsentField]));
    const smsOk = ignoreConsent || !smsConsentField || isYes(cellVal(row[smsConsentField]));
    // Every column as a merge-field attribute (by field label AND name).
    const attributes = {};
    for (const fl of [...fields, ...attrFields]) { const v = cellVal(merged[fl.name]); attributes[fl.name] = v; if (fl.label) attributes[fl.label] = v; }
    raw.push({ email, name: nameField ? cellVal(row[nameField]) : '', ticket: ticketField ? cellVal(row[ticketField]) : '', phone, anchorRaw: anchorField ? cellVal(row[anchorField]) : '', emailOk, smsOk, attributes });
  }
  return { raw, filteredOut };
}

// Dedupe (by email-or-phone) + suppression + per-channel reach. `suppressed` is a Set
// of suppressed emails. Mirrors the shared tail of audienceFor verbatim.
function finalizeAudience(raw, suppressed) {
  const sup = suppressed || new Set();
  const seen = new Set();
  const list = [];
  let excluded = 0;
  for (const r of raw || []) {
    const key = r.email || r.phone; // phone-only recipients have no email
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (r.email && sup.has(r.email)) { excluded += 1; continue; }
    list.push(r);
    if (list.length >= MAX_AUDIENCE) break;
  }
  // Per-channel reach (consent-aware) — surfaced at preview, enforced at send.
  const reach = {
    total: list.length,
    email: list.filter((r) => r.email && r.emailOk).length,
    sms: list.filter((r) => r.phone && r.smsOk).length,
  };
  // noConsent = contactable but reachable on no channel.
  const noConsent = list.filter((r) => !(r.email && r.emailOk) && !(r.phone && r.smsOk)).length;
  return { list, excluded, noConsent, reach };
}

module.exports = { MAX_AUDIENCE, EMAIL_RE, cellVal, isYes, buildRows, finalizeAudience };
