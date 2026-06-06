import { cellText, formatNumber } from '../../lib/format.js';
import { useDrill } from '../../lib/DrillContext.jsx';
import AutoFitText from '../AutoFitText.jsx';

// Single value / KPI tile. Mirrors Looker's single_value visualization:
// big rendered value, optional custom color, optional comparison to a second
// measure (value or % change) with a coloured up/down indicator.
export default function SingleValueTile({ data, visConfig = {}, label }) {
  const { openDrill, canDrill } = useDrill();
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

  const primaryCell = rows[0][primaryField.name];
  const primaryValue = cellText(primaryCell);

  // Comparison against a second measure, when present and not disabled.
  const compField = measures[1] || null;
  const showComparison = compField && visConfig.show_comparison !== false;
  let comparison = null;
  if (showComparison) {
    const compCell = rows[0][compField.name];
    const a = Number(primaryCell?.value);
    const b = Number(compCell?.value);
    const type = visConfig.comparison_type || 'change';
    if (type === 'change' && !Number.isNaN(a) && !Number.isNaN(b) && b !== 0) {
      const pct = (a - b) / Math.abs(b);
      const up = pct >= 0;
      const good = visConfig.comparison_reverse_colors ? !up : up;
      comparison = {
        text: `${up ? '▲' : '▼'} ${formatNumber(Math.abs(pct), '0.0%')}`,
        color: good ? '#10b981' : '#ef4444',
        label: visConfig.comparison_label || `vs ${compField.label_short || compField.label}`,
      };
    } else {
      comparison = {
        text: cellText(rows[0][compField.name]),
        color: 'var(--muted)',
        label: visConfig.comparison_label || `vs ${compField.label_short || compField.label}`,
      };
    }
  }

  const color = visConfig.custom_color_enabled && visConfig.custom_color
    ? visConfig.custom_color
    : visConfig.value_color || '#222';

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
        max={40}
        min={12}
        style={{ flex: 1, minHeight: 0 }}
        onClick={drillable ? () => openDrill(primaryCell.links, primaryField.label_short || primaryField.label) : undefined}
        spanStyle={{
          fontWeight: cf?.bold ? 800 : 700, color: valueColor, letterSpacing: '-0.5px',
          ...(drillable ? { textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 4 } : null),
        }}
      >
        {primaryValue}
      </AutoFitText>
      {comparison && (
        <div style={{ fontSize: 13, marginTop: 6, fontWeight: 600, color: comparison.color }}>
          {comparison.text}
          <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6 }}>{comparison.label}</span>
        </div>
      )}
      {labelText && (
        <div style={{ fontSize: 13, color: labelColor, marginTop: 6, fontWeight: 500, lineHeight: 1.25, textAlign: 'center', overflow: 'hidden' }}>
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

const wrap = { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '12px 16px', textAlign: 'center' };

function Empty() {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#ccc', fontSize: 12 }}>No data</div>;
}
