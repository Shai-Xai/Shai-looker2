// Keeps the server from drifting back into god-files. Every server/*.js has a
// line budget; the test fails if a file grows past it. The budgets RATCHET DOWN
// ONLY — when a file legitimately needs to grow past its budget, that's the
// signal to extract a disposable module (a self-contained feature that owns its
// tables + routes and mounts in one line — see CLAUDE.md "disposable modules"),
// NOT to raise the number. When you shrink a file, lower its budget to lock the
// win in. Never raise a budget.
//
// New files aren't in the map and get DEFAULT_CAP — so nothing is born a
// monolith. (server/index.js is the composition root and is intentionally the
// largest; its budget should keep falling as more clusters are extracted.)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const DEFAULT_CAP = 1500; // any new/untracked server file must stay under this

// Per-file ceilings (lines). Lower these as files shrink; never raise them.
const BUDGETS = {
  'index.js': 2950,    // composition root — keep extracting; ratchet down (integrations patch/views → integrationsConfig.js)
  'actions.js': 1690,   // tracking/tokens/approvals/automations extracted; preview+test-send → actionPreview.js
  'db.js': 1620,     // tile-library cluster extracted to tileLibrary.js — locked in lower
  'insights.js': 1100,   // JSON-salvage layer extracted to aiJson.js — locked in lower
  'goals.js': 1100,
};

function lineCount(file) {
  return fs.readFileSync(path.join(SERVER_DIR, file), 'utf8').split('\n').length;
}

test('no server file exceeds its line budget (extract a module instead of growing one)', () => {
  const offenders = [];
  for (const file of fs.readdirSync(SERVER_DIR)) {
    if (!file.endsWith('.js')) continue;
    const lines = lineCount(file);
    const cap = BUDGETS[file] ?? DEFAULT_CAP;
    if (lines > cap) {
      const how = file in BUDGETS
        ? `over its budget (${cap}) — extract a disposable module, don't raise the budget`
        : `over the ${DEFAULT_CAP}-line cap for a module — split it before it becomes a god-file`;
      offenders.push(`server/${file}: ${lines} lines, ${how}`);
    }
  }
  assert.deepEqual(offenders, [], `\n${offenders.join('\n')}\n`);
});

test('index.js still mounts every critical disposable module (a merge must not silently drop one)', () => {
  // Regression guard: a parallel-session merge once concatenated a new mount onto
  // an existing line and deleted the whole `livepulse` mount with it — every Live
  // Pulse route 404'd in prod and the data looked "lost" (it wasn't; the routes
  // were just gone). A dropped mount is invisible in review, so assert the load-
  // bearing modules are still wired into the composition root.
  const src = fs.readFileSync(path.join(SERVER_DIR, 'index.js'), 'utf8');
  const mustMount = ['alerts', 'livepulse', 'eventops', 'staffAlerts', 'os', 'digests', 'goals', 'actions', 'segments', 'flags'];
  const missing = mustMount.filter((m) => !new RegExp(`require\\('\\./${m}'\\)\\.mount`).test(src) && !new RegExp(`require\\('\\./${m}'\\).*\\.mount`).test(src));
  assert.deepEqual(missing, [], `index.js is no longer mounting: ${missing.join(', ')} — restore the mount line`);
});

test('budgets ratchet down: no budget has slack to grow a file >150 lines', () => {
  // Guards the guard: if someone pads a budget far above the real size to dodge
  // the cap, flag it so budgets stay tight (lower them as files shrink).
  const slack = [];
  for (const [file, cap] of Object.entries(BUDGETS)) {
    const lines = lineCount(file);
    if (cap - lines > 150) slack.push(`server/${file}: budget ${cap} but only ${lines} lines — lower the budget toward the real size`);
  }
  assert.deepEqual(slack, [], `\n${slack.join('\n')}\n`);
});
