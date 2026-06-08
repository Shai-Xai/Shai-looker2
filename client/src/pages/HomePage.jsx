import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import FolderImportModal from '../components/FolderImportModal.jsx';

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
  const [path, setPath] = useState(''); // current folder path; '' = top level
  // Looker-folder import
  const [lookerFolderId, setLookerFolderId] = useState('');
  const [folderPreview, setFolderPreview] = useState(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [includeSubfolders, setIncludeSubfolders] = useState(true);
  const [showFolderModal, setShowFolderModal] = useState(false);

  function load() {
    setLoading(true);
    api.listDashboards().then(setDashboards).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }
  useEffect(load, []);

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
  const dashHere = dashboards.filter((d) => (d.folder || '') === path); // dashboards directly in this folder
  const folderCountOf = (fp) => dashboards.filter((d) => { const f = d.folder || ''; return f === fp || f.startsWith(fp + '/'); }).length;
  const segs = path ? path.split('/') : [];

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
      const d = await api.importDashboard(importId.trim(), importTitle.trim() || undefined, importFolderName.trim() || undefined);
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

      {/* Header: breadcrumb + actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
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
            <button style={{ ...miniBtnOutline, fontSize: 12, color: 'var(--error)' }} onClick={(e) => deleteFolderAction(path, e)} title="Delete this folder">🗑 Delete</button>
          </>
        )}
        {isAdmin && !path && dashboards.some((d) => !d.folder) && (
          <button style={{ ...miniBtnOutline, fontSize: 12 }} onClick={syncFolders} title="Look up each imported dashboard's Looker folder">↻ Sync folders from Looker</button>
        )}
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
                return (
                  <div key={seg} className="lift" style={{ ...folderCard, position: 'relative' }} onClick={() => setPath(fp)}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4 }}>
                      <div style={{ fontSize: 28, flex: 1 }}>📁</div>
                      {isAdmin && (
                        <>
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

          {/* Dashboards directly in the current folder */}
          {dashHere.length > 0 && (
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

          {childSegments.length === 0 && dashHere.length === 0 && (
            <p style={{ color: 'var(--muted)' }}>This folder is empty.</p>
          )}
        </div>
      )}

      {showFolderModal && folderPreview && (
        <FolderImportModal
          preview={folderPreview}
          alreadyImported={new Set(dashboards.map((d) => d.source?.lookerDashboardId).filter(Boolean).map(String))}
          onImported={load}
          onClose={() => { setShowFolderModal(false); setLookerFolderId(''); setFolderPreview(null); }}
        />
      )}
    </main>
  );
}

const cardStyle = { flex: '1 1 300px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 22, boxShadow: 'var(--shadow-sm)' };
const listCardStyle = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 18, cursor: 'pointer', boxShadow: 'var(--shadow-sm)' };
const folderCard = { textAlign: 'left', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 20, cursor: 'pointer', boxShadow: 'var(--shadow-sm)' };
const primaryBtn = { padding: '9px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 14, fontWeight: 600, cursor: 'pointer' };
const inputStyle = { flex: '1 1 140px', padding: '9px 12px', border: '1px solid var(--hairline)', borderRadius: 10, fontSize: 13, outline: 'none', background: '#fff' };
const miniBtn = { padding: '7px 16px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const miniBtnOutline = { padding: '7px 14px', background: 'rgba(0,0,0,0.05)', color: 'var(--text)', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const deleteBtn = { border: 'none', background: 'transparent', color: '#bbb', cursor: 'pointer', fontSize: 14, padding: 2 };
const folderEditBtn = { border: 'none', background: 'rgba(0,0,0,0.05)', color: 'var(--muted)', cursor: 'pointer', fontSize: 13, borderRadius: 8, width: 28, height: 28, flexShrink: 0 };
const crumbBtn = { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 18, fontWeight: 700, color: 'var(--text)', padding: 0 };
const folderTag = { fontSize: 11, fontWeight: 600, background: '#eef2ff', color: '#4f46e5', padding: '2px 8px', borderRadius: 980 };
