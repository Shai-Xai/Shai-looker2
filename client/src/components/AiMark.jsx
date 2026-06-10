import { useState } from 'react';

// The Howler owl — our "AI" mark, used everywhere we used to show a ✨ emoji
// (tile insight buttons, dashboard summary, AI panel headers). A rotating glow
// halo sits behind it and a couple of sparkles twinkle around it.
//
// Drop the owl image in at client/public/ai-mark.png (Vite serves client/public/*
// at the web root). Until that file exists — or if it fails to load — it falls
// back to the ✨ emoji so the UI is never broken.
// `quiet` renders the bare owl — no halo, no sparkles, no breathing — for
// dense surfaces (mobile tile corners) where the full treatment is noisy.
export default function AiMark({ size = 18, sparkle = true, quiet = false, style }) {
  const [failed, setFailed] = useState(false);

  return (
    <span className={`ai-mark${quiet ? ' quiet' : ''}`} style={{ width: size, height: size, fontSize: size, ...style }} aria-hidden="true">
      {failed ? (
        <span style={{ position: 'relative', zIndex: 1, lineHeight: 1 }}>✨</span>
      ) : (
        <img src="/ai-mark.png" alt="" className="ai-mark-img" onError={() => setFailed(true)} />
      )}
      {sparkle && !quiet && (
        <>
          <span className="ai-spark s1">✦</span>
          <span className="ai-spark s2">✦</span>
        </>
      )}
    </span>
  );
}
