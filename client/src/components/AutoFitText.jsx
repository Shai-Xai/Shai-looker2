import { useRef, useLayoutEffect } from 'react';

// Shrinks its text to fit the tile — on BOTH width and height. KPI values vary
// wildly in length (38,947 vs 5,320,481.76), so a fixed font size either
// overflows narrow tiles or grows too tall for short/wide ones. This measures
// the box and binary-searches the largest font whose text fits within both
// dimensions, re-fitting when the tile resizes.
//
// The box must have a real height — callers pass `style` to give it one
// (e.g. flex:1 to fill remaining space, or a fixed height).
export default function AutoFitText({ children, max = 40, min = 12, widthFactor = 0, spanStyle, style, onClick, title }) {
  const boxRef = useRef(null);
  const spanRef = useRef(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const span = spanRef.current;
    if (!box || !span) return;

    const fit = () => {
      const w = box.clientWidth;
      const h = box.clientHeight;
      if (!w || !h) return;
      // Tie the cap to the box WIDTH so tiles of the same width render at the
      // same size (a short "785" doesn't balloon next to a long "1,903,565").
      const cap = widthFactor ? Math.max(min, Math.min(max, w * widthFactor)) : max;
      let lo = min, hi = cap, best = min;
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        span.style.fontSize = `${mid}px`;
        if (span.scrollWidth <= w && span.scrollHeight <= h) { best = mid; lo = mid; } else { hi = mid; }
      }
      span.style.fontSize = `${best}px`;
    };

    fit();
    let ro;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(fit);
      ro.observe(box);
    }
    return () => ro && ro.disconnect();
  }, [children, max, min, widthFactor]);

  return (
    <div
      ref={boxRef}
      onClick={onClick}
      title={title}
      style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', cursor: onClick ? 'pointer' : undefined, ...style }}
    >
      <span ref={spanRef} style={{ display: 'inline-block', whiteSpace: 'nowrap', lineHeight: 1.1, ...spanStyle }}>
        {children}
      </span>
    </div>
  );
}
