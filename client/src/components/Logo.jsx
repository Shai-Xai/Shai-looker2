import { useState } from 'react';

// Product logo. Renders the brand image dropped in at /logo.png (Vite serves
// client/public/* at the web root). Until that file exists — or if it fails to
// load — it falls back to an on-brand gradient mark so the UI is never broken.
export default function Logo({ size = 30, radius = 8 }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        style={{
          width: size, height: size, borderRadius: radius, flexShrink: 0,
          background: 'linear-gradient(135deg, #FF385C 0%, #FF6B35 45%, #7C3AED 100%)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
        aria-label="Howler : Pulse"
      >
        <svg width={size * 0.56} height={size * 0.56} viewBox="0 0 24 24" fill="white">
          <path d="M9 3v11.5a3.5 3.5 0 1 0 2 3.13V8h7V3H9zm-1.5 16a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM11 6V5h5v1h-5z" />
        </svg>
      </div>
    );
  }

  return (
    <img
      src="/logo.png"
      alt="Howler : Pulse"
      onError={() => setFailed(true)}
      style={{ width: size, height: size, borderRadius: radius, objectFit: 'cover', display: 'block', flexShrink: 0 }}
    />
  );
}
