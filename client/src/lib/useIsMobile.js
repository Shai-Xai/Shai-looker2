import { useState, useEffect } from 'react';

// Single source of truth for the mobile breakpoint. Tablet+ (>=768px) keeps the
// desktop grid/builder; below that we switch to a stacked, view-only layout.
const QUERY = '(max-width: 767px)';

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(QUERY).matches : false
  );
  useEffect(() => {
    if (!window.matchMedia) return;
    const mql = window.matchMedia(QUERY);
    const onChange = (e) => setIsMobile(e.matches);
    mql.addEventListener ? mql.addEventListener('change', onChange) : mql.addListener(onChange);
    setIsMobile(mql.matches);
    return () => (mql.removeEventListener ? mql.removeEventListener('change', onChange) : mql.removeListener(onChange));
  }, []);
  return isMobile;
}
