import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../lib/api.js';

export default function HomePage() {
  const navigate = useNavigate();
  const [dashboards, setDashboards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [importId, setImportId] = useState('');
  const [importTitle, setImportTitle] = useState('');
  const [importing, setImporting] = useState(false);

  function load() {
    setLoading(true);
    api.listDashboards()
      .then(setDashboards)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

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
      const d = await api.importDashboard(importId.trim(), importTitle.trim() || undefined);
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
      {/* Actions */}
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
            <button style={primaryBtn} onClick={handleImport} disabled={importing || !importId.trim()}>
              {importing ? 'Importing…' : 'Import'}
            </button>
          </div>
          <div style={{ marginTop: 10, fontSize: 12 }}>
            <Link to="/clone" style={{ color: 'var(--muted)' }}>Or clone directly inside Looker →</Link>
          </div>
        </div>
      </div>

      <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 14 }}>Your dashboards</h2>

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
                <button style={deleteBtn} title="Delete" onClick={(e) => handleDelete(d.id, e)}>✕</button>
              </div>
              {d.description && <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>{d.description}</div>}
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
                <span>{d.tileCount} tiles</span>
                {d.source?.lookerDashboardId && <span style={badge}>imported</span>}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <button style={miniBtn} onClick={(e) => { e.stopPropagation(); navigate(`/d/${d.id}`); }}>View</button>
                <button style={miniBtnOutline} onClick={(e) => { e.stopPropagation(); navigate(`/d/${d.id}/edit`); }}>Edit</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

const cardStyle = { flex: '1 1 320px', background: '#fff', border: '1px solid #e0e0e0', borderRadius: 12, padding: 20, boxShadow: '0 1px 6px rgba(0,0,0,0.05)' };
const listCardStyle = { background: '#fff', border: '1px solid #e0e0e0', borderRadius: 12, padding: 18, cursor: 'pointer', boxShadow: '0 1px 6px rgba(0,0,0,0.05)' };
const primaryBtn = { padding: '9px 16px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' };
const inputStyle = { flex: '1 1 140px', padding: '8px 12px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 13, outline: 'none' };
const miniBtn = { padding: '6px 14px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const miniBtnOutline = { padding: '6px 14px', background: '#fff', color: 'var(--text)', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const deleteBtn = { border: 'none', background: 'transparent', color: '#bbb', cursor: 'pointer', fontSize: 14, padding: 2 };
const badge = { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', background: '#eef2ff', color: '#4f46e5', padding: '2px 6px', borderRadius: 4 };
