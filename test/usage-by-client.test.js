// Per-client usage: a user's dashboard opens are attributed to the client whose
// suite they happened in, grouped + ranked for the admin profile view.

const { test } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');

const db = h.db;

test('usageByClientForUser groups views by the suite\'s client, ranked by volume', () => {
  const acme = h.makeEntity('Acme', 'AcmeOrg');
  const beta = h.makeEntity('Beta', 'BetaOrg');
  const sAcme = db.createSuite({ entityId: acme.id, name: 'Acme suite' });
  const sBeta = db.createSuite({ entityId: beta.id, name: 'Beta suite' });
  const dash = db.createDashboard({ title: 'Sales' });
  const user = h.makeClient(`u-${Date.now()}@t.com`, [acme.id, beta.id]);

  db.recordView(user.id, sAcme.id, dash.id);
  db.recordView(user.id, sAcme.id, dash.id);
  db.recordView(user.id, sAcme.id, dash.id);
  db.recordView(user.id, sBeta.id, dash.id);
  db.recordView(user.id, '', dash.id); // no suite context → unattributable, skipped

  const out = db.usageByClientForUser(user.id);
  assert.equal(out.length, 2, 'two clients with attributed usage');
  assert.equal(out[0].entityName, 'Acme', 'busiest client first');
  assert.equal(out[0].views, 3);
  assert.equal(out[0].topDashboards[0].title, 'Sales');
  assert.equal(out[0].topDashboards[0].count, 3);
  assert.equal(out[1].entityName, 'Beta');
  assert.equal(out[1].views, 1);
});

test('usageByClientForUser is empty for a user with no attributable views', () => {
  const user = h.makeClient(`empty-${Date.now()}@t.com`, []);
  assert.deepEqual(db.usageByClientForUser(user.id), []);
});
