import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../lib/api.js';

// "Save as new (client version)" dialog. Lets an admin fork the dashboard they're
// editing into a CLIENT-OWNED copy for this suite's client, choosing the folder
// and which set it lands in. The shared template is left untouched.
export default function SaveAsClientModal({ entityId, entityName, defaultTitle, onConfirm, onClose }) {
  const [title, setTitle] = useState(defaultTitle || 'Untitled dashboard');
  const [folder, setFolder] = useState(`Custom/${entityName || 'Client'}`);
  const [sets, setSets] = useState([]);          // the client's custom sets
  const [dest, setDest] = useState('');          // '' = replace in place; setId; or '__new__'
  const [newSetName, setNewSetName] = useState('');
  const [folders, setFolders] = useState([]);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (entityId) api.getEntitySets(entityId).then((r) => setSets(r?.sets || [])).catch(() => {});
    api.adminFolders().then(setFolders).catch(() => {});
  }, [entityId]);

  const submit = async () => {
    setBusy(true); setErr('');
    try {
      const payload = { title: title.trim(), folder: folder.trim() };
      if (dest === '__new__') payload.newSetName = newSetName.trim() || `${entityName || 'Client'} dashboards`;
      else if (dest) payload.setId = dest;
      await onConfirm(payload);
    } catch (e) {
      setErr(e.message || 'Could not save'); setBusy(false);
    }
  };

  return createPortal(
    <div style={overlay} onClick={onClose}>
      <div style={card} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 4px', fontSize: 17, fontWeight: 700 }}>Save as {entityName || 'client'}’s version</h3>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.4 }}>
          Creates a copy owned by this client. The shared template stays unchanged for everyone else.
        </p>

        <label style={lbl}>Title</label>
        <input style={inp} value={title} onChange={(e) => setTitle(e.target.value)} />

        <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '12px 0 0', lineHeight: 1.4 }}>
          It’ll sit exactly where {entityName || 'the client'} sees it now, in their library under
          <strong> {folder || `Custom/${entityName || 'Client'}`}</strong>.
        </p>

        <button type="button" style={advToggle} onClick={() => setAdvanced((v) => !v)}>
          {advanced ? '▾' : '▸'} Change folder or set
        </button>
        {advanced && (
          <div style={{ marginTop: 4 }}>
            <label style={lbl}>Folder</label>
            <input style={inp} value={folder} onChange={(e) => setFolder(e.target.value)} list="fork-folders" placeholder={`Custom/${entityName || 'Client'}`} />
            <datalist id="fork-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>

            <label style={lbl}>Where should it go?</label>
            <select style={inp} value={dest} onChange={(e) => setDest(e.target.value)}>
              <option value="">Replace it where the client sees it now (recommended)</option>
              {sets.map((s) => <option key={s.id} value={s.id}>Add to “{s.name}”</option>)}
              <option value="__new__">Create a new set…</option>
            </select>
            {dest === '__new__' && (
              <input style={inp} value={newSetName} onChange={(e) => setNewSetName(e.target.value)} placeholder="New set name" />
            )}
          </div>
        )}

        {err && <p style={{ color: 'var(--error)', fontSize: 12.5, margin: '8px 0 0' }}>{err}</p>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button style={ghost} onClick={onClose} disabled={busy}>Cancel</button>
          <button style={primary} onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save client version'}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 600, padding: 20 };
const card = { width: 'min(460px, 96vw)', background: 'var(--card)', borderRadius: 14, boxShadow: '0 12px 48px rgba(0,0,0,0.25)', padding: 22, maxHeight: '90vh', overflowY: 'auto' };
const lbl = { display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', margin: '12px 0 4px' };
const inp = { width: '100%', boxSizing: 'border-box', padding: '9px 11px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13.5, outline: 'none', fontFamily: 'inherit', background: 'var(--card)', color: 'var(--text)' };
const advToggle = { display: 'inline-block', marginTop: 12, padding: 0, background: 'none', border: 'none', color: 'var(--brand)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
const ghost = { padding: '8px 16px', background: 'rgba(0,0,0,0.05)', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer', color: 'var(--text)' };
const primary = { padding: '8px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
