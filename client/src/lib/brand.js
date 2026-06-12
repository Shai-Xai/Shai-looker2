// ─── White-label brand engine ──────────────────────────────────────────────────
// One source of truth for the brand pair (primary + secondary). Howler's look
// is the default; a client's pair swaps in via the SAME mechanics — CSS
// variables for the UI, and a generated 10-colour chart palette that replicates
// how Howler's own palette relates to its brand pair.

const HOWLER_PRIMARY = '#FF385C';
const HOWLER_SECONDARY = '#FF6B35';
// Howler's hand-tuned chart palette (primary, secondary, then series colours).
const HOWLER_PALETTE = ['#FF385C', '#FF6B35', '#FFB020', '#06B6D4', '#7C3AED', '#10B981', '#EC4899', '#3B82F6', '#F97316', '#14B8A6'];

let current = { primary: HOWLER_PRIMARY, secondary: HOWLER_SECONDARY };

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
// Howler's pair gets Howler's exact hand-tuned palette. Any other pair gets the
// same structure generated: primary, secondary, then alternating hue-shifts off
// each — cohesive with the brand but distinct enough to separate series.
export function chartPalette() {
  const { primary, secondary } = current;
  if (norm(primary) === norm(HOWLER_PRIMARY) && norm(secondary) === norm(HOWLER_SECONDARY)) return HOWLER_PALETTE;
  return [
    primary,
    secondary,
    shift(secondary, 35, 0, 0.04),   // analogous past secondary
    shift(primary, 150, -0.05, 0),   // complementary-ish of primary
    shift(primary, -60, 0, -0.02),   // cool side of primary
    shift(secondary, 90, -0.05, 0),
    shift(primary, 40, 0, 0.05),
    shift(secondary, -130, 0, 0),
    shift(primary, 200, -0.1, 0.03),
    shift(secondary, 160, -0.05, -0.02),
  ];
}
export const brandPrimary = () => current.primary;

// ── CSS variable application ──
export function applyBrand({ primary, secondary } = {}) {
  current = { primary: primary || HOWLER_PRIMARY, secondary: secondary || HOWLER_SECONDARY };
  const root = document.documentElement;
  root.style.setProperty('--brand', current.primary);
  root.style.setProperty('--brand-2', current.secondary);
  root.style.setProperty('--brand-dark', darken(current.primary, 0.1));
  root.style.setProperty('--brand-rgb', hexToRgb(current.primary).join(','));
  window.dispatchEvent(new Event('brand-changed'));
}
export function resetBrand() {
  current = { primary: HOWLER_PRIMARY, secondary: HOWLER_SECONDARY };
  const root = document.documentElement;
  for (const v of ['--brand', '--brand-2', '--brand-dark', '--brand-rgb']) root.style.removeProperty(v);
  window.dispatchEvent(new Event('brand-changed'));
}
