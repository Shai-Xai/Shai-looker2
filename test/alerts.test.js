// Alerts engine: the edge-detection state machine, cooldown, quiet hours and the
// scoped evaluation user. The metric read is stubbed (resolveTileValue) so the test
// drives the value directly and asserts WHEN the rule fires — the real deliverable.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { db, auth, makeEntity } = require('./helpers');

// A fake express app that just records the routes (we exercise the engine via the
// returned `evaluate`, not HTTP).
function fakeApp() { return { get() {}, post() {}, put() {}, delete() {} }; }

// Mount the module with stubbed delivery + a controllable metric source.
function mountAlerts() {
  const sql = db.db;
  let tileValue = 0;          // the live number the rule reads
  let scopedUser = null;      // captures the user resolveTileValue was called with
  const announced = [];       // captured inbox/email-push deliveries
  const sms = [];             // captured SMS deliveries
  let metricArgs = null;       // captures the args a metric read was called with
  const mod = require('../server/alerts').mount(fakeApp(), {
    db, auth,
    resolveTileValue: async ({ user }) => { scopedUser = user; return tileValue; },
    resolveCustomMetric: async ({ user, ...rest }) => { scopedUser = user; metricArgs = rest; return tileValue; },
    metricCatalog: async () => ({ explores: [] }),
    metricFilterValues: async () => [],
    os: { announce: (a) => { announced.push(a); return { id: 'thread' }; } },
    mailer: { baseUrl: () => 'https://pulse.test' },
    push: { isEnabled: () => true },
    messaging: { sendSms: async (m) => { sms.push(m); return { ok: true }; }, status: () => ({ configured: true }) },
  });
  return {
    mod, sql,
    setValue: (v) => { tileValue = v; },
    getScopedUser: () => scopedUser,
    getMetricArgs: () => metricArgs,
    announced, sms,
  };
}

// Insert an alert row and return the JS object the engine evaluates.
function makeAlert(over = {}) {
  const id = crypto.randomUUID();
  const a = {
    id, entityId: over.entityId || 'ent1', suiteId: 'suite1', name: 'Test', ruleType: 'threshold',
    dashboardId: 'dash1', tileId: 'tile1', dashboardName: '', tileName: 'Tickets sold',
    operator: 'gte', threshold: 1000, unit: 'tickets',
    channels: ['push'], smsRecipients: [], priority: 'normal', frequency: 'once', cooldownMin: 60,
    quietStart: '', quietEnd: '', timezone: 'Africa/Johannesburg',
    status: 'active', state: 'armed', lastValue: null, lastCheckedAt: '', lastFiredAt: '', fireCount: 0,
    createdBy: 'owner@test', ...over,
  };
  a.source = over.source || 'tile';
  a.model = over.model || ''; a.view = over.view || ''; a.measure = over.measure || '';
  a.measureLabel = over.measureLabel || ''; a.metricFilters = over.metricFilters || {}; a.metricLabel = over.metricLabel || '';
  db.db.prepare(`INSERT INTO alerts (id, entity_id, suite_id, name, rule_type, source, dashboard_id, tile_id, model, view, measure, measure_label, metric_filters, metric_label, operator, threshold, unit,
      channels, sms_recipients, priority, frequency, cooldown_min, quiet_start, quiet_end, timezone, status, state, fire_count,
      created_at, updated_at, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    a.id, a.entityId, a.suiteId, a.name, a.ruleType, a.source, a.dashboardId, a.tileId, a.model, a.view, a.measure, a.measureLabel, JSON.stringify(a.metricFilters), a.metricLabel, a.operator, a.threshold, a.unit,
    JSON.stringify(a.channels), JSON.stringify(a.smsRecipients), a.priority, a.frequency, a.cooldownMin,
    a.quietStart, a.quietEnd, a.timezone, a.status, a.state, a.fireCount, new Date().toISOString(), new Date().toISOString(), a.createdBy);
  return a;
}

const firedCount = (sql, id) => sql.prepare("SELECT COUNT(*) n FROM alert_events WHERE alert_id=? AND status='fired'").get(id).n;
const rowOf = (sql, id) => sql.prepare('SELECT state, fire_count, last_fired_at FROM alerts WHERE id=?').get(id);

test('fires on the cross, not while the condition stays true (edge-detection)', async () => {
  const h = mountAlerts();
  const a = makeAlert();

  // Below threshold → no fire.
  h.setValue(500);
  await h.mod.evaluate({ ...a });
  assert.equal(firedCount(h.sql, a.id), 0);
  assert.equal(rowOf(h.sql, a.id).state, 'armed');

  // Crosses above → fires exactly once, state becomes triggered.
  h.setValue(1200);
  await h.mod.evaluate({ ...a, state: rowOf(h.sql, a.id).state });
  assert.equal(firedCount(h.sql, a.id), 1);
  assert.equal(rowOf(h.sql, a.id).state, 'triggered');
  assert.equal(h.announced.length, 1);

  // Stays above → does NOT fire again.
  h.setValue(1500);
  await h.mod.evaluate({ ...a, state: 'triggered' });
  assert.equal(firedCount(h.sql, a.id), 1);
});

test('a once-alert rests after clearing; a repeat-alert re-arms and fires again', async () => {
  const h = mountAlerts();

  // once: clears but does not re-arm → a re-cross never fires again.
  const once = makeAlert({ frequency: 'once' });
  h.setValue(1200); await h.mod.evaluate({ ...once });
  assert.equal(firedCount(h.sql, once.id), 1);
  h.setValue(100); await h.mod.evaluate({ ...once, state: 'triggered' });
  assert.equal(rowOf(h.sql, once.id).state, 'triggered'); // stayed triggered (no re-arm)
  h.setValue(1300); await h.mod.evaluate({ ...once, state: 'triggered' });
  assert.equal(firedCount(h.sql, once.id), 1); // never fired a second time

  // repeat: clearing re-arms, and the next cross fires again (cooldown 0 here).
  const rep = makeAlert({ frequency: 'repeat', cooldownMin: 0 });
  h.setValue(1200); await h.mod.evaluate({ ...rep });
  assert.equal(firedCount(h.sql, rep.id), 1);
  h.setValue(100); await h.mod.evaluate({ ...rep, state: 'triggered' });
  assert.equal(rowOf(h.sql, rep.id).state, 'armed'); // re-armed
  h.setValue(1300); await h.mod.evaluate({ ...rep, state: 'armed' });
  assert.equal(firedCount(h.sql, rep.id), 2); // fired again on the new cross
});

test('cooldown suppresses a re-fire inside the window (logged, not sent)', async () => {
  const h = mountAlerts();
  const a = makeAlert({ frequency: 'repeat', cooldownMin: 60 });

  h.setValue(1200); await h.mod.evaluate({ ...a });
  const firstFired = rowOf(h.sql, a.id).last_fired_at;
  assert.equal(firedCount(h.sql, a.id), 1);

  // Clear → re-arm, then re-cross immediately. Inside cooldown → suppressed.
  h.setValue(100); await h.mod.evaluate({ ...a, state: 'triggered', lastFiredAt: firstFired });
  h.setValue(1300); await h.mod.evaluate({ ...a, state: 'armed', lastFiredAt: firstFired });
  assert.equal(firedCount(h.sql, a.id), 1); // still only one real fire
  assert.equal(h.sql.prepare("SELECT COUNT(*) n FROM alert_events WHERE alert_id=? AND status='suppressed'").get(a.id).n, 1);
});

test('quiet hours hold a normal alert but an important one breaks through', async () => {
  const h = mountAlerts();
  // A window covering effectively the whole day, so "now" is inside it.
  const quiet = { quietStart: '00:00', quietEnd: '23:59' };

  const normal = makeAlert({ ...quiet, priority: 'normal' });
  h.setValue(1200); await h.mod.evaluate({ ...normal });
  assert.equal(firedCount(h.sql, normal.id), 0);           // held
  assert.equal(rowOf(h.sql, normal.id).state, 'armed');    // left armed to fire after quiet hours

  const important = makeAlert({ ...quiet, priority: 'important' });
  h.setValue(1200); await h.mod.evaluate({ ...important });
  assert.equal(firedCount(h.sql, important.id), 1);        // broke through
});

test('sold-out and depletion compare correctly', async () => {
  const h = mountAlerts();
  const soldOut = makeAlert({ ruleType: 'sold_out', operator: 'lte', threshold: 0, tileName: 'Tickets remaining' });
  h.setValue(5); await h.mod.evaluate({ ...soldOut });
  assert.equal(firedCount(h.sql, soldOut.id), 0);
  h.setValue(0); await h.mod.evaluate({ ...soldOut, state: 'armed' });
  assert.equal(firedCount(h.sql, soldOut.id), 1);

  const low = makeAlert({ ruleType: 'depletion', operator: 'lte', threshold: 100, tileName: 'GA remaining' });
  h.setValue(150); await h.mod.evaluate({ ...low });
  assert.equal(firedCount(h.sql, low.id), 0);
  h.setValue(80); await h.mod.evaluate({ ...low, state: 'armed' });
  assert.equal(firedCount(h.sql, low.id), 1);
});

test('evaluation runs as a CLIENT user scoped to the entity (never admin/unscoped)', async () => {
  const h = mountAlerts();
  const ent = makeEntity('Acme', 'Acme Organiser');
  const a = makeAlert({ entityId: ent.id });
  h.setValue(1200);
  await h.mod.evaluate({ ...a });
  const u = h.getScopedUser();
  assert.equal(u.role, 'client');                 // not admin → scope is enforced
  assert.deepEqual(u.entityIds, [ent.id]);        // locked to this alert's entity only
});

test('a custom-metric alert reads via resolveCustomMetric (no tile) and fires on the cross', async () => {
  const h = mountAlerts();
  const a = makeAlert({
    source: 'metric', model: 'ticketing', view: 'core', measure: 'core.tickets_sold',
    metricFilters: { 'core.ticket_type': 'VIP' }, measureLabel: 'Tickets sold', metricLabel: 'Tickets sold · Ticket Type = VIP',
    threshold: 1000, operator: 'gte',
  });
  // Below → no fire; the metric read got the measure + filter we configured.
  h.setValue(800); await h.mod.evaluate({ ...a });
  assert.equal(firedCount(h.sql, a.id), 0);
  assert.deepEqual(h.getMetricArgs(), { model: 'ticketing', view: 'core', measure: 'core.tickets_sold', filters: { 'core.ticket_type': 'VIP' }, suiteId: 'suite1' });
  // Crosses → fires once, and the message carries the metric label (not a tile name).
  h.setValue(1200); await h.mod.evaluate({ ...a, state: 'armed' });
  assert.equal(firedCount(h.sql, a.id), 1);
  assert.match(h.announced[0].body, /Tickets sold · Ticket Type = VIP/);
});

test('SMS fans out to configured numbers when the sms channel is on', async () => {
  const h = mountAlerts();
  const a = makeAlert({ channels: ['push', 'sms'], smsRecipients: ['+27821234567'] });
  h.setValue(1200);
  await h.mod.evaluate({ ...a });
  assert.equal(h.sms.length, 1);
  assert.equal(h.sms[0].to, '+27821234567');
  assert.match(h.sms[0].text, /pulse\.test/); // carries the deep link
});
