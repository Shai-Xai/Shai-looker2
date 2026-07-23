// ─── Custom sending domain (disposable module) ────────────────────────────────
// Lets a CLIENT send campaigns/digests from THEIR OWN domain instead of the
// platform's Resend domain. Flow: register the domain with Resend → hand the
// DNS records (DKIM/SPF) to the client's IT → verify → every send for that
// entity switches its from-address to <local>@<their domain> (the display name
// still rides the branding chain). Falls back to the platform address until
// verified, and again if the domain is ever removed. Dual-surface per the
// house rule: Admin → client detail AND client Settings self-service.
// Mounts in one line from index.js; remove it + this file to uninstall.
const { asyncHandler, HttpError } = require('./http');

// Hostname (subdomains encouraged, e.g. mail.brand.com) + from-local-part shapes.
const CLEAN_DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const CLEAN_LOCAL = /^[a-z0-9](\.?[a-z0-9_+-]+)*$/;

function mount(app, { db, auth, mailer }) {
  const sql = db.db;
  sql.exec(`CREATE TABLE IF NOT EXISTS sending_domains (
    entity_id  TEXT PRIMARY KEY,
    domain     TEXT NOT NULL,
    resend_id  TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'pending',
    records    TEXT NOT NULL DEFAULT '[]',
    from_local TEXT NOT NULL DEFAULT 'events',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`);
  const now = () => new Date().toISOString();
  const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
  const get = (eid) => sql.prepare('SELECT * FROM sending_domains WHERE entity_id=?').get(eid);

  // All Resend Domains API specifics live here (same key the mailer sends with).
  const key = () => (db.getSetting('resend_api_key') || process.env.RESEND_API_KEY || '').trim();
  async function resend(method, path, body) {
    if (!key()) throw new HttpError(400, 'Email isn’t configured yet (no Resend API key) — set it in Admin → Integrations first.');
    const res = await fetch(`https://api.resend.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(res.status >= 500 ? 502 : 400, data?.message || `Resend responded ${res.status}`);
    return data;
  }
  const mapRecords = (d) => (Array.isArray(d?.records) ? d.records.map((r) => ({
    record: r.record || '', type: r.type || '', name: r.name || '', value: r.value || '',
    ttl: r.ttl || '', priority: r.priority ?? '', status: r.status || '',
  })) : []);

  const view = (eid) => {
    const r = get(eid);
    return {
      entityId: eid,
      platformFrom: mailer.fromAddress(),
      ...(r
        ? { domain: r.domain, status: r.status, records: J(r.records, []), fromLocal: r.from_local, from: `${r.from_local}@${r.domain}`, active: r.status === 'verified' }
        : { domain: '', status: 'unset', records: [], fromLocal: 'events', from: '', active: false }),
    };
  };

  // The effective custom from-address for an entity ('' = platform default).
  // Registered with the mailer so EVERY send for that entity rides it — only a
  // VERIFIED domain ever changes the address (fail-safe for deliverability).
  function customFromFor(entityId) {
    const r = entityId ? get(entityId) : null;
    return r && r.status === 'verified' ? `${r.from_local}@${r.domain}` : '';
  }
  mailer.setCustomFrom(customFromFor);

  async function setDomain(eid, body) {
    const domain = String(body?.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const fromLocal = (String(body?.fromLocal || '').trim() || 'events').toLowerCase();
    if (!CLEAN_DOMAIN.test(domain) || domain.length > 253) throw new HttpError(400, 'That doesn’t look like a domain — try something like mail.yourbrand.com');
    if (!CLEAN_LOCAL.test(fromLocal) || fromLocal.length > 64) throw new HttpError(400, 'The part before the @ can only use letters, numbers, dots, dashes and underscores.');
    const existing = get(eid);
    if (existing && existing.domain === domain) {
      // Same domain — just the from-address changed; no need to re-verify DNS.
      sql.prepare('UPDATE sending_domains SET from_local=?, updated_at=? WHERE entity_id=?').run(fromLocal, now(), eid);
      return view(eid);
    }
    if (existing?.resend_id) { try { await resend('DELETE', `/domains/${existing.resend_id}`); } catch { /* being replaced anyway */ } }
    let d;
    try {
      d = await resend('POST', '/domains', { name: domain });
    } catch (e) {
      // Resend domains are ACCOUNT-global (shared across our environments on one
      // Resend key). "registered already" = a prior attempt or the other
      // environment claimed it — ADOPT the existing one so its DNS records still
      // surface and the client can be given them, instead of a dead-end error.
      if (!/registered already/i.test(e.message || '')) throw e;
      const list = await resend('GET', '/domains');
      const arr = Array.isArray(list?.data) ? list.data : (Array.isArray(list) ? list : []);
      const match = arr.find((x) => String(x.name || '').toLowerCase() === domain);
      if (!match?.id) throw new HttpError(400, `${domain} is already registered in Resend but I couldn’t read its DNS records back — check the Resend dashboard.`);
      d = await resend('GET', `/domains/${match.id}`);
    }
    sql.prepare(`INSERT INTO sending_domains (entity_id, domain, resend_id, status, records, from_local, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(entity_id) DO UPDATE SET domain=excluded.domain, resend_id=excluded.resend_id, status=excluded.status, records=excluded.records, from_local=excluded.from_local, updated_at=excluded.updated_at`)
      .run(eid, domain, d.id || '', d.status || 'pending', JSON.stringify(mapRecords(d)), fromLocal, now(), now());
    return view(eid);
  }
  async function verify(eid) {
    const r = get(eid);
    if (!r) throw new HttpError(404, 'No sending domain configured yet.');
    // Kick a verification then read back the truth (records carry per-record status).
    try { await resend('POST', `/domains/${r.resend_id}/verify`); } catch { /* status read below decides */ }
    const d = await resend('GET', `/domains/${r.resend_id}`);
    const status = d.status === 'verified' ? 'verified' : (d.status || 'pending');
    sql.prepare('UPDATE sending_domains SET status=?, records=?, updated_at=? WHERE entity_id=?').run(status, JSON.stringify(mapRecords(d)), now(), eid);
    return view(eid);
  }
  async function remove(eid) {
    const r = get(eid);
    if (r?.resend_id) { try { await resend('DELETE', `/domains/${r.resend_id}`); } catch { /* remove locally regardless */ } }
    sql.prepare('DELETE FROM sending_domains WHERE entity_id=?').run(eid);
    return view(eid);
  }

  // Dual surface: admin manages any client; a client manages their own entity
  // (integrations.manage permission + entity ownership, same as Integrations).
  const myGuard = (req, res, next) => {
    if (req.user.role !== 'admin' && !(req.user.entityIds || []).includes(req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
    next();
  };
  for (const [base, guards] of [
    ['/api/admin/entities/:entityId/sending-domain', [auth.requireAdmin]],
    ['/api/my/sending-domain/:entityId', [auth.requireAuth, auth.requirePermission('integrations.manage'), myGuard]],
  ]) {
    app.get(base, ...guards, (req, res) => res.json(view(req.params.entityId)));
    app.put(base, ...guards, asyncHandler(async (req, res) => res.json(await setDomain(req.params.entityId, req.body))));
    app.post(`${base}/verify`, ...guards, asyncHandler(async (req, res) => res.json(await verify(req.params.entityId))));
    app.delete(base, ...guards, asyncHandler(async (req, res) => res.json(await remove(req.params.entityId))));
  }
  return { customFromFor };
}

module.exports = { mount, CLEAN_DOMAIN, CLEAN_LOCAL };
