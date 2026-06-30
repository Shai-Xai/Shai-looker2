// ─── Contact-list parsing — pasted text, uploaded CSV/Excel, and Google Sheets ──
// Extracted from server/actions.js (to keep it under its line budget). Pure text
// helpers shared by the paste/gsheet audience sources. The only shared dependency is
// EMAIL_RE (from audienceMap), so a parsed contact validates the same way everywhere.

const { EMAIL_RE } = require('./audienceMap');

// Parse a free-text contact list — ONE PERSON PER LINE. Within a line we pull out
// an email + a mobile + a name, so "John Smith, john@x.com, 083…" is one contact.
// A header row (no email/phone) is naturally skipped. Deduped by email-or-phone.
function parseContactLines(text) {
  const seen = new Set();
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const em = t.match(/[^\s,;|<>]+@[^\s,;|<>]+\.[^\s,;|<>]+/);
    const email = em ? em[0].toLowerCase().replace(/[.,;]+$/, '') : '';
    let rest = em ? t.replace(em[0], ' ') : t;
    const ph = rest.match(/\+?\d[\d\s().-]{6,}\d/);
    let phone = '';
    if (ph && ph[0].replace(/\D/g, '').length >= 7) { phone = ph[0].replace(/[^\d+]/g, ''); rest = rest.replace(ph[0], ' '); }
    const name = rest.replace(/[,;:|]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!email && !phone) continue; // a line with no contactable identifier (e.g. a header)
    const key = email || phone;
    if (seen.has(key)) continue;
    seen.add(key);
    // Uploaded/pasted/sheet lists carry no consent columns — reachable on whatever
    // identifier was provided (the uploader asserts they may contact them).
    out.push({ email, phone, name, emailOk: !!email, smsOk: !!phone });
  }
  return out;
}

// Minimal CSV parser — handles quoted fields (commas/quotes/newlines inside "…").
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let inQ = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i += 1; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
// The header (column names) of a delimited list — powers the column-mapping UI.
function csvHeader(text) {
  const rows = parseCsv(text);
  return rows.length ? rows[0].map((h) => h.trim()).filter(Boolean) : [];
}
// Parse a delimited list BY MAPPED COLUMN (header names) rather than the per-line
// heuristic. Returns null when there's no usable mapping (caller then falls back
// to parseContactLines). Lets a user pin which column is email/name/mobile when
// auto-detect would otherwise grab the wrong one (an order id read as a phone, …).
function parseContactTable(text, { emailField, nameField, phoneField } = {}) {
  if (!emailField && !phoneField) return null;
  const rows = parseCsv(text);
  if (rows.length < 2) return null;
  const rawHeader = rows[0].map((h) => h.trim());
  const header = rawHeader.map((h) => h.toLowerCase());
  const col = (n) => (n ? header.indexOf(String(n).trim().toLowerCase()) : -1);
  const ei = col(emailField); const pi = col(phoneField); const ni = col(nameField);
  if (ei < 0 && pi < 0) return null; // mapped column(s) not in the header → fall back
  const seen = new Set();
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const rawEmail = ei >= 0 ? String(cells[ei] || '').trim().toLowerCase() : '';
    const email = EMAIL_RE.test(rawEmail) ? rawEmail : '';
    let phone = '';
    if (pi >= 0) { const d = String(cells[pi] || '').replace(/[^\d+]/g, ''); if (d.replace(/\D/g, '').length >= 7) phone = d; }
    const name = ni >= 0 ? String(cells[ni] || '').trim() : '';
    if (!email && !phone) continue;
    const key = email || phone;
    if (seen.has(key)) continue;
    seen.add(key);
    // Keep EVERY column as an attribute (ticket type, city, age, gender…) so the
    // list can be targeted/filtered on them, keyed by the original header name.
    const attributes = {};
    for (let c = 0; c < rawHeader.length; c++) if (rawHeader[c]) attributes[rawHeader[c]] = String(cells[c] || '').trim();
    out.push({ email, phone, name, emailOk: !!email, smsOk: !!phone, attributes });
  }
  return out;
}

// A Google Sheets link → its CSV export URL (works when the sheet is shared
// "anyone with the link" or published to web — no OAuth needed).
function googleSheetCsvUrl(url) {
  const m = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) return '';
  const g = String(url).match(/[#&?]gid=(\d+)/);
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${g ? g[1] : '0'}`;
}
async function fetchGoogleSheetCsv(url) {
  const csvUrl = googleSheetCsvUrl(url);
  if (!csvUrl) throw new Error('That doesn’t look like a Google Sheets link.');
  const res = await fetch(csvUrl, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
  const text = res.ok ? await res.text() : '';
  // A non-public sheet returns 401/403 or an HTML sign-in page rather than CSV.
  if (!res.ok || /^\s*<(!doctype|html)/i.test(text)) {
    throw new Error('Couldn’t read that sheet — set its sharing to “anyone with the link” (or publish it to the web).');
  }
  return text;
}

module.exports = { parseContactLines, parseCsv, csvHeader, parseContactTable, googleSheetCsvUrl, fetchGoogleSheetCsv };
