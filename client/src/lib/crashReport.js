// Report a genuine front-end crash to the server (POST /api/client-error →
// structured log + throttled ops Slack alert). Fire-and-forget: reporting must
// never throw, block, or matter to the user experience. Deploy-hiccup crashes
// (stale bundle during a rollout) are NOT reported — callers filter those.
export default function crashReport(error, info = {}) {
  try {
    const body = JSON.stringify({
      message: String(error?.message || error || '').slice(0, 500),
      stack: String(error?.stack || '').slice(0, 4000),
      componentStack: String(info?.componentStack || '').slice(0, 2000),
      url: window.location.pathname,
    });
    // sendBeacon survives the tab closing right after a crash; fetch is the fallback.
    if (!navigator.sendBeacon?.('/api/client-error', new Blob([body], { type: 'application/json' }))) {
      fetch('/api/client-error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
  } catch { /* never let reporting cause its own crash */ }
}
