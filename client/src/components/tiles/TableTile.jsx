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

  const mLabel = (m) => visConfig.series_labels?.[m.name] || m.label_short || m.label || m.name;
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
    // Order pivots by Looker's column_order, and hide per-pivot measures that
    // Looker hides (hidden_pivots) — so a calc only shown for one pivot column
    // (e.g. "% change" under KFF26 only) isn't duplicated.
    const colOrder = Array.isArray(visConfig.column_order) ? visConfig.column_order : null;
    const rank = (key) => {
      if (!colOrder) return 0;
      const i = colOrder.findIndex((c) => c.startsWith(`${key}_`));
      return i < 0 ? 999 : i;
    };
    const hiddenPivots = visConfig.hidden_pivots || {};
    const visMeasures = (pkey) => {
      const hide = hiddenPivots[pkey]?.measure_names || [];
      return measures.filter((m) => !hide.includes(m.name));
    };
    const groups = [...pivots]
      .sort((a, b) => rank(a.key) - rank(b.key))
      .map((p) => ({ p, ms: visMeasures(p.key) }))
      .filter((g) => g.ms.length > 0);

    // In-cell data bars (Looker series_cell_visualizations) — precompute each
    // active column's max so bar widths are relative to the column.
    const cellViz = visConfig.series_cell_visualizations || {};
    const colMax = {};
    for (const g of groups) for (const m of g.ms) {
      if (!cellViz[m.name]?.is_active) continue;
      let mx = 0;
      for (const row of rows) { const v = Math.abs(Number(row[m.name]?.[g.p.key]?.value)); if (Number.isFinite(v)) mx = Math.max(mx, v); }
      colMax[`${g.p.key}.${m.name}`] = mx;
    }

    return (
      <Scroll>
        <table style={tableStyle}>
          <thead>
            <tr>
              {dimensions.map((d, di) => (
                <th key={d.name} rowSpan={2} style={{ ...thStyle, textAlign: 'left', ...(di === 0 ? stickyHeadCorner : null) }}>{d.label_short || d.label}</th>
              ))}
              {groups.map((g, gi) => (
                <th key={g.p.key} colSpan={g.ms.length} style={{ ...thStyle, textAlign: 'center', borderLeft: gi ? '1px solid #e6e6e6' : undefined }}>
                  {pLabel(g.p)}
                </th>
              ))}
            </tr>
            <tr>
              {groups.map((g, gi) => g.ms.map((m, mi) => (
                <th key={`${g.p.key}.${m.name}`} style={{ ...thStyle, top: 28, textAlign: 'right', borderLeft: (gi && mi === 0) ? '1px solid #e6e6e6' : undefined }}>
                  {mLabel(m)}
                </th>
              )))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} style={{ background: i % 2 ? '#fafafa' : '#fff' }}>
                {dimensions.map((d, di) => (
                  <td key={d.name} style={{ ...tdStyle, textAlign: 'left', ...(di === 0 ? stickyCol(i % 2 ? '#fafafa' : '#fff') : null) }}>{cellText(row[d.name])}</td>
                ))}
                {groups.map((g, gi) => g.ms.map((m, mi) => {
                  const cell = row[m.name]?.[g.p.key];
                  const dr = drillCell(cell, [...dimensions.map((d) => cellText(row[d.name])), pLabel(g.p), mLabel(m)]);
                  const mx = colMax[`${g.p.key}.${m.name}`];
                  return (
                    <td key={`${g.p.key}.${m.name}`} {...dr}
                      style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums', borderLeft: (gi && mi === 0) ? '1px solid var(--hairline)' : undefined, ...(dr.style || null) }}>
                      {mx ? <Bar value={Number(cell?.value)} max={mx}>{cellText(cell)}</Bar> : cellText(cell)}
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
            {allFields.map((f, fi) => (
              <th key={f.name} style={{ ...thStyle, textAlign: align(f), ...(fi === 0 ? stickyHeadCorner : null) }} title={f.label || f.name}>
                {f.label_short || f.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ background: i % 2 ? '#fafafa' : '#fff' }}>
              {allFields.map((f, fi) => {
                const cell = row[f.name];
                const isMeasure = measures.includes(f);
                const dr = isMeasure ? drillCell(cell, [drillTitle(row, f)]) : {};
                return (
                  <td key={f.name} {...dr}
                    style={{ ...tdStyle, textAlign: align(f), fontVariantNumeric: isMeasure ? 'tabular-nums' : 'normal', ...(fi === 0 ? stickyCol(i % 2 ? '#fafafa' : '#fff') : null), ...(dr.style || null) }}>
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
  padding: '6px 10px', background: 'var(--elevated)', borderBottom: '2px solid #e0e0e0',
  fontWeight: 600, whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 2,
};
const tdStyle = { padding: '5px 10px', borderBottom: '1px solid var(--hairline)', whiteSpace: 'nowrap' };
// Keep the first (label) column pinned while scrolling wide tables sideways —
// matters most on narrow/mobile widths. Corner header sits above everything.
const stickyHeadCorner = { left: 0, zIndex: 3 };
const stickyCol = (bg) => ({ position: 'sticky', left: 0, zIndex: 1, background: bg });
const drillStyle = { cursor: 'pointer', color: 'var(--brand)', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 2 };

// In-cell data bar (Looker cell visualization): a proportional bar behind the
// value, growing from the left, with the number on top.
function Bar({ value, max, children }) {
  const pct = max > 0 && Number.isFinite(value) ? Math.max(0, Math.min(100, (Math.abs(value) / max) * 100)) : 0;
  return (
    <div style={{ position: 'relative', minHeight: 15 }}>
      {pct > 0 && (
        <div style={{ position: 'absolute', left: 0, top: 1, bottom: 1, width: `${pct}%`, background: 'rgba(66,133,244,0.22)', borderRadius: 2 }} />
      )}
      <div style={{ position: 'relative' }}>{children}</div>
    </div>
  );
}

function Empty() {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#ccc', fontSize: 12 }}>No data</div>;
}
