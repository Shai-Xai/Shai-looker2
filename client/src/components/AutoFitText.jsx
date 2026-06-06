import { useRef, useLayoutEffect } from 'react';

// Shrinks its text to fit the tile's width. KPI values vary wildly in length
// (38,947 vs 5,320,481.76), so a fixed font size either overflows narrow tiles
// or wastes space in wide ones. This measures the container and binary-searches
// the largest font (between min and max) whose text fits on one line, and
// re-fits when the tile resizes.
export default function AutoFitText({ children, max = 40, min = 13, spanStyle, onClick, title }) {
  const boxRef = useRef(null);
  const spanRef = useRef(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const span = spanRef.current;
    if (!box || !span) return;

    const fit = () => {
      const avail = box.clientWidth;
      if (!avail) return;
      let lo = min, hi = max, best = min;
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        span.style.fontSize = `${mid}px`;
        if (span.scrollWidth <= avail) { best = mid; lo = mid; } else { hi = mid; }
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
  }, [children, max, min]);

  return (
    <div
      ref={boxRef}
      onClick={onClick}
      title={title}
      style={{ width: '100%', overflow: 'hidden', textAlign: 'center', cursor: onClick ? 'pointer' : undefined }}
    >
      <span ref={spanRef} style={{ display: 'inline-block', whiteSpace: 'nowrap', lineHeight: 1.1, ...spanStyle }}>
        {children}
      </span>
    </div>
  );
}
