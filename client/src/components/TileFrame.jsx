import SingleValueTile from './tiles/SingleValueTile.jsx';
import ChartTile from './tiles/ChartTile.jsx';
import TableTile from './tiles/TableTile.jsx';
import TextTile from './tiles/TextTile.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';
import { useTileData } from '../lib/useTileData.js';

// Renders a single tile (vis or text). In edit mode it shows hover controls
// (edit / duplicate / delete) and a drag handle on the title bar.
export default function TileFrame({ tile, filterValues, editable, onEdit, onDuplicate, onRemove }) {
  const { data, loading, error } = useTileData(tile, filterValues);

  return (
    <div
      style={{
        background: 'var(--tile-bg, #fff)',
        border: '1px solid #e0e0e0',
        borderRadius: 8,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
      }}
    >
      {(tile.title || editable) && (
        <div
          className={editable ? 'tile-drag-handle' : undefined}
          style={{
            padding: '8px 12px',
            fontSize: 12,
            fontWeight: 600,
            color: '#555',
            borderBottom: '1px solid #f0f0f0',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            cursor: editable ? 'move' : 'default',
          }}
        >
          <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {tile.title || <em style={{ color: '#bbb', fontWeight: 400 }}>Untitled</em>}
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
        {tile.type === 'text' ? (
          <TextTile tile={tile} />
        ) : !tile.query ? (
          <Centered faint>No query configured</Centered>
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
    </div>
  );
}

function TileContent({ tile, data }) {
  const visType = tile.vis?.type;

  if (visType === 'single_value' || visType === 'single_value_period_over_period') {
    return <SingleValueTile data={data} visConfig={tile.vis} />;
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
