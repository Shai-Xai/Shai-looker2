// ─── Loyalty phase 2 — promo pools, codes and the grant engine ──────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns promo_pools / promo_codes /
// promo_grants and the /api/{admin/entities,my/loyalty}/:id/loyalty routes;
// mounted from index.js in one line. Spec: docs/specs/LOYALTY_ENGINE_SPEC.md §5.
//
// The engine's one non-negotiable (spec §1.3): the MODEL may offer; only THIS
// module grants. Which pool applies, one-grant-per-fan, stock left, expiry —
// all decided here from the verified profile, never from conversation text
// (grantFor takes no free-text arguments a prompt injection could abuse).
//
// Codes are generated in the Howler ticketing system (checkout enforces the
// discount); Pulse holds them in pools and controls WHO gets one. Two modes
// (spec §5): 'unique' — a stock of single-use codes, stock = the hard budget;
// 'shared' — ONE multi-use code many fans receive, budget enforced by capping
// grants (softer: a shared code can leak beyond the Owl — keep values modest).

const crypto = require('crypto');

const REWARD_KINDS = new Set(['discount', 'upgrade', 'addon', 'credit_bundle', 'merch', 'prize']);
const TIERS = new Set(['new', 'returning', 'loyal']);
const SIGNALS = new Set(['group_buyer', 'comp_guest', 'preregistered', 'lead_no_purchase', 'high_onsite_spender', 'app_active', 'community_contributor']);

function mount(app, { db, auth }) {
  const sql = db.db;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS promo_pools (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, suite_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL, reward_kind TEXT NOT NULL DEFAULT 'discount',
      value_label TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
      target TEXT NOT NULL DEFAULT '{}', rules TEXT NOT NULL DEFAULT '{}',
      mode TEXT NOT NULL DEFAULT 'unique', shared_code TEXT NOT NULL DEFAULT '',
      grant_cap INTEGER NOT NULL DEFAULT 0, bundle_item_id TEXT NOT NULL DEFAULT '',
      terms_url TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS promo_codes (
      id TEXT PRIMARY KEY, pool_id TEXT NOT NULL, code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available', issued_to_profile TEXT NOT NULL DEFAULT '',
      issued_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_promo_codes_pool ON promo_codes(pool_id, status);
    CREATE TABLE IF NOT EXISTS promo_grants (
      id TEXT PRIMARY KEY, pool_id TEXT NOT NULL, code_id TEXT NOT NULL DEFAULT '',
      profile_id TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '',
      surface TEXT NOT NULL DEFAULT 'chat', code_text TEXT NOT NULL DEFAULT '',
      referrer_profile_id TEXT NOT NULL DEFAULT '', group_id TEXT NOT NULL DEFAULT '',
      redeemed_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
      UNIQUE(pool_id, profile_id)
    );
  `);
  const now = () => new Date().toISOString();
  const uid = () => crypto.randomUUID();
  const J = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };

  const poolsByEntity = sql.prepare('SELECT * FROM promo_pools WHERE entity_id = ? ORDER BY created_at');
  const poolById = sql.prepare('SELECT * FROM promo_pools WHERE id = ?');
  const codeCounts = sql.prepare(`SELECT
      SUM(CASE WHEN status='available' THEN 1 ELSE 0 END) AS available,
      SUM(CASE WHEN status='issued' THEN 1 ELSE 0 END) AS issued
    FROM promo_codes WHERE pool_id = ?`);
  const grantCounts = sql.prepare(`SELECT COUNT(*) AS granted,
      SUM(CASE WHEN redeemed_at != '' THEN 1 ELSE 0 END) AS redeemed
    FROM promo_grants WHERE pool_id = ?`);
  const grantFor = sql.prepare('SELECT * FROM promo_grants WHERE pool_id = ? AND profile_id = ?');

  // ── Views ──────────────────────────────────────────────────────────────────────
  const poolView = (p) => {
    const c = codeCounts.get(p.id) || {};
    const g = grantCounts.get(p.id) || {};
    return {
      id: p.id, suiteId: p.suite_id, name: p.name, rewardKind: p.reward_kind,
      valueLabel: p.value_label, description: p.description,
      target: J(p.target, {}), rules: J(p.rules, {}), mode: p.mode,
      sharedCodeSet: !!p.shared_code, grantCap: p.grant_cap, bundleItemId: p.bundle_item_id,
      termsUrl: p.terms_url, active: !!p.active,
      stock: { available: c.available || 0, issued: c.issued || 0, granted: g.granted || 0, redeemed: g.redeemed || 0 },
    };
  };
  const listView = (entityId) => ({ pools: poolsByEntity.all(entityId).map(poolView) });

  // ── Save (whole-list, like the fan owl config; codes ride their own route) ─────
  function savePools(entityId, body) {
    const tx = sql.transaction(() => {
      if (!Array.isArray(body.pools)) return;
      const keep = new Set();
      for (const p of body.pools.slice(0, 100)) {
        if (!String(p.name || '').trim()) continue;
        const existing = p.id && poolById.get(p.id);
        const id = existing && existing.entity_id === entityId ? p.id : uid();
        keep.add(id);
        const target = {
          tiers: (Array.isArray(p.target?.tiers) ? p.target.tiers : []).filter((t) => TIERS.has(t)),
          signals: (Array.isArray(p.target?.signals) ? p.target.signals : []).filter((s) => SIGNALS.has(s)),
          segmentId: String(p.target?.segmentId || '').slice(0, 60), // stored now; membership check ships next slice
        };
        const rules = {
          minQty: Math.max(0, Math.min(100, Number(p.rules?.minQty) || 0)),
          ticketTypes: (Array.isArray(p.rules?.ticketTypes) ? p.rules.ticketTypes : []).map((t) => String(t).slice(0, 120)).slice(0, 20),
          comps: p.rules?.comps === 'ignore' ? 'ignore' : 'count', // spec §5: reward buyers, greet guests
          expiresAt: String(p.rules?.expiresAt || '').slice(0, 30),
        };
        const mode = p.mode === 'shared' ? 'shared' : 'unique';
        const row = {
          suite_id: String(p.suiteId || '').slice(0, 60), name: String(p.name).trim().slice(0, 120),
          reward_kind: REWARD_KINDS.has(p.rewardKind) ? p.rewardKind : 'discount',
          value_label: String(p.valueLabel || '').slice(0, 120), description: String(p.description || '').slice(0, 500),
          target: JSON.stringify(target), rules: JSON.stringify(rules), mode,
          // The shared code is write-only-ish: keep the stored one unless a new value arrives.
          shared_code: mode === 'shared' ? String(p.sharedCode || (existing ? existing.shared_code : '')).trim().slice(0, 80) : '',
          grant_cap: Math.max(0, Math.min(1000000, Number(p.grantCap) || 0)),
          bundle_item_id: String(p.bundleItemId || '').slice(0, 60),
          terms_url: String(p.termsUrl || '').trim().slice(0, 600), active: p.active === false ? 0 : 1,
        };
        if (existing && existing.entity_id === entityId) {
          sql.prepare(`UPDATE promo_pools SET suite_id=@suite_id, name=@name, reward_kind=@reward_kind, value_label=@value_label,
            description=@description, target=@target, rules=@rules, mode=@mode, shared_code=@shared_code,
            grant_cap=@grant_cap, bundle_item_id=@bundle_item_id, terms_url=@terms_url, active=@active WHERE id=@id`)
            .run({ ...row, id });
        } else {
          sql.prepare(`INSERT INTO promo_pools (id, entity_id, suite_id, name, reward_kind, value_label, description, target, rules,
            mode, shared_code, grant_cap, bundle_item_id, terms_url, active, created_at)
            VALUES (@id, @entity_id, @suite_id, @name, @reward_kind, @value_label, @description, @target, @rules,
            @mode, @shared_code, @grant_cap, @bundle_item_id, @terms_url, @active, @created_at)`)
            .run({ ...row, id, entity_id: entityId, created_at: now() });
        }
      }
      // Deleting a pool keeps its grants (the audit trail) but voids unused codes.
      for (const p of poolsByEntity.all(entityId)) {
        if (!keep.has(p.id)) {
          sql.prepare('DELETE FROM promo_pools WHERE id = ?').run(p.id);
          sql.prepare("UPDATE promo_codes SET status='void' WHERE pool_id = ? AND status='available'").run(p.id);
        }
      }
    });
    tx();
    return listView(entityId);
  }

  // Paste-in code upload: one code per line, deduped against the pool's existing.
  function uploadCodes(entityId, poolId, text) {
    const pool = poolById.get(poolId);
    if (!pool || pool.entity_id !== entityId) return null;
    const existing = new Set(sql.prepare('SELECT code FROM promo_codes WHERE pool_id = ?').all(poolId).map((r) => r.code));
    let added = 0;
    const ins = sql.prepare('INSERT INTO promo_codes (id, pool_id, code, status) VALUES (?,?,?,\'available\')');
    const tx = sql.transaction(() => {
      for (const line of String(text || '').split(/[\n,;]+/).slice(0, 20000)) {
        const code = line.trim().slice(0, 80);
        if (!code || /\s/.test(code) || existing.has(code)) continue;
        ins.run(uid(), poolId, code); existing.add(code); added++;
      }
    });
    tx();
    return { added, ...poolView(poolById.get(poolId)) };
  }

  // ── Eligibility + the grant (the deterministic core) ──────────────────────────
  // profileSummary = loyalty.summary(profile) — tier, signals, paidEventsCount…
  function eligible(pool, s) {
    const target = J(pool.target, {});
    const rules = J(pool.rules, {});
    if (!pool.active) return false;
    if (rules.expiresAt && Date.parse(rules.expiresAt) < Date.now()) return false;
    // Comps rule (spec §5): 'ignore' judges the fan by their PAID history only.
    const paidTier = (s.paidEventsCount || 0) >= 2 ? 'loyal' : (s.paidEventsCount || 0) >= 1 ? 'returning' : 'new';
    const tier = rules.comps === 'ignore' ? paidTier : (s.tier || 'new');
    if (Array.isArray(target.tiers) && target.tiers.length && !target.tiers.includes(tier)) return false;
    if (Array.isArray(target.signals) && target.signals.length) {
      for (const sig of target.signals) if (!s.signals?.[sig]) return false;
    }
    if (target.segmentId) return false; // segment targeting ships next slice — fail closed until then
    return true;
  }

  // The reward for ONE verified fan on ONE site: first eligible pool with stock,
  // idempotent (a repeat call returns the fan's existing grant, never a second).
  const grantTx = sql.transaction((pool, profileId, sessionId, surface) => {
    let codeText = '';
    let codeId = '';
    if (pool.mode === 'shared') {
      if (pool.grant_cap > 0 && (grantCounts.get(pool.id)?.granted || 0) >= pool.grant_cap) return null;
      codeText = pool.shared_code;
      if (!codeText) return null;
    } else {
      const code = sql.prepare("SELECT * FROM promo_codes WHERE pool_id = ? AND status='available' LIMIT 1").get(pool.id);
      if (!code) return null;
      sql.prepare("UPDATE promo_codes SET status='issued', issued_to_profile = ?, issued_at = ? WHERE id = ?").run(profileId, now(), code.id);
      codeText = code.code; codeId = code.id;
    }
    const gid = uid();
    sql.prepare(`INSERT INTO promo_grants (id, pool_id, code_id, profile_id, session_id, surface, code_text, created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(gid, pool.id, codeId, profileId, sessionId, surface, codeText, now());
    return gid;
  });
  const rewardView = (pool, codeText) => {
    const rules = J(pool.rules, {});
    return {
      pool: pool.name, rewardKind: pool.reward_kind, value: pool.value_label,
      description: pool.description, code: codeText,
      rules: { minQty: rules.minQty || 0, ticketTypes: rules.ticketTypes || [], expiresAt: rules.expiresAt || '' },
      bundleItemId: pool.bundle_item_id || '', termsUrl: pool.terms_url || '',
    };
  };
  function grantFor_(site, session, profile, summary, surface = 'chat') {
    const pools = poolsByEntity.all(site.entity_id)
      .filter((p) => p.active && (!p.suite_id || !site.suite_id || p.suite_id === site.suite_id));
    // An existing grant always wins — the Owl re-presents it instead of double-granting.
    for (const p of pools) {
      const g = grantFor.get(p.id, profile.id);
      if (g) return { ok: true, existing: true, reward: rewardView(p, g.code_text) };
    }
    for (const p of pools) {
      if (!eligible(p, summary)) continue;
      const gid = grantTx(p, profile.id, session.id, surface);
      if (gid) return { ok: true, existing: false, reward: rewardView(p, poolById.get(p.id).mode === 'shared' ? p.shared_code : sql.prepare('SELECT code_text FROM promo_grants WHERE id = ?').get(gid).code_text) };
    }
    return { ok: false, reason: 'none', message: 'No reward applies to this fan right now — say so warmly and carry on helping (never invent a consolation offer).' };
  }
  // Are any pools live (active + stock/capacity left) for this site? Drives the
  // proactive offer: no live pools = the Owl doesn't tease a check that can't pay off.
  function hasLiveRewards(site) {
    return poolsByEntity.all(site.entity_id).some((p) => {
      if (!p.active) return false;
      if (p.suite_id && site.suite_id && p.suite_id !== site.suite_id) return false;
      const rules = J(p.rules, {});
      if (rules.expiresAt && Date.parse(rules.expiresAt) < Date.now()) return false;
      if (J(p.target, {}).segmentId) return false; // can't grant until segment membership ships
      if (p.mode === 'shared') return !!p.shared_code && (!p.grant_cap || (grantCounts.get(p.id)?.granted || 0) < p.grant_cap);
      return (codeCounts.get(p.id)?.available || 0) > 0;
    });
  }

  // ── Routes (dual-surface; /api/my is flag-gated via flags.GATES) ───────────────
  const requireMyEntity = (req, res, next) => {
    const eid = req.params.entityId;
    if (req.user.role === 'admin' || (req.user.entityIds || []).includes(eid)) return next();
    return res.status(403).json({ error: 'Not allowed.' });
  };
  const listHandler = (req, res) => res.json(listView(req.params.entityId));
  const saveHandler = (req, res) => res.json(savePools(req.params.entityId, req.body || {}));
  const codesHandler = (req, res) => {
    const r = uploadCodes(req.params.entityId, String(req.params.poolId || ''), (req.body || {}).codes);
    if (!r) return res.status(404).json({ error: 'Pool not found.' });
    return res.json(r);
  };
  app.get('/api/admin/entities/:entityId/loyalty/pools', auth.requireAdmin, listHandler);
  app.put('/api/admin/entities/:entityId/loyalty/pools', auth.requireAdmin, saveHandler);
  app.post('/api/admin/entities/:entityId/loyalty/pools/:poolId/codes', auth.requireAdmin, codesHandler);
  app.get('/api/my/loyalty/:entityId/pools', auth.requireAuth, requireMyEntity, listHandler);
  app.put('/api/my/loyalty/:entityId/pools', auth.requireAuth, requireMyEntity, saveHandler);
  app.post('/api/my/loyalty/:entityId/pools/:poolId/codes', auth.requireAuth, requireMyEntity, codesHandler);

  console.log('[loyaltyPools] reward pools module mounted');
  return { grantFor: grantFor_, hasLiveRewards, savePools, uploadCodes, listView }; // engine for fanOwl + tests
}

module.exports = { mount };
