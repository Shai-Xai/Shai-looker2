// ─── Slack outbound connector — disposable module ─────────────────────────────
// Mirrors a client's Pulse inbox notifications into their Slack. When Howler posts
// a message to a client (or an automation notifies them), the same nudge also drops
// into the client's connected Slack channel — so teams that live in Slack see it
// without opening Pulse. Follows the mailer.js / meta.js house style:
//   • write-only secrets (per client, in entity integrations — never returned)
//   • graceful no-op when unconfigured (send() returns { skipped }, never throws)
//   • one send chokepoint, every attempt logged to slack_messages
//
// Two ways to connect (per client, Admin → client → Integrations, or self-service):
//   slackWebhookUrl  — an Incoming Webhook for one channel (simplest; write-only)
//   slackBotToken (+ slackChannel) — a bot token (xoxb-…) that can post to a named
//                    channel; richer (Block Kit, any channel) and verifiable.
// A bot token + channel takes precedence over a webhook when both are set.
//
// This is OUTBOUND only. Inbound (replies from Slack landing back in the Pulse
// inbox) is a separate, larger piece — see docs and the os.js inbound webhook.

let db = null;
let mailer = null;
function init(deps) {
  db = deps.db;
  mailer = deps.mailer || null;
  // Audit trail of every attempt (sent / failed / skipped). Self-owned — drop this
  // file + the slack_messages table to fully uninstall.
  db.db.exec(`
    CREATE TABLE IF NOT EXISTS slack_messages (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id TEXT NOT NULL,
      status    TEXT NOT NULL,            -- sent | failed | skipped
      detail    TEXT NOT NULL DEFAULT '', -- destination on success, error on failure
      kind      TEXT NOT NULL DEFAULT 'other',
      at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_slack_messages_entity ON slack_messages(entity_id, at);
  `);
}

const mask = (s) => { const v = String(s || ''); return v ? `••••${v.slice(-4)}` : ''; };

function connection(entityId) {
  const i = (db && entityId) ? db.getEntityIntegrations(entityId) : {};
  return {
    webhookUrl: (i.slackWebhookUrl || '').trim(),
    botToken: (i.slackBotToken || '').trim(),
    channel: (i.slackChannel || '').trim(),
  };
}
function isConfigured(entityId) {
  const c = connection(entityId);
  return !!(c.webhookUrl || (c.botToken && c.channel));
}
function status(entityId) {
  const c = connection(entityId);
  return { configured: isConfigured(entityId), channel: c.channel, mode: (c.botToken && c.channel) ? 'bot' : 'webhook' };
}

// Best-effort audit line — never breaks a send.
function log(entityId, st, detail, kind) {
  try {
    db.db.prepare('INSERT INTO slack_messages (entity_id, status, detail, kind, at) VALUES (?,?,?,?,?)')
      .run(entityId, st, String(detail || ''), kind || 'other', new Date().toISOString());
  } catch { /* logging must never break a send */ }
}

// Low-level post. Prefers a bot token (richer, lets us target a named channel);
// falls back to the incoming webhook. Best-effort — returns a result, never throws.
async function send({ entityId, text, blocks, username, iconUrl, kind = 'other' }) {
  const c = connection(entityId);
  if (process.env.OUTBOUND_DISABLED === '1') { log(entityId, 'skipped', 'outbound disabled (staging)', kind); return { skipped: true, reason: 'outbound_disabled' }; }
  if (!isConfigured(entityId)) { log(entityId, 'skipped', 'not configured', kind); return { skipped: true, reason: 'not_configured' }; }
  const useBot = !!(c.botToken && c.channel);
  try {
    if (useBot) {
      // username/icon_url need the chat:write.customize scope, so we don't set
      // them here — a bot posts under the app's own name/icon (set in Slack).
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.botToken}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel: c.channel, text, blocks }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) throw new Error(data.error || `Slack HTTP ${res.status}`);
    } else {
      // Incoming webhooks DO honour a per-message name + avatar, so we brand them
      // with the client's sender name + logo when we have a public (https) logo.
      const payload = { text, blocks };
      if (username) payload.username = username;
      if (iconUrl) payload.icon_url = iconUrl;
      const res = await fetch(c.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
    }
    log(entityId, 'sent', useBot ? c.channel : 'webhook', kind);
    return { ok: true };
  } catch (e) {
    log(entityId, 'failed', e.message, kind);
    return { ok: false, error: e.message };
  }
}

// Higher-level: a titled notification with an optional "Open in Pulse" button.
// Builds Block Kit but always carries a plain-text fallback for notifications.
async function notify({ entityId, title, body, url, username, iconUrl, kind = 'notification' }) {
  const heading = String(title || 'New message in Pulse').trim();
  // A mrkdwn LINK, not a Block Kit button — buttons are interactive and need an
  // app with an interactivity URL (webhooks can't post them; Slack warns). A link
  // opens Pulse with no interaction payload, so it works on every connection type.
  const link = url ? `\n<${url}|Open in Pulse →>` : '';
  const text = `${heading}${body ? `\n${body}` : ''}${url ? `\nOpen in Pulse: ${url}` : ''}`;
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: `*${heading}*${body ? `\n${body}` : ''}${link}` } }];
  return send({ entityId, text, blocks, username, iconUrl, kind });
}

// Per-message brand (name + logo) from the client's branding, for webhook posts.
function brandingFor(entityId) {
  const b = (mailer && mailer.resolveBranding) ? (mailer.resolveBranding(entityId) || {}) : {};
  return { username: b.senderName || undefined, iconUrl: (b.logo && /^https?:\/\//.test(b.logo)) ? b.logo : undefined };
}

// ── manual "Share to Slack" (direct post to a user's connected channel) ──
// A user shares an insight/tile straight into their own client's connected Slack,
// rather than copy-pasting. Resolves the user's own entities — no entity id from
// the browser — and posts to each one that has Slack connected (usually one).
function shareStatusForUser(user) {
  const ids = (user.entityIds || []).filter((id) => isConfigured(id));
  if (!ids.length) return { connected: false };
  const label = ids.length === 1 ? (connection(ids[0]).channel || 'your Slack channel') : `${ids.length} Slack channels`;
  return { connected: true, label, count: ids.length };
}
async function shareForUser(user, { heading, text, url, note } = {}) {
  const ids = (user.entityIds || []).filter((id) => isConfigured(id));
  if (!ids.length) return { ok: false, connected: false, error: 'No connected Slack for your account.' };
  const body = [String(note || '').trim(), String(text || '').trim()].filter(Boolean).join('\n\n');
  let sent = 0;
  for (const id of ids) {
    const r = await notify({ entityId: id, title: heading || 'Shared from Pulse', body, url, kind: 'share', ...brandingFor(id) });
    if (r.ok) sent += 1;
  }
  return { ok: sent > 0, sent };
}

// Post a friendly test message — lets staff/clients confirm the wiring without
// sending a real inbox message. Best-effort; never throws.
async function sendTest(entityId) {
  if (!isConfigured(entityId)) return { ok: false, error: 'Slack isn’t connected for this client yet — add a webhook or bot token first.' };
  const r = await notify({
    entityId,
    title: '✅ Pulse is connected to Slack',
    body: 'This is a test from Howler Pulse. If you can see this, your Slack notifications are working — Howler messages will land here.',
    kind: 'test',
  });
  return r.ok ? { ok: true, ...status(entityId) } : { ok: false, error: r.error || 'Slack did not accept the message.' };
}

// Live connection check (real API call for bot tokens). Best-effort; never throws.
// status: ok | not_configured | token_invalid | webhook | error.
async function verify(entityId) {
  const checkedAt = new Date().toISOString();
  const c = connection(entityId);
  if (!isConfigured(entityId)) return { ok: false, status: 'not_configured', detail: 'Add a webhook URL, or a bot token plus a channel.', checkedAt };
  if (c.botToken && c.channel) {
    try {
      const r = await fetch('https://slack.com/api/auth.test', { method: 'POST', headers: { Authorization: `Bearer ${c.botToken}` }, signal: AbortSignal.timeout(15000) });
      const d = await r.json().catch(() => ({}));
      if (!d.ok) return { ok: false, status: 'token_invalid', detail: d.error || 'auth.test failed', checkedAt };
      return { ok: true, status: 'ok', team: d.team || '', channel: c.channel, checkedAt };
    } catch (e) { return { ok: false, status: 'error', detail: e.message, checkedAt }; }
  }
  // Webhook-only — there's no non-destructive check; the connection is set.
  return { ok: true, status: 'webhook', detail: 'Webhook set — send a test message to confirm it posts.', checkedAt };
}

// ── integration plumbing (kept here so index.js stays thin) ──
// Translate an inbound integrations payload (body.slack) into stored keys. Called
// from the shared applyIntegrationsPatch; `set(key, value)` writes one field.
function applyPatch(body, set) {
  const s = (body || {}).slack || {};
  if (s.webhookUrl) set('slackWebhookUrl', String(s.webhookUrl).trim());
  if (s.clearWebhookUrl) set('slackWebhookUrl', '');
  if (s.botToken) set('slackBotToken', String(s.botToken).trim());
  if (s.clearBotToken) set('slackBotToken', '');
  if (s.channel !== undefined) set('slackChannel', String(s.channel || '').trim());
}
// Masked, write-only view for the settings UI (secrets reported as set + hint only).
function view(i) {
  return {
    webhookSet: !!i.slackWebhookUrl,
    webhookHint: mask(i.slackWebhookUrl),
    botTokenSet: !!i.slackBotToken,
    botHint: mask(i.slackBotToken),
    channel: i.slackChannel || '',
    configured: !!(i.slackWebhookUrl || (i.slackBotToken && i.slackChannel)),
  };
}

// Mount = init + own the test-send routes (keeps the composition root thin —
// index.js doesn't grow a route cluster for this). Dual-surface: admin sends a
// test for any client; a client can send one for their own entity. Returns the
// module so the caller keeps `const slack = require('./slack').mount(...)`.
function mount(app, deps) {
  const { auth } = deps;
  const { asyncHandler } = require('./http');
  init(deps);
  app.post('/api/admin/entities/:id/slack/test', auth.requireAdmin, asyncHandler(async (req, res) => {
    res.json(await sendTest(req.params.id));
  }));
  app.post('/api/my/slack/:entityId/test', auth.requireAuth, auth.requirePermission('integrations.manage'), asyncHandler(async (req, res) => {
    if (!(req.user.entityIds || []).includes(req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
    res.json(await sendTest(req.params.entityId));
  }));
  // Manual share → the signed-in user's own connected channel (any team member can
  // share; no integrations.manage needed — that's only for connecting Slack).
  app.get('/api/my/slack/share-status', auth.requireAuth, (req, res) => res.json(shareStatusForUser(req.user)));
  app.post('/api/my/slack/share', auth.requireAuth, asyncHandler(async (req, res) => {
    res.json(await shareForUser(req.user, req.body || {}));
  }));
  return module.exports;
}

module.exports = { init, mount, isConfigured, status, connection, send, notify, sendTest, shareForUser, shareStatusForUser, verify, applyPatch, view };
