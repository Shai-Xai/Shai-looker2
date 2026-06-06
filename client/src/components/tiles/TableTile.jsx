import { cellText } from '../../lib/format.js';

// Data table. Uses Looker's per-field `align` and `rendered` strings so
// numbers, currency, and percentages match the source dashboard exactly.
export default function TableTile({ data }) {
  const fields = data.fields || {};
  const rows = data.data || [];
  const dimensions = fields.dimensions || [];
  const measures = [...(fields.measures || []), ...(fields.table_calculations || [])];
  const allFields = [...dimensions, ...measures];

  if (!rows.length || !allFields.length) return <Empty />;

  const align = (f) => f.align || (measures.includes(f) ? 'right' : 'left');

  return (
    <div style={{ width: '100%', height: '100%', overflow: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
        <thead>
          <tr>
            {allFields.map((f) => (
              <th key={f.name} style={{ ...thStyle, textAlign: align(f) }} title={f.label || f.name}>
                {f.label_short || f.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ background: i % 2 === 1 ? '#fafafa' : '#fff' }}>
              {allFields.map((f) => {
                const isMeasure = measures.includes(f);
                return (
                  <td key={f.name} style={{ ...tdStyle, textAlign: align(f), fontVariantNumeric: isMeasure ? 'tabular-nums' : 'normal' }}>
                    {cellText(row[f.name])}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const thStyle = {
  padding: '6px 10px',
  background: '#f7f7f7',
  borderBottom: '2px solid #e0e0e0',
  fontWeight: 600,
  whiteSpace: 'nowrap',
  position: 'sticky',
  top: 0,
  zIndex: 1,
};

const tdStyle = {
  padding: '5px 10px',
  borderBottom: '1px solid #f0f0f0',
  whiteSpace: 'nowrap',
};

function Empty() {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#ccc', fontSize: 12 }}>No data</div>;
}
