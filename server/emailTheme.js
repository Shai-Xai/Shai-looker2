// ─── Email theme — the "look" the Owl (or an author) can set on a campaign ─────
// Tier-1 visual design within email's hard constraints: a page/card background,
// text + heading colours, an accent (buttons/links), a font family and a button
// shape, chosen as a PRESET and optionally tweaked. Resolved against the client's
// brand (accent defaults to their brand colour) and applied by the block renderer +
// the branded shell. PURE (no db) and colour-validated (values go into inline
// styles, so only hex/simple names are allowed — no CSS injection).

const FONTS = {
  system: "-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif",
  rounded: "'Trebuchet MS','Segoe UI',-apple-system,sans-serif",
  serif: "Georgia,'Times New Roman',serif",
  mono: "ui-monospace,Menlo,Consolas,monospace",
};
const RADII = { pill: '980px', rounded: '10px', square: '0' };

// Named looks. `card` styles wrap content in a bordered card; `flat` sits on the page.
const PRESETS = {
  clean: { bg: '#f5f5f7', card: '#ffffff', text: '#3a3a3c', heading: '#111111', font: 'system', radius: 'pill', cardStyle: 'card' },
  bold: { bg: '#0b0b0f', card: '#16161c', text: '#d4d4d8', heading: '#ffffff', font: 'system', radius: 'rounded', cardStyle: 'card' },
  warm: { bg: '#fbf6ef', card: '#ffffff', text: '#4a3f35', heading: '#2a2018', font: 'serif', radius: 'rounded', cardStyle: 'card' },
  minimal: { bg: '#ffffff', card: '#ffffff', text: '#3a3a3c', heading: '#111111', font: 'system', radius: 'square', cardStyle: 'flat' },
};
const PRESET_KEYS = Object.keys(PRESETS);

// A CSS-safe colour: #rgb / #rrggbb / #rrggbbaa, or a short alphabetic name. Anything
// else → the fallback (never let arbitrary text into an inline style value).
const safeColor = (v, fallback) => {
  const s = String(v == null ? '' : v).trim();
  return (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s) || /^[a-z]{3,20}$/i.test(s)) ? s : fallback;
};

// Sanitise a theme blob from client input (enums + validated colours). Blank fields
// stay blank so resolve() can inherit the preset/brand below them.
function clean(theme = {}) {
  const t = theme || {};
  const out = { preset: PRESET_KEYS.includes(t.preset) ? t.preset : 'clean' };
  if (t.accent) out.accent = safeColor(t.accent, '');
  if (t.bg) out.bg = safeColor(t.bg, '');
  if (t.card) out.card = safeColor(t.card, '');
  if (t.text) out.text = safeColor(t.text, '');
  if (t.heading) out.heading = safeColor(t.heading, '');
  if (['system', 'rounded', 'serif', 'mono'].includes(t.font)) out.font = t.font;
  if (['pill', 'rounded', 'square'].includes(t.radius)) out.radius = t.radius;
  if (['card', 'flat'].includes(t.cardStyle)) out.cardStyle = t.cardStyle;
  return out;
}

// Resolve a (possibly partial) theme + the client's brand → concrete style tokens the
// renderer uses. Preset is the base; explicit theme fields override it; accent falls
// back to the brand colour.
function resolve(theme = {}, brand = {}) {
  const base = PRESETS[theme && theme.preset] || PRESETS.clean;
  const pick = (k) => (theme && String(theme[k] || '').trim() ? theme[k] : base[k]);
  return {
    preset: (theme && theme.preset) || 'clean',
    bg: safeColor(pick('bg'), base.bg),
    card: safeColor(pick('card'), base.card),
    text: safeColor(pick('text'), base.text),
    heading: safeColor(pick('heading'), base.heading),
    accent: safeColor((theme && theme.accent) || brand.brandColor, base.heading),
    fontStack: FONTS[pick('font')] || FONTS.system,
    radiusPx: RADII[pick('radius')] || RADII.pill,
    flat: pick('cardStyle') === 'flat',
  };
}

// For the picker UI (client mirrors this list).
const presets = () => PRESET_KEYS.map((key) => ({ key, ...PRESETS[key] }));

module.exports = { clean, resolve, presets, PRESET_KEYS, FONTS, RADII };
