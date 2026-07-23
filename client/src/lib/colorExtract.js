// ─── Logo → brand palette extraction ───────────────────────────────────────────
// Reads an image (data-URL or same-origin/CORS-friendly URL), samples its
// pixels, and returns up to N dominant, *brand-usable* colours — saturated and
// mid-lightness preferred; greys, near-white and near-black ignored; picks are
// forced apart in hue/lightness so they work as distinct chart series.

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // best effort for URL logos
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load the image'));
    img.src = src;
  });
}

function rgbToHsl(r, g, b) {
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
const hex = (r, g, b) => '#' + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');

export async function extractPaletteFromImage(src, count = 5) {
  const img = await loadImage(src);
  const S = 80; // sample resolution — plenty for dominant colours
  const scale = Math.min(1, S / Math.max(img.width || S, img.height || S));
  const w = Math.max(1, Math.round((img.width || S) * scale));
  const h = Math.max(1, Math.round((img.height || S) * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  let data;
  try { ({ data } = ctx.getImageData(0, 0, w, h)); }
  catch { throw new Error('This image blocks colour reading — upload the logo file instead of using a URL'); }

  // Histogram on quantised RGB (16 levels/channel), tracking true averages.
  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 200) continue; // transparent
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const [, s, l] = rgbToHsl(r, g, b);
    if (s < 0.22 || l < 0.12 || l > 0.9) continue; // greys / near-black / near-white
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
    e.r += r; e.g += g; e.b += b; e.n += 1;
    buckets.set(key, e);
  }
  if (!buckets.size) throw new Error('No usable brand colours found in this image');

  // Score = prominence × vibrancy; then greedily pick colours far enough apart.
  const cands = [...buckets.values()].map((e) => {
    const r = e.r / e.n, g = e.g / e.n, b = e.b / e.n;
    const [hDeg, s, l] = rgbToHsl(r, g, b);
    // Prefer mid-lightness, saturated colours (what buttons/series need).
    const vib = s * (1 - Math.abs(l - 0.5) * 1.4);
    return { r, g, b, h: hDeg, s, l, score: e.n * (0.3 + vib) };
  }).sort((a, b) => b.score - a.score);

  const picks = [];
  const farEnough = (x) => picks.every((p) => {
    const dh = Math.min(Math.abs(p.h - x.h), 360 - Math.abs(p.h - x.h));
    return dh > 24 || Math.abs(p.l - x.l) > 0.22;
  });
  // Only genuinely-present colours qualify: anti-aliased edge blends score a
  // tiny fraction of a real brand colour — better to return 3 true colours
  // (leaving slots to the generator) than pad with sludge.
  const minScore = cands[0].score * 0.05;
  for (const cand of cands) {
    if (cand.score < minScore) break;
    if (farEnough(cand)) picks.push(cand);
    if (picks.length >= count) break;
  }
  return picks.map((p) => hex(p.r, p.g, p.b));
}
