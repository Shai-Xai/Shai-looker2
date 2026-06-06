import { cellText } from '../../lib/format.js';
import { useDrill } from '../../lib/DrillContext.jsx';

// Data table. Uses Looker's per-field `align` and `rendered` strings so numbers
// match the source exactly. Handles pivoted queries (one column group per pivot
// value × measure), drill links, and hidden fields.
export default function TableTile({ data, visConfig = {} }) {
  const { openDrill, canDrill } = useDrill();
  const fields = data.fields || {};
  const rows = data.data || [];
  const pivots = data.pivots || [];
  const hidden = new Set(visConfig.hidden_fields || []);
  const dimensions = (fields.dimensions || []).filter((f) => !hidden.has(f.name));
  const measures = [...(fields.measures || []), ...(fields.table_calculations || [])].filter((f) => !hidden.has(f.name));

  if (!rows.length || (!dimensions.length && !measures.length)) return <Empty />;

  const mLabel = (m) => m.label_short || m.label || m.name;
  const pLabel = (p) => (p.data ? Object.values(p.data).join(' / ') : p.key);

  const drillCell = (cell, titleParts) => {
    if (!canDrill(cell?.links)) return {};
    return {
      onClick: () => openDrill(cell.links, titleParts.filter(Boolean).join(' · ')),
      style: drillStyle,
    };
  };

  // ─── Pivoted table: dimension columns + (pivot × measure) column groups ──────
  if (pivots.length > 0 && measures.length > 0) {
    return (
      <Scroll>
        <table style={tableStyle}>
          <thead>
            <tr>
              {dimensions.map((d) => (
                <th key={d.name} rowSpan={2} style={{ ...thStyle, textAlign: 'left' }}>{d.label_short || d.label}</th>
              ))}
              {pivots.map((p, pi) => (
                <th key={p.key} colSpan={measures.length} style={{ ...thStyle, textAlign: 'center', borderLeft: pi ? '1px solid #e6e6e6' : undefined }}>
                  {pLabel(p)}
                </th>
              ))}
            </tr>
            <tr>
              {pivots.map((p, pi) => measures.map((m, mi) => (
                <th key={`${p.key}.${m.name}`} style={{ ...thStyle, top: 28, textAlign: 'right', borderLeft: (pi && mi === 0) ? '1px solid #e6e6e6' : undefined }}>
                  {mLabel(m)}
                </th>
              )))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} style={{ background: i % 2 ? '#fafafa' : '#fff' }}>
                {dimensions.map((d) => (
                  <td key={d.name} style={{ ...tdStyle, textAlign: 'left' }}>{cellText(row[d.name])}</td>
                ))}
                {pivots.map((p, pi) => measures.map((m, mi) => {
                  const cell = row[m.name]?.[p.key];
                  const dr = drillCell(cell, [...dimensions.map((d) => cellText(row[d.name])), pLabel(p), mLabel(m)]);
                  return (
                    <td key={`${p.key}.${m.name}`} {...dr}
                      style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums', borderLeft: (pi && mi === 0) ? '1px solid #f0f0f0' : undefined, ...(dr.style || null) }}>
                      {cellText(cell)}
                    </td>
                  );
                }))}
              </tr>
            ))}
          </tbody>
        </table>
      </Scroll>
    );
  }

  // ─── Flat table ──────────────────────────────────────────────────────────────
  const allFields = [...dimensions, ...measures];
  const align = (f) => f.align || (measures.includes(f) ? 'right' : 'left');
  const drillTitle = (row, f) => {
    const dims = dimensions.map((d) => cellText(row[d.name])).filter((v) => v && v !== '∅');
    const label = f.label_short || f.label;
    return dims.length ? `${dims.join(' · ')} · ${label}` : label;
  };

  return (
    <Scroll>
      <table style={tableStyle}>
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
            <tr key={i} style={{ background: i % 2 ? '#fafafa' : '#fff' }}>
              {allFields.map((f) => {
                const cell = row[f.name];
                const isMeasure = measures.includes(f);
                const dr = isMeasure ? drillCell(cell, [drillTitle(row, f)]) : {};
                return (
                  <td key={f.name} {...dr}
                    style={{ ...tdStyle, textAlign: align(f), fontVariantNumeric: isMeasure ? 'tabular-nums' : 'normal', ...(dr.style || null) }}>
                    {cellText(cell)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  );
}

function Scroll({ children }) {
  return <div style={{ width: '100%', height: '100%', overflow: 'auto' }}>{children}</div>;
}

const tableStyle = { borderCollapse: 'collapse', width: '100%', fontSize: 12 };
const thStyle = {
  padding: '6px 10px', background: '#f7f7f7', borderBottom: '2px solid #e0e0e0',
  fontWeight: 600, whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1,
};
const tdStyle = { padding: '5px 10px', borderBottom: '1px solid #f0f0f0', whiteSpace: 'nowrap' };
const drillStyle = { cursor: 'pointer', color: 'var(--brand)', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 2 };

function Empty() {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#ccc', fontSize: 12 }}>No data</div>;
}
