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

  const measures = [...(fields.measures || []), ...(fields.table_calculations || [])];
  const dimensions = fields.dimensions || [];
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

  // Looker shows the label *below* the number. Use the tile title (passed in)
  // or an explicit single_value_title override.
  const labelText = visConfig.show_single_value_title !== false
    ? (visConfig.single_value_title || label || null)
    : null;

  const drillable = canDrill(primaryCell?.links);

  return (
    <div style={wrap}>
      <AutoFitText
        max={40}
        min={12}
        style={{ flex: 1, minHeight: 0 }}
        onClick={drillable ? () => openDrill(primaryCell.links, primaryField.label_short || primaryField.label) : undefined}
        spanStyle={{
          fontWeight: 700, color, letterSpacing: '-0.5px',
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
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6, fontWeight: 500, lineHeight: 1.25, textAlign: 'center', overflow: 'hidden' }}>
          {labelText}
        </div>
      )}
    </div>
  );
}

const wrap = { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '12px 16px', textAlign: 'center' };

function Empty() {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#ccc', fontSize: 12 }}>No data</div>;
}
