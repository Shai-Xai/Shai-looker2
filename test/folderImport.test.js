// Looker folder-import collision helpers: detecting when an import root name
// already exists in Pulse, suggesting a non-colliding name, and re-rooting a
// folder path so subfolders + dashboards follow the chosen destination.
// (Pure logic behind FolderImportModal's "create separate vs merge" choice.)

const { test } = require('node:test');
const assert = require('node:assert/strict');

// The helper lives in the ESM client bundle; pull it in via dynamic import.
let mod;
test.before(async () => { mod = await import('../client/src/lib/folderImport.js'); });

test('rootSegment: takes the top-level folder segment', () => {
  assert.equal(mod.rootSegment('Festivals/Bushfire/Cashless'), 'Festivals');
  assert.equal(mod.rootSegment('Solo'), 'Solo');
  assert.equal(mod.rootSegment(''), '');
  assert.equal(mod.rootSegment(null), '');
});

test('folderExists: matches an exact folder or any nested subfolder', () => {
  const existing = ['Festivals/Bushfire', 'Reports', 'Reports/Weekly'];
  assert.equal(mod.folderExists('Festivals', existing), true);   // parent of an existing path
  assert.equal(mod.folderExists('Reports', existing), true);     // exact match
  assert.equal(mod.folderExists('Reports/Weekly', existing), true);
  assert.equal(mod.folderExists('Festival', existing), false);   // not a path-segment prefix
  assert.equal(mod.folderExists('New', existing), false);
  assert.equal(mod.folderExists('', existing), false);
  assert.equal(mod.folderExists('Reports', undefined), false);   // tolerates missing list
});

test('suggestUniqueFolder: returns the name when free, else appends (n)', () => {
  assert.equal(mod.suggestUniqueFolder('New', ['Old']), 'New');
  assert.equal(mod.suggestUniqueFolder('Reports', ['Reports']), 'Reports (2)');
  assert.equal(mod.suggestUniqueFolder('Reports', ['Reports', 'Reports (2)']), 'Reports (3)');
  // A nested existing path still counts as the root being taken.
  assert.equal(mod.suggestUniqueFolder('Reports', ['Reports/Weekly']), 'Reports (2)');
  assert.equal(mod.suggestUniqueFolder('', []), 'Imported folder');
});

test('retargetRoot: rewrites only the leading segment, keeping subfolders', () => {
  assert.equal(
    mod.retargetRoot('Festivals/Bushfire/Cashless', 'Festivals', 'Festivals (2)'),
    'Festivals (2)/Bushfire/Cashless',
  );
  assert.equal(mod.retargetRoot('Festivals', 'Festivals', 'Festivals (2)'), 'Festivals (2)');
  // A non-matching root is left untouched.
  assert.equal(mod.retargetRoot('Other/Sub', 'Festivals', 'Festivals (2)'), 'Other/Sub');
  // An empty destination is a no-op (never blanks the path).
  assert.equal(mod.retargetRoot('Festivals/Sub', 'Festivals', '  '), 'Festivals/Sub');
});
