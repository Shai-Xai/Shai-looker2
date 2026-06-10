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
import { useIsMobile } from '../lib/useIsMobile.js';

// Renders a single tile (vis or text). In edit mode it shows hover controls
// (edit / duplicate / delete) and a drag handle on the title bar.
export default function TileFrame({ tile, filterValues, editable, onEdit, onDuplicate, onRemove }) {
  const { data, loading, error } = useTileData(tile, filterValues);
  const { insightsEnabled } = useAuth();
  const isMobile = useIsMobile();
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
          {canInsight && (
            <InsightButton onClick={() => setShowInsight(true)} isMobile={isMobile} />
          )}
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
            style={{ position: 'absolute', top: 6, left: 6, zIndex: 6, cursor: 'grab', fontSize: 12, color: '#999', background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 5, padding: '1px 5px', lineHeight: 1.3 }}
          >⠿</span>
        )}
        {/* No header (metric tiles): the insight button floats in the corner. */}
        {canInsight && !showHeader && (
          <InsightButton onClick={() => setShowInsight(true)} isMobile={isMobile} corner />
        )}
        {tile.type === 'text' ? (
          <TextTile tile={tile} />
        ) : !isRunnableQuery(tile.query) ? (
          <Centered faint>{editable ? 'Pick an explore and at least one field →' : 'Not configured'}</Centered>
        ) : loading && !data ? (
          <Skeleton metric={isMetric} chart={!!(visType || '').match(/column|bar|line|area|scatter|pie|donut/)} />
        ) : error ? (
          <Centered error>⚠ {error}</Centered>
        ) : data ? (
          // First data → fade-rise in, staggered by grid position. On refetch
          // (filter change) the stale data stays visible, dimmed, until the new
          // result lands — no flash back to a loading state.
          <div
            className={`tile-enter tile-live${loading ? ' tile-refreshing' : ''}`}
            style={{ height: '100%', animationDelay: `${enterDelay(tile)}ms` }}
          >
            <ErrorBoundary resetKey={data}>
              <TileContent tile={tile} data={data} />
            </ErrorBoundary>
          </div>
        ) : null}
      </div>

      {showInsight && (
        <InsightModal tile={tile} data={data} filters={appliedFilters()} onClose={() => setShowInsight(false)} />
      )}
    </div>
  );
}

// Stagger the entrance by grid position (top-left first, bottom-right last)
// so the dashboard "composes" itself instead of popping in at random.
function enterDelay(tile) {
  const lay = tile.layout || {};
  return Math.min((lay.y ?? 0) * 40 + (lay.x ?? 0) * 7, 480);
}

// Shimmering placeholder shaped roughly like the tile it's standing in for.
function Skeleton({ metric, chart }) {
  if (metric) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 16 }}>
        <div className="skel" style={{ width: '55%', height: 26 }} />
        <div className="skel" style={{ width: '38%', height: 11 }} />
      </div>
    );
  }
  if (chart) {
    const heights = [38, 62, 48, 78, 56, 88, 70];
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: '6%', padding: '18% 12% 14%' }}>
        {heights.map((h, i) => (
          <div key={i} className="skel" style={{ width: '9%', height: `${h}%`, borderRadius: '5px 5px 2px 2px' }} />
        ))}
      </div>
    );
  }
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 10, padding: 16 }}>
      {[88, 100, 96, 100, 92].map((w, i) => (
        <div key={i} className="skel" style={{ width: `${w}%`, height: 12, opacity: 1 - i * 0.14 }} />
      ))}
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

// ✨ AI insight trigger. In the header it sits inline at the right; on metric
// tiles (no header) it floats in the top-right corner. Hidden until tile hover
// (via .insight-btn CSS) and theme-aware (purple accent that adapts to dark).
function InsightButton({ onClick, isMobile, corner }) {
  return (
    <button
      title="AI insight"
      onClick={onClick}
      onMouseDown={(e) => e.stopPropagation()}
      className="insight-btn btn-key"
      style={{
        ...(corner ? { position: 'absolute', top: 6, right: 6, zIndex: 5 } : { flexShrink: 0 }),
        border: '1px solid var(--ai-border)', background: 'var(--ai-bg)', color: 'var(--ai)',
        borderRadius: isMobile ? 9 : 7, cursor: 'pointer', lineHeight: 1, fontWeight: 600,
        fontSize: isMobile ? 13 : 12, padding: isMobile ? '6px 9px' : '3px 7px',
        backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)',
      }}
    >✨</button>
  );
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
