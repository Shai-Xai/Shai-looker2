import SingleValueTile from './tiles/SingleValueTile.jsx';
import ChartTile from './tiles/ChartTile.jsx';
import TableTile from './tiles/TableTile.jsx';
import BarGaugeTile from './tiles/BarGaugeTile.jsx';
import { useState } from 'react';
import TextTile from './tiles/TextTile.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';
import InsightModal from './InsightModal.jsx';
import { useTileData, isRunnableQuery } from '../lib/useTileData.js';
import { useAuth } from '../lib/auth.jsx';

// Renders a single tile (vis or text). In edit mode it shows hover controls
// (edit / duplicate / delete) and a drag handle on the title bar.
export default function TileFrame({ tile, filterValues, editable, onEdit, onDuplicate, onRemove }) {
  const { data, loading, error } = useTileData(tile, filterValues);
  const { insightsEnabled } = useAuth();
  const [showInsight, setShowInsight] = useState(false);

  // The filters in effect for this tile (its own query filters + the dashboard
  // filters it listens to) — passed to the AI for context.
  function appliedFilters() {
    const f = { ...(tile.query?.filters || {}) };
    for (const [filterName, queryField] of Object.entries(tile.listenTo || {})) {
      const val = filterValues?.[filterName];
      if (val && String(val).trim()) f[queryField] = String(val).trim();
    }
    return f;
  }

  const canInsight = insightsEnabled && tile.type !== 'text' && data && !loading && !error;

  // Metric-style tiles (single value, gauge) show their label *below* the
  // number (Looker convention), so they don't get a top title bar in view mode.
  const visType = tile.vis?.type;
  const isMetric = visType === 'single_value' || visType === 'single_value_period_over_period' || (visType || '').includes('bar_gauge');
  const showHeader = editable || (!!tile.title && !isMetric);

  return (
    <div
      className="howler-tile"
      style={{
        background: 'var(--tile-bg, #fff)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      {showHeader && (
        <div
          className={editable ? 'tile-drag-handle' : undefined}
          style={{
            padding: '10px 14px',
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--text)',
            letterSpacing: '-0.01em',
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            cursor: editable ? 'move' : 'default',
          }}
        >
          <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {isMetric ? null : (tile.title || <em style={{ color: '#bbb', fontWeight: 400 }}>Untitled</em>)}
          </span>
          {editable && (
            <span style={{ display: 'flex', gap: 4 }} onMouseDown={(e) => e.stopPropagation()}>
              <IconBtn title="Edit" onClick={onEdit}>✎</IconBtn>
              <IconBtn title="Duplicate" onClick={onDuplicate}>⧉</IconBtn>
              <IconBtn title="Delete" onClick={onRemove} danger>✕</IconBtn>
            </span>
          )}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, position: 'relative', padding: tile.type === 'text' ? 12 : 0 }}>
        {editable && (
          <span
            draggable
            onDragStart={(e) => { e.dataTransfer.setData('text/plain', tile.id); e.dataTransfer.effectAllowed = 'move'; }}
            title="Drag into a carousel"
            style={{ position: 'absolute', top: 6, left: 6, zIndex: 6, cursor: 'grab', fontSize: 12, color: '#999', background: '#fff', border: '1px solid #eee', borderRadius: 5, padding: '1px 5px', lineHeight: 1.3 }}
          >⠿</span>
        )}
        {canInsight && (
          <button
            title="AI insight"
            onClick={() => setShowInsight(true)}
            className="insight-btn"
            style={{
              position: 'absolute', top: 6, right: 6, zIndex: 5,
              border: '1px solid #eadfff', background: '#f6f1ff', color: '#6d28d9',
              borderRadius: 6, cursor: 'pointer', fontSize: 12, lineHeight: 1,
              padding: '4px 7px', fontWeight: 600,
            }}
          >✨</button>
        )}
        {tile.type === 'text' ? (
          <TextTile tile={tile} />
        ) : !isRunnableQuery(tile.query) ? (
          <Centered faint>{editable ? 'Pick an explore and at least one field →' : 'Not configured'}</Centered>
        ) : loading ? (
          <Centered faint>Loading…</Centered>
        ) : error ? (
          <Centered error>⚠ {error}</Centered>
        ) : data ? (
          <ErrorBoundary resetKey={data}>
            <TileContent tile={tile} data={data} />
          </ErrorBoundary>
        ) : null}
      </div>

      {showInsight && (
        <InsightModal tile={tile} data={data} filters={appliedFilters()} onClose={() => setShowInsight(false)} />
      )}
    </div>
  );
}

function TileContent({ tile, data }) {
  const visType = tile.vis?.type;

  if (visType === 'single_value' || visType === 'single_value_period_over_period') {
    return <SingleValueTile data={data} visConfig={tile.vis} label={tile.title} />;
  }
  if (visType && visType.includes('bar_gauge')) {
    return <BarGaugeTile data={data} visConfig={tile.vis} label={tile.title} />;
  }
  if (visType === 'looker_grid' || visType === 'table' || visType === 'looker_legacy_table') {
    return <TableTile data={data} visConfig={tile.vis} />;
  }
  if (
    visType === 'looker_column' || visType === 'looker_bar' || visType === 'looker_line' ||
    visType === 'looker_area' || visType === 'looker_scatter' || visType === 'looker_pie' ||
    visType === 'looker_donut_multiples'
  ) {
    return <ChartTile data={data} visConfig={tile.vis} />;
  }
  // Fallback: always show the data.
  return <TableTile data={data} visConfig={tile.vis} />;
}

function IconBtn({ children, onClick, title, danger }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        fontSize: 13,
        lineHeight: 1,
        padding: 2,
        color: danger ? 'var(--error)' : '#888',
        borderRadius: 4,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = '#f0f0f0')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {children}
    </button>
  );
}

function Centered({ children, faint, error }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        padding: 12,
        textAlign: 'center',
        fontSize: 12,
        color: error ? 'var(--error)' : faint ? '#bbb' : '#555',
      }}
    >
      {children}
    </div>
  );
}
