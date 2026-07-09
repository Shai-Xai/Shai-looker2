// Queue-it stats connector — locks the pure contracts: hostname-safe customer
// ids (they become a subdomain), string→number normalisation of Queue-it's
// stats payloads, timestamping of bare detail entries, and — the security-
// sensitive one — room visibility on the shared platform account (a client must
// NEVER see another client's waiting rooms).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const q = require('../server/queueit');

test('customer id must be hostname-safe (it becomes a subdomain)', () => {
  assert.equal(q.validCustomerId('howler'), true);
  assert.equal(q.validCustomerId('Howler-2'), true);
  assert.equal(q.validCustomerId(''), false);
  assert.equal(q.validCustomerId('bad.actor'), false);
  assert.equal(q.validCustomerId('evil/..'), false);
  assert.equal(q.validCustomerId('a'.repeat(64)), false);
  assert.equal(q.apiBase('Howler'), 'https://howler.api2.queue-it.net/2_0');
});

test('room id list accepts arrays or comma/space strings, dedupes and trims', () => {
  assert.deepEqual(q.roomIdList('a, b  c,,a'), ['a', 'b', 'c']);
  assert.deepEqual(q.roomIdList(['x', ' x ', '']), ['x']);
  assert.deepEqual(q.roomIdList(null), []);
});

test('summary normalises Queue-it string values to numbers (missing → null)', () => {
  const s = q.normalizeSummary({ TotalWaitingInQueueCount: '1523', NoOfRedirectsLastMinute: '60', TotalQueueCount: 'not-a-number', VersionTimestamp: '2026-07-09T10:00:00Z' });
  assert.equal(s.waitingNow, 1523);
  assert.equal(s.redirectsLastMinute, 60);
  assert.equal(s.totalQueued, null);
  assert.equal(s.totalRedirected, null);
  assert.equal(s.asOf, '2026-07-09T10:00:00Z');
});

test('detail entries are timestamped from From at the reported interval', () => {
  const minute = q.seriesFromDetails({ From: '2026-07-09T10:00:00Z', To: '2026-07-09T10:03:00Z', Interval: 'Minutes', Sum: '30', Entries: [{ Sum: '10' }, { Sum: '20' }, { Sum: null }] });
  assert.equal(minute.interval, 'minute');
  assert.equal(minute.sum, 30);
  assert.deepEqual(minute.points.map((p) => p.v), [10, 20, null]);
  assert.equal(minute.points[1].t, '2026-07-09T10:01:00.000Z');
  const hourly = q.seriesFromDetails({ From: '2026-07-01T00:00:00Z', Interval: 'Hours', Entries: [{ Sum: '1' }, { Sum: '2' }] });
  assert.equal(hourly.interval, 'hour');
  assert.equal(hourly.points[1].t, '2026-07-01T01:00:00.000Z');
});

test('waiting rooms normalise from DtoMinimalReadEvent', () => {
  const r = q.normalizeRoom({ EventId: 'summersale', DisplayName: 'Summer Sale', QueueStatusText: 'Running', WaitingRoomType: 'Scheduled', IsTest: 'False', MaxRedirectsPerMinute: 120 });
  assert.deepEqual({ id: r.id, name: r.name, status: r.status, isTest: r.isTest, max: r.maxRedirectsPerMinute }, { id: 'summersale', name: 'Summer Sale', status: 'Running', isTest: false, max: 120 });
});

test('platform-account clients see ONLY their assigned rooms — never the whole account', () => {
  const rooms = [{ id: 'clientA-sale' }, { id: 'clientB-sale' }];
  // Shared platform creds + no assignment → nothing (no leak).
  assert.deepEqual(q.visibleRooms(rooms, { scope: 'my', source: 'platform', assignedIds: '' }), []);
  // Shared platform creds + assignment → only the assigned room (case-insensitive).
  assert.deepEqual(q.visibleRooms(rooms, { scope: 'my', source: 'platform', assignedIds: 'ClientA-Sale' }), [{ id: 'clientA-sale' }]);
  // Client's OWN account + no assignment → all their rooms.
  assert.equal(q.visibleRooms(rooms, { scope: 'my', source: 'client', assignedIds: '' }).length, 2);
  // Admin scope always sees everything on the resolved account.
  assert.equal(q.visibleRooms(rooms, { scope: 'admin', source: 'platform', assignedIds: '' }).length, 2);
});

test('integrations slice: patch writes only what changed, view never exposes the key', () => {
  const writes = {};
  q.applyPatch({ queueit: { customerId: ' Howler ', apiKey: ' k-123 ' } }, (k, v) => { writes[k] = v; });
  assert.deepEqual(writes, { queueitCustomerId: 'howler', queueitApiKey: 'k-123' });
  const cleared = {};
  q.applyPatch({ queueit: { clearApiKey: true } }, (k, v) => { cleared[k] = v; });
  assert.deepEqual(cleared, { queueitApiKey: '' });
  const v = q.view({ queueitCustomerId: 'howler', queueitApiKey: 'k-123', queueitWaitingRoomIds: 'a,b' }, (s) => (s ? '••1' : ''));
  assert.deepEqual(v, { customerId: 'howler', keySet: true, keyHint: '••1', waitingRoomIds: ['a', 'b'] });
  assert.equal(JSON.stringify(v).includes('k-123'), false);
});
