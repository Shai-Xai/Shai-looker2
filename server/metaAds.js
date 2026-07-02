// ─── Meta paid performance — ads insights INTO Pulse (deep Meta P1) ─────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns meta_ad_insights and the
// /api/admin/entities/:id/meta-ads + /api/my/meta-ads/:id routes. Remove the mount
// line in index.js + this file (and the getPaidPerformance Owl tool) to uninstall.
//
// Closes the loop on the audiences we already push (meta.js): pulls per-campaign
// DAILY insights — spend, impressions, clicks, purchases and purchase VALUE — from
// the Graph API using the SAME per-client connection (metaAccessToken +
// metaAdAccountId; nothing new to configure), so Pulse can show what the ads
// actually did: cost per click, cost per purchase and ROAS (revenue ÷ spend).
// A self-guarded tick refreshes each configured client once a day (kill switch:
// setting meta_ads_sync_enabled = '0'); "Sync now" is on both surfaces.

const GRAPH = 'https://graph.facebook.com/v19.0';
const DAYS_DEFAULT = 28;
const DAYS_MAX = 90;

// Pull purchases + purchase value out of the Graph actions/action_values arrays.
// Meta reports the same conversion under several action_types — prefer the
// canonical omni_purchase, fall back to pixel/offsite purchase. (Exported for tests.)
function pickPurchase(list) {
  const by = new Map((list || []).map((a) => [a.action_type, Number(a.value) || 0]));
  for (const t of ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase']) {
    if (by.has(t)) return by.get(t);
  }
  return 0;
}

function rowFromInsight(i) {
  return {
    date: i.date_start || '',
    campaignId: i.campaign_id || '',
    campaignName: i.campaign_name || '',
    spend: Number(i.spend) || 0,
    impressions: Number(i.impressions) || 0,
    clicks: Number(i.inline_link_clicks != null ? i.inline_link_clicks : i.clicks) || 0,
    reach: Number(i.reach) || 0,
    purchases: pickPurchase(i.actions),
    purchaseValue: pickPurchase(i.action_values),
    currency: i.account_currency || '',
  };
}

function mount(app, { db, auth, meta, fetchImpl, startTimer = true }) {
  const sql = db.db;
  const doFetch = fetchImpl || fetch;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS meta_ad_insights (
      entity_id     TEXT NOT NULL,
      date          TEXT NOT NULL,
      campaign_id   TEXT NOT NULL,
      campaign_name TEXT NOT NULL DEFAULT '',
      spend REAL NOT NULL DEFAULT 0, impressions INTEGER NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0, reach INTEGER NOT NULL DEFAULT 0,
      purchases REAL NOT NULL DEFAULT 0, purchase_value REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT '',
      synced_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (entity_id, date, campaign_id)
    );
    CREATE INDEX IF NOT EXISTS idx_meta_ads_entity_date ON meta_ad_insights(entity_id, date);
  `);
  const now = () => new Date().toISOString();
  const upsert = sql.prepare(`INSERT INTO meta_ad_insights (entity_id,date,campaign_id,campaign_name,spend,impressions,clicks,reach,purchases,purchase_value,currency,synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(entity_id, date, campaign_id) DO UPDATE SET campaign_name=excluded.campaign_name, spend=excluded.spend, impressions=excluded.impressions,
      clicks=excluded.clicks, reach=excluded.reach, purchases=excluded.purchases, purchase_value=excluded.purchase_value, currency=excluded.currency, synced_at=excluded.synced_at`);

  // ── pull daily per-campaign insights for one client. Never throws — returns
  //    { ok, rows } or { ok:false, error }. Paged; token stays in the header. ──
  async function syncEntity(entityId, days = DAYS_DEFAULT) {
    const { accessToken: token, adAccountId } = meta.connection(entityId);
    if (!token || !adAccountId) return { ok: false, reason: 'not_configured', error: 'Meta is not connected for this client.' };
    const since = new Date(Date.now() - Math.min(Math.max(days, 1), DAYS_MAX) * 86400_000).toISOString().slice(0, 10);
    const until = new Date().toISOString().slice(0, 10);
    const fields = 'campaign_id,campaign_name,spend,impressions,clicks,inline_link_clicks,reach,actions,action_values,account_currency,date_start';
    let url = `${GRAPH}/${adAccountId}/insights?level=campaign&time_increment=1&fields=${fields}&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}&limit=200`;
    let rows = 0;
    try {
      for (let page = 0; page < 20 && url; page++) {
        const res = await doFetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data?.error?.message || `Meta HTTP ${res.status}`);
        const ts = now();
        for (const i of data.data || []) {
          const r = rowFromInsight(i);
          if (!r.date || !r.campaignId) continue;
          upsert.run(entityId, r.date, r.campaignId, r.campaignName, r.spend, r.impressions, r.clicks, r.reach, r.purchases, r.purchaseValue, r.currency, ts);
          rows++;
        }
        url = data.paging?.next || null;
      }
      db.setSetting?.(`meta_ads_last_sync:${entityId}`, now());
      return { ok: true, rows };
    } catch (e) {
      return { ok: false, error: String(e.message || e).slice(0, 300) };
    }
  }

  // ── report view: totals + per-campaign rollup + daily series over N days ──
  function report(entityId, days = DAYS_DEFAULT) {
    const since = new Date(Date.now() - Math.min(Math.max(Number(days) || DAYS_DEFAULT, 1), DAYS_MAX) * 86400_000).toISOString().slice(0, 10);
    const rows = sql.prepare('SELECT * FROM meta_ad_insights WHERE entity_id=? AND date>=? ORDER BY date ASC').all(entityId, since);
    const t = { spend: 0, impressions: 0, clicks: 0, purchases: 0, purchaseValue: 0 };
    const byCampaign = new Map();
    const byDay = new Map();
    let currency = '';
    for (const r of rows) {
      currency = r.currency || currency;
      t.spend += r.spend; t.impressions += r.impressions; t.clicks += r.clicks; t.purchases += r.purchases; t.purchaseValue += r.purchase_value;
      const c = byCampaign.get(r.campaign_id) || { campaignId: r.campaign_id, name: r.campaign_name, spend: 0, impressions: 0, clicks: 0, purchases: 0, purchaseValue: 0 };
      c.name = r.campaign_name || c.name;
      c.spend += r.spend; c.impressions += r.impressions; c.clicks += r.clicks; c.purchases += r.purchases; c.purchaseValue += r.purchase_value;
      byCampaign.set(r.campaign_id, c);
      const d = byDay.get(r.date) || { date: r.date, spend: 0, clicks: 0, purchases: 0, purchaseValue: 0 };
      d.spend += r.spend; d.clicks += r.clicks; d.purchases += r.purchases; d.purchaseValue += r.purchase_value;
      byDay.set(r.date, d);
    }
    const enrich = (o) => ({
      ...o,
      cpc: o.clicks ? +(o.spend / o.clicks).toFixed(2) : null,
      costPerPurchase: o.purchases ? +(o.spend / o.purchases).toFixed(2) : null,
      roas: o.spend > 0 && o.purchaseValue > 0 ? +(o.purchaseValue / o.spend).toFixed(2) : null,
    });
    return {
      configured: meta.isConfigured(entityId),
      lastSync: db.getSetting ? db.getSetting(`meta_ads_last_sync:${entityId}`, '') : '',
      days: Math.min(Math.max(Number(days) || DAYS_DEFAULT, 1), DAYS_MAX),
      currency,
      totals: enrich(t),
      campaigns: [...byCampaign.values()].map(enrich).sort((a, b) => b.spend - a.spend).slice(0, 50),
      series: [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    };
  }

  // ── routes (dual-surface) ──
  const myEntity = (req, res, next) => {
    const eid = req.params.entityId;
    if (req.user && (req.user.role === 'admin' || (req.user.entityIds || []).includes(eid))) return next();
    return res.status(403).json({ error: 'Not your client.' });
  };
  const syncHandler = (eid) => async (req, res) => {
    const r = await syncEntity(eid(req), Number(req.body?.days) || DAYS_DEFAULT);
    if (!r.ok) return res.status(400).json({ error: r.error || 'Sync failed.' });
    res.json({ ok: true, rows: r.rows, ...report(eid(req), Number(req.query.days) || DAYS_DEFAULT) });
  };
  app.get('/api/admin/entities/:entityId/meta-ads', auth.requireAdmin, (req, res) => res.json(report(req.params.entityId, req.query.days)));
  app.post('/api/admin/entities/:entityId/meta-ads/sync', auth.requireAdmin, syncHandler((req) => req.params.entityId));
  app.get('/api/my/meta-ads/:entityId', auth.requireAuth, myEntity, (req, res) => res.json(report(req.params.entityId, req.query.days)));
  app.post('/api/my/meta-ads/:entityId/sync', auth.requireAuth, myEntity, syncHandler((req) => req.params.entityId));

  // ── daily tick: refresh every configured client once per local day. Hourly
  //    check, self-guarded by a per-day marker; kill switch meta_ads_sync_enabled. ──
  let ticking = false;
  async function tick() {
    if (ticking) return;
    if (db.getSetting && db.getSetting('meta_ads_sync_enabled', '1') === '0') return;
    const today = new Date().toISOString().slice(0, 10);
    if (db.getSetting && db.getSetting('meta_ads_last_auto', '') === today) return;
    ticking = true;
    try {
      const entities = (db.listEntities ? db.listEntities() : []).filter((e) => meta.isConfigured(e.id));
      for (const e of entities) await syncEntity(e.id);
      db.setSetting?.('meta_ads_last_auto', today);
    } catch (e) { console.error('[meta-ads] tick failed:', e.message); }
    ticking = false;
  }
  if (startTimer) { const timer = setInterval(() => tick().catch(() => {}), 60 * 60_000); timer.unref?.(); }

  console.log('[metaAds] paid-performance connector mounted');
  return { syncEntity, report, tick };
}

module.exports = { mount, pickPurchase, rowFromInsight };
