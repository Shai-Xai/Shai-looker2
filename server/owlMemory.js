// ─── Owl memory — durable facts the Owl carries across chats ───────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Mounted from owlChat.js. Remove that line + this
// file to uninstall.
//
// Within-chat history remembers a CONVERSATION; this remembers the CLIENT, the EVENT and
// the USER. Memory is SCOPED — different events under one client can hold different facts
// (one festival sells add-ons heavily, another is single-day) without bleeding into each
// other, while client-wide facts apply everywhere, and user facts are this person's own
// preferences (how they like answers shaped, not the data):
//   • client memory → setting `owl_memory:<entityId>`        (every chat for that client)
//   • event  memory → setting `owl_memory:event:<suiteId>`   (only that event's context)
//   • user   memory → setting `owl_memory:user:<userId>`     (this person, across clients)
// All three are injected into the Owl's prompt (web + WhatsApp). Two ways in: the Owl
// proposes a fact via the rememberFact ACT-tool (user confirms), or an admin/client edits
// the list. Never PII; capped + editable; scoped per client/event/user (fail-closed
// re-check on commit).

const crypto = require('crypto');
const MAX_ITEMS = 40;
const CAP = 300;

const keyFor = (scope, id) => (scope === 'event' ? `owl_memory:event:${id}` : scope === 'user' ? `owl_memory:user:${id}` : `owl_memory:${id}`);

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
// event's facts when an event is in scope (event facts take precedence on conflict), plus
// this user's own preferences (shape/emphasis of the answer, never the data).
function memoryNote(db, entityId, suiteId, userId) {
  const m = build(db);
  const cl = entityId ? m.read('client', entityId) : [];
  const ev = suiteId ? m.read('event', suiteId) : [];
  const us = userId ? m.read('user', userId) : [];
  const parts = [];
  if (cl.length) parts.push(`What you REMEMBER about this client (durable facts — apply them, and don't re-ask what you already know):\n- ${cl.map((x) => x.text).join('\n- ')}`);
  if (ev.length) parts.push(`What you REMEMBER about THIS EVENT specifically (takes precedence over the client facts on any conflict):\n- ${ev.map((x) => x.text).join('\n- ')}`);
  if (us.length) parts.push(`Personal preferences of THIS USER (apply to how you STYLE and EMPHASISE the answer — wording, level of detail, what to lead with — not to the underlying data):\n- ${us.map((x) => x.text).join('\n- ')}`);
  return parts.join('\n\n');
}

// ── rememberFact ACT-tool ─────────────────────────────────────────────────────
// DRAFTS a memory item (confirm:true) at client OR event scope; the act-layer commits it.
const tool = {
  schema: {
    name: 'rememberFact',
    description: "Offer to REMEMBER a durable fact/preference so it carries into future chats — e.g. \"they report revenue excluding fees\", \"VIP is their priority tier\", \"this event is a 3-day camping festival\", \"GA is called 'Phase' tickets\". It DRAFTS the memory; the user taps Confirm to save it (nothing is stored until they do). Set scope='event' when the fact is specific to the CURRENT event only; scope='user' when it's THIS person's own preference for how answers should be shaped (e.g. \"I prefer short bullet answers\", \"always show me revenue before ticket counts\") rather than a fact about the data; use scope='client' (default) for a fact that applies to the whole client/organiser. Call it when the user states a LASTING fact/preference, or you learn one worth keeping. Do NOT remember one-off question details, transient figures, dates that go stale, or ANY personal/contact data. One concise fact per call.",
    input_schema: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'The short, durable fact/preference to remember (one sentence).' },
        scope: { type: 'string', enum: ['client', 'event', 'user'], description: "'event' = specific to the current event only; 'user' = this person's own answer-style preference; 'client' (default) = applies to the whole client." },
      },
      required: ['fact'],
    },
  },
  run(args = {}, ctx = {}) {
    const entityId = ctx.entityId || (((ctx.user || {}).entityIds || []).length === 1 ? ctx.user.entityIds[0] : '');
    const suiteId = ctx.suiteId || '';
    const userId = (ctx.user || {}).id || '';
    const fact = String(args.fact || '').trim().slice(0, CAP);
    let memScope = args.scope === 'event' ? 'event' : args.scope === 'user' ? 'user' : 'client';
    if (memScope === 'event' && !suiteId) memScope = 'client'; // no event in context → fall back to client
    if (memScope === 'user' && !userId) memScope = 'client'; // no user in context → fall back to client
    const targetId = memScope === 'event' ? suiteId : memScope === 'user' ? userId : entityId;
    if (!targetId) return { ok: false, error: 'no_scope', note: 'Open a client (or event) first, then I can remember that.' };
    if (!fact) return { ok: false, error: 'empty', note: 'Tell me the fact to remember.' };
    const tag = memScope === 'event' ? ' (this event)' : memScope === 'user' ? ' (just for you)' : '';
    return { ok: true, confirm: true, action: { kind: 'rememberFact', memScope, targetId, entityId, suiteId, userId, fact, summary: `Remember${tag}: ${fact}` } };
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
  // A client may pass ?entityId= to choose which of their clients (defaults to the first).
  const ownEntity = (req) => {
    const want = (req.query.entityId || (req.body || {}).entityId || '').toString();
    const ids = req.user.entityIds || [];
    if (want) return ids.includes(want) ? want : '';
    return ids[0] || '';
  };
  app.get('/api/my/owl-memory', auth.requireAuth, (req, res) => {
    const eid = ownEntity(req);
    res.json({ items: eid ? api.read('client', eid) : [], entityId: eid });
  });
  app.put('/api/my/owl-memory', auth.requireAuth, (req, res) => {
    const eid = ownEntity(req);
    if (!eid) return res.status(400).json({ error: 'No client to scope memory to.' });
    res.json({ ok: true, items: api.save('client', eid, (req.body || {}).items || []) });
  });
  // ── Event self-service (an event the user can access) ───────────────────────
  app.get('/api/my/suites/:id/owl-memory', auth.requireAuth, (req, res) => {
    if (!db.getSuite(req.params.id)) return res.status(404).json({ error: 'Event not found.' });
    if (req.user.role !== 'admin' && !auth.canAccessSuite(req.user, req.params.id)) return res.status(403).json({ error: 'Not allowed.' });
    res.json({ items: api.read('event', req.params.id) });
  });
  app.put('/api/my/suites/:id/owl-memory', auth.requireAuth, (req, res) => {
    if (!db.getSuite(req.params.id)) return res.status(404).json({ error: 'Event not found.' });
    if (req.user.role !== 'admin' && !auth.canAccessSuite(req.user, req.params.id)) return res.status(403).json({ error: 'Not allowed.' });
    res.json({ ok: true, items: api.save('event', req.params.id, (req.body || {}).items || []) });
  });
  // ── User memory (this person's own preferences — always self-scoped) ─────────
  app.get('/api/my/owl-user-memory', auth.requireAuth, (req, res) => {
    res.json({ items: api.read('user', req.user.id) });
  });
  app.put('/api/my/owl-user-memory', auth.requireAuth, (req, res) => {
    res.json({ ok: true, items: api.save('user', req.user.id, (req.body || {}).items || []) });
  });

  console.log('[owlMemory] client/event/user memory module mounted');
  return api;
}

module.exports = { mount, build, memoryNote, tool };
