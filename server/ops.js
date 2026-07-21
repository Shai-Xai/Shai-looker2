// ─── Internal ops alerts — disposable module ──────────────────────────────────
// Before this existed, background failures (nightly digest errors, backup
// failures, mailer rejections) went to console.error — i.e. Render's log stream
// — and nobody was told. This module is the one place a background failure can
// raise a human: it posts to a Howler-INTERNAL Slack webhook (not a client's
// Slack — that's server/slack.js, a different concern).
//
// Configure with OPS_SLACK_WEBHOOK_URL in the environment, or the
// `ops_slack_webhook` setting (Admin-settable, write-only like other secrets).
// Unconfigured → falls back to console.error, same as before. Never throws.
//
// Alert storms are throttled: the same (kind) alerts at most once per
// THROTTLE_MS (15 min); suppressed repeats are counted and reported on the next
// send so information isn't lost, just batched.

let db = null;
const THROTTLE_MS = 15 * 60 * 1000;
const recent = new Map(); // kind -> { at, suppressed }

function init(deps) { db = deps.db; }

const webhook = () =>
  (process.env.OPS_SLACK_WEBHOOK_URL || '').trim() ||
  (db ? String(db.getSetting('ops_slack_webhook', '') || '').trim() : '');

const isConfigured = () => !!webhook();

// Fire-and-forget: callers must never await-block or fail on alerting.
function alert(kind, message) {
  const text = `⚠️ [pulse:${kind}] ${String(message || '').slice(0, 1500)}`;
  console.error(text); // always keep the log-stream trail
  const url = webhook();
  if (!url) return;

  const now = Date.now();
  const seen = recent.get(kind);
  if (seen && now - seen.at < THROTTLE_MS) { seen.suppressed += 1; return; }
  const suppressed = seen?.suppressed || 0;
  recent.set(kind, { at: now, suppressed: 0 });
  if (recent.size > 200) recent.clear(); // tiny; never grows unbounded

  const body = suppressed ? `${text}\n(+${suppressed} similar alert${suppressed > 1 ? 's' : ''} suppressed in the last 15 min)` : text;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: body }),
    signal: AbortSignal.timeout(10000),
  }).catch((e) => console.error('[ops] alert delivery failed:', e.message));
}

// Deliberate test send: bypasses the throttle and AWAITS the Slack response so
// the admin gets an honest sent/failed answer — the whole point is proving the
// channel works before a real incident needs it (silence must not look like
// success, same lesson as backups).
async function sendTest() {
  const url = webhook();
  if (!url) return { configured: false, sent: false, error: 'No ops Slack webhook configured — set OPS_SLACK_WEBHOOK_URL in Render → Environment.' };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '✅ [pulse:test] Ops alert test — if you can read this, background failures (backups, mailer, disk) will reach this channel.' }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return { configured: true, sent: false, error: `Slack responded HTTP ${r.status} — the webhook URL may be revoked or wrong.` };
    return { configured: true, sent: true };
  } catch {
    return { configured: true, sent: false, error: 'Could not reach Slack (network error or timeout).' };
  }
}

function mount(app, { auth }) {
  const { asyncHandler } = require('./http');
  app.get('/api/admin/ops', auth.requireAdmin, (_req, res) => res.json({ configured: isConfigured() }));
  app.post('/api/admin/ops/test', auth.requireSuperAdmin, asyncHandler(async (_req, res) => res.json(await sendTest())));
  return module.exports;
}

module.exports = { init, mount, alert, isConfigured, sendTest, _recent: recent };
