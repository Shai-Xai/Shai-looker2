// ─── House-style text normalisation ──────────────────────────────────────────
// Em dashes (—) and their cousins read as unprofessional in Pulse copy. This tiny,
// dependency-free helper normalises them to a spaced hyphen (" - "), which the
// product's copy guidance allows (comma or hyphen where a break is needed). It is
// used two ways:
//   • at authoring time on team-controlled seed/default copy (roles, onboarding,
//     templates, release notes), and
//   • as sanitise-on-save for user-authored copy going forward (campaign copy).
// It is deliberately conservative: it only rewrites dash GLYPHS and the spaces
// hugging them, never other punctuation, and never crosses a line break, so
// multi-line body copy keeps its structure. Idempotent and safe on non-strings.

// The dash glyphs we treat as "em-dash-like": figure dash, en dash, em dash and
// horizontal bar. The ASCII hyphen-minus (-) and the math minus (−) are left alone.
const DASHES = /[ \t]*[‒–—―][ \t]*/g;

// Normalise em/en dashes in a single string to a spaced hyphen.
function deEmDash(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(DASHES, ' - ');
}

// Walk a value (string / array / plain object) and de-em-dash every string in it.
// Handy for JSON copy blobs; leaves numbers, booleans and other types untouched.
function deEmDashDeep(value) {
  if (typeof value === 'string') return deEmDash(value);
  if (Array.isArray(value)) return value.map(deEmDashDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deEmDashDeep(v);
    return out;
  }
  return value;
}

// True if a string still contains an em-dash-like glyph (for the audit sweep).
function hasEmDash(text) {
  return typeof text === 'string' && /[‒–—―]/.test(text);
}

module.exports = { deEmDash, deEmDashDeep, hasEmDash };
