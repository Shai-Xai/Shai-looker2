import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';

// The native, Claude-powered agentic Owl — the conversational "pull" door onto the
// askData tool (server/owlChat.js). Drops into the same drawer slot as the Inventive
// AnalystDrawer (swapped behind FEATURES.owlNativeChat), mirroring its docked/overlay
// shell so the A/B is apples-to-apples. Answers stream in as plain text; every figure
// is fetched + scoped server-side, so nothing here can reach another client's data.
//
// Mobile-first: single column, full-width panel on phones.
export default function OwlChat({ open, onClose, suiteId, entityId, clients = [], events = [], isAdmin = false }) {
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
  const scrollRef = useRef(null);
  const pickDock = (m) => { localStorage.setItem('howler_owl_dock', m); setDock(m); };
  const bumpZoom = (d) => setZoom((z) => { const n = Math.min(1.3, Math.max(0.8, Math.round((z + d) * 100) / 100)); localStorage.setItem('howler_owl_zoom', String(n)); return n; });

  // Follow the page context if it changes while open.
  useEffect(() => { setSelEntity(entityId || ''); }, [entityId]);
  useEffect(() => { setSelSuite(suiteId || ''); }, [suiteId]);
  // Changing scope starts a fresh conversation (don't mix clients' data in a thread).
  const resetThread = () => { setMessages([]); setThreadId(null); };

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

  async function send() {
    const q = input.trim();
    if (!q || busy) return;
    if (!canAsk) { setMessages((m) => [...m, { role: 'owl', text: 'Pick a client (or open an event) above, then ask me — I scope to that organiser.' }]); return; }
    setInput('');
    // Append the question + an empty Owl bubble we stream into.
    setMessages((m) => [...m, { role: 'user', text: q }, { role: 'owl', text: '' }]);
    setBusy(true);
    const appendToOwl = (delta) => setMessages((m) => {
      const next = m.slice();
      for (let i = next.length - 1; i >= 0; i--) { if (next[i].role === 'owl') { next[i] = { ...next[i], text: next[i].text + delta }; break; } }
      return next;
    });
    try {
      const { threadId: tid, sources } = await api.owlChat({ suiteId: selSuite || undefined, entityId: selEntity || undefined, message: q, threadId }, appendToOwl);
      if (tid) setThreadId(tid);
      if (sources && sources.length) setMessages((m) => {
        const next = m.slice();
        for (let i = next.length - 1; i >= 0; i--) { if (next[i].role === 'owl') { next[i] = { ...next[i], sources }; break; } }
        return next;
      });
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
        maxWidth: '85%', padding: '8px 12px', borderRadius: 14, fontSize: 14, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        background: m.role === 'user' ? 'var(--brand)' : 'var(--elevated, rgba(128,128,128,0.12))',
        color: m.role === 'user' ? '#fff' : 'var(--text)',
        borderTopRightRadius: m.role === 'user' ? 4 : 14, borderTopLeftRadius: m.role === 'user' ? 14 : 4,
      }}>{m.text || (busy ? '…' : '')}</div>
    </div>
  );

  const panel = (
    <div className="ai-glow" style={{ height: '100%', width: '100%', background: 'var(--card)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 10px 11px 14px', borderBottom: '1px solid var(--hairline)', flexShrink: 0 }}>
        <span style={{ fontSize: 16 }}>🦉</span>
        <strong style={{ fontSize: 14.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Ask the Owl</strong>
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
          <div key={i}>
            {bubble(m, i)}
            {m.role === 'owl' && m.sources && m.sources.length > 0 && <CitationChips sources={m.sources} />}
          </div>
        ))}
      </div>

      <div style={{ borderTop: '1px solid var(--hairline)', padding: 10, flexShrink: 0, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKeyDown}
          placeholder={canAsk ? 'Ask the Owl…' : 'Open a client or event to ask'}
          rows={1} disabled={!canAsk}
          style={{ flex: 1, resize: 'none', maxHeight: 120, padding: '9px 12px', borderRadius: 12, border: '1px solid var(--hairline)', background: 'var(--bg, var(--card))', color: 'var(--text)', fontSize: 14, fontFamily: 'inherit', lineHeight: 1.4 }}
        />
        <button onClick={send} disabled={busy || !input.trim() || !canAsk} aria-label="Send"
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

// Format a measure value with thousands separators (numbers) or pass strings through.
function fmtVal(v) {
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) && String(v).trim() !== '' ? n.toLocaleString() : String(v);
}

// Citation chips — the grounding made visible. One "source" per live askData call
// in an answer: a green dot (= real query, not invented), the measure + value, the
// filters/scope, and a tap-to-expand card with the exact query.
function CitationChips({ sources }) {
  const [open, setOpen] = useState(-1);
  const chip = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 9px', borderRadius: 980, background: 'var(--card)', border: '1px solid var(--hairline)', fontSize: 11.5, color: '#3a3a3c', cursor: 'default' };
  const dot = { width: 7, height: 7, borderRadius: '50%', background: '#34c759', flex: 'none' };
  const muted = { color: 'var(--muted)' };
  return (
    <div style={{ margin: '-4px 0 12px 2px' }}>
      <div style={{ fontSize: 10, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 6px 2px' }}>Sources</div>
      {sources.map((s, i) => (
        <div key={i} style={{ marginBottom: 6 }}>
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
            <div style={{ marginTop: 6, border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--bg, #fafafe)', padding: '9px 11px', fontSize: 11.5, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px' }}>
              <span style={muted}>Measure</span><span>{s.measure}</span>
              {s.dimensions && s.dimensions.length > 0 && (<><span style={muted}>Group by</span><span>{s.dimensions.join(', ')}</span></>)}
              {s.filters && s.filters.length > 0 && (<><span style={muted}>Filters</span><span>{s.filters.map((f) => `${f.label} = ${f.value}`).join('  ·  ')}</span></>)}
              {s.explore && (<><span style={muted}>Explore</span><span>{s.explore} · live</span></>)}
              <span style={muted}>Rows</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{s.count}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
