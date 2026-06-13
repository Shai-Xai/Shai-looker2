import { useState, useEffect, useRef } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';

// Render a message body: plain text with URLs made clickable. A link to a
// campaign (…/actions?action=…) becomes a prominent "Review & approve" button.
function renderBody(text, mine) {
  const parts = String(text || '').split(/(https?:\/\/[^\s]+)/g);
  return parts.map((p, i) => {
    if (!/^https?:\/\//.test(p)) return p;
    if (/\/actions\?action=/.test(p)) {
      return <a key={i} href={p} style={{ display: 'inline-block', marginTop: 4, background: mine ? '#fff' : 'var(--brand)', color: mine ? 'var(--brand)' : '#fff', borderRadius: 980, padding: '6px 15px', fontSize: 12.5, fontWeight: 700, textDecoration: 'none' }}>Review &amp; approve →</a>;
    }
    return <a key={i} href={p} style={{ color: 'inherit', textDecoration: 'underline', fontWeight: 600, wordBreak: 'break-all' }}>{p}</a>;
  });
}

// Experience OS inbox — the client's tracked correspondence with Howler.
// Master list of threads + a reading pane with reply box and acknowledge.
// Isolated under src/os/ so the whole feature lifts out cleanly.
export default function InboxPage() {
  const isMobile = useIsMobile();
  const { isAdmin } = useAuth();
  const { previewEntityId } = useOutletContext() || {};
  const [collapsed, setCollapsed] = useState(false); // desktop: hide the thread list for more room
  const [list, setList] = useState(null);
  // Deep links (briefing "Open message →") arrive as /inbox?thread=<id>.
  const [params] = useSearchParams();
  const [openId, setOpenId] = useState(() => params.get('thread') || null);

  const load = () => api.osInbox(previewEntityId).then((r) => setList(r.threads)).catch(() => setList([]));
  useEffect(() => { load(); }, [previewEntityId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Live refresh: poll the thread list so new messages/unread show without a
  // manual reload — every 10s while visible, and on focus/return to the tab.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') api.osInbox(previewEntityId).then((r) => setList(r.threads)).catch(() => {}); };
    const iv = setInterval(tick, 10000);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', tick); window.removeEventListener('focus', tick); };
  }, [previewEntityId]);

  if (!list) return <Centered>Loading…</Centered>;

  // On mobile, show the thread full-screen when one is open. On desktop the
  // list can be collapsed to give the reading pane the full width.
  const showList = isMobile ? !openId : !collapsed;
  const showThread = !isMobile || !!openId;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      {showList && (
        <div style={{ width: isMobile ? '100%' : 340, flexShrink: 0, borderRight: isMobile ? 'none' : '1px solid var(--hairline)', overflowY: 'auto' }}>
          <div style={{ padding: '18px 18px 8px' }}>
            <h1 style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.02em' }}>Inbox</h1>
            <p style={{ fontSize: 12, color: 'var(--muted)' }}>Messages between you and Howler — all in one place.</p>
          </div>
          {list.length === 0 ? (
            <p style={{ padding: 18, color: 'var(--muted)', fontSize: 13 }}>No messages yet.</p>
          ) : list.map((t) => (
            <ThreadRow key={t.id} t={t} active={openId === t.id} isAdmin={isAdmin} isMobile={isMobile}
              onOpen={() => setOpenId(t.id)} onChanged={load}
              onDeleted={() => { if (openId === t.id) setOpenId(null); }} />
          ))}
        </div>
      )}
      {showThread && (
        openId
          ? <ThreadView key={openId} id={openId} isAdmin={isAdmin} isMobile={isMobile} onBack={() => setOpenId(null)} onChange={load} listCollapsed={collapsed} onToggleList={() => setCollapsed((c) => !c)} />
          : <Centered>Select a message.</Centered>
      )}
    </div>
  );
}

function ThreadView({ id, isAdmin, isMobile, onBack, onChange, listCollapsed, onToggleList }) {
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]); // [{name, mime, data(base64), size}]
  const [busy, setBusy] = useState(false);
  const [receipts, setReceipts] = useState(null);
  const endRef = useRef(null);
  const fileRef = useRef(null);
  const { user } = useAuth();

  const addFiles = (list) => {
    for (const f of Array.from(list || []).slice(0, 5)) {
      if (f.size > 10 * 1024 * 1024) { alert(`${f.name} is over 10MB`); continue; }
      const reader = new FileReader();
      reader.onload = () => setFiles((cur) => cur.length >= 5 ? cur : [...cur, { name: f.name, mime: f.type || 'application/octet-stream', size: f.size, data: String(reader.result).split(',')[1] }]);
      reader.readAsDataURL(f);
    }
  };

  const load = () => api.osThread(id).then(setData).catch(() => {});
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Live refresh of the open conversation so new replies arrive on their own —
  // every 5s while visible, and immediately when the tab/window regains focus.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') api.osThread(id).then(setData).catch(() => {}); };
    const iv = setInterval(tick, 5000);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', tick); window.removeEventListener('focus', tick); };
  }, [id]);
  useEffect(() => { endRef.current?.scrollIntoView(); onChange?.(); window.dispatchEvent(new Event('os-refresh')); }, [data?.messages?.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <Centered>Loading…</Centered>;
  const t = data.thread;
  // Client read/ack receipts (admin view only) — drive inline read indicators.
  const clientReceipts = data.clientReceipts || [];
  const reads = clientReceipts.filter((r) => r.kind === 'read');
  const acked = isAdmin ? clientReceipts.some((r) => r.kind === 'ack') : data.state.acked;
  // Only the client is ever asked to acknowledge — never Howler.
  const mustAck = !isAdmin && t.priority === 'must_ack' && !data.state.acked;
  // A Howler message is "read" once a client read-receipt lands at/after it.
  const readBy = (m) => reads.filter((r) => r.at >= m.createdAt);

  const reply = () => {
    const b = text.trim(); if (!b && !files.length) return;
    setBusy(true);
    api.osReply(id, b, files).then((r) => { setData((d) => ({ ...d, messages: r.messages })); setText(''); setFiles([]); }).catch((e) => alert(e.message)).finally(() => setBusy(false));
  };
  const ack = () => api.osAck(id).then(() => { load(); onChange?.(); window.dispatchEvent(new Event('os-refresh')); }).catch(() => {});

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--hairline)', display: 'flex', alignItems: 'center', gap: 10 }}>
        {isMobile && <button onClick={onBack} style={linkBtn}>← Inbox</button>}
        {!isMobile && onToggleList && <button onClick={onToggleList} title={listCollapsed ? 'Show inbox list' : 'Hide inbox list'} style={{ ...linkBtn, fontSize: 16, lineHeight: 1 }}>{listCollapsed ? '☰' : '⟨⟨'}</button>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title || '(no subject)'}</h2>
            <PriorityChip priority={t.priority} acked={acked} />
          </div>
          {isAdmin && <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t.entityName}</div>}
        </div>
        {isAdmin && <button onClick={() => { if (!receipts) api.osReceipts(id).then((r) => setReceipts(r.receipts)); else setReceipts(null); }} style={linkBtn}>{receipts ? 'Hide' : 'Receipts'}</button>}
      </div>

      {receipts && (
        <div style={{ padding: '10px 18px', background: 'var(--elevated)', borderBottom: '1px solid var(--hairline)', fontSize: 12 }}>
          {receipts.length === 0 ? <span style={{ color: 'var(--muted)' }}>No reads or acknowledgements yet.</span>
            : receipts.map((r, i) => <div key={i}>{r.kind === 'ack' ? '✓ Acknowledged' : '👁 Read'} by <b>{r.email}</b> · {shortDate(r.at)}</div>)}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {data.messages.map((m) => {
          // System/Pulse notifications render as a centred neutral event note
          // Every message shows an avatar. "My side" is right (Howler for an
          // admin viewer, the client for a client viewer). System/Pulse and
          // Howler sit on the left with the Pulse/Howler logo; the client uses
          // their entity logo. System keeps a neutral (not brand) bubble.
          const isSystem = m.authorType === 'system';
          const isHowlerSide = ['system', 'howler', 'owl'].includes(m.authorType);
          // "My side" is right: Howler for an admin viewer, the client for a
          // client viewer. (Author types are howler | client | owl | system.)
          const mine = isAdmin ? m.authorType === 'howler' : m.authorType === 'client';
          const ownEmail = !!user?.email && (m.authorEmail || '').toLowerCase() === user.email.toLowerCase();
          const seen = isAdmin && m.authorType === 'howler' ? readBy(m) : null;
          const partyBg = m.authorType === 'howler' ? 'var(--brand-2)' : 'var(--brand)';
          const initial = isSystem ? 'P' : m.authorType === 'howler' ? 'H' : (m.authorEmail || '?').trim().charAt(0).toUpperCase();
          const shortName = ownEmail ? 'You' : isSystem ? 'Pulse' : m.authorType === 'owl' ? 'Owl' : m.authorType === 'howler' ? 'Howler' : (m.authorEmail || 'Someone').split('@')[0];
          // Avatar image: Howler/Pulse → the Pulse logo; client → their entity logo.
          const logo = isHowlerSide ? '/logo.png' : (data.thread.entityLogo || '');
          return (
            <div key={m.id} style={{ display: 'flex', flexDirection: mine ? 'row-reverse' : 'row', alignItems: 'flex-end', gap: 8 }}>
              <div title={shortName} style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, overflow: 'hidden', background: logo ? 'var(--card)' : partyBg, border: logo ? '1px solid var(--hairline)' : 'none', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800 }}>
                {logo ? <img src={logo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.parentNode.style.background = partyBg; e.currentTarget.parentNode.textContent = initial; }} /> : initial}
              </div>
              <div style={{ maxWidth: '74%', minWidth: 0 }}>
                <div style={{ fontSize: 10.5, color: 'var(--muted)', marginBottom: 3, textAlign: mine ? 'right' : 'left' }}>{shortName}{m.channel !== 'pulse' ? ` · ${m.channel}` : ''} · {shortDate(m.createdAt)}</div>
                <div style={{ background: mine ? 'var(--brand)' : 'var(--elevated)', color: mine ? '#fff' : 'var(--text)', border: mine ? '1px solid var(--brand)' : '1px solid var(--hairline)', borderLeft: mine ? undefined : `3px solid ${partyBg}`, borderRadius: mine ? '16px 16px 4px 16px' : '16px 16px 16px 4px', padding: '9px 13px', fontSize: 13.5, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{renderBody(m.body, mine)}</div>
                {(m.attachments || []).length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 5, alignItems: mine ? 'flex-end' : 'flex-start' }}>
                    {m.attachments.map((a) => a.mime?.startsWith('image/') ? (
                      <a key={a.id} href={`/api/os/attachments/${a.id}`} target="_blank" rel="noreferrer">
                        <img src={`/api/os/attachments/${a.id}`} alt={a.name} style={{ maxWidth: 220, maxHeight: 160, borderRadius: 10, border: '1px solid var(--hairline)', display: 'block' }} />
                      </a>
                    ) : (
                      <a key={a.id} href={`/api/os/attachments/${a.id}?dl=1`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--text)', background: 'var(--elevated)', border: '1px solid var(--hairline)', borderRadius: 980, padding: '5px 11px', textDecoration: 'none' }}>
                        📎 {a.name} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>{fmtSize(a.size)}</span>
                      </a>
                    ))}
                  </div>
                )}
                {seen && (
                  <div style={{ fontSize: 10, marginTop: 3, color: seen.length ? '#2da44e' : 'var(--muted)', fontWeight: 600, textAlign: mine ? 'right' : 'left' }}>
                    {seen.length ? `✓✓ Read by ${seen.map((r) => r.email).join(', ')} · ${shortDate(seen.map((r) => r.at).sort()[0])}` : '✓ Sent · not yet read'}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {mustAck && (
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--hairline)', background: 'rgba(245,158,11,0.10)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>Howler needs you to acknowledge this message.</span>
          <button onClick={ack} style={{ ...primaryBtn, background: '#b45309' }}>Acknowledge</button>
        </div>
      )}

      <div style={{ padding: 14, borderTop: '1px solid var(--hairline)' }}>
        {files.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {files.map((f, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, background: 'var(--elevated)', border: '1px solid var(--hairline)', borderRadius: 980, padding: '4px 10px' }}>
                📎 {f.name} <span style={{ color: 'var(--muted)' }}>{fmtSize(f.size)}</span>
                <button onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--muted)', fontSize: 12, padding: 0 }}>✕</button>
              </span>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <button onClick={() => fileRef.current?.click()} title="Attach files" aria-label="Attach files" style={{ ...linkBtn, fontSize: 17, padding: '8px 4px' }}>📎</button>
          <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          <textarea
            value={text} onChange={(e) => setText(e.target.value)} rows={1} placeholder="Write a reply…"
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) reply(); }}
            style={{ flex: 1, border: '1px solid var(--hairline)', borderRadius: 12, padding: '10px 13px', fontSize: 13.5, outline: 'none', resize: 'vertical', fontFamily: 'inherit', background: 'var(--card)', color: 'var(--text)' }}
          />
          <button onClick={reply} disabled={busy || (!text.trim() && !files.length)} style={primaryBtn}>{busy ? '…' : 'Send'}</button>
        </div>
      </div>
    </div>
  );
}

// One inbox row. Desktop: hover reveals Unread/Delete. Mobile: swipe left
// (Apple Mail style) to reveal the same actions; tap to open.
function ThreadRow({ t, active, isAdmin, isMobile, onOpen, onChanged, onDeleted }) {
  const W = 152; // revealed actions width
  const [dx, setDx] = useState(0);
  const [hover, setHover] = useState(false);
  const start = useRef(null);
  const moved = useRef(false);

  const toggleRead = () => { setDx(0); (t.unread ? api.osThread(t.id) : api.osThreadUnread(t.id)).then(onChanged).catch(() => {}); };
  const del = () => { setDx(0); api.osThreadDelete(t.id).then(() => { onDeleted?.(); onChanged?.(); }).catch(() => {}); };

  const onTouchStart = (e) => { start.current = { x: e.touches[0].clientX, base: dx }; moved.current = false; };
  const onTouchMove = (e) => {
    if (!start.current) return;
    const nx = Math.min(0, Math.max(-W, start.current.base + (e.touches[0].clientX - start.current.x)));
    if (Math.abs(nx - start.current.base) > 3) moved.current = true;
    setDx(nx);
  };
  const onTouchEnd = () => { setDx(dx < -W / 2 ? -W : 0); start.current = null; };
  const tap = () => { if (moved.current) return; if (dx !== 0) { setDx(0); return; } onOpen(); };

  const actionsVisible = isMobile ? dx < -8 : hover;
  return (
    <div style={{ position: 'relative', overflow: 'hidden', borderBottom: '1px solid var(--hairline)' }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {/* Actions behind the row (revealed by swipe on mobile / hover on desktop) */}
      <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, display: 'flex', opacity: actionsVisible ? 1 : 0, transition: 'opacity .15s', pointerEvents: actionsVisible ? 'auto' : 'none' }}>
        <button onClick={(e) => { e.stopPropagation(); toggleRead(); }} style={{ ...actBtn, background: '#0a66c2' }}>{t.unread ? 'Read' : 'Unread'}</button>
        <button onClick={(e) => { e.stopPropagation(); del(); }} style={{ ...actBtn, background: '#dc2626' }}>Delete</button>
      </div>
      <button
        onClick={tap}
        onTouchStart={isMobile ? onTouchStart : undefined}
        onTouchMove={isMobile ? onTouchMove : undefined}
        onTouchEnd={isMobile ? onTouchEnd : undefined}
        className="nav-row"
        style={{ ...rowBtn, borderBottom: 'none', position: 'relative', transform: `translateX(${isMobile ? dx : 0}px)`, transition: start.current ? 'none' : 'transform .2s', background: active ? 'var(--elevated)' : 'var(--bg)', touchAction: 'pan-y' }}
      >
        <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, marginTop: 6, background: t.unread ? 'var(--brand)' : 'transparent' }} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 13.5, fontWeight: t.unread ? 800 : 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title || '(no subject)'}</span>
            <PriorityChip priority={t.priority} acked={t.acked} />
          </span>
          {isAdmin && <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)' }}>{t.entityName}</span>}
          <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.preview?.body || ''}</span>
        </span>
        <span style={{ fontSize: 10.5, color: 'var(--muted)', flexShrink: 0 }}>{shortDate(t.updatedAt)}</span>
      </button>
    </div>
  );
}

const actBtn = { border: 'none', cursor: 'pointer', color: '#fff', fontSize: 12, fontWeight: 700, width: 76, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' };

function PriorityChip({ priority, acked }) {
  // Status only — the action lives in the amber bar. Labelling this chip
  // "Acknowledge" made clients click it expecting it to register the ack.
  if (priority === 'must_ack') return <span style={{ ...chip, background: acked ? 'rgba(52,199,89,0.15)' : 'rgba(245,158,11,0.16)', color: acked ? '#2da44e' : '#b45309' }}>{acked ? '✓ Acknowledged' : 'Needs ack'}</span>;
  if (priority === 'needs_reply') return <span style={{ ...chip, background: 'rgba(10,132,255,0.13)', color: '#0a66c2' }}>Needs reply</span>;
  if (priority === 'fyi') return <span style={{ ...chip, background: 'rgba(128,128,128,0.14)', color: 'var(--muted-2)' }}>FYI</span>;
  return null;
}

const shortDate = (iso) => { try { const d = new Date(iso); const today = new Date().toDateString() === d.toDateString(); return today ? d.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }); } catch { return ''; } };
const fmtSize = (b) => (b > 1024 * 1024 ? `${(b / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(b / 1024))}KB`);
const rowBtn = { display: 'flex', gap: 9, width: '100%', textAlign: 'left', border: 'none', borderBottom: '1px solid var(--hairline)', cursor: 'pointer', padding: '12px 16px', color: 'var(--text)' };
const chip = { flexShrink: 0, fontSize: 10, fontWeight: 700, borderRadius: 980, padding: '2px 8px' };
const linkBtn = { border: 'none', background: 'transparent', color: 'var(--brand)', fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0 };
const primaryBtn = { border: 'none', background: 'var(--brand)', color: '#fff', borderRadius: 980, padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', flexShrink: 0 };

function Centered({ children }) {
  return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, color: 'var(--muted)', fontSize: 14 }}>{children}</div>;
}
