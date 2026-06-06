import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';

export default function ClonePage() {
  const navigate = useNavigate();
  const [sourceId, setSourceId] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [folderId, setFolderId] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);

  async function handlePreview() {
    if (!sourceId.trim()) return;
    setPreviewing(true);
    setPreview(null);
    try {
      const res = await fetch(`/api/looker-dashboard/${encodeURIComponent(sourceId.trim())}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Unknown error');
      setPreview({ ok: true, data });
    } catch (err) {
      setPreview({ ok: false, error: err.message });
    } finally {
      setPreviewing(false);
    }
  }

  async function handleImportHere() {
    if (!sourceId.trim()) return;
    setImporting(true);
    try {
      const d = await api.importDashboard(sourceId.trim(), newTitle.trim() || undefined);
      navigate(`/d/${d.id}/edit`);
    } catch (err) {
      alert('Import failed: ' + err.message);
    } finally {
      setImporting(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!sourceId.trim() || !newTitle.trim() || !folderId.trim()) {
      alert('Please fill in all fields.');
      return;
    }
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch('/api/recreate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceDashboardId: sourceId.trim(),
          newTitle: newTitle.trim(),
          targetFolderId: folderId.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Server error');
      setResult({ ok: true, data });
    } catch (err) {
      setResult({ ok: false, error: err.message });
    } finally {
      setSubmitting(false);
    }
  }

  const totalTiles = result?.data ? result.data.tilesCreated + result.data.tilesFailed : 0;
  const totalFilters = result?.data ? result.data.filtersCreated + result.data.filtersFailed : 0;
  const hasErrors = result?.data?.errors?.length > 0;
  const allOk = result?.ok && !hasErrors;

  return (
    <main style={{ flex: 1, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '48px 24px' }}>
      <div style={{ background: '#fff', border: '1px solid #e0e0e0', borderRadius: 12, boxShadow: '0 2px 16px rgba(0,0,0,0.08)', width: '100%', maxWidth: 560, padding: '36px 40px' }}>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>Clone a Dashboard inside Looker</div>
        <div style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 32, lineHeight: 1.5 }}>
          Copy a Looker dashboard — tiles, filters, layout — into a new <em>Looker</em> dashboard.
          To build a fully editable copy in this app instead,{' '}
          <button onClick={handleImportHere} style={linkBtnStyle} disabled={!sourceId.trim() || importing}>
            {importing ? 'importing…' : 'import & edit here'}
          </button>.
        </div>

        <form onSubmit={handleSubmit} noValidate>
          <Field label="Source Dashboard ID" hint="the dashboard to copy">
            <div style={{ display: 'flex', gap: 8 }}>
              <Input value={sourceId} onChange={setSourceId} placeholder="e.g. 1429" />
              <button type="button" style={previewBtnStyle} onClick={handlePreview} disabled={previewing || !sourceId.trim()}>
                {previewing ? 'Loading…' : 'Preview'}
              </button>
            </div>
            {preview && (
              <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 6, fontSize: 13, ...(preview.ok ? { background: '#f0fdf4', border: '1px solid #bbf7d0', color: 'var(--success)' } : { background: '#fff5f5', border: '1px solid #fecaca', color: 'var(--error)' }) }}>
                {preview.ok
                  ? `✓ ${preview.data.title} — ${preview.data.tileCount} tiles, ${preview.data.filterCount} filters`
                  : `Error: ${preview.error}`}
              </div>
            )}
          </Field>

          <hr style={{ border: 'none', borderTop: '1px solid #e0e0e0', margin: '28px 0' }} />

          <Field label="New Dashboard Title" hint="name for the copy">
            <Input value={newTitle} onChange={setNewTitle} placeholder="e.g. Howler — Glastonbury 2025" />
          </Field>

          <Field label="Target Folder ID" hint="Looker folder to save into">
            <Input value={folderId} onChange={setFolderId} placeholder="e.g. 7" />
          </Field>

          <button type="submit" disabled={submitting} style={submitBtnStyle}>
            {submitting ? '⏳ Recreating…' : 'Recreate Dashboard'}
          </button>
        </form>

        {result && (
          <div style={{ marginTop: 24, borderRadius: 10, overflow: 'hidden', border: '1px solid #e0e0e0' }}>
            <div style={{ padding: '14px 18px', fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8, ...(allOk ? { background: '#f0fdf4', color: 'var(--success)', borderBottom: '1px solid #bbf7d0' } : result.ok ? { background: '#fffbeb', color: 'var(--warn)', borderBottom: '1px solid #fde68a' } : { background: '#fff5f5', color: 'var(--error)', borderBottom: '1px solid #fecaca' }) }}>
              {allOk ? '✓ Dashboard recreated successfully!' : result.ok ? '⚠ Recreated with some errors' : '✗ Failed'}
            </div>
            <div style={{ padding: '16px 18px', fontSize: 13 }}>
              {result.ok && (
                <>
                  <div style={{ display: 'flex', gap: 24, marginBottom: 14 }}>
                    <Stat label="Tiles" value={`${result.data.tilesCreated}/${totalTiles}`} green={result.data.tilesCreated === totalTiles} />
                    <Stat label="Filters" value={`${result.data.filtersCreated}/${totalFilters}`} green={result.data.filtersCreated === totalFilters} />
                  </div>
                  {result.data.dashboardUrl && (
                    <a href={result.data.dashboardUrl} target="_blank" rel="noopener" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 16px', background: 'var(--brand)', color: '#fff', textDecoration: 'none', borderRadius: 7, fontWeight: 600, fontSize: 13, marginBottom: 14 }}>
                      ↗ Open in Looker — Dashboard {result.data.dashboardId}
                    </a>
                  )}
                  {result.data.dashboardId && (
                    <div>
                      <button
                        onClick={async () => {
                          try {
                            const d = await api.importDashboard(String(result.data.dashboardId), newTitle.trim() || undefined);
                            navigate(`/d/${d.id}/edit`);
                          } catch (e) { alert('Import failed: ' + e.message); }
                        }}
                        style={{ ...submitBtnStyle, marginTop: 4, fontSize: 13, padding: '9px 16px', width: 'auto' }}
                      >
                        Import & edit here →
                      </button>
                    </div>
                  )}
                  {hasErrors && (
                    <ul style={{ listStyle: 'none', marginTop: 12 }}>
                      {result.data.errors.map((err, i) => (
                        <li key={i} style={{ padding: '7px 10px', background: '#fff5f5', borderLeft: '3px solid var(--error)', borderRadius: '0 4px 4px 0', color: 'var(--error)', fontSize: 12, marginBottom: 6, lineHeight: 1.4 }}>{err}</li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              {!result.ok && <p style={{ color: 'var(--error)' }}>{result.error}</p>}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
        {label} {hint && <span style={{ fontWeight: 400, color: 'var(--muted)' }}>— {hint}</span>}
      </label>
      {children}
    </div>
  );
}

function Input({ value, onChange, placeholder }) {
  return (
    <input
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      autoComplete="off"
      style={{ width: '100%', padding: '10px 14px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 14, outline: 'none' }}
    />
  );
}

function Stat({ label, value, green }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
      <span style={{ fontSize: 20, fontWeight: 700, color: green ? 'var(--success)' : 'var(--error)' }}>{value}</span>
    </div>
  );
}

const submitBtnStyle = {
  width: '100%', padding: 13, background: 'var(--brand)', color: '#fff',
  border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 700, cursor: 'pointer',
};

const previewBtnStyle = {
  flexShrink: 0, padding: '10px 16px', background: '#f7f7f7',
  border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 13, fontWeight: 600,
  cursor: 'pointer', whiteSpace: 'nowrap',
};

const linkBtnStyle = {
  background: 'none', border: 'none', color: 'var(--brand)', cursor: 'pointer',
  fontSize: 'inherit', textDecoration: 'underline', padding: 0,
};
