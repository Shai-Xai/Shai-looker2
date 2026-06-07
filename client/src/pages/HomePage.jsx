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
  const [activeFolder, setActiveFolder] = useState(null); // null = all, '' = unfiled, else folder name
  // Looker-folder import
  const [lookerFolderId, setLookerFolderId] = useState('');
  const [folderPreview, setFolderPreview] = useState(null);
  const [folderBusy, setFolderBusy] = useState(false);

  function load() {
    setLoading(true);
    api.listDashboards().then(setDashboards).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }
  useEffect(load, []);

  // Distinct folder names across dashboards (for the filter bar + pickers).
  const folders = [...new Set(dashboards.map((d) => d.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const shown = dashboards.filter((d) => activeFolder === null || (d.folder || '') === activeFolder);

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

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700 }}>{isAdmin ? 'Your dashboards' : 'Dashboards'}</h2>
        {isAdmin && dashboards.some((d) => !d.folder) && (
          <button style={{ ...miniBtnOutline, fontSize: 12 }} onClick={syncFolders} title="Look up each imported dashboard's Looker folder">↻ Sync folders from Looker</button>
        )}
      </div>

      {/* Folder filter bar */}
      {folders.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          <Chip active={activeFolder === null} onClick={() => setActiveFolder(null)}>All ({dashboards.length})</Chip>
          {folders.map((f) => (
            <Chip key={f} active={activeFolder === f} onClick={() => setActiveFolder(f)}>{f} ({dashboards.filter((d) => d.folder === f).length})</Chip>
          ))}
          {dashboards.some((d) => !d.folder) && (
            <Chip active={activeFolder === ''} onClick={() => setActiveFolder('')}>Unfiled ({dashboards.filter((d) => !d.folder).length})</Chip>
          )}
        </div>
      )}

      {loading ? (
        <p style={{ color: 'var(--muted)' }}>Loading…</p>
      ) : error ? (
        <p style={{ color: 'var(--error)' }}>{error}</p>
      ) : dashboards.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>No dashboards yet — create one above.</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
          {shown.map((d) => (
            <div key={d.id} style={listCardStyle} onClick={() => navigate(`/d/${d.id}`)}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1, fontSize: 15, fontWeight: 700, lineHeight: 1.3 }}>{d.title}</div>
                {isAdmin && <button style={deleteBtn} title="Delete" onClick={(e) => handleDelete(d.id, e)}>✕</button>}
              </div>
              {d.description && <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>{d.description}</div>}
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span>{d.tileCount} tiles</span>
                {d.folder ? <span style={folderTag}>📁 {d.folder}</span> : <span style={{ color: '#bbb' }}>Unfiled</span>}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                <button style={miniBtn} onClick={(e) => { e.stopPropagation(); navigate(`/d/${d.id}`); }}>View</button>
                {isAdmin && <button style={miniBtnOutline} onClick={(e) => { e.stopPropagation(); navigate(`/d/${d.id}/edit`); }}>Edit</button>}
                {isAdmin && <button style={miniBtnOutline} onClick={(e) => moveToFolder(d, e)}>📁 Folder</button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

function Chip({ active, onClick, children }) {
  return <button onClick={onClick} style={{ padding: '6px 14px', borderRadius: 980, border: active ? '1.5px solid var(--brand)' : '1px solid var(--hairline)', background: active ? 'var(--brand)' : '#fff', color: active ? '#fff' : 'var(--text)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>{children}</button>;
}

const cardStyle = { flex: '1 1 300px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 22, boxShadow: 'var(--shadow-sm)' };
const listCardStyle = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 18, cursor: 'pointer', boxShadow: 'var(--shadow-sm)' };
const primaryBtn = { padding: '9px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 14, fontWeight: 600, cursor: 'pointer' };
const inputStyle = { flex: '1 1 140px', padding: '9px 12px', border: '1px solid var(--hairline)', borderRadius: 10, fontSize: 13, outline: 'none', background: '#fff' };
const miniBtn = { padding: '7px 16px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const miniBtnOutline = { padding: '7px 14px', background: 'rgba(0,0,0,0.05)', color: 'var(--text)', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const deleteBtn = { border: 'none', background: 'transparent', color: '#bbb', cursor: 'pointer', fontSize: 14, padding: 2 };
const folderTag = { fontSize: 11, fontWeight: 600, background: '#eef2ff', color: '#4f46e5', padding: '2px 8px', borderRadius: 980 };
