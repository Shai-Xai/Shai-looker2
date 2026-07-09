// ─── Client suite categories (disposable module) ─────────────────────────────
// Lets a CLIENT organise their events (suites) into their own named categories in
// the sidebar — "Festivals", "Club nights", "2025 archive" — and drag events in.
// A category is just { id, name, suiteIds:[…] } (ordered); a suite lives in at
// most one. Categories take PRECEDENCE in the nav: filed events show under their
// category, anything unfiled falls back to the automatic Upcoming/Past grouping.
//
// Stored per entity in the KV settings (suite_categories:<entityId>) — no schema,
// disposable. Dual-surface per the house rule: a client manages their own
// (/api/my/…), Howler staff manage any client's (/api/admin/entities/:id/…).
// Gated by the `navcategories` flag (route gate in server/flags.js GATES).
// Mounts in one line from index.js; remove it + this file to uninstall.
const { asyncHandler, HttpError } = require('./http');

function mount(app, { db, auth }) {
  const KEY = (eid) => `suite_categories:${eid}`;
  const uid = () => 'c' + Math.random().toString(36).slice(2, 10); // opaque category id

  const read = (eid) => { try { const a = JSON.parse(db.getSetting(KEY(eid), '[]')); return Array.isArray(a) ? a : []; } catch { return []; } };

  // Clean + persist. Enforces: ≤30 categories, names ≤60 chars, only suite ids that
  // belong to THIS entity, each suite in at most one category (first wins), ≤500
  // filed per category. Drops empties of both name and members.
  function save(eid, body) {
    const valid = new Set(db.listSuitesForEntity(eid).map((s) => s.id));
    const seen = new Set();
    const cats = (Array.isArray(body?.categories) ? body.categories : []).slice(0, 30).map((c) => {
      const name = String(c?.name || '').trim().slice(0, 60);
      const suiteIds = (Array.isArray(c?.suiteIds) ? c.suiteIds : [])
        .map(String).filter((id) => valid.has(id) && !seen.has(id) && seen.add(id))
        .slice(0, 500);
      return { id: String(c?.id || '').trim().slice(0, 40) || uid(), name, suiteIds };
    }).filter((c) => c.name || c.suiteIds.length);
    db.setSetting(KEY(eid), JSON.stringify(cats));
    return cats;
  }

  // Dual surface: admin manages any client; a client manages their own entity.
  const myGuard = (req, res, next) => {
    if (req.user.role !== 'admin' && !(req.user.entityIds || []).includes(req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
    next();
  };
  for (const [base, guards] of [
    ['/api/admin/entities/:entityId/suite-categories', [auth.requireAdmin]],
    ['/api/my/suite-categories/:entityId', [auth.requireAuth, myGuard]],
  ]) {
    app.get(base, ...guards, (req, res) => res.json({ categories: read(req.params.entityId) }));
    app.put(base, ...guards, asyncHandler(async (req, res) => res.json({ categories: save(req.params.entityId, req.body) })));
  }
  return { read };
}

module.exports = { mount };
