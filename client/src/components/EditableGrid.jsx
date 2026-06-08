import GridLayout, { WidthProvider } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import TileFrame from './TileFrame.jsx';
import Carousel from './Carousel.jsx';
import SectionGrid from './SectionGrid.jsx';
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

  // Two-column grid: compact metric/KPI tiles sit 2-up to save vertical space;
  // charts, tables, text and carousels span the full width. `dense` backfills
  // gaps so a lone metric before a full-width tile doesn't leave a hole.
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, gridAutoFlow: 'dense' }}>
      {items.map((it) => {
        if (it.kind === 'tile') {
          return (
            <div key={it.el.id} style={{ height: mobileTileHeight(it.el), gridColumn: isMetricTile(it.el) ? 'auto' : '1 / -1' }}>
              <TileFrame tile={it.el} filterValues={filterValues} editable={false} />
            </div>
          );
        }
        const c = it.el;
        // A grid "section": stack its tiles like the main mobile view (metrics 2-up).
        if (c.mode === 'grid') {
          const stiles = (c.tiles || []).slice().sort((a, b) => (a.layout?.y ?? 0) - (b.layout?.y ?? 0) || (a.layout?.x ?? 0) - (b.layout?.x ?? 0));
          return (
            <div key={c.id} style={{ gridColumn: '1 / -1', background: '#fff', border: '1px solid #e0e0e0', borderRadius: 12, padding: 12, boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}>
              {c.title && <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>{c.title}</h3>}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, gridAutoFlow: 'dense' }}>
                {stiles.map((t) => (
                  <div key={t.id} style={{ height: mobileTileHeight(t), gridColumn: isMetricTile(t) ? 'auto' : '1 / -1' }}>
                    <TileFrame tile={t} filterValues={filterValues} editable={false} />
                  </div>
                ))}
                {stiles.length === 0 && <div style={{ gridColumn: '1 / -1', color: '#bbb', fontSize: 13 }}>No tiles</div>}
              </div>
            </div>
          );
        }
        // A scrolling carousel: a compact capped swipe band.
        return (
          <div key={c.id} style={{ gridColumn: '1 / -1', height: Math.min(340, Math.max(220, it.h * 22)), background: '#fff', border: '1px solid #e0e0e0', borderRadius: 12, padding: 10, boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}>
            <Carousel carousel={c} filterValues={filterValues} editable={false} />
          </div>
        );
      })}
    </div>
  );
}

// Single-number KPI tiles go 2-up on mobile. Bar gauges need the full width
// for their axis labels, so they're not included here.
function isMetricTile(tile) {
  const vt = tile.vis?.type || '';
  return vt === 'single_value' || vt === 'single_value_period_over_period';
}

// Full-width tiles in the mobile stack don't need their tall desktop heights.
// Pick a compact height per tile type so metrics stay slim and charts/tables
// keep just enough room to read.
function mobileTileHeight(tile) {
  const vt = tile.vis?.type || '';
  if (tile.type === 'text') return undefined; // size to content
  if (isMetricTile(tile)) return 120;
  if (vt.includes('bar_gauge')) return 104; // full-width, slim
  if (/looker_(column|bar|line|area|scatter|pie|donut)/.test(vt)) return 200;
  // tables and anything else: scale loosely with the configured rows, capped.
  return Math.min(320, Math.max(150, (tile.layout?.h ?? 6) * 20));
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
      compactType="vertical"
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
        <div key={c.id} style={{ background: '#fff', border: '1px solid #e0e0e0', borderRadius: 'var(--radius-md)', padding: 10, boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}>
          {c.mode === 'grid'
            ? <SectionGrid carousel={c} filterValues={filterValues} editable={editable} {...(carouselHandlers ? carouselHandlers(c) : {})} />
            : <Carousel carousel={c} filterValues={filterValues} editable={editable} {...(carouselHandlers ? carouselHandlers(c) : {})} />}
        </div>
      ))}
    </Grid>
  );
}
