// WhatsApp Owl — edition scoping. A suite is an EDITION and may span several event
// records; the WhatsApp door (no suite picker) learns the full event set from the
// suite lock via eventLockValues, so a multi-event edition isn't undercounted.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { eventLockValues } = require('../server/owlWhatsapp');

// A by-name resolver like auth.filterNameToField ("Event Name" → core_events.name).
const resolve = (k) => ({ 'event name': 'core_events.name', 'current event': 'core_events.name' })[String(k).toLowerCase()] || null;

test('direct core_events.name lock with a comma OR list yields every event', () => {
  const vals = eventLockValues({ 'core_events.name': 'Kappa FuturFestival 2026, Kappa FuturFestival 2026 - Carte Cultura' }, resolve);
  assert.deepEqual(vals, ['Kappa FuturFestival 2026', 'Kappa FuturFestival 2026 - Carte Cultura']);
});

test('by-name preset key ("Event Name") resolves to the event field', () => {
  assert.deepEqual(eventLockValues({ 'Event Name': 'Only One 2026' }, resolve), ['Only One 2026']);
});

test('a combined __or__ key that includes the event field is picked up', () => {
  const vals = eventLockValues({ '__or__:is:core_events.name|cashless_combine_data.name': 'A 2026,B 2026' }, resolve);
  assert.deepEqual(vals, ['A 2026', 'B 2026']);
});

test('non-event locks and blanks are ignored; dedupes across keys', () => {
  const vals = eventLockValues({
    'core_organisers.name': 'Movement',            // not an event lock
    'core_events.name': 'KFF 2026',
    'Current Event': 'KFF 2026',                    // same value via a second key → deduped
    'Event Name': '',                               // blank → ignored
  }, resolve);
  assert.deepEqual(vals, ['KFF 2026']);
});

test('no event lock → empty (WhatsApp then just uses the model-chosen filter)', () => {
  assert.deepEqual(eventLockValues({ 'core_organisers.name': 'Movement' }, resolve), []);
  assert.deepEqual(eventLockValues({}, resolve), []);
});
