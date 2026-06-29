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
    CREATE TABLE IF NOT EXISTS owl_wa_events (
      id TEXT PRIMARY KEY, msisdn TEXT NOT NULL DEFAULT '', stage TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_owl_wa_events ON owl_wa_events(created_at);
  `);
  const now = () => new Date().toISOString();
  const insMsg = sql.prepare('INSERT INTO owl_wa_msgs (id,msisdn,role,body,created_at) VALUES (?,?,?,?,?)');
  const histStmt = sql.prepare('SELECT role, body FROM owl_wa_msgs WHERE msisdn=? ORDER BY created_at DESC LIMIT 12');
  const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

  // Lightweight observability: record every meaningful step a webhook hit goes through,
  // so the admin panel can SHOW whether Clickatell is delivering + where the flow stops.
  const insEvent = sql.prepare('INSERT INTO owl_wa_events (id,msisdn,stage,detail,created_at) VALUES (?,?,?,?,?)');
  const logEvent = (msisdn, stage, detail) => { try { insEvent.run(crypto.randomUUID(), msisdn || '', stage, String(detail || '').slice(0, 800), now()); } catch { /* ignore */ } };

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
    if (!id) { logEvent(msisdn, 'no-account', 'number not linked to any Pulse user'); await messaging.sendWhatsapp({ to: msisdn, text: 'Hi! This number isn\'t linked to a Howler account yet. Ask your Howler contact to connect it, then I can answer questions about your event data.' }); return; }
    logEvent(msisdn, 'identified', `${id.user.email || '?'} → ${id.entityId || '(no client)'}`);
    const apiKey = anthropicKeyForEntity ? anthropicKeyForEntity(id.entityId || undefined) : undefined;
    if (!insights.isConfigured(apiKey)) { logEvent(msisdn, 'no-ai-key', 'Anthropic key not configured'); await messaging.sendWhatsapp({ to: msisdn, text: 'The Owl isn\'t available right now — please try again shortly.' }); return; }
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
    const sent = await messaging.sendWhatsapp({ to: msisdn, text: answer });
    logEvent(msisdn, sent && sent.ok ? 'replied' : 'send-failed', sent && sent.ok ? answer.slice(0, 120) : (sent && sent.error) || 'send error');
  }

  // Pull the sender + text out of Clickatell's inbound (MO) payload, defensively.
  // First the known flat/nested shapes; if those miss, fall back to a generic scan that
  // walks the whole object for a phone-like sender + a message body — so we cope with
  // whatever field names Clickatell's WhatsApp MO actually uses.
  function parseInbound(body) {
    const m = (body && Array.isArray(body.messages) ? body.messages[0] : body) || {};
    let from = m.from || m.fromNumber || m.sender || m.source || m.msisdn || (body && body.from) || '';
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (m.text) text = typeof m.text === 'string' ? m.text : (m.text.body || '');
    else if (m.message) text = typeof m.message === 'string' ? m.message : (m.message.text || m.message.body || m.message.content || '');
    else if (typeof body.text === 'string') text = body.text;
    if (!from || !text) { const g = scanInbound(body); from = from || g.from; text = text || g.text; }
    return { from: String(from || ''), text: String(text || '').trim() };
  }

  // Generic, shape-agnostic extractor. Recursively walks the payload collecting any
  // sender-named key holding a phone-like value, and any text-named key holding a
  // human message — deliberately ignoring destination/id/number-name keys.
  function scanInbound(root) {
    const isPhone = (v) => typeof v === 'string' && /^\+?\d[\d ()-]{7,16}$/.test(v.trim());
    const FROM_KEY = /^(from|fromnumber|sender|source|msisdn|author|wa_id|waid)$/i;
    const TEXT_KEY = /^(content|text|body|message|caption)$/i;
    const SKIP_KEY = /(^to$|tonumber|destination|recipient|messageid|apimessageid|integrationid|accountid|^id$)/i;
    let from = ''; let text = '';
    const seen = new Set();
    const walk = (node) => {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      for (const [k, v] of Object.entries(node)) {
        if (v && typeof v === 'object') { walk(v); continue; }
        if (SKIP_KEY.test(k)) continue;
        if (!from && FROM_KEY.test(k) && isPhone(v)) from = v;
        if (!from && isPhone(v) && /from|sender|source|origin/i.test(k)) from = v;
        if (!text && TEXT_KEY.test(k) && typeof v === 'string' && v.trim() && !isPhone(v)) text = v;
      }
    };
    try { walk(root); } catch { /* ignore */ }
    return { from, text };
  }

  // Clickatell webhook. Ack immediately (200), process in the background so a slow LLM
  // turn never times the webhook out. Optional shared secret (?key= or x-webhook-secret).
  app.post('/api/whatsapp/inbound', (req, res) => {
    const secret = (db.getSetting('whatsapp_webhook_secret', '') || '').trim();
    if (secret && req.query.key !== secret && req.get('x-webhook-secret') !== secret) {
      logEvent('', 'rejected', 'bad/missing webhook secret — Clickatell URL is missing ?key=');
      return res.status(401).json({ error: 'bad secret' });
    }
    res.json({ ok: true });
    try {
      const { from, text } = parseInbound(req.body || {});
      const msisdn = norm(from);
      // Temporary aid for the first live test: confirm we parse Clickatell's reply shape.
      console.log(`[owlWhatsapp] inbound from=${msisdn || '∅'} text="${(text || '').slice(0, 60)}"${msisdn && text ? '' : ` (unparsed raw: ${JSON.stringify(req.body).slice(0, 400)})`}`);
      if (!msisdn || !text) { logEvent(msisdn, 'unparsed', `couldn't read sender/text from payload: ${JSON.stringify(req.body).slice(0, 700)}`); return; }
      logEvent(msisdn, 'received', text.slice(0, 120));
      handleInbound(msisdn, text).catch((e) => { logEvent(msisdn, 'error', (e && e.message) || 'handler error'); console.error('[owlWhatsapp] handle failed', e && e.message); });
    } catch (e) { logEvent('', 'error', (e && e.message) || 'parse error'); console.error('[owlWhatsapp] inbound parse failed', e && e.message); }
  });

  // Admin: manage the number→client allowlist + the WhatsApp 'from' number + secret.
  app.get('/api/admin/owl-whatsapp', auth.requireAdmin, (_req, res) => {
    const sec = (db.getSetting('whatsapp_webhook_secret', '') || '').trim();
    res.json({
      from: messaging.waFrom ? messaging.waFrom() : '',
      hasSecret: !!sec,
      hasApiKey: !!(messaging.waConfigured && messaging.waConfigured()),
      // When a secret is set, the callback URL must carry it — so hand back the exact
      // URL (key embedded) to paste into Clickatell. Admin-only screen.
      webhookPath: sec ? `/api/whatsapp/inbound?key=${encodeURIComponent(sec)}` : '/api/whatsapp/inbound',
      numbers: Object.entries(allowlist()).map(([msisdn, v]) => ({ msisdn, email: v.email || '', entityId: v.entityId || '' })),
    });
  });
  app.put('/api/admin/owl-whatsapp', auth.requireAdmin, (req, res) => {
    const b = req.body || {};
    if (b.from !== undefined) db.setSetting('whatsapp_from', String(b.from || '').trim());
    if (b.apiKey) db.setSetting('whatsapp_api_key', String(b.apiKey).trim()); // write-only; reuses SMS key if blank
    if (b.secret !== undefined) db.setSetting('whatsapp_webhook_secret', String(b.secret || '').trim());
    if (Array.isArray(b.numbers)) {
      const map = {};
      for (const n of b.numbers) { const m = norm(n.msisdn); if (m && n.email) map[m] = { email: String(n.email).trim(), entityId: String(n.entityId || '').trim() }; }
      db.setSetting('owl_whatsapp_numbers', JSON.stringify(map));
    }
    res.json({ ok: true });
  });

  // Admin: the recent webhook activity — so you can SEE whether Clickatell is delivering
  // your real inbound messages, and exactly where the flow stops if it does arrive.
  const recentStmt = sql.prepare('SELECT msisdn, stage, detail, created_at FROM owl_wa_events ORDER BY created_at DESC LIMIT 40');
  app.get('/api/admin/owl-whatsapp/inbound-log', auth.requireAdmin, (_req, res) => {
    res.json({ events: recentStmt.all() });
  });

  // Admin: send a test WhatsApp to confirm OUTBOUND works (before wiring the callback).
  app.post('/api/admin/owl-whatsapp/test', auth.requireAdmin, async (req, res) => {
    const to = norm(String((req.body || {}).to || ''));
    if (!to) return res.status(400).json({ error: 'Enter a valid number (e.g. 27XXXXXXXXX).' });
    const r = await messaging.sendWhatsapp({ to, text: String((req.body || {}).text || '').trim() || 'Hello from the Howler Owl 🦉 — your WhatsApp connection is working.' });
    res.json(r);
  });

  console.log('[owlWhatsapp] WhatsApp door mounted (POST /api/whatsapp/inbound)');
}

module.exports = { mount };
