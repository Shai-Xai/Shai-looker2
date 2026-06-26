import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useIsMobile } from '../lib/useIsMobile.js';
import { useScope } from '../lib/ScopeContext.jsx';
import { useSheetDrag } from '../lib/useSheetDrag.js';
import AiMark from './AiMark.jsx';
import OwlQuips from './OwlQuips.jsx';
import ShareMenu from './ShareMenu.jsx';

// Full-height side panel showing an AI insight that streams in live as Claude
// writes it. The reader can add extra context to steer the analysis and ask
// follow-up questions — the whole thing is a small chat thread. Rendered via a
// portal to document.body so it escapes the dashboard grid's CSS transform.
export default function InsightModal({ tile, data, filters, onClose }) {
  const isMobile = useIsMobile();
  const { suiteId, dashboardContext } = useScope();
  // turns: the conversation after the (server-side) data prompt — the first is
  // the initial insight, then alternating user questions / assistant answers.
  const [turns, setTurns] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState(null);
  const [userContext, setUserContext] = useState('');
  const [contextOpen, setContextOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const abortRef = useRef(null);
  const bodyRef = useRef(null);

  // Stream a reply from the server given the conversation so far (`history`).
  // Appends a fresh assistant turn and fills it as text arrives.
  const generate = useCallback(async (history) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setStreaming(true);
    setTurns((t) => [...t, { role: 'assistant', content: '' }]);
    try {
      const res = await fetch('/api/insight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: tile.title,
          visType: tile.vis?.type,
          fields: data.fields,
          rows: data.data,
          filters,
          userContext,
          history,
          suiteId,
          dashboardContext,
          tileContext: tile.aiContext || '',
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setTurns((t) => {
          const copy = t.slice();
          copy[copy.length - 1] = { role: 'assistant', content: acc };
          return copy;
        });
      }
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message);
    } finally {
      setStreaming(false);
    }
    // userContext/filters/data/tile are captured per call; deliberately broad.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userContext, tile.id]);

  // Initial insight on open / when switching tiles. Also re-run when the user
  // updates their context (a fresh analysis from scratch).
  useEffect(() => {
    setTurns([]);
    generate([]);
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tile.id]);

  // Keep the latest reply in view as it streams.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [turns]);

  function regenerate() {
    setContextOpen(false);
    setTurns([]);
    generate([]);
  }

  function ask() {
    const q = question.trim();
    if (!q || streaming) return;
    const next = [...turns, { role: 'user', content: q }];
    setTurns(next);
    setQuestion('');
    generate(next);
  }

  const drag = useSheetDrag(onClose);

  // The most recent finished assistant turn — what the Share button hands off
  // (the initial insight, or the latest follow-up answer if the reader asked one).
  const shareText = [...turns].reverse().find((t) => t.role === 'assistant' && t.content.trim())?.content || '';

  // On phones the panel becomes a sheet (rounded top, drag-to-dismiss) rather
  // than a full-height side panel.
  const panelStyle = isMobile
    ? { ...panel, width: '100%', maxHeight: '92dvh', borderRadius: '18px 18px 0 0', paddingBottom: 'env(safe-area-inset-bottom)' }
    : panel;

  const node = (
    <div className="ai-overlay" style={isMobile ? { ...overlay, alignItems: 'flex-end', justifyContent: 'center' } : overlay} onClick={onClose}>
      <div
        className={(isMobile ? 'ai-sheet' : 'ai-panel') + ' ai-glow'}
        style={isMobile ? { ...panelStyle, ...drag.style } : panelStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <style>{`@keyframes blink { 50% { opacity: 0; } } @keyframes spin { to { transform: rotate(360deg); } }`}</style>
        {isMobile && <div className="sheet-grip" {...drag.handlers} style={{ marginTop: 8 }} />}
        <div style={header}>
          <AiMark size={28} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>AI insight</div>
            <div style={{ fontSize: 15, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tile.title || 'This tile'}</div>
          </div>
          {shareText && !streaming && (
            <ShareMenu
              variant="header"
              isMobile={isMobile}
              heading={`Owl insight · ${tile.title || 'This tile'}`}
              text={shareText}
            />
          )}
          <button style={isMobile ? { ...closeBtn, fontSize: 22, padding: '6px 10px' } : closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* Add-context affordance: steer the analysis with business background. */}
        <div style={contextBar}>
          {!contextOpen ? (
            <button style={contextToggle} onClick={() => setContextOpen(true)}>
              {userContext.trim() ? '✎ Edit context' : '＋ Add context for the Owl'}
            </button>
          ) : (
            <div>
              <textarea
                value={userContext}
                onChange={(e) => setUserContext(e.target.value)}
                placeholder="Add background to focus the analysis — e.g. goals, what's normal, what you're worried about, a comparison period…"
                rows={3}
                style={contextArea}
                autoFocus
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
                <button style={ghostBtn} onClick={() => setContextOpen(false)}>Cancel</button>
                <button style={primaryBtn} onClick={regenerate} disabled={streaming}>Update analysis</button>
              </div>
            </div>
          )}
        </div>

        <div style={body} ref={bodyRef}>
          {error && !turns.some((t) => t.content) ? (
            <div style={{ color: 'var(--error)', fontSize: 14, lineHeight: 1.5 }}>⚠ {error}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {turns.map((t, i) => (
                t.role === 'user' ? (
                  <div key={i} className="msg-in" style={userBubbleWrap}>
                    <div style={userBubble}>{t.content}</div>
                  </div>
                ) : (
                  <div key={i} className={`msg-in${streaming && i === turns.length - 1 && t.content ? ' streaming' : ''}`} style={{ fontSize: 14, lineHeight: 1.65, color: 'var(--text)' }}>
                    {t.content
                      ? renderMarkdownish(t.content)
                      : <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 5 }}>
                          <span style={{ color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⏳</span>
                            {i === 0 ? 'Analysing this tile…' : 'Thinking…'}
                          </span>
                          <OwlQuips prefix="" style={{ paddingLeft: 26 }} />
                        </span>}
                    {/* Live cursor on the turn currently streaming. */}
                    {streaming && i === turns.length - 1 && t.content && <span style={cursor} />}
                  </div>
                )
              ))}
              {error && turns.some((t) => t.content) && (
                <div style={{ color: 'var(--error)', fontSize: 13 }}>⚠ {error}</div>
              )}
            </div>
          )}
        </div>

        {/* Follow-up question composer. */}
        <div style={composer}>
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') ask(); }}
            placeholder="Ask a follow-up about this tile…"
            style={composerInput}
            disabled={streaming}
          />
          <button style={{ ...sendBtn, opacity: streaming || !question.trim() ? 0.5 : 1 }} onClick={ask} disabled={streaming || !question.trim()} aria-label="Send">↑</button>
        </div>

        <div style={{ padding: '8px 18px 12px', fontSize: 11, color: 'var(--muted)' }}>
          Generated by Claude from this tile's data. Verify important figures.
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

// Light rendering: "- " bullets and **bold**.
function renderMarkdownish(text) {
  if (!text) return null;
  return text.split('\n').filter((l) => l.trim()).map((line, i) => {
    const bulleted = /^[-*]\s+/.test(line.trim());
    const content = line.trim().replace(/^[-*]\s+/, '');
    const parts = content.split(/(\*\*[^*]+\*\*)/g).map((p, j) =>
      p.startsWith('**') && p.endsWith('**') ? <strong key={j}>{p.slice(2, -2)}</strong> : p
    );
    return (
      <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        {bulleted && <span style={{ color: 'var(--brand)' }}>•</span>}
        <span>{parts}</span>
      </div>
    );
  });
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', justifyContent: 'flex-end', zIndex: 400 };
const panel = { width: 'min(460px, 92vw)', height: '100%', background: 'var(--card)', boxShadow: '-4px 0 24px rgba(0,0,0,0.15)', display: 'flex', flexDirection: 'column' };
const header = { display: 'flex', alignItems: 'center', gap: 12, padding: '16px 18px', borderBottom: '1px solid var(--border)' };
const contextBar = { padding: '10px 18px', borderBottom: '1px solid var(--hairline)', background: 'var(--elevated)' };
const contextToggle = { border: 'none', background: 'transparent', color: 'var(--brand)', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: 0 };
const contextArea = { width: '100%', border: '1px solid var(--hairline)', borderRadius: 10, padding: '9px 11px', fontSize: 14, outline: 'none', resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit' };
const body = { flex: 1, minHeight: 0, overflowY: 'auto', padding: 18 };
const userBubbleWrap = { display: 'flex', justifyContent: 'flex-end' };
const userBubble = { background: 'var(--brand)', color: '#fff', fontSize: 14, lineHeight: 1.5, padding: '8px 13px', borderRadius: '14px 14px 4px 14px', maxWidth: '85%' };
const composer = { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 18px', borderTop: '1px solid var(--hairline)' };
const composerInput = { flex: 1, border: '1px solid var(--hairline)', borderRadius: 980, padding: '10px 16px', fontSize: 14, outline: 'none', boxSizing: 'border-box' };
const sendBtn = { flexShrink: 0, width: 38, height: 38, borderRadius: '50%', border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 18, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' };
const closeBtn = { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 17, color: '#888' };
const ghostBtn = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 980, padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const primaryBtn = { border: 'none', background: 'var(--brand)', color: '#fff', borderRadius: 980, padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const cursor = { display: 'inline-block', width: 7, height: 15, background: 'var(--brand)', marginLeft: 2, verticalAlign: 'text-bottom', animation: 'blink 1s step-end infinite' };
