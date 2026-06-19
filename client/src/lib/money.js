// Rand formatting for settlement reports. Negative amounts keep the minus in
// front of the R, matching the source PDFs ("-R16,747.20").
export function fmtR(n, { compact } = {}) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (compact) {
    if (a >= 1e6) return `${sign}R${(a / 1e6).toFixed(2)}m`;
    if (a >= 1e3) return `${sign}R${(a / 1e3).toFixed(1)}k`;
  }
  return `${sign}R${a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtQty(n) {
  if (n == null || !Number.isFinite(Number(n))) return '';
  return Number(n).toLocaleString('en-US');
}

// Derive a ticket "category" (Main Arena, Golden Lounge, Children…) from a line
// item's description — the settlement PDF doesn't carry an explicit category,
// so we parse it out of the name. Fees/refunds/resale get their own buckets.
export function deriveCategory(desc) {
  const d = String(desc || '').trim();
  if (!d) return 'Other';
  if (/resale/i.test(d)) return 'Resale';
  if (/cancel/i.test(d)) return 'Cancellations';
  if (/\brefund/i.test(d)) return 'Refunds';
  if (/\b(booking|service|processing)\s+fee/i.test(d)) return 'Fees';
  // The tier/phase lives after " - "; the category is the head, minus the
  // generic pass words ("3-day Full Fest …") and any "(6-12)" qualifier.
  let head = d.split(/\s[-–]\s/)[0]
    .replace(/^\d+\s*-?\s*day\b/i, '')
    .replace(/\b(full|fest|festival|pass|ticket|tickets|weekend|day|early\s*bird)\b/gi, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\+.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return head || 'Other';
}

// Derive the sub-category (the phase / tier / price band) from a line item —
// the part after the category, e.g. "Phase 1", "Early Bird". Cashless-credit
// variants and "(6-12)" qualifiers collapse onto the same phase so, say,
// "Phase 1" and "Phase 1 + E500 Cashless Credits" group together.
export function deriveSubCategory(desc) {
  const d = String(desc || '').trim();
  const parts = d.split(/\s[-–]\s/);
  if (parts.length < 2) return ''; // no phase component (fees, resale, etc.)
  const sub = parts.slice(1).join(' – ')
    .replace(/\s*\+\s*E\s*\d[\d,]*\s*Cashless Credits/ig, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return sub;
}

// The variant detail that distinguishes line items within the same phase —
// the cashless add-on if present, otherwise the base tier. Used as the leaf
// label so same-named, different-priced rows stay readable.
export function variantLabel(desc) {
  const d = String(desc || '').trim();
  const m = d.match(/\+\s*E\s*\d[\d,]*\s*Cashless Credits/i);
  if (m) return '+ ' + m[0].replace(/^\+\s*/, '');
  const paren = d.match(/\([^)]*\)/);
  if (paren) return paren[0];
  return 'Base';
}
