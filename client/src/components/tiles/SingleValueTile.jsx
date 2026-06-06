import { cellText, formatNumber } from '../../lib/format.js';

// Single value / KPI tile. Mirrors Looker's single_value visualization:
// big rendered value, optional custom color, optional comparison to a second
// measure (value or % change) with a coloured up/down indicator.
export default function SingleValueTile({ data, visConfig = {} }) {
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

  // Only show an explicit custom title — the tile header already shows the
  // tile name, so echoing the raw field name underneath is just noise.
  const title = visConfig.show_single_value_title !== false
    ? (visConfig.single_value_title || null)
    : null;

  return (
    <div style={wrap}>
      <div style={{ fontSize: 'clamp(22px, 4.5vw, 40px)', fontWeight: 700, color, lineHeight: 1.05, letterSpacing: '-0.5px' }}>
        {primaryValue}
      </div>
      {comparison && (
        <div style={{ fontSize: 13, marginTop: 8, fontWeight: 600, color: comparison.color }}>
          {comparison.text}
          <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6 }}>{comparison.label}</span>
        </div>
      )}
      {title && <div style={{ fontSize: 11, color: '#aaa', marginTop: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{title}</div>}
    </div>
  );
}

const wrap = { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '12px 16px', textAlign: 'center' };

function Empty() {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#ccc', fontSize: 12 }}>No data</div>;
}
