import { useState, useEffect, useRef } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';

// Experience OS inbox — the client's tracked correspondence with Howler.
// Master list of threads + a reading pane with reply box and acknowledge.
// Isolated under src/os/ so the whole feature lifts out cleanly.
export default function InboxPage() {
  const isMobile = useIsMobile();
  const { isAdmin } = useAuth();
  const { previewEntityId } = useOutletContext() || {};
  const [list, setList] = useState(null);
  const [openId, setOpenId] = useState(null);

  const load = () => api.osInbox(previewEntityId).then((r) => setList(r.threads)).catch(() => setList([]));
  useEffect(() => { load(); }, [previewEntityId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!list) return <Centered>Loading…</Centered>;

  // On mobile, show the thread full-screen when one is open.
  const showList = !isMobile || !openId;
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
            <button key={t.id} onClick={() => setOpenId(t.id)} className="nav-row" style={{ ...rowBtn, background: openId === t.id ? 'rgba(128,128,128,0.10)' : 'transparent' }}>
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
          ))}
        </div>
      )}
      {showThread && (
        openId
          ? <ThreadView key={openId} id={openId} isAdmin={isAdmin} isMobile={isMobile} onBack={() => setOpenId(null)} onChange={load} />
          : <Centered>Select a message.</Centered>
      )}
    </div>
  );
}

function ThreadView({ id, isAdmin, isMobile, onBack, onChange }) {
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [receipts, setReceipts] = useState(null);
  const endRef = useRef(null);

  const load = () => api.osThread(id).then(setData).catch(() => {});
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { endRef.current?.scrollIntoView(); onChange?.(); window.dispatchEvent(new Event('os-refresh')); }, [data?.messages?.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <Centered>Loading…</Centered>;
  const t = data.thread;
  const mustAck = t.priority === 'must_ack' && !data.state.acked;

  const reply = () => {
    const b = text.trim(); if (!b) return;
    setBusy(true);
    api.osReply(id, b).then((r) => { setData((d) => ({ ...d, messages: r.messages })); setText(''); }).catch(() => {}).finally(() => setBusy(false));
  };
  const ack = () => api.osAck(id).then(() => { load(); onChange?.(); window.dispatchEvent(new Event('os-refresh')); }).catch(() => {});

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--hairline)', display: 'flex', alignItems: 'center', gap: 10 }}>
        {isMobile && <button onClick={onBack} style={linkBtn}>← Inbox</button>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title || '(no subject)'}</h2>
            <PriorityChip priority={t.priority} acked={data.state.acked} />
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
          const mine = m.authorType !== 'howler';
          return (
            <div key={m.id} style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
              <div style={{ maxWidth: '78%' }}>
                <div style={{ fontSize: 10.5, color: 'var(--muted)', marginBottom: 3, textAlign: mine ? 'right' : 'left' }}>
                  {m.authorType === 'howler' ? 'Howler' : m.authorEmail}{m.channel !== 'pulse' ? ` · ${m.channel}` : ''} · {shortDate(m.createdAt)}
                </div>
                <div style={{ background: mine ? 'var(--brand)' : 'var(--elevated)', color: mine ? '#fff' : 'var(--text)', borderRadius: mine ? '14px 14px 4px 14px' : '14px 14px 14px 4px', padding: '9px 13px', fontSize: 13.5, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{m.body}</div>
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

      <div style={{ padding: 14, borderTop: '1px solid var(--hairline)', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          value={text} onChange={(e) => setText(e.target.value)} rows={1} placeholder="Write a reply…"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) reply(); }}
          style={{ flex: 1, border: '1px solid var(--hairline)', borderRadius: 12, padding: '10px 13px', fontSize: 13.5, outline: 'none', resize: 'vertical', fontFamily: 'inherit', background: 'var(--card)', color: 'var(--text)' }}
        />
        <button onClick={reply} disabled={busy || !text.trim()} style={primaryBtn}>{busy ? '…' : 'Send'}</button>
      </div>
    </div>
  );
}

function PriorityChip({ priority, acked }) {
  if (priority === 'must_ack') return <span style={{ ...chip, background: acked ? 'rgba(52,199,89,0.15)' : 'rgba(245,158,11,0.16)', color: acked ? '#2da44e' : '#b45309' }}>{acked ? '✓ Acknowledged' : 'Acknowledge'}</span>;
  if (priority === 'needs_reply') return <span style={{ ...chip, background: 'rgba(10,132,255,0.13)', color: '#0a66c2' }}>Needs reply</span>;
  if (priority === 'fyi') return <span style={{ ...chip, background: 'rgba(128,128,128,0.14)', color: 'var(--muted-2)' }}>FYI</span>;
  return null;
}

const shortDate = (iso) => { try { const d = new Date(iso); const today = new Date().toDateString() === d.toDateString(); return today ? d.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }); } catch { return ''; } };
const rowBtn = { display: 'flex', gap: 9, width: '100%', textAlign: 'left', border: 'none', borderBottom: '1px solid var(--hairline)', cursor: 'pointer', padding: '12px 16px', color: 'var(--text)' };
const chip = { flexShrink: 0, fontSize: 10, fontWeight: 700, borderRadius: 980, padding: '2px 8px' };
const linkBtn = { border: 'none', background: 'transparent', color: 'var(--brand)', fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0 };
const primaryBtn = { border: 'none', background: 'var(--brand)', color: '#fff', borderRadius: 980, padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', flexShrink: 0 };

function Centered({ children }) {
  return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, color: 'var(--muted)', fontSize: 14 }}>{children}</div>;
}
