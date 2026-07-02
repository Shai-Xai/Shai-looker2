import { useState } from 'react';
import { api } from '../lib/api.js';
import { folderExists, suggestUniqueFolder, retargetRoot } from '../lib/folderImport.js';

// Folder-import preview: a table of Looker folders → dashboards, each with an
// Import button (plus per-folder and import-all), and a progress bar.
//
// `existingFolders` is the list of folder paths already used in Pulse. When the
// import root name already exists there, we DON'T silently merge — we default to
// creating a SEPARATE folder (auto-suggested modified name) and let the admin
// opt into merging instead. Subfolders + dashboards follow the chosen root.
export default function FolderImportModal({ preview, alreadyImported, existingFolders = [], onClose, onImported }) {
  const rootName = preview.name || 'Imported folder';
  const collides = folderExists(rootName, existingFolders);
  // Default to keeping the import isolated (merge is the explicit opt-in).
  const [mode, setMode] = useState(collides ? 'new' : 'merge'); // 'new' | 'merge'
  const [destRoot, setDestRoot] = useState(() => suggestUniqueFolder(rootName, existingFolders));

  // status: dashboardId -> 'idle' | 'importing' | 'done' | 'error'
  const [status, setStatus] = useState(() => {
    const init = {};
    for (const f of preview.folders) for (const d of f.dashboards) {
      if (alreadyImported?.has(String(d.id))) init[d.id] = 'done';
    }
    return init;
  });
  const [busy, setBusy] = useState(false);

  // Resolve a preview folder to its final Pulse destination path, applying the
  // collision choice: on "new" we re-root the whole path onto the (unique) name;
  // on "merge" the original Looker path is kept as-is.
  const creatingNew = collides && mode === 'new';
  const folderFor = (f) => {
    const orig = f.path || f.name;
    return creatingNew ? retargetRoot(orig, rootName, destRoot) : orig;
  };
  // Whether the currently-typed separate-folder name would ITSELF collide.
  const destStillCollides = creatingNew && folderExists(destRoot, existingFolders);

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
          <button style={btn} onClick={() => importMany(all)} disabled={busy || doneCount === total}>{busy ? 'Importing…' : `Import all (${total - doneCount})`}</button>
          <button style={closeBtn} onClick={onClose} aria-label="Close" disabled={busy}>✕</button>
        </div>

        {/* Collision banner — the import root name already exists in Pulse. */}
        {collides && (
          <div style={collisionBanner}>
            <div style={{ fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>⚠️</span> A folder named “{rootName}” already exists
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 }}>
              Choose whether to keep this import separate or merge it into the existing folder.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
              <label style={choiceRow(mode === 'new')}>
                <input type="radio" name="collision" checked={mode === 'new'} onChange={() => setMode('new')} disabled={busy} style={{ marginTop: 2 }} />
                <span style={{ flex: 1 }}>
                  <b>Create a separate folder</b> <span style={{ color: 'var(--muted)' }}>(recommended)</span>
                  <div style={{ marginTop: 6 }}>
                    <input
                      style={{ ...destInput, ...(destStillCollides ? { borderColor: 'var(--error)' } : null) }}
                      value={destRoot}
                      onChange={(e) => setDestRoot(e.target.value)}
                      disabled={busy || mode !== 'new'}
                      aria-label="New folder name"
                      placeholder="New folder name"
                    />
                    {destStillCollides && <div style={{ fontSize: 11.5, color: 'var(--error)', marginTop: 4 }}>That name is also taken — pick another to avoid merging.</div>}
                  </div>
                </span>
              </label>
              <label style={choiceRow(mode === 'merge')}>
                <input type="radio" name="collision" checked={mode === 'merge'} onChange={() => setMode('merge')} disabled={busy} style={{ marginTop: 2 }} />
                <span style={{ flex: 1 }}>
                  <b>Merge into “{rootName}”</b>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>New dashboards are filed into the existing folder.</div>
                </span>
              </label>
            </div>
          </div>
        )}

        {/* Progress bar */}
        <div style={{ padding: '10px 18px 4px' }}>
          <div style={progressTrack}><div style={{ ...progressFill, width: `${pct}%` }} /></div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 5 }}>
            {doneCount} of {total} imported · {pct}%
            {creatingNew && destRoot.trim() && <> · filing under <b style={{ color: 'var(--text)' }}>{destRoot.trim()}</b></>}
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
                  {remaining > 0 && <button style={miniBtn} onClick={() => importMany(f.dashboards.map((d) => ({ ...d, folderName: folderFor(f) })))} disabled={busy}>Import folder</button>}
                </div>
                {f.dashboards.map((d) => (
                  <div key={d.id} style={dashRow}>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingLeft: (f.depth || 0) * 14 + 18 }}>{d.title}</span>
                    <StatusButton status={status[d.id]} onClick={() => importOne(d, folderFor(f))} busy={busy} />
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
const choiceRow = (on) => ({ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', minHeight: 40, borderRadius: 10, cursor: 'pointer', fontSize: 13, lineHeight: 1.4, background: on ? 'var(--card)' : 'transparent', border: `1px solid ${on ? 'var(--brand)' : 'var(--hairline)'}` });
const destInput = { width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: '1px solid var(--hairline)', borderRadius: 10, fontSize: 13, outline: 'none', background: 'var(--card)' };
