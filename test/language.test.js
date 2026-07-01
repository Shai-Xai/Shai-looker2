// AI content language: the language Pulse's AI writes generated copy in (briefings,
// digests, insights, campaign copy, the Owl). English is the platform default. These
// guard normalization + the AI prompt note that switches generated prose to the
// client's language without translating the app's own UI.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const language = require('../server/language');

test('normalize: unknown/blank falls back to the English platform default; known codes pass through', () => {
  assert.equal(language.normalize(''), 'en');
  assert.equal(language.normalize(null), 'en');
  assert.equal(language.normalize('made-up'), 'en');
  assert.equal(language.normalize('AF'), 'af');     // case-insensitive
  assert.equal(language.normalize(' fr '), 'fr');    // trimmed
});

test('aiNote: empty for the English default, explicit override otherwise', () => {
  assert.equal(language.aiNote('en'), '');   // prompts are already in English
  assert.equal(language.aiNote(''), '');      // blank → default → no note
  const af = language.aiNote('af');
  assert.match(af, /Afrikaans/);
  assert.match(af, /NOT English/);
  // Keep proper nouns / code untouched — guard the instruction stays in the note.
  assert.match(af, /proper nouns/i);
});

test('list: every entry is well-formed and English leads the picker', () => {
  const list = language.list();
  assert.equal(list[0].code, 'en');
  for (const l of list) {
    assert.ok(l.code && l.name && l.native, `malformed entry: ${JSON.stringify(l)}`);
    assert.equal(language.normalize(l.code), l.code, `${l.code} should be a known code`);
  }
});
