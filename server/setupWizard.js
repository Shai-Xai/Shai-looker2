// ─── Client setup wizard config — SELF-CONTAINED, DISPOSABLE MODULE ───────────
// Lets account managers edit the back-end "Client setup wizard" from the admin UI
// instead of from code: step wording, the order of steps, and their own extra
// guidance/checklist steps. This module is a dumb JSON store — the DEFAULT steps
// and the behaviour of the built-in steps (create client, scope, suites, logins,
// branding) live in the front-end; the server only persists the saved override.
//
//   • config   — a single JSON row: the effective ordered list of steps.
//   • progress — per-client tick state for custom guidance-step checklist items,
//                so a half-finished client resumes with its ticks intact.
//
// Mount: require('./setupWizard').mount(app, { db, auth });

function mount(app, { db, auth }) {
  const sql = db.db;
  sql.exec(`CREATE TABLE IF NOT EXISTS setup_wizard_config (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    steps      TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL DEFAULT ''
  );`);
  sql.exec(`CREATE TABLE IF NOT EXISTS setup_wizard_progress (
    entity_id  TEXT NOT NULL,
    item_key   TEXT NOT NULL,          -- "<customStepKey>:<itemKey>"
    done       INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (entity_id, item_key)
  );`);

  // The saved override, or null when the AM hasn't customised it (→ front-end
  // falls back to its built-in defaults). Stored as the full ordered step list.
  const getConfig = () => {
    try {
      const row = sql.prepare('SELECT steps, updated_at FROM setup_wizard_config WHERE id = 1').get();
      if (!row) return { steps: null, updatedAt: null };
      const steps = JSON.parse(row.steps || 'null');
      return { steps: Array.isArray(steps) ? steps : null, updatedAt: row.updated_at || null };
    } catch { return { steps: null, updatedAt: null }; }
  };
  const saveConfig = (steps) => {
    const json = JSON.stringify(Array.isArray(steps) ? steps : []);
    sql.prepare(`INSERT INTO setup_wizard_config (id, steps, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET steps = excluded.steps, updated_at = excluded.updated_at`).run(json, new Date().toISOString());
  };

  const progressFor = (entityId) => {
    const out = {};
    try { for (const r of sql.prepare('SELECT item_key, done FROM setup_wizard_progress WHERE entity_id = ?').all(entityId)) out[r.item_key] = r.done; } catch { /* table new */ }
    return out;
  };

  // ── Admin: read / write the wizard configuration ────────────────────────────
  app.get('/api/admin/setup-wizard', auth.requireAdmin, (req, res) => res.json(getConfig()));

  app.put('/api/admin/setup-wizard', auth.requireAdmin, (req, res) => {
    const steps = req.body && req.body.steps;
    if (steps != null && !Array.isArray(steps)) return res.status(400).json({ error: 'steps must be an array' });
    saveConfig(steps || []);
    res.json(getConfig());
  });

  // Reset to built-in defaults (clears the override → front-end uses its defaults).
  app.delete('/api/admin/setup-wizard', auth.requireAdmin, (req, res) => {
    try { sql.prepare('DELETE FROM setup_wizard_config WHERE id = 1').run(); } catch { /* noop */ }
    res.json(getConfig());
  });

  // ── Admin: per-client checklist progress for custom guidance steps ──────────
  app.get('/api/admin/setup-wizard/progress/:entityId', auth.requireAdmin, (req, res) => {
    res.json({ ticks: progressFor(req.params.entityId) });
  });
  app.post('/api/admin/setup-wizard/progress/:entityId/:itemKey', auth.requireAdmin, (req, res) => {
    const done = !!(req.body && req.body.done);
    sql.prepare(`INSERT INTO setup_wizard_progress (entity_id, item_key, done, updated_at) VALUES (?,?,?,?)
      ON CONFLICT(entity_id, item_key) DO UPDATE SET done = excluded.done, updated_at = excluded.updated_at`)
      .run(req.params.entityId, req.params.itemKey, done ? 1 : 0, new Date().toISOString());
    res.json({ ticks: progressFor(req.params.entityId) });
  });

  console.log('[setupWizard] config module mounted');
  return { getConfig };
}

module.exports = { mount };
