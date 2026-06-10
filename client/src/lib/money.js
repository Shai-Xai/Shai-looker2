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
