// WhatsApp Owl — edition scoping. A suite is an EDITION and may span several event
// records; the WhatsApp door (no suite picker) learns the CURRENT edition's event set
// from the suite lock via eventLockValues — and must NEVER fold in the "Past Event"
// (prior-year) lock, which also targets core_events.name.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { eventLockValues } = require('../server/owlWhatsapp');

test('Current Event lock with a comma OR list yields every current-edition event', () => {
  const vals = eventLockValues({ 'Current Event': 'Kappa FuturFestival 2026, Kappa FuturFestival 2026 - Carte Cultura' });
  assert.deepEqual(vals, ['Kappa FuturFestival 2026', 'Kappa FuturFestival 2026 - Carte Cultura']);
});

test("CRITICAL: 'Past Event' (prior year) is EXCLUDED — Shai's real KFF 26 lock shape", () => {
  // Exactly the screenshot: Current Event = 2026 + Carte, Past Event = 2025 + Carte.
  const vals = eventLockValues({
    'Current Event': 'Kappa FuturFestival 2026,Kappa FuturFestival 2026 - Carte Cultura',
    'Past Event': 'Kappa FuturFestival 2025,Kappa FuturFestival 2025 - Carte Cultura',
    'Current & Past Events': 'Kappa FuturFestival 2026,Kappa FuturFestival 2025',
    'Comparison Events': 'Kappa FuturFestival 2025',
  });
  assert.deepEqual(vals, ['Kappa FuturFestival 2026', 'Kappa FuturFestival 2026 - Carte Cultura'], 'only the 2026 current edition, never 2025');
});

test('Event Name preset also counts as current', () => {
  assert.deepEqual(eventLockValues({ 'Event Name': 'Only One 2026' }), ['Only One 2026']);
});

test('raw core_events.name field is treated as the current event', () => {
  assert.deepEqual(eventLockValues({ 'core_events.name': 'A 2026,B 2026' }), ['A 2026', 'B 2026']);
});

test('a combined __or__ current-event lock (event × cashless) is picked up', () => {
  const vals = eventLockValues({ '__or__:is:core_events.name|cashless_combine_data.name': 'A 2026,B 2026' });
  assert.deepEqual(vals, ['A 2026', 'B 2026']);
});

test('non-event locks and blanks ignored; dedupes across current-event keys', () => {
  const vals = eventLockValues({
    'core_organisers.name': 'Movement',   // not an event lock
    'Current Event': 'KFF 2026',
    'core_events.name': 'KFF 2026',        // same value via the raw key → deduped
    'Event Name': '',                      // blank → ignored
  });
  assert.deepEqual(vals, ['KFF 2026']);
});

test('no current-event lock → empty (WhatsApp falls back to the model-chosen filter)', () => {
  assert.deepEqual(eventLockValues({ 'Past Event': 'KFF 2025' }), []);
  assert.deepEqual(eventLockValues({}), []);
});
