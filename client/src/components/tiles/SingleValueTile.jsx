// Single value / KPI tile
export default function SingleValueTile({ data, visConfig }) {
  const fields = data.fields || {};
  const rows = data.data || [];
  if (!rows.length) return <Empty />;

  const measures = fields.measures || [];
  const dimensions = fields.dimensions || [];
  const allFields = [...dimensions, ...measures];

  // Primary value: first measure, or first field
  const primaryField = measures[0] || allFields[0];
  if (!primaryField) return <Empty />;

  const primaryCell = rows[0][primaryField.name];
  const primaryValue = primaryCell?.rendered ?? fmt(primaryCell?.value);

  // Comparison value (second measure or dimension)
  const compField = measures[1] || null;
  const compCell = compField ? rows[0][compField.name] : null;
  const compValue = compCell ? (compCell.rendered ?? fmt(compCell.value)) : null;

  // Value format colour from vis_config
  const color = visConfig?.value_colors?.[0] || '#222';

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      padding: '12px 16px',
      textAlign: 'center',
    }}>
      <div style={{
        fontSize: 'clamp(20px, 4vw, 36px)',
        fontWeight: 700,
        color,
        lineHeight: 1.1,
        letterSpacing: '-0.5px',
      }}>
        {primaryValue}
      </div>
      {compValue && (
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>
          vs {compValue}
        </div>
      )}
      {visConfig?.value_format && (
        <div style={{ fontSize: 11, color: '#bbb', marginTop: 4 }}>{primaryField.label_short || primaryField.label}</div>
      )}
    </div>
  );
}

function fmt(val) {
  if (val == null) return '—';
  if (typeof val === 'number') return val.toLocaleString();
  return String(val);
}

function Empty() {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#ccc', fontSize: 12 }}>No data</div>;
}
