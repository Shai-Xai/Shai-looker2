// Email theme presets — the client mirror of server/emailTheme.js (for the picker).
// The actual render is server-side (the live preview shows it), so this only needs
// the option lists + swatches. Keep in sync with server/emailTheme.js.

export const THEME_PRESETS = [
  { key: 'clean', label: 'Clean', swatch: ['#f5f5f7', '#ffffff', '#111111'] },
  { key: 'bold', label: 'Bold', swatch: ['#0b0b0f', '#16161c', '#ffffff'] },
  { key: 'warm', label: 'Warm', swatch: ['#fbf6ef', '#ffffff', '#2a2018'] },
  { key: 'minimal', label: 'Minimal', swatch: ['#ffffff', '#ffffff', '#111111'] },
];
export const THEME_FONTS = [['system', 'System'], ['rounded', 'Rounded'], ['serif', 'Serif'], ['mono', 'Mono']];
export const THEME_SHAPES = [['pill', 'Pill'], ['rounded', 'Rounded'], ['square', 'Square']];
