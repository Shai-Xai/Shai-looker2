import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';

// Event Media — upload + publish the media the Howler app shows for an event
// (Phase-1 pilot slots: header image / header video / event logo). Dual-surface:
// <EventAssets scope="admin" entityId=…/> under Admin → client → Event Media,
// and <EventAssets scope="my" entityId=…/> on the client's /event-media page.
// Publish makes the assets live at GET /api/app/event-assets/by-event/:eventId,
// which the app overlays on its Howler GraphQL data — no app release needed.
// Requires the suite's Howler event ID to be set (Admin → client → events).

export default function EventAssets({ entityId, scope = 'my' }) {
  const [suites, setSuites] = useState(null);
  const [suiteId, setSuiteId] = useState('');

  useEffect(() => {
    if (!entityId) return;
    let alive = true;
    api.eventAssetsSuites(entityId)
      .then((r) => { if (!alive) return; setSuites(r.suites || []); setSuiteId((cur) => cur || (r.suites?.[0]?.id || '')); })
      .catch(() => alive && setSuites([]));
    return () => { alive = false; };
  }, [entityId]);

  if (suites === null) return <div style={{ padding: 24, color: 'var(--muted)' }}>Loading Event Media…</div>;
  if (!suites.length) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>No events yet — add a suite to this client first, then manage its app media here.</p>;

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Event</label>
        <select value={suiteId} onChange={(e) => setSuiteId(e.target.value)} style={sel}>
          {suites.map((s) => <option key={s.id} value={s.id}>{s.name}{s.publishedSlots ? ` · ${s.publishedSlots} live` : ''}</option>)}
        </select>
      </div>
      {suiteId && <Editor key={suiteId} suiteId={suiteId} scope={scope} />}
    </div>
  );
}

function Editor({ suiteId }) {
  const isMobile = useIsMobile();
  const [data, setData] = useState(null); // { slots, howlerEventId, canManage, … }
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const load = () => api.eventAssetsGet(suiteId).then(setData).catch(() => setErr('Could not load this event’s media.'));
  useEffect(() => { load(); }, [suiteId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>{err}</p>;
  if (!data) return <div style={{ padding: 24, color: 'var(--muted)' }}>Loading…</div>;

  const dirty = data.slots.some((s) => s.dirty);
  const anyPublished = data.slots.some((s) => s.publishedUrl);

  async function pickFile(slot, file) {
    if (!file) return;
    setBusy(slot.key); setErr('');
    try {
      const data64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] || '');
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      const up = await api.eventAssetsUpload(suiteId, { name: file.name, mime: file.type, data: data64 });
      setData(await api.eventAssetsSetSlot(suiteId, slot.key, { url: up.url, mime: up.mime }));
    } catch (e) {
      setErr(e?.error || e?.message || 'Upload failed — try a smaller file.');
    } finally { setBusy(''); }
  }
  async function clearSlot(slot) {
    setBusy(slot.key);
    try { setData(await api.eventAssetsSetSlot(suiteId, slot.key, { url: '' })); } finally { setBusy(''); }
  }
  async function publish() {
    setBusy('publish');
    try { setData({ ...data, ...(await api.eventAssetsPublish(suiteId)) }); } finally { setBusy(''); }
  }

  return (
    <div>
      {!data.howlerEventId && (
        <p style={{ fontSize: 13, color: 'var(--muted)', background: 'var(--panel, rgba(127,127,127,0.08))', border: '1px solid var(--border, rgba(127,127,127,0.2))', borderRadius: 10, padding: '10px 14px' }}>
          ⚠️ This event has no <b>Howler event ID</b> yet, so the app can’t find its assets. Set it on the event (Admin → client → events → paste the howler.co.za event URL), then publish here.
        </p>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14, margin: '12px 0 16px' }}>
        {data.slots.map((slot) => (
          <SlotCard key={slot.key} slot={slot} busy={busy === slot.key} canManage={data.canManage}
            onPick={(f) => pickFile(slot, f)} onClear={() => clearSlot(slot)} />
        ))}
      </div>
      {data.canManage && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={publish} disabled={busy === 'publish' || !dirty} style={{ ...btn, opacity: busy === 'publish' || !dirty ? 0.5 : 1 }}>
            {busy === 'publish' ? 'Publishing…' : 'Publish to app'}
          </button>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {dirty ? 'Unpublished changes — the app still shows the previous media.' : anyPublished ? 'Live — the app is serving this media.' : 'Nothing published yet — the app uses Howler’s own media.'}
          </span>
        </div>
      )}
    </div>
  );
}

function SlotCard({ slot, busy, canManage, onPick, onClear }) {
  const fileRef = useRef(null);
  const url = slot.draftUrl || slot.publishedUrl;
  const isVideo = (slot.draftMime || slot.publishedMime || '').startsWith('video/');
  const status = slot.dirty ? { t: 'Draft — not live yet', c: '#e8a23b' }
    : slot.publishedUrl ? { t: 'Live in the app', c: '#4caf7d' }
      : { t: 'Empty — app shows Howler’s media', c: 'var(--muted)' };
  return (
    <div style={{ border: '1px solid var(--border, rgba(127,127,127,0.25))', borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ height: 140, background: 'rgba(127,127,127,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {url ? (isVideo
          ? <video src={url} muted loop autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <img src={url} alt={slot.label} style={{ width: '100%', height: '100%', objectFit: slot.key === 'logo' ? 'contain' : 'cover' }} />)
          : <span style={{ fontSize: 26, opacity: 0.4 }}>＋</span>}
      </div>
      <div style={{ padding: '10px 12px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, justifyContent: 'space-between' }}>
          <b style={{ fontSize: 13.5 }}>{slot.label}</b>
          <span style={{ fontSize: 11, color: status.c, whiteSpace: 'nowrap' }}>● {status.t}</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', margin: '2px 0 8px' }}>Overlays <code style={{ fontSize: 10.5 }}>{slot.overlays}</code></div>
        {canManage && (
          <div style={{ display: 'flex', gap: 8 }}>
            <input ref={fileRef} type="file" accept={`${slot.accept}/*`} style={{ display: 'none' }}
              onChange={(e) => { onPick(e.target.files?.[0]); e.target.value = ''; }} />
            <button onClick={() => fileRef.current?.click()} disabled={busy} style={btnSm}>{busy ? 'Uploading…' : url ? 'Replace' : 'Upload'}</button>
            {url && <button onClick={onClear} disabled={busy} style={{ ...btnSm, opacity: 0.7 }}>Remove</button>}
          </div>
        )}
      </div>
    </div>
  );
}

const sel = { padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border, rgba(127,127,127,0.3))', background: 'var(--panel, transparent)', color: 'inherit', fontSize: 13, minHeight: 40 };
const btn = { padding: '10px 18px', borderRadius: 10, border: 'none', background: 'var(--accent, #4b6ef5)', color: '#fff', fontWeight: 700, fontSize: 13.5, cursor: 'pointer', minHeight: 40 };
const btnSm = { padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border, rgba(127,127,127,0.3))', background: 'transparent', color: 'inherit', fontWeight: 600, fontSize: 12.5, cursor: 'pointer', minHeight: 36 };
