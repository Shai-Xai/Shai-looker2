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
export default function OwlChat({ open, onClose, suiteId }) {
  const isMobile = useIsMobile();
  const [messages, setMessages] = useState([]); // [{ role:'user'|'owl', text }]
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [threadId, setThreadId] = useState(null);
  const [dock, setDock] = useState(() => localStorage.getItem('howler_owl_dock') || 'docked');
  const [zoom, setZoom] = useState(() => parseFloat(localStorage.getItem('howler_owl_zoom')) || 1);
  const scrollRef = useRef(null);
  const pickDock = (m) => { localStorage.setItem('howler_owl_dock', m); setDock(m); };
  const bumpZoom = (d) => setZoom((z) => { const n = Math.min(1.3, Math.max(0.8, Math.round((z + d) * 100) / 100)); localStorage.setItem('howler_owl_zoom', String(n)); return n; });

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
    if (!suiteId) { setMessages((m) => [...m, { role: 'owl', text: 'Open an event first, then ask me about it.' }]); return; }
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
      const { threadId: tid } = await api.owlChat({ suiteId, message: q, threadId }, appendToOwl);
      if (tid) setThreadId(tid);
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
        {messages.map(bubble)}
      </div>

      <div style={{ borderTop: '1px solid var(--hairline)', padding: 10, flexShrink: 0, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKeyDown}
          placeholder={suiteId ? 'Ask the Owl…' : 'Open an event to ask about it'}
          rows={1} disabled={!suiteId}
          style={{ flex: 1, resize: 'none', maxHeight: 120, padding: '9px 12px', borderRadius: 12, border: '1px solid var(--hairline)', background: 'var(--bg, var(--card))', color: 'var(--text)', fontSize: 14, fontFamily: 'inherit', lineHeight: 1.4 }}
        />
        <button onClick={send} disabled={busy || !input.trim() || !suiteId} aria-label="Send"
          style={{ border: 'none', borderRadius: 12, padding: '10px 14px', fontSize: 14, fontWeight: 700, cursor: busy || !input.trim() ? 'default' : 'pointer', background: busy || !input.trim() || !suiteId ? 'var(--elevated, rgba(128,128,128,0.18))' : 'var(--brand)', color: busy || !input.trim() || !suiteId ? 'var(--muted)' : '#fff' }}>
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
