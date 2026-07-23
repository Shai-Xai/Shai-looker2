import { useState, useMemo } from 'react';

// "Move to…" picker for reparenting a whole folder (with all its nested
// subfolders + dashboards) in one action. Mobile-first: a searchable list of
// destinations that works on touch — the reliable fallback to desktop drag-and-drop.
// Blocks the destinations that would be invalid (the folder itself, any of its
// descendants, its current spot, or a name collision) so the move can't fail.
export default function FolderMoveModal({ folder, allFolders, onMove, onClose }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const leaf = folder.split('/').pop();
  const currentParent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';

  // Every folder node in the tree = every path prefix of every stored folder path.
  const nodes = useMemo(() => {
    const set = new Set();
    for (const f of allFolders) {
      const parts = f.split('/');
      for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'));
    }
    return [...set];
  }, [allFolders]);

  // Candidate destination PARENTS (incl. root ''), each annotated with why it may
  // be unavailable. A move drops `folder` INTO the parent, becoming parent/leaf.
  const options = useMemo(() => {
    const list = ['', ...nodes.sort((a, b) => a.localeCompare(b))];
    return list
      .filter((p) => p !== folder && !p.startsWith(folder + '/')) // not itself / a descendant
      .map((p) => {
        const newPath = p ? `${p}/${leaf}` : leaf;
        let reason = '';
        if (p === currentParent) reason = 'Current location';
        else if (nodes.includes(newPath)) reason = 'Name already used here';
        return { parent: p, label: p || '↑ Top level', newPath, disabled: !!reason, reason };
      })
      .filter((o) => !q.trim() || o.label.toLowerCase().includes(q.trim().toLowerCase()));
  }, [nodes, folder, leaf, currentParent, q]);

  async function choose(parent) {
    setBusy(true); setErr('');
    try { await onMove(parent); }
    catch (e) { setErr(e.message || String(e)); setBusy(false); }
  }

  return (
    <div style={overlay} onClick={busy ? undefined : onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>Move folder</div>
            <div style={{ fontSize: 17, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>📁 {leaf}</div>
          </div>
          <button style={closeBtn} onClick={onClose} aria-label="Close" disabled={busy}>✕</button>
        </div>

        <div style={{ padding: '10px 18px 4px' }}>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>Everything inside moves with it. Choose a new parent folder:</div>
          <input style={search} placeholder="Search folders…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        </div>

        <div style={body}>
          {options.length === 0 && <div style={{ color: 'var(--muted)', padding: 12 }}>No matching destination.</div>}
          {options.map((o) => (
            <button
              key={o.parent || '__root'}
              style={{ ...row, ...(o.disabled ? rowDisabled : null) }}
              disabled={o.disabled || busy}
              title={o.disabled ? o.reason : `Move here → ${o.newPath}`}
              onClick={() => choose(o.parent)}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
              {o.disabled ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>{o.reason}</span> : <span style={{ fontSize: 12, color: 'var(--brand)', fontWeight: 700 }}>Move here →</span>}
            </button>
          ))}
        </div>

        {err && <div style={{ color: 'var(--error)', fontSize: 13, padding: '0 18px 14px' }}>{err}</div>}
        {busy && <div style={{ color: 'var(--muted)', fontSize: 13, padding: '0 18px 14px' }}>Moving…</div>}
      </div>
    </div>
  );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 600, padding: 20 };
const panel = { width: 'min(520px, 96vw)', maxHeight: '85vh', background: 'var(--card)', borderRadius: 16, boxShadow: '0 12px 48px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', overflow: 'hidden' };
const header = { display: 'flex', alignItems: 'center', gap: 10, padding: '16px 18px', borderBottom: '1px solid var(--border)' };
const body = { flex: 1, overflowY: 'auto', padding: '8px 12px 12px' };
const search = { width: '100%', padding: '10px 12px', border: '1px solid var(--hairline)', borderRadius: 10, fontSize: 14, outline: 'none', background: 'var(--card)', boxSizing: 'border-box' };
const row = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '12px 12px', minHeight: 44, background: 'transparent', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 600, color: 'var(--text)', cursor: 'pointer' };
const rowDisabled = { opacity: 0.5, cursor: 'default', fontWeight: 500 };
const closeBtn = { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 17, color: '#888' };
