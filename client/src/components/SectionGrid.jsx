import { useState, useRef, useLayoutEffect } from 'react';
import GridLayout from 'react-grid-layout';
import TileFrame from './TileFrame.jsx';

const COLS = 24;
const ROW_HEIGHT = 30;

// A dashboard "section": a titled, full-width container whose tiles live on
// their OWN free-form grid (drag + resize independently). It's the grid-mode
// sibling of Carousel, sharing the same container handlers. The inner grid
// stops mousedown propagation so dragging a tile here doesn't also drag the
// whole section in the outer dashboard grid.
export default function SectionGrid({ carousel, filterValues, editable, onEditTile, onRemoveTile, onDuplicateTile, onAddTile, onChangeTitle, onRemove, onDropTile, onMoveTileOut, onTileLayout }) {
  const [dragOver, setDragOver] = useState(false);
  // Measure our own width so the nested grid lays out across the real columns
  // (WidthProvider mis-measures inside another grid item, collapsing tiles to
  // a single column so they can't sit side by side).
  const bodyRef = useRef(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!bodyRef.current) return;
    const el = bodyRef.current;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const tiles = carousel.tiles || [];
  const layout = tiles.map((t, i) => ({
    i: t.id,
    x: t.layout?.x ?? 0, y: t.layout?.y ?? i * 6, w: t.layout?.w ?? 8, h: t.layout?.h ?? 6,
    minW: 2, minH: 2,
  }));

  const handleChange = (nl) => {
    if (!onTileLayout) return;
    const m = {};
    for (const it of nl) m[it.i] = { x: it.x, y: it.y, w: it.w, h: it.h };
    onTileLayout(m);
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div
        className={editable ? 'tile-drag-handle' : undefined}
        style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, cursor: editable ? 'move' : 'default', flexShrink: 0 }}
      >
        {editable && <span style={{ color: '#bbb', fontSize: 13 }} title="Drag to move section">⠿⠿</span>}
        {editable ? (
          <input
            value={carousel.title || ''}
            onChange={(e) => onChangeTitle(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            placeholder="Section title"
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
            <button style={{ ...miniBtn, color: 'var(--error)', borderColor: '#f0c0c0' }} onClick={onRemove}>Delete section</button>
          </span>
        )}
      </div>

      <div
        ref={bodyRef}
        onMouseDown={editable ? (e) => e.stopPropagation() : undefined}
        onDragOver={editable && onDropTile ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (!dragOver) setDragOver(true); } : undefined}
        onDragLeave={editable && onDropTile ? () => setDragOver(false) : undefined}
        onDrop={editable && onDropTile ? (e) => { e.preventDefault(); setDragOver(false); const id = e.dataTransfer.getData('text/plain'); if (id) onDropTile(id); } : undefined}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', borderRadius: 8, outline: dragOver ? '2px dashed var(--brand)' : 'none', background: dragOver ? 'rgba(var(--brand-rgb), 0.04)' : 'transparent' }}
      >
        {tiles.length === 0 ? (
          <div style={{ color: '#bbb', fontSize: 13, padding: '20px 12px' }}>
            {editable ? 'Empty section — add tiles above, or drag a tile here' : 'No tiles'}
          </div>
        ) : width > 0 ? (
          <GridLayout
            className="layout"
            width={width}
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
            {tiles.map((t) => (
              <div key={t.id} style={{ position: 'relative' }}>
                <TileFrame
                  tile={t}
                  filterValues={filterValues}
                  editable={editable}
                  onEdit={() => onEditTile?.(t.id)}
                  onDuplicate={() => onDuplicateTile?.(t.id)}
                  onRemove={() => onRemoveTile?.(t.id)}
                />
                {editable && (onMoveTileOut || onRemoveTile) && (
                  <span style={cardCtrls} onMouseDown={(e) => e.stopPropagation()}>
                    {onMoveTileOut && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onMoveTileOut(t.id); }}
                        title="Move out to the dashboard grid"
                        aria-label="Move out to the dashboard grid"
                        style={cardCtrlBtn}
                      >⤴</button>
                    )}
                    {onRemoveTile && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onRemoveTile(t.id); }}
                        title="Remove from this section"
                        aria-label="Remove from this section"
                        style={{ ...cardCtrlBtn, color: 'var(--error)' }}
                      >✕</button>
                    )}
                  </span>
                )}
              </div>
            ))}
          </GridLayout>
        ) : null}
      </div>
    </div>
  );
}

const miniBtn = { padding: '6px 10px', background: 'var(--card)', border: '1.5px solid var(--hairline)', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const cardCtrls = { position: 'absolute', top: 4, right: 4, zIndex: 8, display: 'flex', gap: 4 };
const cardCtrlBtn = { width: 22, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 12, fontWeight: 700, lineHeight: 1, cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.18)' };
