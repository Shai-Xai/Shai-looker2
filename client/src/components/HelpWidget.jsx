// App-wide, mobile-first "Pulse Help" chatbot widget. Mounted once in the Shell
// (like InboxNotifier / ReportWidget) so it's reachable from ANY screen. A
// floating ? button opens a chat panel that answers questions about PULSE ITSELF
// — how-to, what's new, what you can do — tailored to the user's role, tenant and
// current event. Backed by server/helpBot.js (retrieval-grounded; declines when
// it doesn't know). This is the client self-service half of the dual-surface
// rule; admins curate the knowledge in Admin → Product → Help bot.
import { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { useProfile } from '../lib/profile.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
import { api } from '../lib/api.js';

// ── Tiny, dependency-free markdown for help answers (bold, code, links, bullet /
// numbered lists, paragraphs). Pulse ships no markdown lib; this covers what the
// help bot emits. HTML is escaped first so nothing user/model-supplied can inject.
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function inline(s) {
  let h = esc(s);
  h = h.replace(/`([^`]+)`/g, '<code style="background:rgba(128,128,128,0.16);padding:1px 5px;border-radius:5px;font-size:0.92em">$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:var(--brand)">$1</a>');
  h = h.replace(/(^|[\s(])(https?:\/\/[^\s)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer" style="color:var(--brand)">$2</a>');
  return h;
}
function Markdown({ text }) {
  const lines = String(text || '').split('\n');
  const blocks = [];
  let list = null; // { ordered, items: [] }
  const flush = () => { if (list) { blocks.push(list); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const ul = line.match(/^\s*[-*]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (ul) { if (!list || list.ordered) { flush(); list = { ordered: false, items: [] }; } list.items.push(ul[1]); }
    else if (ol) { if (!list || !list.ordered) { flush(); list = { ordered: true, items: [] }; } list.items.push(ol[1]); }
    else if (!line.trim()) { flush(); }
    else { flush(); blocks.push({ p: line }); }
  }
  flush();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {blocks.map((b, i) => b.items
        ? (b.ordered
          ? <ol key={i} style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>{b.items.map((it, j) => <li key={j} dangerouslySetInnerHTML={{ __html: inline(it) }} />)}</ol>
          : <ul key={i} style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>{b.items.map((it, j) => <li key={j} dangerouslySetInnerHTML={{ __html: inline(it) }} />)}</ul>)
        : <div key={i} dangerouslySetInnerHTML={{ __html: inline(b.p) }} />)}
    </div>
  );
}

export default function HelpWidget() {
  const { user } = useAuth();
  const { activeEntityId, mode } = useProfile();
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState(null);
  const [msgs, setMsgs] = useState([]); // { role: 'user'|'bot', text, sources? }
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  // Fetch availability once signed in (kill switch + greeting come from the server).
  useEffect(() => {
    if (!user) return;
    let alive = true;
    api.helpConfig().then((c) => { if (alive) setConfig(c); }).catch(() => {});
    return () => { alive = false; };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (open && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [msgs, busy, open]);
  useEffect(() => { if (open && !isMobile) setTimeout(() => inputRef.current?.focus(), 50); }, [open, isMobile]);

  if (!user || !config || config.enabled === false) return null;

  // The active event, when the user is inside a dashboard view (/suite/:id/...).
  const suiteMatch = location.pathname.match(/\/suite\/([^/]+)/);
  const suiteId = suiteMatch ? decodeURIComponent(suiteMatch[1]) : undefined;
  const entityId = mode === 'client' ? (activeEntityId || undefined) : undefined;

  async function ask(text) {
    const q = String(text ?? input).trim();
    if (!q || busy) return;
    setInput('');
    setMsgs((m) => [...m, { role: 'user', text: q }]);
    setBusy(true);
    try {
      const r = await api.helpChat({ message: q, entityId, suiteId });
      setMsgs((m) => [...m, { role: 'bot', text: r.answer, sources: r.sources || [] }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: 'bot', text: (e && e.message) || 'Sorry — I hit a problem answering that. Please try again.' }]);
    } finally { setBusy(false); }
  }

  const goDeepLink = (path) => { if (path) { setOpen(false); navigate(path); } };

  const panelStyle = isMobile
    ? { position: 'fixed', inset: 0, zIndex: 90, display: 'flex', flexDirection: 'column' }
    : { position: 'fixed', bottom: 22, right: 22, zIndex: 90, width: 384, maxWidth: 'calc(100vw - 32px)', height: 'min(600px, calc(100dvh - 90px))', display: 'flex', flexDirection: 'column', borderRadius: 18, overflow: 'hidden', boxShadow: 'var(--glass-shadow), 0 12px 40px rgba(0,0,0,0.28)' };

  return (
    <>
      {/* Floating launcher — persistent across every screen. */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Open Pulse Help"
          style={{
            position: 'fixed', right: isMobile ? 14 : 22, bottom: isMobile ? 'calc(env(safe-area-inset-bottom, 0px) + 78px)' : 22,
            zIndex: 85, width: 52, height: 52, borderRadius: 980, border: 'none', cursor: 'pointer',
            background: 'var(--brand)', color: '#fff', fontSize: 24, lineHeight: 1, boxShadow: '0 6px 20px rgba(0,0,0,0.28)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          title="Pulse Help — how-to, what's new, what you can do"
        >💬</button>
      )}

      {open && (
        <div style={panelStyle} className={isMobile ? '' : 'modal-in'}>
          <div style={{
            display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0,
            background: 'var(--glass-bg)', backdropFilter: 'blur(var(--glass-blur)) saturate(180%)', WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(180%)',
            border: isMobile ? 'none' : '1px solid var(--glass-border)',
          }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: '1px solid var(--hairline)', flexShrink: 0 }}>
              <span style={{ fontSize: 20 }}>💬</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>Pulse Help</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>How-to · what's new · what you can do</div>
              </div>
              <button onClick={() => setOpen(false)} aria-label="Close" style={{ border: 'none', background: 'rgba(128,128,128,0.14)', borderRadius: 980, width: 30, height: 30, fontSize: 16, cursor: 'pointer', color: 'var(--text)' }}>✕</button>
            </div>

            {/* Messages */}
            <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {msgs.length === 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.5 }}>{config.greeting}</div>
                  {!config.aiConfigured && <div style={{ fontSize: 12, color: 'var(--muted)' }}>(The assistant isn’t fully configured yet — answers may be unavailable.)</div>}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {(config.starters || []).map((s, i) => (
                      <button key={i} onClick={() => ask(s.prompt)} style={starterStyle}>
                        <span style={{ fontSize: 15 }}>{s.icon}</span>
                        <span style={{ flex: 1, textAlign: 'left' }}>{s.label}</span>
                        <span style={{ color: 'var(--muted)' }}>›</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {msgs.map((m, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                  <div style={{
                    maxWidth: '88%', padding: '10px 12px', borderRadius: 14, fontSize: 14, lineHeight: 1.5,
                    background: m.role === 'user' ? 'var(--brand)' : 'rgba(128,128,128,0.12)',
                    color: m.role === 'user' ? '#fff' : 'var(--text)',
                    borderBottomRightRadius: m.role === 'user' ? 4 : 14, borderBottomLeftRadius: m.role === 'user' ? 14 : 4,
                  }}>
                    {m.role === 'user' ? m.text : <Markdown text={m.text} />}
                    {m.sources && m.sources.length > 0 && (
                      <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {m.sources.map((s, j) => (
                          <button key={j} onClick={() => goDeepLink(s.deepLink)} style={sourceChip} title={`Go to ${s.title}`}>↳ {s.title}</button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {busy && <div style={{ fontSize: 13, color: 'var(--muted)', fontStyle: 'italic' }}>Looking that up…</div>}
            </div>

            {/* Composer */}
            <form
              onSubmit={(e) => { e.preventDefault(); ask(); }}
              style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid var(--hairline)', flexShrink: 0, paddingBottom: isMobile ? 'calc(env(safe-area-inset-bottom, 0px) + 12px)' : 12 }}
            >
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask how to do something…"
                style={{ flex: 1, border: '1px solid var(--hairline)', background: 'var(--surface, rgba(128,128,128,0.06))', borderRadius: 980, padding: '10px 14px', fontSize: 14, color: 'var(--text)', outline: 'none' }}
              />
              <button type="submit" disabled={busy || !input.trim()} style={{ border: 'none', background: 'var(--brand)', color: '#fff', borderRadius: 980, width: 44, fontSize: 17, cursor: busy || !input.trim() ? 'default' : 'pointer', opacity: busy || !input.trim() ? 0.5 : 1 }}>➤</button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

const starterStyle = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', border: '1px solid var(--hairline)', background: 'rgba(128,128,128,0.06)', borderRadius: 12, padding: '10px 12px', fontSize: 13, fontWeight: 600, color: 'var(--text)', cursor: 'pointer' };
const sourceChip = { border: '1px solid var(--glass-border, var(--hairline))', background: 'rgba(128,128,128,0.10)', borderRadius: 980, padding: '4px 10px', fontSize: 12, fontWeight: 600, color: 'var(--brand)', cursor: 'pointer' };
