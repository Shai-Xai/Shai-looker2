// App ↔ ticketing audience match: the email join between PostHog app users and
// Looker buyers. Locks the counting rules (dedupe, case-folding, counts-only
// output) and the ticket enrichment's scope binding. All deps stubbed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const appMatch = require('../server/appMatch');

function makeHarness({ appEmails = [], appTotal = 0, appCapped = false, buyerRows = [], attendeeRows = [], attendeesThrow = false, lookerRows = [], typeRows = [], totalTickets = 0, peopleRows = [], orgLocks = { 'core_organisers.name': 'G&G' } } = {}) {
  const capture = () => () => {};
  const app = { get: capture(), post: capture(), put: capture(), delete: capture() };
  const calls = { looker: [], segments: [], people: [] };
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
      people: async (opts) => { calls.people.push(opts); return { people: peopleRows }; },
    },
    queryEngine: {
      applyScope: async () => true,
      runLookerQuery: async (path, body) => {
        calls.looker.push(body);
        if ((body.fields || []).includes('core_ticket_types.name')) return typeRows;
        if ((body.fields || []).length === 1 && body.fields[0] === 'core_tickets.count') return [{ 'core_tickets.count': totalTickets }];
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

test('group math matches the card, and segments are saved LIVE (appmatch definition)', async () => {
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
  const u = { role: 'admin' };
  // never_ticket = app emails minus ATTENDEES (the wide set), not minus buyers.
  assert.deepEqual((await h.api.groupEmails('e1', u, { group: 'never_ticket' })).emails, ['lurker@app.com']);
  // holders_not_app = attendees minus the app set; group_buy = attendees minus purchasers.
  assert.deepEqual((await h.api.groupEmails('e1', u, { group: 'holders_not_app' })).emails, ['holder@only.com']);
  assert.deepEqual((await h.api.groupEmails('e1', u, { group: 'group_buy' })).emails.sort(), ['fan2@x.com', 'holder@only.com']);
  // Intersections (tap-a-tile groups).
  assert.deepEqual((await h.api.groupEmails('e1', u, { group: 'app_holders' })).emails.sort(), ['fan2@x.com', 'fan@one.com'].sort());
  assert.deepEqual((await h.api.groupEmails('e1', u, { group: 'app_buyers' })).emails, ['fan@one.com']);
  assert.equal((await h.api.groupEmails('e1', u, { group: 'app_users' })).emails.length, 3);
  // The saved segment is a LIVE definition — no member list is stored.
  const r = await h.api.createGroupSegment('e1', u, { group: 'never_ticket' });
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
  assert.equal(r.live, true);
  const made = h.calls.segments[0];
  assert.equal(made.entityId, 'e1');
  assert.equal(made.via, 'app-match');
  assert.equal(made.folder, 'App audience');
  assert.ok(made.name.includes('all events'), 'unscoped run is named for all events');
  assert.deepEqual(made.definition, { mode: 'appmatch', group: 'never_ticket', appEvent: '', appSize: 0 });
  assert.ok(!JSON.stringify(made).includes('lurker@app.com'), 'no emails in the stored definition');
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

test('without attendee data: holder groups refuse, never_ticket falls back to buyers', async () => {
  const h = makeHarness({
    appTotal: 2, appEmails: ['fan@one.com', 'lurker@app.com'],
    buyerRows: [{ 'core_purchasers.email': 'fan@one.com' }],
    attendeesThrow: true,
  });
  await assert.rejects(() => h.api.groupEmails('e1', { role: 'admin' }, { group: 'holders_not_app' }), /Ticket-holder data/);
  // never_ticket degrades to "minus buyers" — same fallback the card shows.
  assert.deepEqual((await h.api.groupEmails('e1', { role: 'admin' }, { group: 'never_ticket' })).emails, ['lurker@app.com']);
});

test('super_fans: live top-N by activity, staff excluded, size clamped into range', async () => {
  const h = makeHarness({ peopleRows: [{ email: 'Fan@One.com' }, { email: 'fan@one.com' }, { email: '' }, { email: 'two@x.com' }] });
  const r = await h.api.groupEmails('e1', { role: 'admin' }, { group: 'super_fans', size: 3 });
  assert.deepEqual(r.emails, ['fan@one.com', 'two@x.com'], 'case-folded, deduped, no blanks');
  assert.equal(r.size, 10, 'size clamps up to the minimum of 10');
  assert.equal(h.calls.people[0].limit, 10);
  assert.equal(h.calls.people[0].excludeStaff, true, 'super fans never include Howler staff');
  assert.equal(h.calls.people[0].orderBy, 'active');
  const seg = await h.api.createGroupSegment('e1', { role: 'admin' }, { group: 'super_fans', size: 25 });
  assert.equal(seg.ok, true);
  assert.equal(h.calls.segments[0].definition.appSize, 25);
  assert.ok(h.calls.segments[0].name.includes('Top 25 super fans'));
});

test('ticketSummary: total sold + app-held tickets by type, scoped and org-locked', async () => {
  const h = makeHarness({
    appTotal: 2, appEmails: ['fan@one.com', 'lurker@app.com'],
    buyerRows: [{ 'core_purchasers.email': 'fan@one.com' }],
    attendeeRows: [{ 'core_users.email': 'fan@one.com' }],
    totalTickets: 100,
    typeRows: [
      { 'core_ticket_types.name': 'General', 'core_tickets.count': 3 },
      { 'core_ticket_types.name': 'VIP', 'core_tickets.count': 1 },
    ],
  });
  const t = await h.api.ticketSummary('e1', { role: 'admin' }, {});
  assert.equal(t.totalTickets, 100);
  assert.equal(t.appTickets, 4);
  assert.equal(t.appHolders, 1, 'only the matched holder counts');
  assert.deepEqual(t.types, [{ type: 'General', tickets: 3 }, { type: 'VIP', tickets: 1 }]);
  // Both the total and the type queries are event-scoped AND org-locked.
  const q = h.calls.looker.filter((b) => (b.fields || []).includes('core_tickets.count'));
  for (const b of q) {
    assert.equal(b.filters['core_events.id'], '101');
    assert.equal(b.filters['core_organisers.name'], 'G&G');
  }
  // The type query is keyed by the matched HOLDER emails only.
  const typeQ = h.calls.looker.find((b) => (b.fields || []).includes('core_ticket_types.name'));
  assert.equal(typeQ.filters['core_users.email'], 'fan@one.com');
});
