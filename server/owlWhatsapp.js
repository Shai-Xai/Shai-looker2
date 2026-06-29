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
const chartImg = require('./owlChartImg');

const WA_OVERRIDE = [
  'OVERRIDE — this conversation is over WhatsApp: reply in SHORT, plain text. No markdown tables. Use *single asterisks* for light emphasis. Lead with the answer in words. Express monetary amounts in the organiser\'s reporting currency (a Currency line below states it when it isn\'t South African Rand).',
  'There is NO screen, panel, toggle, button or chart-type switcher here. NEVER tell the user to tap, switch or toggle anything, and never refer to something "below" or "on screen" — they are on WhatsApp.',
  'Say NOTHING about chart delivery: never announce, point at, apologise for, or promise a chart/image — no "here\'s a chart", no 👇/👆, no "a fresh chart is on its way", no "re-sent". A chart link/image is attached automatically when useful; just answer with the figures in words.',
  'When the user wants to SEE data as a chart / line graph / bar chart / trend — EVEN data you just gave them — you MUST re-run it as ONE grouped askData query (a dimension such as day/month/event plus the measure) so a fresh chart image can be attached. Never reply "it\'s the same data" or refuse to re-pull, and never split a trend into many separate per-day lookups.',
  'End your reply with the <<<FOLLOWUPS>>> marker + a JSON array of 2-3 SHORT (≤6 words) next questions, exactly as instructed; the app turns them into tappable buttons.',
].join('\n');

const FU_MARK = '<<<FOLLOWUPS>>>';
// Parse the trailing "<<<FOLLOWUPS>>>[...]" JSON array the model emits (mirrors the
// web client). Returns up to 3 short next-question strings, or [].
function parseFollowups(out) {
  const i = String(out || '').indexOf(FU_MARK);
  if (i < 0) return [];
  const m = out.slice(i + FU_MARK.length).match(/\[[\s\S]*\]/);
  if (!m) return [];
  try { const a = JSON.parse(m[0]); return Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.trim()).slice(0, 3) : []; } catch { return []; }
}

function mount(app, { db, auth, insights, messaging, owlTools, owlFields, anthropicKeyForEntity, currencyNote }) {
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
    CREATE TABLE IF NOT EXISTS owl_wa_suggest (
      msisdn TEXT PRIMARY KEY, items TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
    );
  `);
  const now = () => new Date().toISOString();
  const insMsg = sql.prepare('INSERT INTO owl_wa_msgs (id,msisdn,role,body,created_at) VALUES (?,?,?,?,?)');
  const histStmt = sql.prepare('SELECT role, body FROM owl_wa_msgs WHERE msisdn=? ORDER BY created_at DESC LIMIT 12');
  const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

  // Chart-image fallback hosting: when Clickatell's native media send isn't available,
  // we serve the rendered PNG from our own public URL and text the customer a link.
  // Kept in-memory with a short TTL (charts are ephemeral; a restart just drops them).
  const imgStore = new Map(); // id -> { png, title, exp }
  const IMG_TTL = 2 * 60 * 60 * 1000; // 2 hours
  let seenBase = ''; // the public host Clickatell hits us on (captured from the webhook)
  const publicBase = () => (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || seenBase || '').replace(/\/$/, '');
  const storeImg = (png, title = 'Chart') => { const id = crypto.randomUUID(); imgStore.set(id, { png, title, exp: Date.now() + IMG_TTL }); return id; };
  const getImg = (raw) => { const it = imgStore.get(String(raw || '').replace(/\.png$/, '')); return it && it.exp >= Date.now() ? it : null; };
  app.get('/api/whatsapp/img/:id', (req, res) => {
    const it = getImg(req.params.id);
    if (!it) return res.status(404).end();
    res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=7200').send(it.png);
  });
  // A tiny OpenGraph page so the WhatsApp link shows a chart-thumbnail preview card,
  // and tapping it opens the chart full-bleed in the browser.
  app.get('/api/whatsapp/chart/:id', (req, res) => {
    const it = getImg(req.params.id);
    if (!it) return res.status(404).send('This chart has expired.');
    const base = publicBase();
    const img = `${base}/api/whatsapp/img/${req.params.id}.png`;
    const t = String(it.title).replace(/[<>&"]/g, '');
    res.set('Content-Type', 'text/html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t}</title><meta property="og:type" content="website"><meta property="og:title" content="${t}"><meta property="og:image" content="${img}"><meta property="og:image:width" content="1320"><meta property="og:image:height" content="760"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${img}"></head><body style="margin:0;background:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh"><img src="${img}" alt="${t}" style="max-width:100%;height:auto"></body></html>`);
  });

  // Lightweight observability: record every meaningful step a webhook hit goes through,
  // so the admin panel can SHOW whether Clickatell is delivering + where the flow stops.
  const insEvent = sql.prepare('INSERT INTO owl_wa_events (id,msisdn,stage,detail,created_at) VALUES (?,?,?,?,?)');
  const logEvent = (msisdn, stage, detail) => { try { insEvent.run(crypto.randomUUID(), msisdn || '', stage, String(detail || '').slice(0, 800), now()); } catch { /* ignore */ } };

  // Last follow-up suggestions per number, so a bare "1"/"2"/"3" reply (the numbered
  // fallback when interactive buttons aren't available) maps back to its question.
  const upSuggest = sql.prepare('INSERT INTO owl_wa_suggest (msisdn,items,created_at) VALUES (?,?,?) ON CONFLICT(msisdn) DO UPDATE SET items=excluded.items, created_at=excluded.created_at');
  const getSuggest = sql.prepare('SELECT items FROM owl_wa_suggest WHERE msisdn=?');
  const saveSuggest = (msisdn, items) => { try { upSuggest.run(msisdn, JSON.stringify(items), now()); } catch { /* ignore */ } };
  const resolveSelection = (msisdn, text) => {
    const m = String(text || '').trim().match(/^([1-3])[.)]?$/);
    if (!m) return null;
    try { return JSON.parse(getSuggest.get(msisdn)?.items || '[]')[Number(m[1]) - 1] || null; } catch { return null; }
  };

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
    // Reporting currency for this organiser (blank for ZAR — the default).
    try { const cn = currencyNote && currencyNote(entityId || undefined); if (cn) parts.push(cn); } catch { /* ignore */ }
    parts.push(WA_OVERRIDE);
    return parts.join('\n\n');
  }

  // Friendly-label + dimension-type resolvers for chart axes, rebuilt per turn so admin
  // field renames apply without a restart (mirrors the web citation labels).
  function labelMaps() {
    const cat = owlTools.catalogue || {};
    const label = new Map();
    for (const m of (cat.measures || [])) label.set(m.name, m.label);
    for (const d of (cat.dimensions || [])) label.set(d.name, d.label);
    try { for (const f of (owlFields.list() || [])) if (f.label) label.set(f.name, f.label); } catch { /* ignore */ }
    const dimType = new Map((cat.dimensions || []).map((d) => [d.name, d.type]));
    return { label: (f) => label.get(f), dimType: (f) => dimType.get(f) || '', dateDim: cat.dateDimension };
  }

  // Render the answer's data to a chart PNG and send it (upload → image message).
  // Best-effort: any failure is logged and the text answer still stands.
  // Inline native images need Clickatell's media upload (POST /v1/media), which 404s
  // until they enable it on the integration. So default to the hosted link, and only
  // attempt the native upload when an admin flips this on (after Clickatell enables it).
  const mediaEnabled = () => db.getSetting('whatsapp_media_enabled', '') === '1';
  async function maybeSendChart(msisdn, trail) {
    try {
      const spec = chartImg.chartFromTrail(trail, labelMaps());
      if (!spec) { logEvent(msisdn, 'image-skip', 'nothing chartable in this answer'); return; }
      const png = chartImg.renderPng(spec);
      if (!png) { logEvent(msisdn, 'image-failed', 'render produced no PNG'); return; }
      // Native inline image (only when enabled) — best UX once Clickatell provisions media.
      if (mediaEnabled()) {
        const up = await messaging.uploadWhatsappMedia(png, 'image/png');
        if (up.ok) {
          const im = await messaging.sendWhatsappImage({ to: msisdn, fileId: up.fileId, caption: spec.title });
          if (im.ok) { logEvent(msisdn, 'image-sent', spec.title); return; }
        }
        logEvent(msisdn, 'image-failed', `native: ${up.error || up.reason || 'send error'} — falling back to link`);
      }
      // Fallback (the default): a link to the hosted OpenGraph chart page.
      const base = publicBase();
      if (!base) { logEvent(msisdn, 'image-failed', 'no public base URL to host the chart'); return; }
      const url = `${base}/api/whatsapp/chart/${storeImg(png, spec.title)}`;
      const r = await messaging.sendWhatsapp({ to: msisdn, text: `📈 View chart — ${spec.title}:\n${url}` });
      logEvent(msisdn, r && r.ok ? 'image-link' : 'image-failed', r && r.ok ? spec.title : (r && r.error) || 'link send error');
    } catch (e) { logEvent(msisdn, 'image-failed', (e && e.message) || 'chart error'); }
  }

  // Offer follow-ups as native WhatsApp reply buttons; if Clickatell rejects them
  // (interactive not enabled on this number), fall back to a numbered text list.
  async function sendFollowups(msisdn, followups) {
    const items = followups.slice(0, 3);
    if (!items.length) return;
    saveSuggest(msisdn, items);
    const btn = await messaging.sendWhatsappButtons({ to: msisdn, body: 'Want to dig deeper?', buttons: items.map((q) => ({ title: q, postbackData: q })) });
    if (btn.ok) { logEvent(msisdn, 'followups-buttons', items.join(' | ')); return; }
    const numbered = `Want to dig deeper? Reply with a number:\n${items.map((q, i) => `${i + 1}. ${q}`).join('\n')}`;
    await messaging.sendWhatsapp({ to: msisdn, text: numbered });
    logEvent(msisdn, 'followups-text', `buttons unavailable (${btn.error || btn.reason || '?'}) — sent numbered`);
  }

  async function handleInbound(msisdn, rawText) {
    const id = identify(msisdn);
    if (!id) { logEvent(msisdn, 'no-account', 'number not linked to any Pulse user'); await messaging.sendWhatsapp({ to: msisdn, text: 'Hi! This number isn\'t linked to a Howler account yet. Ask your Howler contact to connect it, then I can answer questions about your event data.' }); return; }
    logEvent(msisdn, 'identified', `${id.user.email || '?'} → ${id.entityId || '(no client)'}`);
    const apiKey = anthropicKeyForEntity ? anthropicKeyForEntity(id.entityId || undefined) : undefined;
    if (!insights.isConfigured(apiKey)) { logEvent(msisdn, 'no-ai-key', 'Anthropic key not configured'); await messaging.sendWhatsapp({ to: msisdn, text: 'The Owl isn\'t available right now — please try again shortly.' }); return; }
    // Immediate "the Owl is on it" acknowledgement so the customer isn't left staring at
    // a silent chat while the model + Looker run (a real WhatsApp "typing…" bubble needs
    // Clickatell to expose Meta's typing API). Fire-and-forget so it never delays the
    // actual answer; it lands first because it's sent seconds before the reply.
    messaging.sendWhatsapp({ to: msisdn, text: '🦉💭 One sec — looking into that…' }).catch(() => {});
    // A bare "1"/"2"/"3" reply selects a prior follow-up (the numbered fallback); a tapped
    // button already arrives as the full question text via postbackData.
    const text = resolveSelection(msisdn, rawText) || rawText;
    insMsg.run(crypto.randomUUID(), msisdn, 'user', text, now());
    const history = histStmt.all(msisdn).reverse().map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.body }));
    // histStmt already includes the just-inserted user message at the end.
    const instructions = instructionsFor(id.entityId);
    let out = ''; let trail = [];
    try {
      const r = await runOwlLoop({
        llmTurn: ({ messages: m, tools, onText }) => owlTurn(insights, { messages: m, tools, instructions, apiKey, onText }),
        toolMap, tools: toolSchemas, messages: history,
        ctx: { user: id.user, entityId: id.entityId },
      });
      out = r.text; trail = r.trail || [];
    } catch { out = ''; }
    const answer = String(out || '').split(FU_MARK)[0].replace(/\s+$/, '').trim() || 'Sorry — I couldn\'t answer that just now. Try rephrasing?';
    const followups = parseFollowups(out);
    insMsg.run(crypto.randomUUID(), msisdn, 'owl', answer, now());
    const sent = await messaging.sendWhatsapp({ to: msisdn, text: answer });
    logEvent(msisdn, sent && sent.ok ? 'replied' : 'send-failed', sent && sent.ok ? answer.slice(0, 120) : (sent && sent.error) || 'send error');
    if (chartImg.wantsChart(text)) await maybeSendChart(msisdn, trail);
    await sendFollowups(msisdn, followups);
  }

  // Pull the sender + text out of Clickatell's inbound (MO) payload, defensively.
  // First the known flat/nested shapes; if those miss, fall back to a generic scan that
  // walks the whole object for a phone-like sender + a message body — so we cope with
  // whatever field names Clickatell's WhatsApp MO actually uses.
  function parseInbound(body) {
    body = body || {};
    const ev = body.event || body;
    const m = (Array.isArray(body.messages) ? body.messages[0] : (Array.isArray(ev.messages) ? ev.messages[0] : ev)) || {};
    let from = m.from || m.fromNumber || m.sender || m.source || m.msisdn || body.from || '';
    let text = '';
    // A tapped reply button: the postbackData we set = the follow-up question itself.
    const btn = ev.moButtonResponse || body.moButtonResponse || m.moButtonResponse;
    if (Array.isArray(btn) && btn[0]) {
      const b = btn[0];
      text = b.postbackData || b.selectedItem?.postbackData || b.title || b.selectedItem?.title || '';
      from = from || b.from || b.fromNumber || b.mobileNumber || b.msisdn || '';
    }
    if (text) { /* button reply resolved above */ }
    else if (typeof m.content === 'string') text = m.content;
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
    if (!seenBase && req.get('host')) seenBase = `https://${req.get('host')}`; // public URL for hosted chart images
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
      mediaEnabled: db.getSetting('whatsapp_media_enabled', '') === '1',
      numbers: Object.entries(allowlist()).map(([msisdn, v]) => ({ msisdn, email: v.email || '', entityId: v.entityId || '' })),
    });
  });
  app.put('/api/admin/owl-whatsapp', auth.requireAdmin, (req, res) => {
    const b = req.body || {};
    if (b.from !== undefined) db.setSetting('whatsapp_from', String(b.from || '').trim());
    if (b.apiKey) db.setSetting('whatsapp_api_key', String(b.apiKey).trim()); // write-only; reuses SMS key if blank
    if (b.secret !== undefined) db.setSetting('whatsapp_webhook_secret', String(b.secret || '').trim());
    if (b.mediaEnabled !== undefined) db.setSetting('whatsapp_media_enabled', b.mediaEnabled ? '1' : '');
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
