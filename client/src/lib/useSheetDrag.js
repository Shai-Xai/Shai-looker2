import { useRef, useState } from 'react';

// Drag-to-dismiss for mobile bottom sheets. Returns touch handlers + a live
// transform style. Drag down past the threshold closes; release short of it
// springs back. Dragging up rubber-bands (resists) so the sheet feels physical.
export function useSheetDrag(onClose, { threshold = 90 } = {}) {
  const [dy, setDy] = useState(0);
  const startY = useRef(null);

  const onTouchStart = (e) => { startY.current = e.touches[0].clientY; };
  const onTouchMove = (e) => {
    if (startY.current == null) return;
    const d = e.touches[0].clientY - startY.current;
    setDy(d > 0 ? d : d * 0.25); // resist upward drags
  };
  const onTouchEnd = () => {
    if (dy > threshold) { onClose(); return; }
    setDy(0);
    startY.current = null;
  };

  const style = dy
    ? { transform: `translateY(${dy}px)`, transition: 'none', opacity: Math.max(0.4, 1 - dy / 500) }
    : { transition: 'transform .28s var(--ease-out, ease)' };

  return { handlers: { onTouchStart, onTouchMove, onTouchEnd }, style, dragging: dy !== 0 };
}
