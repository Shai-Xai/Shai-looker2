import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// ─── Owl memory — client self-service ─────────────────────────────────────────
// The client-facing twin of the admin OwlMemoryEditor. Lets a client see and edit
// the durable facts the Owl remembers for THEM, at three scopes:
//   • Client  → every chat for this client account (`/api/my/owl-memory`)
//   • Event   → only that event's context (`/api/my/suites/:id/owl-memory`)
//   • Me      → this person's own answer-style preferences (`/api/my/owl-user-memory`)
// Same durable facts the Owl uses on web + WhatsApp; the Owl also offers to remember
// things in chat — this is where you review and curate them. Never PII.
export default function MyOwlMemory({ entityId }) {
  const [scope, setScope] = useState('client'); // 'client' | 'event' | 'user'
  const [suites, setSuites] = useState([]);
  const [suiteId, setSuiteId] = useState('');
  const [items, setItems] = useState([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.mySuites().then((all) => setSuites((all || []).filter((s) => s.entityId === entityId))).catch(() => setSuites([]));
  }, [entityId]);

  // Which store we're editing right now (user scope has no extra id — it's "me").
  const ready = scope === 'user' || (scope === 'client' && entityId) || (scope === 'event' && suiteId);
  useEffect(() => {
    if (!ready) { setItems([]); return; }
    const load = scope === 'event' ? api.myOwlEventMemory(suiteId)
      : scope === 'user' ? api.myOwlUserMemory()
        : api.myOwlMemory(entityId);
    load.then((r) => setItems(r.items || [])).catch(() => setItems([]));
  }, [scope, suiteId, entityId, ready]);

  const add = () => { const t = draft.trim(); if (!t) return; setItems((x) => [{ id: `new-${Date.now()}`, text: t }, ...x]); setDraft(''); };
  const removeItem = (id) => setItems((x) => x.filter((m) => m.id !== id));
  const save = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const payload = items.map((m) => ({ id: m.id, text: m.text }));
      const r = scope === 'event' ? await api.saveMyOwlEventMemory(suiteId, payload)
        : scope === 'user' ? await api.saveMyOwlUserMemory(payload)
          : await api.saveMyOwlMemory(payload, entityId);
      setItems(r.items || []); setSaved(true); setTimeout(() => setSaved(false), 1600);
    } catch { /* ignore */ }
    setBusy(false);
  };

  const fld = { padding: '6px 9px', borderRadius: 7, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 13, fontFamily: 'inherit' };
  const chip = (on) => ({ border: '1px solid var(--hairline)', background: on ? 'var(--brand)' : 'var(--card)', color: on ? '#fff' : 'var(--muted)', borderRadius: 980, padding: '5px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' });
  const blurb = scope === 'event'
    ? 'Facts true only for this event — different events can hold different facts.'
    : scope === 'user'
      ? 'Your personal preferences for how the Owl answers YOU — wording, level of detail, what to lead with. These shape the style, not the data, and only apply to your own chats.'
      : 'Facts about your account the Owl should always know and never re-ask.';

  return (
    <div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 10px' }}>Durable things the Owl remembers, so it doesn't re-ask what it already knows. The Owl also offers to remember things as you chat (web &amp; WhatsApp) — this is where you review and edit them. Don't store anything personal or contact details.</p>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <button onClick={() => setScope('client')} style={chip(scope === 'client')}>🏢 This account</button>
        <button onClick={() => setScope('event')} style={chip(scope === 'event')}>🎟 An event</button>
        <button onClick={() => setScope('user')} style={chip(scope === 'user')}>🙋 Just me</button>
        {scope === 'event' && (
          <select value={suiteId} onChange={(e) => setSuiteId(e.target.value)} style={{ ...fld, minWidth: 200 }}>
            <option value="">Pick an event…</option>
            {suites.map((s) => {
              const icon = s.icon && !s.icon.startsWith('data:') ? `${s.icon} ` : '';
              return <option key={s.id} value={s.id}>{icon}{s.name}</option>;
            })}
          </select>
        )}
      </div>
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 10px', fontStyle: 'italic' }}>{blurb}</p>

      {scope === 'event' && !suiteId ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{suites.length ? 'Pick an event above to see what the Owl remembers for it.' : 'No events yet — once Howler sets one up, you can add event-specific facts here.'}</div>
      ) : (
        <div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
            <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} placeholder={scope === 'user' ? 'Add a preference (e.g. "keep answers short and lead with revenue")…' : `Add a fact the Owl should remember…`} style={{ ...fld, flex: 1 }} />
            <button onClick={add} disabled={!draft.trim()} style={{ ...fld, cursor: draft.trim() ? 'pointer' : 'default' }}>＋ Add</button>
          </div>
          {items.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--muted)', margin: '2px 0 8px' }}>Nothing remembered yet — add one above, or let the Owl offer to remember things as you chat.</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {items.map((m) => (
              <div key={m.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 9px', borderRadius: 8, border: '1px solid var(--hairline)', background: 'var(--card)' }}>
                <span style={{ fontSize: 13 }}>🧠</span>
                <input value={m.text} onChange={(e) => setItems((x) => x.map((z) => (z.id === m.id ? { ...z, text: e.target.value } : z)))} style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', color: 'var(--text)', fontSize: 13, fontFamily: 'inherit' }} />
                <button onClick={() => removeItem(m.id)} title="Remove" style={{ border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 13 }}>🗑</button>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
            <button onClick={save} disabled={busy} style={{ border: 'none', background: 'var(--brand)', color: '#fff', borderRadius: 8, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>
            {saved && <span style={{ fontSize: 12.5, color: '#34c759', fontWeight: 600 }}>Saved ✓</span>}
          </div>
        </div>
      )}
    </div>
  );
}
