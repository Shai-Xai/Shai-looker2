import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';

// Google Drive → the Owl. Same component on both surfaces via the scope prop:
// 'admin-client' (Admin → client → Integrations) | 'my' (Settings → Integrations).
// Flow: paste the service-account key once (write-only) → share files/folders
// with its email → paste the link here. Sheets become attached tables (askUpload);
// Docs/Slides/PDFs become searchable text the Owl quotes with the file name.
export default function DriveSourcesCard({ entityId, scope = 'my' }) {
  const get = () => (scope === 'admin-client' ? api.adminDriveView(entityId) : api.myDriveView(entityId));
  const run = (fn, ...args) => (scope === 'admin-client' ? api[`adminDrive${fn}`](entityId, ...args) : api[`myDrive${fn}`](entityId, ...args));

  const [view, setView] = useState(null);
  const [denied, setDenied] = useState(false);
  const [keyJson, setKeyJson] = useState('');
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => { get().then(setView).catch(() => setDenied(true)); }, [entityId, scope]); // eslint-disable-line react-hooks/exhaustive-deps
  if (denied || !view) return null;

  const act = async (label, fn) => {
    setBusy(label); setError('');
    try { setView(await fn()); }
    catch (e) { setError(e.message || 'Something went wrong.'); }
    setBusy('');
  };
  const saveKey = () => act('key', async () => { const v = await run('SetKey', { serviceAccountJson: keyJson }); setKeyJson(''); setShowKeyForm(false); return v; });
  const clearKey = () => window.confirm('Disconnect Google Drive? Added files stop syncing (they stay until removed).') && act('key', () => run('SetKey', { clear: true }));
  const add = () => act('add', async () => { const v = await run('AddSource', { link: link.trim() }); setLink(''); return v; });
  const copyEmail = () => {
    (navigator.clipboard?.writeText(view.saEmail) || Promise.reject()).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); })
      .catch(() => window.prompt('Copy this email:', view.saEmail));
  };

  const STATUS = { ok: ['✓ synced', 'var(--success, #16a34a)'], partial: ['⚠︎ partial', '#d97706'], error: ['✕ error', 'var(--danger, #dc2626)'], unsupported: ['unsupported', 'var(--muted)'], pending: ['syncing…', 'var(--muted)'] };
  const chip = (s) => { const [t, c] = STATUS[s] || [s, 'var(--muted)']; return <span style={{ fontSize: 11.5, fontWeight: 700, color: c, whiteSpace: 'nowrap' }}>{t}</span>; };
  const icon = (s) => (s.kind === 'folder' ? '📁' : /spreadsheet|csv/.test(s.mime) ? '📊' : /pdf/.test(s.mime) ? '📕' : '📄');

  return (
    <div style={card}>
      <div style={title}>🗂️ Google Drive — files the Owl can read</div>
      <p style={sub}>
        Share budgets, plans or contracts with the Owl: it answers questions from them alongside your live data.
        Sheets become queryable tables; Docs, Slides and PDFs become searchable text the Owl quotes by name.
      </p>

      {!view.configured && !showKeyForm && (
        <button style={btn} onClick={() => setShowKeyForm(true)}>Connect Google Drive</button>
      )}
      {(showKeyForm || (!view.configured && showKeyForm)) && (
        <div style={{ marginBottom: 12 }}>
          <p style={sub}>Paste a Google <b>service-account JSON key</b> (Google Cloud → IAM → Service accounts → Keys). It's stored write-only and never shown again.</p>
          <textarea value={keyJson} onChange={(e) => setKeyJson(e.target.value)} rows={4} placeholder='{"type":"service_account","client_email":"…","private_key":"…"}' style={{ ...input, width: '100%', fontFamily: 'monospace', fontSize: 12 }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button style={btn} disabled={busy === 'key' || !keyJson.trim()} onClick={saveKey}>{busy === 'key' ? 'Saving…' : 'Save key'}</button>
            <button style={ghostBtn} onClick={() => { setShowKeyForm(false); setKeyJson(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {view.configured && (
        <>
          <div style={{ ...row, flexWrap: 'wrap', marginBottom: 12 }}>
            <div style={{ minWidth: 0, flex: '1 1 240px' }}>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 2 }}>
                1 · Share files or folders with{view.envFallback ? ' (platform connection)' : ''}:
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, wordBreak: 'break-all', userSelect: 'all' }}>{view.saEmail}</div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button style={ghostBtn} onClick={copyEmail}>{copied ? 'Copied ✓' : 'Copy email'}</button>
              {!view.envFallback && view.keySet && <button style={dangerBtn} onClick={clearKey}>Disconnect</button>}
              {view.envFallback && <button style={ghostBtn} onClick={() => setShowKeyForm(true)}>Use own key</button>}
            </div>
          </div>

          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>2 · Paste the link — a Sheet, Doc, Slides, PDF or a whole folder (folders keep themselves in sync):</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <input style={input} value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://drive.google.com/…" onKeyDown={(e) => e.key === 'Enter' && link.trim() && add()} />
            <button style={btn} disabled={!link.trim() || busy === 'add'} onClick={add}>{busy === 'add' ? 'Adding…' : 'Add'}</button>
          </div>
        </>
      )}
      {error && <p style={{ ...sub, color: 'var(--danger, #dc2626)' }}>{error}</p>}

      {(view.sources || []).length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {view.sources.map((s) => (
            <div key={s.id} style={{ border: '1px solid var(--hairline)', borderRadius: 10, padding: '10px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span>{icon(s)}</span>
                <span style={{ fontSize: 13.5, fontWeight: 600, flex: '1 1 140px', minWidth: 0, overflowWrap: 'anywhere' }}>{s.name || s.fileId}</span>
                {chip(s.status)}
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  {s.kind === 'folder' && (
                    <button style={ghostBtn} title="Auto-sync hourly" onClick={() => act(s.id, () => run('UpdateSource', s.id, { watch: !s.watch }))}>{s.watch ? '👁 watching' : 'watch'}</button>
                  )}
                  <button style={ghostBtn} disabled={busy === s.id} onClick={() => act(s.id, () => run('SyncSource', s.id))}>{busy === s.id ? '…' : '↻'}</button>
                  <button style={dangerBtn} onClick={() => window.confirm(`Remove "${s.name}"? The Owl forgets it immediately.`) && act(s.id, () => run('RemoveSource', s.id))}>✕</button>
                </div>
              </div>
              {s.error && <div style={{ fontSize: 12, color: 'var(--danger, #dc2626)', marginTop: 4 }}>{s.error}</div>}
              {s.kind === 'folder' && (s.files || []).length > 0 && (
                <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {s.files.map((f) => (
                    <div key={f.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5, color: f.status === 'error' ? 'var(--danger, #dc2626)' : 'var(--muted)' }}>
                      <span>{/pdf/.test(f.mime) ? '📕' : f.kind === 'table' ? '📊' : '📄'}</span>
                      <span style={{ overflowWrap: 'anywhere' }}>{f.name}</span>
                      {f.status === 'error' && <span title={f.error}>✕</span>}
                    </div>
                  ))}
                </div>
              )}
              {s.lastSynced && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>Last synced {new Date(s.lastSynced).toLocaleString()}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const card = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: 16, marginTop: 16 };
const title = { fontSize: 14, fontWeight: 700, marginBottom: 6 };
const sub = { fontSize: 13, color: 'var(--muted)', margin: '0 0 12px' };
const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, border: '1px solid var(--hairline)', borderRadius: 10, padding: '10px 12px' };
const input = { flex: '1 1 220px', minWidth: 0, border: '1px solid var(--hairline)', borderRadius: 8, padding: '9px 12px', fontSize: 13.5, background: 'var(--card)', color: 'inherit' };
const btn = { border: '1px solid var(--hairline)', background: 'var(--brand)', color: '#fff', borderRadius: 980, padding: '9px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', minHeight: 40 };
const ghostBtn = { ...btn, background: 'transparent', color: 'var(--muted)' };
const dangerBtn = { ...ghostBtn, color: 'var(--danger, #dc2626)', flexShrink: 0 };
