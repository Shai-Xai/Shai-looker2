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
function init(deps) {
  db = deps.db;
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
async function send({ entityId, text, blocks, kind = 'other' }) {
  const c = connection(entityId);
  if (!isConfigured(entityId)) { log(entityId, 'skipped', 'not configured', kind); return { skipped: true, reason: 'not_configured' }; }
  const useBot = !!(c.botToken && c.channel);
  try {
    if (useBot) {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.botToken}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel: c.channel, text, blocks }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) throw new Error(data.error || `Slack HTTP ${res.status}`);
    } else {
      const res = await fetch(c.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, blocks }),
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
async function notify({ entityId, title, body, url, kind = 'notification' }) {
  const heading = String(title || 'New message in Pulse').trim();
  const text = `${heading}${body ? `\n${body}` : ''}`;
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: `*${heading}*${body ? `\n${body}` : ''}` } }];
  if (url) blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in Pulse' }, url }] });
  return send({ entityId, text, blocks, kind });
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

module.exports = { init, isConfigured, status, connection, send, notify, verify, applyPatch, view };
