import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

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
  const [openFolder, setOpenFolder] = useState(null); // null = folder grid; '' = unfiled; else folder name
  // Looker-folder import
  const [lookerFolderId, setLookerFolderId] = useState('');
  const [folderPreview, setFolderPreview] = useState(null);
  const [folderBusy, setFolderBusy] = useState(false);

  function load() {
    setLoading(true);
    api.listDashboards().then(setDashboards).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }
  useEffect(load, []);

  // Folder list (with counts) for the landing grid; + Unfiled if any.
  const folderNames = [...new Set(dashboards.map((d) => d.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const unfiledCount = dashboards.filter((d) => !d.folder).length;
  const folders = [...folderNames]; // for the import datalist
  const shown = dashboards.filter((d) => (d.folder || '') === (openFolder || ''));

  async function previewFolder() {
    setFolderPreview(null);
    if (!lookerFolderId.trim()) return;
    try { setFolderPreview(await api.lookerFolder(lookerFolderId.trim())); }
    catch (e) { alert('Could not read folder: ' + e.message); }
  }
  async function importLookerFolder() {
    if (!lookerFolderId.trim()) return;
    setFolderBusy(true);
    try {
      const r = await api.importFolder(lookerFolderId.trim());
      alert(`Imported ${r.imported} of ${r.total} dashboards into folder "${r.folder}".` + (r.failed.length ? `\n${r.failed.length} failed.` : ''));
      setLookerFolderId(''); setFolderPreview(null);
      load();
    } catch (e) { alert('Folder import failed: ' + e.message); }
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
  // Move a dashboard into a folder (a string label).
  async function moveToFolder(d, e) {
    e.stopPropagation();
    const name = prompt(`Folder for "${d.title}" (blank = unfiled):`, d.folder || '');
    if (name === null) return;
    await api.updateDashboard(d.id, { folder: name.trim() });
    load();
  }
  // Rename a folder — applies the new name to every dashboard filed under it.
  async function renameFolder(oldName, e) {
    if (e) e.stopPropagation();
    if (!oldName) return; // "Unfiled" isn't a real folder
    const next = prompt(`Rename folder "${oldName}" to:`, oldName);
    if (next === null) return;
    const name = next.trim();
    if (!name || name === oldName) return;
    const affected = dashboards.filter((d) => (d.folder || '') === oldName);
    try {
      await Promise.all(affected.map((d) => api.updateDashboard(d.id, { folder: name })));
      if (openFolder === oldName) setOpenFolder(name);
      load();
    } catch (err) { alert('Rename failed: ' + err.message); }
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
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>Bring in every dashboard in a Looker folder at once — filed under a folder here.</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input style={inputStyle} placeholder="Looker folder ID" value={lookerFolderId} onChange={(e) => { setLookerFolderId(e.target.value); setFolderPreview(null); }} onBlur={previewFolder} />
            <button style={miniBtnOutline} onClick={previewFolder} disabled={!lookerFolderId.trim()}>Preview</button>
            <button style={primaryBtn} onClick={importLookerFolder} disabled={folderBusy || !lookerFolderId.trim()}>{folderBusy ? 'Importing…' : (folderPreview ? `Import ${folderPreview.dashboards.length}` : 'Import folder')}</button>
          </div>
          {folderPreview && (
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
              <b style={{ color: 'var(--text)' }}>{folderPreview.name}</b> — {folderPreview.dashboards.length} dashboards{folderBusy && <span> · importing, this can take a minute…</span>}
            </div>
          )}
        </div>
      </div>
      )}

      {/* shared datalist of existing folders for the import input */}
      <datalist id="folder-list">{folders.map((f) => <option key={f} value={f} />)}</datalist>

      {/* Header: folder grid title, or a breadcrumb when inside a folder */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        {openFolder !== null && (
          <button style={{ ...miniBtnOutline, fontSize: 12 }} onClick={() => setOpenFolder(null)}>← Folders</button>
        )}
        <h2 style={{ fontSize: 18, fontWeight: 700 }}>
          {openFolder === null ? (isAdmin ? 'Your dashboards' : 'Dashboards') : (openFolder || 'Unfiled')}
        </h2>
        {isAdmin && openFolder === null && dashboards.some((d) => !d.folder) && (
          <button style={{ ...miniBtnOutline, fontSize: 12 }} onClick={syncFolders} title="Look up each imported dashboard's Looker folder">↻ Sync folders from Looker</button>
        )}
        {isAdmin && openFolder && (
          <button style={{ ...miniBtnOutline, fontSize: 12 }} onClick={(e) => renameFolder(openFolder, e)} title="Rename this folder">✎ Rename folder</button>
        )}
      </div>

      {loading ? (
        <p style={{ color: 'var(--muted)' }}>Loading…</p>
      ) : error ? (
        <p style={{ color: 'var(--error)' }}>{error}</p>
      ) : dashboards.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>No dashboards yet{isAdmin ? ' — create or import one above.' : '.'}</p>
      ) : openFolder === null ? (
        // ── Landing: folder cards ──────────────────────────────────────────────
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
          {folderNames.map((f) => {
            const count = dashboards.filter((d) => d.folder === f).length;
            return (
              <div key={f} className="lift" style={{ ...folderCard, position: 'relative' }} onClick={() => setOpenFolder(f)}>
                <div style={{ display: 'flex', alignItems: 'flex-start' }}>
                  <div style={{ fontSize: 28, flex: 1 }}>📁</div>
                  {isAdmin && <button style={folderEditBtn} title="Rename folder" onClick={(e) => renameFolder(f, e)}>✎</button>}
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, marginTop: 6, lineHeight: 1.3 }}>{f}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{count} dashboard{count === 1 ? '' : 's'}</div>
              </div>
            );
          })}
          {unfiledCount > 0 && (
            <button className="lift" style={folderCard} onClick={() => setOpenFolder('')}>
              <div style={{ fontSize: 28, opacity: 0.5 }}>🗂️</div>
              <div style={{ fontSize: 15, fontWeight: 700, marginTop: 6 }}>Unfiled</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{unfiledCount} dashboard{unfiledCount === 1 ? '' : 's'}</div>
            </button>
          )}
        </div>
      ) : (
        // ── Inside a folder: its dashboards ────────────────────────────────────
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
          {shown.map((d) => (
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
          {shown.length === 0 && <p style={{ color: 'var(--muted)' }}>No dashboards in this folder.</p>}
        </div>
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
const folderTag = { fontSize: 11, fontWeight: 600, background: '#eef2ff', color: '#4f46e5', padding: '2px 8px', borderRadius: 980 };
