// ─── Owl memory — durable facts the Owl carries across chats ───────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Mounted from owlChat.js. Remove that line + this
// file to uninstall.
//
// Within-chat history remembers a CONVERSATION; this remembers the CLIENT and the EVENT.
// Memory is SCOPED — different events under one client can hold different facts (one
// festival sells add-ons heavily, another is single-day) without bleeding into each
// other, while client-wide facts apply everywhere:
//   • client memory → setting `owl_memory:<entityId>`        (every chat for that client)
//   • event  memory → setting `owl_memory:event:<suiteId>`   (only that event's context)
// Both are injected into the Owl's prompt (web + WhatsApp). Two ways in: the Owl proposes
// a fact via the rememberFact ACT-tool (user confirms), or an admin/client edits the list.
// Never PII; capped + editable; scoped per client/event (fail-closed re-check on commit).

const crypto = require('crypto');
const MAX_ITEMS = 40;
const CAP = 300;

const keyFor = (scope, id) => (scope === 'event' ? `owl_memory:event:${id}` : `owl_memory:${id}`);

function build(db) {
  const read = (scope, id) => {
    if (!id) return [];
    try { const a = JSON.parse(db.getSetting(keyFor(scope, id), '') || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
  };
  const write = (scope, id, items) => db.setSetting(keyFor(scope, id), JSON.stringify((items || []).slice(0, MAX_ITEMS)));
  // Add one fact (de-duped, case-insensitive). Returns the item (existing or new).
  const add = (scope, id, text, by) => {
    const t = String(text || '').trim().slice(0, CAP);
    if (!id || !t) return null;
    const items = read(scope, id);
    const dupe = items.find((m) => (m.text || '').toLowerCase() === t.toLowerCase());
    if (dupe) return dupe;
    const item = { id: crypto.randomUUID(), text: t, at: new Date().toISOString(), by: String(by || '').slice(0, 120) };
    write(scope, id, [item, ...items]);
    return item;
  };
  // Replace the whole list (the editor's Save). Sanitises + drops empties.
  const save = (scope, id, items) => {
    const clean = (items || [])
      .map((m) => ({ id: m.id || crypto.randomUUID(), text: String(m.text || '').trim().slice(0, CAP), at: m.at || new Date().toISOString(), by: m.by || '' }))
      .filter((m) => m.text);
    write(scope, id, clean);
    return read(scope, id);
  };
  return { read, add, save };
}

// The instruction text injected into the Owl's prompt: the client's facts, plus this
// event's facts when an event is in scope (event facts take precedence on conflict).
function memoryNote(db, entityId, suiteId) {
  const m = build(db);
  const cl = entityId ? m.read('client', entityId) : [];
  const ev = suiteId ? m.read('event', suiteId) : [];
  const parts = [];
  if (cl.length) parts.push(`What you REMEMBER about this client (durable facts — apply them, and don't re-ask what you already know):\n- ${cl.map((x) => x.text).join('\n- ')}`);
  if (ev.length) parts.push(`What you REMEMBER about THIS EVENT specifically (takes precedence over the client facts on any conflict):\n- ${ev.map((x) => x.text).join('\n- ')}`);
  return parts.join('\n\n');
}

// ── rememberFact ACT-tool ─────────────────────────────────────────────────────
// DRAFTS a memory item (confirm:true) at client OR event scope; the act-layer commits it.
const tool = {
  schema: {
    name: 'rememberFact',
    description: "Offer to REMEMBER a durable fact/preference so it carries into future chats — e.g. \"they report revenue excluding fees\", \"VIP is their priority tier\", \"this event is a 3-day camping festival\", \"GA is called 'Phase' tickets\". It DRAFTS the memory; the user taps Confirm to save it (nothing is stored until they do). Set scope='event' when the fact is specific to the CURRENT event only; use scope='client' (default) for a fact that applies to the whole client/organiser. Call it when the user states a LASTING fact/preference, or you learn one worth keeping. Do NOT remember one-off question details, transient figures, dates that go stale, or ANY personal/contact data. One concise fact per call.",
    input_schema: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'The short, durable fact/preference to remember (one sentence).' },
        scope: { type: 'string', enum: ['client', 'event'], description: "'event' = specific to the current event only; 'client' (default) = applies to the whole client." },
      },
      required: ['fact'],
    },
  },
  run(args = {}, ctx = {}) {
    const entityId = ctx.entityId || (((ctx.user || {}).entityIds || []).length === 1 ? ctx.user.entityIds[0] : '');
    const suiteId = ctx.suiteId || '';
    const fact = String(args.fact || '').trim().slice(0, CAP);
    let memScope = args.scope === 'event' ? 'event' : 'client';
    if (memScope === 'event' && !suiteId) memScope = 'client'; // no event in context → fall back to client
    const targetId = memScope === 'event' ? suiteId : entityId;
    if (!targetId) return { ok: false, error: 'no_scope', note: 'Open a client (or event) first, then I can remember that.' };
    if (!fact) return { ok: false, error: 'empty', note: 'Tell me the fact to remember.' };
    return { ok: true, confirm: true, action: { kind: 'rememberFact', memScope, targetId, entityId, suiteId, fact, summary: `Remember${memScope === 'event' ? ' (this event)' : ''}: ${fact}` } };
  },
};

function mount(app, { db, auth }) {
  const api = build(db);
  // ── Per-client memory (admin) ───────────────────────────────────────────────
  app.get('/api/admin/entities/:id/owl-memory', auth.requireAdmin, (req, res) => {
    if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Client not found.' });
    res.json({ items: api.read('client', req.params.id) });
  });
  app.put('/api/admin/entities/:id/owl-memory', auth.requireAdmin, (req, res) => {
    if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Client not found.' });
    res.json({ ok: true, items: api.save('client', req.params.id, (req.body || {}).items || []) });
  });
  // ── Per-event memory (admin) ────────────────────────────────────────────────
  app.get('/api/admin/suites/:id/owl-memory', auth.requireAdmin, (req, res) => {
    if (!db.getSuite(req.params.id)) return res.status(404).json({ error: 'Event not found.' });
    res.json({ items: api.read('event', req.params.id) });
  });
  app.put('/api/admin/suites/:id/owl-memory', auth.requireAdmin, (req, res) => {
    if (!db.getSuite(req.params.id)) return res.status(404).json({ error: 'Event not found.' });
    res.json({ ok: true, items: api.save('event', req.params.id, (req.body || {}).items || []) });
  });
  // ── Client self-service (own client) ────────────────────────────────────────
  app.get('/api/my/owl-memory', auth.requireAuth, (req, res) => {
    const eid = (req.user.entityIds || [])[0] || '';
    res.json({ items: eid ? api.read('client', eid) : [], entityId: eid });
  });
  app.put('/api/my/owl-memory', auth.requireAuth, (req, res) => {
    const eid = (req.user.entityIds || [])[0] || '';
    if (!eid) return res.status(400).json({ error: 'No client to scope memory to.' });
    res.json({ ok: true, items: api.save('client', eid, (req.body || {}).items || []) });
  });

  console.log('[owlMemory] client/event memory module mounted');
  return api;
}

module.exports = { mount, build, memoryNote, tool };
