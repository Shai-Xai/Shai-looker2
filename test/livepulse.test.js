// Live Pulse engine: snapshot deltas + per-hour rate, last-event comparison, the
// top-N + EventOps blocks, the live-window/cadence gating and the WhatsApp 24h
// customer-care window. Metric reads are stubbed so the test drives the values and
// asserts what the composed update SAYS and where it fans out — the real deliverable.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { db, auth, makeEntity } = require('./helpers');

function fakeApp() { return { get() {}, post() {}, put() {}, delete() {} }; }

// en-ZA thousands separators vary by ICU build (comma vs (narrow) no-break space) —
// match any of them so the assertion pins the NUMBER, not the locale's separator.
const num = (s) => new RegExp(s.replace(/,/g, '[,\\s\\u00A0\\u202F]'));

function mountLivePulse(over = {}) {
  const sql = db.db;
  let tileValue = 0;
  let metricBySuite = {};          // suiteId -> value (drives the last-event comparison)
  const metricCalls = [];          // every metric read: { suiteId, filters } (asserts the same-point clip)
  const announced = [];
  const sms = [];
  const wa = [];
  const mod = require('../server/livepulse').mount(fakeApp(), {
    db, auth,
    resolveTileValue: async () => tileValue,
    resolveCustomMetric: async ({ suiteId, filters }) => { metricCalls.push({ suiteId, filters: filters || {} }); return suiteId in metricBySuite ? metricBySuite[suiteId] : tileValue; },
    resolveTileRows: over.resolveTileRows || (async () => null),
    resolveEventDate: over.resolveEventDate,
    os: { announce: (a) => { announced.push(a); return { id: 'thread' }; } },
    mailer: { baseUrl: () => 'https://pulse.test' },
    messaging: {
      sendSms: async (m) => { sms.push(m); return { ok: true }; },
      sendWhatsapp: async (m) => { wa.push(m); return { ok: true }; },
      normaliseMsisdn: (n) => n,
      status: () => ({ configured: true }),
      waConfigured: () => true,
    },
    eventops: over.eventops,
  });
  return {
    mod, sql, announced, sms, wa, metricCalls,
    setValue: (v) => { tileValue = v; },
    setMetricBySuite: (m) => { metricBySuite = m; },
  };
}

// Insert a pulse row and return the engine's object for it.
function makePulse(mod, over = {}) {
  const id = crypto.randomUUID();
  const p = {
    id, entityId: over.entityId || 'ent1', suiteId: over.suiteId || 'suite1', name: 'Event live update',
    cadenceMin: 30, windowStart: '', windowEnd: '', live: 1,
    blocks: [{ id: 'b1', type: 'value', source: 'tile', dashboardId: 'dash1', tileId: 'tile1', label: 'Through the gates', icon: '🎟️', unit: '', showDelta: true, showRate: true, compare: false }],
    channels: ['push'], smsRecipients: [], waRecipients: [],
    compareSuiteId: '', compareLabel: '', timezone: 'Africa/Johannesburg',
    status: 'active', ...over,
  };
  db.db.prepare(`INSERT INTO live_pulses (id, entity_id, suite_id, name, cadence_min, window_start, window_end, live, blocks, channels,
      sms_recipients, wa_recipients, compare_suite_id, compare_label, timezone, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    p.id, p.entityId, p.suiteId, p.name, p.cadenceMin, p.windowStart, p.windowEnd, p.live ? 1 : 0,
    JSON.stringify(p.blocks), JSON.stringify(p.channels), JSON.stringify(p.smsRecipients), JSON.stringify(p.waRecipients),
    p.compareSuiteId, p.compareLabel, p.timezone, p.status, new Date().toISOString(), new Date().toISOString());
  return mod.pulseById(id);
}

test('second update carries a since-last delta and a per-hour rate', async () => {
  const h = mountLivePulse();
  const p = makePulse(h.mod);

  h.setValue(4000);
  const first = await h.mod.sendUpdate(p);
  assert.match(first.message, num('Through the gates: 4,000'));
  assert.ok(!/since/.test(first.message), 'no delta on the very first update');

  h.setValue(4600);
  const second = await h.mod.sendUpdate(h.mod.pulseById(p.id));
  assert.match(second.message, num('4,600'));
  assert.match(second.message, /\+600 since \d{2}:\d{2}/);
  assert.match(second.message, /\/hr/); // pace derived from consecutive snapshots
  assert.equal(h.announced.length, 2);  // inbox thread per send
});

test('a compare block reads the SAME metric under the previous event and shows % of it', async () => {
  const h = mountLivePulse();
  const p = makePulse(h.mod, {
    compareSuiteId: 'lastyear', compareLabel: 'last year',
    blocks: [{ id: 'b1', type: 'value', source: 'metric', model: 'm', view: 'v', measure: 'v.count', label: 'Gates', unit: '', showDelta: false, showRate: false, compare: true }],
  });
  h.setMetricBySuite({ suite1: 3900, lastyear: 5000 });
  const r = await h.mod.sendUpdate(p);
  assert.match(r.message, /78% of last year/);
});

test('same-point compare clips the past event to the same day-of-event + clock time', async () => {
  const tz = 'Africa/Johannesburg';
  const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const curStart = ymd(new Date(Date.now() - 86400e3)); // this event started yesterday → we're on day 1
  const h = mountLivePulse({ resolveEventDate: async ({ suiteId }) => (suiteId === 'suite1' ? curStart : '2025-07-01') });
  const p = makePulse(h.mod, {
    compareSuiteId: 'lastyear', compareLabel: 'last year',
    blocks: [{ id: 'b1', type: 'value', source: 'metric', model: 'm', view: 'v', measure: 'v.count', label: 'Gates', unit: '', showDelta: false, showRate: false, compare: true, compareMode: 'same_point', compareClipField: 'v.created_date' }],
  });
  h.setMetricBySuite({ suite1: 5200, lastyear: 5000 });
  const r = await h.mod.sendUpdate(p);
  const cmp = h.metricCalls.find((c) => c.suiteId === 'lastyear');
  assert.ok(cmp, 'the compare read hit the past event');
  // Day 1 of this event → last year's day 1 (start 2025-07-01 + 1 = 2025-07-02), cut at the same clock time.
  assert.match(cmp.filters['v.created_date'], /^before 2025-07-02 \d{2}:\d{2}$/);
  assert.match(r.message, /104% of last year by this point/);
});

test('same-point falls back to the final-number comparison when event dates are unknown', async () => {
  const h = mountLivePulse({ resolveEventDate: async () => null });
  const p = makePulse(h.mod, {
    compareSuiteId: 'lastyear', compareLabel: 'last year',
    blocks: [{ id: 'b1', type: 'value', source: 'metric', model: 'm', view: 'v', measure: 'v.count', label: 'Gates', unit: '', showDelta: false, showRate: false, compare: true, compareMode: 'same_point', compareClipField: 'v.created_date' }],
  });
  h.setMetricBySuite({ suite1: 3900, lastyear: 5000 });
  const r = await h.mod.sendUpdate(p);
  const cmp = h.metricCalls.find((c) => c.suiteId === 'lastyear');
  assert.equal(cmp.filters['v.created_date'], undefined, 'no clip → the whole past event');
  assert.match(r.message, /78% of last year/);
  assert.ok(!/by this point/.test(r.message), 'labelled as a final-number comparison, honestly');
});

test('top-list block reads the table behind a tile, sorts and takes the top N', async () => {
  const h = mountLivePulse({
    resolveTileRows: async () => ({
      fields: [{ name: 'bars.name' }, { name: 'bars.revenue' }],
      rows: [
        { 'bars.name': 'Beach Bar', 'bars.revenue': 9800 },
        { 'bars.name': 'Main Bar', 'bars.revenue': 12100 },
        { 'bars.name': 'VIP', 'bars.revenue': 6200 },
        { 'bars.name': 'Kiosk', 'bars.revenue': 900 },
      ],
    }),
  });
  const p = makePulse(h.mod, { blocks: [{ id: 'b1', type: 'top_list', dashboardId: 'd', tileId: 't', label: 'Top bars', unit: 'ZAR', topN: 3 }] });
  const r = await h.mod.sendUpdate(p);
  assert.match(r.message, num('Top bars: Main Bar R12,100 · Beach Bar R9,800 · VIP R6,200'));
  assert.ok(!/Kiosk/.test(r.message), 'only the top N make the cut');
});

test('eventops block summarises devices + open issues', async () => {
  const h = mountLivePulse({
    eventops: { suiteSummary: () => ({ devices: { total: 102, deployed: 94, lost: 1, damaged: 1, atHive: 6 }, openIssues: 2, stations: [] }) },
  });
  const p = makePulse(h.mod, { blocks: [{ id: 'b1', type: 'eventops', label: 'Devices' }] });
  const r = await h.mod.sendUpdate(p);
  assert.match(r.message, /94 deployed \/ 102 devices/);
  assert.match(r.message, /2 open issues/);
  assert.match(r.message, /2 lost\/damaged/);
});

test('tick sends only while live and only when the cadence is due', async () => {
  const h = mountLivePulse();
  const idle = makePulse(h.mod, { live: 0 });                    // no window, not live
  const live = makePulse(h.mod, { live: 1 });
  h.setValue(100);

  await h.mod.tick();
  const runs = (id) => h.sql.prepare('SELECT COUNT(*) n FROM live_pulse_runs WHERE pulse_id=?').get(id).n;
  assert.equal(runs(idle.id), 0, 'idle pulse never sends');
  assert.equal(runs(live.id), 1, 'live pulse sends on the first tick');

  await h.mod.tick();
  assert.equal(runs(live.id), 1, 'inside the cadence window — no resend');
});

test('a scheduled window makes the pulse live without the manual switch', () => {
  const h = mountLivePulse();
  const past = new Date(Date.now() - 3600e3).toISOString();
  const future = new Date(Date.now() + 3600e3).toISOString();
  const inWin = makePulse(h.mod, { live: 0, windowStart: past, windowEnd: future });
  const outWin = makePulse(h.mod, { live: 0, windowStart: future, windowEnd: new Date(Date.now() + 7200e3).toISOString() });
  assert.equal(h.mod.isLiveNow(inWin), true);
  assert.equal(h.mod.isLiveNow(outWin), false);
});

test('WhatsApp respects the 24h customer-care window (fail closed, skip logged)', async () => {
  const h = mountLivePulse();
  // The Owl's inbound log — normally created by owlWhatsapp; create it here so the
  // window check has somewhere to look. An IN-window number has a fresh 'user' row.
  h.sql.exec(`CREATE TABLE IF NOT EXISTS owl_wa_msgs (
    id TEXT PRIMARY KEY, msisdn TEXT NOT NULL, role TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '', entity_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`);
  h.sql.prepare('INSERT INTO owl_wa_msgs (id, msisdn, role, body, created_at) VALUES (?,?,?,?,?)')
    .run(crypto.randomUUID(), '+27820000001', 'user', 'hi owl', new Date().toISOString());          // fresh → in window
  h.sql.prepare('INSERT INTO owl_wa_msgs (id, msisdn, role, body, created_at) VALUES (?,?,?,?,?)')
    .run(crypto.randomUUID(), '+27820000002', 'user', 'old', new Date(Date.now() - 25 * 3600e3).toISOString()); // stale → out

  const p = makePulse(h.mod, { channels: ['whatsapp'], waRecipients: ['+27820000001', '+27820000002', '+27820000003'] });
  h.setValue(50);
  const r = await h.mod.sendUpdate(p);
  assert.equal(h.wa.length, 1, 'only the in-window number is messaged');
  assert.equal(h.wa[0].to, '+27820000001');
  assert.ok(r.channels.includes('whatsapp'));
  assert.ok(r.channels.includes('whatsapp-skipped:2'), 'out-of-window numbers are skipped, visibly');
});

test('SMS fans out to the configured numbers with the Pulse link', async () => {
  const h = mountLivePulse();
  const p = makePulse(h.mod, { channels: ['sms'], smsRecipients: ['+27821111111'] });
  h.setValue(10);
  await h.mod.sendUpdate(p);
  assert.equal(h.sms.length, 1);
  assert.match(h.sms[0].text, /pulse\.test/);
});

test('createLivePulse runs the same clean + permission path as the routes', () => {
  const h = mountLivePulse();
  const ent = makeEntity('LP Client', 'LP Org');
  const su = db.createSuite({ entityId: ent.id, name: 'LP Fest 2026' });
  const admin = { id: 'a1', email: 'admin@test', role: 'admin' };
  const ok = h.mod.createLivePulse({
    suiteId: su.id, user: admin, via: 'owl',
    draft: { name: 'Night pulse', cadenceMin: 5 /* below floor → clamped */, blocks: [{ type: 'value', source: 'metric', model: 'm', view: 'v', measure: 'v.count', label: 'Gates' }], channels: ['push', 'bogus'] },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.pulse.cadenceMin, 10, 'cadence clamps to the floor');
  assert.deepEqual(ok.pulse.channels, ['push'], 'unknown channels are dropped');
  assert.equal(ok.pulse.createdVia, 'owl');

  const noBlocks = h.mod.createLivePulse({ suiteId: su.id, user: admin, draft: { name: 'x', blocks: [] } });
  assert.equal(noBlocks.ok, false);

  // A client WITHOUT alerts.manage can't create one (same guard as Alerts).
  const stranger = { id: 'u9', email: 'x@test', role: 'client', entityIds: [] };
  const denied = h.mod.createLivePulse({ suiteId: su.id, user: stranger, draft: { name: 'x', blocks: [{ type: 'eventops' }] } });
  assert.equal(denied.ok, false);
});

test('the comparison event must belong to the same client (cross-tenant compare is dropped)', () => {
  const h = mountLivePulse();
  const entA = makeEntity('Client A', 'Org A');
  const entB = makeEntity('Client B', 'Org B');
  const suA = db.createSuite({ entityId: entA.id, name: 'A Fest' });
  const suB = db.createSuite({ entityId: entB.id, name: 'B Fest' });
  const admin = { id: 'a1', email: 'admin@test', role: 'admin' };
  const r = h.mod.createLivePulse({
    suiteId: suA.id, user: admin,
    draft: { name: 'x', blocks: [{ type: 'value', source: 'metric', model: 'm', view: 'v', measure: 'v.count', compare: true }], compareSuiteId: suB.id },
  });
  assert.equal(r.ok, true);
  assert.equal(r.pulse.compareSuiteId, '', 'another client\'s event can never be the comparison');
});
