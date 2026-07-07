// Admin curation surface for the Owl's product help (server/helpBot.js) — the
// admin half of the dual-surface rule (the client half is the Owl chat itself:
// its productHelp tool answers how-to / what's-new from THIS knowledge). Curate
// + publish the versioned articles (no deploy needed) and flip product help
// on/off. Lives under Admin → Product → Help knowledge.
import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';

const ROLE_OPTIONS = [
  ['owner', 'Owner'], ['manager', 'Manager'], ['marketing', 'Marketing'],
  ['finance', 'Finance'], ['viewer', 'Viewer'], ['ops', 'Event Ops'],
];
const BLANK = { title: '', slug: '', body: '', tags: '', roles: '', features: '', deepLink: '', published: true };

export default function HelpBotAdmin() {
  const [articles, setArticles] = useState(null);
  const [settings, setSettings] = useState(null);
  const [editing, setEditing] = useState(null); // article being edited/created (or null)
  const [err, setErr] = useState('');

  const load = () => {
    api.adminHelpArticles().then(setArticles).catch((e) => setErr(e.message));
    api.adminHelpSettings().then(setSettings).catch((e) => setErr(e.message));
  };
  useEffect(load, []);

  const saveSettings = async (patch) => {
    setSettings((s) => ({ ...s, ...patch }));
    try { setSettings(await api.adminSaveHelpSettings({ ...settings, ...patch })); }
    catch (e) { setErr(e.message); load(); }
  };

  const save = async () => {
    setErr('');
    if (!editing.title.trim() || !editing.body.trim()) { setErr('A title and body are required.'); return; }
    try {
      if (editing.id) await api.adminUpdateHelpArticle(editing.id, editing);
      else await api.adminCreateHelpArticle(editing);
      setEditing(null); load();
    } catch (e) { setErr(e.message); }
  };
  const remove = async (a) => {
    if (!window.confirm(`Delete “${a.title}”? Seeded articles won’t come back on redeploy.`)) return;
    try { await api.adminDeleteHelpArticle(a.id); load(); } catch (e) { setErr(e.message); }
  };

  if (!articles || !settings) return <p style={hint}>{err || 'Loading…'}</p>;

  return (
    <div>
      <p style={hint}>
        The <b>Owl</b> answers users’ questions about Pulse itself — how-to, what’s new, what they can do —
        grounded <b>only</b> in the <b>published</b> articles here (plus published release notes) and tailored
        to each user’s role, tenant and event. Publishing is the gate: drafts and unreleased work can never
        reach a user. Edits apply immediately, no deploy. Tag articles with the roles they matter to and the
        features they require (e.g. <code>cashless</code>) so they only surface for the right accounts.
      </p>
      {err && <p style={{ ...hint, color: '#c0392b' }}>{err}</p>}

      {/* Availability */}
      <div style={card}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!settings.enabled} onChange={(e) => saveSettings({ enabled: e.target.checked })} />
          Product help enabled (the Owl may answer how-to / what’s-new questions)
        </label>
      </div>

      {/* Article list */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '18px 0 10px' }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Knowledge ({articles.length})</div>
        <button onClick={() => setEditing({ ...BLANK })} style={primaryBtn}>+ New article</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {articles.map((a) => (
          <div key={a.id} style={{ ...card, marginBottom: 0, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {a.title}
                {!a.published && <span style={pill}>draft</span>}
                {a.source === 'seed' && <span style={{ ...pill, background: 'rgba(128,128,128,0.14)', color: 'var(--muted)' }}>seed</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.body}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {a.roles && <span>👤 {a.roles}</span>}
                {a.features && <span>🧩 {a.features}</span>}
                {a.deepLink && <span>↳ {a.deepLink}</span>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button onClick={() => setEditing({ ...BLANK, ...a })} style={miniOutline}>Edit</button>
              <button onClick={() => remove(a)} style={{ ...miniOutline, color: '#c0392b' }}>Delete</button>
            </div>
          </div>
        ))}
      </div>

      {/* Editor modal */}
      {editing && (
        <div style={overlay} onClick={() => setEditing(null)}>
          <div style={modal} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>{editing.id ? 'Edit article' : 'New article'}</div>
            <Field label="Title"><input style={inp} value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></Field>
            <Field label="Body (the facts the Owl may use — plain text or light markdown)">
              <textarea rows={6} style={ta} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
            </Field>
            <Field label="Search tags (space or comma separated — boosts retrieval)">
              <input style={inp} value={editing.tags} onChange={(e) => setEditing({ ...editing, tags: e.target.value })} placeholder="campaign email abandoned cart" />
            </Field>
            <Field label="Relevant to roles (leave all off for everyone)">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {ROLE_OPTIONS.map(([key, label]) => {
                  const set = new Set((editing.roles || '').split(',').map((s) => s.trim()).filter(Boolean));
                  const on = set.has(key);
                  return (
                    <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' }}>
                      <input type="checkbox" checked={on} onChange={(e) => { e.target.checked ? set.add(key) : set.delete(key); setEditing({ ...editing, roles: [...set].join(',') }); }} />
                      {label}
                    </label>
                  );
                })}
              </div>
            </Field>
            <Field label="Requires features (comma separated — hides the article from accounts without them, e.g. cashless)">
              <input style={inp} value={editing.features} onChange={(e) => setEditing({ ...editing, features: e.target.value })} placeholder="cashless" />
            </Field>
            <Field label="Deep link (in-app screen path, e.g. /engage/campaigns)">
              <input style={inp} value={editing.deepLink} onChange={(e) => setEditing({ ...editing, deepLink: e.target.value })} placeholder="/engage/campaigns" />
            </Field>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, margin: '4px 0 14px', cursor: 'pointer' }}>
              <input type="checkbox" checked={editing.published !== false} onChange={(e) => setEditing({ ...editing, published: e.target.checked })} />
              Published (unpublished = a draft the Owl can never see)
            </label>
            {err && <p style={{ ...hint, color: '#c0392b' }}>{err}</p>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setEditing(null)} style={miniOutline}>Cancel</button>
              <button onClick={save} style={primaryBtn}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const hint = { fontSize: 13, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.5 };
const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 14 };
const inp = { width: '100%', boxSizing: 'border-box', border: '1px solid var(--hairline)', borderRadius: 8, padding: '9px 11px', fontSize: 14, background: 'var(--elevated)', color: 'var(--text)' };
const ta = { ...inp, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 };
const primaryBtn = { padding: '8px 16px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: 'pointer' };
const miniOutline = { padding: '6px 12px', background: 'var(--card)', border: '1.5px solid var(--hairline)', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer', color: 'var(--text)' };
const pill = { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', background: 'rgba(230,160,30,0.18)', color: '#c0392b', borderRadius: 980, padding: '2px 8px' };
const overlay = { position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const modal = { background: 'var(--card)', borderRadius: 16, padding: 22, width: 560, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.35)' };
