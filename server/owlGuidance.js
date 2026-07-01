// ─── Owl guidance — the no-code fine-tuning layer ─────────────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Mounted from owlChat.js (so index.js stays
// lean). Remove that line + this file to uninstall.
//
// The Owl's analytical correctness is governed by the curated catalogue (measures,
// dimensions, rules) which is CODE. This adds a plain-text steering layer an admin
// (or, when the Owl opens to clients, a client) can edit WITHOUT a deploy:
//   • Global "house rules"     → setting `owl_guidance`     (every answer follows)
//   • Per-client guidance      → setting `owl_guidance:<entityId>` (layers on top)
// Both are injected into the Owl's instructions per request (see owlChat.js) and
// surfaced in the Admin → AI audit (GET /api/admin/ai-overview).
//
// Stored as settings (mirrors digest_prefs:<entityId>) — no schema change. Free text,
// capped. NOT secret (it's steering, not credentials), so it reads back in full.

const CAP = 8000;

// Combined guidance text for a given client (global house rules + that client's
// extra guidance). Returned as instruction text the Owl appends to its system prompt.
function resolveGuidance(db, entityId) {
  const read = (k) => String(db.getSetting(k, '') || '').trim();
  const g = read('owl_guidance');
  const c = entityId ? read(`owl_guidance:${entityId}`) : '';
  const parts = [];
  if (g) parts.push(`Owl house rules — always follow these when answering:\n${g}`);
  if (c) parts.push(`Extra guidance for this specific client (takes precedence on conflict):\n${c}`);
  return parts.join('\n\n');
}

function mount(app, { db, auth }) {
  const read = (key) => String(db.getSetting(key, '') || '');
  const write = (key, v) => db.setSetting(key, String(v || '').slice(0, CAP));

  // ── Global house rules (admin) ──────────────────────────────────────────────
  app.get('/api/admin/owl-guidance', auth.requireAdmin, (_req, res) => res.json({ guidance: read('owl_guidance') }));
  app.put('/api/admin/owl-guidance', auth.requireAdmin, (req, res) => {
    write('owl_guidance', (req.body || {}).guidance);
    res.json({ ok: true, guidance: read('owl_guidance') });
  });

  // ── Per-client guidance (admin, on the client's tab) ────────────────────────
  app.get('/api/admin/entities/:id/owl-guidance', auth.requireAdmin, (req, res) => {
    if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Client not found.' });
    res.json({ guidance: read(`owl_guidance:${req.params.id}`) });
  });
  app.put('/api/admin/entities/:id/owl-guidance', auth.requireAdmin, (req, res) => {
    if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Client not found.' });
    write(`owl_guidance:${req.params.id}`, (req.body || {}).guidance);
    res.json({ ok: true, guidance: read(`owl_guidance:${req.params.id}`) });
  });

  // ── Client self-service (scoped to the user's own entity) ───────────────────
  // The admin-set global house rules are read-only context here (shown, not edited).
  app.get('/api/my/owl-guidance', auth.requireAuth, (req, res) => {
    const eid = (req.user.entityIds || [])[0] || '';
    res.json({ guidance: eid ? read(`owl_guidance:${eid}`) : '', houseRules: read('owl_guidance'), entityId: eid });
  });
  app.put('/api/my/owl-guidance', auth.requireAuth, (req, res) => {
    const eid = (req.user.entityIds || [])[0] || '';
    if (!eid) return res.status(400).json({ error: 'No client to scope guidance to.' });
    write(`owl_guidance:${eid}`, (req.body || {}).guidance);
    res.json({ ok: true, guidance: read(`owl_guidance:${eid}`) });
  });

  console.log('[owlGuidance] no-code Owl guidance module mounted');
}

module.exports = { mount, resolveGuidance };
