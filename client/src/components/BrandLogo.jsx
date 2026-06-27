import { useTheme } from '../lib/theme.jsx';
import { useBrandLogo, useBrandHasDarkLogo } from '../lib/brand.js';

// The ACTIVE client's brand logo in the app shell (top-left identity). Handles
// dark mode two ways, per the client's branding:
//   • if they uploaded a dedicated dark-mode logo, use it as-is in dark mode;
//   • otherwise fall back to their normal logo on a subtle light chip, so a
//     dark-ink logo never disappears against the dark header.
// Falls back to the initial letter when there's no logo at all.
export default function BrandLogo({ size = 30, name = '', fallback = '', radius = 8 }) {
  const { theme } = useTheme();
  const src = useBrandLogo(theme) || fallback;
  const hasDark = useBrandHasDarkLogo();
  if (!src) {
    return (
      <span style={{ width: size, height: size, borderRadius: 7, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.5, fontWeight: 800, color: '#fff', background: 'var(--brand)' }}>
        {(name || '?').trim().charAt(0).toUpperCase()}
      </span>
    );
  }
  const img = <img src={src} alt="" style={{ height: size, maxWidth: size * 2.8, objectFit: 'contain', display: 'block', flexShrink: 0 }} />;
  // Safety net: a non-dark logo on the dark header gets a light backing chip so
  // it stays legible. A supplied dark logo opts out (it's already made for dark).
  if (theme !== 'dark' || hasDark) return img;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '3px 6px', borderRadius: radius, background: 'rgba(255,255,255,0.92)', boxShadow: '0 1px 2px rgba(0,0,0,0.25)', flexShrink: 0 }}>
      {img}
    </span>
  );
}
