// App ↔ ticketing audience match: the email join between PostHog app users and
// Looker buyers. Locks the counting rules (dedupe, case-folding, counts-only
// output) and the ticket enrichment's scope binding. All deps stubbed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const appMatch = require('../server/appMatch');

function makeHarness({ appEmails = [], appTotal = 0, appCapped = false, buyers = [], lookerRows = [], orgLocks = { 'core_organisers.name': 'G&G' } } = {}) {
  const capture = () => () => {};
  const app = { get: capture(), post: capture(), put: capture(), delete: capture() };
  const calls = { looker: [] };
  const api = appMatch.mount(app, {
    db: { getEntity: () => ({ id: 'e1' }) },
    auth: { requireAuth: (q, s, n) => n(), requireAdmin: (q, s, n) => n(), accessibleOrgFilters: () => orgLocks },
    posthog: {
      isConfigured: () => true,
      eventIdsForEntity: async () => ['101'],
      appEmails: async () => ({ persons: appTotal, emails: appEmails, capped: appCapped }),
      windowUniques: async () => appTotal,
    },
    resolveAudience: async () => ({ raw: buyers }),
    queryEngine: {
      applyScope: async () => true,
      runLookerQuery: async (path, body) => { calls.looker.push(body); return lookerRows; },
    },
    catalogue: { model: 'm', explore: 'x' },
  });
  return { api, calls };
}

test('overlap matches the WHOLE app audience to buyers by email — counts only', async () => {
  const h = makeHarness({
    appTotal: 4, // exact uncapped headcount (windowUniques)
    appEmails: ['fan@one.com', 'fan2@x.com'], // appEmails() already deduped + case-folded
    buyers: [{ email: 'fan@one.com' }, { email: 'buyer@only.com' }],
  });
  const d = await h.api.overlap('e1', { role: 'admin' });
  assert.equal(d.appUsers, 4);
  assert.equal(d.appUsersWithEmail, 2);
  assert.equal(d.matched, 1);
  assert.equal(d.appNotBuyers, 1);
  assert.equal(d.buyers, 2);
  assert.equal(d.buyersNotOnApp, 1);
  assert.equal(d.appCapped, false);
  // No emails in the payload — counts only.
  assert.ok(!JSON.stringify(d).includes('fan@one.com'));
});

test('ticketsByEmail binds the org scope and groups holdings per email', async () => {
  const h = makeHarness({
    lookerRows: [
      { 'core_purchasers.email': 'FAN@one.com', 'core_events.name': 'Ultra', 'core_tickets.count': 2 },
      { 'core_purchasers.email': 'fan@one.com', 'core_events.name': 'Soirée', 'core_tickets.count': 1 },
    ],
  });
  const by = await h.api.ticketsByEmail('e1', { role: 'admin' }, ['fan@one.com', 'not-an-email', 'FAN@ONE.COM']);
  assert.deepEqual(by['fan@one.com'], [{ event: 'Ultra', tickets: 2 }, { event: 'Soirée', tickets: 1 }]);
  assert.equal(h.calls.looker.length, 1); // deduped to one chunk; junk dropped
  assert.equal(h.calls.looker[0].filters['core_purchasers.email'], 'fan@one.com');
  assert.equal(h.calls.looker[0].filters['core_organisers.name'], 'G&G', 'hard-bound to the client');
});

test('ticketsByEmail fails CLOSED without an organiser lock — no cross-client reads', async () => {
  const h = makeHarness({ orgLocks: null, lookerRows: [{ 'core_purchasers.email': 'a@b.c', 'core_events.name': 'X', 'core_tickets.count': 9 }] });
  const by = await h.api.ticketsByEmail('e1', { role: 'member' }, ['a@b.c']);
  assert.deepEqual(by, {});
  assert.equal(h.calls.looker.length, 0, 'the query never runs unscoped');
});
