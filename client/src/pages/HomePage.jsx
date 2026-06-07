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
  const [templates, setTemplates] = useState([]);
  const [folderId, setFolderId] = useState('');

  function load() {
    setLoading(true);
    api.listDashboards()
      .then(setDashboards)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);
  useEffect(() => { if (isAdmin) api.adminListSets().then(setTemplates).catch(() => {}); }, [isAdmin]);

  async function newFolder() {
    const name = prompt('New folder name:');
    if (!name || !name.trim()) return;
    try { const t = await api.adminCreateSet({ name: name.trim(), dashboardIds: [] }); setTemplates((cur) => [...cur, t]); setFolderId(t.id); }
    catch (e) { alert(e.message); }
  }

  async function handleCreate() {
    try {
      const d = await api.createDashboard({ title: 'Untitled dashboard' });
      navigate(`/d/${d.id}/edit`);
    } catch (e) {
      alert(e.message);
    }
  }

  async function handleImport() {
    if (!importId.trim()) return;
    setImporting(true);
    try {
      const d = await api.importDashboard(importId.trim(), importTitle.trim() || undefined, folderId || undefined);
      navigate(`/d/${d.id}/edit`);
    } catch (e) {
      alert('Import failed: ' + e.message);
    } finally {
      setImporting(false);
    }
  }

  async function handleDelete(id, e) {
    e.stopPropagation();
    if (!confirm('Delete this dashboard?')) return;
    await api.deleteDashboard(id);
    load();
  }

  return (
    <main style={{ flex: 1, padding: '32px 24px', maxWidth: 1100, margin: '0 auto', width: '100%' }}>
      {/* Actions — admin only */}
      {isAdmin && (
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 28 }}>
        <div style={cardStyle}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Build from scratch</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>
            Start with a blank canvas and add tiles backed by your Looker metrics.
          </div>
          <button style={primaryBtn} onClick={handleCreate}>+ New dashboard</button>
        </div>

        <div style={cardStyle}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Replicate a Looker dashboard</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>
            Import an existing Looker dashboard. It becomes fully editable here.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input style={inputStyle} placeholder="Looker dashboard ID" value={importId} onChange={(e) => setImportId(e.target.value)} />
            <input style={inputStyle} placeholder="New title (optional)" value={importTitle} onChange={(e) => setImportTitle(e.target.value)} />
            <select style={inputStyle} value={folderId} onChange={(e) => (e.target.value === '__new' ? newFolder() : setFolderId(e.target.value))}>
              <option value="">Add to folder… (optional)</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              <option value="__new">+ New folder…</option>
            </select>
            <button style={primaryBtn} onClick={handleImport} disabled={importing || !importId.trim()}>
              {importing ? 'Importing…' : 'Import'}
            </button>
          </div>
          <div style={{ marginTop: 10, fontSize: 12 }}>
            <Link to="/clone" style={{ color: 'var(--muted)' }}>Or clone directly inside Looker →</Link>
          </div>
        </div>
      </div>
      )}

      <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 14 }}>{isAdmin ? 'Your dashboards' : 'Dashboards'}</h2>

      {loading ? (
        <p style={{ color: 'var(--muted)' }}>Loading…</p>
      ) : error ? (
        <p style={{ color: 'var(--error)' }}>{error}</p>
      ) : dashboards.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>No dashboards yet — create one above.</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
          {dashboards.map((d) => (
            <div key={d.id} style={listCardStyle} onClick={() => navigate(`/d/${d.id}`)}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1, fontSize: 15, fontWeight: 700, lineHeight: 1.3 }}>{d.title}</div>
                {isAdmin && <button style={deleteBtn} title="Delete" onClick={(e) => handleDelete(d.id, e)}>✕</button>}
              </div>
              {d.description && <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>{d.description}</div>}
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
                <span>{d.tileCount} tiles</span>
                {d.source?.lookerDashboardId && <span style={badge}>imported</span>}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <button style={miniBtn} onClick={(e) => { e.stopPropagation(); navigate(`/d/${d.id}`); }}>View</button>
                {isAdmin && <button style={miniBtnOutline} onClick={(e) => { e.stopPropagation(); navigate(`/d/${d.id}/edit`); }}>Edit</button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

const cardStyle = { flex: '1 1 320px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 22, boxShadow: 'var(--shadow-sm)' };
const listCardStyle = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 18, cursor: 'pointer', boxShadow: 'var(--shadow-sm)' };
const primaryBtn = { padding: '9px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 14, fontWeight: 600, cursor: 'pointer' };
const inputStyle = { flex: '1 1 140px', padding: '9px 12px', border: '1px solid var(--hairline)', borderRadius: 10, fontSize: 13, outline: 'none', background: '#fff' };
const miniBtn = { padding: '7px 16px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const miniBtnOutline = { padding: '7px 16px', background: 'rgba(0,0,0,0.05)', color: 'var(--text)', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const deleteBtn = { border: 'none', background: 'transparent', color: '#bbb', cursor: 'pointer', fontSize: 14, padding: 2 };
const badge = { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', background: '#eef2ff', color: '#4f46e5', padding: '2px 6px', borderRadius: 4 };
