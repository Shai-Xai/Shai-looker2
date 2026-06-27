// ─── White-label brand engine ──────────────────────────────────────────────────
// One source of truth for the brand pair (primary + secondary) AND the brand
// logo. Howler's look is the default; a client's pair + logo swap in via the SAME
// mechanics — CSS variables for the UI, a generated 10-colour chart palette, and
// the resolved logo shown across the app shell (sidebar + identity).

import { useState, useEffect } from 'react';

const HOWLER_PRIMARY = '#FF385C';
const HOWLER_SECONDARY = '#FF6B35';
// Howler's hand-tuned chart palette (primary, secondary, then series colours).
const HOWLER_PALETTE = ['#FF385C', '#FF6B35', '#FFB020', '#06B6D4', '#7C3AED', '#10B981', '#EC4899', '#3B82F6', '#F97316', '#14B8A6'];
// The fixed tail (series 6-10) for the Howler default.
const HOWLER_TAIL = ['#10B981', '#EC4899', '#3B82F6', '#F97316', '#14B8A6'];

let current = { primary: HOWLER_PRIMARY, secondary: HOWLER_SECONDARY, chart3: '', chart4: '', chart5: '', logo: '', logoDark: '', metricScale: 1 };

// Clamp a metric-size multiplier to a sane range; blank/garbage → 1 (default).
function cleanScale(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.max(0.6, Math.min(1.6, n)) : 1; }

// ── colour maths ──
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');
}
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s, l];
}
function hslToRgb([h, s, l]) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
const shift = (hex, dH, dS = 0, dL = 0) => {
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  return rgbToHex(hslToRgb([h + dH, Math.max(0.35, Math.min(0.95, s + dS)), Math.max(0.32, Math.min(0.62, l + dL))]));
};
const darken = (hex, amt) => { const [h, s, l] = rgbToHsl(hexToRgb(hex)); return rgbToHex(hslToRgb([h, s, Math.max(0, l - amt)])); };
const norm = (hex) => (hex || '').trim().toLowerCase();

// ── chart palette ──
// Up to FIVE explicit brand colours (primary, secondary, chart3-5) lead the
// palette; any unset slots and the tail (series 6-10) are filled — with Howler's
// hand-tuned colours for the default pair, or generated from the pair for a
// white-labelled client (cohesive with the brand, distinct enough per series).
export function chartPalette() {
  const { primary, secondary, chart3, chart4, chart5 } = current;
  const isHowler = norm(primary) === norm(HOWLER_PRIMARY) && norm(secondary) === norm(HOWLER_SECONDARY);
  // Generated fallbacks for each slot, used when a slot is left blank.
  const gen = [
    primary, secondary,
    shift(secondary, 35, 0, 0.04),
    shift(primary, 150, -0.05, 0),
    shift(primary, -60, 0, -0.02),
  ];
  const howlerHead = HOWLER_PALETTE.slice(0, 5);
  const slot = (val, i) => val || (isHowler ? howlerHead[i] : gen[i]);
  const head = [
    slot(primary, 0), slot(secondary, 1), slot(chart3, 2), slot(chart4, 3), slot(chart5, 4),
  ];
  const tail = isHowler ? HOWLER_TAIL : [
    shift(secondary, 90, -0.05, 0),
    shift(primary, 40, 0, 0.05),
    shift(secondary, -130, 0, 0),
    shift(primary, 200, -0.1, 0.03),
    shift(secondary, 160, -0.05, -0.02),
  ];
  return [...head, ...tail].slice(0, 10);
}
export const brandPrimary = () => current.primary;

// ── CSS variable application ──
export function applyBrand({ primary, secondary, chart3, chart4, chart5, logo, logoDark, metricScale } = {}) {
  current = { primary: primary || HOWLER_PRIMARY, secondary: secondary || HOWLER_SECONDARY, chart3: chart3 || '', chart4: chart4 || '', chart5: chart5 || '', logo: logo || '', logoDark: logoDark || '', metricScale: cleanScale(metricScale) };
  const root = document.documentElement;
  root.style.setProperty('--brand', current.primary);
  root.style.setProperty('--brand-2', current.secondary);
  root.style.setProperty('--brand-dark', darken(current.primary, 0.1));
  root.style.setProperty('--brand-rgb', hexToRgb(current.primary).join(','));
  window.dispatchEvent(new Event('brand-changed'));
}
export function resetBrand() {
  current = { primary: HOWLER_PRIMARY, secondary: HOWLER_SECONDARY, chart3: '', chart4: '', chart5: '', logo: '', logoDark: '', metricScale: 1 };
  const root = document.documentElement;
  for (const v of ['--brand', '--brand-2', '--brand-dark', '--brand-rgb']) root.style.removeProperty(v);
  window.dispatchEvent(new Event('brand-changed'));
}
// The active brand's KPI number-size multiplier (1 = default). Subscribe a
// component to it; re-renders when branding changes.
export const metricScale = () => current.metricScale;
export function useMetricScale() {
  const [v, setV] = useState(current.metricScale);
  useEffect(() => {
    const on = () => setV(current.metricScale);
    window.addEventListener('brand-changed', on);
    return () => window.removeEventListener('brand-changed', on);
  }, []);
  return v;
}

// The active client's resolved brand logo (their branding logo, falling back to
// their entity logo) — shown across the app shell. '' = Howler default (no logo).
export const brandLogo = () => current.logo;
// The active client's optional DARK-MODE logo ('' = none → fall back to `logo`).
export const brandLogoDark = () => current.logoDark;
// Subscribe a component to the current brand logo, resolved for the active theme:
// in dark mode the dark-specific logo wins when set, else the normal logo (which
// the shell puts on a light chip so it stays legible). Pass the theme string;
// omit it to always get the light logo. Re-renders when branding changes.
export function useBrandLogo(theme) {
  const [v, setV] = useState({ logo: current.logo, logoDark: current.logoDark });
  useEffect(() => {
    const on = () => setV({ logo: current.logo, logoDark: current.logoDark });
    window.addEventListener('brand-changed', on);
    return () => window.removeEventListener('brand-changed', on);
  }, []);
  return theme === 'dark' && v.logoDark ? v.logoDark : v.logo;
}
// Whether the active brand has a dedicated dark-mode logo — lets the shell skip
// the legibility chip when the client has supplied a proper dark variant.
export function useBrandHasDarkLogo() {
  const [v, setV] = useState(!!current.logoDark);
  useEffect(() => {
    const on = () => setV(!!current.logoDark);
    window.addEventListener('brand-changed', on);
    return () => window.removeEventListener('brand-changed', on);
  }, []);
  return v;
}
