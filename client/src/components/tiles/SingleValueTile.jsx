import { cellText, formatNumber } from '../../lib/format.js';
import { useDrill } from '../../lib/DrillContext.jsx';
import { useIsMobile } from '../../lib/useIsMobile.js';
import { useCountUp } from '../../lib/useCountUp.js';
import AutoFitText from '../AutoFitText.jsx';

// The big number, animated. A hidden copy of the FINAL text reserves the full
// width (so AutoFitText sizes the font to the finished number, not the small
// in-flight one); the animating value paints on top with tabular digits.
function CountUpValue({ text }) {
  const display = useCountUp(text);
  if (display === text) return text;
  return (
    <span style={{ position: 'relative', display: 'inline-block', fontVariantNumeric: 'tabular-nums' }}>
      <span style={{ visibility: 'hidden' }}>{text}</span>
      <span style={{ position: 'absolute', inset: 0, textAlign: 'center', whiteSpace: 'nowrap' }}>{display}</span>
    </span>
  );
}

// Single value / KPI tile. Mirrors Looker's single_value visualization:
// big rendered value, optional custom color, optional comparison to a second
// measure (value or % change) with a coloured up/down indicator.
export default function SingleValueTile({ data, visConfig = {}, label }) {
  const { openDrill, canDrill } = useDrill();
  const isMobile = useIsMobile();
  const fields = data.fields || {};
  const rows = data.data || [];
  if (!rows.length) return <Empty />;

  // Looker hides some fields (e.g. a raw measure) and displays only the visible
  // one (often a table calculation like "% change"). Honour hidden_fields so we
  // show the field the tile is actually configured to display.
  const hidden = new Set(visConfig.hidden_fields || []);
  const measures = [...(fields.measures || []), ...(fields.table_calculations || [])].filter((f) => !hidden.has(f.name));
  const dimensions = (fields.dimensions || []).filter((f) => !hidden.has(f.name));
  const allFields = [...measures, ...dimensions];

  const primaryField = measures[0] || allFields[0];
  if (!primaryField) return <Empty />;

  const pivots = data.pivots || [];
  const primaryCell = resolvePivotCell(rows[0][primaryField.name], pivots);
  const primaryValue = cellText(primaryCell);

  // Comparison against a second measure, when present and not disabled.
  const compField = measures[1] || null;
  const showComparison = compField && visConfig.show_comparison !== false;
  let comparison = null;
  if (showComparison) {
    const compCell = resolvePivotCell(rows[0][compField.name], pivots);
    const a = Number(primaryCell?.value);
    const b = Number(compCell?.value);
    const label = visConfig.comparison_label || `vs ${compField.label_short || compField.label}`;
    const arrowColour = (positive) => ((visConfig.comparison_reverse_colors ? !positive : positive) ? '#10b981' : '#ef4444');

    // Looker only computes a PERCENT change when the comparison is explicitly a
    // 'change' type AND its field is a plain measure used as the baseline. In
    // every other case — the default, comparison_type 'value', or a table-calc
    // that already IS the delta (e.g. "−12 vs previous day") — Looker shows the
    // comparison field's own value verbatim. Recomputing (a−b)/|b| there flips
    // the sign and inflates the number (the "266.7%" bug), so we mirror Looker
    // and display the rendered value directly.
    const compIsTableCalc = (fields.table_calculations || []).some((tc) => tc.name === compField.name);
    const wantsPctChange = visConfig.comparison_type === 'change' && !compIsTableCalc;

    if (wantsPctChange && !Number.isNaN(a) && !Number.isNaN(b) && b !== 0) {
      const pct = (a - b) / Math.abs(b);
      const up = pct >= 0;
      comparison = { text: `${up ? '▲' : '▼'} ${formatNumber(Math.abs(pct), '0.0%')}`, color: arrowColour(up), label };
    } else {
      // Show the comparison field's own value exactly as Looker renders it.
      const shown = (compCell?.rendered != null && compCell.rendered !== '') ? String(compCell.rendered) : cellText(compCell);
      if (!Number.isNaN(b) && b !== 0) {
        comparison = { text: `${b > 0 ? '▲' : '▼'} ${shown}`, color: arrowColour(b > 0), label };
      } else {
        comparison = { text: shown, color: 'var(--muted)', label };
      }
    }
  }

  const color = visConfig.custom_color_enabled && visConfig.custom_color
    ? visConfig.custom_color
    : visConfig.value_color || 'var(--text)';

  // Looker conditional formatting → colour the whole tile + text.
  const cf = evalConditionalFormatting(visConfig.conditional_formatting, primaryField, primaryCell);
  const valueColor = cf?.font || color;
  const labelColor = cf?.font || 'var(--muted)';

  // Looker shows the label *below* the number. Use the tile title (passed in)
  // or an explicit single_value_title override.
  const labelText = visConfig.show_single_value_title !== false
    ? (visConfig.single_value_title || label || null)
    : null;

  const drillable = canDrill(primaryCell?.links);

  return (
    <div style={{ ...wrap, ...(cf?.background ? { background: cf.background } : null) }}>
      <AutoFitText
        max={isMobile ? 34 : 22}
        min={isMobile ? 14 : 11}
        style={{ flex: 1, minHeight: isMobile ? 30 : 22 }}
        onClick={drillable ? () => openDrill(primaryCell.links, primaryField.label_short || primaryField.label) : undefined}
        spanStyle={{
          fontWeight: cf?.bold ? 800 : 700, color: valueColor, letterSpacing: '-0.5px',
          ...(drillable ? { textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 4 } : null),
        }}
      >
        <CountUpValue text={primaryValue} />
      </AutoFitText>
      {comparison && (
        <div className="chip-in" style={{ fontSize: 12.5, marginTop: 3, fontWeight: 600, color: comparison.color, flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%', animationDelay: '420ms' }}>
          {comparison.text}
          <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6 }}>{comparison.label}</span>
        </div>
      )}
      {labelText && (
        <div className="chip-in" style={{ fontSize: 13, color: labelColor, marginTop: 3, fontWeight: 500, lineHeight: 1.2, textAlign: 'center', overflow: 'hidden', flexShrink: 0, animationDelay: '240ms' }}>
          {labelText}
        </div>
      )}
    </div>
  );
}

// Evaluate Looker conditional_formatting rules against the primary value.
// Rules apply in order; the last matching rule wins (matches Looker).
function evalConditionalFormatting(rules, field, cell) {
  if (!Array.isArray(rules) || !cell) return null;
  const raw = cell.value;
  const v = Number(raw);
  let out = null;
  for (const r of rules) {
    if (r.fields && field && !r.fields.includes(field.name)) continue;
    if (ruleMatches(r, v, raw)) {
      out = { background: r.background_color || undefined, font: r.font_color || undefined, bold: r.bold };
    }
  }
  return out;
}

// For pivoted single-value tiles the value is nested by pivot key
// (row[field][pivotKey]). Resolve to the most recent non-null pivot column
// (e.g. the latest year's "% change vs previous") instead of showing ∅.
function resolvePivotCell(cell, pivots) {
  if (!cell || cell.value !== undefined || cell.rendered !== undefined) return cell;
  const keys = (pivots && pivots.length) ? pivots.map((p) => p.key) : Object.keys(cell);
  for (let i = keys.length - 1; i >= 0; i--) {
    const c = cell[keys[i]];
    if (c && (c.value != null || (c.rendered != null && c.rendered !== ''))) return c;
  }
  return cell[keys[keys.length - 1]] || null;
}

function ruleMatches(r, v, raw) {
  switch (r.type) {
    case 'null': return raw == null;
    case 'not null': return raw != null;
    default: break;
  }
  if (Number.isNaN(v)) return false;
  switch (r.type) {
    case 'greater than': return v > r.value;
    case 'greater than or equal to': return v >= r.value;
    case 'less than': return v < r.value;
    case 'less than or equal to': return v <= r.value;
    case 'equal to': return v === r.value;
    case 'not equal to': return v !== r.value;
    case 'between': return Array.isArray(r.value) && v >= r.value[0] && v <= r.value[1];
    case 'not between': return Array.isArray(r.value) && !(v >= r.value[0] && v <= r.value[1]);
    default: return false;
  }
}

const wrap = { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '8px 12px', textAlign: 'center', overflow: 'hidden' };

function Empty() {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#ccc', fontSize: 12 }}>No data</div>;
}
