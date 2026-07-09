import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import FolderImportModal from '../components/FolderImportModal.jsx';
import FolderMoveModal from '../components/FolderMoveModal.jsx';
import BackButton from '../components/BackButton.jsx';

export default function HomePage() {
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const [dashboards, setDashboards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [importId, setImportId] = useState('');
  const [importTitle, setImportTitle] = useState('');
  const [importing, setImporting] = useState(false);
  const [importFolderName, setImportFolderName] = useState('');
  const [importKeepFilters, setImportKeepFilters] = useState(false);
  const [path, setPath] = useState(''); // current folder path; '' = top level
  // Looker-folder import
  const [lookerFolderId, setLookerFolderId] = useState('');
  const [folderPreview, setFolderPreview] = useState(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [includeSubfolders, setIncludeSubfolders] = useState(true);
  const [showFolderModal, setShowFolderModal] = useState(false);
  const [moveFolderPath, setMoveFolderPath] = useState(null); // folder being reparented via the "Move to…" picker
  const [dragFolder, setDragFolder] = useState(null); // folder path being dragged (desktop drag-and-drop)
  const [dropTarget, setDropTarget] = useState(null); // folder path currently hovered as a drop destination
  const [folderSettings, setFolderSettings] = useState({}); // { "<path>": { keepImported } } — persistent, cascading
  const [view, setView] = useState(() => localStorage.getItem('howler_lib_view') || 'list'); // 'tile' | 'list'
  const setViewMode = (v) => { setView(v); localStorage.setItem('howler_lib_view', v); };

  function load() {
    setLoading(true);
    api.listDashboards().then(setDashboards).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }
  const loadFolderSettings = () => { if (isAdmin) api.getFolderSettings().then(setFolderSettings).catch(() => {}); };
  useEffect(() => { load(); }, []);
  useEffect(() => { loadFolderSettings(); }, [isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  // Nested-folder navigation. Folders are stored as "/"-separated paths on each
  // dashboard (e.g. "Festivals/MTN Bushfire/Cashless").
  const allFolders = [...new Set(dashboards.map((d) => d.folder).filter(Boolean))];
  const folders = [...allFolders].sort((a, b) => a.localeCompare(b)); // for the import datalist
  const fullChild = (seg) => (path ? `${path}/${seg}` : seg);
  const childSegments = (() => {
    const set = new Set();
    for (const f of allFolders) {
      if (path) { if (f === path || !f.startsWith(path + '/')) continue; set.add(f.slice(path.length + 1).split('/')[0]); }
      else set.add(f.split('/')[0]);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  })();
  // Dashboards directly in this folder, sorted by name (A→Z).
  const dashHere = dashboards.filter((d) => (d.folder || '') === path).sort((a, b) => (a.title || '').localeCompare(b.title || '', undefined, { numeric: true }));
  const folderCountOf = (fp) => dashboards.filter((d) => { const f = d.folder || ''; return f === fp || f.startsWith(fp + '/'); }).length;
  const segs = path ? path.split('/') : [];

  // Persistent per-folder "📌 Imported filters": one toggle that cascades to every
  // dashboard in this folder (+ subfolders), including ones added later.
  const folderKeepOn = !!folderSettings[path]?.keepImported;
  async function toggleFolderKeepImported() {
    try { await api.setFolderKeepImported(path, !folderKeepOn); loadFolderSettings(); }
    catch (e) { alert('Could not update folder: ' + (e.message || e)); }
  }
  // Flip comparison-events charts in this folder to sort events ascending. Dry-run
  // first (counts what would change), confirm, then apply.
  async function comparisonSortAsc() {
    try {
      const dry = await api.comparisonSortAsc(path, false);
      if (!dry.changed) { alert('No comparison-event charts in this folder sort events descending — nothing to change.'); return; }
      if (!confirm(`Set ${dry.changed} comparison chart${dry.changed === 1 ? '' : 's'} in “${path}” (and subfolders) to sort events ascending?`)) return;
      await api.comparisonSortAsc(path, true);
      alert(`Updated ${dry.changed} tile${dry.changed === 1 ? '' : 's'}. Refresh a dashboard to see the new order.`);
    } catch (e) { alert('Could not update: ' + (e.message || e)); }
  }

  async function previewFolder() {
    if (!lookerFolderId.trim()) return;
    setFolderBusy(true);
    try {
      const p = await api.lookerFolder(lookerFolderId.trim(), includeSubfolders);
      setFolderPreview(p);
      setShowFolderModal(true);
    } catch (e) { alert('Could not read folder: ' + e.message); }
    finally { setFolderBusy(false); }
  }

  async function handleCreate() {
    try { const d = await api.createDashboard({ title: 'Untitled dashboard' }); navigate(`/d/${d.id}/edit`); }
    catch (e) { alert(e.message); }
  }
  async function handleImport() {
    if (!importId.trim()) return;
    setImporting(true);
    try {
      const d = await api.importDashboard(importId.trim(), importTitle.trim() || undefined, importFolderName.trim() || undefined, importKeepFilters);
      navigate(`/d/${d.id}/edit`);
    } catch (e) { alert('Import failed: ' + e.message); }
    finally { setImporting(false); }
  }
  async function syncFolders() {
    try {
      const r = await api.backfillFolders();
      alert(`Filed ${r.updated} dashboard(s) under their Looker folder.` + (r.errors?.length ? `\n${r.errors.length} could not be read.` : ''));
      load();
    } catch (e) { alert('Sync failed: ' + e.message); }
  }

  async function handleDelete(id, e) {
    e.stopPropagation();
    if (!confirm('Delete this dashboard?')) return;
    await api.deleteDashboard(id); load();
  }
  // Move a dashboard into a folder. Accepts a nested path (e.g. "A/B").
  async function moveToFolder(d, e) {
    e.stopPropagation();
    const name = prompt(`Folder for "${d.title}" — use "/" for subfolders (blank = unfiled):`, d.folder || '');
    if (name === null) return;
    await api.updateDashboard(d.id, { folder: name.trim().replace(/^\/+|\/+$/g, '') });
    load();
  }
  // Rename a folder (its leaf), rippling to every dashboard nested under it.
  async function renameFolder(fullPath, e) {
    if (e) e.stopPropagation();
    if (!fullPath) return;
    const leaf = fullPath.split('/').pop();
    const next = prompt(`Rename folder "${leaf}" to:`, leaf);
    if (next === null) return;
    const to = next.trim();
    if (!to || to === leaf) return;
    try {
      await api.renameFolder(fullPath, to);
      const parent = fullPath.includes('/') ? fullPath.slice(0, fullPath.lastIndexOf('/') + 1) : '';
      if (path === fullPath || path.startsWith(fullPath + '/')) setPath((parent + to) + path.slice(fullPath.length));
      load();
    } catch (err) { alert('Rename failed: ' + err.message); }
  }
  // Delete a folder and everything nested under it (removes those dashboards).
  async function deleteFolderAction(fullPath, e) {
    if (e) e.stopPropagation();
    if (!fullPath) return;
    const count = dashboards.filter((d) => { const f = d.folder || ''; return f === fullPath || f.startsWith(fullPath + '/'); }).length;
    if (!confirm(`Delete folder "${fullPath.split('/').pop()}" and its ${count} dashboard${count === 1 ? '' : 's'} (including subfolders)? This cannot be undone.`)) return;
    try {
      await api.deleteFolder(fullPath);
      if (path === fullPath || path.startsWith(fullPath + '/')) setPath(fullPath.includes('/') ? fullPath.slice(0, fullPath.lastIndexOf('/')) : '');
      load();
    } catch (err) { alert('Delete failed: ' + err.message); }
  }
  // Reparent a folder (with ALL its nested subfolders + dashboards) in one atomic
  // move. `from` moves under `parent` ('' = top level). Keeps the breadcrumb in
  // sync if you're standing inside the folder that just moved. Throws on failure
  // so callers (the picker modal) can surface the server's message.
  async function doMoveFolder(from, parent) {
    const leaf = from.split('/').pop();
    const newPath = parent ? `${parent}/${leaf}` : leaf;
    await api.moveFolder(from, parent);
    if (path === from || path.startsWith(from + '/')) setPath(newPath + path.slice(from.length));
    setMoveFolderPath(null);
    load();
  }
  // Drag-and-drop (desktop): dropping a folder card onto another folder moves it
  // inside. Invalid drops (onto itself / a descendant) are ignored; the server is
  // the final guard and any error is surfaced.
  function canDropInto(from, target) {
    return from && from !== target && !(target || '').startsWith(from + '/') && target !== (from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '');
  }
  async function handleFolderDrop(target) {
    const from = dragFolder;
    setDragFolder(null); setDropTarget(null);
    if (!from || !canDropInto(from, target)) return;
    try { await doMoveFolder(from, target); }
    catch (err) { alert('Move failed: ' + (err.message || err)); }
  }

  return (
    <main style={{ flex: 1, padding: '32px 24px', maxWidth: 1100, margin: '0 auto', width: '100%' }}>
      {isAdmin && (
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 28 }}>
        <div style={cardStyle}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Build from scratch</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>Start with a blank canvas and add tiles backed by your Looker metrics.</div>
          <button style={primaryBtn} onClick={handleCreate}>+ New dashboard</button>
        </div>

        <div style={cardStyle}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Replicate a Looker dashboard</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>Import an existing Looker dashboard. It becomes fully editable here.</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input style={inputStyle} placeholder="Looker dashboard ID" value={importId} onChange={(e) => setImportId(e.target.value)} />
            <input style={inputStyle} placeholder="New title (optional)" value={importTitle} onChange={(e) => setImportTitle(e.target.value)} />
            <input style={inputStyle} placeholder="Folder (optional)" value={importFolderName} onChange={(e) => setImportFolderName(e.target.value)} list="folder-list" />
            <button style={primaryBtn} onClick={handleImport} disabled={importing || !importId.trim()}>{importing ? 'Importing…' : 'Import'}</button>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--muted)', marginTop: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={importKeepFilters} onChange={(e) => setImportKeepFilters(e.target.checked)} />
            📌 Keep Looker's default filters (client/user/lock settings won't override them)
          </label>
          <div style={{ marginTop: 10, fontSize: 12 }}><Link to="/clone" style={{ color: 'var(--muted)' }}>Or clone directly inside Looker →</Link></div>
        </div>

        <div style={cardStyle}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Import a Looker folder</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>Bring in every dashboard in a Looker folder at once. With subfolders included, each dashboard is filed under its own Looker (sub)folder name.</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input style={inputStyle} placeholder="Looker folder ID" value={lookerFolderId} onChange={(e) => setLookerFolderId(e.target.value)} />
            <button style={primaryBtn} onClick={previewFolder} disabled={folderBusy || !lookerFolderId.trim()}>{folderBusy ? 'Reading…' : 'Preview & import'}</button>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 10, fontSize: 13, color: 'var(--text)', cursor: 'pointer' }}>
            <input type="checkbox" checked={includeSubfolders} onChange={(e) => setIncludeSubfolders(e.target.checked)} />
            Include subfolders
          </label>
        </div>
      </div>
      )}

      {/* shared datalist of existing folders for the import input */}
      <datalist id="folder-list">{folders.map((f) => <option key={f} value={f} />)}</datalist>

      {/* Header: back + breadcrumb + actions. The back button steps UP a folder
          when you're inside one, otherwise returns to the previous page. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        {path
          ? <button onClick={() => setPath(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')} title="Up a folder" aria-label="Up a folder" className="btn-key" style={homeBackBtn}>
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
          : <BackButton fallback="/admin" />}
        <h2 style={{ fontSize: 18, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <button style={crumbBtn} onClick={() => setPath('')}>{isAdmin ? 'Your dashboards' : 'Dashboards'}</button>
          {segs.map((s, i) => (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: 'var(--muted)' }}>/</span>
              <button style={crumbBtn} onClick={() => setPath(segs.slice(0, i + 1).join('/'))}>{s}</button>
            </span>
          ))}
        </h2>
        {isAdmin && path && (
          <>
            <button style={{ ...miniBtnOutline, fontSize: 12 }} onClick={(e) => renameFolder(path, e)} title="Rename this folder">✎ Rename</button>
            <button style={{ ...miniBtnOutline, fontSize: 12 }} onClick={() => setMoveFolderPath(path)} title="Move this folder (with everything inside) elsewhere">↗ Move</button>
            <button
              style={{ ...miniBtnOutline, fontSize: 12, ...(folderKeepOn ? { background: 'var(--success,#10b981)', borderColor: 'var(--success,#10b981)', color: '#fff' } : null) }}
              onClick={toggleFolderKeepImported}
              title="When ON, the imported (Looker) default filters are authoritative for EVERY dashboard in this folder (incl. subfolders, and ones added later) — client defaults, saved views & suite locks won't override them.">
              📌 Imported filters: {folderKeepOn ? 'On' : 'Off'}
            </button>
            <button style={{ ...miniBtnOutline, fontSize: 12 }} onClick={comparisonSortAsc} title="Set comparison-events charts in this folder (and subfolders) to sort events ascending (chronological). Skips offset ‘change’ tiles and measure sorts.">↕ Comparison → Asc</button>
            <button style={{ ...miniBtnOutline, fontSize: 12, color: 'var(--error)' }} onClick={(e) => deleteFolderAction(path, e)} title="Delete this folder">🗑 Delete</button>
          </>
        )}
        {isAdmin && !path && dashboards.some((d) => !d.folder) && (
          <button style={{ ...miniBtnOutline, fontSize: 12 }} onClick={syncFolders} title="Look up each imported dashboard's Looker folder">↻ Sync folders from Looker</button>
        )}
        <div style={{ flex: 1 }} />
        {/* Tile / List view toggle for the dashboard list. */}
        <div style={{ display: 'inline-flex', border: '1px solid var(--hairline)', borderRadius: 8, overflow: 'hidden' }}>
          <button style={{ ...viewToggleBtn, ...(view === 'tile' ? viewToggleOn : null) }} onClick={() => setViewMode('tile')} title="Tile view">▦ Tiles</button>
          <button style={{ ...viewToggleBtn, ...(view === 'list' ? viewToggleOn : null) }} onClick={() => setViewMode('list')} title="List view">☰ List</button>
        </div>
      </div>

      {loading ? (
        <p style={{ color: 'var(--muted)' }}>Loading…</p>
      ) : error ? (
        <p style={{ color: 'var(--error)' }}>{error}</p>
      ) : dashboards.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>No dashboards yet{isAdmin ? ' — create or import one above.' : '.'}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          {/* Subfolders in the current folder */}
          {childSegments.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>
              {childSegments.map((seg) => {
                const fp = fullChild(seg);
                const isDropOk = isAdmin && dragFolder && canDropInto(dragFolder, fp);
                return (
                  <div key={seg} className="lift" style={{ ...folderCard, position: 'relative', ...(dropTarget === fp && isDropOk ? dropHighlight : null), ...(dragFolder === fp ? { opacity: 0.5 } : null) }}
                    onClick={() => setPath(fp)}
                    draggable={isAdmin}
                    onDragStart={(e) => { if (!isAdmin) return; setDragFolder(fp); e.dataTransfer.effectAllowed = 'move'; }}
                    onDragEnd={() => { setDragFolder(null); setDropTarget(null); }}
                    onDragOver={(e) => { if (isDropOk) { e.preventDefault(); setDropTarget(fp); } }}
                    onDragLeave={() => setDropTarget((t) => (t === fp ? null : t))}
                    onDrop={(e) => { e.preventDefault(); e.stopPropagation(); handleFolderDrop(fp); }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4 }}>
                      <div style={{ fontSize: 28, flex: 1 }}>📁</div>
                      {isAdmin && (
                        <>
                          <button style={folderEditBtn} title="Move folder" onClick={(e) => { e.stopPropagation(); setMoveFolderPath(fp); }}>↗</button>
                          <button style={folderEditBtn} title="Rename folder" onClick={(e) => renameFolder(fp, e)}>✎</button>
                          <button style={{ ...folderEditBtn, color: 'var(--error)' }} title="Delete folder" onClick={(e) => deleteFolderAction(fp, e)}>🗑</button>
                        </>
                      )}
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 700, marginTop: 6, lineHeight: 1.3 }}>{seg}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{folderCountOf(fp)} dashboard{folderCountOf(fp) === 1 ? '' : 's'}</div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Dashboards directly in the current folder — tile cards or compact list */}
          {dashHere.length > 0 && view === 'tile' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
              {dashHere.map((d) => (
                <div key={d.id} style={listCardStyle} onClick={() => navigate(`/d/${d.id}`)}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ flex: 1, fontSize: 15, fontWeight: 700, lineHeight: 1.3 }}>{d.title}</div>
                    {isAdmin && <button style={deleteBtn} title="Delete" onClick={(e) => handleDelete(d.id, e)}>✕</button>}
                  </div>
                  {d.description && <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>{d.description}</div>}
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12 }}>{d.tileCount} tiles</div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                    <button style={miniBtn} onClick={(e) => { e.stopPropagation(); navigate(`/d/${d.id}`); }}>View</button>
                    {isAdmin && <button style={miniBtnOutline} onClick={(e) => { e.stopPropagation(); navigate(`/d/${d.id}/edit`); }}>Edit</button>}
                    {isAdmin && <button style={miniBtnOutline} onClick={(e) => moveToFolder(d, e)}>📁 Move</button>}
                  </div>
                </div>
              ))}
            </div>
          )}
          {dashHere.length > 0 && view === 'list' && (
            <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--hairline)', borderRadius: 12, overflow: 'hidden' }}>
              {dashHere.map((d, i) => (
                <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderTop: i ? '1px solid var(--hairline)' : 'none', background: 'var(--card)', cursor: 'pointer' }} onClick={() => navigate(`/d/${d.id}`)}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</div>
                    {d.description && <div style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.description}</div>}
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--muted)', flexShrink: 0 }}>{d.tileCount} tiles</span>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                    <button style={miniBtn} onClick={() => navigate(`/d/${d.id}`)}>View</button>
                    {isAdmin && <button style={miniBtnOutline} onClick={() => navigate(`/d/${d.id}/edit`)}>Edit</button>}
                    {isAdmin && <button style={miniBtnOutline} onClick={(e) => moveToFolder(d, e)}>📁</button>}
                    {isAdmin && <button style={deleteBtn} title="Delete" onClick={(e) => handleDelete(d.id, e)}>✕</button>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {childSegments.length === 0 && dashHere.length === 0 && (
            <p style={{ color: 'var(--muted)' }}>This folder is empty.</p>
          )}
        </div>
      )}

      {showFolderModal && folderPreview && (
        <FolderImportModal
          preview={folderPreview}
          alreadyImported={new Set(dashboards.map((d) => d.source?.lookerDashboardId).filter(Boolean).map(String))}
          existingFolders={allFolders}
          onImported={load}
          onClose={() => { setShowFolderModal(false); setLookerFolderId(''); setFolderPreview(null); }}
        />
      )}

      {moveFolderPath && (
        <FolderMoveModal
          folder={moveFolderPath}
          allFolders={allFolders}
          onMove={(parent) => doMoveFolder(moveFolderPath, parent)}
          onClose={() => setMoveFolderPath(null)}
        />
      )}
    </main>
  );
}

const cardStyle = { flex: '1 1 300px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 22, boxShadow: 'var(--shadow-sm)' };
const listCardStyle = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 18, cursor: 'pointer', boxShadow: 'var(--shadow-sm)' };
const folderCard = { textAlign: 'left', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 20, cursor: 'pointer', boxShadow: 'var(--shadow-sm)' };
const primaryBtn = { padding: '9px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 14, fontWeight: 600, cursor: 'pointer' };
const inputStyle = { flex: '1 1 140px', padding: '9px 12px', border: '1px solid var(--hairline)', borderRadius: 10, fontSize: 13, outline: 'none', background: 'var(--card)' };
const miniBtn = { padding: '7px 16px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const miniBtnOutline = { padding: '7px 14px', background: 'rgba(0,0,0,0.05)', color: 'var(--text)', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const viewToggleBtn = { padding: '6px 12px', background: 'var(--card)', color: 'var(--muted)', border: 'none', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
const viewToggleOn = { background: 'var(--brand)', color: '#fff' };
const deleteBtn = { border: 'none', background: 'transparent', color: '#bbb', cursor: 'pointer', fontSize: 14, padding: 2 };
const folderEditBtn = { border: 'none', background: 'rgba(0,0,0,0.05)', color: 'var(--muted)', cursor: 'pointer', fontSize: 13, borderRadius: 8, width: 28, height: 28, flexShrink: 0 };
const dropHighlight = { outline: '2px dashed var(--brand)', outlineOffset: 2, background: 'rgba(79,70,229,0.06)' };
const crumbBtn = { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 18, fontWeight: 700, color: 'var(--text)', padding: 0 };
const homeBackBtn = { flexShrink: 0, width: 34, height: 34, borderRadius: '50%', background: 'rgba(128,128,128,0.15)', color: 'var(--text)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 'none', cursor: 'pointer' };
const folderTag = { fontSize: 11, fontWeight: 600, background: '#eef2ff', color: '#4f46e5', padding: '2px 8px', borderRadius: 980 };
