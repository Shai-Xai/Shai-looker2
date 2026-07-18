import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';

// Engage → Community → Channels: per-event chat channels + fan groups
// (Social+ replacement phase 2, mockup approved 2026-07-18). Dual-surface
// (scope: 'my' | 'admin'). Wire contract: docs/specs/SOCIAL_CONTRACT.md §chat.

const ACCESS_LABEL = { public: '🌍 Public', segment: '🎟 Segment-gated', manual: '🔒 Manual members', invite: '🔗 Invite link' };
const CTA_SCREENS = [
  ['explore_tickets', '🎟 Tickets'], ['explore', '📄 Event page'], ['explore_lineup', '🎤 Line-up'],
  ['explore_map', '🗺 Map'], ['explore_merch', '🛍 Merch'], ['explore_feed', '📰 Event feed'],
  ['open_url', '🔗 Custom link'],
];

// Shared CTA sub-form (same vocabulary the feed composer uses).
function CtaFields({ cta, setCta, eventId }) {
  if (!cta.on) return <button style={mini} onClick={() => setCta({ ...cta, on: true })}>🔘 Button</button>;
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <input style={{ ...input, width: 130 }} value={cta.label} onChange={(e) => setCta({ ...cta, label: e.target.value })} placeholder="Button label" maxLength={40} />
      <select style={{ ...input, width: 'auto' }} value={cta.screen} onChange={(e) => setCta({ ...cta, screen: e.target.value })}>
        {CTA_SCREENS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {cta.screen === 'open_url' && <input style={{ ...input, width: 170 }} value={cta.url} onChange={(e) => setCta({ ...cta, url: e.target.value })} placeholder="https://…" />}
      <button style={tiny} onClick={() => setCta({ on: false, label: '', screen: 'explore_tickets', url: '' })}>✕</button>
      {cta.on && <span style={{ display: 'none' }}>{eventId}</span>}
    </span>
  );
}
const buildCta = (cta, eventId) => (!cta.on || !cta.label.trim() ? {} : {
  ctaLabel: cta.label.trim(),
  ctaDestination: cta.screen === 'open_url' ? `open_url:${cta.url.trim()}` : `${cta.screen}${eventId ? `:${eventId}` : ''}`,
});
const emptyCta = { on: false, label: '', screen: 'explore_tickets', url: '' };

export default function ChatChannelsManager({ entityId, scope, eventIds = [] }) {
  const [eventId, setEventId] = useState(eventIds[0] || '');
  const [channels, setChannels] = useState(null);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const load = () => eventId && api.chatChannels(scope, entityId, eventId).then((r) => setChannels(r.channels || [])).catch(() => setChannels([]));
  useEffect(() => { setChannels(null); if (eventId) load(); }, [entityId, eventId]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = (fn) => fn.then(() => { setError(''); return load(); }).catch((e) => setError(e.message || 'That didn’t work'));

  const official = (channels || []).filter((c) => c.kind === 'official');
  const groups = (channels || []).filter((c) => c.kind === 'group');

  return (
    <section style={{ marginTop: 28 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 750 }}>💬 Channels</h3>
        <input style={{ ...input, width: 120 }} value={eventId} onChange={(e) => setEventId(e.target.value.replace(/\D/g, ''))} placeholder="Event ID" inputMode="numeric" />
        {eventIds.filter((id) => id && id !== eventId).map((id) => <button key={id} style={tiny} onClick={() => setEventId(id)}>{id}</button>)}
        {eventId && <button style={{ ...mini, marginLeft: 'auto' }} onClick={() => setShowCreate((v) => !v)}>{showCreate ? 'Close' : '+ New channel'}</button>}
      </div>
      {error && <p style={{ color: '#c62828', fontSize: 13, margin: '0 0 8px' }}>{error}</p>}
      {!eventId ? <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>Enter the Howler event ID to manage its chat channels.</p> : channels === null ? <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p> : (
        <>
          {showCreate && <CreateChannel scope={scope} entityId={entityId} eventId={eventId} onDone={() => { setShowCreate(false); load(); }} onError={setError} />}
          {official.length > 0 && <Broadcast scope={scope} entityId={entityId} eventId={eventId} onDone={load} onError={setError} />}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
            {official.map((c) => <ChannelRow key={c.id} scope={scope} entityId={entityId} channel={c} eventId={eventId} onChanged={load} onError={setError} act={act} />)}
            {official.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>No channels yet — start with 📣 Main, then add Transport, Line-up…</p>}
          </div>
          {groups.length > 0 && (
            <details style={{ marginTop: 14 }}>
              <summary style={{ fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>👥 Fan-made groups ({groups.length})</summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                {groups.map((c) => (
                  <div key={c.id} style={{ ...card, marginBottom: 0, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 160 }}>
                      <p style={{ margin: 0, fontWeight: 700, fontSize: 13.5 }}>{c.emoji} {c.name}</p>
                      <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--muted)' }}>by {c.createdBy || 'a fan'} · {c.memberCount} member{c.memberCount === 1 ? '' : 's'}</p>
                    </div>
                    <button style={{ ...mini, color: '#c62828' }} onClick={() => window.confirm('Close this fan group? Members lose access.') && act(api.chatCloseChannel(scope, entityId, c.id))}>Close group</button>
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function CreateChannel({ scope, entityId, eventId, onDone, onError }) {
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('📣');
  const [access, setAccess] = useState('public');
  const [mode, setMode] = useState('chat');
  const [segmentId, setSegmentId] = useState('');
  const create = () => api.chatCreateChannel(scope, entityId, { eventId, name, emoji, access, mode, segmentId })
    .then(onDone).catch((e) => onError(e.message || 'Create failed'));
  return (
    <div style={{ ...card, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <input style={{ ...input, width: 54 }} value={emoji} onChange={(e) => setEmoji(e.target.value)} title="Emoji" />
      <input style={{ ...input, flex: 1, minWidth: 140 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Channel name, e.g. Transport" maxLength={60} />
      <select style={{ ...input, width: 'auto' }} value={access} onChange={(e) => setAccess(e.target.value)}>
        <option value="public">🌍 Public — everyone at the event</option>
        <option value="segment">🎟 Segment-gated (ticket types)</option>
        <option value="manual">🔒 Manual — admin-added only</option>
      </select>
      {access === 'segment' && <input style={{ ...input, width: 150 }} value={segmentId} onChange={(e) => setSegmentId(e.target.value)} placeholder="Segment ID" title="From Engage → Segments — gating members sync from this segment" />}
      <select style={{ ...input, width: 'auto' }} value={mode} onChange={(e) => setMode(e.target.value)}>
        <option value="chat">💬 Open chat</option>
        <option value="broadcast">📣 Broadcast — organiser posts, fans react</option>
      </select>
      <button style={{ ...primary, opacity: name.trim() ? 1 : 0.5 }} disabled={!name.trim()} onClick={create}>Create</button>
    </div>
  );
}

function Broadcast({ scope, entityId, eventId, onDone, onError }) {
  const [text, setText] = useState('');
  const [pin, setPin] = useState(true);
  const [push, setPush] = useState(true);
  const [cta, setCta] = useState(emptyCta);
  const send = () => api.chatBroadcast(scope, entityId, { eventId, text, pin, push, ...buildCta(cta, eventId) })
    .then(() => { setText(''); setCta(emptyCta); onDone(); }).catch((e) => onError(e.message || 'Broadcast failed'));
  return (
    <div style={{ ...card, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', borderStyle: 'dashed' }}>
      <strong style={{ fontSize: 13 }}>📣 Broadcast</strong>
      <input style={{ ...input, flex: 1, minWidth: 200 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="Lands in every channel at once…" />
      <CtaFields cta={cta} setCta={setCta} eventId={eventId} />
      <label style={{ fontSize: 12.5, display: 'inline-flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} /> 📌 pin</label>
      <label style={{ fontSize: 12.5, display: 'inline-flex', gap: 5, alignItems: 'center' }} title="Recorded per message — delivery activates once the Firebase key is configured"><input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} /> 🔔 push</label>
      <button style={{ ...primary, opacity: text.trim() ? 1 : 0.5 }} disabled={!text.trim()} onClick={send}>Send</button>
    </div>
  );
}

function ChannelRow({ scope, entityId, channel: c, eventId, onChanged, onError, act }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState(null);
  const [text, setText] = useState('');
  const [cta, setCta] = useState(emptyCta);
  const [memberId, setMemberId] = useState('');
  const loadMsgs = () => api.chatChannelMessages(scope, entityId, c.id).then((r) => setMessages(r.messages || [])).catch(() => setMessages([]));
  const toggle = () => { setOpen((v) => !v); if (!open && messages === null) loadMsgs(); };
  const send = () => api.chatSendMessage(scope, entityId, c.id, { text, ...buildCta(cta, eventId) })
    .then(() => { setText(''); setCta(emptyCta); loadMsgs(); }).catch((e) => onError(e.message || 'Send failed'));
  const reported = (messages || []).filter((m) => m.reported && !m.deleted).length;
  return (
    <div style={{ ...card, marginBottom: 0 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 170 }}>
          <p style={{ margin: 0, fontWeight: 700, fontSize: 14 }}>{c.emoji} {c.name} {c.mode === 'broadcast' && <span style={pill('rgba(245,179,1,0.16)', '#8a6d00')}>broadcast</span>}</p>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--muted)' }}>{ACCESS_LABEL[c.access]}{c.segmentId ? ` · segment ${c.segmentId}` : ''} · {c.memberCount} member{c.memberCount === 1 ? '' : 's'}</p>
        </div>
        {c.access === 'segment' && <button style={tiny} title="Pull members from the linked segment" onClick={() => act(api.chatSyncSegment(scope, entityId, c.id).then((r) => { if (r.pending) onError(r.message); }))}>⟳ Sync</button>}
        {c.access !== 'public' && (
          <span style={{ display: 'inline-flex', gap: 4 }}>
            <input style={{ ...input, width: 110, fontSize: 12 }} value={memberId} onChange={(e) => setMemberId(e.target.value.replace(/\D/g, ''))} placeholder="User ID" inputMode="numeric" />
            <button style={tiny} disabled={!memberId} onClick={() => { api.chatAddMember(scope, entityId, c.id, { howlerUserId: memberId }).then(() => { setMemberId(''); onChanged(); }).catch((e) => onError(e.message)); }}>+ Add</button>
          </span>
        )}
        <button style={mini} onClick={toggle}>{open ? 'Hide' : 'Open'}{reported ? ` · ⚠ ${reported}` : ''}</button>
        <button style={{ ...tiny, color: '#c62828' }} onClick={() => window.confirm(`Close #${c.name}?`) && act(api.chatCloseChannel(scope, entityId, c.id))}>Close</button>
      </div>
      {open && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
            <input style={{ ...input, flex: 1, minWidth: 180 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Message #${c.name} as the organiser…`} onKeyDown={(e) => e.key === 'Enter' && text.trim() && send()} />
            <CtaFields cta={cta} setCta={setCta} eventId={eventId} />
            <button style={{ ...mini, opacity: text.trim() ? 1 : 0.5 }} disabled={!text.trim()} onClick={send}>Send</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 300, overflowY: 'auto' }}>
            {(messages || []).map((m) => (
              <div key={m.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', background: m.reported && !m.deleted ? 'rgba(198,40,40,0.07)' : 'rgba(128,128,128,0.06)', borderRadius: 8, padding: '6px 9px', fontSize: 12.5 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 700 }}>{m.deleted ? '—' : m.author.name}</span>
                  {m.authorType === 'organiser' && !m.deleted && <span style={pill('rgba(11,107,203,0.14)', '#0b6bcb')}>org</span>}
                  {m.pinned && <span style={pill('rgba(245,179,1,0.16)', '#8a6d00')}>📌</span>}
                  {m.reported && !m.deleted && <span style={pill('rgba(198,40,40,0.14)', '#c62828')}>⚠</span>}
                  <span style={{ marginLeft: 6, color: m.deleted ? 'var(--muted)' : 'inherit' }}>{m.deleted ? 'message deleted' : m.text}</span>
                  {m.ctaLabel && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--muted)' }}>🔘 {m.ctaLabel} → {m.ctaDestination}</span>}
                </div>
                {!m.deleted && (
                  <span style={{ whiteSpace: 'nowrap', display: 'inline-flex', gap: 4 }}>
                    <button style={tiny} title={m.pinned ? 'Unpin' : 'Pin'} onClick={() => act(api.chatModerate(scope, entityId, m.id, m.pinned ? 'unpin' : 'pin').then(loadMsgs))}>📌</button>
                    <button style={{ ...tiny, color: '#c62828' }} title="Delete" onClick={() => act(api.chatModerate(scope, entityId, m.id, 'delete').then(loadMsgs))}>🗑</button>
                  </span>
                )}
              </div>
            ))}
            {(messages || []).length === 0 && <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>No messages yet.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

const pill = (bg, fg) => ({ display: 'inline-block', marginLeft: 6, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', background: bg, color: fg, borderRadius: 980, padding: '1px 7px', verticalAlign: 'middle' });
const input = { boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 13, color: 'var(--text)', background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 9, padding: '7px 10px' };
const mini = { padding: '7px 12px', borderRadius: 8, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
const tiny = { padding: '4px 8px', borderRadius: 7, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 12, cursor: 'pointer' };
const primary = { padding: '8px 16px', borderRadius: 980, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const card = { border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)', padding: '12px 14px' };
