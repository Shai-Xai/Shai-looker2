import { useRef, useState } from 'react';
import TileFrame from './TileFrame.jsx';

// A horizontal, scrollable row of tiles. When the tiles overflow the screen
// width, the left/right arrows scroll the track. Reuses TileFrame so every
// tile type (KPI, table, chart, gauge) renders exactly as in the grid.
// In edit mode it's also a drop target — drag any tile here to move it in.
export default function Carousel({ carousel, filterValues, editable, onEditTile, onRemoveTile, onDuplicateTile, onAddTile, onChangeTitle, onRemove, onDropTile, onChangeSize, onMoveUp, onMoveDown, canMoveUp, canMoveDown }) {
  const trackRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const cardW = carousel.cardW || 320;
  const cardH = carousel.cardH || 200;
  const tiles = carousel.tiles || [];

  const scroll = (dir) => trackRef.current?.scrollBy({ left: dir * (cardW + GAP) * 2, behavior: 'smooth' });

  // Drag the corner handle to resize all cards in the row (W from horizontal
  // movement, H from vertical).
  const startResize = (e) => {
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY, startW = cardW, startH = cardH;
    const onMove = (ev) => onChangeSize?.({
      cardW: Math.max(160, Math.min(720, Math.round((startW + (ev.clientX - startX)) / 10) * 10)),
      cardH: Math.max(110, Math.min(440, Math.round((startH + (ev.clientY - startY)) / 10) * 10)),
    });
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, padding: '0 2px', flexWrap: 'wrap' }}>
        {editable && (
          <span style={{ display: 'flex', gap: 2 }}>
            <button style={iconBtn} onClick={onMoveUp} disabled={!canMoveUp} title="Move row up">↑</button>
            <button style={iconBtn} onClick={onMoveDown} disabled={!canMoveDown} title="Move row down">↓</button>
          </span>
        )}
        {editable ? (
          <input
            value={carousel.title || ''}
            onChange={(e) => onChangeTitle(e.target.value)}
            placeholder="Row title"
            style={{ fontSize: 15, fontWeight: 700, border: '1.5px solid transparent', background: '#fafafa', borderRadius: 6, padding: '4px 8px', outline: 'none' }}
          />
        ) : (
          carousel.title && <h3 style={{ fontSize: 15, fontWeight: 700 }}>{carousel.title}</h3>
        )}
        <div style={{ flex: 1 }} />
        {editable && (
          <>
            <button style={miniBtn} onClick={() => onAddTile('vis')}>+ Visualization</button>
            <button style={miniBtn} onClick={() => onAddTile('text')}>+ Text</button>
            <button style={{ ...miniBtn, color: 'var(--error)', borderColor: '#f0c0c0' }} onClick={onRemove}>Delete row</button>
          </>
        )}
        <button style={arrowBtn} onClick={() => scroll(-1)} title="Scroll left">‹</button>
        <button style={arrowBtn} onClick={() => scroll(1)} title="Scroll right">›</button>
      </div>

      <div style={{ position: 'relative' }}>
      <div
        ref={trackRef}
        onDragOver={editable && onDropTile ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (!dragOver) setDragOver(true); } : undefined}
        onDragLeave={editable && onDropTile ? () => setDragOver(false) : undefined}
        onDrop={editable && onDropTile ? (e) => {
          e.preventDefault();
          setDragOver(false);
          const tileId = e.dataTransfer.getData('text/plain');
          if (tileId) onDropTile(tileId);
        } : undefined}
        style={{
          display: 'flex', gap: GAP, overflowX: 'auto', paddingBottom: 8, scrollSnapType: 'x proximity',
          borderRadius: 8,
          outline: dragOver ? '2px dashed var(--brand)' : 'none',
          outlineOffset: 2,
          background: dragOver ? 'rgba(255,56,92,0.04)' : 'transparent',
          minHeight: editable ? Math.max(60, (carousel.cardH || 200) / 2) : undefined,
        }}
      >
        {tiles.length === 0 ? (
          <div style={{ color: '#bbb', fontSize: 13, padding: '28px 12px' }}>
            {editable ? 'Empty row — add tiles above, or drag a tile here →' : 'No tiles'}
          </div>
        ) : (
          tiles.map((t) => (
            <div key={t.id} style={{ flex: `0 0 ${cardW}px`, width: cardW, height: cardH, scrollSnapAlign: 'start' }}>
              <TileFrame
                tile={t}
                filterValues={filterValues}
                editable={editable}
                onEdit={() => onEditTile?.(t.id)}
                onRemove={() => onRemoveTile?.(t.id)}
                onDuplicate={() => onDuplicateTile?.(t.id)}
              />
            </div>
          ))
        )}
      </div>
        {editable && onChangeSize && (
          <div onMouseDown={startResize} title="Drag to resize cards" style={resizeHandle} />
        )}
      </div>
    </div>
  );
}

const GAP = 12;
const miniBtn = { padding: '6px 10px', background: '#fff', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const arrowBtn = { width: 30, height: 30, borderRadius: '50%', border: '1.5px solid #e0e0e0', background: '#fff', cursor: 'pointer', fontSize: 18, lineHeight: 1, color: '#555', flexShrink: 0 };
const iconBtn = { width: 26, height: 26, borderRadius: 6, border: '1.5px solid #e0e0e0', background: '#fff', cursor: 'pointer', fontSize: 13, lineHeight: 1, color: '#555' };
const resizeHandle = {
  position: 'absolute', right: 2, bottom: 10, width: 18, height: 18,
  cursor: 'nwse-resize', borderRight: '3px solid #cbd5e1', borderBottom: '3px solid #cbd5e1',
  borderBottomRightRadius: 4,
};
