// Report Studio (server/reports.js) — templates → snapshots → share/PDF/email.
// Pins the contracts that matter: input sanitisation, the tenant + permission
// gates on the client surface, snapshot resolution (KPI / table / AI blocks),
// the public capability-token routes (viewer JSON + PDF + assets), and the
// claim-first scheduler behaviour (a due template can never double-send).

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');
const { startApp } = require('./http');

const sql = h.db.db;
const sent = [];

const mailer = {
  send: async ({ to, subject, html }) => { sent.push({ to, subject, html }); return { ok: true }; },
  resolveBranding: () => ({ brandColor: '#FF2D55', secondaryColor: '#FF6B35', logo: '', logoDark: '', wordmark: 'Acme Events', senderName: 'Acme', currency: 'ZAR' }),
  baseUrl: () => 'http://test.local',
};

// One fake fact per known tile — the shape buildFactsFromTiles emits (json_detail
// fields/rows). "kpi1" resolves to a single-value tile; "chart1" to a chartable
// bar (2 rows, dim+measure); anything else is unresolvable.
const FACTS = {
  kpi1: {
    title: 'Tickets sold', visType: 'single_value', context: '', dashboardId: 'dash1', suiteId: 'su1', pivots: [],
    fields: { dimensions: [], measures: [{ name: 'orders.count', label: 'Count' }] },
    rows: [{ 'orders.count': { value: 8430, rendered: '8,430' } }],
  },
  chart1: {
    title: 'Sales by tier', visType: 'looker_bar', context: '', dashboardId: 'dash1', suiteId: 'su1', pivots: [],
    fields: { dimensions: [{ name: 'tiers.name', label: 'Tier' }], measures: [{ name: 'orders.count', label: 'Sold' }] },
    rows: [
      { 'tiers.name': { value: 'GA', rendered: 'GA' }, 'orders.count': { value: 5000, rendered: '5,000' } },
      { 'tiers.name': { value: 'VIP', rendered: 'VIP' }, 'orders.count': { value: 430, rendered: '430' } },
    ],
  },
};
const buildFactsFromTiles = async (_user, _entityId, picks) => {
  const f = FACTS[picks[0]?.tileId];
  return { tiles: f ? [f] : [], catalogue: [], dropped: f ? [] : ['missing'] };
};
const factValueLabel = (fact) => {
  const row = (fact.rows || [])[0];
  if (!row) return '—';
  const m = (fact.fields?.measures || [])[0];
  return m && row[m.name] ? String(row[m.name].rendered ?? row[m.name].value) : '—';
};

// reports.js builds the analysis prompt itself and runs it through insights'
// shared plumbing — fake the Anthropic client so the test exercises the real
// prompt assembly (scope label + tile count) with no network.
const insights = {
  isConfigured: () => true,
  MODEL: 'test-model',
  systemWith: (base) => base,
  compactTable: (fields, rows) => `${(rows || []).length} row(s)`,
  requireClient: () => ({
    messages: {
      create: async ({ messages }) => {
        const prompt = messages[0].content;
        const scope = (/Scope of this analysis: (.+)/.exec(prompt) || [])[1] || '?';
        const tiles = (prompt.match(/^### /gm) || []).length;
        return { content: [{ type: 'text', text: `AI(${scope}) over ${tiles} tile(s).` }] };
      },
    },
  }),
};

let app, reports, ent, otherEnt, admin, manager, viewer, outsider;
before(async () => {
  ent = h.makeEntity('Reports Client', 'reports-org');
  otherEnt = h.makeEntity('Other Client', 'other-org');
  admin = h.makeAdmin('reports-admin@test.local');
  manager = h.makeClient('manager@test.local', [ent.id], 'manager');
  viewer = h.makeClient('viewer@test.local', [ent.id], 'viewer');
  outsider = h.makeClient('outsider@test.local', [otherEnt.id], 'manager');
  app = await startApp((expressApp) => {
    reports = require('../server/reports').mount(expressApp, {
      db: h.db, auth: h.auth, mailer, insights,
      currency: require('../server/currency'),
      buildFactsFromTiles, factValueLabel,
      anthropicKeyForEntity: () => 'sk-test',
      aiInstructionsFor: () => '',
      notifyOps: () => {},
      // Engage campaigns + native-app analytics data sources (report blocks
      // resolve through these exactly like index.js wires them).
      campaignsFor: () => [{
        id: 'camp1', title: 'Early-bird push', status: 'done', audienceCount: 5200,
        results: { sent: 5100, opens: 2300, clicks: 612, converted: 89 },
      }],
      appReportFor: async (_eid, { days }) => ({
        scoped: true, days,
        totals: { uniques: 4100, views: 18400, interactions: 9600, ctaTaps: 1200, purchases: 310, purchaseValue: 186000 },
        series: Array.from({ length: 10 }, (_, i) => ({ date: `2026-07-${String(i + 1).padStart(2, '0')}`, uniques: 300 + i * 20, views: 1500 + i * 40, ctaTaps: 90 + i * 5 })),
        events: [{ eventRef: 'ev1', eventName: 'Oasis Festival', uniques: 4100, views: 18400, ctaTaps: 1200, purchases: 310 }],
      }),
    });
  });
});
after(async () => { if (app) await app.close(); });
beforeEach(() => { sent.length = 0; });

const BLOCKS = [
  { type: 'heading', text: 'Sales', level: 1 },
  { type: 'tile', dashboardId: 'dash1', tileId: 'kpi1', display: 'value' },
  { type: 'tile', dashboardId: 'dash1', tileId: 'chart1', display: 'table' },
  { type: 'ai', scope: 'section' },
  { type: 'text', text: 'A closing note.' },
];

test('cleanBlocks: unknown types dropped, fields capped, scope/display validated', () => {
  const out = reports._cleanBlocks([
    { type: 'heading', text: 'x'.repeat(9000), level: 7 },
    { type: 'nonsense', text: 'nope' },
    { type: 'ai', scope: 'weird', focus: 'f' },
    { type: 'tile', dashboardId: 'd', tileId: 't', display: 'sideways' },
    null,
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[0].text.length, 8000);
  assert.equal(out[0].level, 1);
  assert.equal(out[1].scope, 'section');   // invalid scope → section
  assert.equal(out[2].display, 'auto');    // invalid display → auto
});

test('computeNextRun: monthly lands on the configured local day-of-month', () => {
  const next = reports._computeNextRun({ cadence: 'monthly', timeOfDay: '08:30', monthday: 15, timezone: 'Africa/Johannesburg' });
  assert.ok(next instanceof Date && next > new Date());
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(next);
  const get = (t) => p.find((x) => x.type === t).value;
  assert.equal(get('day'), '15');
  assert.equal(`${get('hour')}:${get('minute')}`, '08:30');
});

test('client surface: permission + tenant gates hold', async () => {
  // viewer lacks reports.manage → 403
  let r = await app.req('GET', `/api/my/reports/${ent.id}`, { as: viewer });
  assert.equal(r.status, 403);
  // manager of ANOTHER entity can't touch this one → 403 (permission check is per-entity)
  r = await app.req('GET', `/api/my/reports/${ent.id}`, { as: outsider });
  assert.equal(r.status, 403);
  // manager of this entity → 200
  r = await app.req('GET', `/api/my/reports/${ent.id}`, { as: manager });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.templates));
});

test('end to end: create → generate → public viewer JSON → PDF → assets 404 for junk', async () => {
  const c = await app.req('POST', `/api/my/reports/${ent.id}`, { as: manager, body: { title: 'Weekly wrap', blocks: BLOCKS, recipients: ['stake@holder.com'], cadence: 'none' } });
  assert.equal(c.status, 201);
  const tpl = c.body.template;
  assert.equal(tpl.blocks.length, 5);

  const g = await app.req('POST', `/api/my/reports/${ent.id}/${tpl.id}/generate`, { as: manager });
  assert.equal(g.status, 201);
  const snap = g.body.snapshot;
  assert.ok(snap.token && snap.path === `/r/${snap.token}`);

  // Public viewer payload — no auth cookie at all.
  const pub = await app.req('GET', `/api/public/reports/${snap.token}`, {});
  assert.equal(pub.status, 200);
  assert.equal(pub.body.title, 'Weekly wrap');
  assert.equal(pub.body.branding.name, 'Acme Events');
  const kinds = pub.body.blocks.map((b) => `${b.type}${b.kind ? ':' + b.kind : ''}`);
  assert.deepEqual(kinds, ['heading', 'tile:kpi', 'tile:table', 'ai', 'text']);
  assert.equal(pub.body.blocks[1].value, '8,430');
  assert.deepEqual(pub.body.blocks[2].columns, ['Tier', 'Sold']);
  assert.match(pub.body.blocks[3].text, /AI\(the "Sales" section\) over 2 tile/);

  // PDF (public, token capability).
  const pdf = await fetch(`${app.base}/api/public/reports/${snap.token}/pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(bytes.slice(0, 5).toString(), '%PDF-');

  // Junk tokens 404.
  assert.equal((await app.req('GET', '/api/public/reports/not-a-token', {})).status, 404);
  assert.equal((await fetch(`${app.base}/report-assets/not-a-token`)).status, 404);
});

test('campaign + app analytics blocks resolve to chips/chart/table and feed the AI scope', async () => {
  const c = await app.req('POST', `/api/my/reports/${ent.id}`, { as: manager, body: { title: 'Engage wrap', blocks: [
    { type: 'campaign', campaignId: 'camp1' },
    { type: 'app', appView: 'summary', days: 28 },
    { type: 'app', appView: 'trend', days: 14 },
    { type: 'app', appView: 'events', days: 90 },
    { type: 'ai', scope: 'report' },
  ] } });
  assert.equal(c.status, 201);
  const g = await app.req('POST', `/api/my/reports/${ent.id}/${c.body.template.id}/generate`, { as: manager });
  assert.equal(g.status, 201);
  const pub = await app.req('GET', `/api/public/reports/${g.body.snapshot.token}`, {});
  const blocks = pub.body.blocks;
  // Campaign → sub-heading + 6 KPI chips (audience/sent/opens/clicks/rate/converted)
  assert.equal(blocks[0].type, 'heading');
  assert.match(blocks[0].text, /Early-bird push/);
  const campChips = blocks.slice(1, 7);
  assert.ok(campChips.every((b) => b.type === 'tile' && b.kind === 'kpi'));
  assert.deepEqual(campChips.map((b) => b.title), ['Audience', 'Sent', 'Opens', 'Clicks', 'Click rate', 'Converted']);
  assert.equal(campChips[1].value, '5,100');
  assert.equal(campChips[4].value, '12%');
  // App summary → sub-heading + KPI chips incl currency-formatted purchase value
  const appHead = blocks.findIndex((b) => b.type === 'heading' && /App engagement — last 28 days/.test(b.text));
  assert.ok(appHead > 0);
  const appChips = blocks.slice(appHead + 1, appHead + 7);
  assert.deepEqual(appChips.map((b) => b.title), ['App users', 'Views', 'Interactions', 'CTA taps', 'Purchases', 'Purchase value']);
  assert.match(appChips[5].value, /R.?186[ ,]000/);
  // Trend → a rendered chart asset; events → a table
  const chart = blocks.find((b) => b.kind === 'chart' && /last 14 days/.test(b.title));
  assert.ok(chart && chart.assetToken, 'trend chart rendered');
  const table = blocks.find((b) => b.kind === 'table' && /by event/.test(b.title));
  assert.deepEqual(table.columns, ['Event', 'App users', 'Views', 'CTA taps', 'Purchases']);
  assert.equal(table.rows[0][0], 'Oasis Festival');
  // AI (whole report) saw all four data facts (campaign + 3 app views)
  const ai = blocks.find((b) => b.type === 'ai');
  assert.match(ai.text, /over 4 tile/);
});

test("'auto' display on a chartable tile renders a PNG chart asset", async () => {
  const c = await app.req('POST', `/api/admin/entities/${ent.id}/reports`, { as: admin, body: { title: 'Chart test', blocks: [{ type: 'tile', dashboardId: 'dash1', tileId: 'chart1', display: 'auto' }] } });
  const g = await app.req('POST', `/api/admin/reports/${c.body.template.id}/generate`, { as: admin });
  assert.equal(g.status, 201);
  const pub = await app.req('GET', `/api/public/reports/${g.body.snapshot.token}`, {});
  assert.equal(pub.body.blocks[0].kind, 'chart');
  const asset = await fetch(`${app.base}/report-assets/${pub.body.blocks[0].assetToken}`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('content-type'), 'image/png');
  const png = Buffer.from(await asset.arrayBuffer());
  assert.equal(png.slice(1, 4).toString(), 'PNG');
});

test('send emails every recipient the branded snapshot with the share link', async () => {
  const c = await app.req('POST', `/api/my/reports/${ent.id}`, { as: manager, body: { title: 'Send me', blocks: BLOCKS, recipients: ['a@x.com', 'b@x.com'] } });
  const s = await app.req('POST', `/api/my/reports/${ent.id}/${c.body.template.id}/send`, { as: manager });
  assert.equal(s.status, 200);
  assert.equal(s.body.sent, 2);
  assert.deepEqual(sent.map((m) => m.to).sort(), ['a@x.com', 'b@x.com']);
  assert.match(sent[0].html, new RegExp(`/r/${s.body.snapshot.token}`));
  assert.match(sent[0].subject, /Send me/);
});

test('scheduler: a due template is claimed before the send and never double-sends', async () => {
  const id = crypto.randomUUID();
  const t = new Date().toISOString();
  sql.prepare(`INSERT INTO report_templates (id, entity_id, title, blocks, recipients, cadence, time_of_day, status, next_run_at, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, ent.id, 'Due report', JSON.stringify([{ type: 'tile', dashboardId: 'dash1', tileId: 'kpi1', display: 'value', id: 'b0', text: '', level: 1, url: '', alt: '', href: '', scope: 'section', focus: '' }]),
      JSON.stringify(['sched@x.com']), 'daily', '07:00', 'active', new Date(Date.now() - 60000).toISOString(), t, t);
  await reports._tick();
  assert.deepEqual(sent.map((m) => m.to), ['sched@x.com']);
  const row = sql.prepare('SELECT * FROM report_templates WHERE id=?').get(id);
  assert.ok(new Date(row.next_run_at) > new Date(), 'next_run_at advanced');
  assert.match(row.last_status, /^ok: sent to 1/);
  await reports._tick(); // not due any more — no double-send
  assert.equal(sent.length, 1);
});

test('deleting a snapshot revokes the share link and its assets', async () => {
  const c = await app.req('POST', `/api/my/reports/${ent.id}`, { as: manager, body: { title: 'Revoke', blocks: [{ type: 'tile', dashboardId: 'dash1', tileId: 'chart1', display: 'auto' }] } });
  const g = await app.req('POST', `/api/my/reports/${ent.id}/${c.body.template.id}/generate`, { as: manager });
  const snap = g.body.snapshot;
  const tok = (await app.req('GET', `/api/public/reports/${snap.token}`, {})).body.blocks[0].assetToken;
  const d = await app.req('DELETE', `/api/my/reports/${ent.id}/snapshots/${snap.id}`, { as: manager });
  assert.equal(d.status, 204);
  assert.equal((await app.req('GET', `/api/public/reports/${snap.token}`, {})).status, 404);
  assert.equal((await fetch(`${app.base}/report-assets/${tok}`)).status, 404);
});
