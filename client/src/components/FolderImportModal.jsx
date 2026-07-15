import { useState } from 'react';
import { api } from '../lib/api.js';
import { folderExists, suggestUniqueFolder, retargetRoot, rootSegment } from '../lib/folderImport.js';

// Folder-import preview: a table of Looker folders → dashboards, each with an
// Import button (plus per-folder and import-all), and a progress bar.
//
// `existingFolders` is the list of folder paths already used in Pulse. When the
// import root name already exists there, we DON'T silently merge — we default to
// creating a SEPARATE folder (auto-suggested modified name) and let the admin
// opt into merging instead. Subfolders + dashboards follow the chosen root.
export default function FolderImportModal({ preview, alreadyImported, existingFolders = [], onClose, onImported }) {
  const rootName = preview.name || 'Imported folder';
  // Destination folder in Pulse, chosen UP FRONT. Defaults to the Looker folder's
  // name, but auto-suggests a free name if that already exists so we never
  // silently merge by accident. The admin can point it at any existing or new
  // Pulse folder before importing anything.
  const [dest, setDest] = useState(() => folderExists(rootName, existingFolders) ? suggestUniqueFolder(rootName, existingFolders) : rootName);
  const destTrim = dest.trim();
  const destExists = folderExists(destTrim, existingFolders);
  const folderRoots = [...new Set((existingFolders || []).map(rootSegment).filter(Boolean))].sort();
  const hasSubfolders = preview.folders.some((f) => (f.depth || 0) > 0);

  // status: dashboardId -> 'idle' | 'importing' | 'done' | 'error'
  const [status, setStatus] = useState(() => {
    const init = {};
    for (const f of preview.folders) for (const d of f.dashboards) {
      if (alreadyImported?.has(String(d.id))) init[d.id] = 'done';
    }
    return init;
  });
  const [busy, setBusy] = useState(false);

  // Every dashboard is filed under the chosen destination: the Looker root segment
  // of each path is re-rooted onto `dest`, so subfolders keep their names nested
  // beneath it. Falls back to the Looker name if the field is cleared.
  const folderFor = (f) => retargetRoot(f.path || f.name, rootName, destTrim || rootName);

  const all = preview.folders.flatMap((f) => f.dashboards.map((d) => ({ ...d, folderName: folderFor(f) })));
  const total = all.length;
  const doneCount = all.filter((d) => status[d.id] === 'done').length;
  const pct = total ? Math.round((doneCount / total) * 100) : 0;

  async function importOne(d, folderName) {
    if (status[d.id] === 'done' || status[d.id] === 'importing') return;
    setStatus((s) => ({ ...s, [d.id]: 'importing' }));
    try {
      await api.importDashboard(String(d.id), undefined, folderName);
      setStatus((s) => ({ ...s, [d.id]: 'done' }));
      onImported?.();
    } catch (e) {
      setStatus((s) => ({ ...s, [d.id]: 'error' }));
    }
  }
  async function importMany(list) {
    setBusy(true);
    for (const d of list) {
      if (status[d.id] === 'done') continue;
       
      await importOne(d, d.folderName);
    }
    setBusy(false);
  }

  return (
    <div style={overlay} onClick={busy ? undefined : onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>Import from Looker</div>
            <div style={{ fontSize: 17, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{preview.name}</div>
          </div>
          <button style={btn} onClick={() => importMany(all)} disabled={busy || doneCount === total || !destTrim}>{busy ? 'Importing…' : `Import all (${total - doneCount})`}</button>
          <button style={closeBtn} onClick={onClose} aria-label="Close" disabled={busy}>✕</button>
        </div>

        {/* Destination — chosen before importing. Type a new name or pick an
            existing Pulse folder; everything is filed under it. */}
        <div style={destSection}>
          <label htmlFor="dest-folder" style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 6 }}>Save to folder</label>
          <input id="dest-folder" list="pulse-folder-roots" style={{ ...destInput, ...(destTrim ? null : { borderColor: 'var(--error)' }) }} value={dest} onChange={(e) => setDest(e.target.value)} disabled={busy} placeholder="Folder name — e.g. Festivals" aria-label="Destination folder" />
          <datalist id="pulse-folder-roots">{folderRoots.map((r) => <option key={r} value={r} />)}</datalist>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, lineHeight: 1.4 }}>
            {!destTrim ? 'Enter a folder to save these dashboards under.'
              : destExists ? <>Merges into your existing <b style={{ color: 'var(--text)' }}>{destTrim}</b> folder.</>
              : <>Creates a new folder <b style={{ color: 'var(--text)' }}>{destTrim}</b>.</>}
            {hasSubfolders && destTrim && ' Subfolders keep their names under it.'}
          </div>
        </div>

        {/* Progress bar */}
        <div style={{ padding: '10px 18px 4px' }}>
          <div style={progressTrack}><div style={{ ...progressFill, width: `${pct}%` }} /></div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 5 }}>
            {doneCount} of {total} imported · {pct}%
            {destTrim && <> · filing under <b style={{ color: 'var(--text)' }}>{destTrim}</b></>}
          </div>
        </div>

        <div style={body}>
          {preview.folders.map((f) => {
            const remaining = f.dashboards.filter((d) => status[d.id] !== 'done').length;
            return (
              <div key={f.id} style={{ marginBottom: 14 }}>
                <div style={folderRow}>
                  <span style={{ paddingLeft: (f.depth || 0) * 14 }}>📁 <b>{f.name}</b> <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({f.dashboards.length})</span></span>
                  <div style={{ flex: 1 }} />
                  {remaining > 0 && <button style={miniBtn} onClick={() => importMany(f.dashboards.map((d) => ({ ...d, folderName: folderFor(f) })))} disabled={busy || !destTrim}>Import folder</button>}
                </div>
                {f.dashboards.map((d) => (
                  <div key={d.id} style={dashRow}>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingLeft: (f.depth || 0) * 14 + 18 }}>{d.title}</span>
                    <StatusButton status={status[d.id]} onClick={() => importOne(d, folderFor(f))} busy={busy || !destTrim} />
                  </div>
                ))}
                {f.dashboards.length === 0 && <div style={{ ...dashRow, color: 'var(--muted)', paddingLeft: 18 }}>No dashboards</div>}
              </div>
            );
          })}
          {total === 0 && <div style={{ color: 'var(--muted)', padding: 12 }}>This folder has no dashboards.</div>}
        </div>
      </div>
    </div>
  );
}

function StatusButton({ status, onClick, busy }) {
  if (status === 'done') return <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--success, #10b981)' }}>✓ Imported</span>;
  if (status === 'importing') return <span style={{ fontSize: 12, color: 'var(--muted)' }}>Importing…</span>;
  if (status === 'error') return <button style={{ ...rowBtn, color: 'var(--error)', borderColor: '#f0c0c0' }} onClick={onClick}>Retry</button>;
  return <button style={rowBtn} onClick={onClick} disabled={busy}>Import</button>;
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 600, padding: 20 };
const panel = { width: 'min(640px, 96vw)', maxHeight: '88vh', background: 'var(--card)', borderRadius: 16, boxShadow: '0 12px 48px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', overflow: 'hidden' };
const header = { display: 'flex', alignItems: 'center', gap: 10, padding: '16px 18px', borderBottom: '1px solid var(--border)' };
const body = { flex: 1, overflowY: 'auto', padding: '12px 18px 18px' };
const folderRow = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, padding: '6px 0', borderBottom: '1px solid var(--hairline)' };
const dashRow = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '7px 0' };
const progressTrack = { height: 8, borderRadius: 980, background: 'rgba(0,0,0,0.08)', overflow: 'hidden' };
const progressFill = { height: '100%', background: 'var(--brand)', borderRadius: 980, transition: 'width 0.3s ease' };
const btn = { padding: '8px 16px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const miniBtn = { padding: '5px 12px', background: 'rgba(0,0,0,0.05)', color: 'var(--text)', border: 'none', borderRadius: 980, fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const rowBtn = { padding: '5px 14px', background: 'var(--card)', color: 'var(--brand)', border: '1.5px solid var(--brand)', borderRadius: 980, fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const closeBtn = { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 17, color: '#888' };
const collisionBanner = { margin: '12px 18px 0', padding: '12px 14px', background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.35)', borderRadius: 12 };
const destSection = { margin: '12px 18px 0', padding: '12px 14px', background: 'var(--elevated, rgba(0,0,0,0.03))', border: '1px solid var(--hairline)', borderRadius: 12 };
const choiceRow = (on) => ({ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', minHeight: 40, borderRadius: 10, cursor: 'pointer', fontSize: 13, lineHeight: 1.4, background: on ? 'var(--card)' : 'transparent', border: `1px solid ${on ? 'var(--brand)' : 'var(--hairline)'}` });
const destInput = { width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: '1px solid var(--hairline)', borderRadius: 10, fontSize: 13, outline: 'none', background: 'var(--card)' };
