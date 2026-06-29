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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [threads, setThreads] = useState([]);
  const [followups, setFollowups] = useState([]); // suggested next questions for the latest answer
  const [chatCopied, setChatCopied] = useState(false);
  const scrollRef = useRef(null);
  // Copy the whole conversation as plain text (Q/Owl transcript) to the clipboard.
  const copyChat = async () => {
    const text = messages.filter((m) => m.text).map((m) => `${m.role === 'user' ? 'Q' : 'Owl'}: ${m.text}`).join('\n\n');
    try { await navigator.clipboard.writeText(text); setChatCopied(true); setTimeout(() => setChatCopied(false), 2000); } catch { /* ignore */ }
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
  const newChat = () => { resetThread(); setInput(''); setHistoryOpen(false); };
  async function openHistory() {
    if (!historyOpen) { try { const r = await api.owlThreads(); setThreads(r.threads || []); } catch { setThreads([]); } }
    setHistoryOpen((o) => !o);
  }
  async function loadThread(t) {
    try {
      const r = await api.owlThreadMessages(t.id);
      setMessages((r.messages || []).map((m) => ({ role: m.role === 'user' ? 'user' : 'owl', text: m.body, sources: m.sources })));
      setThreadId(t.id);
      setSelEntity(t.entityId || ''); setSelSuite(t.suiteId || '');
    } catch { /* ignore */ }
    setHistoryOpen(false);
  }

  const clientEvents = events.filter((e) => e.entityId === selEntity);
  const showPicker = isAdmin || clients.length > 1;
  // Clients are auto-scoped server-side; admins need a client or event chosen.
  const canAsk = isAdmin ? !!(selEntity || selSuite) : true;

  // Keep the latest message in view as it streams.
  useEffect(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, [messages]);
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
    if (!canAsk) { setMessages((m) => [...m, { role: 'owl', text: 'Pick a client (or open an event) above, then ask me — I scope to that organiser.' }]); return; }
    if (text == null) setInput('');
    setFollowups([]);
    // Append the question + an empty Owl bubble we stream into.
    setMessages((m) => [...m, { role: 'user', text: q }, { role: 'owl', text: '' }]);
    setBusy(true);
    const appendToOwl = (delta) => setMessages((m) => {
      const next = m.slice();
      for (let i = next.length - 1; i >= 0; i--) { if (next[i].role === 'owl') { next[i] = { ...next[i], text: next[i].text + delta }; break; } }
      return next;
    });
    try {
      const { threadId: tid, sources, followups: fu } = await api.owlChat({ suiteId: selSuite || undefined, entityId: selEntity || undefined, dashboardId: dashboardId || undefined, message: q, threadId }, appendToOwl);
      if (tid) setThreadId(tid);
      if (sources && sources.length) setMessages((m) => {
        const next = m.slice();
        for (let i = next.length - 1; i >= 0; i--) { if (next[i].role === 'owl') { next[i] = { ...next[i], sources }; break; } }
        return next;
      });
      if (fu && fu.length) setFollowups(fu);
    } catch (e) {
      appendToOwl((e && e.message) ? `⚠ ${e.message}` : '⚠ Sorry — I hit a problem answering that.');
    } finally {
      setBusy(false);
    }
  }
  const onKeyDown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };

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
      }}>{m.role === 'owl' ? (m.text ? <OwlMd text={m.text} /> : (busy ? '…' : '')) : m.text}</div>
    </div>
  );

  const panel = (
    <div className="ai-glow" style={{ height: '100%', width: '100%', background: 'var(--card)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 10px 11px 14px', borderBottom: '1px solid var(--hairline)', flexShrink: 0 }}>
        <span style={{ fontSize: 16 }}>🦉</span>
        <strong style={{ fontSize: 14.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Ask the Owl</strong>
        <button onClick={newChat} title="New chat" aria-label="New chat" style={{ ...hdrBtn, fontSize: 15, padding: '2px 5px' }}>✎</button>
        <button onClick={openHistory} title="Past chats" aria-label="Past chats" style={{ ...hdrBtn, fontSize: 15, padding: '2px 5px' }}>🕘</button>
        {messages.some((m) => m.text) && (
          <>
            <button onClick={copyChat} title="Copy the chat" aria-label="Copy the chat" style={{ ...hdrBtn, fontSize: 14, padding: '2px 5px' }}>{chatCopied ? '✓' : '📋'}</button>
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

      {historyOpen && (
        <div style={{ borderBottom: '1px solid var(--hairline)', maxHeight: 240, overflowY: 'auto', background: 'var(--card)', flexShrink: 0 }}>
          <div style={{ padding: '8px 12px 4px', fontSize: 10, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)' }}>Past chats</div>
          {threads.length === 0 && <div style={{ padding: '4px 12px 10px', fontSize: 13, color: 'var(--muted)' }}>No saved chats yet.</div>}
          {threads.map((t) => (
            <button key={t.id} onClick={() => loadThread(t)} style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: t.id === threadId ? 'var(--elevated, rgba(128,128,128,0.12))' : 'transparent', cursor: 'pointer', padding: '8px 12px', fontSize: 13.5, color: 'var(--text)', borderTop: '1px solid var(--hairline)' }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title || 'Chat'}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>{new Date(t.at).toLocaleString()}</div>
            </button>
          ))}
        </div>
      )}

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
          <div key={i}>
            {bubble(m, i)}
            {m.role === 'owl' && m.sources && m.sources.length > 0 && <CitationChips sources={m.sources} entityId={selEntity} suiteId={selSuite} canPin={isAdmin} />}
            {m.role === 'owl' && m.text && !busy && (
              <ReportToClaude
                question={[...messages.slice(0, i)].reverse().find((x) => x.role === 'user')?.text || ''}
                answer={m.text}
                sources={m.sources}
                scopeLabel={[clients.find((c) => c.id === selEntity)?.name, events.find((e) => e.id === selSuite)?.name].filter(Boolean).join(' · ')}
                dashboardId={dashboardId}
              />
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
      <div style={{ borderTop: '1px solid var(--hairline)', padding: 10, flexShrink: 0, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKeyDown}
          placeholder={canAsk ? 'Ask the Owl…' : 'Open a client or event to ask'}
          rows={1} disabled={!canAsk}
          style={{ flex: 1, resize: 'none', maxHeight: 120, padding: '9px 12px', borderRadius: 12, border: '1px solid var(--hairline)', background: 'var(--bg, var(--card))', color: 'var(--text)', fontSize: 14, fontFamily: 'inherit', lineHeight: 1.4 }}
        />
        <button onClick={() => send()} disabled={busy || !input.trim() || !canAsk} aria-label="Send"
          style={{ border: 'none', borderRadius: 12, padding: '10px 14px', fontSize: 14, fontWeight: 700, cursor: busy || !input.trim() ? 'default' : 'pointer', background: busy || !input.trim() || !canAsk ? 'var(--elevated, rgba(128,128,128,0.18))' : 'var(--brand)', color: busy || !input.trim() || !canAsk ? 'var(--muted)' : '#fff' }}>
          {busy ? '…' : 'Send'}
        </button>
      </div>
    </div>
  );

  if (docked) {
    const w = 'min(560px, 44vw)';
    return (
      <div style={{ position: 'relative', flexShrink: 0, height: '100%', width: open ? w : 0, transition: 'width .28s var(--ease-spring, ease)', overflow: 'hidden' }} aria-hidden={!open}>
        <div style={{ position: 'absolute', top: 0, right: 0, height: '100%', width: w }}>{panel}</div>
      </div>
    );
  }

  const w = isMobile ? '100%' : 'min(560px, 94vw)';
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 80, pointerEvents: open ? 'auto' : 'none' }} aria-hidden={!open}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.42)', opacity: open ? 1 : 0, transition: 'opacity .26s ease', backdropFilter: open ? 'blur(2px)' : 'none', WebkitBackdropFilter: open ? 'blur(2px)' : 'none' }} />
      <div style={{ position: 'absolute', top: 0, right: 0, height: '100%', width: w, boxShadow: '-10px 0 30px rgba(0,0,0,0.28)', transform: open ? 'translateX(0)' : 'translateX(100%)', transition: 'transform .26s var(--ease-spring, ease)' }}>{panel}</div>
    </div>
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
          // On a phone a 3+ column table overflows and clips columns. Render each row as
          // a stacked card instead (first cell = title, the rest as Label: value lines) so
          // nothing is cut off and there's no sideways scroll. Narrow tables stay tabular.
          if (isMobile && b.header.length >= 3) return (
            <div key={k} style={{ margin: '8px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {b.rows.map((r, ri) => {
                const title = (r[0] || '').trim();
                return (
                  <div key={ri} style={{ border: '1px solid var(--hairline)', borderRadius: 10, padding: '8px 11px', background: 'var(--card)' }}>
                    {title && <div style={{ fontWeight: 650, marginBottom: 4, color: 'var(--text)' }}>{mdInline(title)}</div>}
                    {r.map((c, ci) => {
                      if (ci === 0 && title) return null;
                      const val = (c || '').trim();
                      if (!val) return null;
                      return (
                        <div key={ci} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '2px 0', fontSize: '0.95em' }}>
                          <span style={{ color: 'var(--muted)' }}>{mdInline(b.header[ci] || '')}</span>
                          <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{mdInline(val)}</span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          );
          return (
            <div key={k} style={{ overflowX: 'auto', margin: '6px 0' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: '0.92em', width: '100%' }}>
                <thead><tr>{b.header.map((h, j) => <th key={j} style={th}>{mdInline(h)}</th>)}</tr></thead>
                <tbody>{b.rows.map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci} style={td(ci > 0 && looksNumeric(c))}>{mdInline(c)}</td>)}</tr>)}</tbody>
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
  useEffect(() => { let on = true; api.owlPinTargets(entityId).then((r) => { if (on) setDashboards(r.dashboards || []); }).catch(() => {}); return () => { on = false; }; }, [entityId]);
  async function pin() {
    setBusy(true);
    try {
      const r = await api.owlPin({ entityId, suiteId: suiteId || undefined, target, title, queryBody: source.queryBody, chartType });
      setDone(`Pinned to ${target === 'home' ? 'Home' : (r.dashboardTitle || 'the dashboard')} ✓`);
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
  const [open, setOpen] = useState(-1);
  // Only data sources (askData/queryDashboard) render as chips/charts; dashboard-read
  // sources carry query detail for the fix-brief but have no chart/table to show here.
  const dataSources = (sources || []).filter((s) => s.kind !== 'dashboard');
  const chip = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 9px', borderRadius: 980, background: 'var(--card)', border: '1px solid var(--hairline)', fontSize: 11.5, color: '#3a3a3c', cursor: 'default' };
  const dot = { width: 7, height: 7, borderRadius: '50%', background: '#34c759', flex: 'none' };
  const muted = { color: 'var(--muted)' };
  if (!dataSources.length) return null;
  return (
    <div style={{ margin: '-4px 0 12px 2px' }}>
      <div style={{ fontSize: 10, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 6px 2px' }}>Sources</div>
      {dataSources.map((s, i) => (
        <div key={i} style={{ marginBottom: 6 }}>
          {s.chartType && s.rows && s.rows.length > 1 && <OwlChart source={s} entityId={entityId} suiteId={suiteId} canPin={canPin} />}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <button onClick={() => setOpen(open === i ? -1 : i)} style={{ ...chip, cursor: 'pointer' }} aria-expanded={open === i}>
              <span style={dot} />
              <b style={{ fontWeight: 650, color: 'var(--text)' }}>{s.measure}</b>
              {s.value != null
                ? <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtVal(s.value)}</span>
                : <span style={muted}>{s.count} rows</span>}
              <span style={{ ...muted, fontSize: 10 }}>{open === i ? '▴' : '▾'}</span>
            </button>
            {(s.filters || []).map((f, j) => (
              <span key={j} style={chip}><span style={muted}>{f.label}</span> {f.value}</span>
            ))}
          </div>
          {open === i && (
            <div style={{ marginTop: 6, border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--bg, #fafafe)', overflow: 'hidden' }}>
              <div style={{ padding: '9px 11px', fontSize: 11.5, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', borderBottom: (s.rows && s.rows.length) ? '1px solid var(--hairline)' : 'none' }}>
                <span style={muted}>Measure</span><span>{s.measure}</span>
                {s.dimensions && s.dimensions.length > 0 && (<><span style={muted}>Group by</span><span>{s.dimensions.join(', ')}</span></>)}
                {s.filters && s.filters.length > 0 && (<><span style={muted}>Filters</span><span>{s.filters.map((f) => `${f.label} = ${f.value}`).join('  ·  ')}</span></>)}
                {s.explore && (<><span style={muted}>Explore</span><span>{s.explore} · live</span></>)}
              </div>
              {s.columns && s.rows && s.rows.length > 0 && (
                <div style={{ overflow: 'auto', maxHeight: 240 }}>
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
                  {s.count > s.rows.length && <div style={{ padding: '6px 10px', fontSize: 10.5, color: 'var(--muted)' }}>Showing {s.rows.length} of {s.count.toLocaleString()} rows.</div>}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
