// PWA install helpers. Browsers fire `beforeinstallprompt` once, early — so we
// capture and defer it at module load, then expose a one-touch install later
// (Chrome/Edge/Android). iOS Safari has no programmatic install, so we detect it
// and the UI shows Add-to-Home-Screen guidance instead. All best-effort: where
// install isn't available these simply report so and the UI adapts.

let deferredPrompt = null;
const listeners = new Set();
const emit = () => listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; emit(); });
  window.addEventListener('appinstalled', () => { deferredPrompt = null; emit(); });
}

// Already running as an installed app (standalone display mode / iOS home-screen)?
export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return !!(window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone);
}

export function isIOS() {
  if (typeof navigator === 'undefined') return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
}

// Can we show a native install prompt right now?
export function canInstallApp() { return !!deferredPrompt; }

// Subscribe to install-availability changes (prompt captured, or app installed).
export function onInstallChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// Trigger the native install prompt. Returns 'installed' | 'dismissed' | 'unavailable'.
export async function promptInstall() {
  if (!deferredPrompt) return 'unavailable';
  const e = deferredPrompt;
  deferredPrompt = null; // a prompt can only be used once
  e.prompt();
  let outcome = 'dismissed';
  try { ({ outcome } = await e.userChoice); } catch { /* ignore */ }
  emit();
  return outcome === 'accepted' ? 'installed' : 'dismissed';
}
