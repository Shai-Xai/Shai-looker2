// Shared renderers for RESOLVED report blocks — the single source of how a
// report looks. Used by the public share page (ReportViewPage) AND the live
// editor canvas (ReportStudio), so what you design is exactly what stakeholders
// see. Deliberately fixed light styling (reports are outward-facing documents),
// independent of the app theme.

// Coalesce consecutive KPI chips into rows so they flow side by side.
export function groupKpiRows(blocks) {
  const rows = [];
  for (const b of blocks || []) {
    const isKpi = b.type === 'tile' && b.kind === 'kpi';
    const last = rows[rows.length - 1];
    if (isKpi && last?.kind === 'kpis') last.items.push(b);
    else if (isKpi) rows.push({ kind: 'kpis', items: [b] });
    else rows.push({ kind: 'block', b });
  }
  return rows;
}

export function KpiRow({ items }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, margin: '4px 0 16px' }}>
      {items.map((k, j) => (
        <div key={j} style={{ border: '1px solid #e8e8ec', borderRadius: 12, padding: '12px 18px', minWidth: 120, flex: '0 1 auto', background: '#fff' }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#86868b' }}>{k.title}</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: '#111', marginTop: 2 }}>{k.value}</div>
        </div>
      ))}
    </div>
  );
}

// An asset reference: stored snapshots carry assetToken (served publicly);
// live-canvas previews carry an inline data: URL instead.
const assetSrc = (b) => b.dataUrl || (b.assetToken ? `/report-assets/${b.assetToken}` : b.url || '');

export function ReportBlockView({ b, accent }) {
  switch (b.type) {
    case 'heading':
      return b.level === 2
        ? <h3 style={{ fontSize: 15, fontWeight: 700, color: '#111', margin: '18px 0 8px' }}>{fmtRich(b.text)}</h3>
        : <h2 style={{ fontSize: 19, fontWeight: 800, letterSpacing: '-0.01em', color: '#111', margin: '22px 0 10px' }}>{fmtRich(b.text)}</h2>;
    case 'text':
      return <p style={{ fontSize: 14.5, lineHeight: 1.65, color: '#3a3a3c', margin: '0 0 14px', whiteSpace: 'pre-wrap' }}>{fmtRich(b.text)}</p>;
    case 'ai': {
      const body = b.text || b.note;
      if (!body) return null;
      return (
        <div style={{ borderLeft: `3px solid ${accent}`, padding: '4px 0 4px 14px', margin: '4px 0 16px' }}>
          <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.06em', color: accent, marginBottom: 4 }}>ANALYSIS</div>
          <div style={{ fontSize: 14.5, lineHeight: 1.65, color: '#3a3a3c', whiteSpace: 'pre-wrap', fontStyle: b.text ? 'normal' : 'italic' }}>{body}</div>
        </div>
      );
    }
    case 'image': {
      const src = assetSrc(b);
      return src ? <img src={src} alt={b.alt || ''} style={{ maxWidth: '100%', borderRadius: 10, margin: '4px 0 16px', display: 'block' }} /> : null;
    }
    case 'button':
      return b.text ? (
        <div style={{ margin: '4px 0 16px' }}>
          <a href={b.href || '#'} target="_blank" rel="noreferrer" style={{ display: 'inline-block', padding: '11px 24px', background: accent, color: '#fff', borderRadius: 980, fontSize: 13.5, fontWeight: 700, textDecoration: 'none' }}>{b.text}</a>
        </div>
      ) : null;
    case 'divider':
      return <div style={{ borderTop: '1px solid #e8e8ec', margin: '16px 0' }} />;
    case 'tile': {
      if (b.kind === 'chart') return <img src={assetSrc(b)} alt={b.title || 'Chart'} style={{ width: '100%', borderRadius: 10, margin: '4px 0 16px', display: 'block' }} />;
      if (b.kind === 'table') {
        return (
          <div style={{ margin: '4px 0 16px' }}>
            {b.title && <div style={{ fontSize: 13.5, fontWeight: 700, color: '#111', marginBottom: 6 }}>{b.title}</div>}
            <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: Math.min(560, (b.columns || []).length * 110) }}>
                <thead><tr>{(b.columns || []).map((c, i) => <th key={i} style={{ textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#86868b', padding: '6px 8px', borderBottom: '1px solid #e8e8ec', whiteSpace: 'nowrap' }}>{c}</th>)}</tr></thead>
                <tbody>{(b.rows || []).map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} style={{ fontSize: 13.5, color: '#3a3a3c', padding: '7px 8px', borderBottom: '1px solid #f2f2f5' }}>{v}</td>)}</tr>)}</tbody>
              </table>
            </div>
            {b.more ? <div style={{ fontSize: 11.5, color: '#86868b', marginTop: 4 }}>… {b.more} more rows</div> : null}
          </div>
        );
      }
      if (b.kind === 'missing') return <div style={{ fontSize: 13, color: '#a1a1a6', fontStyle: 'italic', margin: '4px 0 14px' }}>{b.title} — data unavailable at generation time</div>;
      return null;
    }
    default:
      return null;
  }
}

// **bold** / *italic* — the same light author markup emailBlocks supports.
export function fmtRich(s) {
  const out = [];
  let key = 0;
  for (const seg of String(s || '').split(/(\*\*[^*]+\*\*)/g)) {
    const b = /^\*\*([^*]+)\*\*$/.exec(seg);
    if (b) { out.push(<strong key={key++}>{b[1]}</strong>); continue; }
    for (const s2 of seg.split(/(\*[^*]+\*)/g)) {
      const i = /^\*([^*]+)\*$/.exec(s2);
      if (i) out.push(<em key={key++}>{i[1]}</em>);
      else if (s2) out.push(s2);
    }
  }
  return out;
}
