// Folder-level Days-to-go sync resolver: storage, nearest-ancestor precedence, and
// resolving the folder sync to a concrete per-dashboard sync by matching the source
// tile by TITLE. A dashboard's own sync always wins.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createFolderDaysSync = require('../server/folderDaysSync');

const stubDb = () => { const kv = new Map(); return { getSetting: (k, d = '') => (kv.has(k) ? kv.get(k) : d), setSetting: (k, v) => kv.set(k, v) }; };

test('save + read; mode off clears the folder', () => {
  const fds = createFolderDaysSync(stubDb());
  fds.save('KFF/27', { mode: 'apply', sourceTileTitle: 'Days To Go', filterName: 'Days Before Event', expr: '>={n}' });
  assert.equal(fds.read()['KFF/27'].mode, 'apply');
  fds.save('KFF/27', null);
  assert.equal('KFF/27' in fds.read(), false);
});

test('forPath: nearest configured ancestor wins; root applies everywhere', () => {
  const fds = createFolderDaysSync(stubDb());
  fds.save('', { mode: 'heading', sourceTileTitle: 'Days To Go' });
  fds.save('KFF', { mode: 'apply', sourceTileTitle: 'DTG-KFF', filterName: 'Days Before Event' });
  assert.equal(fds.forPath('KFF/27').sourceTileTitle, 'DTG-KFF'); // KFF beats root
  assert.equal(fds.forPath('Other').sourceTileTitle, 'Days To Go'); // root fallback
});

test('effectiveFor: own sync wins; else resolve the source tile by title', () => {
  const fds = createFolderDaysSync(stubDb());
  fds.save('KFF', { mode: 'apply', sourceTileTitle: 'Days To Go', filterName: 'Days Before Event', expr: '>={n}' });
  const tiles = [{ id: 't1', title: 'Sales' }, { id: 't2', title: 'Days To Go' }];

  // no own sync → folder sync resolves to the tile titled "Days To Go"
  assert.deepEqual(fds.effectiveFor({ folder: 'KFF/27', tiles }), { mode: 'apply', sourceTileId: 't2', filterName: 'Days Before Event', expr: '>={n}' });
  // own sync present → null (the caller keeps the dashboard's own)
  assert.equal(fds.effectiveFor({ folder: 'KFF/27', tiles, daysBeforeSync: { mode: 'apply', sourceTileId: 'x' } }), null);
  // no tile with that title here → folder sync doesn't apply
  assert.equal(fds.effectiveFor({ folder: 'KFF/27', tiles: [{ id: 't1', title: 'Sales' }] }), null);
  // a folder with no configured sync → null
  assert.equal(fds.effectiveFor({ folder: 'Other', tiles }), null);
});

test('withFolderSync attaches the resolved sync only when the dashboard has none', () => {
  const fds = createFolderDaysSync(stubDb());
  fds.save('KFF', { mode: 'apply', sourceTileTitle: 'Days To Go', filterName: 'Days Before Event' });
  const base = { folder: 'KFF/27', tiles: [{ id: 't2', title: 'Days To Go' }] };
  assert.equal(fds.withFolderSync(base).daysBeforeSync.sourceTileId, 't2');
  const own = { ...base, daysBeforeSync: { mode: 'apply', sourceTileId: 'own' } };
  assert.equal(fds.withFolderSync(own).daysBeforeSync.sourceTileId, 'own'); // unchanged
});
