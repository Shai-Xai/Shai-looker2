// Keeps the AI audit honest. Every hardcoded system prompt in insights.js must
// be exposed through promptRegistry() — that registry powers the Admin → AI
// "Everything the AI is told" screen and the resolved-prompt tool. If someone
// adds a new prompt const but forgets to register it, the audit would silently
// miss it; this test fails the build instead.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const insights = require('../server/insights');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'insights.js'), 'utf8');

// Top-level system-prompt consts: the tile one is `SYSTEM`; the rest end `_SYSTEM`.
// Only template-literal consts (the prompts) — `= \``.
function declaredSystemConsts() {
  const names = new Set();
  const re = /^const\s+([A-Z][A-Z0-9_]*)\s*=\s*`/gm;
  let m;
  while ((m = re.exec(SRC))) if (/SYSTEM$/.test(m[1])) names.add(m[1]);
  return [...names];
}

// The body of promptRegistry(), to confirm each const is wired in by name.
function registryBody() {
  const i = SRC.indexOf('function promptRegistry()');
  assert.ok(i !== -1, 'promptRegistry() must exist in insights.js');
  const start = SRC.indexOf('{', i);
  let depth = 0;
  for (let j = start; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) return SRC.slice(start, j + 1);
  }
  throw new Error('could not find the end of promptRegistry()');
}

test('every built-in system prompt is exposed in promptRegistry (AI audit stays complete)', () => {
  const body = registryBody();
  const missing = declaredSystemConsts().filter((name) => !new RegExp(`\\b${name}\\b`).test(body));
  assert.deepEqual(missing, [], `Add these to promptRegistry() so the Admin → AI audit shows every prompt: ${missing.join(', ')}`);
});

test('promptRegistry entries are well-formed', () => {
  for (const p of insights.promptRegistry()) {
    assert.ok(p.key && p.label && p.scope, `registry entry missing key/label/scope: ${JSON.stringify(p)}`);
    assert.ok(typeof p.text === 'string' && p.text.length > 20, `registry entry "${p.key}" has no prompt text`);
  }
});
