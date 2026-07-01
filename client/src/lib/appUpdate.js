// Detect a new deploy WITHOUT a service-worker cache. The production build's
// index.html references hashed asset bundles (e.g. /assets/index-AbC123.js) that
// change every build. We capture our own entry-bundle URL at boot, then poll the
// live index.html in the background; a different hash means a newer version
// shipped — so we prompt the user to reload (handy for an installed PWA window
// left open for days, which otherwise keeps running the old bundle). No-ops in
// dev (unhashed entry) and offline.

let bootSig = null;
let started = false;
const listeners = new Set();

// The entry module Vite injects: <script type="module" … src="/assets/index-HASH.js">
function sigFromHtml(html) {
  const m = html.match(/src="(\/assets\/index-[^"]+\.js)"/);
  return m ? m[1] : null;
}
// Our own currently-loaded entry bundle, read from the live document.
function currentSig() {
  if (typeof document === 'undefined') return null;
  return [...document.scripts].map((s) => s.getAttribute('src') || '').find((src) => /\/assets\/index-.*\.js/.test(src)) || null;
}

async function check() {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  try {
    const res = await fetch('/index.html', { cache: 'no-store' });
    if (!res.ok) return;
    const sig = sigFromHtml(await res.text());
    if (sig && bootSig && sig !== bootSig) listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  } catch { /* offline / transient — ignore */ }
}

// Subscribe to "a new version is available". Returns an unsubscribe fn.
export function onAppUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// Begin watching (call once). Skips in dev / when the entry isn't hashed.
export function startUpdateWatch() {
  if (started || typeof window === 'undefined') return;
  bootSig = currentSig();
  if (!bootSig) return; // dev server or unexpected markup — nothing to compare
  started = true;
  const tick = () => check();
  window.addEventListener('focus', tick);
  document.addEventListener('visibilitychange', tick);
  setInterval(tick, 20 * 60 * 1000);  // every 20 min while the app is open
  setTimeout(check, 30 * 1000);       // and once shortly after load
}
