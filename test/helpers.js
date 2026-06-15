// Shared setup for the server test suite.
//
// IMPORTANT: this module sets DATA_DIR / DB_FILE to a throwaway location BEFORE
// requiring server/db.js, because db.js opens the SQLite database at load time.
// Each test file runs in its own process (node --test), so each gets a fresh,
// isolated database — no cross-test state.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-test-'));
process.env.DATA_DIR = dir;
process.env.DB_FILE = path.join(dir, 'test.db');
// Keep the suite hermetic: with no Looker credentials, the scope resolver's
// last-resort live lookup must fail closed rather than reach out to a network.
delete process.env.LOOKER_BASE_URL;
delete process.env.LOOKER_CLIENT_ID;
delete process.env.LOOKER_CLIENT_SECRET;

const db = require('../server/db');
const auth = require('../server/auth');
const roles = require('../server/roles');

// The canonical organiser field — the entity-level lock that is force-scoped
// onto every Looker query (see server/auth.js).
const ORG_FIELD = 'core_organisers.name';

// A SHARED dashboard (no owner) that declares the organiser filter on an
// explore. The scope resolver builds its explore→organiser-field index from the
// saved dashboards, so this lets `scopeForQuery` resolve the organiser field for
// `model::view` WITHOUT calling Looker — mirroring a real imported dashboard.
function seedOrganiserDashboard({ model = 'ticketing', explore = 'core' } = {}) {
  return db.createDashboard({
    title: 'Org-scoped dashboard',
    ownerEntityId: '', // shared — owns the explore's organiser field
    filters: [{ name: 'Organiser', field: ORG_FIELD, dimension: ORG_FIELD, model, explore }],
    tiles: [{ id: 't1', type: 'vis', title: 'Sales', query: { model, view: explore, fields: [`${explore}.count`] } }],
  });
}

// Create a client entity whose forced scope is `orgValue` (or unscoped if null).
function makeEntity(name, orgValue, { allOrganisers = false } = {}) {
  const e = db.createEntity({ name, lockedFilters: orgValue ? { [ORG_FIELD]: orgValue } : {} });
  if (allOrganisers) db.updateEntity(e.id, { allOrganisers: true });
  return db.getEntity(e.id);
}

// A client user, member of the given entities (returns the FULL user with
// memberships, which the scope/permission functions expect).
function makeClient(email, entityIds, role) {
  const pub = db.createUser({ email, password: 'pw-' + crypto.randomUUID(), role: 'client', entityIds });
  if (role) for (const eid of entityIds) db.setMembershipRole(pub.id, eid, role);
  return db.getUser(pub.id);
}

function makeAdmin(email = 'admin@test.local') {
  const pub = db.createUser({ email, password: 'pw-' + crypto.randomUUID(), role: 'admin' });
  return db.getUser(pub.id);
}

module.exports = { db, auth, roles, ORG_FIELD, seedOrganiserDashboard, makeEntity, makeClient, makeAdmin };
