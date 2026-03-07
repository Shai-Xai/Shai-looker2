export default function TableTile({ data }) {
  const fields = data.fields || {};
  const rows = data.data || [];
  const allFields = [
    ...(fields.dimensions || []),
    ...(fields.measures || []),
  ];

  if (!rows.length || !allFields.length) {
    return <Empty />;
  }

  return (
    <div style={{ width: '100%', height: '100%', overflowY: 'auto', overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
        <thead>
          <tr>
            {allFields.map(f => (
              <th key={f.name} style={thStyle}>
                {f.label_short || f.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ background: i % 2 === 1 ? '#fafafa' : '#fff' }}>
              {allFields.map(f => {
                const cell = row[f.name];
                const val = cell?.rendered ?? cell?.value;
                return (
                  <td key={f.name} style={tdStyle(f.type)}>
                    {val ?? '—'}
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
  textAlign: 'left',
  whiteSpace: 'nowrap',
  position: 'sticky',
  top: 0,
  zIndex: 1,
};

function tdStyle(type) {
  const isNumeric = type === 'number' || type === 'count' || type === 'sum' || type === 'average';
  return {
    padding: '5px 10px',
    borderBottom: '1px solid #f0f0f0',
    whiteSpace: 'nowrap',
    textAlign: isNumeric ? 'right' : 'left',
  };
}

function Empty() {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#ccc', fontSize: 12 }}>No data</div>;
}
