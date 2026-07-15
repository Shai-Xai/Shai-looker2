// ─── Folder-level days-to-go sync (live cascade) ──────────────────────────────
// A persistent, per-folder Days-to-go sync that EVERY dashboard in the folder
// (+ subfolders, incl. ones added later) inherits at view time — set once for a
// folder instead of on every dashboard. Because a folder can't point at one
// dashboard's tile, the source tile is matched by TITLE within each dashboard
// (and the days-before filter by name), which works because folder-mates share
// the "Days To Go" tile/filter names.
//
// A dashboard's OWN daysBeforeSync always wins; the folder's applies only when the
// dashboard has none. Stored in the settings KV (folder_days_sync) as
// { "<folderPath>": { mode, sourceTileTitle, filterName, expr } }; the nearest
// configured ancestor folder wins ('' = root, applies everywhere). A factory over
// db so both the dashboard-serve path and the briefing overlay resolve it the same
// way — the effective sync is a concrete { mode, sourceTileId, filterName, expr },
// so all the existing days-before machinery works unchanged.

module.exports = function createFolderDaysSync(db) {
  const KEY = 'folder_days_sync';
  const read = () => { try { return JSON.parse(db.getSetting(KEY, '{}')) || {}; } catch { return {}; } };
  const write = (m) => db.setSetting(KEY, JSON.stringify(m));

  // The nearest configured ancestor folder's sync for a path (most specific wins).
  function forPath(path) {
    const p = String(path || '');
    const m = read();
    let best = null; let bestLen = -1;
    for (const [folder, sync] of Object.entries(m)) {
      if (!sync || !sync.mode || sync.mode === 'off') continue;
      const match = folder === '' ? true : (p === folder || p.startsWith(`${folder}/`));
      if (match && folder.length > bestLen) { best = sync; bestLen = folder.length; }
    }
    return best;
  }

  // The concrete daysBeforeSync a dashboard should USE: its own if set, else the
  // folder's with the source tile resolved to a real tile id by TITLE. null = none.
  function effectiveFor(def) {
    if (def && def.daysBeforeSync && def.daysBeforeSync.mode && def.daysBeforeSync.mode !== 'off') return null; // own wins
    const fs = forPath(def && def.folder);
    if (!fs) return null;
    const want = String(fs.sourceTileTitle || '').trim();
    if (!want) return null;
    const tiles = [...((def && def.tiles) || []), ...(((def && def.carousels) || []).flatMap((c) => c.tiles || []))];
    const src = tiles.find((t) => String(t.title || '').trim() === want);
    if (!src) return null; // no tile with that title here → folder sync doesn't apply
    return { mode: fs.mode, sourceTileId: src.id, filterName: fs.filterName, expr: fs.expr || '>={n}' };
  }

  // Attach the effective folder sync onto a def when it has none of its own — so a
  // caller can hand the augmented def straight to the existing sync machinery.
  function withFolderSync(def) {
    const eff = effectiveFor(def);
    return eff ? { ...def, daysBeforeSync: eff } : def;
  }

  function save(folder, sync) {
    const m = read();
    const key = String(folder || '');
    if (!sync || !sync.mode || sync.mode === 'off') delete m[key];
    else m[key] = {
      mode: String(sync.mode),
      sourceTileTitle: String(sync.sourceTileTitle || '').slice(0, 200),
      filterName: String(sync.filterName || '').slice(0, 200),
      expr: String(sync.expr || '>={n}').slice(0, 120),
    };
    write(m);
    return m[key] || null;
  }

  return { read, save, forPath, effectiveFor, withFolderSync };
};
