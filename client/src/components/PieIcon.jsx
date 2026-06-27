// Segments icon — a pie/slice, so Segments reads as "carve your audience into
// slices" and is no longer the same 🎯 target as Goals. Strokes in currentColor, so
// it tints with the nav row (muted → brand when active), unlike a flat emoji.
export default function PieIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 12V3" />
      <path d="M12 12h9" />
    </svg>
  );
}
