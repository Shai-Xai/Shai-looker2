// Scenario simulations as CI assertions. scripts/journeySim.js drives the REAL
// branching engine (server/journeys.js) with fake people — opens, clicks, buys,
// ticket types, segment membership, waits — over an in-memory DB with stubbed
// senders. Here we turn each persona's expected outcome (final status + the exact
// messages received, in order) into a test. Run the readable report with:
//   node scripts/journeySim.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SCENARIOS, simulate, personaOk } = require('../scripts/journeySim');

for (const scn of SCENARIOS) {
  test(`journey simulation: ${scn.name}`, async () => {
    const results = await simulate(scn);
    for (const p of results) {
      assert.equal(p.status, p.expect.status, `${p.name} (${p.behaviour}) ended '${p.status}', expected '${p.expect.status}'`);
      assert.deepEqual(p.got.map((s) => s.subject), p.expect.got, `${p.name} (${p.behaviour}) received the wrong messages / order`);
      if (p.expect.syncs) assert.ok(personaOk(p), `${p.name} (${p.behaviour}) triggered the wrong ad-audience syncs: got ${JSON.stringify(p.syncs)}, expected ${JSON.stringify(p.expect.syncs)}`);
    }
  });
}
