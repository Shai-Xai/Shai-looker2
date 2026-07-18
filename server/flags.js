// ─── 🚩 Feature flags — SELF-CONTAINED, DISPOSABLE MODULE ───────────────────────
// Which client sees which feature. TWO levels: a section flag (engage, alerts…)
// and its sub-features (engage.segments…). Resolution per (entity, flag):
//   override (feature_flags row) ?? platform default (flag_defaults setting ?? registry)
// …then the PARENT CHAIN is applied: a section OFF force-kills its children.
//
// The REGISTRY below is the single source of truth — ship a new gateable feature,
// add ONE line here and it appears in Admin → Product → 🚩 Flags for every client
// (test/flags.test.js fails a flag without name+desc). Storage is overrides-only,
// so new clients need zero setup and flipping a platform default moves every
// non-overridden client at once.
//
// Enforcement (phase 1):
//   • URL-prefix gates (GATES below) 403 client users when a section is off —
//     registered at mount, BEFORE the feature modules, so nothing leaks.
//   • Owl act-tools: owlChat filters tools per entity via OWL_TOOL_FLAGS.
//   • Pulse API + MCP: apiKeys' bearer auth consults integrations.api (seeded
//     from the old api_enabled:<entityId> settings at first boot).
//   • Nav/UI: the client hides sections via GET /api/my/flags/:entityId.
// Still on their legacy switches (migrate next): the per-integration Settings
// panels (integrations.looker/meta/… are marked LEGACY in the matrix).
//
// Module-singleton (like aiUsage): mount() once from index.js; any module may
// `require('./flags').enabled(entityId, key)` afterwards.

let _db = null;

// ── The registry (one line per flag; kids use dotted keys) ──────────────────────
const REGISTRY = [
  { key: 'goals', emoji: '🎯', name: 'Goals', def: true, desc: 'Targets on the numbers that matter, tracked live.' },
  { key: 'alerts', emoji: '🔔', name: 'Alerts', def: true, desc: 'Metric watchers + event-day live updates.', kids: [
    { key: 'alerts.alerts', name: 'Alerts', def: true, desc: 'Threshold alerts on any metric.' },
    { key: 'alerts.livepulse', name: 'Live updates', def: true, desc: 'Recurring event-day multi-metric snapshots.' },
    { key: 'alerts.templates', name: 'Templates', def: true, desc: 'Reusable alert templates.' },
  ] },
  { key: 'eventops', emoji: '🎛️', name: 'Event Ops', def: false, beta: true, desc: 'Device/station logistics — the per-client pilot switch (old pilot grants were migrated in).', kids: [
    { key: 'eventops.hive', name: 'Hive', def: true, desc: 'Devices, stations, moves, issues.' },
    { key: 'eventops.health', name: 'Data health', def: true, desc: 'Stream monitors for this event.' },
    { key: 'eventops.signal', name: 'Signal board', def: true, desc: 'The live site board.' },
    { key: 'eventops.staff', name: 'Staff alerts', def: false, beta: true, desc: 'Dark station → assigned crew.' },
    { key: 'eventops.calls', name: 'Calls', def: false, beta: true, desc: 'Device support calls to dispatch.' },
  ] },
  { key: 'engage', emoji: '📣', name: 'Engage', def: true, desc: 'Turn data into action — campaigns and audiences.', kids: [
    { key: 'engage.campaigns', name: 'Campaigns', def: true, desc: 'Email/SMS campaigns with approval flow.' },
    { key: 'engage.segments', name: 'Segments', def: true, desc: 'Reusable audiences from tiles.' },
    { key: 'engage.audiences', name: 'Ad audiences', def: true, desc: 'Push segments to Meta/TikTok ads.' },
    { key: 'engage.templates', name: 'Templates', def: true, desc: 'Campaign templates.' },
    { key: 'engage.journeys', name: 'Journeys', def: false, beta: true, desc: 'Owl-built branching journeys — decisions, audience splits, per-mailer editing. OFF hides the tab + removes the Owl tool. (Branch EXECUTION additionally needs the JOURNEY_ENGINE switch.)' },
    { key: 'engage.links', name: 'Links', def: true, beta: true, desc: 'ChottuLink short links into the Howler app — created from Pulse, click-tracked. OFF hides the tab + removes the Owl link tools.' },
    { key: 'engage.surveys', name: 'Surveys', def: false, beta: true, desc: 'Post-event fan surveys answered in the Howler app, results back in Pulse. OFF hides the tab AND stops the app being served this client\'s surveys.' },
  ] },
  { key: 'social', emoji: '📊', name: 'Social', def: false, beta: true, desc: 'Social performance reporting.' },
  { key: 'community', emoji: '📰', name: 'Community feed', def: false, beta: true, desc: 'Howler-native communities & feed posts served to the app from Pulse (Social+ replacement spike). OFF hides the composer AND drops this client\'s posts/communities from the app feed.' },
  { key: 'appanalytics', emoji: '📱', name: 'App analytics', def: false, beta: true, desc: 'Howler-app engagement on the client\'s events, live from PostHog — views, CTAs, purchases, app users.', kids: [
    { key: 'appanalytics.socialplus', name: 'Community (Social+)', def: true, beta: true, desc: 'The client\'s in-app communities & chats from Social+ — members, messages, posts & reactions, as a tab on the App page. Needs communities linked to the client.' },
  ] },
  { key: 'digests', emoji: '🗓', name: 'Digests', def: true, desc: 'Scheduled role-based briefing emails.' },
  { key: 'reports', emoji: '📑', name: 'Report Studio', def: false, beta: true, desc: 'Block-based shareable client reports — tiles + AI analysis, share link + PDF, one-off or scheduled.' },
  { key: 'settlements', emoji: '🧾', name: 'Settlements', def: true, desc: 'Settlements, invoices and documents.', kids: [
    { key: 'settlements.settlements', name: 'Settlements', def: true, desc: 'Interactive settlement views.' },
    { key: 'settlements.documents', name: 'Documents', def: true, desc: 'Invoices & event documents.' },
  ] },
  { key: 'ai', emoji: '✨', name: 'AI insights', def: true, desc: 'The read-only AI layer.', kids: [
    { key: 'ai.briefing', name: 'Home briefing', def: true, desc: 'The AI-written home summary.' },
    { key: 'ai.tile_insights', name: 'Tile insights', def: true, desc: 'Per-tile “explain this” Owl.' },
    { key: 'ai.analyst', name: 'Ask analyst', def: true, desc: 'The Inventive analyst drawer.' },
  ] },
  { key: 'owl', emoji: '🦉', name: 'Owl chat', def: true, desc: 'The conversational Owl. Sub-flags remove specific ACTIONS (the tool is simply not offered to the model).', kids: [
    { key: 'owl.create_alerts', name: 'Create alerts', def: true, desc: 'Owl may draft alerts (human confirms).' },
    { key: 'owl.create_live_updates', name: 'Create live updates', def: true, desc: 'Owl may draft live updates.' },
    { key: 'owl.create_segments', name: 'Create segments', def: true, desc: 'Owl may draft segments.' },
    { key: 'owl.draft_campaigns', name: 'Draft campaigns', def: true, desc: 'Owl may draft campaigns.' },
    { key: 'owl.save_reports', name: 'Save reports', def: true, desc: 'Owl may save dashboards (“Saved from Owl”).' },
    { key: 'owl.uploads', name: 'File uploads', def: true, desc: 'Grounding files uploaded to the Owl.' },
    { key: 'owl.drive', name: 'Google Drive', def: true, desc: 'Owl reads the linked Drive folder.' },
  ] },
  { key: 'waowl', emoji: '💬', name: 'WhatsApp Owl', def: true, beta: true, desc: 'The Owl over WhatsApp (inert until configured; OFF = the Owl stops engaging on WhatsApp).' },
  { key: 'fanowl', emoji: '🎪', name: 'Fan Owl', def: true, beta: true, desc: 'Public website ticket assistant (inert until a site is set up; OFF = the widget refuses to boot).', kids: [
    { key: 'fanowl.loyalty', name: 'Loyalty & verification', def: false, beta: true, desc: 'The identity handshake: fans verify their email (6-digit code) and the Owl guides from their derived purchase history. OFF = verification is never offered.' },
  ] },
  { key: 'integrations', emoji: '🔌', name: 'Integrations', def: true, desc: 'What reaches Pulse from outside.', kids: [
    { key: 'integrations.looker', name: 'Looker', def: true, legacy: true, desc: 'Client’s OWN Looker credential panel (dashboards run on platform credentials either way).' },
    { key: 'integrations.anthropic', name: 'Anthropic key', def: true, legacy: true, desc: 'Client’s own AI key panel.' },
    { key: 'integrations.meta', name: 'Meta', def: true, legacy: true, desc: 'Meta ads account link.' },
    { key: 'integrations.tiktok', name: 'TikTok', def: true, legacy: true, desc: 'TikTok ads account link.' },
    { key: 'integrations.slack', name: 'Slack', def: true, legacy: true, desc: 'Slack channel mirror/shares.' },
    { key: 'integrations.drive', name: 'Google Drive', def: true, legacy: true, desc: 'Linked Drive folder.' },
    { key: 'integrations.inbox', name: 'CC-the-Owl inbox', def: true, legacy: true, desc: 'The client’s inbound mail address.' },
    { key: 'integrations.api', name: 'API & MCP (agents)', def: false, beta: true, desc: 'Pulse API keys + the MCP connector (Claude/ChatGPT). OFF = keys stop authenticating instantly.' },
  ] },
  { key: 'selfservice', emoji: '🛠', name: 'Self-service settings', def: true, desc: 'Which Settings sections the CLIENT may manage themselves (Howler admin always can).', kids: [
    { key: 'selfservice.integrations', name: 'Integrations panel', def: true, desc: 'Settings → Integrations.' },
    { key: 'selfservice.branding', name: 'Branding', def: true, desc: 'Logo, colours, sender.' },
    { key: 'selfservice.domain', name: 'Sending domain', def: true, desc: 'Send from their own domain.' },
    { key: 'selfservice.team', name: 'Team', def: true, desc: 'Invite/manage their own users.' },
  ] },
  { key: 'yourjourney', emoji: '⚡', name: 'Your journey', def: true, beta: true, desc: 'Client onboarding journey — stickers, badges & Pulse Points (nav entry + points ledger).' },
  { key: 'navcategories', emoji: '🗂', name: 'Nav categories', def: false, beta: true, desc: 'Clients group their events into their own named categories in the sidebar (drag events in). OFF hides the category controls; the nav falls back to the automatic Upcoming/Past grouping.' },
  { key: 'report', emoji: '💬', name: 'Report an issue', def: true, desc: 'In-app bug/idea reporting.' },
];

const FLAT = []; // [{key, parent|null, def, ...}]
for (const s of REGISTRY) { FLAT.push({ ...s, parent: null }); for (const k of (s.kids || [])) FLAT.push({ ...k, parent: s.key }); }
const BY_KEY = new Map(FLAT.map((f) => [f.key, f]));

// Owl act-tool name → the flag that must be ON for the tool to be offered.
const OWL_TOOL_FLAGS = {
  createAlert: 'owl.create_alerts',
  createLiveUpdate: 'owl.create_live_updates',
  createSegment: 'owl.create_segments',
  draftCampaign: 'owl.draft_campaigns',
  draftJourney: 'engage.journeys', // one switch: the feature flag also offers/removes the Owl tool
  draftReport: 'owl.save_reports',
  createLink: 'engage.links',
  applyLinkTemplate: 'engage.links',
  getAppAnalytics: 'appanalytics', // flag off = the tool is never offered to the model
};

// Client-route prefixes → the flag that must be ON (admins always pass).
const GATES = [
  ['/api/goals', 'goals'],
  ['/api/alerts', 'alerts.alerts'],
  ['/api/livepulse', 'alerts.livepulse'],
  ['/api/my/digests', 'digests'],
  ['/api/my/reports', 'reports'],
  ['/api/actions', 'engage.campaigns'],
  ['/api/actions-summary', 'engage.campaigns'],
  ['/api/segments', 'engage.segments'],
  ['/api/journeys', 'engage.journeys'],
  ['/api/owl/act/draft-journey', 'engage.journeys'],
  ['/api/campaign-templates', 'engage.templates'],
  ['/api/my/chottu', 'engage.links'],
  ['/api/my/surveys', 'engage.surveys'],
  ['/api/owl/act/create-chottu-link', 'engage.links'],
  ['/api/owl/act/apply-chottu-template', 'engage.links'],
  ['/api/my/onboarding', 'yourjourney'],
  ['/api/my/suite-categories', 'navcategories'],
  ['/api/my/app-analytics', 'appanalytics'],
  ['/api/my/app-audience', 'appanalytics'],
  ['/api/my/app-tickets', 'appanalytics'],
  ['/api/my/socialplus', 'appanalytics.socialplus'],
  ['/api/my/loyalty', 'fanowl.loyalty'],
  ['/api/my/social', 'community'],
];

// ── Resolution ──────────────────────────────────────────────────────────────────
const J = (s, fb) => { try { const v = JSON.parse(s); return v == null ? fb : v; } catch { return fb; } };
function platformDefaults() {
  const over = _db ? J(_db.getSetting('flag_defaults', '{}'), {}) : {};
  const out = {};
  for (const f of FLAT) out[f.key] = over[f.key] !== undefined ? over[f.key] === 'on' : !!f.def;
  return out;
}
function overridesFor(entityId) {
  if (!_db || !entityId) return {};
  const rows = _db.db.prepare('SELECT flag, value FROM feature_flags WHERE entity_id=?').all(entityId);
  return Object.fromEntries(rows.map((r) => [r.flag, r.value]));
}
// Effective flat map for one entity — parent chain applied (section off kills kids).
function resolveEntity(entityId) {
  const defs = platformDefaults();
  const over = overridesFor(entityId);
  const raw = {};
  for (const f of FLAT) raw[f.key] = over[f.key] ? over[f.key] === 'on' : defs[f.key];
  const out = {};
  for (const f of FLAT) out[f.key] = raw[f.key] && (!f.parent || raw[f.parent]);
  return out;
}
const enabled = (entityId, key) => {
  if (!BY_KEY.has(key)) return true; // unknown key: never lock anyone out
  const f = BY_KEY.get(key);
  const defs = platformDefaults();
  const over = overridesFor(entityId);
  const on = (k) => (over[k] ? over[k] === 'on' : defs[k]);
  return on(key) && (!f.parent || on(f.parent));
};
// A user-scoped check for gates: admins always pass; a client passes if ANY of
// their entities has it on (multi-entity users keep working).
const enabledForUser = (user, key) =>
  !user ? false : user.role === 'admin' ? true : (user.entityIds || []).some((e) => enabled(e, key));

// ── Mount ───────────────────────────────────────────────────────────────────────
// Idempotent + order-independent: any module touching flags (apiKeys does, from
// its own mount) may call init(db) first; the full mount() also runs it.
function init(db) {
  if (_db) return;
  _db = db;
  db.db.exec(`CREATE TABLE IF NOT EXISTS feature_flags (
    entity_id TEXT NOT NULL, flag TEXT NOT NULL, value TEXT NOT NULL, updated_by TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
    PRIMARY KEY (entity_id, flag));`);
  // One-time seed: clients granted API access under the old api_enabled:<id>
  // settings keep it when integrations.api becomes the gate.
  try {
    if (db.getSetting('flags_seeded_api', '') !== '1') {
      const rows = db.db.prepare("SELECT key FROM settings WHERE key LIKE 'api_enabled:%' AND value='1'").all();
      const ins = db.db.prepare('INSERT OR IGNORE INTO feature_flags (entity_id, flag, value, updated_by, updated_at) VALUES (?,?,?,?,?)');
      for (const r of rows) ins.run(r.key.slice('api_enabled:'.length), 'integrations.api', 'on', 'seed', new Date().toISOString());
      db.setSetting('flags_seeded_api', '1');
    }
  } catch (e) { console.error('[flags] api seed failed', e.message); }
}

function mount(app, { db, auth }) {
  init(db);

  // URL-prefix gates — registered BEFORE the feature modules mount (index.js order).
  for (const [prefix, key] of GATES) {
    app.use(prefix, auth.requireAuth, (req, res, next) => {
      if (enabledForUser(req.user, key)) return next();
      res.status(403).json({ error: 'This feature isn’t enabled for your account — ask Howler to switch it on.' });
    });
  }

  const values = () => {
    const out = {};
    for (const r of db.db.prepare('SELECT entity_id, flag, value FROM feature_flags').all()) (out[r.entity_id] = out[r.entity_id] || {})[r.flag] = r.value;
    return out;
  };
  app.get('/api/admin/flags', auth.requireAdmin, (_req, res) => {
    res.json({
      registry: REGISTRY,
      defaults: platformDefaults(),
      overrides: values(),
      entities: db.listEntities().map((e) => ({ id: e.id, name: e.name })),
    });
  });
  app.put('/api/admin/flags/default', auth.requireAdmin, (req, res) => {
    const { key, value } = req.body || {};
    if (!BY_KEY.has(key)) return res.status(400).json({ error: 'Unknown flag' });
    const over = J(db.getSetting('flag_defaults', '{}'), {});
    if (value === 'on' || value === 'off') over[key] = value; else delete over[key];
    db.setSetting('flag_defaults', JSON.stringify(over));
    res.json({ defaults: platformDefaults() });
  });
  app.put('/api/admin/flags/:entityId', auth.requireAdmin, (req, res) => {
    const { key, value } = req.body || {};
    if (!BY_KEY.has(key)) return res.status(400).json({ error: 'Unknown flag' });
    if (!db.getEntity(req.params.entityId)) return res.status(404).json({ error: 'Client not found' });
    if (value === 'on' || value === 'off') {
      db.db.prepare('INSERT INTO feature_flags (entity_id, flag, value, updated_by, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(entity_id, flag) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at')
        .run(req.params.entityId, key, value, req.user.email || '', new Date().toISOString());
    } else {
      db.db.prepare('DELETE FROM feature_flags WHERE entity_id=? AND flag=?').run(req.params.entityId, key); // back to auto
    }
    res.json({ overrides: overridesFor(req.params.entityId), effective: resolveEntity(req.params.entityId) });
  });
  // The client's own effective map — drives nav/UI hiding. Admins may read any
  // entity (client preview must look exactly like the client sees it).
  app.get('/api/my/flags/:entityId', auth.requireAuth, (req, res) => {
    if (req.user.role !== 'admin' && !(req.user.entityIds || []).includes(req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
    res.json({ flags: resolveEntity(req.params.entityId) });
  });

  console.log(`[flags] mounted — ${FLAT.length} flags, ${GATES.length} route gates`);
  return { enabled, enabledForUser, resolveEntity, REGISTRY, OWL_TOOL_FLAGS };
}

module.exports = { mount, init, enabled, enabledForUser, resolveEntity, REGISTRY, FLAT, OWL_TOOL_FLAGS, GATES };
