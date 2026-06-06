import { cellText } from '../../lib/format.js';
import { useDrill } from '../../lib/DrillContext.jsx';

// Data table. Uses Looker's per-field `align` and `rendered` strings so
// numbers, currency, and percentages match the source dashboard exactly.
// Measure cells that carry Looker drill links are clickable.
export default function TableTile({ data, visConfig = {} }) {
  const { openDrill, canDrill } = useDrill();
  const fields = data.fields || {};
  const rows = data.data || [];
  const hidden = new Set(visConfig.hidden_fields || []);
  const dimensions = (fields.dimensions || []).filter((f) => !hidden.has(f.name));
  const measures = [...(fields.measures || []), ...(fields.table_calculations || [])].filter((f) => !hidden.has(f.name));
  const allFields = [...dimensions, ...measures];

  if (!rows.length || !allFields.length) return <Empty />;

  const align = (f) => f.align || (measures.includes(f) ? 'right' : 'left');

  // Build a readable drill title from a row's dimension values + the field.
  const drillTitle = (row, f) => {
    const dims = dimensions.map((d) => cellText(row[d.name])).filter((v) => v && v !== '∅');
    const label = f.label_short || f.label;
    return dims.length ? `${dims.join(' · ')} · ${label}` : label;
  };

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
                const cell = row[f.name];
                const isMeasure = measures.includes(f);
                const drillable = isMeasure && canDrill(cell?.links);
                return (
                  <td
                    key={f.name}
                    onClick={drillable ? () => openDrill(cell.links, drillTitle(row, f)) : undefined}
                    style={{
                      ...tdStyle,
                      textAlign: align(f),
                      fontVariantNumeric: isMeasure ? 'tabular-nums' : 'normal',
                      ...(drillable ? drillStyle : null),
                    }}
                  >
                    {cellText(cell)}
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

const drillStyle = {
  cursor: 'pointer',
  color: 'var(--brand)',
  textDecoration: 'underline',
  textDecorationStyle: 'dotted',
  textUnderlineOffset: 2,
};

function Empty() {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#ccc', fontSize: 12 }}>No data</div>;
}
