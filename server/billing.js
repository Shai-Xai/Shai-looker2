// ── Campaign billing: per-channel rate card + cost computation ────────────────
// Disposable module. Owns the master (platform-default) rate card and per-client
// overrides, and the math to cost a campaign (per message sent). ROI/revenue is
// deliberately out of scope for now — the rate card is shaped so a Howler-cost
// (margin) or revenue field can be added later without a migration rethink.
//
// Resolution mirrors branding: a client's rate inherits the master unless it's
// explicitly overridden (blank = inherit). Costs are per MESSAGE sent (one email
// = one unit, one SMS = one unit; multi-part SMS counts as one for now).
const CHANNELS = ['email', 'sms', 'whatsapp'];
const CHANNEL_LABELS = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' };

function mount(app, { db, auth }) {
  const sql = db.db;
  const now = () => new Date().toISOString();
  const MASTER_KEY = 'billing_rates_master';
  const DEFAULTS = { email: 0, sms: 0, whatsapp: 0, currency: 'ZAR' };

  sql.exec(`CREATE TABLE IF NOT EXISTS billing_entity_rates (
    entity_id  TEXT PRIMARY KEY,
    rates      TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
  );`);

  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
  const masterRates = () => { try { return { ...DEFAULTS, ...JSON.parse(db.getSetting(MASTER_KEY, '{}') || '{}') }; } catch { return { ...DEFAULTS }; } };
  const setMaster = (patch = {}) => {
    const next = masterRates();
    for (const ch of CHANNELS) if (patch[ch] !== undefined && patch[ch] !== '') next[ch] = num(patch[ch]);
    if (patch.currency) next.currency = String(patch.currency).slice(0, 8);
    db.setSetting(MASTER_KEY, JSON.stringify(next));
    return next;
  };
  const entityOverrides = (entityId) => { try { const r = sql.prepare('SELECT rates FROM billing_entity_rates WHERE entity_id=?').get(entityId); return r ? (JSON.parse(r.rates || '{}') || {}) : {}; } catch { return {}; } };
  const setEntityOverrides = (entityId, patch = {}) => {
    const next = entityOverrides(entityId);
    for (const ch of CHANNELS) {
      if (!(ch in patch)) continue;
      const v = patch[ch];
      if (v === '' || v === null || v === undefined) delete next[ch]; // blank = inherit master
      else next[ch] = num(v);
    }
    const json = JSON.stringify(next);
    sql.prepare('INSERT INTO billing_entity_rates (entity_id, rates, updated_at) VALUES (?,?,?) ON CONFLICT(entity_id) DO UPDATE SET rates=excluded.rates, updated_at=excluded.updated_at').run(entityId, json, now());
    return next;
  };

  // Effective rate per channel for a client (override else master), plus which
  // ones are inherited (for the "inherited" UI hint) and the currency.
  function effectiveRates(entityId) {
    const m = masterRates();
    const o = entityOverrides(entityId);
    const rates = {}; const inherited = {};
    for (const ch of CHANNELS) {
      if (o[ch] !== undefined) { rates[ch] = num(o[ch]); inherited[ch] = false; }
      else { rates[ch] = num(m[ch]); inherited[ch] = true; }
    }
    return { rates, inherited, currency: m.currency || 'ZAR', channels: CHANNELS, labels: CHANNEL_LABELS };
  }

  // Cost a set of per-channel message counts at a client's effective rates.
  // `counts` = { email, sms, whatsapp } (any subset). Returns per-channel lines +
  // total + the rate snapshot (so callers can store it for a stable historical cost).
  function costFor(entityId, counts = {}) {
    const { rates, currency } = effectiveRates(entityId);
    const lines = {}; let total = 0;
    for (const ch of CHANNELS) {
      const n = num(counts[ch]);
      if (!(ch in counts)) continue; // only channels the caller asked about
      const cost = n * (rates[ch] || 0);
      lines[ch] = { count: n, rate: rates[ch] || 0, cost };
      total += cost;
    }
    return { lines, total, currency, rates };
  }

  // ── Admin routes ──
  app.get('/api/billing/master', auth.requireAdmin, (_req, res) => res.json({ rates: masterRates(), channels: CHANNELS, labels: CHANNEL_LABELS }));
  app.put('/api/billing/master', auth.requireAdmin, (req, res) => res.json({ rates: setMaster(req.body || {}), channels: CHANNELS, labels: CHANNEL_LABELS }));
  app.get('/api/billing/admin/entities/:id/rates', auth.requireAdmin, (req, res) => {
    if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
    res.json({ ...effectiveRates(req.params.id), overrides: entityOverrides(req.params.id), master: masterRates() });
  });
  app.put('/api/billing/admin/entities/:id/rates', auth.requireAdmin, (req, res) => {
    if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Not found' });
    setEntityOverrides(req.params.id, req.body || {});
    res.json({ ...effectiveRates(req.params.id), overrides: entityOverrides(req.params.id), master: masterRates() });
  });

  // ── Client self-service: read-only effective rates + spend rollup ──
  const ownsEntity = (req) => (req.user.entityIds || []).includes(req.params.id);
  app.get('/api/billing/my/:id', auth.requireAuth, (req, res) => {
    if (req.user.role !== 'admin' && !ownsEntity(req)) return res.status(403).json({ error: 'Not allowed' });
    const eff = effectiveRates(req.params.id);
    res.json({ rates: eff.rates, currency: eff.currency, channels: CHANNELS, labels: CHANNEL_LABELS, spend: spendRollup(req.params.id) });
  });

  // Spend rollup for one client: per-campaign cost + totals (from each action's
  // stored cost snapshot; falls back to a live computation from its sent counts).
  function spendRollup(entityId) {
    let rows = [];
    try { rows = sql.prepare("SELECT id, title, status, results, created_at FROM actions WHERE entity_id=? AND type='campaign' ORDER BY created_at DESC").all(entityId); }
    catch { rows = []; }
    const campaigns = []; let total = 0; const currency = masterRates().currency || 'ZAR';
    for (const r of rows) {
      let results = {}; try { results = JSON.parse(r.results || '{}'); } catch { results = {}; }
      const cost = costSnapshotOf(entityId, results);
      campaigns.push({ id: r.id, title: r.title, status: r.status, sent: results.sent || 0, cost: cost.total, currency: cost.currency, createdAt: r.created_at });
      total += cost.total;
    }
    return { total, currency, count: campaigns.length, campaigns: campaigns.slice(0, 200) };
  }
  // The cost for an action's results: prefer a stored snapshot (stable even if
  // rates later change), else compute live from its per-channel sent counts.
  function costSnapshotOf(entityId, results = {}) {
    if (results.cost && typeof results.cost.total === 'number') return results.cost;
    return costFor(entityId, { email: results.emailSent || 0, sms: results.smsSent || 0, whatsapp: results.whatsappSent || 0 });
  }

  // ── Master rollup (admin): spend across all clients ──
  app.get('/api/billing/rollup', auth.requireAdmin, (_req, res) => {
    const ents = db.listEntities ? db.listEntities() : [];
    const perClient = []; let grand = 0; const currency = masterRates().currency || 'ZAR';
    for (const e of ents) {
      const roll = spendRollup(e.id);
      if (roll.count === 0 && roll.total === 0) continue;
      perClient.push({ entityId: e.id, name: e.name, total: roll.total, campaigns: roll.count });
      grand += roll.total;
    }
    perClient.sort((a, b) => b.total - a.total);
    res.json({ total: grand, currency, clients: perClient });
  });

  // Exposed to the campaign engine (actions.js): cost a campaign's sends + read rates.
  return { effectiveRates, costFor, costSnapshotOf, masterRates, channels: CHANNELS };
}

module.exports = { mount };
