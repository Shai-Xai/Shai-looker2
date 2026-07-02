// ─── AI usage metering (disposable module) ────────────────────────────────────
// Records every Anthropic API call's token usage — model, input/output/cache
// tokens, plus WHICH client (entity) and WHICH feature (kind) drove it — into
// one table, and serves the Admin → AI "Usage" report (per day / client /
// feature / model with an estimated cost). Wiring:
//   • insights.clientFor wraps every Anthropic client with wrapClient(), so no
//     call site can forget to meter.
//   • Feature entry points wrap their work in aiUsage.run({entityId, kind}, fn)
//     — AsyncLocalStorage carries the attribution through awaits into record().
//     Unattributed calls still record (kind 'other'), so totals stay honest.
// Remove the mount line in index.js + this file (and the clientFor wrap) to
// uninstall.
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
let sql = null;
let ins = null;

// USD per 1M tokens [input, output]; cache write ≈1.25× input, cache read ≈0.1×.
// Longest-prefix match so dated IDs resolve; unknown models assume Opus pricing
// (over-estimating beats silently under-reporting).
const PRICES = {
  'claude-opus-4': [5, 25],
  'claude-sonnet-5': [3, 15],
  'claude-sonnet-4': [3, 15],
  'claude-haiku-4': [1, 5],
  'claude-3-5-haiku': [0.8, 4],
};
const priceFor = (model) => { const m = String(model || ''); const k = Object.keys(PRICES).filter((p) => m.startsWith(p)).sort((a, b) => b.length - a.length)[0]; return k ? PRICES[k] : [5, 25]; };
const costOf = (r) => { const [i, o] = priceFor(r.model); return ((r.in_tok || 0) * i + (r.cache_w || 0) * 1.25 * i + (r.cache_r || 0) * 0.1 * i + (r.out_tok || 0) * o) / 1e6; };

function init(db) {
  if (sql) return;
  sql = db;
  sql.exec(`CREATE TABLE IF NOT EXISTS ai_usage (
    id         TEXT PRIMARY KEY,
    entity_id  TEXT NOT NULL DEFAULT '',
    kind       TEXT NOT NULL DEFAULT 'other',
    model      TEXT NOT NULL DEFAULT '',
    in_tok     INTEGER NOT NULL DEFAULT 0,
    out_tok    INTEGER NOT NULL DEFAULT 0,
    cache_r    INTEGER NOT NULL DEFAULT 0,
    cache_w    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ai_usage_at ON ai_usage(created_at);`);
  ins = sql.prepare('INSERT INTO ai_usage (id, entity_id, kind, model, in_tok, out_tok, cache_r, cache_w, created_at) VALUES (?,?,?,?,?,?,?,?,?)');
}

// Run `fn` with {entityId, kind} attribution; nests (inner values win, missing
// fields inherit) so a feature can set kind while a deeper helper adds entity.
function run(ctx, fn) { return als.run({ ...(als.getStore() || {}), ...ctx }, fn); }

function record(model, usage) {
  if (!ins || !usage) return;
  const ctx = als.getStore() || {};
  try {
    ins.run(crypto.randomUUID(), String(ctx.entityId || ''), String(ctx.kind || 'other'), String(model || ''),
      usage.input_tokens || 0, usage.output_tokens || 0, usage.cache_read_input_tokens || 0, usage.cache_creation_input_tokens || 0,
      new Date().toISOString());
  } catch { /* metering must never break the feature */ }
}

// Wrap an Anthropic client so create/stream record usage transparently. Only
// the surface the codebase uses (messages.create / messages.stream) is proxied.
function wrapClient(c) {
  return {
    _raw: c,
    messages: {
      create: async (req, opts) => { const resp = await c.messages.create(req, opts); record(resp?.model || req?.model, resp?.usage); return resp; },
      stream: (req, opts) => {
        const s = c.messages.stream(req, opts);
        try { s.on('finalMessage', (m) => record(m?.model || req?.model, m?.usage)); } catch { /* older SDK shapes */ }
        return s;
      },
    },
  };
}

function mount(app, { auth, db }) {
  init(db);
  // Usage report: totals + breakdowns for the last N days (default 14, max 90).
  app.get('/api/admin/ai-usage', auth.requireAdmin, (req, res) => {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14));
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const rows = sql.prepare("SELECT entity_id, kind, model, in_tok, out_tok, cache_r, cache_w, substr(created_at, 1, 10) AS day FROM ai_usage WHERE created_at >= ?").all(since);
    const agg = (keyOf) => {
      const m = new Map();
      for (const r of rows) {
        const k = keyOf(r) || '—';
        let a = m.get(k);
        if (!a) { a = { key: k, calls: 0, inTok: 0, outTok: 0, cacheTok: 0, cost: 0 }; m.set(k, a); }
        a.calls += 1; a.inTok += r.in_tok; a.outTok += r.out_tok; a.cacheTok += r.cache_r + r.cache_w; a.cost += costOf(r);
      }
      return [...m.values()];
    };
    const byCost = (list) => list.sort((a, b) => b.cost - a.cost);
    const total = agg(() => 'all')[0] || { calls: 0, inTok: 0, outTok: 0, cacheTok: 0, cost: 0 };
    const recordingSince = (sql.prepare('SELECT MIN(created_at) AS m FROM ai_usage').get() || {}).m || '';
    res.json({
      days,
      recordingSince,
      total: { calls: total.calls, inTok: total.inTok, outTok: total.outTok, cacheTok: total.cacheTok, cost: total.cost },
      byDay: agg((r) => r.day).sort((a, b) => a.key.localeCompare(b.key)),
      byEntity: byCost(agg((r) => r.entity_id)),
      byKind: byCost(agg((r) => r.kind)),
      byModel: byCost(agg((r) => r.model)),
      note: 'Cost is an estimate from list pricing (cache writes 1.25×, reads 0.1× input rate). The Anthropic console is the billing source of truth.',
    });
  });
}

module.exports = { init, run, record, wrapClient, mount, priceFor, costOf };
