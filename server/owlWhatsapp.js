// ─── Owl on WhatsApp — a third "door" onto the same brain (Clickatell) ─────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns owl_wa_msgs + /api/whatsapp/inbound +
// /api/admin/owl-whatsapp. Mounted from owlChat.js. Remove that line + this file.
//
// A customer messages the Howler WhatsApp number; Clickatell POSTs it to our webhook;
// we identify the number → a Pulse user + their org, run the SAME runOwlLoop (with the
// SAME scope gate + tools), and reply via Clickatell. The 24h customer-service window
// means replies are free-form — no template approval needed.
//
// Identity (pilot): an allowlist setting maps a phone number → { email, entityId }, and
// we also fall back to matching a user's own `mobile`. Scope is then enforced by the
// usual gate, so a WhatsApp user can only ever reach their own client's data.

const crypto = require('crypto');
const { runOwlLoop, owlTurn } = require('./owlChat'); // owlTurn already layers OWL_CHAT_SYSTEM
const { resolveGuidance } = require('./owlGuidance');

const WA_OVERRIDE = 'OVERRIDE — this conversation is over WhatsApp: reply in SHORT, plain text. No markdown tables, no chart/toggle talk, and never output a <<<FOLLOWUPS>>> marker. Use *single asterisks* for light emphasis. Lead with the answer. Money in ZAR.';

function mount(app, { db, auth, insights, messaging, owlTools, owlFields, anthropicKeyForEntity }) {
  const sql = db.db;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS owl_wa_msgs (
      id TEXT PRIMARY KEY, msisdn TEXT NOT NULL, role TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_owl_wa_msisdn ON owl_wa_msgs(msisdn, created_at);
  `);
  const now = () => new Date().toISOString();
  const insMsg = sql.prepare('INSERT INTO owl_wa_msgs (id,msisdn,role,body,created_at) VALUES (?,?,?,?,?)');
  const histStmt = sql.prepare('SELECT role, body FROM owl_wa_msgs WHERE msisdn=? ORDER BY created_at DESC LIMIT 12');
  const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

  const toolEntries = Object.values(owlTools).filter((t) => t && t.schema && t.run);
  const toolMap = Object.fromEntries(toolEntries.map((t) => [t.schema.name, t]));
  const toolSchemas = toolEntries.map((t) => t.schema);
  const norm = (n) => messaging.normaliseMsisdn(n);

  const allowlist = () => J(db.getSetting('owl_whatsapp_numbers', '') || '{}', {});

  // Phone number → { user, entityId }. Allowlist first (can pin an org), else a user
  // whose own mobile matches. Returns null if the number isn't linked.
  function identify(msisdn) {
    const allow = allowlist();
    const entry = allow[msisdn];
    let user = null; let entityId = '';
    if (entry && entry.email) { user = db.getUserByEmail(entry.email); entityId = entry.entityId || ''; }
    if (!user) user = (db.listUsers() || []).find((u) => u.mobile && norm(u.mobile) === msisdn) || null;
    if (!user) return null;
    if (!entityId) entityId = (user.entityIds && user.entityIds[0]) || '';
    return { user, entityId };
  }

  // Build the per-turn instructions (scope, date, the live field dictionary, guidance,
  // and the WhatsApp plain-text override). Mirrors the web route, trimmed for WhatsApp.
  function instructionsFor(entityId) {
    const today = now().slice(0, 10);
    const ent = entityId && db.getEntity ? db.getEntity(entityId) : null;
    const parts = [`Today's date is ${today}.`];
    if (ent) parts.push(`All data in this conversation is scoped to: ${ent.name}. Lead your answer with "For ${ent.name}:" and never imply the figures cover other clients.`);
    let fmeta = []; try { fmeta = owlFields.list(); } catch { /* ignore */ }
    if (fmeta.length) {
      parts.push(`Field guide (name = meaning): ${fmeta.map((f) => `${f.name} = ${f.label}${(f.aka || []).length ? ` (aka: ${f.aka.join(', ')})` : ''}`).join('; ')}.`);
      const qs = fmeta.filter((f) => (f.questions || []).length).map((f) => `${f.label} → ${f.questions.join(' / ')}`);
      if (qs.length) parts.push(`Typical questions by field: ${qs.join(' | ')}.`);
    }
    const cat = owlTools.catalogue || {};
    if ((cat.notes || []).length) parts.push(`Rules:\n- ${cat.notes.join('\n- ')}`);
    try { const g = resolveGuidance(db, entityId); if (g) parts.push(g); } catch { /* ignore */ }
    parts.push(WA_OVERRIDE);
    return parts.join('\n\n');
  }

  async function handleInbound(msisdn, text) {
    const id = identify(msisdn);
    if (!id) { await messaging.sendWhatsapp({ to: msisdn, text: 'Hi! This number isn\'t linked to a Howler account yet. Ask your Howler contact to connect it, then I can answer questions about your event data.' }); return; }
    const apiKey = anthropicKeyForEntity ? anthropicKeyForEntity(id.entityId || undefined) : undefined;
    if (!insights.isConfigured(apiKey)) { await messaging.sendWhatsapp({ to: msisdn, text: 'The Owl isn\'t available right now — please try again shortly.' }); return; }
    insMsg.run(crypto.randomUUID(), msisdn, 'user', text, now());
    const history = histStmt.all(msisdn).reverse().map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.body }));
    // histStmt already includes the just-inserted user message at the end.
    const instructions = instructionsFor(id.entityId);
    let answer = '';
    try {
      const { text: out } = await runOwlLoop({
        llmTurn: ({ messages: m, tools, onText }) => owlTurn(insights, { messages: m, tools, instructions, apiKey, onText }),
        toolMap, tools: toolSchemas, messages: history,
        ctx: { user: id.user, entityId: id.entityId },
      });
      answer = String(out || '').split('<<<FOLLOWUPS>>>')[0].replace(/\s+$/, '').trim();
    } catch { answer = ''; }
    if (!answer) answer = 'Sorry — I couldn\'t answer that just now. Try rephrasing?';
    insMsg.run(crypto.randomUUID(), msisdn, 'owl', answer, now());
    await messaging.sendWhatsapp({ to: msisdn, text: answer });
  }

  // Pull the sender + text out of Clickatell's inbound (MO) payload, defensively.
  function parseInbound(body) {
    const m = (body && Array.isArray(body.messages) ? body.messages[0] : body) || {};
    const from = m.from || m.fromNumber || m.sender || (body && body.from) || '';
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (m.text) text = typeof m.text === 'string' ? m.text : (m.text.body || '');
    else if (m.message) text = typeof m.message === 'string' ? m.message : (m.message.text || m.message.body || '');
    else if (typeof body.text === 'string') text = body.text;
    return { from: String(from || ''), text: String(text || '').trim() };
  }

  // Clickatell webhook. Ack immediately (200), process in the background so a slow LLM
  // turn never times the webhook out. Optional shared secret (?key= or x-webhook-secret).
  app.post('/api/whatsapp/inbound', (req, res) => {
    const secret = (db.getSetting('whatsapp_webhook_secret', '') || '').trim();
    if (secret && req.query.key !== secret && req.get('x-webhook-secret') !== secret) return res.status(401).json({ error: 'bad secret' });
    res.json({ ok: true });
    try {
      const { from, text } = parseInbound(req.body || {});
      const msisdn = norm(from);
      if (!msisdn || !text) return;
      handleInbound(msisdn, text).catch((e) => console.error('[owlWhatsapp] handle failed', e && e.message));
    } catch (e) { console.error('[owlWhatsapp] inbound parse failed', e && e.message); }
  });

  // Admin: manage the number→client allowlist + the WhatsApp 'from' number + secret.
  app.get('/api/admin/owl-whatsapp', auth.requireAdmin, (_req, res) => {
    res.json({
      from: messaging.waFrom ? messaging.waFrom() : '',
      hasSecret: !!(db.getSetting('whatsapp_webhook_secret', '') || '').trim(),
      webhookPath: '/api/whatsapp/inbound',
      numbers: Object.entries(allowlist()).map(([msisdn, v]) => ({ msisdn, email: v.email || '', entityId: v.entityId || '' })),
    });
  });
  app.put('/api/admin/owl-whatsapp', auth.requireAdmin, (req, res) => {
    const b = req.body || {};
    if (b.from !== undefined) db.setSetting('whatsapp_from', String(b.from || '').trim());
    if (b.secret !== undefined) db.setSetting('whatsapp_webhook_secret', String(b.secret || '').trim());
    if (Array.isArray(b.numbers)) {
      const map = {};
      for (const n of b.numbers) { const m = norm(n.msisdn); if (m && n.email) map[m] = { email: String(n.email).trim(), entityId: String(n.entityId || '').trim() }; }
      db.setSetting('owl_whatsapp_numbers', JSON.stringify(map));
    }
    res.json({ ok: true });
  });

  console.log('[owlWhatsapp] WhatsApp door mounted (POST /api/whatsapp/inbound)');
}

module.exports = { mount };
