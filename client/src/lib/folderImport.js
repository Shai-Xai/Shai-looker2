// Pure helpers for Looker folder-import collision handling.
//
// Pulse folders are just "/"-separated path strings stored on each dashboard —
// there is no folder entity. So a "collision" is simply an import whose root
// folder name already exists among the current dashboards' folder paths. When
// that happens we let the admin CREATE A SEPARATE folder (with an auto-suggested
// modified name) instead of silently merging new dashboards into the existing
// one. Merge stays available as an explicit choice.
//
// Kept dependency-free so the logic is unit-testable outside React.

// The top-level segment of a "/"-separated folder path.
export function rootSegment(path) {
  return String(path || '').split('/')[0];
}

// Does `name` already exist as a top-level folder among `existing` paths?
// True if any existing path equals `name` or is nested under it (a subfolder),
// since either way new dashboards would land inside the pre-existing folder.
export function folderExists(name, existing) {
  const n = String(name || '').trim();
  if (!n) return false;
  for (const f of existing || []) {
    const p = String(f || '');
    if (p === n || p.startsWith(n + '/')) return true;
  }
  return false;
}

// Suggest a non-colliding folder name by appending " (2)", " (3)", … until free.
export function suggestUniqueFolder(name, existing) {
  const base = String(name || '').trim() || 'Imported folder';
  if (!folderExists(base, existing)) return base;
  let i = 2;
  for (; i < 1000; i++) {
    const candidate = `${base} (${i})`;
    if (!folderExists(candidate, existing)) return candidate;
  }
  return `${base} (${i})`; // pathological fallback (1000 collisions)
}

// Rewrite the leading root segment of a folder path from `oldRoot` → `newRoot`,
// keeping every nested subfolder intact. This is what routes subfolders and
// dashboards into the chosen destination when creating a separate folder, e.g.
//   retargetRoot("Festivals/Bushfire/Cashless", "Festivals", "Festivals (2)")
//     → "Festivals (2)/Bushfire/Cashless"
export function retargetRoot(path, oldRoot, newRoot) {
  const dest = String(newRoot || '').trim();
  if (!dest) return String(path || '');
  const segs = String(path || '').split('/');
  if (segs[0] === oldRoot) segs[0] = dest;
  return segs.join('/');
}
