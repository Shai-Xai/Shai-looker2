// Build-time feature flags. Flip a value here to show/hide a feature across the
// app — trivial to toggle when we're ready to ship something. Keep these to
// genuinely in-progress / paused features; anything configurable per client
// belongs in settings, not here.
export const FEATURES = {
  // "Ask" (the embedded Inventive analyst) — live in the nav. Shows a "not
  // connected yet" message if the Inventive API key/token aren't configured.
  ask: true,
};
