// Admin surface for the Support Owl's knowledge spine (server/supportOwl.js,
// P0a of docs/specs/SUPPORT_OWL_SPEC.md): the PLATFORM tier of the two-tier
// customer-support knowledge base — Howler's help docs mirrored from HelpDocs
// (synced, never retyped) plus manual platform entries — with a retrieval
// preview to sanity-check what the future agent would ground on. The CLIENT
// tier lives in each client's Fan Owl knowledge. Lives under Admin → Product →
// 🛟 Support Owl.
import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';

const BLANK = { kind: 'faq', title: '', body: '', category: '' };
const KIND_OPTIONS = [['faq', 'FAQ'], ['policy', 'Policy'], ['info', 'Info'], ['article', 'Article']];

export default function SupportOwlAdmin() {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null);
  const [err, setErr] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [sync, setSync] = useState({ busy: false, msg: '' });
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);

  const load = () => api.adminSupportOwl().then(setData).catch((e) => setErr(e.message));
  useEffect(load, []);

  const saveSettings = async (patch) => {
    setErr('');
    try { setData(await api.adminSupportOwlSettings(patch)); setKeyInput(''); }
    catch (e) { setErr(e.message); }
  };
  const runSync = async () => {
    setSync({ busy: true, msg: '' });
    try {
      const r = await api.adminSupportOwlSync();
      setSync({ busy: false, msg: `Synced ${r.total} article${r.total === 1 ? '' : 's'} — ${r.added} new, ${r.updated} updated, ${r.removed} removed.` });
      load();
    } catch (e) { setSync({ busy: false, msg: e.message }); }
  };
  const save = async () => {
    setErr('');
    if (!editing.title.trim() || !editing.body.trim()) { setErr('A title and body are required.'); return; }
    try {
      if (editing.id) await api.adminUpdateSupportKnowledge(editing.id, editing);
      else await api.adminCreateSupportKnowledge(editing);
      setEditing(null); load();
    } catch (e) { setErr(e.message); }
  };
  const remove = async (k) => {
    if (!window.confirm(`Delete “${k.title}”?`)) return;
    try { await api.adminDeleteSupportKnowledge(k.id); load(); } catch (e) { setErr(e.message); }
  };
  const search = async () => {
    if (!q.trim()) { setResults(null); return; }
    try { setResults((await api.adminSupportOwlSearch(q)).results); } catch (e) { setErr(e.message); }
  };

  if (!data) return <p style={hint}>{err || 'Loading…'}</p>;
  const synced = data.knowledge.filter((k) => k.source === 'helpdocs');
  const manual = data.knowledge.filter((k) => k.source !== 'helpdocs');
  const ls = data.helpdocs.lastSync;

  return (
    <div>
      <p style={hint}>
        The <b>platform tier</b> of the Support Owl’s knowledge — general “how Howler works” answers
        (tickets, refunds, entry, cashless…) shared by <b>every</b> client’s future support agent.
        Howler’s help docs are <b>mirrored from HelpDocs</b> (maintain them there; sync brings them here),
        plus any manual platform entries below. Each client’s own FAQs/policies (the <b>client tier</b>,
        which wins on conflict) live in their Fan Owl knowledge. Spec: <code>docs/specs/SUPPORT_OWL_SPEC.md</code>.
      </p>
      {err && <p style={{ ...hint, color: '#c0392b' }}>{err}</p>}

      {/* Availability + HelpDocs connection */}
      <div style={card}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, fontWeight: 600, cursor: 'pointer', marginBottom: 14 }}>
          <input type="checkbox" checked={!!data.enabled} onChange={(e) => saveSettings({ enabled: e.target.checked })} />
          Support Owl enabled (gates the sync + every future consumer surface)
        </label>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
          HelpDocs API key {data.helpdocs.keySet ? `— set (${data.helpdocs.keyMask})` : '— not set'} · create a <b>read-only</b> key in HelpDocs → Settings → API
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            style={{ ...inp, flex: 1, minWidth: 180 }} type="password" value={keyInput}
            placeholder={data.helpdocs.keySet ? 'Replace key…' : 'Paste the HelpDocs API key'}
            onChange={(e) => setKeyInput(e.target.value)}
          />
          <button style={primaryBtn} disabled={!keyInput.trim()} onClick={() => saveSettings({ helpdocsApiKey: keyInput })}>Save key</button>
          <button style={miniOutline} disabled={!data.helpdocs.keySet || sync.busy} onClick={runSync}>{sync.busy ? 'Syncing…' : '🔄 Sync now'}</button>
        </div>
        <div style={{ fontSize: 12, color: ls && !ls.ok ? '#c0392b' : 'var(--muted)', marginTop: 8 }}>
          {!ls ? 'Never synced. Articles refresh automatically once a day after the first sync.'
            : ls.ok ? `Last synced ${new Date(ls.at).toLocaleString()} — ${ls.total} articles (${ls.added} new, ${ls.updated} updated, ${ls.removed} removed). Refreshes daily.`
              : `Last sync failed (${new Date(ls.at).toLocaleString()}): ${ls.error}`}
        </div>
        {sync.msg && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>{sync.msg}</div>}
      </div>

      {/* Retrieval preview */}
      <div style={card}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Try a question</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input style={{ ...inp, flex: 1, minWidth: 180 }} value={q} placeholder="e.g. how do refunds work?"
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
          <button style={miniOutline} onClick={search}>Search</button>
        </div>
        {results && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {!results.length && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Nothing matches — the future agent would say it doesn’t know and escalate.</div>}
            {results.map((r) => (
              <div key={r.id} style={{ fontSize: 12.5, padding: '8px 10px', border: '1px solid var(--hairline)', borderRadius: 8 }}>
                <b>{r.title}</b> <span style={pillMuted}>{r.tier}</span>
                <div style={{ color: 'var(--muted)', marginTop: 3, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{r.body}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Manual platform entries */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '18px 0 10px', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Platform entries ({manual.length})</div>
        <button onClick={() => setEditing({ ...BLANK })} style={primaryBtn}>+ New entry</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {!manual.length && <p style={hint}>No manual entries yet — for anything the help docs don’t cover (tone, exceptions, internal policy).</p>}
        {manual.map((k) => (
          <div key={k.id} style={{ ...card, marginBottom: 0, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {k.title} <span style={pillMuted}>{k.kind}</span>{k.category && <span style={pillMuted}>{k.category}</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k.body}</div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button onClick={() => setEditing({ ...BLANK, ...k })} style={miniOutline}>Edit</button>
              <button onClick={() => remove(k)} style={{ ...miniOutline, color: '#c0392b' }}>Delete</button>
            </div>
          </div>
        ))}
      </div>

      {/* Synced mirror (read-only) */}
      <div style={{ fontSize: 15, fontWeight: 700, margin: '18px 0 10px' }}>Synced from HelpDocs ({synced.length})</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {!synced.length && <p style={hint}>Nothing synced yet — save the API key above and hit Sync now.</p>}
        {synced.map((k) => (
          <div key={k.id} style={{ fontSize: 12.5, padding: '8px 12px', border: '1px solid var(--hairline)', borderRadius: 8, display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 }}>
            <b style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '45%' }}>{k.title}</b>
            <span style={{ color: 'var(--muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k.body}</span>
            {k.url && <a href={k.url} target="_blank" rel="noreferrer" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>edit in HelpDocs ↗</a>}
          </div>
        ))}
      </div>

      {/* Editor modal */}
      {editing && (
        <div style={overlay} onClick={() => setEditing(null)}>
          <div style={modal} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>{editing.id ? 'Edit entry' : 'New platform entry'}</div>
            <Field label="Kind">
              <select style={inp} value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value })}>
                {KIND_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            <Field label="Title (the question, in a customer’s words)"><input style={inp} value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></Field>
            <Field label="Body (the answer — the agent may only state what’s written here)">
              <textarea rows={6} style={ta} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
            </Field>
            <Field label="Category (optional grouping)"><input style={inp} value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })} placeholder="refunds" /></Field>
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
const pillMuted = { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', background: 'rgba(128,128,128,0.14)', color: 'var(--muted)', borderRadius: 980, padding: '2px 8px' };
const overlay = { position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const modal = { background: 'var(--card)', borderRadius: 16, padding: 22, width: 560, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.35)' };
