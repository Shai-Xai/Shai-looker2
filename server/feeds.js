// ─── PostHog warehouse feed — DISPOSABLE BRIDGE MODULE ──────────────────────────
// Serves Howler ORDER data (read via Looker) to PostHog's "Custom REST source"
// so PostHog's data warehouse gets users/transactional rows WITHOUT waiting on
// a dedicated Howler-platform API. Deliberately a BRIDGE for a handful of
// organisers: when the core API ships, repoint PostHog's source at it and
// delete this file + its mount line.
//
//   GET /api/feeds/orders?since=YYYY-MM-DD[ HH:MM]&limit=N
//   Authorization: Bearer <token>        (posthog_feed_token — write-only)
//
// Fail-closed twice over: no token configured, or an EMPTY organiser
// allowlist, serves nothing. Rows only ever cover allowlisted organisers.
// Purchaser email IS included — decided 2026-07-11: it's the person join key
// PostHog uses to stitch orders to app users. No phone numbers/names ride.
//
// Incremental pulls: pass ?since= (the previous page's `nextSince`); rows come
// sorted by order-created time ascending. Re-pull a trailing week on a
// schedule so refunds/status changes restate.
//
// Mount: require('./feeds').mount(app, { db, auth, runLookerQuery })

const crypto = require('node:crypto');
const { HttpError, asyncHandler } = require('./http');

const SINCE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/;

function mount(app, { db, auth, runLookerQuery }) {
  const orgs = () => {
    try { return (JSON.parse(db.getSetting('posthog_feed_orgs', '') || '[]') || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 40); }
    catch { return []; }
  };
  const tokenOk = (req) => {
    const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const want = db.getSetting('posthog_feed_token', '');
    if (!want || !got) return false;
    const a = Buffer.from(got), b = Buffer.from(want);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  // Find a model/explore exposing core_events.name by scanning saved dashboard
  // filters (same trick as posthog.js / /api/admin/filter-fields).
  function home() {
    for (const d of db.listDashboards ? db.listDashboards() : []) {
      const full = db.getDashboard ? db.getDashboard(d.id) : null;
      for (const f of full?.filters || []) {
        if ((f.field || f.dimension) === 'core_events.name' && f.model && f.explore) return { model: f.model, explore: f.explore };
      }
    }
    return null;
  }

  async function orderRows({ since = '', limit = 1000 } = {}) {
    const allow = orgs();
    if (!allow.length) throw new HttpError(403, 'The feed has no organisers allowlisted.');
    const h = home();
    if (!h || !runLookerQuery) throw new HttpError(503, 'The Looker lookup home is unavailable.');
    const L = Math.min(Math.max(Number(limit) || 1000, 1), 5000);
    const filters = { 'core_organisers.name': allow.join(',') };
    if (since) {
      if (!SINCE_RE.test(since)) throw new HttpError(400, 'since must be YYYY-MM-DD or YYYY-MM-DD HH:MM.');
      filters['core_orders.created_time'] = `after ${since.replace('T', ' ')}`;
    }
    const rows = await runLookerQuery('/queries/run/json', {
      model: h.model, view: h.explore,
      fields: ['core_orders.id', 'core_orders.created_time', 'core_orders.status', 'core_events.id', 'core_events.name', 'core_events.currency', 'core_purchasers.email', 'core_tickets.sum_revenue_decimal'],
      filters, sorts: ['core_orders.created_time'], limit: L,
    });
    const orders = (rows || []).map((r) => ({
      order_id: String(r['core_orders.id'] ?? ''),
      created_at: String(r['core_orders.created_time'] || ''),
      status: String(r['core_orders.status'] || ''),
      event_id: r['core_events.id'] == null ? '' : String(r['core_events.id']),
      event_name: String(r['core_events.name'] || ''),
      currency: String(r['core_events.currency'] || ''),
      email: String(r['core_purchasers.email'] || ''),
      amount: Number(r['core_tickets.sum_revenue_decimal']) || 0,
    })).filter((o) => o.order_id);
    return {
      orders,
      // full page → likely more; hand back the boundary as the next cursor
      nextSince: orders.length >= L ? orders[orders.length - 1].created_at : null,
      asOf: new Date().toISOString(),
    };
  }

  // ── the feed itself (token-authed; consumed by PostHog's REST source) ─────────
  app.get('/api/feeds/orders', asyncHandler(async (req, res) => {
    if (!tokenOk(req)) throw new HttpError(401, 'Missing or invalid feed token.');
    res.json(await orderRows({ since: String(req.query.since || ''), limit: req.query.limit }));
  }));

  // ── admin management (token write-only; organiser allowlist) ──────────────────
  app.get('/api/admin/feeds/settings', auth.requireAdmin, (_req, res) => {
    const t = db.getSetting('posthog_feed_token', '');
    res.json({ tokenSet: !!t, tokenHint: t ? `••••${t.slice(-4)}` : '', orgs: orgs(), path: '/api/feeds/orders' });
  });
  app.put('/api/admin/feeds/settings', auth.requireAdmin, (req, res) => {
    const b = req.body || {};
    if (b.clearToken) db.setSetting('posthog_feed_token', '');
    if (b.orgs !== undefined) {
      const list = (Array.isArray(b.orgs) ? b.orgs : String(b.orgs).split(/\n/)).map((s) => String(s).trim()).filter(Boolean).slice(0, 40);
      db.setSetting('posthog_feed_orgs', JSON.stringify(list));
    }
    res.json({ ok: true });
  });
  // The token is generated server-side and shown ONCE — never stored readable
  // client-side, never echoed by settings GET.
  app.post('/api/admin/feeds/token', auth.requireAdmin, (_req, res) => {
    const token = `hfeed_${crypto.randomBytes(24).toString('base64url')}`;
    db.setSetting('posthog_feed_token', token);
    res.json({ token });
  });
  // Dry-run for the admin card: same query, first rows only, no token needed
  // (admin session IS the auth here).
  app.get('/api/admin/feeds/preview', auth.requireAdmin, asyncHandler(async (req, res) => {
    const out = await orderRows({ since: String(req.query.since || ''), limit: 5 });
    res.json({ ...out, orders: out.orders.map((o) => ({ ...o, email: o.email ? `${o.email.slice(0, 2)}…@…` : '' })) }); // preview masks emails
  }));

  console.log('[feeds] PostHog warehouse bridge mounted');
  return { orderRows };
}

module.exports = { mount };
