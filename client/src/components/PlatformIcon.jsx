import { SiTiktok, SiMeta, SiYoutube, SiX } from 'react-icons/si';

// Real platform brand marks, in one place so every surface (hub, segments,
// integrations) shows the actual logo instead of a stand-in glyph. `live` marks
// which channels Pulse can actually sync today.
export const PLATFORMS = {
  tiktok: { Icon: SiTiktok, label: 'TikTok', color: 'currentColor', live: true },
  meta: { Icon: SiMeta, label: 'Meta', color: '#0866FF', live: true },
  x: { Icon: SiX, label: 'X', color: 'currentColor', live: false },
  youtube: { Icon: SiYoutube, label: 'YouTube', color: '#FF0000', live: false },
};

export default function PlatformIcon({ channel, size = 16, color, style }) {
  const p = PLATFORMS[channel];
  if (!p) return null;
  const Icon = p.Icon;
  return <Icon size={size} style={{ color: color || p.color, flexShrink: 0, verticalAlign: 'text-bottom', ...style }} aria-label={p.label} />;
}
