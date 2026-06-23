import { useRef, useState } from 'react';
import TileFrame from './TileFrame.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';

// A horizontal, scrollable row of tiles, rendered as a full-width grid item so
// it can be dragged anywhere on the dashboard and resized with the grid's own
// handles. Cards fill the band height; card width is set with the right-edge
// drag handle. In edit mode it's also a drop target for existing tiles.
export default function Carousel({ carousel, filterValues, editable, onEditTile, onRemoveTile, onDuplicateTile, onAddTile, onChangeTitle, onRemove, onDropTile, onChangeTileW }) {
  const trackRef = useRef(null);
  const isMobile = useIsMobile();
  const [dragOver, setDragOver] = useState(false);
  const isGrid = carousel.mode === 'grid'; // a "section": tiles flow in a wrapping grid, not a scroller
  const cardW = carousel.cardW || 300;
  const tiles = carousel.tiles || [];
  const cardH = carousel.cardH || 220; // fixed card height in grid (section) mode
  // On phones a card shouldn't exceed the viewport — show one card plus a peek
  // of the next so it's obviously swipeable. On desktop the configured width is
  // the target, but it's capped to the row's own width (100%) so cards shrink to
  // fit when the window/container narrows instead of sticking at a fixed size.
  const cardBasis = (w) => (isMobile ? `min(${w}px, 82vw)` : `min(${w}px, 100%)`);

  const scroll = (dir) => trackRef.current?.scrollBy({ left: dir * (cardW + GAP) * 2, behavior: 'smooth' });

  // Drag a card's right-edge handle to set THIS card's width (px).
  // stopPropagation so the grid doesn't treat it as a tile/row drag.
  const startTileResize = (tileId, curW) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX, sw = curW;
    const mv = (ev) => onChangeTileW?.(tileId, Math.max(140, Math.min(720, Math.round((sw + (ev.clientX - sx)) / 10) * 10)));
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); document.body.style.userSelect = ''; };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div
        className={editable ? 'tile-drag-handle' : undefined}
        style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, cursor: editable ? 'move' : 'default', flexShrink: 0 }}
      >
        {editable && <span style={{ color: '#bbb', fontSize: 13 }} title="Drag to move row">⠿⠿</span>}
        {editable ? (
          <input
            value={carousel.title || ''}
            onChange={(e) => onChangeTitle(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            placeholder={isGrid ? 'Section title' : 'Row title'}
            style={{ fontSize: 15, fontWeight: 700, border: '1.5px solid transparent', background: 'var(--elevated)', borderRadius: 6, padding: '4px 8px', outline: 'none' }}
          />
        ) : (
          carousel.title && <h3 style={{ fontSize: 15, fontWeight: 700 }}>{carousel.title}</h3>
        )}
        <div style={{ flex: 1 }} />
        {editable && (
          <span style={{ display: 'flex', gap: 6 }} onMouseDown={(e) => e.stopPropagation()}>
            <button style={miniBtn} onClick={() => onAddTile('vis')}>+ Visualization</button>
            <button style={miniBtn} onClick={() => onAddTile('text')}>+ Text</button>
            <button style={{ ...miniBtn, color: 'var(--error)', borderColor: '#f0c0c0' }} onClick={onRemove}>{isGrid ? 'Delete section' : 'Delete row'}</button>
          </span>
        )}
        {!isGrid && (
          <span onMouseDown={(e) => e.stopPropagation()} style={{ display: 'flex', gap: 4 }}>
            <button style={arrowBtn} onClick={() => scroll(-1)} title="Scroll left">‹</button>
            <button style={arrowBtn} onClick={() => scroll(1)} title="Scroll right">›</button>
          </span>
        )}
      </div>

      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div
          ref={trackRef}
          // Keep horizontal tile-scrolling self-contained: stop touch gestures
          // from bubbling up to the dashboard's swipe-to-next-tab handler, so
          // scrolling a carousel on mobile never flips to the next dashboard.
          onTouchStart={!isGrid ? (e) => e.stopPropagation() : undefined}
          onTouchMove={!isGrid ? (e) => e.stopPropagation() : undefined}
          onTouchEnd={!isGrid ? (e) => e.stopPropagation() : undefined}
          onDragOver={editable && onDropTile ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (!dragOver) setDragOver(true); } : undefined}
          onDragLeave={editable && onDropTile ? () => setDragOver(false) : undefined}
          onDrop={editable && onDropTile ? (e) => { e.preventDefault(); setDragOver(false); const id = e.dataTransfer.getData('text/plain'); if (id) onDropTile(id); } : undefined}
          style={{
            display: 'flex', gap: GAP, height: '100%', borderRadius: 8,
            ...(isGrid
              ? { flexWrap: 'wrap', alignContent: 'flex-start', overflowY: 'auto', overflowX: 'hidden' }
              : { overflowX: 'auto', WebkitOverflowScrolling: 'touch', scrollSnapType: isMobile ? 'x mandatory' : undefined }),
            outline: dragOver ? '2px dashed var(--brand)' : 'none',
            background: dragOver ? 'rgba(var(--brand-rgb), 0.04)' : 'transparent',
          }}
        >
          {tiles.length === 0 ? (
            <div style={{ color: '#bbb', fontSize: 13, padding: '20px 12px', alignSelf: 'center' }}>
              {editable ? (isGrid ? 'Empty section — add tiles above, or drag a tile here' : 'Empty row — add tiles above, or drag a tile here →') : 'No tiles'}
            </div>
          ) : (
            tiles.map((t) => {
              const w = t.cw || cardW;
              return (
                <div key={t.id} style={{ flex: `0 0 ${cardBasis(w)}`, width: cardBasis(w), height: isGrid ? cardH : '100%', position: 'relative', scrollSnapAlign: isGrid ? undefined : 'start' }}>
                  <TileFrame
                    tile={t}
                    filterValues={filterValues}
                    editable={editable}
                    onEdit={() => onEditTile?.(t.id)}
                    onRemove={() => onRemoveTile?.(t.id)}
                    onDuplicate={() => onDuplicateTile?.(t.id)}
                  />
                  {editable && onChangeTileW && (
                    <div onMouseDown={startTileResize(t.id, w)} title="Drag to resize this tile" style={tileResizeHandle} />
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

const GAP = 12;
const miniBtn = { padding: '6px 10px', background: 'var(--card)', border: '1.5px solid var(--hairline)', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const arrowBtn = { width: 30, height: 30, borderRadius: '50%', border: '1.5px solid var(--hairline)', background: 'var(--card)', cursor: 'pointer', fontSize: 18, lineHeight: 1, color: '#555', flexShrink: 0 };
const tileResizeHandle = { position: 'absolute', top: '32%', right: -3, height: '36%', width: 8, cursor: 'ew-resize', borderRight: '4px solid #cbd5e1', borderRadius: 2, zIndex: 6 };
