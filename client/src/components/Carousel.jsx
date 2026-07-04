import { useRef, useState, useEffect } from 'react';
import TileFrame from './TileFrame.jsx';
import AlignPicker from './AlignPicker.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';

// A horizontal, scrollable row of tiles, rendered as a full-width grid item so
// it can be dragged anywhere on the dashboard and resized with the grid's own
// handles. Cards fill the band height; card width is set with the right-edge
// drag handle. In edit mode it's also a drop target for existing tiles.
export default function Carousel({ carousel, filterValues, editable, onEditTile, onRemoveTile, onDuplicateTile, onToggleHide, onAddTile, onChangeTitle, onChangeAlign, onRemove, onDropTile, onMoveTileOut, onChangeTileW }) {
  const trackRef = useRef(null);
  const isMobile = useIsMobile();
  const [dragOver, setDragOver] = useState(false);
  // Drag-to-reorder within the row: track which tile we'd drop BEFORE (or the end).
  const [dropBefore, setDropBefore] = useState(null);
  // Only surface the ‹ › arrows when the tiles actually overflow the row.
  const [canScroll, setCanScroll] = useState(false);
  const isGrid = carousel.mode === 'grid'; // a "section": tiles flow in a wrapping grid, not a scroller
  const cardW = carousel.cardW || 300;
  // Viewers don't see hidden tiles; the editor keeps them (dimmed).
  const tiles = editable ? (carousel.tiles || []) : (carousel.tiles || []).filter((t) => !t.hidden);
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
  // their fixed wrapping size. EXCEPT: a card whose width was hand-set with the
  // drag handle (t.cw) is RIGID — it keeps its width (up to the full row) and the
  // row scrolls, so a chart CAN be made wider than its equal-share slot.
  const cardSizeStyle = (w, custom, kpi) => {
    if (isGrid) return { flex: `0 0 ${cardBasis(w)}`, width: cardBasis(w), height: cardH };
    if (isMobile) {
      // KPI number cards fit 4 across the phone (a 5th+ scrolls into view);
      // charts/tables would be unreadable at that size, so they get a
      // near-full-width card each — swipe between them.
      const basis = kpi ? `calc((100% - ${3 * GAP}px) / 4)` : '82vw';
      return { flex: `0 0 ${basis}`, width: basis, height: '100%', scrollSnapAlign: 'start' };
    }
    if (custom) return { flex: `0 0 ${cardBasis(w)}`, width: cardBasis(w), height: '100%' };
    return { flex: `1 1 ${w}px`, minWidth: Math.min(w, 150), height: '100%' };
  };
  // "KPI-shaped" = a single number (or text) card — happy tiny. Anything with
  // axes needs real width on a phone.
  const isKpiTile = (t) => {
    const v = t.vis?.type || '';
    return t.type === 'text' || v === 'single_value' || v === 'single_value_period_over_period' || v.includes('bar_gauge');
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

  // Watch for overflow so the scroll arrows only appear when there's something
  // off-screen to scroll to (re-checks on resize and when the tiles change).
  useEffect(() => {
    const el = trackRef.current;
    if (!el || isGrid) { setCanScroll(false); return; }
    const check = () => setCanScroll(el.scrollWidth - el.clientWidth > 2);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    window.addEventListener('resize', check);
    return () => { ro.disconnect(); window.removeEventListener('resize', check); };
  }, [isGrid, tiles.length, isMobile]);

  // Drag a card's right-edge handle to set THIS card's width (px).
  // stopPropagation so the grid doesn't treat it as a tile/row drag.
  const startTileResize = (tileId, curW) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX, sw = curW;
    const mv = (ev) => onChangeTileW?.(tileId, Math.max(140, Math.min(2000, Math.round((sw + (ev.clientX - sx)) / 10) * 10)));
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); document.body.style.userSelect = ''; };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div
        className={editable ? 'tile-drag-handle' : undefined}
        style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, cursor: editable ? 'move' : 'default', flexShrink: 0 }}
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
          <>
            {/* Centre the heading in the FULL row by balancing the right-hand
                scroll arrows with an equal spacer on the left — kept in-flow (no
                absolute positioning) so the header always reserves its height and
                never sits behind the tiles. */}
            {align === 'center' && !isGrid && canScroll && <span aria-hidden="true" style={{ width: 52, flexShrink: 0 }} />}
            {carousel.title
              ? <h3 style={{ flex: 1, minWidth: 0, margin: 0, fontSize: 15, fontWeight: 700, textAlign: align, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{carousel.title}</h3>
              : <div style={{ flex: 1 }} />}
          </>
        )}
        {editable && (
          <span style={{ display: 'flex', gap: 6 }} onMouseDown={(e) => e.stopPropagation()}>
            <button style={miniBtn} onClick={() => onAddTile('vis')}>+ Visualization</button>
            <button style={miniBtn} onClick={() => onAddTile('text')}>+ Text</button>
            <button style={{ ...miniBtn, color: 'var(--error)', borderColor: '#f0c0c0' }} onClick={onRemove}>{isGrid ? 'Delete section' : 'Delete row'}</button>
          </span>
        )}
        {!isGrid && canScroll && (
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
                  style={{ ...cardSizeStyle(w, !!t.cw, isKpiTile(t)), position: 'relative', borderRadius: 8, boxShadow: dropAccent(t.id, i === tiles.length - 1) }}
                >
                  <TileFrame
                    tile={t}
                    filterValues={filterValues}
                    editable={editable}
                    inCarousel={!isGrid}
                    onEdit={() => onEditTile?.(t.id)}
                    onRemove={() => onRemoveTile?.(t.id)}
                    onDuplicate={() => onDuplicateTile?.(t.id)}
                    onToggleHide={onToggleHide ? () => onToggleHide(t.id) : undefined}
                    onMoveOut={onMoveTileOut ? () => onMoveTileOut(t.id) : undefined}
                  />
                  {/* Per-card width handle (desktop scroller only — grid/mobile size themselves). */}
                  {editable && onChangeTileW && !isGrid && !isMobile && (
                    <div onMouseDown={startTileResize(t.id, w)} onDoubleClick={() => onChangeTileW(t.id, 0)} title="Drag to resize this tile (it keeps that width and the row scrolls) · double-click to reset to auto" style={tileResizeHandle} />
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
const arrowBtn = { width: 24, height: 24, borderRadius: '50%', border: '1.5px solid var(--hairline)', background: 'var(--card)', cursor: 'pointer', fontSize: 15, lineHeight: 1, color: '#555', flexShrink: 0 };
const tileResizeHandle = { position: 'absolute', top: '32%', right: -3, height: '36%', width: 8, cursor: 'ew-resize', borderRight: '4px solid #cbd5e1', borderRadius: 2, zIndex: 6 };
