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
const { runOwlLoop, owlTurn, personaOf } = require('./owlChat'); // owlTurn already layers OWL_CHAT_SYSTEM

// WhatsApp-tuned depth layers (the web Analyst/Operator briefs mention Markdown tables,
// which we forbid on WhatsApp — so these say the same thing in chat-friendly terms).
const WA_DEEP_LAYER = 'DEEPER READ: pull a couple of supporting cuts (the trend, a key breakdown, a comparison to a prior period or event), then give the answer + what\'s driving it + one recommended next step. Stay plain WhatsApp text — a few short lines, no tables, no walls of text.';
const WA_OPERATOR_LAYER = `${WA_DEEP_LAYER}\nTHEN be proactive: draft the single most valuable next action it implies (an alert, a segment, or a campaign) for the user to confirm — say why in one line, then draft it. Nothing is created until they tap Confirm; you never send to customers.`;
// Map a persona key → the WhatsApp depth layer to append (Quick adds nothing).
const WA_LAYER = { analyst: WA_DEEP_LAYER, operator: WA_OPERATOR_LAYER };

// Detect a depth/action escalation from the customer's message → persona key (or 'quick').
// "go deeper" works even on its own because the conversation history already holds the
// prior question, so the layer re-analyses that topic.
function detectWaPersona(text) {
  const t = String(text || '').trim().toLowerCase();
  if (/\b(what should i do|what'?s? the (best )?move|what next|recommend|best action|take action|suggest (an )?action)\b/.test(t)) return 'operator';
  if (/\b(go deeper|dig deeper|deeper|deep dive|more detail|full analysis|analyse|analyze|break this down)\b/.test(t)) return 'analyst';
  return 'quick';
}
const { resolveGuidance } = require('./owlGuidance');
const { actionViewUrl } = require('./owlActionLinks'); // deep-link a created action
const chartImg = require('./owlChartImg');

const WA_OVERRIDE = [
  'OVERRIDE — this conversation is over WhatsApp: reply in SHORT, plain text. No markdown tables. Use *single asterisks* for light emphasis. Lead with the answer in words. Express monetary amounts in the organiser\'s reporting currency (a Currency line below states it when it isn\'t South African Rand).',
  'There is no dashboard screen or chart-type toggle here — never tell the user to switch chart types or refer to on-screen panels (they are on WhatsApp). (Action confirmations are the one exception: those DO send a tappable button — see below.)',
  'Say NOTHING about chart delivery: never announce, point at, apologise for, or promise a chart/image — no "here\'s a chart", no 👇/👆, no "a fresh chart is on its way", no "re-sent". A chart link/image is attached automatically when useful; just answer with the figures in words.',
  'When the user wants to SEE data as a chart / line graph / bar chart / trend — EVEN data you just gave them — you MUST re-run it as ONE grouped askData query (a dimension such as day/month/event plus the measure) so a fresh chart image can be attached. Never reply "it\'s the same data" or refuse to re-pull, and never split a trend into many separate per-day lookups.',
  'You CAN set up an alert (createAlert), save a segment (createSegment), draft an email/SMS campaign (draftCampaign), or remember a durable client fact (rememberFact) over WhatsApp. When you draft one, briefly state what it will do — for a campaign give the audience size/reach + the subject line — then STOP. A Confirm button is attached automatically for the user to tap (and for an alert with several possible events, event-choice buttons). Do NOT invent your own button text, numbered steps, or say "tap … below"; just describe the draft. A drafted campaign is a DRAFT only — never sent from here; the user reviews, approves and sends it in the Pulse app (Engage). Never say anything is sent or scheduled.',
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

function mount(app, { db, auth, insights, messaging, getOwlTools, owlFields, anthropicKeyForEntity, currencyNote, languageNote, whatsappDigestFor, getAlertsApi, getSegmentsApi, getActionsApi, memoryApi, getStaffInbound = null }) {
  const owlMemory = require('./owlMemory'); // memoryNote + rememberFact tool (durable client memory)
  const sql = db.db;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS owl_wa_msgs (
      id TEXT PRIMARY KEY, msisdn TEXT NOT NULL, role TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '', entity_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
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
    CREATE TABLE IF NOT EXISTS owl_wa_sent (
      msisdn TEXT NOT NULL, day TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (msisdn, day)
    );
    CREATE TABLE IF NOT EXISTS owl_wa_pending (
      msisdn TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  // Migration for DBs created before history was segmented by client (entity_id).
  try { sql.exec("ALTER TABLE owl_wa_msgs ADD COLUMN entity_id TEXT NOT NULL DEFAULT ''"); } catch { /* already present */ }
  const now = () => new Date().toISOString();
  const insMsg = sql.prepare('INSERT INTO owl_wa_msgs (id,msisdn,role,body,entity_id,created_at) VALUES (?,?,?,?,?,?)');
  // History is scoped to the CURRENT linked client: if a number's client changes, the
  // previous client's messages aren't replayed — so the Owl can't echo the old client's
  // name (the data was already correctly scoped; this stops the stale label bleeding in).
  const histStmt = sql.prepare('SELECT role, body FROM owl_wa_msgs WHERE msisdn=? AND entity_id=? ORDER BY created_at DESC LIMIT 12');
  const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

  // Chart-image fallback hosting: when Clickatell's native media send isn't available,
  // we serve the rendered PNG from our own public URL and text the customer a link.
  // Kept in-memory with a short TTL (charts are ephemeral; a restart just drops them).
  const imgStore = new Map(); // id -> { png, title, exp }
  const IMG_TTL = 2 * 60 * 60 * 1000; // 2 hours
  const IMG_MAX = 50; // raw PNG buffers — expired ones must be DELETED, not just ignored, or they pile up until OOM
  let seenBase = ''; // the public host Clickatell hits us on (captured from the webhook)
  const publicBase = () => (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || seenBase || '').replace(/\/$/, '');
  const storeImg = (png, title = 'Chart') => {
    const id = crypto.randomUUID();
    const now = Date.now();
    for (const [k, v] of imgStore) if (v.exp < now) imgStore.delete(k);
    imgStore.set(id, { png, title, exp: now + IMG_TTL });
    while (imgStore.size > IMG_MAX) imgStore.delete(imgStore.keys().next().value);
    return id;
  };
  const getImg = (raw) => { const id = String(raw || '').replace(/\.png$/, ''); const it = imgStore.get(id); if (it && it.exp < Date.now()) { imgStore.delete(id); return null; } return it || null; };
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
    const m = String(text || '').trim().match(/^([1-9])[.)]?$/);
    if (!m) return null;
    try { return JSON.parse(getSuggest.get(msisdn)?.items || '[]')[Number(m[1]) - 1] || null; } catch { return null; }
  };

  // ── Prompt starters (the WhatsApp take on Meta AI's suggestion chips) ─────────
  // WhatsApp can't show Meta AI's pre-chat suggestion chips (Meta-proprietary), so
  // the equivalent is a friendly WELCOME the Owl sends on a greeting / "menu" /
  // "help": a short intro + tappable starter buttons (WhatsApp caps buttons at 3 ×
  // 20 chars) plus a numbered menu in the body for the rest. Each starter's FULL
  // question rides the button's postbackData (a tap sends it) and is saved so a
  // typed number works too. Admin-overridable via the owl_whatsapp_starters setting.
  const DEFAULT_STARTERS = [
    { label: 'Sales today',      prompt: 'How are ticket sales going today?' },
    { label: 'Sales by hour',    prompt: 'Show me ticket sales by hour today' },
    { label: 'Goal tracking',    prompt: 'How are my goals tracking?' },
    { label: 'Top ticket types', prompt: 'What are my top-selling ticket types?' },
    { label: 'Set an alert',     prompt: 'Alert me when ticket sales reach a milestone' },
    { label: 'Draft a campaign', prompt: 'Draft a campaign to a customer segment' },
  ];
  const starters = () => {
    try {
      const j = JSON.parse(db.getSetting('owl_whatsapp_starters', '') || '[]');
      if (Array.isArray(j) && j.length) return j.filter((s) => s && s.prompt).map((s) => ({ label: String(s.label || s.prompt).slice(0, 20), prompt: String(s.prompt).slice(0, 256) })).slice(0, 9);
    } catch { /* fall through to defaults */ }
    return DEFAULT_STARTERS;
  };
  // Bare greeting / menu / help (full-string match on the de-punctuated text), so
  // "help" opens the menu but "help me draft a campaign" still reaches the Owl.
  const GREETING_RE = /^(hi+|hello+|hey+|heya|hiya|yo|howzit|sawubona|menu|help|start|options|commands|hi there|good (morning|afternoon|evening|day)|morning|afternoon|evening|get started|start over|what can (you|u) do)$/;
  const isGreeting = (t) => { const s = String(t || '').replace(/[^a-z ]/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase(); return !!s && GREETING_RE.test(s); };

  // ── Pending action confirmation ─────────────────────────────────────────────
  // An act-tool (createAlert/createSegment) only DRAFTS; we stash the draft here, send
  // the customer a Confirm button, and commit it when they tap (button postbackData
  // comes back as the message text). Expires after an hour so a stale tap can't fire.
  const upPending = sql.prepare('INSERT INTO owl_wa_pending (msisdn,payload,created_at) VALUES (?,?,?) ON CONFLICT(msisdn) DO UPDATE SET payload=excluded.payload, created_at=excluded.created_at');
  const getPendingRow = sql.prepare('SELECT payload, created_at FROM owl_wa_pending WHERE msisdn=?');
  const delPending = sql.prepare('DELETE FROM owl_wa_pending WHERE msisdn=?');
  const storePending = (msisdn, p) => { try { upPending.run(msisdn, JSON.stringify(p), now()); } catch { /* ignore */ } };
  const clearPending = (msisdn) => { try { delPending.run(msisdn); } catch { /* ignore */ } };
  const getPending = (msisdn) => {
    const r = getPendingRow.get(msisdn);
    if (!r || (Date.now() - Date.parse(r.created_at)) > 60 * 60 * 1000) return null;
    try { return JSON.parse(r.payload); } catch { return null; }
  };

  // All act-tools (createAlert, createSegment, draftCampaign) are confirmed over WhatsApp
  // with a reply button (see the action flow below). draftCampaign only creates a DRAFT —
  // it never sends — so confirming it on WhatsApp is safe (a human still sends in Engage).
  // Resolved per turn so an admin's catalogue edits take effect without a restart.
  // Extra-explore tools (exploreKey) are dropped when that explore is OFF for this client.
  const owlCatalogueAccess = require('./owlCatalogue');
  const currentTools = (entityId) => {
    const entries = [...Object.values(getOwlTools()).filter((t) => t && t.schema && t.run), owlMemory.tool]
      .filter((t) => !t.exploreKey || owlCatalogueAccess.exploreEnabledFor(db, t.exploreKey, entityId));
    return { toolMap: Object.fromEntries(entries.map((t) => [t.schema.name, t])), toolSchemas: entries.map((t) => t.schema) };
  };
  const norm = (n) => messaging.normaliseMsisdn(n);

  const allowlist = () => J(db.getSetting('owl_whatsapp_numbers', '') || '{}', {});

  // ── Scheduled "in-window" updates ───────────────────────────────────────────
  // WhatsApp lets us send FREE-FORM (no template) only inside the 24h window that
  // opens when the customer last messaged us. So a scheduled digest/goals/alerts
  // push only goes out to numbers whose last inbound is < 24h old. We already log
  // every inbound, so the window is just the latest 'user' row's age.
  const lastInStmt = sql.prepare("SELECT MAX(created_at) AS c FROM owl_wa_msgs WHERE msisdn=? AND role='user'");
  const inWindow = (msisdn) => { const c = lastInStmt.get(msisdn)?.c; return !!c && (Date.now() - Date.parse(c)) < 24 * 60 * 60 * 1000; };
  const sentGet = sql.prepare('SELECT 1 FROM owl_wa_sent WHERE msisdn=? AND day=?');
  const sentMark = sql.prepare('INSERT OR IGNORE INTO owl_wa_sent (msisdn, day, at) VALUES (?,?,?)');

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
    // 🚩 waowl feature flag: OFF for this client = the WhatsApp Owl doesn't engage
    // (the sender falls into the existing unregistered-number path).
    if (entityId && !require('./flags').enabled(entityId, 'waowl')) return { user: null, entityId: '' };
    return { user, entityId };
  }

  // An authorised "author" to GENERATE a client's broadcast update under — broadcast
  // recipients needn't be Pulse users, but the scoped Owl loop still needs a user whose
  // access includes this client. Prefer an actual member of the entity, else any admin.
  // (The content is built once under this identity, then mirrored to the list — like an
  // email digest whose recipients don't each need an account.)
  function userForEntity(entityId) {
    if (!entityId) return null;
    const users = db.listUsers ? (db.listUsers() || []) : [];
    return users.find((u) => (u.entityIds || []).includes(entityId)) || users.find((u) => u.role === 'admin') || null;
  }

  // Build the per-turn instructions (scope, date, the live field dictionary, guidance,
  // and the WhatsApp plain-text override). Mirrors the web route, trimmed for WhatsApp.
  function instructionsFor(entityId, userId) {
    const nowSa = new Date(Date.now() + 2 * 60 * 60 * 1000); // SAST (UTC+2) — Howler's local day/hour
    const today = nowSa.toISOString().slice(0, 10);
    const hourSa = nowSa.getUTCHours();
    const ent = entityId && db.getEntity ? db.getEntity(entityId) : null;
    const parts = [`Today's date is ${today} and the current time is about ${String(hourSa).padStart(2, '0')}:00 (SAST, UTC+2). For a "today so far vs yesterday (to the same time)" comparison, use ${hourSa} as the cut-off hour (filter Purchased Hour of Day to "0 to ${hourSa}") so both days are trimmed to the same window.`];
    if (ent) parts.push(`All data in this conversation is scoped to: ${ent.name}. The ONLY client here is "${ent.name}" — when naming the client/entity, always say "${ent.name}" and NEVER any other client name, even if a different name appears earlier in this chat (that was a previous scope). Lead your answer with "For ${ent.name}:" and never imply the figures cover other clients.`);
    let fmeta = []; try { fmeta = owlFields.list(); } catch { /* ignore */ }
    if (fmeta.length) {
      parts.push(`Field guide (name = meaning): ${fmeta.map((f) => `${f.name} = ${f.label}${(f.aka || []).length ? ` (aka: ${f.aka.join(', ')})` : ''}`).join('; ')}.`);
      const qs = fmeta.filter((f) => (f.questions || []).length).map((f) => `${f.label} → ${f.questions.join(' / ')}`);
      if (qs.length) parts.push(`Typical questions by field: ${qs.join(' | ')}.`);
    }
    const cat = getOwlTools().catalogue || {};
    if ((cat.notes || []).length) parts.push(`Rules:\n- ${cat.notes.join('\n- ')}`);
    try { const g = resolveGuidance(db, entityId); if (g) parts.push(g); } catch { /* ignore */ }
    // Durable client memory (facts confirmed over time) — same source as the web Owl.
    try { const mem = owlMemory.memoryNote(db, entityId, '', userId); if (mem) parts.push(mem); } catch { /* ignore */ }
    // Reporting currency for this organiser (blank for ZAR — the default).
    try { const cn = currencyNote && currencyNote(entityId || undefined); if (cn) parts.push(cn); } catch { /* ignore */ }
    // AI content language for this organiser (blank for English — the default).
    try { const ln = languageNote && languageNote(entityId || undefined); if (ln) parts.push(ln); } catch { /* ignore */ }
    parts.push(WA_OVERRIDE);
    return parts.join('\n\n');
  }

  // Friendly-label + dimension-type resolvers for chart axes, rebuilt per turn so admin
  // field renames apply without a restart (mirrors the web citation labels).
  function labelMaps() {
    const cat = getOwlTools().catalogue || {};
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

  // Greeting/menu → a welcome with starter prompts. Sends the top 3 as tappable
  // buttons (WhatsApp's cap) with the full set as a numbered menu in the body, and
  // saves them so a typed number resolves to its question (the no-buttons fallback).
  async function sendWelcome(msisdn, id) {
    const ent = id.entityId && db.getEntity ? db.getEntity(id.entityId) : null;
    const who = ent && ent.name ? ` for *${ent.name}*` : '';
    const list = starters();
    const menu = list.map((s, i) => `${i + 1}. ${s.prompt}`).join('\n');
    const body = `🦉 Hi! I'm the Howler Owl — your data assistant${who}. Ask me about your ticket sales, goals, alerts and campaigns. Try one of these:\n\n${menu}\n\nOr just type your question — e.g. "revenue this week vs last".`;
    saveSuggest(msisdn, list.map((s) => s.prompt)); // typed-number fallback maps to the question
    const r = await messaging.sendWhatsappButtons({ to: msisdn, body, buttons: list.slice(0, 3).map((s) => ({ title: s.label, postbackData: s.prompt })) });
    if (!r.ok) await messaging.sendWhatsapp({ to: msisdn, text: body });
    logEvent(msisdn, 'welcome', r.ok ? 'buttons + menu' : 'menu (buttons unavailable)');
  }

  // ── Action confirmation (alerts + segments over WhatsApp) ────────────────────
  // The first drafted action in the loop's trail (an act-tool returns confirm+action).
  const actionFromTrail = (trail) => ((trail || []).map((t) => t && t.result).find((r) => r && r.confirm && r.action) || {}).action || null;

  // Offer the drafted action: a Confirm button, or — for an alert that could watch
  // several events — event-choice buttons (picking one IS the confirm).
  async function offerAction(msisdn, id, act) {
    // Store the whole action (campaigns carry subject/body/audience/etc. — not just a draft).
    storePending(msisdn, { ...act, suiteId: act.suiteId || '', entityId: act.entityId || id.entityId || '', name: act.name || (act.draft && act.draft.name) || '', summary: act.summary || '', events: (act.events || []).slice(0, 3) });
    if (act.kind === 'createAlert' && act.needsEvent && (act.events || []).length > 1) {
      const evs = act.events.slice(0, 3); // WhatsApp allows max 3 reply buttons
      const r = await messaging.sendWhatsappButtons({ to: msisdn, body: 'Which event should this alert watch?', buttons: evs.map((e) => ({ title: e.name, postbackData: `owlevt:${e.id}` })) });
      if (!r.ok) await messaging.sendWhatsapp({ to: msisdn, text: `Which event should this alert watch? Reply with a number:\n${evs.map((e, i) => `${i + 1}. ${e.name}`).join('\n')}` });
      logEvent(msisdn, 'action-draft', `alert — choose event${act.events.length > 3 ? ' (showing first 3)' : ''}`);
      return;
    }
    const r = await messaging.sendWhatsappButtons({ to: msisdn, body: `Confirm — ${act.summary}?`, buttons: [{ title: '✅ Confirm', postbackData: 'owlok' }, { title: '✖ Cancel', postbackData: 'owlno' }] });
    if (!r.ok) await messaging.sendWhatsapp({ to: msisdn, text: `Reply *YES* to confirm: ${act.summary} — or *NO* to cancel.` });
    logEvent(msisdn, 'action-draft', `${act.kind}: ${act.summary}`);
  }

  // A reply to a pending action: confirm / cancel / pick event / a bare yes-no-number.
  function isActionReply(t, msisdn) {
    const s = String(t || '').trim();
    if (/^(owlok|owlno)$/i.test(s) || /^owlevt:/i.test(s)) return true;
    const pend = getPending(msisdn);
    if (!pend) return false;
    if (/^(yes|y|confirm|no|n|cancel)$/i.test(s)) return true;
    // A bare number is an event pick ONLY when an alert is awaiting one.
    return /^[1-3]$/.test(s) && Array.isArray(pend.events) && pend.events.length > 0;
  }
  async function handleActionReply(msisdn, t, user) {
    const pend = getPending(msisdn);
    if (!pend) { await messaging.sendWhatsapp({ to: msisdn, text: 'That request has expired — just ask me to set it up again.' }); return; }
    const low = t.trim().toLowerCase();
    if (low === 'owlno' || low === 'no' || low === 'n' || low === 'cancel') { clearPending(msisdn); logEvent(msisdn, 'action-cancelled', pend.kind); await messaging.sendWhatsapp({ to: msisdn, text: 'Okay — cancelled. Nothing was created.' }); return; }
    let suiteId = pend.suiteId;
    if (low.startsWith('owlevt:')) suiteId = t.trim().slice(7);
    else if (/^[1-3]$/.test(low) && Array.isArray(pend.events)) suiteId = (pend.events[Number(low) - 1] || {}).id || suiteId; // numbered event fallback
    await commitPending(msisdn, pend, suiteId, user);
  }

  // Commit the pending action through the SAME APIs the web confirm uses (which
  // re-check permissions), so WhatsApp can never create something the user couldn't.
  async function commitPending(msisdn, pend, suiteId, user) {
    clearPending(msisdn);
    try {
      if (pend.kind === 'createAlert') {
        if (!suiteId) { await messaging.sendWhatsapp({ to: msisdn, text: 'I need to know which event — please ask again and pick one.' }); return; }
        if (user.role !== 'admin' && auth.canAccessSuite && !auth.canAccessSuite(user, suiteId)) { logEvent(msisdn, 'action-failed', 'no event access'); await messaging.sendWhatsapp({ to: msisdn, text: "You don't have access to that event." }); return; }
        const api = getAlertsApi && getAlertsApi();
        const r = api && api.createAlert ? api.createAlert({ suiteId, draft: pend.draft, user, via: 'whatsapp' }) : { ok: false, error: 'Alerts unavailable' };
        if (r.ok) { logEvent(msisdn, 'action-done', `alert ${r.alert.name}`); const link = actionViewUrl(publicBase(), 'createAlert'); await messaging.sendWhatsapp({ to: msisdn, text: `✅ Done — alert *${r.alert.name}* is on. I'll let you know when it triggers.${link ? `\nView it: ${link}` : ''}` }); }
        else { logEvent(msisdn, 'action-failed', r.error || 'error'); await messaging.sendWhatsapp({ to: msisdn, text: `I couldn't switch that alert on: ${r.error || 'something went wrong'}.` }); }
      } else if (pend.kind === 'createSegment') {
        const api = getSegmentsApi && getSegmentsApi();
        const r = api && api.createSegment ? api.createSegment({ entityId: pend.entityId, name: pend.name, definition: pend.draft, user, via: 'whatsapp' }) : { ok: false, error: 'Segments unavailable' };
        if (r.ok) { logEvent(msisdn, 'action-done', `segment ${r.segment.name}`); const link = actionViewUrl(publicBase(), 'createSegment'); await messaging.sendWhatsapp({ to: msisdn, text: `✅ Saved the segment *${r.segment.name}*. You can use it for a campaign in the Pulse app.${link ? `\nView it: ${link}` : ''}` }); }
        else { logEvent(msisdn, 'action-failed', r.error || 'error'); await messaging.sendWhatsapp({ to: msisdn, text: `I couldn't save that segment: ${r.error || 'something went wrong'}.` }); }
      } else if (pend.kind === 'draftCampaign') {
        // Mirror the web commit (/api/owl/act/draft-campaign): persist a chat cohort as a
        // reusable segment first, then create a DRAFT campaign (status 'draft' — never sent).
        let audience = pend.audience;
        const cat = getOwlTools().catalogue;
        if (audience && audience.mode === 'query') {
          if (cat && (audience.model !== cat.model || audience.view !== cat.explore)) { logEvent(msisdn, 'action-failed', 'audience off-catalogue'); await messaging.sendWhatsapp({ to: msisdn, text: 'I can only build that audience from your ticket data — set it up in the Pulse app.' }); return; }
          const segApi = getSegmentsApi && getSegmentsApi();
          if (segApi && segApi.createSegment) {
            const sr = segApi.createSegment({ entityId: pend.entityId, name: String(pend.name || 'Campaign audience').slice(0, 120), definition: audience, user, via: 'whatsapp' });
            if (sr.ok) audience = { mode: 'segment', segmentId: sr.segment.id };
          }
        }
        const config = {
          channel: ['email', 'sms', 'both'].includes(pend.channel) ? pend.channel : 'email',
          audience, subject: String(pend.subject || ''), body: String(pend.body || ''),
          ctaText: String(pend.ctaText || ''), ctaUrl: String(pend.ctaUrl || ''),
          goal: String(pend.goal || ''), eventSuiteId: String(pend.suiteId || ''), campaignMode: 'once',
          language: String(pend.language || '').slice(0, 5).toLowerCase(), // per-campaign AI language (blank → client default)
          // A designed email arrives as block content (theme + blocks); cleanConfig sanitises.
          contentMode: pend.contentMode === 'blocks' ? 'blocks' : 'template', blocks: Array.isArray(pend.blocks) ? pend.blocks : [], theme: pend.theme || {},
          customHtml: '', source: 'owl-whatsapp', // tag where it was drafted (for the Engage badge)
        };
        const api = getActionsApi && getActionsApi();
        const r = api && api.createDraftCampaign ? api.createDraftCampaign({ entityId: pend.entityId, title: pend.name, config, user, via: 'whatsapp' }) : { ok: false, error: 'Campaigns unavailable' };
        if (r.ok) { logEvent(msisdn, 'action-done', `campaign draft ${r.action.title}`); const link = actionViewUrl(publicBase(), 'draftCampaign'); await messaging.sendWhatsapp({ to: msisdn, text: `✅ Drafted the campaign *${r.action.title}*. It's a DRAFT — review, approve and send it in the Pulse app (Engage). I never send anything to customers.${link ? `\nReview it: ${link}` : ''}` }); }
        else { logEvent(msisdn, 'action-failed', r.error || 'error'); await messaging.sendWhatsapp({ to: msisdn, text: `I couldn't create that draft: ${r.error || 'something went wrong'}.` }); }
      } else if (pend.kind === 'rememberFact') {
        // User scope is always self-scoped to the identified person; client/event use the drafted target.
        const tgt = pend.memScope === 'user' ? user.id : (pend.targetId || pend.entityId);
        const item = memoryApi && memoryApi.add ? memoryApi.add(pend.memScope || 'client', tgt, pend.fact, user.email) : null;
        if (item) { logEvent(msisdn, 'action-done', `remember: ${String(pend.fact).slice(0, 80)}`); await messaging.sendWhatsapp({ to: msisdn, text: '✅ Got it — I\'ll remember that for next time.' }); }
        else { logEvent(msisdn, 'action-failed', 'memory save failed'); await messaging.sendWhatsapp({ to: msisdn, text: 'I couldn\'t save that to memory just now.' }); }
      } else { await messaging.sendWhatsapp({ to: msisdn, text: 'That action can only be completed in the Pulse app.' }); }
    } catch (e) { logEvent(msisdn, 'action-failed', (e && e.message) || 'commit error'); await messaging.sendWhatsapp({ to: msisdn, text: 'Something went wrong completing that — please try again.' }); }
  }

  async function handleInbound(msisdn, rawText) {
    // Staff-alerts intercept: a message from a known Event Ops staff number is
    // captured for ops and answered simply — it must NEVER reach the client
    // Owl. Fully guarded: any non-staff number (or an error) falls straight
    // through to the normal Owl flow below.
    const staffInbound = getStaffInbound && getStaffInbound();
    if (staffInbound) {
      try { if (await staffInbound(msisdn, rawText)) { logEvent(msisdn, 'staff-alert', 'captured (kept off the Owl)'); return; } }
      catch (e) { console.error('[owlWhatsapp] staffInbound failed', e && e.message); }
    }
    const id = identify(msisdn);
    if (!id) { logEvent(msisdn, 'no-account', 'number not linked to any Pulse user'); await messaging.sendWhatsapp({ to: msisdn, text: 'Hi! This number isn\'t linked to a Howler account yet. Ask your Howler contact to connect it, then I can answer questions about your event data.' }); return; }
    logEvent(msisdn, 'identified', `${id.user.email || '?'} → ${id.entityId || '(no client)'}`);
    // A tap on a Confirm / Cancel / event button (or a yes/no/number reply to a pending
    // action) commits or cancels the drafted alert/segment — handle it before the Owl runs.
    if (isActionReply(rawText, msisdn)) { await handleActionReply(msisdn, rawText, id.user); return; }
    // A bare greeting / "menu" / "help" opens the welcome + starter prompts (the
    // WhatsApp take on Meta AI's suggestion chips) — no model call needed.
    if (isGreeting(rawText)) {
      insMsg.run(crypto.randomUUID(), msisdn, 'user', rawText, id.entityId || '', now()); // keep the 24h window open + history
      await sendWelcome(msisdn, id);
      logEvent(msisdn, 'replied', 'welcome / starter prompts');
      return;
    }
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
    const eid = id.entityId || '';
    insMsg.run(crypto.randomUUID(), msisdn, 'user', text, eid, now());
    const history = histStmt.all(msisdn, eid).reverse().map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.body }));
    // histStmt already includes the just-inserted user message at the end.
    // Depth/action mode: "go deeper" → Analyst, "what should I do" → Operator (default Quick).
    const pkey = detectWaPersona(text);
    const persona = personaOf(pkey);
    const waLayer = WA_LAYER[pkey];
    if (pkey !== 'quick') logEvent(msisdn, 'mode', pkey);
    const uid = (id.user || {}).id || '';
    const instructions = waLayer ? `${instructionsFor(id.entityId, uid)}\n\n${waLayer}` : instructionsFor(id.entityId, uid);
    let out = ''; let trail = [];
    const { toolMap, toolSchemas } = currentTools(id.entityId);
    try {
      const r = await require('./aiUsage').run({ entityId: id.entityId, kind: 'whatsapp' }, () => runOwlLoop({
        llmTurn: ({ messages: m, tools, onText, signal }) => owlTurn(insights, { messages: m, tools, instructions, apiKey, onText, effort: persona.effort, maxTokens: persona.maxTokens, model: persona.model, signal }),
        toolMap, tools: toolSchemas, messages: history,
        ctx: { user: id.user, entityId: id.entityId },
        maxRounds: persona.maxRounds,
        turnTimeoutMs: persona.turnTimeoutMs, toolTimeoutMs: persona.toolTimeoutMs,
      }));
      out = r.text; trail = r.trail || [];
    } catch { out = ''; }
    const answer = String(out || '').split(FU_MARK)[0].replace(/\s+$/, '').trim() || 'Sorry — I couldn\'t answer that just now. Try rephrasing?';
    const followups = parseFollowups(out);
    insMsg.run(crypto.randomUUID(), msisdn, 'owl', answer, eid, now());
    const sent = await messaging.sendWhatsapp({ to: msisdn, text: answer });
    logEvent(msisdn, sent && sent.ok ? 'replied' : 'send-failed', sent && sent.ok ? answer.slice(0, 120) : (sent && sent.error) || 'send error');
    if (chartImg.wantsChart(text)) await maybeSendChart(msisdn, trail);
    // If the Owl drafted an alert/segment, send the Confirm (or event-choice) buttons —
    // that's the call to action this turn, so skip the follow-up suggestions.
    const act = actionFromTrail(trail);
    if (act) { await offerAction(msisdn, id, act); return; }
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

  // Pull the recipient + delivery status + failure reason out of a Clickatell status
  // (delivery notification) payload, defensively across its shapes.
  function parseStatus(body) {
    body = body || {};
    const ev = body.event || body;
    const m = (Array.isArray(body.statuses) ? body.statuses[0]
      : Array.isArray(ev.moStatus) ? ev.moStatus[0]
      : Array.isArray(ev.statuses) ? ev.statuses[0]
      : Array.isArray(body.messages) ? body.messages[0] : ev) || {};
    const to = m.to || m.toNumber || m.msisdn || m.destination || m.recipient || ev.to || '';
    const status = m.status || m.messageStatus || m.statusDescription || m.deliveryStatus || ev.status || '';
    const e = m.error || m.errorDescription || m.statusReason || m.reason || m.errorCode || '';
    const err = typeof e === 'string' ? e : [e && e.code, e && (e.description || e.message)].filter(Boolean).join(' ');
    return { to: String(to || ''), status: String(status || ''), err: String(err || '') };
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

  // Detect a NON-TEXT inbound (voice note, image, video, document, sticker) so we can
  // reply helpfully instead of dropping it silently. Walks the payload defensively for
  // a media TYPE value, a media MIME type, or a media-named object — Clickatell MO
  // shapes vary, so we don't rely on one field. Returns a kind string or ''.
  function detectMedia(root) {
    const KINDS = ['voice', 'audio', 'image', 'video', 'document', 'sticker'];
    const TYPE_KEY = /^(type|messagetype|message_type|contenttype|content_type)$/i;
    const MIME_KEY = /^(mime|mimetype|mime_type)$/i;
    let found = '';
    const seen = new Set();
    const walk = (node) => {
      if (found || !node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      for (const [k, v] of Object.entries(node)) {
        if (found) return;
        if (KINDS.includes(k.toLowerCase()) && v && typeof v === 'object') { found = k.toLowerCase(); return; }
        if (typeof v === 'string') {
          const vl = v.toLowerCase();
          if (TYPE_KEY.test(k) && KINDS.includes(vl)) { found = vl; return; }
          if (MIME_KEY.test(k)) { const hit = KINDS.find((x) => vl.startsWith(`${x}/`)); if (hit) { found = hit; return; } if (vl.startsWith('audio/')) { found = 'voice'; return; } }
        } else if (v && typeof v === 'object') { walk(v); }
      }
    };
    try { walk(root); } catch { /* ignore */ }
    return found === 'audio' ? 'voice' : found; // WhatsApp voice notes are PTT audio
  }

  // A non-text message arrived — the Owl can't process media yet (voice→text needs a
  // transcription provider + Clickatell inbound-media access). Reply so the customer
  // isn't ghosted, and keep the 24h window open. NB: silently dropping was the old bug.
  async function handleMedia(msisdn, kind) {
    const id = identify(msisdn);
    if (!id) { logEvent(msisdn, 'no-account', `media (${kind}) from unlinked number`); await messaging.sendWhatsapp({ to: msisdn, text: 'Hi! This number isn\'t linked to a Howler account yet. Ask your Howler contact to connect it, then I can answer questions about your event data.' }); return; }
    insMsg.run(crypto.randomUUID(), msisdn, 'user', `[${kind}]`, id.entityId || '', now()); // keep the 24h window open
    const what = kind === 'voice' ? 'listen to voice notes' : kind === 'image' ? 'read images' : kind === 'video' ? 'watch videos' : kind === 'document' ? 'open documents' : `handle ${kind}s`;
    await messaging.sendWhatsapp({ to: msisdn, text: `🦉 I can't ${what} yet — please *type* your question instead (or send *menu* to see what I can do).` });
    logEvent(msisdn, 'replied', `media fallback (${kind})`);
  }

  // Clickatell webhook. Ack immediately (200), process in the background so a slow LLM
  // turn never times the webhook out. Optional shared secret (?key= or x-webhook-secret).
  app.post('/api/whatsapp/inbound', (req, res) => {
    const secret = (db.getSetting('whatsapp_webhook_secret', '') || '').trim();
    // The sender is identified purely by the (spoofable) MSISDN, which then drives
    // a scoped Owl turn — so transport auth is MANDATORY, not optional. With no
    // secret configured the endpoint is closed (fail closed): set
    // whatsapp_webhook_secret and put ?key=<secret> on the Clickatell webhook URL.
    if (!secret) {
      logEvent('', 'rejected', 'inbound WhatsApp disabled — set whatsapp_webhook_secret to enable');
      return res.status(503).json({ error: 'not configured' });
    }
    if (req.query.key !== secret && req.get('x-webhook-secret') !== secret) {
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
      if (!msisdn || !text) {
        // A voice note / image / file (no text) — reply helpfully instead of dropping it.
        const media = msisdn ? detectMedia(req.body || {}) : '';
        if (media) { logEvent(msisdn, 'received', `[${media}] (no text)`); handleMedia(msisdn, media).catch((e) => { logEvent(msisdn, 'error', (e && e.message) || 'media handler error'); }); return; }
        logEvent(msisdn, 'unparsed', `couldn't read sender/text from payload: ${JSON.stringify(req.body).slice(0, 700)}`); return;
      }
      logEvent(msisdn, 'received', text.slice(0, 120));
      handleInbound(msisdn, text).catch((e) => { logEvent(msisdn, 'error', (e && e.message) || 'handler error'); console.error('[owlWhatsapp] handle failed', e && e.message); });
    } catch (e) { logEvent('', 'error', (e && e.message) || 'parse error'); console.error('[owlWhatsapp] inbound parse failed', e && e.message); }
  });

  // Clickatell DELIVERY NOTIFICATIONS (status callback). Tells us whether a message we
  // sent actually reached the handset — so 'replied' (Clickatell accepted) is no longer
  // the end of the story. Logs delivered / undelivered (+ the reason Clickatell gives).
  app.post('/api/whatsapp/status', (req, res) => {
    res.json({ ok: true });
    try {
      const { to, status, err } = parseStatus(req.body || {});
      const msisdn = norm(to);
      const s = String(status || '').toUpperCase();
      const stage = /FAIL|UNDELIV|REJECT|EXPIRE|ERROR|BLOCK/.test(s) ? 'undelivered' : (/DELIVER|READ|SENT_TO/.test(s) ? 'delivered' : 'status');
      const detail = `${status || '?'}${err ? ` — ${err}` : ''}`.trim() || JSON.stringify(req.body).slice(0, 300);
      logEvent(msisdn, stage, detail.slice(0, 300));
    } catch (e) { console.error('[owlWhatsapp] status parse failed', e && e.message); }
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
      statusPath: '/api/whatsapp/status',
      mediaEnabled: db.getSetting('whatsapp_media_enabled', '') === '1',
      pushEnabled: db.getSetting('whatsapp_push_enabled', '') === '1',
      testMessage: db.getSetting('whatsapp_test_message', '') || '',
      numbers: Object.entries(allowlist()).map(([msisdn, v]) => ({ msisdn, email: v.email || '', entityId: v.entityId || '', subs: Array.isArray(v.subs) ? v.subs : [], hour: Number.isInteger(v.hour) ? v.hour : 8 })),
      // Per-client broadcast lists: { entityId: { hour, subs[], numbers[] } } — a team of
      // plain numbers (no Pulse account needed) that all get the same daily update.
      broadcasts: J(db.getSetting('owl_whatsapp_broadcasts', '') || '{}', {}),
    });
  });
  app.put('/api/admin/owl-whatsapp', auth.requireAdmin, (req, res) => {
    const b = req.body || {};
    const TOPICS = ['digest', 'goals', 'alerts'];
    if (b.from !== undefined) db.setSetting('whatsapp_from', String(b.from || '').trim());
    if (b.apiKey) db.setSetting('whatsapp_api_key', String(b.apiKey).trim()); // write-only; reuses SMS key if blank
    if (b.secret !== undefined) db.setSetting('whatsapp_webhook_secret', String(b.secret || '').trim());
    if (b.mediaEnabled !== undefined) db.setSetting('whatsapp_media_enabled', b.mediaEnabled ? '1' : '');
    if (b.pushEnabled !== undefined) db.setSetting('whatsapp_push_enabled', b.pushEnabled ? '1' : '');
    if (b.testMessage !== undefined) db.setSetting('whatsapp_test_message', String(b.testMessage || '').slice(0, 1000));
    if (Array.isArray(b.numbers)) {
      const map = {};
      for (const n of b.numbers) {
        const m = norm(n.msisdn); if (!m || !n.email) continue;
        const subs = Array.isArray(n.subs) ? n.subs.filter((t) => TOPICS.includes(t)) : [];
        const hour = Number.isInteger(n.hour) ? Math.min(23, Math.max(0, n.hour)) : 8;
        map[m] = { email: String(n.email).trim(), entityId: String(n.entityId || '').trim(), subs, hour };
      }
      db.setSetting('owl_whatsapp_numbers', JSON.stringify(map));
    }
    // Per-client broadcast lists: validate hour, topics and numbers; drop empty lists.
    if (b.broadcasts && typeof b.broadcasts === 'object') {
      const out = {};
      for (const [entityId, cfg] of Object.entries(b.broadcasts)) {
        const eid = String(entityId || '').trim(); if (!eid || !cfg || typeof cfg !== 'object') continue;
        const subs = Array.isArray(cfg.subs) ? cfg.subs.filter((t) => TOPICS.includes(t)) : [];
        const hour = Number.isInteger(cfg.hour) ? Math.min(23, Math.max(0, cfg.hour)) : 8;
        const numbers = [...new Set((Array.isArray(cfg.numbers) ? cfg.numbers : []).map((x) => norm(x)).filter(Boolean))].slice(0, 100);
        if (!numbers.length && !subs.length) continue; // an empty list isn't worth storing
        out[eid] = { hour, subs, numbers };
      }
      db.setSetting('owl_whatsapp_broadcasts', JSON.stringify(out));
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

  // What each subscribable topic asks the Owl to include in the scheduled update.
  const TOPIC_ASK = {
    digest: 'a quick sales pulse — tickets sold and revenue so far today, and how that compares to yesterday',
    goals: 'the headline goal — lead with the North Star: its target, current value, and whether it is on pace or behind',
    alerts: 'any alerts that have triggered in the last 24 hours (if none, say all clear in a few words)',
  };
  const SCHED_NOTE = 'This is an automated SCHEDULED WhatsApp update the customer subscribed to (they are inside their 24h window). Open with a short friendly greeting line, then the update. Keep the whole thing tight — a few short lines. Do NOT append a <<<FOLLOWUPS>>> marker for this scheduled message.';
  const SCHED_NOTE_ADD = 'This is a short ADDENDUM beneath a scheduled update already shown above — do NOT greet again; just give these item(s) in a line or two. No <<<FOLLOWUPS>>> marker.';

  // Compose the scheduled update by running the SAME Owl loop (scoped to this user),
  // so the figures are live + grounded and honour the field guide + currency.
  async function buildScheduled(id, topics, greeting = true) {
    const apiKey = anthropicKeyForEntity ? anthropicKeyForEntity(id.entityId || undefined) : undefined;
    if (!insights.isConfigured(apiKey)) return '';
    const wants = topics.map((t) => TOPIC_ASK[t]).filter(Boolean);
    if (!wants.length) return '';
    const ask = `Please give me my scheduled update covering: ${wants.join('; ')}.`;
    const instructions = `${instructionsFor(id.entityId, (id.user || {}).id || '')}\n\n${greeting ? SCHED_NOTE : SCHED_NOTE_ADD}`;
    const { toolMap, toolSchemas } = currentTools(id.entityId);
    try {
      const { text } = await require('./aiUsage').run({ entityId: id.entityId, kind: 'whatsapp' }, () => runOwlLoop({
        llmTurn: ({ messages: m, tools, onText, signal }) => owlTurn(insights, { messages: m, tools, instructions, apiKey, onText, signal }),
        toolMap, tools: toolSchemas, messages: [{ role: 'user', content: ask }],
        ctx: { user: id.user, entityId: id.entityId },
      }));
      return String(text || '').split(FU_MARK)[0].replace(/\s+$/, '').trim();
    } catch { return ''; }
  }

  // The full message: use the customer's REAL configured digest for the 'digest' topic
  // when they have one (same source as their email digest), plus a lightweight Owl
  // summary for the rest — and for 'digest' itself when no digest is set up ("keep both").
  async function buildScheduledMessage(id, topics) {
    const parts = [];
    let owlTopics = topics;
    if (topics.includes('digest') && whatsappDigestFor) {
      let real = null;
      try { real = await whatsappDigestFor(id.entityId, id.user && id.user.email); } catch { real = null; }
      if (real) { parts.push(real); owlTopics = topics.filter((t) => t !== 'digest'); }
    }
    if (owlTopics.length) { const s = await buildScheduled(id, owlTopics, parts.length === 0); if (s) parts.push(s); }
    return parts.join('\n\n');
  }

  // Hourly tick: at/after each subscriber's send hour (SAST), once a day, if they're
  // inside their 24h window, send the update they chose. Master switch is off by default.
  let scheduling = false;
  async function schedTick() {
    if (db.getSetting('whatsapp_push_enabled', '') !== '1' || scheduling) return;
    scheduling = true;
    try {
      const sa = new Date(Date.now() + 2 * 60 * 60 * 1000); // SAST (UTC+2) — Howler's local day/hour
      const hour = sa.getUTCHours(); const day = sa.toISOString().slice(0, 10);
      for (const [msisdn, entry] of Object.entries(allowlist())) {
        const topics = Array.isArray(entry.subs) ? entry.subs.filter((t) => TOPIC_ASK[t]) : [];
        if (!topics.length) continue;
        if (hour < (Number.isInteger(entry.hour) ? entry.hour : 8)) continue; // not yet their hour today
        if (sentGet.get(msisdn, day)) continue; // already handled today
        sentMark.run(msisdn, day, now()); // evaluate once per day, in or out of window
        if (!inWindow(msisdn)) { logEvent(msisdn, 'push-skip', 'outside 24h window (needs a template) — no send'); continue; }
        const id = identify(msisdn); if (!id) continue;
        const msg = await buildScheduledMessage(id, topics);
        if (!msg) { logEvent(msisdn, 'push-failed', 'no content generated'); continue; }
        insMsg.run(crypto.randomUUID(), msisdn, 'owl', msg, id.entityId || '', now());
        const r = await messaging.sendWhatsapp({ to: msisdn, text: msg });
        logEvent(msisdn, r && r.ok ? 'push-sent' : 'push-failed', r && r.ok ? topics.join(', ') : (r && r.error) || 'send error');
      }
      await broadcastTick(hour, day);
    } catch (e) { console.error('[owlWhatsapp] sched tick failed', e && e.message); } finally { scheduling = false; }
  }

  // Broadcast lists: a per-client set of plain numbers (recipients needn't be Pulse
  // users) that all receive the SAME daily update. The message is built ONCE per client
  // per day (cached), then mirrored to each number that still needs it AND is inside its
  // 24h window — the same WhatsApp free-form rule the per-user push obeys. Numbers out of
  // window are left unsent so a later tick catches them once they message the Owl.
  const bcastCache = new Map(); // entityId -> { day, msg }
  async function broadcastTick(hour, day) {
    const all = J(db.getSetting('owl_whatsapp_broadcasts', '') || '{}', {});
    for (const [entityId, cfg] of Object.entries(all)) {
      const topics = Array.isArray(cfg.subs) ? cfg.subs.filter((t) => TOPIC_ASK[t]) : [];
      const numbers = [...new Set((Array.isArray(cfg.numbers) ? cfg.numbers : []).map(norm).filter(Boolean))];
      if (!topics.length || !numbers.length) continue;
      if (hour < (Number.isInteger(cfg.hour) ? cfg.hour : 8)) continue; // not yet this list's hour
      // Only recipients who still need today's update AND can be messaged free-form.
      const due = numbers.filter((m) => !sentGet.get(m, day) && inWindow(m));
      if (!due.length) continue;
      let cached = bcastCache.get(entityId);
      if (!cached || cached.day !== day) {
        const user = userForEntity(entityId);
        if (!user) { logEvent('', 'bcast-skip', `no author user with access to ${entityId}`); continue; }
        const msg = await buildScheduledMessage({ user, entityId }, topics);
        if (!msg) { logEvent('', 'bcast-failed', `no content generated for ${entityId}`); continue; }
        cached = { day, msg }; bcastCache.set(entityId, cached);
      }
      for (const m of due) {
        sentMark.run(m, day, now());
        insMsg.run(crypto.randomUUID(), m, 'owl', cached.msg, entityId, now());
        const r = await messaging.sendWhatsapp({ to: m, text: cached.msg });
        logEvent(m, r && r.ok ? 'push-sent' : 'push-failed', r && r.ok ? `broadcast: ${topics.join(', ')}` : (r && r.error) || 'send error');
      }
    }
  }
  const schedTimer = setInterval(() => schedTick().catch(() => {}), 30 * 60 * 1000); // every 30 min
  if (schedTimer.unref) schedTimer.unref();
  setTimeout(() => schedTick().catch(() => {}), 20000); // shortly after boot

  console.log('[owlWhatsapp] WhatsApp door mounted (POST /api/whatsapp/inbound)');
}

module.exports = { mount };
