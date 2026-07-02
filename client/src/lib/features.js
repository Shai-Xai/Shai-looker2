// Build-time feature flags. Flip a value here to show/hide a feature across the
// app — trivial to toggle when we're ready to ship something. Keep these to
// genuinely in-progress / paused features; anything configurable per client
// belongs in settings, not here.
export const FEATURES = {
  // "Ask" (the embedded Inventive analyst) — live in the nav. Shows a "not
  // connected yet" message if the Inventive API key/token aren't configured.
  ask: true,
  // The native, Claude-powered agentic Owl (askData over the curated catalogue).
  // When ON, the floating owl opens the native chat panel instead of Inventive.
  // Default OFF globally — gated to the allowlist below so we can dogfood it in
  // production without exposing it to clients (see AGENTIC_OWL_P1_PLAN.md).
  owlNativeChat: false,
};

// Per-user allowlist for the native Owl while it's in development: even with the
// global flag OFF, these accounts get it. The server enforces the same list on
// /api/owl/chat (OWL_CHAT_ALLOW env) — this only controls who SEES the UI.
const OWL_NATIVE_CHAT_ALLOW = ['shai.evian@howler.co.za'];
export function owlNativeChatEnabled(user) {
  if (FEATURES.owlNativeChat) return true;
  if (user?.owlEnabled) return true; // server-resolved (the owner can toggle this in Admin → AI)
  const email = String(user?.email || '').trim().toLowerCase();
  return !!email && OWL_NATIVE_CHAT_ALLOW.includes(email);
}

// Fan Owl SETTINGS (the config surfaces in Admin → client and Settings → Fan
// Owl) while the feature is dogfooding: only these accounts see the tabs. The
// server enforces the same gate on all /fan-owl config routes (FANOWL_ADMIN_ALLOW
// env — comma-separated emails, or "all" to open it). The fan-facing widget
// itself is public and unaffected by this.
const FAN_OWL_SETTINGS_ALLOW = ['shai.evian@howler.co.za'];
export function fanOwlSettingsEnabled(user) {
  const email = String(user?.email || '').trim().toLowerCase();
  return !!email && FAN_OWL_SETTINGS_ALLOW.includes(email);
}
