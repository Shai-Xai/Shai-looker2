// Unit tests for the reporting-timezone resolver (server/timezone.js) — the layer
// that makes relative date filters ("today") resolve on the client's local day.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers'); // sets up an isolated db before requiring timezone
const tz = require('../server/timezone');

test('isValidTimezone accepts real IANA zones and rejects junk/blank', () => {
  assert.equal(tz.isValidTimezone('Europe/Paris'), true);
  assert.equal(tz.isValidTimezone('UTC'), true);
  assert.equal(tz.isValidTimezone('Not/AZone'), false);
  assert.equal(tz.isValidTimezone(''), false);
  assert.equal(tz.isValidTimezone(null), false);
  assert.equal(tz.isValidTimezone(42), false);
});

test('reportingTimezoneFor falls back to the platform default with no override', () => {
  const ent = h.makeEntity('Default Co', 'Default-org');
  assert.equal(tz.reportingTimezoneFor(h.db, { entityId: ent.id }), tz.PLATFORM_TIMEZONE);
});

test('reportingTimezoneFor prefers a valid per-entity override', () => {
  const ent = h.makeEntity('Override Co', 'Override-org');
  h.db.updateEntity(ent.id, { reportingTimezone: 'America/New_York' });
  assert.equal(tz.reportingTimezoneFor(h.db, { entityId: ent.id }), 'America/New_York');
});

test('reportingTimezoneFor resolves via a suite\'s entity', () => {
  const ent = h.makeEntity('Suite TZ Co', 'SuiteTZ-org');
  h.db.updateEntity(ent.id, { reportingTimezone: 'Europe/Athens' });
  const suite = h.db.createSuite({ entityId: ent.id, name: 'A Fest' });
  assert.equal(tz.reportingTimezoneFor(h.db, { suiteId: suite.id }), 'Europe/Athens');
});

test('reportingTimezoneFor uses a single-entity user\'s client', () => {
  const ent = h.makeEntity('User TZ Co', 'UserTZ-org');
  h.db.updateEntity(ent.id, { reportingTimezone: 'Asia/Dubai' });
  const user = h.makeClient('tz-user@client.test', [ent.id]);
  assert.equal(tz.reportingTimezoneFor(h.db, { user }), 'Asia/Dubai');
});

test('reportingTimezoneFor never throws on a missing db / empty context', () => {
  assert.equal(tz.reportingTimezoneFor(null, {}), tz.PLATFORM_TIMEZONE);
  assert.equal(tz.reportingTimezoneFor(undefined), tz.PLATFORM_TIMEZONE);
});
