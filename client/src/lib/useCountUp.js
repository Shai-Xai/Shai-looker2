import { useEffect, useRef, useState } from 'react';

// Count-up animation for KPI values that preserves Looker's exact rendering.
//
// The tile only has a *rendered string* ("R 18,191,613.50", "7.2%", "5,696"),
// so we parse it into prefix + number + suffix, animate the number with an
// ease-out, format each frame to match, and snap to the exact original string
// at the end — so the final state is always pixel-identical to Looker's.
// When the value changes later (filter switch) it counts from the previous
// value to the new one rather than restarting at zero.

const REDUCED = typeof window !== 'undefined'
  && window.matchMedia
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// "R18,191,613.50" → { prefix:"R", value:18191613.5, suffix:"", decimals:2, grouped:true }
export function parseRendered(text) {
  const m = String(text).match(/^([^\d\-+]*)([-+]?[\d.,\s ]*\d)(.*)$/);
  if (!m) return null;
  if (/\d/.test(m[3])) return null; // digits after the number → a date/compound, not a metric
  const numStr = m[2].replace(/[\s ,]/g, '');
  const value = Number(numStr);
  if (!Number.isFinite(value)) return null;
  return {
    prefix: m[1],
    value,
    suffix: m[3],
    decimals: (numStr.split('.')[1] || '').length,
    grouped: m[2].includes(','),
  };
}

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

export function useCountUp(finalText, { duration = 700 } = {}) {
  // First paint shows the formatted zero (not the final value) so there's no
  // one-frame flash of the finished number before the count starts.
  const [display, setDisplay] = useState(() => {
    if (REDUCED) return finalText;
    const p = parseRendered(finalText);
    if (!p) return finalText;
    return p.prefix + (0).toLocaleString('en-US', {
      minimumFractionDigits: p.decimals, maximumFractionDigits: p.decimals,
    }) + p.suffix;
  });
  const lastValueRef = useRef(0); // numeric value we last settled on
  const rafRef = useRef(null);

  useEffect(() => {
    if (REDUCED) { setDisplay(finalText); return; }
    const parsed = parseRendered(finalText);
    if (!parsed) { setDisplay(finalText); return; } // non-numeric → no animation

    const from = lastValueRef.current;
    const to = parsed.value;
    lastValueRef.current = to;
    if (from === to) { setDisplay(finalText); return; }

    const start = performance.now();
    const fmt = (v) => parsed.prefix + v.toLocaleString('en-US', {
      minimumFractionDigits: parsed.decimals,
      maximumFractionDigits: parsed.decimals,
      useGrouping: parsed.grouped,
    }) + parsed.suffix;

    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      if (t >= 1) { setDisplay(finalText); return; } // snap to Looker's exact string
      setDisplay(fmt(from + (to - from) * easeOutCubic(t)));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [finalText, duration]);

  return display;
}
