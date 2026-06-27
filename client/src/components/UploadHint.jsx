// Shared upload-spec guidance shown beneath any image upload control, so users
// know what to provide before they pick a file. One component, a few presets —
// used identically across admin and client self-service surfaces so the advice
// never drifts. Pass `kind` for a preset, or `text` to override.
//
//   <UploadHint kind="logo" />
//   <UploadHint kind="icon" />
//   <UploadHint kind="banner" />

const SPECS = {
  // Brand logo: sidebar identity + top of every email; also rendered small.
  logo: 'PNG or SVG, transparent background. Square at least 512×512px, or a landscape lockup up to about 1200px wide. Under 2MB. It renders small in the header, so keep it legible at 40px.',
  // Small square icon (suite/dashboard): shown tiny, so simple shapes read best.
  icon: 'PNG or SVG, square, transparent background. At least 128×128px (256×256 is plenty), under 1MB. It shows small (~26px), so keep it simple and legible — or just pick an emoji.',
  // Wide hero/banner image for emails & campaigns.
  banner: 'JPG or PNG, landscape. About 1200px wide (16:9 or wider) works best, under 2MB. Keep important detail away from the edges — it may be cropped on small screens.',
};

export default function UploadHint({ kind = 'logo', text, style }) {
  const body = text || SPECS[kind] || SPECS.logo;
  return (
    <p style={{ ...wrap, ...style }}>
      <span style={{ flexShrink: 0 }} aria-hidden="true">ⓘ</span>
      <span>{body}</span>
    </p>
  );
}

const wrap = {
  display: 'flex', gap: 6, alignItems: 'flex-start', margin: '6px 0 0',
  fontSize: 11.5, lineHeight: 1.45, color: 'var(--muted)', maxWidth: 420,
};
