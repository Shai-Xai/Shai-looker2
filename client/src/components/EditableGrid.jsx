import GridLayout, { WidthProvider } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import TileFrame from './TileFrame.jsx';

const Grid = WidthProvider(GridLayout);

const COLS = 24;
const ROW_HEIGHT = 30;

// Renders tiles on a 24-column grid. When `editable`, tiles can be dragged
// (via the title bar) and resized, and layout changes flow back through
// onLayoutChange. Mirrors Looker's grid units so imported layouts line up.
export default function EditableGrid({ tiles, filterValues, editable, onLayoutChange, onEditTile, onDuplicateTile, onRemoveTile }) {
  const layout = tiles.map((t) => ({
    i: t.id,
    x: t.layout?.x ?? 0,
    y: t.layout?.y ?? 0,
    w: t.layout?.w ?? 8,
    h: t.layout?.h ?? 6,
    minW: 2,
    minH: 2,
  }));

  function handleChange(newLayout) {
    if (!onLayoutChange) return;
    const map = {};
    for (const item of newLayout) map[item.i] = { x: item.x, y: item.y, w: item.w, h: item.h };
    onLayoutChange(map);
  }

  return (
    <Grid
      className="layout"
      layout={layout}
      cols={COLS}
      rowHeight={ROW_HEIGHT}
      margin={[8, 8]}
      isDraggable={!!editable}
      isResizable={!!editable}
      draggableHandle=".tile-drag-handle"
      onDragStop={handleChange}
      onResizeStop={handleChange}
      compactType={null}
      preventCollision={false}
    >
      {tiles.map((tile) => (
        <div key={tile.id}>
          <TileFrame
            tile={tile}
            filterValues={filterValues}
            editable={editable}
            onEdit={() => onEditTile?.(tile.id)}
            onDuplicate={() => onDuplicateTile?.(tile.id)}
            onRemove={() => onRemoveTile?.(tile.id)}
          />
        </div>
      ))}
    </Grid>
  );
}
