import { useRef, useState } from 'react';
import TileFrame from './TileFrame.jsx';
import AlignPicker from './AlignPicker.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';

// A horizontal, scrollable row of tiles, rendered as a full-width grid item so
// it can be dragged anywhere on the dashboard and resized with the grid's own
// handles. Cards fill the band height; card width is set with the right-edge
// drag handle. In edit mode it's also a drop target for existing tiles.
export default function Carousel({ carousel, filterValues, editable, onEditTile, onRemoveTile, onDuplicateTile, onAddTile, onChangeTitle, onChangeAlign, onRemove, onDropTile, onMoveTileOut, onChangeTileW }) {
  const trackRef = useRef(null);
  const isMobile = useIsMobile();
  const [dragOver, setDragOver] = useState(false);
  // Drag-to-reorder within the row: track which tile we'd drop BEFORE (or the end).
  const [dropBefore, setDropBefore] = useState(null);
  const isGrid = carousel.mode === 'grid'; // a "section": tiles flow in a wrapping grid, not a scroller
  const cardW = carousel.cardW || 300;
  const tiles = carousel.tiles || [];
  const cardH = carousel.cardH || 220; // fixed card height in grid (section) mode
  const align = carousel.titleAlign || 'left'; // heading alignment: left | center | right
  // On phones a card shouldn't exceed the viewport — show one card plus a peek
  // of the next so it's obviously swipeable. On desktop the configured width is
  // the target, but it's capped to the row's own width (100%) so cards shrink to
  // fit when the window/container narrows instead of sticking at a fixed size.
  const cardBasis = (w) => (isMobile ? `min(${w}px, 82vw)` : `min(${w}px, 100%)`);
  // Card sizing per mode. On a scroller the cards FLEX to fill the row (grow/
  // shrink with the window) so they resize to fit the screen — on mobile too,
  // with a smaller min so several KPI cards still fit a phone instead of jumping
  // to one big card. They only scroll once they hit that min. Grid sections keep
  // their fixed wrapping size.
  const cardSizeStyle = (w) => {
    if (isGrid) return { flex: `0 0 ${cardBasis(w)}`, width: cardBasis(w), height: cardH };
    if (isMobile) {
      // Fit 4 KPI cards across the phone width; a 5th+ scrolls into view.
      const basis = `calc((100% - ${3 * GAP}px) / 4)`;
      return { flex: `0 0 ${basis}`, width: basis, height: '100%', scrollSnapAlign: 'start' };
    }
    return { flex: `1 1 ${w}px`, minWidth: Math.min(w, 150), height: '100%' };
  };
  // A brand insertion bar on the card we'd drop before (or the row's end).
  const dropAccent = (tid, isLast) => {
    if (dropBefore === tid) return 'inset 3px 0 0 var(--brand)';
    if (isLast && dropBefore === '__end__') return 'inset -3px 0 0 var(--brand)';
    return undefined;
  };
  const onCardDragOver = (i) => (e) => {
    if (!(editable && onDropTile) || isGrid) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const before = (e.clientX - r.left) < r.width / 2;
    setDropBefore(before ? tiles[i].id : (tiles[i + 1]?.id || '__end__'));
  };

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
          <>
            <input
              value={carousel.title || ''}
              onChange={(e) => onChangeTitle(e.target.value)}
              onMouseDown={(e) => e.stopPropagation()}
              placeholder={isGrid ? 'Section title' : 'Row title'}
              style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: 700, border: '1.5px solid transparent', background: 'var(--elevated)', borderRadius: 6, padding: '4px 8px', outline: 'none', textAlign: align }}
            />
            {onChangeAlign && <AlignPicker value={align} onChange={onChangeAlign} />}
          </>
        ) : (
          carousel.title ? <h3 style={{ fontSize: 15, fontWeight: 700, flex: 1, minWidth: 0, margin: 0, textAlign: align }}>{carousel.title}</h3> : <div style={{ flex: 1 }} />
        )}
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
          className={isGrid ? undefined : 'howler-carousel-track'}
          // Keep horizontal tile-scrolling self-contained: stop touch gestures
          // from bubbling up to the dashboard's swipe-to-next-tab handler, so
          // scrolling a carousel on mobile never flips to the next dashboard.
          onTouchStart={!isGrid ? (e) => e.stopPropagation() : undefined}
          onTouchMove={!isGrid ? (e) => e.stopPropagation() : undefined}
          onTouchEnd={!isGrid ? (e) => e.stopPropagation() : undefined}
          // The full-track highlight is only for dropping into an EMPTY row; a
          // non-empty row shows a precise insertion bar via the cards instead.
          onDragOver={editable && onDropTile ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (tiles.length === 0 && !dragOver) setDragOver(true); } : undefined}
          onDragLeave={editable && onDropTile ? () => setDragOver(false) : undefined}
          onDrop={editable && onDropTile ? (e) => { e.preventDefault(); setDragOver(false); const id = e.dataTransfer.getData('text/plain'); const before = dropBefore; setDropBefore(null); if (id) onDropTile(id, before); } : undefined}
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
            tiles.map((t, i) => {
              const w = t.cw || cardW;
              return (
                <div
                  key={t.id}
                  onDragOver={onCardDragOver(i)}
                  onDragEnd={() => { setDropBefore(null); setDragOver(false); }}
                  style={{ ...cardSizeStyle(w), position: 'relative', borderRadius: 8, boxShadow: dropAccent(t.id, i === tiles.length - 1) }}
                >
                  <TileFrame
                    tile={t}
                    filterValues={filterValues}
                    editable={editable}
                    inCarousel={!isGrid}
                    onEdit={() => onEditTile?.(t.id)}
                    onRemove={() => onRemoveTile?.(t.id)}
                    onDuplicate={() => onDuplicateTile?.(t.id)}
                    onMoveOut={onMoveTileOut ? () => onMoveTileOut(t.id) : undefined}
                  />
                  {/* Per-card width handle (desktop scroller only — grid/mobile size themselves). */}
                  {editable && onChangeTileW && !isGrid && !isMobile && (
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
