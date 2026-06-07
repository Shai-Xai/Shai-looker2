import { useRef, useState } from 'react';
import TileFrame from './TileFrame.jsx';

// A horizontal, scrollable row of tiles, rendered as a full-width grid item so
// it can be dragged anywhere on the dashboard and resized with the grid's own
// handles. Cards fill the band height; card width is set with the right-edge
// drag handle. In edit mode it's also a drop target for existing tiles.
export default function Carousel({ carousel, filterValues, editable, onEditTile, onRemoveTile, onDuplicateTile, onAddTile, onChangeTitle, onRemove, onDropTile, onChangeTileW }) {
  const trackRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const cardW = carousel.cardW || 300;
  const tiles = carousel.tiles || [];

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
            placeholder="Row title"
            style={{ fontSize: 15, fontWeight: 700, border: '1.5px solid transparent', background: '#fafafa', borderRadius: 6, padding: '4px 8px', outline: 'none' }}
          />
        ) : (
          carousel.title && <h3 style={{ fontSize: 15, fontWeight: 700 }}>{carousel.title}</h3>
        )}
        <div style={{ flex: 1 }} />
        {editable && (
          <span style={{ display: 'flex', gap: 6 }} onMouseDown={(e) => e.stopPropagation()}>
            <button style={miniBtn} onClick={() => onAddTile('vis')}>+ Visualization</button>
            <button style={miniBtn} onClick={() => onAddTile('text')}>+ Text</button>
            <button style={{ ...miniBtn, color: 'var(--error)', borderColor: '#f0c0c0' }} onClick={onRemove}>Delete row</button>
          </span>
        )}
        <span onMouseDown={(e) => e.stopPropagation()} style={{ display: 'flex', gap: 4 }}>
          <button style={arrowBtn} onClick={() => scroll(-1)} title="Scroll left">‹</button>
          <button style={arrowBtn} onClick={() => scroll(1)} title="Scroll right">›</button>
        </span>
      </div>

      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div
          ref={trackRef}
          onDragOver={editable && onDropTile ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (!dragOver) setDragOver(true); } : undefined}
          onDragLeave={editable && onDropTile ? () => setDragOver(false) : undefined}
          onDrop={editable && onDropTile ? (e) => { e.preventDefault(); setDragOver(false); const id = e.dataTransfer.getData('text/plain'); if (id) onDropTile(id); } : undefined}
          style={{
            display: 'flex', gap: GAP, overflowX: 'auto', height: '100%',
            borderRadius: 8,
            outline: dragOver ? '2px dashed var(--brand)' : 'none',
            background: dragOver ? 'rgba(255,56,92,0.04)' : 'transparent',
          }}
        >
          {tiles.length === 0 ? (
            <div style={{ color: '#bbb', fontSize: 13, padding: '20px 12px', alignSelf: 'center' }}>
              {editable ? 'Empty row — add tiles above, or drag a tile here →' : 'No tiles'}
            </div>
          ) : (
            tiles.map((t) => {
              const w = t.cw || cardW;
              return (
                <div key={t.id} style={{ flex: `0 0 ${w}px`, width: w, height: '100%', position: 'relative', scrollSnapAlign: 'start' }}>
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
const miniBtn = { padding: '6px 10px', background: '#fff', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const arrowBtn = { width: 30, height: 30, borderRadius: '50%', border: '1.5px solid #e0e0e0', background: '#fff', cursor: 'pointer', fontSize: 18, lineHeight: 1, color: '#555', flexShrink: 0 };
const tileResizeHandle = { position: 'absolute', top: '32%', right: -3, height: '36%', width: 8, cursor: 'ew-resize', borderRight: '4px solid #cbd5e1', borderRadius: 2, zIndex: 6 };
