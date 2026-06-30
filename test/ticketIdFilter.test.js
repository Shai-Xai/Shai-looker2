// routeTicketIdFilters — ticket category/type names collide (several "Loyalty
// Tickets" with different ids), so a name-keyed filter can't isolate one. When a
// filter value is purely numeric id(s) it must be retargeted to the `.id`
// dimension so a report filters to that EXACT category; plain names stay on the
// name field, and a mixed id+name value stays put (two fields would AND to none).

const { test } = require('node:test');
const assert = require('node:assert');

// The helper only touches the filters object — no looker/auth needed for it.
const { routeTicketIdFilters } = require('../server/query')({ looker: {}, auth: {} });

test('numeric ticket-category value → id dimension', () => {
  const out = routeTicketIdFilters({ 'core_ticket_categories.name': '16244' });
  assert.deepEqual(out, { 'core_ticket_categories.id': '16244' });
});

test('multiple numeric ids → id dimension, comma-joined', () => {
  const out = routeTicketIdFilters({ 'core_ticket_categories.name': '16244, 15166' });
  assert.deepEqual(out, { 'core_ticket_categories.id': '16244,15166' });
});

test('ticket-type names route the same way', () => {
  const out = routeTicketIdFilters({ 'core_ticket_types.name': '154' });
  assert.deepEqual(out, { 'core_ticket_types.id': '154' });
});

test('a plain name stays on the name field', () => {
  const f = { 'core_ticket_categories.name': 'Loyalty Tickets' };
  assert.deepEqual(routeTicketIdFilters(f), f);
});

test('a mixed id+name value stays put (no broken cross-field AND)', () => {
  const f = { 'core_ticket_categories.name': '16244,Festival Tickets' };
  assert.deepEqual(routeTicketIdFilters(f), f);
});

test('merges into an existing id filter rather than clobbering it', () => {
  const out = routeTicketIdFilters({
    'core_ticket_categories.name': '16244',
    'core_ticket_categories.id': '999',
  });
  assert.deepEqual(out, { 'core_ticket_categories.id': '999,16244' });
});

test('non-ticket fields are untouched', () => {
  const f = { 'core_organisers.name': '42', 'core_purchasers.city': 'Cape Town' };
  assert.deepEqual(routeTicketIdFilters(f), f);
});

test('null/empty input is returned as-is', () => {
  assert.equal(routeTicketIdFilters(null), null);
  assert.deepEqual(routeTicketIdFilters({}), {});
});
