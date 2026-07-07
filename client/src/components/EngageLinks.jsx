import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';

// Engage → Links. A per-client set of links grouped into typed CATEGORIES so a
// growing list stays easy to navigate. Landing shows category tiles; tapping one
// drills into just that category's links; a clear back link returns to the tiles.
// Mobile-first (single-column tiles that stack, ≥40px tap targets). Dual-surface:
// the same component serves a client managing their own links and an admin acting
// on a client's behalf — only the intro copy changes by `scope`.
export default function EngageLinks({ entityId, scope = 'admin' }) {
  const isMobile = useIsMobile();
  const [data, setData] = useState(null); // { links, catalog } | null
  const [cat, setCat] = useState(null);   // selected category key, or null (landing)
  const [editing, setEditing] = useState(null); // 'new' | link object | null
  const [manage, setManage] = useState(false);

  const load = () => api.listEngageLinks(entityId)
    .then((r) => setData({ links: r.links || [], catalog: r.catalog || [] }))
    .catch(() => setData({ links: [], catalog: [] }));
  useEffect(() => { load(); setCat(null); }, [entityId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (data === null) return null;
  const { links, catalog } = data;

  const meta = (key) => catalog.find((c) => c.key === key) || { key, label: titleCase(key), icon: '🔗' };
  // Categories that actually have links, ordered by the catalog first then extras.
  const present = [...new Set(links.map((l) => l.category))];
  const ordered = [
    ...catalog.map((c) => c.key).filter((k) => present.includes(k)),
    ...present.filter((k) => !catalog.some((c) => c.key === k)),
  ];

  if (editing) {
    return (
      <LinkEditor
        entityId={entityId}
        catalog={catalog}
        link={editing === 'new' ? null : editing}
        defaultCategory={cat || 'app'}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); load(); }}
      />
    );
  }

  // ── Drilled into one category ──
  if (cat) {
    const inCat = links.filter((l) => l.category === cat);
    const m = meta(cat);
    return (
      <div>
        <button style={{ ...mini, marginBottom: 14 }} onClick={() => setCat(null)}>← All categories</button>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 26 }}>{m.icon}</span>
            <h2 style={{ fontSize: 19, fontWeight: 700, margin: 0 }}>{m.label}</h2>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={mini} onClick={() => setManage((v) => !v)}>{manage ? 'Done' : 'Manage'}</button>
            <button style={primary} onClick={() => setEditing('new')}>+ Add link</button>
          </div>
        </div>
        {inCat.length === 0 ? (
          <p style={{ color: 'var(--muted)', fontSize: 13, padding: '18px 0' }}>No links in this category yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {inCat.map((l) => (
              <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 12, border: '1px solid var(--hairline)', borderRadius: 14, background: 'var(--card)', padding: '4px 6px 4px 4px' }}>
                <a href={l.url} target="_blank" rel="noopener noreferrer" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, padding: '12px 12px', textDecoration: 'none', color: 'var(--text)', minHeight: 40 }}>
                  <span style={{ fontWeight: 700, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.label} <span aria-hidden style={{ color: 'var(--muted)', fontWeight: 400 }}>↗</span></span>
                  <span style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.url}</span>
                </a>
                {manage && (
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0, paddingRight: 6 }}>
                    <button style={mini} onClick={() => setEditing(l)}>Edit</button>
                    <button style={{ ...mini, color: 'var(--error,#ef4444)' }} onClick={() => { if (confirm(`Delete “${l.label}”?`)) api.deleteEngageLink(entityId, l.id).then(load); }}>Delete</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Landing: category tiles ──
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
          {scope === 'my'
            ? 'Your links, grouped by type. Tap a category to see its links.'
            : 'Links for this client, grouped by type. Tap a category to see its links.'}
        </p>
        <button style={primary} onClick={() => setEditing('new')}>+ Add link</button>
      </div>
      {ordered.length === 0 ? (
        <p style={{ color: 'var(--muted)', fontSize: 13, padding: '18px 0' }}>No links yet — add one and pick a category to group it under.</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
          {ordered.map((key) => {
            const m = meta(key);
            const count = links.filter((l) => l.category === key).length;
            return (
              <button
                key={key}
                onClick={() => { setManage(false); setCat(key); }}
                style={{ display: 'flex', alignItems: 'center', gap: 14, textAlign: 'left', minHeight: 64, padding: '16px 18px', border: '1px solid var(--hairline)', borderRadius: 16, background: 'var(--card)', color: 'var(--text)', cursor: 'pointer' }}
              >
                <span style={{ fontSize: 28, lineHeight: 1 }}>{m.icon}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 700, fontSize: 16 }}>{m.label}</span>
                  <span style={{ display: 'block', fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{count} link{count === 1 ? '' : 's'}</span>
                </span>
                <span aria-hidden style={{ fontSize: 20, color: 'var(--muted)' }}>›</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LinkEditor({ entityId, catalog, link, defaultCategory, onClose, onSaved }) {
  const known = catalog.length ? catalog : [{ key: 'app', label: 'App' }];
  const startCat = link?.category || defaultCategory || 'app';
  // If the link's category isn't in the catalog it's a custom one — start in "new" mode.
  const startIsCustom = !known.some((c) => c.key === startCat);
  const [f, setF] = useState({ label: link?.label || '', url: link?.url || '', category: startIsCustom ? '__new' : startCat });
  const [customCat, setCustomCat] = useState(startIsCustom ? startCat : '');
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!f.label.trim()) { alert('Give the link a name.'); return; }
    if (!f.url.trim()) { alert('Add the link URL.'); return; }
    const category = f.category === '__new' ? (customCat.trim() || 'app') : f.category;
    setBusy(true);
    try {
      if (link) await api.updateEngageLink(entityId, link.id, { ...f, category });
      else await api.createEngageLink(entityId, { ...f, category });
      onSaved();
    } catch (e) { alert('Save failed: ' + e.message); } finally { setBusy(false); }
  };

  return (
    <div style={{ maxWidth: 520 }}>
      <button style={{ ...mini, marginBottom: 14 }} onClick={onClose}>← Back</button>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Link name"><input style={input} value={f.label} onChange={(e) => set('label', e.target.value)} placeholder="e.g. Chotulink" /></Field>
        <Field label="URL"><input style={input} value={f.url} onChange={(e) => set('url', e.target.value)} placeholder="https://…" inputMode="url" autoCapitalize="off" spellCheck={false} /></Field>
        <Field label="Category">
          <select style={input} value={f.category} onChange={(e) => set('category', e.target.value)}>
            {known.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            <option value="__new">+ New category…</option>
          </select>
          {f.category === '__new' && (
            <input style={{ ...input, marginTop: 8 }} value={customCat} onChange={(e) => setCustomCat(e.target.value)} placeholder="New category name (e.g. Partners)" />
          )}
        </Field>
        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          <button style={primary} onClick={save} disabled={busy}>{busy ? 'Saving…' : link ? 'Save changes' : 'Add link'}</button>
          <button style={mini} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function titleCase(s) { return String(s || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }
function Field({ label, children }) { return <div><div style={lbl}>{label}</div>{children}</div>; }
const input = { width: '100%', boxSizing: 'border-box', padding: '10px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 14, outline: 'none', background: 'var(--card)', color: 'var(--text)' };
const mini = { padding: '9px 14px', borderRadius: 8, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', minHeight: 40 };
const primary = { padding: '10px 18px', borderRadius: 980, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 40 };
const lbl = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted)', marginBottom: 5 };
