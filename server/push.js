// ─── Web Push (disposable module) ─────────────────────────────────────────────
// Turns Pulse into an installable app that can push notifications. Push-only —
// no asset caching, so it never interferes with normal deploys. Mounts with one
// line and is fully behind a kill switch (settings key `push_enabled`).
//
// VAPID keys are generated once and persisted in the settings table (like the
// session secret), so nothing to configure. Subscriptions are per browser/device
// and tied to a user; sends fan out by entity (a client's whole team) reusing
// the same notification points as email.
const webpush = require('web-push');

let sql = null;
let _db = null;

const enabled = () => _db && _db.getSetting('push_enabled', '1') !== '0'; // on by default

// One-time VAPID identity, persisted. Subject must be a mailto:/https: URI.
function ensureVapid() {
  let pub = _db.getSetting('vapid_public', '');
  let priv = _db.getSetting('vapid_private', '');
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey; priv = keys.privateKey;
    _db.setSetting('vapid_public', pub);
    _db.setSetting('vapid_private', priv);
  }
  const subject = process.env.PUSH_SUBJECT || _db.getSetting('push_subject', '') || 'mailto:support@howler.co.za';
  webpush.setVapidDetails(subject, pub, priv);
  return pub;
}

function mount(app, { db, auth }) {
  _db = db;
  sql = db.db; // raw better-sqlite3 handle
  sql.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      endpoint   TEXT NOT NULL UNIQUE,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      ua         TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
  `);
  const publicKey = ensureVapid();
  const now = () => new Date().toISOString();
  const uuid = () => require('crypto').randomUUID();
  const off = (res) => res.status(404).json({ error: 'Push is disabled' });

  // Public-ish: the VAPID public key + whether push is on (auth so we know who).
  app.get('/api/push/key', auth.requireAuth, (_req, res) => {
    res.json({ enabled: enabled(), publicKey: enabled() ? publicKey : '' });
  });

  // Register this device's subscription for the signed-in user.
  app.post('/api/push/subscribe', auth.requireAuth, (req, res) => {
    if (!enabled()) return off(res);
    const sub = req.body?.subscription || req.body || {};
    const endpoint = sub.endpoint;
    const p256dh = sub.keys?.p256dh;
    const a = sub.keys?.auth;
    if (!endpoint || !p256dh || !a) return res.status(400).json({ error: 'Invalid subscription' });
    sql.prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, ua, created_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth, ua=excluded.ua`)
      .run(uuid(), req.user.id, endpoint, p256dh, a, String(req.headers['user-agent'] || '').slice(0, 300), now());
    res.status(201).json({ ok: true });
  });

  // Drop a subscription (logout / toggle off on this device).
  app.post('/api/push/unsubscribe', auth.requireAuth, (req, res) => {
    const endpoint = req.body?.endpoint;
    if (endpoint) sql.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?').run(endpoint, req.user.id);
    res.json({ ok: true });
  });

  // Send a test push to the caller's own devices.
  app.post('/api/push/test', auth.requireAuth, async (req, res) => {
    if (!enabled()) return off(res);
    const n = await sendToUser(req.user.id, { title: 'Howler : Pulse', body: 'Notifications are on 🎉', url: '/' });
    res.json({ sent: n });
  });

  console.log('[push] web push mounted', enabled() ? '(enabled)' : '(disabled — set push_enabled=1)');
}

// ── send helpers (used by os.js and any other notification point) ─────────────
async function deliver(rows, payload) {
  if (!enabled() || !rows.length) return 0;
  const data = JSON.stringify(payload);
  let sent = 0;
  await Promise.all(rows.map(async (r) => {
    try {
      await webpush.sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, data);
      sent++;
    } catch (err) {
      // 404/410 = the subscription is dead (app uninstalled, permission revoked).
      if (err.statusCode === 404 || err.statusCode === 410) {
        try { sql.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(r.endpoint); } catch { /* ignore */ }
      } else {
        console.error('[push] send failed', err.statusCode || err.message);
      }
    }
  }));
  return sent;
}

function sendToUser(userId, payload) {
  if (!enabled()) return Promise.resolve(0);
  const rows = sql.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=?').all(userId);
  return deliver(rows, payload);
}

// Fan out to every login linked to an entity (the client's whole team). Admins
// linked to that client are included — same rule as the email nudge.
function sendToEntity(entityId, payload) {
  if (!enabled() || !entityId) return Promise.resolve(0);
  const userIds = _db.listUsers().filter((u) => (u.entityIds || []).includes(entityId)).map((u) => u.id);
  if (!userIds.length) return Promise.resolve(0);
  const ph = userIds.map(() => '?').join(',');
  const rows = sql.prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id IN (${ph})`).all(...userIds);
  return deliver(rows, payload);
}

module.exports = { mount, sendToUser, sendToEntity, isEnabled: enabled };
