import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';
import ChartTile from './tiles/ChartTile.jsx';
import ShareMenu from './ShareMenu.jsx';

// The native, Claude-powered agentic Owl — the conversational "pull" door onto the
// askData tool (server/owlChat.js). Drops into the same drawer slot as the Inventive
// AnalystDrawer (swapped behind FEATURES.owlNativeChat), mirroring its docked/overlay
// shell so the A/B is apples-to-apples. Answers stream in as plain text; every figure
// is fetched + scoped server-side, so nothing here can reach another client's data.
//
// Mobile-first: single column, full-width panel on phones.
export default function OwlChat({ open, onClose, suiteId, entityId, dashboardId, clients = [], events = [], isAdmin = false }) {
  const isMobile = useIsMobile();
  const [messages, setMessages] = useState([]); // [{ role:'user'|'owl', text }]
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [threadId, setThreadId] = useState(null);
  const [dock, setDock] = useState(() => localStorage.getItem('howler_owl_dock') || 'docked');
  const [zoom, setZoom] = useState(() => parseFloat(localStorage.getItem('howler_owl_zoom')) || 1);
  // Scope the Owl answers for — pick a client (organiser) and optionally an event.
  const [selEntity, setSelEntity] = useState(entityId || '');
  const [selSuite, setSelSuite] = useState(suiteId || '');
  const [sidebarOpen, setSidebarOpen] = useState(false); // chat list: persistent on desktop, slide-over on mobile
  const [threads, setThreads] = useState([]);
  const [editingId, setEditingId] = useState(null); // thread being renamed inline
  const [editText, setEditText] = useState('');
  const [movingId, setMovingId] = useState(null); // thread whose folder is being changed
  const [confirmDelId, setConfirmDelId] = useState(null); // thread pending a 2nd-tap delete confirm
  const [collapsedFolders, setCollapsedFolders] = useState({});
  const [uploads, setUploads] = useState([]); // attached external data (CSV files / Google Sheets)
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachBusy, setAttachBusy] = useState(false);
  const fileRef = useRef(null);
  const [listening, setListening] = useState(false); // voice dictation
  const recogRef = useRef(null);
  const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
  const toggleMic = () => {
    if (listening) { try { recogRef.current && recogRef.current.stop(); } catch { /* ignore */ } return; }
    if (!SR) return;
    const r = new SR(); recogRef.current = r;
    r.lang = 'en-ZA'; r.interimResults = true; r.continuous = true;
    const base = input ? `${input} ` : '';
    r.onresult = (e) => { let t = ''; for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript; setInput(base + t); };
    r.onerror = () => setListening(false);
    r.onend = () => setListening(false);
    try { r.start(); setListening(true); } catch { setListening(false); }
  };
  const [followups, setFollowups] = useState([]); // suggested next questions for the latest answer
  const [status, setStatus] = useState(''); // live "thinking" label streamed while the Owl works
  const [commands, setCommands] = useState([]); // "/" slash-command palette (from the tool registry)
  const [slashIdx, setSlashIdx] = useState(0);   // highlighted command in the palette
  const taRef = useRef(null);                     // the composer textarea (for focus after picking)
  const [chatCopied, setChatCopied] = useState(false);
  const scrollRef = useRef(null);
  // Copy the whole conversation as plain text (Q/Owl transcript) to the clipboard.
  const copyChat = async () => {
    const text = messages.filter((m) => m.text).map((m) => `${m.role === 'user' ? 'Q' : 'Owl'}: ${m.text}`).join('\n\n');
    try { await navigator.clipboard.writeText(text); setChatCopied(true); setTimeout(() => setChatCopied(false), 2000); } catch { /* ignore */ }
  };
  // Save the conversation as a PDF: clone the rendered messages into a print window
  // (charts→PNG, tables/text preserved), seed the app's CSS vars with light values so
  // colours resolve, then trigger the browser's print → "Save as PDF". No dependency.
  const printChat = () => {
    const node = scrollRef.current; if (!node) return;
    const clone = node.cloneNode(true);
    const srcCanvas = node.querySelectorAll('canvas'); const cloneCanvas = clone.querySelectorAll('canvas');
    cloneCanvas.forEach((c, i) => { try { const img = document.createElement('img'); img.src = srcCanvas[i].toDataURL('image/png'); img.style.maxWidth = '100%'; c.replaceWith(img); } catch { /* tainted/none */ } });
    clone.querySelectorAll('button').forEach((b) => b.remove()); // drop interactive controls
    const title = (messages.find((m) => m.role === 'user' && m.text)?.text || 'Owl chat').slice(0, 70);
    const scope = [clients.find((c) => c.id === selEntity)?.name, events.find((e) => e.id === selSuite)?.name].filter(Boolean).join(' · ');
    const w = window.open('', '_blank'); if (!w) return;
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>:root{--text:#1a1a1a;--muted:#6b7280;--brand:#3b5bfd;--card:#fff;--bg:#fafafe;--hairline:#e2e2e8;--elevated:#f1f1f5}body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;padding:28px;max-width:780px;margin:0 auto;line-height:1.5}h1{font-size:17px;margin:0 0 2px}.sub{color:#6b7280;font-size:12px;margin:0 0 16px}table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #e2e2e8;padding:5px 9px;text-align:left;font-size:12.5px}img{max-width:100%}</style></head><body><h1>🦉 ${title}</h1>${scope ? `<p class="sub">${scope}</p>` : ''}${clone.innerHTML}</body></html>`);
    w.document.close();
    setTimeout(() => { w.focus(); w.print(); }, 350);
  };
  const pickDock = (m) => { localStorage.setItem('howler_owl_dock', m); setDock(m); };
  const bumpZoom = (d) => setZoom((z) => { const n = Math.min(1.3, Math.max(0.8, Math.round((z + d) * 100) / 100)); localStorage.setItem('howler_owl_zoom', String(n)); return n; });

  // Follow the page context if it changes while open.
  useEffect(() => { setSelEntity(entityId || ''); }, [entityId]);
  useEffect(() => { setSelSuite(suiteId || ''); }, [suiteId]);
  // Auto-default the event: the first time the picker has data and nothing is in
  // scope, select the client's CURRENT on-sale event that has goals (falling back to
  // any event with goals). Runs once so it never fights a manual change. Only when
  // the picker is visible, so the chosen event is always shown and changeable.
  const autoPicked = useRef(false);
  useEffect(() => {
    if (autoPicked.current || suiteId || selSuite || !events.length) return;
    if (!(isAdmin || clients.length > 1)) return;
    const scope = selEntity ? events.filter((e) => e.entityId === selEntity) : events;
    const withGoals = scope.filter((e) => e.hasGoals);
    const choice = withGoals.find((e) => e.onSale) || withGoals[0];
    if (!choice) return;
    autoPicked.current = true;
    if (!selEntity) setSelEntity(choice.entityId);
    setSelSuite(choice.id);
  }, [events, selEntity, selSuite, suiteId, isAdmin, clients.length]);
  // Changing scope starts a fresh conversation (don't mix clients' data in a thread).
  const resetThread = () => { setMessages([]); setThreadId(null); };
  const refreshThreads = async () => { try { const r = await api.owlThreads(); setThreads(r.threads || []); } catch { /* ignore */ } };
  const newChat = () => { resetThread(); setInput(''); setEditingId(null); if (isMobile) setSidebarOpen(false); };
  async function loadThread(t) {
    try {
      const r = await api.owlThreadMessages(t.id);
      setMessages((r.messages || []).map((m) => ({ role: m.role === 'user' ? 'user' : 'owl', text: m.body, sources: m.sources })));
      setThreadId(t.id);
      setSelEntity(t.entityId || ''); setSelSuite(t.suiteId || '');
    } catch { /* ignore */ }
    setEditingId(null);
    if (isMobile) setSidebarOpen(false);
  }
  const startRename = (t) => { setEditingId(t.id); setEditText(t.title || ''); };
  const commitRename = async (id) => {
    const title = editText.trim(); setEditingId(null);
    if (!title) return;
    setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, title } : t)));
    try { await api.owlRenameThread(id, title); } catch { /* ignore */ } refreshThreads();
  };
  // Delete is a reliable in-app two-tap (🗑 → red "Delete?") — no native
  // window.confirm, which can be suppressed in the overlay/PWA and made the
  // trash silently do nothing. Optimistic remove, then reconcile with the server.
  const deleteThread = async (t) => {
    setConfirmDelId(null);
    setThreads((ts) => ts.filter((x) => x.id !== t.id));
    if (t.id === threadId) newChat();
    try { await api.owlDeleteThread(t.id); } catch (e) { window.alert((e && e.message) || 'Could not delete the chat.'); }
    refreshThreads();
  };
  const startMove = (t) => { setEditingId(null); setMovingId(t.id); };
  const setFolder = async (id, folder) => {
    setMovingId(null);
    const f = String(folder || '').trim();
    setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, folder: f } : t)));
    try { await api.owlSetThreadFolder(id, f); } catch { /* ignore */ } refreshThreads();
  };
  // Attached external data (CSV files / live Google Sheets) the Owl can query.
  const attachEntity = selEntity || entityId || '';
  const refreshUploads = () => { if (!attachEntity) { setUploads([]); return; } api.owlUploads(attachEntity).then((r) => setUploads(r.uploads || [])).catch(() => {}); };
  const onPickFile = async (e) => {
    const f = e.target.files && e.target.files[0]; if (e.target) e.target.value = '';
    if (!f || !attachEntity) return;
    setAttachBusy(true);
    try { await api.owlUploadCsv(attachEntity, f.name.replace(/\.[^.]+$/, ''), await f.text()); refreshUploads(); } catch (err) { window.alert((err && err.message) || 'Upload failed.'); }
    setAttachBusy(false);
  };
  const addSheet = async () => {
    if (!attachEntity) return;
    const url = window.prompt('Paste a Google Sheet link (it must be shared "anyone with the link", or published to the web).'); if (!url || !url.trim()) return;
    const name = (window.prompt('Name this source', 'Google Sheet') || 'Google Sheet').trim();
    setAttachBusy(true);
    try { await api.owlUploadSheet(attachEntity, name, url.trim()); refreshUploads(); } catch (err) { window.alert((err && err.message) || 'Could not import the sheet.'); }
    setAttachBusy(false);
  };
  const refreshSheet = async (u) => { setAttachBusy(true); try { await api.owlRefreshUpload(u.id); refreshUploads(); } catch (err) { window.alert((err && err.message) || 'Refresh failed.'); } setAttachBusy(false); };
  const removeUpload = async (u) => { if (!window.confirm(`Remove "${u.name}"?`)) return; setUploads((x) => x.filter((z) => z.id !== u.id)); try { await api.owlDeleteUpload(u.id); } catch { /* ignore */ } refreshUploads(); };

  const clientEvents = events.filter((e) => e.entityId === selEntity);
  const showPicker = isAdmin || clients.length > 1;
  // Clients are auto-scoped server-side; admins need a client or event chosen.
  const canAsk = isAdmin ? !!(selEntity || selSuite) : true;

  // Keep the latest message in view as it streams.
  useEffect(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, [messages]);
  // Load the saved-chats list when the panel opens; show the sidebar by default on
  // desktop (a persistent column) and hidden on mobile (a slide-over toggled by ☰).
  useEffect(() => { if (open) { refreshThreads(); setSidebarOpen(false); } }, [open, isMobile]); // chats list collapsed by default; toggle with ☰
  // The "/" command palette, sourced from the Owl's tool registry (loads once).
  useEffect(() => { if (open && !commands.length) api.owlCapabilities().then((r) => setCommands(r.commands || [])).catch(() => {}); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // Load the client's attached data sources (for the 📎 panel + so the Owl can query them).
  useEffect(() => { if (!open || !attachEntity) { setUploads([]); return; } api.owlUploads(attachEntity).then((r) => setUploads(r.uploads || [])).catch(() => {}); }, [open, attachEntity]);
  // Esc closes (only while open).
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  async function send(text) {
    const q = String(text ?? input).trim();
    if (!q || busy) return;
    if (listening) { try { recogRef.current && recogRef.current.stop(); } catch { /* ignore */ } setListening(false); }
    if (!canAsk) { setMessages((m) => [...m, { role: 'owl', text: 'Pick a client (or open an event) above, then ask me — I scope to that organiser.' }]); return; }
    if (text == null) setInput('');
    setFollowups([]);
    setStatus('Thinking…'); // show an immediate indicator before the first token
    // Append the question + an empty Owl bubble we stream into.
    setMessages((m) => [...m, { role: 'user', text: q }, { role: 'owl', text: '' }]);
    setBusy(true);
    const appendToOwl = (delta) => setMessages((m) => {
      const next = m.slice();
      for (let i = next.length - 1; i >= 0; i--) { if (next[i].role === 'owl') { next[i] = { ...next[i], text: next[i].text + delta }; break; } }
      return next;
    });
    try {
      const { threadId: tid, sources, followups: fu, actions } = await api.owlChat({ suiteId: selSuite || undefined, entityId: selEntity || undefined, dashboardId: dashboardId || undefined, message: q, threadId }, appendToOwl, setStatus);
      if (tid) { const isNew = tid !== threadId; setThreadId(tid); if (isNew) refreshThreads(); }
      if ((sources && sources.length) || (actions && actions.length)) setMessages((m) => {
        const next = m.slice();
        for (let i = next.length - 1; i >= 0; i--) { if (next[i].role === 'owl') { next[i] = { ...next[i], sources: (sources && sources.length) ? sources : next[i].sources, actions }; break; } }
        return next;
      });
      if (fu && fu.length) setFollowups(fu);
    } catch (e) {
      appendToOwl((e && e.message) ? `⚠ ${e.message}` : '⚠ Sorry — I hit a problem answering that.');
    } finally {
      setBusy(false);
      setStatus('');
    }
  }
  // "/" command palette: open while the input is just "/word" (no space yet), so it
  // never triggers mid-sentence or on a date like "1/2". Picking a command drops its
  // example question into the box (editable), per the chosen behaviour.
  const slashMatch = /^\/(\w*)$/.exec(input);
  const slashOpen = !!slashMatch && commands.length > 0;
  const slashQuery = slashMatch ? slashMatch[1].toLowerCase() : '';
  const slashMatches = slashOpen ? commands.filter((c) => c.cmd.toLowerCase().includes(slashQuery) || c.label.toLowerCase().includes(slashQuery)) : [];
  const slashSel = slashMatches.length ? Math.min(slashIdx, slashMatches.length - 1) : 0;
  const pickCommand = (c) => { if (!c) return; setInput(c.example); setSlashIdx(0); setTimeout(() => taRef.current && taRef.current.focus(), 0); };
  const openSlash = () => { setInput('/'); setSlashIdx(0); setTimeout(() => taRef.current && taRef.current.focus(), 0); };
  const onKeyDown = (e) => {
    if (slashOpen && slashMatches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx((i) => Math.min(i + 1, slashMatches.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIdx((i) => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter') { e.preventDefault(); pickCommand(slashMatches[slashSel]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setInput(''); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const docked = dock === 'docked' && !isMobile;
  const hdrBtn = { border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', lineHeight: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' };
  const segBtn = (active) => ({ padding: '4px 10px', fontSize: 11.5, fontWeight: 600, border: 'none', borderRadius: 980, cursor: 'pointer', background: active ? 'var(--brand)' : 'transparent', color: active ? '#fff' : 'var(--text)' });
  const selStyle = { padding: '4px 8px', borderRadius: 8, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 12.5, maxWidth: 200 };

  const bubble = (m, i) => (
    <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', marginBottom: 10 }}>
      <div style={{
        maxWidth: '85%', padding: '8px 12px', borderRadius: 14, fontSize: 14, lineHeight: 1.45, whiteSpace: m.role === 'user' ? 'pre-wrap' : 'normal', wordBreak: 'break-word',
        background: m.role === 'user' ? 'var(--brand)' : 'var(--elevated, rgba(128,128,128,0.12))',
        color: m.role === 'user' ? '#fff' : 'var(--text)',
        borderTopRightRadius: m.role === 'user' ? 4 : 14, borderTopLeftRadius: m.role === 'user' ? 14 : 4,
      }}>{m.role === 'owl' ? (m.text ? <OwlMd text={m.text} /> : (busy ? <ThinkingDots label={status} /> : '')) : m.text}</div>
    </div>
  );

  // Chat list (saved conversations) — a persistent left column on desktop, a slide-over
  // on mobile. Each row loads on tap; inline rename (✎) and delete (🗑) per chat.
  const folders = [...new Set(threads.map((t) => t.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  // Event names offered as ready-made folders (link a chat to an event by name).
  const eventNames = [...new Set((selEntity ? clientEvents : events).map((e) => e.name).filter(Boolean))].filter((n) => !folders.includes(n)).slice(0, 40);
  const rowBtn = { border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 12, padding: '4px 3px' };
  const inlineFld = { width: '100%', boxSizing: 'border-box', padding: '8px 12px', border: 'none', borderLeft: '2px solid var(--brand)', background: 'var(--card)', color: 'var(--text)', fontSize: 13, fontFamily: 'inherit', outline: 'none' };
  const renderRow = (t) => {
    const active = t.id === threadId;
    if (editingId === t.id) return (
      <input key={t.id} autoFocus value={editText} onChange={(e) => setEditText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') commitRename(t.id); if (e.key === 'Escape') setEditingId(null); }}
        onBlur={() => commitRename(t.id)} style={inlineFld} />
    );
    if (movingId === t.id) return (
      <select key={t.id} autoFocus defaultValue={t.folder || ''} style={inlineFld}
        onChange={(e) => { const v = e.target.value; if (v === '__new__') { const name = window.prompt('New folder name'); if (name && name.trim()) setFolder(t.id, name.trim()); else setMovingId(null); } else setFolder(t.id, v); }}
        onBlur={() => setMovingId(null)}>
        <option value="">Unfiled</option>
        {folders.length > 0 && <optgroup label="Folders">{folders.map((f) => <option key={f} value={f}>{f}</option>)}</optgroup>}
        {eventNames.length > 0 && <optgroup label="Events">{eventNames.map((n) => <option key={n} value={n}>{n}</option>)}</optgroup>}
        <option value="__new__">＋ New folder…</option>
      </select>
    );
    return (
      <div key={t.id} style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--hairline)', background: active ? 'var(--elevated, rgba(128,128,128,0.12))' : 'transparent' }}>
        <button onClick={() => loadThread(t)} style={{ flex: 1, minWidth: 0, textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', padding: '8px 2px 8px 12px', color: 'var(--text)' }}>
          <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title || 'Chat'}</div>
          <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 1 }}>{new Date(t.at).toLocaleString([], { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
        </button>
        <button onClick={() => startMove(t)} title="Move to folder" aria-label="Move to folder" style={rowBtn}>📁</button>
        <button onClick={() => startRename(t)} title="Rename" aria-label="Rename chat" style={rowBtn}>✎</button>
        {confirmDelId === t.id
          ? <button onClick={() => deleteThread(t)} title="Tap again to delete" aria-label="Confirm delete" style={{ ...rowBtn, color: 'var(--error, #dc2626)', fontWeight: 800, paddingRight: 9 }}>Delete?</button>
          : <button onClick={() => { setConfirmDelId(t.id); setTimeout(() => setConfirmDelId((c) => (c === t.id ? null : c)), 3000); }} title="Delete" aria-label="Delete chat" style={{ ...rowBtn, paddingRight: 9 }}>🗑</button>}
      </div>
    );
  };
  const folderHdr = { display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left', border: 'none', background: 'var(--elevated, rgba(128,128,128,0.06))', cursor: 'pointer', padding: '6px 12px', fontSize: 11.5, fontWeight: 700, color: 'var(--text)', borderBottom: '1px solid var(--hairline)' };
  const unfiled = threads.filter((t) => !t.folder);
  const sidebarInner = (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: isMobile ? '78vw' : 212, maxWidth: isMobile ? 320 : 212, background: 'var(--bg, var(--card))', borderRight: '1px solid var(--hairline)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 10px 9px 12px', borderBottom: '1px solid var(--hairline)', flexShrink: 0 }}>
        <strong style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', flex: 1 }}>Chats</strong>
        <button onClick={newChat} title="New chat" style={{ border: 'none', background: 'var(--brand)', color: '#fff', borderRadius: 8, padding: '4px 10px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>＋ New</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {threads.length === 0 && <div style={{ padding: '12px', fontSize: 12.5, color: 'var(--muted)' }}>No saved chats yet.</div>}
        {folders.map((f) => {
          const items = threads.filter((t) => t.folder === f);
          const collapsed = !!collapsedFolders[f];
          return (
            <div key={f}>
              <button onClick={() => setCollapsedFolders((c) => ({ ...c, [f]: !c[f] }))} style={folderHdr}>
                <span style={{ fontSize: 9 }}>{collapsed ? '▶' : '▼'}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📁 {f}</span>
                <span style={{ color: 'var(--muted)', fontWeight: 500 }}>{items.length}</span>
              </button>
              {!collapsed && items.map(renderRow)}
            </div>
          );
        })}
        {folders.length > 0 && unfiled.length > 0 && <div style={{ ...folderHdr, cursor: 'default', background: 'transparent', color: 'var(--muted)', fontWeight: 600 }}>Unfiled</div>}
        {unfiled.map(renderRow)}
      </div>
    </div>
  );
  const sidebar = sidebarOpen && (isMobile
    ? (
      <div style={{ position: 'absolute', inset: 0, zIndex: 6, display: 'flex' }}>
        <div style={{ boxShadow: '4px 0 20px rgba(0,0,0,0.25)' }}>{sidebarInner}</div>
        <div onClick={() => setSidebarOpen(false)} style={{ flex: 1, background: 'rgba(0,0,0,0.35)' }} />
      </div>
    )
    : <div style={{ flexShrink: 0 }}>{sidebarInner}</div>);

  const panel = (
    <div className="ai-glow" style={{ height: '100%', width: '100%', background: 'var(--card)', display: 'flex', flexDirection: 'row', overflow: 'hidden', position: 'relative' }}>
      {!isMobile && sidebar}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 10px 11px 14px', borderBottom: '1px solid var(--hairline)', flexShrink: 0 }}>
        <span style={{ fontSize: 16 }}>🦉</span>
        <strong style={{ fontSize: 14.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Ask the Owl</strong>
        <button onClick={() => setSidebarOpen((o) => !o)} title="Chats" aria-label="Show chats" style={{ ...hdrBtn, fontSize: 16, padding: '2px 5px' }}>☰</button>
        <button onClick={newChat} title="New chat" aria-label="New chat" style={{ ...hdrBtn, fontSize: 15, padding: '2px 5px' }}>✎</button>
        {messages.some((m) => m.text) && (
          <>
            <button onClick={copyChat} title="Copy the chat" aria-label="Copy the chat" style={{ ...hdrBtn, fontSize: 14, padding: '2px 5px' }}>{chatCopied ? '✓' : '📋'}</button>
            <button onClick={printChat} title="Save as PDF" aria-label="Save as PDF" style={{ ...hdrBtn, fontSize: 11.5, fontWeight: 700, padding: '2px 5px' }}>PDF</button>
            <ShareMenu
              heading={`Owl chat${messages.find((m) => m.role === 'user' && m.text) ? ' — ' + messages.find((m) => m.role === 'user' && m.text).text.slice(0, 60) : ''}`}
              text={messages.filter((m) => m.text).map((m) => `${m.role === 'user' ? 'Q' : 'Owl'}: ${m.text}`).join('\n\n')}
              isMobile={isMobile} variant="tile" title="Share this chat"
            />
          </>
        )}
        <span style={{ flex: 1 }} />
        <div style={{ display: 'inline-flex', gap: 2, marginRight: 2 }} title="Text size">
          <button onClick={() => bumpZoom(-0.1)} aria-label="Smaller" style={{ ...hdrBtn, fontSize: 11.5, fontWeight: 700, padding: '4px 6px' }}>A−</button>
          <button onClick={() => bumpZoom(0.1)} aria-label="Larger" style={{ ...hdrBtn, fontSize: 14.5, fontWeight: 700, padding: '4px 6px' }}>A+</button>
        </div>
        {!isMobile && (
          <div style={{ display: 'inline-flex', gap: 2, padding: 2, background: 'var(--elevated, rgba(128,128,128,0.12))', borderRadius: 980, marginRight: 2 }} title="How the Owl opens">
            <button onClick={() => pickDock('overlay')} style={segBtn(!docked)}>Overlay</button>
            <button onClick={() => pickDock('docked')} style={segBtn(docked)}>In-app</button>
          </div>
        )}
        <button onClick={onClose} title="Close" aria-label="Close the Owl" style={{ ...hdrBtn, fontSize: 20, padding: '2px 6px' }}>✕</button>
      </div>

      {showPicker && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--hairline)', flexShrink: 0, flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>Scope:</span>
          {clients.length > 1 ? (
            <select value={selEntity} onChange={(e) => { setSelEntity(e.target.value); setSelSuite(''); resetThread(); }} style={selStyle} aria-label="Client">
              <option value="">Pick a client…</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          ) : (
            <strong style={{ fontSize: 12.5 }}>{(clients[0] && clients[0].name) || 'Your data'}</strong>
          )}
          {selEntity && clientEvents.length > 0 && (
            <select value={selSuite} onChange={(e) => { setSelSuite(e.target.value); resetThread(); }} style={selStyle} aria-label="Event">
              <option value="">All events</option>
              {clientEvents.map((ev) => <option key={ev.id} value={ev.id}>{ev.name}</option>)}
            </select>
          )}
        </div>
      )}

      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14, fontSize: `${zoom}em` }}>
        {messages.length === 0 && (
          <div style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.5 }}>
            <p style={{ margin: '4px 0 10px' }}>Ask about your ticket sales in plain English — I pull the answer live from your own data.</p>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>How many tickets have I sold?</li>
              <li>What’s my revenue by ticket type?</li>
              <li>Sales in the last 7 days?</li>
            </ul>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} data-owl-msg>
            {bubble(m, i)}
            {m.role === 'owl' && m.sources && m.sources.length > 0 && <CitationChips sources={m.sources} entityId={selEntity} suiteId={selSuite} canPin={isAdmin} />}
            {m.role === 'owl' && m.actions && m.actions.length > 0 && m.actions.map((a, ai) => <ActionCard key={ai} action={a} />)}
            {m.role === 'owl' && m.text && !busy && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
                <CopyBtn text={m.text} />
                <ShareMenu heading={[...messages.slice(0, i)].reverse().find((x) => x.role === 'user')?.text || 'Owl answer'} text={m.text} isMobile={isMobile} variant="tile" title="Share this answer" />
                <DataActions source={(m.sources || []).filter((s) => s.kind !== 'dashboard').find((s) => s.rows && s.rows.length)} />
                {isAdmin && selEntity && <SaveSegmentButton source={(m.sources || []).filter((s) => s.kind !== 'dashboard').find((s) => s.queryBody && s.queryBody.model)} entityId={selEntity} />}
                <ReportToClaude
                  question={[...messages.slice(0, i)].reverse().find((x) => x.role === 'user')?.text || ''}
                  answer={m.text}
                  sources={m.sources}
                  scopeLabel={[clients.find((c) => c.id === selEntity)?.name, events.find((e) => e.id === selSuite)?.name].filter(Boolean).join(' · ')}
                  dashboardId={dashboardId}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      {followups.length > 0 && !busy && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 12px 0', flexShrink: 0 }}>
          {followups.slice(0, 3).map((q, i) => (
            <button key={i} onClick={() => send(q)} style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 980, padding: '5px 11px', fontSize: 12.5, cursor: 'pointer' }}>{q}</button>
          ))}
        </div>
      )}
      {attachOpen && (
        <div style={{ borderTop: '1px solid var(--hairline)', padding: '8px 12px', flexShrink: 0, background: 'var(--bg, #fafafe)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: uploads.length ? 6 : 0 }}>
            <strong style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', flex: 1 }}>Attached data</strong>
            <button onClick={() => fileRef.current && fileRef.current.click()} disabled={!attachEntity || attachBusy} style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 8, padding: '4px 9px', fontSize: 12, cursor: attachEntity ? 'pointer' : 'default' }}>⬆ CSV</button>
            <button onClick={addSheet} disabled={!attachEntity || attachBusy} style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 8, padding: '4px 9px', fontSize: 12, cursor: attachEntity ? 'pointer' : 'default' }}>＋ Google Sheet</button>
          </div>
          {!attachEntity && <div style={{ fontSize: 12, color: 'var(--muted)' }}>Pick a client first to attach data.</div>}
          {uploads.map((u) => (
            <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12.5 }}>
              <span title={u.source === 'sheet' ? 'Live Google Sheet' : 'Uploaded file'}>{u.source === 'sheet' ? '🔗' : '📄'}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }}>{u.name} <span style={{ color: 'var(--muted)' }}>· {u.rowCount} rows</span></span>
              {u.source === 'sheet' && <button onClick={() => refreshSheet(u)} disabled={attachBusy} title="Refresh from the sheet" style={{ border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 12 }}>↻</button>}
              <button onClick={() => removeUpload(u)} title="Remove" style={{ border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 12 }}>🗑</button>
            </div>
          ))}
          {attachEntity && uploads.length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)' }}>No data attached yet. Add a CSV or a Google Sheet, then ask me about it.</div>}
          <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onPickFile} style={{ display: 'none' }} />
        </div>
      )}
      {/* Composer, Claude-style: a big text box on top, with attach / mic on the
          left and Send on the right of a row beneath it. */}
      <div style={{ borderTop: '1px solid var(--hairline)', padding: 10, flexShrink: 0 }}>
        {/* "/" command palette — a quick menu of what the Owl can answer. */}
        {slashOpen && slashMatches.length > 0 && (
          <div style={{ marginBottom: 6, border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)', overflow: 'hidden', boxShadow: '0 6px 22px rgba(0,0,0,0.14)' }}>
            {slashMatches.map((c, i) => (
              <button key={c.cmd} type="button" onMouseEnter={() => setSlashIdx(i)} onClick={() => pickCommand(c)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', border: 'none', borderBottom: i < slashMatches.length - 1 ? '1px solid var(--hairline)' : 'none', background: i === slashSel ? 'var(--elevated, rgba(128,128,128,0.12))' : 'transparent', cursor: 'pointer', padding: '8px 12px', color: 'var(--text)' }}>
                <span style={{ fontSize: 16, flexShrink: 0 }}>{c.icon}</span>
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>/{c.cmd} · {c.label}</span>
                  <span style={{ fontSize: 11.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.example}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        <div style={{ border: '1px solid var(--hairline)', borderRadius: 16, background: 'var(--bg, var(--card))', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <textarea
            ref={taRef}
            value={input} onChange={(e) => { setInput(e.target.value); setSlashIdx(0); }} onKeyDown={onKeyDown}
            placeholder={canAsk ? 'Ask the Owl…  (type / for commands)' : 'Open a client or event to ask'}
            rows={4} disabled={!canAsk}
            style={{ width: '100%', boxSizing: 'border-box', resize: 'none', minHeight: 108, maxHeight: 260, padding: '8px 10px', border: 'none', outline: 'none', background: 'transparent', color: 'var(--text)', fontSize: 14.5, fontFamily: 'inherit', lineHeight: 1.5 }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={openSlash} title="Commands" aria-label="Slash commands" style={{ border: '1px solid var(--hairline)', background: slashOpen ? 'var(--elevated, rgba(128,128,128,0.12))' : 'var(--card)', color: 'var(--text)', borderRadius: 980, width: 38, height: 38, fontSize: 17, fontWeight: 700, cursor: 'pointer', lineHeight: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>/</button>
            <button onClick={() => setAttachOpen((o) => !o)} title="Attach data (CSV or Google Sheet)" aria-label="Attach data" style={{ border: '1px solid var(--hairline)', background: attachOpen || uploads.length ? 'var(--elevated, rgba(128,128,128,0.12))' : 'var(--card)', color: 'var(--text)', borderRadius: 980, minWidth: 38, height: 38, padding: '0 11px', fontSize: 16, cursor: 'pointer', lineHeight: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>📎{uploads.length ? <span style={{ fontSize: 11, fontWeight: 700, marginLeft: 3 }}>{uploads.length}</span> : ''}</button>
            {SR && <button onClick={toggleMic} title={listening ? 'Stop dictation' : 'Dictate your question'} aria-label="Dictate" style={{ border: '1px solid var(--hairline)', background: listening ? '#e0414a' : 'var(--card)', color: listening ? '#fff' : 'var(--text)', borderRadius: 980, width: 38, height: 38, fontSize: 16, cursor: 'pointer', lineHeight: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>🎤</button>}
            <span style={{ flex: 1 }} />
            <button onClick={() => send()} disabled={busy || !input.trim() || !canAsk} aria-label="Send"
              style={{ border: 'none', borderRadius: 980, padding: '0 20px', height: 38, fontSize: 14, fontWeight: 700, cursor: busy || !input.trim() || !canAsk ? 'default' : 'pointer', background: busy || !input.trim() || !canAsk ? 'var(--elevated, rgba(128,128,128,0.18))' : 'var(--brand)', color: busy || !input.trim() || !canAsk ? 'var(--muted)' : '#fff' }}>
              {busy ? '…' : 'Send ↑'}
            </button>
          </div>
        </div>
      </div>
      </div>
      {isMobile && sidebar}
    </div>
  );

  if (docked) {
    const w = sidebarOpen && !isMobile ? 'min(800px, 58vw)' : 'min(560px, 44vw)';
    return (
      <div style={{ position: 'relative', flexShrink: 0, height: '100%', width: open ? w : 0, transition: 'width .28s var(--ease-spring, ease)', overflow: 'hidden' }} aria-hidden={!open}>
        <div style={{ position: 'absolute', top: 0, right: 0, height: '100%', width: w }}>{panel}</div>
      </div>
    );
  }

  const w = isMobile ? '100%' : (sidebarOpen ? 'min(800px, 96vw)' : 'min(560px, 94vw)');
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 80, pointerEvents: open ? 'auto' : 'none' }} aria-hidden={!open}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.42)', opacity: open ? 1 : 0, transition: 'opacity .26s ease', backdropFilter: open ? 'blur(2px)' : 'none', WebkitBackdropFilter: open ? 'blur(2px)' : 'none' }} />
      <div style={{ position: 'absolute', top: 0, right: 0, height: '100%', width: w, boxShadow: '-10px 0 30px rgba(0,0,0,0.28)', transform: open ? 'translateX(0)' : 'translateX(100%)', transition: 'transform .26s var(--ease-spring, ease)' }}>{panel}</div>
    </div>
  );
}

// The "thinking" indicator: three bouncing dots + the live status label streamed from
// the server (e.g. "Reading your ticket data…"), so a multi-second tool call never looks
// frozen. Shown in the empty Owl bubble until the first answer token arrives.
function ThinkingDots({ label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--muted)' }}>
      <style>{'@keyframes owl-bd{0%,80%,100%{transform:translateY(0);opacity:.35}40%{transform:translateY(-3px);opacity:1}}'}</style>
      <span style={{ display: 'inline-flex', gap: 3 }} aria-hidden="true">
        {[0, 1, 2].map((i) => <span key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', display: 'inline-block', animation: 'owl-bd 1.2s ease-in-out infinite', animationDelay: `${i * 0.16}s` }} />)}
      </span>
      <span style={{ fontSize: 13 }}>{label || 'Thinking…'}</span>
    </span>
  );
}

// ── Lightweight markdown for Owl answers: GFM pipe tables, bold/italic/code, and
// bullet lists. (No dep — Pulse has no markdown lib; this covers what the Owl emits.)
function mdInline(text) {
  const out = []; const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g;
  let last = 0, m, key = 0;
  const s = String(text);
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[1] != null) out.push(<strong key={key++}>{m[1]}</strong>);
    else if (m[2] != null) out.push(<em key={key++}>{m[2]}</em>);
    else out.push(<code key={key++} style={{ background: 'rgba(128,128,128,0.15)', borderRadius: 4, padding: '0 4px', fontSize: '0.92em' }}>{m[3]}</code>);
    last = re.lastIndex;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
function splitRow(line) { let s = line.trim(); if (s.startsWith('|')) s = s.slice(1); if (s.endsWith('|')) s = s.slice(0, -1); return s.split('|').map((c) => c.trim()); }
const looksNumeric = (s) => /^[R$€£]?\s?-?[\d,.]+%?$/.test(String(s).trim());
function OwlMd({ text }) {
  const isMobile = useIsMobile();
  const lines = String(text || '').split('\n');
  const blocks = []; let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.includes('|') && i + 1 < lines.length && /-/.test(lines[i + 1]) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const header = splitRow(line); i += 2; const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
      blocks.push({ t: 'table', header, rows }); continue;
    }
    if (/^\s*[-*]\s+/.test(line)) { const items = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++; } blocks.push({ t: 'ul', items }); continue; }
    if (!line.trim()) { i++; continue; }
    const para = [line]; i++;
    while (i < lines.length && lines[i].trim() && !lines[i].includes('|') && !/^\s*[-*]\s+/.test(lines[i])) { para.push(lines[i]); i++; }
    blocks.push({ t: 'p', text: para.join('\n') });
  }
  const th = { textAlign: 'left', padding: '5px 9px', borderBottom: '1px solid var(--hairline)', color: 'var(--muted)', fontWeight: 600, whiteSpace: 'nowrap' };
  const td = (n) => ({ padding: '5px 9px', borderBottom: '1px solid var(--hairline)', textAlign: n ? 'right' : 'left', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' });
  return (
    <div>
      {blocks.map((b, k) => {
        if (b.t === 'table') {
          // Keep it tabular on EVERY screen. On a phone the table scrolls sideways
          // inside its own container with the first column pinned — instead of
          // exploding each row into a tall stacked card. Momentum + overscroll-contain
          // keep the scroll inside the table rather than dragging the page/chat.
          const stickyL = { position: 'sticky', left: 0, zIndex: 1, borderRight: '1px solid var(--hairline)' };
          return (
            <div key={k} style={{ margin: '6px 0', overflowX: 'auto', WebkitOverflowScrolling: 'touch', touchAction: 'pan-x pan-y', overscrollBehavior: 'contain', border: '1px solid var(--hairline)', borderRadius: 10 }}>
              <table style={{ borderCollapse: 'collapse', fontSize: isMobile ? '0.85em' : '0.92em', width: '100%', minWidth: isMobile ? 'max-content' : undefined }}>
                <thead><tr>{b.header.map((h, j) => <th key={j} style={j === 0 ? { ...th, ...stickyL, zIndex: 2, background: 'var(--elevated, #f1f1f5)' } : th}>{mdInline(h)}</th>)}</tr></thead>
                <tbody>{b.rows.map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci} style={ci === 0 ? { ...td(false), ...stickyL, background: 'var(--card)', fontWeight: 600 } : td(ci > 0 && looksNumeric(c))}>{mdInline(c)}</td>)}</tr>)}</tbody>
              </table>
            </div>
          );
        }
        if (b.t === 'ul') return <ul key={k} style={{ margin: '4px 0', paddingLeft: 18 }}>{b.items.map((it, j) => <li key={j} style={{ margin: '1px 0' }}>{mdInline(it)}</li>)}</ul>;
        return <p key={k} style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>{mdInline(b.text)}</p>;
      })}
    </div>
  );
}

// Format a measure value with thousands separators (numbers) or pass strings through.
function fmtVal(v) {
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) && String(v).trim() !== '' ? n.toLocaleString() : String(v);
}

// Format a result-table cell: numbers get thousands separators; dates/strings pass
// through (a YYYY-MM-DD has inner dashes so it won't be mistaken for a number).
function fmtCell(v) {
  if (v == null || v === '') return '—';
  if (typeof v === 'number') return v.toLocaleString();
  const s = String(v);
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s).toLocaleString() : s;
}

// ── CSV export ────────────────────────────────────────────────────────────────
// A source carries the result table (columns + rows) — export exactly what's shown.
function csvEscape(v) { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function toCSV(columns, rows) {
  const head = (columns || []).map((c) => csvEscape(c.label)).join(',');
  const body = (rows || []).map((r) => (columns || []).map((c) => csvEscape(r[c.field])).join(',')).join('\n');
  return `${head}\n${body}`;
}
function downloadText(filename, text, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const csvName = (source) => `${[source.measure, ...(source.dimensions || [])].filter(Boolean).join(' by ') || 'owl-data'}`
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) + '.csv';
// ECharts paints to a transparent canvas → flatten onto white before JPEG (else black).
function downloadCanvasJpg(canvas, filename) {
  try {
    const tmp = document.createElement('canvas'); tmp.width = canvas.width; tmp.height = canvas.height;
    const ctx = tmp.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, tmp.width, tmp.height); ctx.drawImage(canvas, 0, 0);
    const a = document.createElement('a'); a.href = tmp.toDataURL('image/jpeg', 0.92); a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  } catch { /* tainted */ }
}

// The result rows as a data table (columns + values). Reused by the chart's "Table"
// view; measure columns are right-aligned.
function SourceTable({ source }) {
  const cols = source.columns || [];
  const rows = source.rows || [];
  return (
    <div style={{ overflow: 'auto', maxHeight: 260, border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11.5 }}>
        <thead><tr>{cols.map((c, k) => <th key={k} style={{ textAlign: c.kind === 'measure' ? 'right' : 'left', padding: '6px 10px', position: 'sticky', top: 0, background: 'var(--elevated, #f1f1f5)', color: 'var(--muted)', fontWeight: 600, whiteSpace: 'nowrap', borderBottom: '1px solid var(--hairline)' }}>{c.label}</th>)}</tr></thead>
        <tbody>{rows.map((r, ri) => <tr key={ri}>{cols.map((c, k) => <td key={k} style={{ padding: '5px 10px', whiteSpace: 'nowrap', borderBottom: '1px solid var(--hairline)', fontVariantNumeric: 'tabular-nums', textAlign: c.kind === 'measure' ? 'right' : 'left', color: 'var(--text)' }}>{fmtCell(r[c.field])}</td>)}</tr>)}</tbody>
      </table>
      {source.count > rows.length && <div style={{ padding: '6px 10px', fontSize: 10.5, color: 'var(--muted)' }}>Showing {rows.length} of {source.count.toLocaleString()} rows.</div>}
    </div>
  );
}

// Map an Owl citation source into the Looker-shaped data ChartTile renders. Bars
// show the biggest first (rows arrive measure-desc); line charts re-sort by the
// date dimension so time runs left→right.
const VIS = { line: 'looker_line', bar: 'looker_column', pie: 'looker_pie' };
function chartDataFromSource(s) {
  const dims = s.columns.filter((c) => c.kind === 'dimension');
  const meas = s.columns.filter((c) => c.kind === 'measure');
  let rows = s.rows || [];
  if (s.chartType === 'line' && dims[0]) rows = [...rows].sort((a, b) => String(a[dims[0].field]).localeCompare(String(b[dims[0].field])));
  else rows = rows.slice(0, 15); // top 15 categories keeps bars readable
  return {
    fields: {
      dimensions: dims.map((c) => ({ name: c.field, label: c.label, label_short: c.label })),
      measures: meas.map((c) => ({ name: c.field, label: c.label, label_short: c.label })),
    },
    data: rows.map((r) => { const o = {}; for (const c of s.columns) o[c.field] = { value: r[c.field] }; return o; }),
  };
}

// Compile a structured "fix brief" from an Owl answer — the question, the answer, and
// the EXACT query behind it (measures, group-bys, filters, scope, dashboard) — so the
// user can hand it to Claude verbatim instead of writing one by hand or screenshotting.
function buildFixBrief({ question, answer, sources, scopeLabel, dashboardId }) {
  const lines = [];
  lines.push('FIX BRIEF — Owl answer');
  if (scopeLabel) lines.push(`Scope: ${scopeLabel}`);
  if (dashboardId) lines.push(`Dashboard: ${dashboardId}`);
  lines.push('');
  lines.push(`Question: ${question || '(unknown)'}`);
  lines.push('');
  lines.push('Owl answered:');
  lines.push(String(answer || '').trim() || '(no text)');
  const dataSrc = (sources || []).filter((s) => s.kind !== 'dashboard');
  const dashSrc = (sources || []).filter((s) => s.kind === 'dashboard');
  if (dataSrc.length) {
    lines.push('');
    lines.push('Underlying query the Owl ran:');
    dataSrc.forEach((s, n) => {
      const qb = s.queryBody || {};
      const measures = (qb.fields || []).filter((f) => (s.columns || []).some((c) => c.field === f && c.kind === 'measure'));
      const groupBy = (s.dimensions || []);
      const filters = (s.filters || []).map((f) => `${f.label}=${f.value}`).join(', ');
      lines.push(`${dataSrc.length > 1 ? `[${n + 1}] ` : ''}explore=${qb.model || ''}/${qb.view || s.explore || ''}`);
      lines.push(`  measures: ${measures.join(', ') || s.measure || '(none)'}`);
      lines.push(`  group by: ${groupBy.join(', ') || '(none)'}`);
      lines.push(`  filters: ${filters || '(scope only)'}`);
      lines.push(`  rows: ${s.count != null ? s.count : (s.rows || []).length}`);
      lines.push(`  query: ${JSON.stringify(qb)}`);
    });
  }
  // getDashboard answers: list each tile the Owl read + the explore/fields/filters behind it.
  dashSrc.forEach((s) => {
    lines.push('');
    lines.push(`Dashboard read: ${s.dashboard?.title || ''} (${s.dashboard?.id || ''})`);
    (s.tiles || []).forEach((ti) => {
      const filters = (ti.filters || []).map((f) => `${f.label}=${f.value}`).join(', ');
      lines.push(`- ${ti.title}: value=${ti.value != null ? ti.value : '(none)'} | explore=${ti.explore || '(?)'} | fields=[${(ti.fields || []).join(', ')}]${filters ? ` | filters=${filters}` : ''}`);
    });
  });
  lines.push('');
  lines.push("What's wrong / what it should be: (describe here)");
  return lines.join('\n');
}

// Small text-action button styling shared by the per-message actions.
const msgActionStyle = { border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 11.5, padding: '2px 4px', display: 'inline-flex', alignItems: 'center', gap: 4 };
// 🎯 "Save as segment" — turn ANY chat answer's cohort into a reusable audience
// ("from any point of a chat"). Reuses the answer's live query (its filters define the
// cohort); the server re-applies scope + only saves from the ticket-data explore. No PII.
function SaveSegmentButton({ source, entityId }) {
  const [state, setState] = useState(''); // '' | 'busy' | 'done'
  if (!source || !source.queryBody || !source.queryBody.model) return null;
  const save = async () => {
    const suggested = [source.measure, ...(source.dimensions || [])].filter(Boolean).join(' by ').slice(0, 60) || 'Owl segment';
    const name = window.prompt('Name this segment (a reusable audience of these people):', `${suggested} audience`.slice(0, 80));
    if (name == null) return;
    setState('busy');
    const qb = source.queryBody;
    try {
      await api.owlCreateSegment({ entityId, name: name.trim(), draft: { mode: 'query', model: qb.model, view: qb.view, queryFilters: qb.filters || {} } });
      setState('done'); setTimeout(() => setState(''), 2500);
    } catch (e) { setState(''); window.alert((e && e.message) || 'Could not save the segment.'); }
  };
  return (
    <button onClick={save} disabled={state === 'busy'} title="Save these people as a reusable audience (Engage → Segments)" style={msgActionStyle}>
      {state === 'done' ? '✓ Saved' : (state === 'busy' ? '🎯 Saving…' : '🎯 Save as segment')}
    </button>
  );
}
// Copy a single message's text to the clipboard.
function CopyBtn({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button onClick={async () => { try { await navigator.clipboard.writeText(String(text || '')); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* ignore */ } }}
      title="Copy this answer" style={msgActionStyle}>{done ? '✓ Copied' : '📋 Copy'}</button>
  );
}

// CSV + chart-image downloads for an answer, sitting inline with the other message
// actions. The image grabs the answer's rendered chart canvas (found via the message
// wrapper's data attribute), so no ref-threading into the chart is needed.
function DataActions({ source }) {
  if (!source || !(source.rows && source.rows.length)) return null;
  const hasChart = !!source.chartType;
  return (
    <>
      <button onClick={() => downloadText(csvName(source), toCSV(source.columns, source.rows))} title="Download the data as CSV (opens in Excel/Sheets)" style={msgActionStyle}>⬇ CSV</button>
      {hasChart && <button onClick={(e) => { const c = e.currentTarget.closest('[data-owl-msg]') && e.currentTarget.closest('[data-owl-msg]').querySelector('canvas'); if (c) downloadCanvasJpg(c, csvName(source).replace(/\.csv$/, '.jpg')); }} title="Download the chart as an image (JPEG)" style={msgActionStyle}>⬇ Image</button>}
    </>
  );
}

// ── Action card: the act-layer's confirm step ──────────────────────────────────
// An act-tool (createAlert) DRAFTS something; nothing is created until the user taps
// here. This is the safe draft→confirm pattern the riskier act-tools will reuse. The
// commit re-checks permission server-side (alerts.manage), so this button can never
// create something the user couldn't make by hand.
const OP_TEXT = { gte: 'reaches', lte: 'drops to', gt: 'goes above', lt: 'drops below' };
// Dispatch to the right confirm card by action kind (act-tools share the pattern).
function ActionCard({ action }) {
  if (!action) return null;
  if (action.kind === 'createAlert') return <AlertActionCard action={action} />;
  if (action.kind === 'createSegment') return <SegmentActionCard action={action} />;
  return null;
}
function AlertActionCard({ action }) {
  const [state, setState] = useState(''); // '' | 'busy' | 'done' | 'error'
  const [err, setErr] = useState('');
  const d = action.draft || {};
  const cond = `${d.metricLabel || d.measureLabel || 'this metric'} ${OP_TEXT[d.operator] || 'reaches'} ${fmtVal(d.threshold)}${d.unit === '%' ? '%' : ''}`;
  const CHAN_LABEL = { push: 'push', email: 'email', sms: 'SMS', slack: 'Slack' };
  const chans = (d.channels || []).map((c) => CHAN_LABEL[c] || c);
  const delivery = `via ${['in-app', ...chans].join(', ')}${d.priority === 'important' ? ' · important' : ''}`;
  const create = async () => {
    setState('busy'); setErr('');
    try {
      await api.owlCreateAlert({ suiteId: action.suiteId, draft: d });
      setState('done');
    } catch (e) { setState('error'); setErr((e && e.message) || 'Could not create the alert.'); }
  };
  return (
    <div style={{ margin: '2px 0 10px', border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)', padding: '10px 12px', maxWidth: '85%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
        <span style={{ fontSize: 15 }}>🔔</span>
        <strong style={{ fontSize: 12.5 }}>Alert</strong>
        <span style={{ fontSize: 11, color: 'var(--muted)', border: '1px solid var(--hairline)', borderRadius: 980, padding: '1px 7px' }}>Draft</span>
      </div>
      <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 4 }}>Notify me when <strong>{cond}</strong>.</div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 8 }}>{delivery}</div>
      {state === 'done' ? (
        <div style={{ fontSize: 12.5, color: 'var(--brand)', fontWeight: 600 }}>✓ Alert created — you'll be notified when it triggers.</div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={create} disabled={state === 'busy'}
            style={{ border: 'none', borderRadius: 980, padding: '6px 16px', fontSize: 12.5, fontWeight: 700, cursor: state === 'busy' ? 'default' : 'pointer', background: state === 'busy' ? 'var(--elevated, rgba(128,128,128,0.18))' : 'var(--brand)', color: state === 'busy' ? 'var(--muted)' : '#fff' }}>
            {state === 'busy' ? 'Creating…' : 'Create alert'}
          </button>
          {state === 'error' && <span style={{ fontSize: 12, color: '#e0414a' }}>{err}</span>}
        </div>
      )}
    </div>
  );
}

// Segment confirm card — saves a reusable audience from a chat cohort. PII-safe: shows
// only the count + per-channel reach, never people. Commit re-checks campaigns.approve.
function SegmentActionCard({ action }) {
  const [state, setState] = useState('');
  const [err, setErr] = useState('');
  const reach = action.reach || null;
  const reachLine = reach
    ? `${fmtVal(reach.total)} people${reach.email != null ? ` · ${fmtVal(reach.email)} emailable` : ''}${reach.sms ? ` · ${fmtVal(reach.sms)} SMS` : ''}`
    : null;
  const create = async () => {
    setState('busy'); setErr('');
    try { await api.owlCreateSegment({ entityId: action.entityId, name: action.name, draft: action.draft }); setState('done'); }
    catch (e) { setState('error'); setErr((e && e.message) || 'Could not create the segment.'); }
  };
  return (
    <div style={{ margin: '2px 0 10px', border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)', padding: '10px 12px', maxWidth: '85%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
        <span style={{ fontSize: 15 }}>🎯</span>
        <strong style={{ fontSize: 12.5 }}>Segment</strong>
        <span style={{ fontSize: 11, color: 'var(--muted)', border: '1px solid var(--hairline)', borderRadius: 980, padding: '1px 7px' }}>Draft</span>
      </div>
      <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: reachLine ? 4 : 8 }}>Save <strong>{action.summary || action.name}</strong> as a reusable audience.</div>
      {reachLine && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 8 }}>{reachLine}</div>}
      {state === 'done' ? (
        <div style={{ fontSize: 12.5, color: 'var(--brand)', fontWeight: 600 }}>✓ Segment saved — find it in Engage → Segments.</div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={create} disabled={state === 'busy'}
            style={{ border: 'none', borderRadius: 980, padding: '6px 16px', fontSize: 12.5, fontWeight: 700, cursor: state === 'busy' ? 'default' : 'pointer', background: state === 'busy' ? 'var(--elevated, rgba(128,128,128,0.18))' : 'var(--brand)', color: state === 'busy' ? 'var(--muted)' : '#fff' }}>
            {state === 'busy' ? 'Saving…' : 'Create segment'}
          </button>
          {state === 'error' && <span style={{ fontSize: 12, color: '#e0414a' }}>{err}</span>}
        </div>
      )}
    </div>
  );
}

// One-tap "Report to Claude": copies the fix brief to the clipboard (falls back to the
// share sheet on devices without clipboard access) so it can be pasted straight to Claude.
function ReportToClaude({ question, answer, sources, scopeLabel, dashboardId }) {
  const [state, setState] = useState(''); // '' | 'copied' | 'failed'
  const brief = () => buildFixBrief({ question, answer, sources, scopeLabel, dashboardId });
  const onClick = async () => {
    const text = brief();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); setState('copied'); }
      else if (navigator.share) { await navigator.share({ title: 'Owl fix brief', text }); setState('copied'); }
      else throw new Error('no clipboard');
    } catch { setState('failed'); }
    setTimeout(() => setState(''), 2500);
  };
  return (
    <button
      onClick={onClick}
      title="Copy a fix brief (question + answer + the exact query behind it) to paste to Claude"
      style={{ marginTop: 4, border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 11.5, padding: '2px 4px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
    >
      🛠 {state === 'copied' ? 'Copied — paste to Claude' : state === 'failed' ? 'Copy failed — long-press to select' : 'Report to Claude'}
    </button>
  );
}

// An auto-chart with a type toggle (bar / line / pie / metric) + a 📌 pin button.
// Switching type is instant + client-side; pinning saves the live query as a tile.
function OwlChart({ source, entityId, suiteId, canPin }) {
  const [type, setType] = useState(source.chartType || 'bar');
  const [pinOpen, setPinOpen] = useState(false);
  const [stacked, setStacked] = useState(false);
  const [followMsg, setFollowMsg] = useState('');
  // Follow this chart in the briefing: materialise it as a tile (on the home "Saved
  // from Owl" board) and add a 'follow' mark so the home briefing always addresses it.
  const doFollow = async () => {
    setFollowMsg('…');
    try {
      await api.owlPin({ entityId, suiteId: suiteId || undefined, target: 'home', follow: true, title: `${source.measure}${source.dimensions && source.dimensions.length ? ` by ${source.dimensions.join(', ')}` : ''}`, queryBody: source.queryBody, chartType: type });
      setFollowMsg('👁 Following — your briefing will cover this');
    } catch (e) { setFollowMsg(`⚠ ${(e && e.message) || 'Could not follow.'}`); }
    setTimeout(() => setFollowMsg(''), 2800);
  };
  const measCols = source.columns.filter((c) => c.kind === 'measure');
  const meas = measCols[0];
  const multiMeasure = measCols.length >= 2;
  const dims = source.columns.filter((c) => c.kind === 'dimension');
  const rowCount = (source.rows || []).length;
  const canPie = !multiMeasure && dims.length === 1 && rowCount >= 2 && rowCount <= 12;
  const opts = [{ k: 'bar', label: 'Bar' }, { k: 'line', label: 'Line' }, ...(canPie ? [{ k: 'pie', label: 'Pie' }] : []), { k: 'metric', label: 'Metric' }, { k: 'table', label: 'Table' }];
  const seg = (active) => ({ padding: '3px 9px', fontSize: 11, fontWeight: 600, border: 'none', borderRadius: 980, cursor: 'pointer', background: active ? 'var(--brand)' : 'transparent', color: active ? '#fff' : 'var(--text)' });
  const total = (source.rows || []).reduce((a, r) => a + (Number(r[meas?.field]) || 0), 0);
  const showPin = canPin && source.queryBody && entityId;
  const canStack = multiMeasure && (type === 'bar' || type === 'line');
  return (
    <div style={{ margin: '2px 0 8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <div style={{ display: 'inline-flex', gap: 2, padding: 2, background: 'var(--elevated, rgba(128,128,128,0.12))', borderRadius: 980 }}>
          {opts.map((o) => <button key={o.k} onClick={() => setType(o.k)} style={seg(type === o.k)}>{o.label}</button>)}
        </div>
        {canStack && <button onClick={() => setStacked((s) => !s)} title="Stack the series" style={{ border: '1px solid var(--hairline)', background: stacked ? 'var(--brand)' : 'var(--card)', color: stacked ? '#fff' : 'var(--text)', borderRadius: 980, padding: '3px 10px', fontSize: 11.5, cursor: 'pointer' }}>{stacked ? 'Stacked' : 'Stack'}</button>}
        {showPin && <button onClick={() => setPinOpen((o) => !o)} title="Pin to a dashboard or home" style={{ border: '1px solid var(--hairline)', background: pinOpen ? 'var(--elevated, rgba(128,128,128,0.12))' : 'var(--card)', borderRadius: 980, padding: '3px 10px', fontSize: 11.5, cursor: 'pointer', color: 'var(--text)' }}>📌 Pin</button>}
        {showPin && <button onClick={doFollow} title="Follow in your briefing — the home briefing will always read & address this" style={{ border: '1px solid var(--hairline)', background: 'var(--card)', borderRadius: 980, padding: '3px 10px', fontSize: 11.5, cursor: 'pointer', color: 'var(--text)' }}>👁 Follow</button>}
        {followMsg && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{followMsg}</span>}
      </div>
      {showPin && pinOpen && <PinMenu source={source} entityId={entityId} suiteId={suiteId} chartType={type} onDone={() => setPinOpen(false)} />}
      {type === 'metric'
        ? (
          <div style={{ border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)', padding: '18px 14px', textAlign: 'center' }}>
            <div style={{ fontSize: 30, fontWeight: 800, color: 'var(--text)', fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{fmtVal(total)}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{meas?.label} · total</div>
          </div>
        )
        : type === 'table'
          ? <SourceTable source={source} />
          : (
          <div style={{ height: 200, border: '1px solid var(--hairline)', borderRadius: 12, overflow: 'hidden', background: 'var(--card)' }}>
            <ChartTile data={chartDataFromSource({ ...source, chartType: type })} visConfig={{ type: VIS[type] || 'looker_column', stacking: (canStack && stacked) ? 'normal' : undefined }} />
          </div>
        )}
    </div>
  );
}

// The pin dialog: name it, choose Home or a dashboard, save it as a live tile.
function PinMenu({ source, entityId, suiteId, chartType, onDone }) {
  const defaultTitle = `${source.measure}${source.dimensions && source.dimensions.length ? ' by ' + source.dimensions.join(', ') : ''}`;
  const [title, setTitle] = useState(defaultTitle);
  const [target, setTarget] = useState('home');
  const [dashboards, setDashboards] = useState([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [follow, setFollow] = useState(false);
  useEffect(() => { let on = true; api.owlPinTargets(entityId).then((r) => { if (on) setDashboards(r.dashboards || []); }).catch(() => {}); return () => { on = false; }; }, [entityId]);
  async function pin() {
    setBusy(true);
    try {
      const r = await api.owlPin({ entityId, suiteId: suiteId || undefined, target, title, queryBody: source.queryBody, chartType, follow });
      setDone(`Pinned to ${target === 'home' ? 'Home' : (r.dashboardTitle || 'the dashboard')}${follow ? ' · 👁 following in your briefing' : ''} ✓`);
    } catch (e) { setDone(`⚠ ${(e && e.message) || 'Could not pin.'}`); }
    setBusy(false);
  }
  const fld = { width: '100%', padding: '7px 10px', borderRadius: 8, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 13, marginTop: 6 };
  if (done) return <div style={{ border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--bg, #fafafe)', padding: '10px 12px', fontSize: 13, marginBottom: 8, display: 'flex', gap: 8, alignItems: 'center' }}><span>{done}</span><button onClick={onDone} style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer' }}>✕</button></div>;
  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--bg, #fafafe)', padding: '10px 12px', marginBottom: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)' }}>📌 Pin chart</div>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" style={fld} />
      <select value={target} onChange={(e) => setTarget(e.target.value)} style={fld}>
        <option value="home">🏠 Home page</option>
        {(() => {
          const groups = {};
          for (const d of dashboards) { const f = d.folder || ''; (groups[f] = groups[f] || []).push(d); }
          const folders = Object.keys(groups).sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
          return folders.map((f) => (f === ''
            ? groups[f].map((d) => <option key={d.id} value={d.id}>{d.title}</option>)
            : <optgroup key={f} label={f}>{groups[f].map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</optgroup>));
        })()}
      </select>
      <label style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 9, fontSize: 12.5, color: 'var(--text)', cursor: 'pointer' }}>
        <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
        <span>👁 Follow in my briefing <span style={{ color: 'var(--muted)' }}>— the home briefing will read &amp; address it</span></span>
      </label>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button onClick={pin} disabled={busy || !title.trim()} style={{ border: 'none', borderRadius: 8, padding: '7px 14px', fontWeight: 700, fontSize: 13, cursor: busy ? 'default' : 'pointer', background: 'var(--brand)', color: '#fff' }}>{busy ? 'Pinning…' : 'Pin'}</button>
        <button onClick={onDone} style={{ border: '1px solid var(--hairline)', borderRadius: 8, padding: '7px 14px', fontSize: 13, cursor: 'pointer', background: 'var(--card)', color: 'var(--text)' }}>Cancel</button>
      </div>
    </div>
  );
}

// Citation chips — the grounding made visible. One "source" per live askData call
// in an answer: a green dot (= real query, not invented), the measure + value, the
// filters/scope, and a tap-to-expand card with the exact query.
function CitationChips({ sources, entityId, suiteId, canPin }) {
  const [open, setOpen] = useState(false);
  // Only data sources (askData/queryDashboard) render as chips/charts; dashboard-read
  // sources carry query detail for the fix-brief but have no chart/table to show here.
  const dataSources = (sources || []).filter((s) => s.kind !== 'dashboard');
  const chip = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 9px', borderRadius: 980, background: 'var(--card)', border: '1px solid var(--hairline)', fontSize: 11.5, color: '#3a3a3c', cursor: 'default' };
  const dot = { width: 7, height: 7, borderRadius: '50%', background: '#34c759', flex: 'none' };
  const muted = { color: 'var(--muted)' };
  if (!dataSources.length) return null;
  return (
    <div style={{ margin: '-4px 0 12px 2px' }}>
      {/* Charts stay visible; the query/source detail tucks into one "Beneath the hood" dropdown. */}
      {dataSources.map((s, i) => (s.chartType && s.rows && s.rows.length > 1
        ? <OwlChart key={i} source={s} entityId={entityId} suiteId={suiteId} canPin={canPin} /> : null))}
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--muted)', borderRadius: 980, padding: '4px 11px', fontSize: 11.5, cursor: 'pointer', marginTop: 2 }}>
        <span style={dot} /> Beneath the hood <span style={{ fontSize: 10 }}>{open ? '▴' : '▾'}</span>
      </button>
      {open && dataSources.map((s, i) => (
        <div key={i} style={{ marginTop: 8, border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--bg, #fafafe)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: '9px 11px' }}>
            <span style={{ ...chip, cursor: 'default' }}>
              <b style={{ fontWeight: 650, color: 'var(--text)' }}>{s.measure}</b>
              {s.value != null
                ? <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtVal(s.value)}</span>
                : <span style={muted}>{s.count} rows</span>}
            </span>
            {(s.filters || []).map((f, j) => (<span key={j} style={chip}><span style={muted}>{f.label}</span> {f.value}</span>))}
            {s.explore && <span style={chip}><span style={muted}>explore</span> {s.explore} · live</span>}
          </div>
          {s.columns && s.rows && s.rows.length > 0 && (
            <div style={{ overflow: 'auto', maxHeight: 240, borderTop: '1px solid var(--hairline)' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11.5 }}>
                <thead>
                  <tr>{s.columns.map((c, k) => <th key={k} style={{ textAlign: 'left', padding: '6px 10px', position: 'sticky', top: 0, background: 'var(--elevated, #f1f1f5)', color: 'var(--muted)', fontWeight: 600, whiteSpace: 'nowrap', borderBottom: '1px solid var(--hairline)' }}>{c.label}</th>)}</tr>
                </thead>
                <tbody>
                  {s.rows.map((r, ri) => (
                    <tr key={ri}>{s.columns.map((c, k) => <td key={k} style={{ padding: '5px 10px', whiteSpace: 'nowrap', borderBottom: '1px solid var(--hairline)', fontVariantNumeric: 'tabular-nums', color: 'var(--text)' }}>{fmtCell(r[c.field])}</td>)}</tr>
                  ))}
                </tbody>
              </table>
              <div style={{ display: 'flex', alignItems: 'center', padding: '6px 10px', fontSize: 10.5, color: 'var(--muted)' }}>
                {s.count > s.rows.length ? `Showing ${s.rows.length} of ${s.count.toLocaleString()} rows.` : ''}
                <button onClick={() => downloadText(csvName(s), toCSV(s.columns, s.rows))} title="Download as CSV" style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--brand)', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>⬇ CSV</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
