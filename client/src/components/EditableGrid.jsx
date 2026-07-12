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
    ...tiles.filter((t) => !t.hidden).map((t) => ({ kind: 'tile', el: t, y: t.layout?.y ?? 0, x: t.layout?.x ?? 0, w: t.layout?.w ?? 8, h: t.layout?.h ?? 6 })),
    ...carousels.filter((c) => (c.tiles || []).some((t) => !t.hidden)).map((c, idx) => ({ kind: 'carousel', el: c, y: c.layout?.y ?? (1000 + idx), x: 0, w: 24, h: c.layout?.h ?? 7 })),
  ].sort((a, b) => a.y - b.y || a.x - b.x);

  // Group consecutive tiles that share a desktop row (same y) so a strip of small
  // KPI/header tiles stays on ONE row on mobile (shrinking to fit) instead of
  // each dropping onto its own line. Wide tiles and carousels stand alone.
  const groups = [];
  let cur = null;
  for (const it of items) {
    if (it.kind === 'carousel') { groups.push({ type: 'carousel', it }); cur = null; continue; }
    if (cur && cur.y === it.y) cur.items.push(it);
    else { cur = { type: 'row', y: it.y, items: [it] }; groups.push(cur); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {groups.map((g, gi) => {
        if (g.type === 'carousel') {
          const c = g.it.el;
          // A grid "section": stack its tiles 2-up like the main mobile view.
          if (c.mode === 'grid') {
            const stiles = (c.tiles || []).filter((t) => !t.hidden).slice().sort((a, b) => (a.layout?.y ?? 0) - (b.layout?.y ?? 0) || (a.layout?.x ?? 0) - (b.layout?.x ?? 0));
            return (
              <div key={c.id} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: 12, boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}>
                {c.title && <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 10, textAlign: c.titleAlign || 'left' }}>{c.title}</h3>}
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
          // A scrolling carousel: a compact capped swipe band — unless it holds
          // charts/tables (which get full-width cards on mobile and need real
          // height to be readable, like a standalone mobile chart).
          const hasBigCards = (c.tiles || []).some((t) => !t.hidden && !isKpiCard(t));
          return (
            <div key={c.id} style={{ height: hasBigCards ? 320 : Math.min(230, Math.max(150, g.it.h * 16)), background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: 10, boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}>
              <Carousel carousel={c} filterValues={filterValues} editable={false} />
            </div>
          );
        }
        // A desktop row of tiles. Keep a strip of small tiles (each ≤ half-width)
        // on one line, sharing the width proportionally; otherwise stack them.
        const keepRow = g.items.length >= 2 && g.items.every((it) => it.w <= 12);
        if (keepRow) {
          const rowH = Math.max(0, ...g.items.map((it) => mobileTileHeight(it.el) || 0));
          return (
            <div key={`row-${gi}`} style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
              {g.items.map((it) => (
                <div key={it.el.id} style={{ flex: `${it.w} 1 0`, minWidth: 80, height: rowH || undefined }}>
                  <TileFrame tile={it.el} filterValues={filterValues} editable={false} />
                </div>
              ))}
            </div>
          );
        }
        return (
          <div key={`stack-${gi}`} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {g.items.map((it) => (
              <div key={it.el.id} style={{ height: mobileTileHeight(it.el) }}>
                <TileFrame tile={it.el} filterValues={filterValues} editable={false} />
              </div>
            ))}
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

// "KPI-shaped" carousel card (number/gauge/text) — happy in a slim band.
// Mirrors Carousel.jsx's isKpiTile; anything else gets a full-width card there.
function isKpiCard(tile) {
  const vt = tile.vis?.type || '';
  return tile.type === 'text' || isMetricTile(tile) || vt.includes('bar_gauge');
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
  // Tables (and anything else): scale loosely with the configured rows, capped.
  // Give tables more height on mobile so there's room to read + a bigger target
  // to scroll within (less fighting with the page scroll).
  const isTable = tile.type === 'table' || vt === 'looker_grid' || vt.includes('table');
  return Math.min(isTable ? 440 : 320, Math.max(isTable ? 220 : 150, (tile.layout?.h ?? 6) * 20));
}


function DesktopGrid({ tiles = [], carousels = [], filterValues, editable, onLayoutChange, onEditTile, onDuplicateTile, onRemoveTile, onHideTile, carouselHandlers }) {
  // Viewers don't see hidden tiles (or carousels left with nothing visible).
  const visTiles = editable ? tiles : tiles.filter((t) => !t.hidden);
  const visCarousels = editable ? carousels : carousels.filter((c) => (c.tiles || []).some((t) => !t.hidden));
  const layout = [
    ...visTiles.map((t) => ({
      i: t.id,
      x: t.layout?.x ?? 0, y: t.layout?.y ?? 0, w: t.layout?.w ?? 8, h: t.layout?.h ?? 6,
      minW: 2, minH: 2,
    })),
    ...visCarousels.map((c, idx) => ({
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
      {visTiles.map((tile) => (
        <div key={tile.id}>
          <TileFrame
            tile={tile}
            filterValues={filterValues}
            editable={editable}
            onEdit={() => onEditTile?.(tile.id)}
            onDuplicate={() => onDuplicateTile?.(tile.id)}
            onRemove={() => onRemoveTile?.(tile.id)}
            onToggleHide={onHideTile ? () => onHideTile(tile.id) : undefined}
          />
        </div>
      ))}
      {visCarousels.map((c) => (
        <div key={c.id} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 10, boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}>
          {c.mode === 'grid'
            ? <SectionGrid carousel={c} filterValues={filterValues} editable={editable} {...(carouselHandlers ? carouselHandlers(c) : {})} />
            : <Carousel carousel={c} filterValues={filterValues} editable={editable} {...(carouselHandlers ? carouselHandlers(c) : {})} />}
        </div>
      ))}
    </Grid>
  );
}
