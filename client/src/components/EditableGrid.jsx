import GridLayout, { WidthProvider } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import TileFrame from './TileFrame.jsx';
import Carousel from './Carousel.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';

const Grid = WidthProvider(GridLayout);

const COLS = 24;
const ROW_HEIGHT = 30;

// Renders tiles AND carousels on a 24-column grid. Carousels are full-width
// (w=24) grid items, so they can be dragged anywhere (incl. between grid rows)
// and resized like any tile. Mirrors Looker's grid units.
//
// On phones (<768px) we drop the pixel grid entirely and stack everything in a
// single full-width, read-only column ordered by grid position — tiny squished
// tiles don't work on a 375px screen.
export default function EditableGrid(props) {
  const isMobile = useIsMobile();
  return isMobile ? <StackedGrid {...props} /> : <DesktopGrid {...props} />;
}

function StackedGrid({ tiles = [], carousels = [], filterValues }) {
  // Order by grid position (row, then column) so the stack reads the same way
  // the dashboard looks on desktop.
  const items = [
    ...tiles.map((t) => ({ kind: 'tile', el: t, y: t.layout?.y ?? 0, x: t.layout?.x ?? 0, h: t.layout?.h ?? 6 })),
    ...carousels.map((c, idx) => ({ kind: 'carousel', el: c, y: c.layout?.y ?? (1000 + idx), x: 0, h: c.layout?.h ?? 7 })),
  ].sort((a, b) => a.y - b.y || a.x - b.x);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {items.map((it) =>
        it.kind === 'tile' ? (
          <div key={it.el.id} style={{ height: Math.max(120, it.h * (ROW_HEIGHT + 8)) }}>
            <TileFrame tile={it.el} filterValues={filterValues} editable={false} />
          </div>
        ) : (
          <div key={it.el.id} style={{ background: '#fff', border: '1px solid #e0e0e0', borderRadius: 12, padding: 10, boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}>
            <Carousel carousel={it.el} filterValues={filterValues} editable={false} />
          </div>
        )
      )}
    </div>
  );
}

function DesktopGrid({ tiles = [], carousels = [], filterValues, editable, onLayoutChange, onEditTile, onDuplicateTile, onRemoveTile, carouselHandlers }) {
  const layout = [
    ...tiles.map((t) => ({
      i: t.id,
      x: t.layout?.x ?? 0, y: t.layout?.y ?? 0, w: t.layout?.w ?? 8, h: t.layout?.h ?? 6,
      minW: 2, minH: 2,
    })),
    ...carousels.map((c, idx) => ({
      i: c.id,
      x: 0, y: c.layout?.y ?? (1000 + idx), w: 24, h: c.layout?.h ?? 7,
      minW: 24, maxW: 24, minH: 3,
    })),
  ];

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
      {carousels.map((c) => (
        <div key={c.id} style={{ background: '#fff', border: '1px solid #e0e0e0', borderRadius: 8, padding: 10, boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}>
          <Carousel carousel={c} filterValues={filterValues} editable={editable} {...(carouselHandlers ? carouselHandlers(c) : {})} />
        </div>
      ))}
    </Grid>
  );
}
