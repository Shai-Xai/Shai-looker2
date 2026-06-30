// ─── Owl memory — durable, per-client facts the Owl carries across chats ───────
// SELF-CONTAINED, DISPOSABLE MODULE. Mounted from owlChat.js. Remove that line + this
// file to uninstall.
//
// Within-chat history lets the Owl remember a CONVERSATION; this lets it remember the
// CLIENT — short durable facts/preferences ("VIP is the priority tier", "they report
// revenue excluding fees", "flagship event is KFF") that are injected into EVERY Owl
// turn for that client, on web AND WhatsApp (one source). Two ways in, both safe:
//   • the Owl proposes one via the rememberFact ACT-tool → the user confirms to save it
//     (same draft→confirm flow as alerts), and
//   • an admin/client edits the list directly.
// Scoped per client (the setting key carries the entityId); never PII; capped + editable.

const crypto = require('crypto');
const MAX_ITEMS = 40;   // keep the injected note small + relevant
const CAP = 300;        // per-fact length

function build(db) {
  const key = (eid) => `owl_memory:${eid}`;
  const read = (eid) => {
    if (!eid) return [];
    try { const a = JSON.parse(db.getSetting(key(eid), '') || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
  };
  const write = (eid, items) => db.setSetting(key(eid), JSON.stringify((items || []).slice(0, MAX_ITEMS)));
  // Add one fact (de-duped, case-insensitive). Returns the item (existing or new).
  const add = (eid, text, by) => {
    const t = String(text || '').trim().slice(0, CAP);
    if (!eid || !t) return null;
    const items = read(eid);
    const dupe = items.find((m) => (m.text || '').toLowerCase() === t.toLowerCase());
    if (dupe) return dupe;
    const item = { id: crypto.randomUUID(), text: t, at: new Date().toISOString(), by: String(by || '').slice(0, 120) };
    write(eid, [item, ...items]);
    return item;
  };
  // Replace the whole list (the editor's Save). Sanitises + drops empties.
  const save = (eid, items) => {
    const clean = (items || [])
      .map((m) => ({ id: m.id || crypto.randomUUID(), text: String(m.text || '').trim().slice(0, CAP), at: m.at || new Date().toISOString(), by: m.by || '' }))
      .filter((m) => m.text);
    write(eid, clean);
    return read(eid);
  };
  return { read, add, save };
}

// The instruction text injected into the Owl's prompt for this client (empty if none).
function memoryNote(db, entityId) {
  if (!entityId) return '';
  const items = build(db).read(entityId);
  if (!items.length) return '';
  return `What you REMEMBER about this client (durable facts they've confirmed — apply them, and don't re-ask what you already know):\n- ${items.map((m) => m.text).join('\n- ')}`;
}

// ── rememberFact ACT-tool ─────────────────────────────────────────────────────
// DRAFTS a memory item (confirm:true); the existing act-layer commits it (web card /
// WhatsApp button → POST /api/owl/act/remember / commitPending). Bundled here so it can
// be added to the tool set without touching the shared owlTools factory.
const tool = {
  schema: {
    name: 'rememberFact',
    description: "Offer to REMEMBER a durable fact or preference about THIS client so it carries into future chats — e.g. \"VIP is their priority tier\", \"they report revenue excluding fees\", \"flagship event is KFF\", \"they don't sell add-ons\", \"they call GA 'Phase' tickets\". It DRAFTS the memory; the user taps Confirm to save it (nothing is stored until they do). Call it when the user states a LASTING fact/preference about their business, naming, or what they care about — or you learn something clearly worth carrying across conversations. Do NOT remember one-off question details, transient figures, dates that go stale, or ANY personal/contact data. One concise fact per call.",
    input_schema: { type: 'object', properties: { fact: { type: 'string', description: 'The short, durable fact/preference to remember (one sentence).' } }, required: ['fact'] },
  },
  run(args = {}, ctx = {}) {
    const entityId = ctx.entityId || (((ctx.user || {}).entityIds || []).length === 1 ? ctx.user.entityIds[0] : '');
    const fact = String(args.fact || '').trim().slice(0, CAP);
    if (!entityId) return { ok: false, error: 'no_client', note: 'Open a client first, then I can remember that for them.' };
    if (!fact) return { ok: false, error: 'empty', note: 'Tell me the fact to remember.' };
    return { ok: true, confirm: true, action: { kind: 'rememberFact', entityId, fact, summary: `Remember: ${fact}` } };
  },
};

function mount(app, { db, auth }) {
  const api = build(db);

  // ── Per-client memory (admin, on the client's detail tab) ───────────────────
  app.get('/api/admin/entities/:id/owl-memory', auth.requireAdmin, (req, res) => {
    if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Client not found.' });
    res.json({ items: api.read(req.params.id) });
  });
  app.put('/api/admin/entities/:id/owl-memory', auth.requireAdmin, (req, res) => {
    if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Client not found.' });
    res.json({ ok: true, items: api.save(req.params.id, (req.body || {}).items || []) });
  });

  // ── Client self-service (scoped to the user's own entity) ───────────────────
  app.get('/api/my/owl-memory', auth.requireAuth, (req, res) => {
    const eid = (req.user.entityIds || [])[0] || '';
    res.json({ items: eid ? api.read(eid) : [], entityId: eid });
  });
  app.put('/api/my/owl-memory', auth.requireAuth, (req, res) => {
    const eid = (req.user.entityIds || [])[0] || '';
    if (!eid) return res.status(400).json({ error: 'No client to scope memory to.' });
    res.json({ ok: true, items: api.save(eid, (req.body || {}).items || []) });
  });

  console.log('[owlMemory] client memory module mounted');
  return api;
}

module.exports = { mount, build, memoryNote, tool };
