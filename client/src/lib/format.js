// Value formatting helpers that mirror Looker as closely as possible.
//
// Looker's json_detail already returns a `rendered` string per cell that
// respects the field's LookML value_format — so for anything we display as
// text we prefer `rendered`. For places where we only have a raw number
// (chart axes, computed tooltips) we parse the field's value_format string.

// Text for a table/single-value cell: prefer Looker's rendered string.
export function cellText(cell) {
  if (cell == null) return '∅';
  if (cell.rendered != null && cell.rendered !== '') return cell.rendered;
  if (cell.value == null) return '∅';
  return String(cell.value);
}

// Format a raw number using a Looker/Excel-style value_format string.
// Handles prefixes/suffixes ($, R, etc.), thousands grouping, decimal places
// and percentages — the common cases. Falls back to locale formatting.
export function formatNumber(value, fmt) {
  if (value == null || value === '') return '∅';
  const num = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(num)) return String(value);
  if (!fmt) return num.toLocaleString();

  const isPct = fmt.includes('%');
  const work = fmt.replace(/%/g, '');
  const m = work.match(/[#0.,]+/);
  const pattern = m ? m[0] : '#,##0';
  const prefix = m ? work.slice(0, m.index) : '';
  const suffix = m ? work.slice(m.index + pattern.length) : '';

  const decimals = (pattern.split('.')[1] || '').length;
  const useGrouping = pattern.includes(',');

  const n = isPct ? num * 100 : num;
  const body = n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping,
  });
  return `${prefix}${body}${suffix}${isPct ? '%' : ''}`;
}

// Compact axis labels (1.2k, 3.4M) for dense charts, respecting any
// currency prefix from the value_format.
export function formatAxis(value, fmt) {
  if (value == null) return '';
  const num = Number(value);
  if (Number.isNaN(num)) return String(value);
  const prefix = fmt ? (fmt.match(/^[^#0.,%-]+/)?.[0] || '') : '';
  const abs = Math.abs(num);
  if (fmt && fmt.includes('%')) return formatNumber(num, fmt);
  if (abs >= 1e9) return `${prefix}${(num / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${prefix}${(num / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${prefix}${(num / 1e3).toFixed(1)}k`;
  return `${prefix}${num.toLocaleString()}`;
}
