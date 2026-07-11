// App ↔ ticketing audience match: the email join between PostHog app users and
// Looker buyers. Locks the counting rules (dedupe, case-folding, counts-only
// output) and the ticket enrichment's scope binding. All deps stubbed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const appMatch = require('../server/appMatch');

function makeHarness({ appEmails = [], appTotal = 0, appCapped = false, buyerRows = [], attendeeRows = [], attendeesThrow = false, lookerRows = [], orgLocks = { 'core_organisers.name': 'G&G' } } = {}) {
  const capture = () => () => {};
  const app = { get: capture(), post: capture(), put: capture(), delete: capture() };
  const calls = { looker: [], segments: [] };
  const api = appMatch.mount(app, {
    db: { getEntity: () => ({ id: 'e1' }), db: { prepare: () => ({ get: () => null }) } },
    segments: () => ({
      createSegment: (args) => { calls.segments.push(args); return { ok: true, segment: { id: 's1', name: args.name } }; },
    }),
    auth: { requireAuth: (q, s, n) => n(), requireAdmin: (q, s, n) => n(), accessibleOrgFilters: () => orgLocks },
    posthog: {
      isConfigured: () => true,
      eventIdsForEntity: async () => ['101'],
      appEmails: async () => ({ persons: appTotal, emails: appEmails, capped: appCapped }),
      windowUniques: async () => appTotal,
    },
    queryEngine: {
      applyScope: async () => true,
      runLookerQuery: async (path, body) => {
        calls.looker.push(body);
        if ((body.fields || []).includes('core_users.email')) {
          if (attendeesThrow) throw new Error('unknown field');
          return attendeeRows;
        }
        if ((body.fields || []).includes('core_purchasers.email') && body.fields.length === 1) return buyerRows;
        return lookerRows;
      },
    },
    catalogue: { model: 'm', explore: 'x' },
  });
  return { api, calls };
}

test('overlap matches the WHOLE app audience to BOTH segments — counts only', async () => {
  const h = makeHarness({
    appTotal: 4, // exact uncapped headcount (windowUniques)
    appEmails: ['fan@one.com', 'fan2@x.com'], // appEmails() already deduped + case-folded
    buyerRows: [{ 'core_purchasers.email': 'Fan@One.com' }, { 'core_purchasers.email': 'buyer@only.com' }],
    // Attendees (held a ticket) is the WIDER set: fan2 attended via a group buy.
    attendeeRows: [
      { 'core_users.email': 'FAN@one.com' },
      { 'core_users.email': 'fan2@x.com' },
      { 'core_users.email': 'holder@only.com' },
    ],
  });
  const d = await h.api.overlap('e1', { role: 'admin' });
  assert.equal(d.appUsers, 4);
  assert.equal(d.appUsersWithEmail, 2);
  // BOTH identity queries are scoped to the SAME events as the app side.
  const idQueries = h.calls.looker.filter((b) => b.fields.length === 1);
  assert.equal(idQueries.length, 2);
  for (const b of idQueries) assert.equal(b.filters['core_events.id'], '101');
  // Buyers (paid): only fan@one matches.
  assert.equal(d.matched, 1);
  assert.equal(d.appNotBuyers, 1);
  assert.equal(d.buyers, 2);
  assert.equal(d.buyersNotOnApp, 1);
  // Attendees (held a ticket): both app users match; one holder isn't on the app.
  assert.equal(d.attendees, 3);
  assert.equal(d.matchedAttendees, 2);
  assert.equal(d.appNotAttendees, 0);
  assert.equal(d.attendeesNotOnApp, 1);
  assert.equal(d.appCapped, false);
  // No emails in the payload — counts only.
  assert.ok(!JSON.stringify(d).includes('fan@one.com'));
});

test('overlap narrows to ONE event when asked — but never widens beyond scope', async () => {
  const h = makeHarness({ appTotal: 2, appEmails: ['fan@one.com'], buyerRows: [] });
  await h.api.overlap('e1', { role: 'admin' }, { event: '101' });
  assert.equal(h.calls.looker[0].filters['core_events.id'], '101');
  // An event OUTSIDE the client's scope is ignored (falls back to all their events).
  await h.api.overlap('e1', { role: 'admin' }, { event: '999' });
  assert.equal(h.calls.looker[2].filters['core_events.id'], '101');
});

test('overlap degrades to buyers-only when the attendee field is unavailable', async () => {
  const h = makeHarness({
    appTotal: 2, appEmails: ['fan@one.com'],
    buyerRows: [{ 'core_purchasers.email': 'fan@one.com' }],
    attendeesThrow: true,
  });
  const d = await h.api.overlap('e1', { role: 'admin' });
  assert.equal(d.matched, 1);
  assert.equal(d.attendees, null);
  assert.equal(d.matchedAttendees, null);
  assert.equal(d.appNotAttendees, null);
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

test('createGroupSegment: the group math matches the card and ships as a paste snapshot', async () => {
  const h = makeHarness({
    appTotal: 3,
    appEmails: ['fan@one.com', 'fan2@x.com', 'lurker@app.com'],
    buyerRows: [{ 'core_purchasers.email': 'fan@one.com' }],
    attendeeRows: [
      { 'core_users.email': 'fan@one.com' },
      { 'core_users.email': 'fan2@x.com' },
      { 'core_users.email': 'holder@only.com' },
    ],
  });
  // never_ticket = app emails minus ATTENDEES (the wide set), not minus buyers.
  const r = await h.api.createGroupSegment('e1', { role: 'admin' }, { group: 'never_ticket' });
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
  assert.equal(r.truncated, false);
  const made = h.calls.segments[0];
  assert.equal(made.entityId, 'e1');
  assert.equal(made.via, 'app-match');
  assert.equal(made.folder, 'App audience');
  assert.ok(made.name.includes('all events'), 'unscoped run is named for all events');
  assert.equal(made.definition.mode, 'paste');
  assert.equal(made.definition.pasted, 'email\nlurker@app.com', 'header + only the unmatched app user');
  // holders_not_app = attendees minus the app set.
  const r2 = await h.api.createGroupSegment('e1', { role: 'admin' }, { group: 'holders_not_app' });
  assert.equal(h.calls.segments[1].definition.pasted, 'email\nholder@only.com');
  assert.equal(r2.count, 1);
  // group_buy = attendees who never appear as a purchaser.
  await h.api.createGroupSegment('e1', { role: 'admin' }, { group: 'group_buy' });
  const groupBuy = h.calls.segments[2].definition.pasted.split('\n').slice(1).sort();
  assert.deepEqual(groupBuy, ['fan2@x.com', 'holder@only.com']);
});

test('createGroupSegment rejects unknown groups and empty cohorts', async () => {
  const h = makeHarness({
    appTotal: 1, appEmails: ['fan@one.com'],
    buyerRows: [{ 'core_purchasers.email': 'fan@one.com' }],
    attendeeRows: [{ 'core_users.email': 'fan@one.com' }],
  });
  await assert.rejects(() => h.api.createGroupSegment('e1', { role: 'admin' }, { group: 'nope' }), /Unknown group/);
  // Everyone on the app holds a ticket → never_ticket is empty → 400, no segment made.
  await assert.rejects(() => h.api.createGroupSegment('e1', { role: 'admin' }, { group: 'never_ticket' }), /No one is in this group/);
  assert.equal(h.calls.segments.length, 0);
});

test('createGroupSegment without attendee data: holder groups refuse, buyer fallback works', async () => {
  const h = makeHarness({
    appTotal: 2, appEmails: ['fan@one.com', 'lurker@app.com'],
    buyerRows: [{ 'core_purchasers.email': 'fan@one.com' }],
    attendeesThrow: true,
  });
  await assert.rejects(() => h.api.createGroupSegment('e1', { role: 'admin' }, { group: 'holders_not_app' }), /Ticket-holder data/);
  // never_ticket degrades to "minus buyers" — same fallback the card shows.
  const r = await h.api.createGroupSegment('e1', { role: 'admin' }, { group: 'never_ticket' });
  assert.equal(h.calls.segments[0].definition.pasted, 'email\nlurker@app.com');
  assert.equal(r.ok, true);
});
